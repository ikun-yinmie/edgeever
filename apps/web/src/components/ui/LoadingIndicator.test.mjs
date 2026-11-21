import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./LoadingIndicator.tsx", import.meta.url), "utf8");

describe("LoadingIndicator", () => {
  test("keeps a localized status label beside an animated indicator", () => {
    expect(source).toContain("{label}");
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("animate-spin");
    expect(source).toContain("motion-reduce:animate-none");
    expect(source).toContain('aria-hidden="true"');
  });
});
