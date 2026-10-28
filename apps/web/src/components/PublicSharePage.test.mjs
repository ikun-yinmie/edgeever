import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./PublicSharePage.tsx", import.meta.url), "utf8");
const scrollButtonsSource = readFileSync(new URL("./ScrollToEdgeButtons.tsx", import.meta.url), "utf8");

describe("PublicSharePage header", () => {
  test("shows who shared the note with a generic icon instead of brand marks", () => {
    expect(source).toContain("share.sharedByName");
    expect(source).toContain("<UserRound");
    expect(source).toContain("sharing.readOnly");
    expect(source).not.toContain("ShieldCheck");
    expect(source).not.toContain("EdgeEver ·");
  });
});

describe("PublicSharePage image preview", () => {
  test("opens the zoomable lightbox when a reader double clicks an image", () => {
    expect(source).toContain("handleDoubleClick");
    expect(source).toContain("target instanceof HTMLImageElement");
    expect(source).toContain("setViewerImage");
    expect(source).toContain("<ImageViewer");
    expect(source).toContain("sharing.imageViewer");
    expect(source).toContain("sharing.imageZoomIn");
    expect(source).toContain("sharing.imageZoomOut");
    expect(source).toContain("sharing.imageResetZoom");
  });
});

describe("PublicSharePage outline", () => {
  test("keeps the shared article and outline in independent scroll columns", () => {
    expect(source).toContain("<EditorOutline");
    expect(source).toContain("docked");
    expect(source).toContain("scrollContainer={articleScroller}");
    expect(source).not.toContain("trackWindowScroll");
    expect(source).toContain("onEditorReady={setShareEditor}");
    expect(source).toContain("const [outlineCollapsed, setOutlineCollapsed] = useState(false)");
    expect(source).toContain("className=\"max-lg:hidden\"");
    expect(source).toContain("lg:h-[100dvh] lg:overflow-hidden");
    expect(source).toContain("lg:min-h-0 lg:overflow-y-auto");
  });

  test("offers scroll-to-edge controls for the article scroller", () => {
    expect(source).toContain("<ScrollToEdgeButtons");
    expect(source).toContain("scrollContainer={articleScroller}");
    expect(scrollButtonsSource).toContain('data-scroll-to-edge="top"');
    expect(scrollButtonsSource).toContain('data-scroll-to-edge="bottom"');
    expect(scrollButtonsSource).toContain('t("editor.scrollToTop")');
    expect(scrollButtonsSource).toContain('t("editor.scrollToBottom")');
  });
});
