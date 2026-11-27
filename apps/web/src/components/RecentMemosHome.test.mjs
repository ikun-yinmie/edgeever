import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./RecentMemosHome.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");

describe("RecentMemosHome timeline", () => {
  test("offers a refresh button that refreshes the mirror and guards concurrent page loads", () => {
    expect(source).toContain('aria-label={t("recentMemos.refresh")}');
    expect(source).toContain("onRefresh ? onRefresh() : memosQuery.refetch({ throwOnError: true })");
    expect(source).toContain("disabled={refreshing}");
    expect(source).toContain("refreshMutation.isPending || memosQuery.isFetching");
    expect(source).toContain('t("recentMemos.refreshFailed")');
    expect(source).toContain("memosQuery.isError && !memosQuery.data");
    expect(workspaceSource).toContain("queryClient.invalidateQueries({ queryKey: RECENT_MEMOS_HOME_QUERY_KEY })");
  });
  test("loads recent notes by update time and groups them by local day", () => {
    expect(source).toContain('sort: "updated-desc"');
    expect(source).toContain("groupMemosByDay(visibleMemos)");
    expect(source).toContain("getMemoDayKey(memo.updatedAt)");
    expect(source).toContain("formatDayLabel");
  });

  test("filters the timeline by a calendar day and clears on second click", () => {
    expect(source).toContain("handleSelectDay");
    expect(source).toContain("setSelectedDay((current) => (current === dayKey ? null : dayKey))");
    expect(source).toContain("memoDayKeys.has(dayKey)");
    expect(source).toContain('t("recentMemos.clearDayFilter")');
  });

  test("marks calendar days that contain notes", () => {
    expect(source).toContain("getCalendarGridDayKeys");
    expect(source).toContain("hasMemos && !isSelected && \"bg-slate-200/70");
    expect(source).toContain("isToday && !isSelected");
  });

  test("offers a create-note affordance when today has no notes", () => {
    expect(source).toContain("showTodayPlaceholder");
    expect(source).toContain('t("recentMemos.newMemoHint")');
    expect(source).toContain("onClick={onCreateMemo}");
  });

  test("loads older pages until the picked calendar day is covered", () => {
    expect(source).toContain("shouldAutoloadOlderMemos");
    expect(source).toContain("RECENT_MEMOS_AUTOLOAD_LIMIT");
    expect(source).toContain("void memosQuery.fetchNextPage()");
  });

  test("keeps hover hints on tooltips instead of native titles", () => {
    expect(source).toContain("<Tooltip");
    expect(source).not.toContain("title={");
  });
});

describe("RecentMemosHome workspace wiring", () => {
  test("renders the home view from the right pane without auto-selecting a note while open", () => {
    expect(workspaceSource).toContain('rightView === "recent"');
    expect(workspaceSource).toContain("<RecentMemosHome");
    expect(workspaceSource).toContain('if (rightView === "recent") {');
  });

  test("keeps open tabs and the selected note through the recent-notes home", () => {
    const recentHandler = workspaceSource.split("const handleOpenRecentMemos = () => {")[1]?.split("const handleMobileHome")[0] ?? "";
    const allMemosHandler = workspaceSource.split("const handleSelectAllMemos = () => {")[1]?.split("const handleOpenMemberNotes")[0] ?? "";

    expect(recentHandler.length).toBeGreaterThan(0);
    expect(recentHandler).not.toContain("setOpenMemoTabs([])");
    expect(recentHandler).not.toContain("setSelectedMemoId(null)");
    expect(recentHandler).toContain('setMobileBottomNavActive("recent")');
    expect(workspaceSource).toContain('setMobileBottomNavActive("home");\n                        setActivePane("memos");');
    expect(allMemosHandler.length).toBeGreaterThan(0);
    expect(allMemosHandler).not.toContain("setOpenMemoTabs([])");
    expect(allMemosHandler).not.toContain("setSelectedMemoId(null)");
  });

  test("lands on the recent-notes home with no snapshot or an explicitly closed tab strip", () => {
    expect(workspaceSource).toContain('&& (!workspaceRestore || rendererRecoveryMode || (workspaceRestore.memoView !== "trash" && workspaceRestore.openMemoTabs.length === 0))');
    expect(workspaceSource).toContain("readWebWorkspaceRestoreState");
    expect(workspaceSource).toContain("writeWebWorkspaceRestoreState");
  });

  test("keeps safe startup mode on the recent-notes home instead of a recovery splash", () => {
    expect(workspaceSource).toContain("safeModeNotice={rendererRecoveryMode}");
    expect(workspaceSource).not.toContain("<EditorRecoveryPane />");
    expect(source).toContain("safeModeNotice?: boolean;");
    expect(source).toContain("data-safe-mode-notice");
    expect(source).toContain('t("recentMemos.safeModeDismiss")');
    expect(source).not.toContain("title={");
  });

  test("keeps the landing view instead of syncing the untouched initial route to the editor", () => {
    expect(workspaceSource).toContain("const routeSyncSignatureRef = useRef<string | null>(null);");
    expect(workspaceSource).toContain("const previousRouteSignature = routeSyncSignatureRef.current;");
    expect(workspaceSource).toContain("if (previousRouteSignature === null || previousRouteSignature === routeSignature) {");
  });

  test("opens the picked note in its notebook and keeps the selection through list normalisation", () => {
    expect(workspaceSource).toContain("const handleOpenRecentMemos = () => {");
    expect(workspaceSource).toContain("pendingQuickSwitcherMemoIdRef.current = memo.id;");
    expect(workspaceSource).toContain("setSelectedNotebookId(memo.notebookId);");
    expect(workspaceSource).toContain("recentActive={rightView === \"recent\"}");
  });
});
