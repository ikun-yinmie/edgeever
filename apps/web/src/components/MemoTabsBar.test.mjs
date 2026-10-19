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

  test("scrolls the active tab into view and truncates long titles", () => {
    expect(source).toContain('scrollIntoView({ block: "nearest", inline: "nearest" })');
    expect(source).toContain("truncate");
    expect(source).toContain("max-w-[220px]");
  });
});
