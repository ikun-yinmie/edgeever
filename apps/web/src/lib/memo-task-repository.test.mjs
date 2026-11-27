import { afterEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { markdownToDoc } from "@edgeever/shared";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { localDb } = await import("./local-db.ts");
const { collectMemoTasks, findMemoTaskNode, memoTaskAttributes } = await import("./memo-tasks.ts");
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
    expect(collectMemoTasks(updated.contentJson, original.id).map(task => task.status)).toEqual(["done", "done"]);
    const tasks = collectMemoTasks(payload.contentJson, original.id);
    expect(tasks.map(task => findMemoTaskNode(payload.contentJson, task.path).attrs.statusSource)).toEqual(["auto", "manual"]);
    expect(original.contentJson.content[0].content[0].content[1].content[0].attrs.checked).toBe(false);
    expect(updated.contentJson.content[1]).toEqual(original.contentJson.content[1]);
  });
  test("persists cascade provenance so reopening resets only automatic descendants across saves", async () => {
    let current = memo();
    current.contentJson = markdownToDoc("- [ ] Parent\n  - [x] Legacy done\n  - [❌] Legacy rejected\n  - [ ] Manual pending\n  - [ ] Empty child\n    - [ ] Grandchild\n\nUnrelated paragraph");
    const tasks = collectMemoTasks(current.contentJson, current.id);
    findMemoTaskNode(current.contentJson, tasks.find(task => task.text === "Manual pending").path).attrs.statusSource = "manual";
    const original = structuredClone(current);
    const payloads = [];
    const repository = {
      getMemo: async () => ({ memo: current }),
      updateMemo: async (base, input) => {
        expect(base).toBe(current);
        expect(input.expectedRevision).toBe(current.revision);
        expect(input.expectedContentHash).toBe(current.contentHash);
        payloads.push(input);
        // Simulate a persisted/reloaded JSON document, not retained object identity.
        current = structuredClone({ ...base, ...input, revision: base.revision + 1, contentHash: `saved-${base.revision + 1}` });
        return { memo: current, queued: true };
      },
    };
    for (const [mark, descendantMark] of [["done", "rejected"], ["rejected", "rejected"], ["pending", "pending"]]) {
      const parent = collectMemoTasks(current.contentJson, current.id)[0];
      const updated = await saveTaskMark(repository, current, parent, mark);
      const savedTasks = collectMemoTasks(updated.contentJson, updated.id);
      expect(savedTasks.map(task => [task.text, task.status, findMemoTaskNode(updated.contentJson, task.path).attrs.statusSource ?? null])).toEqual([
        ["Parent", mark, "manual"], ["Legacy done", "done", null], ["Legacy rejected", "rejected", null],
        ["Manual pending", "pending", "manual"], ["Empty child", descendantMark, "auto"], ["Grandchild", descendantMark, "auto"],
      ]);
      expect(updated.contentJson.content[1]).toEqual(original.contentJson.content[1]);
      expect(updated.title).toBe(original.title);
      expect(updated.tags).toEqual(original.tags);
    }
    expect(payloads).toHaveLength(3);
    expect(payloads.map(payload => payload.expectedRevision)).toEqual([7, 8, 9]);
    expect(payloads.map(payload => payload.expectedContentHash)).toEqual(["base-hash", "saved-8", "saved-9"]);
    expect(original.contentJson.content[0].content[0].attrs.checked).toBe(false);
  });
  test("saved child edits recompute automatic parents but do not override a manual pending parent", async () => {
    for (const statusSource of [null, "auto", "manual"]) {
      const original = memo();
      original.contentJson.content[0].content[0].attrs.statusSource = statusSource;
      let writes = 0;
      const repository = {
        getMemo: async () => ({ memo: original }),
        updateMemo: async (base, input) => { writes += 1; return { memo: { ...base, ...input }, queued: true }; },
      };
      const child = collectMemoTasks(original.contentJson, original.id)[1];
      const updated = await saveTaskMark(repository, original, child, "done");
      const tasks = collectMemoTasks(updated.contentJson, updated.id);
      const parent = findMemoTaskNode(updated.contentJson, tasks[0].path);
      expect(parent.attrs).toMatchObject({
        ...memoTaskAttributes(statusSource === "manual" ? "pending" : "done"),
        statusSource: statusSource === "manual" ? "manual" : "auto",
      });
      expect(tasks[0].status).toBe(statusSource === "manual" ? "pending" : "done");
      expect(findMemoTaskNode(updated.contentJson, tasks[1].path).attrs.statusSource).toBe("manual");
      expect(writes).toBe(1);
    }
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
