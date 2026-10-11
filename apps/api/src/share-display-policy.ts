// Display policy — the single front controlling what a share audience sees.
//
// One policy shape, two consumers: public link shares (memo_shares) and group
// shares (group_shares). The policy decides how HTML and Markdown code blocks
// reach the reader:
//
//   "rendered" -> transcribed and shown as rich content (default, as before)
//   "source"   -> shown as raw source text (no translation to markup)
//   "hidden"   -> replaced by a "not shared by the author" placeholder
//
// The filter runs server-side over the TipTap document before any share
// payload leaves the API, so the audience-visible result is authoritative —
// not a client-side decoration. Personal (authenticated owner) reads are never
// filtered: the author always sees their own note in full.

import type { TiptapDoc } from "@edgeever/shared";

export type ShareDisplayMode = "rendered" | "source" | "hidden";

export type ShareDisplayPolicy = {
  html: ShareDisplayMode;
  markdown: ShareDisplayMode;
};

export const DEFAULT_SHARE_DISPLAY_POLICY: ShareDisplayPolicy = {
  html: "rendered",
  markdown: "rendered",
};

const DISPLAY_MODES: ShareDisplayMode[] = ["rendered", "source", "hidden"];

export const parseShareDisplayPolicy = (raw: string | null | undefined): ShareDisplayPolicy => {
  if (!raw) return DEFAULT_SHARE_DISPLAY_POLICY;
  try {
    const parsed = JSON.parse(raw) as Partial<ShareDisplayPolicy> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_SHARE_DISPLAY_POLICY;
    return {
      html: DISPLAY_MODES.includes(parsed.html as ShareDisplayMode)
        ? (parsed.html as ShareDisplayMode)
        : DEFAULT_SHARE_DISPLAY_POLICY.html,
      markdown: DISPLAY_MODES.includes(parsed.markdown as ShareDisplayMode)
        ? (parsed.markdown as ShareDisplayMode)
        : DEFAULT_SHARE_DISPLAY_POLICY.markdown,
    };
  } catch {
    return DEFAULT_SHARE_DISPLAY_POLICY;
  }
};

const SOURCE_LANGUAGES = new Set(["html", "markdown", "md", "mdx", "htm", "xhtml", "xml", "svg"]);

export const isDisplaySourceLanguage = (language: string | null | undefined) =>
  Boolean(language) && SOURCE_LANGUAGES.has((language ?? "").trim().toLowerCase());

type DisplayNode = {
  type: string;
  attrs?: Record<string, unknown> | null;
  content?: DisplayNode[] | null;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> | null }> | null;
  text?: string;
};

const placeholderNode = (mode: ShareDisplayMode, language: string): DisplayNode => ({
  type: "codeBlock",
  attrs: { language: language || "plaintext" },
  content: [
    {
      type: "text",
      text:
        mode === "hidden"
          ? "[此内容块已被作者设置为不公开 / This block was not shared by the author]"
          : `[${language || "source"} 源码已按作者设置以源码方式展示 / shown as source by the author]`,
    },
  ],
});

const applyDisplayMode = (node: DisplayNode, mode: ShareDisplayMode, language: string): DisplayNode => {
  if (mode === "rendered") return node;
  // "source" keeps the block but swaps it to a plain fenced block so the
  // viewer's editor renders it as literal source instead of translating it.
  // "hidden" replaces the content with a placeholder notice.
  return placeholderNode(mode, mode === "source" ? "plaintext" : language);
};

const isDisplayBlock = (node: DisplayNode) =>
  node.type === "codeBlock" && isDisplaySourceLanguage(typeof node.attrs?.language === "string" ? node.attrs.language : null);

/**
 * Deep-transform the document: every html/markdown code block is rewritten
 * according to the policy, wherever it nests (tables, quotes, list items).
 * Returns the original object when nothing changed, so callers can skip writes.
 */
export const applyShareDisplayPolicyToDoc = (
  doc: TiptapDoc | DisplayNode,
  policy: ShareDisplayPolicy,
): TiptapDoc | DisplayNode => {
  const walk = (node: DisplayNode): DisplayNode => {
    const children = Array.isArray(node.content) ? node.content : null;
    if (isDisplayBlock(node)) {
      const language = String(node.attrs?.language ?? "").toLowerCase();
      const mode = language === "html" || language === "htm" || language === "xhtml" || language === "xml" || language === "svg"
        ? policy.html
        : policy.markdown;
      const next = applyDisplayMode(node, mode, language);
      if (next !== node) return next;
    }
    if (!children) return node;
    let changed = false;
    const mapped = children.map((child) => {
      const walked = walk(child);
      if (walked !== child) changed = true;
      return walked;
    });
    return changed ? { ...node, content: mapped } : node;
  };
  return walk(doc as DisplayNode) as TiptapDoc | DisplayNode;
};

/** True when the policy would change nothing (the common default case). */
export const isDefaultShareDisplayPolicy = (policy: ShareDisplayPolicy) =>
  policy.html === DEFAULT_SHARE_DISPLAY_POLICY.html && policy.markdown === DEFAULT_SHARE_DISPLAY_POLICY.markdown;
