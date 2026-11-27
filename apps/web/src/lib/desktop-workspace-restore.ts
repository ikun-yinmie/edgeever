import type { MemoView } from "@/lib/app-helpers";
import { remapMemoTabs } from "@/lib/memo-tabs";

export const DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY = "edgeever.desktop.workspace-restore";

export type DesktopWorkspaceRestoreState = {
  selectedMemoId: string | null;
  selectedNotebookId: string | null;
  memoView: MemoView;
  openMemoTabs: string[];
};

type RestoreInput = Omit<DesktopWorkspaceRestoreState, "openMemoTabs"> & { openMemoTabs?: string[] };
type ReadStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem" | "removeItem">>;

const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// An absent tab list is an old snapshot. An explicit empty list means the user
// closed the last tab, and must take precedence over a stale selected memo.
export const normalizeWorkspaceRestoreState = (value: unknown): DesktopWorkspaceRestoreState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  if (!("selectedMemoId" in parsed || "selectedNotebookId" in parsed || "memoView" in parsed || "openMemoTabs" in parsed)) return null;
  const memoView = parsed.memoView === "trash" ? "trash" : "notebook";
  let selectedMemoId = isId(parsed.selectedMemoId) ? parsed.selectedMemoId : null;
  const hasTabs = Object.hasOwn(parsed, "openMemoTabs");
  const openMemoTabs = hasTabs
    ? [...new Set(Array.isArray(parsed.openMemoTabs) ? parsed.openMemoTabs.filter(isId) : [])]
    : selectedMemoId && memoView !== "trash" ? [selectedMemoId] : [];
  if (hasTabs && memoView !== "trash") {
    selectedMemoId = selectedMemoId && openMemoTabs.includes(selectedMemoId) ? selectedMemoId : openMemoTabs[0] ?? null;
  }
  return {
    selectedMemoId,
    selectedNotebookId: isId(parsed.selectedNotebookId) ? parsed.selectedNotebookId : null,
    memoView,
    openMemoTabs,
  };
};

const desktopStorageKey = (userId?: string | null) => userId
  ? `${DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY}:${userId}`
  : DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY;

export const readDesktopWorkspaceRestoreState = (
  storage: ReadStorage | null = typeof window === "undefined" ? null : window.sessionStorage,
  userId?: string | null,
): DesktopWorkspaceRestoreState | null => {
  if (!storage) return null;
  try {
    const key = desktopStorageKey(userId);
    const raw = storage.getItem(key);
    // Claim the pre-account-scoping snapshot once, so a later account cannot
    // inherit it. Do not import it when storage cannot complete the migration.
    if (!raw && userId) {
      const legacy = storage.getItem(DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY);
      if (legacy && storage.setItem && storage.removeItem) {
        storage.removeItem(DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY);
        const state = normalizeWorkspaceRestoreState(JSON.parse(legacy));
        if (state) {
          storage.setItem(key, JSON.stringify(state));
          return state;
        }
      }
    }
    if (!raw) return null;
    const state = normalizeWorkspaceRestoreState(JSON.parse(raw));
    if (!state) storage.removeItem?.(key);
    return state;
  } catch {
    try { storage.removeItem?.(desktopStorageKey(userId)); } catch { /* Storage can be unavailable. */ }
    return null;
  }
};

export const writeDesktopWorkspaceRestoreState = (
  state: RestoreInput,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.sessionStorage,
  userId?: string | null,
) => {
  if (!storage) return false;
  try {
    storage.setItem(desktopStorageKey(userId), JSON.stringify(normalizeWorkspaceRestoreState(state)));
    return true;
  } catch {
    return false;
  }
};

// Validation uses individual memo lookups, never the filtered/paginated list.
// Retain unresolved tabs on network/auth failures. Only confirmed tombstones or
// 404s remove a tab. Contents are discarded; only titles and ID mappings survive.
export const validateRestoredMemoTabs = async (
  tabs: readonly string[],
  getMemo: (id: string, includeDeleted: boolean) => Promise<{ memo: { id: string; title: string | null; isDeleted?: boolean } }>,
  shouldContinue: () => boolean = () => true,
) => {
  const removed = new Set<string>();
  const mappings = new Map<string, string>();
  const titles: Record<string, string> = {};
  // Read sequentially to bound the amount of note content held during startup.
  for (const id of tabs) {
    if (!shouldContinue()) break;
    try {
      const { memo } = await getMemo(id, true);
      if (memo.isDeleted) {
        removed.add(id);
      } else {
        if (memo.id !== id) mappings.set(id, memo.id);
        if (memo.title?.trim()) titles[memo.id] = memo.title;
      }
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 404) removed.add(id);
    }
  }
  return { removed, mappings, titles };
};

export const reconcileRestoredMemoTabs = (
  current: Pick<DesktopWorkspaceRestoreState, "openMemoTabs" | "selectedMemoId">,
  { removed, mappings }: { removed: ReadonlySet<string>; mappings: ReadonlyMap<string, string> },
) => {
  const tabs = current.openMemoTabs;
  let selected = current.selectedMemoId;
  if (selected && removed.has(selected) && tabs.includes(selected)) {
    const index = tabs.indexOf(selected);
    selected = tabs.slice(index + 1).find((id) => !removed.has(id))
      ?? tabs.slice(0, index).reverse().find((id) => !removed.has(id)) ?? null;
  }
  return {
    openMemoTabs: remapMemoTabs(tabs.filter((id) => !removed.has(id)), mappings),
    selectedMemoId: selected ? mappings.get(selected) ?? selected : null,
  };
};

export const shouldRestoreDesktopWorkspace = () =>
  typeof window !== "undefined"
  && window.edgeeverDesktop?.isAvailable === true;
