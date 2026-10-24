import { Extension } from "@tiptap/core";

const LINE_HEIGHTS = ["1", "1.15", "1.5", "1.75", "2", "2.5", "3"] as const;

export type ParagraphFormatAttrs = {
  lineHeight: string | null;
  indentLeft: number;
  indentRight: number;
  firstLineIndent: number;
  headingNumbering: "decimal" | "chinese" | "circled" | null;
};

const normalizeLineHeight = (value: unknown) => {
  if (typeof value !== "string" || !LINE_HEIGHTS.includes(value as typeof LINE_HEIGHTS[number])) return null;
  return value;
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
          renderHTML: (attributes: Record<string, any>) => attributes.lineHeight
            ? { "data-line-height": attributes.lineHeight }
            : {},
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
