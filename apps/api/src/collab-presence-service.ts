// Advisory "who is editing this note right now" for group collaboration.
//
// Rows are ephemeral and non-authoritative: the write path still goes through
// the memo edit-session optimistic lock. Presence only powers the Yuque-style
// collaborator bar, so stale entries simply expire.

import { isoNow } from "./entity-utils";
import type { DatabaseAdapter } from "./storage-contract";

export const COLLAB_PRESENCE_TTL_MS = 30 * 1000;
const EXPIRED_CLEANUP_PROBABILITY = 0.1;

export type CollabPeer = {
  actorId: string;
  actorType: "user" | "agent";
  displayName: string | null;
  lastSeenAt: string;
  /** True when this row belongs to the calling actor. */
  isSelf: boolean;
};

type PresenceRow = {
  actor_id: string;
  actor_type: "user" | "agent";
  display_name: string | null;
  last_seen_at: string;
};

/** Periodically drop expired rows without paying a DELETE on every heartbeat. */
const cleanupIfNeeded = async (database: DatabaseAdapter, now: string) => {
  if (Math.random() >= EXPIRED_CLEANUP_PROBABILITY) return;
  await database.prepare(`DELETE FROM memo_collab_presence WHERE expires_at <= ?`).bind(now).run();
};

export const touchCollabPresence = async (
  database: DatabaseAdapter,
  input: {
    memoId: string;
    actorId: string;
    actorType: "user" | "agent";
    displayName: string | null;
  },
) => {
  const now = isoNow();
  const expiresAt = new Date(Date.now() + COLLAB_PRESENCE_TTL_MS).toISOString();
  await database
    .prepare(
      `INSERT INTO memo_collab_presence (memo_id, actor_id, actor_type, display_name, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memo_id, actor_id) DO UPDATE SET
         display_name = excluded.display_name,
         last_seen_at = excluded.last_seen_at,
         expires_at = excluded.expires_at`,
    )
    .bind(input.memoId, input.actorId, input.actorType, input.displayName, now, expiresAt)
    .run();
  await cleanupIfNeeded(database, now);
};

export const releaseCollabPresence = async (database: DatabaseAdapter, memoId: string, actorId: string) => {
  await database
    .prepare(`DELETE FROM memo_collab_presence WHERE memo_id = ? AND actor_id = ?`)
    .bind(memoId, actorId)
    .run();
};

export const listCollabPeers = async (
  database: DatabaseAdapter,
  memoId: string,
  currentActorId: string,
): Promise<CollabPeer[]> => {
  const now = isoNow();
  const rows = await database
    .prepare(
      `SELECT actor_id, actor_type, display_name, last_seen_at
       FROM memo_collab_presence
       WHERE memo_id = ? AND expires_at > ?
       ORDER BY last_seen_at ASC
       LIMIT 50`,
    )
    .bind(memoId, now)
    .all<PresenceRow>();
  return (rows.results ?? []).map((row) => ({
    actorId: row.actor_id,
    actorType: row.actor_type,
    displayName: row.display_name,
    lastSeenAt: row.last_seen_at,
    isSelf: row.actor_id === currentActorId,
  }));
};
