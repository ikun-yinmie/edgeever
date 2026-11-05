import { describe, expect, test } from "bun:test";
import { buildHtmlCodePreviewDocument, getCodeBlockPreviewLanguage, HTML_CODE_PREVIEW_CSP } from "./code-block-preview.ts";

describe("code block preview languages", () => {
  test.each(["html", "HTML", "htm", " HtM "])("recognizes %s as HTML", (language) => {
    expect(getCodeBlockPreviewLanguage(language)).toBe("html");
  });

  test.each(["md", "markdown", "MD", "mkdn"])("preserves Markdown support for %s", (language) => {
    expect(getCodeBlockPreviewLanguage(language)).toBe("markdown");
  });

  test.each(["javascript", "xml", "mermaid", "plaintext", undefined, null])("does not preview %s", (language) => {
    expect(getCodeBlockPreviewLanguage(language)).toBeNull();
  });
});

describe("sandboxed HTML preview document", () => {
  test("retains HTML fragments and styles without Markdown conversion", () => {
    const source = '<style>h1 { color: red; }</style><h1>HTML preview</h1><p>**not Markdown**</p>';
    const preview = buildHtmlCodePreviewDocument(source);
    expect(preview).toContain(`<body>${source}</body>`);
    expect(preview).not.toContain("<strong>");
    expect(preview).toContain('<meta name="referrer" content="no-referrer">');
  });

  test("places restrictions before even a complete user-supplied document", () => {
    const source = '<!doctype html><html><head><style>body{margin:0}</style></head><body><p>Complete page</p></body></html>';
    const preview = buildHtmlCodePreviewDocument(source);
    expect(preview).toContain(source);
    expect(preview.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(preview.indexOf(source));
    expect(HTML_CODE_PREVIEW_CSP).toContain("script-src 'none'");
    expect(HTML_CODE_PREVIEW_CSP).toContain("default-src 'none'");
    expect(HTML_CODE_PREVIEW_CSP).toContain("frame-src 'none'");
    expect(HTML_CODE_PREVIEW_CSP).toContain("base-uri 'none'");
    expect(HTML_CODE_PREVIEW_CSP).toContain("form-action 'none'");
  });
});
