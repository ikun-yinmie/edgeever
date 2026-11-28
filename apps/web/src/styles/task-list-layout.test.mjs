import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

const TASK_ITEM_LAYOUT_SOURCES = [
  ["./globals.css", '.ProseMirror ul[data-type="taskList"] li[data-checked]'],
  ["./mobile-markdown-editor.css", '.edgeever-mobile-tiptap-content ul[data-type="taskList"] li[data-checked]'],
  ["./note-html-export.css", '.edgeever-html-content ul[data-type="taskList"] li[data-checked]'],
  ["./note-print.css", '.edgeever-print-content ul[data-type="taskList"] li[data-checked]'],
  ["../../../mobile/src/components/LocalTiptapEditor.tsx", '.edgeever-editor-content ul[data-type="taskList"] li[data-checked]'],
  ["../../../ios/EditorSource/src/styles.css", '.ProseMirror ul[data-type="taskList"] li[data-checked]'],
];

const NESTED_TASK_LIST_LAYOUT_SOURCES = [
  ["./globals.css", '.ProseMirror ul[data-type="taskList"] ul[data-type="taskList"]', "calc(-1.15rem - 0.55rem)"],
  ["./mobile-markdown-editor.css", '.edgeever-mobile-tiptap-content ul[data-type="taskList"] ul[data-type="taskList"]', "calc(-22px - 9px)"],
];

describe("task list layout contract", () => {
  test.each(TASK_ITEM_LAYOUT_SOURCES)("uses TipTap's live task-item marker in %s", (relativePath, selector) => {
    const source = readSource(relativePath);
    const selectorStart = source.indexOf(selector);

    expect(selectorStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(selectorStart, selectorStart + selector.length + 160)).toMatch(/display:\s*flex/);
  });

  test.each(NESTED_TASK_LIST_LAYOUT_SOURCES)("hangs nested task toggles to align child checkboxes with parent text in %s", (relativePath, selector, overhang) => {
    const source = readSource(relativePath);
    const selectorStart = source.indexOf(selector);
    const blockStart = source.indexOf("{", selectorStart + selector.length);
    const blockEnd = source.indexOf("}", blockStart);
    const declarations = selectorStart >= 0 ? source.slice(blockStart + 1, blockEnd) : "";

    expect(selectorStart).toBeGreaterThanOrEqual(0);
    expect(declarations).toContain(`margin: ${relativePath === "./globals.css" ? "0.25rem 0 0" : "4px 0 0"} ${overhang};`);
    expect(declarations).toMatch(/padding-left:\s*0\s*;/);
  });
});
