import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("note editor failure containment", () => {
  test("isolates editor failures below the workspace shell", () => {
    const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

    expect(workspaceSource).toContain("<EditorPaneErrorBoundary");
    expect(workspaceSource).toContain("<EditorPane\n");
    expect(workspaceSource.indexOf("<EditorPaneErrorBoundary")).toBeLessThan(workspaceSource.indexOf("<EditorPane\n"));
  });

  test("does not auto-open a note while renderer recovery is active", () => {
    const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
    const rootBoundarySource = readFileSync(new URL("./DesktopRendererErrorBoundary.tsx", import.meta.url), "utf8");

    expect(rootBoundarySource).toContain("markRendererRecoveryRequired()");
    expect(workspaceSource).toContain("rendererRecoveryMode ? null : selectedMemoId ?? (suppressAutoOpenRef.current ? null : memos[0]?.id ?? null)");
    const restoreBlock = workspaceSource.slice(workspaceSource.indexOf("const [workspaceRestore]"), workspaceSource.indexOf("const [activePane"));
    expect(restoreBlock).toContain("if (rendererRecoveryMode) {\n      return null;");
    expect(workspaceSource).toContain("if (!workspaceRestore?.openMemoTabs.length || rendererRecoveryMode) return;");
    expect(workspaceSource).toContain("Boolean(route.openMemoId) && !route.isTrash && !rendererRecoveryMode");
    expect(workspaceSource).toContain("rendererRecoveryMode ? route.openMemoId : null");
    expect(workspaceSource).toContain("if (rendererRecoveryMode) {");
    expect(workspaceSource).toContain("safeModeNotice={rendererRecoveryMode}");
    expect(workspaceSource).not.toContain("<EditorRecoveryPane />");
  });
});
