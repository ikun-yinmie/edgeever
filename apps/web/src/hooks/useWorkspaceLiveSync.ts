import { useEffect, useRef } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { getLocalSyncCursor } from "@/lib/local-mirror";
import { isBrowserOffline } from "@/lib/network-status";
import type { WorkspaceRefreshMode } from "@/lib/workspace-refresh";

/** Hold time of one watch request. Must stay below the Bun server idle timeout. */
export const LIVE_SYNC_WATCH_TIMEOUT_MS = 20_000;
export const LIVE_SYNC_RETRY_DELAY_MS = 4_000;
export const LIVE_SYNC_IDLE_POLL_DELAY_MS = 1_500;
export const LIVE_SYNC_BOOTSTRAP_WAIT_MS = 2_000;
/** Coalescing window after a received change before the next watch starts. */
export const LIVE_SYNC_SETTLE_DELAY_MS = 400;

/**
 * Cross-client freshness for ordinary notes.
 *
 * The mirror cursor is the cheapest possible change signal (one indexed
 * MAX(id)), so the client keeps a single long-poll in flight while the tab is
 * visible. A change runs the regular pull + query invalidation path, which is
 * what a focus refresh does today — only promptly. Hidden tabs fall back to a
 * short sleep and re-check their own visibility, so a phone in a pocket does
 * not hold connections open.
 *
 * Seeding from the local cursor (not from the number the server returned) means
 * a failed or skipped refresh never spins: the next watch uses the highest
 * cursor seen and still pulls everything from the mirror's own cursor.
 */
export const useWorkspaceLiveSync = ({
  enabled,
  scope,
  refreshWorkspace,
}: {
  enabled: boolean;
  scope: string;
  refreshWorkspace: (mode: WorkspaceRefreshMode) => Promise<unknown>;
}) => {
  const refreshRef = useRef(refreshWorkspace);

  useEffect(() => {
    refreshRef.current = refreshWorkspace;
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const controller = new AbortController();
    let lastSeenCursor = 0;

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const timer = window.setTimeout(done, ms);
      function done() {
        window.clearTimeout(timer);
        controller.signal.removeEventListener("abort", done);
        resolve();
      }
      controller.signal.addEventListener("abort", done);
    });

    const run = async () => {
      while (!disposed) {
        if (document.visibilityState === "hidden" || isBrowserOffline()) {
          await sleep(LIVE_SYNC_IDLE_POLL_DELAY_MS);
          continue;
        }

        let localCursor: number | null = null;
        try {
          localCursor = await getLocalSyncCursor(scope);
        } catch {
          // IndexedDB can be briefly unavailable during upgrades.
        }
        if (localCursor === null) {
          await sleep(LIVE_SYNC_BOOTSTRAP_WAIT_MS);
          continue;
        }

        const cursor = Math.max(localCursor, lastSeenCursor);
        try {
          const result = await api.syncWatch({
            cursor,
            timeoutMs: LIVE_SYNC_WATCH_TIMEOUT_MS,
            signal: controller.signal,
          });
          if (disposed) return;
          lastSeenCursor = Math.max(cursor, result.cursor);
          if (result.changed) {
            await refreshRef.current("manual");
            if (disposed) return;
            await sleep(LIVE_SYNC_SETTLE_DELAY_MS);
          }
        } catch (error) {
          if (disposed) return;
          // Older servers (or a desktop client pointed at one) have no watch
          // route: fall back to the periodic refresh instead of polling 404s.
          if (error instanceof ApiRequestError && error.status === 404) return;
          await sleep(LIVE_SYNC_RETRY_DELAY_MS);
        }
      }
    };

    void run();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [enabled, scope]);
};
