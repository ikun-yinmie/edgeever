import { expect, test, type Locator } from "@playwright/test";

test("rebuilds outlines and phone preview when a reused editor switches notes", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const marker = `outline-isolation-${Date.now()}`;
  const created: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.request.get("/api/v1/notebooks");
  expect(response.ok()).toBe(true);
  const { notebooks } = await response.json() as { notebooks: Array<{ id: string }> };
  const notebookId = notebooks[0]?.id;
  expect(notebookId).toBeTruthy();

  const create = async (name: string, contentMarkdown: string) => {
    const result = await page.request.post("/api/v1/memos", {
      data: { notebookId, title: `${marker} ${name}`, contentMarkdown },
    });
    expect(result.status()).toBe(201);
    const { memo } = await result.json() as { memo: { id: string } };
    created.push(memo.id);
    return memo.id;
  };
  const outline = page.getByRole("complementary", { name: "文档大纲", exact: true });
  const editor = page.locator(".ProseMirror").first();
  const open = async (id: string, text: string) => {
    await page.locator(`[data-memo-id="${id}"]`).locator("button").first().click();
    await expect(editor).toContainText(text, { timeout: 60_000 });
  };
  const showOutline = async () => {
    await expect(outline).toBeAttached();
    const toggle = outline.getByRole("button", { name: /^显示文档大纲/ });
    if (await toggle.count()) await toggle.click();
    await expect(outline.getByRole("navigation")).toBeVisible();
  };
  const expectHeadings = async (root: Locator, names: string[]) => {
    await expect(root.locator("li > div > button:last-child")).toHaveText(names);
  };

  try {
    // A and B deliberately share heading counts and positions.
    const first = await create("A", "# Alpha root\n\n## Alpha child\n\nAlpha body.");
    const second = await create("B", "# Bravo root\n\n## Bravo child\n\nBravo body.");
    const empty = await create("C", "Charlie body without any headings.");
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.getByPlaceholder("搜索笔记", { exact: true }).fill(marker);

    await open(first, "Alpha body.");
    await showOutline();
    await expectHeadings(outline, ["Alpha root"]);
    await outline.getByRole("button", { name: "全部展开", exact: true }).click();
    await expectHeadings(outline, ["Alpha root", "Alpha child"]);

    await open(second, "Bravo body.");
    await showOutline();
    await expectHeadings(outline, ["Bravo root"]);
    await expect(outline).not.toContainText("Alpha");
    await outline.getByRole("button", { name: "全部展开", exact: true }).click();
    await outline.getByRole("button", { name: "Bravo child", exact: true }).click();
    await expect(outline.getByRole("button", { name: "Bravo child", exact: true })).toHaveAttribute("aria-current", "location");

    await open(empty, "Charlie body");
    await expect(outline).toHaveCount(0);
    await open(first, "Alpha body.");
    await showOutline();
    await expectHeadings(outline, ["Alpha root"]);
    await expect(outline).not.toContainText("Bravo");

    const moreTools = page.getByRole("button", { name: "显示更多编辑工具", exact: true });
    if (await moreTools.count()) await moreTools.click();
    await page.getByRole("button", { name: "显示手机预览", exact: true }).click();
    const preview = page.getByRole("complementary", { name: "手机预览", exact: true });
    await expect(preview).toContainText("Alpha root");
    await open(second, "Bravo body.");
    await expect(preview).toContainText("Bravo root");
    await expect(preview).not.toContainText("Alpha root");
    await open(empty, "Charlie body");
    await expect(preview).toContainText("Charlie body");
    await expect(preview).not.toContainText("Bravo root");
    await expect(outline).toHaveCount(0);

    // Resize without remounting the editor to exercise the mobile consumer.
    await open(first, "Alpha body.");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTrigger = page.locator('[data-mobile-outline-trigger="true"]');
    await expect(mobileTrigger).toBeVisible();
    await mobileTrigger.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toContainText("Alpha root");
    await expect(drawer).toContainText("Alpha child");
    await drawer.getByRole("button", { name: "Alpha child", exact: true }).click();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await open(empty, "Charlie body");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mobileTrigger).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const id of created) {
      await page.request.delete(`/api/v1/memos/${id}`);
      await page.request.delete(`/api/v1/memos/${id}?permanent=1`);
    }
  }
});
