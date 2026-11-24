import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { runMemoWriteBatch } from "./memo-write-guard.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

const environment = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE memos (id TEXT PRIMARY KEY, is_deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memo_contents (memo_id TEXT PRIMARY KEY, revision INTEGER, content_hash TEXT, content_text TEXT);
    CREATE TABLE effects (id TEXT PRIMARY KEY);
    INSERT INTO memos VALUES ('m1', 0);
    INSERT INTO memo_contents VALUES ('m1', 1, 'base-hash', 'saved body');
  `);
  sqlite.exec(readFileSync(new URL("../../../migrations/0070_memo_write_checks.sql", import.meta.url), "utf8"));
  const { db } = createSelfHostedStorageAdapter(sqlite, "/unused-test-resources");
  return { sqlite, db };
};
const base = { id: "m1", revision: 1, content_hash: "base-hash" };

const mutation = (db) => [
  db.prepare("INSERT INTO effects VALUES ('history')"),
  db.prepare("UPDATE memo_contents SET revision = 2, content_hash = 'new-hash', content_text = 'new body' WHERE memo_id = 'm1'"),
  db.prepare("INSERT INTO effects VALUES ('audit')"),
];

describe("atomic memo write guard", () => {
  test("commits every effect on the current base and removes its assertion", async () => {
    const { sqlite, db } = environment();
    try {
      const results = await runMemoWriteBatch(db, base, mutation(db));
      expect(results).toHaveLength(3);
      expect(sqlite.query("SELECT revision, content_text FROM memo_contents").get())
        .toEqual({ revision: 2, content_text: "new body" });
      expect(sqlite.query("SELECT count(*) AS count FROM effects").get().count).toBe(2);
      expect(sqlite.query("SELECT count(*) AS count FROM memo_write_checks").get().count).toBe(0);
    } finally { sqlite.close(); }
  });

  for (const [name, change] of [
    ["revision changed", "UPDATE memo_contents SET revision = 2"],
    ["hash changed without a revision bump", "UPDATE memo_contents SET content_hash = 'outside-hash'"],
    ["note deleted", "UPDATE memos SET is_deleted = 1"],
    ["note permanently removed", "DELETE FROM memos"],
  ]) {
    test(`rolls back every effect when ${name}`, async () => {
      const { sqlite, db } = environment();
      try {
        sqlite.exec(change);
        const before = sqlite.query("SELECT * FROM memo_contents").get();
        await expect(runMemoWriteBatch(db, base, mutation(db)))
          .rejects.toMatchObject({ code: "revision_conflict", status: 409 });
        expect(sqlite.query("SELECT * FROM memo_contents").get()).toEqual(before);
        expect(sqlite.query("SELECT count(*) AS count FROM effects").get().count).toBe(0);
        expect(sqlite.query("SELECT count(*) AS count FROM memo_write_checks").get().count).toBe(0);
      } finally { sqlite.close(); }
    });
  }

  test("does not disguise an unrelated storage failure as a conflict", async () => {
    const { sqlite, db } = environment();
    try {
      await expect(runMemoWriteBatch(db, base, [
        ...mutation(db), db.prepare("INSERT INTO effects VALUES ('audit')"),
      ])).rejects.toThrow("UNIQUE constraint failed");
      expect(sqlite.query("SELECT content_text FROM memo_contents").get().content_text).toBe("saved body");
      expect(sqlite.query("SELECT count(*) AS count FROM effects").get().count).toBe(0);
      expect(sqlite.query("SELECT count(*) AS count FROM memo_write_checks").get().count).toBe(0);
    } finally { sqlite.close(); }
  });

  test("recognizes the named assertion in a D1-style error", async () => {
    const { sqlite, db } = environment();
    try {
      const d1 = {
        prepare: (sql) => db.prepare(sql),
        batch: async () => { throw new Error("D1_ERROR: CHECK constraint failed: memo_write_current: SQLITE_CONSTRAINT"); },
      };
      await expect(runMemoWriteBatch(d1, base, []))
        .rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    } finally { sqlite.close(); }
  });
});
