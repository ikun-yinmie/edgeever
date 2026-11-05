import { expect, test, type Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";

test.use({ actionTimeout: 10_000 });

const withCodePreviewMemo = async (page: Page, contentMarkdown: string, run: () => Promise<void>) => {
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
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    await run();
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
};

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

    await preview.click({ position: { x: 30, y: 30 } });
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toHaveText(source);
    await toggle.click();
    await expect(preview).toBeVisible();
    await preview.focus();
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
