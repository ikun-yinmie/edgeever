// Yuque-style realtime collaboration: browser-side Yjs wiring.
//
// The Bun/Docker runtime hosts one CRDT room per note (see
// apps/api/src/collab-realtime.ts); this module is the other half: a
// y-websocket provider bound to a TipTap Collaboration extension, plus remote
// carets rendered from the awareness channel.
//
// The pure helpers below (URL building, peer derivation, eligibility) carry
// no DOM dependency and are covered by collab-realtime.test.mjs. The hook
// owns the provider lifecycle: one provider per (memo, enabled) pair,
// destroyed on cleanup so a closed note never leaves a ghost caret behind.

import { useEffect, useMemo, useState } from "react";
import { Extension } from "@tiptap/core";
import { yCursorPlugin } from "@tiptap/y-tiptap";
import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ShareDisplayPolicySummary } from "@edgeever/client";
import { DESKTOP_API_BASE_URL_STORAGE_KEY, getConfiguredDesktopApiBaseUrl } from "@/lib/api";

/** The Yjs fragment the Collaboration extension and the server seed share. */
export const COLLAB_DOCUMENT_FIELD = "default";

/**
 * How long a fresh provider may fail before the note falls back to the
 * presence-only mode. A refused upgrade (Cloudflare runtime, unknown note)
 * fails fast; a slow network gets the full window before we give up.
 */
export const COLLAB_UNSUPPORTED_TIMEOUT_MS = 6_000;

/** 6-digit RGB caret colors: y-prosemirror only accepts this format. */
const COLLAB_PEER_COLORS = [
  "#16A06E",
  "#2563EB",
  "#9333EA",
  "#DB2777",
  "#EA580C",
  "#CA8A04",
  "#0891B2",
  "#4F46E5",
] as const;

export type CollabRealtimePeer = {
  clientId: number;
  name: string;
  color: string;
};

export type CollabRealtimeStatus = "idle" | "connecting" | "live" | "reconnecting" | "unavailable";

export type CollabRealtimeBinding = {
  doc: Y.Doc;
  awareness: Awareness;
};

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
};

/** Stable caret color per identity, so a peer is recognizable across notes. */
export const pickCollabColor = (seed: string): string =>
  COLLAB_PEER_COLORS[hashSeed(seed || "?") % COLLAB_PEER_COLORS.length];

export const isDesktopBridgeRuntime = () =>
  typeof window !== "undefined" && Boolean(window.edgeeverDesktop?.isAvailable);

/** The API base the renderer talks to: "" means same-origin (plain web). */
export const resolveCollabApiBaseUrl = (): string => {
  if (typeof window === "undefined") return "";
  if (!isDesktopBridgeRuntime()) return "";
  try {
    const saved = window.localStorage.getItem(DESKTOP_API_BASE_URL_STORAGE_KEY) ?? "";
    if (saved.trim()) return saved.trim().replace(/\/$/, "");
  } catch {
    // Restricted storage contexts fall through to the bridge value.
  }
  try {
    return (getConfiguredDesktopApiBaseUrl() ?? "").replace(/\/$/, "");
  } catch {
    return "";
  }
};

/**
 * Browsers cannot set headers on a websocket upgrade, so same-origin web
 * clients authenticate with the session cookie (sent automatically). The
 * desktop renderer lives on a custom scheme and talks to a cross-origin API
 * base, where cookies do not travel; it passes its session token as
 * ?token=, which the socket runtime replays as a bearer.
 */
export const resolveCollabSocketToken = (): string | null => {
  if (!isDesktopBridgeRuntime()) return null;
  try {
    const token = window.edgeeverDesktop?.getSessionToken?.()?.trim() ?? "";
    return token ? token : null;
  } catch {
    return null;
  }
};

export const resolveCollabSocketParts = (options: { apiBaseUrl: string; memoId: string }) => {
  const origin = options.apiBaseUrl ? options.apiBaseUrl.replace(/\/$/, "") : window.location.origin;
  const wsOrigin = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return {
    serverUrl: `${wsOrigin}/api/v1/memos`,
    roomname: `${encodeURIComponent(options.memoId)}/collab-ws`,
  };
};

export const isDefaultCollabDisplayPolicy = (policy: ShareDisplayPolicySummary | null | undefined) =>
  !policy || (policy.html === "rendered" && policy.markdown === "rendered");

/**
 * Realtime editing is only offered where the shared Yjs document cannot leak
 * filtered content: group-shared notes the viewer may edit, with no display
 * policy applied to their view. Everyone else keeps the presence-only mode
 * (heartbeat + optimistic-lock save path) that shipped before realtime.
 */
export const shouldEnableCollabRealtime = (options: {
  isGroupShared: boolean;
  canEdit: boolean;
  isDeleted: boolean;
  displayPolicy?: ShareDisplayPolicySummary | null;
  runtimeSupportsRealtime: boolean;
}): boolean =>
  options.isGroupShared &&
  options.canEdit &&
  !options.isDeleted &&
  isDefaultCollabDisplayPolicy(options.displayPolicy) &&
  options.runtimeSupportsRealtime;

export const createCollabBinding = (): CollabRealtimeBinding => {
  const doc = new Y.Doc();
  return { doc, awareness: new Awareness(doc) };
};

/** Peer list from raw awareness states, minus ourselves and nameless ghosts. */
export const deriveCollabPeers = (
  states: Iterable<readonly [number, unknown]>,
  selfClientId: number,
): CollabRealtimePeer[] => {
  const peers: CollabRealtimePeer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const user = (state as { user?: { name?: unknown; color?: unknown } } | null)?.user;
    const name = typeof user?.name === "string" && user.name.trim() ? user.name.trim() : "";
    if (!name) continue;
    const color = typeof user?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(user.color)
      ? user.color
      : pickCollabColor(name);
    peers.push({ clientId, name, color });
  }
  peers.sort((left, right) => left.name.localeCompare(right.name));
  return peers;
};

/** Remote carets, driven by the same awareness channel the peers come from. */
export const createCollabCursorExtension = (awareness: Awareness) =>
  Extension.create({
    name: "edgeeverCollabCursor",
    addProseMirrorPlugins() {
      return [yCursorPlugin(awareness)];
    },
  });

export const useCollabRealtimeSession = (options: {
  memoId: string | null;
  enabled: boolean;
  /** Shown on our caret and in everyone else's peer list. */
  displayName: string;
  colorSeed: string;
}): {
  binding: CollabRealtimeBinding | null;
  status: CollabRealtimeStatus;
  peers: CollabRealtimePeer[];
} => {
  const { memoId, enabled, displayName, colorSeed } = options;
  const [status, setStatus] = useState<CollabRealtimeStatus>("idle");
  const [peers, setPeers] = useState<CollabRealtimePeer[]>([]);

  const binding = useMemo(
    () => (enabled && memoId ? createCollabBinding() : null),
    [enabled, memoId],
  );

  useEffect(() => {
    setPeers([]);
    if (!binding || !memoId) {
      setStatus("idle");
      return;
    }

    const apiBaseUrl = resolveCollabApiBaseUrl();
    const { serverUrl, roomname } = resolveCollabSocketParts({ apiBaseUrl, memoId });
    const token = resolveCollabSocketToken();

    let cancelled = false;
    let everSynced = false;

    const provider = new WebsocketProvider(serverUrl, roomname, binding.doc, {
      awareness: binding.awareness,
      connect: false,
      params: token ? { token } : {},
    });

    binding.awareness.setLocalState({
      user: { name: displayName, color: pickCollabColor(colorSeed || displayName) },
    });

    const refreshPeers = () => {
      if (cancelled) return;
      setPeers(deriveCollabPeers(binding.awareness.getStates().entries(), binding.doc.clientID));
    };

    const onStatus = (event: { status: "connected" | "disconnected" | "connecting" }) => {
      if (cancelled) return;
      if (event.status === "connected") {
        setStatus(everSynced ? "live" : "connecting");
        return;
      }
      if (event.status === "disconnected" && everSynced) setStatus("reconnecting");
    };

    const onSync = (synced: boolean) => {
      if (cancelled || !synced) return;
      everSynced = true;
      setStatus("live");
      refreshPeers();
    };

    const onConnectionClose = () => {
      // The desktop session token can rotate; the documented params object is
      // re-read for every new connection, so refresh it ahead of the retry.
      const freshToken = resolveCollabSocketToken();
      provider.params = freshToken ? { token: freshToken } : {};
    };

    provider.on("status", onStatus);
    provider.on("sync", onSync);
    provider.on("connection-close", onConnectionClose);
    binding.awareness.on("update", refreshPeers);
    setStatus("connecting");
    provider.connect();

    const unsupportedTimer = window.setTimeout(() => {
      // The upgrade never succeeded: this runtime serves no collaboration
      // socket (Cloudflare) or the note is gone. Stop retrying silently and
      // let the caller fall back to presence-only mode.
      if (!cancelled && !everSynced) {
        provider.disconnect();
        setStatus("unavailable");
      }
    }, COLLAB_UNSUPPORTED_TIMEOUT_MS);

    refreshPeers();

    return () => {
      cancelled = true;
      window.clearTimeout(unsupportedTimer);
      provider.off("status", onStatus);
      provider.off("sync", onSync);
      provider.off("connection-close", onConnectionClose);
      binding.awareness.off("update", refreshPeers);
      binding.awareness.setLocalState(null);
      provider.destroy();
      setPeers([]);
      setStatus("idle");
    };
  }, [binding, memoId, displayName, colorSeed]);

  return { binding, status, peers };
};
