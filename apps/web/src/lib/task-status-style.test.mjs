import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const surfaces = [
  ["desktop", "globals.css", ".ProseMirror"],
  ["mobile", "mobile-markdown-editor.css", ".edgeever-mobile-tiptap-content"],
  ["HTML export", "note-html-export.css", ".edgeever-html-content"],
  ["print", "note-print.css", ".edgeever-print-content"],
].map(([name, file, root]) => ({
  name,
  root,
  css: readFileSync(new URL(`../styles/${file}`, import.meta.url), "utf8"),
}));

const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
};

const rejectedSelector = (root) => `${root} ul[data-type="taskList"] li[data-rejected="true"] > label`;

// Every surface uses the same font-independent, checkbox-sized SquareX mask.
const desktopMask = rule(surfaces[0].css, `${rejectedSelector(surfaces[0].root)}::after`).match(/mask: ([^;]+);/)?.[1];

describe("crossed-out task styling", () => {
  for (const { name, root, css } of surfaces) {
    test(`${name} renders a monochrome square cross without changing checkbox dimensions`, () => {
      const icon = rule(css, `${rejectedSelector(root)}::after`);
      expect(icon).toContain('content: "";');
      expect(icon).toContain("position: absolute;");
      expect(icon).toContain("inset: 0;");
      expect(icon).toContain("background-color:");
      expect(icon).toContain("pointer-events: none;");
      expect(icon.match(/mask: ([^;]+);/)?.[1]).toBe(desktopMask);
      expect(icon).not.toContain("font-size:");
      expect(icon).not.toContain("❌");
      expect(desktopMask).toContain("%3Crect");
      expect(desktopMask).toContain("%3Cpath");
      expect(desktopMask).toContain("100% 100%");
    });
  }

  test("live editor checkboxes remain clickable and keyboard-focusable", () => {
    for (const { root, css } of surfaces.slice(0, 2)) {
      const selector = rejectedSelector(root);
      const input = rule(css, `${selector} input`);
      expect(input).toContain("opacity: 0;");
      expect(input).not.toMatch(/visibility:\s*hidden|display:\s*none/);
      expect(rule(css, `${selector}:focus-within`)).toContain("outline: 2px solid");
    }
  });

  test("exported and printed masks retain their ink when background printing is disabled", () => {
    for (const { root, css } of surfaces.slice(2)) {
      expect(rule(css, `${rejectedSelector(root)}::after`)).toContain("print-color-adjust: exact;");
    }
  });

  test("mobile dark mode provides a lighter cross", () => {
    expect(surfaces[1].css).toContain(`html.dark ${rejectedSelector(surfaces[1].root)}::after {\n  background-color: #94a3b8;`);
  });

  test("toolbar uses the matching line icon instead of a colorful emoji", () => {
    const toolbar = readFileSync(new URL("../components/EditorToolbar.tsx", import.meta.url), "utf8");
    expect(toolbar).toContain('<SquareX className="h-4 w-4" />');
    expect(toolbar).not.toContain('<span aria-hidden="true">❌</span>');
  });
});
