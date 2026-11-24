import type { TiptapDoc } from "@edgeever/shared";
import { createCollabDocumentStore } from "./collab-document-store";
import { createCollabMemoWriter } from "./collab-memo-writer";
import { createCollabRoomRegistry, type CollabRoomRegistryOptions } from "./collab-realtime";
import { replaceCollabDocumentContent, resolveCollabInitialState, yjsUpdateToTiptapJson } from "./collab-seed";
import type { MemoRevisionRestoreCollab } from "./memo-revision-service";
import type { DatabaseAdapter } from "./storage-contract";

/** Storage/room coordination, independent of the websocket runtime. */
export const createMemoCollaborationService = (
  database: DatabaseAdapter,
  options: Pick<CollabRoomRegistryOptions, "onError" | "persistDebounceMs" | "idleEvictionMs"> = {},
) => {
  const documents = createCollabDocumentStore(database);
  const writer = createCollabMemoWriter(database);
  const baseHashes = new Map<string, string | null>();
  const rooms = createCollabRoomRegistry({
    ...options,
    loadState: async (memoId) => {
      const [persisted, memo] = await Promise.all([
        documents.loadWithHash(memoId),
        database.prepare(
          `SELECT c.content_json, c.content_hash
           FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
           WHERE m.id = ? AND m.is_deleted = 0`,
        ).bind(memoId).first<{ content_json: string; content_hash: string }>(),
      ]);
      if (!memo) {
        baseHashes.delete(memoId);
        return null;
      }
      let contentJson: unknown = null;
      try { contentJson = JSON.parse(memo.content_json); } catch { /* Keep the usable cache fallback. */ }
      baseHashes.set(memoId, memo.content_hash);
      return resolveCollabInitialState({
        persistedState: persisted.state,
        persistedContentHash: persisted.contentHash,
        memoContentJson: contentJson,
        memoContentHash: memo.content_hash,
      });
    },
    persistState: async (memoId, state, actorLabel) => {
      const contentJson = yjsUpdateToTiptapJson(state);
      if (!contentJson) throw new Error("Collaboration state is unreadable");
      const result = await writer.materialize(memoId, contentJson as TiptapDoc, {
        actorLabel,
        expectedContentHash: baseHashes.get(memoId) ?? null,
        state,
      });
      if (result.contentHash) baseHashes.set(memoId, result.contentHash);
    },
  });

  // The same port handles ordinary document saves and explicit restores.
  // Pause/drain before reading the memo, commit both representations in one
  // batch, then update connected peers before intake resumes.
  const restore: MemoRevisionRestoreCollab = {
    begin: (memoId) => rooms.beginRestore(memoId),
    prepare: async (memoId, content, liveState) => {
      const state = liveState ?? await documents.load(memoId);
      // Notes that never used collaboration need no redundant CRDT copy.
      if (!state) return null;
      let nextState: Uint8Array;
      try {
        nextState = replaceCollabDocumentContent(state, content.contentJson);
      } catch {
        // A corrupt cache must not prevent an otherwise valid bound save.
        nextState = replaceCollabDocumentContent(null, content.contentJson);
      }
      return {
        statement: documents.prepareSaveWithHash(memoId, nextState, content.contentHash),
        apply: async () => {
          if (baseHashes.has(memoId)) baseHashes.set(memoId, content.contentHash);
          await rooms.applyRestoredState(memoId, nextState);
        },
      };
    },
    end: (memoId) => rooms.endRestore(memoId),
  };

  // Only drain rooms that accepted edits. Never sweep historical cache rows:
  // an inactive cache may predate many successful non-collaboration saves.
  return { rooms, restore, shutdown: () => rooms.shutdown() };
};
