import { describe, expect, test } from "bun:test";
import {
  getCalendarGridDayKeys,
  getDayKeyFromDate,
  getMemoDayKey,
  groupMemosByDay,
} from "./recent-memos.ts";

const localIso = (year, monthIndex, day, hours = 12) => new Date(year, monthIndex, day, hours).toISOString();

describe("recent memo day grouping", () => {
  test("groups memos by their local calendar day in input order", () => {
    const memos = [
      { id: "memo_3", updatedAt: localIso(2026, 9, 18, 10) },
      { id: "memo_2", updatedAt: localIso(2026, 9, 18, 9) },
      { id: "memo_1", updatedAt: localIso(2026, 9, 16, 21) },
    ];

    const groups = groupMemosByDay(memos);

    expect(groups.map((group) => group.dayKey)).toEqual(["2026-10-18", "2026-10-16"]);
    expect(groups[0].memos.map((memo) => memo.id)).toEqual(["memo_3", "memo_2"]);
    expect(groups[1].memos.map((memo) => memo.id)).toEqual(["memo_1"]);
  });

  test("skips invalid timestamps instead of crashing the home timeline", () => {
    const memos = [
      { id: "memo_bad", updatedAt: "not-a-date" },
      { id: "memo_ok", updatedAt: localIso(2026, 9, 18) },
    ];

    expect(groupMemosByDay(memos).map((group) => group.dayKey)).toEqual(["2026-10-18"]);
    expect(getMemoDayKey("not-a-date")).toBe("");
  });

  test("derives day keys from local calendar fields", () => {
    expect(getDayKeyFromDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(getMemoDayKey(localIso(2026, 11, 31, 23))).toBe("2026-12-31");
  });
});

describe("recent memo calendar grid", () => {
  test("builds monday-first weeks covering the whole month", () => {
    const october = getCalendarGridDayKeys(2026, 9);

    expect(october[0]).toBe("2026-09-28");
    expect(october).toContain("2026-10-01");
    expect(october).toContain("2026-10-31");
    expect(october.length % 7).toBe(0);

    const february = getCalendarGridDayKeys(2026, 1);

    expect(february[0]).toBe("2026-01-26");
    expect(february).toContain("2026-02-28");
  });
});
