import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { registerMemberNotesRoutes } from "./member-notes-routes.ts";
import { AppError } from "./app-error.ts";
import { resolveMemberNotesResourceRow } from "./member-notes-service.ts";

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

const OWNER_ID = "usr_owner";
const MEMBER_ID = "usr_member";
const OTHER_ID = "usr_other";

const createEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  return {
    sqlite,
    database: new SqliteD1Database(sqlite),
    environment: {
      EDGE_EVER_AUTH_PASSWORD: "test-password",
      storage: { db: new SqliteD1Database(sqlite) },
    },
  };
};

const seedUser = (sqlite, {
  id,
  username,
  accountType = "user",
  isDeleted = 0,
  role = "member",
  workspaceId,
  displayName = null,
}) => {
  sqlite
    .query(
      `INSERT INTO users (id, username, password_hash, display_name, is_deleted, account_type)
       VALUES (?, ?, 'hash', ?, ?, ?)`,
    )
    .run(id, username, displayName, isDeleted, accountType);
  if (workspaceId) {
    sqlite
      .query(`INSERT INTO workspaces (id, name) VALUES (?, ?)`)
      .run(workspaceId, `${username} workspace`);
    sqlite
      .query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`)
      .run(workspaceId, id, role);
  }
};

const seedMemo = (sqlite, {
  id,
  workspaceId,
  notebookId,
  userId,
  title,
  isDeleted = 0,
}) => {
  sqlite
    .query(
      `INSERT INTO notebooks (id, name, workspace_id) VALUES (?, ?, ?)`,
    )
    .run(notebookId, `${title} notebook`, workspaceId);
  sqlite
    .query(
      `INSERT INTO memos (id, notebook_id, workspace_id, title, excerpt, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, notebookId, workspaceId, title, `${title} excerpt`, isDeleted);
  sqlite
    .query(
      `INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash, revision)
       VALUES (?, '{"type":"doc","content":[]}', ?, ?, ?, 1)`,
    )
    .run(id, `# ${title}`, title, `hash-${id}`);
  sqlite
    .query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'image', 'image/png', 'image.png', 128)`,
    )
    .run(`res_${id}`, id, `objects/${id}.png`);
};

const seed = (sqlite) => {
  seedUser(sqlite, {
    id: OWNER_ID,
    username: "owner",
    role: "owner",
    workspaceId: "ws_owner",
    displayName: "Owner",
  });
  seedUser(sqlite, {
    id: MEMBER_ID,
    username: "member",
    workspaceId: "ws_member",
    displayName: "Member One",
  });
  seedUser(sqlite, {
    id: OTHER_ID,
    username: "other",
    workspaceId: "ws_other",
    displayName: "Other Member",
  });
  seedUser(sqlite, {
    id: "usr_group",
    username: "team",
    accountType: "group",
    workspaceId: "ws_group",
    displayName: "Team Account",
  });
  seedUser(sqlite, {
    id: "usr_deleted",
    username: "gone",
    isDeleted: 1,
    workspaceId: "ws_deleted",
    displayName: "Deleted Member",
  });

  seedMemo(sqlite, {
    id: "memo_member",
    workspaceId: "ws_member",
    notebookId: "nb_member",
    userId: MEMBER_ID,
    title: "Member note",
  });
  seedMemo(sqlite, {
    id: "memo_member_deleted",
    workspaceId: "ws_member",
    notebookId: "nb_member_deleted",
    userId: MEMBER_ID,
    title: "Deleted member note",
    isDeleted: 1,
  });
  seedMemo(sqlite, {
    id: "memo_other",
    workspaceId: "ws_other",
    notebookId: "nb_other",
    userId: OTHER_ID,
    title: "Other note",
  });
};

const authFor = (role = "owner", actorId = OWNER_ID) => ({
  kind: "user",
  actorType: "user",
  actorId,
  username: role === "owner" ? "owner" : "member",
  displayName: null,
  scopes: [],
  workspaceId: role === "owner" ? "ws_owner" : "ws_member",
  role,
});

const createTestApp = (role = "owner", actorId = OWNER_ID) => {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("auth", authFor(role, actorId));
    await next();
  });
  registerMemberNotesRoutes(app);
  app.onError((error, context) => {
    if (error instanceof AppError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    throw error;
  });
  return app;
};

const jsonRequest = (app, path, environment, method, body) => app.request(
  path,
  {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  },
  environment,
);

const setAccess = (sqlite, mode, userIds = []) => {
  sqlite.query(`UPDATE instance_settings SET member_notes_access_mode = ? WHERE id = 'instance'`).run(mode);
  sqlite.query("DELETE FROM member_notes_access_grants").run();
  for (const userId of userIds) {
    sqlite.query("INSERT INTO member_notes_access_grants (user_id) VALUES (?)").run(userId);
  }
};

describe("member notes access settings", () => {
  test("defaults to off and rejects non-owners", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);

    const ownerResponse = await createTestApp().request("/api/v1/admin/member-notes/access", {}, environment);
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.json()).toEqual({
      settings: { mode: "off", selectedUserIds: [] },
    });

    const memberResponse = await createTestApp("member", MEMBER_ID)
      .request("/api/v1/admin/member-notes/access", {}, environment);
    expect(memberResponse.status).toBe(403);
    sqlite.close();
  });

  test("stores selected members and returns them", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    const app = createTestApp();

    const update = await jsonRequest(app, "/api/v1/admin/member-notes/access", environment, "PATCH", {
      mode: "selected",
      selectedUserIds: [MEMBER_ID, MEMBER_ID],
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({
      settings: { mode: "selected", selectedUserIds: [MEMBER_ID] },
    });

    const access = await app.request("/api/v1/admin/member-notes/access", {}, environment);
    expect(await access.json()).toEqual({
      settings: { mode: "selected", selectedUserIds: [MEMBER_ID] },
    });
    sqlite.close();
  });

  test("rejects group, deleted, owner, and unknown members", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    const app = createTestApp();

    for (const selectedUserIds of [[OWNER_ID], ["usr_group"], ["usr_deleted"], ["missing"]]) {
      const response = await jsonRequest(app, "/api/v1/admin/member-notes/access", environment, "PATCH", {
        mode: "selected",
        selectedUserIds,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "member_notes_invalid_members" } });
    }
    sqlite.close();
  });
});

describe("member notes directory", () => {
  test("lists active human members and their non-deleted note counts", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    setAccess(sqlite, "all");

    const response = await createTestApp().request("/api/v1/admin/member-notes/members", {}, environment);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe("all");
    expect(body.members.map((member) => member.id).sort()).toEqual(["usr_other", MEMBER_ID].sort());
    expect(body.members.find((member) => member.id === MEMBER_ID)).toMatchObject({
      username: "member",
      displayName: "Member One",
      memoCount: 1,
    });
    sqlite.close();
  });

  test("honors the selected allowlist", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    setAccess(sqlite, "selected", [OTHER_ID]);

    const response = await createTestApp().request("/api/v1/admin/member-notes/members", {}, environment);
    const body = await response.json();
    expect(body.members.map((member) => member.id)).toEqual([OTHER_ID]);
    sqlite.close();
  });
});

describe("member notes read endpoints", () => {
  test("returns member memos and a detail when access is enabled", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    setAccess(sqlite, "all");
    const app = createTestApp();

    const list = await app.request(`/api/v1/admin/member-notes/${MEMBER_ID}/memos`, {}, environment);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.member).toMatchObject({ id: MEMBER_ID, username: "member" });
    expect(listBody.totalCount).toBe(1);
    expect(listBody.memos.map((memo) => memo.id)).toEqual(["memo_member"]);

    const detail = await app.request(
      `/api/v1/admin/member-notes/${MEMBER_ID}/memos/memo_member`,
      {},
      environment,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      memo: { id: "memo_member", title: "Member note" },
      member: { id: MEMBER_ID, username: "member" },
    });
    sqlite.close();
  });

  test("denies access when the mode is off or the member is not selected", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    const app = createTestApp();

    const off = await app.request(`/api/v1/admin/member-notes/${MEMBER_ID}/memos`, {}, environment);
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ error: { code: "member_notes_forbidden" } });

    setAccess(sqlite, "selected", [OTHER_ID]);
    const notSelected = await app.request(
      `/api/v1/admin/member-notes/${MEMBER_ID}/memos/memo_member`,
      {},
      environment,
    );
    expect(notSelected.status).toBe(403);
    sqlite.close();
  });

  test("never exposes deleted member notes", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    setAccess(sqlite, "all");

    const response = await createTestApp().request(
      `/api/v1/admin/member-notes/${MEMBER_ID}/memos/memo_member_deleted`,
      {},
      environment,
    );
    expect(response.status).toBe(404);
    sqlite.close();
  });

  test("rejects group accounts and the site owner's own workspace", async () => {
    const { sqlite, environment } = createEnvironment();
    seed(sqlite);
    setAccess(sqlite, "all");
    const app = createTestApp();

    const group = await app.request("/api/v1/admin/member-notes/usr_group/memos", {}, environment);
    expect(group.status).toBe(403);
    const own = await app.request(`/api/v1/admin/member-notes/${OWNER_ID}/memos`, {}, environment);
    expect(own.status).toBe(403);
    sqlite.close();
  });
});

describe("member notes resource fallback", () => {
  test("resolves images only for allowed members and live memos", async () => {
    const { sqlite, database } = createEnvironment();
    seed(sqlite);

    setAccess(sqlite, "off");
    expect(await resolveMemberNotesResourceRow(database, OWNER_ID, "res_memo_member")).toBeNull();

    setAccess(sqlite, "all");
    expect(await resolveMemberNotesResourceRow(database, OWNER_ID, "res_memo_member")).toMatchObject({
      id: "res_memo_member",
      memo_id: "memo_member",
    });

    setAccess(sqlite, "selected", [OTHER_ID]);
    expect(await resolveMemberNotesResourceRow(database, OWNER_ID, "res_memo_member")).toBeNull();

    setAccess(sqlite, "all");
    expect(await resolveMemberNotesResourceRow(database, OWNER_ID, "res_memo_member_deleted")).toBeNull();
    sqlite.close();
  });
});
