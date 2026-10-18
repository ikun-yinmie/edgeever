import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const codeBlock = readFileSync(new URL("./MermaidCodeBlock.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

describe("MermaidCodeBlock read mode", () => {
  test("keeps collapse, width, line numbers and wrapping available without editing", () => {
    expect(codeBlock).toContain("setViewCollapsed((value) => !value)");
    expect(codeBlock).toContain("setViewWide((value) => !value)");
    expect(codeBlock).toContain("setViewLineNumbers((value) => !value)");
    expect(codeBlock).toContain("setViewWrap((value) => !value)");
    expect(codeBlock).toContain("const collapsed = canEdit ? isCollapsed : viewCollapsed;");
    expect(codeBlock).toContain("const wide = canEdit ? isWide : viewWide;");
    expect(codeBlock).toContain("const lineNumbersVisible = canEdit ? showLineNumbers : viewLineNumbers;");
    expect(codeBlock).toContain("const wrapLinesVisible = canEdit ? wrapLines : viewWrap;");
  });

  test("keeps language switching and title editing out of read mode", () => {
    expect(codeBlock).toMatch(/\{canEdit \? \(\s*<LanguagePicker/);
    expect(codeBlock).toMatch(/\{canEdit \? \(\s*<input/);
    expect(codeBlock).toContain('<span className="edgeever-code-lang" aria-hidden="true">{language}</span>');
    expect(codeBlock).toContain('<span className="edgeever-code-title-label">{blockTitle}</span>');
  });

  test("shows the mermaid source toggle and viewer for readers too", () => {
    const toolbar = codeBlock.split("edgeever-mermaid-toolbar")[1]?.split("edgeever-mermaid-preview")[0] ?? "";

    expect(toolbar).toContain("setSourceVisible((visible) => !visible)");
    expect(toolbar).toContain("setViewerOpen(true)");
  });

  test("keeps the tiptap content node mounted while collapsed so CSS can hide it", () => {
    expect(codeBlock).not.toMatch(/\{!collapsed && \(\s*<NodeViewContent/);
    expect(codeBlock).toContain("<NodeViewContent");
    expect(styles).toMatch(/\.edgeever-code-block-collapsed \.edgeever-code-source \{\s*display: none;/);
  });

  test("keeps only the document-wide sync actions behind the edit gate", () => {
    expect(codeBlock.split("{canEdit && (").length - 1).toBe(1);
    expect(codeBlock.indexOf("{canEdit && (")).toBeLessThan(codeBlock.indexOf("codeSyncStyleAll"));
  });
});
