import { describe, expect, test } from "bun:test";
import { resolveContextMenuOffset } from "./context-menu-placement.ts";

describe("context menu placement", () => {
  test("starts the menu at the click when it fits below", () => {
    // Radix placed the menu 4px below the cursor; the correction removes the gap.
    expect(resolveContextMenuOffset(200, 204, 300, 900)).toBe(-4);
  });

  test("ends the menu at the click when there is no room below", () => {
    // Click at 700 in a 800px viewport: a 300px menu must flip up so its
    // bottom edge lands on the click point instead of the viewport edge.
    expect(resolveContextMenuOffset(700, 300, 300, 800)).toBe(100);
  });

  test("keeps a menu taller than the space above the click on screen", () => {
    // 700px menu, 250px click point: neither side fits, so the top margin wins.
    expect(resolveContextMenuOffset(250, 100, 700, 800)).toBe(-92);
  });

  test("leaves unmeasured content alone", () => {
    expect(resolveContextMenuOffset(400, 400, 0, 800)).toBe(0);
  });
});
