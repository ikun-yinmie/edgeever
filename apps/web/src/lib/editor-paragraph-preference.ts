export const EDITOR_DEFAULT_LINE_HEIGHT = "1.6";
export const EDITOR_PARAGRAPH_LINE_HEIGHT_CHANGED = "edgeever:paragraph-line-height-changed";
const KEY = "edgeever.editor.paragraph-line-height";

export const readEditorParagraphLineHeight = () => {
  if (typeof window === "undefined") return EDITOR_DEFAULT_LINE_HEIGHT;
  const value = window.localStorage.getItem(KEY);
  return value && ["1", "1.15", "1.5", "1.6", "1.75", "2", "2.5", "3"].includes(value)
    ? value
    : EDITOR_DEFAULT_LINE_HEIGHT;
};

export const writeEditorParagraphLineHeight = (value: string) => {
  window.localStorage.setItem(KEY, value);
  window.dispatchEvent(new CustomEvent(EDITOR_PARAGRAPH_LINE_HEIGHT_CHANGED, { detail: value }));
};
