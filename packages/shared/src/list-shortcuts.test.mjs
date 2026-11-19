import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createEdgeEverDocumentExtensions } from "./document-extensions.ts";
import { handleConsecutiveListEnter, sinkListItemPreservingAttrs, splitTaskItemWithoutInheritedMarks, toggleTaskItemCollapseAtSelection } from "./list-shortcuts.ts";

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

  test("expanded task items keep their existing descendants when splitting the title", () => {
    const state = createState({ attrs: { collapsed: false } });
    const previous = state.doc.firstChild.firstChild;
    const next = enter(state);
    const list = next.doc.firstChild;
    expect(list.firstChild.eq(previous)).toBe(true);
    expect(list.child(1).eq(task(""))).toBe(true);
    expect(list.lastChild.eq(state.doc.firstChild.lastChild)).toBe(true);
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

describe("task hierarchy and selected content", () => {
  for (const nested of [false, true]) {
    test(`Enter then Tab inserts before existing ${nested ? "nested " : ""}children without making them grandchildren`, () => {
      const state = createState({ nested, attrs: { collapsed: false } });
      const originalParent = state.selection.$from.node(-1);
      const split = enter(state);
      const current = EditorState.create({ doc: split.doc, selection: split.selection, plugins: [history()] });
      let next;
      expect(sinkListItemPreservingAttrs(current, undefined)).toBe(true);
      expect(sinkListItemPreservingAttrs(current, tr => { next = current.apply(tr); })).toBe(true);
      const parent = next.selection.$from.node(-3);
      const children = parent.child(1);
      expect(parent.firstChild.eq(originalParent.firstChild)).toBe(true);
      expect(parent.attrs).toEqual(originalParent.attrs);
      expect(children.attrs.numbered).toBe(true);
      expect(children.firstChild.eq(task(""))).toBe(true);
      expect(children.child(1).eq(originalParent.child(1).firstChild)).toBe(true);
      expect(parent.child(2).eq(originalParent.child(2))).toBe(true);
      expect(next.selection.$from.node(-1)).toBe(children.firstChild);
      expect(next.selection.$from.parentOffset).toBe(0);
      next.doc.check();
      let restored;
      expect(undo(next, tr => { restored = next.apply(tr); })).toBe(true);
      expect(restored.doc.eq(split.doc)).toBe(true);
      expect(restored.selection.eq(split.selection)).toBe(true);
    });
  }

  test("an empty task with descendants is not merged into its previous sibling", () => {
    const state = createState({ title: "", attrs: { collapsed: false } });
    const previous = task("Before");
    const doc = schema.nodes.doc.create(null, taskList([previous, state.doc.firstChild.firstChild, state.doc.firstChild.lastChild]));
    const current = EditorState.create({ doc, selection: TextSelection.create(doc, previous.nodeSize + 3) });
    expect(handleConsecutiveListEnter(current, undefined)).toBe(false);
    expect(enter(current).doc.firstChild.child(1).eq(doc.firstChild.child(1))).toBe(true);
  });

  for (const collapsed of [false, true]) {
    test(`Tab moves selected blocks under the preceding task (collapsed: ${collapsed})`, () => {
      const parent = task("Parent", { collapsed, checked: true }, [taskList([task("Existing child")])]);
      const first = paragraph("Selected first", [schema.marks.bold.create()]);
      const second = paragraph("Selected second");
      const following = paragraph("Unselected");
      const list = taskList([parent]);
      const doc = schema.nodes.doc.create(null, [list, first, second, following]);
      const from = list.nodeSize + 2;
      const to = list.nodeSize + first.nodeSize + second.nodeSize - 2;
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to), plugins: [history()] });
      let next;
      expect(sinkListItemPreservingAttrs(state, undefined)).toBe(true);
      expect(sinkListItemPreservingAttrs(state, tr => { next = state.apply(tr); })).toBe(true);
      const updated = next.doc.firstChild.firstChild;
      expect(next.doc.childCount).toBe(2);
      expect(next.doc.lastChild.eq(following)).toBe(true);
      expect(updated.attrs).toEqual({ ...parent.attrs, collapsed: false });
      expect(updated.child(1).eq(parent.child(1))).toBe(true);
      expect(updated.child(2).eq(first)).toBe(true);
      expect(updated.child(3).eq(second)).toBe(true);
      expect(next.doc.textBetween(next.selection.from, next.selection.to)).toBe(doc.textBetween(from, to));
      next.doc.check();
      let restored;
      expect(undo(next, tr => { restored = next.apply(tr); })).toBe(true);
      expect(restored.doc.eq(doc)).toBe(true);
      expect(restored.selection.eq(state.selection)).toBe(true);
    });
  }

  test("Tab moves a selected group of tasks together with their existing subtrees", () => {
    const first = task("First", { rejected: true }, [taskList([task("Grandchild")])]);
    const second = task("Second", { checked: true });
    const following = task("Following");
    const parent = task("Parent");
    const doc = schema.nodes.doc.create(null, taskList([parent, first, second, following]));
    const from = parent.nodeSize + 3;
    const to = parent.nodeSize + first.nodeSize + second.firstChild.nodeSize + 1;
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
    let next;
    expect(sinkListItemPreservingAttrs(state, tr => { next = state.apply(tr); })).toBe(true);
    expect(next.doc.firstChild.childCount).toBe(2);
    expect(next.doc.firstChild.lastChild.eq(following)).toBe(true);
    const children = next.doc.firstChild.firstChild.lastChild;
    expect(children.attrs.numbered).toBe(true);
    expect(children.childCount).toBe(2);
    expect(children.firstChild.eq(first)).toBe(true);
    expect(children.lastChild.eq(second)).toBe(true);
    next.doc.check();
  });

  test("ordinary paragraphs with no preceding task remain outside task indentation", () => {
    const doc = schema.nodes.doc.create(null, [paragraph("Before"), paragraph("Selected")]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 10, 14) });
    expect(sinkListItemPreservingAttrs(state, undefined)).toBe(false);
  });
});

describe("task folding selection and history", () => {
  test("collapsing a task moves a hidden child caret to the parent title", () => {
    let state = createState({ attrs: { collapsed: false } });
    let childPosition;
    state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.textContent === "Child") childPosition = position + 2;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, childPosition)));
    let next;
    expect(toggleTaskItemCollapseAtSelection(state, tr => { next = state.apply(tr); }, 1)).toBe(true);
    expect(next.doc.firstChild.firstChild.attrs.collapsed).toBe(true);
    expect(next.selection.$from.parent.textContent).toBe("Parent");
    expect(next.selection.$from.parentOffset).toBe("Parent".length);
    next.doc.check();
  });

  test("undoing typing does not undo a manually collapsed task", () => {
    const state = createState({ attrs: { collapsed: false } });
    const typed = state.apply(state.tr.insertText(" added"));
    let collapsed;
    expect(toggleTaskItemCollapseAtSelection(typed, tr => { collapsed = typed.apply(tr); })).toBe(true);
    let restored;
    expect(undo(collapsed, tr => { restored = collapsed.apply(tr); })).toBe(true);
    expect(restored.doc.firstChild.firstChild.attrs.collapsed).toBe(true);
    expect(restored.doc.firstChild.firstChild.firstChild.textContent).toBe("Parent");
  });

  test("folding a different task does not move an unrelated caret", () => {
    const state = createState({ attrs: { collapsed: false } });
    const following = state.doc.firstChild.lastChild;
    const cursor = state.doc.content.size - following.nodeSize + 3;
    const current = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)));
    let next;
    expect(toggleTaskItemCollapseAtSelection(current, tr => { next = current.apply(tr); }, 1)).toBe(true);
    expect(next.selection.eq(current.selection)).toBe(true);
  });
});
