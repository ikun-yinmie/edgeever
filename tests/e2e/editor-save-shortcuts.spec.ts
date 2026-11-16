import { expect, test, type Locator, type Page } from "@playwright/test";

const withMemo = async (page: Page, run: (memoId: string) => Promise<void>) => {
  const response = await page.request.get("/api/v1/notebooks");
  expect(response.ok()).toBe(true);
  const { notebooks } = await response.json() as { notebooks: Array<{ id: string }> };
  expect(notebooks[0]?.id).toBeTruthy();
  const created = await page.request.post("/api/v1/memos", {
    data: {
      notebookId: notebooks[0].id,
      title: `save-shortcuts-${Date.now()}`,
      contentMarkdown: "Search this phrase.\n\n```javascript\nconst value = 1;\n```",
    },
  });
  expect(created.status()).toBe(201);
  const { memo } = await created.json() as { memo: { id: string } };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    await expect(page.locator(".ProseMirror[contenteditable='true']")).toContainText("Search this phrase.");
    await run(memo.id);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
};

const dispatchShortcut = (target: Locator, options: KeyboardEventInit = {}) => target.evaluate((element, options) => {
  const event = new KeyboardEvent("keydown", {
    key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true, ...options,
  });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}, options);

test("save modifiers are consumed in body and source without blocking selected-text search", async ({ page }) => {
  await withMemo(page, async () => {
    const editor = page.locator(".ProseMirror").first();
    const paragraph = editor.locator("p").filter({ hasText: /^Search this phrase\.$/ });
    await paragraph.click();
    for (const options of [{}, { repeat: true }, { ctrlKey: false, metaKey: true }, { shiftKey: true }]) expect(await dispatchShortcut(paragraph, options)).toBe(true);
    await paragraph.evaluate(element => {
      const text = element.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0); range.setEnd(text, 6);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.press("Control+f");
    await expect(page.getByPlaceholder("在当前笔记内搜索", { exact: true })).toHaveValue("Search");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "切换到 Markdown 源码", exact: true }).click();
    const source = page.locator(".cm-content");
    await source.click();
    expect(await dispatchShortcut(source)).toBe(true);
    expect(await dispatchShortcut(source, { repeat: true })).toBe(true);
    await page.screenshot({ path: test.info().outputPath("source-save-shortcut.png") });
  });
});

test("save is prevented even when the code block title stops propagation", async ({ page }) => {
  await withMemo(page, async (memoId) => {
    const title = page.locator(".edgeever-code-title-input");
    await title.fill("saved-from-title");
    expect(await dispatchShortcut(title)).toBe(true);
    await expect(title).toBeFocused();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/memos/${memoId}`);
      return (await response.json()).memo.contentMarkdown;
    }).toContain("saved-from-title");
    await page.screenshot({ path: test.info().outputPath("code-title-save.png") });
  });
});
