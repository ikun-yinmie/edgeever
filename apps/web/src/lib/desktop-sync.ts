import {
  getMemoSyncBaseConflictDetails,
  getSyncRetryAt,
  hasSyncStateReset,
  isDesktopLocalRevisionId,
  isMemoSyncBaseCurrent,
  memoUpdatePayloadMatchesRemote,
  resolveSameDeviceMemoSyncRecovery,
  type DesktopOutboxItem,
  type DesktopRpcParams,
  type DesktopRpcResponses,
  type MemoDetail,
  type SameDeviceMemoSyncRecovery,
  type SyncBootstrapResponse,
  type SyncChangesResponse,
  type TiptapDoc,
} from "@edgeever/shared";
import { api, ApiRequestError } from "@/lib/api";
import { isDesktopResourceRuntime, mapMarkdownResourceUrls, mapTiptapResourceUrls, toApiResourceUrl } from "@/lib/desktop-resources";
import { notifyMemoIdRemapped, notifyMemoSyncAcknowledged, notifyNotebookIdRemapped, notifySyncQueueChanged } from "@/lib/sync-events";

type StagedResourceRewrite = { memoId: string; placeholder: string; url: string };

export type DesktopSyncPhase =
  | "sync_creates"
  | "remap_created_resources"
  | "sync_staged_resources"
  | "sync_outbox"
  | "read_status"
  | "pull_remote_changes"
  | "pull_shared_snapshots"
  | "finalize_resource_remap";

export type DesktopGlobalSyncIssue = {
  phase: DesktopSyncPhase;
  message: string;
  errorCode: string | null;
  occurredAt: string;
};

let lastGlobalSyncIssue: DesktopGlobalSyncIssue | null = null;

const STAGED_RESOURCE_ID_CHARACTER = /[A-Za-z0-9_-]/;

const stringReferencesStagedResource = (value: string, placeholder: string) => {
  let index = value.indexOf(placeholder);
  while (index >= 0) {
    const nextCharacter = value[index + placeholder.length];
    if (!nextCharacter || !STAGED_RESOURCE_ID_CHARACTER.test(nextCharacter)) return true;
    index = value.indexOf(placeholder, index + placeholder.length);
  }
  return false;
};

const valueReferencesStagedResource = (value: unknown, placeholder: string): boolean => {
  if (typeof value === "string") return stringReferencesStagedResource(value, placeholder);
  if (Array.isArray(value)) return value.some((item) => valueReferencesStagedResource(item, placeholder));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => valueReferencesStagedResource(item, placeholder));
  }
  return false;
};

export const isStagedResourceReferenced = (payloads: unknown[], stagedId: string) => {
  const placeholder = `edgeever-staged://${stagedId}`;
  return payloads.some((payload) => valueReferencesStagedResource(payload, placeholder));
};

const stagedIdsReferencedByLocalMemos = async (rewrites: StagedResourceRewrite[]) => {
  const referenced = new Set<string>();
  for (const rewrite of rewrites) {
    const stagedId = rewrite.placeholder.startsWith("edgeever-staged://")
      ? rewrite.placeholder.slice("edgeever-staged://".length)
      : rewrite.placeholder;
    try {
      const local = await request("memo.get", { memoId: rewrite.memoId, includeDeleted: true });
      if (isStagedResourceReferenced([local.memo.contentJson, local.memo.contentMarkdown], stagedId)) {
        referenced.add(stagedId);
      }
    } catch {
      referenced.add(stagedId);
    }
  }
  return referenced;
};

const remapStagedResourceMemoIds = async (memoIdMappings: ReadonlyMap<string, string>) => {
  if (memoIdMappings.size === 0) return;
  // Keep sync compatible with a renderer hot-reload or an older native shell
  // that does not expose the new remapping IPC yet.
  await window.edgeeverDesktop?.remapStagedResourceMemoIds?.([...memoIdMappings]);
};

const syncStagedResources = async (memoIdMappings: Map<string, string>) => {
  if (!isDesktopResourceRuntime() || (typeof navigator !== "undefined" && !navigator.onLine)) return { attempted: 0, synced: 0, failed: 0, rewrites: [] as StagedResourceRewrite[], stagedIds: [] as string[] };
  const staged = await window.edgeeverDesktop!.listStagedResources();
  const pending = await request("sync.outbox.list", { limit: 200 });
  const pendingPayloads = pending.items.map((item) => item.payload);
  let synced = 0;
  let failed = 0;
  const rewrites: StagedResourceRewrite[] = [];
  const stagedIds: string[] = [];
  for (const item of staged) {
    // An image can finish staging before the editor's debounced local save
    // has queued the memo update that references it. Uploading and deleting
    // the staged file in that gap leaves the memo with an unrecoverable
    // edgeever-staged:// URL. Keep it durable until an outbox payload proves
    // that the note content containing the placeholder has been saved.
    if (!isStagedResourceReferenced(pendingPayloads, item.id)) continue;
    try {
      const memoId = memoIdMappings.get(item.memoId) ?? item.memoId;
      const uploaded = await api.uploadMemoResourceParts(memoId, {
        filename: item.name,
        mimeType: item.type,
        byteSize: item.size,
        readPart: async (start, end) => new Blob([
          await window.edgeeverDesktop!.readStagedResourcePart(item.id, start, end - start),
        ], { type: item.type }),
      });
      await window.edgeeverDesktop!.sidecarRequest("resource.cache", { resource: uploaded.resource });
      rewrites.push({ memoId, placeholder: `edgeever-staged://${item.id}`, url: uploaded.resource.url });
      stagedIds.push(item.id);
      synced += 1;
    } catch {
      failed += 1;
    }
  }
  try {
    await patchCreatedMemoResources(rewrites);
  } catch {
    // Keep the staged files and rewritten outbox payloads recoverable. A later
    // sync can retry the remote patch without losing the local attachment.
    failed += rewrites.length > 0 ? 1 : 0;
  }
  return { attempted: staged.length, synced, failed, rewrites, stagedIds };
};

const removeSyncedStagedResources = async (stagedIds: string[]) => {
  for (const id of stagedIds) {
    try {
      await window.edgeeverDesktop!.removeStagedResource(id);
    } catch {
      // The uploaded resource and the local memo are already durable; a later
      // pass can remove this harmless orphan from the staging directory.
    }
  }
};

export const rewriteStagedResource = (value: unknown, rewrites: StagedResourceRewrite[]): unknown => {
  if (typeof value === "string") {
    return rewrites.reduce((current, rewrite) => current.split(rewrite.placeholder).join(rewrite.url), value);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteStagedResource(item, rewrites));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStagedResource(item, rewrites)]));
  }
  return value;
};

export const normalizeDesktopMemoPayload = (payload: Record<string, unknown>): Record<string, unknown> => ({
  ...payload,
  contentJson: payload.contentJson && typeof payload.contentJson === "object"
    ? mapTiptapResourceUrls(payload.contentJson as TiptapDoc, toApiResourceUrl)
    : payload.contentJson,
  contentMarkdown: typeof payload.contentMarkdown === "string"
    ? mapMarkdownResourceUrls(payload.contentMarkdown, toApiResourceUrl)
    : payload.contentMarkdown,
});

const patchCreatedMemoResources = async (rewrites: StagedResourceRewrite[]) => {
  const memoIds = [...new Set(rewrites.map((rewrite) => rewrite.memoId))];
  if (memoIds.length === 0) return;

  const pending = await request("sync.outbox.list", { limit: 200 });
  const pendingUpdates = new Set(
    pending.items
      .filter((item) => item.kind === "memo.update")
      .map((item) => String(item.payload.memoId ?? item.entityId)),
  );

  for (const memoId of memoIds) {
    // A queued edit will carry the rewritten URLs through syncOutbox. Patching
    // here as well would advance the revision and turn that edit into a false
    // conflict, so only patch creates that have no later local edit.
    if (pendingUpdates.has(memoId)) continue;

    const remote = await api.getMemo(memoId, { includeDeleted: true });
    const memoRewrites = rewrites.filter((rewrite) => rewrite.memoId === memoId);
    const contentJson = rewriteStagedResource(remote.memo.contentJson, memoRewrites) as TiptapDoc;
    const contentMarkdown = rewriteStagedResource(remote.memo.contentMarkdown, memoRewrites);
    if (JSON.stringify(contentJson) === JSON.stringify(remote.memo.contentJson) && contentMarkdown === remote.memo.contentMarkdown) continue;

    const editSession = (await api.createMemoEditSession(memoId)).editSession;
    const updated = await api.updateMemo(memoId, {
      expectedRevision: editSession.baseRevision,
      expectedContentHash: editSession.baseContentHash,
      editSessionId: editSession.id,
      contentJson,
      contentMarkdown: typeof contentMarkdown === "string" ? contentMarkdown : undefined,
      title: remote.memo.title ?? "",
      tags: remote.memo.tags,
    });
    await request("sync.apply", {
      changes: [{ entityType: "memo", operation: "upsert", entityId: updated.memo.id, memo: updated.memo, notebook: null }],
    });
  }
};

const request = async <M extends keyof DesktopRpcResponses>(method: M, params: DesktopRpcParams[M]) => {
  const bridge = window.edgeeverDesktop;
  if (!bridge?.isAvailable) throw new Error("EdgeEver desktop bridge is unavailable");
  return bridge.sidecarRequest<DesktopRpcResponses[M]>(method, params);
};

const toDesktopGlobalSyncIssue = (phase: DesktopSyncPhase, error: unknown): DesktopGlobalSyncIssue => ({
  phase,
  message: error instanceof Error ? error.message : String(error),
  errorCode: error instanceof ApiRequestError ? error.code ?? `http_${error.status}` : error instanceof TypeError ? "network_error" : null,
  occurredAt: new Date().toISOString(),
});

const applyRemoteNotebook = async (notebook: DesktopRpcResponses["notebook.list"]["notebooks"][number]) => {
  await request("sync.apply", {
    changes: [{ entityType: "notebook", operation: "upsert", entityId: notebook.id, notebook, memo: null }],
  });
};

export const resolveDesktopMemoSyncBase = (
  current: { revision: number; contentHash: string },
  expected: { expectedRevision: number; expectedContentHash: string },
) => {
  // Older desktop clients advanced the cached cloud revision for every local
  // autosave. A base ahead of the actual server is therefore a local counter,
  // not evidence of a concurrent remote edit. Rebase that impossible state so
  // existing drafts recover automatically. Bases behind the server are inspected
  // by resolveDesktopStaleMemoUpdate before becoming a user-facing conflict.
  if (expected.expectedRevision > current.revision) {
    return {
      expectedRevision: current.revision,
      expectedContentHash: current.contentHash,
    };
  }
  return expected;
};

type DesktopLocalRevisionWitness = {
  id: string;
  revision: number;
  contentHash: string;
  contentMarkdown: string;
  contentJson?: unknown;
};

export const desktopLocalRevisionWitnessesRemote = (
  revisions: ReadonlyArray<DesktopLocalRevisionWitness>,
  remote: { contentHash: string; contentMarkdown: string; contentJson?: unknown },
  expectedRevision: number,
) => revisions.some((revision) => {
  if (!isDesktopLocalRevisionId(revision.id) || revision.revision < expectedRevision) {
    return false;
  }
  if (revision.contentHash === remote.contentHash) {
    return true;
  }
  if (revision.contentMarkdown !== remote.contentMarkdown) {
    return false;
  }
  return revision.contentMarkdown !== ""
    || JSON.stringify(revision.contentJson ?? null) === JSON.stringify(remote.contentJson ?? null);
});

export const resolveDesktopStaleMemoUpdate = (input: {
  current: { revision: number; contentHash: string };
  expected: { expectedRevision: number; expectedContentHash: string };
  payload: {
    title?: unknown;
    tags?: unknown;
    contentMarkdown?: unknown;
    contentJson?: unknown;
  };
  remote: Pick<MemoDetail, "title" | "tags" | "contentMarkdown" | "contentHash" | "contentJson">;
  localRevisions: ReadonlyArray<DesktopLocalRevisionWitness>;
}): SameDeviceMemoSyncRecovery => resolveSameDeviceMemoSyncRecovery({
  current: input.current,
  expected: input.expected,
  payloadMatchesRemote: memoUpdatePayloadMatchesRemote(input.payload, input.remote),
  remoteProducedLocally: desktopLocalRevisionWitnessesRemote(
    input.localRevisions,
    input.remote,
    input.expected.expectedRevision,
  ),
});

const acknowledge = async (
  item: DesktopOutboxItem,
  remoteMemo?: DesktopRpcResponses["memo.get"]["memo"],
  remoteNotebook?: DesktopRpcResponses["notebook.list"]["notebooks"][number],
  remoteTemplate?: DesktopRpcResponses["template.list"]["templates"][number],
) => {
  if (remoteNotebook) await applyRemoteNotebook(remoteNotebook);
  await request("sync.outbox.ack", { id: item.id, version: item.version, remoteMemo, remoteNotebook, remoteTemplate });
};

export const syncOutboxItem = async (item: DesktopOutboxItem, stagedRewrites: StagedResourceRewrite[]) => {
  const rewrittenPayload = stagedRewrites.length > 0
    ? rewriteStagedResource(item.payload, stagedRewrites.filter((rewrite) => rewrite.memoId === String(item.payload.memoId ?? item.entityId))) as Record<string, unknown>
    : item.payload;
  const payload = item.kind === "memo.create" || item.kind === "memo.update"
    ? normalizeDesktopMemoPayload(rewrittenPayload)
    : rewrittenPayload;
  if (item.kind === "memo.create") {
    const data = await api.createMemo({
      notebookId: String(payload.notebookId),
      title: String(payload.title ?? ""),
      contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : undefined,
      tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [],
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
    });
    await acknowledge(item, data.memo);
    return data.memo;
  }

  if (item.kind === "memo.update") {
    const memoId = String(payload.memoId ?? item.entityId);
    const editSessionResponse = await api.createMemoEditSession(memoId);
    const editSession = editSessionResponse.editSession;
    const queuedBase = {
      expectedRevision: Number(payload.expectedRevision),
      expectedContentHash: String(payload.expectedContentHash ?? ""),
    };
    const currentBase = { revision: editSession.baseRevision, contentHash: editSession.baseContentHash };
    const expectedBase = resolveDesktopMemoSyncBase(currentBase, queuedBase);
    let syncBase = expectedBase;
    if (!isMemoSyncBaseCurrent(currentBase, expectedBase)) {
      const remote = await api.getMemo(memoId, { includeDeleted: true });
      let localRevisions: DesktopLocalRevisionWitness[] = [];
      try {
        localRevisions = (await request("memo.revisions", { memoId, limit: 200 })).revisions;
      } catch {
        // A lost acknowledgement of the exact payload can still be acked
        // without local history. Missing snapshots keep a genuine remote edit
        // as a conflict.
      }
      const recovery = resolveDesktopStaleMemoUpdate({
        current: currentBase,
        expected: expectedBase,
        payload,
        remote: remote.memo,
        localRevisions,
      });
      if (recovery === "ack") {
        await acknowledge(item, remote.memo);
        return remote.memo;
      }
      if (recovery !== "rebase") {
        throw new ApiRequestError(
          "Note changed before the offline draft could sync.",
          409,
          "revision_conflict",
          getMemoSyncBaseConflictDetails(currentBase, expectedBase),
        );
      }
      syncBase = {
        expectedRevision: currentBase.revision,
        expectedContentHash: currentBase.contentHash,
      };
    }
    const data = await api.updateMemo(memoId, {
      expectedRevision: syncBase.expectedRevision,
      expectedContentHash: syncBase.expectedContentHash,
      editSessionId: editSession.id,
      title: String(payload.title ?? ""),
      contentJson: payload.contentJson as TiptapDoc,
      contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : undefined,
      tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [],
      allowDestructiveOverwrite: payload.allowDestructiveOverwrite === true,
    });
    await acknowledge(item, data.memo);
    return data.memo;
  }

  if (item.kind === "memo.delete") {
    try {
      await api.deleteMemo(String(payload.memoId ?? item.entityId), { permanent: Boolean(payload.permanent) });
    } catch (error) {
      // The note is already gone (removed on another device, or its create
      // never reached the server). Permanent delete is idempotent here.
      if (!(Boolean(payload.permanent) && error instanceof ApiRequestError && error.status === 404)) {
        throw error;
      }
    }
    await acknowledge(item);
    return null;
  }

  if (item.kind === "memo.deleteBatch") {
    const memoIds = Array.isArray(payload.memoIds) ? payload.memoIds.filter((memoId): memoId is string => typeof memoId === "string") : [];
    const permanent = Boolean(payload.permanent);
    try {
      await api.deleteMemos({ memoIds, permanent });
    } catch (error) {
      // The server rejects a permanent batch when some ids are already gone;
      // fall back to per-id deletes so the rest of the batch still empties.
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
    await acknowledge(item);
    return null;
  }

  if (item.kind === "memo.emptyTrash") {
    await api.emptyTrash();
    await acknowledge(item);
    return null;
  }

  if (item.kind === "memo.pinBatch") {
    const memoIds = Array.isArray(payload.memoIds) ? payload.memoIds.filter((memoId): memoId is string => typeof memoId === "string") : [];
    for (const memoId of memoIds) {
      try {
        await api.updateMemo(memoId, { isPinned: Boolean(payload.isPinned) });
      } catch (error) {
        // The note may be already gone (removed on another device, or its
        // create never reached the server); the rest of the batch still pins.
        if (!(error instanceof ApiRequestError) || error.status !== 404) {
          throw error;
        }
      }
    }
    await acknowledge(item);
    return null;
  }

  if (item.kind === "memo.setTheme") {
    const memoId = String(payload.memoId ?? item.entityId);
    let data: { memo: MemoDetail } | null = null;
    try {
      data = await api.updateMemo(memoId, { theme: typeof payload.theme === "string" ? payload.theme : null });
    } catch (error) {
      // The note may be already gone (removed on another device, or its create
      // never reached the server); there is nothing left to theme.
      if (!(error instanceof ApiRequestError) || error.status !== 404) {
        throw error;
      }
    }
    await acknowledge(item, data?.memo);
    return null;
  }

  if (item.kind === "memo.merge") {
    const data = await api.mergeMemos({
      memoIds: Array.isArray(payload.memoIds) ? payload.memoIds.filter((memoId): memoId is string => typeof memoId === "string") : [],
      notebookId: typeof payload.notebookId === "string" ? payload.notebookId : undefined,
      title: typeof payload.title === "string" ? payload.title : undefined,
    });
    await acknowledge(item, data.memo);
    return data.memo;
  }

  if (item.kind === "notebook.create") {
    const data = await api.createNotebook({ name: String(payload.name ?? ""), parentId: typeof payload.parentId === "string" ? payload.parentId : null });
    await acknowledge(item, undefined, data.notebook);
    // The sidecar renames the local `local_*` row to the server id; hand the
    // mapping back so the renderer can keep its selection on the same
    // notebook once the new id reaches the notebook list.
    return data.notebook;
  }

  if (item.kind === "notebook.update") {
    const data = await api.updateNotebook(String(payload.notebookId ?? item.entityId), {
      name: typeof payload.name === "string" ? payload.name : undefined,
      parentId: Object.prototype.hasOwnProperty.call(payload, "parentId") ? (typeof payload.parentId === "string" ? payload.parentId : null) : undefined,
      sortOrder: typeof payload.sortOrder === "number" ? payload.sortOrder : undefined,
    });
    await acknowledge(item, undefined, data.notebook);
    return null;
  }

  if (item.kind === "notebook.delete") {
    await api.deleteNotebook(String(payload.notebookId ?? item.entityId));
    await acknowledge(item);
    return null;
  }

  if (item.kind === "notebook.restore") {
    const data = await api.restoreNotebook(String(payload.notebookId ?? item.entityId));
    await acknowledge(item, undefined, data.notebook);
    return null;
  }

  if (item.kind === "template.create") {
    const data = await api.createTemplate({
      name: String(payload.name ?? ""),
      description: typeof payload.description === "string" ? payload.description : null,
      title: typeof payload.title === "string" ? payload.title : null,
      contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : "",
      tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [],
    });
    await acknowledge(item, undefined, undefined, data.template);
    return null;
  }

  if (item.kind === "template.update") {
    const data = await api.updateTemplate(String(payload.templateId ?? item.entityId), {
      name: typeof payload.name === "string" ? payload.name : undefined,
      description: typeof payload.description === "string" ? payload.description : null,
      title: typeof payload.title === "string" ? payload.title : null,
      contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : undefined,
      tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : [],
    });
    await acknowledge(item, undefined, undefined, data.template);
    return null;
  }

  if (item.kind === "template.delete") {
    await api.deleteTemplate(String(payload.templateId ?? item.entityId));
    await acknowledge(item);
    return null;
  }

  if (item.kind === "tag.rename") {
    await api.renameTag(String(payload.tag ?? item.entityId), String(payload.name ?? ""));
    await acknowledge(item);
    return null;
  }

  if (item.kind === "tag.delete") {
    await api.deleteTag(String(payload.tag ?? item.entityId));
    await acknowledge(item);
    return null;
  }

  if (item.kind === "memo.move") {
    const memoIds = Array.isArray(payload.memoIds) ? payload.memoIds.filter((memoId): memoId is string => typeof memoId === "string") : [];
    const notebookId = String(payload.notebookId ?? "");
    try {
      await api.moveMemos({ memoIds, notebookId });
    } catch (error) {
      // A note whose create never reached the server cannot be moved. Fall
      // back to per-id moves so the rest of the batch still follows.
      if (!(error instanceof ApiRequestError) || error.status !== 400 || error.code !== "missing_memos") {
        throw error;
      }
      for (const memoId of memoIds) {
        try {
          await api.moveMemos({ memoIds: [memoId], notebookId });
        } catch (nested) {
          if (!(nested instanceof ApiRequestError) || nested.status !== 400 || nested.code !== "missing_memos") {
            throw nested;
          }
        }
      }
    }
    await acknowledge(item);
    return null;
  }

  if (item.kind === "memo.restore") {
    await api.restoreMemo(String(payload.memoId ?? item.entityId));
    await acknowledge(item);
    return null;
  }

  throw new Error(`Unsupported desktop sync operation: ${item.kind}`);
};

const syncOutbox = async (stagedRewrites: StagedResourceRewrite[], onlyKinds?: Set<string>) => {
  let synced = 0;
  let failed = 0;
  let conflicted = 0;
  const response = await request("sync.outbox.list", { limit: 100 });
  const memoIdMappings = new Map<string, string>();
  const syncedMemos = new Map<string, DesktopRpcResponses["memo.get"]["memo"]>();
  for (const item of response.items) {
    if (onlyKinds && !onlyKinds.has(item.kind)) continue;
    try {
      const claim = await request("sync.outbox.claim", { id: item.id, version: item.version });
      if (!claim.claimed) continue;
      const result = await syncOutboxItem(item, stagedRewrites);
      if (item.kind === "memo.create" && result && typeof result === "object" && "id" in result && typeof result.id === "string") {
        memoIdMappings.set(item.entityId, result.id);
        // Remap the live editor and advance its cloud base as soon as the
        // create is acknowledged. Waiting for the workspace-wide sync to end
        // leaves a window where the next autosave still sends revision 0.
        notifyMemoIdRemapped(new Map([[item.entityId, result.id]]));
      }
      if (item.kind === "notebook.create" && result && typeof result === "object" && "id" in result && typeof result.id === "string") {
        notifyNotebookIdRemapped(new Map([[item.entityId, result.id]]));
      }
      if (result && typeof result === "object" && "id" in result && typeof result.id === "string" && "contentJson" in result) {
        const syncedMemo = result as DesktopRpcResponses["memo.get"]["memo"];
        syncedMemos.set(result.id, syncedMemo);
        notifyMemoSyncAcknowledged(syncedMemo);
      }
      synced += 1;
    } catch (error) {
      const disposition = classifyDesktopSyncFailure(item, error);
      await request("sync.outbox.fail", {
        id: item.id,
        version: item.version,
        error: error instanceof Error ? error.message : String(error),
        errorCode: disposition.errorCode,
        conflict: disposition.conflict,
        retryable: disposition.retryable,
        nextAttemptAt: disposition.retryable ? getSyncRetryAt(item.attemptCount + 1) : null,
      });
      if (disposition.conflict) conflicted += 1;
      else failed += 1;
    }
  }
  return { attempted: onlyKinds ? synced + failed + conflicted : response.items.length, synced, failed, conflicted, memoIdMappings, syncedMemos };
};

const applyBootstrap = async (page: SyncBootstrapResponse) => {
  const changes = [
    ...orderBootstrapNotebooks(page.notebooks).map((notebook) => ({ entityType: "notebook" as const, operation: "upsert" as const, entityId: notebook.id, notebook, memo: null })),
    ...page.memos.map((memo) => ({ entityType: "memo" as const, operation: "upsert" as const, entityId: memo.id, memo, notebook: null })),
  ];
  if (changes.length > 0) await request("sync.apply", { changes });
};

export const hasDesktopSyncStateReset = (
  local: { cursor: number; syncIdentity: string },
  remote: Pick<SyncChangesResponse, "serverCursor" | "syncIdentity">,
) => hasSyncStateReset(local, remote);

export const classifyDesktopSyncFailure = (item: Pick<DesktopOutboxItem, "kind">, error: unknown) => {
  const conflict = error instanceof ApiRequestError
    && (error.code === "revision_conflict" || error.code === "content_conflict" || error.code === "edit_session_conflict");
  if (conflict) {
    return { conflict: true, retryable: false, errorCode: error.code ?? "sync_conflict" };
  }
  if (error instanceof ApiRequestError) {
    const missingMemo = item.kind === "memo.update" && error.status === 404;
    return {
      conflict: false,
      retryable: !missingMemo && (error.status === 408 || error.status === 429 || error.status >= 500),
      errorCode: missingMemo ? "memo_not_found" : error.code ?? `http_${error.status}`,
    };
  }
  return {
    conflict: false,
    retryable: error instanceof TypeError,
    errorCode: error instanceof TypeError ? "network_error" : "unexpected_sync_error",
  };
};

export const shouldPullDesktopChanges = (
  status: Pick<DesktopRpcResponses["sync.status"], "pending" | "syncing">,
  online: boolean,
) => online && status.pending === 0 && status.syncing === 0;

export const shouldAttemptDesktopRecoveryPull = (
  phase: DesktopSyncPhase,
  status: Pick<DesktopRpcResponses["sync.status"], "pending" | "syncing">,
  online: boolean,
) => phase !== "pull_remote_changes"
  && phase !== "finalize_resource_remap"
  && shouldPullDesktopChanges(status, online);

export const orderBootstrapNotebooks = <T extends { id: string; parentId?: string | null }>(notebooks: T[]) => {
  const remaining = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const ordered: T[] = [];

  while (remaining.size > 0) {
    let added = 0;
    for (const [id, notebook] of remaining) {
      if (notebook.parentId && remaining.has(notebook.parentId)) continue;
      ordered.push(notebook);
      remaining.delete(id);
      added += 1;
    }
    if (added === 0) {
      ordered.push(...remaining.values());
      break;
    }
  }

  return ordered;
};

export const orderDesktopSyncChanges = <T extends {
  entityType: string;
  entityId: string;
  operation: string;
  notebook?: { id: string; parentId?: string | null } | null;
}>(changes: T[]) => {
  const notebookUpserts: T[] = [];
  const notebookDeletes: T[] = [];
  const rest: T[] = [];
  for (const change of changes) {
    if (change.entityType !== "notebook") rest.push(change);
    else if (change.operation === "delete") notebookDeletes.push(change);
    else notebookUpserts.push(change);
  }
  const byId = new Map(notebookUpserts.map((change) => [change.entityId, change]));
  const orderedUpserts = orderBootstrapNotebooks(
    notebookUpserts.map((change) => change.notebook ?? { id: change.entityId, parentId: null }),
  ).flatMap((notebook) => {
    const change = byId.get(notebook.id);
    return change ? [change] : [];
  });
  const orderedIds = new Set(orderedUpserts.map((change) => change.entityId));
  const leftoverUpserts = notebookUpserts.filter((change) => !orderedIds.has(change.entityId));
  return [...orderedUpserts, ...leftoverUpserts, ...notebookDeletes, ...rest];
};

const bootstrapDesktopMirror = async (reset: boolean) => {
  await request("sync.bootstrap.prepare", reset ? { reset: true } : {});
  let afterId: string | null = null;
  let firstPage = true;
  let snapshotCursor = 0;
  let syncIdentity = "";
  do {
    const page = await api.syncBootstrap({ afterId, limit: 200 });
    if (firstPage) {
      snapshotCursor = page.snapshotCursor;
      syncIdentity = page.syncIdentity ?? "";
      firstPage = false;
    }
    await applyBootstrap(page);
    afterId = page.nextAfterId;
  } while (afterId);
  await request("sync.cursor.set", { cursor: snapshotCursor, syncIdentity });
};

const pullRemoteChanges = async () => {
  const status = await request("sync.status", {});
  if (!status.syncIdentity) {
    await bootstrapDesktopMirror(false);
    return;
  }

  let cursor = status.cursor;
  let response: SyncChangesResponse = await api.syncChanges({ cursor, limit: 200 });
  if (hasDesktopSyncStateReset({ cursor: status.cursor, syncIdentity: status.syncIdentity }, response)) {
    await bootstrapDesktopMirror(true);
    return;
  }
  while (response.changes.length > 0) {
    await request("sync.apply", { changes: orderDesktopSyncChanges(response.changes) });
    cursor = response.cursor;
    if (!response.hasMore) break;
    response = await api.syncChanges({ cursor, limit: 200 });
    if (hasDesktopSyncStateReset({ cursor, syncIdentity: status.syncIdentity }, response)) {
      await bootstrapDesktopMirror(true);
      return;
    }
  }
  await request("sync.cursor.set", { cursor: response.cursor ?? cursor, syncIdentity: response.syncIdentity ?? status.syncIdentity });
};

const isDefaultDisplayPolicy = (policy: { html: string; markdown: string } | null | undefined) =>
  !policy || (policy.html === "rendered" && policy.markdown === "rendered");

export type SharedSnapshotEntry = {
  id: string;
  updatedAt: string;
  groupId: string;
};

export type MirroredSnapshotEntry = {
  memoId: string;
  updatedAt: string;
};

/**
 * Pure diff for the shared snapshot sync: which accessible memos need a
 * (re)fetch, and whether anything lost access and must be pruned.
 */
export const diffSharedSnapshots = (
  shared: SharedSnapshotEntry[],
  mirrored: MirroredSnapshotEntry[],
  strictGroupIds: ReadonlySet<string>,
): { refreshIds: string[]; prune: boolean } => {
  const mirroredById = new Map(mirrored.map((entry) => [entry.memoId, entry]));
  const refreshIds = shared
    .filter((entry) => {
      const known = mirroredById.get(entry.id);
      return !known || known.updatedAt !== entry.updatedAt || strictGroupIds.has(entry.groupId);
    })
    .map((entry) => entry.id);
  const accessibleIds = new Set(shared.map((entry) => entry.id));
  return { refreshIds, prune: mirrored.some((entry) => !accessibleIds.has(entry.memoId)) };
};

/**
 * Mirror group-shared notes into the sidecar so they stay readable offline.
 * The snapshots table is strictly separate from the personal mirror; entries
 * carry the already-filtered document the API served (never the raw note),
 * and anything that lost access is pruned on every online sync.
 */
const pullSharedSnapshots = async () => {
  const shared = await api.getSharedWithMe();
  const memos = shared.memos ?? [];
  const mirrored = await request("shared.snapshot.list", {});

  // A display-policy change does not bump the memo revision, so compare
  // policies per group as well: any non-default policy in the group forces a
  // refresh of its snapshots, keeping filtered views from going stale.
  const strictGroupIds = new Set<string>();
  for (const groupId of new Set(memos.map((memo) => memo.groupId))) {
    try {
      const { shares } = await api.listGroupShares(groupId);
      if (shares.some((share) => !isDefaultDisplayPolicy(share.displayPolicy))) {
        strictGroupIds.add(groupId);
      }
    } catch {
      // Keep the last snapshot when the share list is unreachable.
    }
  }

  const { refreshIds, prune } = diffSharedSnapshots(
    memos.map((memo) => ({ id: memo.id, updatedAt: memo.updatedAt, groupId: memo.groupId })),
    mirrored.snapshots,
    strictGroupIds,
  );
  const byId = new Map(memos.map((memo) => [memo.id, memo]));
  await Promise.all(refreshIds.map(async (memoId) => {
    const entry = byId.get(memoId);
    if (!entry) return;
    const remote = await api.getMemo(entry.id);
    await request("shared.snapshot.save", {
      memo: {
        ...remote.memo,
        groupId: entry.groupId,
        groupName: entry.groupName,
        displayPolicy: remote.displayPolicy ?? null,
      },
    });
  }));

  if (prune) {
    const accessibleIds = new Set(memos.map((memo) => memo.id));
    await request("shared.snapshot.prune", { memoIds: [...accessibleIds] });
  }
};

export const syncSharedSnapshots = async () => {
  try {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    await pullSharedSnapshots();
  } catch (error) {
    // Snapshots are advisory: never break the main sync over them.
    console.error("[desktop-sync] Shared snapshot pull failed", error);
  }
};

export type DesktopSyncResult = {
  attempted: number;
  synced: number;
  failed: number;
  conflicted: number;
  memoIdMappings: Map<string, string>;
  syncedMemos: Map<string, DesktopRpcResponses["memo.get"]["memo"]>;
};

export const mergeMemoIdMappings = (
  target: Map<string, string>,
  source: ReadonlyMap<string, string>,
) => {
  for (const [temporaryId, remoteId] of source) target.set(temporaryId, remoteId);
  return target;
};

export const mergeSyncedMemos = <T>(target: Map<string, T>, source: ReadonlyMap<string, T>) => {
  for (const [memoId, memo] of source) target.set(memoId, memo);
  return target;
};

let activeSync: Promise<DesktopSyncResult> | null = null;

export const syncDesktopData = () => {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const memoIdMappings = new Map<string, string>();
    const syncedMemos = new Map<string, DesktopRpcResponses["memo.get"]["memo"]>();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return { attempted: 0, synced: 0, failed: 0, conflicted: 0, memoIdMappings, syncedMemos };
    }
    let phase: DesktopSyncPhase = "sync_creates";
    try {
      const creates = await syncOutbox([], new Set(["memo.create"]));
      mergeMemoIdMappings(memoIdMappings, creates.memoIdMappings);
      mergeSyncedMemos(syncedMemos, creates.syncedMemos);
      phase = "remap_created_resources";
      await remapStagedResourceMemoIds(creates.memoIdMappings);
      phase = "sync_staged_resources";
      const stagedResources = await syncStagedResources(creates.memoIdMappings);
      phase = "sync_outbox";
      const outbox = await syncOutbox(stagedResources.rewrites);
      mergeMemoIdMappings(memoIdMappings, outbox.memoIdMappings);
      mergeSyncedMemos(syncedMemos, outbox.syncedMemos);
      if (stagedResources.failed === 0 && outbox.failed === 0 && outbox.conflicted === 0 && creates.conflicted === 0) {
        const stillReferenced = await stagedIdsReferencedByLocalMemos(stagedResources.rewrites);
        if (stillReferenced.size > 0) {
          try {
            await patchCreatedMemoResources(stagedResources.rewrites.filter((rewrite) => {
              const stagedId = rewrite.placeholder.slice("edgeever-staged://".length);
              return stillReferenced.has(stagedId);
            }));
          } catch {
            // Keep the staged files so a later save can finish rewriting the note.
          }
        }
        const remainingReferenced = stillReferenced.size > 0
          ? await stagedIdsReferencedByLocalMemos(stagedResources.rewrites)
          : stillReferenced;
        await removeSyncedStagedResources(
          stagedResources.stagedIds.filter((stagedId) => !remainingReferenced.has(stagedId)),
        );
      }
      phase = "read_status";
      const remaining = await request("sync.status", {});
      // A durable failed or conflicted outbox item must not freeze unrelated
      // remote changes. The payload remains recoverable while pulls continue.
      if (shouldPullDesktopChanges(remaining, typeof navigator === "undefined" || navigator.onLine)) {
        phase = "pull_remote_changes";
        await pullRemoteChanges();
        // Shared notes live outside the mirrored workspace, so the cursor
        // pull above never sees them. Mirror them separately (advisory: a
        // failed shared pull must never break the main sync).
        phase = "pull_shared_snapshots";
        await syncSharedSnapshots();
      }
      // Catch resources staged while the network sync itself was running.
      phase = "finalize_resource_remap";
      await remapStagedResourceMemoIds(creates.memoIdMappings);
      lastGlobalSyncIssue = null;
      return {
        attempted: creates.attempted + outbox.attempted + stagedResources.attempted,
        synced: creates.synced + outbox.synced + stagedResources.synced,
        failed: creates.failed + outbox.failed + stagedResources.failed,
        conflicted: creates.conflicted + outbox.conflicted,
        memoIdMappings,
        syncedMemos,
      };
    } catch (error) {
      lastGlobalSyncIssue = toDesktopGlobalSyncIssue(phase, error);
      console.error("[desktop-sync] Sync failed", error);
      // Resource preparation and other peripheral desktop phases must not
      // freeze cloud downloads. Pull only after the sidecar proves there is no
      // local upload in progress; pending drafts continue to block the pull.
      try {
        const online = typeof navigator === "undefined" || navigator.onLine;
        const remaining = await request("sync.status", {});
        if (shouldAttemptDesktopRecoveryPull(phase, remaining, online)) {
          await pullRemoteChanges();
        }
      } catch (pullError) {
        if (phase !== "pull_remote_changes") {
          console.error("[desktop-sync] Recovery pull failed", pullError);
        }
      }
      // A create may already have been acknowledged before a later upload or
      // pull failed. Preserve its id mapping so the UI cannot keep editing an
      // obsolete temporary id merely because the overall sync was partial.
      return { attempted: 0, synced: 0, failed: 1, conflicted: 0, memoIdMappings, syncedMemos };
    }
  })().finally(() => { activeSync = null; });
  return activeSync;
};

export const createDesktopSyncSummary = (
  status: Pick<DesktopRpcResponses["sync.status"], "pending" | "syncing" | "conflict" | "error">,
  globalIssue: DesktopGlobalSyncIssue | null,
) => {
  const error = status.error + (globalIssue ? 1 : 0);
  return { total: status.pending + status.syncing + status.conflict + error, pending: status.pending, syncing: status.syncing, conflict: status.conflict, error };
};

export const getDesktopSyncSummary = async () => createDesktopSyncSummary(
  await request("sync.status", {}),
  lastGlobalSyncIssue,
);

export const createDesktopSyncIssueDetails = (
  items: DesktopOutboxItem[],
  globalIssue: DesktopGlobalSyncIssue | null,
) => ({
  globalIssue,
  items: items.filter((item) => item.status === "error" || item.status === "conflict"),
});

export const getDesktopSyncIssues = async () => {
  const response = await request("sync.outbox.list", { limit: 200, includeConflicts: true });
  return createDesktopSyncIssueDetails(response.items, lastGlobalSyncIssue);
};

export const retryDesktopSyncIssue = async (item: DesktopOutboxItem) => {
  await request("sync.outbox.retry", { id: item.id, version: item.version });
  window.dispatchEvent(new CustomEvent("edgeever:sync-queue-changed"));
};

export const discardDesktopSyncIssue = async (item: DesktopOutboxItem) => {
  await request("sync.outbox.discard", { id: item.id, version: item.version });
  window.dispatchEvent(new CustomEvent("edgeever:sync-queue-changed"));
};

export const recoverDesktopMemoUpdate = async (item: DesktopOutboxItem, notebookId: string) => {
  const result = await request("sync.outbox.recoverMemoUpdate", { id: item.id, version: item.version, notebookId });
  window.dispatchEvent(new CustomEvent("edgeever:sync-queue-changed"));
  return result.memo;
};

export type DesktopMaintenanceProgress = {
  done: number;
  total: number;
};

export type DesktopUploadAllResult = {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  failedMemoIds: string[];
};

let activeMaintenance: Promise<unknown> | null = null;

const listLocalMemoIds = async () => {
  const ids: string[] = [];
  const first = await request("memo.list", { limit: 200 });
  ids.push(...first.memos.map((memo) => memo.id));
  let offset = first.memos.length;
  while (offset < first.totalCount) {
    const page = await request("memo.list", { limit: 200, offset });
    if (page.memos.length === 0) break;
    ids.push(...page.memos.map((memo) => memo.id));
    offset += page.memos.length;
  }
  return ids;
};

const isUploadAllMemoKind = (item: DesktopOutboxItem) =>
  item.kind === "memo.update" || item.kind === "memo.create" || item.kind === "memo.delete"
  || item.kind === "memo.restore" || item.kind === "memo.merge" || item.kind === "memo.move";

/**
 * WizNote-style "download everything": rebuild the local mirror from the
 * server. The sidecar reset keeps every note that still has a queued change,
 * so pending local edits survive and sync afterwards as usual.
 */
export const pullEverythingFromServer = (): Promise<void> => {
  if (activeMaintenance) return activeMaintenance as Promise<void>;
  const run = async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new Error("The server is unreachable");
    }
    await bootstrapDesktopMirror(true);
    await syncSharedSnapshots();
    notifySyncQueueChanged();
  };
  activeMaintenance = run().finally(() => { activeMaintenance = null; });
  return activeMaintenance as Promise<void>;
};

/**
 * WizNote-style "upload everything": force-push the local version of every
 * note that also exists on the server, using the server's current base and a
 * destructive-overwrite pass so the server content converges to local.
 * Notes with queued changes and notes that only exist locally are left to
 * the regular queue.
 */
export const uploadEverythingToServer = (onProgress?: (progress: DesktopMaintenanceProgress) => void): Promise<DesktopUploadAllResult> => {
  if (activeMaintenance) return activeMaintenance as Promise<DesktopUploadAllResult>;
  const run = async (): Promise<DesktopUploadAllResult> => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new Error("The server is unreachable");
    }
    const queued = await request("sync.outbox.list", { limit: 200, includeConflicts: true });
    const queuedMemoIds = new Set(
      queued.items.filter(isUploadAllMemoKind).map((item) => item.entityId),
    );
    const ids = (await listLocalMemoIds()).filter((memoId) => !queuedMemoIds.has(memoId));
    const result: DesktopUploadAllResult = { total: ids.length, uploaded: 0, skipped: 0, failed: 0, failedMemoIds: [] };
    for (const [index, memoId] of ids.entries()) {
      try {
        const local = (await request("memo.get", { memoId, includeDeleted: true })).memo;
        if (local.isDeleted) {
          result.skipped += 1;
        } else {
          const { editSession } = await api.createMemoEditSession(memoId);
          const data = await api.updateMemo(memoId, {
            expectedRevision: editSession.baseRevision,
            expectedContentHash: editSession.baseContentHash,
            editSessionId: editSession.id,
            notebookId: local.notebookId,
            title: local.title ?? "",
            contentJson: local.contentJson,
            contentMarkdown: local.contentMarkdown || undefined,
            tags: local.tags,
            isPinned: local.isPinned,
            theme: local.theme ?? null,
            allowDestructiveOverwrite: true,
          });
          await request("sync.apply", {
            changes: [{ entityType: "memo", operation: "upsert", entityId: memoId, memo: data.memo }],
          });
          notifyMemoSyncAcknowledged(data.memo);
          result.uploaded += 1;
        }
      } catch (error) {
        // A note that never reached the server is the regular queue's job,
        // not a maintenance failure.
        if (error instanceof ApiRequestError && error.status === 404) {
          result.skipped += 1;
        } else {
          result.failed += 1;
          if (result.failedMemoIds.length < 10) {
            result.failedMemoIds.push(memoId);
          }
          console.error("[desktop-sync] Upload-all failed for memo", memoId, error);
        }
      }
      onProgress?.({ done: index + 1, total: result.total });
    }
    notifySyncQueueChanged();
    return result;
  };
  activeMaintenance = run().finally(() => { activeMaintenance = null; });
  return activeMaintenance as Promise<DesktopUploadAllResult>;
};

const sanitizeDesktopSyncDiagnosticError = (value: string | null | undefined) => value
  ? value
      .slice(0, 200)
      .replace(/https?:\/\/[^\s)\]}]+/gi, "[redacted-url]")
      .replace(/\b(?:memo|notebook|template|resource)_[A-Za-z0-9_-]+\b/g, "[redacted-id]")
      .replace(/\/Users\/[^/\s]+/g, "/Users/[redacted]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
  : value;

export const createDesktopSyncDiagnosticText = (items: DesktopOutboxItem[], globalIssue: DesktopGlobalSyncIssue | null = null) => JSON.stringify({
  generatedAt: new Date().toISOString(),
  globalIssue: globalIssue ? {
    ...globalIssue,
    message: sanitizeDesktopSyncDiagnosticError(globalIssue.message),
  } : null,
  totalItemCount: items.length,
  includedItemCount: Math.min(items.length, 5),
  items: items.slice(0, 5).map((item) => ({
    kind: item.kind,
    status: item.status,
    attemptCount: item.attemptCount,
    lastError: sanitizeDesktopSyncDiagnosticError(item.lastError),
    lastErrorCode: item.lastErrorCode,
    retryable: item.retryable,
    nextAttemptAt: item.nextAttemptAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })),
}, null, 2);

export const discardDesktopConflicts = async () => {
  const response = await request("sync.outbox.list", { limit: 200, includeConflicts: true });
  const conflicts = response.items.filter((item) => item.status === "conflict");
  let discarded = 0;

  for (const item of conflicts) {
    if (item.kind === "memo.update") {
      // Replace the local conflicted draft with the authoritative remote memo
      // before removing the queue item. If the remote read fails, keep the
      // conflict so the user's local changes remain recoverable.
      const remote = await api.getMemo(item.entityId, { includeDeleted: true });
      await request("sync.apply", {
        changes: [{ entityType: "memo", operation: "upsert", entityId: remote.memo.id, memo: remote.memo, notebook: null }],
      });
      await request("sync.outbox.ack", { id: item.id, version: item.version, remoteMemo: remote.memo });
    } else {
      await request("sync.outbox.discard", { id: item.id });
    }
    discarded += 1;
  }

  return discarded;
};

/**
 * Discard a single note's conflicted desktop outbox item and replace the local
 * store with the authoritative cloud memo.
 */
export const discardDesktopMemoConflict = async (memoId: string) => {
  const remote = await api.getMemo(memoId, { includeDeleted: true });
  await request("sync.apply", {
    changes: [{ entityType: "memo", operation: "upsert", entityId: remote.memo.id, memo: remote.memo, notebook: null }],
  });

  const response = await request("sync.outbox.list", { limit: 200, includeConflicts: true });
  for (const item of response.items) {
    if (item.entityId !== memoId || item.status !== "conflict") {
      continue;
    }
    if (item.kind === "memo.update") {
      await request("sync.outbox.ack", { id: item.id, version: item.version, remoteMemo: remote.memo });
    } else {
      await request("sync.outbox.discard", { id: item.id });
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("edgeever:sync-queue-changed"));
  }
  return remote.memo;
};
