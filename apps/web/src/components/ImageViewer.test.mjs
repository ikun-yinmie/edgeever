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
    expect(source).toContain("imageFit: \"contain\"");
  });
});
