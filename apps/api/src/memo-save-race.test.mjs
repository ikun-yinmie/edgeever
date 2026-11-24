import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { createMemoRecord, getMemoDetail, updateMemoRecord } from "./memo-service.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

let sqlite;
let db;
let memo;
const actor = (id) => ({ actorType: "user", actorId: id });

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  db = createSelfHostedStorageAdapter(sqlite, "/unused-test-resources").db;
  const notebookId = sqlite.query("SELECT id FROM notebooks WHERE workspace_id = 'ws_default' AND is_deleted = 0 LIMIT 1").get().id;
  memo = await createMemoRecord(db, "ws_default", { notebookId, title: "Original", contentMarkdown: "Original body" }, actor("alice"), "user:alice");
  for (const id of ["alice", "bob"]) {
    sqlite.query(`INSERT INTO memo_edit_sessions
      (id, memo_id, actor_type, actor_id, base_revision, base_content_hash, expires_at)
      VALUES (?, ?, 'user', ?, ?, ?, '2099-01-01T00:00:00.000Z')`)
      .run(`session-${id}`, memo.id, id, memo.revision, memo.contentHash);
  }
});
afterEach(() => sqlite.close());

const save = (id, body) => updateMemoRecord(db, "ws_default", memo.id, {
  expectedRevision: memo.revision,
  expectedContentHash: memo.contentHash,
  editSessionId: `session-${id}`,
  contentMarkdown: body,
  tags: [id],
}, actor(id), `user:${id}`, true);

describe("memo save races", () => {
  test("two already-validated requests cannot both commit the same base", async () => {
    const batch = db.batch.bind(db);
    const waiting = [];
    let reachedBoth;
    const bothReady = new Promise((resolve) => { reachedBoth = resolve; });
    db.batch = (statements) => new Promise((resolve, reject) => {
      waiting.push(() => batch(statements).then(resolve, reject));
      if (waiting.length === 2) reachedBoth();
    });
    const first = save("alice", "First page's now-stale body");
    const second = save("bob", "Second page's acknowledged body");
    await bothReady;
    await waiting[1]();
    const winner = await second;
    expect(winner.memo.contentMarkdown).toBe("Second page's acknowledged body");
    await waiting[0]();
    expect(await first).toMatchObject({ error: "revision_conflict", status: 409 });

    const stored = await getMemoDetail(db, "ws_default", memo.id);
    expect(stored.contentHash).toBe(winner.memo.contentHash);
    expect(stored.revision).toBe(memo.revision + 1);
    expect(stored.tags).toEqual(["bob"]);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM memo_revisions WHERE memo_id = ?").get(memo.id).count).toBe(1);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ? AND action = 'memo.update'").get(memo.id).count).toBe(1);
    expect(sqlite.query("SELECT base_revision FROM memo_edit_sessions WHERE id = 'session-alice'").get().base_revision).toBe(memo.revision);
    expect(sqlite.query("SELECT base_revision FROM memo_edit_sessions WHERE id = 'session-bob'").get().base_revision).toBe(stored.revision);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM memo_write_checks").get().count).toBe(0);
  });

  test("an old page's retry remains a conflict rather than silently rebasing its body", async () => {
    const first = await save("bob", "Latest acknowledged body");
    expect(first.memo.contentMarkdown).toBe("Latest acknowledged body");
    expect(await save("alice", "Old cached body")).toMatchObject({ error: "revision_conflict", status: 409 });
    expect((await getMemoDetail(db, "ws_default", memo.id)).contentHash).toBe(first.memo.contentHash);
  });
});
