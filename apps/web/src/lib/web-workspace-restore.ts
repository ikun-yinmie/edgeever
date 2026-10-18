import type { DesktopWorkspaceRestoreState } from "@/lib/desktop-workspace-restore";
import type { MemoView } from "@/lib/app-helpers";

export const WEB_WORKSPACE_RESTORE_STORAGE_KEY_PREFIX = "edgeever.web.workspace-restore:v1:";

export const getWebWorkspaceRestoreStorageKey = (userId: string) =>
  `${WEB_WORKSPACE_RESTORE_STORAGE_KEY_PREFIX}${userId}`;

const isMemoView = (value: unknown): value is MemoView => value === "notebook" || value === "trash";

export const readWebWorkspaceRestoreState = (
  userId: string,
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage,
): DesktopWorkspaceRestoreState | null => {
  if (!storage || !userId) return null;
  try {
    const raw = storage.getItem(getWebWorkspaceRestoreStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DesktopWorkspaceRestoreState>;
    return {
      selectedMemoId: typeof parsed.selectedMemoId === "string" ? parsed.selectedMemoId : null,
      selectedNotebookId: typeof parsed.selectedNotebookId === "string" ? parsed.selectedNotebookId : null,
      memoView: isMemoView(parsed.memoView) ? parsed.memoView : "notebook",
    };
  } catch {
    return null;
  }
};

export const writeWebWorkspaceRestoreState = (
  userId: string,
  state: DesktopWorkspaceRestoreState,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage,
) => {
  if (!storage || !userId) return false;
  try {
    storage.setItem(getWebWorkspaceRestoreStorageKey(userId), JSON.stringify({
      selectedMemoId: state.selectedMemoId,
      selectedNotebookId: state.selectedNotebookId,
      memoView: state.memoView,
    }));
    return true;
  } catch {
    return false;
  }
};
