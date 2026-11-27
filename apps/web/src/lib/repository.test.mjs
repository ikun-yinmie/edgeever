import { afterEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { localDb } = await import("./local-db.ts");
const { api } = await import("./api.ts");
const { createWebRepository } = await import("./repository.ts");
const { createLocalMemo, replaceLocalMemoId } = await import("./local-mirror.ts");
const {
  getMemoCreateQueueId,
  getMemoDeleteQueueId,
  getMemoRestoreQueueId,
  queueMemoCreate,
  syncQueuedChanges,
} = await import("./sync-queue.ts");
const { setSyncPause } = await import("./sync-preferences.ts");

const installTestWindow = ({ hostname = "localhost" } = {}) => {
  const previousWindow = globalThis.window;
  const eventTarget = new EventTarget();
  globalThis.window = Object.assign(eventTarget, {
    location: { hostname, href: `http://${hostname}/` },
  });
  return () => {
    globalThis.window = previousWindow;
  };
};

afterEach(async () => {
  await localDb.transaction("rw", [localDb.drafts, localDb.templates, localDb.notebooks, localDb.memos, localDb.resources, localDb.revisions, localDb.syncMeta, localDb.syncQueue, localDb.idMappings], async () => {
    await Promise.all([
      localDb.drafts.clear(),
      localDb.templates.clear(),
      localDb.notebooks.clear(),
      localDb.memos.clear(),
      localDb.resources.clear(),
      localDb.revisions.clear(),
      localDb.syncMeta.clear(),
      localDb.syncQueue.clear(),
      localDb.idMappings.clear(),
    ]);
  });
});

describe("web repository offline boundaries", () => {
  test("keeps status choices local and coalesces explicit clears while pushes are paused", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const repository = createWebRepository(scope);
    const original = api.updateMemo;
    let remoteCalls = 0;
    let deferredEvents = 0;
    window.addEventListener("edgeever:sync-queue-deferred", () => { deferredEvents += 1; });
    api.updateMemo = async () => { remoteCalls += 1; throw new Error("unexpected network"); };
    setSyncPause(scope, "push", true);
    try {
      expect(memo.status).toBeNull();
      for (const status of ["in_progress", "completed", "cancelled", null]) {
        const updated = await repository.setMemoStatus(memo.id, status);
        expect(updated.status).toBe(status);
        expect(updated.id).toBe(memo.id);
        expect((await localDb.memos.get([scope, memo.id])).status).toBe(status);
      }
      const queued = await localDb.syncQueue.toArray();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: "memo.status", payload: { memoId: memo.id, status: null }, status: "pending" });
      expect(deferredEvents).toBe(4);
      expect(remoteCalls).toBe(0);
    } finally {
      api.updateMemo = original;
      setSyncPause(scope, "push", false);
      restoreWindow();
    }
  });

  test("resolves an old temporary id before writing a newer status choice", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    await replaceLocalMemoId(scope, memo.id, { ...memo, id: "remote-status-alias", revision: 1 });
    try {
      const updated = await createWebRepository(scope).setMemoStatus(memo.id, "cancelled");
      expect(updated).toMatchObject({ id: "remote-status-alias", status: "cancelled" });
      expect(await localDb.syncQueue.toArray()).toMatchObject([{ memoId: "remote-status-alias", payload: { memoId: "remote-status-alias", status: "cancelled" } }]);
      expect(await localDb.memos.get([scope, memo.id])).toBeUndefined();
    } finally {
      restoreWindow();
    }
  });

  test("restores an offline-created note with its selected status after canceling the original create", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const repository = createWebRepository(scope);
    await queueMemoCreate(scope, { temporaryId: memo.id, notebookId: "inbox", title: "", tags: [] });
    try {
      await repository.setMemoStatus(memo.id, "completed");
      await repository.deleteMemo(memo.id);
      expect(await localDb.syncQueue.count()).toBe(0);
      expect((await repository.restoreMemo(memo.id)).memo.status).toBe("completed");
      expect((await localDb.syncQueue.toArray()).find((item) => item.kind === "memo.status")).toMatchObject({ payload: { memoId: memo.id, status: "completed" } });
    } finally {
      restoreWindow();
    }
  });

  test("rolls status back when its queue write fails", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const failQueueWrite = () => { throw new Error("status queue unavailable"); };
    localDb.syncQueue.hook("creating", failQueueWrite);
    try {
      await expect(createWebRepository(scope).setMemoStatus(memo.id, "completed")).rejects.toThrow("status queue unavailable");
      expect((await localDb.memos.get([scope, memo.id])).status).toBeNull();
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      localDb.syncQueue.hook("creating").unsubscribe(failQueueWrite);
      restoreWindow();
    }
  });

  test("projects a pending clear into a fresher remote detail and refresh event", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const created = await createLocalMemo(scope, { notebookId: "inbox" });
    const memo = { ...created, id: "remote-status-detail", status: "completed", revision: 1 };
    await localDb.memos.put({ ...memo, scope });
    const repository = createWebRepository(scope);
    const original = api.getMemo;
    let release;
    const response = new Promise((resolve) => { release = resolve; });
    api.getMemo = async () => response;
    const refreshed = new Promise((resolve) => window.addEventListener("edgeever:memo-detail-refreshed", (event) => resolve(event.detail), { once: true }));
    try {
      expect((await repository.getMemo(memo.id)).memo.status).toBe("completed");
      await repository.setMemoStatus(memo.id, null);
      release({ memo: { ...memo, title: "Fresh content", revision: 2, updatedAt: "2099-01-01T00:00:00.000Z" } });
      expect(await refreshed).toMatchObject({ title: "Fresh content", status: null });
    } finally {
      api.getMemo = original;
      release({ memo });
      restoreWindow();
    }
  });

  test("reconciles stale template cache entries while preserving queued local edits", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const template = (id, name, updatedAt) => ({
      id,
      name,
      description: null,
      title: name,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "",
      tags: [],
      createdAt: updatedAt,
      updatedAt,
    });
    const stale = template("template-stale", "Stale", "2026-01-01T00:00:00.000Z");
    const edited = template("template-edited", "Local edit", "2026-01-03T00:00:00.000Z");
    const remoteEdited = template("template-edited", "Remote old", "2026-01-02T00:00:00.000Z");
    const remote = template("template-remote", "Remote", "2026-01-04T00:00:00.000Z");
    await localDb.templates.bulkPut([{ ...stale, scope }, { ...edited, scope }]);
    await localDb.syncQueue.put({
      id: `action:${scope}:template.update:${edited.id}`,
      kind: "template.update",
      scope,
      memoId: edited.id,
      status: "pending",
      payload: { templateId: edited.id, name: edited.name },
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      claimId: null,
      createdAt: edited.updatedAt,
      updatedAt: edited.updatedAt,
    });
    const originalListTemplates = api.listTemplates;
    api.listTemplates = async () => ({ templates: [remote, remoteEdited] });

    try {
      const result = await createWebRepository(scope).listTemplates();
      expect(result.templates.map((item) => item.id)).toEqual([remote.id, edited.id]);
      expect(result.templates.find((item) => item.id === edited.id)?.name).toBe("Local edit");
      expect(await localDb.templates.get([scope, stale.id])).toBeUndefined();
    } finally {
      api.listTemplates = originalListTemplates;
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("saves memo edits locally while deferring remote synchronization", async () => {
    const restoreWindow = installTestWindow();
    let immediateEvents = 0;
    let deferredEvents = 0;
    window.addEventListener("edgeever:sync-queue-changed", () => {
      immediateEvents += 1;
    });
    window.addEventListener("edgeever:sync-queue-deferred", () => {
      deferredEvents += 1;
    });

    try {
      const scope = "https://demo.edgeever.org|user-1";
      const memo = await createLocalMemo(scope, { notebookId: "nb-1" });
      const repository = createWebRepository(scope);
      const contentJson = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Saved locally" }] }],
      };

      const result = await repository.updateMemo(memo, {
        expectedRevision: memo.revision,
        expectedContentHash: memo.contentHash,
        editSessionId: "local-edit",
        title: "",
        contentJson,
        tags: [],
      });

      expect(result.memo.contentText).toBe("Saved locally");
      expect(await localDb.syncQueue.get(`memo.update:${memo.id}`)).toBeDefined();
      expect(deferredEvents).toBe(1);
      expect(immediateEvents).toBe(0);
    } finally {
      restoreWindow();
    }
  });

  test("rolls back the local memo when queuing its sync update fails", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const memo = await createLocalMemo(scope, { notebookId: "nb-1", contentMarkdown: "Original" });
    const failQueueWrite = () => { throw new Error("queue unavailable"); };
    localDb.syncQueue.hook("creating", failQueueWrite);

    try {
      await expect(createWebRepository(scope).updateMemo(memo, {
        expectedRevision: memo.revision,
        expectedContentHash: memo.contentHash,
        editSessionId: "local-edit",
        title: "Changed",
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Changed" }] }],
        },
        tags: [],
      })).rejects.toThrow("queue unavailable");

      expect((await localDb.memos.get([scope, memo.id]))?.contentText).toBe("Original");
      expect(await localDb.syncQueue.get(`memo.update:${memo.id}`)).toBeUndefined();
    } finally {
      localDb.syncQueue.hook("creating").unsubscribe(failQueueWrite);
      restoreWindow();
    }
  });

  test("uses the remote detail when the local database is blocked and navigator falsely reports offline", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: false });
    const scope = "https://demo.edgeever.org|user-1";
    const remoteMemo = {
      id: "memo-blocked",
      notebookId: "nb-1",
      title: "Remote detail",
      excerpt: "Remote excerpt",
      tags: [],
      isPinned: false,
      isArchived: false,
      isDeleted: false,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "remote",
      contentText: "remote",
      contentHash: "remote",
      sourceMemoIds: [],
    };
    const originalLocalGet = localDb.memos.get;
    const originalLocalPut = localDb.memos.put;
    const originalApiGetMemo = api.getMemo;
    localDb.memos.get = async () => new Promise(() => {});
    localDb.memos.put = async () => new Promise(() => {});
    api.getMemo = async () => ({ memo: remoteMemo });

    try {
      const repository = createWebRepository(scope);
      const startedAt = Date.now();
      expect((await repository.getMemo("memo-blocked")).memo.title).toBe("Remote detail");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      localDb.memos.get = originalLocalGet;
      localDb.memos.put = originalLocalPut;
      api.getMemo = originalApiGetMemo;
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("returns cached detail immediately and refreshes it in the background", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";
    const localMemo = {
      id: "memo-1",
      notebookId: "nb-1",
      title: "Cached title",
      excerpt: "Cached excerpt",
      tags: [],
      isPinned: false,
      isArchived: false,
      isDeleted: false,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "cached",
      contentText: "cached",
      contentHash: "cached",
      sourceMemoIds: [],
      mergeSourceCount: 0,
      mergedIntoMemoId: null,
    };
    const remoteMemo = { ...localMemo, title: "Remote title", contentMarkdown: "remote", contentText: "remote", revision: 2 };
    await localDb.memos.put({ ...localMemo, scope });
    const originalGetMemo = api.getMemo;
    api.getMemo = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { memo: remoteMemo };
    };

    try {
      const repository = createWebRepository(scope);
      expect((await repository.getMemo("memo-1")).memo.title).toBe("Cached title");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await localDb.memos.get([scope, "memo-1"])).title).toBe("Remote title");
    } finally {
      api.getMemo = originalGetMemo;
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("does not overwrite a newer local autosave with a stale remote detail", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();
    let refreshEvents = 0;
    window.addEventListener("edgeever:memo-detail-refreshed", () => {
      refreshEvents += 1;
    });

    const scope = "https://demo.edgeever.org|user-1";
    const localMemo = {
      id: "memo-stale-remote",
      notebookId: "nb-1",
      title: "Local autosave",
      excerpt: "local",
      tags: [],
      isPinned: false,
      isArchived: false,
      isDeleted: false,
      revision: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T12:00:01.000Z",
      deletedAt: null,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "local" }] }] },
      contentMarkdown: "local",
      contentText: "local",
      contentHash: "local-hash",
      sourceMemoIds: [],
      mergeSourceCount: 0,
      mergedIntoMemoId: null,
    };
    // Same revision, older updatedAt — the classic "server has not received the autosave yet" case.
    const remoteMemo = {
      ...localMemo,
      title: "Stale remote",
      excerpt: "remote",
      updatedAt: "2026-01-02T12:00:00.000Z",
      contentMarkdown: "remote",
      contentText: "remote",
      contentHash: "remote-hash",
    };
    await localDb.memos.put({ ...localMemo, scope });
    await localDb.syncQueue.put({
      id: `memo.update:${localMemo.id}`,
      kind: "memo.update",
      scope,
      memoId: localMemo.id,
      status: "pending",
      payload: {
        memoId: localMemo.id,
        expectedRevision: 3,
        expectedContentHash: "local-hash",
        editSessionId: "edit-1",
        title: "Local autosave",
        contentJson: localMemo.contentJson,
        tags: [],
      },
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      claimId: null,
      createdAt: localMemo.updatedAt,
      updatedAt: localMemo.updatedAt,
    });

    const originalGetMemo = api.getMemo;
    api.getMemo = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { memo: remoteMemo };
    };

    try {
      const repository = createWebRepository(scope);
      expect((await repository.getMemo(localMemo.id)).memo.title).toBe("Local autosave");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await localDb.memos.get([scope, localMemo.id])).title).toBe("Local autosave");
      expect(refreshEvents).toBe(0);
    } finally {
      api.getMemo = originalGetMemo;
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("does not prefer a stale remote that wins the local/remote race", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();

    const scope = "https://demo.edgeever.org|user-1";
    const localMemo = {
      id: "memo-race",
      notebookId: "nb-1",
      title: "Local wins",
      excerpt: "local",
      tags: [],
      isPinned: false,
      isArchived: false,
      isDeleted: false,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T12:00:01.000Z",
      deletedAt: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "local",
      contentText: "local",
      contentHash: "local",
      sourceMemoIds: [],
      mergeSourceCount: 0,
      mergedIntoMemoId: null,
    };
    const remoteMemo = {
      ...localMemo,
      title: "Stale remote race",
      updatedAt: "2026-01-02T12:00:00.000Z",
      contentMarkdown: "remote",
      contentText: "remote",
    };
    await localDb.memos.put({ ...localMemo, scope });

    const originalGetMemo = api.getMemo;
    const originalLocalGet = localDb.memos.get;
    api.getMemo = async () => ({ memo: remoteMemo });
    // Delay local read so remote wins Promise.race.
    localDb.memos.get = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return originalLocalGet.apply(localDb.memos, args);
    };

    try {
      const repository = createWebRepository(scope);
      const result = await repository.getMemo(localMemo.id);
      expect(result.memo.title).toBe("Local wins");
      localDb.memos.get = originalLocalGet;
      expect((await localDb.memos.get([scope, localMemo.id])).title).toBe("Local wins");
    } finally {
      api.getMemo = originalGetMemo;
      localDb.memos.get = originalLocalGet;
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("recreates an unsynced note when it is restored after its canceled delete", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";

    try {
      const memo = await createLocalMemo(scope, { notebookId: "nb-1", title: "Offline note" });
      await queueMemoCreate(scope, {
        temporaryId: memo.id,
        notebookId: memo.notebookId,
        title: memo.title ?? "",
        contentMarkdown: memo.contentMarkdown,
        tags: memo.tags,
        createdAt: memo.createdAt,
        updatedAt: memo.updatedAt,
      });
      const repository = createWebRepository(scope);

      await repository.deleteMemo(memo.id, false);
      expect(await localDb.syncQueue.get(getMemoCreateQueueId(memo.id))).toBeUndefined();

      const restored = await repository.restoreMemo(memo.id);
      expect(restored.memo.isDeleted).toBe(false);
      expect(await localDb.syncQueue.get(getMemoCreateQueueId(memo.id))).toMatchObject({
        kind: "memo.create",
        memoId: memo.id,
      });
      expect(await localDb.syncQueue.get(getMemoRestoreQueueId(memo.id))).toBeUndefined();
    } finally {
      restoreWindow();
    }
  });

  test("defers a single delete for a note whose create was already attempted", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";

    try {
      const memo = await createLocalMemo(scope, { notebookId: "nb-1", title: "Attempted" });
      await localDb.syncQueue.put({
        id: getMemoCreateQueueId(memo.id),
        kind: "memo.create",
        scope,
        memoId: memo.id,
        status: "error",
        payload: {
          temporaryId: memo.id,
          notebookId: memo.notebookId,
          title: memo.title ?? "",
          tags: [],
          createdAt: memo.createdAt,
          updatedAt: memo.updatedAt,
        },
        attemptCount: 1,
        lastError: "temporary outage",
        nextAttemptAt: "2099-01-01T00:00:00.000Z",
        claimId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const repository = createWebRepository(scope);

      await repository.deleteMemos({ memoIds: [memo.id] });
      expect(await localDb.syncQueue.get(getMemoCreateQueueId(memo.id))).toBeDefined();
      expect(await localDb.syncQueue.get(getMemoDeleteQueueId(memo.id))).toMatchObject({
        kind: "memo.delete",
        payload: { memoId: memo.id, permanent: false },
      });
      expect((await localDb.syncQueue.toArray()).some((item) => item.kind === "memo.deleteBatch")).toBe(false);
      // The delete must wait for the create acknowledgement instead of racing it.
      expect(await syncQueuedChanges({ scope })).toMatchObject({ attempted: 0 });
    } finally {
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("emptying the trash keeps attempted creates as deferred permanent deletes", async () => {
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-1";

    try {
      const memo = await createLocalMemo(scope, { notebookId: "nb-1", title: "Trashed" });
      await localDb.syncQueue.put({
        id: getMemoCreateQueueId(memo.id),
        kind: "memo.create",
        scope,
        memoId: memo.id,
        status: "error",
        payload: {
          temporaryId: memo.id,
          notebookId: memo.notebookId,
          title: memo.title ?? "",
          tags: [],
          createdAt: memo.createdAt,
          updatedAt: memo.updatedAt,
        },
        attemptCount: 2,
        lastError: "temporary outage",
        nextAttemptAt: "2099-01-01T00:00:00.000Z",
        claimId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const repository = createWebRepository(scope);
      await repository.deleteMemo(memo.id, false);

      await repository.emptyTrash();
      expect(await localDb.syncQueue.get(getMemoDeleteQueueId(memo.id))).toMatchObject({
        kind: "memo.delete",
        payload: { memoId: memo.id, permanent: true },
      });
      const emptyTrash = (await localDb.syncQueue.toArray()).find((item) => item.kind === "memo.emptyTrash");
      expect(emptyTrash?.payload.memoIds).toEqual([]);
      expect(await localDb.memos.get([scope, memo.id])).toBeUndefined();
    } finally {
      restoreWindow();
    }
  });

  test("returns empty initialized collections without cloud fallbacks", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: false });
    // Non-loopback host so navigator.onLine=false is treated as offline.
    const restoreWindow = installTestWindow({ hostname: "demo.edgeever.org" });
    const scope = "https://demo.edgeever.org|user-1";
    await localDb.syncMeta.put({ scope, key: "identity", value: "sync-1", updatedAt: new Date().toISOString() });
    const original = {
      listTags: api.listTags,
      listTemplates: api.listTemplates,
      listResources: api.listResources,
      listNotebooks: api.listNotebooks,
    };
    api.listTags = async () => { throw new Error("cloud fallback"); };
    api.listTemplates = async () => { throw new Error("cloud fallback"); };
    api.listResources = async () => { throw new Error("cloud fallback"); };
    api.listNotebooks = async () => { throw new Error("cloud fallback"); };

    try {
      const repository = createWebRepository(scope);
      expect(await repository.listTags()).toEqual({ tags: [] });
      expect(await repository.listTemplates()).toEqual({ templates: [] });
      expect(await repository.listResources()).toEqual({ resources: [], summary: { totalCount: 0, totalBytes: 0, imageCount: 0, attachmentCount: 0 } });
      expect((await repository.listNotebooks()).notebooks).toEqual([]);
    } finally {
      api.listTags = original.listTags;
      api.listTemplates = original.listTemplates;
      api.listResources = original.listResources;
      api.listNotebooks = original.listNotebooks;
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });
});

describe("web repository sync pause", () => {
  test("reads only the local mirror while pulling is paused", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-pull-paused";
    const memo = await createLocalMemo(scope, { notebookId: "nb-1", contentMarkdown: "local only" });
    const original = { getMemo: api.getMemo, listNotebooks: api.listNotebooks };
    let remoteCalls = 0;
    api.getMemo = async () => {
      remoteCalls += 1;
      throw new Error("Remote memo must not be requested while pulling is paused");
    };
    api.listNotebooks = async () => {
      remoteCalls += 1;
      throw new Error("Remote notebooks must not be requested while pulling is paused");
    };
    setSyncPause("pull", true, scope);

    try {
      const repository = createWebRepository(scope);
      expect((await repository.getMemo(memo.id)).memo.contentMarkdown).toContain("local only");
      expect((await repository.listNotebooks()).notebooks).toEqual([]);
      expect(remoteCalls).toBe(0);
    } finally {
      api.getMemo = original.getMemo;
      api.listNotebooks = original.listNotebooks;
      setSyncPause("all", false, scope);
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("refuses to open an uncached note while pulling is paused", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const restoreWindow = installTestWindow();
    const scope = "https://demo.edgeever.org|user-pull-paused-missing";
    const original = api.getMemo;
    api.getMemo = async () => {
      throw new Error("Remote memo must not be requested while pulling is paused");
    };
    setSyncPause("pull", true, scope);

    try {
      await expect(createWebRepository(scope).getMemo("memo-not-mirrored")).rejects.toMatchObject({
        code: "sync_paused",
      });
    } finally {
      api.getMemo = original;
      setSyncPause("all", false, scope);
      restoreWindow();
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });
});
