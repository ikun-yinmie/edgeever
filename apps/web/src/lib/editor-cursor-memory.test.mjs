import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clearEditorCursor, readEditorCursor, writeEditorCursor } from "./editor-cursor-memory";

const originalWindow = globalThis.window;
const data = new Map();
const fakeStorage = {
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, value) => { data.set(key, String(value)); },
  removeItem: (key) => { data.delete(key); },
  clear: () => { data.clear(); },
  key: (index) => [...data.keys()][index] ?? null,
  get length() { return data.size; },
};

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: fakeStorage },
  });
});

afterAll(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

describe("editor cursor memory", () => {
  test("stores and restores a selection per memo", () => {
    data.clear();
    writeEditorCursor("memo-a", 12, 18);
    writeEditorCursor("memo-b", 3, 3);

    expect(readEditorCursor("memo-a")).toMatchObject({ from: 12, to: 18 });
    expect(readEditorCursor("memo-b")).toMatchObject({ from: 3, to: 3 });
    expect(readEditorCursor("missing")).toBeNull();
  });

  test("ignores invalid selections and clears on demand", () => {
    data.clear();
    writeEditorCursor("memo-a", 0, 4);
    writeEditorCursor("memo-a", 8, 3);
    expect(readEditorCursor("memo-a")).toBeNull();

    writeEditorCursor("memo-a", 4, 6);
    clearEditorCursor("memo-a");
    expect(readEditorCursor("memo-a")).toBeNull();
  });

  test("survives malformed storage and keeps the map bounded", () => {
    data.clear();
    data.set("edgeever.editor-cursor-positions.v1", "{not json");
    expect(readEditorCursor("memo-a")).toBeNull();

    for (let index = 0; index < 410; index += 1) {
      writeEditorCursor(`memo-${index}`, index + 1, index + 1);
    }
    const stored = JSON.parse(data.get("edgeever.editor-cursor-positions.v1") ?? "{}");
    expect(Object.keys(stored).length).toBeLessThanOrEqual(400);
  });
});
