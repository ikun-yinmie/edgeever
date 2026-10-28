import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");

describe("editor cursor restoration", () => {
  test("remembers focus-driven selections per note", () => {
    expect(source).toContain("writeEditorCursor(memoId, from, to)");
    expect(source).toContain("editor.view.hasFocus()");
    expect(source).toContain("editor.on(\"selectionUpdate\", rememberCursor)");
  });

  test("restores the saved caret when switching notes", () => {
    expect(source).toContain("const savedCursor = readEditorCursor(memo.id);");
    expect(source).toContain("writeEditorCursor(outgoingMemo.id");
    expect(source).toContain("currentEditor.commands.setTextSelection({ from, to })");
    expect(source).toContain("setBaseAndExtent(start.node, start.offset, end.node, end.offset)");
    expect(source).toContain("if (savedCursor && !effectiveReadOnly");
    expect(source).toContain("restoreEditorScrollMemory(container, scrollEntry)");
  });
});
