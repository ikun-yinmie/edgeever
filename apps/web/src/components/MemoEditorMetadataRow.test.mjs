import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./MemoEditorMetadataRow.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const diagramSource = readFileSync(new URL("./DiagramEditorPane.tsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("./NotebookPane.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

describe("reveal the open note's notebook", () => {
  test("renders a locate control next to the notebook selector when enabled", () => {
    expect(source).toContain("onRevealNotebook?: () => void;");
    expect(source).toContain('<LocateFixed className="h-4 w-4" />');
    expect(source).toContain('aria-label={t("editor.revealNotebook")}');
    expect(source).toContain('<TooltipContent side="top">{t("editor.revealNotebook")}</TooltipContent>');
    expect(source).toContain("{onRevealNotebook ? (");
  });

  test("wires the locate control through both note editors", () => {
    expect(editorSource).toContain("!isTrashView");
    expect(diagramSource).toContain("!readOnly");
    expect(editorSource).toContain("&& notebooks.some((notebook) => notebook.id === memo.notebookId)");
    expect(diagramSource).toContain("&& notebooks.some((notebook) => notebook.id === memo.notebookId)");
    expect(workspaceSource).toContain("onRevealNotebook={isDesktop ? handleRevealSelectedMemoNotebook : undefined}");
  });

  test("locates on demand instead of following every tab switch", () => {
    const tabHandler = workspaceSource.split("const handleSelectMemoTab = useCallback(")[1]?.split("const closeMemoTab")[0] ?? "";

    expect(tabHandler.length).toBeGreaterThan(0);
    expect(tabHandler).not.toContain("setSelectedNotebookId");
    expect(workspaceSource).toContain("const handleRevealSelectedMemoNotebook = useCallback(() => {");
    expect(workspaceSource).toContain("setSelectedNotebookId(notebookId);");
    expect(workspaceSource).toContain("pendingQuickSwitcherMemoIdRef.current = selectedMemo?.id ?? null;");
  });

  test("clears the sidebar filter so the located notebook is actually visible", () => {
    expect(sidebarSource).toContain('setNotebookSearch((current) => (current ? "" : current));');
    expect(workspaceSource).toContain("setNotebookRevealRequest({ notebookId, token: notebookRevealTokenRef.current });");
    expect(workspaceSource).toContain("revealRequest={notebookRevealRequest}");
    expect(sidebarSource).toContain("if (!revealRequest) {");
    expect(sidebarSource).toContain('targetNode?.scrollIntoView({ block: "nearest" });');
  });
});
