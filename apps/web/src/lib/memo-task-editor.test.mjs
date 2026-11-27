import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { history, redo, undo, undoDepth } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createEdgeEverDocumentExtensions, markdownToDoc } from "@edgeever/shared";
import { setMemoTaskMark } from "./memo-task-editor.ts";
import { collectMemoTasks, findMemoTaskNode, updateMemoTaskDocument } from "./memo-tasks.ts";

const schema = getSchema(createEdgeEverDocumentExtensions({ mathematics: [] }));
const taskNamed = (doc, text) => collectMemoTasks(doc, "editor").find(task => task.text === text);
const makeEditor = (json, selectionText) => {
  const doc = schema.nodeFromJSON(json);
  const task = selectionText && taskNamed(doc.toJSON(), selectionText);
  const transactions = [];
  const editor = {
    schema,
    state: EditorState.create({
      doc,
      selection: task ? TextSelection.create(doc, task.position + 2) : undefined,
      plugins: [history()],
    }),
    view: {
      dispatch(transaction) {
        transactions.push(transaction);
        editor.state = editor.state.apply(transaction);
      },
    },
  };
  return { editor, transactions };
};
const marksOf = json => collectMemoTasks(json, "editor").map(task => [
  task.text, task.status, findMemoTaskNode(json, task.path).attrs.statusSource,
]);
const withoutTaskMarks = json => {
  const copy = structuredClone(json);
  const walk = node => {
    if (node.type === "taskItem") {
      delete node.attrs.checked;
      delete node.attrs.rejected;
      delete node.attrs.statusSource;
    }
    node.content?.forEach(walk);
  };
  walk(copy);
  return copy;
};

const cases = [
  {
    name: "finishing a parent cancels empty descendants and keeps completed descendants",
    markdown: "- [ ] **Parent**\n  - [x] Legacy done\n  - [x] Automatic done\n  - [ ] Empty child\n    - [ ] *Grandchild*\n\nUnrelated paragraph",
    target: "Parent", mark: "done", attrs: { "Parent": { collapsed: true }, "Automatic done": { statusSource: "auto" } },
    expected: [["Parent", "done", "manual"], ["Legacy done", "done", null], ["Automatic done", "done", "auto"], ["Empty child", "rejected", "auto"], ["Grandchild", "rejected", "auto"]],
  },
  {
    name: "rejecting a parent changes automatic children and traverses protected nodes",
    markdown: "- [ ] Parent\n  - [x] Automatic done\n  - [ ] Manual pending\n    - [ ] Grandchild\n  - [x] Legacy done\n  - [❌] Legacy rejected\n- [ ] Unrelated sibling",
    target: "Parent", mark: "rejected", attrs: { "Automatic done": { statusSource: "auto" }, "Manual pending": { statusSource: "manual" } },
    expected: [["Parent", "rejected", "manual"], ["Automatic done", "rejected", "auto"], ["Manual pending", "pending", "manual"], ["Grandchild", "rejected", "auto"], ["Legacy done", "done", null], ["Legacy rejected", "rejected", null], ["Unrelated sibling", "pending", null]],
  },
  {
    name: "reopening a parent clears automatic descendants but protects manual descendants",
    markdown: "- [❌] Parent\n  - [❌] Automatic child\n    - [x] Automatic grandchild\n  - [x] Legacy done\n  - [❌] Manual rejected",
    target: "Parent", mark: "pending", attrs: { "Automatic child": { statusSource: "auto" }, "Automatic grandchild": { statusSource: "auto" }, "Manual rejected": { statusSource: "manual" } },
    expected: [["Parent", "pending", "manual"], ["Automatic child", "pending", "auto"], ["Automatic grandchild", "pending", "auto"], ["Legacy done", "done", null], ["Manual rejected", "rejected", "manual"]],
  },
  {
    name: "a settled child aggregates all ancestors in the same transaction",
    markdown: "- [ ] Root\n  - [ ] Branch\n    - [ ] Target\n  - [❌] Sibling",
    target: "Target", mark: "done",
    expected: [["Root", "done", "auto"], ["Branch", "done", "auto"], ["Target", "done", "manual"], ["Sibling", "rejected", null]],
  },
  {
    name: "all crossed direct children produce an automatic rejected parent",
    markdown: "- [ ] Parent\n  - [❌] Sibling\n  - [ ] Target",
    target: "Target", mark: "rejected",
    expected: [["Parent", "rejected", "auto"], ["Sibling", "rejected", null], ["Target", "rejected", "manual"]],
  },
  {
    name: "clearing a child reopens an automatic parent with derived doing display",
    markdown: "- [x] Parent\n  - [x] Sibling\n  - [x] Target",
    target: "Target", mark: "pending", attrs: { "Parent": { statusSource: "auto" } },
    expected: [["Parent", "doing", "auto"], ["Sibling", "done", null], ["Target", "pending", "manual"]],
  },
  {
    name: "manual pending is protected from both aggregation and derived doing",
    markdown: "- [ ] Parent\n  - [ ] Target",
    target: "Target", mark: "done", attrs: { "Parent": { statusSource: "manual" } },
    expected: [["Parent", "pending", "manual"], ["Target", "done", "manual"]],
  },
  {
    name: "automatic parent completion never cascades into sibling descendants",
    markdown: "- [ ] Parent\n  - [x] Branch\n    - [ ] Empty grandchild\n  - [ ] Target",
    target: "Target", mark: "done", attrs: { "Branch": { statusSource: "auto" } },
    expected: [["Parent", "done", "auto"], ["Branch", "done", "auto"], ["Empty grandchild", "pending", null], ["Target", "done", "manual"]],
  },
  {
    name: "explicitly setting an existing automatic mark changes provenance and is undoable",
    markdown: "- [x] Target",
    target: "Target", mark: "done", attrs: { "Target": { statusSource: "auto" } },
    expected: [["Target", "done", "manual"]],
  },
];

describe("memo task editor transactions", () => {
  test("uses the production task schema with null provenance by default", () => {
    const { editor } = makeEditor(markdownToDoc("- [ ] Empty\n- [x] Legacy done"));
    expect(marksOf(editor.state.doc.toJSON())).toEqual([["Empty", "pending", null], ["Legacy done", "done", null]]);
  });
  for (const scenario of cases) {
    test(`${scenario.name}; JSON agrees and one undo restores everything`, () => {
      const json = markdownToDoc(scenario.markdown);
      for (const [text, attrs] of Object.entries(scenario.attrs ?? {})) {
        Object.assign(findMemoTaskNode(json, taskNamed(json, text).path).attrs, attrs);
      }
      const { editor, transactions } = makeEditor(json, scenario.target);
      const before = editor.state;
      const beforeJson = before.doc.toJSON();
      const target = taskNamed(beforeJson, scenario.target);
      const expectedJson = updateMemoTaskDocument(beforeJson, target, scenario.mark);
      expect(expectedJson).not.toBeNull();
      expect(setMemoTaskMark(editor, target.position, scenario.mark)).toBe(true);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].docChanged).toBe(true);
      const afterJson = editor.state.doc.toJSON();
      expect(afterJson).toEqual(schema.nodeFromJSON(expectedJson).toJSON());
      expect(marksOf(afterJson)).toEqual(scenario.expected);
      expect(withoutTaskMarks(afterJson)).toEqual(withoutTaskMarks(beforeJson));
      expect(editor.state.selection.eq(before.selection)).toBe(true);
      const changedTasks = collectMemoTasks(afterJson, "editor").filter(task =>
        JSON.stringify(findMemoTaskNode(afterJson, task.path).attrs) !== JSON.stringify(findMemoTaskNode(beforeJson, task.path).attrs));
      expect(transactions[0].steps).toHaveLength(changedTasks.length);
      expect(undoDepth(editor.state)).toBe(1);
      expect(undo(editor.state, editor.view.dispatch)).toBe(true);
      expect(editor.state.doc.eq(before.doc)).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(beforeJson);
      expect(editor.state.selection.eq(before.selection)).toBe(true);
      expect(undoDepth(editor.state)).toBe(0);
      expect(undo(editor.state, editor.view.dispatch)).toBe(false);
      expect(redo(editor.state, editor.view.dispatch)).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(afterJson);
    });
  }
  test("null position targets the innermost task at the current text selection", () => {
    const { editor, transactions } = makeEditor(markdownToDoc("- [ ] Parent\n  - [ ] Child\n    - [ ] Leaf"), "Leaf");
    expect(setMemoTaskMark(editor, null, "done")).toBe(true);
    expect(transactions).toHaveLength(1);
    expect(marksOf(editor.state.doc.toJSON())).toEqual([["Parent", "done", "auto"], ["Child", "done", "auto"], ["Leaf", "done", "manual"]]);
  });
  test("an explicit position takes precedence over a selection in another task", () => {
    const { editor } = makeEditor(markdownToDoc("- [ ] Parent\n  - [ ] Child\n- [ ] Selected sibling"), "Selected sibling");
    const target = taskNamed(editor.state.doc.toJSON(), "Parent");
    expect(setMemoTaskMark(editor, target.position, "done")).toBe(true);
    expect(marksOf(editor.state.doc.toJSON())).toEqual([["Parent", "done", "manual"], ["Child", "rejected", "auto"], ["Selected sibling", "pending", null]]);
  });
  test("returns false without dispatching or adding history when the position is not a task", () => {
    const { editor, transactions } = makeEditor(markdownToDoc("Outside paragraph\n\n- [ ] Task"));
    const before = editor.state;
    for (const position of [null, -1, 0, 1, before.doc.content.size + 1]) {
      expect(setMemoTaskMark(editor, position, "done")).toBe(false);
      expect(editor.state).toBe(before);
    }
    expect(transactions).toHaveLength(0);
    expect(undoDepth(editor.state)).toBe(0);
  });
});
