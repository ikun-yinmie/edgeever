import { expect, test } from "@playwright/test";

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
