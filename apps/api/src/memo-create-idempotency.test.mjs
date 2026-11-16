import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { createMemoRecord } from "./memo-service.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

let sqlite;
let db;
let notebookId;
const actor = { actorType: "user", actorId: null };
const create = (input, workspaceId = "ws_default") => createMemoRecord(db, workspaceId, { notebookId, ...input }, actor, "Test");

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const path of globSync("migrations/*.sql").sort().filter((path) => path < "migrations/0068")) {
    sqlite.exec(readFileSync(path, "utf8"));
  }
  notebookId = sqlite.query("SELECT id FROM notebooks WHERE workspace_id = 'ws_default' AND is_deleted = 0 LIMIT 1").get().id;
  db = createSelfHostedStorageAdapter(sqlite, ".unused-test-resources").db;
});
afterEach(() => sqlite.close());
const migrate = () => sqlite.exec(readFileSync("migrations/0068_memo_create_requests.sql", "utf8"));

describe("memo creation idempotency", () => {
  test("upgrades an existing database without changing notes and keeps legacy creates independent", async () => {
    const before = await create({ title: "Before upgrade", contentMarkdown: "Existing body" });
    const rows = sqlite.query("SELECT * FROM memos ORDER BY id").all();
    migrate();
    expect(sqlite.query("SELECT * FROM memos ORDER BY id").all()).toEqual(rows);
    const after = await create({ title: "Before upgrade", contentMarkdown: "Existing body" });
    expect(after.id).not.toBe(before.id);
    expect(sqlite.query("SELECT count(*) AS count FROM memo_create_requests").get().count).toBe(0);
  });

  test("concurrent blank-create retries produce one note, audit and mapping", async () => {
    migrate();
    const results = await Promise.all(Array.from({ length: 8 }, () => create({ creationId: "local_once", title: "", contentMarkdown: "" })));
    expect(new Set(results.map((memo) => memo.id)).size).toBe(1);
    const id = results[0].id;
    expect(sqlite.query("SELECT count(*) AS count FROM memos WHERE id = ?").get(id).count).toBe(1);
    expect(sqlite.query("SELECT count(*) AS count FROM memo_create_requests").get().count).toBe(1);
    expect(sqlite.query("SELECT count(*) AS count FROM audit_events WHERE entity_id = ? AND action = 'memo.create'").get(id).count).toBe(1);
  });

  test("a retry returns the edited note without restoring the original empty content", async () => {
    migrate();
    const memo = await create({ creationId: "local_edited", title: "", contentMarkdown: "" });
    sqlite.query("UPDATE memos SET title = 'Written title' WHERE id = ?").run(memo.id);
    sqlite.query("UPDATE memo_contents SET content_markdown = 'Written body', revision = 1 WHERE memo_id = ?").run(memo.id);
    const retry = await create({ creationId: "local_edited", title: "", contentMarkdown: "" });
    expect(retry).toMatchObject({ id: memo.id, title: "Written title", contentMarkdown: "Written body", revision: 1 });
  });

  test("isolates the same key across workspaces", async () => {
    migrate();
    sqlite.query("INSERT INTO workspaces (id, name) VALUES ('ws_other', 'Other')").run();
    sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES ('nb_other', 'ws_other', 'Other')").run();
    const first = await create({ creationId: "local_shared_key" });
    const second = await create({ creationId: "local_shared_key", notebookId: "nb_other" }, "ws_other");
    expect(first.id).not.toBe(second.id);
    expect(second.notebookId).toBe("nb_other");
  });

  test("does not resurrect trashed or permanently deleted notes on retry", async () => {
    migrate();
    const memo = await create({ creationId: "local_deleted" });
    sqlite.query("UPDATE memos SET is_deleted = 1 WHERE id = ?").run(memo.id);
    expect(await create({ creationId: "local_deleted" })).toMatchObject({ id: memo.id, isDeleted: true });
    sqlite.query("DELETE FROM memos WHERE id = ?").run(memo.id);
    await expect(create({ creationId: "local_deleted" })).rejects.toMatchObject({ code: "memo_creation_deleted", status: 409 });
    expect(sqlite.query("SELECT count(*) AS count FROM memo_create_requests WHERE creation_id = 'local_deleted'").get().count).toBe(1);
  });

  test("rolls back failed creates and permits retrying the key with a valid notebook", async () => {
    migrate();
    await expect(create({ creationId: "local_failed", notebookId: "missing" })).rejects.toThrow();
    expect(sqlite.query("SELECT count(*) AS count FROM memo_create_requests").get().count).toBe(0);
    const memo = await create({ creationId: "local_failed" });
    expect(memo.notebookId).toBe(notebookId);
  });
});
