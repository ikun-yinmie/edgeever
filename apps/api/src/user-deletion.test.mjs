import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { permanentUserDeletionStatements } from "./user-routes.ts";

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

const openDatabase = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  return sqlite;
};

const seedMember = (sqlite, { userId, workspaceId, suffix }) => {
  sqlite.query(
    `INSERT INTO users (id, username, password_hash, display_name)
     VALUES (?, ?, 'hash', ?)`,
  ).run(userId, `member_${suffix}`, `Member ${suffix}`);
  sqlite.query(`INSERT INTO workspaces (id, name, is_personal) VALUES (?, ?, 1)`)
    .run(workspaceId, `${suffix} workspace`);
  sqlite.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')`)
    .run(workspaceId, userId);
  sqlite.query(
    `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order)
     VALUES (?, ?, NULL, 'Inbox', 'inbox', 0)`,
  ).run(`nb_${suffix}`, workspaceId);
  sqlite.query(
    `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt, tags_json)
     VALUES (?, ?, ?, 'Note', '', '["tag"]')`,
  ).run(`memo_${suffix}`, workspaceId, `nb_${suffix}`);
  sqlite.query(
    `INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash)
     VALUES (?, '{"type":"doc","content":[]}', '', ?, ?)`,
  ).run(`memo_${suffix}`, `needle_${suffix}`, `hash_${suffix}`);
  sqlite.query(
    `INSERT INTO memo_search_documents (memo_id, title, content_text, tags)
     VALUES (?, 'Note', ?, 'tag')`,
  ).run(`memo_${suffix}`, `needle_${suffix}`);
  sqlite.query(
    `INSERT INTO resources (id, memo_id, object_key, kind, byte_size)
     VALUES (?, ?, ?, 'attachment', 10)`,
  ).run(`res_${suffix}`, `memo_${suffix}`, `objects/${suffix}.txt`);
  sqlite.query(
    `INSERT INTO api_tokens (id, workspace_id, name, token_hash) VALUES (?, ?, 'token', ?)`,
  ).run(`tok_${suffix}`, workspaceId, `token_hash_${suffix}`);
  sqlite.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, '2027-01-01T00:00:00.000Z')`,
  ).run(`ses_${suffix}`, userId, `session_hash_${suffix}`);
};

const count = (sqlite, sql, ...bindings) => sqlite.query(sql).get(...bindings).count;

describe("permanent member deletion", () => {
  test("purges one member's workspace and account without touching anyone else", async () => {
    const sqlite = openDatabase();
    const database = new SqliteD1Database(sqlite);
    seedMember(sqlite, { userId: "usr_a", workspaceId: "ws_a", suffix: "a" });
    seedMember(sqlite, { userId: "usr_b", workspaceId: "ws_b", suffix: "b" });
    sqlite.query(`INSERT INTO groups (id, name, created_by) VALUES ('grp_1', 'Team', 'usr_admin')`).run();
    sqlite.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ('grp_1', 'usr_a', 'member')`).run();
    sqlite.query(
      `INSERT INTO group_shares (id, group_id, target_type, target_id, source_workspace_id, created_by)
       VALUES ('share_1', 'grp_1', 'memo', 'memo_a', 'ws_a', 'usr_a')`,
    ).run();

    await database.batch(
      permanentUserDeletionStatements(database, {
        userId: "usr_a",
        workspaceIds: ["ws_a"],
        auditActorId: "usr_admin",
        metadata: { username: "member_a" },
      }),
    );

    expect(count(sqlite, `SELECT COUNT(*) AS count FROM users WHERE id = 'usr_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM workspaces WHERE id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM workspace_members WHERE user_id = 'usr_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memos WHERE workspace_id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memo_contents WHERE memo_id = 'memo_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memo_search_documents WHERE memo_id = 'memo_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memo_tags WHERE workspace_id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM resources WHERE id = 'res_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM api_tokens WHERE workspace_id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'usr_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM group_members WHERE user_id = 'usr_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM group_shares WHERE source_workspace_id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM mobile_sync_changes WHERE workspace_id = 'ws_a'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memos_fts WHERE memos_fts MATCH 'needle_a'`)).toBe(0);

    expect(count(sqlite, `SELECT COUNT(*) AS count FROM users WHERE id = 'usr_b'`)).toBe(1);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM workspaces WHERE id = 'ws_b'`)).toBe(1);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memos WHERE workspace_id = 'ws_b'`)).toBe(1);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM resources WHERE id = 'res_b'`)).toBe(1);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'usr_b'`)).toBe(1);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM memos_fts WHERE memos_fts MATCH 'needle_b'`)).toBe(1);

    expect(
      sqlite.query(`SELECT action FROM audit_events WHERE entity_id = 'usr_a'`).all(),
    ).toEqual([{ action: "user.delete" }]);
    sqlite.close();
  });

  test("removes an account that has no workspace of its own", async () => {
    const sqlite = openDatabase();
    const database = new SqliteD1Database(sqlite);
    sqlite.query(
      `INSERT INTO users (id, username, password_hash) VALUES ('usr_detached', 'detached', 'hash')`,
    ).run();
    sqlite.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ('ses_detached', 'usr_detached', 'session_detached', '2027-01-01T00:00:00.000Z')`,
    ).run();

    await database.batch(
      permanentUserDeletionStatements(database, {
        userId: "usr_detached",
        workspaceIds: [],
        auditActorId: "usr_admin",
      }),
    );

    expect(count(sqlite, `SELECT COUNT(*) AS count FROM users WHERE id = 'usr_detached'`)).toBe(0);
    expect(count(sqlite, `SELECT COUNT(*) AS count FROM sessions WHERE user_id = 'usr_detached'`)).toBe(0);
    sqlite.close();
  });
});
