import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_SHORTCUT_SETTINGS, getShortcutActionForEvent } from "../lib/app-helpers";

const editorSource = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
const helperSource = readFileSync(new URL("../lib/app-helpers.ts", import.meta.url), "utf8");

describe("editor save controls", () => {
  test("autosaves without a persistent toolbar save button", () => {
    expect(editorSource).toContain("EDITOR_LOCAL_SAVE_DELAY_MS");
    expect(editorSource).toContain("const timer = window.setTimeout(() => {");
    expect(editorSource).toContain("mutateSave();");
    expect(editorSource).not.toContain('<Save className="h-4 w-4" />');
    expect(editorSource).not.toContain('aria-label={t("editor.save")}');
  });

  test("keeps Ctrl or Command S as the explicit save and sync action", () => {
    expect(helperSource).toContain('saveAndSync: { key: "s", ctrlOrMeta: true');
    expect(workspaceSource).toContain('action !== "saveAndSync"');
    expect(workspaceSource).toContain('window.addEventListener("keydown", handleSaveShortcutCapture, true)');
    expect(workspaceSource).toContain("setNoteSaveAndSyncToken((value) => value + 1)");
    expect(editorSource).toContain("saveAndSyncEditor({");
  });

  test("recognizes save modifiers without consuming ordinary typing", () => {
    const event = (options = {}) => ({ key: "s", code: "KeyS", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...options });
    expect(getShortcutActionForEvent(event(), DEFAULT_SHORTCUT_SETTINGS)).toBe("saveAndSync");
    expect(getShortcutActionForEvent(event({ ctrlKey: false, metaKey: true }), DEFAULT_SHORTCUT_SETTINGS)).toBe("saveAndSync");
    expect(getShortcutActionForEvent(event({ ctrlKey: false }), DEFAULT_SHORTCUT_SETTINGS)).toBeNull();
    const rebound = { ...DEFAULT_SHORTCUT_SETTINGS, saveAndSync: { key: "s", ctrlOrMeta: true, shift: true, alt: false } };
    expect(getShortcutActionForEvent(event(), rebound)).toBeNull();
    expect(getShortcutActionForEvent(event({ shiftKey: true }), rebound)).toBe("saveAndSync");
  });
});
