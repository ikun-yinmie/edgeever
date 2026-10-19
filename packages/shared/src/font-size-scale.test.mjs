import { describe, expect, test } from "bun:test";
import {
  FONT_SIZE_BASE_PX,
  FONT_SIZE_PX_MAX,
  FONT_SIZE_PX_MIN,
  FONT_SIZE_SCALE,
  clampFontSizePx,
  parseFontSizePx,
  stepFontSizePx,
} from "./font-size-scale.ts";

describe("editor font size scale", () => {
  test("keeps the shared scale sorted and inside the custom range", () => {
    const sorted = [...FONT_SIZE_SCALE].sort((left, right) => left - right);
    expect([...FONT_SIZE_SCALE]).toEqual(sorted);
    expect(FONT_SIZE_SCALE[0]).toBeGreaterThanOrEqual(FONT_SIZE_PX_MIN);
    expect(FONT_SIZE_SCALE[FONT_SIZE_SCALE.length - 1]).toBeLessThanOrEqual(FONT_SIZE_PX_MAX);
  });

  test("parses textStyle fontSize attrs and rejects everything else", () => {
    expect(parseFontSizePx("15px")).toBe(15);
    expect(parseFontSizePx(" 29PX ")).toBe(29);
    expect(parseFontSizePx("14.6px")).toBe(15);
    expect(parseFontSizePx("1.2em")).toBeNull();
    expect(parseFontSizePx("")).toBeNull();
    expect(parseFontSizePx(undefined)).toBeNull();
    expect(parseFontSizePx(16)).toBeNull();
  });

  test("clamps custom sizes into the supported range", () => {
    expect(clampFontSizePx(17.4)).toBe(17);
    expect(clampFontSizePx(2)).toBe(FONT_SIZE_PX_MIN);
    expect(clampFontSizePx(400)).toBe(FONT_SIZE_PX_MAX);
    expect(clampFontSizePx(Number.NaN)).toBe(FONT_SIZE_BASE_PX);
  });

  test("walks the shared scale from an unset size", () => {
    expect(stepFontSizePx(null, 1)).toBe(16);
    expect(stepFontSizePx(null, -1)).toBe(14);
    expect(FONT_SIZE_BASE_PX).toBe(15);
  });

  test("steps onto the scale and keeps stepping by one px past its ends", () => {
    expect(stepFontSizePx(17, 1)).toBe(19);
    expect(stepFontSizePx(17, -1)).toBe(16);
    expect(stepFontSizePx(48, 1)).toBe(49);
    expect(stepFontSizePx(12, -1)).toBe(11);
  });

  test("stays clamped at the outer bounds", () => {
    expect(stepFontSizePx(FONT_SIZE_PX_MAX, 1)).toBe(FONT_SIZE_PX_MAX);
    expect(stepFontSizePx(FONT_SIZE_PX_MIN, -1)).toBe(FONT_SIZE_PX_MIN);
  });
});
