import { expect, test } from "@playwright/test";

const visibleTaskMarkdown = (source: string) => source.replace(/<!-- edgeever:task-status (?:manual|auto) --> /g, "");

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["compact", { width: 390, height: 844 }],
] as const) {
  test(`${name} task checkboxes cycle on clicks and Space, persist, and respect preview mode`, async ({ page }) => {
    // Every mark waits for a server acknowledgement through the local queue,
    // so a loaded dev machine can take minutes.
    test.setTimeout(420_000);
    // Keep the dev API from proxying GitHub plugin manifests: an unreachable
    // github.com stalls workerd fast enough that unrelated PATCH saves 503.
    await page.route("**/api/v1/plugins/github/**", (route) => route.fulfill({ status: 404, body: "Plugin download disabled in this test" }));
    await page.setViewportSize(viewport);
    const compact = name === "compact";
    const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
    const created = await page.request.post("/api/v1/memos", { data: {
      notebookId: notebooks[0].id,
      title: `task-cycle-${name}-${Date.now()}`,
      contentMarkdown: "- [ ] Cycle parent\n  - [x] Keep child\n  - [ ] Empty child\n    - [ ] Empty grandchild\n\nText outside tasks.",
    } });
    expect(created.status()).toBe(201);
    const { memo } = await created.json();
    const openFromList = async () => {
      // The compact layout has no notebook sidebar; the note list is the home page.
      if (!compact) await page.getByRole("button", { name: "全部笔记", exact: true }).click();
      await page.locator(`[data-memo-id="${memo.id}"]`).locator("button").first().click();
    };
    try {
      await page.goto("/");
      await openFromList();
      const parent = () => page.locator('li[data-type="taskItem"]').first();
      if (compact) {
        // Compact opens notes in the read-only preview; the checkbox must not
        // change a mark until the note is opened for editing.
        await expect(parent()).toBeVisible({ timeout: 30_000 });
        await parent().locator(':scope > label input[type="checkbox"]').click();
        await expect(parent()).toHaveAttribute("data-checked", "false");
        await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
      } else {
        await page.getByRole("radio", { name: "编辑", exact: true }).click();
      }
      const editor = page.locator(".ProseMirror").first();
      await expect(editor).toContainText("Cycle parent", { timeout: 30_000 });
      const taskParent = parent();
      const child = editor.locator('li[data-type="taskItem"]').nth(1);
      const automaticDescendants = [2, 3].map(index => editor.locator('li[data-type="taskItem"]').nth(index));
      const checkbox = taskParent.locator(':scope > label input[type="checkbox"]');
      const assertState = async (checked: boolean, rejected: boolean) => {
        await expect(taskParent).toHaveAttribute("data-checked", String(checked));
        if (rejected) await expect(taskParent).toHaveAttribute("data-rejected", "true");
        else await expect(taskParent).not.toHaveAttribute("data-rejected", "true");
        if (checked) await expect(checkbox).toBeChecked();
        else await expect(checkbox).not.toBeChecked();
        await expect(child).toHaveAttribute("data-checked", "true");
        await expect(child).not.toHaveAttribute("data-rejected", "true");
        for (const descendant of automaticDescendants) {
          await expect(descendant).toHaveAttribute("data-checked", "false");
          if (checked || rejected) await expect(descendant).toHaveAttribute("data-rejected", "true");
          else await expect(descendant).not.toHaveAttribute("data-rejected", "true");
        }
      };
      const assertSaved = async (marker: string) => {
        const descendantMarker = marker === " " ? " " : "❌";
        await expect.poll(async () => {
          const response = await page.request.get(`/api/v1/memos/${memo.id}`);
          const saved = (await response.json()).memo;
          type TaskNode = { type: string; attrs?: Record<string, unknown>; content?: TaskNode[] };
          const marks: unknown[][] = [];
          const walk = (node: TaskNode) => {
            if (node.type === "taskItem") marks.push([node.attrs?.checked, node.attrs?.rejected, node.attrs?.statusSource ?? null]);
            node.content?.forEach(walk);
          };
          walk(saved.contentJson);
          return {
            hasMarkdown: visibleTaskMarkdown(saved.contentMarkdown).includes(`- [${marker}] Cycle parent\n  - [x] Keep child\n  - [${descendantMarker}] Empty child\n    - [${descendantMarker}] Empty grandchild`),
            marks,
          };
        }, { timeout: 60_000 }).toEqual({
          hasMarkdown: true,
          marks: [
            [marker === "x", marker === "❌", "manual"], [true, false, null],
            [false, marker !== " ", "auto"], [false, marker !== " ", "auto"],
          ],
        });
      };

      for (const [checked, rejected, marker] of [[true, false, "x"], [false, true, "❌"], [false, false, " "]] as const) {
        await checkbox.click();
        await assertState(checked, rejected);
        await assertSaved(marker);
      }
      // Rapid clicks also advance once per click, not as a special triple-click gesture.
      await checkbox.click({ clickCount: 3, delay: 60 });
      await assertState(false, false);
      await checkbox.click({ clickCount: 2, delay: 60 });
      await assertState(false, true);
      await checkbox.focus();
      await page.keyboard.press("Space");
      await assertState(false, false);
      await page.keyboard.press("Space");
      await assertState(true, false);
      await assertSaved("x");
      await page.reload();
      // Hydration after a reload can outlast the default expect timeout.
      await expect(editor).toContainText("Text outside tasks.", { timeout: 60_000 });
      await assertState(true, false);

      if (compact) {
        // "Done" returns to the list; reopening shows the read-only preview.
        await page.getByRole("button", { name: "完成", exact: true }).click();
        await openFromList();
        await expect(parent()).toBeVisible({ timeout: 30_000 });
        await expect(parent()).toHaveAttribute("data-checked", "true");
        await parent().locator(':scope > label input[type="checkbox"]').click();
        await expect(parent()).toHaveAttribute("data-checked", "true");
      } else {
        await page.getByRole("radio", { name: "预览", exact: true }).click();
        await checkbox.click();
        await assertState(true, false);
      }
      await page.waitForTimeout(1500);
      await expect.poll(async () => {
        const response = await page.request.get(`/api/v1/memos/${memo.id}`);
        return visibleTaskMarkdown((await response.json()).memo.contentMarkdown);
      }, { timeout: 30_000 }).toContain("- [x] Cycle parent");
    } finally {
      await page.request.delete(`/api/v1/memos/${memo.id}`);
      await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
    }
  });
}
