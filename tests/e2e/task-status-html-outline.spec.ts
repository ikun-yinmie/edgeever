import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
      nesting: root.querySelectorAll(".edgeever-html-outline-scroll > ol > li > ol").length,
      sidebar: root.querySelector(".edgeever-html-outline-sidebar")?.previousElementSibling?.tagName,
      inlineOutline: !!root.querySelector("article nav"),
      ids: Array.from(root.querySelectorAll("[id]")).map((element) => element.id),
      navLabel: root.querySelector("nav")?.getAttribute("aria-label"),
      without: buildStandaloneHtmlDocument(options).includes('<nav '),
      empty: buildStandaloneHtmlDocument({ title: "Only note title", bodyHtml: "<h2> </h2><p>body</p>", includeOutline: true }).includes('<nav '),
    };
  });
  expect(result.labels).toEqual(["重复 & <文本>", "子标题", "重复 & <文本>", "深层标题"]);
  expect(result.targets).toEqual(result.labels);
  expect(result.nesting).toBe(2);
  expect(result.sidebar).toBe("ARTICLE");
  expect(result.inlineOutline).toBe(false);
  expect(new Set(result.ids).size).toBe(result.ids.length);
  expect(result.navLabel).toBe("大纲 <safe>");
  expect(result.without).toBe(false);
  expect(result.empty).toBe(false);
});

test("exported HTML has an offline, collapsible reading sidebar with scroll tracking", async ({ page, browser }) => {
  await page.goto("/");
  const downloading = page.waitForEvent("download");
  await page.evaluate(async () => {
    const exportPath = "/src/lib/note-html-export.ts";
    const stylesPath = "/src/lib/note-html-export-assets.ts";
    const { downloadNoteHtmlFile } = await import(exportPath);
    const { NOTE_HTML_FULL_STYLES } = await import(stylesPath);
    const paragraphs = "<p>正文段落，用于验证滚动定位与大纲高亮。</p>".repeat(8);
    await downloadNoteHtmlFile({
      title: "离线阅读大纲",
      fallbackTitle: "Note",
      bodyHtml: `<h2>第一章</h2>${paragraphs}<h3>子章节</h3>${paragraphs}<h4>深层章节</h4>${paragraphs}`
        + Array.from({ length: 30 }, (_, index) => `<h2>章节 ${index + 2}</h2>${paragraphs}`).join(""),
      styles: NOTE_HTML_FULL_STYLES,
      includeOutline: true,
      outlineLabel: "大纲",
      outlineLabels: {
        show: "显示大纲", hide: "隐藏大纲", expandAll: "全部展开", collapseAll: "全部收起",
        expandHeading: "展开 {name}", collapseHeading: "收起 {name}",
      },
    });
  });
  const download = await downloading;
  const path = test.info().outputPath("outline.html");
  await download.saveAs(path);
  const fileUrl = pathToFileURL(path).href;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, offline: true });
  const exported = await context.newPage();
  const errors: string[] = [];
  exported.on("pageerror", (error) => errors.push(error.message));
  try {
    await exported.goto(fileUrl);
    const nav = exported.getByRole("navigation", { name: "大纲", exact: true });
    const first = nav.getByRole("link", { name: "第一章", exact: true });
    const child = nav.getByRole("link", { name: "子章节", exact: true });
    const grandchild = nav.getByRole("link", { name: "深层章节", exact: true });
    await expect(nav).toBeVisible();
    await expect(child).toBeHidden();
    await expect(first).toHaveAttribute("aria-current", "location");
    const articleBox = await exported.locator("article").boundingBox();
    const sidebarBox = await nav.boundingBox();
    expect(sidebarBox!.x).toBeGreaterThan(articleBox!.x + articleBox!.width);
    expect(sidebarBox!.width).toBe(300);
    await nav.getByRole("button", { name: "展开 第一章", exact: true }).click();
    await expect(child).toBeVisible();
    await expect(grandchild).toBeHidden();
    await nav.getByRole("button", { name: "展开 子章节", exact: true }).click();
    await expect(grandchild).toBeVisible();
    await child.click();
    await expect(child).toHaveAttribute("aria-current", "location");
    await expect.poll(() => exported.locator("article h3").evaluate((heading) => Math.round(heading.getBoundingClientRect().top))).toBe(72);
    await nav.getByRole("button", { name: "收起 第一章", exact: true }).click();
    await expect(first).toHaveAttribute("aria-current", "location");
    await expect(child).toBeHidden();
    await nav.getByRole("button", { name: "全部收起", exact: true }).click();
    await nav.getByRole("button", { name: "全部展开", exact: true }).click();
    await expect(grandchild).toBeVisible();
    await exported.screenshot({ path: test.info().outputPath("html-sidebar-desktop.png") });
    await nav.getByRole("button", { name: "隐藏大纲", exact: true }).click();
    await expect(nav).toBeHidden();
    await exported.getByRole("button", { name: "显示大纲", exact: true }).click();
    await expect(nav).toBeVisible();

    await exported.reload();
    await exported.locator("article h2").filter({ hasText: /^章节 29$/ }).evaluate((heading) => {
      window.scrollTo(0, window.scrollY + heading.getBoundingClientRect().top - 72);
    });
    await expect(nav.getByRole("link", { name: "章节 29", exact: true })).toHaveAttribute("aria-current", "location");
    expect((await nav.boundingBox())!.y).toBe(32);
    const scrollTop = await exported.locator(".edgeever-html-outline-scroll").evaluate((element) => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    const windowScroll = await exported.evaluate(() => window.scrollY);
    await exported.locator(".edgeever-html-outline-scroll").evaluate((element) => { element.scrollTop = 0; });
    expect(await exported.evaluate(() => window.scrollY)).toBe(windowScroll);

    await exported.setViewportSize({ width: 390, height: 844 });
    await exported.reload();
    await expect(nav).toBeHidden();
    const mobileReadingScroll = await exported.evaluate(() => window.scrollY);
    await exported.getByRole("button", { name: "显示大纲", exact: true }).click();
    await expect(nav).toBeInViewport();
    await nav.getByRole("button", { name: "隐藏大纲", exact: true }).click();
    expect(await exported.evaluate(() => window.scrollY)).toBe(mobileReadingScroll);
    await exported.getByRole("button", { name: "显示大纲", exact: true }).click();
    await expect(nav).toBeInViewport();
    await exported.screenshot({ path: test.info().outputPath("html-sidebar-mobile.png") });
    const mobileNav = await nav.boundingBox();
    const mobileArticle = await exported.locator("article").boundingBox();
    expect(mobileNav!.y + mobileNav!.height).toBeLessThanOrEqual(mobileArticle!.y);
    expect(await exported.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await nav.getByRole("link", { name: "章节 2", exact: true }).click();
    await expect(nav).toBeHidden();
    await expect.poll(() => exported.locator("article h2").filter({ hasText: /^章节 2$/ }).evaluate((heading) => Math.round(heading.getBoundingClientRect().top))).toBe(72);
    await exported.emulateMedia({ media: "print" });
    await expect(exported.locator(".edgeever-html-outline-sidebar")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  const noScriptContext = await browser.newContext({ javaScriptEnabled: false, offline: true });
  try {
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(fileUrl);
    await expect(noScriptPage.getByRole("link", { name: "深层章节", exact: true })).toBeVisible();
  } finally {
    await noScriptContext.close();
  }
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
