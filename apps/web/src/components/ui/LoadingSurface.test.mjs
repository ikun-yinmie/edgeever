import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./LoadingSurface.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");

describe("shared loading surfaces", () => {
  test("exposes localized status and explicit surface variants", () => {
    expect(source).toContain("data-loading-surface={variant}");
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('variant?: "startup" | "pane" | "editor" | "tasks"');
  });

  test("renders the task overview hierarchy and honors reduced motion", () => {
    expect(source).toContain("export const MemoTasksLoadingSurface");
    expect(source).toContain('variant="tasks"');
    expect(source).toContain("edgeever-loading__task-filters");
    expect(source).toContain("edgeever-loading__task-card");
    expect(source).toContain("edgeever-loading__task-checkbox");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".edgeever-loading__halo");
    expect(styles).toContain(".edgeever-loading__paper");
    expect(styles).toContain(".edgeever-loading__note");
  });
});
