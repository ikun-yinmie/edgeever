import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EDITOR_SHORTCUT_SETTINGS,
  EDITOR_SHORTCUT_IDS,
  editorShortcutBindingFromEvent,
  editorShortcutBindingsEqual,
  normalizeEditorShortcutSettings,
} from "./editor-shortcut-keys.ts";

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
});
