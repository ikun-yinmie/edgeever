import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const editorSource = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");

describe("mobile scroll-to-edge controls", () => {
  test("places the bottom control above the mobile edit button while preserving desktop placement", () => {
    expect(editorSource).toContain("bottom-5 right-5 z-10 max-sm:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-sm:right-4");
    expect(editorSource).toContain('className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-30 h-12 w-12');
  });
});
