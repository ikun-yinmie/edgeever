import { describe, expect, test } from "bun:test";
import { formatRendererErrorReport, getRendererErrorSections } from "./renderer-error-details.ts";

describe("renderer error details", () => {
  test("includes actionable diagnostic fields and omits empty sections", () => {
    const sections = getRendererErrorSections({
      kind: "react-error",
      message: "Cannot read properties of undefined",
      stack: "at render (assets/index.js:42:7)",
      componentStack: "at WorkspaceApp",
    }, true);

    expect(sections.map(({ label }) => label)).toEqual([
      "错误类型",
      "错误消息",
      "JavaScript 堆栈",
      "组件堆栈",
    ]);
    expect(formatRendererErrorReport(sections)).toContain("## 错误消息\n\nCannot read properties of undefined");
    expect(formatRendererErrorReport(sections)).toContain("at WorkspaceApp");
  });

  test("does not include empty fields or unrelated system information", () => {
    const sections = getRendererErrorSections({
      kind: "react-error",
      message: "Page failed",
      stack: "",
      componentStack: "",
    }, false);
    const report = formatRendererErrorReport(sections);

    expect(report).toContain("## Error message\n\nPage failed");
    expect(report).not.toContain("JavaScript stack");
    expect(report).not.toContain("systemInfo");
  });

  test("returns no sections without a captured error", () => {
    expect(getRendererErrorSections(null, false)).toEqual([]);
  });
});
