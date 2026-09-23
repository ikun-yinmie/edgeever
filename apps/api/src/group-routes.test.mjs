import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { registerGroupRoutes } from "./group-routes.ts";

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

const users = {
  owner: { id: "usr_owner", username: "owner", role: "owner", workspaceId: "ws_usr_owner" },
  alice: { id: "usr_alice", username: "alice", role: "member", workspaceId: "ws_usr_alice" },
  bob: { id: "usr_bob", username: "bob", role: "member", workspaceId: "ws_usr_bob" },
  carol: { id: "usr_carol", username: "carol", role: "member", workspaceId: "ws_usr_carol" },
};

const createHarness = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  for (const user of Object.values(users)) {
    sqlite
      .query(
        `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, 'hash', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(user.id, user.username, user.username);
    sqlite
      .query(
        `INSERT INTO workspaces (id, name, is_personal, created_at, updated_at)
         VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(user.workspaceId, `${user.username} workspace`);
    sqlite
      .query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', '2026-01-01T00:00:00.000Z')`)
      .run(user.workspaceId, user.id);
  }
  sqlite
    .query(
      `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at)
       VALUES ('nb_alice', 'ws_usr_alice', NULL, 'Alice notes', 'alice', 'notebook', '#000', 0,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  sqlite
    .query(
      `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt, tags_json, is_pinned, is_archived,
          is_deleted, source_memo_ids, merge_source_count, created_by, updated_by, created_at, updated_at)
       VALUES ('memo_alice', 'ws_usr_alice', 'nb_alice', 'Alice note', '', '[]', 0, 0, 0, '[]', 0, 'user', 'user',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run();

  let currentUser = users.owner;
  const app = new Hono();
  registerGroupRoutes(app, {
    authenticateRequest: async () => ({
      kind: "user",
      actorType: "user",
      actorId: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.username,
      scopes: [],
      workspaceId: currentUser.workspaceId,
      role: currentUser.role,
    }),
  });

  const environment = { storage: { db: new SqliteD1Database(sqlite) } };
  const request = (actor, path, init) => {
    currentUser = actor;
    return app.request(path, init, environment);
  };

  return { sqlite, request };
};

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("group routes", () => {
  test("only administrators assemble groups", async () => {
    const { request } = createHarness();

    const denied = await request(users.alice, "/api/v1/groups", json({ name: "家庭" }));
    expect(denied.status).toBe(403);

    const created = await request(users.owner, "/api/v1/groups", json({ name: "家庭" }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.group).toMatchObject({ name: "家庭" });
  });

  test("members manage the membership", async () => {
    const { request } = createHarness();
    const created = await (await request(users.owner, "/api/v1/groups", json({ name: "家庭" }))).json();

    const added = await request(
      users.owner,
      `/api/v1/groups/${created.group.id}/members`,
      json({ userIds: ["usr_alice"] }),
    );
    expect(added.status).toBe(200);
    expect((await added.json()).members.map((member) => member.userId).sort()).toEqual(["usr_alice", "usr_owner"]);

    const memberView = await request(users.alice, `/api/v1/groups/${created.group.id}/members`);
    expect(memberView.status).toBe(200);

    const strangerView = await request(users.bob, `/api/v1/groups/${created.group.id}/members`);
    expect(strangerView.status).toBe(403);

    const removed = await request(users.owner, `/api/v1/groups/${created.group.id}/members/usr_alice`, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });

  test("a member shares their own notebook and everyone in the group sees it", async () => {
    const { request } = createHarness();
    const created = await (await request(users.owner, "/api/v1/groups", json({ name: "家庭" }))).json();
    await request(users.owner, `/api/v1/groups/${created.group.id}/members`, json({ userIds: ["usr_alice", "usr_bob"] }));

    const shared = await request(
      users.alice,
      `/api/v1/groups/${created.group.id}/shares`,
      json({ targetType: "notebook", targetId: "nb_alice", editMode: "group", editorUserIds: [] }),
    );
    expect(shared.status).toBe(201);

    const listed = await (await request(users.alice, `/api/v1/groups/${created.group.id}/shares`)).json();
    expect(listed.shares).toEqual([
      expect.objectContaining({ targetId: "nb_alice", editMode: "group", title: "Alice notes", authorUsername: "alice" }),
    ]);

    const sharedWithBob = await (await request(users.bob, "/api/v1/shared-with-me")).json();
    expect(sharedWithBob.notebooks).toEqual([
      expect.objectContaining({ id: "nb_alice", canEdit: true, groupName: "家庭" }),
    ]);

    const memos = await (
      await request(users.bob, "/api/v1/shared-with-me/notebooks/nb_alice/memos")
    ).json();
    expect(memos.memos).toEqual([
      expect.objectContaining({ id: "memo_alice", canEdit: true }),
    ]);
  });

  test("refuses to publish content the sharer does not own", async () => {
    const { request } = createHarness();
    const created = await (await request(users.owner, "/api/v1/groups", json({ name: "家庭" }))).json();
    await request(users.owner, `/api/v1/groups/${created.group.id}/members`, json({ userIds: ["usr_alice", "usr_bob"] }));

    const response = await request(
      users.bob,
      `/api/v1/groups/${created.group.id}/shares`,
      json({ targetType: "notebook", targetId: "nb_alice", editMode: "author", editorUserIds: [] }),
    );
    expect(response.status).toBe(404);
  });

  test("non-members cannot read or create shares", async () => {
    const { request } = createHarness();
    const created = await (await request(users.owner, "/api/v1/groups", json({ name: "家庭" }))).json();

    const list = await request(users.bob, `/api/v1/groups/${created.group.id}/shares`);
    expect(list.status).toBe(403);

    const create = await request(
      users.bob,
      `/api/v1/groups/${created.group.id}/shares`,
      json({ targetType: "notebook", targetId: "nb_alice", editMode: "author", editorUserIds: [] }),
    );
    expect(create.status).toBe(403);

    const notes = await request(users.bob, "/api/v1/shared-with-me/notebooks/nb_alice/memos");
    expect(notes.status).toBe(403);
  });

  test("only the sharer or an administrator changes a share", async () => {
    const { request } = createHarness();
    const created = await (await request(users.owner, "/api/v1/groups", json({ name: "家庭" }))).json();
    await request(users.owner, `/api/v1/groups/${created.group.id}/members`, json({ userIds: ["usr_alice", "usr_bob"] }));
    await request(
      users.alice,
      `/api/v1/groups/${created.group.id}/shares`,
      json({ targetType: "notebook", targetId: "nb_alice", editMode: "author", editorUserIds: [] }),
    );
    const [share] = (await (await request(users.alice, `/api/v1/groups/${created.group.id}/shares`)).json()).shares;

    const forbidden = await request(
      users.bob,
      `/api/v1/groups/${created.group.id}/shares/${share.id}`,
      { ...json({ editMode: "group" }), method: "PATCH" },
    );
    expect(forbidden.status).toBe(403);

    const bySharer = await request(
      users.alice,
      `/api/v1/groups/${created.group.id}/shares/${share.id}`,
      { ...json({ editMode: "group" }), method: "PATCH" },
    );
    expect(bySharer.status).toBe(200);

    const byAdmin = await request(users.owner, `/api/v1/groups/${created.group.id}/shares/${share.id}`, {
      method: "DELETE",
    });
    expect(byAdmin.status).toBe(200);

    const after = await (await request(users.alice, `/api/v1/groups/${created.group.id}/shares`)).json();
    expect(after.shares).toEqual([]);
  });

  test("reports the shares I created separately", async () => {
    const { request } = createHarness();
    const created = await (await request(users.owner, "/api/v1/groups", json({ name: "家庭" }))).json();
    await request(users.owner, `/api/v1/groups/${created.group.id}/members`, json({ userIds: ["usr_alice"] }));
    await request(
      users.alice,
      `/api/v1/groups/${created.group.id}/shares`,
      json({ targetType: "memo", targetId: "memo_alice", editMode: "author", editorUserIds: [] }),
    );

    const overview = await (await request(users.alice, "/api/v1/shared-with-me")).json();
    expect(overview.sharedByMe).toEqual([
      expect.objectContaining({ targetId: "memo_alice", targetType: "memo", groupName: "家庭" }),
    ]);
    expect(overview.memos).toEqual([]);
  });
});
