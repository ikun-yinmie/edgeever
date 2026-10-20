import { describe, expect, test } from "bun:test";
import {
  hasTaskItemSubContent,
  isTaskItemCollapsed,
  resolveRenderedTaskItemCollapse,
} from "./task-item-collapse.ts";

describe("task item collapse", () => {
  test("treats blocks after the leading paragraph as collapsible sub-content", () => {
    expect(hasTaskItemSubContent(0)).toBe(false);
    expect(hasTaskItemSubContent(1)).toBe(false);
    expect(hasTaskItemSubContent(2)).toBe(true);
    expect(hasTaskItemSubContent(5)).toBe(true);
  });

  test("only reads an explicit true collapse attribute", () => {
    expect(isTaskItemCollapsed(true)).toBe(true);
    expect(isTaskItemCollapsed(false)).toBe(false);
    expect(isTaskItemCollapsed("true")).toBe(false);
    expect(isTaskItemCollapsed(undefined)).toBe(false);
  });

  test("expands persisted collapsed items while the editor is read-only", () => {
    expect(resolveRenderedTaskItemCollapse({ childCount: 3, collapsed: true, editable: true })).toBe(true);
    expect(resolveRenderedTaskItemCollapse({ childCount: 3, collapsed: true, editable: false })).toBe(false);
    expect(resolveRenderedTaskItemCollapse({ childCount: 3, collapsed: false, editable: true })).toBe(false);
    expect(resolveRenderedTaskItemCollapse({ childCount: 1, collapsed: true, editable: true })).toBe(false);
  });
});
