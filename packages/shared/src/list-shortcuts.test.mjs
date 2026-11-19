import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createEdgeEverDocumentExtensions } from "./document-extensions.ts";
import { handleConsecutiveListEnter, sinkListItemPreservingAttrs, splitTaskItemWithoutInheritedMarks } from "./list-shortcuts.ts";

const schema = getSchema(createEdgeEverDocumentExtensions({ mathematics: [] }));
const paragraph = (text = "", marks = []) => schema.nodes.paragraph.create(
  null,
  text ? schema.text(text, marks) : null,
);
const task = (text, attrs = {}, children = [], marks = []) => schema.nodes.taskItem.create(
  attrs,
  [paragraph(text, marks), ...children],
);
const taskList = (items) => schema.nodes.taskList.create({ numbered: true }, items);

const createState = ({ title = "Parent", nested = false, attrs = {}, marks = [] } = {}) => {
  const parent = task(title, { collapsed: true, ...attrs }, [
    taskList([
      task("Child", { checked: true }, [taskList([task("Grandchild", { rejected: true })])]),
    ]),
    paragraph("Child details"),
  ], marks);
  const list = taskList([parent, task("Following sibling")]);
  const doc = schema.nodes.doc.create(null, nested ? taskList([task("Outer parent", {}, [list])]) : list);
  let cursor;
  doc.descendants((node, pos) => {
    if (node === parent) cursor = pos + 2 + title.length;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, cursor), plugins: [history()] });
};

const enter = (state) => {
  let next = state;
  const dispatch = (transaction) => { next = state.apply(transaction); };
  const handled = handleConsecutiveListEnter(state, dispatch)
    || splitTaskItemWithoutInheritedMarks(state, dispatch);
  expect(handled).toBe(true);
  next.doc.check();
  return next;
};

describe("Enter on collapsed task items", () => {
  for (const nested of [false, true]) {
    test(`creates a ${nested ? "nested" : "root"} sibling while keeping hidden descendants on the collapsed parent`, () => {
      const state = createState({ nested });
      const originalParent = state.selection.$from.node(-1);
      const originalFollowing = state.selection.$from.node(-2).lastChild;
      const depth = state.selection.$from.depth;
      const next = enter(state);
      const list = next.selection.$from.node(-2);

      expect(next.selection.$from.depth).toBe(depth);
      expect(next.selection.$from.index(depth - 2)).toBe(1);
      expect(next.selection.$from.parentOffset).toBe(0);
      expect(list.attrs.numbered).toBe(true);
      expect(list.childCount).toBe(3);
      expect(list.firstChild.eq(originalParent)).toBe(true);
      expect(list.lastChild.eq(originalFollowing)).toBe(true);
      expect(list.child(1).eq(task(""))).toBe(true);

      let restored;
      expect(undo(next, (transaction) => { restored = next.apply(transaction); })).toBe(true);
      expect(restored.doc.eq(state.doc)).toBe(true);
      expect(restored.selection.eq(state.selection)).toBe(true);
    });
  }

  test("creates a sibling even when the collapsed task title is empty", () => {
    const state = createState({ title: "" });
    const originalParent = state.doc.firstChild.firstChild;
    const next = enter(state);
    expect(next.doc.firstChild.childCount).toBe(3);
    expect(next.doc.firstChild.firstChild.eq(originalParent)).toBe(true);
    expect(next.selection.$from.node(-1).eq(task(""))).toBe(true);
  });

  for (const attrs of [{ checked: true }, { rejected: true }]) {
    test(`new siblings reset ${Object.keys(attrs)[0]} and inline formatting`, () => {
      const marks = [schema.marks.bold.create(), schema.marks.textStyle.create({ color: "#ff0000" })];
      const state = createState({ attrs, marks });
      const next = enter(state);
      expect(next.doc.firstChild.firstChild.eq(state.doc.firstChild.firstChild)).toBe(true);
      expect(next.selection.$from.node(-1).attrs).toMatchObject({ checked: false, rejected: false, collapsed: false });
      expect(next.storedMarks).toEqual([]);
      const typed = next.apply(next.tr.insertText("New task"));
      expect(typed.selection.$from.node(-1).eq(task("New task"))).toBe(true);
    });
  }

  test.each([
    [0, 0, "", "Parent"],
    [3, 3, "Par", "ent"],
    [2, 4, "Pa", "nt"],
  ])("splits the visible title at %i..%i without moving hidden children", (from, to, before, after) => {
    let state = createState({ marks: [schema.marks.bold.create()] });
    const start = state.selection.$from.start();
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, start + from, start + to)));
    const originalParent = state.doc.firstChild.firstChild;
    const next = enter(state);
    const parent = next.doc.firstChild.firstChild;
    expect(parent.firstChild.textContent).toBe(before);
    expect(parent.attrs).toEqual(originalParent.attrs);
    expect(parent.content.cut(parent.firstChild.nodeSize).eq(originalParent.content.cut(originalParent.firstChild.nodeSize))).toBe(true);
    expect(next.selection.$from.node(-1).eq(task(after))).toBe(true);
    expect(next.selection.$from.parentOffset).toBe(0);
  });

  test("command availability does not dispatch or mutate the document", () => {
    const state = createState();
    const originalDoc = state.doc.toJSON();
    expect(splitTaskItemWithoutInheritedMarks(state, undefined)).toBe(true);
    expect(state.doc.toJSON()).toEqual(originalDoc);
  });

  test("expanded task items keep their existing split behavior", () => {
    const state = createState({ attrs: { collapsed: false } });
    const previous = state.doc.firstChild.firstChild;
    const next = enter(state);
    const list = next.doc.firstChild;
    expect(list.firstChild.eq(task("Parent"))).toBe(true);
    expect(list.child(1).childCount).toBe(3);
    expect(list.child(1).child(1).eq(previous.child(1))).toBe(true);
    expect(list.child(1).child(2).textContent).toBe("Child details");
  });

  test("consecutive Enter merges an expanded task's split sub-content into a child paragraph", () => {
    const state = createState({ attrs: { collapsed: false } });
    const originalParent = state.doc.firstChild.firstChild;
    const originalSibling = state.doc.firstChild.lastChild;
    const split = enter(state);
    const fresh = EditorState.create({ doc: split.doc, selection: split.selection, plugins: [history()] });
    let subContent;
    expect(handleConsecutiveListEnter(fresh, (transaction) => {
      subContent = fresh.apply(transaction);
    })).toBe(true);

    expect(subContent.doc.firstChild.childCount).toBe(2);
    const parent = subContent.doc.firstChild.firstChild;
    expect(parent.attrs.collapsed).toBe(false);
    expect(parent.firstChild.eq(originalParent.firstChild)).toBe(true);
    expect(parent.child(1).type.name).toBe("paragraph");
    expect(parent.child(1).content.size).toBe(0);
    expect(parent.child(2).eq(originalParent.child(1))).toBe(true);
    expect(parent.child(3).eq(originalParent.child(2))).toBe(true);
    expect(subContent.doc.firstChild.lastChild.eq(originalSibling)).toBe(true);
    expect(subContent.selection.$from.parent).toBe(parent.child(1));
    expect(subContent.selection.$from.parentOffset).toBe(0);
    subContent.doc.check();

    let restored;
    expect(undo(subContent, (transaction) => { restored = subContent.apply(transaction); })).toBe(true);
    expect(restored.doc.eq(fresh.doc)).toBe(true);
  });

  test("Tab expands a collapsed parent when sinking a new sibling task into it", () => {
    const state = createState();
    const { doc, selection } = enter(state);
    const createdSibling = EditorState.create({ doc, selection, plugins: [history()] });
    let next;

    expect(sinkListItemPreservingAttrs(createdSibling, (transaction) => {
      next = createdSibling.apply(transaction);
    })).toBe(true);

    const originalParent = doc.firstChild.firstChild;
    const parent = next.doc.firstChild.firstChild;
    expect(parent.attrs).toEqual({ ...originalParent.attrs, collapsed: false });
    expect(parent.content.cut(0, originalParent.content.size).eq(originalParent.content)).toBe(true);
    expect(parent.lastChild.attrs.numbered).toBe(true);
    expect(parent.lastChild.firstChild.eq(task(""))).toBe(true);
    expect(next.selection.$from.node(-1)).toBe(parent.lastChild.firstChild);
    expect(next.doc.firstChild.child(1).eq(doc.firstChild.lastChild)).toBe(true);
    next.doc.check();

    let restored;
    expect(undo(next, (transaction) => { restored = next.apply(transaction); })).toBe(true);
    expect(restored.doc.eq(doc)).toBe(true);
    expect(restored.selection.eq(selection)).toBe(true);
  });
});
