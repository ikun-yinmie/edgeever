import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const editorSource = readFileSync(
  new URL("../apps/web/src/components/EditorPane.tsx", import.meta.url),
  "utf8",
);
const imageSource = readFileSync(
  new URL("../apps/web/src/components/editor/ResizableImage.tsx", import.meta.url),
  "utf8",
);

describe("image copy actions", () => {
  test("opens an action menu at the pointer on image right click", () => {
    expect(imageSource).toContain("IMAGE_CONTEXT_MENU_SHOW_EVENT");
    expect(imageSource).toContain("point: { x: event.clientX, y: event.clientY }");
    expect(imageSource).toContain("onContextMenu={(event: MouseEvent<HTMLElement>) => requestImageContextMenu(event)}");
  });

  test("offers copy-to-clipboard from the image right-click menu", () => {
    expect(editorSource).toContain("showImageContextMenu");
    expect(editorSource).toContain("IMAGE_CONTEXT_MENU_SHOW_EVENT");
    expect(editorSource).toContain("resourceMenuLabels.copy");
    expect(editorSource).toContain("handleResourceCopyImage(target)");
  });
});
