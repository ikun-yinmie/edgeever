import { expect, test } from "@playwright/test";

test("task child images share rows, retain individual scaling and collapse with their task", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/task-layout-*.svg", async route => {
    const tall = route.request().url().includes("tall");
    await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${tall ? 200 : 80}"><rect width="100%" height="100%" fill="${tall ? "#dcece2" : "#e5e7eb"}"/></svg>` });
  });
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const created = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id,
    title: `task-image-layout-${Date.now()}`,
    contentMarkdown: "- [ ] Pictures in task\n\n  ![First](/task-layout-tall.svg)\n\n  ![Second](/task-layout-short.svg)\n\n  Following paragraph\n\n  - [ ] Nested task\n\nText outside tasks.",
  } });
  expect(created.status()).toBe(201);
  const { memo } = await created.json();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("Pictures in task");
    const task = editor.locator('li[data-type="taskItem"]').first();
    const content = task.locator(":scope > div");
    const images = content.locator(":scope > .node-image > .edgeever-image-node");
    await expect(images).toHaveCount(2);
    const first = images.nth(0);
    const second = images.nth(1);
    await expect(first.locator("img")).toBeVisible();
    await expect(second.locator("img")).toBeVisible();
    const assertSameRow = async () => {
      const a = (await first.boundingBox())!;
      const b = (await second.boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(2);
      expect(b.x).toBeGreaterThan(a.x + a.width);
      const following = (await content.locator(":scope > p").filter({ hasText: "Following paragraph" }).boundingBox())!;
      expect(following.y).toBeGreaterThanOrEqual(a.y + a.height);
      expect(following.y).toBeGreaterThanOrEqual(b.y + b.height);
    };
    await assertSameRow();
    expect(await first.locator("img").evaluate(image => getComputedStyle(image).objectFit)).toBe("contain");
    await first.locator("img").click();
    const widthInput = first.locator('input[type="number"]');
    await widthInput.fill("100");
    await expect(first).toHaveAttribute("data-width", "100");
    await expect.poll(async () => Math.abs((await first.boundingBox())!.width - (await content.boundingBox())!.width)).toBeLessThan(2);
    expect((await second.boundingBox())!.y).toBeGreaterThan((await first.boundingBox())!.y);
    await widthInput.fill("25");
    await expect(first).toHaveAttribute("data-width", "25");
    await assertSameRow();

    // Resizing a 25% image is measured against the task, not its small outer box.
    const handle = (await first.locator(".edgeever-image-resize-handle").boundingBox())!;
    const area = (await content.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * 0.6, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Number(await first.getAttribute("data-width"))).toBeCloseTo(60, 0);
    await widthInput.fill("25");
    await expect(first).toHaveAttribute("data-width", "25");
    await assertSameRow();

    await task.locator(":scope > .edgeever-task-toggle").click();
    await expect(images.first()).toBeHidden();
    await task.locator(":scope > .edgeever-task-toggle").click();
    await expect(images.first()).toBeVisible();
    await assertSameRow();
    await expect(content.locator(':scope > ul[data-type="taskList"]')).toContainText("Nested task");
    await page.screenshot({ path: test.info().outputPath("task-images-desktop.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await assertSameRow();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("task-images-compact.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
