import { expect, test } from "@playwright/test";

test("saved code blocks keep language controls and only overflowing blocks offer full height", async ({ page }) => {
  test.setTimeout(300_000);
  const notebooksResponse = await page.request.get("/api/v1/notebooks");
  expect(notebooksResponse.ok()).toBe(true);
  const { notebooks } = await notebooksResponse.json() as { notebooks: Array<{ id: string }> };
  expect(notebooks[0]?.id).toBeTruthy();
  const longSource = Array.from({ length: 60 }, (_, index) => `console.log("line ${index + 1}");`).join("\n");
  const created = await page.request.post("/api/v1/memos", {
    data: {
      notebookId: notebooks[0].id,
      title: `code-block-lifecycle-${Date.now()}`,
      contentMarkdown: `Short code\n\n\`\`\`javascript\nconsole.log("short");\n\`\`\`\n\nLong code\n\n\`\`\`javascript\n${longSource}\n\`\`\``,
    },
  });
  expect(created.status()).toBe(201);
  const { memo } = await created.json() as { memo: { id: string } };
  const readMemo = async () => {
    const response = await page.request.get(`/api/v1/memos/${memo.id}`);
    expect(response.ok()).toBe(true);
    return (await response.json()).memo as { revision: number; contentMarkdown: string };
  };
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));

  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?openMemo=${memo.id}`);
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    await expect(page.locator(".ProseMirror[contenteditable='true']")).toContainText('console.log("short");');
    // Cold reload hydration in the local workerd profile can take tens of seconds.
    await page.reload();
    await expect(page.locator(".ProseMirror[contenteditable='true']"))
      .toContainText('console.log("short");', { timeout: 60_000 });
    await expect(page.getByRole("button", { name: "代码语言", exact: true })).toHaveCount(2);
    await expect(page.getByRole("textbox", { name: "代码块标题", exact: true })).toHaveCount(2);

    const shortBlock = page.locator(".edgeever-code-block").filter({ hasText: 'console.log("short");' });
    const longBlock = page.locator(".edgeever-code-block").filter({ hasText: 'console.log("line 60");' });
    const scroll = longBlock.locator(".edgeever-code-scroll");
    const scrollsInternally = () => scroll.evaluate(element => element.scrollHeight > element.clientHeight + 1);
    await expect(shortBlock.locator(".edgeever-code-height-toggle")).toHaveCount(0);
    await expect(longBlock.getByRole("button", { name: "展开全部代码", exact: true })).toBeVisible();
    await expect.poll(scrollsInternally).toBe(true);
    const beforeViewChanges = await readMemo();
    await longBlock.getByRole("button", { name: "展开全部代码", exact: true }).click();
    await expect.poll(scrollsInternally).toBe(false);
    await expect(longBlock.getByRole("button", { name: "恢复代码滚动", exact: true })).toBeVisible();
    await longBlock.getByRole("button", { name: "恢复代码滚动", exact: true }).click();
    await expect.poll(scrollsInternally).toBe(true);

    await page.getByRole("radio", { name: "预览", exact: true }).click();
    await expect(page.getByRole("button", { name: "代码语言", exact: true })).toHaveCount(0);
    await longBlock.getByRole("button", { name: "展开全部代码", exact: true }).click();
    await expect.poll(scrollsInternally).toBe(false);
    await longBlock.getByRole("button", { name: "恢复代码滚动", exact: true }).click();
    await expect.poll(scrollsInternally).toBe(true);
    expect(await readMemo()).toEqual(beforeViewChanges);

    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    await shortBlock.getByRole("button", { name: "代码语言", exact: true }).click();
    await page.getByRole("menuitem", { name: "Python", exact: true }).click();
    await expect(shortBlock).toHaveAttribute("data-language", "python");
    await expect.poll(async () => (await readMemo()).contentMarkdown, { timeout: 60_000 })
      .toContain("```python");
    await page.reload();
    await expect(page.locator(".ProseMirror[contenteditable='true']"))
      .toContainText('console.log("line 60");', { timeout: 60_000 });
    await expect(shortBlock).toHaveAttribute("data-language", "python");
    await expect(page.getByRole("button", { name: "代码语言", exact: true })).toHaveCount(2);
    await expect(longBlock.getByRole("button", { name: "展开全部代码", exact: true })).toBeVisible();
    await expect.poll(scrollsInternally).toBe(true);

    await longBlock.getByRole("button", { name: "展开全部代码", exact: true }).click();
    await expect.poll(scrollsInternally).toBe(false);
    await longBlock.getByRole("textbox", { name: "", exact: true }).fill("const compact = true;");
    await expect(page.locator(".edgeever-code-height-toggle")).toHaveCount(0);
    const compactBlock = page.locator(".edgeever-code-block").filter({ hasText: "const compact = true;" });
    await expect(compactBlock).not.toHaveClass(/edgeever-code-block-full-height/);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
