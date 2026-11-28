import { expect, test } from "@playwright/test";

test("overview groups notes by category and combines descendant, status and text filters", async ({ page }) => {
  test.setTimeout(240_000);
  await page.route("**/api/v1/plugins/github/**", route => route.fulfill({ status: 404, body: "Disabled in this test" }));
  const marker = `overview-categories-${Date.now()}`;
  const notebookIds: string[] = [];
  const memoIds: string[] = [];
  const createNotebook = async (name: string, parentId: string | null = null) => {
    const response = await page.request.post("/api/v1/notebooks", { data: { name, parentId } });
    expect(response.status()).toBe(201);
    const { notebook } = await response.json();
    notebookIds.push(notebook.id);
    return notebook.id as string;
  };
  const createMemo = async (notebookId: string, suffix: string, contentMarkdown: string) => {
    const response = await page.request.post("/api/v1/memos", { data: { notebookId, title: `${marker}-${suffix}`, contentMarkdown } });
    expect(response.status()).toBe(201);
    const { memo } = await response.json();
    memoIds.push(memo.id);
    return memo.id as string;
  };
  try {
    const parentId = await createNotebook(`${marker}-parent`);
    const childId = await createNotebook(`${marker}-child`, parentId);
    const outsideId = await createNotebook(`${marker}-outside`);
    const parentMemo = await createMemo(parentId, "parent-note", "- [ ] Category parent task");
    const childMemo = await createMemo(childId, "child-note", "- [ ] Tree parent\n  - [x] Finished needle\n  - [ ] Pending sibling");
    const outsideMemo = await createMemo(outsideId, "outside-note", "- [ ] Outside category task");

    await page.goto("/");
    await page.getByRole("button", { name: "待办总览", exact: true }).click();
    await expect(page.locator(`[data-task-memo="${childMemo}"]`)).toBeVisible({ timeout: 60_000 });
    const category = page.getByRole("button", { name: "全部笔记本", exact: true });
    await category.click();
    const categorySearch = page.getByRole("textbox", { name: "搜索笔记本或路径…" });
    await expect(categorySearch).toBeFocused();
    await categorySearch.fill(`${marker}-parent / ${marker}-child`);
    await expect(page.locator(`[data-task-notebook-option="${childId}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-notebook-option="${parentId}"]`)).toHaveCount(0);
    await categorySearch.fill(`${marker}-parent`);
    await expect(page.locator(`[data-task-notebook-option="${parentId}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-notebook-option="${outsideId}"]`)).toBeHidden();
    await page.locator(`[data-task-notebook-option="${parentId}"]`).click();
    await page.getByRole("button", { name: "全部笔记本", exact: true }).click();
    const emptyCategorySearch = page.getByRole("textbox", { name: "搜索笔记本或路径…" });
    await emptyCategorySearch.fill("missing-notebook");
    await expect(page.getByText("没有找到匹配的笔记本", { exact: true })).toBeVisible();
    await emptyCategorySearch.press("Escape");
    await expect(emptyCategorySearch).toHaveCount(0);
    await page.getByRole("button", { name: "全部笔记本", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "搜索笔记本或路径…" })).toHaveValue("");
    await page.getByRole("textbox", { name: "搜索笔记本或路径…" }).press("Escape");
    await expect(page.locator(`[data-task-memo="${parentMemo}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-memo="${childMemo}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-memo="${outsideMemo}"]`)).toHaveCount(0);

    const notebookGroup = page.locator(`[data-task-notebook="${childId}"]`);
    const notebookToggle = notebookGroup.locator(":scope > button");
    await notebookToggle.click();
    await expect(page.locator(`[data-task-memo="${childMemo}"]`)).toBeHidden();
    await notebookToggle.click();
    const memoGroup = page.locator(`[data-task-memo="${childMemo}"]`);
    const memoToggle = memoGroup.locator(":scope > div > button[aria-expanded], :scope > button[aria-expanded]");
    await memoToggle.click();
    await expect(memoGroup.locator("[data-task-id]")).toHaveCount(0);
    await memoToggle.click();

    await page.getByRole("textbox", { name: "搜索待办内容或笔记…" }).fill("Finished needle");
    await page.locator("[data-task-status-filters] button[aria-pressed]").filter({ hasText: "已完成" }).click();
    await expect(memoGroup.locator("[data-task-id]")).toHaveCount(2);
    await expect(memoGroup.locator("[data-task-context]")).toContainText("Tree parent");
    await expect(memoGroup.locator('[data-task-status="done"]')).toContainText("Finished needle");
    await expect(page.locator(`[data-task-memo="${parentMemo}"]`)).toHaveCount(0);
    await expect(page.getByText("Pending sibling", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("task-overview-grouped-filtered.png") });

    await page.getByRole("textbox", { name: "搜索待办内容或笔记…" }).fill("No matching task");
    await expect(page.getByText("没有匹配的待办", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "搜索待办内容或笔记…" })).toHaveValue("");
    await expect(page.locator(`[data-task-memo="${outsideMemo}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-memo="${parentMemo}"]`)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(`[data-task-memo="${childMemo}"]`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("task-overview-grouped-mobile.png") });
  } finally {
    for (const memoId of memoIds) {
      await page.request.delete(`/api/v1/memos/${memoId}`);
      await page.request.delete(`/api/v1/memos/${memoId}?permanent=1`);
    }
    for (const notebookId of notebookIds.reverse()) await page.request.delete(`/api/v1/notebooks/${notebookId}`);
  }
});
