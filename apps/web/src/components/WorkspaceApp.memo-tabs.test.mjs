import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

describe("workspace memo tabs", () => {
  test("opens a tab for the selected note and stays quiet after closing the last one", () => {
    expect(source).toContain("const [openMemoTabs, setOpenMemoTabs] = useState<string[]>([]);");
    expect(source).toContain(
      "setOpenMemoTabs((current) => (current.includes(selectedMemoId) ? current : [...current, selectedMemoId]));"
    );
    expect(source).toContain("suppressAutoOpenRef.current = true;");
    expect(source).toContain("if (suppressAutoOpenRef.current) {");
  });

  test("switching and closing tabs reuses the quick-switcher selection guard", () => {
    expect(source).toContain("const handleSelectMemoTab = useCallback(");
    expect(source).toContain("const closeMemoTab = useCallback(");
    expect(source).toContain("const neighbor = remaining[index] ?? remaining[index - 1] ?? null;");
    expect(source).toContain("pendingQuickSwitcherMemoIdRef.current = memoId;");
    expect(source).toContain("pendingQuickSwitcherMemoIdRef.current = neighbor;");
  });

  test("prunes deleted notes from the tab strip in both delete mutations", () => {
    expect(source).toContain("setOpenMemoTabs((current) => current.filter((id) => id !== variables?.memoId));");
    expect(source).toContain("setOpenMemoTabs((current) => current.filter((id) => !deletedMemoIds.has(id)));");
  });

  test("renders the tab bar only for the desktop editor view", () => {
    expect(source).toContain("const showMemoTabsBar = Boolean(");
    expect(source).toContain(
      'isDesktop && rightView === "editor" && memoView !== "trash" && !desktopFocusModeActive && openMemoTabItems.length > 0'
    );
    expect(source).toContain("<MemoTabsBar");
    expect(source).toContain("activeMemoId={selectedMemoId}");
    expect(source).toContain("onSelect={handleSelectMemoTab}");
    expect(source).toContain("onClose={closeMemoTab}");
  });

  test("titles fall back to the localized untitled label and skip trash in the ensure effect", () => {
    expect(source).toContain('t("common.untitledMemo")');
    expect(source).toContain('if (rightView !== "editor" || memoView === "trash") {');
  });

  test("opens list notes in a new tab by default", () => {
    expect(source).toContain("onOpenMemo={openMemoInNewTab}");
    expect(source).toContain("const openMemoInNewTab = useCallback(");
  });

  test("replaces the active tab when opening in the current tab", () => {
    expect(source).toContain("const openMemoInCurrentTab = useCallback(");
    expect(source).toContain("replaceActiveMemoTab(current, selectedMemoId, memoId)");
    expect(source).toContain("onOpenMemoInCurrentTab={openMemoInCurrentTab}");
  });

  test("supports close-others, close-all, and drag reordering from the tab bar", () => {
    expect(source).toContain("closeOtherMemoTabs(current, memoId)");
    expect(source).toContain("const closeAllMemoTabs = useCallback(");
    expect(source).toContain("reorderMemoTabs(current, sourceMemoId, targetMemoId)");
    expect(source).toContain("onCloseOthers={closeOtherMemoTabsAndSelect}");
    expect(source).toContain("onCloseAll={closeAllMemoTabs}");
    expect(source).toContain("onReorder={reorderOpenMemoTabs}");
  });

  test("returns to the recent notes page after closing all tabs", () => {
    const closeAllBlock = source.slice(
      source.indexOf("const closeAllMemoTabs = useCallback("),
      source.indexOf("const reorderOpenMemoTabs")
    );
    expect(closeAllBlock).toContain('setRightView("recent");');
    expect(closeAllBlock).toContain("navigateWorkspaceHome();");
    expect(closeAllBlock).toContain('skipNextHomeRouteSyncRef.current = route.pathname !== "/";');
  });

  test("opens the active note in a new window through the openMemo deep link", () => {
    expect(source).toContain("buildOpenMemoWindowUrl(window.location.href, memoId");
    expect(source).toContain("hashRouter: isDesktopRenderer()");
    expect(source).toContain('window.open(url, "_blank", "noopener,noreferrer")');
    expect(source).toContain("onOpenMemoInNewWindow={openMemoInNewWindow}");
    expect(source).toContain("onOpenInNewWindow={openMemoInNewWindow}");
  });

  test("consumes an openMemo deep link once and clears it from the URL", () => {
    expect(source).toContain("consumedOpenMemoParamRef");
    expect(source).toContain("if (!memoId || consumedOpenMemoParamRef.current === memoId) {");
    expect(source).toContain('pendingQuickSwitcherMemoIdRef.current = memoId;');
    expect(source).toContain("navigateWorkspaceHome({ replace: true });");
  });
});
