import { afterEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { localDb } = await import("./local-db.ts");
const { ApiRequestError, api } = await import("./api.ts");
const { createLocalDataScope, createLocalMemo, getLocalMemo, putLocalMemo, replaceLocalMemoId, createLocalResource, listLocalResources } = await import("./local-mirror.ts");
const { discardWebConflicts, getLocalActionQueueId, getMemoCreateQueueId, getMemoDeleteQueueId, getMemoUpdateQueueId, queueLocalAction, queueMemoCreate, queueMemoDelete, queueMemoUpdate, shouldRetryMissingMemoBatch, syncQueuedChanges } = await import("./sync-queue.ts");

afterEach(async () => {
  await localDb.transaction(
    "rw",
    [localDb.drafts, localDb.syncQueue, localDb.notebooks, localDb.memos, localDb.templates, localDb.revisions, localDb.resources, localDb.syncMeta, localDb.idMappings],
    async () => {
      await Promise.all([
        localDb.drafts.clear(),
        localDb.syncQueue.clear(),
        localDb.notebooks.clear(),
        localDb.memos.clear(),
        localDb.templates.clear(),
        localDb.revisions.clear(),
        localDb.resources.clear(),
        localDb.syncMeta.clear(),
        localDb.idMappings.clear(),
      ]);
    },
  );
});

describe("web sync conflict recovery", () => {
  test("preserves a newer draft written while a memo update is in flight", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const createdMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    const remoteMemo = {
      ...createdMemo,
      id: "memo-draft-in-flight",
      revision: 1,
      contentHash: "hash-1",
    };
    const syncedContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "synced snapshot" }] }] };
    const newerContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "still typing" }] }] };
    await putLocalMemo(scope, remoteMemo);
    await queueMemoUpdate({
      memoId: remoteMemo.id,
      expectedRevision: 1,
      expectedContentHash: "hash-1",
      editSessionId: "edit-a",
      title: "Synced snapshot",
      contentJson: syncedContent,
      tags: [],
    }, scope);

    let updateStarted;
    let releaseUpdate;
    const updateStartedPromise = new Promise((resolve) => { updateStarted = resolve; });
    const releaseUpdatePromise = new Promise((resolve) => { releaseUpdate = resolve; });
    const original = {
      createMemoEditSession: api.createMemoEditSession,
      updateMemo: api.updateMemo,
    };
    api.createMemoEditSession = async () => ({ editSession: { id: "fresh-edit", baseRevision: 1, baseContentHash: "hash-1" } });
    api.updateMemo = async (_memoId, payload) => {
      updateStarted();
      await releaseUpdatePromise;
      return { memo: { ...remoteMemo, ...payload, revision: 2, contentHash: "hash-2" } };
    };

    try {
      const callbackOrder = [];
      const syncing = syncQueuedChanges({
        scope,
        onMemoAcknowledged: () => callbackOrder.push("acknowledged"),
        onSynced: () => callbackOrder.push("synced"),
      });
      await updateStartedPromise;
      await localDb.drafts.put({
        memoId: remoteMemo.id,
        title: "Still typing",
        tagsText: "",
        contentJson: newerContent,
        updatedAt: "2099-01-01T00:00:00.000Z",
      });
      releaseUpdate();

      expect(await syncing).toMatchObject({ synced: 1, conflicted: 0 });
      expect(callbackOrder).toEqual(["acknowledged", "synced"]);
      expect(await localDb.drafts.get(remoteMemo.id)).toMatchObject({
        title: "Still typing",
        contentJson: newerContent,
      });
    } finally {
      api.createMemoEditSession = original.createMemoEditSession;
      api.updateMemo = original.updateMemo;
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("preserves a draft written while a new memo create request is in flight", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });

    let createStarted;
    let releaseCreate;
    const createStartedPromise = new Promise((resolve) => { createStarted = resolve; });
    const releaseCreatePromise = new Promise((resolve) => { releaseCreate = resolve; });
    const remoteMemo = {
      ...localMemo,
      id: "memo-remote",
      revision: 1,
      contentHash: "remote-empty-hash",
    };
    const originalCreateMemo = api.createMemo;
    api.createMemo = async () => {
      createStarted();
      await releaseCreatePromise;
      return { memo: remoteMemo };
    };

    try {
      const syncing = syncQueuedChanges({
        scope,
        onSynced: async (memo, item) => {
          if (item.kind === "memo.create") await replaceLocalMemoId(scope, item.memoId, memo);
        },
      });
      await createStartedPromise;
      await localDb.drafts.put({
        memoId: localMemo.id,
        title: "Pasted while syncing",
        tagsText: "important",
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "must survive" }] }] },
        updatedAt: "2099-01-01T00:00:00.000Z",
      });
      releaseCreate();

      expect(await syncing).toMatchObject({ synced: 1, failed: 0 });
      expect(await localDb.drafts.get(localMemo.id)).toBeUndefined();
      expect(await localDb.drafts.get(remoteMemo.id)).toMatchObject({ title: "Pasted while syncing" });
      expect(await getLocalMemo(scope, remoteMemo.id)).toMatchObject({
        title: "Pasted while syncing",
        contentText: "must survive",
        revision: remoteMemo.revision,
        contentHash: remoteMemo.contentHash,
      });
    } finally {
      api.createMemo = originalCreateMemo;
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("rebases an edit queued before a new memo receives its remote id", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });
    await queueMemoUpdate({
      memoId: localMemo.id,
      expectedRevision: 0,
      expectedContentHash: localMemo.contentHash,
      editSessionId: `local-edit:${localMemo.id}`,
      title: "Queued edit",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "queued body" }] }] },
      tags: [],
    }, scope);
    const remoteMemo = { ...localMemo, id: "memo-remote-rebased", revision: 3, contentHash: "remote-base-hash" };
    const original = {
      createMemo: api.createMemo,
      createMemoEditSession: api.createMemoEditSession,
      updateMemo: api.updateMemo,
    };
    let receivedUpdate = null;
    api.createMemo = async () => ({ memo: remoteMemo });
    api.createMemoEditSession = async () => ({
      editSession: {
        id: "fresh-remote-session",
        baseRevision: remoteMemo.revision,
        baseContentHash: remoteMemo.contentHash,
      },
    });
    api.updateMemo = async (_memoId, payload) => {
      receivedUpdate = payload;
      return { memo: { ...remoteMemo, ...payload, revision: remoteMemo.revision + 1, contentHash: "updated-hash" } };
    };

    try {
      const firstRun = await syncQueuedChanges({ scope });
      // The edit queued against the temporary id is rebased onto the fresh
      // server base and pushed in the same pass instead of waiting for the
      // next queue tick.
      expect(firstRun).toMatchObject({ synced: 2, conflicted: 0, failed: 0 });
      expect(receivedUpdate).toMatchObject({
        expectedRevision: remoteMemo.revision,
        expectedContentHash: remoteMemo.contentHash,
        editSessionId: "fresh-remote-session",
        title: "Queued edit",
      });
      expect(await localDb.syncQueue.get(getMemoUpdateQueueId(remoteMemo.id))).toBeUndefined();
      expect(await localDb.syncQueue.get(getMemoUpdateQueueId(localMemo.id))).toBeUndefined();
    } finally {
      api.createMemo = original.createMemo;
      api.createMemoEditSession = original.createMemoEditSession;
      api.updateMemo = original.updateMemo;
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("cancels a queued create when the note is deleted before its create syncs", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });
    await localDb.drafts.put({
      memoId: localMemo.id,
      title: "Draft of a canceled create",
      tagsText: "",
      contentJson: { type: "doc", content: [] },
      updatedAt: "2099-01-01T00:00:00.000Z",
    });

    const original = { createMemo: api.createMemo, deleteMemo: api.deleteMemo };
    let createCalls = 0;
    let deleteCalls = 0;
    api.createMemo = async () => {
      createCalls += 1;
      return { memo: { ...localMemo, id: "memo-should-not-exist", revision: 1 } };
    };
    api.deleteMemo = async () => {
      deleteCalls += 1;
    };

    try {
      await queueMemoDelete(scope, { memoId: localMemo.id, permanent: false });
      // Never created on the server, so there is nothing to delete remotely.
      expect(await localDb.syncQueue.get(getMemoCreateQueueId(localMemo.id))).toBeUndefined();
      expect(await localDb.syncQueue.get(getMemoDeleteQueueId(localMemo.id))).toBeUndefined();
      expect(await localDb.drafts.get(localMemo.id)).toBeUndefined();

      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ attempted: 0, synced: 0 });
      expect(createCalls).toBe(0);
      expect(deleteCalls).toBe(0);
    } finally {
      api.createMemo = original.createMemo;
      api.deleteMemo = original.deleteMemo;
    }
  });

  test("deletes the durable memo when a delete is queued while its create is in flight", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });

    let createStarted;
    let releaseCreate;
    const createStartedPromise = new Promise((resolve) => { createStarted = resolve; });
    const releaseCreatePromise = new Promise((resolve) => { releaseCreate = resolve; });
    const remoteMemo = { ...localMemo, id: "memo-remote-deleted", revision: 1, contentHash: "created-hash" };
    const original = { createMemo: api.createMemo, deleteMemo: api.deleteMemo };
    const deletedIds = [];
    api.createMemo = async () => {
      createStarted();
      await releaseCreatePromise;
      return { memo: remoteMemo };
    };
    api.deleteMemo = async (memoId) => {
      deletedIds.push(memoId);
    };

    try {
      const syncing = syncQueuedChanges({ scope });
      await createStartedPromise;
      // The create is already in flight, so the delete cannot cancel it; it
      // must be remapped to the durable id and run in the same pass.
      await queueMemoDelete(scope, { memoId: localMemo.id, permanent: false });
      releaseCreate();

      expect(await syncing).toMatchObject({ synced: 2, failed: 0 });
      expect(deletedIds).toEqual([remoteMemo.id]);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.createMemo = original.createMemo;
      api.deleteMemo = original.deleteMemo;
    }
  });

  test("treats an already removed memo as deleted when the permanent delete syncs", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await queueMemoDelete(scope, { memoId: "memo-already-gone", permanent: true });

    const originalDeleteMemo = api.deleteMemo;
    api.deleteMemo = async () => {
      throw new ApiRequestError("Memo not found in trash", 404, "not_found");
    };

    try {
      expect(await syncQueuedChanges({ scope })).toMatchObject({ synced: 1, failed: 0, conflicted: 0 });
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.deleteMemo = originalDeleteMemo;
    }
  });

  test("turns a save for a deleted memo into a resolvable conflict", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox", title: "Edited elsewhere" });
    await queueMemoUpdate({
      memoId: memo.id,
      expectedRevision: 0,
      expectedContentHash: memo.contentHash,
      editSessionId: `local-edit:${memo.id}`,
      title: "Edited elsewhere",
      contentJson: { type: "doc", content: [] },
      tags: [],
    }, scope);

    const originalCreateEditSession = api.createMemoEditSession;
    api.createMemoEditSession = async () => {
      throw new ApiRequestError("Memo not found", 404, "not_found");
    };

    try {
      expect(await syncQueuedChanges({ scope })).toMatchObject({ conflicted: 1, failed: 0 });
      expect(await localDb.syncQueue.get(getMemoUpdateQueueId(memo.id))).toMatchObject({
        status: "conflict",
        lastErrorCode: "memo_not_found",
        nextAttemptAt: null,
      });
      // Conflicts wait for the user; the sync loop must not keep retrying.
      expect(await syncQueuedChanges({ scope })).toMatchObject({ attempted: 0 });
    } finally {
      api.createMemoEditSession = originalCreateEditSession;
    }
  });

  test("does not auto-retry a permanent sync failure", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox", title: "Rejected payload" });
    await queueMemoUpdate({
      memoId: memo.id,
      expectedRevision: 0,
      expectedContentHash: memo.contentHash,
      editSessionId: `local-edit:${memo.id}`,
      title: "Rejected payload",
      contentJson: { type: "doc", content: [] },
      tags: [],
    }, scope);

    const originalCreateEditSession = api.createMemoEditSession;
    api.createMemoEditSession = async () => {
      throw new ApiRequestError("Invalid payload", 400, "invalid_payload");
    };

    try {
      expect(await syncQueuedChanges({ scope })).toMatchObject({ failed: 1, conflicted: 0 });
      expect(await localDb.syncQueue.get(getMemoUpdateQueueId(memo.id))).toMatchObject({
        status: "error",
        nextAttemptAt: null,
      });
      expect(await syncQueuedChanges({ scope })).toMatchObject({ attempted: 0 });
    } finally {
      api.createMemoEditSession = originalCreateEditSession;
    }
  });

  test("restores the authoritative remote memo and removes the conflict", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox", title: "Local draft" });
    const remote = { ...memo, title: "Remote version", revision: 4 };
    const originalGetMemo = api.getMemo;
    api.getMemo = async () => ({ memo: remote });
    await localDb.syncQueue.put({
      id: "memo.update:conflict",
      kind: "memo.update",
      scope,
      memoId: memo.id,
      status: "conflict",
      payload: { memoId: memo.id, expectedRevision: 0, expectedContentHash: memo.contentHash, editSessionId: "session", title: "Local draft", contentJson: memo.contentJson, tags: [] },
      attemptCount: 1,
      lastError: "conflict",
      nextAttemptAt: null,
      claimId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(await discardWebConflicts(scope)).toBe(1);
    expect((await getLocalMemo(scope, memo.id))?.title).toBe("Remote version");
    expect(await localDb.syncQueue.get("memo.update:conflict")).toBeUndefined();
    api.getMemo = originalGetMemo;
  });

  test("uploads an offline resource and rewrites its memo reference", async () => {
    const previousCaches = globalThis.caches;
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const entries = new Map();
    globalThis.caches = {
      open: async () => ({
        put: async (key, response) => entries.set(key, response),
        match: async (key) => entries.get(key) ?? undefined,
        delete: async (key) => entries.delete(key),
      }),
    };
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox", title: "With file" });
    const staged = await createLocalResource(scope, memo.id, new File(["offline"], "offline.txt", { type: "text/plain" }));
    const localMemo = await getLocalMemo(scope, memo.id);
    const placeholderMemo = {
      ...localMemo,
      contentMarkdown: `[offline](${staged.url})`,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: staged.url }] }] },
    };
    await putLocalMemo(scope, placeholderMemo);
    await queueLocalAction(scope, "resource.create", staged.id, {
      resourceId: staged.id,
      memoId: memo.id,
      filename: staged.filename,
      mimeType: staged.mimeType,
      url: staged.url,
    }, memo.id);

    const original = {
      uploadMemoResource: api.uploadMemoResource,
      getMemo: api.getMemo,
      createMemoEditSession: api.createMemoEditSession,
      updateMemo: api.updateMemo,
    };
    const remoteResource = { ...staged, id: "resource-remote", url: "/api/v1/resources/resource-remote/blob" };
    const remoteMemo = { ...placeholderMemo, contentMarkdown: `[offline](${staged.url})` };
    api.uploadMemoResource = async () => ({ resource: remoteResource });
    api.getMemo = async () => ({ memo: remoteMemo });
    api.createMemoEditSession = async () => ({ editSession: { id: "edit-1", baseRevision: 1, baseContentHash: remoteMemo.contentHash } });
    api.updateMemo = async (_memoId, payload) => ({ memo: { ...remoteMemo, ...payload, contentHash: "patched", revision: 2 } });

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result.synced).toBe(1);
      expect((await getLocalMemo(scope, memo.id))?.contentMarkdown).toContain(remoteResource.url);
      expect((await listLocalResources(scope)).resources[0]?.id).toBe(remoteResource.id);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.uploadMemoResource = original.uploadMemoResource;
      api.getMemo = original.getMemo;
      api.createMemoEditSession = original.createMemoEditSession;
      api.updateMemo = original.updateMemo;
      globalThis.caches = previousCaches;
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });
});

describe("web batch action recovery", () => {
  const withOnline = (body) => async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    try {
      await body();
    } finally {
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  };

  test("retries only terminal missing-memo batch failures", () => {
    expect(shouldRetryMissingMemoBatch({ kind: "memo.moveBatch", status: "error", lastErrorCode: "missing_memos" })).toBe(true);
    expect(shouldRetryMissingMemoBatch({ kind: "memo.pinBatch", status: "error", lastErrorCode: "not_found" })).toBe(true);
    expect(shouldRetryMissingMemoBatch({ kind: "memo.pinBatch", status: "error", lastErrorCode: "http_404" })).toBe(true);
    expect(shouldRetryMissingMemoBatch({ kind: "memo.pinBatch", status: "pending", lastErrorCode: "not_found" })).toBe(false);
    expect(shouldRetryMissingMemoBatch({ kind: "memo.deleteBatch", status: "error", lastErrorCode: "missing_memos" })).toBe(false);
    expect(shouldRetryMissingMemoBatch({ kind: "memo.moveBatch", status: "error", lastErrorCode: "http_500" })).toBe(false);
  });

  test("moves an offline-created memo after the create acknowledgement remaps the batch", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });
    await queueLocalAction(scope, "memo.moveBatch", localMemo.id, { memoIds: [localMemo.id], notebookId: "nb-target" });
    const remoteMemo = { ...localMemo, id: "memo-remote-move", revision: 1, contentHash: "remote-hash" };
    const original = { createMemo: api.createMemo, moveMemos: api.moveMemos };
    const moveCalls = [];
    api.createMemo = async () => ({ memo: remoteMemo });
    api.moveMemos = async (input) => {
      moveCalls.push(input);
      return { ok: true, moved: input.memoIds.length };
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 2, failed: 0, conflicted: 0 });
      expect(moveCalls).toEqual([{ memoIds: [remoteMemo.id], notebookId: "nb-target" }]);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.createMemo = original.createMemo;
      api.moveMemos = original.moveMemos;
    }
  }));

  test("waits for the create before moving a memo that is still syncing", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });
    await queueLocalAction(scope, "memo.moveBatch", localMemo.id, { memoIds: [localMemo.id], notebookId: "nb-target" });
    const original = { createMemo: api.createMemo, moveMemos: api.moveMemos };
    const moveCalls = [];
    api.moveMemos = async (input) => {
      moveCalls.push(input);
      return { ok: true, moved: input.memoIds.length };
    };
    api.createMemo = async () => {
      throw new ApiRequestError("Server unavailable", 500);
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 0, failed: 1, conflicted: 0 });
      expect(moveCalls).toEqual([]);
      const moveItem = await localDb.syncQueue.get(getLocalActionQueueId(scope, "memo.moveBatch", localMemo.id));
      expect(moveItem?.status).toBe("pending");
      expect(moveItem?.payload).toMatchObject({ memoIds: [localMemo.id] });
    } finally {
      api.createMemo = original.createMemo;
      api.moveMemos = original.moveMemos;
    }
  }));

  test("recovers a move batch stuck on a terminal missing_memos failure", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const moveId = getLocalActionQueueId(scope, "memo.moveBatch", "memo-dead");
    await queueLocalAction(scope, "memo.moveBatch", "memo-dead", { memoIds: ["memo-dead"], notebookId: "nb-target" });
    await localDb.syncQueue.update(moveId, {
      status: "error",
      lastError: "One or more memos cannot be moved.",
      lastErrorCode: "missing_memos",
      nextAttemptAt: null,
    });
    const originalMoveMemos = api.moveMemos;
    const calls = [];
    api.moveMemos = async (input) => {
      calls.push(input);
      if (input.memoIds.length === 1 && input.memoIds[0] === "memo-dead") {
        throw new ApiRequestError("One or more memos cannot be moved.", 400, "missing_memos");
      }
      return { ok: true, moved: input.memoIds.length };
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 1, failed: 0, conflicted: 0 });
      expect(calls).toEqual([
        { memoIds: ["memo-dead"], notebookId: "nb-target" },
        { memoIds: ["memo-dead"], notebookId: "nb-target" },
      ]);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.moveMemos = originalMoveMemos;
    }
  }));

  test("pins what it can when a note in the batch is already gone", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await queueLocalAction(scope, "memo.pinBatch", "memo-a,memo-gone", { memoIds: ["memo-a", "memo-gone"], isPinned: true });
    const originalUpdateMemo = api.updateMemo;
    const pinned = [];
    api.updateMemo = async (memoId, patch) => {
      if (memoId === "memo-gone") {
        throw new ApiRequestError("Memo not found", 404, "not_found");
      }
      pinned.push({ memoId, isPinned: patch.isPinned });
      return { memo: { id: memoId } };
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 1, failed: 0, conflicted: 0 });
      expect(pinned).toEqual([{ memoId: "memo-a", isPinned: true }]);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  }));

  test("flushes a memo theme change and clears it from the queue", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await queueLocalAction(scope, "memo.setTheme", "memo-a", { memoId: "memo-a", theme: "letter" });
    const originalUpdateMemo = api.updateMemo;
    const updates = [];
    api.updateMemo = async (memoId, patch) => {
      updates.push({ memoId, patch });
      return { memo: { id: memoId, theme: patch.theme ?? null } };
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 1, failed: 0, conflicted: 0 });
      expect(updates).toEqual([{ memoId: "memo-a", patch: { theme: "letter" } }]);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  }));

  test("drops a theme change whose note is already gone", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await queueLocalAction(scope, "memo.setTheme", "memo-gone", { memoId: "memo-gone", theme: null });
    const originalUpdateMemo = api.updateMemo;
    api.updateMemo = async () => {
      throw new ApiRequestError("Memo not found", 404, "not_found");
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 1, failed: 0, conflicted: 0 });
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  }));

  test("applies a theme chosen offline after the create acknowledgement remaps the id", withOnline(async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox" });
    await queueMemoCreate(scope, {
      temporaryId: localMemo.id,
      notebookId: localMemo.notebookId,
      title: "",
      contentMarkdown: "",
      tags: [],
      createdAt: localMemo.createdAt,
      updatedAt: localMemo.updatedAt,
    });
    await queueLocalAction(scope, "memo.setTheme", localMemo.id, { memoId: localMemo.id, theme: "letter" });
    const remoteMemo = { ...localMemo, id: "memo-remote-theme", revision: 1, contentHash: "remote-hash" };
    const original = { createMemo: api.createMemo, updateMemo: api.updateMemo };
    const updates = [];
    api.createMemo = async () => ({ memo: remoteMemo });
    api.updateMemo = async (memoId, patch) => {
      updates.push({ memoId, patch });
      return { memo: { ...remoteMemo, theme: patch.theme ?? null } };
    };

    try {
      const result = await syncQueuedChanges({ scope });
      expect(result).toMatchObject({ synced: 2, failed: 0, conflicted: 0 });
      expect(updates).toEqual([{ memoId: remoteMemo.id, patch: { theme: "letter" } }]);
      expect(await localDb.syncQueue.count()).toBe(0);
    } finally {
      api.createMemo = original.createMemo;
      api.updateMemo = original.updateMemo;
    }
  }));
});
