import { UserBulkUpdateSchema, UserCreateSchema, UserUpdateSchema, type InstanceUser } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { auditStatement } from "./audit";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { hashPassword } from "./auth-crypto";
import { isProtectedDemoAccount } from "./demo-mode";
import { createId, isoNow } from "./entity-utils";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "./http-errors";
import { deleteStoredObjects } from "./object-storage";
import { requireOwner } from "./request-auth";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";
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

/**
 * Statements that permanently remove a member: their personal workspace with
 * everything inside it, then the account itself. Workspace-scoped tables that
 * carry no cascade from `workspaces` are listed explicitly, memo rows go first
 * because `resources` and `notebooks` both RESTRICT, and sync rows are cleared
 * last because the notebook/memo delete triggers queue them again.
 */
export const permanentUserDeletionStatements = (
  database: DatabaseAdapter,
  input: { userId: string; workspaceIds: string[]; auditActorId: string | null; metadata?: unknown },
): PreparedStatementAdapter[] => {
  const statements: PreparedStatementAdapter[] = [];
  const { workspaceIds } = input;
  if (workspaceIds.length > 0) {
    const placeholders = workspaceIds.map(() => "?").join(", ");
    statements.push(
      database
        .prepare(`DELETE FROM resources WHERE memo_id IN (SELECT id FROM memos WHERE workspace_id IN (${placeholders}))`)
        .bind(...workspaceIds),
      database.prepare(`DELETE FROM memos WHERE workspace_id IN (${placeholders})`).bind(...workspaceIds),
      database.prepare(`UPDATE notebooks SET parent_id = NULL WHERE workspace_id IN (${placeholders})`).bind(...workspaceIds),
      database.prepare(`DELETE FROM notebooks WHERE workspace_id IN (${placeholders})`).bind(...workspaceIds),
      database.prepare(`DELETE FROM api_tokens WHERE workspace_id IN (${placeholders})`).bind(...workspaceIds),
      database.prepare(`DELETE FROM group_shares WHERE source_workspace_id IN (${placeholders})`).bind(...workspaceIds),
      database.prepare(`DELETE FROM workspaces WHERE id IN (${placeholders})`).bind(...workspaceIds),
      database.prepare(`DELETE FROM mobile_sync_changes WHERE workspace_id IN (${placeholders})`).bind(...workspaceIds),
    );
  }
  statements.push(
    // Sessions, workspace membership and group membership cascade from users,
    // but revoking sessions first keeps any in-flight request failing closed.
    database.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(input.userId),
    database.prepare(`DELETE FROM users WHERE id = ?`).bind(input.userId),
    auditStatement(database, "user", input.auditActorId, "user.delete", "user", input.userId, {
      workspaces: workspaceIds.length,
      ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
    }),
  );
  return statements;
};

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
      ) && (
        input.username !== undefined
        || input.password !== undefined
        || input.isDisabled !== undefined
      )
    ) {
      return forbidden(context, "The demo owner account uses fixed credentials and cannot be modified.");
    }
    if (current.role === "owner" && (input.isDisabled === true || input.isDeleted === true)) {
      return badRequest(context, "The instance owner cannot be disabled.");
    }
    if (input.username !== undefined && input.username !== current.username) {
      const takenUsername = await context.env.storage.db
        .prepare(`SELECT id FROM users WHERE username = ? AND id <> ?`)
        .bind(input.username, userId)
        .first<{ id: string }>();
      if (takenUsername) return conflict(context, "username_exists", "Username already exists.");
    }
    if (input.email !== undefined && input.email !== null) {
      const takenEmail = await context.env.storage.db
        .prepare(`SELECT id FROM users WHERE email = ? AND id <> ?`)
        .bind(input.email, userId)
        .first<{ id: string }>();
      if (takenEmail) return conflict(context, "email_exists", "Email already exists.");
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
    if (input.username !== undefined) {
      updates.push("username = ?");
      binds.push(input.username);
    }
    if (input.displayName !== undefined) {
      updates.push("display_name = ?");
      binds.push(input.displayName);
    }
    if (input.email !== undefined) {
      updates.push("email = ?");
      binds.push(input.email);
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
        username: input.username,
        displayName: input.displayName,
        email: input.email,
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

  // Permanent removal of a single member: the account, its personal workspace
  // and everything inside it. Administrators and the acting account are refused
  // so the console can never delete the last way back in.
  app.delete("/api/v1/users/:id", async (context) => {
    const denied = await requireOwnerRequest(context, dependencies.authenticateRequest);
    if (denied) return denied;

    const userId = context.req.param("id");
    const actorId = context.get("auth")!.actorId;
    if (userId === actorId) return badRequest(context, "You cannot delete your own account.");

    const current = await dependencies.getInstanceUser(context.env.storage.db, userId);
    if (!current) return notFound(context, "User not found");
    if (current.role === "owner") {
      return badRequest(context, "Administrator accounts cannot be deleted.");
    }
    if (
      isProtectedDemoAccount(
        context.env.EDGE_EVER_DEMO_MODE,
        context.env.EDGE_EVER_AUTH_USERNAME,
        current.username,
      )
    ) {
      return forbidden(context, "The demo owner account uses fixed credentials and cannot be deleted.");
    }

    const database = context.env.storage.db;
    const workspaceRows = await database
      .prepare(
        `SELECT w.id AS workspace_id
         FROM workspaces w
         INNER JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = ?`,
      )
      .bind(userId)
      .all<{ workspace_id: string }>();
    const workspaceIds = (workspaceRows.results ?? []).map((row) => row.workspace_id);

    // Attachments live outside the database, so collect their object keys before
    // the owning rows disappear.
    if (workspaceIds.length > 0) {
      const resourcePlaceholders = workspaceIds.map(() => "?").join(", ");
      const resourceRows = await database
        .prepare(
          `SELECT r.object_key, r.storage_config_id
           FROM resources r
           INNER JOIN memos m ON m.id = r.memo_id
           WHERE m.workspace_id IN (${resourcePlaceholders})`,
        )
        .bind(...workspaceIds)
        .all<{ object_key: string; storage_config_id: string | null }>();
      if ((resourceRows.results ?? []).length > 0) {
        await deleteStoredObjects(context.env, resourceRows.results);
      }
    }

    await database.batch(
      permanentUserDeletionStatements(database, {
        userId,
        workspaceIds,
        auditActorId: actorId,
        metadata: { username: current.username },
      }),
    );

    return context.json({ ok: true });
  });
};
