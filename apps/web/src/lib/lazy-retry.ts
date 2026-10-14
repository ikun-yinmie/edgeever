import { lazy, type ComponentType } from "react";

const RELOAD_FLAG_PREFIX = "edgeever:chunk-reload:";

type FlagStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Returns true when this pane already reloaded once for a stale chunk (or
 * when storage is unavailable, where reloading could loop forever).
 */
export const consumeChunkReloadFlag = (
  storage: FlagStorage | undefined | null,
  flag: string,
): boolean => {
  try {
    if (!storage) return true;
    if (storage.getItem(RELOAD_FLAG_PREFIX + flag) === "1") return true;
    storage.setItem(RELOAD_FLAG_PREFIX + flag, "1");
    return false;
  } catch {
    return true;
  }
};

/**
 * Chunk filenames carry content hashes, so right after a redeploy a cached
 * app shell can request a chunk the server no longer serves. React would
 * otherwise land on an error screen with a working app one reload away.
 * Reload once to pick up the fresh shell; only a repeated failure surfaces
 * the real error. The flag lives in sessionStorage so every tab reloads at
 * most once per pane.
 */
export const lazyWithChunkRetry = <T extends ComponentType<any>>(
  flag: string,
  loader: () => Promise<{ default: T }>,
) =>
  lazy(async () => {
    try {
      return await loader();
    } catch (error) {
      if (!consumeChunkReloadFlag(window.sessionStorage, flag)) {
        window.location.reload();
        await new Promise<never>(() => {});
      }
      throw error;
    }
  });
