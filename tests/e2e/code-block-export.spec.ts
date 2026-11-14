import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";

test("HTML and image export preparation preserves code and Mermaid titles as safe visible captions", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Exercise the shared export pipeline in a real DOM, without creating stored notes.
    const modulePath = "/src/lib/note-html-export.ts";
    const { prepareNoteBodyHtmlForExport } = await import(modulePath);
    const root = document.createElement("div");
    const addCode = (title: string | null, source: string, language: string, rawMeta?: string) => {
      const pre = document.createElement("pre");
      if (title !== null) pre.setAttribute("data-edgeever-code-meta", JSON.stringify({ v: 1, title }));
      if (rawMeta) pre.setAttribute("data-edgeever-code-meta", rawMeta);
      const code = document.createElement("code");
      if (language) code.className = `language-${language}`;
      code.textContent = source;
      pre.append(code);
      root.append(pre);
    };
    addCode('示例 <img src=x onerror="alert(1)"> & 标题', 'console.log("hello");', "javascript");
    addCode("无语言标题", "plain source", "");
    addCode("流程图标题", "graph TD\n  A --> B", "mermaid");
    addCode("无效图表标题", "this is not a mermaid diagram", "mermaid");
    addCode(null, "untitled source", "text");
    addCode("   ", "blank title", "text");
    addCode(null, "invalid metadata", "text", "{broken");
    const prepared = await prepareNoteBodyHtmlForExport(root.innerHTML);
    const once = document.createElement("div");
    once.innerHTML = prepared.bodyHtml;
    const repeated = await prepareNoteBodyHtmlForExport(prepared.bodyHtml);
    const twice = document.createElement("div");
    twice.innerHTML = repeated.bodyHtml;
    return {
      captions: Array.from(once.querySelectorAll("figcaption")).map((caption) => caption.textContent),
      repeatedCount: twice.querySelectorAll("figcaption").length,
      firstSource: once.querySelector("pre > code")?.textContent,
      diagram: once.querySelector(".edgeever-html-code-block:has(.edgeever-html-mermaid)")?.textContent,
      renderedDiagram: once.querySelectorAll(".edgeever-html-mermaid svg").length,
      invalidDiagram: once.querySelector("pre > code.language-mermaid")?.textContent,
      injectedImages: once.querySelectorAll("img").length,
      untitledSource: once.textContent?.includes("untitled source"),
      invalidMetadataSource: once.textContent?.includes("invalid metadata"),
    };
  });
  expect(result.captions).toEqual([
    '示例 <img src=x onerror="alert(1)"> & 标题',
    "无语言标题", "流程图标题", "无效图表标题",
  ]);
  expect(result.repeatedCount).toBe(4);
  expect(result.firstSource).toBe('console.log("hello");');
  expect(result.diagram).toContain("流程图标题");
  expect(result.renderedDiagram).toBe(1);
  expect(result.invalidDiagram).toBe("this is not a mermaid diagram");
  expect(result.injectedImages).toBe(0);
  expect(result.untitledSource).toBe(true);
  expect(result.invalidMetadataSource).toBe(true);
});

test("exported HTML keeps offline code previews, copy and image zoom", async ({ page, browser }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  await page.goto("/");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#16a06e";
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = "white";
    context.font = "64px sans-serif";
    context.fillText("Offline image preview", 120, 400);
    return canvas.toDataURL();
  });
  const source = 'const text = "</script><script>window.exportEscaped = true</script>";\nconsole.log(text);';
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const response = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id, title: `interactive-export-${Date.now()}`,
    contentMarkdown: `## 离线交互\n\n\`\`\`javascript\n${source}\n\`\`\`\n\n`
      + '\`\`\`html\n<h2>HTML 卡片</h2><button onclick="parent.exportEscaped=true">不执行脚本</button><script>parent.exportEscaped=true</script>\n\`\`\`\n\n'
      + '\`\`\`md\n# Markdown 预览\n\n**加粗内容**\n\`\`\`\n\n'
      + '\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n'
      + `![第一张](${image})\n\n![第二张](${image})`,
  } });
  expect(response.status()).toBe(201);
  const { memo } = await response.json();
  const context = await browser.newContext({ offline: true, permissions: ["clipboard-read", "clipboard-write"] });
  context.setDefaultTimeout(10_000);
  try {
    // Load the app after the note exists so the list is populated on first render.
    await page.goto("/");
    await expect(page.getByRole("button", { name: "个人中心", exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    const row = page.locator(`[data-memo-id="${memo.id}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator("button").first().click();
    await expect(page.locator(".ProseMirror").first()).toContainText("离线交互");
    await page.getByRole("button", { name: "笔记更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出 HTML", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("dialog", { name: "导出 HTML", exact: true }).getByRole("button", { name: "导出 HTML", exact: true }).click();
    const file = test.info().outputPath("interactive.html");
    await (await downloadPromise).saveAs(file);
    const exported = await context.newPage();
    const errors: string[] = [];
    exported.on("pageerror", (error) => errors.push(error.message));
    await exported.goto(pathToFileURL(file).href);
    const blocks = exported.locator("[data-edgeever-code-interactive]");
    await expect(blocks).toHaveCount(4);
    const outline = exported.getByRole("navigation", { name: "文档大纲", exact: true });
    await expect(outline).toBeVisible();
    await expect(outline.getByRole("link")).toHaveText(["离线交互"]);
    await blocks.nth(0).getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(blocks.nth(0).getByRole("button", { name: "已复制", exact: true })).toBeVisible();
    expect(await exported.evaluate(() => navigator.clipboard.readText())).toBe(source);
    await expect(blocks.nth(1).frameLocator("iframe").getByRole("heading", { name: "HTML 卡片" })).toBeVisible();
    await blocks.nth(1).frameLocator("iframe").getByRole("button").click();
    expect(await exported.evaluate(() => (window as any).exportEscaped)).toBeUndefined();
    await expect(blocks.nth(1).locator("iframe")).toHaveAttribute("sandbox", "");
    await blocks.nth(1).getByRole("button", { name: "源码", exact: true }).click();
    await expect(blocks.nth(1).locator("pre")).toContainText("<h2>HTML 卡片</h2>");
    await blocks.nth(1).getByRole("button", { name: "预览", exact: true }).click();
    await expect(blocks.nth(2).getByRole("heading", { name: "Markdown 预览" })).toBeVisible();
    await expect(blocks.nth(3).locator("svg")).toBeVisible();
    await exported.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    });
    await blocks.nth(3).getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(blocks.nth(3).getByRole("button", { name: "已复制", exact: true })).toBeVisible();
    await exported.evaluate(() => {
      const input = document.createElement("textarea");
      input.id = "paste-check";
      document.body.appendChild(input);
    });
    await exported.locator("#paste-check").focus();
    await exported.keyboard.press("Control+V");
    await expect(exported.locator("#paste-check")).toHaveValue("graph TD\n  A --> B");
    await exported.locator("#paste-check").evaluate((element) => element.remove());
    await exported.evaluate(() => { document.execCommand = () => false; });
    await blocks.nth(2).getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(blocks.nth(2).getByRole("button", { name: "复制失败", exact: true })).toBeVisible();
    const firstImage = exported.getByRole("button", { name: "图片查看器: 第一张", exact: true });
    await firstImage.click();
    await expect(exported.locator(".yarl__root")).toBeVisible();
    await exported.getByRole("button", { name: "放大图片", exact: true }).click();
    const reset = exported.getByRole("button", { name: "重置缩放", exact: true });
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect(reset).toBeDisabled();
    await exported.getByRole("button", { name: "下一张", exact: true }).click();
    await expect(exported.getByRole("button", { name: "上一张", exact: true })).toBeEnabled();
    await exported.screenshot({ path: test.info().outputPath("offline-image-viewer.png") });
    await exported.keyboard.press("Escape");
    await expect(exported.locator(".yarl__root")).toHaveCount(0);
    await firstImage.focus();
    await firstImage.press("Enter");
    await expect(exported.locator(".yarl__root")).toBeVisible();
    await exported.getByRole("button", { name: "关闭图片查看器", exact: true }).click();
    await expect(exported.locator(".yarl__root")).toHaveCount(0);
    await exported.setViewportSize({ width: 390, height: 844 });
    await exported.evaluate(() => scrollTo(0, 0));
    await expect(blocks.nth(1).frameLocator("iframe").getByRole("heading", { name: "HTML 卡片" })).toBeVisible();
    await exported.screenshot({ path: test.info().outputPath("offline-code-mobile.png"), fullPage: true });
    expect(await exported.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});

test("print and PDF preview preserves code-block titles after pagination", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.evaluate(() => {
    const token = "code-title-export-test";
    const handler = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== "edgeever:note-print-ready" || event.data.token !== token) return;
      window.removeEventListener("message", handler);
      const root = document.createElement("div");
      for (const [title, source, language] of [
        ["打印代码标题", 'console.log("print");', "javascript"],
        ["打印图表标题", "graph TD\n  A --> B", "mermaid"],
      ]) {
        const pre = document.createElement("pre");
        pre.setAttribute("data-edgeever-code-meta", JSON.stringify({ v: 1, title }));
        const code = document.createElement("code");
        code.className = `language-${language}`;
        code.textContent = source;
        pre.append(code);
        root.append(pre);
      }
      (event.source as Window).postMessage({
        type: "edgeever:note-print", token, title: "Export test", notebook: "", tags: [], updatedAt: "",
        html: root.innerHTML, language: "zh-CN",
        labels: { close: "Close", error: "Error", hint: "Print", preparing: "Preparing", print: "Print", ready: "Ready" },
      }, location.origin);
    };
    window.addEventListener("message", handler);
    window.open(`/note-print.html?token=${token}`, "_blank");
  });
  const popup = await popupPromise;
  try {
    await expect(popup.locator("#print-status")).toHaveText("Ready", { timeout: 40_000 });
    await expect(popup.locator("#print-preview .edgeever-html-code-title")).toHaveText(["打印代码标题", "打印图表标题"]);
    await expect(popup.locator("#print-preview pre code")).toHaveText('console.log("print");');
    await expect(popup.locator("#print-preview .edgeever-print-mermaid svg")).toHaveCount(1);
  } finally {
    await popup.close();
  }
});
