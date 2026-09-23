import { UserBulkUpdateSchema, UserCreateSchema, UserUpdateSchema, type InstanceUser } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { auditStatement } from "./audit";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { hashPassword } from "./auth-crypto";
import { isProtectedDemoAccount } from "./demo-mode";
import { createId, isoNow } from "./entity-utils";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "./http-errors";
import { requireOwner } from "./request-auth";
import type { DatabaseAdapter } from "./storage-contract";
import {
  createDefaultNotebookRows,
  createWorkspaceDefaultSeedStatements,
} from "./workspace-provisioning";

export type InstanceUserRow = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  email: string | null;
  is_disabled: number;
  is_deleted: number;
  last_login_at: string | null;
  created_at: string;
  role: "owner" | "member";
};

type UserRouteDependencies = {
  authenticateRequest: (context: AppContext, touch: boolean) => Promise<AuthContext | null>;
  getInstanceUser: (database: DatabaseAdapter, userId: string) => Promise<InstanceUserRow | null>;
};

export const mapInstanceUser = (row: InstanceUserRow): InstanceUser => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  email: row.email,
  role: row.role,
  isDisabled: Boolean(row.is_disabled),
  isDeleted: Boolean(row.is_deleted),
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

const requireOwnerRequest = async (
  context: AppContext,
  authenticateRequest: UserRouteDependencies["authenticateRequest"],
) => {
  const auth = await authenticateRequest(context, true);
  if (!auth) return unauthorized(context, "Authentication required.");
  context.set("auth", auth);
  return requireOwner(context);
};

export const registerUserRoutes = (
  app: Hono<AppEnv>,
  dependencies: UserRouteDependencies,
) => {
  app.get("/api/v1/users", async (context) => {
    const denied = await requireOwnerRequest(context, dependencies.authenticateRequest);
    if (denied) return denied;

    // Archived members stay out of the way unless the console asks for them.
    const includeDeleted = context.req.query("includeDeleted") === "1";
    const rows = await context.env.storage.db.prepare(
      `SELECT u.id, u.username, u.password_hash, u.display_name, u.email, u.is_disabled,
              u.is_deleted, u.last_login_at, u.created_at, wm.role
       FROM users u
       INNER JOIN workspace_members wm ON wm.user_id = u.id
       WHERE (? = 1 OR u.is_deleted = 0)
       ORDER BY wm.role = 'owner' DESC, u.created_at ASC`,
    ).bind(includeDeleted ? 1 : 0).all<InstanceUserRow>();

    return context.json({ users: rows.results.map(mapInstanceUser) });
  });

  app.post("/api/v1/users", zValidator("json", UserCreateSchema), async (context) => {
    const denied = await requireOwnerRequest(context, dependencies.authenticateRequest);
    if (denied) return denied;

    const input = context.req.valid("json");
    const existing = await context.env.storage.db.prepare(`SELECT id FROM users WHERE username = ?`)
      .bind(input.username)
      .first();
    if (existing) return conflict(context, "username_exists", "Username already exists.");

    const userId = createId("usr");
    const workspaceId = createId("ws");
    const now = isoNow();
    const passwordHash = await hashPassword(input.password);
    const notebooks = createDefaultNotebookRows(workspaceId);
    const statements = [
      context.env.storage.db.prepare(
        `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(userId, input.username, passwordHash, input.displayName ?? input.username, now, now),
      context.env.storage.db.prepare(
        `INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
      ).bind(workspaceId, `${input.displayName ?? input.username}'s workspace`, now, now),
      context.env.storage.db.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
      ).bind(workspaceId, userId, now),
      ...notebooks.map((notebook) => context.env.storage.db.prepare(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'notebook', ?, ?, ?, ?)`,
      ).bind(notebook.id, workspaceId, notebook.name, notebook.slug, notebook.color, notebook.sortOrder, now, now)),
      ...createWorkspaceDefaultSeedStatements(
        context.env.storage.db,
        workspaceId,
        now,
        context.req.header("accept-language"),
      ),
      auditStatement(context.env.storage.db, "user", context.get("auth").actorId, "user.create", "user", userId, {
        username: input.username,
      }),
    ];
    await context.env.storage.db.batch(statements);

    const user = await dependencies.getInstanceUser(context.env.storage.db, userId);
    return context.json({ user: user ? mapInstanceUser(user) : null }, 201);
  });

  app.patch("/api/v1/users/:id", zValidator("json", UserUpdateSchema), async (context) => {
    const denied = await requireOwnerRequest(context, dependencies.authenticateRequest);
    if (denied) return denied;

    const userId = context.req.param("id");
    const input = context.req.valid("json");
    const current = await dependencies.getInstanceUser(context.env.storage.db, userId);
    if (!current) return notFound(context, "User not found");
    if (
      isProtectedDemoAccount(
        context.env.EDGE_EVER_DEMO_MODE,
        context.env.EDGE_EVER_AUTH_USERNAME,
        current.username,
      ) && (input.password !== undefined || input.isDisabled !== undefined)
    ) {
      return forbidden(context, "The demo owner account uses fixed credentials and cannot be modified.");
    }
    if (current.role === "owner" && (input.isDisabled === true || input.isDeleted === true)) {
      return badRequest(context, "The instance owner cannot be disabled.");
    }

    const actorId = context.get("auth")!.actorId;
    if (actorId === userId && (input.isDisabled === true || input.isDeleted === true)) {
      return badRequest(context, "You cannot disable or archive your own account.");
    }
    if (actorId === userId && input.role === "member") {
      return badRequest(context, "You cannot drop your own administrator role.");
    }
    if (current.role === "owner" && input.role === "member") {
      const owners = await context.env.storage.db
        .prepare(`SELECT COUNT(*) AS count FROM workspace_members WHERE role = 'owner'`)
        .first<{ count: number }>();
      if ((owners?.count ?? 0) <= 1) {
        return badRequest(context, "At least one administrator must remain.");
      }
    }

    const updates: string[] = [];
    const binds: unknown[] = [];
    if (input.displayName !== undefined) {
      updates.push("display_name = ?");
      binds.push(input.displayName);
    }
    if (input.password !== undefined) {
      updates.push("password_hash = ?");
      binds.push(await hashPassword(input.password));
    }
    if (input.isDisabled !== undefined) {
      updates.push("is_disabled = ?");
      binds.push(input.isDisabled ? 1 : 0);
    }
    if (input.isDeleted !== undefined) {
      updates.push("is_deleted = ?");
      binds.push(input.isDeleted ? 1 : 0);
    }
    updates.push("updated_at = ?");
    binds.push(isoNow(), userId);

    const statements = [
      context.env.storage.db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...binds),
      auditStatement(context.env.storage.db, "user", context.get("auth").actorId, "user.update", "user", userId, {
        passwordReset: input.password !== undefined,
        isDisabled: input.isDisabled,
        isDeleted: input.isDeleted,
        role: input.role,
      }),
    ];
    if (input.role !== undefined) {
      statements.push(
        context.env.storage.db
          .prepare(`UPDATE workspace_members SET role = ? WHERE user_id = ?`)
          .bind(input.role, userId),
      );
    }
    if (input.password !== undefined || input.isDisabled === true || input.isDeleted === true) {
      statements.push(
        context.env.storage.db.prepare(
          `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
        ).bind(isoNow(), userId),
      );
    }
    await context.env.storage.db.batch(statements);

    const user = await dependencies.getInstanceUser(context.env.storage.db, userId);
    return context.json({ user: user ? mapInstanceUser(user) : null });
  });

  // Bulk actions for the member list. Administrator accounts are never touched
  // in bulk, and the acting administrator is always excluded, so a single
  // mis-click cannot lock the instance out.
  app.post("/api/v1/users/bulk", zValidator("json", UserBulkUpdateSchema), async (context) => {
    const denied = await requireOwnerRequest(context, dependencies.authenticateRequest);
    if (denied) return denied;

    const input = context.req.valid("json");
    const actorId = context.get("auth")!.actorId;
    const database = context.env.storage.db;
    const targetIds = input.ids.filter((id) => id !== actorId);
    if (targetIds.length === 0) {
      return badRequest(context, "Select at least one member other than yourself.");
    }

    const placeholders = targetIds.map(() => "?").join(", ");
    const protectedRows = await database
      .prepare(
        `SELECT u.id FROM users u
         INNER JOIN workspace_members wm ON wm.user_id = u.id
         WHERE u.id IN (${placeholders}) AND wm.role = 'owner'`,
      )
      .bind(...targetIds)
      .all<{ id: string }>();
    const skipped = (protectedRows.results ?? []).map((row) => row.id);
    const skippedSet = new Set(skipped);
    const affected = targetIds.filter((id) => !skippedSet.has(id));
    if (affected.length === 0) {
      return badRequest(context, "Administrator accounts cannot be changed in bulk.");
    }

    const affectedPlaceholders = affected.map(() => "?").join(", ");
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (input.isDisabled !== undefined) {
      updates.push("is_disabled = ?");
      binds.push(input.isDisabled ? 1 : 0);
    }
    if (input.isDeleted !== undefined) {
      updates.push("is_deleted = ?");
      binds.push(input.isDeleted ? 1 : 0);
    }
    updates.push("updated_at = ?");
    binds.push(isoNow());

    const statements = [
      database.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id IN (${affectedPlaceholders})`).bind(...binds, ...affected),
      auditStatement(database, "user", actorId, "user.bulk_update", "user", affected.join(","), {
        count: affected.length,
        isDisabled: input.isDisabled ?? null,
        isDeleted: input.isDeleted ?? null,
      }),
    ];
    if (input.isDisabled === true || input.isDeleted === true) {
      statements.push(
        database
          .prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id IN (${affectedPlaceholders}) AND revoked_at IS NULL`)
          .bind(isoNow(), ...affected),
      );
    }
    await database.batch(statements);

    return context.json({ ok: true, updated: affected.length, skipped });
  });
};
