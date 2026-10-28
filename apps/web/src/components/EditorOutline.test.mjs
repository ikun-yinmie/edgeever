import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const outlineSource = readFileSync(new URL("./EditorOutline.tsx", import.meta.url), "utf8");
const outlineItemsSource = readFileSync(new URL("../lib/editor-outline-editor.ts", import.meta.url), "utf8");
const editorPaneSource = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const phonePreviewSource = readFileSync(new URL("./EditorPhonePreview.tsx", import.meta.url), "utf8");
const helpersSource = readFileSync(new URL("./editor/editor-pane-helpers.ts", import.meta.url), "utf8");

describe("editor outline floating toggle", () => {
  test("keeps the collapsed toggle floating while scrolling instead of anchoring it to the article top", () => {
    expect(outlineSource).not.toContain("absolute right-2 top-6");
    expect(outlineSource).toContain("sticky top-6 z-20 h-8 w-0 shrink-0 self-start overflow-visible");
    expect(outlineSource).toContain('collapsed ? "absolute right-0 top-0 h-8 w-8 justify-center"');
  });

  test("renders strikethrough runs from heading marks in the outline", () => {
    expect(outlineSource).toContain("getOutlineDisplaySegments");
    expect(outlineItemsSource).toContain('mark.type.name === "strike"');
    expect(outlineSource).toContain('segment.strike ? "line-through" : undefined');
  });

  test("matches and scrolls the phone preview scroller when the preview stage is visible", () => {
    expect(outlineSource).toContain("previewContainer?: HTMLDivElement | null");
    expect(outlineSource).toContain("getPreviewHeadingElements");
    expect(outlineSource.replace(/\s+/g, " ")).toContain(
      'previewContainer.scrollTo({ top: previewContainer.scrollTop + delta, behavior: "smooth" })'
    );
  });

  test("renders the outline while the phone preview is open and feeds it the preview scroller", () => {
    const normalizedEditorPane = editorPaneSource.replace(/\s+/g, " ");
    expect(normalizedEditorPane).not.toContain("!phonePreviewOpen && ( <EditorOutline");
    expect(normalizedEditorPane).toContain(
      "previewContainer={phonePreviewOpen && phonePreviewStageVisible ? phonePreviewScroller : null}"
    );
    expect(normalizedEditorPane).toContain("onScrollerChange={setPhonePreviewScroller}");
    expect(normalizedEditorPane).toContain("PHONE_PREVIEW_STAGE_QUERY");
  });

  test("exposes the phone preview scroller element to the editor pane", () => {
    expect(phonePreviewSource).toContain("onScrollerChange?: (element: HTMLDivElement | null) => void");
    expect(phonePreviewSource).toContain("onScrollerChange?.(element);");
    expect(helpersSource).toContain('PHONE_PREVIEW_STAGE_QUERY = "(min-width: 1280px)"');
  });

  test("tracks window scrolling on reading pages such as the public share view", () => {
    expect(outlineSource).toContain("trackWindowScroll?: boolean");
    expect(outlineSource).toContain('window.addEventListener("scroll", updateFromScroll');
    expect(outlineSource).toContain('window.removeEventListener("scroll", updateFromScroll)');
  });
});

describe("editor outline collapsing", () => {
  test("starts each note with nested headings collapsed", () => {
    expect(outlineSource).toContain("getOutlineParentPositions");
    expect(outlineSource).toContain("documentKey?: string");
    expect(outlineSource).toContain("initializedDocumentKeyRef");
    expect(outlineSource).toContain("setCollapsedPositions(new Set(getOutlineParentPositions(nextTree)))");
  });

  test("offers one-click collapse-all and expand-all in both header layouts", () => {
    expect(outlineSource).toContain('t(allCollapsed ? "editor.expandAllOutline" : "editor.collapseAllOutline")');
    expect(outlineSource).toContain("<ChevronsUp");
    expect(outlineSource).toContain("<ChevronsDown");
    expect(outlineSource).toContain("aria-pressed={allCollapsed}");
    expect(outlineSource.match(/\{collapseAllButton\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("passes the open note id so switching notes resets the collapse state", () => {
    expect(editorPaneSource).toContain("documentKey={memo?.id}");
  });
});
