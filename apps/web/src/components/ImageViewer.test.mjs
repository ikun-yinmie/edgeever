import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ImageViewer.tsx", import.meta.url), "utf8");

describe("ImageViewer", () => {
  test("zooms the image with the lightbox zoom plugin", () => {
    expect(source).toContain('import Zoom from "yet-another-react-lightbox/plugins/zoom"');
    expect(source).toContain("scrollToZoom: true");
    expect(source).toContain("pinchZoomV4: true");
    expect(source).toContain('toolbar={{ buttons: ["zoom", resetButton, "close"] }}');
    expect(source).toContain("closeOnBackdropClick: true");
    expect(source).toContain('imageFit: "contain"');
  });

  test("steps through adjacent images and hides arrows for a lone image", () => {
    expect(source).toContain("slides={open.slides.map");
    expect(source).toContain("index={Math.min(open.index, open.slides.length - 1)}");
    expect(source).toContain("const hasMultipleSlides = open.slides.length > 1;");
    expect(source).toContain("disableSwipeNavigation: !hasMultipleSlides");
    expect(source).toContain("buttonPrev: hasMultipleSlides ? undefined : () => null");
    expect(source).toContain("buttonNext: hasMultipleSlides ? undefined : () => null");
    expect(source).toContain("Previous: previousLabel");
    expect(source).toContain("Next: nextLabel");
  });
});
