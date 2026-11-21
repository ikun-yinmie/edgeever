// Per-account pause switches for server synchronization.
//
// Pull and push are independent: a user may keep receiving changes while
// holding local edits back, or keep uploading while freezing incoming
// snapshots. Preferences are stored per data scope (instance + account) so a
// pause on one account never leaks into another.

export type SyncDirection = "pull" | "push";

export type SyncPreferences = {
  pausePull: boolean;
  pausePush: boolean;
};

export const SYNC_PREFERENCES_CHANGED_EVENT = "edgeever:sync-preferences-changed";

const STORAGE_PREFIX = "edgeever.sync-preferences:";
const DEFAULT_PREFERENCES: SyncPreferences = { pausePull: false, pausePush: false };

// Restricted storage contexts (and non-browser hosts) keep the switch usable
// for this session instead of silently reporting "not paused".
const memoryPreferences = new Map<string, SyncPreferences>();

let activeSyncScope: string | null = null;

export const setActiveSyncScope = (scope: string | null) => {
  activeSyncScope = scope;
};

export const getActiveSyncScope = () => activeSyncScope;

const resolveScope = (scope?: string) => scope ?? activeSyncScope ?? "default";

const getStorage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const storageKey = (scope?: string) => `${STORAGE_PREFIX}${resolveScope(scope)}`;

export const getSyncPreferences = (scope?: string): SyncPreferences => {
  const key = resolveScope(scope);
  const fallback = memoryPreferences.get(key) ?? DEFAULT_PREFERENCES;
  try {
    const raw = getStorage()?.getItem(storageKey(scope));
    if (!raw) return { ...fallback };
    const parsed = JSON.parse(raw) as Partial<SyncPreferences> | null;
    return {
      pausePull: parsed?.pausePull === true,
      pausePush: parsed?.pausePush === true,
    };
  } catch {
    return { ...fallback };
  }
};

export const setSyncPreferences = (
  scope: string | undefined,
  next: SyncPreferences,
): SyncPreferences => {
  const normalized: SyncPreferences = {
    pausePull: next.pausePull === true,
    pausePush: next.pausePush === true,
  };
  const key = resolveScope(scope);
  memoryPreferences.set(key, normalized);
  try {
    getStorage()?.setItem(storageKey(scope), JSON.stringify(normalized));
  } catch {
    // Restricted storage still applies the change to this tab through memory
    // and the event below.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SYNC_PREFERENCES_CHANGED_EVENT, {
      detail: { scope: key, preferences: normalized },
    }));
  }
  return normalized;
};

export const setSyncPause = (
  direction: SyncDirection | "all",
  paused: boolean,
  scope?: string,
): SyncPreferences => {
  const current = getSyncPreferences(scope);
  return setSyncPreferences(scope, {
    pausePull: direction === "all" || direction === "pull" ? paused : current.pausePull,
    pausePush: direction === "all" || direction === "push" ? paused : current.pausePush,
  });
};

export const isSyncPaused = (scope?: string) => {
  const preferences = getSyncPreferences(scope);
  return preferences.pausePull || preferences.pausePush;
};

export const canPullFromServer = (scope?: string) => !getSyncPreferences(scope).pausePull;

export const canPushToServer = (scope?: string) => !getSyncPreferences(scope).pausePush;

export class SyncPausedError extends Error {
  readonly code = "sync_paused";
  readonly direction: SyncDirection;

  constructor(direction: SyncDirection) {
    super(direction === "pull"
      ? "服务器拉取已暂停，恢复同步后再试。"
      : "服务器上传已暂停，恢复同步后再试。");
    this.name = "SyncPausedError";
    this.direction = direction;
  }
}

export const isSyncPausedError = (error: unknown): error is SyncPausedError =>
  error instanceof SyncPausedError
  || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "sync_paused");

export const requireSyncDirection = (direction: SyncDirection, scope?: string) => {
  const paused = direction === "pull" ? !canPullFromServer(scope) : !canPushToServer(scope);
  if (paused) throw new SyncPausedError(direction);
};

export const subscribeSyncPreferences = (
  scope: string | undefined,
  listener: (preferences: SyncPreferences) => void,
) => {
  if (typeof window === "undefined") return () => undefined;
  const key = storageKey(scope);
  const read = () => listener(getSyncPreferences(scope));
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) read();
  };
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<{ scope?: string; preferences?: SyncPreferences }>).detail;
    if (!detail || detail.scope === resolveScope(scope)) {
      listener(detail?.preferences ?? getSyncPreferences(scope));
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SYNC_PREFERENCES_CHANGED_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SYNC_PREFERENCES_CHANGED_EVENT, onLocal);
  };
};