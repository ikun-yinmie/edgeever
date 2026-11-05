import { Marked, Renderer } from "marked";

const MARKDOWN_LANGUAGE_ALIASES = new Set(["markdown", "md", "mdown", "mkdn"]);
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
const IMAGE_SCHEMES = new Set(["http:", "https:"]);

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case "\"":
      return "&quot;";
    default:
      return "&#39;";
  }
});

/** Use the browser's URL parsing rules, including control-character handling. */
const safeUrl = (value: string, allowedSchemes: Set<string>) => {
  if (!value.trim()) return null;
  try {
    const url = new URL(value, "https://markdown-preview.invalid/");
    return allowedSchemes.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
};

// Do not share global Marked extensions with other consumers of the parser.
const markdown = new Marked();

export const isMarkdownCodeLanguage = (language: unknown) => typeof language === "string"
  && MARKDOWN_LANGUAGE_ALIASES.has(language.trim().toLowerCase());

/**
 * Renders a deliberately restricted Markdown subset for an in-editor preview.
 * Marked escapes normal text and code. These overrides additionally render raw
 * HTML as text and apply a protocol allowlist to the only URL-bearing elements.
 */
export const renderMarkdownCodePreview = (source: string) => {
  const renderer = new Renderer();

  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = ({ href, tokens }) => {
    const label = renderer.parser.parseInline(tokens);
    const safeHref = safeUrl(href, LINK_SCHEMES);
    if (!safeHref) return label;

    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  };
  renderer.image = ({ href, text }) => {
    const safeHref = safeUrl(href, IMAGE_SCHEMES);
    if (!safeHref) return escapeHtml(text);

    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}" loading="lazy" referrerpolicy="no-referrer">`;
  };

  return markdown.parse(source, {
    async: false,
    breaks: false,
    gfm: true,
    renderer,
  }) as string;
};
