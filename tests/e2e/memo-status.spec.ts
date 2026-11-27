import { expect, test, type Page } from "@playwright/test";
import { createDefaultDiagramDocument, parseDiagramDocument, serializeDiagramDocument } from "../../packages/shared/src/diagram";

type Status = "in_progress" | "completed" | "cancelled" | null;
const choices: Array<{ status: Status; label: string }> = [
  { status: "in_progress", label: "进行中" },
  { status: "completed", label: "已完成" },
  { status: "cancelled", label: "已叉掉" },
  { status: null, label: "清除状态" },
];

const openMemo = async (page: Page, memoId: string) => {
  await page.getByRole("button", { name: "全部笔记", exact: true }).click();
  await page.locator(`[data-memo-id="${memoId}"]`).locator("button").first().click();
};

const expandToolbar = async (page: Page) => {
  const more = page.getByRole("button", { name: "显示更多编辑工具", exact: true });
  if (await more.isVisible()) await more.click();
};

const assertStatus = async (page: Page, memoId: string, title: string, status: Status, label: string) => {
  const titleInput = page.locator('input[maxlength="160"]').first();
  await expect(titleInput).toHaveValue(title);
  const headingRow = titleInput.locator("..").locator("..");
  const card = page.locator(`[data-memo-id="${memoId}"]`);
  if (status) {
    await expect(headingRow.locator("[data-memo-status]")).toHaveAttribute("data-memo-status", status);
    await expect(headingRow.locator("[data-memo-status]")).toHaveText(label);
    await expect(card.locator("[data-memo-status]")).toHaveAttribute("data-memo-status", status);
    await expect(card.locator("[data-memo-status]")).toHaveText(label);
  } else {
    await expect(headingRow.locator("[data-memo-status]")).toHaveCount(0);
    await expect(card.locator("[data-memo-status]")).toHaveCount(0);
  }
};

for (const kind of ["text", "flowchart"] as const) {
  test(`${kind} note status is optional and all four toolbar choices persist through saves and reload`, async ({ page }) => {
    test.setTimeout(480_000);
    await page.route("**/api/v1/plugins/github/**", route => route.fulfill({ status: 404, body: "Disabled in this test" }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.request.get("/api/v1/notebooks");
    expect(response.ok()).toBe(true);
    const { notebooks } = await response.json();
    const title = `memo-status-${kind}-${Date.now()}`;
    const contentMarkdown = kind === "text"
      ? "Status must preserve this body."
      : serializeDiagramDocument(createDefaultDiagramDocument("flowchart"));
    const created = await page.request.post("/api/v1/memos", { data: { notebookId: notebooks[0].id, title, contentMarkdown } });
    expect(created.status(), await created.text()).toBe(201);
    const { memo } = await created.json();
    expect(memo.status ?? null).toBeNull();
    let savedTitle = title;
    try {
      await page.goto("/");
      await openMemo(page, memo.id);
      if (kind === "text") await page.getByRole("radio", { name: "编辑", exact: true }).click();
      await expect(page.locator('input[maxlength="160"]').first()).toHaveValue(title);
      await assertStatus(page, memo.id, title, null, "");
      for (const { status, label } of choices) {
        await expandToolbar(page);
        const trigger = page.getByRole("button", { name: "笔记状态", exact: true });
        await expect(trigger).toBeEnabled();
        await trigger.click();
        const options = page.getByRole("menuitemradio");
        await expect(options).toHaveCount(4);
        await page.getByRole("menuitemradio", { name: label, exact: true }).click();
        await assertStatus(page, memo.id, savedTitle, status, label);
        await expect.poll(async () => (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo.status ?? null,
          { timeout: 30_000 }).toBe(status);
        // Exercise a normal content save after setting metadata. Its response
        // must keep the status rather than silently restoring an older value.
        savedTitle = `${title}-${status ?? "cleared"}`;
        await page.locator('input[maxlength="160"]').first().fill(savedTitle);
        await page.keyboard.press("Control+s");
        await expect.poll(async () => {
          const detail = (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo;
          return { title: detail.title, status: detail.status ?? null };
        }, { timeout: 30_000 }).toEqual({ title: savedTitle, status });
        const saved = (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo;
        if (kind === "text") {
          expect(saved.contentMarkdown).toContain(contentMarkdown);
        } else {
          // The graph normalizes layout while loading. Compare its authored
          // content rather than treating serialized coordinates as immutable.
          const original = parseDiagramDocument(contentMarkdown)!;
          const diagram = parseDiagramDocument(saved.contentMarkdown)!;
          expect(diagram.kind).toBe(original.kind);
          expect(diagram.nodes.map(({ id, label }) => ({ id, label }))).toEqual(original.nodes.map(({ id, label }) => ({ id, label })));
          expect(diagram.edges.map(({ source, target }) => ({ source, target }))).toEqual(original.edges.map(({ source, target }) => ({ source, target })));
        }
        }
      // One reload proves the saved choice survives a fresh load; each status
      // is already verified against the server above.
      await page.reload();
      await openMemo(page, memo.id);
      await assertStatus(page, memo.id, savedTitle, choices[choices.length - 1]!.status, "");
      if (kind === "text") {
        // Preview keeps the status visible, and exposes no editing entry.
        await expandToolbar(page);
        await page.getByRole("button", { name: "笔记状态", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "已完成", exact: true }).click();
        await assertStatus(page, memo.id, savedTitle, "completed", "已完成");
        await expect.poll(async () => (await (await page.request.get(`/api/v1/memos/${memo.id}`)).json()).memo.status,
          { timeout: 30_000 }).toBe("completed");
        await page.getByRole("radio", { name: "预览", exact: true }).click();
        await expect(page.getByRole("button", { name: "笔记状态", exact: true })).toHaveCount(0);
        await assertStatus(page, memo.id, savedTitle, "completed", "已完成");
        await page.getByRole("radio", { name: "编辑", exact: true }).click();
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('input[maxlength="160"]').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${kind}-status-narrow.png`) });
      expect(errors).toEqual([]);
    } finally {
      await page.request.delete(`/api/v1/memos/${memo.id}`);
      await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
    }
  });
}
