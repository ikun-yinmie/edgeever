import { expect, test } from "@playwright/test";

test("operates nested notebook search results without leaving the search", async ({ page }) => {
  test.setTimeout(90_000);
  const marker = Date.now();
  const parentName = `分类搜索-${marker}`;
  const childName = `子分类-${marker}`;
  const grandchildName = `孙分类-${marker}`;
  const notebookIds: string[] = [];
  const memoIds: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const createNotebook = async (name: string, parentId: string | null = null) => {
    const response = await page.request.post("/api/v1/notebooks", { data: { name, parentId } });
    expect(response.status()).toBe(201);
    const { notebook } = await response.json() as { notebook: { id: string } };
    notebookIds.push(notebook.id);
    return notebook.id;
  };

  try {
    const parentId = await createNotebook(parentName);
    const childId = await createNotebook(childName, parentId);
    const grandchildId = await createNotebook(grandchildName, childId);
    const response = await page.request.post("/api/v1/memos", {
      data: { notebookId: grandchildId, title: `定位测试-${marker}`, contentMarkdown: "分类搜索操作测试" },
    });
    expect(response.status()).toBe(201);
    const { memo } = await response.json() as { memo: { id: string } };
    memoIds.push(memo.id);

    await page.goto("/");
    const sidebar = page.locator("#edgeever-notebook-sidebar");
    const search = sidebar.getByRole("searchbox", { name: "搜索笔记本", exact: true });
    const row = (id: string) => sidebar.locator(`[data-notebook-id="${id}"]`);
    const select = (id: string) => row(id).locator("[data-notebook-tree-button]").click();
    const parentToggle = () => row(parentId).getByRole("button", { name: new RegExp(`^(展开|收起) ${parentName}$`) });
    const childToggle = () => row(childId).getByRole("button", { name: /^(展开|收起) / });

    await expect(parentToggle()).toHaveAttribute("aria-expanded", "false");
    await search.fill(parentName);
    await expect(row(grandchildId)).toBeVisible();
    await parentToggle().click();
    await expect(row(childId)).toHaveCount(0);
    await expect(search).toHaveValue(parentName);
    await parentToggle().click();
    await expect(row(grandchildId)).toBeVisible();
    await childToggle().click();
    await expect(row(grandchildId)).toHaveCount(0);
    await select(childId);
    await expect(search).toHaveValue(parentName);
    await expect(row(childId).locator("[data-notebook-tree-button]")).toHaveAttribute("aria-current", "page");
    await expect(childToggle()).toHaveAttribute("aria-expanded", "false");

    await search.press("Enter");
    await expect(row(parentId).locator("[data-notebook-tree-button]")).toHaveAttribute("aria-current", "page");
    await expect(search).toHaveValue(parentName);
    await expect(childToggle()).toHaveAttribute("aria-expanded", "false");
    await row(childId).hover();
    await row(childId).getByRole("button", { name: `打开 ${childName} 的操作菜单`, exact: true }).click();
    await row(childId).getByRole("button", { name: "重命名", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "重命名笔记本", exact: true });
    const renamedChild = `${childName}-已改名`;
    await renameDialog.getByLabel("名称", { exact: true }).fill(renamedChild);
    await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(renameDialog).toHaveCount(0);
    await expect(row(childId)).toContainText(renamedChild);
    await expect(search).toHaveValue(parentName);
    await expect(childToggle()).toHaveAttribute("aria-expanded", "false");
    await expect(row(grandchildId)).toHaveCount(0);

    await row(childId).click({ button: "right" });
    await page.getByRole("menuitem", { name: "新建子笔记本", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await expect(search).toHaveValue(parentName);
    await page.screenshot({ path: test.info().outputPath("notebook-search-actions.png") });
    await row(parentId).locator("[data-notebook-tree-button]").press("*");
    await parentToggle().click();
    await expect(row(childId)).toHaveCount(0);

    await sidebar.getByRole("button", { name: "清空搜索", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(parentToggle()).toHaveAttribute("aria-expanded", "false");
    await expect(row(childId)).toHaveCount(0);
    await parentToggle().click();
    await expect(childToggle()).toHaveAttribute("aria-expanded", "false");
    await select(childId);
    await expect(row(grandchildId)).toBeVisible();

    await search.fill(grandchildName);
    await expect(row(grandchildId)).toBeVisible();
    await childToggle().click();
    await expect(row(grandchildId)).toHaveCount(0);
    await search.fill(parentName);
    await expect(row(grandchildId)).toBeVisible();
    await select(grandchildId);
    await expect(search).toHaveValue(parentName);
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await expect(page.locator(".ProseMirror").first()).toContainText("分类搜索操作测试");

    const missingQuery = `不存在-${marker}`;
    await search.fill(missingQuery);
    await expect(sidebar.locator("[data-notebook-search-empty]")).toBeVisible();
    await search.press("Enter");
    await expect(search).toHaveValue(missingQuery);
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(row(grandchildId)).toBeVisible();
    await search.fill(missingQuery);
    await page.getByRole("button", { name: "在侧栏定位所在笔记本", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(row(grandchildId)).toBeVisible();
    await expect(row(grandchildId).locator("[data-notebook-tree-button]")).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: test.info().outputPath("notebook-search-reveal.png") });
    expect(pageErrors).toEqual([]);
  } finally {
    for (const id of memoIds) {
      await page.request.delete(`/api/v1/memos/${id}`);
      await page.request.delete(`/api/v1/memos/${id}?permanent=1`);
    }
    for (const id of notebookIds.reverse()) {
      await page.request.delete(`/api/v1/notebooks/${id}`);
    }
  }
});
