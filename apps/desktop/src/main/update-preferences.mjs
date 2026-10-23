// Auto-update preferences live in the Electron main process so the scheduler
// keeps working while the renderer is hidden or hibernating.

export const UPDATE_PREFERENCES_FILE = "update-preferences.json";
export const UPDATE_PREFERENCES_VERSION = 1;

export const DEFAULT_UPDATE_PREFERENCES = Object.freeze({
  autoUpdateEnabled: true,
  windowEnabled: false,
  windowStart: "00:00",
  windowEnd: "06:00",
});

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidUpdateWindowTime = (value) =>
  typeof value === "string" && TIME_OF_DAY_PATTERN.test(value);

const normalizeTime = (value, fallback) => (isValidUpdateWindowTime(value) ? value : fallback);

/** Total minutes since midnight for a validated HH:MM value. */
export const updateWindowTimeMinutes = (value) => {
  const match = TIME_OF_DAY_PATTERN.exec(String(value ?? ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Clamp arbitrary input (possibly from a corrupt file) onto known fields. */
export const normalizeUpdatePreferences = (value) => {
  const input = value && typeof value === "object" ? value : {};
  return {
    autoUpdateEnabled:
      typeof input.autoUpdateEnabled === "boolean"
        ? input.autoUpdateEnabled
        : DEFAULT_UPDATE_PREFERENCES.autoUpdateEnabled,
    windowEnabled:
      typeof input.windowEnabled === "boolean"
        ? input.windowEnabled
        : DEFAULT_UPDATE_PREFERENCES.windowEnabled,
    windowStart: normalizeTime(input.windowStart, DEFAULT_UPDATE_PREFERENCES.windowStart),
    windowEnd: normalizeTime(input.windowEnd, DEFAULT_UPDATE_PREFERENCES.windowEnd),
  };
};

export const parseUpdatePreferences = (text) => {
  let parsed = null;
  try {
    parsed = typeof text === "string" && text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return normalizeUpdatePreferences(parsed);
};

export const serializeUpdatePreferences = (value) => `${JSON.stringify({
  version: UPDATE_PREFERENCES_VERSION,
  ...normalizeUpdatePreferences(value),
}, null, 2)}\n`;

/**
 * Whether a moment falls inside the configured daily window. Local wall-clock
 * time is used, matching what the user picked in settings. A start equal to
 * the end means the whole day; a start later than the end spans midnight.
 */
export const isWithinUpdateWindow = (value, date = new Date()) => {
  const preferences = normalizeUpdatePreferences(value);
  if (!preferences.windowEnabled) return true;
  const start = updateWindowTimeMinutes(preferences.windowStart);
  const end = updateWindowTimeMinutes(preferences.windowEnd);
  if (start === null || end === null || start === end) return true;
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
};

/** Automatic checks/downloads run only when enabled and inside the window. */
export const shouldAutoUpdateNow = (value, date = new Date()) => {
  const preferences = normalizeUpdatePreferences(value);
  return preferences.autoUpdateEnabled && isWithinUpdateWindow(preferences, date);
};
