import { Mark } from "@tiptap/core";
import { BackgroundColor, Color, FontSize, TextStyle as BaseTextStyle } from "@tiptap/extension-text-style";
import type { JSONContent, MarkdownParseHelpers, MarkdownRendererHelpers, MarkdownToken } from "@tiptap/core";

export const EDGE_EVER_TEXT_STYLE_MARK_TYPE = "textStyle" as const;

/** Attributes the EdgeEver rich-text toolbar may set on the textStyle mark. */
export type EdgeEverTextStyleAttrs = {
  color: string | null;
  backgroundColor: string | null;
  fontSize: string | null;
};

/** Style declarations written into the markdown `style` attribute. */
export const textStyleAttrsToStyle = (attrs: Partial<EdgeEverTextStyleAttrs>): string => {
  const declarations: string[] = [];
  if (attrs.color) declarations.push(`color: ${attrs.color}`);
  if (attrs.backgroundColor) declarations.push(`background-color: ${attrs.backgroundColor}`);
  if (attrs.fontSize) declarations.push(`font-size: ${attrs.fontSize}`);
  return declarations.join("; ");
};

/** Parse a `style` attribute value back into textStyle attrs (null when absent). */
export const styleToTextStyleAttrs = (style: string | null | undefined): EdgeEverTextStyleAttrs => {
  const result: EdgeEverTextStyleAttrs = { color: null, backgroundColor: null, fontSize: null };
  if (!style) return result;

  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!value) continue;
    if (property === "color") {
      result.color = value;
    } else if (property === "background-color" || property === "background") {
      result.backgroundColor = value;
    } else if (property === "font-size") {
      result.fontSize = value;
    }
  }
  return result;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Serialize a textStyle mark as an inline `<span style="...">` HTML segment.
 * Recognized inline HTML round-trips through the markdown pipeline verbatim,
 * so colors, backgrounds and sizes survive markdown copies.
 */
const renderTextStyleMarkdown = (
  attrs: Partial<EdgeEverTextStyleAttrs> | undefined,
  content: JSONContent[] | undefined,
  helpers: MarkdownRendererHelpers,
) => {
  const inner = helpers.renderChildren(content ?? []);
  const style = textStyleAttrsToStyle(attrs ?? {});
  if (!style) return inner;
  return `<span style="${escapeHtml(style)}">${inner}</span>`;
};

const SPAN_STYLE_PATTERN = /^<span\b[^>]*\bstyle=["']([^"']*)["'][^>]*>([\s\S]*)<\/span>$/i;

const parseSpanStyleFromToken = (token: MarkdownToken): string | null => {
  if (typeof token.attrs?.style === "string") return token.attrs.style;
  const raw = typeof token.raw === "string" ? token.raw : "";
  const match = SPAN_STYLE_PATTERN.exec(raw.trim());
  return match ? match[1] : null;
};

/**
 * The EdgeEver text-style mark: the stock TextStyle mark plus Color,
 * BackgroundColor and FontSize global attributes, with markdown round-trip
 * via inline span styles.
 */
export const EdgeEverTextStyle = BaseTextStyle.extend({
  renderMarkdown(node, helpers) {
    return renderTextStyleMarkdown(
      node.attrs as Partial<EdgeEverTextStyleAttrs> | undefined,
      node.content,
      helpers,
    );
  },

  parseMarkdown(token, helpers) {
    const parse = helpers as MarkdownParseHelpers;
    const content = parse.parseInline(token.tokens ?? []);
    const attrs = styleToTextStyleAttrs(parseSpanStyleFromToken(token));
    return parse.applyMark(EDGE_EVER_TEXT_STYLE_MARK_TYPE, content, {
      color: attrs.color,
      backgroundColor: attrs.backgroundColor,
      fontSize: attrs.fontSize,
    });
  },
});

export const EdgeEverTextColor = Color;
export const EdgeEverTextBackgroundColor = BackgroundColor;
export const EdgeEverTextFontSize = FontSize;
