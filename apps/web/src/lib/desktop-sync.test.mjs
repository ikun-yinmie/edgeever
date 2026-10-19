import { describe, expect, test } from "bun:test";

const {
  classifyDesktopSyncFailure,
  createDesktopSyncIssueDetails,
  createDesktopSyncDiagnosticText,
  createDesktopSyncSummary,
  diffSharedSnapshots,
  isStagedResourceReferenced,
  hasDesktopSyncStateReset,
  mergeMemoIdMappings,
  mergeSyncedMemos,
  normalizeDesktopMemoPayload,
  orderBootstrapNotebooks,
  orderDesktopSyncChanges,
  resolveDesktopMemoSyncBase,
  resolveDesktopStaleMemoUpdate,
  desktopLocalRevisionWitnessesRemote,
  rewriteStagedResource,
  shouldAttemptDesktopRecoveryPull,
  shouldPullDesktopChanges,
  syncOutboxItem,
} = await import("./desktop-sync.ts");
const { ApiRequestError, api } = await import("./api.ts");

describe("desktop staged resource sync", () => {
  test("rewrites placeholders in memo JSON and markdown", () => {
    const rewrites = [{ memoId: "memo-1", placeholder: "edgeever-staged://stage-1", url: "/api/v1/resources/resource-1/blob" }];
    const value = {
      contentJson: { type: "doc", content: [{ type: "image", attrs: { src: "edgeever-staged://stage-1" } }] },
      contentMarkdown: "![photo](edgeever-staged://stage-1)",
    };

    expect(rewriteStagedResource(value, rewrites)).toEqual({
      contentJson: { type: "doc", content: [{ type: "image", attrs: { src: "/api/v1/resources/resource-1/blob" } }] },
      contentMarkdown: "![photo](/api/v1/resources/resource-1/blob)",
    });
  });

  test("never sends desktop-only PDF URLs to the cloud", () => {
    expect(normalizeDesktopMemoPayload({
      contentJson: {
        type: "doc",
        content: [{ type: "pdfAttachment", attrs: { url: "edgeever-resource://resource/res_pdf" } }],
      },
      contentMarkdown: "[Attachment: report.pdf](edgeever-resource://resource/res_pdf)",
    })).toMatchObject({
      contentJson: {
        content: [{ attrs: { url: "/api/v1/resources/res_pdf/blob" } }],
      },
      contentMarkdown: "[Attachment: report.pdf](/api/v1/resources/res_pdf/blob)",
    });
  });

  test("does not consume a staged image before a saved memo update references it", () => {
    const stagedId = "stage-1";

    expect(isStagedResourceReferenced([], stagedId)).toBe(false);
    expect(isStagedResourceReferenced([
      { contentJson: { type: "doc", content: [{ type: "image", attrs: { src: `edgeever-staged://${stagedId}` } }] } },
    ], stagedId)).toBe(true);
  });

  test("does not confuse one staged image id with a longer id that shares its prefix", () => {
    expect(isStagedResourceReferenced([
      { contentMarkdown: "![photo](edgeever-staged://stage-10)" },
    ], "stage-1")).toBe(false);
    expect(isStagedResourceReferenced([
      { contentMarkdown: "![photo](edgeever-staged://stage-1)" },
    ], "stage-1")).toBe(true);
  });

  test("retains a temporary id mapping when a later sync phase fails", () => {
    const retained = mergeMemoIdMappings(new Map(), new Map([["memo_local_1", "memo_remote_1"]]));

    expect(retained.get("memo_local_1")).toBe("memo_remote_1");
  });

  test("keeps the latest acknowledged memo base across sync phases", () => {
    const created = { id: "memo_remote_1", revision: 0 };
    const updated = { id: "memo_remote_1", revision: 1 };
    const retained = mergeSyncedMemos(
      new Map([[created.id, created]]),
      new Map([[updated.id, updated]]),
    );

    expect(retained.get("memo_remote_1")).toEqual(updated);
  });
});

describe("desktop bootstrap sync", () => {
  test("rebuilds when the server cursor rewinds or its identity changes", () => {
    const local = { cursor: 42, syncIdentity: "workspace-a" };
    expect(hasDesktopSyncStateReset(local, { serverCursor: 7, syncIdentity: "workspace-a" })).toBe(true);
    expect(hasDesktopSyncStateReset(local, { serverCursor: 42, syncIdentity: "workspace-b" })).toBe(true);
    expect(hasDesktopSyncStateReset(local, { serverCursor: 64, syncIdentity: "workspace-a" })).toBe(false);
  });

  test("orders parent notebooks before their children", () => {
    const child = { id: "child", parentId: "parent", name: "Child" };
    const parent = { id: "parent", parentId: null, name: "Parent" };
    const grandchild = { id: "grandchild", parentId: "child", name: "Grandchild" };

    expect(orderBootstrapNotebooks([grandchild, child, parent]).map((notebook) => notebook.id)).toEqual([
      "parent",
      "child",
      "grandchild",
    ]);
  });

  test("applies notebook upserts before memos in an incremental change page", () => {
    const memo = { entityType: "memo", entityId: "memo-1", operation: "upsert", notebook: null };
    const child = {
      entityType: "notebook",
      entityId: "child",
      operation: "upsert",
      notebook: { id: "child", parentId: "parent" },
    };
    const parent = {
      entityType: "notebook",
      entityId: "parent",
      operation: "upsert",
      notebook: { id: "parent", parentId: null },
    };
    const deleted = { entityType: "notebook", entityId: "gone", operation: "delete", notebook: null };

    expect(orderDesktopSyncChanges([memo, child, deleted, parent]).map((change) => change.entityId)).toEqual([
      "parent",
      "child",
      "gone",
      "memo-1",
    ]);
  });
});

describe("desktop memo sync base", () => {
  test("repairs a legacy local autosave revision that is ahead of the cloud", () => {
    expect(resolveDesktopMemoSyncBase(
      { revision: 3, contentHash: "cloud-3" },
      { expectedRevision: 9, expectedContentHash: "local-autosave-9" },
    )).toEqual({ expectedRevision: 3, expectedContentHash: "cloud-3" });
  });

  test("keeps a genuinely stale base so the server update remains protected", () => {
    expect(resolveDesktopMemoSyncBase(
      { revision: 9, contentHash: "cloud-9" },
      { expectedRevision: 3, expectedContentHash: "cloud-3" },
    )).toEqual({ expectedRevision: 3, expectedContentHash: "cloud-3" });
  });

  test("acks a lost save when the cloud already has the queued payload", () => {
    expect(resolveDesktopStaleMemoUpdate({
      current: { revision: 10, contentHash: "hash-a" },
      expected: { expectedRevision: 9, expectedContentHash: "hash-before" },
      payload: { title: "", tags: [], contentMarkdown: "一期验收通过。", contentJson: { type: "doc" } },
      remote: { title: "无标题笔记", tags: [], contentMarkdown: "一期验收通过。", contentHash: "hash-a", contentJson: { type: "doc" } },
      localRevisions: [],
    })).toBe("ack");
  });

  test("rebases a later local draft when a sidecar snapshot already contains the cloud body", () => {
    const remote = {
      title: "无标题笔记",
      tags: [],
      contentMarkdown: "一期验收通过。",
      contentHash: "hash-a",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    };

    expect(desktopLocalRevisionWitnessesRemote([
      {
        id: "revision_local_1",
        revision: 9,
        contentHash: "sidecar-a",
        contentMarkdown: "一期验收通过。",
        contentJson: remote.contentJson,
      },
    ], remote, 9)).toBe(true);

    expect(resolveDesktopStaleMemoUpdate({
      current: { revision: 10, contentHash: "hash-a" },
      expected: { expectedRevision: 9, expectedContentHash: "hash-before" },
      payload: { title: "", tags: [], contentMarkdown: "一期验收通过。然后继续写。", contentJson: { type: "doc" } },
      remote,
      localRevisions: [{
        id: "revision_local_1",
        revision: 9,
        contentHash: "sidecar-a",
        contentMarkdown: "一期验收通过。",
        contentJson: remote.contentJson,
      }],
    })).toBe("rebase");
  });

  test("does not treat an older local snapshot or a remote-cached revision as proof", () => {
    const remote = {
      title: "无标题笔记",
      tags: [],
      contentMarkdown: "别人改过的正文",
      contentHash: "hash-other",
      contentJson: { type: "doc" },
    };

    expect(desktopLocalRevisionWitnessesRemote([
      {
        id: "revision_local_old",
        revision: 3,
        contentHash: "hash-other",
        contentMarkdown: "别人改过的正文",
        contentJson: remote.contentJson,
      },
      {
        id: "rev_remote_cached",
        revision: 10,
        contentHash: "hash-other",
        contentMarkdown: "别人改过的正文",
        contentJson: remote.contentJson,
      },
    ], remote, 9)).toBe(false);

    expect(resolveDesktopStaleMemoUpdate({
      current: { revision: 10, contentHash: "hash-other" },
      expected: { expectedRevision: 9, expectedContentHash: "hash-before" },
      payload: { title: "", tags: [], contentMarkdown: "本地还在写的草稿", contentJson: { type: "doc" } },
      remote,
      localRevisions: [{
        id: "revision_local_9",
        revision: 9,
        contentHash: "sidecar-local",
        contentMarkdown: "本地还在写的草稿",
        contentJson: { type: "doc" },
      }],
    })).toBe("conflict");
  });
});

describe("desktop sync failure handling", () => {
  test("stops retrying a missing memo update and keeps transient failures retryable", () => {
    expect(classifyDesktopSyncFailure(
      { kind: "memo.update" },
      new ApiRequestError("Memo not found", 404, "not_found"),
    )).toEqual({ conflict: false, retryable: false, errorCode: "memo_not_found" });

    expect(classifyDesktopSyncFailure(
      { kind: "memo.update" },
      new ApiRequestError("Temporarily unavailable", 503),
    )).toEqual({ conflict: false, retryable: true, errorCode: "http_503" });
  });

  test("copies diagnostics without exposing entity ids or payload content", () => {
    const diagnostic = createDesktopSyncDiagnosticText([{
      id: 7,
      kind: "memo.update",
      entityId: "private-memo-id",
      payload: { contentMarkdown: "private note body" },
      attemptCount: 3,
      version: 1,
      status: "error",
      lastError: "Memo memo_private123 not found at https://private.example.test/api",
      lastErrorCode: "memo_not_found",
      retryable: false,
    }]);

    expect(diagnostic).toContain("memo_not_found");
    expect(diagnostic).toContain('"totalItemCount": 1');
    expect(diagnostic).not.toContain('"id": 7');
    expect(diagnostic).not.toContain("private-memo-id");
    expect(diagnostic).not.toContain("private note body");
    expect(diagnostic).not.toContain("memo_private123");
    expect(diagnostic).not.toContain("private.example.test");
  });

  test("keeps a global failure visible in both the summary and details", () => {
    const globalIssue = {
      phase: "pull_remote_changes",
      message: "Request failed at https://private.example.test/api/v1/sync/changes",
      errorCode: "http_500",
      occurredAt: "2026-09-05T00:00:00.000Z",
    };

    expect(createDesktopSyncSummary({ pending: 0, syncing: 0, conflict: 0, error: 0 }, globalIssue)).toEqual({
      total: 1,
      pending: 0,
      syncing: 0,
      conflict: 0,
      error: 1,
    });
    expect(createDesktopSyncIssueDetails([], globalIssue)).toEqual({ globalIssue, items: [] });
    expect(createDesktopSyncDiagnosticText([], globalIssue)).toContain("pull_remote_changes");
    expect(createDesktopSyncDiagnosticText([], globalIssue)).not.toContain("private.example.test");
  });

  test("bounds diagnostics for a prefilled GitHub Issue URL", () => {
    const items = Array.from({ length: 200 }, (_, id) => ({
      id,
      kind: "memo.update",
      entityId: `memo_private_${id}`,
      payload: { contentMarkdown: "private note body" },
      attemptCount: 99_999,
      version: 1,
      status: "error",
      lastError: "Temporary failure ".repeat(40),
      lastErrorCode: "network_error",
      retryable: true,
    }));
    const diagnostic = createDesktopSyncDiagnosticText(items);

    expect(diagnostic).toContain('"totalItemCount": 200');
    expect(diagnostic).toContain('"includedItemCount": 5');
    expect(encodeURIComponent(diagnostic).length).toBeLessThan(6_000);
  });

  test("allows remote pulls while durable errors are handled separately", () => {
    expect(shouldPullDesktopChanges({ pending: 0, syncing: 0, error: 1, conflict: 1 }, true)).toBe(true);
    expect(shouldPullDesktopChanges({ pending: 1, syncing: 0, error: 0, conflict: 0 }, true)).toBe(false);
    expect(shouldPullDesktopChanges({ pending: 0, syncing: 0, error: 0, conflict: 0 }, false)).toBe(false);
  });

  test("attempts a recovery pull only when no local upload can be overwritten", () => {
    expect(shouldAttemptDesktopRecoveryPull("sync_staged_resources", { pending: 0, syncing: 0 }, true)).toBe(true);
    expect(shouldAttemptDesktopRecoveryPull("sync_staged_resources", { pending: 1, syncing: 0 }, true)).toBe(false);
    expect(shouldAttemptDesktopRecoveryPull("sync_staged_resources", { pending: 0, syncing: 1 }, true)).toBe(false);
    expect(shouldAttemptDesktopRecoveryPull("pull_remote_changes", { pending: 0, syncing: 0 }, true)).toBe(false);
    expect(shouldAttemptDesktopRecoveryPull("finalize_resource_remap", { pending: 0, syncing: 0 }, true)).toBe(false);
    expect(shouldAttemptDesktopRecoveryPull("sync_staged_resources", { pending: 0, syncing: 0 }, false)).toBe(false);
  });
});

describe("desktop batch outbox sync", () => {
  const withSidecar = (body, acked = []) => async () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        sidecarRequest: async (method, params) => {
          if (method === "sync.outbox.ack") {
            acked.push(params);
            return {};
          }
          throw new Error(`Unexpected sidecar request: ${method}`);
        },
      },
    };
    try {
      await body();
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  };

  test("moves what it can when the batch carries a temporary id the server never saw", withSidecar(async () => {
    const originalMoveMemos = api.moveMemos;
    const calls = [];
    api.moveMemos = async (input) => {
      calls.push(input);
      if (input.memoIds.length > 1 || input.memoIds[0] === "memo_temp_2") {
        throw new ApiRequestError("One or more memos cannot be moved.", 400, "missing_memos");
      }
      return { ok: true, moved: input.memoIds.length };
    };

    try {
      const result = await syncOutboxItem({
        id: 9,
        kind: "memo.move",
        entityId: "memo_remote_1,memo_temp_2",
        payload: { memoIds: ["memo_remote_1", "memo_temp_2"], notebookId: "nb_target" },
        attemptCount: 0,
        version: 3,
      }, []);
      expect(result).toBeNull();
      expect(calls).toEqual([
        { memoIds: ["memo_remote_1", "memo_temp_2"], notebookId: "nb_target" },
        { memoIds: ["memo_remote_1"], notebookId: "nb_target" },
        { memoIds: ["memo_temp_2"], notebookId: "nb_target" },
      ]);
    } finally {
      api.moveMemos = originalMoveMemos;
    }
  }));

  test("keeps a move failure when the target notebook is missing", withSidecar(async () => {
    const originalMoveMemos = api.moveMemos;
    api.moveMemos = async () => {
      throw new ApiRequestError("Target notebook not found", 404, "not_found");
    };

    try {
      await expect(syncOutboxItem({
        id: 10,
        kind: "memo.move",
        entityId: "memo_remote_1",
        payload: { memoIds: ["memo_remote_1"], notebookId: "nb_missing" },
        attemptCount: 0,
        version: 1,
      }, [])).rejects.toThrow("Target notebook not found");
    } finally {
      api.moveMemos = originalMoveMemos;
    }
  }));

  test("pins the surviving memos when one target is already gone", withSidecar(async () => {
    const originalUpdateMemo = api.updateMemo;
    const pinned = [];
    api.updateMemo = async (memoId, patch) => {
      if (memoId === "memo_gone") {
        throw new ApiRequestError("Memo not found", 404, "not_found");
      }
      pinned.push({ memoId, isPinned: patch.isPinned });
      return { memo: { id: memoId } };
    };

    try {
      await syncOutboxItem({
        id: 11,
        kind: "memo.pinBatch",
        entityId: "memo_a,memo_gone",
        payload: { memoIds: ["memo_a", "memo_gone"], isPinned: true },
        attemptCount: 0,
        version: 1,
      }, []);
      expect(pinned).toEqual([{ memoId: "memo_a", isPinned: true }]);
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  }));

  test("still fails a pin batch on a transient error", withSidecar(async () => {
    const originalUpdateMemo = api.updateMemo;
    api.updateMemo = async () => {
      throw new ApiRequestError("Temporarily unavailable", 503);
    };

    try {
      await expect(syncOutboxItem({
        id: 12,
        kind: "memo.pinBatch",
        entityId: "memo_a",
        payload: { memoIds: ["memo_a"], isPinned: true },
        attemptCount: 0,
        version: 1,
      }, [])).rejects.toThrow("Temporarily unavailable");
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  }));

  test("pushes a memo theme and acknowledges with the remote snapshot", async () => {
    const originalUpdateMemo = api.updateMemo;
    const updates = [];
    const remoteMemo = { id: "memo_themed", theme: "letter" };
    api.updateMemo = async (memoId, patch) => {
      updates.push({ memoId, patch });
      return { memo: remoteMemo };
    };

    try {
      const acked = [];
      const previousWindow = globalThis.window;
      globalThis.window = {
        edgeeverDesktop: {
          isAvailable: true,
          sidecarRequest: async (method, params) => {
            if (method === "sync.outbox.ack") {
              acked.push(params);
              return {};
            }
            throw new Error(`Unexpected sidecar request: ${method}`);
          },
        },
      };
      try {
        await syncOutboxItem({
          id: 13,
          kind: "memo.setTheme",
          entityId: "memo_themed",
          payload: { memoId: "memo_themed", theme: "letter" },
          attemptCount: 0,
          version: 1,
        }, []);
      } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
      }
      expect(updates).toEqual([{ memoId: "memo_themed", patch: { theme: "letter" } }]);
      expect(acked).toEqual([{ id: 13, version: 1, remoteMemo }]);
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  });

  test("acknowledges a theme change for a note that is already gone", async () => {
    const originalUpdateMemo = api.updateMemo;
    api.updateMemo = async () => {
      throw new ApiRequestError("Memo not found", 404, "not_found");
    };

    try {
      const acked = [];
      const previousWindow = globalThis.window;
      globalThis.window = {
        edgeeverDesktop: {
          isAvailable: true,
          sidecarRequest: async (method, params) => {
            if (method === "sync.outbox.ack") {
              acked.push(params);
              return {};
            }
            throw new Error(`Unexpected sidecar request: ${method}`);
          },
        },
      };
      try {
        await syncOutboxItem({
          id: 14,
          kind: "memo.setTheme",
          entityId: "memo_gone",
          payload: { memoId: "memo_gone", theme: null },
          attemptCount: 0,
          version: 1,
        }, []);
      } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
      }
      expect(acked).toEqual([{ id: 14, version: 1, remoteMemo: undefined }]);
    } finally {
      api.updateMemo = originalUpdateMemo;
    }
  });
});

describe("shared snapshot sync diff", () => {
  const shared = [
    { id: "memo_same", updatedAt: "2026-02-01T00:00:00.000Z", groupId: "grp_1" },
    { id: "memo_new", updatedAt: "2026-02-01T00:00:00.000Z", groupId: "grp_1" },
    { id: "memo_changed", updatedAt: "2026-03-01T00:00:00.000Z", groupId: "grp_1" },
    { id: "memo_strict", updatedAt: "2026-02-01T00:00:00.000Z", groupId: "grp_2" },
  ];
  const mirrored = [
    { memoId: "memo_same", updatedAt: "2026-02-01T00:00:00.000Z" },
    { memoId: "memo_changed", updatedAt: "2026-02-01T00:00:00.000Z" },
    { memoId: "memo_strict", updatedAt: "2026-02-01T00:00:00.000Z" },
    { memoId: "memo_revoked", updatedAt: "2026-02-01T00:00:00.000Z" },
  ];

  test("refreshes new and changed snapshots and prunes revoked access", () => {
    expect(diffSharedSnapshots(shared, mirrored, new Set())).toEqual({
      refreshIds: ["memo_new", "memo_changed"],
      prune: true,
    });
  });

  test("refreshes strict-policy groups even when the memo revision is unchanged", () => {
    expect(diffSharedSnapshots(shared, mirrored, new Set(["grp_2"])).refreshIds).toContain("memo_strict");
    expect(diffSharedSnapshots(shared, mirrored, new Set()).refreshIds).not.toContain("memo_strict");
  });

  test("settles when everything matches and nothing was revoked", () => {
    expect(diffSharedSnapshots(
      [{ id: "memo_same", updatedAt: "2026-02-01T00:00:00.000Z", groupId: "grp_1" }],
      [{ memoId: "memo_same", updatedAt: "2026-02-01T00:00:00.000Z" }],
      new Set(),
    )).toEqual({ refreshIds: [], prune: false });
  });
});
