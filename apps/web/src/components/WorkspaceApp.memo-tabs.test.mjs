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
});
