import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./MemoTabsBar.tsx", import.meta.url), "utf8");

describe("memo tabs bar", () => {
  test("renders an accessible tablist with tab semantics", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("aria-selected={active}");
    expect(source).toContain('aria-label={t("memoTabs.label")}');
    expect(source).toContain("data-memo-tab-id={tab.id}");
  });

  test("closes tabs through the close button and the middle click", () => {
    expect(source).toContain("onClick={() => onClose(tab.id)}");
    expect(source).toContain("event.button === 1");
    expect(source).toContain('aria-label={t("memoTabs.close")}');
  });

  test("keeps tooltips on the shadcn component instead of the native title attribute", () => {
    expect(source).toContain('<TooltipContent side="bottom">{tab.title}</TooltipContent>');
    expect(source).not.toContain("title=");
  });

  test("offers close, close-others, close-all, and new-window actions on right click", () => {
    expect(source).toContain("<ContextMenu");
    expect(source).toContain("onSelect={() => onCloseOthers(tab.id)}");
    expect(source).toContain("onSelect={onCloseAll}");
    expect(source).toContain("onSelect={() => onOpenInNewWindow(tab.id)}");
    expect(source).toContain('t("memoTabs.closeCurrent")');
    expect(source).toContain('t("memoTabs.closeOthers")');
    expect(source).toContain('t("memoTabs.closeAll")');
    expect(source).toContain('t("memoTabs.openInNewWindow")');
  });

  test("reveals the note's mirrored Markdown file only when it exists", () => {
    expect(source).toContain("canRevealMemoMarkdown()");
    expect(source).toContain("refreshLocalMarkdownAvailability(tab.id)");
    expect(source).toContain("isMemoMarkdownAvailable(memoId)");
    expect(source).toContain("revealMemoMarkdown(tab.id)");
    expect(source).toContain("localMarkdownMemoIds[tab.id]");
    expect(source).not.toContain("revealLocalStorage()");
    expect(source).toContain('t("common.showInFileManager")');
  });

  test("reorders visible tabs with native drag and drop", () => {
    expect(source).toContain("draggable");
    expect(source).toContain("onDragStart={(event) => handleDragStart(event, tab.id)}");
    expect(source).toContain("onDrop={(event) => handleDrop(event, tab.id)}");
    expect(source).toContain("onReorder(sourceMemoId, memoId)");
    expect(source).toContain("dataTransfer.effectAllowed");
  });

  test("keeps one row and replaces scrolling with an overflow dropdown", () => {
    expect(source).not.toContain("overflow-x-auto");
    expect(source).not.toContain("scrollIntoView");
    expect(source).toContain("resolveMemoTabOverflow");
    expect(source).toContain("hiddenTabs");
    expect(source).toContain("max-h-72");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain("data-overflow-memo-tab-id={tab.id}");
    expect(source).toContain('t("memoTabs.more")');
  });

  test("filters the overflow dropdown with a focused search field", () => {
    expect(source).toContain('t("memoTabs.searchPlaceholder")');
    expect(source).toContain('t("memoTabs.noSearchResults")');
    expect(source).toContain("overflowQuery.trim().toLocaleLowerCase()");
    expect(source).toContain("overflowSearchRef.current?.focus()");
    expect(source).toContain("overflowTabs.map((tab) =>");
  });

  test("closes a tab directly from the overflow dropdown", () => {
    expect(source).toContain('data-overflow-memo-tab-id={tab.id}');
    expect(source).toContain("onClose(tab.id)");
    expect(source).toContain('aria-label={t("memoTabs.close")}');
  });

  test("truncates long titles at the fixed tab width", () => {
    expect(source).toContain("truncate");
    expect(source).toContain("max-w-[220px]");
    expect(source).toContain("min-w-[96px]");
  });
});
