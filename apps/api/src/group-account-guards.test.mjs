import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { registerApiTokenRoutes } from "./api-token-routes.ts";
import { registerUserRoutes } from "./user-routes.ts";
import {
  RegisterSchema,
  UserCreateSchema,
  UserUpdateSchema,
} from "@edgeever/shared";

// --- Minimal D1-over-sqlite shim (same pattern as group-collab-http.test.mjs) ---

class SqliteD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.db, this.sql, bindings);
  }

  async all() {
    return { results: this.db.query(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first() {
    return this.db.query(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    this.db.query(this.sql).run(...this.bindings);
    return { success: true, meta: {} };
  }
}

class SqliteD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    return this.db.transaction(() => statements.map((statement) =>
      this.db.query(statement.sql).run(...statement.bindings)))();
  }
}

const createEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  return { sqlite, database: new SqliteD1Database(sqlite) };
};

const iso = "2026-01-01T00:00:00.000Z";

const seedOwner = (sqlite) => {
  sqlite.query(`INSERT INTO users (id, username, password_hash, display_name, account_type, created_at, updated_at) VALUES ('usr_owner', 'owner', 'hash', 'Owner', 'user', ?, ?)`).run(iso, iso);
  sqlite.query(`INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES ('ws_owner', 'owner ws', 1, ?, ?)`).run(iso, iso);
  sqlite.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_owner', 'usr_owner', 'owner', ?)`).run(iso);
};

const seedGroupAccount = (sqlite) => {
  sqlite.query(`INSERT INTO users (id, username, password_hash, display_name, account_type, created_at, updated_at) VALUES ('usr_shared', 'shared_team', 'hash', 'Team', 'group', ?, ?)`).run(iso, iso);
  sqlite.query(`INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES ('ws_shared', 'Team (shared)', 1, ?, ?)`).run(iso, iso);
  sqlite.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_shared', 'usr_shared', 'member', ?)`).run(iso);
  sqlite.query(`INSERT INTO sessions (id, user_id, token_hash, device_id, expires_at, created_at, last_seen_at) VALUES ('ses_1', 'usr_shared', 'thash', 'dev', '2099-01-01T00:00:00.000Z', ?, ?)`).run(iso, iso);
  sqlite.query(`INSERT INTO api_tokens (id, workspace_id, name, token_hash, token_value, scopes_json, expires_at, created_at) VALUES ('tok_1', 'ws_shared', 'legacy', 'thash', NULL, '["read:memos"]', NULL, ?)`).run(iso);
};

const authFor = (overrides) => ({
  kind: "user",
  actorType: "user",
  actorId: "usr_owner",
  username: "owner",
  displayName: "Owner",
  scopes: [],
  workspaceId: "ws_owner",
  role: "owner",
  accountType: "user",
  ...overrides,
});

const buildApp = (env, auth, register, dependencies) => {
  const app = new Hono();
  app.onError((error, context) => {
    console.error("[test-app-error]", error instanceof Error ? error.message : error);
    return context.json({ error: "internal" }, 500);
  });
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  register(app, dependencies);
  return app;
};

const tokenApp = (env, auth) => buildApp(env, auth, registerApiTokenRoutes, {
  sha256: async () => "hash",
});

const userApp = (env, auth) => buildApp(env, auth, registerUserRoutes, {
  authenticateRequest: async (context) => context.get("auth") ?? null,
  getInstanceUser: async () => null,
});

describe("shared account credential boundaries", () => {
  test("a shared account cannot mint API tokens", async () => {
    const env = createEnvironment();
    seedOwner(env.sqlite);
    seedGroupAccount(env.sqlite);
    const app = tokenApp(env, authFor({
      actorId: "usr_shared",
      username: "shared_team",
      displayName: "Team",
      workspaceId: "ws_shared",
      role: "member",
      accountType: "group",
    }));
    const response = await app.request(
      "/api/v1/api-tokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "sneaky", scopes: ["read:memos"] }),
      },
      { storage: { db: env.database }, env: {} },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    // Nothing was minted.
    const rows = env.sqlite.query(`SELECT COUNT(*) AS n FROM api_tokens WHERE workspace_id = 'ws_shared' AND id != 'tok_1'`).get();
    expect(rows.n).toBe(0);
  });

  test("a personal account can still mint API tokens", async () => {
    const env = createEnvironment();
    seedOwner(env.sqlite);
    const app = tokenApp(env, authFor({}));
    const response = await app.request(
      "/api/v1/api-tokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "automation", scopes: ["read:memos"] }),
      },
      { storage: { db: env.database }, env: {} },
    );
    expect(response.status).toBe(201);
  });

  test("resetting the password revokes sessions and API tokens together", async () => {
    const env = createEnvironment();
    seedOwner(env.sqlite);
    seedGroupAccount(env.sqlite);
    const app = userApp(env, authFor({}));
    const response = await app.request(
      "/api/v1/group-accounts/usr_shared",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "rotated-secret-pass" }),
      },
      { storage: { db: env.database }, env: {} },
    );
    expect(response.status).toBe(200);
    const session = env.sqlite.query(`SELECT revoked_at FROM sessions WHERE id = 'ses_1'`).get();
    expect(session.revoked_at).not.toBe(null);
    const token = env.sqlite.query(`SELECT is_revoked FROM api_tokens WHERE id = 'tok_1'`).get();
    expect(token.is_revoked).toBe(1);
  });

  test("disabling the account revokes sessions and API tokens together", async () => {
    const env = createEnvironment();
    seedOwner(env.sqlite);
    seedGroupAccount(env.sqlite);
    const app = userApp(env, authFor({}));
    const patch = await app.request(
      "/api/v1/group-accounts/usr_shared",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isDisabled: true }),
      },
      { storage: { db: env.database }, env: {} },
    );
    expect(patch.status).toBe(200);
    expect(env.sqlite.query(`SELECT revoked_at FROM sessions WHERE id = 'ses_1'`).get().revoked_at).not.toBe(null);
    expect(env.sqlite.query(`SELECT is_revoked FROM api_tokens WHERE id = 'tok_1'`).get().is_revoked).toBe(1);
    expect(env.sqlite.query(`SELECT is_disabled FROM users WHERE id = 'usr_shared'`).get().is_disabled).toBe(1);
  });
});

describe("shared_ username reservation", () => {
  test("public registration rejects the reserved prefix", () => {
    const parsed = RegisterSchema.safeParse({
      username: "Shared_Team",
      displayName: "squat",
      email: "squat@example.com",
      password: "long-enough-pass",
      emailCode: "123456",
    });
    expect(parsed.success).toBe(false);
  });

  test("owner-created members reject the reserved prefix", () => {
    expect(UserCreateSchema.safeParse({ username: "shared_team", password: "long-enough-pass" }).success).toBe(false);
    expect(UserCreateSchema.safeParse({ username: "alice", password: "long-enough-pass" }).success).toBe(true);
  });

  test("renaming a member into the reserved prefix is rejected", () => {
    expect(UserUpdateSchema.safeParse({ username: "shared_ops" }).success).toBe(false);
    expect(UserUpdateSchema.safeParse({ username: "ops" }).success).toBe(true);
    expect(UserUpdateSchema.safeParse({ displayName: "Ops" }).success).toBe(true);
  });
});
