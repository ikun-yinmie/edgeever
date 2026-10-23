import { useEffect, useRef } from "react";
import { isBrowserOffline } from "@/lib/network-status";
import { flushEditorBeforeUpdateInstall } from "@/lib/update-install-flush";

type UpdateInstallPreparation = {
  ok: boolean;
  reason?: string | null;
  pending?: number;
};

/**
 * Desktop installs ask the renderer to persist the active draft, push every
 * queued local change to the server, and confirm the queue is empty. If any
 * step fails the main process cancels the restart instead of risking notes
 * that only exist locally.
 */
export const useDesktopUpdateInstallGuard = (runQueuedSync: () => Promise<void>) => {
  const runQueuedSyncRef = useRef(runQueuedSync);

  useEffect(() => {
    runQueuedSyncRef.current = runQueuedSync;
  }, [runQueuedSync]);

  useEffect(() => {
    const bridge = window.edgeeverDesktop;
    if (!bridge?.isAvailable || !bridge.onUpdateInstallPrepare) return;

    return bridge.onUpdateInstallPrepare(async (): Promise<UpdateInstallPreparation> => {
      try {
        await flushEditorBeforeUpdateInstall();
        if (isBrowserOffline()) {
          return { ok: false, reason: "offline", pending: 0 };
        }
        await runQueuedSyncRef.current();
        const { getDesktopSyncSummary } = await import("@/lib/desktop-sync");
        const summary = await getDesktopSyncSummary();
        if (summary.total === 0) {
          return { ok: true, reason: null, pending: 0 };
        }
        return {
          ok: false,
          reason: summary.conflict > 0 ? "sync-conflict" : "sync-pending",
          pending: summary.total,
        };
      } catch {
        return { ok: false, reason: "sync-failed", pending: 0 };
      }
    });
  }, []);
};
