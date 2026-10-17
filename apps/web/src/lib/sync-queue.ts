import {
  createEmptySyncQueueSummary,
  createEmptySyncRunResult,
  getMemoSyncBaseConflictDetails,
  getSyncRetryAt,
  isMemoSyncBaseCurrent,
  summarizeSyncQueue,
  type MemoDetail,
  type MemoTemplate,
  type Notebook,
  type Resource,
  type SyncQueueSummary,
  type SyncRunResult,
  type TiptapDoc,
} from "@edgeever/shared";
import { liveQuery } from "dexie";
import { ApiRequestError, api } from "@/lib/api";
import {
  localDb,
  selectNewestLocalDraft,
  type MemoCreateSyncPayload,
  type MemoDeleteSyncPayload,
  type MemoRestoreSyncPayload,
  type LocalActionKind,
  type LocalActionPayload,
  type LocalDraft,
  type MemoUpdateSyncPayload,
  type SyncQueueItem,
} from "@/lib/local-db";
import { getMemoSaveConflictInfo, parseMemoSaveConflictDetails } from "@/lib/memo-save-conflict";
import { getCachedLocalResourceBytes, removeCachedLocalResourceBytes } from "@/lib/local-resource-cache";
import { isBrowserOffline } from "@/lib/network-status";
import { parseTagsText } from "@/lib/utils";
import { createClientUuid } from "@/lib/client-id";

export type { SyncQueueSummary, SyncRunResult } from "@edgeever/shared";
export type SyncQueueResult = MemoDetail | Notebook | MemoTemplate | Resource | null;
export type MemoUpdateAcknowledgement = "completed" | "rebased" | "stale";

export const emptySyncQueueSummary = createEmptySyncQueueSummary;

export const getMemoUpdateQueueId = (memoId: string) => `memo.update:${memoId}`;
export const getMemoCreateQueueId = (temporaryId: string) => `memo.create:${temporaryId}`;
export const getMemoDeleteQueueId = (memoId: string) => `memo.delete:${memoId}`;
export const getMemoRestoreQueueId = (memoId: string) => `memo.restore:${memoId}`;

export const getLocalActionQueueId = (scope: string, kind: LocalActionKind, entityId: string) => `action:${scope}:${kind}:${entityId}`;

export const queueLocalAction = async (scope: string, kind: LocalActionKind, entityId: string, payload: LocalActionPayload, memoId = entityId) => {
  const id = getLocalActionQueueId(scope, kind, entityId);
  const now = new Date().toISOString();
  await localDb.syncQueue.put({
    id,
    kind,
    scope,
    memoId,
    status: "pending",
    payload,
    attemptCount: 0,
    lastError: null,
    lastErrorCode: null,
    lastErrorDetails: null,
    nextAttemptAt: null,
    claimId: null,
    createdAt: now,
    updatedAt: now,
  });
};

export const putMemoUpdateQueueItem = async (payload: MemoUpdateSyncPayload, scope?: string) => {
  const id = getMemoUpdateQueueId(payload.memoId);
  const now = new Date().toISOString();
  const existing = await localDb.syncQueue.get(id);
  const existingPayload = existing?.kind === "memo.update"
    ? existing.payload as MemoUpdateSyncPayload
    : null;
  // A previous in-flight save may already have advanced this queue row to a
  // newer acknowledged server base. A local autosave that started just
  // before that acknowledgement must not move the successor back again.
  const nextPayload = existingPayload && existingPayload.expectedRevision > payload.expectedRevision
    ? {
        ...payload,
        expectedRevision: existingPayload.expectedRevision,
        expectedContentHash: existingPayload.expectedContentHash,
      }
    : payload;

  await localDb.syncQueue.put({
    id,
    kind: "memo.update",
    scope: scope ?? existing?.scope,
    memoId: payload.memoId,
    status: "pending",
    payload: nextPayload,
    attemptCount: existing?.attemptCount ?? 0,
    lastError: null,
    lastErrorCode: null,
    lastErrorDetails: null,
    nextAttemptAt: null,
    claimId: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
};

export const queueMemoUpdate = async (payload: MemoUpdateSyncPayload, scope?: string) =>
  localDb.transaction("rw", localDb.syncQueue, () => putMemoUpdateQueueItem(payload, scope));

export const queueMemoCreate = async (scope: string, payload: MemoCreateSyncPayload) => {
  const id = getMemoCreateQueueId(payload.temporaryId);
  const now = new Date().toISOString();
  await localDb.syncQueue.put({
    id,
    kind: "memo.create",
    scope,
    memoId: payload.temporaryId,
    status: "pending",
    payload,
    attemptCount: 0,
    lastError: null,
    nextAttemptAt: null,
    claimId: null,
    createdAt: now,
    updatedAt: now,
  });
};

/**
 * A note whose create request is still queued (and never handed to the network)
 * does not exist on the server, so it can be canceled locally: otherwise the
 * create retry could resurrect a note the user already deleted. Returns true
 * when a queued create was canceled, meaning no server delete is needed.
 */
const cancelUnsyncedMemoCreate = async (scope: string, memoId: string) => {
  const createId = getMemoCreateQueueId(memoId);
  return localDb.transaction("rw", [localDb.syncQueue, localDb.drafts], async () => {
    const create = await localDb.syncQueue.get(createId);
    if (
      !create ||
      create.kind !== "memo.create" ||
      create.scope !== scope ||
      create.status !== "pending" ||
      create.attemptCount > 0
    ) {
      return false;
    }
    await localDb.syncQueue.delete(createId);
    await localDb.drafts.delete(memoId);
    // Queued edits and restores reference an id the server never saw; drop
    // them so they cannot surface as unresolvable missing-memo conflicts.
    const dependents = (await localDb.syncQueue.toArray()).filter(
      (item) => item.memoId === memoId
        && (item.scope === scope || !item.scope)
        && (item.kind === "memo.update" || item.kind === "memo.restore")
        && item.status !== "syncing",
    );
    for (const item of dependents) {
      await localDb.syncQueue.delete(item.id);
    }
    return true;
  });
};

export const cancelUnsyncedMemoCreates = async (scope: string, memoIds: string[]) => {
  const canceled = new Set<string>();
  for (const memoId of memoIds) {
    if (await cancelUnsyncedMemoCreate(scope, memoId)) {
      canceled.add(memoId);
    }
  }
  return canceled;
};

export const hasQueuedMemoCreate = async (scope: string, memoId: string) => {
  const create = await localDb.syncQueue.get(getMemoCreateQueueId(memoId));
  return Boolean(create && create.kind === "memo.create" && (create.scope === scope || !create.scope));
};

export const queueMemoDelete = async (scope: string, payload: MemoDeleteSyncPayload) => {
  if (await cancelUnsyncedMemoCreate(scope, payload.memoId)) {
    return;
  }
  const id = getMemoDeleteQueueId(payload.memoId);
  const now = new Date().toISOString();
  await localDb.syncQueue.put({
    id,
    kind: "memo.delete",
    scope,
    memoId: payload.memoId,
    status: "pending",
    payload,
    attemptCount: 0,
    lastError: null,
    nextAttemptAt: null,
    claimId: null,
    createdAt: now,
    updatedAt: now,
  });
};

export const queueMemoRestore = async (scope: string, payload: MemoRestoreSyncPayload) => {
  const id = getMemoRestoreQueueId(payload.memoId);
  const now = new Date().toISOString();
  await localDb.syncQueue.put({
    id,
    kind: "memo.restore",
    scope,
    memoId: payload.memoId,
    status: "pending",
    payload,
    attemptCount: 0,
    lastError: null,
    nextAttemptAt: null,
    claimId: null,
    createdAt: now,
    updatedAt: now,
  });
};

const remapQueuedMemoId = async (scope: string, temporaryId: string, remoteMemo: MemoDetail) => {
  const remoteId = remoteMemo.id;
  const remappedIds: string[] = [];
  const items = (await localDb.syncQueue.toArray()).filter(
    (item) => item.scope === scope && item.memoId === temporaryId && item.kind !== "memo.create"
  );
  await localDb.transaction("rw", [localDb.syncQueue, localDb.drafts], async () => {
    for (const item of items) {
      const payload = { ...item.payload } as Record<string, unknown>;
      if ("memoId" in payload) payload.memoId = remoteId;
      if (item.kind === "memo.update") {
        payload.expectedRevision = remoteMemo.revision;
        payload.expectedContentHash = remoteMemo.contentHash;
      }
      const nextId = item.kind === "memo.update"
        ? getMemoUpdateQueueId(remoteId)
        : item.kind === "memo.delete"
          ? getMemoDeleteQueueId(remoteId)
          : item.kind === "memo.restore"
            ? getMemoRestoreQueueId(remoteId)
            : item.id;
      if (nextId !== item.id) await localDb.syncQueue.delete(item.id);
      await localDb.syncQueue.put({
        ...item,
        id: nextId,
        memoId: remoteId,
        payload: payload as SyncQueueItem["payload"],
      });
      remappedIds.push(nextId);
    }

    const temporaryDraft = await localDb.drafts.get(temporaryId);
    if (temporaryDraft) {
      const remoteDraft = await localDb.drafts.get(remoteId);
      const newestDraft = selectNewestLocalDraft(temporaryDraft, remoteDraft);
      if (newestDraft) {
        const remappedDraft = { ...newestDraft, memoId: remoteId };
        await localDb.drafts.put(remappedDraft);

        const queuedUpdate = await localDb.syncQueue.get(getMemoUpdateQueueId(remoteId));
        const draftIsCovered = queuedUpdate
          ? isDraftCoveredByMemoUpdate(queuedUpdate, remappedDraft)
          : false;
        const draftMatchesCreatedMemo =
          remappedDraft.title.trim() === (remoteMemo.title ?? "") &&
          JSON.stringify(parseTagsText(remappedDraft.tagsText)) === JSON.stringify(remoteMemo.tags) &&
          JSON.stringify(remappedDraft.contentJson) === JSON.stringify(remoteMemo.contentJson);

        // Editor autosave can persist a draft while memo.create is already in
        // flight, before the temporary memo has a server revision that can be
        // queued as memo.update. Preserve that edit as the successor request.
        if (!draftIsCovered && !draftMatchesCreatedMemo) {
          const now = new Date().toISOString();
          await localDb.syncQueue.put({
            id: getMemoUpdateQueueId(remoteId),
            kind: "memo.update",
            scope,
            memoId: remoteId,
            status: "pending",
            payload: {
              memoId: remoteId,
              expectedRevision: remoteMemo.revision,
              expectedContentHash: remoteMemo.contentHash,
              editSessionId: `create-remap:${remoteId}`,
              title: remappedDraft.title,
              contentJson: remappedDraft.contentJson,
              tags: parseTagsText(remappedDraft.tagsText),
            },
            attemptCount: queuedUpdate?.attemptCount ?? 0,
            lastError: null,
            lastErrorCode: null,
            lastErrorDetails: null,
            nextAttemptAt: null,
            claimId: null,
            createdAt: queuedUpdate?.createdAt ?? now,
            updatedAt: now,
          });
        }
      }
      await localDb.drafts.delete(temporaryId);
    }
  });
  return remappedIds;
};

export const observeSyncQueue = (onChange: (summary: SyncQueueSummary) => void) => {
  const subscription = liveQuery(async () => summarizeSyncQueue(await localDb.syncQueue.toArray())).subscribe({
    next: onChange,
    error: () => onChange(emptySyncQueueSummary()),
  });

  return () => subscription.unsubscribe();
};

/**
 * Only scheduled retries should keep the background sync loop awake. Terminal
 * failures (permanent 4xx) and conflicts stay visible in the queue summary but
 * must not spin the 15s retry cycle forever.
 */
export const isRetryableSyncQueueError = (error: unknown) => {
  if (error instanceof ApiRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
};

export const observeRetryableSyncErrors = (scope: string, onChange: (count: number) => void) => {
  const subscription = liveQuery(async () => {
    const items = await localDb.syncQueue.where("status").equals("error").toArray();
    return items.filter((item) =>
      (item.scope === scope || (!item.scope && item.kind === "memo.update" && Boolean(item.lastError)))
      && item.nextAttemptAt !== null
    ).length;
  }).subscribe({
    next: onChange,
    error: () => onChange(0),
  });

  return () => subscription.unsubscribe();
};

export const discardWebConflicts = async (scope: string) => {
  const conflicts: SyncQueueItem[] = [];
  for (const item of await localDb.syncQueue.where("status").equals("conflict").toArray()) {
    if (item.scope === scope) {
      conflicts.push(item);
      continue;
    }
    if (!item.scope && item.kind === "memo.update" && await localDb.memos.get([scope, item.memoId])) {
      conflicts.push(item);
    }
  }
  let discarded = 0;
  const { putLocalMemo } = await import("@/lib/local-mirror");
  for (const item of conflicts) {
    try {
      if (item.kind === "memo.update") {
        const remote = await api.getMemo(item.memoId, { includeDeleted: true });
        await putLocalMemo(scope, remote.memo);
        await localDb.drafts.delete(item.memoId);
      }
      await localDb.syncQueue.delete(item.id);
      discarded += 1;
    } catch {
      // Keep the conflict durable when the authoritative remote snapshot is
      // unavailable; the user can retry after the connection recovers.
    }
  }
  return discarded;
};

/**
 * Discard a single note's local conflict/draft and replace the local mirror
 * with the authoritative cloud memo so the editor can rehydrate cleanly.
 */
export const discardWebMemoConflict = async (scope: string, memoId: string) => {
  const remote = await api.getMemo(memoId, { includeDeleted: true });
  const { putLocalMemo } = await import("@/lib/local-mirror");
  await putLocalMemo(scope, remote.memo);
  await localDb.drafts.delete(memoId);

  const queueId = getMemoUpdateQueueId(memoId);
  const queued = await localDb.syncQueue.get(queueId);
  if (queued) {
    await localDb.syncQueue.delete(queueId);
  }

  // Older clients could leave unscoped conflict rows; clear any leftover
  // conflict update for this memo under the current scope as well.
  for (const item of await localDb.syncQueue.where("status").equals("conflict").toArray()) {
    if (item.memoId !== memoId) continue;
    if (item.scope && item.scope !== scope) continue;
    if (item.id === queueId) continue;
    await localDb.syncQueue.delete(item.id);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("edgeever:sync-queue-changed"));
  }
  return remote.memo;
};

export const isMemoUpdateAlreadyApplied = (memo: MemoDetail, item: SyncQueueItem) => {
  if (item.kind !== "memo.update") {
    return false;
  }
  const payload = item.payload as MemoUpdateSyncPayload;
  // A local mirror can project a draft over the memo returned by memo.create
  // while retaining that response's server base. Matching visible content is
  // not an acknowledgement until the revision or hash has advanced.
  if (
    memo.revision === payload.expectedRevision &&
    memo.contentHash === payload.expectedContentHash
  ) {
    return false;
  }
  if (memo.id !== item.memoId || memo.title !== payload.title) {
    return false;
  }

  const remoteTags = [...memo.tags].sort((left, right) => left.localeCompare(right));
  const queuedTags = [...payload.tags].sort((left, right) => left.localeCompare(right));
  return JSON.stringify(remoteTags) === JSON.stringify(queuedTags) &&
    JSON.stringify(memo.contentJson) === JSON.stringify(payload.contentJson);
};

let activeSyncPromise: Promise<SyncRunResult> | null = null;

export const syncQueuedChanges = (options: {
  scope?: string;
  onMemoAcknowledged?: (memo: MemoDetail, item: SyncQueueItem, acknowledgement: MemoUpdateAcknowledgement) => void | Promise<void>;
  onSynced?: (memo: MemoDetail, item: SyncQueueItem) => void | Promise<void>;
  onActionSynced?: (result: SyncQueueResult, item: SyncQueueItem) => void | Promise<void>;
} = {}): Promise<SyncRunResult> => {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = runQueuedChanges(options).finally(() => {
    activeSyncPromise = null;
  });

  return activeSyncPromise;
};

const runQueuedChanges = async (options: {
  scope?: string;
  onMemoAcknowledged?: (memo: MemoDetail, item: SyncQueueItem, acknowledgement: MemoUpdateAcknowledgement) => void | Promise<void>;
  onSynced?: (memo: MemoDetail, item: SyncQueueItem) => void | Promise<void>;
  onActionSynced?: (result: SyncQueueResult, item: SyncQueueItem) => void | Promise<void>;
}): Promise<SyncRunResult> => {
  const result = createEmptySyncRunResult();

  if (isBrowserOffline()) {
    return result;
  }

  const now = new Date();
  const allQueued = await localDb.syncQueue.toArray();
  const queued = allQueued.filter((item) => item.status === "pending" || item.status === "error");
  // Terminal failures leave `nextAttemptAt` empty so they stop retrying in the
  // background; only fresh items and scheduled retries run here.
  const candidates = queued
    .filter((item) => item.status === "pending" || (item.nextAttemptAt !== null && new Date(item.nextAttemptAt) <= now))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  // Includes in-flight creates: their dependent deletes must wait for the
  // acknowledgement that remaps the temporary id, never race ahead of it.
  const openCreateIds = new Set(
    allQueued.filter((item) => item.kind === "memo.create").map((item) => item.memoId)
  );
  const items: SyncQueueItem[] = [];
  for (const candidate of candidates) {
    let ready: SyncQueueItem;
    if (!options.scope || candidate.scope === options.scope) {
      ready = candidate;
    } else if (!candidate.scope && candidate.kind === "memo.update") {
      // Older releases did not persist a scope for editor retry items. Adopt one
      // only when the current account already owns the memo in its local mirror;
      // otherwise leave the item untouched instead of risking cross-account sync.
      const localMemo = await localDb.memos.get([options.scope, candidate.memoId]);
      if (!localMemo) continue;
      await localDb.syncQueue.update(candidate.id, { scope: options.scope, updatedAt: new Date().toISOString() });
      ready = { ...candidate, scope: options.scope };
    } else {
      continue;
    }

    // A delete/update/restore must wait for the note's own create to reach the
    // server. Otherwise the server acks the delete for an unknown temporary id
    // and the later create retry resurrects the note.
    if (
      ready.kind !== "memo.create" &&
      openCreateIds.has(ready.memoId) &&
      (ready.kind === "memo.delete" || ready.kind === "memo.update" || ready.kind === "memo.restore")
    ) {
      continue;
    }

    items.push(ready);
  }

  for (let index = 0; index < items.length; index += 1) {
    const candidate = items[index];
    const item = await claimQueueItem(candidate.id);
    if (!item) {
      continue;
    }

    result.attempted += 1;

    try {
      const memo = await syncQueueItem(item);
      if (item.kind === "memo.create" && memo && item.scope) {
        const remappedIds = await remapQueuedMemoId(item.scope, item.memoId, memo as MemoDetail);
        // Dependent delete/update/restore items were renamed to the durable id;
        // run them in this pass instead of waiting for the next queue tick.
        if (remappedIds.length > 0) {
          const remappedItems = await localDb.syncQueue.bulkGet(remappedIds);
          for (const remapped of remappedItems) {
            if (!remapped || items.some((queuedItem) => queuedItem.id === remapped.id)) continue;
            if (remapped.status === "pending" || remapped.status === "error") {
              items.push(remapped);
            }
          }
        }
      }
      const acknowledgement = await acknowledgeClaimedQueueItem(item, memo);
      if (memo && item.kind === "memo.update" && acknowledgement !== "stale") {
        await options.onMemoAcknowledged?.(memo as MemoDetail, item, acknowledgement);
      }
      if (acknowledgement === "completed") {
        if (memo && (item.kind === "memo.create" || item.kind === "memo.update" || item.kind === "memo.restore" || item.kind === "memo.delete")) {
          await options.onSynced?.(memo as MemoDetail, item);
        }
        if (item.kind !== "memo.create" && item.kind !== "memo.update" && item.kind !== "memo.restore" && item.kind !== "memo.delete") {
          await options.onActionSynced?.(memo, item);
        }
      }
      if (acknowledgement !== "stale") {
        result.synced += 1;
      }
    } catch (error) {
      const conflictInfo = getMemoSaveConflictInfo(error);
      // The memo was deleted (or permanently removed) elsewhere; saving it can
      // never succeed, so surface a resolvable conflict instead of retrying.
      const missingRemoteMemo = item.kind === "memo.update"
        && error instanceof ApiRequestError
        && error.status === 404;
      const status = conflictInfo || missingRemoteMemo ? "conflict" : "error";
      const attemptCount = item.attemptCount + 1;
      const errorDetails = parseMemoSaveConflictDetails(
        error instanceof ApiRequestError ? error.details : null,
      );
      const retryable = status === "error" && isRetryableSyncQueueError(error);

      const updated = await updateClaimedQueueItem(item, {
        status,
        attemptCount,
        lastError: getErrorMessage(error),
        lastErrorCode: conflictInfo?.code
          ?? (missingRemoteMemo
            ? "memo_not_found"
            : error instanceof ApiRequestError
              ? error.code ?? null
              : null),
        lastErrorDetails: errorDetails ? { ...errorDetails } : null,
        nextAttemptAt: retryable ? getSyncRetryAt(attemptCount) : null,
        claimId: null,
        updatedAt: new Date().toISOString(),
      });

      if (!updated) {
        continue;
      } else if (status === "conflict") {
        result.conflicted += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
};

const claimQueueItem = (id: string) =>
  localDb.transaction("rw", localDb.syncQueue, async () => {
    const item = await localDb.syncQueue.get(id);
    if (!item || (item.status !== "pending" && item.status !== "error")) {
      return null;
    }

    const claimId = createClientUuid();
    const claimedItem: SyncQueueItem = {
      ...item,
      status: "syncing",
      claimId,
      updatedAt: new Date().toISOString(),
    };
    await localDb.syncQueue.put(claimedItem);
    return claimedItem;
  });

const isDraftCoveredByMemoUpdate = (item: SyncQueueItem, draft: LocalDraft | undefined) => {
  if (item.kind !== "memo.update" || !draft) return false;
  const payload = item.payload as MemoUpdateSyncPayload;
  return draft.title === payload.title &&
    JSON.stringify(parseTagsText(draft.tagsText)) === JSON.stringify(payload.tags) &&
    JSON.stringify(draft.contentJson) === JSON.stringify(payload.contentJson);
};

const acknowledgeClaimedQueueItem = (item: SyncQueueItem, result: SyncQueueResult): Promise<MemoUpdateAcknowledgement> =>
  localDb.transaction("rw", [localDb.syncQueue, localDb.drafts, localDb.memos], async () => {
    const current = await localDb.syncQueue.get(item.id);
    const memo = result && item.kind === "memo.update" && "contentHash" in result
      ? result as MemoDetail
      : null;

    if (current?.claimId === item.claimId && current.status === "syncing") {
      await localDb.syncQueue.delete(item.id);
      if (item.kind !== "memo.create") {
        const draft = await localDb.drafts.get(item.memoId);
        if (!draft || item.kind !== "memo.update" || isDraftCoveredByMemoUpdate(item, draft)) {
          await localDb.drafts.delete(item.memoId);
        }
      }
      if (memo && item.scope) {
        const stored = await localDb.memos.get([item.scope, item.memoId]);
        if (stored && memo.revision > stored.revision) {
          await localDb.memos.put({ ...stored, revision: memo.revision, contentHash: memo.contentHash });
        }
      }
      return "completed";
    }

    if (
      !memo ||
      !current ||
      current.kind !== "memo.update" ||
      current.memoId !== item.memoId ||
      current.claimId ||
      (current.status !== "pending" && current.status !== "error")
    ) {
      return "stale";
    }

    const claimedPayload = item.payload as MemoUpdateSyncPayload;
    const successorPayload = current.payload as MemoUpdateSyncPayload;
    const successorUsesClaimedBase = successorPayload.expectedRevision === claimedPayload.expectedRevision &&
      successorPayload.expectedContentHash === claimedPayload.expectedContentHash;
    const successorAlreadyRebased = successorPayload.expectedRevision === memo.revision &&
      successorPayload.expectedContentHash === memo.contentHash;

    if (!successorUsesClaimedBase && !successorAlreadyRebased) {
      return "stale";
    }

    if (successorUsesClaimedBase) {
      await localDb.syncQueue.put({
        ...current,
        payload: {
          ...successorPayload,
          expectedRevision: memo.revision,
          expectedContentHash: memo.contentHash,
        },
        updatedAt: new Date().toISOString(),
      });
    }

    if (item.scope) {
      const stored = await localDb.memos.get([item.scope, item.memoId]);
      if (stored && memo.revision > stored.revision) {
        await localDb.memos.put({ ...stored, revision: memo.revision, contentHash: memo.contentHash });
      }
    }
    return "rebased";
  });

const updateClaimedQueueItem = (item: SyncQueueItem, patch: Partial<SyncQueueItem>) =>
  localDb.transaction("rw", localDb.syncQueue, async () => {
    const current = await localDb.syncQueue.get(item.id);
    if (!current || current.claimId !== item.claimId || current.status !== "syncing") {
      return false;
    }

    await localDb.syncQueue.update(item.id, patch);
    return true;
  });

export const shouldQueueMemoSaveError = (error: unknown) => {
  if (isBrowserOffline()) {
    return true;
  }

  if (error instanceof ApiRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  return error instanceof TypeError;
};

const rewriteResourceValue = (value: unknown, placeholder: string, url: string): unknown => {
  if (typeof value === "string") return value.split(placeholder).join(url);
  if (Array.isArray(value)) return value.map((item) => rewriteResourceValue(item, placeholder, url));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteResourceValue(child, placeholder, url)]));
  }
  return value;
};

const syncLocalResource = async (item: SyncQueueItem) => {
  const payload = item.payload as LocalActionPayload;
  const memoId = String(payload.memoId ?? item.memoId);
  const placeholder = String(payload.url ?? "");
  const blob = placeholder ? await getCachedLocalResourceBytes(placeholder) : null;
  if (!blob) throw new Error("Offline resource bytes are unavailable");

  const file = new File([blob], String(payload.filename ?? "attachment"), { type: String(payload.mimeType ?? blob.type ?? "application/octet-stream") });
  const result = await api.uploadMemoResource(memoId, file);
  const remoteUrl = result.resource.url;
  const { getLocalMemo, putLocalMemo, replaceLocalResource } = await import("@/lib/local-mirror");
  const localResource = String(payload.resourceId ?? "");

  const localMemo = await getLocalMemo(item.scope ?? "", memoId);
  if (localMemo) {
    const contentJson = rewriteResourceValue(localMemo.contentJson, placeholder, remoteUrl);
    const contentMarkdown = rewriteResourceValue(localMemo.contentMarkdown, placeholder, remoteUrl);
    if (JSON.stringify(contentJson) !== JSON.stringify(localMemo.contentJson) || contentMarkdown !== localMemo.contentMarkdown) {
      await putLocalMemo(item.scope ?? "", {
        ...localMemo,
        contentJson: contentJson as MemoDetail["contentJson"],
        contentMarkdown: typeof contentMarkdown === "string" ? contentMarkdown : localMemo.contentMarkdown,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const queuedItems = (await localDb.syncQueue.toArray()).filter((candidate) => candidate.scope === item.scope);
  for (const queued of queuedItems) {
    const payloadValue = rewriteResourceValue(queued.payload, placeholder, remoteUrl);
    if (JSON.stringify(payloadValue) !== JSON.stringify(queued.payload)) {
      await localDb.syncQueue.update(queued.id, { payload: payloadValue as SyncQueueItem["payload"], updatedAt: new Date().toISOString() });
    }
  }

  const remote = await api.getMemo(memoId, { includeDeleted: true });
  const contentJson = rewriteResourceValue(remote.memo.contentJson, placeholder, remoteUrl) as MemoDetail["contentJson"];
  const contentMarkdown = rewriteResourceValue(remote.memo.contentMarkdown, placeholder, remoteUrl);
  if (JSON.stringify(contentJson) !== JSON.stringify(remote.memo.contentJson) || contentMarkdown !== remote.memo.contentMarkdown) {
    const session = (await api.createMemoEditSession(memoId)).editSession;
    const patched = await api.updateMemo(memoId, {
      expectedRevision: session.baseRevision,
      expectedContentHash: session.baseContentHash,
      editSessionId: session.id,
      title: remote.memo.title ?? "",
      contentJson,
      contentMarkdown: typeof contentMarkdown === "string" ? contentMarkdown : undefined,
      tags: remote.memo.tags,
    });
    await putLocalMemo(item.scope ?? "", patched.memo);
  }
  await replaceLocalResource(item.scope ?? "", localResource, {
    ...result.resource,
    memoTitle: null,
    memoExcerpt: null,
    memoDeleted: false,
  });
  await removeCachedLocalResourceBytes(placeholder);
  return result.resource;
};

const syncQueueItem = async (item: SyncQueueItem): Promise<SyncQueueResult> => {
  if (item.kind === "memo.create") {
    const payload = item.payload as MemoCreateSyncPayload;
    const data = await api.createMemo({
      notebookId: payload.notebookId,
      title: payload.title,
      contentJson: payload.contentJson,
      contentMarkdown: payload.contentMarkdown,
      tags: payload.tags,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    });
    return data.memo;
  }

  if (item.kind === "memo.delete") {
    const payload = item.payload as MemoDeleteSyncPayload;
    try {
      await api.deleteMemo(payload.memoId, { permanent: payload.permanent });
    } catch (error) {
      // The note is already gone (deleted on another device, or its create
      // never reached the server). Permanent delete is idempotent here.
      if (payload.permanent && error instanceof ApiRequestError && error.status === 404) {
        return null;
      }
      throw error;
    }
    return null;
  }

  if (item.kind === "memo.restore") {
    const payload = item.payload as MemoRestoreSyncPayload;
    const data = await api.restoreMemo(payload.memoId);
    return data.memo;
  }

  if (item.kind === "tag.rename") {
    const payload = item.payload as LocalActionPayload;
    await api.renameTag(String(payload.tag ?? item.memoId), String(payload.name ?? ""));
    return null;
  }
  if (item.kind === "tag.delete") {
    const payload = item.payload as LocalActionPayload;
    await api.deleteTag(String(payload.tag ?? item.memoId));
    return null;
  }
  if (item.kind === "memo.moveBatch") {
    const payload = item.payload as LocalActionPayload;
    await api.moveMemos({ memoIds: Array.isArray(payload.memoIds) ? payload.memoIds.filter((value): value is string => typeof value === "string") : [], notebookId: String(payload.notebookId ?? "") });
    return null;
  }
  if (item.kind === "memo.deleteBatch") {
    const payload = item.payload as LocalActionPayload;
    const memoIds = Array.isArray(payload.memoIds) ? payload.memoIds.filter((value): value is string => typeof value === "string") : [];
    const permanent = Boolean(payload.permanent);
    try {
      await api.deleteMemos({ memoIds, permanent });
    } catch (error) {
      // The server rejects a permanent batch when some ids are already gone
      // (e.g. a note created and deleted before its create was acknowledged).
      // Fall back to per-id deletes so the rest of the batch still empties.
      if (!permanent || !(error instanceof ApiRequestError) || error.status !== 400 || error.code !== "missing_memos") {
        throw error;
      }
      for (const memoId of memoIds) {
        try {
          await api.deleteMemo(memoId, { permanent: true });
        } catch (nested) {
          if (!(nested instanceof ApiRequestError) || nested.status !== 404) {
            throw nested;
          }
        }
      }
    }
    return null;
  }
  if (item.kind === "memo.emptyTrash") {
    await api.emptyTrash();
    return null;
  }
  if (item.kind === "memo.pinBatch") {
    const payload = item.payload as LocalActionPayload;
    const memoIds = Array.isArray(payload.memoIds) ? payload.memoIds.filter((value): value is string => typeof value === "string") : [];
    await Promise.all(memoIds.map((memoId) => api.updateMemo(memoId, { isPinned: Boolean(payload.isPinned) })));
    return null;
  }
  if (item.kind === "memo.merge") {
    const payload = item.payload as LocalActionPayload;
    const result = await api.mergeMemos({
      memoIds: Array.isArray(payload.memoIds) ? payload.memoIds.filter((value): value is string => typeof value === "string") : [],
      notebookId: typeof payload.notebookId === "string" ? payload.notebookId : undefined,
      title: typeof payload.title === "string" ? payload.title : undefined,
    });
    return result.memo;
  }
  if (item.kind === "notebook.update") {
    const payload = item.payload as LocalActionPayload;
    const result = await api.updateNotebook(String(payload.notebookId ?? item.memoId), {
      name: typeof payload.name === "string" ? payload.name : undefined,
      parentId: Object.prototype.hasOwnProperty.call(payload, "parentId") ? (typeof payload.parentId === "string" ? payload.parentId : null) : undefined,
      sortOrder: typeof payload.sortOrder === "number" ? payload.sortOrder : undefined,
    });
    return result.notebook;
  }
  if (item.kind === "notebook.create") {
    const payload = item.payload as LocalActionPayload;
    const result = await api.createNotebook({ name: String(payload.name ?? ""), parentId: typeof payload.parentId === "string" ? payload.parentId : null });
    return result.notebook;
  }
  if (item.kind === "notebook.delete") {
    const payload = item.payload as LocalActionPayload;
    await api.deleteNotebook(String(payload.notebookId ?? item.memoId));
    return null;
  }
  if (item.kind === "template.create") {
    const payload = item.payload as LocalActionPayload;
    const result = await api.createTemplate({
      name: String(payload.name ?? ""),
      description: typeof payload.description === "string" ? payload.description : null,
      title: typeof payload.title === "string" ? payload.title : null,
      contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : "",
      tags: Array.isArray(payload.tags) ? payload.tags.filter((value): value is string => typeof value === "string") : [],
    });
    return result.template;
  }
  if (item.kind === "template.update") {
    const payload = item.payload as LocalActionPayload;
    const result = await api.updateTemplate(String(payload.templateId ?? item.memoId), {
      name: typeof payload.name === "string" ? payload.name : undefined,
      description: typeof payload.description === "string" ? payload.description : null,
      title: typeof payload.title === "string" ? payload.title : null,
      contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : undefined,
      tags: Array.isArray(payload.tags) ? payload.tags.filter((value): value is string => typeof value === "string") : [],
    });
    return result.template;
  }
  if (item.kind === "template.delete") {
    const payload = item.payload as LocalActionPayload;
    await api.deleteTemplate(String(payload.templateId ?? item.memoId));
    return null;
  }

  if (item.kind === "resource.create") {
    return syncLocalResource(item);
  }

  if (item.kind !== "memo.update") {
    throw new Error(`Unsupported sync item kind: ${item.kind}`);
  }

  const payload = item.payload as MemoUpdateSyncPayload;
  const { editSession } = await api.createMemoEditSession(item.memoId);
  const currentBase = { revision: editSession.baseRevision, contentHash: editSession.baseContentHash };
  if (!isMemoSyncBaseCurrent(currentBase, payload)) {
    throw new ApiRequestError(
      "Note changed before the offline draft could sync.",
      409,
      "revision_conflict",
      getMemoSyncBaseConflictDetails(currentBase, payload),
    );
  }

  const data = await api.updateMemo(item.memoId, {
    expectedRevision: payload.expectedRevision,
    expectedContentHash: payload.expectedContentHash,
    editSessionId: editSession.id,
    title: payload.title,
    contentJson: payload.contentJson as TiptapDoc,
    contentMarkdown: payload.contentMarkdown,
    tags: payload.tags,
  });

  return data.memo;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return "Sync failed";
};
