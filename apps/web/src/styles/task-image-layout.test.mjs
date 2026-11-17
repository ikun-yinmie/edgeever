import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const surfaces = [
  ["desktop", "globals.css", ".ProseMirror", ":is(.node-image, img:not(.ProseMirror-separator))"],
  ["mobile", "mobile-markdown-editor.css", ".edgeever-mobile-tiptap-content", "img:not(.ProseMirror-separator)"],
  ["HTML", "note-html-export.css", ".edgeever-html-content", "img"],
  ["print", "note-print.css", ".edgeever-print-content", "img"],
];
const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
};

describe("task child image layout", () => {
  for (const [name, file, root, imageSelector] of surfaces) {
    const css = readFileSync(new URL(file, import.meta.url), "utf8");
    const content = `${root} ul[data-type="taskList"] li[data-checked] > div`;
    test(`${name} wraps adjacent images while keeping other blocks full width`, () => {
      const container = rule(css, content);
      expect(container).toContain("display: flex;");
      expect(container).toContain("flex-wrap: wrap;");
      expect(container).toContain("align-items: flex-start;");
      expect(container).toContain("column-gap: 0.75rem;");
      expect(rule(css, `${content} > *`)).toContain("flex: 0 0 100%;");
      const image = rule(css, `${content} > ${imageSelector}`);
      expect(image).toContain("flex: 0 0 auto;");
      expect(image).toContain("min-width: min(9rem, calc((100% - 0.75rem) / 2));");
      expect(image).toContain("max-width: 100%;");
      expect(image).not.toContain("object-fit: cover;");
      expect(image).not.toContain("height:");
    });
  }

  test("desktop outer image boxes retain the selected width and fill the inner figure", () => {
    const css = readFileSync(new URL("globals.css", import.meta.url), "utf8");
    const imageView = readFileSync(new URL("../components/editor/ResizableImage.tsx", import.meta.url), "utf8");
    expect(css).toContain("width: var(--edgeever-image-width, 25%);");
    const figure = rule(css, '.ProseMirror ul[data-type="taskList"] li[data-checked] > div > .node-image > .edgeever-image-node');
    expect(figure).toContain("width: 100% !important;");
    expect(figure).toContain("min-width: 0;");
    expect(imageView).toContain('nodeView?.style.setProperty("--edgeever-image-width", `${width}%`);');
    expect(imageView).toContain('const parent = taskContent?.matches(\'li[data-checked] > div\') ? taskContent : nodeView;');
    expect(imageView).toContain("const parentWidth = parent.getBoundingClientRect().width;");
  });
});
