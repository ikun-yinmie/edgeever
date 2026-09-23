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
      return { results: harness.rows, success: true };
    },
    first: async () => (sql.includes("COUNT(*)") ? { count: harness.ownerCount } : null),
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
});
