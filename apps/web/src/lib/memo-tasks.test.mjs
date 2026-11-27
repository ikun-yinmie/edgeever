import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { createEdgeEverDocumentExtensions, markdownToDoc } from "@edgeever/shared";
import { collectMemoTasks, findMemoTaskNode, memoTaskAttributes, nextMemoTaskMark, updateMemoTaskDocument } from "./memo-tasks";

const cross = "❌";
const tasksFor = source => collectMemoTasks(markdownToDoc(source), "memo");
const taskNamed = (doc, text) => collectMemoTasks(doc, "memo").find(task => task.text === text);
const nodeNamed = (doc, text) => findMemoTaskNode(doc, taskNamed(doc, text).path);
const markNamed = (doc, text, mark) => {
  const updated = updateMemoTaskDocument(doc, taskNamed(doc, text), mark);
  expect(updated).not.toBeNull();
  return updated;
};
const marksOf = doc => collectMemoTasks(doc, "memo").map(task => {
  const attrs = findMemoTaskNode(doc, task.path).attrs;
  return [task.text, task.status, attrs.statusSource ?? null];
});

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
  test("cycling a parent cancels empty descendants, preserves legacy marks, and reopens automatic marks", () => {
    let doc = markdownToDoc(`- [ ] Parent\n  - [x] Done child\n  - [${cross}] Crossed child\n  - [ ] Empty child\n    - [ ] Grandchild`);
    for (const [mark, childMark] of [["done", "rejected"], ["rejected", "rejected"], ["pending", "pending"]]) {
      expect(nextMemoTaskMark(taskNamed(doc, "Parent"))).toBe(mark);
      doc = markNamed(doc, "Parent", mark);
      expect(marksOf(doc)).toEqual([
        ["Parent", mark, "manual"], ["Done child", "done", null], ["Crossed child", "rejected", null],
        ["Empty child", childMark, "auto"], ["Grandchild", childMark, "auto"],
      ]);
    }
  });
  test("rejecting a parent crosses out automatic descendants at every level without changing legacy or manual marks", () => {
    const doc = markdownToDoc("- [ ] Parent\n  - [x] Legacy child\n    - [ ] Grandchild\n  - [x] Automatic child\n  - [ ] Manual empty child\n    - [ ] Nested empty child\n- [ ] Sibling");
    nodeNamed(doc, "Automatic child").attrs.statusSource = "auto";
    nodeNamed(doc, "Manual empty child").attrs.statusSource = "manual";
    const updated = markNamed(doc, "Parent", "rejected");
    expect(marksOf(updated)).toEqual([
      ["Parent", "rejected", "manual"], ["Legacy child", "done", null], ["Grandchild", "rejected", "auto"],
      ["Automatic child", "rejected", "auto"], ["Manual empty child", "pending", "manual"],
      ["Nested empty child", "rejected", "auto"], ["Sibling", "pending", null],
    ]);
    expect(nodeNamed(updated, "Automatic child").attrs.checked).toBe(false);
    expect(nodeNamed(updated, "Sibling")).toEqual(nodeNamed(doc, "Sibling"));
  });
  test("re-opening a parent clears its automatic cascade and keeps unrelated and protected marks", () => {
    const doc = markdownToDoc(`- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild\n  - [${cross}] Legacy child\n- [${cross}] Sibling`);
    const rejected = markNamed(doc, "Parent", "rejected");
    const reopened = markNamed(rejected, "Parent", "pending");
    expect(marksOf(reopened)).toEqual([
      ["Parent", "pending", "manual"], ["Child", "pending", "auto"], ["Grandchild", "pending", "auto"],
      ["Legacy child", "rejected", null], ["Sibling", "rejected", null],
    ]);
  });
  test("finishing a parent preserves automatic done descendants and cancels unfinished descendants", () => {
    const doc = markdownToDoc(`- [ ] Parent\n  - [x] Automatic done\n    - [ ] Empty grandchild\n  - [${cross}] Automatic rejected\n  - [ ] Automatic empty`);
    for (const text of ["Automatic done", "Automatic rejected", "Automatic empty"]) nodeNamed(doc, text).attrs.statusSource = "auto";
    const updated = markNamed(doc, "Parent", "done");
    expect(marksOf(updated)).toEqual([
      ["Parent", "done", "manual"], ["Automatic done", "done", "auto"], ["Empty grandchild", "rejected", "auto"],
      ["Automatic rejected", "rejected", "auto"], ["Automatic empty", "rejected", "auto"],
    ]);
    expect(nodeNamed(updated, "Automatic done").attrs).toEqual(nodeNamed(doc, "Automatic done").attrs);
  });
  for (const mark of ["done", "rejected", "pending"]) {
    test(`${mark} cascade preserves manual choices and legacy non-empty marks with null or missing provenance`, () => {
      const doc = markdownToDoc(`- [ ] Parent\n  - [ ] Manual pending\n  - [x] Manual done\n  - [${cross}] Manual rejected\n  - [x] Legacy done\n  - [${cross}] Legacy rejected\n  - [x] Missing-source done\n  - [${cross}] Missing-source rejected\n  - [ ] Empty`);
      const protectedTexts = ["Manual pending", "Manual done", "Manual rejected", "Legacy done", "Legacy rejected", "Missing-source done", "Missing-source rejected"];
      for (const text of protectedTexts.slice(0, 3)) nodeNamed(doc, text).attrs.statusSource = "manual";
      for (const text of protectedTexts.slice(3, 5)) nodeNamed(doc, text).attrs.statusSource = null;
      for (const text of protectedTexts.slice(5)) delete nodeNamed(doc, text).attrs.statusSource;
      const before = structuredClone(doc);
      const updated = markNamed(doc, "Parent", mark);
      for (const text of protectedTexts) expect(nodeNamed(updated, text)).toEqual(nodeNamed(before, text));
      expect(nodeNamed(updated, "Parent").attrs).toMatchObject({ ...memoTaskAttributes(mark), statusSource: "manual" });
      expect(nodeNamed(updated, "Empty").attrs).toMatchObject({ ...memoTaskAttributes(mark === "done" ? "rejected" : mark), statusSource: "auto" });
      expect(doc).toEqual(before);
    });
    test(`explicit ${mark} replaces an automatic mark with manual provenance`, () => {
      const doc = markdownToDoc("- [x] Target");
      nodeNamed(doc, "Target").attrs.statusSource = "auto";
      expect(nodeNamed(markNamed(doc, "Target", mark), "Target").attrs)
        .toMatchObject({ ...memoTaskAttributes(mark), statusSource: "manual" });
    });
  }
  test("derives progress from completed and crossed descendants without marking parents", () => {
    const tasks = tasksFor(`## Plan\n\n- [ ] Parent\n  - [x] Done\n  - [${cross}] Cancelled\n  - [ ] Pending\n- [ ] Untouched\n  - [ ] Child`);
    expect(tasks.map(task => task.status)).toEqual(["doing", "done", "rejected", "pending", "pending", "pending"]);
    expect(tasks[0].checked).toBe(false);
    expect(tasks[0].text).toBe("Parent");
    expect(tasks[0].heading).toBe("Plan");
    expect(tasks[1].parentId).toBe(tasks[0].id);
  });
  test("propagates display progress through multiple levels and honors explicit parent marks", () => {
    expect(tasksFor("- [ ] Parent\n  - [ ] Child\n    - [x] Leaf").map(task => task.status)).toEqual(["doing", "doing", "done"]);
    expect(tasksFor(`- [x] Parent\n  - [ ] Child\n- [${cross}] Rejected\n  - [x] Child`).map(task => task.status)).toEqual(["done", "pending", "rejected", "done"]);
    // Reading legacy content does not write an aggregate mark into the document.
    expect(tasksFor("- [ ] Parent\n  - [x] All children done")[0].status).toBe("doing");
  });
  for (const [sibling, targetMark, parentMark, displayStatus] of [
    ["x", "done", "done", "done"], [cross, "done", "done", "done"],
    ["x", "rejected", "done", "done"], [cross, "rejected", "rejected", "rejected"],
    [" ", "done", "pending", "doing"], ["x", "pending", "pending", "doing"],
    [" ", "pending", "pending", "pending"],
  ]) {
    test(`aggregates direct children [${sibling}] and ${targetMark} as auto ${parentMark} (${displayStatus})`, () => {
      const doc = markdownToDoc(`- [ ] Parent\n  - [${sibling}] Sibling\n  - [ ] Target`);
      const updated = markNamed(doc, "Target", targetMark);
      expect(nodeNamed(updated, "Parent").attrs).toMatchObject({ ...memoTaskAttributes(parentMark), statusSource: "auto" });
      expect(taskNamed(updated, "Parent").status).toBe(displayStatus);
      expect(nodeNamed(updated, "Target").attrs.statusSource).toBe("manual");
      expect(nodeNamed(updated, "Sibling")).toEqual(nodeNamed(doc, "Sibling"));
    });
  }
  test("recomputes automatic ancestors after reopening a child without cascading to siblings", () => {
    let doc = markdownToDoc("- [ ] Root\n  - [ ] Branch\n    - [ ] Target\n  - [x] Sibling");
    doc = markNamed(doc, "Target", "done");
    expect(marksOf(doc)).toEqual([["Root", "done", "auto"], ["Branch", "done", "auto"], ["Target", "done", "manual"], ["Sibling", "done", null]]);
    doc = markNamed(doc, "Target", "pending");
    expect(marksOf(doc)).toEqual([["Root", "doing", "auto"], ["Branch", "pending", "auto"], ["Target", "pending", "manual"], ["Sibling", "done", null]]);
    doc = markNamed(doc, "Target", "rejected");
    expect(marksOf(doc)).toEqual([["Root", "done", "auto"], ["Branch", "rejected", "auto"], ["Target", "rejected", "manual"], ["Sibling", "done", null]]);
  });
  for (const [branchMark, targetMark, parentMark] of [["x", "done", "done"], [cross, "rejected", "rejected"]]) {
    test(`automatic parent ${parentMark} uses direct children and never recascades into their subtrees`, () => {
      const doc = markdownToDoc(`- [ ] Parent\n  - [${branchMark}] Branch\n    - [ ] Unfinished grandchild\n  - [ ] Target`);
      nodeNamed(doc, "Branch").attrs.statusSource = "auto";
      const updated = markNamed(doc, "Target", targetMark);
      expect(nodeNamed(updated, "Parent").attrs).toMatchObject({ ...memoTaskAttributes(parentMark), statusSource: "auto" });
      expect(nodeNamed(updated, "Branch")).toEqual(nodeNamed(doc, "Branch"));
      expect(taskNamed(updated, "Unfinished grandchild").status).toBe("pending");
    });
  }
  test("manual pending stays pending when descendants change, including derived doing at deeper levels", () => {
    const doc = markdownToDoc("- [ ] Parent\n  - [ ] Branch\n    - [ ] Target\n    - [ ] Empty sibling");
    nodeNamed(doc, "Parent").attrs.statusSource = "manual";
    const updated = markNamed(doc, "Target", "done");
    expect(marksOf(updated)).toEqual([
      ["Parent", "pending", "manual"], ["Branch", "doing", "auto"], ["Target", "done", "manual"], ["Empty sibling", "pending", null],
    ]);
    expect(nodeNamed(updated, "Parent").attrs).toEqual(nodeNamed(doc, "Parent").attrs);
  });
  test("upward aggregation preserves manual and legacy terminal parents", () => {
    for (const source of [undefined, null, "manual"]) {
      for (const parentMark of ["x", cross]) {
        const doc = markdownToDoc(`- [${parentMark}] Parent\n  - [ ] Target`);
        if (source === undefined) delete nodeNamed(doc, "Parent").attrs.statusSource;
        else nodeNamed(doc, "Parent").attrs.statusSource = source;
        const updated = markNamed(doc, "Target", "pending");
        expect(nodeNamed(updated, "Parent").attrs).toEqual(nodeNamed(doc, "Parent").attrs);
        expect(nodeNamed(updated, "Target").attrs.statusSource).toBe("manual");
      }
    }
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
  test("updates only target and ancestor attributes while retaining unknown metadata, marks and unrelated content", () => {
    const doc = markdownToDoc("- [ ] **Parent**\n  - [ ] *Child*\n\n```js\n- [ ] Not a task\n```");
    nodeNamed(doc, "Parent").attrs.custom = "keep";
    nodeNamed(doc, "Child").attrs.custom = { nested: true };
    const before = structuredClone(doc);
    const updated = markNamed(doc, "Child", "rejected");
    expect(doc).toEqual(before);
    const expected = structuredClone(doc);
    nodeNamed(expected, "Parent").attrs = { ...nodeNamed(expected, "Parent").attrs, checked: false, rejected: true, statusSource: "auto" };
    nodeNamed(expected, "Child").attrs = { ...nodeNamed(expected, "Child").attrs, checked: false, rejected: true, statusSource: "manual" };
    expect(updated).toEqual(expected);
    expect(collectMemoTasks(updated, "memo").map(task => task.status)).toEqual(["rejected", "rejected"]);
    const restored = markNamed(updated, "Child", "pending");
    expect(collectMemoTasks(restored, "memo").map(task => task.status)).toEqual(["pending", "pending"]);
  });
  test("rejects stale paths instead of changing another task", () => {
    const doc = markdownToDoc("- [ ] First\n- [ ] Second");
    const task = collectMemoTasks(doc, "memo")[0];
    doc.content[0].content.reverse();
    const before = structuredClone(doc);
    expect(updateMemoTaskDocument(doc, task, "done")).toBeNull();
    expect(updateMemoTaskDocument(doc, { ...task, path: [999] }, "done")).toBeNull();
    expect(doc).toEqual(before);
    expect(tasksFor("```md\n- [ ] Example\n```")).toEqual([]);
  });
});
