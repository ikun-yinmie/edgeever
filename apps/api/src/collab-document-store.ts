// Persistence for merged Yjs collaboration documents.
//
// The websocket layer is runtime-specific (only the Bun/Docker runtime serves
// collaboration sockets), but reading and writing the merged CRDT state is
// plain storage work, so it lives here behind the shared DatabaseAdapter and
// stays testable without a socket.
//
// `content_hash` shadows the memo's content hash at the moment the merged
// state was last materialized back into memo_contents (see
// collab-memo-writer.ts). When a room opens, the persisted state is only
// reused when the hashes still match; a non-collaboration writer (mobile,
// desktop outbox, LWW web path) leaves the hashes out of sync and the room
// is re-seeded from the memo content instead of resurrecting a stale merge.

import type { DatabaseAdapter } from "./storage-contract";

/** SQLite hands back a Uint8Array; D1 hands back an ArrayBuffer. */
const toStateBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  // Some drivers expose BLOBs as plain byte arrays.
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return new Uint8Array(value as number[]);
  }
  return null;
};

export type CollabDocumentStore = {
  load: (memoId: string) => Promise<Uint8Array | null>;
  /** The state plus the content hash it was last materialized with. */
  loadWithHash: (memoId: string) => Promise<{ state: Uint8Array | null; contentHash: string | null }>;
  save: (memoId: string, state: Uint8Array) => Promise<void>;
  /** Persist the state and declare it materialized at the given content hash. */
  saveWithHash: (memoId: string, state: Uint8Array, contentHash: string) => Promise<void>;
  /** Record a materialization without rewriting the state blob. */
  setContentHash: (memoId: string, contentHash: string) => Promise<void>;
  remove: (memoId: string) => Promise<void>;
};

export const createCollabDocumentStore = (database: DatabaseAdapter): CollabDocumentStore => {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function"
  ) {
    throw new Error("createCollabDocumentStore requires a database adapter with a prepare() method");
  }
  return {
    load: async (memoId: string) => {
      const row = await database
        .prepare(`SELECT state FROM memo_collab_documents WHERE memo_id = ?`)
        .bind(memoId)
        .first<{ state: unknown }>();
      return toStateBytes(row?.state ?? null);
    },

    loadWithHash: async (memoId: string) => {
      const row = await database
        .prepare(`SELECT state, content_hash FROM memo_collab_documents WHERE memo_id = ?`)
        .bind(memoId)
        .first<{ state: unknown; content_hash: unknown }>();
      return {
        state: toStateBytes(row?.state ?? null),
        contentHash: typeof row?.content_hash === "string" && row.content_hash ? row.content_hash : null,
      };
    },

    save: async (memoId: string, state: Uint8Array) => {
      await database
        .prepare(
          `INSERT INTO memo_collab_documents (memo_id, state, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(memo_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        )
        .bind(memoId, state, new Date().toISOString())
        .run();
    },

    saveWithHash: async (memoId: string, state: Uint8Array, contentHash: string) => {
      await database
        .prepare(
          `INSERT INTO memo_collab_documents (memo_id, state, content_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(memo_id) DO UPDATE SET
             state = excluded.state,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at`,
        )
        .bind(memoId, state, contentHash, new Date().toISOString())
        .run();
    },

    setContentHash: async (memoId: string, contentHash: string) => {
      await database
        .prepare(`UPDATE memo_collab_documents SET content_hash = ? WHERE memo_id = ?`)
        .bind(contentHash, memoId)
        .run();
    },

    remove: async (memoId: string) => {
      await database
        .prepare(`DELETE FROM memo_collab_documents WHERE memo_id = ?`)
        .bind(memoId)
        .run();
    },
  };
};