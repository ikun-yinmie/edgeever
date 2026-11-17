import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { createEdgeEverDocumentExtensions, markdownToDoc } from "@edgeever/shared";
import { collectMemoTasks, memoTaskAttributes, nextMemoTaskMark, updateMemoTaskDocument } from "./memo-tasks";

const cross = "❌";
const tasksFor = source => collectMemoTasks(markdownToDoc(source), "memo");

describe("memo task progress", () => {
  test("cycles explicit marks through checked, crossed out and empty", () => {
    let attrs = { checked: false, rejected: false };
    for (const expected of ["done", "rejected", "pending", "done", "rejected", "pending"]) {
      const mark = nextMemoTaskMark(attrs);
      expect(mark).toBe(expected);
      attrs = memoTaskAttributes(mark);
      expect(attrs.checked && attrs.rejected).toBe(false);
    }
    expect(nextMemoTaskMark({})).toBe("done");
    expect(nextMemoTaskMark({ checked: true })).toBe("rejected");
    expect(nextMemoTaskMark({ rejected: true })).toBe("pending");
  });
  test("cycling a parent leaves child marks intact and restores automatic progress", () => {
    let doc = markdownToDoc(`- [ ] Parent\n  - [x] Done child\n  - [${cross}] Crossed child`);
    for (const expected of ["done", "rejected", "doing"]) {
      const task = collectMemoTasks(doc, "memo")[0];
      doc = updateMemoTaskDocument(doc, task, nextMemoTaskMark(task));
      expect(collectMemoTasks(doc, "memo").map(task => task.status)).toEqual([expected, "done", "rejected"]);
    }
  });
  test("derives progress from completed and crossed descendants without marking parents", () => {
    const tasks = tasksFor(`## Plan\n\n- [ ] Parent\n  - [x] Done\n  - [${cross}] Cancelled\n  - [ ] Pending\n- [ ] Untouched\n  - [ ] Child`);
    expect(tasks.map(task => task.status)).toEqual(["doing", "done", "rejected", "pending", "pending", "pending"]);
    expect(tasks[0].checked).toBe(false);
    expect(tasks[0].text).toBe("Parent");
    expect(tasks[0].heading).toBe("Plan");
    expect(tasks[1].parentId).toBe(tasks[0].id);
  });
  test("propagates progress through multiple levels and honors explicit parent marks", () => {
    expect(tasksFor("- [ ] Parent\n  - [ ] Child\n    - [x] Leaf").map(task => task.status)).toEqual(["doing", "doing", "done"]);
    expect(tasksFor(`- [x] Parent\n  - [ ] Child\n- [${cross}] Rejected\n  - [x] Child`).map(task => task.status)).toEqual(["done", "pending", "rejected", "done"]);
    expect(tasksFor("- [ ] Parent\n  - [x] All children done")[0].status).toBe("doing");
  });
  test("positions agree with the real editor schema, including empty paragraphs", () => {
    const json = markdownToDoc(`## Plan\n\n- [ ] Parent\n  - [x] Child\n\nParagraph\n\n- [${cross}] Other`);
    json.content.unshift({ type: "paragraph" });
    const schema = getSchema(createEdgeEverDocumentExtensions({ mathematics: [] }));
    const doc = schema.nodeFromJSON(json);
    const positions = [];
    doc.descendants((node, position) => { if (node.type.name === "taskItem") positions.push(position); });
    expect(collectMemoTasks(json, "memo").map(task => task.position)).toEqual(positions);
  });
  test("edits only the target attributes and retains unknown metadata and marks", () => {
    const doc = markdownToDoc("- [ ] Parent\n  - [ ] Child\n\n```js\n- [ ] Not a task\n```");
    const task = collectMemoTasks(doc, "memo")[1];
    doc.content[0].content[0].attrs.custom = "keep";
    const before = structuredClone(doc);
    const updated = updateMemoTaskDocument(doc, task, "rejected");
    expect(doc).toEqual(before);
    const expected = structuredClone(doc);
    expected.content[0].content[0].content[1].content[0].attrs = { ...expected.content[0].content[0].content[1].content[0].attrs, checked: false, rejected: true };
    expect(updated).toEqual(expected);
    expect(collectMemoTasks(updated, "memo").map(task => task.status)).toEqual(["doing", "rejected"]);
    const restored = updateMemoTaskDocument(updated, task, "pending");
    expect(collectMemoTasks(restored, "memo").map(task => task.status)).toEqual(["pending", "pending"]);
  });
  test("rejects stale paths instead of changing another task", () => {
    const doc = markdownToDoc("- [ ] First\n- [ ] Second");
    const task = collectMemoTasks(doc, "memo")[0];
    doc.content[0].content.reverse();
    expect(updateMemoTaskDocument(doc, task, "done")).toBeNull();
    expect(tasksFor("```md\n- [ ] Example\n```")).toEqual([]);
  });
});
