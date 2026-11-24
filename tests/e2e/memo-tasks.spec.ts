import { expect, test } from "@playwright/test";

const cross = "❌";

test("task overview and in-note dialog derive progress and persist marks", async ({ page }) => {
  // The overview walks every note and each mark save waits for a server
  // acknowledgement, so a loaded local machine can take minutes.
  test.setTimeout(300_000);
  // Keep the dev API from proxying GitHub plugin manifests: an unreachable
  // github.com stalls workerd fast enough that unrelated PATCH saves 503.
  await page.route("**/api/v1/plugins/github/**", (route) => route.fulfill({ status: 404, body: "Plugin download disabled in this test" }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const title = `task-views-${Date.now()}`;
  const created = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id, title,
    contentMarkdown: `## Task section\n\n- [ ] Parent\n  - [x] Done child\n  - [${cross}] Crossed child\n  - [ ] Pending child\n- [ ] Untouched\n- [x] Completed root\n- [${cross}] Rejected root\n\nText outside tasks.`,
  } });
  expect(created.status()).toBe(201);
  const { memo } = await created.json();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "全部笔记", exact: true }).click();
    await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    await page.getByRole("radio", { name: "编辑", exact: true }).click();
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("Pending child");
    const trigger = page.getByRole("button", { name: "本文待办", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "本文待办", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("全部笔记", { exact: true })).toHaveCount(0);
    const parent = dialog.locator('[data-task-status="doing"]').filter({ has: page.getByText("Parent", { exact: true }) });
    await expect(parent).toBeVisible();
    const group = dialog.locator('[data-task-group="doing"]');
    expect(await group.evaluate(element => element.querySelector("[data-task-group-content]")!.getBoundingClientRect().left > element.querySelector("[data-task-group-label]")!.getBoundingClientRect().right)).toBe(true);
    await dialog.getByRole("button", { name: "展开 Parent", exact: true }).click();
    const childRow = dialog.locator('[data-task-id]').filter({ has: page.getByText("Pending child", { exact: true }) }).first();
    for (const [status, marker] of [["done", "x"], ["rejected", cross], ["pending", " "], ["done", "x"]]) {
      await childRow.getByRole("button", { name: /更改标记/ }).click();
      await expect(childRow).toHaveAttribute("data-task-status", status);
      await expect(parent).toBeVisible();
      await expect.poll(async () => (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo.contentMarkdown, { timeout: 30_000 }).toContain(`- [${marker}] Pending child`);
    }
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("article-tasks-desktop.png") });
    // Rejecting a parent crosses out its subtree; re-opening clears the cascade.
    // A row that changes status moves between groups, so switch to the unfiltered
    // view and open both groups before cycling.
    await dialog.locator('button[aria-pressed]').filter({ hasText: "全部" }).click();
    for (const group of ["done", "rejected"]) {
      const header = dialog.locator(`[data-task-group="${group}"] > button`);
      if ((await header.getAttribute("aria-expanded")) === "false") {
        await header.click();
      }
    }
    // This locator must not pin a status: the row leaves [data-task-status=doing].
    const stableParent = dialog.locator("[data-task-id]").filter({ has: page.getByText("Parent", { exact: true }) }).first();
    await stableParent.getByRole("button", { name: /更改标记/ }).click();
    await expect(stableParent).toHaveAttribute("data-task-status", "done");
    await stableParent.getByRole("button", { name: /更改标记/ }).click();
    await expect(stableParent).toHaveAttribute("data-task-status", "rejected");
    await expect(childRow).toHaveAttribute("data-task-status", "rejected");
    await expect.poll(async () => (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo.contentMarkdown, { timeout: 30_000 })
      .toContain(`- [${cross}] Parent\n  - [${cross}] Done child\n  - [${cross}] Crossed child\n  - [${cross}] Pending child`);
    await stableParent.getByRole("button", { name: /更改标记/ }).click();
    await expect(stableParent).toHaveAttribute("data-task-status", "pending");
    await expect(childRow).toHaveAttribute("data-task-status", "pending");
    // The rejected cascade reset every child to pending; re-check one child so
    // the parent derives "doing" again for the later filter steps.
    await childRow.getByRole("button", { name: /更改标记/ }).click();
    await expect(childRow).toHaveAttribute("data-task-status", "done");
    await expect(stableParent).toHaveAttribute("data-task-status", "doing");
    // The later overview steps read persisted data, so wait for the restore.
    await expect.poll(async () => (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo.contentMarkdown, { timeout: 30_000 })
      .toContain(`- [ ] Parent\n  - [ ] Done child\n  - [ ] Crossed child\n  - [x] Pending child`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.locator('button[aria-pressed]').filter({ hasText: "已完成" }).click();
    const doneChild = dialog.locator('[data-task-status="done"]').filter({ has: page.getByText("Pending child", { exact: true }) });
    await doneChild.getByRole("button", { name: /定位原文/ }).click();
    await expect(dialog).toBeHidden();
    await expect(editor.locator("p").filter({ hasText: /^Pending child$/ })).toBeInViewport();
    const parentItem = editor.locator('li[data-type="taskItem"]').first();
    await parentItem.locator(":scope > .edgeever-task-toggle").click();
    await expect(parentItem).toHaveAttribute("data-collapsed", "true");
    await trigger.click();
    await dialog.locator('button[aria-pressed]').filter({ hasText: "进行中" }).click();
    const parentTarget = dialog.locator('[data-task-status="doing"]').filter({ has: page.getByText("Parent", { exact: true }) });
    await expect(parentTarget).toBeVisible();
    // A status filter keeps the outline: the done child stays nested as context
    // instead of the whole list becoming flat.
    const nestedChild = dialog.locator("[data-task-context]").filter({ has: page.getByText("Pending child", { exact: true }) });
    await expect(nestedChild).toBeVisible();
    expect(await nestedChild.evaluate(
      (element, parent) => element.getBoundingClientRect().left > parent.getBoundingClientRect().left,
      await parentTarget.elementHandle(),
    )).toBe(true);
    await parentTarget.getByRole("button", { name: /定位原文/ }).click();
    await expect(dialog).toBeHidden();
    await expect(parentItem).toHaveAttribute("data-collapsed", "true");
    await expect(parentItem.locator(":scope > div > p").first()).toBeInViewport();

    await page.getByRole("button", { name: "待办总览", exact: true }).click();
    await expect(page.getByRole("heading", { name: "待办总览", exact: true })).toBeVisible();
    const overviewSearch = page.getByRole("textbox", { name: "搜索待办内容或笔记…" });
    await overviewSearch.fill(title);
    await expect(page.locator('[data-task-status="doing"]').filter({ has: page.getByText("Parent", { exact: true }) })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("task-overview-desktop.png") });
    const globalParent = page.locator('[data-task-status="doing"]').filter({ has: page.getByText("Parent", { exact: true }) });
    await globalParent.getByRole("button", { name: /更改标记/ }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo.contentMarkdown, { timeout: 30_000 }).toContain("- [x] Parent");
    await overviewSearch.fill("No such task anywhere");
    await expect(page.getByText("没有匹配的待办", { exact: true })).toBeVisible();
    await overviewSearch.fill(title);
    await page.locator('button[aria-pressed]').filter({ hasText: "已完成" }).click();
    const completedParent = page.locator('[data-task-status="done"]').filter({ has: page.getByText("Parent", { exact: true }) });
    await completedParent.getByRole("button", { name: /定位原文/ }).click();
    await expect(editor).toContainText("Parent");
    await expect(editor.locator('li[data-type="taskItem"]').first()).toHaveAttribute("data-checked", "true");
    await page.reload();
    // The editor remounts after the reload; hydration can outlast the default
    // expect timeout while the dev API proxies slow plugin manifests.
    await expect(editor).toContainText("Text outside tasks.", { timeout: 30_000 });
    await expect(editor.locator('li[data-type="taskItem"]').first()).toHaveAttribute("data-checked", "true");
    await page.getByRole("radio", { name: "预览", exact: true }).click();
    await page.getByRole("button", { name: "本文待办", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /更改标记/ }).first()).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("article-tasks-mobile.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
