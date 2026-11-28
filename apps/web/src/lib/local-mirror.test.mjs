import { afterEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const { localDb } = await import("./local-db.ts");
const {
  createLocalDataScope,
  clearLocalScope,
  createLocalMemo,
  getLocalMemo,
  listLocalTemplates,
  listLocalTags,
  listLocalMemos,
  putLocalTemplate,
  putLocalMemo,
  putLocalMemoUpdate,
  cacheSavedLocalMemo,
  applyLocalTagRename,
  applyLocalMemoMove,
  applyLocalMemoPin,
  applyLocalMemoTheme,
  applyLocalMemoStatus,
  putLocalMemoIfNotStale,
  applyLocalMemoDeleteBatch,
  applyLocalEmptyTrash,
  updateLocalNotebook,
  getLocalNotebook,
  deleteLocalNotebook,
  putLocalNotebook,
  mergeLocalMemos,
  putLocalMemoRevisions,
  listLocalMemoRevisions,
  getLocalMemoRevision,
  putLocalResource,
  createLocalResource,
  listLocalResources,
  listLocalMemoIdMappings,
  observeLocalMemoIdMappings,
  replaceLocalResources,
  remapLocalDraftMemoId,
  replaceLocalMemoId,
  hasLocalSyncCursorRewound,
  syncLocalMirror,
} = await import("./local-mirror.ts");
const { api } = await import("./api.ts");
const { queueLocalAction } = await import("./sync-queue.ts");
const { setSyncPause } = await import("./sync-preferences.ts");
const { getCachedLocalResourceBytes } = await import("./local-resource-cache.ts");

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

// listLocalMemos only returns notes whose notebook exists in the mirror, so a
// listed note needs its notebook row first — exactly like a real workspace.
const seedNotebook = (scope, id) => putLocalNotebook(scope, {
  id,
  parentId: null,
  name: id,
  slug: null,
  icon: null,
  color: null,
  sortOrder: 0,
  memoCount: 0,
  lastMemoUpdatedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("local mirror", () => {
  test("defaults old and new notes to no status and preserves summary metadata", async () => {
    const scope = createLocalDataScope("https://notes.example.org", "user-1");
    await seedNotebook(scope, "inbox");
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    expect(memo.status).toBeNull();
    const { status: _status, ...legacy } = memo;
    await localDb.memos.put({ ...legacy, scope });
    expect((await getLocalMemo(scope, memo.id)).status).toBeNull();
    expect((await listLocalMemos(scope, {})).memos[0].status).toBeNull();
    await putLocalMemo(scope, { ...memo, theme: "letter", status: "in_progress" });
    expect((await listLocalMemos(scope, {})).memos[0]).toMatchObject({ theme: "letter", status: "in_progress" });
  });

  test("preserves omitted status, honors null, and rejects older status snapshots after a clear", async () => {
    const scope = createLocalDataScope("https://notes.example.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const selected = await applyLocalMemoStatus(scope, memo.id, "completed");
    await putLocalMemo(scope, { ...selected, status: undefined, title: "Unrelated update" });
    expect((await getLocalMemo(scope, memo.id)).status).toBe("completed");
    await putLocalMemo(scope, { ...selected, status: null });
    expect((await getLocalMemo(scope, memo.id)).status).toBeNull();
    const cleared = await applyLocalMemoStatus(scope, memo.id, null);
    await putLocalMemoIfNotStale(scope, { ...selected, status: "completed" });
    expect((await getLocalMemo(scope, memo.id))).toMatchObject({ status: null, updatedAt: cleared.updatedAt });
    // A content autosave may still hold the detail from before the clear.
    const saved = await putLocalMemoUpdate(scope, selected, { title: "Saved content", contentJson: memo.contentJson, tags: [] });
    expect(saved.status).toBeNull();
    expect((await getLocalMemo(scope, memo.id)).status).toBeNull();
  });

  for (const bootstrap of [false, true]) {
    for (const status of ["in_progress", "completed", "cancelled", null]) {
      test(`overlays queued status ${status} during ${bootstrap ? "bootstrap" : "incremental pull"}`, async () => {
        const scope = createLocalDataScope("https://notes.example.org", "user-1");
        await seedNotebook(scope, "inbox");
        const created = await createLocalMemo(scope, { notebookId: "inbox" });
        const memo = { ...created, id: "remote-status", status: "completed" };
        await putLocalMemo(scope, memo);
        await applyLocalMemoStatus(scope, memo.id, status);
        await queueLocalAction(scope, "memo.status", memo.id, { memoId: memo.id, status });
        const original = { syncBootstrap: api.syncBootstrap, syncChanges: api.syncChanges };
        const stale = { ...memo, revision: 9, title: "New remote content", updatedAt: "2099-01-01T00:00:00.000Z" };
        if (!bootstrap) {
          await localDb.syncMeta.bulkPut([
            { scope, key: "cursor", value: "1", updatedAt: memo.updatedAt },
            { scope, key: "identity", value: "workspace", updatedAt: memo.updatedAt },
          ]);
        }
        api.syncBootstrap = async () => ({ notebooks: [], memos: [stale], snapshotCursor: 2, syncIdentity: "workspace", nextAfterId: null });
        api.syncChanges = async () => ({ changes: [{ entityType: "memo", entityId: memo.id, operation: "upsert", memo: stale }], cursor: 2, serverCursor: 2, hasMore: false, syncIdentity: "workspace" });
        try {
          await syncLocalMirror(scope);
          expect((await getLocalMemo(scope, memo.id))).toMatchObject({ status, title: "New remote content", revision: 9 });
        } finally {
          api.syncBootstrap = original.syncBootstrap;
          api.syncChanges = original.syncChanges;
        }
      });
    }
  }

  test("keeps an acknowledged clear when an older pull response arrives after the queue is empty", async () => {
    const scope = createLocalDataScope("https://notes.example.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const remote = { ...memo, id: "late-status-pull", status: "completed", revision: 1 };
    await putLocalMemo(scope, remote);
    await localDb.syncMeta.bulkPut([
      { scope, key: "cursor", value: "1", updatedAt: memo.updatedAt },
      { scope, key: "identity", value: "workspace", updatedAt: memo.updatedAt },
    ]);
    const original = { syncChanges: api.syncChanges, updateMemo: api.updateMemo };
    let started;
    let release;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const response = new Promise((resolve) => { release = resolve; });
    api.syncChanges = async () => { started(); return response; };
    api.updateMemo = async () => ({ memo: { ...remote, status: null, updatedAt: "2099-01-01T00:00:00.000Z" } });
    const stalePage = { changes: [{ entityType: "memo", entityId: remote.id, operation: "upsert", memo: remote }], cursor: 2, serverCursor: 2, hasMore: false, syncIdentity: "workspace" };
    try {
      const pulling = syncLocalMirror(scope);
      await startedPromise;
      await applyLocalMemoStatus(scope, remote.id, null);
      await queueLocalAction(scope, "memo.status", remote.id, { memoId: remote.id, status: null });
      const { syncQueuedChanges } = await import("./sync-queue.ts");
      expect(await syncQueuedChanges({ scope })).toMatchObject({ synced: 1 });
      expect(await localDb.syncQueue.count()).toBe(0);
      release(stalePage);
      await pulling;
      expect((await getLocalMemo(scope, remote.id))).toMatchObject({ status: null, updatedAt: "2099-01-01T00:00:00.000Z" });
      await syncLocalMirror(scope);
      expect((await getLocalMemo(scope, remote.id)).status).toBeNull();
    } finally {
      release(stalePage);
      api.syncChanges = original.syncChanges;
      api.updateMemo = original.updateMemo;
    }
  });

  test("preserves a cleared temporary status when create acknowledgement is applied twice", async () => {
    const scope = createLocalDataScope("https://notes.example.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    await applyLocalMemoStatus(scope, memo.id, "completed");
    await applyLocalMemoStatus(scope, memo.id, null);
    const remote = { ...memo, id: "remote-cleared-status", status: "completed", revision: 1 };
    expect((await replaceLocalMemoId(scope, memo.id, remote)).status).toBeNull();
    expect((await replaceLocalMemoId(scope, memo.id, remote)).status).toBeNull();
  });

  test("records a durable mapping when a new memo receives its remote id", async () => {
    const scope = createLocalDataScope("https://notes.example.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox", title: "New note" });
    const remoteMemo = {
      ...localMemo,
      id: "memo-remote",
      revision: 1,
      contentHash: "remote-hash",
    };

    await replaceLocalMemoId(scope, localMemo.id, remoteMemo);

    expect(await listLocalMemoIdMappings(scope)).toEqual(new Map([[localMemo.id, remoteMemo.id]]));
  });

  test("observes a new memo id mapping so another live workspace can recover", async () => {
    const scope = createLocalDataScope("https://notes.example.org", "user-1");
    const localMemo = await createLocalMemo(scope, { notebookId: "inbox", title: "New note" });
    const remoteMemo = {
      ...localMemo,
      id: "memo-remote",
      revision: 1,
      contentHash: "remote-hash",
    };
    const observedMapping = new Promise((resolve) => {
      const unsubscribe = observeLocalMemoIdMappings(scope, (mappings) => {
        if (mappings.get(localMemo.id) !== remoteMemo.id) return;
        unsubscribe();
        resolve(mappings);
      });
    });

    await replaceLocalMemoId(scope, localMemo.id, remoteMemo);

    expect(await observedMapping).toEqual(new Map([[localMemo.id, remoteMemo.id]]));
  });

  test("clears cached data, drafts, and pending changes for a reset scope", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const otherScope = createLocalDataScope("https://notes.example.org", "user-2");
    const scopedMemo = await createLocalMemo(scope, { notebookId: "demo-notebook", title: "Changed demo note" });
    const otherMemo = await createLocalMemo(otherScope, { notebookId: "private-notebook", title: "Keep me" });
    await localDb.drafts.bulkPut([
      { memoId: scopedMemo.id, title: "Demo draft", contentJson: { type: "doc", content: [] }, tagsText: "", updatedAt: "2026-01-01T00:00:00.000Z" },
      { memoId: otherMemo.id, title: "Private draft", contentJson: { type: "doc", content: [] }, tagsText: "", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await localDb.syncQueue.bulkPut([
      {
        id: `memo.update:${scopedMemo.id}`,
        kind: "memo.update",
        scope,
        memoId: scopedMemo.id,
        status: "pending",
        payload: {},
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
        claimId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: `memo.update:${otherMemo.id}`,
        kind: "memo.update",
        scope: otherScope,
        memoId: otherMemo.id,
        status: "pending",
        payload: {},
        attemptCount: 0,
        lastError: null,
        nextAttemptAt: null,
        claimId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await clearLocalScope(scope);

    expect(await getLocalMemo(scope, scopedMemo.id)).toBeNull();
    expect(await localDb.drafts.get(scopedMemo.id)).toBeUndefined();
    expect(await localDb.syncQueue.get(`memo.update:${scopedMemo.id}`)).toBeUndefined();
    expect(await getLocalMemo(otherScope, otherMemo.id)).not.toBeNull();
    expect(await localDb.drafts.get(otherMemo.id)).toBeDefined();
    expect(await localDb.syncQueue.get(`memo.update:${otherMemo.id}`)).toBeDefined();
  });

  test("rebuilds the browser mirror when the server change cursor rewinds", () => {
    expect(hasLocalSyncCursorRewound(42, 7)).toBe(true);
    expect(hasLocalSyncCursorRewound(42, 42)).toBe(false);
    expect(hasLocalSyncCursorRewound(42, 64)).toBe(false);
    expect(hasLocalSyncCursorRewound(42)).toBe(false);
  });

  test("replaces stale IndexedDB data after the server change log is reset", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await createLocalMemo(scope, { notebookId: "old-notebook", title: "Stale cached note" });
    await localDb.syncMeta.bulkPut([
      { scope, key: "cursor", value: "42", updatedAt: "2026-01-01T00:00:00.000Z" },
      { scope, key: "identity", value: "same-workspace", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const originalSyncChanges = api.syncChanges;
    const originalSyncBootstrap = api.syncBootstrap;
    api.syncChanges = async () => ({
      changes: [],
      cursor: 42,
      hasMore: false,
      serverCursor: 7,
      syncIdentity: "same-workspace",
    });
    api.syncBootstrap = async () => ({
      notebooks: [],
      memos: [],
      snapshotCursor: 7,
      syncIdentity: "same-workspace",
      totalCount: 0,
      nextAfterId: null,
    });

    try {
      expect(await syncLocalMirror(scope)).toEqual({ bootstrapped: true, changed: 0 });
      expect((await listLocalMemos(scope, {})).totalCount).toBe(0);
      expect((await localDb.syncMeta.get([scope, "cursor"]))?.value).toBe("7");
    } finally {
      api.syncChanges = originalSyncChanges;
      api.syncBootstrap = originalSyncBootstrap;
    }
  });

  test("keeps a locally deleted memo deleted while its delete is queued", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await seedNotebook(scope, "nb-inbox");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox", title: "Deleted offline" });
    await putLocalMemo(scope, { ...memo, isDeleted: true, deletedAt: "2026-01-02T00:00:00.000Z" });
    await localDb.syncQueue.put({
      id: `memo.delete:${memo.id}`,
      kind: "memo.delete",
      scope,
      memoId: memo.id,
      status: "pending",
      payload: { memoId: memo.id, permanent: false },
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      claimId: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await localDb.syncMeta.bulkPut([
      { scope, key: "cursor", value: "1", updatedAt: "2026-01-01T00:00:00.000Z" },
      { scope, key: "identity", value: "same-workspace", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const originalSyncChanges = api.syncChanges;
    api.syncChanges = async () => ({
      changes: [{
        entityType: "memo",
        operation: "upsert",
        entityId: memo.id,
        memo: { ...memo, isDeleted: false, revision: 9, title: "Resurrected?" },
        notebook: null,
      }],
      cursor: 2,
      hasMore: false,
      serverCursor: 2,
      syncIdentity: "same-workspace",
    });

    try {
      expect(await syncLocalMirror(scope)).toEqual({ bootstrapped: false, changed: 1 });
      const stored = await getLocalMemo(scope, memo.id);
      // A stale alive snapshot must not undo the queued delete.
      expect(stored?.isDeleted).toBe(true);
      expect(stored?.title).toBe("Deleted offline");
      expect(stored?.revision).not.toBe(9);
    } finally {
      api.syncChanges = originalSyncChanges;
    }
  });

  test("keeps a queued theme while a stale remote snapshot arrives", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await seedNotebook(scope, "nb-inbox");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox", title: "Themed offline" });
    await putLocalMemo(scope, { ...memo, theme: "letter" });
    await localDb.syncQueue.put({
      id: `action:${scope}:memo.setTheme:${memo.id}`,
      kind: "memo.setTheme",
      scope,
      memoId: memo.id,
      status: "pending",
      payload: { memoId: memo.id, theme: "letter" },
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      claimId: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await localDb.syncMeta.bulkPut([
      { scope, key: "cursor", value: "1", updatedAt: "2026-01-01T00:00:00.000Z" },
      { scope, key: "identity", value: "same-workspace", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const originalSyncChanges = api.syncChanges;
    api.syncChanges = async () => ({
      changes: [{
        entityType: "memo",
        operation: "upsert",
        entityId: memo.id,
        memo: { ...memo, theme: null, revision: 9, title: "Themed offline" },
        notebook: null,
      }],
      cursor: 2,
      hasMore: false,
      serverCursor: 2,
      syncIdentity: "same-workspace",
    });

    try {
      expect(await syncLocalMirror(scope)).toEqual({ bootstrapped: false, changed: 1 });
      expect((await getLocalMemo(scope, memo.id))?.theme).toBe("letter");
    } finally {
      api.syncChanges = originalSyncChanges;
    }
  });

  test("keeps a queued delete across a bootstrap rebuild", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await seedNotebook(scope, "nb-inbox");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox", title: "Deleted offline" });
    await putLocalMemo(scope, { ...memo, isDeleted: true, deletedAt: "2026-01-02T00:00:00.000Z" });
    await localDb.syncQueue.put({
      id: `memo.delete:${memo.id}`,
      kind: "memo.delete",
      scope,
      memoId: memo.id,
      status: "pending",
      payload: { memoId: memo.id, permanent: false },
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      claimId: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await localDb.syncMeta.bulkPut([
      { scope, key: "cursor", value: "1", updatedAt: "2026-01-01T00:00:00.000Z" },
      { scope, key: "identity", value: "old-workspace", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const originalSyncChanges = api.syncChanges;
    const originalSyncBootstrap = api.syncBootstrap;
    api.syncChanges = async () => ({
      changes: [],
      cursor: 1,
      hasMore: false,
      serverCursor: 1,
      syncIdentity: "rebuilt-workspace",
    });
    api.syncBootstrap = async () => ({
      notebooks: [],
      memos: [{ ...memo, isDeleted: false, revision: 7, title: "Resurrected?" }],
      snapshotCursor: 3,
      syncIdentity: "rebuilt-workspace",
      totalCount: 1,
      nextAfterId: null,
    });

    try {
      expect(await syncLocalMirror(scope)).toEqual({ bootstrapped: true, changed: 1 });
      const stored = await getLocalMemo(scope, memo.id);
      // The rebuild may refresh content, but the memo must stay in the trash
      // until the queued delete reaches the server.
      expect(stored?.isDeleted).toBe(true);
      expect(stored?.deletedAt).toBeTruthy();
    } finally {
      api.syncChanges = originalSyncChanges;
      api.syncBootstrap = originalSyncBootstrap;
    }
  });

  test("keeps the newest draft when memo ids are remapped more than once", async () => {
    await localDb.drafts.put({
      memoId: "local-memo",
      title: "Older draft",
      tagsText: "",
      contentJson: { type: "doc", content: [] },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await localDb.drafts.put({
      memoId: "remote-memo",
      title: "Newer draft",
      tagsText: "",
      contentJson: { type: "doc", content: [] },
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    await remapLocalDraftMemoId("local-memo", "remote-memo");

    expect(await localDb.drafts.get("local-memo")).toBeUndefined();
    expect(await localDb.drafts.get("remote-memo")).toMatchObject({ title: "Newer draft" });
  });

  test("creates and lists a memo without a network request", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await seedNotebook(scope, "nb-inbox");
    const memo = await createLocalMemo(scope, {
      notebookId: "nb-inbox",
      title: "Local note",
      contentMarkdown: "Hello local first",
      tags: ["draft"],
    });

    const result = await listLocalMemos(scope, { notebookId: "nb-inbox" });
    expect(result.totalCount).toBe(1);
    expect(result.memos[0]?.id).toBe(memo.id);
    expect(result.memos[0]?.excerpt).toContain("Hello local first");
  });

  test("filters memos for direct notebook vs sub-notebook hierarchy", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await Promise.all([
      seedNotebook(scope, "nb-parent"),
      seedNotebook(scope, "nb-child"),
    ]);

    const parentMemo = await createLocalMemo(scope, { notebookId: "nb-parent", title: "Parent Note" });
    const childMemo = await createLocalMemo(scope, { notebookId: "nb-child", title: "Child Note" });

    // Direct only: pass notebookId without notebookIds
    const directResult = await listLocalMemos(scope, { notebookId: "nb-parent" });
    expect(directResult.totalCount).toBe(1);
    expect(directResult.memos.map((m) => m.id)).toEqual([parentMemo.id]);

    // Include sub-notebooks: pass notebookIds containing [parent, child]
    const allDescendantsResult = await listLocalMemos(scope, {
      notebookId: "nb-parent",
      notebookIds: ["nb-parent", "nb-child"],
    });
    expect(allDescendantsResult.totalCount).toBe(2);
    expect(allDescendantsResult.memos.map((m) => m.id).sort()).toEqual([parentMemo.id, childMemo.id].sort());
  });

  test("filters local memos by an exact tag across notebooks", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await Promise.all([seedNotebook(scope, "nb-a"), seedNotebook(scope, "nb-b")]);
    const expected = await createLocalMemo(scope, { notebookId: "nb-a", tags: ["Demo"] });
    await createLocalMemo(scope, { notebookId: "nb-b", tags: ["demo-extra"] });
    await createLocalMemo(scope, { notebookId: "nb-b", title: "Demo without tag" });

    const result = await listLocalMemos(scope, { tag: "demo" });

    expect(result.totalCount).toBe(1);
    expect(result.memos.map((memo) => memo.id)).toEqual([expected.id]);
  });

  test("filters local memos by status before counting and paging", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await seedNotebook(scope, "nb-inbox");
    const statuses = ["in_progress", "completed", "completed", "cancelled", null];
    const created = await Promise.all(statuses.map((status, index) => createLocalMemo(scope, {
      notebookId: "nb-inbox",
      title: `Status ${index}`,
    })));
    for (let index = 0; index < created.length - 1; index += 1) {
      await putLocalMemo(scope, { ...created[index], status: statuses[index] });
    }
    const { status: _status, ...legacyNoStatus } = created[created.length - 1];
    await localDb.memos.put({ ...legacyNoStatus, scope });

    const completed = await listLocalMemos(scope, { filter: "completed", limit: 1 });
    expect(completed.totalCount).toBe(2);
    expect(completed.memos).toHaveLength(1);
    expect(completed.nextCursor).toBe("1");
    expect((await listLocalMemos(scope, { filter: "in_progress" })).memos.map((memo) => memo.id)).toEqual([created[0].id]);
    expect((await listLocalMemos(scope, { filter: "cancelled" })).memos.map((memo) => memo.id)).toEqual([created[3].id]);
    expect((await listLocalMemos(scope, { filter: "no-status" })).memos.map((memo) => memo.id)).toEqual([created[4].id]);
  });

  test("updates local content and preserves the memo identity", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox" });
    const updated = await putLocalMemoUpdate(scope, memo, {
      title: "Updated locally",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Changed" }] }] },
      tags: ["updated"],
    });

    expect(updated.id).toBe(memo.id);
    expect((await getLocalMemo(scope, memo.id))?.title).toBe("Updated locally");
    expect((await getLocalMemo(scope, memo.id))?.tags).toEqual(["updated"]);
    expect((await getLocalMemo(scope, memo.id))?.contentMarkdown).toContain("Changed");
  });

  test("caches a memo the standalone editor saved over the pre-edit mirror row", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox", title: "Before editing" });
    const saved = {
      ...memo,
      title: "Saved from the phone",
      contentMarkdown: "Saved from the phone",
      revision: memo.revision + 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    expect(await cacheSavedLocalMemo(scope, saved)).toBe(true);
    expect((await getLocalMemo(scope, memo.id))?.title).toBe("Saved from the phone");
    expect((await getLocalMemo(scope, memo.id))?.revision).toBe(1);
  });

  test("does not regress a newer saved row to an older server snapshot", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox", title: "Before editing" });
    const saved = { ...memo, title: "Saved on the phone", revision: 4, updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(await cacheSavedLocalMemo(scope, saved)).toBe(true);

    // A detail response that was already in flight can be older than the save.
    expect(await cacheSavedLocalMemo(scope, { ...memo, title: "Stale server", revision: 3 })).toBe(false);
    expect((await getLocalMemo(scope, memo.id))?.title).toBe("Saved on the phone");
    expect((await getLocalMemo(scope, memo.id))?.revision).toBe(4);
  });

  test("does not overwrite a mirror row with a newer queued local update", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "nb-inbox", title: "Queued locally" });
    await localDb.syncQueue.put({
      id: `memo.update:${memo.id}`,
      kind: "memo.update",
      scope,
      memoId: memo.id,
      status: "pending",
      payload: { memoId: memo.id, title: "Queued locally", contentMarkdown: "Queued locally", tags: [] },
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      claimId: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(await cacheSavedLocalMemo(scope, { ...memo, title: "Server snapshot", revision: 2 })).toBe(false);
    expect((await getLocalMemo(scope, memo.id))?.title).toBe("Queued locally");
  });

  test("caches templates inside the same local data scope", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await putLocalTemplate(scope, {
      id: "template-1",
      name: "Daily note",
      description: null,
      title: "Daily",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "# Daily",
      tags: ["journal"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await listLocalTemplates(scope)).templates[0]?.id).toBe("template-1");
  });

  test("derives tags from the local memo mirror", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await createLocalMemo(scope, { notebookId: "nb-inbox", tags: ["offline", "offline"] });
    expect((await listLocalTags(scope)).tags).toEqual([{ name: "offline", memoCount: 1, updatedAt: expect.any(String) }]);
  });

  test("applies batch mutations to the local mirror immediately", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const first = await createLocalMemo(scope, { notebookId: "inbox", tags: ["old"] });
    const second = await createLocalMemo(scope, { notebookId: "inbox" });
    expect(await applyLocalTagRename(scope, "old", "new")).toBe(1);
    expect(await applyLocalMemoMove(scope, [first.id, second.id], "archive")).toBe(2);
    expect(await applyLocalMemoPin(scope, [first.id], true)).toBe(1);
    expect((await getLocalMemo(scope, first.id))?.tags).toEqual(["new"]);
    expect((await getLocalMemo(scope, first.id))?.notebookId).toBe("archive");
    expect((await getLocalMemo(scope, first.id))?.isPinned).toBe(true);
  });

  test("applies a memo theme to the local mirror immediately", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const themed = await applyLocalMemoTheme(scope, memo.id, "letter");
    expect(themed?.theme).toBe("letter");
    expect((await getLocalMemo(scope, memo.id))?.theme).toBe("letter");
    expect((await applyLocalMemoTheme(scope, memo.id, null))?.theme).toBeNull();
  });

  test("deletes and empties trash locally without waiting for the API", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const activeMemo = await createLocalMemo(scope, { notebookId: "inbox", title: "Keep me" });
    const trashedMemo = await createLocalMemo(scope, { notebookId: "inbox", title: "Delete me" });
    expect(await applyLocalMemoDeleteBatch(scope, [trashedMemo.id])).toBe(1);
    expect((await getLocalMemo(scope, trashedMemo.id))?.isDeleted).toBe(true);
    expect(await applyLocalEmptyTrash(scope)).toBe(1);
    expect(await getLocalMemo(scope, trashedMemo.id)).toBeNull();
    expect(await applyLocalEmptyTrash(scope)).toBe(0);
    expect((await getLocalMemo(scope, activeMemo.id))?.title).toBe("Keep me");
  });

  test("treats empty batch selections as no-ops", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox", title: "Keep me", tags: ["old"] });

    expect(await applyLocalMemoMove(scope, [], "archive")).toBe(0);
    expect(await applyLocalMemoPin(scope, [], true)).toBe(0);
    expect(await applyLocalMemoDeleteBatch(scope, [])).toBe(0);
    expect(await applyLocalMemoDeleteBatch(scope, [], true)).toBe(0);
    expect(await applyLocalTagRename(scope, "missing", "new")).toBe(0);

    expect(await getLocalMemo(scope, memo.id)).toMatchObject({
      notebookId: "inbox",
      isPinned: false,
      isDeleted: false,
      tags: ["old"],
    });
  });

  test("updates and removes notebooks in the local mirror immediately", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await putLocalNotebook(scope, {
      id: "notebook-1",
      parentId: null,
      name: "Inbox",
      slug: "inbox",
      icon: null,
      color: null,
      sortOrder: 0,
      memoCount: 0,
      lastMemoUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await updateLocalNotebook(scope, "notebook-1", { name: "Archive" }))?.name).toBe("Archive");
    expect((await getLocalNotebook(scope, "notebook-1"))?.name).toBe("Archive");
    expect(await deleteLocalNotebook(scope, "notebook-1")).toBe(true);
    expect(await getLocalNotebook(scope, "notebook-1")).toBeNull();
  });

  test("merges memos locally and marks source notes as deleted", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const first = await createLocalMemo(scope, { notebookId: "inbox", title: "First", contentMarkdown: "one", tags: ["a"] });
    const second = await createLocalMemo(scope, { notebookId: "inbox", title: "Second", contentMarkdown: "two", tags: ["b"] });
    const merged = await mergeLocalMemos(scope, { memoIds: [first.id, second.id], title: "Merged" });
    expect(merged?.title).toBe("Merged");
    expect(merged?.contentMarkdown).toContain("one");
    expect(merged?.contentMarkdown).toContain("two");
    expect(merged?.contentMarkdown).toContain("edgeever:merge-divider");
    expect(merged?.contentJson?.content?.some((node) => node.type === "edgeeverMergeDivider")).toBe(true);
    expect(merged?.sourceMemoIds).toEqual([first.id, second.id]);
    expect((await getLocalMemo(scope, first.id))?.isDeleted).toBe(true);
    expect((await getLocalMemo(scope, second.id))?.mergedIntoMemoId).toBe(merged?.id);
  });

  test("uses a custom source title when the first merged memo is untitled", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const untitled = await createLocalMemo(scope, { notebookId: "inbox", title: "无标题笔记", contentMarkdown: "one" });
    const titled = await createLocalMemo(scope, { notebookId: "inbox", title: "手动设置的标题", contentMarkdown: "two" });

    const merged = await mergeLocalMemos(scope, { memoIds: [untitled.id, titled.id] });

    expect(merged?.title).toBe("手动设置的标题");
  });

  test("recovers rich content when source Markdown copies are empty", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const first = await createLocalMemo(scope, { notebookId: "inbox", title: "First" });
    const second = await createLocalMemo(scope, { notebookId: "inbox", title: "Second" });
    first.contentJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "第一篇真实正文" }] }] };
    first.contentText = "第一篇真实正文";
    second.contentJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "第二篇真实正文" }] }] };
    second.contentText = "第二篇真实正文";
    await putLocalMemo(scope, first);
    await putLocalMemo(scope, second);

    const merged = await mergeLocalMemos(scope, { memoIds: [first.id, second.id] });

    expect(merged?.contentMarkdown).toContain("第一篇真实正文");
    expect(merged?.contentMarkdown).toContain("第二篇真实正文");
    expect(merged?.contentText).toContain("第一篇真实正文");
    expect((await getLocalMemo(scope, first.id))?.isDeleted).toBe(true);
  });

  test("cancels a merge before deleting sources when cached content is inconsistent", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const unsafe = await createLocalMemo(scope, { notebookId: "inbox", title: "Unsafe" });
    const second = await createLocalMemo(scope, { notebookId: "inbox", title: "Second", contentMarkdown: "正常正文" });
    unsafe.contentText = "缓存声称这里有正文";
    await putLocalMemo(scope, unsafe);

    await expect(mergeLocalMemos(scope, { memoIds: [unsafe.id, second.id] }))
      .rejects.toThrow("Merge was cancelled");
    expect((await getLocalMemo(scope, unsafe.id))?.isDeleted).toBe(false);
    expect((await getLocalMemo(scope, second.id))?.isDeleted).toBe(false);
  });

  test("caches memo revisions by account scope", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    const memo = await createLocalMemo(scope, { notebookId: "inbox" });
    const revision = {
      id: "revision-local-1",
      memoId: memo.id,
      revision: 1,
      title: "Old title",
      tags: ["old"],
      contentMarkdown: "old body",
      contentText: "old body",
      contentHash: "hash",
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await putLocalMemoRevisions(scope, memo.id, [revision]);
    expect((await listLocalMemoRevisions(scope, memo.id)).revisions[0]?.id).toBe(revision.id);
    expect((await getLocalMemoRevision(scope, memo.id, revision.id))?.contentMarkdown).toBe("old body");

    const newer = { ...revision, id: "revision-local-2", revision: 2 };
    await putLocalMemoRevisions(scope, memo.id, [newer]);
    expect((await listLocalMemoRevisions(scope, memo.id)).revisions.map((item) => item.id)).toEqual([newer.id]);
    expect(await getLocalMemoRevision(scope, memo.id, revision.id)).toBeNull();
  });

  test("caches resource metadata without storing resource bytes", async () => {
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
    await putLocalResource(scope, {
      id: "resource-1",
      memoId: "memo-1",
      originalMemoId: null,
      kind: "attachment",
      mimeType: "text/plain",
      filename: "readme.txt",
      byteSize: 12,
      sha256: "hash",
      width: null,
      height: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      url: "/api/v1/resources/resource-1/blob",
      memoTitle: "Memo",
      memoExcerpt: "Excerpt",
      memoDeleted: false,
    });
    const result = await listLocalResources(scope);
    expect(result.resources[0]?.filename).toBe("readme.txt");
    expect(result.summary).toEqual({ totalCount: 1, totalBytes: 12, imageCount: 0, attachmentCount: 1 });
  });

  test("stages resource bytes for offline upload", async () => {
    const previousCaches = globalThis.caches;
    const entries = new Map();
    globalThis.caches = {
      open: async () => ({
        put: async (key, response) => entries.set(key, response),
        match: async (key) => entries.get(key) ?? undefined,
        delete: async (key) => entries.delete(key),
      }),
    };
    try {
      const scope = createLocalDataScope("https://demo.edgeever.org", "user-1");
      const resource = await createLocalResource(scope, "memo-1", new File(["offline bytes"], "offline.txt", { type: "text/plain" }));
      const cached = await getCachedLocalResourceBytes(resource.url);
      expect(resource.id).toStartWith("local_resource_");
      expect(await cached?.text()).toBe("offline bytes");
      expect((await listLocalResources(scope)).resources[0]?.url).toBe(resource.url);
      await replaceLocalResources(scope, []);
      expect((await listLocalResources(scope)).resources[0]?.id).toBe(resource.id);
    } finally {
      globalThis.caches = previousCaches;
    }
  });
});

describe("local mirror pull pause", () => {
  test("never contacts the server while pulling is paused", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-pull-paused");
    const original = { syncBootstrap: api.syncBootstrap, syncChanges: api.syncChanges };
    let calls = 0;
    api.syncBootstrap = async () => { calls += 1; throw new Error("must not pull"); };
    api.syncChanges = async () => { calls += 1; throw new Error("must not pull"); };
    setSyncPause("pull", true, scope);

    try {
      expect(await syncLocalMirror(scope)).toEqual({ bootstrapped: false, changed: 0 });
      expect(calls).toBe(0);
    } finally {
      api.syncBootstrap = original.syncBootstrap;
      api.syncChanges = original.syncChanges;
      setSyncPause("all", false, scope);
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });

  test("stops between bootstrap pages without committing a partial mirror", async () => {
    const previousOnline = globalThis.navigator?.onLine;
    if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    const scope = createLocalDataScope("https://demo.edgeever.org", "user-pull-paused-pages");
    const original = api.syncBootstrap;
    let calls = 0;
    api.syncBootstrap = async () => {
      calls += 1;
      setSyncPause("pull", true, scope);
      return {
        notebooks: [],
        memos: [],
        snapshotCursor: 1,
        syncIdentity: "paused-workspace",
        totalCount: 0,
        nextAfterId: "page-2",
      };
    };
    setSyncPause("pull", false, scope);

    try {
      expect(await syncLocalMirror(scope)).toEqual({ bootstrapped: false, changed: 0 });
      expect(calls).toBe(1);
      expect((await listLocalMemos(scope, {})).totalCount).toBe(0);
      expect(await localDb.syncMeta.get([scope, "cursor"])).toBeUndefined();
    } finally {
      api.syncBootstrap = original;
      setSyncPause("all", false, scope);
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: previousOnline });
    }
  });
});
