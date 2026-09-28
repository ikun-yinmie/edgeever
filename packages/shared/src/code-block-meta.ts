import { Extension } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import type { JSONContent, MarkdownParseHelpers, MarkdownRendererHelpers, MarkdownToken } from "@tiptap/core";

/** TipTap node type for EdgeEver code blocks. */
export const EDGE_EVER_CODE_BLOCK_NODE_TYPE = "codeBlock" as const;

/** Info-string marker that carries code-block title / width / collapsed state. */
export const EDGE_EVER_CODE_META_MARKER = "edgeever-meta" as const;

/** Serialized shape of code-block metadata inside the fence info string. */
export type EdgeEverCodeMeta = {
  v: 1;
  title: string;
  width: "normal" | "wide";
  collapsed: boolean;
};

const EMPTY_META: EdgeEverCodeMeta = { v: 1, title: "", width: "normal", collapsed: false };

const clampMeta = (value: Partial<EdgeEverCodeMeta> | null | undefined): EdgeEverCodeMeta => ({
  v: 1,
  title: typeof value?.title === "string" ? value.title.slice(0, 300) : "",
  width: value?.width === "wide" ? "wide" : "normal",
  collapsed: value?.collapsed === true,
});

/** Escape a JSON payload so it can sit on one fence line (no backticks / newlines). */
export const encodeCodeMetaJson = (meta: EdgeEverCodeMeta): string =>
  JSON.stringify(meta).replace(/`/g, "\\u0060").replace(/\r/g, "\\u000d");

/** Undo {@link encodeCodeMetaJson}. Returns null when the payload is not valid meta JSON. */
export const decodeCodeMetaJson = (value: string): EdgeEverCodeMeta | null => {
  try {
    const parsed = JSON.parse(value.replace(/\\u0060/g, "`").replace(/\\u000d/gi, "\r")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    return clampMeta(record as Partial<EdgeEverCodeMeta>);
  } catch {
    return null;
  }
};

/** Split a fence info string into the language and the optional EdgeEver meta payload. */
export const parseCodeFenceInfo = (info: string | null | undefined): {
  language: string | null;
  meta: EdgeEverCodeMeta | null;
} => {
  const trimmed = (info ?? "").trim();
  if (!trimmed) return { language: null, meta: null };
  const separator = trimmed.search(/\s/);
  const language = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const rest = separator < 0 ? "" : trimmed.slice(separator + 1).trim();
  const metaMatch = /^edgeever-meta=(\{.*\})$/.exec(rest);
  if (!metaMatch) return { language, meta: null };
  return { language, meta: decodeCodeMetaJson(metaMatch[1]) };
};

/** Compose a fence info string, appending the EdgeEver meta payload only when needed. */
export const buildCodeFenceInfo = (
  language: string | null | undefined,
  meta: Partial<EdgeEverCodeMeta> | null | undefined,
): string => {
  const normalized = clampMeta(meta);
  const hasMeta = Boolean(normalized.title) || normalized.width === "wide" || normalized.collapsed;
  const lang = (language ?? "").trim();
  if (!hasMeta) return lang;
  return `${lang} ${EDGE_EVER_CODE_META_MARKER}=${encodeCodeMetaJson(normalized)}`.trim();
};

/** Extract the title / width / collapsed attrs from a TipTap codeBlock node. */
export const codeBlockMetaFromAttrs = (attrs: Record<string, unknown> | undefined): EdgeEverCodeMeta => {
  if (!attrs) return EMPTY_META;
  if (attrs.meta && typeof attrs.meta === "object") {
    return clampMeta(attrs.meta as Partial<EdgeEverCodeMeta>);
  }
  return clampMeta({
    title: typeof attrs.title === "string" ? attrs.title : "",
    width: attrs.width === "wide" ? "wide" : "normal",
    collapsed: attrs.collapsed === true,
  });
};

/**
 * The EdgeEver code block: stock lowlight code block plus a meta attribute
 * (title / width / collapsed) that round-trips through fenced markdown via an
 * `edgeever-meta={...}` chunk in the fence info string.
 */
export const createEdgeEverCodeBlock = () =>
  CodeBlock.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        meta: {
          default: null,
          parseHTML: (element) => {
            const raw = element.getAttribute("data-edgeever-code-meta");
            if (!raw) return null;
            return decodeCodeMetaJson(raw);
          },
          renderHTML: (attributes) => {
            const meta = codeBlockMetaFromAttrs(attributes);
            if (!meta.title && meta.width === "normal" && !meta.collapsed) return {};
            return { "data-edgeever-code-meta": encodeCodeMetaJson(meta) };
          },
        },
      };
    },

    renderMarkdown(node, helpers: MarkdownRendererHelpers) {
      const meta = codeBlockMetaFromAttrs(node.attrs as Record<string, unknown> | undefined);
      const language = (node.attrs as { language?: string | null } | undefined)?.language ?? "";
      const info = buildCodeFenceInfo(language, meta);
      const body = node.content
        ? helpers.renderChildren(node.content)
        : "";
      return `\`\`\`${info}\n${body}\n\`\`\``;
    },

    parseMarkdown(token, helpers: MarkdownParseHelpers) {
      const raw = typeof token.raw === "string" ? token.raw : "";
      if (!raw.startsWith("```") && !raw.startsWith("~~~") && token.codeBlockStyle === "indented") {
        return [];
      }
      const { language, meta } = parseCodeFenceInfo(token.lang);
      const content = token.text
        ? [helpers.createTextNode(token.text)]
        : [];
      return helpers.createNode(
        EDGE_EVER_CODE_BLOCK_NODE_TYPE,
        meta ? { language: language ?? null, meta } : { language: language ?? null },
        content,
      );
    },
  });
