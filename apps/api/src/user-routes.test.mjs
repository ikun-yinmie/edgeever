import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerUserRoutes } from "./user-routes.ts";

const ownerAuth = {
  kind: "user",
  actorType: "user",
  actorId: "usr_owner",
  username: "owner",
  displayName: "Owner",
  scopes: [],
  workspaceId: "ws_owner",
  role: "owner",
};

const createStatement = (sql, harness) => {
  const statement = {
    sql,
    bindings: [],
    bind(...bindings) {
      statement.bindings = bindings;
      return statement;
    },
    all: async () => {
      if (sql.includes("AND wm.role = 'owner'")) {
        return { results: harness.administratorIds.map((id) => ({ id })), success: true };
      }
      if (sql.includes("SELECT w.id AS workspace_id")) {
        return { results: harness.workspaceIds.map((workspace_id) => ({ workspace_id })), success: true };
      }
      if (sql.includes("FROM resources r")) {
        return { results: harness.resourceRows, success: true };
      }
      return { results: harness.rows, success: true };
    },
    first: async () => {
      if (sql.includes("COUNT(*)")) return { count: harness.ownerCount };
      if (harness.takenUsername && sql.includes("SELECT id FROM users WHERE username")) {
        return { id: "usr_other" };
      }
      if (harness.takenEmail && sql.includes("SELECT id FROM users WHERE email")) {
        return { id: "usr_other" };
      }
      return null;
    },
    run: async () => ({ success: true }),
  };
  harness.statements.push(statement);
  return statement;
};

const createEnvironment = (rows = [], harnessOptions = {}) => {
  const harness = {
    rows,
    statements: [],
    batched: [],
    administratorIds: harnessOptions.administratorIds ?? [],
    ownerCount: harnessOptions.ownerCount ?? 1,
    workspaceIds: harnessOptions.workspaceIds ?? [],
    resourceRows: harnessOptions.resourceRows ?? [],
    takenUsername: harnessOptions.takenUsername ?? false,
    takenEmail: harnessOptions.takenEmail ?? false,
  };
  const environment = {
    storage: {
      db: {
        prepare: (sql) => createStatement(sql, harness),
        batch: async (statements) => {
          harness.batched.push(...statements.map((statement) => ({
            sql: statement.sql,
            bindings: statement.bindings,
          })));
          return [];
        },
      },
      resources: {},
    },
    harness,
  };
  return environment;
};

const createApp = (authenticateRequest, instanceUserOverride = {}) => {
  const app = new Hono();
  registerUserRoutes(app, {
    authenticateRequest,
    getInstanceUser: async (_database, userId) => ({
      id: userId,
      username: "writer",
      password_hash: "hidden",
      display_name: "Writer",
      email: null,
      is_disabled: 0,
      is_deleted: 0,
      last_login_at: null,
      created_at: "2026-08-08T00:00:00.000Z",
      role: "member",
      ...instanceUserOverride,
    }),
  });
  return app;
};

describe("user route contracts", () => {
  test("rejects unauthenticated user listing", async () => {
    const app = createApp(async () => null);
    const response = await app.request("/api/v1/users", {}, createEnvironment());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  test("rejects non-owner user listing", async () => {
    const app = createApp(async () => ({ ...ownerAuth, role: "member" }));
    const response = await app.request("/api/v1/users", {}, createEnvironment());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  test("maps owner-visible users at the HTTP boundary", async () => {
    const app = createApp(async () => ownerAuth);
    const response = await app.request("/api/v1/users", {}, createEnvironment([{
      id: "usr_member",
      username: "writer",
      password_hash: "hidden",
      display_name: "Writer",
      email: "writer@example.com",
      is_disabled: 0,
      is_deleted: 0,
      last_login_at: null,
      created_at: "2026-08-08T00:00:00.000Z",
      role: "member",
    }]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      users: [{
        id: "usr_member",
        username: "writer",
        displayName: "Writer",
        email: "writer@example.com",
        role: "member",
        isDisabled: false,
        isDeleted: false,
        lastLoginAt: null,
        createdAt: "2026-08-08T00:00:00.000Z",
      }],
    });
  });

  test("asks for archived members only when the console requests them", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([]);

    await app.request("/api/v1/users", {}, environment);
    await app.request("/api/v1/users?includeDeleted=1", {}, environment);

    const listStatements = environment.harness.statements.filter((statement) => statement.sql.includes("FROM users u"));
    expect(listStatements[0].bindings).toEqual([0]);
    expect(listStatements[1].bindings).toEqual([1]);
  });
});

describe("bulk member actions", () => {
  test("disables only the selected ordinary members", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([], { administratorIds: ["usr_admin"] });

    const response = await app.request(
      "/api/v1/users/bulk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["usr_member", "usr_admin", "usr_owner"], isDisabled: true }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, updated: 1, skipped: ["usr_admin"] });
    const update = environment.harness.batched.find((statement) => statement.sql.startsWith("UPDATE users SET"));
    expect(update.bindings).toEqual([1, expect.any(String), "usr_member"]);
    const revoke = environment.harness.batched.find((statement) => statement.sql.startsWith("UPDATE sessions SET"));
    expect(revoke.bindings.at(-1)).toBe("usr_member");
  });

  test("archives members and always leaves sessions revoked", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([]);

    const response = await app.request(
      "/api/v1/users/bulk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["usr_member"], isDeleted: true }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    const update = environment.harness.batched.find((statement) => statement.sql.startsWith("UPDATE users SET"));
    expect(update.bindings[0]).toBe(1);
    expect(environment.harness.batched.some((statement) => statement.sql.startsWith("UPDATE sessions SET"))).toBe(true);
  });

  test("refuses a bulk change that only targets administrators or the actor", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([], { administratorIds: ["usr_admin"] });

    const adminOnly = await app.request(
      "/api/v1/users/bulk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["usr_admin"], isDisabled: true }),
      },
      environment,
    );
    expect(adminOnly.status).toBe(400);

    const selfOnly = await app.request(
      "/api/v1/users/bulk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["usr_owner"], isDisabled: true }),
      },
      environment,
    );
    expect(selfOnly.status).toBe(400);
  });

  test("requires at least one change", async () => {
    const app = createApp(async () => ownerAuth);
    const response = await app.request(
      "/api/v1/users/bulk",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["usr_member"] }),
      },
      createEnvironment([]),
    );

    expect(response.status).toBe(400);
  });
});

describe("single member updates", () => {
  test("refuses to lock the acting owner out", async () => {
    const app = createApp(async () => ownerAuth);
    const disableSelf = await app.request(
      "/api/v1/users/usr_owner",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isDisabled: true }),
      },
      createEnvironment([]),
    );
    expect(disableSelf.status).toBe(400);

    const demoteSelf = await app.request(
      "/api/v1/users/usr_owner",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
      createEnvironment([]),
    );
    expect(demoteSelf.status).toBe(400);
  });

  test("moves a promoted member into the administrator role", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([]);

    const response = await app.request(
      "/api/v1/users/usr_member",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "owner" }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    const roleUpdate = environment.harness.batched.find((statement) =>
      statement.sql.startsWith("UPDATE workspace_members SET role"));
    expect(roleUpdate.bindings).toEqual(["owner", "usr_member"]);
  });

  test("keeps the last administrator in place", async () => {
    const app = createApp(async () => ({ ...ownerAuth, actorId: "usr_admin" }), { role: "owner" });
    const response = await app.request(
      "/api/v1/users/usr_owner",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
      createEnvironment([], { ownerCount: 1 }),
    );

    expect(response.status).toBe(400);
  });

  test("edits the username, display name and email of a member", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([]);

    const response = await app.request(
      "/api/v1/users/usr_member",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "writer2", displayName: "Second Writer", email: "Writer@Example.COM" }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    const update = environment.harness.batched.find((statement) => statement.sql.startsWith("UPDATE users SET"));
    expect(update.sql).toContain("username = ?");
    expect(update.bindings).toEqual([
      "writer2",
      "Second Writer",
      "writer@example.com",
      expect.any(String),
      "usr_member",
    ]);
  });

  test("refuses a rename that another account already owns", async () => {
    const app = createApp(async () => ownerAuth);
    const response = await app.request(
      "/api/v1/users/usr_member",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "taken" }),
      },
      createEnvironment([], { takenUsername: true }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "username_exists" } });
  });

  test("refuses an email that another account already owns", async () => {
    const app = createApp(async () => ownerAuth);
    const response = await app.request(
      "/api/v1/users/usr_member",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "taken@example.com" }),
      },
      createEnvironment([], { takenEmail: true }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "email_exists" } });
  });
});

describe("permanent member deletion", () => {
  test("needs an administrator session", async () => {
    const app = createApp(async () => ({ ...ownerAuth, role: "member" }));
    const response = await app.request(
      "/api/v1/users/usr_member",
      { method: "DELETE" },
      createEnvironment([]),
    );

    expect(response.status).toBe(403);
  });

  test("refuses to delete the acting account", async () => {
    const app = createApp(async () => ownerAuth);
    const response = await app.request(
      "/api/v1/users/usr_owner",
      { method: "DELETE" },
      createEnvironment([]),
    );

    expect(response.status).toBe(400);
  });

  test("refuses to delete an administrator", async () => {
    const app = createApp(async () => ownerAuth, { role: "owner" });
    const environment = createEnvironment([]);
    const response = await app.request(
      "/api/v1/users/usr_admin",
      { method: "DELETE" },
      environment,
    );

    expect(response.status).toBe(400);
    expect(environment.harness.batched).toEqual([]);
  });

  test("purges the member workspace and account", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([], { workspaceIds: ["ws_member"] });

    const response = await app.request(
      "/api/v1/users/usr_member",
      { method: "DELETE" },
      environment,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const sql = environment.harness.batched.map((statement) => statement.sql);
    expect(sql.some((statement) => statement.startsWith("DELETE FROM memos WHERE workspace_id IN"))).toBe(true);
    expect(sql.some((statement) => statement.startsWith("DELETE FROM notebooks WHERE workspace_id IN"))).toBe(true);
    expect(sql.some((statement) => statement.startsWith("DELETE FROM users WHERE id = ?"))).toBe(true);
    const workspaceDelete = environment.harness.batched.find((statement) =>
      statement.sql.startsWith("DELETE FROM workspaces WHERE id IN"));
    expect(workspaceDelete.bindings).toEqual(["ws_member"]);
    const memoDelete = environment.harness.batched.findIndex((statement) =>
      statement.sql.startsWith("DELETE FROM memos WHERE workspace_id IN"));
    const syncDelete = environment.harness.batched.findIndex((statement) =>
      statement.sql.startsWith("DELETE FROM mobile_sync_changes"));
    expect(syncDelete).toBeGreaterThan(memoDelete);
  });

  test("deletes an account that has no workspace of its own", async () => {
    const app = createApp(async () => ownerAuth);
    const environment = createEnvironment([]);

    const response = await app.request(
      "/api/v1/users/usr_member",
      { method: "DELETE" },
      environment,
    );

    expect(response.status).toBe(200);
    const sql = environment.harness.batched.map((statement) => statement.sql);
    expect(sql.some((statement) => statement.startsWith("DELETE FROM workspaces"))).toBe(false);
    expect(sql.some((statement) => statement.startsWith("DELETE FROM users WHERE id = ?"))).toBe(true);
  });
});
