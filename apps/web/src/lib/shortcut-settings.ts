import {
  DEFAULT_SHORTCUT_SETTINGS,
  LEGACY_READING_PROTECTION_SHORTCUT,
  SHORTCUT_ACTION_VALUES,
  SHORTCUT_SETTINGS_STORAGE_KEY,
  normalizeShortcutKey,
  shortcutBindingsEqual,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutSettings,
} from "@/lib/app-helpers";

/** Fired on window whenever personal overrides or instance defaults change. */
export const SHORTCUT_SETTINGS_CHANGED_EVENT = "edgeever:shortcut-settings-changed";

const INSTANCE_DEFAULT_KEY = "edgeever.instanceAppShortcuts";

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

const dispatchChanged = () => {
  try {
    window.dispatchEvent(new Event(SHORTCUT_SETTINGS_CHANGED_EVENT));
  } catch {
    // Event dispatch can be unavailable in exotic embedded contexts; ignore.
  }
};

const isValidBinding = (value: unknown): value is ShortcutBinding => {
  const binding = value as ShortcutBinding;
  return (
    Boolean(binding)
    && typeof binding.key === "string"
    && binding.key.trim().length > 0
    && typeof binding.ctrlOrMeta === "boolean"
    && typeof binding.shift === "boolean"
    && typeof binding.alt === "boolean"
  );
};

const toBinding = (value: unknown): ShortcutBinding | null => {
  if (!isValidBinding(value)) return null;
  return { ...value, key: normalizeShortcutKey(value.key) };
};

/** Admin-configured instance defaults for app shortcuts, cached locally. */
export const readInstanceAppShortcutDefaults = (): Partial<ShortcutSettings> | null => {
  const raw = readJson(INSTANCE_DEFAULT_KEY);
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const result: Partial<ShortcutSettings> = {};
  for (const action of SHORTCUT_ACTION_VALUES) {
    const binding = toBinding(input[action]);
    if (binding) result[action] = binding;
  }
  return Object.keys(result).length ? result : null;
};

export const writeInstanceAppShortcutDefaults = (value: Partial<ShortcutSettings> | null) => {
  if (!value) {
    try {
      window.localStorage.removeItem(INSTANCE_DEFAULT_KEY);
    } catch {
      // ignore
    }
    dispatchChanged();
    return;
  }
  const sanitized: Partial<ShortcutSettings> = {};
  for (const action of SHORTCUT_ACTION_VALUES) {
    const binding = toBinding(value[action]);
    if (binding) sanitized[action] = binding;
  }
  if (Object.keys(sanitized).length === 0) {
    try {
      window.localStorage.removeItem(INSTANCE_DEFAULT_KEY);
    } catch {
      // ignore
    }
    dispatchChanged();
    return;
  }
  writeJson(INSTANCE_DEFAULT_KEY, sanitized);
  dispatchChanged();
};

/**
 * Personal app-shortcut overrides. Historically this key held a full settings
 * snapshot, so entries that match the built-in default are dropped on read to
 * keep the "customized" badge meaningful.
 */
export const readShortcutSettingsCustomizations = (): Partial<ShortcutSettings> => {
  const raw = readJson(SHORTCUT_SETTINGS_STORAGE_KEY);
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const result: Partial<ShortcutSettings> = {};
  for (const action of SHORTCUT_ACTION_VALUES) {
    const binding = toBinding(input[action]);
    if (!binding) continue;
    if (action === "toggleReadingProtection" && shortcutBindingsEqual(binding, LEGACY_READING_PROTECTION_SHORTCUT)) {
      continue;
    }
    if (shortcutBindingsEqual(binding, DEFAULT_SHORTCUT_SETTINGS[action])) continue;
    result[action] = binding;
  }
  return result;
};

export const writeShortcutSettingsCustomizations = (overrides: Partial<ShortcutSettings> | null) => {
  if (!overrides || Object.keys(overrides).length === 0) {
    try {
      window.localStorage.removeItem(SHORTCUT_SETTINGS_STORAGE_KEY);
    } catch {
      // ignore
    }
    dispatchChanged();
    return;
  }
  writeJson(SHORTCUT_SETTINGS_STORAGE_KEY, overrides);
  dispatchChanged();
};

/** Sanitize an untrusted record (API payload) into valid per-action bindings. */
export const normalizeAppShortcutSettings = (value: unknown): Partial<ShortcutSettings> => {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: Partial<ShortcutSettings> = {};
  for (const action of SHORTCUT_ACTION_VALUES) {
    const binding = toBinding(input[action]);
    if (binding) result[action] = binding;
  }
  return result;
};

/** Effective defaults (builtin + admin-configured), without personal overrides. */
export const resolveShortcutDefaultSettings = (): ShortcutSettings => {
  const instance = readInstanceAppShortcutDefaults();
  const effective = { ...DEFAULT_SHORTCUT_SETTINGS };
  if (instance) {
    for (const action of SHORTCUT_ACTION_VALUES) {
      const binding = instance[action];
      if (binding) effective[action] = binding;
    }
  }
  return effective;
};

/** Effective settings: personal overrides win, then instance defaults, then builtin. */
export const resolveShortcutSettings = (): ShortcutSettings => {
  const effective = resolveShortcutDefaultSettings();
  const customizations = readShortcutSettingsCustomizations();
  for (const action of SHORTCUT_ACTION_VALUES) {
    const binding = customizations[action];
    if (binding) effective[action] = binding;
  }
  return effective;
};

/**
 * Store a personal binding for one action. Setting the binding that equals the
 * current effective default removes the override so the action follows the
 * default again (and stops showing the customized badge).
 */
export const updateShortcutSettingsOverride = (
  action: ShortcutAction,
  binding: ShortcutBinding,
): Partial<ShortcutSettings> => {
  const overrides = readShortcutSettingsCustomizations();
  if (shortcutBindingsEqual(resolveShortcutDefaultSettings()[action], binding)) {
    delete overrides[action];
  } else {
    overrides[action] = binding;
  }
  writeShortcutSettingsCustomizations(overrides);
  return overrides;
};

/** Clear all personal overrides so every action follows the effective default. */
export const resetShortcutSettingsCustomizations = () => {
  try {
    window.localStorage.removeItem(SHORTCUT_SETTINGS_STORAGE_KEY);
  } catch {
    // ignore
  }
  dispatchChanged();
};

export type { ShortcutAction, ShortcutSettings };
