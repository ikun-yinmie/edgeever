import { expect as baseExpect, test } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 90_000 });

test("reload preserves ordered tabs and the middle selection, and never resurrects closed tabs", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const marker = `Tab restore ${Date.now()}`;
  const memoIds: string[] = [];
  const notebookIds: string[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await page.request.post("/api/v1/notebooks", { data: { name: `${marker} ${index}` } });
      expect(response.ok()).toBe(true);
      notebookIds.push((await response.json()).notebook.id);
    }
    for (let index = 0; index < 3; index += 1) {
      const response = await page.request.post("/api/v1/memos", {
        data: { notebookId: notebookIds[index % 2], title: `Restore ${index}`, contentMarkdown: `Body ${marker} ${index}` },
      });
      expect(response.ok()).toBe(true);
      memoIds.push((await response.json()).memo.id);
    }
    await page.goto("/");
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("edgeever.web.workspace-restore:")) localStorage.removeItem(key);
      }
    });
    await page.reload();
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    // Route navigation opens each memo through the same public deep link used
    // by plugins and new windows. Full reloads between opens also prove append.
    for (const id of memoIds) {
      await page.goto(`/?openMemo=${encodeURIComponent(id)}`);
      await expect(page.locator(`[data-memo-tab-id="${id}"]`)).toHaveAttribute("aria-selected", "true");
    }
    const tabs = page.locator("[data-memo-tab-id]");
    await expect(tabs).toHaveCount(3);
    await page.locator(`[data-memo-tab-id="${memoIds[1]}"]`).click();
    await expect(page.locator(`[data-memo-tab-id="${memoIds[1]}"]`)).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    await expect(tabs).toHaveCount(3);
    await expect.poll(() => tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-memo-tab-id")))).toEqual(memoIds);
    await expect(tabs).toHaveText(["Restore 0", "Restore 1", "Restore 2"]);
    await expect(page.locator(`[data-memo-tab-id="${memoIds[1]}"]`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByPlaceholder("无标题")).toHaveValue("Restore 1");

    const closeTab = async (id: string) => {
      const wrapper = page.locator(`[data-memo-tab-wrapper-id="${id}"]`);
      await wrapper.hover();
      await wrapper.locator('button:not([role="tab"])').click();
    };
    await closeTab(memoIds[1]);
    await page.reload();
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    await expect.poll(() => tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-memo-tab-id")))).toEqual([memoIds[0], memoIds[2]]);
    await expect(page.locator(`[data-memo-tab-id="${memoIds[2]}"]`)).toHaveAttribute("aria-selected", "true");
    await closeTab(memoIds[0]);
    await closeTab(memoIds[2]);
    await expect(tabs).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    await expect(tabs).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toHaveCount(0);
    // A second reload catches an automatic first-note selection persisted by
    // the first reload after closing the final tab.
    await page.reload();
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    await expect(tabs).toHaveCount(0);
    await expect(page.locator(".ProseMirror")).toHaveCount(0);
  } finally {
    test.setTimeout(testInfo.timeout + 60_000);
    for (const id of memoIds) {
      await page.request.delete(`/api/v1/memos/${id}`);
      await page.request.delete(`/api/v1/memos/${id}?permanent=1`);
    }
    for (const id of notebookIds) await page.request.delete(`/api/v1/notebooks/${id}`);
  }
});
