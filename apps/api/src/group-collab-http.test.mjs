import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { registerMemoRoutes } from "./memo-routes.ts";
import { registerGroupRoutes } from "./group-routes.ts";
import { createGroupAccount } from "./group-account-service.ts";
import { createGroup, createGroupShare } from "./group-service.ts";

// --- Minimal D1-over-sqlite shim (same pattern as group-service.test.mjs) ---

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

const iso = "2026-01-01T00:00:00.000Z";

const createEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }

  const seedUser = (id, username, accountType = "user") => {
    sqlite
      .query(
        `INSERT INTO users (id, username, password_hash, display_name, account_type, created_at, updated_at)
         VALUES (?, ?, 'hash', ?, ?, ?, ?)`,
      )
      .run(id, username, username, accountType, iso, iso);
    sqlite
      .query(`INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .run(`ws_${id}`, `${username} workspace`, iso, iso);
    sqlite
      .query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .run(`ws_${id}`, id, iso);
  };

  const seedNotebook = (id, workspaceId) => {
    sqlite
      .query(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'notebook', '#000', 0, ?, ?)`,
      )
      .run(id, workspaceId, id, id, iso, iso);
  };

  const seedMemo = (id, workspaceId, notebookId, contentJson, contentMarkdown, creatorId) => {
    const owner = creatorId ?? workspaceId.replace(/^ws_/, "");
    sqlite
      .query(
        `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt, tags_json, is_pinned,
            is_archived, is_deleted, source_memo_ids, merge_source_count, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '[]', 0, 0, 0, '[]', 0, ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, notebookId, id, owner, owner, iso, iso);
    sqlite
      .query(
        `INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'hash', 1, ?, ?)`,
      )
      .run(id, JSON.stringify(contentJson), contentMarkdown, "seed", iso, iso);
  };

  return { sqlite, database: new SqliteD1Database(sqlite), seedUser, seedNotebook, seedMemo };
};

const NB = "nb_auth";

const htmlCodeBlock = {
  type: "codeBlock",
  attrs: { language: "html" },
  content: [{ type: "text", text: "<script>alert(1)</script>" }],
};

const markdownCodeBlock = {
  type: "codeBlock",
  attrs: { language: "markdown" },
  content: [{ type: "text", text: "# secret plan" }],
};

const seedDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "intro" }] }, htmlCodeBlock, markdownCodeBlock] };

const buildApp = (env, auth) => {
  const app = new Hono();
  app.onError((error, context) => {
    console.error("[test-app-error]", error instanceof Error ? error.message : error);
    return context.json({ error: "internal" }, 500);
  });
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  registerMemoRoutes(app, {
    clampNumber: (value, min, max) => Math.min(Math.max(value, min), max),
    createMemo: async () => { throw new Error("not used"); },
    createMemoEditSession: async () => null,
    deleteMemo: async () => {},
    deleteMemos: async () => 0,
    emptyTrash: async () => 0,
    getMemoDetail: async (_db, workspaceId, memoId) => {
      // The adapter is promise-based: without this await the row is a pending
      // Promise, so JSON.parse(row.content_json) would parse undefined.
      const row = await env.database
        .prepare(`SELECT m.id, m.workspace_id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
              m.is_archived, m.is_deleted, m.source_memo_ids, m.merge_source_count, m.created_at, m.updated_at,
              c.content_json, c.content_markdown, c.content_text, c.content_hash, m.merged_into_memo_id
       FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
       WHERE m.id = ? AND m.workspace_id = ?`)
        .bind(memoId, workspaceId)
        .first();
      if (!row) return null;
      return {
        id: row.id,
        notebookId: row.notebook_id,
        title: row.title,
        excerpt: row.excerpt,
        tags: [],
        isPinned: false,
        isArchived: false,
        isDeleted: row.is_deleted === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revision: 1,
        contentJson: JSON.parse(row.content_json),
        contentMarkdown: row.content_markdown,
        contentText: row.content_text,
        contentHash: row.content_hash,
        sourceMemoIds: [],
        mergedIntoMemoId: null,
      };
    },
    listMemoRevisions: async () => [],
    listMemos: async () => ({ memos: [], totalCount: 0, nextCursor: null }),
    mergeMemos: async () => { throw new Error("not used"); },
    moveMemos: async () => 0,
    restoreMemo: async () => { throw new Error("not used"); },
    restoreMemoRevision: async () => { throw new Error("not used"); },
    updateMemo: async () => { throw new Error("not used"); },
  });
  registerGroupRoutes(app, {
    authenticateRequest: async (context) => context.get("auth") ?? null,
  });
  return app;
};

describe("instance administrator group visibility", () => {
  test("site owner and administrators see every group, members only their own", async () => {
    const env = createEnvironment();
    env.seedUser("usr_owner", "site-owner");
    env.seedUser("usr_admin", "admin-user");
    env.seedUser("usr_alice", "alice");

    const aliceGroup = await createGroup(env.database, { name: "Alice 的组", description: null, createdBy: "usr_alice" });
    const adminGroup = await createGroup(env.database, { name: "Admin 的组", description: null, createdBy: "usr_admin" });
    const expectedAll = [aliceGroup.id, adminGroup.id].sort();

    const adminApp = buildApp(env, {
      kind: "user", actorType: "user", actorId: "usr_admin", username: "admin-user",
      displayName: null, scopes: [], workspaceId: "ws_usr_admin", role: "admin", accountType: "user",
    });
    const adminList = await (await adminApp.request("/api/v1/groups", {}, { storage: { db: env.database }, env: {} })).json();
    expect(adminList.groups.map((group) => group.id).sort()).toEqual(expectedAll);

    const ownerApp = buildApp(env, {
      kind: "user", actorType: "user", actorId: "usr_owner", username: "site-owner",
      displayName: null, scopes: [], workspaceId: "ws_usr_owner", role: "owner", accountType: "user",
    });
    const ownerList = await (await ownerApp.request("/api/v1/groups", {}, { storage: { db: env.database }, env: {} })).json();
    expect(ownerList.groups.map((group) => group.id).sort()).toEqual(expectedAll);

    const aliceApp = buildApp(env, {
      kind: "user", actorType: "user", actorId: "usr_alice", username: "alice",
      displayName: null, scopes: [], workspaceId: "ws_usr_alice", role: "member", accountType: "user",
    });
    const aliceList = await (await aliceApp.request("/api/v1/groups", {}, { storage: { db: env.database }, env: {} })).json();
    expect(aliceList.groups.map((group) => group.id)).toEqual([aliceGroup.id]);
  });
});

describe("group share display policy over HTTP", () => {
  test("a group member reading a shared note receives a policy-filtered document", async () => {
    const env = createEnvironment();
    env.seedUser("usr_author", "author");
    env.seedUser("usr_reader", "reader");
    env.seedNotebook(NB, "ws_usr_author");
    env.seedMemo("memo_html", "ws_usr_author", NB, seedDoc, "# intro");

    // createGroup seeds usr_author as manager; the reader joins separately.
    const group = await createGroup(env.database, { name: "研发", description: null, createdBy: null });
    await env.database
      .prepare(`INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .bind(group.id, "usr_reader", iso)
      .run();
    await createGroupShare(env.database, {
      groupId: group.id,
      targetType: "notebook",
      targetId: NB,
      sourceWorkspaceId: "ws_usr_author",
      editMode: "author",
      editorUserIds: [],
      displayPolicy: { html: "hidden", markdown: "source" },
      note: null,
      createdBy: "usr_author",
    });

    const app = buildApp(env, { kind: "user", actorType: "user", actorId: "usr_reader", username: "reader", displayName: "Reader", scopes: [], workspaceId: "ws_usr_reader", role: "member", accountType: "user" });
    const response = await app.request(
      "/api/v1/memos/memo_html",
      {},
      { storage: { db: env.database }, env: {} },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.access.shared).toBe(true);
    expect(body.access.authorUsername).toBe("author");
    expect(body.access.authorDisplayName).toBe("author");
    expect(body.displayPolicy).toEqual({ html: "hidden", markdown: "source" });

    const blocks = body.memo.contentJson.content;
    const htmlBlock = blocks.find((node) => node.type === "codeBlock" && node.attrs?.language === "html");
    // "source" rewrites the markdown block's language to plaintext, so locate
    // it by its post-policy language instead of its original one.
    const markdownBlock = blocks.find((node) => node.type === "codeBlock" && node.attrs?.language === "plaintext");
    expect(htmlBlock).toBeDefined();
    expect(JSON.stringify(htmlBlock.content[0].text)).toContain("不公开");
    expect(JSON.stringify(htmlBlock.content[0].text)).not.toContain("alert");
    expect(markdownBlock.attrs.language).toBe("plaintext");
    expect(JSON.stringify(markdownBlock.content[0].text)).not.toContain("secret plan");
  });

  test("the author still reads the full document and receives no display policy", async () => {
    const env = createEnvironment();
    env.seedUser("usr_author", "author");
    env.seedNotebook(NB, "ws_usr_author");
    env.seedMemo("memo_html", "ws_usr_author", NB, seedDoc, "# intro");

    const app = buildApp(env, { kind: "user", actorType: "user", actorId: "usr_author", username: "author", displayName: "Author", scopes: [], workspaceId: "ws_usr_author", role: "member", accountType: "user" });
    const response = await app.request(
      "/api/v1/memos/memo_html",
      {},
      { storage: { db: env.database }, env: {} },
    );
    const body = await response.json();
    expect(body.displayPolicy).toBeUndefined();
    const htmlBlock = body.memo.contentJson.content.find((node) => node.type === "codeBlock");
    expect(htmlBlock.content[0].text).toContain("alert");
  });
});

describe("collab presence routes", () => {
  const presenceEnv = () => {
    const env = createEnvironment();
    env.seedUser("usr_author", "author");
    env.seedUser("usr_peer", "peer");
    env.seedUser("usr_outsider", "outsider");
    env.seedNotebook(NB, "ws_usr_author");
    env.seedMemo("memo_shared", "ws_usr_author", NB, seedDoc, "# intro");
    return env;
  };

  const authFor = (userId, workspaceId) => ({
    kind: "user", actorType: "user", actorId: userId, username: userId, displayName: userId,
    scopes: [], workspaceId, role: "member", accountType: "user",
  });

  test("a group editor records presence and sees the peer list", async () => {
    const env = presenceEnv();
    // createGroup seeds usr_author as manager; add usr_peer as plain member.
    const group = await createGroup(env.database, { name: "研发", description: null, createdBy: "usr_author" });
    await env.database
      .prepare(`INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .bind(group.id, "usr_peer", iso)
      .run();
    await createGroupShare(env.database, {
      groupId: group.id,
      targetType: "notebook",
      targetId: NB,
      sourceWorkspaceId: "ws_usr_author",
      editMode: "group",
      editorUserIds: [],
      displayPolicy: { html: "rendered", markdown: "rendered" },
      note: null,
      createdBy: "usr_author",
    });

    const app = buildApp(env, authFor("usr_peer", "ws_usr_peer"));
    const response = await app.request(
      "/api/v1/memos/memo_shared/collab-heartbeat",
      { method: "POST" },
      { storage: { db: env.database }, env: {} },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.peers.some((peer) => peer.isSelf)).toBe(true);
  });

  test("a non-member cannot heartbeat and gets 404 like any hidden note", async () => {
    const env = presenceEnv();
    const app = buildApp(env, authFor("usr_outsider", "ws_usr_outsider"));
    const response = await app.request(
      "/api/v1/memos/memo_shared/collab-heartbeat",
      { method: "POST" },
      { storage: { db: env.database }, env: {} },
    );
    expect(response.status).toBe(404);
  });
});

describe("shared group account joins groups (service level)", () => {
  test("created account lands in requested groups and is a member, not manager", async () => {
    const env = createEnvironment();
    env.seedUser("usr_admin", "admin");
    const created = await createGroupAccount(env.database, {
      name: "ops",
      displayName: null,
      password: "super-secret-pass",
      createdBy: "usr_admin",
    });
    expect(created.ok).toBe(true);
    const groups = await env.database
      .prepare(`SELECT role FROM group_members WHERE user_id = ?`)
      .bind(created.userId)
      .all();
    expect(groups.results).toHaveLength(0);
  });
});

describe("realtime collaboration session handshake", () => {
  // The collaboration socket validates its upgrade by replaying it against this
  // endpoint, so these assertions are the socket's real access control.
  const setup = async ({ editMode }) => {
    const env = createEnvironment();
    env.seedUser("usr_author", "author");
    env.seedUser("usr_peer", "peer");
    env.seedUser("usr_outsider", "outsider");
    env.seedNotebook(NB, "ws_usr_author");
    env.seedMemo("memo_shared", "ws_usr_author", NB, seedDoc, "# intro");

    const group = await createGroup(env.database, { name: "研发", description: null, createdBy: "usr_author" });
    await env.database
      .prepare(`INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .bind(group.id, "usr_peer", iso)
      .run();
    await createGroupShare(env.database, {
      groupId: group.id,
      targetType: "notebook",
      targetId: NB,
      sourceWorkspaceId: "ws_usr_author",
      editMode,
      editorUserIds: [],
      displayPolicy: { html: "rendered", markdown: "rendered" },
      note: null,
      createdBy: "usr_author",
    });
    return env;
  };

  const authFor = (userId) => ({
    kind: "user", actorType: "user", actorId: userId, username: userId, displayName: userId,
    scopes: [], workspaceId: `ws_${userId}`, role: "member", accountType: "user",
  });

  const openSession = (env, userId) => buildApp(env, authFor(userId)).request(
    "/api/v1/memos/memo_shared/collab-session",
    {},
    { storage: { db: env.database }, env: {} },
  );

  test("a group editor receives write access plus group identity", async () => {
    const env = await setup({ editMode: "group" });
    const response = await openSession(env, "usr_peer");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canEdit).toBe(true);
    expect(body.memoId).toBe("memo_shared");
    expect(body.groupName).toBe("研发");
    expect(body.displayName).toBe("usr_peer");
  });

  test("a read-only member connects without gaining write access", async () => {
    const env = await setup({ editMode: "author" });
    const response = await openSession(env, "usr_peer");
    expect(response.status).toBe(200);
    expect((await response.json()).canEdit).toBe(false);
  });

  test("a non-member is rejected like any hidden note", async () => {
    const env = await setup({ editMode: "group" });
    expect((await openSession(env, "usr_outsider")).status).toBe(404);
  });

  test("the author always keeps write access to their own note", async () => {
    const env = await setup({ editMode: "author" });
    const response = await openSession(env, "usr_author");
    expect(response.status).toBe(200);
    expect((await response.json()).canEdit).toBe(true);
  });
});
