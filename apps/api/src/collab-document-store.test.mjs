import { describe, expect, test } from "bun:test";
import { createCollabDocumentStore } from "./collab-document-store.ts";

// --- Minimal D1-shaped shim over a plain map (same contract the store uses) ---

const createMapAdapter = () => {
  const rows = new Map();
  const statement = (sql, bindings = []) => ({
    sql,
    bindings,
    bind(...next) {
      return statement(sql, next);
    },
    async first() {
      if (sql.startsWith("SELECT state")) {
        const row = rows.get(bindings[0]);
        return row ? { state: row.state, content_hash: row.contentHash ?? null } : null;
      }
      return null;
    },
    async run() {
      if (sql.startsWith("INSERT INTO memo_collab_documents")) {
        const withHash = sql.includes("content_hash");
        rows.set(bindings[0], {
          state: bindings[1],
          contentHash: withHash ? bindings[2] : (rows.get(bindings[0])?.contentHash ?? null),
          updatedAt: withHash ? bindings[3] : bindings[2],
        });
      }
      if (sql.startsWith("UPDATE memo_collab_documents SET content_hash")) {
        const row = rows.get(bindings[1]);
        if (row) row.contentHash = bindings[0];
      }
      if (sql.startsWith("DELETE FROM memo_collab_documents")) {
        rows.delete(bindings[0]);
      }
      return { success: true };
    },
  });
  return { prepare: (sql) => statement(sql), rows };
};

const stateOf = (text) => new TextEncoder().encode(text);

describe("collab document store", () => {
  test("a fresh store has no document for any memo id", async () => {
    const store = createCollabDocumentStore(createMapAdapter());
    expect(await store.load("memo-one")).toBe(null);
    expect(await store.loadWithHash("memo-one")).toEqual({ state: null, contentHash: null });
  });

  test("throws for a database without a prepare() method", () => {
    expect(() => createCollabDocumentStore({})).toThrow(
      "createCollabDocumentStore requires a database adapter with a prepare() method",
    );
    expect(() => createCollabDocumentStore(null)).toThrow(
      "createCollabDocumentStore requires a database adapter with a prepare() method",
    );
  });

  test("save and load round-trip the merged state", async () => {
    const adapter = createMapAdapter();
    const store = createCollabDocumentStore(adapter);

    await store.save("m1", stateOf("hello"));
    expect(await store.load("m1")).toEqual(stateOf("hello"));

    // A second save advances cleanly.
    await store.save("m1", stateOf("hello world"));
    expect(await store.load("m1")).toEqual(stateOf("hello world"));
    const row = adapter.rows.get("m1");
    expect(typeof row.updatedAt).toBe("string");
  });

  test("content hashes ride along with the state for staleness checks", async () => {
    const store = createCollabDocumentStore(createMapAdapter());

    await store.saveWithHash("m1", stateOf("abc"), "hash-one");
    expect(await store.loadWithHash("m1")).toEqual({ state: stateOf("abc"), contentHash: "hash-one" });

    await store.setContentHash("m1", "hash-two");
    expect(await store.loadWithHash("m1")).toEqual({ state: stateOf("abc"), contentHash: "hash-two" });
  });

  test("one memo does not leak state to another memo", async () => {
    const store = createCollabDocumentStore(createMapAdapter());
    await store.save("a", stateOf("a"));
    expect(await store.load("b")).toBe(null);
  });

  test("remove drops the document", async () => {
    const store = createCollabDocumentStore(createMapAdapter());
    await store.save("m1", stateOf("abc"));
    await store.remove("m1");
    expect(await store.load("m1")).toBe(null);
    expect(await store.loadWithHash("m1")).toEqual({ state: null, contentHash: null });
  });

  test("blob rows survive a driver that hands back array-likes", async () => {
    const raw = { state: Array.from(stateOf("hi")), content_hash: "h" };
    const store = createCollabDocumentStore({
      prepare: () => ({
        bind: () => ({
          first: async () => raw,
          run: async () => ({ success: true }),
        }),
      }),
    });
    const loaded = await store.loadWithHash("m1");
    expect(loaded.state).toEqual(stateOf("hi"));
    expect(loaded.contentHash).toBe("h");
  });

  test("a persisted store hydrates new instances from the same sqlite db", async () => {
    const { tmpdir } = await import("node:os");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { Database } = await import("bun:sqlite");
    const { join } = await import("node:path");

    // The store speaks the D1-shaped prepare/bind contract; wrap raw sqlite
    // the same way the sibling API tests do.
    class Statement {
      constructor(db, sql, bindings = []) {
        this.db = db;
        this.sql = sql;
        this.bindings = bindings;
      }
      bind(...bindings) {
        return new Statement(this.db, this.sql, bindings);
      }
      async first() {
        return this.db.query(this.sql).get(...this.bindings) ?? null;
      }
      async run() {
        this.db.query(this.sql).run(...this.bindings);
        return { success: true };
      }
    }
    const asAdapter = (db) => ({ prepare: (sql) => new Statement(db, sql) });

    const dir = await mkdtemp(join(tmpdir(), "collab-store-"));
    const path = join(dir, "x.sqlite");
    const seed = new Database(path, { create: true });
    seed.exec(`
      CREATE TABLE memo_collab_documents (
        memo_id TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        content_hash TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    seed.close();

    const first = createCollabDocumentStore(asAdapter(new Database(path)));
    await first.saveWithHash("persist-me", stateOf("persisted"), "hash-p");

    const second = createCollabDocumentStore(asAdapter(new Database(path)));
    expect(await second.loadWithHash("persist-me")).toEqual({ state: stateOf("persisted"), contentHash: "hash-p" });

    await rm(dir, { recursive: true, force: true });
  });
});
