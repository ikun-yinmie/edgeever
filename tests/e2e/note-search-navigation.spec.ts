import { expect, test, type Locator } from "@playwright/test";

test("navigates global search highlights and hands off to in-note search", async ({ page }) => {
  test.setTimeout(90_000);
  const marker = `search-navigation-${Date.now()}`;
  const notebooksResponse = await page.request.get("/api/v1/notebooks");
  expect(notebooksResponse.ok()).toBe(true);
  const { notebooks } = await notebooksResponse.json() as { notebooks: Array<{ id: string }> };
  const notebookId = notebooks[0]?.id;
  expect(notebookId).toBeTruthy();
  const createdMemoIds: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const createMemo = async (title: string, contentMarkdown: string) => {
    const response = await page.request.post("/api/v1/memos", {
      data: { notebookId, title, contentMarkdown },
    });
    expect(response.status()).toBe(201);
    const { memo } = await response.json() as { memo: { id: string } };
    createdMemoIds.push(memo.id);
    return memo;
  };

  const expectActiveMatchVisible = async (editor: Locator) => {
    await expect.poll(async () => editor.evaluate((element) => {
      const active = element.querySelector(".edgeever-search-match-active");
      const container = element.closest("[data-editor-theme]");
      if (!active || !container) return false;
      const matchRect = active.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return matchRect.top >= containerRect.top && matchRect.bottom <= containerRect.bottom;
    })).toBe(true);
  };

  try {
    const first = await createMemo(`${marker} first`, [
      `First ${marker}.`,
      ...Array.from({ length: 20 }, (_, index) => `Filler paragraph ${index}.`),
      `${"A long paragraph. ".repeat(150)}Middle ${marker}. ${"More text. ".repeat(150)}`,
      ...Array.from({ length: 20 }, (_, index) => `More filler paragraph ${index}.`),
      `Last ${marker}.`,
    ].join("\n\n"));
    const second = await createMemo(`${marker} second`, `Only ${marker}.`);
    const titleOnly = await createMemo(`${marker} title only`, "No matching text in this note.");

    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    const globalSearch = page.getByPlaceholder("搜索笔记", { exact: true });
    await globalSearch.fill(marker);
    const openMemo = async (id: string) => {
      await page.locator(`[data-memo-id="${id}"]`).locator("button").first().click();
    };
    await openMemo(first.id);
    const editor = page.locator(".ProseMirror").first();
    const navigation = page.locator('[data-note-search-mode="content"]');
    const counter = navigation.locator('[aria-live="polite"]');
    const next = navigation.getByRole("button", { name: "下一个搜索结果", exact: true });
    const previous = navigation.getByRole("button", { name: "上一个搜索结果", exact: true });

    await expect(editor).toContainText(`First ${marker}.`);
    await expect(editor.locator(".edgeever-search-match")).toHaveCount(3);
    await expect(counter).toHaveText("1/3");
    await expectActiveMatchVisible(editor);

    await next.click();
    await expect(counter).toHaveText("2/3");
    await expect(editor.locator(".edgeever-search-match").nth(1)).toHaveClass(/edgeever-search-match-active/);
    await expectActiveMatchVisible(editor);
    await page.screenshot({ path: test.info().outputPath("search-navigation.png") });
    await page.getByRole("radio", { name: "预览", exact: true }).click();
    await next.click();
    await expect(counter).toHaveText("3/3");
    await expectActiveMatchVisible(editor);
    await next.click();
    await expect(counter).toHaveText("1/3");
    await previous.click();
    await expect(counter).toHaveText("3/3");
    await expectActiveMatchVisible(editor);
    await page.getByRole("radio", { name: "编辑", exact: true }).click();

    await navigation.getByRole("button", { name: `在当前笔记内搜索: ${marker}`, exact: true }).click();
    const noteSearch = page.locator('[data-note-search-mode="note"]');
    const noteSearchInput = noteSearch.getByPlaceholder("在当前笔记内搜索");
    await expect(noteSearchInput).toHaveValue(marker);
    await expect(noteSearchInput).toBeFocused();
    await expect(noteSearch.getByPlaceholder("替换为")).toHaveCount(0);
    await noteSearchInput.press("Enter");
    await expect(noteSearch.locator('[aria-live="polite"]')).toHaveText("2/3");
    await noteSearchInput.press("Shift+Enter");
    await expect(noteSearch.locator('[aria-live="polite"]')).toHaveText("1/3");
    await noteSearchInput.fill("Middle");
    await expect(noteSearch.locator('[aria-live="polite"]')).toHaveText("1/1");
    await noteSearchInput.press("Escape");
    await expect(navigation).toBeVisible();
    await expect(counter).toHaveText("1/3");
    await expect(globalSearch).toHaveValue(marker);

    await previous.click();
    await expect(counter).toHaveText("3/3");
    await openMemo(second.id);
    await expect(editor).toContainText(`Only ${marker}.`);
    await expect(counter).toHaveText("1/1");
    await next.click();
    await expect(counter).toHaveText("1/1");
    await expectActiveMatchVisible(editor);

    await openMemo(titleOnly.id);
    await expect(editor).toContainText("No matching text");
    await expect(counter).toHaveText("0/0");
    await expect(next).toBeDisabled();
    await expect(previous).toBeDisabled();

    await openMemo(first.id);
    await expect(counter).toHaveText("1/3");
    await expectActiveMatchVisible(editor);
    await previous.click();
    await expect(counter).toHaveText("3/3");
    await editor.locator(".edgeever-search-match-active").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(` Added ${marker}.`);
    await expect(counter).toHaveText("3/4");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(counter).toHaveText("3/3");
    await globalSearch.fill("Middle");
    await expect(counter).toHaveText("1/1");
    await expect(editor.locator(".edgeever-search-match-active")).toHaveText("Middle");
    await expectActiveMatchVisible(editor);
    await globalSearch.fill("");
    await expect(navigation).toHaveCount(0);
    await expect(editor.locator(".edgeever-search-match")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    for (const id of createdMemoIds) {
      await page.request.delete(`/api/v1/memos/${id}`);
      await page.request.delete(`/api/v1/memos/${id}?permanent=1`);
    }
  }
});
