import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

/**
 * Editor formatting shortcuts (Yuque-style), separate from the app-level
 * ShortcutSettings so each concern keeps its own namespace. Bindings reuse
 * the same { key, ctrlOrMeta, shift, alt } shape as app shortcuts.
 */

export type EditorShortcutId =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "paragraph"
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "horizontalRule"
  | "clearFormatting";

export type EditorShortcutBinding = {
  key: string;
  ctrlOrMeta: boolean;
  shift: boolean;
  alt: boolean;
};

export type EditorShortcutSettings = Record<EditorShortcutId, EditorShortcutBinding>;

/** Yuque-style defaults; headings use Alt+Ctrl+N, zero turns text into body. */
export const DEFAULT_EDITOR_SHORTCUT_SETTINGS: EditorShortcutSettings = {
  "heading-1": { key: "1", ctrlOrMeta: true, shift: false, alt: true },
  "heading-2": { key: "2", ctrlOrMeta: true, shift: false, alt: true },
  "heading-3": { key: "3", ctrlOrMeta: true, shift: false, alt: true },
  "heading-4": { key: "4", ctrlOrMeta: true, shift: false, alt: true },
  "heading-5": { key: "5", ctrlOrMeta: true, shift: false, alt: true },
  "heading-6": { key: "6", ctrlOrMeta: true, shift: false, alt: true },
  paragraph: { key: "0", ctrlOrMeta: true, shift: false, alt: true },
  bold: { key: "b", ctrlOrMeta: true, shift: false, alt: false },
  italic: { key: "i", ctrlOrMeta: true, shift: false, alt: false },
  underline: { key: "u", ctrlOrMeta: true, shift: false, alt: false },
  strikethrough: { key: "x", ctrlOrMeta: true, shift: true, alt: false },
  code: { key: "e", ctrlOrMeta: true, shift: false, alt: false },
  bulletList: { key: "8", ctrlOrMeta: true, shift: true, alt: false },
  orderedList: { key: "7", ctrlOrMeta: true, shift: true, alt: false },
  taskList: { key: "t", ctrlOrMeta: true, shift: false, alt: true },
  blockquote: { key: "u", ctrlOrMeta: true, shift: true, alt: false },
  codeBlock: { key: "c", ctrlOrMeta: true, shift: true, alt: false },
  horizontalRule: { key: "s", ctrlOrMeta: true, shift: false, alt: true },
  clearFormatting: { key: "\\", ctrlOrMeta: true, shift: false, alt: false },
};

export const EDITOR_SHORTCUT_IDS = Object.keys(DEFAULT_EDITOR_SHORTCUT_SETTINGS) as EditorShortcutId[];

const normalizeKey = (key: string) => key.toLowerCase();

/** Turn a browser keyboard event into a comparable binding. */
export const editorShortcutBindingFromEvent = (event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): EditorShortcutBinding | null => {
  const key = normalizeKey(event.key);
  if (!key || ["control", "meta", "shift", "alt", "altgraph"].includes(key)) {
    return null;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    return null;
  }
  return {
    key,
    ctrlOrMeta: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
};

export const editorShortcutBindingsEqual = (a: EditorShortcutBinding, b: EditorShortcutBinding) =>
  a.key === b.key && a.ctrlOrMeta === b.ctrlOrMeta && a.shift === b.shift && a.alt === b.alt;

export const normalizeEditorShortcutSettings = (value: unknown): EditorShortcutSettings => {
  if (!value || typeof value !== "object") return DEFAULT_EDITOR_SHORTCUT_SETTINGS;
  const input = value as Partial<Record<EditorShortcutId, Partial<EditorShortcutBinding>>>;
  const merged = { ...DEFAULT_EDITOR_SHORTCUT_SETTINGS };
  for (const id of EDITOR_SHORTCUT_IDS) {
    const binding = input[id];
    if (
      binding
      && typeof binding.key === "string"
      && binding.key.trim()
      && typeof binding.ctrlOrMeta === "boolean"
      && typeof binding.shift === "boolean"
      && typeof binding.alt === "boolean"
    ) {
      merged[id] = { key: normalizeKey(binding.key), ctrlOrMeta: binding.ctrlOrMeta, shift: binding.shift, alt: binding.alt };
    }
  }
  return merged;
};

export const serializeEditorShortcutSettings = (settings: EditorShortcutSettings) =>
  JSON.stringify(settings);

const runEditorShortcut = (editor: Editor, id: EditorShortcutId): boolean => {
  const chain = editor.chain().focus();
  switch (id) {
    case "heading-1": return chain.setHeading({ level: 1 }).run();
    case "heading-2": return chain.setHeading({ level: 2 }).run();
    case "heading-3": return chain.setHeading({ level: 3 }).run();
    case "heading-4": return chain.setHeading({ level: 4 }).run();
    case "heading-5": return chain.setHeading({ level: 5 }).run();
    case "heading-6": return chain.setHeading({ level: 6 }).run();
    case "paragraph": return chain.setParagraph().run();
    case "bold": return chain.toggleBold().run();
    case "italic": return chain.toggleItalic().run();
    case "underline": return chain.toggleUnderline().run();
    case "strikethrough": return chain.toggleStrike().run();
    case "code": return chain.toggleCode().run();
    case "bulletList": return chain.toggleBulletList().run();
    case "orderedList": return chain.toggleOrderedList().run();
    case "taskList": return chain.toggleTaskList().run();
    case "blockquote": return chain.toggleBlockquote().run();
    case "codeBlock": return chain.setCodeBlock().run();
    case "horizontalRule": return chain.setHorizontalRule().run();
    case "clearFormatting": return chain.unsetAllMarks().clearNodes().run();
    default: return false;
  }
};

/**
 * TipTap extension wired to the (possibly customized) editor shortcut settings.
 * Handlers keep the stock extension behaviour when the custom binding fails.
 */
export const createEditorShortcutExtension = (getSettings: () => EditorShortcutSettings) =>
  Extension.create({
    name: "edgeeverEditorShortcuts",
    priority: 1000,
    addKeyboardShortcuts() {
      const bindings: Record<string, () => boolean> = {};
      for (const id of EDITOR_SHORTCUT_IDS) {
        bindings[id] = () => {
          const settings = getSettings();
          const binding = settings[id];
          if (!binding) return false;
          const event = this.editor.view.dom.ownerDocument.defaultView?.event as KeyboardEvent | null;
          if (!event) return false;
          const actual = editorShortcutBindingFromEvent(event);
          if (!actual || !editorShortcutBindingsEqual(actual, binding)) {
            return false;
          }
          return runEditorShortcut(this.editor, id);
        };
      }
      return bindings;
    },
  });

/** human-readable label, e.g. "Alt+Ctrl+1" (⌥⌘1 on mac handled by formatShortcutBinding). */
export const EDITOR_SHORTCUT_ACTION_LABELS: Record<EditorShortcutId, string> = {
  "heading-1": "heading1",
  "heading-2": "heading2",
  "heading-3": "heading3",
  "heading-4": "heading4",
  "heading-5": "heading5",
  "heading-6": "heading6",
  paragraph: "paragraph",
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strikethrough",
  code: "inlineCode",
  bulletList: "bulletList",
  orderedList: "orderedList",
  taskList: "taskList",
  blockquote: "quote",
  codeBlock: "codeBlock",
  horizontalRule: "horizontalRule",
  clearFormatting: "clearFormatting",
};
