import { describe, expect, test } from "bun:test";
import { normalizeDesktopUpdateProgress } from "./update-progress.mjs";

describe("desktop update byte progress", () => {
  test("keeps updater percentages and byte counts, including differential downloads", () => {
    expect(normalizeDesktopUpdateProgress({ percent: 42.5, transferred: 85, total: 200 }))
      .toEqual({ percent: 42.5, transferred: 85, total: 200 });
  });

  test("derives a missing percentage from a known total", () => {
    expect(normalizeDesktopUpdateProgress({ transferred: 25, total: 100 }))
      .toEqual({ percent: 25, transferred: 25, total: 100 });
  });

  test("does not invent a total or percentage before download headers arrive", () => {
    expect(normalizeDesktopUpdateProgress(null)).toEqual({ percent: null, transferred: 0, total: null });
    expect(normalizeDesktopUpdateProgress({ transferred: 32, total: 0, percent: NaN }))
      .toEqual({ percent: null, transferred: 32, total: null });
  });

  test("rejects invalid byte counts and clamps percentages", () => {
    expect(normalizeDesktopUpdateProgress({ transferred: -1, total: Infinity, percent: -5 }))
      .toEqual({ percent: 0, transferred: 0, total: null });
    expect(normalizeDesktopUpdateProgress({ transferred: 110, total: 100, percent: 110 }).percent).toBe(100);
  });
});
