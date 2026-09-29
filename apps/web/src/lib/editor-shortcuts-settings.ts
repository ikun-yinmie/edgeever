import {
  DEFAULT_EDITOR_SHORTCUT_SETTINGS,
  EDITOR_SHORTCUT_IDS,
  normalizeEditorShortcutSettings,
  type EditorShortcutId,
  type EditorShortcutSettings,
} from "@edgeever/shared";

const CUSTOM_STORAGE_KEY = "edgeever.editorShortcutSettings";
const INSTANCE_DEFAULT_KEY = "edgeever.instanceEditorShortcuts";

const readJson = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
};

/** Admin-configured instance defaults, cached locally after login/settings load. */
export const readInstanceEditorShortcutDefaults = (): EditorShortcutSettings | null => {
  const raw = readJson(INSTANCE_DEFAULT_KEY);
  return raw ? normalizeEditorShortcutSettings(raw) : null;
};

export const writeInstanceEditorShortcutDefaults = (value: EditorShortcutSettings | null) => {
  if (!value) {
    try {
      window.localStorage.removeItem(INSTANCE_DEFAULT_KEY);
    } catch {
      // ignore
    }
    return;
  }
  writeJson(INSTANCE_DEFAULT_KEY, value);
};

/** User-customized editor shortcuts; null entries mean "follow the instance default". */
export const readEditorShortcutCustomizations = (): Partial<EditorShortcutSettings> | null => {
  const raw = readJson(CUSTOM_STORAGE_KEY);
  if (!raw || typeof raw !== "object") return null;
  const result: Partial<EditorShortcutSettings> = {};
  const input = raw as Record<string, unknown>;
  for (const id of EDITOR_SHORTCUT_IDS) {
    const binding = input[id];
    if (
      binding
      && typeof binding === "object"
      && typeof (binding as { key?: unknown }).key === "string"
    ) {
      result[id] = normalizeEditorShortcutSettings({ [id]: binding })[id];
    }
  }
  return Object.keys(result).length ? result : null;
};

export const writeEditorShortcutCustomizations = (custom: Partial<EditorShortcutSettings> | null) => {
  if (!custom || Object.keys(custom).length === 0) {
    try {
      window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
    } catch {
      // ignore
    }
    return;
  }
  writeJson(CUSTOM_STORAGE_KEY, custom);
};

/**
 * Effective settings: user customization wins, then the instance default the
 * admin configured, then the built-in Yuque-style defaults.
 */
export const resolveEditorShortcutSettings = (): EditorShortcutSettings => {
  const effective = normalizeEditorShortcutSettings({
    ...DEFAULT_EDITOR_SHORTCUT_SETTINGS,
    ...(readInstanceEditorShortcutDefaults() ?? {}),
    ...(readEditorShortcutCustomizations() ?? {}),
  });
  return effective;
};

/** Instance defaults as they should be shown in the admin UI (builtin fallback). */
export const resolveAdminEditorShortcutDefaults = (): EditorShortcutSettings =>
  readInstanceEditorShortcutDefaults() ?? DEFAULT_EDITOR_SHORTCUT_SETTINGS;

export const resetEditorShortcutCustomizations = () => {
  try {
    window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export type { EditorShortcutId, EditorShortcutSettings };
