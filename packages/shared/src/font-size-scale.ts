import { MEMO_CONTENT_STYLE } from "./memo-content-style";

/**
 * Typographic size scale shared by the toolbar dropdown, the A+/A− step
 * buttons and the keyboard shortcuts. Values are px integers.
 */
export const FONT_SIZE_SCALE = [12, 13, 14, 15, 16, 19, 22, 24, 29, 32, 40, 48] as const;

/** Custom sizes typed into the toolbar stay inside this range. */
export const FONT_SIZE_PX_MIN = 8;
export const FONT_SIZE_PX_MAX = 96;

/** Size used when a selection has no explicit inline size yet. */
export const FONT_SIZE_BASE_PX = MEMO_CONTENT_STYLE.body.fontSize;

export const clampFontSizePx = (value: number): number => {
  if (!Number.isFinite(value)) {
    return FONT_SIZE_BASE_PX;
  }
  return Math.min(FONT_SIZE_PX_MAX, Math.max(FONT_SIZE_PX_MIN, Math.round(value)));
};

/** Reads a `textStyle` fontSize attr ("15px") back into a number, or null when unset. */
export const parseFontSizePx = (value: unknown): number | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{1,3}(?:\.\d+)?)\s*px$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

/**
 * Next/previous size for the A+/A− buttons and shortcuts: walks the shared
 * scale, then keeps stepping by one px beyond either end of the scale.
 */
export const stepFontSizePx = (current: number | null, direction: 1 | -1): number => {
  const base = current === null ? FONT_SIZE_BASE_PX : clampFontSizePx(current);
  if (direction > 0) {
    return FONT_SIZE_SCALE.find((size) => size > base) ?? Math.min(FONT_SIZE_PX_MAX, base + 1);
  }
  for (let index = FONT_SIZE_SCALE.length - 1; index >= 0; index -= 1) {
    const size = FONT_SIZE_SCALE[index];
    if (size < base) {
      return size;
    }
  }
  return Math.max(FONT_SIZE_PX_MIN, base - 1);
};
