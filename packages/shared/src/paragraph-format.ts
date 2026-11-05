import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";

const LINE_HEIGHTS = ["1", "1.15", "1.5", "1.75", "2", "2.5", "3"] as const;
export const LINE_SPACING_MIN = -12;
export const LINE_SPACING_MAX = 32;

export type ParagraphFormatAttrs = {
  lineHeight: string | null;
  lineSpacing: number | null;
  indentLeft: number;
  indentRight: number;
  firstLineIndent: number;
  headingNumbering: "decimal" | "chinese" | "circled" | null;
};

const normalizeLineHeight = (value: unknown) => {
  if (typeof value !== "string" || !LINE_HEIGHTS.includes(value as typeof LINE_HEIGHTS[number])) return null;
  return value;
};

export const normalizeLineSpacing = (value: unknown): number | null => {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(LINE_SPACING_MIN, Math.min(LINE_SPACING_MAX, Math.round(number))) : null;
};

export const updateParagraphLineSpacing = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  attrs: Partial<Pick<ParagraphFormatAttrs, "lineHeight" | "lineSpacing">>,
  range = state.selection.empty ? { from: 0, to: state.doc.content.size } : state.selection,
): boolean => {
  const attributes = {
    ...(attrs.lineHeight !== undefined ? { lineHeight: normalizeLineHeight(attrs.lineHeight) } : {}),
    ...(attrs.lineSpacing !== undefined ? { lineSpacing: normalizeLineSpacing(attrs.lineSpacing) } : {}),
  };
  const transaction = state.tr;
  state.doc.nodesBetween(range.from, range.to, (node, position) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
    if (Object.entries(attributes).some(([key, value]) => node.attrs[key] !== value)) {
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, ...attributes });
    }
  });
  if (!transaction.docChanged) return false;
  dispatch?.(transaction);
  return true;
};

const renderLineHeight = (attributes: Record<string, unknown>) => {
  const height = normalizeLineHeight(attributes.lineHeight);
  const spacing = normalizeLineSpacing(attributes.lineSpacing);
  if (height === null && spacing === null) return {};
  const base = height ?? "var(--editor-body-line-height, 1.6)";
  return {
    ...(height !== null ? { "data-line-height": height } : {}),
    // CSS forbids negative line-height; signed spacing adjusts the baseline instead.
    style: spacing === null || spacing === 0
      ? `line-height: ${base} !important`
      : `line-height: max(0.5em, calc(${base} * 1em + ${spacing}px)) !important`,
  };
};

const normalizeIndent = (value: unknown) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(8, Math.round(number))) : 0;
};

/** Block-level typography shared by the rich editor and rendered documents. */
export const ParagraphFormat = Extension.create({
  name: "paragraphFormat",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading", "blockquote", "listItem", "taskItem"],
      attributes: {
        headingNumbering: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const value = element.dataset.headingNumbering;
            return value === "decimal" || value === "chinese" || value === "circled" ? value : null;
          },
          renderHTML: (attributes: Record<string, any>) => attributes.headingNumbering
            ? { "data-heading-numbering": attributes.headingNumbering }
            : {},
        },
        lineHeight: {
          default: null,
          parseHTML: (element: HTMLElement) => normalizeLineHeight(element.dataset.lineHeight),
          renderHTML: renderLineHeight,
        },
        lineSpacing: {
          default: null,
          parseHTML: (element: HTMLElement) => normalizeLineSpacing(element.dataset.lineSpacing),
          renderHTML: (attributes: Record<string, unknown>) => {
            const spacing = normalizeLineSpacing(attributes.lineSpacing);
            return spacing !== null ? { "data-line-spacing": String(spacing) } : {};
          },
        },
        indentLeft: {
          default: 0,
          parseHTML: (element: HTMLElement) => normalizeIndent(element.dataset.indentLeft),
          renderHTML: (attributes: Record<string, any>) => attributes.indentLeft
            ? { "data-indent-left": String(attributes.indentLeft) }
            : {},
        },
        indentRight: {
          default: 0,
          parseHTML: (element: HTMLElement) => normalizeIndent(element.dataset.indentRight),
          renderHTML: (attributes: Record<string, any>) => attributes.indentRight
            ? { "data-indent-right": String(attributes.indentRight) }
            : {},
        },
        firstLineIndent: {
          default: 0,
          parseHTML: (element: HTMLElement) => normalizeIndent(element.dataset.firstLineIndent),
          renderHTML: (attributes: Record<string, any>) => attributes.firstLineIndent
            ? { "data-first-line-indent": String(attributes.firstLineIndent) }
            : {},
        },
      },
    }];
  },
});

export { LINE_HEIGHTS };
