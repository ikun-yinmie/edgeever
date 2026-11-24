import { useCallback, useEffect, useRef, useState } from "react";
import { getStandaloneMobileEditorReturningMemoId, openStandaloneMobileEditor } from "@/lib/mobile-editor";

const MOBILE_EDITOR_QUERY = "(max-width: 639px)";

export const useStandaloneMobileEditor = ({
  memoId,
  mobileDefaultEditMemoId,
  onDefaultEditConsumed,
  readOnly,
}: {
  memoId: string | null;
  mobileDefaultEditMemoId: string | null;
  onDefaultEditConsumed: () => void;
  readOnly: boolean;
}) => {
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(MOBILE_EDITOR_QUERY).matches
  );
  const standaloneOpenMemoIdRef = useRef<string | null>(null);
  const defaultEditRequested = Boolean(memoId && memoId === mobileDefaultEditMemoId && !readOnly);
  const editingActive = isMobileViewport && defaultEditRequested;

  useEffect(() => {
    if (!isMobileViewport || !defaultEditRequested || !memoId) return;
    // WorkspaceApp owns the return handoff. Do not consume its marker here or
    // reopen a newly created note when the previous document is restored.
    if (getStandaloneMobileEditorReturningMemoId() === memoId) {
      onDefaultEditConsumed();
      return;
    }
    if (standaloneOpenMemoIdRef.current === memoId) return;

    standaloneOpenMemoIdRef.current = memoId;
    onDefaultEditConsumed();
    openStandaloneMobileEditor(memoId);
  }, [defaultEditRequested, isMobileViewport, memoId, onDefaultEditConsumed]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_EDITOR_QUERY);
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  const requestEdit = useCallback(() => {
    if (!memoId || readOnly) return;
    openStandaloneMobileEditor(memoId);
  }, [memoId, readOnly]);

  return { editingActive, requestEdit };
};
