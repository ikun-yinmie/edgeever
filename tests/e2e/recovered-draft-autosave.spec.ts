import { expect, test, type Page } from "@playwright/test";

const writeRecoveredDraft = (
  page: Page,
  draft: { memoId: string; title: string; marker: string },
) => page.evaluate(({ memoId, title, marker }) => new Promise<void>((resolve, reject) => {
  const openRequest = indexedDB.open("edgeever-local");
  openRequest.onerror = () => reject(openRequest.error);
  openRequest.onsuccess = () => {
    const database = openRequest.result;
    const transaction = database.transaction("drafts", "readwrite");
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.objectStore("drafts").put({
      memoId,
      title,
      tagsText: "",
      contentJson: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: marker }],
        }],
      },
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
  };
}), draft);

const openMemo = async (page: Page, memoId: string, title: string) => {
  await page.getByRole("button", { name: "全部笔记", exact: true }).click();
  await page.getByPlaceholder("搜索笔记", { exact: true }).fill(title);
  await page.locator(`[data-memo-id="${memoId}"]`).locator("button").first().click();
};

test("automatically saves a recovered local draft after reload", async ({ page }) => {
  test.setTimeout(90_000);
  await page.route("**/api/v1/plugins/github/**", (route) => route.fulfill({ status: 404, body: "Plugin download disabled in this test" }));
  const marker = `recovered-draft-${Date.now()}`;
  const title = `Recovered draft ${Date.now()}`;
  const notebooksResponse = await page.request.get("/api/v1/notebooks");
  expect(notebooksResponse.ok()).toBe(true);
  const notebooks = await notebooksResponse.json() as { notebooks: Array<{ id: string }> };
  const notebookId = notebooks.notebooks[0]?.id;
  expect(notebookId).toBeTruthy();

  const createResponse = await page.request.post("/api/v1/memos", {
    data: { notebookId, title, contentMarkdown: "Saved server content" },
  });
  expect(createResponse.status()).toBe(201);
  const memoId = (await createResponse.json() as { memo: { id: string } }).memo.id;
  let releaseSessions = () => {};

  try {
    await page.goto("/");
    await openMemo(page, memoId, title);
    await expect(page.locator(".ProseMirror[contenteditable='true']")).toContainText("Saved server content");

    await writeRecoveredDraft(page, { memoId, title, marker });
    const sessionsGate = new Promise<void>((resolve) => { releaseSessions = resolve; });
    await page.route(`**/api/v1/memos/${memoId}/edit-sessions`, async (route) => {
      await sessionsGate;
      await route.continue();
    });
    await page.reload();
    await openMemo(page, memoId, title);

    const editor = page.locator(".ProseMirror[contenteditable='true']");
    await expect(editor).toContainText(marker);
    await expect.poll(() => page.evaluate(({ memoId, marker }) => new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open("edgeever-local");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction("syncQueue", "readonly").objectStore("syncQueue").getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => {
          db.close();
          resolve(read.result.some((item) => item.kind === "memo.update" && item.memoId === memoId && JSON.stringify(item.payload).includes(marker)));
        };
      };
    }), { memoId, marker })).toBe(true);
    await expect(page.getByText("保存失败", { exact: true })).toHaveCount(0);
    releaseSessions();

    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/memos/${memoId}`);
      const body = await response.json() as { memo: { contentJson: unknown } };
      return JSON.stringify(body.memo.contentJson);
    }, { timeout: 20_000 }).toContain(marker);

    await expect(page.getByText("未保存", { exact: true })).toHaveCount(0);
  } finally {
    releaseSessions();
    await page.request.delete(`/api/v1/memos/${memoId}`);
    await page.request.delete(`/api/v1/memos/${memoId}?permanent=1`);
  }
});
