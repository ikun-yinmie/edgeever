import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCollabMemoWriter } from "./collab-memo-writer.ts";

// --- Minimal D1-over-sqlite shim (same pattern as group-collab-http.test.mjs) ---

class Statement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) {
    return new Statement(this.db, this.sql, bindings);
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

const asAdapter = (db) => ({
  prepare: (sql) => new Statement(db, sql),
  batch: async (statements) => {
    for (const statement of statements) await statement.run();
    return [];
  },
});

const seedDatabase = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE memos (
      id TEXT PRIMARY KEY, title TEXT, excerpt TEXT, tags_json TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE memo_contents (
      memo_id TEXT PRIMARY KEY, content_json TEXT, content_markdown TEXT,
      content_text TEXT, content_hash TEXT, revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE memo_search_documents (
      memo_id TEXT PRIMARY KEY, title TEXT, content_text TEXT, tags TEXT
    );
  `);
  sqlite.query(
    `INSERT INTO memos (id, title, excerpt, tags_json, is_deleted, updated_at)
     VALUES ('m1', 'Note', 'intro', '["t1"]', 0, '2026-01-01T00:00:00.000Z')`,
  ).run();
  sqlite.query(
    `INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash, revision, updated_at)
     VALUES ('m1', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"intro"}]}]}',
             'intro', 'intro', 'seed-hash', 1, '2026-01-01T00:00:00.000Z')`,
  ).run();
  return { sqlite, database: asAdapter(sqlite) };
};

const mergedDoc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "intro plus alice" }] },
    { type: "paragraph", content: [{ type: "text", text: "and bob", marks: [{ type: "bold", attrs: {} }] }] },
  ],
};

describe("collab memo writer", () => {
  test("writes the merged document into every consumer column", async () => {
    const env = seedDatabase();
    const writer = createCollabMemoWriter(env.database);

    const result = await writer.materialize("m1", mergedDoc);
    expect(result.materialized).toBe(true);
    expect(typeof result.contentHash).toBe("string");

    const contents = env.sqlite.query(`SELECT * FROM memo_contents WHERE memo_id = 'm1'`).get();
    expect(JSON.parse(contents.content_json)).toEqual(mergedDoc);
    expect(contents.revision).toBe(2);
    expect(contents.content_hash).toBe(result.contentHash);
    expect(contents.content_text).toContain("intro plus alice");
    expect(contents.content_text).toContain("and bob");
    expect(contents.content_markdown).toContain("intro plus alice");

    const memo = env.sqlite.query(`SELECT excerpt, updated_at FROM memos WHERE id = 'm1'`).get();
    expect(memo.excerpt.length).toBeGreaterThan(0);
    expect(memo.updated_at).not.toBe("2026-01-01T00:00:00.000Z");

    const search = env.sqlite.query(`SELECT title, content_text FROM memo_search_documents WHERE memo_id = 'm1'`).get();
    expect(search.title).toBe("Note");
    expect(search.content_text).toContain("and bob");
  });

  test("skips the write when the merged content is unchanged", async () => {
    const env = seedDatabase();
    const writer = createCollabMemoWriter(env.database);

    const before = env.sqlite.query(`SELECT revision, updated_at FROM memo_contents WHERE memo_id = 'm1'`).get();
    const first = await writer.materialize("m1", mergedDoc);
    expect(first.materialized).toBe(true);

    const second = await writer.materialize("m1", mergedDoc);
    expect(second.materialized).toBe(false);
    expect(second.contentHash).toBe(first.contentHash);
    const after = env.sqlite.query(`SELECT revision FROM memo_contents WHERE memo_id = 'm1'`).get();
    expect(after.revision).toBe(before.revision + 1);
  });

  test("leaves deleted notes alone", async () => {
    const env = seedDatabase();
    env.sqlite.query(`UPDATE memos SET is_deleted = 1 WHERE id = 'm1'`).run();
    const writer = createCollabMemoWriter(env.database);

    const result = await writer.materialize("m1", mergedDoc);
    expect(result).toEqual({ materialized: false, contentHash: null });
    const contents = env.sqlite.query(`SELECT revision FROM memo_contents WHERE memo_id = 'm1'`).get();
    expect(contents.revision).toBe(1);
  });

  test("leaves unknown notes alone", async () => {
    const env = seedDatabase();
    const writer = createCollabMemoWriter(env.database);
    expect(await writer.materialize("missing", mergedDoc)).toEqual({ materialized: false, contentHash: null });
  });

  test("throws for a database without a prepare() method", () => {
    expect(() => createCollabMemoWriter({})).toThrow(
      "createCollabMemoWriter requires a database adapter with a prepare() method",
    );
  });
});
