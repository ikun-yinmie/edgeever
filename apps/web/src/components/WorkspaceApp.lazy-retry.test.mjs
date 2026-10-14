import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consumeChunkReloadFlag } from "../lib/lazy-retry.ts";

const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

const memoryStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
};

describe("chunk reload retry", () => {
  test("reloads once per pane, then surfaces repeat failures", () => {
    const storage = memoryStorage();
    expect(consumeChunkReloadFlag(storage, "EditorPane")).toBe(false);
    expect(consumeChunkReloadFlag(storage, "EditorPane")).toBe(true);
    expect(consumeChunkReloadFlag(storage, "SettingsPane")).toBe(false);
  });

  test("never reloads when the flag store is unavailable", () => {
    expect(consumeChunkReloadFlag(undefined, "EditorPane")).toBe(true);
    expect(consumeChunkReloadFlag(null, "EditorPane")).toBe(true);
    expect(consumeChunkReloadFlag({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    }, "EditorPane")).toBe(true);
  });

  test("workspace panes load through the retry helper instead of bare lazy()", () => {
    for (const pane of ["EditorPane", "SettingsPane", "SharedWithMePane", "NotebookPane"]) {
      expect(workspaceSource).toContain(`lazyWithChunkRetry("${pane}"`);
    }
    expect(workspaceSource).not.toContain("lazy(() => import(");
    expect(workspaceSource).toContain('from "@/lib/lazy-retry"');
  });
});
