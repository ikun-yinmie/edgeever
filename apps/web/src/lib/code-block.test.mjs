import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
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
