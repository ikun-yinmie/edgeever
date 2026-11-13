import { readFile } from "node:fs/promises";
import { expect, test, type Download } from "@playwright/test";

const readDownload = async (download: Download) => {
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, "utf8");
};

// Uses a real DOM for safe anchor generation, repeated labels and nested levels.
test("HTML outline handles empty headings, skipped levels and anchor collisions", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/lib/note-html-export.ts";
    const { buildStandaloneHtmlDocument } = await import(path);
    const bodyHtml = '<div id="edgeever-heading-1"></div><h2>重复 &amp; &lt;文本&gt;</h2><h4>子标题</h4><h2>重复 &amp; &lt;文本&gt;</h2><h3> </h3><h6 id="existing">深层标题</h6>';
    const options = { bodyHtml, title: "Note title", outlineLabel: "大纲 <safe>" };
    const root = document.createElement("div");
    root.innerHTML = buildStandaloneHtmlDocument({ ...options, includeOutline: true });
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>(".edgeever-html-outline a"));
    return {
      labels: links.map((link) => link.textContent),
      targets: links.map((link) => root.querySelector(`[id="${decodeURIComponent(link.getAttribute("href")!.slice(1))}"]`)?.textContent),
      nesting: root.querySelectorAll(".edgeever-html-outline > ol > li > ol").length,
      ids: Array.from(root.querySelectorAll("[id]")).map((element) => element.id),
      navLabel: root.querySelector("nav")?.getAttribute("aria-label"),
      without: buildStandaloneHtmlDocument(options).includes('<nav '),
      empty: buildStandaloneHtmlDocument({ title: "Only note title", bodyHtml: "<h2> </h2><p>body</p>", includeOutline: true }).includes('<nav '),
    };
  });
  expect(result.labels).toEqual(["重复 & <文本>", "子标题", "重复 & <文本>", "深层标题"]);
  expect(result.targets).toEqual(result.labels);
  expect(result.nesting).toBe(2);
  expect(new Set(result.ids).size).toBe(result.ids.length);
  expect(result.navLabel).toBe("大纲 <safe>");
  expect(result.without).toBe(false);
  expect(result.empty).toBe(false);
});

test("marks tasks red, persists them, and optionally exports a clickable HTML outline", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json() as { notebooks: Array<{ id: string }> };
  const title = `task-outline-${Date.now()}`;
  const created = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id,
    title,
    contentMarkdown: "## 第一节\n\n- [ ] 待办任务\n- [x] 已完成任务\n- [❌] 已否定任务\n  - [ ] 子任务\n\n### 子标题\n\n正文\n\n## 第一节\n\n重复标题正文",
  } });
  expect(created.status()).toBe(201);
  const { memo } = await created.json() as { memo: { id: string } };
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("待办任务");
    const pending = editor.locator('li[data-type="taskItem"]').filter({ has: page.locator("p", { hasText: /^待办任务$/ }) });
    await pending.locator("p").click();
    const moreTools = page.getByRole("button", { name: "显示更多编辑工具", exact: true });
    if (await moreTools.isVisible()) await moreTools.click();
    const crossButton = page.getByRole("button", { name: "标记 / 取消红色 ❌", exact: true });
    await crossButton.click();
    await expect(pending).toHaveAttribute("data-rejected", "true");
    await expect(pending).toHaveAttribute("data-checked", "false");
    await page.screenshot({ path: test.info().outputPath("red-task.png") });
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/memos/${memo.id}`);
      return (await response.json()).memo.contentMarkdown as string;
    }, { timeout: 30_000 }).toContain("- [❌] 待办任务");
    await page.reload();
    // The editor remounts after the reload; wait for the body before counting
    // attributes, otherwise this races the initial hydration.
    await expect(editor).toContainText("待办任务", { timeout: 30_000 });
    await expect(editor.locator('li[data-rejected="true"]')).toHaveCount(2);

    // The original checkbox still marks a red task completed and clears the cross.
    await pending.locator('input[type="checkbox"]').click();
    await expect(pending).toHaveAttribute("data-checked", "true");
    await expect(pending).not.toHaveAttribute("data-rejected", "true");

    const openExport = async () => {
      await page.getByRole("button", { name: "笔记更多操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "导出 HTML", exact: true }).click();
    };
    await openExport();
    const dialog = page.getByRole("dialog", { name: "导出 HTML", exact: true });
    await expect(dialog.getByRole("checkbox", { name: "包含大纲", exact: true })).toBeChecked();
    await page.screenshot({ path: test.info().outputPath("html-outline-options.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await openExport();
    const withOutline = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出 HTML", exact: true }).click();
    const exported = await readDownload(await withOutline);
    expect(exported).toContain('<nav class="edgeever-html-outline"');
    expect(exported).toContain('data-rejected="true"');
    expect(exported).toContain('content: "❌"');
    await expect(dialog).toHaveCount(0);
    const parsed = await page.evaluate((html) => {
      const root = document.createElement("div");
      root.innerHTML = html;
      return Array.from(root.querySelectorAll<HTMLAnchorElement>("nav a")).map((a) => ({
        label: a.textContent,
        target: root.querySelector(a.getAttribute("href")!)?.textContent,
      }));
    }, exported);
    expect(parsed.map((row) => row.label)).toEqual(["第一节", "子标题", "第一节"]);
    expect(parsed.every((row) => row.label === row.target)).toBe(true);

    await openExport();
    await dialog.getByRole("checkbox", { name: "包含大纲", exact: true }).uncheck();
    const withoutOutline = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出 HTML", exact: true }).click();
    expect(await readDownload(await withoutOutline)).not.toContain('<nav class="edgeever-html-outline"');
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});

test("a note without body headings exports directly without an outline dialog", async ({ page }) => {
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json() as { notebooks: Array<{ id: string }> };
  const created = await page.request.post("/api/v1/memos", { data: { notebookId: notebooks[0].id, title: `no-outline-${Date.now()}`, contentMarkdown: "没有标题的正文" } });
  expect(created.status()).toBe(201);
  const { memo } = await created.json() as { memo: { id: string } };
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await expect(page.locator(".ProseMirror").first()).toContainText("没有标题的正文");
    await page.getByRole("button", { name: "笔记更多操作", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "导出 HTML", exact: true }).click();
    expect(await readDownload(await downloading)).not.toContain('<nav class="edgeever-html-outline"');
    await expect(page.getByRole("dialog", { name: "导出 HTML", exact: true })).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
