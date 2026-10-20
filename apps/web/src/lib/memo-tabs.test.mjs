import { describe, expect, test } from "bun:test";
import {
  addMemoTab,
  closeOtherMemoTabs,
  reorderMemoTabs,
  replaceActiveMemoTab,
  resolveMemoTabOverflow,
} from "./memo-tabs.ts";

describe("memo tab state", () => {
  test("adds missing tabs once and keeps the existing order", () => {
    expect(addMemoTab(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(addMemoTab(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  test("replaces the active tab and falls back to appending", () => {
    expect(replaceActiveMemoTab(["a", "b", "c"], "b", "d")).toEqual(["a", "d", "c"]);
    expect(replaceActiveMemoTab(["a", "b"], "b", "a")).toEqual(["a", "b"]);
    expect(replaceActiveMemoTab(["a"], null, "b")).toEqual(["a", "b"]);
    expect(replaceActiveMemoTab(["a"], "missing", "b")).toEqual(["a", "b"]);
  });

  test("closes other tabs only when the kept tab is open", () => {
    expect(closeOtherMemoTabs(["a", "b", "c"], "b")).toEqual(["b"]);
    expect(closeOtherMemoTabs(["a", "b"], "missing")).toEqual(["a", "b"]);
  });

  test("reorders dragged tabs in both directions", () => {
    expect(reorderMemoTabs(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderMemoTabs(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderMemoTabs(["a", "b", "c"], "a", "a")).toEqual(["a", "b", "c"]);
    expect(reorderMemoTabs(["a", "b", "c"], "missing", "a")).toEqual(["a", "b", "c"]);
  });
});

describe("memo tab overflow", () => {
  test("shows every tab when the row fits", () => {
    expect(resolveMemoTabOverflow({
      tabWidths: [100, 100, 100],
      availableWidth: 400,
      activeIndex: 0,
    })).toEqual({ start: 0, count: 3 });
  });

  test("reserves room for the more button and hides trailing tabs", () => {
    expect(resolveMemoTabOverflow({
      tabWidths: [100, 100, 100, 100],
      availableWidth: 400,
      activeIndex: 0,
    })).toEqual({ start: 0, count: 3 });
  });

  test("keeps the active tab visible by shifting the window", () => {
    expect(resolveMemoTabOverflow({
      tabWidths: [100, 100, 100, 100, 100],
      availableWidth: 420,
      activeIndex: 4,
    })).toEqual({ start: 2, count: 3 });
  });

  test("keeps the window inside the available width with variable tab widths", () => {
    const result = resolveMemoTabOverflow({
      tabWidths: [96, 96, 220, 96, 96],
      availableWidth: 420,
      activeIndex: 4,
    });
    expect(result).toEqual({ start: 3, count: 2 });
  });

  test("falls back to a collapsed row when nothing fits", () => {
    expect(resolveMemoTabOverflow({
      tabWidths: [100],
      availableWidth: 60,
      activeIndex: 0,
    })).toEqual({ start: 0, count: 0 });
    expect(resolveMemoTabOverflow({
      tabWidths: [],
      availableWidth: 100,
      activeIndex: -1,
    })).toEqual({ start: 0, count: 0 });
  });
});
