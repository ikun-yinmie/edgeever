import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const outlineSource = readFileSync(new URL("./EditorOutline.tsx", import.meta.url), "utf8");
const editorPaneSource = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const phonePreviewSource = readFileSync(new URL("./EditorPhonePreview.tsx", import.meta.url), "utf8");
const helpersSource = readFileSync(new URL("./editor/editor-pane-helpers.ts", import.meta.url), "utf8");

describe("editor outline floating toggle", () => {
  test("keeps the collapsed toggle floating while scrolling instead of anchoring it to the article top", () => {
    expect(outlineSource).not.toContain("absolute right-2 top-6");
    expect(outlineSource).toContain("sticky top-6 z-20 h-8 w-0 shrink-0 self-start overflow-visible");
    expect(outlineSource).toContain('collapsed ? "absolute right-0 top-0 h-8 w-8 justify-center"');
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
});
