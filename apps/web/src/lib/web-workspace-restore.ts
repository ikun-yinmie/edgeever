import { normalizeWorkspaceRestoreState, type DesktopWorkspaceRestoreState } from "@/lib/desktop-workspace-restore";

export const WEB_WORKSPACE_RESTORE_STORAGE_KEY_PREFIX = "edgeever.web.workspace-restore:v1:";

export const getWebWorkspaceRestoreStorageKey = (userId: string) =>
  `${WEB_WORKSPACE_RESTORE_STORAGE_KEY_PREFIX}${userId}`;

export const readWebWorkspaceRestoreState = (
  userId: string,
  storage: (Pick<Storage, "getItem"> & Partial<Pick<Storage, "removeItem">>) | null = typeof window === "undefined" ? null : window.localStorage,
): DesktopWorkspaceRestoreState | null => {
  if (!storage || !userId) return null;
  const key = getWebWorkspaceRestoreStorageKey(userId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const state = normalizeWorkspaceRestoreState(JSON.parse(raw));
    if (!state) storage.removeItem?.(key);
    return state;
  } catch {
    try { storage.removeItem?.(key); } catch { /* Storage can be unavailable. */ }
    return null;
  }
};

export const writeWebWorkspaceRestoreState = (
  userId: string,
  state: Omit<DesktopWorkspaceRestoreState, "openMemoTabs"> & { openMemoTabs?: string[] },
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage,
) => {
  if (!storage || !userId) return false;
  try {
    storage.setItem(getWebWorkspaceRestoreStorageKey(userId), JSON.stringify(normalizeWorkspaceRestoreState(state)));
    return true;
  } catch {
    return false;
  }
};
