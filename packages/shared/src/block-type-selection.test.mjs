import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { BlockTypeSelection } from "./block-type-selection.ts";

const createEditor = () => new Editor({
  extensions: [StarterKit, BlockTypeSelection],
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "first" }] },
      { type: "paragraph", content: [{ type: "text", text: "second" }] },
    ],
  },
});

const blockTypes = (editor) =>
  editor.state.doc.content.content.map((node) => node.type.name);

describe("block type selection", () => {
  test("does not convert the next line when the selection ends at its start", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });

    editor.commands.setHeading({ level: 2 });

    expect(blockTypes(editor)).toEqual(["heading", "paragraph"]);
    expect(editor.state.doc.child(0).attrs.level).toBe(2);
    editor.destroy();
  });

  test("does not convert the previous line when the selection starts at its end", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 6, to: 11 });

    editor.commands.setHeading({ level: 2 });

    expect(blockTypes(editor)).toEqual(["paragraph", "heading"]);
    editor.destroy();
  });

  test("does not convert an empty next line when the selection ends at its start", () => {
    const editor = new Editor({
      extensions: [StarterKit, BlockTypeSelection],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "first" }] },
          { type: "paragraph" },
        ],
      },
    });
    editor.commands.setTextSelection({ from: 1, to: 8 });

    editor.commands.setHeading({ level: 2 });

    expect(blockTypes(editor)).toEqual(["heading", "paragraph"]);
    expect(editor.state.doc.child(1).content.size).toBe(0);
    editor.destroy();
  });

  test("still converts multiple fully selected blocks", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 14 });

    editor.commands.setHeading({ level: 3 });

    expect(blockTypes(editor)).toEqual(["heading", "heading"]);
    expect(editor.state.doc.child(0).attrs.level).toBe(3);
    expect(editor.state.doc.child(1).attrs.level).toBe(3);
    editor.destroy();
  });

  test("keeps normal caret behavior inside a block", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(9);

    editor.commands.setHeading({ level: 1 });

    expect(blockTypes(editor)).toEqual(["paragraph", "heading"]);
    editor.destroy();
  });

  test("respects the same boundary when changing headings back to paragraphs", () => {
    const editor = new Editor({
      extensions: [StarterKit, BlockTypeSelection],
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "first" }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "second" }] },
        ],
      },
    });
    editor.commands.setTextSelection({ from: 1, to: 8 });

    editor.commands.setParagraph();

    expect(blockTypes(editor)).toEqual(["paragraph", "heading"]);
    editor.destroy();
  });
});
