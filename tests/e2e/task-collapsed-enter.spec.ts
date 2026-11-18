import { expect, test } from "@playwright/test";

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["compact", { width: 390, height: 844 }],
] as const) {
  test(`${name} Enter after a collapsed task creates a sibling and preserves hidden descendants`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/plugins/github/**", (route) => route.fulfill({ status: 404, body: "Plugin download disabled in this test" }));
    await page.setViewportSize(viewport);
    const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
    const created = await page.request.post("/api/v1/memos", { data: {
      notebookId: notebooks[0].id,
      title: `collapsed-task-enter-${name}-${Date.now()}`,
      contentMarkdown: "- [❌] Parent task\n  - [x] Child task\n    - [ ] Grandchild task\n  - [ ] Second child\n- [ ] Following sibling\n\nOutside tasks.",
    } });
    expect(created.status()).toBe(201);
    const { memo } = await created.json();
    try {
      await page.goto("/");
      if (name === "desktop") await page.getByRole("button", { name: "全部笔记", exact: true }).click();
      await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
      if (name === "compact") await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
      else await page.getByRole("radio", { name: "编辑", exact: true }).click();
      const editor = page.locator(".ProseMirror").first();
      await expect(editor).toContainText("Parent task");
      const rootItems = editor.locator(':scope > ul[data-type="taskList"] > li');
      const parent = rootItems.first();
      const children = parent.locator(':scope > div > ul[data-type="taskList"] > li');
      const child = children.first();
      const grandchild = child.locator('li[data-type="taskItem"]');

      // The same Enter behavior must retain the current nesting level.
      await child.locator(":scope > .edgeever-task-toggle").click();
      await expect(grandchild).toBeHidden();
      const childBefore = await editor.evaluate((element) => (element as any).editor.getJSON().content[0].content[0].content[1].content[0]);
      await child.locator(":scope > div > p").first().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(children).toHaveCount(3);
      await page.keyboard.insertText("New child sibling");
      await expect(children.nth(1).locator("p")).toHaveText("New child sibling");
      await expect(children.nth(1)).toHaveAttribute("data-checked", "false");
      await expect(grandchild).toBeHidden();
      expect(await editor.evaluate((element) => (element as any).editor.getJSON().content[0].content[0].content[1].content[0])).toEqual(childBefore);

      // Collapsing the outer task leaves all existing children on that task.
      await parent.locator(":scope > .edgeever-task-toggle").click();
      await expect(child).toBeHidden();
      const parentBefore = await editor.evaluate((element) => (element as any).editor.getJSON().content[0].content[0]);
      await parent.locator(":scope > div > p").first().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(rootItems).toHaveCount(3);
      const sibling = rootItems.nth(1);
      await expect(sibling).toBeVisible();
      await expect(sibling).toHaveAttribute("data-checked", "false");
      await expect(sibling).not.toHaveAttribute("data-rejected", "true");
      await expect(sibling).toHaveAttribute("data-collapsed", "false");
      await page.keyboard.insertText("New root sibling");
      await expect(sibling.locator("p")).toHaveText("New root sibling");
      await expect(parent).toHaveAttribute("data-collapsed", "true");
      await expect(child).toBeHidden();
      await expect(rootItems.last().locator("p")).toHaveText("Following sibling");
      expect(await editor.evaluate((element) => (element as any).editor.getJSON().content[0].content[0])).toEqual(parentBefore);
      await page.screenshot({ path: test.info().outputPath(`collapsed-task-enter-${name}.png`) });

      await parent.locator(":scope > .edgeever-task-toggle").click();
      await expect(child).toBeVisible();
      await expect(grandchild).toBeHidden();
      await child.locator(":scope > .edgeever-task-toggle").click();
      await expect(grandchild).toBeVisible();
      await expect(grandchild.locator("p")).toHaveText("Grandchild task");
      await expect.poll(async () => {
        const response = await page.request.get(`/api/v1/memos/${memo.id}`);
        return (await response.json()).memo.contentMarkdown;
      }, { timeout: 60_000 }).toContain("- [ ] New root sibling");
      expect(errors).toEqual([]);
    } finally {
      await page.request.delete(`/api/v1/memos/${memo.id}`);
      await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
    }
  });
}
