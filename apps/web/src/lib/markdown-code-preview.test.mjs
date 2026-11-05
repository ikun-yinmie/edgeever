import { describe, expect, test } from "bun:test";
import {
  isMarkdownCodeLanguage,
  renderMarkdownCodePreview,
} from "./markdown-code-preview.ts";

describe("Markdown code preview", () => {
  test("recognizes Markdown fence aliases", () => {
    expect(isMarkdownCodeLanguage("markdown")).toBe(true);
    expect(isMarkdownCodeLanguage("MD")).toBe(true);
    expect(isMarkdownCodeLanguage("mkdn")).toBe(true);
    expect(isMarkdownCodeLanguage("javascript")).toBe(false);
  });

  test("renders common GFM content", () => {
    const html = renderMarkdownCodePreview("# Title\n\n- [x] done\n- **bold**");

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<strong>bold</strong>");
  });

  test("renders raw HTML as inert text", () => {
    const html = renderMarkdownCodePreview('<img src=x onerror="alert(1)">\n<script>alert(1)</script>');

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("removes unsafe links and images while keeping safe URLs", () => {
    const html = renderMarkdownCodePreview([
      "[unsafe](javascript:alert(1))",
      "[mixed case](JaVaScRiPt:alert(1))",
      "[control characters](<java\tscript:alert(1)>)",
      "![unsafe image](data:text/html;base64,PHNjcmlwdD4=)",
      "[safe](https://example.com)",
      "![safe image](/image.png)",
    ].join("\n\n"));

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('src="/image.png"');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test("preserves indentation, fenced code, tables and empty input", () => {
    const html = renderMarkdownCodePreview([
      "    <em>indented code</em>",
      "",
      "```html",
      "<script>not executed</script>",
      "```",
      "",
      "| First | Second |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n"));
    expect(html).toContain("<pre><code>&lt;em&gt;indented code&lt;/em&gt;");
    expect(html).toContain('&lt;script&gt;not executed&lt;/script&gt;');
    expect(html).toContain("<table>");
    expect(html).toContain("<td>two</td>");
    expect(renderMarkdownCodePreview("")).toBe("");
  });

  test("does not emit attributes from Markdown labels or native hover titles", () => {
    const html = renderMarkdownCodePreview('![a\" onerror=\"alert(1)](/image.png "image title")\n\n[safe](/path "link title")');
    expect(html).toContain('alt="a&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain(' onerror="');
    expect(html).not.toContain(' title="');
  });
});
