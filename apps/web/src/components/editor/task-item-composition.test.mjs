import { afterEach, describe, expect, test } from "bun:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { createTaskItemCompositionPlugin } from "./task-item-composition.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    taskList: { content: "taskItem+", group: "block" },
    taskItem: { content: "paragraph block*" },
    text: { group: "inline" },
  },
  marks: { bold: {} },
});

const harnesses = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.destroy();
});

const createHarness = ({ title = "Before after", offset = 6, nested = false } = {}) => {
  const paragraph = text => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
  const original = paragraph(title);
  const following = paragraph("Following task");
  const task = (heading, children = []) => schema.nodes.taskItem.create(null, [heading, ...children]);
  const list = schema.nodes.taskList.create(null, [task(original), task(following)]);
  const doc = schema.nodes.doc.create(null, nested
    ? schema.nodes.taskList.create(null, [task(paragraph("Outer"), [list])])
    : list);
  let paragraphPos;
  doc.descendants((node, pos) => { if (node === original) paragraphPos = pos; });
  const originalPosition = paragraphPos + 1 + offset;
  const plugin = createTaskItemCompositionPlugin();
  const listeners = new Map();
  const nextDom = {};
  let nativeSelection = null;
  let focusCount = 0;
  let lifecycle;
  const view = {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, originalPosition), plugins: [plugin] }),
    editable: true,
    composing: false,
    isDestroyed: false,
    hasFocus: () => true,
    dom: {
      contains: node => node === nextDom || node === view.dom,
      ownerDocument: {
        getSelection: () => nativeSelection,
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: type => listeners.delete(type),
      },
    },
    nodeDOM: position => {
      const node = view.state.doc.nodeAt(position);
      return node ? { textContent: node.textContent } : null;
    },
    posAtDOM: () => nextPosition(),
    dispatch: tr => {
      const previous = view.state;
      view.state = previous.apply(tr);
      lifecycle?.update(view, previous);
    },
    focus: () => { focusCount++; nativeSelection = null; },
  };
  const nextPosition = () => {
    let position;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.textContent === "Following task") position = pos + 1;
    });
    return position;
  };
  lifecycle = plugin.spec.view(view);
  const events = plugin.props.handleDOMEvents;
  const start = () => {
    events.compositionstart(view, { data: "" });
    view.composing = true;
  };
  const end = data => {
    events.compositionend(view, { data });
    view.composing = false;
  };
  const driftNative = () => { nativeSelection = { isCollapsed: true, anchorNode: nextDom, anchorOffset: 0 }; };
  const driftState = () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, nextPosition())));
  const harness = {
    view, start, end, events, listeners, driftNative, driftState, originalPosition, nextPosition,
    get focusCount() { return focusCount; },
    destroy: () => { lifecycle.destroy(); view.isDestroyed = true; },
  };
  harnesses.push(harness);
  return harness;
};

const cancelDraft = harness => {
  harness.start();
  harness.view.dispatch(harness.view.state.tr.insertText("pinyinn"));
  harness.view.dispatch(harness.view.state.tr.delete(harness.originalPosition, harness.originalPosition + 7));
  harness.end("");
};

describe("cancelled task IME preedit", () => {
  for (const options of [
    { title: "", offset: 0 },
    { title: "Before after", offset: 0 },
    { title: "Before after", offset: 6 },
    { title: "Before after", offset: 12, nested: true },
  ]) {
    test(`restores the original caret after cancellation and state drift: ${JSON.stringify(options)}`, async () => {
      const harness = createHarness(options);
      const before = harness.view.state.doc;
      cancelDraft(harness);
      harness.driftState();
      await Promise.resolve();
      expect(harness.view.state.selection.from).toBe(harness.originalPosition);
      expect(harness.view.state.doc.eq(before)).toBe(true);
      expect(harness.focusCount).toBe(1);
      harness.view.dispatch(harness.view.state.tr.insertText("继续"));
      expect(harness.view.state.selection.$from.parent.textContent).toBe(`${options.title.slice(0, options.offset)}继续${options.title.slice(options.offset)}`);
    });
  }

  test("does not dispatch editor transactions just for composition lifecycle events", () => {
    const harness = createHarness();
    const before = harness.view.state;
    harness.start();
    expect(harness.view.state).toBe(before);
    harness.end("");
    expect(harness.view.state).toBe(before);
  });

  test("maps the original caret when content before the composing task changes", async () => {
    const harness = createHarness({ nested: true });
    harness.start();
    harness.view.dispatch(harness.view.state.tr.insertText("prefix", 3));
    harness.end("");
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.originalPosition + 6);
    expect(harness.focusCount).toBe(1);
  });

  test("repairs a DOM-only jump even if the editor state still has the original caret", async () => {
    const harness = createHarness();
    cancelDraft(harness);
    harness.driftNative();
    harness.listeners.get("selectionchange")();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.originalPosition);
    expect(harness.focusCount).toBe(1);
  });

  test("repairs the cancelled composition before accepting the next text input", () => {
    const harness = createHarness();
    cancelDraft(harness);
    harness.driftNative();
    expect(harness.events.beforeinput(harness.view, { inputType: "insertText" })).toBe(false);
    expect(harness.focusCount).toBe(1);
    harness.view.dispatch(harness.view.state.tr.insertText("继续"));
    expect(harness.view.state.selection.$from.parent.textContent).toBe("Before继续 after");
  });

  test("keeps the anchor when the final composition deletion arrives after compositionend", async () => {
    const harness = createHarness();
    harness.start();
    harness.view.dispatch(harness.view.state.tr.insertText("pinyinn"));
    harness.end("");
    harness.events.beforeinput(harness.view, { inputType: "deleteCompositionText" });
    harness.view.dispatch(harness.view.state.tr.delete(harness.originalPosition, harness.originalPosition + 7));
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.originalPosition);
  });

  test("preserves the original stored marks", async () => {
    const harness = createHarness();
    const marks = [schema.marks.bold.create()];
    harness.view.dispatch(harness.view.state.tr.setStoredMarks(marks));
    cancelDraft(harness);
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.storedMarks).toEqual(marks);
  });

  test("does not move the caret after a committed composition", async () => {
    const harness = createHarness();
    harness.start();
    harness.view.dispatch(harness.view.state.tr.insertText("中文"));
    harness.end("中文");
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.nextPosition());
    expect(harness.focusCount).toBe(0);
  });

  test("does not restore over a changed source paragraph", async () => {
    const harness = createHarness();
    harness.start();
    harness.view.dispatch(harness.view.state.tr.insertText("changed"));
    harness.end("");
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.nextPosition());
    expect(harness.focusCount).toBe(0);
    expect(harness.view.state.doc.textContent).toContain("changed");
  });

  test("does not steal focus after the editor loses focus", async () => {
    const harness = createHarness();
    cancelDraft(harness);
    harness.view.hasFocus = () => false;
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.nextPosition());
    expect(harness.focusCount).toBe(0);
  });

  test("respects a deliberate pointer move after deleting the preedit", async () => {
    const harness = createHarness();
    cancelDraft(harness);
    harness.listeners.get("pointerdown")({ target: harness.view.dom });
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.nextPosition());
    expect(harness.focusCount).toBe(0);
  });

  test("respects keyboard navigation after deleting the preedit", async () => {
    const harness = createHarness();
    cancelDraft(harness);
    harness.listeners.get("keydown")({ key: "ArrowDown", keyCode: 40, isComposing: false, target: harness.view.dom });
    harness.driftState();
    await Promise.resolve();
    expect(harness.view.state.selection.from).toBe(harness.nextPosition());
    expect(harness.focusCount).toBe(0);
  });

  test("does not restore after the composing task was removed", async () => {
    const harness = createHarness();
    harness.start();
    const $from = harness.view.state.selection.$from;
    harness.view.dispatch(harness.view.state.tr.delete($from.before($from.depth - 1), $from.after($from.depth - 1)));
    harness.end("");
    await Promise.resolve();
    expect(harness.focusCount).toBe(0);
    expect(harness.view.state.doc.textContent).toBe("Following task");
  });
});
