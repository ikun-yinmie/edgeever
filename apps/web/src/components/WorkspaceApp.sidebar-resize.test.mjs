import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
const preferencesSource = readFileSync(new URL("../hooks/useWorkspacePreferences.ts", import.meta.url), "utf8");

describe("notebook sidebar resize", () => {
  test("renders an accessible separator that drives the notebook column variable", () => {
    expect(workspaceSource).toContain('"--notebook-sidebar-width": `${notebookSidebarWidth}px`');
    expect(workspaceSource).toContain('role="separator"');
    expect(workspaceSource).toContain('aria-label={t("workspaceDialogs.resizeNotebookSidebar")}');
    expect(workspaceSource).toContain("handleNotebookSidebarResizePointerDown");
    expect(workspaceSource).toContain("handleNotebookSidebarResizeKeyDown");
    expect(workspaceSource).toContain("onDoubleClick={resetNotebookSidebarWidth}");
  });

  test("applies the drag delta and keeps the collapsed rail width untouched", () => {
    expect(workspaceSource).toContain("setNotebookSidebarWidth(startWidth + moveEvent.clientX - startX)");
    expect(workspaceSource).toContain("!desktopNotebookSidebarCollapsed && {");
    expect(workspaceSource).toContain("!desktopFocusModeActive && !desktopNotebookSidebarCollapsed && (");
  });

  test("persists the width through workspace preferences", () => {
    expect(preferencesSource).toContain("readNotebookSidebarWidthPreference");
    expect(preferencesSource).toContain("writeNotebookSidebarWidthPreference");
    expect(preferencesSource).toContain("resetNotebookSidebarWidth");
  });
});
