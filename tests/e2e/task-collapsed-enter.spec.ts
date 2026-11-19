import { expect, test, type Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";

const focusParagraphEnd = (paragraph: Locator) => paragraph.evaluate((element) => {
  const editorElement = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
  const { commands, view } = editorElement.editor;
  commands.setTextSelection(view.posAtDOM(element, element.childNodes.length));
  view.focus();
});

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

      const parentTitle = parent.locator(":scope > div > p").first();
      const enterAfterParent = async () => {
        await focusParagraphEnd(parentTitle);
        await page.keyboard.press("Enter");
        await expect(rootItems).toHaveCount(4);
      };
      await enterAfterParent();
      if (name === "compact") {
        await page.getByRole("button", { name: "增加列表层级（Tab）", exact: true }).click();
      } else {
        await page.keyboard.press("Tab");
      }
      await expect(parent).toHaveAttribute("data-collapsed", "false");
      await expect(rootItems).toHaveCount(3);
      await expect(parent.locator(":scope > div > p").first()).toHaveText("Parent task");
      await page.keyboard.insertText("Indented child");
      await expect(children.last().locator("p")).toHaveText("Indented child");
      await expect(children.last()).toBeVisible();
      await expect(grandchild).toBeHidden();

      await parent.locator(":scope > .edgeever-task-toggle").click();
      await enterAfterParent();
      await page.keyboard.press("Backspace");
      await expect(parent).toHaveAttribute("data-collapsed", "false");
      await expect(rootItems).toHaveCount(3);
      await page.keyboard.insertText("Child paragraph");
      await expect(parent.locator(":scope > div > p")).toHaveText(["Parent task", "Child paragraph"]);
      await child.locator(":scope > .edgeever-task-toggle").click();
      await expect(grandchild).toBeVisible();
      await expect(grandchild.locator("p")).toHaveText("Grandchild task");

      const followingParagraphs = rootItems.last().locator(":scope > div > p");
      await followingParagraphs.first().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(rootItems).toHaveCount(4);
      await page.keyboard.press("Enter");
      await expect(rootItems).toHaveCount(3);
      await page.keyboard.insertText("Consecutive Enter paragraph");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.insertText("Shift+Enter paragraph");
      await expect(followingParagraphs).toHaveText([
        "Following sibling", "Consecutive Enter paragraph", "Shift+Enter paragraph",
      ]);

      const expandedParent = rootItems.last();
      await focusParagraphEnd(expandedParent.locator(":scope > div > p").first());
      const beforeExpandedDoubleEnter = await editor.evaluate((element) => {
        const document = (element as any).editor.getJSON();
        return structuredClone(document.content[0].content.at(-1).content.at(-1));
      });
      await page.keyboard.press("Enter");
      await expect(rootItems).toHaveCount(4);
      await page.keyboard.press("Enter");
      await expect(rootItems).toHaveCount(3);
      await page.keyboard.insertText("Expanded child paragraph");
      await expect(expandedParent.locator(":scope > div > p")).toHaveText([
        "Following sibling", "Expanded child paragraph", "Consecutive Enter paragraph", "Shift+Enter paragraph",
      ]);
      expect(await editor.evaluate((element) => (element as any).editor.getJSON().content[0].content.at(-1).content.at(-1)))
        .toEqual(beforeExpandedDoubleEnter);

      await page.screenshot({ path: test.info().outputPath(`task-sub-items-${name}.png`) });
      if (name === "compact") await page.getByRole("button", { name: "完成", exact: true }).click();
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

test("expanded task insertion, folding and selected-block indentation preserve task trees", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const created = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id,
    title: `task-hierarchy-${Date.now()}`,
    contentMarkdown: "- [ ] Parent\n  - [x] Existing child\n    - [❌] Grandchild\n  - [ ] Second child\n- [ ] Following\n\nSelected one\n\nSelected two\n\nUnselected",
  } });
  expect(created.status()).toBe(201);
  const { memo } = await created.json();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("Parent");
    const rootItems = editor.locator(':scope > ul[data-type="taskList"] > li');
    const parent = rootItems.first();
    const title = parent.locator(":scope > div > p").first();
    const children = parent.locator(':scope > div > ul[data-type="taskList"] > li');
    const originalChild = await editor.evaluate(element => (element as any).editor.getJSON().content[0].content[0].content[1].content[0]);

    await focusParagraphEnd(title);
    await page.keyboard.press("Enter");
    await expect(rootItems).toHaveCount(3);
    await expect(children).toHaveCount(2);
    await page.keyboard.press("Tab");
    await expect(rootItems).toHaveCount(2);
    await expect(children).toHaveCount(3);
    await page.keyboard.insertText("First inserted");
    await expect(children.first().locator("p")).toHaveText("First inserted");
    expect(await editor.evaluate(element => (element as any).editor.getJSON().content[0].content[0].content[1].content[1])).toEqual(originalChild);

    await parent.locator(":scope > .edgeever-task-toggle").click();
    await expect(parent).toHaveAttribute("data-collapsed", "true");
    await expect(children.first()).toBeHidden();
    expect(await title.evaluate(element => element.contains(window.getSelection()?.anchorNode ?? null))).toBe(true);
    await page.keyboard.insertText(" continued");
    await expect(title).toHaveText("Parent continued");
    await expect(rootItems.last().locator("p")).toHaveText("Following");
    await page.keyboard.press("Control+z");
    await expect(title).toHaveText("Parent");
    await expect(parent).toHaveAttribute("data-collapsed", "true");

    await editor.evaluate(element => {
      const instance = (element as any).editor as Editor;
      const paragraphs = Array.from(element.children).filter(child => child.tagName === "P");
      const first = paragraphs.find(child => child.textContent === "Selected one")!;
      const second = paragraphs.find(child => child.textContent === "Selected two")!;
      instance.commands.setTextSelection({
        from: instance.view.posAtDOM(first, 0),
        to: instance.view.posAtDOM(second, second.childNodes.length),
      });
      instance.view.focus();
    });
    await page.keyboard.press("Tab");
    await expect(rootItems.last().locator(":scope > div > p")).toHaveText(["Following", "Selected one", "Selected two"]);
    await expect(editor.locator(":scope > p")).toHaveText(["Unselected"]);
    await expect(parent).toHaveAttribute("data-collapsed", "true");
    await page.screenshot({ path: test.info().outputPath("task-hierarchy-selection.png") });
    await expect.poll(async () => {
      const { memo: saved } = await (await page.request.get(`/api/v1/memos/${memo.id}`)).json();
      return saved.contentJson.content[0].content.at(-1).content.map((node: any) => node.content?.[0]?.text ?? "");
    }, { timeout: 60_000 }).toEqual(["Following", "Selected one", "Selected two"]);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
