import { afterEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { markdownToDoc } from "@edgeever/shared";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { localDb } = await import("./local-db.ts");
const { collectMemoTasks } = await import("./memo-tasks.ts");
const { MemoTaskUpdateError, saveTaskMark } = await import("./memo-task-repository.ts");

const memo = () => ({
  id: "task-repository-test", notebookId: "own-notebook", title: "Keep title", tags: ["keep"],
  contentJson: markdownToDoc("- [ ] Parent\n  - [ ] Child\n\nUnrelated paragraph"),
  contentMarkdown: "- [ ] Parent\n  - [ ] Child\n\nUnrelated paragraph", contentText: "", excerpt: "", contentHash: "base-hash", revision: 7,
  isDeleted: false, isPinned: false, isArchived: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null,
  sourceMemoIds: [], mergeSourceCount: 0, mergedIntoMemoId: null,
});
afterEach(async () => { await localDb.drafts.delete("task-repository-test"); });

describe("cross-note task marks", () => {
  test("uses existing save queue with the original concurrency base and metadata", async () => {
    const original = memo();
    const task = collectMemoTasks(original.contentJson, original.id)[1];
    let payload;
    const repository = {
      getMemo: async () => ({ memo: original }),
      updateMemo: async (base, input) => { expect(base).toBe(original); payload = input; return { memo: { ...base, ...input }, queued: true }; },
    };
    const updated = await saveTaskMark(repository, original, task, "done");
    expect(payload.expectedRevision).toBe(7);
    expect(payload.expectedContentHash).toBe("base-hash");
    expect(payload.title).toBe("Keep title");
    expect(payload.tags).toEqual(["keep"]);
    expect(collectMemoTasks(updated.contentJson, original.id).map(task => task.status)).toEqual(["doing", "done"]);
    expect(original.contentJson.content[0].content[0].content[1].content[0].attrs.checked).toBe(false);
    expect(updated.contentJson.content[1]).toEqual(original.contentJson.content[1]);
  });
  test("rejects changed documents, deleted notes and shared workspaces", async () => {
    const original = memo();
    const task = collectMemoTasks(original.contentJson, original.id)[0];
    for (const result of [
      { memo: { ...original, contentJson: markdownToDoc("- [ ] Different task") } },
      { memo: { ...original, revision: 8 } },
      { memo: { ...original, isDeleted: true } },
      { memo: original, access: { shared: true } },
    ]) {
      const repository = { getMemo: async () => result, updateMemo: () => { throw new Error("Must not write"); } };
      try { await saveTaskMark(repository, original, task, "done"); throw new Error("Should reject"); }
      catch (error) { expect(error).toBeInstanceOf(MemoTaskUpdateError); expect(error.reason).toBe("changed"); }
    }
  });
  test("never overwrites an unsaved editor draft", async () => {
    const original = memo();
    await localDb.drafts.put({ memoId: original.id, title: original.title, tagsText: "keep", contentJson: markdownToDoc("- [ ] Unsaved content"), updatedAt: "2026-02-01T00:00:00Z" });
    const repository = { getMemo: async () => ({ memo: original }), updateMemo: () => { throw new Error("Must not write"); } };
    try { await saveTaskMark(repository, original, collectMemoTasks(original.contentJson, original.id)[0], "done"); throw new Error("Should reject"); }
    catch (error) { expect(error).toBeInstanceOf(MemoTaskUpdateError); expect(error.reason).toBe("draft"); }
  });
});
