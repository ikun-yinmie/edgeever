import { isMarkdownCodeLanguage } from "./markdown-code-preview";

export const getCodeBlockPreviewLanguage = (language: unknown): "markdown" | "html" | null => {
  if (isMarkdownCodeLanguage(language)) return "markdown";
  if (typeof language === "string" && /^(html|htm)$/i.test(language.trim())) return "html";
  return null;
};

// The iframe also has an empty sandbox: no scripts, same-origin access, forms,
// popups or top-level navigation. CSP blocks nested frames and active resources
// while retaining inline CSS and images for a static HTML preview.
export const HTML_CODE_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "font-src data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Only use as a sandboxed iframe's srcDoc, never as the parent document's HTML. */
export const buildHtmlCodePreviewDocument = (source: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HTML_CODE_PREVIEW_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  body { margin: 16px; color: #1e293b; background: #fff; font: 14px/1.6 system-ui, sans-serif; overflow-wrap: break-word; }
  img, video { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; }
</style>
</head>
<body>${source}</body>
</html>`;
