import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const chromeSource = readFileSync(new URL("./WorkspaceMobileChrome.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

const sharedSource = readFileSync(new URL("./SharedWithMePane.tsx", import.meta.url), "utf8");

const sharedMemoHandler = workspaceSource.split("const handleOpenSharedMemo = (memoId: string) => {")[1]?.split("const handleBackToMemoList")[0] ?? "";

describe("mobile groups and outgoing shares", () => {
  test("exposes group pages and both outgoing-share scopes in the notebook picker", () => {
    expect(chromeSource).toContain("data-mobile-groups");
    expect(chromeSource).toContain("data-mobile-my-shares");
    expect(chromeSource).toContain("handleOpenShared({ groupId: group.id })");
    expect(chromeSource).toContain('handleOpenShared("link")');
    expect(chromeSource).toContain('handleOpenShared("group")');
    expect(chromeSource).toContain("onOpenShared?: (target?: SharedPaneTarget) => void;");
    expect(workspaceSource).toContain("onOpenShared={handleOpenShared}");
  });

  test("opens shared notes in the editor instead of the personal list and protects the external selection", () => {
    expect(sharedMemoHandler).toContain("externalSelectionRef.current = memoId;");
    expect(sharedMemoHandler).toContain('setActivePane("editor")');
    expect(sharedMemoHandler).not.toContain('setActivePane("memos")');
    expect(sharedMemoHandler).toContain("sharedMemoReturnRef.current =");
    expect(workspaceSource).toContain("onOpenMemo={handleOpenSharedMemo}");
    expect(workspaceSource).toContain("onBackToList={handleBackToMemoList}");
  });

  test("restores the source shared page and expanded notebook on back", () => {
    expect(workspaceSource).toContain("sharedReturn?.memoId === selectedMemoId");
    expect(workspaceSource).toContain("initialExpandedNotebookId={sharedExpandedNotebookId}");
    expect(workspaceSource).toContain('key={sharedGroupId ? `group:${sharedGroupId}` : `scope:${sharedScope}`}');
    expect(sharedSource).toContain("useState<string | null>(initialExpandedNotebookId)");
    expect(sharedSource).toContain("onExpandedNotebookChange?.(nextId)");
    expect(workspaceSource).toContain('if (rightView === "shared") {');
  });

  test("shows query failures instead of reporting an empty shared notebook", () => {
    expect(sharedSource).toContain("isError={notebookMemosQuery.isError}");
    expect(sharedSource).toContain("<SharedContentLoadError onRetry={onRetry} />");
    expect(chromeSource).toContain('t("sharedPane.loadFailed")');
    expect(chromeSource).not.toContain("title={");
  });
});

describe("mobile recent-notes navigation", () => {
  test("shows a direct recent-notes destination in the mobile main navigation", () => {
    expect(chromeSource).toContain("grid-cols-4");
    expect(chromeSource).toContain('active={activeItem === "recent"}');
    expect(chromeSource).toContain('label={t("recentMemos.title")}');
    expect(chromeSource).toContain("onClick={onOpenRecent}");
    expect(workspaceSource).toContain("onOpenRecent={handleOpenRecentMemos}");
  });
});

describe("mobile notebook picker create-notebook entry", () => {
  test("declares an optional onCreateNotebook callback for the picker", () => {
    expect(chromeSource).toContain("onCreateNotebook?: (parentId?: string | null) => void;");
    expect(chromeSource).toContain("onCreateNotebook,");
  });

  test("renders a create-notebook row that closes the drawer before creating", () => {
    expect(chromeSource).toContain('t("mobileNotebookPicker.createNotebook")');
    expect(chromeSource).toContain("<Plus className=\"h-4 w-4 shrink-0 text-slate-500\" />");
    expect(chromeSource).toContain("onClose();");
    expect(chromeSource).toContain("onCreateNotebook(null);");
  });

  test("workspace wires the picker to the shared notebook-name dialog", () => {
    expect(workspaceSource).toContain("onCreateNotebook={(parentId) => {");
    expect(workspaceSource).toContain("setMobileNotebookPickerOpen(false);");
    expect(workspaceSource).toContain("handleCreateNotebook(parentId);");
  });
});
