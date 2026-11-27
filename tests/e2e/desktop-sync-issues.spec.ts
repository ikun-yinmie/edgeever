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
  const feedbackSubmissions: { content: string; systemInfo: string | null }[] = [];
  await page.route("**/api/v1/public/feedback", (route) => route.fulfill({ json: { feedback: { enabled: true, contactEmail: null } } }));
  await page.route("**/api/v1/feedback", (route) => {
    feedbackSubmissions.push(route.request().postDataJSON());
    if (feedbackSubmissions.length === 1) return route.fulfill({
      status: 502, json: { error: { code: "email_delivery_failed", message: "SMTP unavailable" } },
    });
    return route.fulfill({ json: { ok: true } });
  });
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
  const pauseAll = dialog.getByRole("switch", { name: "暂停全部同步", exact: true });
  const pausePull = dialog.getByRole("switch", { name: "从服务器拉取", exact: true });
  const pausePush = dialog.getByRole("switch", { name: "向服务器上传", exact: true });
  await expect(pauseAll).toBeVisible();
  await expect(pausePull).toBeVisible();
  await expect(pausePush).toBeVisible();
  await expect(pauseAll).not.toBeChecked();
  await pauseAll.check();
  await expect(pausePull).toBeChecked();
  await expect(pausePush).toBeChecked();
  await pauseAll.uncheck();
  await expect(pausePull).not.toBeChecked();
  await expect(pausePush).not.toBeChecked();
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
  await dialog.getByRole("button", { name: "反馈问题", exact: true }).click();
  const feedback = page.getByRole("dialog", { name: "意见反馈", exact: true });
  await expect(feedback).toBeVisible();
  const content = feedback.getByLabel("反馈内容", { exact: true });
  const includeSystemInfo = feedback.getByRole("checkbox");
  await expect(includeSystemInfo).not.toBeChecked();
  await content.fill("同步冲突无法上传");
  await includeSystemInfo.check();
  await includeSystemInfo.uncheck();
  await feedback.getByRole("button", { name: "关闭", exact: true }).click();
  await dialog.getByRole("button", { name: "反馈问题", exact: true }).click();
  await expect(includeSystemInfo).not.toBeChecked();
  await expect(content).toHaveValue("同步冲突无法上传");
  await feedback.getByRole("button", { name: "提交反馈", exact: true }).click();
  await expect(feedback.getByRole("alert")).toContainText("反馈邮件发送失败");
  expect(feedbackSubmissions[0].systemInfo).toBeNull();
  await includeSystemInfo.check();
  await feedback.getByRole("button", { name: "提交反馈", exact: true }).click();
  await expect(feedback).toContainText("反馈已发送");
  expect(feedbackSubmissions).toHaveLength(2);
  const submitted = feedbackSubmissions[1];
  const diagnostics = submitted.systemInfo ?? "";
  expect(diagnostics).toContain("自动采集的同步诊断");
  expect(diagnostics).toContain("revision_conflict");
  expect(diagnostics).not.toContain("同步测试计划");
  expect(diagnostics).not.toContain("sync-memo-work");
  expect(diagnostics).not.toContain("private body");
  expect(await page.evaluate(() => (window as unknown as { syncIssueRequests: string[] }).syncIssueRequests.every((method) => ["sync.outbox.list", "memo.get", "memo.list", "notebook.list", "sync.status"].includes(method)))).toBe(true);
  await dialog.screenshot({ path: test.info().outputPath("sync-issues-identifiable.png") });
  await feedback.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(feedback).not.toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});
