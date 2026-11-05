import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { history, undo } from "@tiptap/pm/history";
import { EdgeEverTaskItem, EdgeEverTaskList, ensureCodeBlockTrailingParagraph } from "@edgeever/shared";
import { EdgeEverCodeBlock, enterAdjacentPreviewCodeBlock, getCodeBlockLanguageValue, selectCurrentCodeBlockContent } from "./code-block.ts";

const createEditor = (language = "mermaid") => new Editor({
  extensions: [
    StarterKit.configure({ codeBlock: false }),
    EdgeEverCodeBlock,
  ],
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      {
        type: "codeBlock",
        attrs: { language },
        content: [{ type: "text", text: "flowchart TD\n  A --> B" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ],
  },
});

const getCodeBlockRange = (editor) => {
  let range = null;
  editor.state.doc.descendants((node, pos) => {
    if (!range && node.type.name === "codeBlock") {
      range = { from: pos + 1, to: pos + 1 + node.content.size };
    }
  });
  return range;
};

const paragraph = (text = "") => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const createInsertionEditor = (content) => new Editor({
  extensions: [
    StarterKit.configure({ codeBlock: false, trailingNode: false }),
    EdgeEverTaskList,
    EdgeEverTaskItem.configure({ nested: true }),
    EdgeEverCodeBlock,
  ],
  content: { type: "doc", content },
});

describe("new code block trailing paragraphs", () => {
  let navigatorDescriptor;
  beforeEach(() => {
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "Linux", userAgent: "Bun" },
    });
  });
  afterEach(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  });

  for (const command of ["setCodeBlock", "toggleCodeBlock"]) {
    for (const atEnd of [false, true]) {
      test(`${command} adds an empty paragraph ${atEnd ? "at the end" : "within a note"} and keeps selection`, () => {
        const editor = createInsertionEditor([paragraph("code"), ...(atEnd ? [] : [paragraph("keep")])]);
        editor.commands.setTextSelection({ from: 2, to: 4 });
        expect(editor.commands[command]()).toBe(true);
        expect(editor.state.doc.child(0).type.name).toBe("codeBlock");
        expect(editor.state.doc.child(0).textContent).toBe("code");
        expect(editor.state.doc.child(1).type.name).toBe("paragraph");
        expect(editor.state.doc.child(1).content.size).toBe(0);
        expect(editor.state.doc.childCount).toBe(atEnd ? 2 : 3);
        if (!atEnd) expect(editor.state.doc.child(2).textContent).toBe("keep");
        expect(editor.state.selection.from).toBe(2);
        expect(editor.state.selection.to).toBe(4);
        editor.state.doc.check();
        editor.destroy();
      });
    }
  }

  test("reuses an existing empty paragraph and repeated calls do not add more", () => {
    const editor = createInsertionEditor([paragraph("code"), paragraph(), paragraph("keep")]);
    editor.commands.setTextSelection(2);
    expect(editor.commands.setCodeBlock()).toBe(true);
    expect(editor.commands.command(ensureCodeBlockTrailingParagraph)).toBe(true);
    expect(editor.commands.command(ensureCodeBlockTrailingParagraph)).toBe(true);
    expect(editor.commands.setCodeBlock({ language: "html" })).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).content.size).toBe(0);
    expect(editor.state.doc.child(2).textContent).toBe("keep");
    expect(editor.state.selection.from).toBe(2);
    editor.destroy();
  });

  test("keeps new code and its trailing paragraph inside the same task", () => {
    const editor = createInsertionEditor([{
      type: "taskList",
      content: [{ type: "taskItem", content: [paragraph("Task"), paragraph("detail")] }],
    }]);
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.textContent === "detail") editor.commands.setTextSelection(position + 3);
    });
    const before = editor.state.selection.from;
    expect(editor.commands.setCodeBlock()).toBe(true);
    const task = editor.state.doc.child(0).child(0);
    expect(task.childCount).toBe(3);
    expect(task.child(0).textContent).toBe("Task");
    expect(task.child(1).type.name).toBe("codeBlock");
    expect(task.child(2).type.name).toBe("paragraph");
    expect(task.child(2).content.size).toBe(0);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.selection.from).toBe(before);
    editor.state.doc.check();
    editor.destroy();
  });

  test("can checks do not mutate the note or its selection", () => {
    const editor = createInsertionEditor([paragraph("code")]);
    editor.commands.setTextSelection(2);
    const before = editor.getJSON();
    expect(editor.can().setCodeBlock()).toBe(true);
    expect(editor.can().toggleCodeBlock()).toBe(true);
    expect(editor.can().chain().setCodeBlock().command(ensureCodeBlockTrailingParagraph).run()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.from).toBe(2);
    editor.destroy();
  });

  test("conversion from a node selection and its extra paragraph undo together", () => {
    const editor = createInsertionEditor([paragraph("code"), paragraph("keep")]);
    editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }));
    editor.commands.setNodeSelection(0);
    const before = editor.getJSON();
    expect(editor.commands.setCodeBlock()).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.state.selection.$to.parent.type.name).toBe("codeBlock");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  test("loading or changing an existing code block language does not normalize old content", () => {
    const editor = createInsertionEditor([{
      type: "codeBlock", content: [{ type: "text", text: "old" }],
    }, paragraph("keep")]);
    const before = editor.getJSON();
    editor.commands.setTextSelection(2);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.setCodeBlock({ language: "html" })).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).textContent).toBe("keep");
    editor.view.dispatch(editor.state.tr.insertText("!"));
    expect(editor.state.doc.childCount).toBe(2);
    editor.destroy();
  });

  test("multiline replacement and its trailing paragraph use one transaction", () => {
    const editor = createInsertionEditor([paragraph("first"), paragraph("second")]);
    editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }));
    const before = editor.getJSON();
    expect(editor.chain().insertContentAt({ from: 1, to: editor.state.doc.content.size - 1 }, {
      type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "first\nsecond" }],
    }).command(ensureCodeBlockTrailingParagraph).run()).toBe(true);
    const range = getCodeBlockRange(editor);
    const next = editor.state.doc.resolve(range.to + 1).nodeAfter;
    expect(next.type.name).toBe("paragraph");
    expect(next.content.size).toBe(0);
    expect(editor.state.selection.from).toBe(range.to);
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  test("adding code below a block leaves an editable empty paragraph below it", () => {
    const editor = createInsertionEditor([paragraph("before"), paragraph("after")]);
    const position = editor.state.doc.child(0).nodeSize;
    expect(editor.chain().insertContentAt(position, { type: "codeBlock" }).command(ensureCodeBlockTrailingParagraph).run()).toBe(true);
    expect(editor.state.doc.content.content.map((node) => node.type.name)).toEqual(["paragraph", "codeBlock", "paragraph", "paragraph"]);
    expect(editor.state.doc.child(2).content.size).toBe(0);
    expect(editor.state.doc.child(3).textContent).toBe("after");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    editor.destroy();
  });

  test.each(["```javascript", "~~~html"])("the %s input rule also creates a trailing paragraph", (prefix) => {
    const editor = createInsertionEditor([paragraph(prefix), paragraph("keep")]);
    editor.commands.setTextSelection(prefix.length + 1);
    const cursor = editor.state.selection.from;
    const handled = editor.extensionManager.plugins.some((plugin) => plugin.props.handleTextInput?.(editor.view, cursor, cursor, " "));
    expect(handled).toBe(true);
    expect(editor.state.doc.child(0).type.name).toBe("codeBlock");
    expect(editor.state.doc.child(0).content.size).toBe(0);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).content.size).toBe(0);
    expect(editor.state.doc.child(2).textContent).toBe("keep");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    editor.destroy();
  });
});

describe("code block selection", () => {
  test("selects only the current code block on the first Mod-a", () => {
    const editor = createEditor();
    const range = getCodeBlockRange(editor);
    editor.commands.setTextSelection(range.from + 2);

    expect(selectCurrentCodeBlockContent(editor)).toBe(true);
    expect({
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }).toEqual(range);
    editor.destroy();
  });

  test("allows the editor-wide Mod-a after the code block is fully selected", () => {
    const editor = createEditor();
    const range = getCodeBlockRange(editor);
    editor.commands.setTextSelection(range);

    expect(selectCurrentCodeBlockContent(editor)).toBe(false);
    editor.destroy();
  });

  test("leaves Mod-a unchanged outside code blocks", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(2);

    expect(selectCurrentCodeBlockContent(editor)).toBe(false);
    editor.destroy();
  });

  test("maps Markdown aliases to the language picker value", () => {
    expect(getCodeBlockLanguageValue("md")).toBe("markdown");
    expect(getCodeBlockLanguageValue("MARKDOWN")).toBe("markdown");
    expect(getCodeBlockLanguageValue("htm")).toBe("html");
    expect(getCodeBlockLanguageValue("HTML")).toBe("html");
    expect(getCodeBlockLanguageValue("javascript")).toBe("javascript");
  });

  test.each(["md", "html", "htm"])("arrows enter adjacent %s blocks without changing content", (language) => {
    const editor = createEditor(language);
    const range = getCodeBlockRange(editor);
    const original = editor.getJSON();
    editor.commands.setTextSelection(range.from - 2);
    expect(enterAdjacentPreviewCodeBlock(editor, 1)).toBe(true);
    expect(editor.state.selection.from).toBe(range.from);
    editor.commands.setTextSelection(range.to + 2);
    expect(enterAdjacentPreviewCodeBlock(editor, -1)).toBe(true);
    expect(editor.state.selection.from).toBe(range.to);
    expect(editor.getJSON()).toEqual(original);
    editor.destroy();
  });

  test("does not intercept arrows mid-paragraph, across a selection, or before non-Markdown blocks", () => {
    const editor = createEditor("markdown");
    const range = getCodeBlockRange(editor);
    editor.commands.setTextSelection(2);
    expect(enterAdjacentPreviewCodeBlock(editor, 1)).toBe(false);
    editor.commands.setTextSelection({ from: 1, to: range.from - 2 });
    expect(enterAdjacentPreviewCodeBlock(editor, 1)).toBe(false);
    editor.commands.setTextSelection(range.from);
    editor.commands.updateAttributes("codeBlock", { language: "javascript" });
    editor.commands.setTextSelection(range.from - 2);
    expect(enterAdjacentPreviewCodeBlock(editor, 1)).toBe(false);
    editor.destroy();
  });

  test.each(["markdown", "html"])("does not enter collapsed %s blocks", (language) => {
    const editor = createEditor(language);
    const range = getCodeBlockRange(editor);
    editor.commands.setTextSelection(range.from);
    editor.commands.updateAttributes("codeBlock", { meta: { collapsed: true } });
    editor.commands.setTextSelection(range.from - 2);
    expect(enterAdjacentPreviewCodeBlock(editor, 1)).toBe(false);
    editor.destroy();
  });
});
