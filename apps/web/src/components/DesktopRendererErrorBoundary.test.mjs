import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./DesktopRendererErrorBoundary.tsx", import.meta.url), "utf8");

describe("renderer error fallback", () => {
  test("keeps raw diagnostics in a collapsed disclosure by default", () => {
    expect(source).toContain("diagnosticsExpanded: false");
    expect(source).toContain("<Collapsible");
    expect(source).toContain("open={this.state.diagnosticsExpanded}");
    expect(source).toContain("getRendererErrorSections(this.state.error, zh).map");
    expect(source).not.toContain("{this.state.error.message}");
  });

  test("offers diagnostics copying and keeps browser recovery guidance", () => {
    expect(source).toContain("copyTextToClipboard(formatRendererErrorReport(sections))");
    expect(source).toContain("复制失败，请选择并复制上方内容。");
    expect(source).toContain("include them with your feedback");
    expect(source).toContain("onClick={() => window.location.reload()}");
  });
});
