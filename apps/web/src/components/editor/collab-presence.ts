// Yuque-style collaboration helpers for the editor pane.
//
// The API keeps the optimistic-lock save path authoritative; this module only
// adds the collaborative feel:
//   - a presence heartbeat while a shared note is open and editable,
//   - a friendly conflict description when another member saved first
//     (revision_conflict), so the editor can offer "load latest" instead of a
//     bare error.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { CollabPeer } from "@edgeever/client";

const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const POLL_INTERVAL_MS = 8 * 1000;

export type CollabConflictInfo = {
  /** Latest revision the server holds, when the error carries it. */
  currentRevision: number | null;
  occurredAt: number;
};

/**
 * Shared-editing awareness for one open memo. Presence is advisory: a failing
 * heartbeat must never disturb typing, so every error is swallowed.
 */
export const useCollabPresence = (options: {
  memoId: string | null;
  /** Only ping while the note is actually writable by this account. */
  enabled: boolean;
}) => {
  const { memoId, enabled } = options;
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const timerRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const lastBeatRef = useRef(0);

  useEffect(() => {
    setPeers([]);
    if (!memoId || !enabled) return;

    let cancelled = false;

    const beat = async () => {
      const now = Date.now();
      if (now - lastBeatRef.current < HEARTBEAT_INTERVAL_MS - 1000) return;
      lastBeatRef.current = now;
      try {
        const body = await api.collabHeartbeat(memoId);
        if (!cancelled) setPeers(body.peers);
      } catch {
        // Presence is best-effort; ignore auth/permission hiccups.
      }
    };

    const poll = async () => {
      try {
        const body = await api.collabState(memoId);
        if (!cancelled) setPeers(body.peers);
      } catch {
        // Ignore.
      }
    };

    void beat();
    pollTimerRef.current = window.setInterval(poll, POLL_INTERVAL_MS);
    timerRef.current = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);

    const release = () => {
      void api.collabRelease(memoId).catch(() => undefined);
    };
    window.addEventListener("pagehide", release);

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [memoId, enabled]);

  return { peers };
};

/** Turn a raw save error into collaboration info, when it is a revision conflict. */
export const describeCollabConflict = async (error: unknown): Promise<CollabConflictInfo | null> => {
  if (!(error instanceof Error)) return null;
  const apiError = error as Error & { code?: string; details?: { currentRevision?: number } };
  if (apiError.code !== "revision_conflict" && apiError.code !== "content_conflict") return null;
  return {
    currentRevision:
      typeof apiError.details?.currentRevision === "number" ? apiError.details.currentRevision : null,
    occurredAt: Date.now(),
  };
};

/** Format peer names for the collaborator bar: "你 · Alice · Bob". */
export const formatCollabPeerNames = (peers: CollabPeer[], selfLabel: string) => {
  const others = peers.filter((peer) => !peer.isSelf);
  const names = others.map((peer) => peer.displayName || peer.actorId);
  return [selfLabel, ...names].join(" · ");
};

export const useCollabConflict = () => {
  const [conflict, setConflict] = useState<CollabConflictInfo | null>(null);
  const reportConflict = useCallback(async (error: unknown) => {
    const info = await describeCollabConflict(error);
    if (info) setConflict(info);
    return info;
  }, []);
  const clearConflict = useCallback(() => setConflict(null), []);
  return { conflict, reportConflict, clearConflict };
};
