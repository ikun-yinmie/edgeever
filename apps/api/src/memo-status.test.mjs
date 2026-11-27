import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { createMemoRecord, getMemoDetail, updateMemoRecord } from "./memo-service.ts";
import { restoreJsonMemos } from "./backup-service.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { MemoCreateSchema, MemoUpdateSchema } from "@edgeever/shared";

let sqlite;
let db;
let memo;
let notebookId;
const actor = { actorType: "user", actorId: "alice" };
const migrations = () => globSync("migrations/*.sql").sort();

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const path of migrations()) sqlite.exec(readFileSync(path, "utf8"));
  db = createSelfHostedStorageAdapter(sqlite, "/unused-test-resources").db;
  notebookId = sqlite.query("SELECT id FROM notebooks WHERE workspace_id = 'ws_default' AND is_deleted = 0 LIMIT 1").get().id;
  memo = await createMemoRecord(db, "ws_default", {
    notebookId,
    title: "Status note",
    contentMarkdown: "Original body",
  }, actor, "user:alice");
});

afterEach(() => sqlite.close());

describe("memo status persistence", () => {
  test("applies the new migration to legacy rows without changing note content", async () => {
    const legacyDb = new Database(":memory:");
    try {
      legacyDb.exec("PRAGMA foreign_keys = ON");
      for (const path of migrations().filter((migration) => !migration.endsWith("0074_memo_status.sql"))) {
        legacyDb.exec(readFileSync(path, "utf8"));
      }
      const legacyNotebookId = legacyDb.query(
        "SELECT id FROM notebooks WHERE workspace_id = 'ws_default' AND is_deleted = 0 LIMIT 1",
      ).get().id;
      const contentJson = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Legacy body" }] }] });
      legacyDb.query(`INSERT INTO memos (
        id, workspace_id, notebook_id, title, excerpt, created_by, updated_by, created_at, updated_at
      ) VALUES ('memo_legacy', 'ws_default', ?, 'Legacy title', 'Legacy body', 'user', 'user', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run(legacyNotebookId);
      legacyDb.query(`INSERT INTO memo_contents (
        memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at
      ) VALUES ('memo_legacy', ?, 'Legacy body', 'Legacy body', 'legacy-hash', 7, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run(contentJson);

      legacyDb.exec(readFileSync("migrations/0074_memo_status.sql", "utf8"));
      expect(legacyDb.query("SELECT status FROM memos WHERE id = 'memo_legacy'").get().status).toBeNull();
      const legacyAdapter = createSelfHostedStorageAdapter(legacyDb, "/unused-test-resources").db;
      expect(await getMemoDetail(legacyAdapter, "ws_default", "memo_legacy")).toMatchObject({
        title: "Legacy title",
        status: null,
        contentMarkdown: "Legacy body",
        contentHash: "legacy-hash",
        revision: 7,
      });
    } finally {
      legacyDb.close();
    }
  });

  test("persists all supported states, allows clearing, and leaves omitted status unchanged", async () => {
    expect(memo.status).toBeNull();
    for (const status of ["in_progress", "completed", "cancelled"]) {
      const result = await updateMemoRecord(db, "ws_default", memo.id, { status }, actor, "user:alice");
      expect(result.memo.status).toBe(status);
    }

    expect((await updateMemoRecord(db, "ws_default", memo.id, { status: null }, actor, "user:alice")).memo.status).toBeNull();
    expect((await updateMemoRecord(db, "ws_default", memo.id, { status: "completed" }, actor, "user:alice")).memo.status).toBe("completed");
    expect((await updateMemoRecord(db, "ws_default", memo.id, {}, actor, "user:alice")).memo.status).toBe("completed");
    expect(MemoCreateSchema.safeParse({ notebookId, status: null }).success).toBe(true);
    expect(MemoUpdateSchema.safeParse({ status: undefined }).success).toBe(true);
    expect(MemoUpdateSchema.safeParse({ status: "pending" }).success).toBe(false);
    await expect(updateMemoRecord(db, "ws_default", memo.id, { status: "pending" }, actor, "user:alice")).rejects.toThrow();
    expect((await getMemoDetail(db, "ws_default", memo.id)).status).toBe("completed");
  });

  test("status-only writes do not change content hash or revision, and body saves preserve status", async () => {
    const before = await getMemoDetail(db, "ws_default", memo.id);
    const updated = await updateMemoRecord(db, "ws_default", memo.id, { status: "in_progress" }, actor, "user:alice");
    expect(updated.memo).toMatchObject({ status: "in_progress", contentHash: before.contentHash, revision: before.revision });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM memo_revisions WHERE memo_id = ?").get(memo.id).count).toBe(0);

    const saved = await updateMemoRecord(db, "ws_default", memo.id, { contentMarkdown: "Edited body" }, actor, "user:alice");
    expect(saved.memo).toMatchObject({ status: "in_progress", contentMarkdown: "Edited body", revision: before.revision + 1 });
  });

  test("round-trips status through JSON backup restoration", async () => {
    await updateMemoRecord(db, "ws_default", memo.id, { status: "cancelled" }, actor, "user:alice");
    const exportedMemo = await getMemoDetail(db, "ws_default", memo.id);
    await restoreJsonMemos(db, "ws_default", [{ memo: exportedMemo, revisions: [], resources: [] }]);
    expect(await getMemoDetail(db, "ws_default", memo.id)).toMatchObject({
      status: "cancelled",
      contentMarkdown: exportedMemo.contentMarkdown,
      contentHash: exportedMemo.contentHash,
    });
  });
});
