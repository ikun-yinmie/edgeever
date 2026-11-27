import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { zhCN } from "../../../../packages/shared/src/i18n/zh-CN.ts";
import { enUS } from "../../../../packages/shared/src/i18n/en-US.ts";
import { ja } from "../../../../packages/shared/src/i18n/ja.ts";
import { MemoStatusBadge } from "./MemoStatusBadge.tsx";
import { MemoStatusMenu } from "./MemoStatusMenu.tsx";
import { MemoCard } from "./MemoCard.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const catalogs = { "zh-CN": zhCN, "en-US": enUS, ja };
const statuses = ["in_progress", "completed", "cancelled"];
const render = async (component, lng = "zh-CN") => {
  const i18n = createInstance();
  await i18n.init({ lng, resources: Object.fromEntries(Object.entries(catalogs).map(([key, value]) => [key, { translation: value }])) });
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(TooltipProvider, null, component)));
};

const card = (status) => createElement(MemoCard, {
  memo: {
    id: "status-note", title: "Status note title", excerpt: "Original excerpt", tags: [],
    notebookId: "notebook", createdAt: "2026-11-27T12:00:00Z", updatedAt: "2026-11-27T12:00:00Z",
    status,
  },
  selected: false, checked: false, dragMemoIds: [], isTrashView: false,
  selectionMode: false, listDensity: "compact", sortMode: "updated-desc", multiSelectKeyDown: false,
  onOpen() {}, onRestore() {}, onDelete() {}, onOpenContextMenu() {}, onOpenSelectionContextMenu() {},
  onOpenSelectionKeyboardContextMenu() {}, onOpenKeyboardContextMenu() {}, onToggle() {},
});

describe("optional memo status UI", () => {
  test("legacy and cleared notes render no badge or implicit status", async () => {
    for (const status of [undefined, null]) {
      expect(await render(createElement(MemoStatusBadge, { status }))).toBe("");
      const html = await render(card(status));
      expect(html).toContain("Status note title");
      expect(html).not.toContain("data-memo-status");
      for (const label of statuses.map(value => zhCN.memoStatus[value])) expect(html).not.toContain(label);
    }
  });

  for (const [lng, catalog] of Object.entries(catalogs)) {
    for (const status of statuses) {
      test(`${lng} ${status} has visible localized text and a decorative icon`, async () => {
        const html = await render(createElement(MemoStatusBadge, { status }), lng);
        expect(html).toContain(`data-memo-status="${status}"`);
        expect(html).toContain(catalog.memoStatus[status]);
        expect(html).toContain('aria-hidden="true"');
        expect(html).not.toContain("memoStatus.");
        expect(html).not.toMatch(/\stitle=/);
      });
    }
    test(`${lng} menu has an accessible text entry, follows read-only, and never defaults a badge`, async () => {
      const html = await render(createElement(MemoStatusMenu, { disabled: true, onStatusChange() {} }), lng);
      expect(html).toContain(`aria-label="${catalog.memoStatus.menu}"`);
      expect(html).toContain(`>${catalog.memoStatus.menu}</span>`);
      expect(html).toContain('disabled=""');
      expect(html).not.toContain("data-memo-status");
      expect(html).not.toMatch(/\stitle=/);
      expect(catalog.memoStatus.clear).toBeTruthy();
      expect(catalog.memoStatus.saveError).toBeTruthy();
    });
  }

  test("each list badge follows the title and preserves the excerpt", async () => {
    for (const status of statuses) {
      const html = await render(card(status));
      expect(html.indexOf("Status note title")).toBeLessThan(html.indexOf(`data-memo-status="${status}"`));
      expect(html).toContain(zhCN.memoStatus[status]);
      expect(html).toContain("Original excerpt");
    }
  });
});
