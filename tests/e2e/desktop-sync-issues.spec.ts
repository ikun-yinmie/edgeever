import { expect, test } from "@playwright/test";

test.use({ actionTimeout: 10_000 });

test("sync details identify each conflicting note without exposing its content in feedback", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const notebooks = [
    { id: "sync-parent", parentId: null, name: "项目" },
    { id: "sync-work", parentId: "sync-parent", name: "工作" },
    { id: "sync-home", parentId: null, name: "生活" },
  ].map((notebook) => ({
    ...notebook, slug: null, icon: null, color: null, sortOrder: 0, memoCount: 0,
    lastMemoUpdatedAt: null, createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z",
  }));
  await page.route("**/api/v1/notebooks", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { notebooks } }) : route.continue());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "个人中心", exact: true })).toBeVisible();
  await page.evaluate((notebooks) => {
    const makeItem = (id: number, memoId: string, payload: Record<string, unknown>, extra = {}) => ({
      id, kind: "memo.update", entityId: memoId, payload, attemptCount: 1, version: 1,
      status: "conflict", lastError: "Note changed before the offline draft could sync.",
      lastErrorCode: "revision_conflict", retryable: false, updatedAt: "2026-11-14T00:00:00Z", ...extra,
    });
    const items = [
      makeItem(1, "sync-memo-work", { title: "同步测试计划", contentMarkdown: "private body" }),
      makeItem(2, "sync-memo-home", { title: "同步测试计划", contentMarkdown: "private body" }),
      makeItem(3, "sync-memo-draft", { title: "未同步草稿", notebookId: "sync-work" }, { status: "error", lastErrorCode: "memo_not_found", lastError: "Memo not found" }),
      makeItem(4, "batch", { memoIds: ["sync-memo-work", "sync-memo-untitled", "sync-memo-missing"] }, { kind: "memo.pinBatch" }),
    ];
    const memos = new Map([
      ["sync-memo-work", { title: "本地另一个标题", notebookId: "sync-work" }],
      ["sync-memo-home", { title: "同步测试计划", notebookId: "sync-home" }],
      ["sync-memo-untitled", { title: null, notebookId: "sync-home" }],
    ]);
    const requests: string[] = [];
    Object.assign(window, {
      syncIssueRequests: requests,
      edgeeverDesktop: {
        isAvailable: true,
        apiBaseUrl: location.origin,
        onCommand: () => () => {},
        onImportMarkdown: () => () => {},
        onScheduledTask: () => () => {},
        syncScheduledTasks: async () => ({ scheduled: 0 }),
        setAccountScope: async () => ({ ready: true, scope: "test" }),
        getSessionToken: () => "",
        listStagedResources: async () => [],
        getProxySettings: async () => ({ mode: "off", protocol: "http", host: "", port: 0 }),
        onUpdateStatus: () => () => {},
        updateStatus: async () => ({ state: "idle", currentVersion: "1.0.0" }),
        systemInfo: async () => ({ appVersion: "1.0.0", autoUpdateSupported: false, platform: "linux", architecture: "x64", deviceModel: "Test", osVersion: "Linux", electron: "40", chrome: "144" }),
        sidecarRequest: async (method: string, params: { memoId?: string; includeDeleted?: boolean; includeConflicts?: boolean }) => {
          requests.push(method);
          if (method === "sync.outbox.list") return { items: params.includeConflicts ? items : [] };
          if (method === "notebook.list") return { notebooks };
          if (method === "memo.list") return { memos: [], totalCount: 0, nextCursor: null };
          if (method === "memo.get") {
            if (!params.includeDeleted) throw new Error("Deleted notes must remain identifiable");
            const memo = memos.get(params.memoId!);
            if (!memo) throw new Error("Memo not found");
            return { memo: { ...memo, id: params.memoId, contentMarkdown: "private body" } };
          }
          if (method === "sync.status") return { pending: 1, syncing: 0, error: 1, conflict: 3, cursor: 0, lastSyncedAt: null };
          throw new Error(`Unexpected test RPC: ${method}`);
        },
      },
    });
  }, notebooks);
  await page.getByRole("searchbox", { name: "搜索笔记本", exact: true }).fill("项目");
  await page.getByRole("status").getByRole("button", { name: /^(已同步|3 项同步冲突)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "同步详情", exact: true });
  await expect(dialog).toBeVisible();
  const affectedLists = dialog.getByRole("list", { name: "涉及的笔记", exact: true });
  await expect(affectedLists).toHaveCount(4);
  await expect(affectedLists.nth(0)).toContainText("同步测试计划");
  await expect(affectedLists.nth(0)).toContainText("所属分类：项目 / 工作");
  await expect(affectedLists.nth(0)).toContainText("笔记 ID：sync-memo-work");
  await expect(affectedLists.nth(1)).toContainText("同步测试计划");
  await expect(affectedLists.nth(1)).toContainText("所属分类：生活");
  await expect(affectedLists.nth(1)).toContainText("笔记 ID：sync-memo-home");
  await expect(affectedLists.nth(2)).toContainText("未同步草稿");
  await expect(affectedLists.nth(2)).toContainText("所属分类：项目 / 工作");
  await expect(affectedLists.nth(3).getByRole("listitem")).toHaveCount(3);
  await expect(affectedLists.nth(3)).toContainText("本地另一个标题");
  await expect(affectedLists.nth(3)).toContainText("无标题笔记");
  await expect(affectedLists.nth(3)).toContainText("笔记标题不可用");
  await expect(affectedLists.nth(3)).toContainText("笔记 ID：sync-memo-missing");
  await expect(dialog.getByText("同步冲突", { exact: true })).toHaveCount(3);
  const reportLink = dialog.getByRole("link", { name: "反馈问题", exact: true });
  await expect(reportLink).toBeVisible();
  const reportUrl = new URL((await reportLink.getAttribute("href"))!);
  const report = reportUrl.searchParams.get("body")!;
  expect(report).not.toContain("同步测试计划");
  expect(report).not.toContain("sync-memo-work");
  expect(report).not.toContain("private body");
  expect(await page.evaluate(() => (window as unknown as { syncIssueRequests: string[] }).syncIssueRequests.every((method) => ["sync.outbox.list", "memo.get", "memo.list", "notebook.list", "sync.status"].includes(method)))).toBe(true);
  await dialog.screenshot({ path: test.info().outputPath("sync-issues-identifiable.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});
