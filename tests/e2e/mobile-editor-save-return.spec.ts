import { devices, expect as baseExpect, test, type Page } from "@playwright/test";
import { createExcerpt, docToMarkdown, docToText, type MemoDetail, type Notebook, type TiptapDoc } from "@edgeever/shared";

const memoId = "memo_mobile_edit_return";
const originalText = "手机笔记原来的正文";
const timestamp = "2026-11-23T12:00:00.000Z";

// Each case boots the whole app twice (workspace, then the standalone editor),
// so dev servers on slow or network-mounted disks need more than the defaults.
test.describe.configure({ timeout: 150_000 });
const expect = baseExpect.configure({ timeout: 30_000 });

test.use({ ...devices["Pixel 7"], storageState: { cookies: [], origins: [] } });

type SavePayload = {
  expectedRevision: number;
  expectedContentHash: string;
  editSessionId: string;
  title: string;
  contentJson: TiptapDoc;
  tags: string[];
};

/** Exercise the real mobile editor without writing to any user's notebooks. */
const mockWorkspace = async (page: Page) => {
  const notebook: Notebook = {
    id: "nb_mobile_edit_return", parentId: null, name: "手机编辑回归测试", slug: "inbox", icon: null, color: null,
    sortOrder: 0, memoCount: 2, lastMemoUpdatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  const state = {
    memo: {
      id: memoId, notebookId: notebook.id, title: "手机编辑测试笔记", excerpt: originalText,
      tags: [], isPinned: false, isArchived: false, isDeleted: false, revision: 1,
      createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: originalText }] }] },
      contentMarkdown: originalText, contentText: originalText, contentHash: "mobile-hash-1",
      sourceMemoIds: [], mergeSourceCount: 0, mergedIntoMemoId: null,
    } as MemoDetail,
    saves: [] as SavePayload[],
    saveGate: null as Promise<void> | null,
    saveErrorStatus: 0,
  };

  const otherMemo: MemoDetail = {
    ...state.memo, id: "memo_mobile_edit_other", title: "不应跳到这篇笔记", contentText: "另一篇笔记的正文",
    contentMarkdown: "另一篇笔记的正文", excerpt: "另一篇笔记的正文",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "另一篇笔记的正文" }] }] },
    updatedAt: "2099-01-01T00:00:00.000Z",
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/v1/auth/session") {
      return json({ authRequired: true, authenticated: true, demoMode: false, user: {
        id: "user_mobile_edit_return", username: "mobile_edit_return", displayName: "手机编辑测试账号", role: "member", accountType: "user",
      } });
    }
    if (path === "/api/health") return json({ ok: true, runtime: "cloudflare-workers" });
    if (path === "/api/v1/notebooks") return json({ notebooks: [notebook] });
    if (path === "/api/v1/memos") return json({ memos: [otherMemo, state.memo], totalCount: 2, nextCursor: null });
    if (path === "/api/v1/sync/bootstrap") {
      return json({ notebooks: [notebook], memos: [otherMemo, state.memo], snapshotCursor: state.memo.revision,
        syncIdentity: "mobile-edit-return-fixture", totalCount: 2, nextAfterId: null });
    }
    if (path === "/api/v1/sync/changes") {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      return json({
        changes: cursor < state.memo.revision ? [{
          cursor: state.memo.revision, entityType: "memo", entityId: memoId, operation: "upsert", notebook: null, memo: state.memo,
        }] : [],
        cursor: state.memo.revision, serverCursor: state.memo.revision, syncIdentity: "mobile-edit-return-fixture", hasMore: false,
      });
    }
    if (path === "/api/v1/tags") return json({ tags: [] });
    if (path === `/api/v1/memos/${otherMemo.id}`) return json({ memo: otherMemo });
    if (path === "/api/v1/shared-with-me") return json({ groups: [], notebooks: [], memos: [], sharedByMe: [] });
    if (path === "/api/v1/memo-link-shares") return json({ shares: [] });
    if (path === `/api/v1/shared-with-me/memos/${memoId}`) return json({ access: null });
    if (path === `/api/v1/memos/${memoId}/edit-sessions`) {
      return json({ editSession: {
        id: "session_mobile_edit_return", memoId, baseRevision: state.memo.revision,
        baseContentHash: state.memo.contentHash, expiresAt: "2099-01-01T00:00:00.000Z",
      } });
    }
    if (path === `/api/v1/memos/${memoId}` || path === `/api/v1/memos/${memoId}/save`) {
      if (request.method() === "GET") return json({ memo: state.memo });
      const payload = request.postDataJSON() as SavePayload;
      state.saves.push(payload);
      if (state.saveGate) await state.saveGate;
      if (state.saveErrorStatus) {
        return json({ error: { code: "TEST_SAVE_FAILED", message: "测试保存失败，请重试" } }, state.saveErrorStatus);
      }
      if (payload.expectedRevision !== state.memo.revision || payload.expectedContentHash !== state.memo.contentHash) {
        return json({ error: { code: "REVISION_CONFLICT", message: "测试笔记版本不一致" } }, 409);
      }
      const contentText = docToText(payload.contentJson);
      state.memo = {
        ...state.memo, title: payload.title || null, contentJson: payload.contentJson,
        contentText, contentMarkdown: docToMarkdown(payload.contentJson), excerpt: createExcerpt(contentText), tags: payload.tags,
        revision: state.memo.revision + 1, contentHash: `mobile-hash-${state.memo.revision + 1}`, updatedAt: new Date().toISOString(),
      };
      return json({ memo: state.memo });
    }
    return json({ error: { code: "NOT_FOUND", message: "Not part of this test fixture" } }, 404);
  });

  return state;
};

const openEditor = async (page: Page) => {
  await page.goto(`/?openMemo=${memoId}`);
  await expect(page.locator(".edgeever-workspace-editor")).toContainText(originalText);
  await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
  await expect(page).toHaveURL(/\/mobile-edit\.html#/);
  const editor = page.locator(".edgeever-mobile-tiptap-content[contenteditable='true']");
  await expect(editor).toContainText(originalText);
  return editor;
};

const expectPreview = async (page: Page, title: string, text: string) => {
  await expect(page).toHaveURL("/");
  const preview = page.locator(".edgeever-workspace-editor");
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "无标题笔记", exact: true })).toHaveValue(title);
  await expect(preview).toContainText(text);
  await expect(preview.locator(".ProseMirror[contenteditable='true']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "编辑笔记", exact: true })).toBeVisible();
  await expect(page.locator(".edgeever-workspace-memo-list")).not.toBeVisible();
};

const readLocalStore = (page: Page, storeName: string) => page.evaluate((store) => new Promise<unknown[]>((resolve, reject) => {
  const open = indexedDB.open("edgeever-local");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const read = db.transaction(store, "readonly").objectStore(store).getAll();
    read.onerror = () => { db.close(); reject(read.error); };
    read.onsuccess = () => { db.close(); resolve(read.result); };
  };
}), storeName);

const gateSave = (state: Awaited<ReturnType<typeof mockWorkspace>>) => {
  let release!: () => void;
  state.saveGate = new Promise<void>((resolve) => { release = resolve; });
  return release;
};

test("Done saves the note and returns to its read-only preview, not home", async ({ page }) => {
  const state = await mockWorkspace(page);
  const editor = await openEditor(page);
  const title = "手机完成后的标题";
  const text = "手机点击完成后必须保存的正文";
  await page.locator(".mobile-editor-title").fill(title);
  await editor.fill(text);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expectPreview(page, title, text);
  expect(state.memo.title).toBe(title);
  expect(state.memo.contentText).toBe(text);
  await page.screenshot({ path: test.info().outputPath("mobile-saved-note-preview.png") });

  await page.reload();
  await page.goto(`/?openMemo=${memoId}`);
  await expectPreview(page, title, text);
  await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
  await expect(page.locator(".edgeever-mobile-tiptap-content")).toContainText(text);
});

test("Done waits for a slow save instead of leaving after 1.6 seconds", async ({ page }) => {
  const state = await mockWorkspace(page);
  const editor = await openEditor(page);
  const release = gateSave(state);
  try {
    await editor.fill("慢网络下仍然要保存的正文");
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect.poll(() => state.saves.length).toBe(1);
    // Wait beyond the old navigation deadline while the server response is held.
    await page.waitForTimeout(2200);
    await expect(page).toHaveURL(/\/mobile-edit\.html#/);
    await expect(page.getByRole("button", { name: "完成", exact: true })).toBeDisabled();
    release();
    await expectPreview(page, "手机编辑测试笔记", "慢网络下仍然要保存的正文");
  } finally {
    release();
  }
});

for (const status of [409, 503]) {
  test(`a failed save (HTTP ${status}) keeps the editor and durable draft open for retry`, async ({ page }) => {
    const state = await mockWorkspace(page);
    const editor = await openEditor(page);
    state.saveErrorStatus = status;
    const text = `保存失败也不能丢失的正文-${status}`;
    await editor.fill(text);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator(".mobile-editor-error")).toContainText("测试保存失败");
    await expect(page).toHaveURL(/\/mobile-edit\.html#/);
    await expect(editor).toBeEditable();
    await expect(editor).toContainText(text);
    await expect(page.getByRole("button", { name: "完成", exact: true })).toBeEnabled();
    expect(await page.evaluate((id) => localStorage.getItem(`edgeever-mobile-tiptap-draft:${id}`), memoId)).toContain(text);
    await expect.poll(async () => JSON.stringify(await readLocalStore(page, "drafts"))).toContain(text);
    expect(state.memo.contentText).toBe(originalText);

    state.saveErrorStatus = 0;
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expectPreview(page, "手机编辑测试笔记", text);
    expect(await readLocalStore(page, "drafts")).toEqual([]);
    expect(await readLocalStore(page, "syncQueue")).toEqual([]);
  });
}

test("Done flushes edits made during an earlier autosave before returning", async ({ page }) => {
  const state = await mockWorkspace(page);
  const editor = await openEditor(page);
  const release = gateSave(state);
  try {
    await editor.fill("先开始自动保存的正文");
    await expect.poll(() => state.saves.length).toBe(1);
    const title = "自动保存期间修改的新标题";
    const text = "自动保存期间继续输入的最后一段正文";
    await page.locator(".mobile-editor-title").fill(title);
    await editor.fill(text);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    release();
    await expectPreview(page, title, text);
    expect(state.memo.title).toBe(title);
    expect(state.memo.contentText).toBe(text);
    expect(state.saves).toHaveLength(2);
    expect(state.saves[1].expectedRevision).toBe(2);
    expect(state.saves[1].expectedContentHash).toBe("mobile-hash-2");
  } finally {
    release();
  }
});

test("Done can save a note larger than the fetch keepalive body limit", async ({ page }) => {
  const state = await mockWorkspace(page);
  const editor = await openEditor(page);
  const text = `large-mobile-note-${"a".repeat(70_000)}`;
  await editor.fill(text);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expectPreview(page, "手机编辑测试笔记", "large-mobile-note-");
  expect(state.memo.contentText).toBe(text);
  expect(JSON.stringify(state.saves[0]).length).toBeGreaterThan(65_536);
});

test("Done without changes returns to preview without creating an unsaved draft", async ({ page }) => {
  const state = await mockWorkspace(page);
  await openEditor(page);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expectPreview(page, "手机编辑测试笔记", originalText);
  expect(state.saves).toEqual([]);
  expect(await readLocalStore(page, "drafts")).toEqual([]);
  expect(await page.evaluate((id) => localStorage.getItem(`edgeever-mobile-tiptap-draft:${id}`), memoId)).toBeNull();
});

test("Done saves a recovered queued edit instead of treating it as already saved", async ({ page }) => {
  const state = await mockWorkspace(page);
  await openEditor(page);
  const title = "恢复的待同步标题";
  const text = "恢复的待同步正文仍然需要保存";
  await page.evaluate(({ id, title, text }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("edgeever-local");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(["drafts", "syncQueue"], "readwrite");
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.objectStore("drafts").delete(id);
      transaction.objectStore("syncQueue").put({
        id: `memo.update:${id}`, memoId: id, kind: "memo.update", status: "pending", attemptCount: 0,
        lastError: null, nextAttemptAt: null, createdAt: "2026-11-23T12:00:00.000Z", updatedAt: "2026-11-23T12:00:00.000Z",
        payload: {
          memoId: id, expectedRevision: 1, expectedContentHash: "mobile-hash-1", editSessionId: "session_mobile_edit_return",
          title, tags: ["mobile"],
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
        },
      });
    };
  }), { id: memoId, title, text });
  await page.reload();
  await expect(page.locator(".edgeever-mobile-tiptap-content[contenteditable='true']")).toContainText(text);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expectPreview(page, title, text);
  expect(state.memo.contentText).toBe(text);
  expect(state.memo.tags).toEqual(["mobile"]);
  expect(state.saves).toHaveLength(1);
  expect(await readLocalStore(page, "syncQueue")).toEqual([]);
});
