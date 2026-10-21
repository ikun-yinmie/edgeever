import { describe, expect, test } from "bun:test";
import {
  captureEditorScrollMemory,
  readEditorScrollMemory,
  restoreEditorScrollMemory,
  writeEditorScrollMemory,
  EDITOR_SCROLL_MEMORY_STORAGE_KEY,
} from "./editor-scroll-memory.ts";

const createStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

const createScroller = (scrollTop, scrollHeight, clientHeight) => ({
  clientHeight,
  scrollHeight,
  scrollTop,
});

describe("editor scroll memory", () => {
  test("round-trips a note position", () => {
    const storage = createStorage();
    const entry = captureEditorScrollMemory(createScroller(900, 3000, 600), 1234);

    expect(writeEditorScrollMemory("memo_1", entry, storage)).toBe(true);
    expect(readEditorScrollMemory("memo_1", storage)).toEqual({
      progress: 0.375,
      scrollHeight: 3000,
      scrollTop: 900,
      updatedAt: 1234,
    });
    expect(storage.data[EDITOR_SCROLL_MEMORY_STORAGE_KEY]).toContain("memo_1");
  });

  test("ignores malformed snapshots and missing notes", () => {
    const storage = createStorage({
      [EDITOR_SCROLL_MEMORY_STORAGE_KEY]: "{",
    });
    expect(readEditorScrollMemory("memo_1", storage)).toBeNull();
    expect(readEditorScrollMemory("", createStorage())).toBeNull();
    expect(readEditorScrollMemory("missing", createStorage())).toBeNull();
  });

  test("keeps the most recent entries within the cap", () => {
    const storage = createStorage();
    for (let index = 0; index < 45; index += 1) {
      writeEditorScrollMemory(`memo_${index}`, {
        progress: 0.5,
        scrollHeight: 1000,
        scrollTop: 200,
        updatedAt: index,
      }, storage);
    }

    const stored = JSON.parse(storage.data[EDITOR_SCROLL_MEMORY_STORAGE_KEY]);
    expect(Object.keys(stored)).toHaveLength(40);
    expect(stored.memo_44).toBeDefined();
    expect(stored.memo_0).toBeUndefined();
  });

  test("restores the exact offset when the document height matches", () => {
    const scroller = createScroller(0, 3000, 600);
    restoreEditorScrollMemory(scroller, {
      progress: 0.375,
      scrollHeight: 3000,
      scrollTop: 900,
      updatedAt: 1,
    });

    expect(scroller.scrollTop).toBe(900);
  });

  test("falls back to relative progress after content reflows", () => {
    const scroller = createScroller(0, 6000, 600);
    restoreEditorScrollMemory(scroller, {
      progress: 0.5,
      scrollHeight: 3000,
      scrollTop: 1200,
      updatedAt: 1,
    });

    expect(scroller.scrollTop).toBe(2700);
  });
});
