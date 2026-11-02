import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EdgeEverTextStyle, EdgeEverTextBackgroundColor, EdgeEverTextColor } from "@edgeever/shared";
import { captureFormatFromEditor, applyFormatToEditor } from "./format-painter";

describe("format painter", () => {
  test("captures inline marks (background color, color, bold) and applies them to another range", () => {
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTextStyle, EdgeEverTextBackgroundColor, EdgeEverTextColor],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                marks: [
                  { type: "bold" },
                  { type: "textStyle", attrs: { backgroundColor: "#fef08a", color: "#b91c1c" } },
                ],
                text: "Source styled text",
              },
              {
                type: "text",
                text: " Target plain text",
              },
            ],
          },
        ],
      },
    });

    // 1. Select the source text (pos 1 to 19)
    editor.commands.setTextSelection({ from: 1, to: 19 });
    const captured = captureFormatFromEditor(editor);
    expect(captured).not.toBeNull();
    expect(captured.marks.some((m) => m.type === "bold")).toBe(true);
    const textStyleMark = captured.marks.find((m) => m.type === "textStyle");
    expect(textStyleMark).toBeDefined();
    expect(textStyleMark.attrs.backgroundColor).toBe("#fef08a");
    expect(textStyleMark.attrs.color).toBe("#b91c1c");

    // 2. Apply to target text (pos 19 to 37)
    editor.commands.setTextSelection({ from: 19, to: 37 });
    const applied = applyFormatToEditor(editor, captured);
    expect(applied).toBe(true);

    // Verify the target range now has both bold and the textStyle marks
    let targetHasBold = false;
    let targetHasBg = false;
    let targetHasColor = false;
    editor.state.doc.nodesBetween(19, 37, (node) => {
      if (node.isInline && node.marks) {
        if (node.marks.some((m) => m.type.name === "bold")) targetHasBold = true;
        const ts = node.marks.find((m) => m.type.name === "textStyle");
        if (ts?.attrs?.backgroundColor === "#fef08a") targetHasBg = true;
        if (ts?.attrs?.color === "#b91c1c") targetHasColor = true;
      }
    });
    expect(targetHasBold).toBe(true);
    expect(targetHasBg).toBe(true);
    expect(targetHasColor).toBe(true);

    editor.destroy();
  });

  test("clears existing formatting on the target before applying new format", () => {
    const editor = new Editor({
      extensions: [StarterKit, EdgeEverTextStyle],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                marks: [{ type: "italic" }],
                text: "Only italic",
              },
              {
                type: "text",
                marks: [{ type: "bold" }, { type: "strike" }],
                text: " Bold and strike",
              },
            ],
          },
        ],
      },
    });

    // Capture italic from first node
    editor.commands.setTextSelection({ from: 1, to: 12 });
    const captured = captureFormatFromEditor(editor);
    expect(captured.marks).toHaveLength(1);
    expect(captured.marks[0].type).toBe("italic");

    // Apply to second node (should remove bold and strike, leaving only italic)
    const applied = applyFormatToEditor(editor, captured, { from: 13, to: 28 });
    expect(applied).toBe(true);

    // Check all text nodes in the paragraph: the target text should now have italic and no bold or strike
    const doc = editor.getJSON();
    let targetHasItalic = false;
    let targetHasBoldOrStrike = false;
    editor.state.doc.nodesBetween(13, 28, (node) => {
      if (node.isInline && node.marks) {
        if (node.marks.some((m) => m.type.name === "italic")) targetHasItalic = true;
        if (node.marks.some((m) => m.type.name === "bold" || m.type.name === "strike")) targetHasBoldOrStrike = true;
      }
    });
    expect(targetHasItalic).toBe(true);
    expect(targetHasBoldOrStrike).toBe(false);

    editor.destroy();
  });
});
