import { describe, expect, test } from "bun:test";
import {
  DEFAULT_UPDATE_PREFERENCES,
  isWithinUpdateWindow,
  isValidUpdateWindowTime,
  normalizeUpdatePreferences,
  parseUpdatePreferences,
  serializeUpdatePreferences,
  shouldAutoUpdateNow,
  updateWindowTimeMinutes,
} from "./update-preferences.mjs";

const at = (hours, minutes = 0) => new Date(2026, 0, 15, hours, minutes, 0, 0);

describe("desktop update preferences", () => {
  test("defaults to automatic updates with the time window disabled", () => {
    expect(parseUpdatePreferences("")).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(normalizeUpdatePreferences(null)).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(parseUpdatePreferences("not json")).toEqual(DEFAULT_UPDATE_PREFERENCES);
  });

  test("clamps corrupt or invalid values onto the known shape", () => {
    const preferences = normalizeUpdatePreferences({
      autoUpdateEnabled: false,
      windowEnabled: true,
      windowStart: "25:00",
      windowEnd: "7:30",
    });
    expect(preferences).toEqual({
      autoUpdateEnabled: false,
      windowEnabled: true,
      windowStart: DEFAULT_UPDATE_PREFERENCES.windowStart,
      windowEnd: "06:00",
    });
  });

  test("round-trips through the persisted JSON format", () => {
    const preferences = {
      autoUpdateEnabled: false,
      windowEnabled: true,
      windowStart: "22:15",
      windowEnd: "06:45",
    };
    const serialized = serializeUpdatePreferences(preferences);
    expect(JSON.parse(serialized)).toMatchObject({ version: 1, ...preferences });
    expect(parseUpdatePreferences(serialized)).toEqual(preferences);
  });

  test("validates HH:MM values", () => {
    expect(isValidUpdateWindowTime("00:00")).toBe(true);
    expect(isValidUpdateWindowTime("23:59")).toBe(true);
    expect(isValidUpdateWindowTime("24:00")).toBe(false);
    expect(isValidUpdateWindowTime("7:30")).toBe(false);
    expect(isValidUpdateWindowTime("07:60")).toBe(false);
    expect(isValidUpdateWindowTime(null)).toBe(false);
    expect(updateWindowTimeMinutes("02:30")).toBe(150);
  });

  test("ignores the window while it is disabled", () => {
    expect(isWithinUpdateWindow({ windowEnabled: false, windowStart: "02:00", windowEnd: "03:00" }, at(12))).toBe(true);
  });

  test("matches a same-day window and treats the end as exclusive", () => {
    const preferences = { autoUpdateEnabled: true, windowEnabled: true, windowStart: "02:00", windowEnd: "05:00" };
    expect(isWithinUpdateWindow(preferences, at(1, 59))).toBe(false);
    expect(isWithinUpdateWindow(preferences, at(2, 0))).toBe(true);
    expect(isWithinUpdateWindow(preferences, at(4, 59))).toBe(true);
    expect(isWithinUpdateWindow(preferences, at(5, 0))).toBe(false);
  });

  test("matches a window that spans midnight", () => {
    const preferences = { autoUpdateEnabled: true, windowEnabled: true, windowStart: "22:00", windowEnd: "06:00" };
    expect(isWithinUpdateWindow(preferences, at(23))).toBe(true);
    expect(isWithinUpdateWindow(preferences, at(2))).toBe(true);
    expect(isWithinUpdateWindow(preferences, at(6))).toBe(false);
    expect(isWithinUpdateWindow(preferences, at(12))).toBe(false);
  });

  test("a zero-length window covers the whole day", () => {
    expect(isWithinUpdateWindow({ windowEnabled: true, windowStart: "03:00", windowEnd: "03:00" }, at(15))).toBe(true);
  });

  test("automatic updates require the toggle and the window", () => {
    const inWindow = { autoUpdateEnabled: true, windowEnabled: true, windowStart: "02:00", windowEnd: "05:00" };
    expect(shouldAutoUpdateNow(inWindow, at(3))).toBe(true);
    expect(shouldAutoUpdateNow({ ...inWindow, autoUpdateEnabled: false }, at(3))).toBe(false);
    expect(shouldAutoUpdateNow(inWindow, at(12))).toBe(false);
    expect(shouldAutoUpdateNow({ ...inWindow, windowEnabled: false }, at(12))).toBe(true);
  });
});
