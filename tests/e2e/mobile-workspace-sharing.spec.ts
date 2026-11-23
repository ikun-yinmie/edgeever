import { devices, expect, test, type Page } from "@playwright/test";
import type { MemoDetail, Notebook } from "@edgeever/shared";

const desktopUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
const phone = {
  userAgent: devices["Pixel 7"].userAgent,
  viewport: devices["Pixel 7"].viewport,
  deviceScaleFactor: devices["Pixel 7"].deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
};
const timestamp = new Date().toISOString();
const makeMemo = (id: string, notebookId: string, title: string, text: string): MemoDetail => ({
  id, notebookId, title, excerpt: text, tags: [], isPinned: false, isArchived: false, isDeleted: false,
  revision: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
  contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  contentMarkdown: text, contentText: text, contentHash: `hash-${id}`,
  sourceMemoIds: [], mergeSourceCount: 0, mergedIntoMemoId: null,
});

/** Keep these collaboration fixtures out of real users' groups and notebooks. */
const mockWorkspace = async (page: Page, { groupAccount = false } = {}) => {
  const ownNotebook: Notebook = {
    id: "nb_mobile_own", parentId: null, name: "个人测试笔记本", slug: "inbox", icon: null, color: null,
    sortOrder: 0, memoCount: 1, lastMemoUpdatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  const ownMemo = makeMemo("memo_mobile_own", ownNotebook.id, "已有的近期笔记", "个人笔记正文");
  const sharedMemo = makeMemo("memo_mobile_shared", "nb_mobile_foreign", "共享笔记本中的文章", "这是群组共享笔记本的正文");
  const directMemo = makeMemo("memo_mobile_direct", "nb_mobile_foreign", "直接共享的文章", "这是单篇共享文章的正文");
  const groups = [
    { id: "group_mobile", name: "协作测试群组", description: null, memberCount: 2, shareCount: 2 },
    { id: "group_mobile_empty", name: "没有共享内容的群组", description: null, memberCount: 1, shareCount: 0 },
  ];
  const shareDefaults = {
    groupId: groups[0].id, groupName: groups[0].name, editMode: "author", editorUserIds: [],
    displayPolicy: {}, allowCopy: false, note: null, createdAt: timestamp, authorUsername: "author", authorDisplayName: "分享者",
  };
  const receivedShares = [
    { ...shareDefaults, id: "share_mobile_notebook", targetType: "notebook", targetId: sharedMemo.notebookId, title: "群组共享笔记本" },
    { ...shareDefaults, id: "share_mobile_memo", targetType: "memo", targetId: directMemo.id, title: directMemo.title },
  ];
  const outgoingShare = {
    ...shareDefaults, id: "share_mobile_outgoing", targetType: "memo", targetId: ownMemo.id,
    title: "我分享到群组的文章", authorUsername: "viewer", authorDisplayName: "测试成员",
  };
  const access = {
    shared: true, canEdit: false, allowCopy: false, groupId: groups[0].id, groupName: groups[0].name,
    authorUsername: "author", authorDisplayName: "分享者",
  };
  const notebooks = groupAccount ? [] : [ownNotebook];
  const memos = groupAccount ? [] : [ownMemo];
  const state = { bootstrapRequests: 0, changeRequests: 0, notebookLoadFails: false, syncFails: false, serverCursor: 1 };
  const addedMemos: Array<{ cursor: number; memo: MemoDetail }> = [];

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/v1/auth/session") {
      return json({ authRequired: true, authenticated: true, demoMode: false, user: {
        id: groupAccount ? "user_mobile_group" : "user_mobile_viewer", username: "viewer", displayName: "测试成员",
        role: "member", accountType: groupAccount ? "group" : "user",
      } });
    }
    if (path === "/api/health") return json({ ok: true, runtime: "cloudflare-workers" });
    if (path === "/api/v1/notebooks") return json({ notebooks });
    if (path === "/api/v1/memos") {
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const all = [...memos].reverse();
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ memos: all.slice(offset, offset + limit), totalCount: all.length, nextCursor: null });
    }
    if (path === "/api/v1/sync/bootstrap") {
      state.bootstrapRequests += 1;
      return json({ notebooks, memos, snapshotCursor: state.serverCursor, syncIdentity: "mobile-workspace-fixture", totalCount: memos.length, nextAfterId: null });
    }
    if (path === "/api/v1/sync/changes") {
      state.changeRequests += 1;
      if (state.syncFails) return json({ error: { code: "UNAVAILABLE", message: "Test sync failure" } }, 503);
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      return json({
        changes: addedMemos.filter((entry) => entry.cursor > cursor).map((entry) => ({
          cursor: entry.cursor, entityType: "memo", entityId: entry.memo.id, operation: "upsert", notebook: null, memo: entry.memo,
        })),
        cursor: state.serverCursor, serverCursor: state.serverCursor, syncIdentity: "mobile-workspace-fixture", hasMore: false,
      });
    }
    if (path === "/api/v1/shared-with-me") return json({
      groups, notebooks: [{
        id: sharedMemo.notebookId, name: "群组共享笔记本", icon: null, parentId: null, groupId: groups[0].id,
        groupName: groups[0].name, editMode: "author", canEdit: false, memoCount: 1, authorUsername: "author", authorDisplayName: "分享者",
      }],
      memos: [{ ...directMemo, groupId: groups[0].id, groupName: groups[0].name, editMode: "author", canEdit: false }],
      sharedByMe: groupAccount ? [] : [outgoingShare],
    });
    if (path === `/api/v1/shared-with-me/notebooks/${sharedMemo.notebookId}/memos`) {
      if (state.notebookLoadFails) return json({ error: { code: "UNAVAILABLE", message: "Test notebook load failure" } }, 503);
      return json({ memos: [{ ...sharedMemo, canEdit: false }], canEdit: false, groupName: groups[0].name });
    }
    if (path === "/api/v1/groups") return json({ groups });
    if (path === `/api/v1/groups/${groups[0].id}/shares`) return json({ shares: receivedShares });
    if (path === `/api/v1/groups/${groups[1].id}/shares`) return json({ shares: [] });
    if (/^\/api\/v1\/groups\/[^/]+\/members$/.test(path)) return json({ members: [{
      userId: "user_mobile_viewer", username: "viewer", displayName: "测试成员", role: "member", joinedAt: timestamp,
    }] });
    if (path === "/api/v1/memo-link-shares") return json({ shares: groupAccount ? [] : [{
      id: "link_mobile", memoId: ownMemo.id, token: "test-mobile-link", isActive: true, passwordProtected: false,
      createdAt: timestamp, updatedAt: timestamp, memoTitle: "我分享到外链的文章", memoUpdatedAt: timestamp, memoDeleted: false,
    }] });
    if (path === "/api/v1/share-servers") return json({ servers: [], defaultShareServerUrl: null });
    if (path === "/api/v1/tags") return json({ tags: [] });
    if (path.startsWith("/api/v1/plugins/github/")) return json({ error: { code: "NOT_FOUND", message: "Plugins disabled in this test" } }, 404);
    const detail = [sharedMemo, directMemo, ...memos].find((memo) => path === `/api/v1/memos/${memo.id}`);
    if (detail) return json({ memo: detail, ...(detail.notebookId === sharedMemo.notebookId ? { access } : {}) });
    if (path.startsWith("/api/v1/shared-with-me/memos/")) return json({ access: path.endsWith(ownMemo.id) ? null : access });
    return route.continue();
  });

  return {
    state,
    addRecentMemo: () => {
      const memo = makeMemo("memo_mobile_new", ownNotebook.id, "刷新后出现的新笔记", "其他设备刚刚创建的笔记");
      memos.push(memo);
      state.serverCursor += 1;
      addedMemos.push({ cursor: state.serverCursor, memo });
      return memo;
    },
  };
};

const openNotebookPicker = async (page: Page) => {
  await page.getByRole("button", { name: "切换笔记本", exact: true }).click();
  const picker = page.getByRole("dialog");
  await expect(picker.getByRole("heading", { name: "切换笔记本", exact: true })).toBeVisible();
  return picker;
};

const waitForMirror = (page: Page) => expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
  const request = indexedDB.open("edgeever-local");
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("syncMeta")) { database.close(); resolve(false); return; }
    const transaction = database.transaction("syncMeta", "readonly");
    const read = transaction.objectStore("syncMeta").getAll();
    read.onerror = () => reject(read.error);
    read.onsuccess = () => { database.close(); resolve(JSON.stringify(read.result).includes("mobile-workspace-fixture")); };
  };
}))).toBe(true);

test.describe("mobile web group and outgoing-share navigation", () => {
  test.use({ ...phone });

  test("opens a shared notebook note and returns to the same expanded group", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockWorkspace(page);
    await page.goto("/");
    const picker = await openNotebookPicker(page);
    await picker.getByRole("button", { name: "协作测试群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "协作测试群组", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "成员", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /群组共享笔记本/ }).click();
    await page.getByRole("button", { name: "共享笔记本中的文章", exact: true }).click();
    await expect(page.locator(".edgeever-workspace-editor")).toContainText("这是群组共享笔记本的正文");
    await expect(page.locator(".ProseMirror[contenteditable='true']")).toHaveCount(0);
    await expect(page.locator(".edgeever-workspace-memo-list")).not.toBeVisible();
    await page.screenshot({ path: test.info().outputPath("mobile-shared-notebook-note.png") });
    await page.getByRole("button", { name: "返回列表", exact: true }).click();
    await expect(page.getByRole("heading", { name: "协作测试群组", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "共享笔记本中的文章", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /直接共享的文章/ }).click();
    await expect(page.locator(".edgeever-workspace-editor")).toContainText("这是单篇共享文章的正文");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "协作测试群组", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("navigation", { name: "移动端主导航" })).toBeVisible();
    await expect(page.locator(".edgeever-workspace-memo-list")).not.toContainText("共享笔记本中的文章");
    expect(errors).toEqual([]);
  });

  test("shows outgoing public links, outgoing group shares and groups without shared content", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/");
    let picker = await openNotebookPicker(page);
    await picker.getByRole("button", { name: "分享到外链", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分享到外链", exact: true })).toBeVisible();
    await expect(page.getByText("我分享到外链的文章", { exact: true })).toBeVisible();
    await expect(page.getByText("我分享到群组的文章", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "复制链接", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    picker = await openNotebookPicker(page);
    await picker.getByRole("button", { name: "分享到群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分享到群组", exact: true })).toBeVisible();
    await expect(page.getByText("我分享到群组的文章", { exact: true })).toBeVisible();
    await expect(page.getByText("我分享到外链的文章", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "编辑权限", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    picker = await openNotebookPicker(page);
    await page.screenshot({ path: test.info().outputPath("mobile-groups-and-outgoing-shares.png") });
    await picker.getByRole("button", { name: "没有共享内容的群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "没有共享内容的群组", exact: true })).toBeVisible();
    await expect(page.getByText("这个群组里还没有共享内容。", { exact: true })).toBeVisible();
  });

  test("refreshes recent notes from the mobile header", async ({ page }) => {
    const fixtures = await mockWorkspace(page);
    await page.goto("/");
    await page.getByRole("navigation", { name: "移动端主导航" }).getByRole("button", { name: "近期笔记", exact: true }).click();
    await expect(page.getByRole("heading", { name: "近期笔记", exact: true })).toBeVisible();
    await waitForMirror(page);
    fixtures.addRecentMemo();
    const refresh = page.getByRole("button", { name: "刷新近期笔记", exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.locator("[data-recent-memos-timeline]")).toContainText("刷新后出现的新笔记");
    await expect(refresh).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("mobile-recent-notes-refreshed.png") });
  });

  test("reports a failed notebook load and allows retry instead of showing an empty notebook", async ({ page }) => {
    const fixtures = await mockWorkspace(page);
    fixtures.state.notebookLoadFails = true;
    await page.goto("/");
    const picker = await openNotebookPicker(page);
    await picker.getByRole("button", { name: "协作测试群组", exact: true }).click();
    await page.getByRole("button", { name: /群组共享笔记本/ }).click();
    await expect(page.getByRole("alert")).toContainText("共享内容加载失败");
    await expect(page.getByText("这个笔记本里还没有笔记。", { exact: true })).toHaveCount(0);
    fixtures.state.notebookLoadFails = false;
    await page.getByRole("alert").getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("button", { name: "共享笔记本中的文章", exact: true })).toBeVisible();
  });

  test("opens shared notebook notes for a shared group account with no personal notebooks", async ({ page }) => {
    await mockWorkspace(page, { groupAccount: true });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "共享给我", exact: true, level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /群组共享笔记本/ }).click();
    await page.getByRole("button", { name: "共享笔记本中的文章", exact: true }).click();
    await expect(page.locator(".edgeever-workspace-editor")).toContainText("这是群组共享笔记本的正文");
    await page.getByRole("button", { name: "返回列表", exact: true }).click();
    await expect(page.getByRole("heading", { name: "共享给我", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "共享笔记本中的文章", exact: true })).toBeVisible();
  });
});

test.describe("desktop UA requested on a phone", () => {
  test.use({ ...phone, userAgent: desktopUa });

  test("uses a desktop CSS viewport and renders the desktop workspace", async ({ page }) => {
    await mockWorkspace(page);
    await page.goto("/");
    await expect(page.locator("#edgeever-notebook-sidebar")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "移动端主导航" })).not.toBeVisible();
    expect(await page.evaluate(() => window.matchMedia("(min-width: 1024px)").matches)).toBe(true);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /width=1280/);
    await expect(page.getByRole("heading", { name: "近期笔记", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("phone-desktop-ua-workspace.png") });
  });
});

test.describe("recent notes refresh", () => {
  test("pulls new notes into the local mirror and keeps cached notes visible when a later refresh fails", async ({ page }) => {
    const fixtures = await mockWorkspace(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "近期笔记", exact: true })).toBeVisible();
    await expect(page.locator("[data-recent-memos-timeline]")).toContainText("已有的近期笔记");
    await waitForMirror(page);
    const calendar = page.locator("[data-recent-memos-calendar]");
    await calendar.locator('button[class*="bg-slate-200/70"]').click();
    await expect(calendar.getByRole("button", { pressed: true })).toHaveCount(1);
    const previousRequests = fixtures.state.changeRequests;
    fixtures.addRecentMemo();
    const refresh = page.getByRole("button", { name: "刷新近期笔记", exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.locator("[data-recent-memos-timeline]")).toContainText("刷新后出现的新笔记");
    expect(fixtures.state.changeRequests).toBeGreaterThan(previousRequests);
    await expect(calendar.getByRole("button", { pressed: true })).toHaveCount(1);
    await expect(refresh).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("recent-notes-refreshed.png") });
    fixtures.state.syncFails = true;
    await refresh.click();
    await expect(page.getByRole("alert")).toContainText("刷新失败");
    await expect(page.locator("[data-recent-memos-timeline]")).toContainText("刷新后出现的新笔记");
    fixtures.state.syncFails = false;
    await refresh.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(refresh).toBeEnabled();
  });
});
