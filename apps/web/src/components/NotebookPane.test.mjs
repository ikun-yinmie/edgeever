import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./NotebookPane.tsx", import.meta.url), "utf8");

test("keeps proactive AI out of primary navigation", () => {
  const primaryNav = source.split('aria-label={t("notebookPane.entries")}>')[1]?.split("</nav>")[0];
  expect(primaryNav).toContain('label={t("notebookPane.allMemos")}');
  expect(primaryNav).not.toContain('label={t("companion.navTitle")}');
  expect(primaryNav).not.toContain("onClick={onOpenCompanion}");
});

test("keeps the desktop create-note control a soft pill split button without card chrome", () => {
  const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
  const createControl = source.split("edgeever-create-memo-split ")[1]?.split("</DropdownMenu>")[0] ?? "";

  expect(source).toContain("edgeever-create-memo-split flex h-10 items-center rounded-full bg-emerald-100");
  expect(createControl).toContain('aria-label={t("notebookPane.newMemo")}');
  expect(createControl).toContain('aria-label={t("diagram.createType")}');
  expect(createControl).toContain('t("diagram.moreTypes")}');
  expect(createControl).toContain("hover:bg-emerald-200/60");
  expect(createControl).not.toContain("bg-white/25");
  expect(source).not.toContain("rounded-2xl border border-slate-200/90");
  expect(source).not.toContain("rounded-full bg-emerald-500 text-white shadow-");
  expect(source).not.toContain("edgeever-create-memo-split__more-label");
  expect(css).not.toContain("__more-label");
  expect(css).not.toContain("@container (max-width: 11.749rem)");
  expect(source).not.toContain('focus-visible:ring-inset focus-visible:ring-emerald-500');
  expect(source).not.toContain('title={t("notebookPane.newMemo")}');
});

test("keeps the desktop sync status bar and sidebar chrome compact without shrinking primary controls", () => {
  const syncBar = source.split("const SyncStatusBar")[1]?.split("export const NotebookPane")[0];

  expect(syncBar).toContain("flex h-8 items-center gap-2 rounded-full px-3");
  expect(syncBar).toContain('rounded-full bg-emerald-500"');
  expect(syncBar).not.toContain("rounded-md border");
  expect(syncBar).not.toContain("min-h-10");
  expect(syncBar).not.toContain("py-2");
  expect(syncBar).not.toContain("mb-3");
  expect(source).toContain('className="px-3 pt-1.5"');
  expect(source).toContain('className="hidden shrink-0 px-3 pb-2 pt-2 lg:block"');
  expect(source).toContain("edgeever-create-memo-split flex h-10 items-center rounded-full bg-emerald-100");
  expect(source).toContain("mb-1 hidden h-8 w-full items-center justify-start gap-2");
  expect(source).toContain('className="mb-1 space-y-1"');
  expect(source).not.toContain("mb-3 hidden h-8 w-full");
  expect(source).not.toContain('className="mb-3 space-y-1"');
  expect(source).not.toContain("mb-2 hidden h-8 w-full");
  expect(source).not.toContain('className="mb-2 space-y-1"');
});

test("lists diagram note types in the create menu without beta badges", () => {
  const createTypeMenu = source.split("const CreateMemoTypeItems")[1]?.split("const getSyncStatusLabel")[0];

  expect(createTypeMenu).toContain('onCreateMemo()');
  expect(createTypeMenu).toContain('onCreateMemo("mind-map")');
  expect(createTypeMenu).toContain('onCreateMemo("flowchart")');
  expect(createTypeMenu).toContain('onCreateMemo("architecture")');
  expect(createTypeMenu).not.toContain("DiagramBetaBadge");
  expect(createTypeMenu).not.toContain("Beta");
});

describe("NotebookPane sidebar collapse", () => {
  test("places a desktop-only collapse control in the footer and keeps an expand control when collapsed", () => {
    const expandedFooter = source.split('pwa.sidebarDownloadsTitle')[1]?.split(") : (")[0] ?? source;
    const profileRow = expandedFooter.split('aria-label={t("notebookPane.profile")}')[1]?.split("</div>")[0];

    expect(source).toContain("SidebarCollapseButton");
    expect(source).toContain('t(collapsed ? "notebookPane.expandSidebar" : "notebookPane.collapseSidebar")');
    expect(source).toContain("aria-controls={NOTEBOOK_SIDEBAR_ID}");
    expect(source).toContain('className="hidden lg:inline-flex"');
    expect(source).toContain('collapsed && "hidden"');
    expect(source).toContain("<ChevronsLeft");
    expect(source).toContain("<ChevronsRight");
    expect(profileRow).toContain("<SidebarCollapseButton");
    expect(profileRow.indexOf('t("notebookPane.profile")')).toBeLessThan(profileRow.indexOf("<SidebarCollapseButton"));
  });

  test("renders an icon rail of primary destinations while the notebook tree is collapsed", () => {
    const rail = source.split('data-notebook-sidebar-rail')[1]?.split(") : (")[0];

    expect(rail).toContain('aria-label={t("notebookPane.newMemo")}');
    expect(rail).toContain("<LayoutGrid");
    expect(rail).toContain('label={t("notebookPane.allMemos")}');
    expect(rail).toContain('label={t("notebookPane.notebooks")}');
    expect(rail).toContain('label={t("mobileSheets.tags")}');
    expect(rail).toContain('label={t("notebookPane.trash")}');
    expect(rail).toContain("<SidebarCollapseButton collapsed");
    expect(rail).toContain('tooltipSide="right"');
  });

  test("wires the desktop workspace grid to a collapsed notebook column", () => {
    const workspace = readFileSync(new URL("./WorkspaceApp.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

    expect(workspace).toContain("desktopNotebookSidebarCollapsed");
    expect(workspace).toContain("edgeever-workspace-grid--sidebar-collapsed");
    expect(workspace).toContain('id="edgeever-notebook-sidebar"');
    expect(workspace).toContain("collapsed={desktopNotebookSidebarCollapsed}");
    expect(css).toContain(".edgeever-workspace-grid--sidebar-collapsed");
    expect(css).toContain("var(--notebook-sidebar-width)");
    expect(css).toContain("--notebook-sidebar-width: 3.5rem;");
  });
});

describe("NotebookPane tree expansion", () => {
  test("keeps branches collapsed by default and only opens the last note's path", () => {
    const treeItemSource = readFileSync(new URL("./NotebookTreeItem.tsx", import.meta.url), "utf8");

    expect(source).toContain("const [expandedNotebookIds, setExpandedNotebookIds] = useState<Set<string>>(() => new Set());");
    expect(source).toContain("expandedNotebookIds={expandedNotebookIds}");
    expect(source).toContain("getNotebookAncestorIds(tree, selectedNotebookId)");
    expect(source).not.toContain("readNotebookTreeCollapsedIdsPreference");
    expect(treeItemSource).toContain("const open = expandedNotebookIds.has(node.id)");
    expect(treeItemSource).not.toContain("const [open, setOpen] = useState(true)");
    expect(treeItemSource).not.toContain("if (hasSelectedDescendant) {");
  });

  test("exposes the recent-notes home from both the nav list and the collapsed rail", () => {
    const rail = source.split('data-notebook-sidebar-rail')[1]?.split(") : (")[0];

    expect(source).toContain('label={t("recentMemos.title")}');
    expect(source).toContain("onClick={onOpenRecent}");
    expect(rail).toContain('label={t("recentMemos.title")}');
  });

  test("keeps the tree scroll anchored while expanding unrelated branches", () => {
    expect(source).toContain("const scrolledSelectionRef = useRef<string | null>(null);");
    expect(source).toContain("if (scrolledSelectionRef.current === selectedNotebookId)");
    expect(source).toContain("expandedPathNotebookIdRef.current = null;");
    expect(source).toContain("scrolledSelectionRef.current = selectedNotebookId;");
  });
});

describe("NotebookPane client downloads", () => {
  test("keeps macOS, Windows, and Linux downloads visible in the desktop runtime", () => {
    expect(source).toContain('t("pwa.sidebarMac") || "macOS"');
    expect(source).toContain('t("pwa.sidebarWindows") || "Windows"');
    expect(source).toContain('t("pwa.sidebarLinux") || "Linux"');
    expect(source).not.toContain("!window.edgeeverDesktop?.isAvailable");
  });

  test("labels Windows and Linux by package format instead of a preview badge", () => {
    const downloads = source.split('pwa.sidebarDownloadsTitle')[1]?.split("</DropdownMenu>")[0];

    expect(downloads).toContain(">AppImage</span>");
    expect(downloads).toContain(">EXE</span>");
    expect(downloads).toContain('t("pwa.sidebarLinuxAvailability")');
    expect(downloads).toContain('t("pwa.sidebarWindowsAvailability")');
    expect(downloads).toContain("<Tooltip>");
    expect(downloads).not.toContain("sidebarLinuxBadge");
    expect(downloads).not.toContain("sidebarWindowsBadge");
    expect(downloads).not.toContain('|| "Preview"');
    expect(downloads).not.toContain("bg-amber-50");
  });

  test("renders platform icons inline so desktop protocols do not break them", () => {
    expect(source).toContain("<BrandIcon path={APPLE_ICON_PATH}");
    expect(source).toContain("<BrandIcon path={WINDOWS_ICON_PATH}");
    expect(source).toContain('<BrandIcon path={LINUX_ICON_PATH} className="h-4 w-4"');
    expect(source).toContain("<GooglePlayIcon />");
    expect(source).toContain("<AppStoreIcon />");
    expect(source).not.toContain('src="/icons/platforms/');
  });
});

describe("NotebookPane shared sections", () => {
  test("defaults the group and my-shares sections to collapsed", () => {
    expect(source).toContain("const [groupSectionOpen, setGroupSectionOpen] = useState(false);");
    expect(source).toContain("const [mySharesSectionOpen, setMySharesSectionOpen] = useState(false);");
  });

  test("keeps the section headers toggling and their rows clickable", () => {
    expect(source).toContain("onClick={() => setGroupSectionOpen((open) => !open)}");
    expect(source).toContain("onClick={() => setMySharesSectionOpen((open) => !open)}");

    const sharedSections = source.split("data-group-section")[1]?.split("{collapsed && onToggleCollapsed")[0] ?? "";
    expect(sharedSections).toContain('onClick={() => onOpenShared?.("link")}');
    expect(sharedSections).toContain('onClick={() => onOpenShared?.("group")}');
    expect(sharedSections).toContain("onClick={() => onOpenShared?.({ groupId: group.id })}");
    expect(source.match(/onClick=\{\(\) => onOpenShared\?\.\(\)\}/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("forwards notebook-scoped create-note requests to the tree", () => {
    expect(source).toContain("onCreateMemoInNotebook?: (notebookId: string, kind?: DiagramKind) => void;");
    expect(source).toContain("onCreateMemo={onCreateMemoInNotebook}");
  });
});
