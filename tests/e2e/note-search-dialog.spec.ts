import { expect, test } from "@playwright/test";

test("loads search results beyond the first page using the keyboard", async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `Search pages ${Date.now()}`;
  const notebookResponse = await page.request.post("/api/v1/notebooks", { data: { name: marker } });
  expect(notebookResponse.status()).toBe(201);
  const { notebook } = await notebookResponse.json();
  const ids: string[] = [];
  try {
    for (let index = 0; index < 51; index += 1) {
      const response = await page.request.post("/api/v1/memos", { data: { notebookId: notebook.id, title: `${marker} ${index}` } });
      expect(response.status()).toBe(201);
      ids.push((await response.json()).memo.id);
    }
    await page.goto("/");
    await page.locator(`[data-notebook-id="${notebook.id}"] [data-notebook-tree-button]`).click();
    await page.locator("#edgeever-notebook-sidebar").getByRole("button", { name: "搜索笔记", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索笔记", exact: true });
    await dialog.getByRole("combobox").fill(marker);
    await expect(dialog.getByRole("option")).toHaveCount(50);
    await dialog.getByRole("button", { name: "加载更多", exact: true }).press("Enter");
    await expect(dialog.getByRole("option")).toHaveCount(51);
    await expect(dialog.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
    // Reopening must show the initial page even when the last page is cached.
    // Loading more can reveal the cached page again, including when nextCursor is null.
    for (let reopening = 0; reopening < 2; reopening += 1) {
      await dialog.getByRole("combobox").press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.locator("#edgeever-notebook-sidebar").getByRole("button", { name: "搜索笔记", exact: true }).click();
      await dialog.getByRole("combobox").fill(marker);
      await expect(dialog.getByRole("option")).toHaveCount(50);
      await expect(dialog.getByRole("button", { name: "加载更多", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "加载更多", exact: true }).press("Enter");
      await expect(dialog.getByRole("option")).toHaveCount(51);
      await expect(dialog.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
    }
    await dialog.getByRole("combobox").press("End");
    await dialog.getByRole("combobox").press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByPlaceholder("无标题")).toHaveValue(`${marker} 0`);
  } finally {
    for (const id of ids) {
      await page.request.delete(`/api/v1/memos/${id}`);
      await page.request.delete(`/api/v1/memos/${id}?permanent=1`);
    }
    await page.request.delete(`/api/v1/notebooks/${notebook.id}`);
  }
});

test("searches current notebook descendants or all notes without disturbing the editor", async ({ page }) => {
  test.setTimeout(90_000);
  const marker = `search-dialog-${Date.now()}`;
  const notebookIds: string[] = [];
  const memoIds: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const notebook = async (name: string, parentId: string | null = null) => {
    const response = await page.request.post("/api/v1/notebooks", { data: { name, parentId } });
    expect(response.status()).toBe(201);
    const { notebook } = await response.json();
    notebookIds.push(notebook.id);
    return notebook.id as string;
  };
  const memo = async (notebookId: string, title: string) => {
    const response = await page.request.post("/api/v1/memos", { data: { notebookId, title, contentMarkdown: `Body match ${marker}` } });
    expect(response.status()).toBe(201);
    const { memo } = await response.json();
    memoIds.push(memo.id);
    return memo.id as string;
  };

  try {
    const parentId = await notebook(`Search category ${marker}`);
    const childId = await notebook(`Child ${marker}`, parentId);
    const otherId = await notebook(`Other ${marker}`);
    const firstId = await memo(parentId, "搜索弹窗父级笔记");
    await memo(childId, "搜索弹窗子级笔记");
    const outsideId = await memo(otherId, "搜索弹窗外部笔记");
    const deletedId = await memo(parentId, "搜索弹窗已删除笔记");
    await page.request.delete(`/api/v1/memos/${deletedId}`);
    await page.goto("/");
    const sidebar = page.locator("#edgeever-notebook-sidebar");
    const parentButton = sidebar.locator(`[data-notebook-id="${parentId}"] [data-notebook-tree-button]`);
    await parentButton.click();
    await page.locator(`[data-memo-id="${firstId}"]`).locator("button").first().click();
    await expect(page.getByPlaceholder("无标题")).toHaveValue("搜索弹窗父级笔记");
    await sidebar.getByRole("button", { name: "搜索笔记", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索笔记", exact: true });
    const input = dialog.getByRole("combobox");
    await expect(input).toBeFocused();
    const scopeGroup = dialog.getByRole("group", { name: "搜索范围", exact: true });
    const scopeBounds = await scopeGroup.boundingBox();
    const inputBounds = await input.boundingBox();
    const dialogBounds = await dialog.boundingBox();
    expect(scopeBounds!.y + scopeBounds!.height).toBeLessThan(inputBounds!.y);
    expect(inputBounds!.y - dialogBounds!.y).toBeGreaterThan(48);
    await expect(dialog.getByRole("button", { name: "当前分类", exact: true })).toHaveAttribute("aria-pressed", "true");
    await input.fill(marker);
    await expect(dialog.getByRole("option")).toHaveCount(2);
    await expect(dialog.getByRole("option").filter({ hasText: "搜索弹窗子级笔记" })).toBeVisible();
    await dialog.getByRole("button", { name: "全部笔记", exact: true }).focus();
    await dialog.getByRole("button", { name: "全部笔记", exact: true }).press("Enter");
    await expect(dialog.getByRole("option")).toHaveCount(3);
    await expect(dialog).not.toContainText("搜索弹窗已删除笔记");
    await page.screenshot({ path: test.info().outputPath("note-search-dialog.png") });
    await input.fill(`missing-${marker}`);
    await expect(dialog).toContainText("没有找到匹配的笔记");
    await input.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(parentButton).toHaveAttribute("aria-current", "page");
    await expect(page.getByPlaceholder("无标题")).toHaveValue("搜索弹窗父级笔记");

    await page.keyboard.press("ControlOrMeta+Shift+k");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "当前分类", exact: true })).toHaveAttribute("aria-pressed", "true");
    await input.fill(marker);
    await input.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect(dialog.getByRole("button", { name: "全部笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await input.fill(marker);
    await dialog.getByRole("option").filter({ hasText: "搜索弹窗外部笔记" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByPlaceholder("无标题")).toHaveValue("搜索弹窗外部笔记");
    await expect(page.locator(`[data-memo-id="${outsideId}"]`)).toBeVisible();

    await sidebar.getByRole("button", { name: "全部笔记", exact: true }).click();
    await sidebar.getByRole("button", { name: "搜索笔记", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "当前分类", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "全部笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await input.press("Escape");
    await sidebar.getByRole("button", { name: "收起笔记本栏", exact: true }).click();
    await sidebar.getByRole("button", { name: "搜索笔记", exact: true }).click();
    await input.fill(marker);
    await expect(dialog.getByRole("option")).toHaveCount(3);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: test.info().outputPath("note-search-dialog-dark.png") });
    const originalViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 600 });
    const compactBounds = await dialog.boundingBox();
    expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(600);
    await page.screenshot({ path: test.info().outputPath("note-search-dialog-compact.png") });
    await input.press("Escape");
    await page.setViewportSize(originalViewport);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.goto("/settings");
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    const shortcutRow = page.getByText("打开搜索弹窗", { exact: true }).locator("../..");
    await shortcutRow.getByRole("button").click();
    await page.keyboard.press("ControlOrMeta+Alt+y");
    await expect(shortcutRow).toContainText("自定义");
    await page.keyboard.press("ControlOrMeta+Alt+y");
    await expect(dialog).toBeVisible();
    await input.press("Escape");
    expect(pageErrors).toEqual([]);
  } finally {
    for (const id of memoIds) {
      await page.request.delete(`/api/v1/memos/${id}`);
      await page.request.delete(`/api/v1/memos/${id}?permanent=1`);
    }
    for (const id of notebookIds.reverse()) await page.request.delete(`/api/v1/notebooks/${id}`);
  }
});
