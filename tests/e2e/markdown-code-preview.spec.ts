import { expect, test, type Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";

test.use({ actionTimeout: 10_000 });

const withCodePreviewMemo = async (page: Page, contentMarkdown: string, run: (memoId: string) => Promise<void>) => {
  const notebooksResponse = await page.request.get("/api/v1/notebooks");
  expect(notebooksResponse.ok()).toBe(true);
  const { notebooks } = await notebooksResponse.json() as { notebooks: Array<{ id: string }> };
  expect(notebooks[0]?.id).toBeTruthy();
  const response = await page.request.post("/api/v1/memos", {
    data: { notebookId: notebooks[0].id, title: `code-preview-${Date.now()}`, contentMarkdown },
  });
  expect(response.status()).toBe(201);
  const { memo } = await response.json() as { memo: { id: string } };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click({ timeout: 30_000 });
    await page.getByRole("radio", { name: "编辑", exact: true }).click({ timeout: 30_000 });
    await run(memo.id);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
};

test("line spacing drag applies to the selection or whole note and survives saving", async ({ page }) => {
  test.setTimeout(120_000);
  await withCodePreviewMemo(page, "Selected first line  \nSelected second line\n\nOther paragraph\n\n## Section heading\n\n- List paragraph\n\n```javascript\nconst value = 1;\n```", async (memoId) => {
    const editor = page.locator(".ProseMirror").first();
    const first = editor.locator("p").filter({ hasText: "Selected first line" });
    const other = editor.locator("p").filter({ hasText: "Other paragraph" });
    const format = page.getByRole("button", { name: "段落格式", exact: true });
    if (!await format.isVisible()) await page.getByRole("button", { name: "显示更多编辑工具", exact: true }).click();
    const slider = page.getByRole("slider", { name: "行距微调", exact: true });
    const dragSpacing = async (value: number) => {
      const box = (await slider.boundingBox())!;
      const current = Number(await slider.inputValue());
      const x = (number: number) => box.x + 8 + (box.width - 16) * (number + 12) / 44;
      await page.mouse.move(x(current), box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x(value), box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(slider).toHaveValue(String(value));
    };
    await first.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    const original = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    const selection = await editor.evaluate((element) => {
      const { from, to } = (element as HTMLElement & { editor: Editor }).editor.state.selection;
      return { from, to };
    });
    expect(selection.from).not.toBe(selection.to);
    await format.click();
    await expect(page.getByText("应用于选中段落", { exact: true })).toBeVisible();
    await dragSpacing(-8);
    await expect(first).toHaveAttribute("data-line-spacing", "-8");
    await expect(first).toHaveCSS("line-height", "16px");
    await expect(other).not.toHaveAttribute("data-line-spacing");
    expect(await editor.evaluate((element) => {
      const { from, to } = (element as HTMLElement & { editor: Editor }).editor.state.selection;
      return { from, to };
    })).toEqual(selection);
    await page.screenshot({ path: test.info().outputPath("negative-line-spacing.png") });
    await page.keyboard.press("Escape");
    await first.click();
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);

    await other.click();
    await format.click();
    await expect(page.getByText("应用于整篇文章", { exact: true })).toBeVisible();
    await dragSpacing(6);
    await expect(first).toHaveCSS("line-height", "30px");
    for (const block of [first, other, editor.locator("h2").filter({ hasText: "Section heading" }), editor.locator("p").filter({ hasText: "List paragraph" })]) {
      await expect(block).toHaveAttribute("data-line-spacing", "6");
    }
    await expect(editor.locator(".edgeever-code-block")).not.toHaveAttribute("data-line-spacing");
    await page.keyboard.press("Escape");
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/memos/${memoId}`);
      const body = await response.json() as { memo: { contentJson: unknown } };
      return JSON.stringify(body.memo.contentJson);
    }, { timeout: 30_000 }).toContain('"lineSpacing":6');
    await page.reload();
    await page.locator(`[data-memo-id="${memoId}"]`).locator("button").first().click({ timeout: 30_000 });
    await expect(first).toHaveAttribute("data-line-spacing", "6", { timeout: 30_000 });
    await expect(first).toHaveCSS("line-height", "30px");
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    if (!await format.isVisible()) await page.getByRole("button", { name: "显示更多编辑工具", exact: true }).click();
    await other.click();
    await format.click();
    await page.getByRole("menuitem", { name: "恢复默认行距", exact: true }).click();
    await expect(first).not.toHaveAttribute("data-line-spacing");
    await expect(other).not.toHaveAttribute("data-line-spacing");
    await expect(first).toHaveCSS("line-height", "24px");
  });
});

test("new code blocks include a following blank paragraph for consecutive insertion", async ({ page }) => {
  test.setTimeout(90_000);
  await withCodePreviewMemo(page, "Before block\n\nInsert here\n\nAfter block", async () => {
    const editor = page.locator(".ProseMirror").first();
    const insert = page.getByRole("button", { name: "代码块", exact: true });
    if (!await insert.isVisible()) await page.getByRole("button", { name: "显示更多编辑工具", exact: true }).click();
    await editor.getByRole("paragraph").filter({ hasText: "Insert here" }).click();
    const original = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await insert.click();
    await expect(editor.locator(".edgeever-code-block")).toHaveCount(1);
    const empty = editor.locator(":scope > p").filter({ hasText: /^$/ });
    await expect(empty).toHaveCount(1);
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.state.selection.$from.parent.type.name)).toBe("codeBlock");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor.locator(".edgeever-code-block")).toHaveCount(1);
    await empty.click();
    await insert.click();
    await expect(editor.locator(".edgeever-code-block")).toHaveCount(2);
    await expect(empty).toHaveCount(1);
    await page.keyboard.insertText("Second code block");
    await expect(editor.locator(".edgeever-code-block").last().locator(".edgeever-code-source")).toHaveText("Second code block");
    await expect(editor.getByRole("paragraph").filter({ hasText: "After block" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("consecutive-code-blocks.png") });
  });
});

test("heading collapse and block conversion have separate click targets", async ({ page }) => {
  test.setTimeout(90_000);
  await withCodePreviewMemo(page, "## Foldable heading\n\nHeading body\n\n## Next heading\n\nNext body", async () => {
    const editor = page.locator(".ProseMirror").first();
    const heading = editor.getByRole("heading", { name: "Foldable heading" });
    const toggle = heading.locator(".edgeever-heading-collapse-toggle");
    const menu = page.getByRole("button", { name: "块操作", exact: true });
    await editor.getByRole("paragraph").filter({ hasText: "Next body" }).click();
    await heading.hover();
    const handle = page.locator(".edgeever-block-drag-handle");
    await expect(handle).toBeVisible();
    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2, { steps: 30 });
    await expect(menu).toBeVisible();
    await expect.poll(async () => {
      const button = await menu.boundingBox();
      const fold = await toggle.boundingBox();
      return button && fold ? fold.x - (button.x + button.width) : -1;
    }).toBeGreaterThanOrEqual(8);
    await menu.click();
    await page.getByRole("menuitem", { name: "转化为", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: "标题 3", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "标题 3", exact: true }).click();
    await expect(editor.locator("h3").filter({ hasText: "Foldable heading" })).toBeVisible();
    await expect(editor.getByRole("paragraph").filter({ hasText: "Heading body" })).toBeVisible();
    await toggle.click();
    await expect(editor.getByRole("paragraph").filter({ hasText: "Heading body" })).toBeHidden();
    await expect(editor.getByRole("paragraph").filter({ hasText: "Next body" })).toBeVisible();
    await toggle.click();
    await expect(editor.getByRole("paragraph").filter({ hasText: "Heading body" })).toBeVisible();
    await heading.hover();
    await page.locator(".edgeever-block-drag-handle").hover();
    await expect(menu).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("heading-buttons-separated.png") });
  });
});

test("body context menu transforms the clicked block or selection and respects preview mode", async ({ page }) => {
  test.setTimeout(120_000);
  await withCodePreviewMemo(page, "First paragraph\n\nTarget paragraph\n\nOther paragraph\n\n## Existing heading\n\nHeading body", async (memoId) => {
    const editor = page.locator(".ProseMirror").first();
    const first = editor.getByRole("paragraph").filter({ hasText: "First paragraph" });
    const target = editor.getByRole("paragraph").filter({ hasText: "Target paragraph" });
    const other = editor.getByRole("paragraph").filter({ hasText: "Other paragraph" });
    const original = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    const transform = page.getByRole("menuitem", { name: "转化为", exact: true });

    await first.click();
    await target.click({ button: "right", position: { x: 8, y: 8 } });
    await transform.hover();
    await page.getByRole("menuitem", { name: "标题 3", exact: true }).click();
    const heading = editor.getByRole("heading", { name: "Target paragraph", level: 3 });
    await expect(heading).toBeVisible();
    await expect(first).toBeVisible();
    await expect(other).toBeVisible();
    await expect(editor.getByRole("heading", { name: "Existing heading", level: 2 })).toBeVisible();
    const convertedDocument = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/memos/${memoId}`);
      const body = await response.json() as { memo: { contentJson: unknown } };
      return body.memo.contentJson;
    }, { timeout: 30_000 }).toEqual(convertedDocument);
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(heading).toBeVisible();

    await heading.click({ button: "right", position: { x: 8, y: 8 } });
    await transform.hover();
    await page.getByRole("menuitem", { name: "正文", exact: true }).click();
    await expect(target).toBeVisible();
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);

    await first.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+End");
    const selection = await editor.evaluate((element) => {
      const { from, to } = (element as HTMLElement & { editor: Editor }).editor.state.selection;
      return { from, to };
    });
    expect(selection.from).not.toBe(selection.to);
    await first.click({ button: "right", position: { x: 8, y: 8 } });
    await transform.hover();
    await expect(page.getByRole("menuitem", { name: "无序列表", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("body-context-conversion.png") });
    await page.getByRole("menuitem", { name: "无序列表", exact: true }).click();
    await expect(editor.locator("ul > li")).toHaveCount(2);
    await expect(editor.locator("ul").first()).toContainText("First paragraph");
    await expect(editor.locator("ul").first()).toContainText("Target paragraph");
    await expect(other).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);

    await page.getByRole("radio", { name: "预览", exact: true }).click();
    await target.click({ button: "right", position: { x: 8, y: 8 } });
    await expect(page.getByRole("menuitem", { name: "复制", exact: true })).toBeVisible();
    await expect(transform).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(original);
  });
});

test("Markdown fences preview on blur and edit on click, keyboard focus and cursor entry", async ({ page }) => {
  test.setTimeout(90_000);
  const source = "# Preview heading\n\n**bold content**\n\n- [x] done\n\n| A | B |\n| --- | --- |\n| one | two |";
  await withCodePreviewMemo(page, `Before block\n\n\`\`\`md\n${source}\n\`\`\`\n\nAfter block`, async () => {
    const editor = page.locator(".ProseMirror").first();
    const block = editor.locator(".edgeever-code-block");
    const preview = block.locator(".edgeever-markdown-preview");
    const sourceView = block.locator(".edgeever-markdown-source");
    const toggle = block.locator(".edgeever-markdown-preview-toggle");
    const before = editor.getByText("Before block", { exact: true });
    const after = editor.getByText("After block", { exact: true });
    await before.click();
    await expect(preview.getByRole("heading", { name: "Preview heading" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("bold content");
    await expect(preview.locator("table")).toBeVisible();
    await expect(preview.getByRole("checkbox")).toBeChecked();
    await expect(sourceView).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const documentBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await preview.getByRole("heading").click();
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toHaveText(source);
    await expect(preview).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(preview).toBeVisible();
    await toggle.click();
    await expect(sourceView).toBeVisible();
    await page.getByPlaceholder("搜索笔记", { exact: true }).focus();
    await expect(preview).toBeVisible();

    // Tab focus of the preview region enters editing without requiring a mouse.
    await preview.focus();
    await expect(sourceView).toBeVisible();
    await after.click();
    await expect(preview).toBeVisible();

    // Selection updates within the same contenteditable do not emit DOM blur.
    await before.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await expect(sourceView).toBeVisible();
    await after.click();
    await expect(preview).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft");
    await expect(sourceView).toBeVisible();
    await before.click();
    await page.keyboard.press("ArrowDown");
    await expect(sourceView).toBeVisible();
    await after.click();
    await page.keyboard.press("ArrowUp");
    await expect(sourceView).toBeVisible();
    await after.click();
    await expect(preview).toBeVisible();
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(documentBefore);

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: test.info().outputPath("markdown-code-preview-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await toggle.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await editor.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, "## Updated heading\n\n**Updated bold**");
    await after.click();
    await expect(preview.getByRole("heading", { name: "Updated heading" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("Updated bold");
    await expect(before).toBeVisible();
    await expect(after).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("markdown-code-preview.png") });
    await toggle.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await after.click();
    await expect(preview.getByRole("heading", { name: "Preview heading" })).toBeVisible();
  });
});

test("empty Markdown blocks and read-only previews preserve their source", async ({ page }) => {
  test.setTimeout(90_000);
  await withCodePreviewMemo(page, "Before block\n\n```markdown\n```\n\nBetween blocks\n\n```javascript\nconst value = 1;\n```\n\nAfter block", async () => {
    const editor = page.locator(".ProseMirror").first();
    const block = editor.locator('[data-language="markdown"]');
    const preview = block.locator(".edgeever-markdown-preview");
    const sourceView = block.locator(".edgeever-markdown-source");
    const toggle = block.locator(".edgeever-markdown-preview-toggle");
    await editor.getByText("Before block", { exact: true }).click();
    await expect(preview).toContainText("输入 Markdown");
    await expect(editor.locator('[data-language="javascript"] .edgeever-markdown-preview-toggle')).toHaveCount(0);
    await preview.click();
    await expect(sourceView).toBeVisible();
    const unsafeSource = '# Safe heading\n\n<script>window.previewScriptRan = true</script>\n\n[unsafe](javascript:alert(1))';
    // Use real Enter key events for typing, rather than a single multiline insertText.
    await expect(editor).toBeFocused();
    const lines = unsafeSource.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) await page.keyboard.press("Enter");
      if (lines[index]) await page.keyboard.insertText(lines[index]);
    }
    await expect(sourceView).toHaveText(unsafeSource);
    await editor.getByText("After block", { exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Safe heading" })).toBeVisible();
    await expect(preview.locator("script, a")).toHaveCount(0);
    await expect(preview).toContainText("<script>");
    expect(await page.evaluate(() => "previewScriptRan" in window)).toBe(false);

    await block.getByRole("button", { name: "收起代码块", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(sourceView).toBeHidden();
    await block.getByRole("button", { name: "展开代码块", exact: true }).click();
    await expect(preview).toBeVisible();
    await page.getByRole("radio", { name: "预览", exact: true }).click();
    const documentBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await expect(preview).toBeVisible();
    await preview.getByRole("heading").click();
    await expect(preview).toBeVisible();
    await expect(sourceView).toBeHidden();
    await toggle.click();
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toHaveAttribute("aria-readonly", "true");
    await sourceView.click();
    await sourceView.locator("[data-node-view-content-react]").evaluate((element) => window.getSelection()?.selectAllChildren(element));
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain("Safe heading");
    await expect(sourceView).toBeVisible();
    await toggle.click();
    await expect(preview).toBeVisible();
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(documentBefore);
  });
});

test("HTML code blocks render isolated styles and switch between preview and source", async ({ page }) => {
  test.setTimeout(90_000);
  const source = '<!doctype html><html><head><style>body { background: rgb(230, 245, 240); } h1 { color: rgb(12, 120, 80); } .ProseMirror { display: none; }</style></head><body><h1>HTML preview heading</h1><p>A rendered <strong>HTML card</strong>.</p></body></html>';
  await withCodePreviewMemo(page, `Before block\n\n\`\`\`html\n${source}\n\`\`\`\n\nAfter block`, async () => {
    const editor = page.locator(".ProseMirror").first();
    const block = editor.locator('[data-language="html"]');
    const preview = block.locator(".edgeever-html-preview");
    const sourceView = block.locator(".edgeever-html-source");
    const toggle = block.locator(".edgeever-html-preview-toggle");
    const iframe = block.locator("iframe");
    const frame = block.frameLocator("iframe");
    const before = editor.getByText("Before block", { exact: true });
    const after = editor.getByText("After block", { exact: true });
    await before.click();
    await expect(frame.getByRole("heading", { name: "HTML preview heading" })).toBeVisible();
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(12, 120, 80)");
    await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(230, 245, 240)");
    await expect(editor).toBeVisible();
    await expect(sourceView).toBeHidden();
    await expect(iframe).toHaveAttribute("sandbox", "");
    expect(await iframe.evaluate((element) => (element as HTMLIFrameElement).contentDocument)).toBeNull();
    const documentBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await page.screenshot({ path: test.info().outputPath("html-code-preview.png") });

    await frame.getByRole("heading", { name: "HTML preview heading" }).click();
    await expect(preview).toBeVisible();
    await expect(sourceView).toBeHidden();
    await toggle.click();
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toHaveText(source);
    await toggle.click();
    await expect(preview).toBeVisible();
    await iframe.focus();
    await expect(preview).toBeVisible();
    await toggle.click();
    await expect(sourceView).toBeVisible();
    await page.getByPlaceholder("搜索笔记", { exact: true }).focus();
    await expect(preview).toBeVisible();
    await before.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await expect(sourceView).toBeVisible();
    await after.click();
    await expect(preview).toBeVisible();
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(documentBefore);

    await toggle.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", '<h2>Updated HTML</h2>\n<p style="color: red">New HTML content</p>');
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    await after.click();
    await expect(frame.getByRole("heading", { name: "Updated HTML" })).toBeVisible();
    await toggle.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await after.click();
    await expect(frame.getByRole("heading", { name: "HTML preview heading" })).toBeVisible();
  });
});

test("HTML previews scroll in edit and read mode without opening source", async ({ page }) => {
  test.setTimeout(90_000);
  const source = `<h1>Scrollable HTML</h1>${Array.from({ length: 120 }, (_, index) => `<p>Preview row ${index + 1}</p>`).join("\n")}`;
  await withCodePreviewMemo(page, `Before block\n\n\`\`\`html\n${source}\n\`\`\`\n\nAfter block`, async () => {
    const editor = page.locator(".ProseMirror").first();
    const block = editor.locator('[data-language="html"]');
    const iframe = block.locator("iframe");
    const frame = block.frameLocator("iframe");
    await editor.getByText("Before block", { exact: true }).click();
    const documentBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    for (const mode of ["编辑", "预览"]) {
      await page.getByRole("radio", { name: mode, exact: true }).click();
      await expect(frame.getByRole("heading", { name: "Scrollable HTML" })).toBeVisible();
      await expect(iframe).not.toHaveAttribute("inert", "");
      await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
      await iframe.hover();
      await page.mouse.wheel(0, 500);
      await expect.poll(() => frame.locator("body").evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBeGreaterThan(100);
      await iframe.focus();
      const scrollBefore = await frame.locator("body").evaluate(() => document.scrollingElement?.scrollTop ?? 0);
      await page.keyboard.press("PageDown");
      await expect.poll(() => frame.locator("body").evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBeGreaterThan(scrollBefore);
      await expect(block.locator(".edgeever-html-source")).toBeHidden();
      await expect(block.locator(".edgeever-html-preview-toggle")).toHaveAttribute("aria-pressed", "true");
    }
    await page.screenshot({ path: test.info().outputPath("html-preview-scrolled.png") });
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(documentBefore);
  });
});

test("long code scrolls inside the block while header actions stay accessible", async ({ page }) => {
  test.setTimeout(90_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const source = Array.from({ length: 160 }, (_, index) => `const line${index + 1} = "${"long code ".repeat(20)}";`).join("\n");
  await withCodePreviewMemo(page, `Before block\n\n\`\`\`javascript\n${source}\n\`\`\`\n\nAfter block`, async () => {
    const editor = page.locator(".ProseMirror").first();
    const block = editor.locator('[data-language="javascript"]');
    const scroll = block.locator(".edgeever-code-scroll");
    const sourceView = block.locator(".edgeever-code-source");
    const header = block.locator(".edgeever-code-header");
    await editor.getByText("Before block", { exact: true }).click();
    const textBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getText());
    for (const mode of ["编辑", "预览"]) {
      await page.getByRole("radio", { name: mode, exact: true }).click();
      const documentBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
      await scroll.scrollIntoViewIfNeeded();
      const dimensions = await scroll.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
      expect(dimensions.content).toBeGreaterThan(dimensions.height * 3);
      expect(dimensions.height).toBeLessThanOrEqual(576);
      const headerBefore = await header.boundingBox();
      await sourceView.hover({ position: { x: 100, y: 60 } });
      await page.mouse.wheel(0, 900);
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
      expect((await header.boundingBox())?.y).toBe(headerBefore?.y);
      await expect(block.getByRole("button", { name: "收起代码块", exact: true })).toBeInViewport();
      await block.getByRole("button", { name: "复制代码", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
      await block.getByRole("button", { name: "收起代码块", exact: true }).click();
      await expect(sourceView).toBeHidden();
      await block.getByRole("button", { name: "展开代码块", exact: true }).click();
      await expect(sourceView).toBeVisible();
      await scroll.evaluate((element) => { element.scrollTop = 0; });
      if (mode === "预览") {
        expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(documentBefore);
      }
    }
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getText())).toBe(textBefore);
    await sourceView.hover({ position: { x: 100, y: 60 } });
    await page.mouse.wheel(500, 0);
    await expect.poll(() => sourceView.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
    await block.getByRole("button", { name: "更多代码块操作", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "自动换行", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(sourceView).toHaveCSS("white-space", "pre-wrap");
    await page.screenshot({ path: test.info().outputPath("long-code-toolbar.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: test.info().outputPath("long-code-toolbar-dark.png") });
  });
});

test("task sub-content supports code creation, newlines, indentation and folding", async ({ page }) => {
  test.setTimeout(90_000);
  await withCodePreviewMemo(page, "- [ ] Previous task\n- [ ] Parent task\n\nAfter block", async () => {
    const editor = page.locator(".ProseMirror").first();
    const tasks = editor.locator('li[data-type="taskItem"]');
    const task = tasks.nth(1);
    await task.getByRole("paragraph").filter({ hasText: "Parent task" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("ControlOrMeta+Alt+c");
    const block = task.locator(".edgeever-code-block");
    const sourceView = block.locator(".edgeever-code-source");
    await expect(block).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(block).toBeVisible();
    await page.keyboard.insertText("first");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("second");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("third");
    await expect.poll(() => sourceView.textContent()).toBe("\nfirst\nsecond\n    third");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => sourceView.textContent()).toBe("\nfirst\nsecond\nthird");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Tab");
    await expect.poll(() => sourceView.textContent()).toBe("    \n    first\n    second\n    third");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => sourceView.textContent()).toBe("\nfirst\nsecond\nthird");
    await expect(tasks).toHaveCount(2);
    await expect(editor.locator('ul[data-type="taskList"] ul')).toHaveCount(0);
    await task.getByRole("button", { name: "收起子项", exact: true }).click();
    await expect(block).toBeHidden();
    await task.getByRole("button", { name: "展开子项", exact: true }).click();
    await expect(sourceView).toBeVisible();
    await expect.poll(() => sourceView.textContent()).toBe("\nfirst\nsecond\nthird");
    await sourceView.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("<h1>Nested HTML</h1>");
    await block.locator(".edgeever-code-lang-picker").click();
    await page.getByRole("menuitem", { name: "HTML", exact: true }).click();
    await task.getByRole("paragraph").filter({ hasText: "Parent task" }).click();
    await expect(block.frameLocator("iframe").getByRole("heading", { name: "Nested HTML" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Alt+t");
    await expect(block).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Alt+t");
    await expect(block.frameLocator("iframe").getByRole("heading", { name: "Nested HTML" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("task-code-preview.png") });
    await expect(tasks.nth(0).getByRole("paragraph").filter({ hasText: "Previous task" })).toBeVisible();
    await expect(editor.getByText("After block", { exact: true })).toBeVisible();
  });
});

test("empty HTML blocks support typing and read-only HTML cannot run active content", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests: string[] = [];
  await page.route("https://html-preview-blocked.invalid/**", async (route) => {
    blockedRequests.push(route.request().url());
    await route.abort();
  });
  await withCodePreviewMemo(page, "Before block\n\n```htm\n```\n\nAfter block", async () => {
    const editor = page.locator(".ProseMirror").first();
    const block = editor.locator(".edgeever-code-block");
    const preview = block.locator(".edgeever-html-preview");
    const sourceView = block.locator(".edgeever-html-source");
    const toggle = block.locator(".edgeever-html-preview-toggle");
    const frame = block.frameLocator("iframe");
    await editor.getByText("Before block", { exact: true }).click();
    await expect(preview).toContainText("输入 HTML");
    await preview.click();
    await expect(editor).toBeFocused();
    await page.keyboard.insertText("<h1>Typed HTML</h1>");
    await editor.getByText("After block", { exact: true }).click();
    await expect(frame.getByRole("heading", { name: "Typed HTML" })).toBeVisible();
    await block.getByRole("button", { name: "收起代码块", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(sourceView).toBeHidden();
    await block.getByRole("button", { name: "展开代码块", exact: true }).click();
    await expect(frame.getByRole("heading", { name: "Typed HTML" })).toBeVisible();

    // Switching language reuses the preview state but renders the correct format.
    await block.locator(".edgeever-code-lang-picker").click();
    await page.getByRole("menuitem", { name: "Markdown", exact: true }).click();
    await expect(block.locator(".edgeever-markdown-preview")).toContainText("<h1>Typed HTML</h1>");
    await expect(block.locator("iframe")).toHaveCount(0);
    await block.locator(".edgeever-code-lang-picker").click();
    await page.getByRole("menuitem", { name: "HTML", exact: true }).click();
    await expect(frame.getByRole("heading", { name: "Typed HTML" })).toBeVisible();

    await toggle.click();
    await expect(editor).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    const activeHtml = [
      '<h1>Safe HTML</h1>',
      '<script>window.htmlPreviewScriptRan = true; parent.htmlPreviewScriptRan = true;</script>',
      '<script src="https://html-preview-blocked.invalid/script"></script>',
      '<iframe src="https://html-preview-blocked.invalid/frame"></iframe>',
      '<meta http-equiv="refresh" content="0;url=https://html-preview-blocked.invalid/redirect">',
      '<form action="https://html-preview-blocked.invalid/form"><button type="submit">Submit form</button></form>',
      '<button onclick="window.htmlPreviewScriptRan = true">Run script</button>',
    ].join("\n");
    await editor.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, activeHtml);
    await editor.getByText("After block", { exact: true }).click();
    await page.getByRole("radio", { name: "预览", exact: true }).click();
    const documentBefore = await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await expect(frame.getByRole("heading", { name: "Safe HTML" })).toBeVisible();
    await expect(block.locator("iframe")).not.toHaveAttribute("inert", "");
    await frame.getByRole("button", { name: "Run script" }).click();
    await frame.getByRole("button", { name: "Submit form" }).click();
    expect(await frame.locator("body").evaluate(() => "htmlPreviewScriptRan" in window)).toBe(false);
    expect(await page.evaluate(() => "htmlPreviewScriptRan" in window)).toBe(false);
    expect(blockedRequests).toEqual([]);
    await toggle.click();
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toHaveText(activeHtml);
    await expect(sourceView).toHaveAttribute("aria-readonly", "true");
    await toggle.click();
    await expect(preview).toBeVisible();
    expect(await editor.evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(documentBefore);
  });
});
