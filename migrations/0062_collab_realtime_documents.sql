-- 0062: Realtime collaboration documents.
--
-- The Yuque-style collaboration bar (0061) is presence-only and keeps the
-- optimistic-lock save path authoritative. Real concurrent editing needs a
-- CRDT document that every participant merges into, so the merged Yjs state
-- is persisted here and replayed to later joiners.
--
-- `state` holds a single merged Yjs update (Y.encodeStateAsUpdate). Storing one
-- row per note keeps reads to a point lookup; the conflict-free merge itself
-- happens in the Yjs document, not in SQL.
--
-- `content_hash` shadows the memo's content hash at the moment `state` was
-- last materialized back into memo_contents. On room open the persisted state
-- is reused only while the hashes match; a non-collaboration writer (mobile,
-- desktop outbox, or the LWW web path) leaves them out of sync and the room is
-- re-seeded from the memo content instead of resurrecting a stale merge.
--
-- The table is additive and harmless to every other runtime: the desktop
-- sidecar applies the same migration files to its local SQLite database and
-- simply never uses this table, and the Cloudflare D1 deployment only stores
-- rows once a Bun/Docker runtime serves a collaboration socket.

CREATE TABLE IF NOT EXISTS memo_collab_documents (
  memo_id TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  content_hash TEXT,
  updated_at TEXT NOT NULL
);
