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
    expect(imageSource).toContain("event.stopPropagation()");
    expect(imageSource).toContain("onContextMenu={(event: MouseEvent<HTMLImageElement>) => requestImageContextMenu(event)}");
  });

  test("offers copy-to-clipboard from the image right-click menu", () => {
    expect(editorSource).toContain("showImageContextMenu");
    expect(editorSource).toContain("IMAGE_CONTEXT_MENU_SHOW_EVENT");
    expect(editorSource).toContain("resourceMenuLabels.copy");
    expect(editorSource).toContain("handleResourceCopyImage(target)");
    expect(editorSource).toContain("alignContextMenuToPoint(el, imageContextMenu.point)");
    // ProseMirror re-focuses the editor after a right click on an image, so the
    // menu must ignore focus-out or it disappears before it can be used.
    expect(editorSource).toContain("onFocusOutside={(event) => event.preventDefault()}");
  });

  test("keeps the open image menu anchored and dismisses it with the page", () => {
    expect(editorSource).toContain('event.target.closest("[data-image-actions-menu]")');
    expect(editorSource).toContain('window.addEventListener("scroll", hideMenu, true)');
  });
});
