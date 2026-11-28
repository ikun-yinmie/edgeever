import { devices, expect as baseExpect, test, type Locator, type Page } from "@playwright/test";
import { createExcerpt, docToMarkdown, docToText, markdownToDoc, type MemoDetail, type Notebook, type TiptapDoc } from "@edgeever/shared";

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
    saveHangs: false,
    saveErrorStatus: 0,
    // Emulate a server whose reads lag behind the save this client just made:
    // the returned workspace must still show the saved note from its mirror.
    staleReads: false,
    preEditMemo: null as MemoDetail | null,
  };
  const readMemo = () => (state.staleReads && state.preEditMemo ? state.preEditMemo : state.memo);

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
    if (path === "/api/v1/memos") return json({ memos: [otherMemo, readMemo()], totalCount: 2, nextCursor: null });
    if (path === "/api/v1/sync/bootstrap") {
      return json({ notebooks: [notebook], memos: [otherMemo, readMemo()], snapshotCursor: readMemo().revision,
        syncIdentity: "mobile-edit-return-fixture", totalCount: 2, nextAfterId: null });
    }
    if (path === "/api/v1/sync/changes") {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const memo = readMemo();
      const useStaleCursor = Boolean(state.staleReads && state.preEditMemo);
      return json({
        changes: !useStaleCursor && cursor < memo.revision ? [{
          cursor: memo.revision, entityType: "memo", entityId: memoId, operation: "upsert", notebook: null, memo,
        }] : [],
        cursor: memo.revision, serverCursor: memo.revision, syncIdentity: "mobile-edit-return-fixture", hasMore: false,
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
      if (request.method() === "GET") {
        // A detail endpoint that is not answering while the change feed stays
        // silent: the returned workspace can only render its mirror copy.
        if (state.staleReads) {
          return json({ error: { code: "TEMPORARILY_UNAVAILABLE", message: "测试详情读取暂不可用" } }, 503);
        }
        return json({ memo: readMemo() });
      }
      const payload = request.postDataJSON() as SavePayload;
      state.saves.push(payload);
      if (state.saveHangs) await new Promise(() => undefined);
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
  await expect(page).toHaveURL(new RegExp(`openMemo=${memoId}`));
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

/**
 * The returned workspace preview reads the IndexedDB mirror. Wait for the
 * first boot's bootstrap to finish so the return trip takes the incremental
 * path instead of rebuilding the scope from the (stale) fixture.
 */
const waitForLocalMirror = async (page: Page, id: string) => {
  await expect.poll(async () => {
    const [meta, memos] = await Promise.all([
      readLocalStore(page, "syncMeta").catch(() => []),
      readLocalStore(page, "memos").catch(() => []),
    ]);
    return (meta as Array<{ key?: string }>).some((entry) => entry.key === "cursor")
      && (memos as Array<{ id?: string }>).some((entry) => entry.id === id);
  }, { timeout: 30_000 }).toBe(true);
};

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

test("the back arrow abandons a pending Done wait immediately", async ({ page }) => {
  const state = await mockWorkspace(page);
  const editor = await openEditor(page);
  const release = gateSave(state);
  try {
    const text = "完成等待中按返回也要立刻离开";
    await editor.fill(text);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect.poll(() => state.saves.length).toBe(1);
    await expect(page.getByRole("button", { name: "完成", exact: true })).toBeDisabled();

    const startedAt = Date.now();
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`openMemo=${memoId}`));
    // The held save never settles; leaving well under the 20s request timeout
    // proves the wait was abandoned rather than timed out. The bound covers the
    // return navigation's own dev-server boot on a slow machine.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(await page.evaluate((id) => localStorage.getItem(`edgeever-mobile-tiptap-draft:${id}`), memoId)).toContain(text);
  } finally {
    release();
  }
});

test("reloading the note page keeps the note open instead of returning home", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto(`/?openMemo=${memoId}`);
  await expect(page.locator(".edgeever-workspace-editor")).toContainText(originalText);
  await expect(page).toHaveURL(new RegExp(`openMemo=${memoId}`));

  await page.reload();
  await expect(page.locator(".edgeever-workspace-editor")).toContainText(originalText);
  await expect(page.locator(".edgeever-workspace-memo-list")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "编辑笔记", exact: true })).toBeVisible();
});

test("a hung save cannot trap the editor: the back arrow leaves with a durable draft", async ({ page }) => {
  const state = await mockWorkspace(page);
  const editor = await openEditor(page);
  state.saveHangs = true;
  const text = "网络挂起时仍然要保留的正文";
  await editor.fill(text);
  // The autosave starts and its response never arrives.
  await expect.poll(() => state.saves.length).toBe(1);

  await page.getByRole("button", { name: "返回上一页", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`openMemo=${memoId}`));
  expect(await page.evaluate((id) => localStorage.getItem(`edgeever-mobile-tiptap-draft:${id}`), memoId)).toContain(text);
  expect(await readLocalStore(page, "drafts")).not.toEqual([]);
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

test("Done returns to the saved note when the server detail read fails", async ({ page }) => {
  const state = await mockWorkspace(page);
  const title = "手机保存后的新标题";
  const text = "手机保存后的新正文不会被旧镜像覆盖";

  await page.goto(`/?openMemo=${memoId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".edgeever-workspace-editor")).toContainText(originalText);
  await waitForLocalMirror(page, memoId);
  await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
  await expect(page).toHaveURL(/\/mobile-edit\.html#/);
  const editor = page.locator(".edgeever-mobile-tiptap-content[contenteditable='true']");
  await expect(editor).toContainText(originalText);

  await page.locator(".mobile-editor-title").fill(title);
  await editor.fill(text);

  // The save is authoritative, but the detail read fails and the change feed
  // stays silent on the way back. Only the mirror the editor wrote can keep
  // the returned preview on the edited version.
  state.preEditMemo = state.memo;
  state.staleReads = true;
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expectPreview(page, title, text);
  expect(state.memo.title).toBe(title);
  expect(state.memo.contentText).toBe(text);
});

const middleTaskText = "长正文中部需要触摸切换的待办";
const middleParagraphText = "第 41 段。把手机端编辑位置带回预览的长正文。";

const seedLongMobileMemo = (state: Awaited<ReturnType<typeof mockWorkspace>>) => {
  const paragraphs = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段。把手机端编辑位置带回预览的长正文。`);
  paragraphs.splice(40, 0, `- [ ] ${middleTaskText}`);
  const markdown = [originalText, ...paragraphs].join("\n\n");
  const contentJson = markdownToDoc(markdown) as TiptapDoc;
  state.memo = {
    ...state.memo,
    contentJson,
    contentMarkdown: markdown,
    contentText: docToText(contentJson),
    excerpt: createExcerpt(markdown),
  };
};

const waitForInitialEditorFocus = async (page: Page, editor: Locator) => {
  await expect(editor).toBeFocused();
  // Initialization focuses the document end after 160ms, then ProseMirror
  // scrolls the selection on a frame. Finish that before moving to the middle.
  await page.waitForTimeout(300);
};

const expectBodyBlockVisibleInPreview = async (block: Locator) => {
  await expect(block).toBeInViewport({ ratio: 1 });
  await expect.poll(() => block.evaluate((element) => {
    const scroller = document.querySelector(".edgeever-editor")!;
    const viewport = scroller.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return rect.top >= Math.max(0, viewport.top)
      && rect.bottom <= Math.min(window.innerHeight, viewport.bottom);
  }), { message: "The same body block must be fully visible inside the returned preview" }).toBe(true);
};

for (const waitForFocus of [true, false]) {
  test(`middle checkbox touch taps cycle all three states without jumping to the bottom, then Done keeps that body block visible${waitForFocus ? "" : " with an early tap"}`, async ({ page }) => {
    const state = await mockWorkspace(page);
    seedLongMobileMemo(state);
    const editor = await openEditor(page);
    if (waitForFocus) {
      await waitForInitialEditorFocus(page, editor);
      await expect.poll(() => page.evaluate(() => window.getSelection()?.focusNode?.textContent)).toContain("第 80 段");
    }
    const task = editor.locator('li[data-type="taskItem"]').filter({ hasText: middleTaskText });
    const checkbox = task.locator(':scope > label input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();
    await task.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(checkbox).toBeInViewport({ ratio: 1 });
    if (waitForFocus) await page.waitForTimeout(200);
    const middleScrollY = await page.evaluate(() => window.scrollY);
    expect(middleScrollY).toBeGreaterThan(500);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight - window.scrollY)).toBeGreaterThan(1000);

    for (const [checked, rejected] of [[true, false], [false, true], [false, false]] as const) {
      await test.step(`touch checkbox: checked=${checked}, rejected=${rejected}`, async () => {
        // Use a real touch sequence: click()/check() do not reproduce mobile
        // touch focus and can miss the scroll-to-the-stale-caret regression.
        const activeElementBeforeTap = await page.evaluateHandle(() => document.activeElement);
        await checkbox.tap();
        if (waitForFocus) await expect(editor).toBeFocused();
        else await expect.poll(() => activeElementBeforeTap.evaluate((element) => element === document.activeElement)).toBe(true);
        await activeElementBeforeTap.dispose();
        await expect(checkbox).not.toBeFocused();
        await expect(task).toHaveAttribute("data-checked", String(checked));
        if (checked) await expect(checkbox).toBeChecked();
        else await expect(checkbox).not.toBeChecked();
        if (rejected) await expect(task).toHaveAttribute("data-rejected", "true");
        else await expect(task).not.toHaveAttribute("data-rejected", "true");
        await page.waitForTimeout(300);
        const position = await checkbox.evaluate((element) => ({
          scrollY: window.scrollY,
          maxScrollY: document.scrollingElement!.scrollHeight - window.innerHeight,
          checkboxTop: element.getBoundingClientRect().top,
          activeElement: document.activeElement?.tagName,
          selectionText: window.getSelection()?.focusNode?.textContent,
        }));
        await test.info().attach(`touch-position-${checked}-${rejected}`, { body: JSON.stringify({ middleScrollY, ...position }), contentType: "application/json" });
        expect.soft(Math.abs(position.scrollY - middleScrollY), JSON.stringify(position)).toBeLessThan(40);
        await expect.soft(checkbox).toBeInViewport({ ratio: 1, timeout: 1000 });
      });
    }

    // Do not scroll back before Done: that would conceal a broken touch path.
    await page.getByRole("button", { name: "完成", exact: true }).tap();
    await expectPreview(page, "手机编辑测试笔记", middleTaskText);
    const previewTask = page.locator('.edgeever-workspace-editor li[data-type="taskItem"]').filter({ hasText: middleTaskText });
    await expect(previewTask).toHaveAttribute("data-checked", "false");
    await expect(previewTask).not.toHaveAttribute("data-rejected", "true");
    await expectBodyBlockVisibleInPreview(previewTask);
  });
}

for (const resetScrollOnBlur of [false, true]) {
  test(`Done after typing in a middle paragraph keeps that exact paragraph visible in preview${resetScrollOnBlur ? " when blur resets window scroll" : ""}`, async ({ page }) => {
    const state = await mockWorkspace(page);
    seedLongMobileMemo(state);
    const editor = await openEditor(page);
    await waitForInitialEditorFocus(page, editor);
    const paragraph = editor.locator("p").filter({ hasText: middleParagraphText });
    await paragraph.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(paragraph).toBeInViewport({ ratio: 1 });
    await paragraph.tap();
    await page.keyboard.press("End");
    const insertedText = "手机中段实际输入后仍停在这里";
    await page.keyboard.insertText(insertedText);
    const editedParagraph = editor.locator("p").filter({ hasText: insertedText });
    await expect(editedParagraph).toBeInViewport({ ratio: 1 });
    const savedParagraphText = await editedParagraph.innerText();
    const middleScrollY = await page.evaluate(() => window.scrollY);
    expect(middleScrollY).toBeGreaterThan(500);

    const release = resetScrollOnBlur ? gateSave(state) : null;
    if (resetScrollOnBlur) {
      await page.evaluate(() => {
        // Simulate the transient relayout following keyboard dismissal. Keeping
        // the save pending proves the reset happened before return navigation.
        document.addEventListener("blur", (event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches(".edgeever-mobile-tiptap-content")) return;
          const before = window.scrollY;
          window.setTimeout(() => {
            window.scrollTo(0, 0);
            sessionStorage.setItem("e2e-mobile-blur-scroll-reset", JSON.stringify({ before, after: window.scrollY }));
          }, 0);
        }, true);
      });
    }
    try {
      await page.getByRole("button", { name: "完成", exact: true }).tap();
      if (resetScrollOnBlur) {
        await expect.poll(() => page.evaluate(() => {
          const reset = sessionStorage.getItem("e2e-mobile-blur-scroll-reset");
          return reset ? JSON.parse(reset) as { before: number; after: number } : null;
        })).toEqual({ before: middleScrollY, after: 0 });
        release!();
      }
      await expectPreview(page, "手机编辑测试笔记", insertedText);
      expect(state.memo.contentText).toContain(savedParagraphText);
      // A broad scroll fraction (> 0.55) also accepts jumping all the way to
      // the bottom. Require the exact paragraph edited above to be on screen.
      const previewParagraph = page.locator(".edgeever-workspace-editor p").filter({ hasText: insertedText });
      await expect(previewParagraph).toHaveText(savedParagraphText);
      await expectBodyBlockVisibleInPreview(previewParagraph);
    } finally {
      release?.();
    }
  });
}

test("Done returns to the scroll position where the editor left off", async ({ page }) => {
  const state = await mockWorkspace(page);
  const paragraphs = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段。把手机端编辑位置带回预览的长正文。`).join("\n\n");
  state.memo = {
    ...state.memo,
    revision: 5,
    contentHash: "mobile-hash-long",
    contentJson: markdownToDoc(paragraphs) as TiptapDoc,
    contentMarkdown: paragraphs,
    contentText: docToText(markdownToDoc(paragraphs) as TiptapDoc),
    excerpt: createExcerpt(paragraphs),
  };

  await page.goto(`/?openMemo=${memoId}`);
  await page.waitForLoadState("domcontentloaded");
  const preview = page.locator(".edgeever-editor");
  await expect(page.locator(".edgeever-workspace-editor")).toContainText("第 1 段");
  await expect.poll(() => preview.evaluate((element) => element.scrollHeight > element.clientHeight + 200)).toBe(true);

  // Leave the reading screen away from the top so a stale scroll memory is
  // visibly different from the editor position asserted below.
  await preview.evaluate((element) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.12;
  });
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "编辑笔记", exact: true }).click();
  await expect(page).toHaveURL(/\/mobile-edit\.html#/);
  const editor = page.locator(".edgeever-mobile-tiptap-content[contenteditable='true']");
  await expect(editor).toContainText("第 1 段");
  await page.evaluate(() => window.scrollTo(0, (document.scrollingElement!.scrollHeight - window.innerHeight) * 0.7));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`openMemo=${memoId}`));
  await expect.poll(async () => preview.evaluate((element) => {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    return maxScrollTop > 0 ? element.scrollTop / maxScrollTop : 0;
  }), { timeout: 30_000 }).toBeGreaterThan(0.55);
});
