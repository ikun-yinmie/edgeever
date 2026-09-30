import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { keymap } from "@tiptap/pm/keymap";
import { createEdgeEverCodeBlock } from "./code-block-meta.ts";
import {
  DEFAULT_EDITOR_SHORTCUT_SETTINGS,
  EDITOR_SHORTCUT_IDS,
  createEditorShortcutExtension,
  editorShortcutBindingFromEvent,
  editorShortcutBindingToKeymapName,
  editorShortcutBindingsEqual,
  normalizeEditorShortcutSettings,
} from "./editor-shortcut-keys.ts";

const KEYMAP_MODIFIERS = new Set(["Mod", "Alt", "Shift", "Ctrl"]);

const isValidKeymapName = (name) => {
  const parts = name.split("-");
  if (parts.length < 2) return false;
  return parts.slice(0, -1).every((part) => KEYMAP_MODIFIERS.has(part));
};

describe("editor shortcut keys", () => {
  test("provides a Yuque-style default for every action", () => {
    expect(EDITOR_SHORTCUT_IDS.length).toBe(19);
    expect(DEFAULT_EDITOR_SHORTCUT_SETTINGS["heading-1"]).toEqual({ key: "1", ctrlOrMeta: true, shift: false, alt: true });
    expect(DEFAULT_EDITOR_SHORTCUT_SETTINGS.paragraph).toEqual({ key: "0", ctrlOrMeta: true, shift: false, alt: true });
    expect(DEFAULT_EDITOR_SHORTCUT_SETTINGS.bulletList).toEqual({ key: "8", ctrlOrMeta: true, shift: true, alt: false });
    expect(DEFAULT_EDITOR_SHORTCUT_SETTINGS.orderedList).toEqual({ key: "7", ctrlOrMeta: true, shift: true, alt: false });
    expect(DEFAULT_EDITOR_SHORTCUT_SETTINGS.clearFormatting).toEqual({ key: "\\", ctrlOrMeta: true, shift: false, alt: false });
  });

  test("every default binding includes a modifier and stays unique", () => {
    const serialized = EDITOR_SHORTCUT_IDS.map((id) => JSON.stringify(DEFAULT_EDITOR_SHORTCUT_SETTINGS[id]));
    expect(new Set(serialized).size).toBe(EDITOR_SHORTCUT_IDS.length);
    for (const id of EDITOR_SHORTCUT_IDS) {
      const binding = DEFAULT_EDITOR_SHORTCUT_SETTINGS[id];
      expect(binding.ctrlOrMeta || binding.alt).toBe(true);
    }
  });

  test("parses keyboard events into comparable bindings", () => {
    const event = { key: "1", ctrlKey: true, metaKey: false, shiftKey: false, altKey: true };
    const binding = editorShortcutBindingFromEvent(event);
    expect(binding).toEqual({ key: "1", ctrlOrMeta: true, shift: false, alt: true });
    expect(editorShortcutBindingsEqual(binding, DEFAULT_EDITOR_SHORTCUT_SETTINGS["heading-1"])).toBe(true);
  });

  test("ignores bare modifier presses and bindings without modifiers", () => {
    expect(editorShortcutBindingFromEvent({ key: "Alt", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true })).toBeNull();
    expect(editorShortcutBindingFromEvent({ key: "a", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBeNull();
  });

  test("normalizes stored settings over the defaults and rejects malformed rows", () => {
    const normalized = normalizeEditorShortcutSettings({
      "heading-1": { key: "7", ctrlOrMeta: true, shift: false, alt: true },
      bold: { key: "q", ctrlOrMeta: true },
      italic: "bogus",
    });
    expect(normalized["heading-1"]).toEqual({ key: "7", ctrlOrMeta: true, shift: false, alt: true });
    expect(normalized.bold).toEqual(DEFAULT_EDITOR_SHORTCUT_SETTINGS.bold);
    expect(normalized.italic).toEqual(DEFAULT_EDITOR_SHORTCUT_SETTINGS.italic);
    expect(normalizeEditorShortcutSettings(null)).toEqual(DEFAULT_EDITOR_SHORTCUT_SETTINGS);
  });

  test("maps bindings to modifier-only prosemirror keymap names", () => {
    expect(editorShortcutBindingToKeymapName(DEFAULT_EDITOR_SHORTCUT_SETTINGS["heading-1"])).toBe("Mod-Alt-1");
    expect(editorShortcutBindingToKeymapName(DEFAULT_EDITOR_SHORTCUT_SETTINGS.paragraph)).toBe("Mod-Alt-0");
    expect(editorShortcutBindingToKeymapName(DEFAULT_EDITOR_SHORTCUT_SETTINGS.bold)).toBe("Mod-b");
    expect(editorShortcutBindingToKeymapName(DEFAULT_EDITOR_SHORTCUT_SETTINGS.bulletList)).toBe("Mod-Shift-8");
    expect(editorShortcutBindingToKeymapName(DEFAULT_EDITOR_SHORTCUT_SETTINGS.clearFormatting)).toBe("Mod-\\");
    expect(editorShortcutBindingToKeymapName({ key: "space", ctrlOrMeta: true, shift: false, alt: false })).toBe("Mod-Space");
    expect(editorShortcutBindingToKeymapName({ key: "", ctrlOrMeta: true, shift: false, alt: false })).toBeNull();
  });

  test("every default binding yields a unique keymap name prosemirror-keymap accepts", () => {
    const names = EDITOR_SHORTCUT_IDS.map((id) => editorShortcutBindingToKeymapName(DEFAULT_EDITOR_SHORTCUT_SETTINGS[id]));
    expect(names.every((name) => typeof name === "string" && isValidKeymapName(name))).toBe(true);
    expect(new Set(names).size).toBe(EDITOR_SHORTCUT_IDS.length);

    // prosemirror-keymap rejects names whose segments are not recognized
    // modifiers ("heading-1" once crashed every editor mount); the generated
    // names must all be accepted at plugin construction.
    expect(() => keymap({ "heading-1": () => false })).toThrow("Unrecognized modifier name");
    expect(() => keymap(Object.fromEntries(names.map((name) => [name, () => false])))).not.toThrow();
  });

  test("mounts an editor with the shortcut extension without crashing", () => {
    // Regression: the extension used to register action ids ("heading-1") as
    // keymap names, so every editor mount threw
    // "Unrecognized modifier name: heading" and notes could not be opened.
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        createEdgeEverCodeBlock(),
        createEditorShortcutExtension(() => DEFAULT_EDITOR_SHORTCUT_SETTINGS),
      ],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
          {
            type: "codeBlock",
            attrs: { language: "yaml", meta: { collapsed: false } },
            content: [{ type: "text", text: "a: b" }],
          },
        ],
      },
    });

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).attrs.meta).toMatchObject({ collapsed: false });
    editor.destroy();
  });
});
