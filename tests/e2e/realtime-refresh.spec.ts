import { expect, test } from "@playwright/test";

/**
 * Cross-client freshness: a save from another device must reach an already
 * open preview without a reload. The watcher polls the workspace cursor, pulls
 * the change and invalidates the open detail query.
 */
test("an external edit reaches the open preview without reloading", async ({ page }) => {
  test.setTimeout(120_000);
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const created = await page.request.post("/api/v1/memos", {
    data: { notebookId: notebooks[0].id, title: `realtime-${Date.now()}`, contentMarkdown: "初始正文" },
  });
  expect(created.status()).toBe(201);
  const { memo } = await created.json();

  try {
    await page.goto(`/?openMemo=${memo.id}`);
    const preview = page.locator(".edgeever-workspace-editor");
    await expect(preview).toContainText("初始正文");

    const detail = await (await page.request.get(`/api/v1/memos/${memo.id}`)).json();
    const session = await (await page.request.post(`/api/v1/memos/${memo.id}/edit-sessions`, { data: {} })).json();
    const saved = await page.request.post(`/api/v1/memos/${memo.id}/save`, {
      data: {
        expectedRevision: detail.memo.revision,
        expectedContentHash: detail.memo.contentHash,
        editSessionId: session.editSession.id,
        title: detail.memo.title,
        tags: detail.memo.tags,
        contentMarkdown: "另一台设备写入的正文",
      },
    });
    expect(saved.ok()).toBe(true);

    await expect(preview).toContainText("另一台设备写入的正文", { timeout: 25_000 });
  } finally {
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
