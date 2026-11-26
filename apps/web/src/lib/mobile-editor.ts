import { getAppEntryPath, getAppPagePath } from "@/lib/app-page-path";
import { getActiveSyncScope } from "@/lib/sync-preferences";

export const STANDALONE_MOBILE_EDITOR_PATH = getAppPagePath("mobile-edit.html", import.meta.env.BASE_URL);
export const MOBILE_EDITOR_RETURN_PARAM = "mobileEditorReturn";
const STANDALONE_MOBILE_EDITOR_MEMO_KEY = "edgeever-standalone-mobile-editor-memo-id";
const STANDALONE_MOBILE_EDITOR_RETURN_KEY = "edgeever-standalone-mobile-editor-return-memo-id";
const STANDALONE_MOBILE_EDITOR_RETURN_PREVIEW_KEY = "edgeever-standalone-mobile-editor-return-preview";
// The editor runs in its own document and cannot reach the workspace's
// repository. Hand it the mirror scope through sessionStorage so its saves can
// update the same IndexedDB rows the returned preview reads.
const STANDALONE_MOBILE_EDITOR_SCOPE_KEY = "edgeever-standalone-mobile-editor-scope";

export type MobileEditorReturnPreview = {
  memoId: string;
  baseRevision: number;
  title: string | null;
  excerpt: string;
  tags: string[];
  updatedAt: string;
};

// The standalone web editor opens in a separate document and creates a server
// edit session immediately, so it must never receive a local-first temporary ID.
export const requiresRemoteMemoForStandaloneMobileEditor = ({
  mobileViewport,
  desktopRuntime,
}: {
  mobileViewport: boolean;
  desktopRuntime: boolean;
}) => mobileViewport && !desktopRuntime;

export const getStandaloneMobileEditorReturnPath = (memoId: string) => {
  const params = new URLSearchParams({
    [MOBILE_EDITOR_RETURN_PARAM]: memoId,
  });

  return `${getAppEntryPath(import.meta.env.BASE_URL)}?${params.toString()}`;
};

export const getStandaloneMobileEditorHref = (memoId: string, returnTo = getStandaloneMobileEditorReturnPath(memoId)) => {
  const params = new URLSearchParams({
    memoId,
    returnTo,
  });
  return `${STANDALONE_MOBILE_EDITOR_PATH}#${params.toString()}`;
};

export const openStandaloneMobileEditor = (memoId: string, returnTo = getStandaloneMobileEditorReturnPath(memoId)) => {
  markStandaloneMobileEditorOpened(memoId);
  window.location.href = getStandaloneMobileEditorHref(memoId, returnTo);
};

export const markStandaloneMobileEditorOpened = (memoId: string, scope: string | null = getActiveSyncScope()) => {
  sessionStorage.setItem(STANDALONE_MOBILE_EDITOR_MEMO_KEY, memoId);
  sessionStorage.removeItem(STANDALONE_MOBILE_EDITOR_RETURN_KEY);
  sessionStorage.removeItem(STANDALONE_MOBILE_EDITOR_RETURN_PREVIEW_KEY);
  if (scope) {
    sessionStorage.setItem(STANDALONE_MOBILE_EDITOR_SCOPE_KEY, scope);
  } else {
    sessionStorage.removeItem(STANDALONE_MOBILE_EDITOR_SCOPE_KEY);
  }
};

/** Mirror scope of the workspace that opened the editor, if it handed one over. */
export const getStandaloneMobileEditorScope = () =>
  sessionStorage.getItem(STANDALONE_MOBILE_EDITOR_SCOPE_KEY);

export const markStandaloneMobileEditorReturning = (memoId: string | null) => {
  if (!memoId) {
    return;
  }

  sessionStorage.setItem(STANDALONE_MOBILE_EDITOR_RETURN_KEY, memoId);
};

export const getStandaloneMobileEditorReturningMemoId = () =>
  sessionStorage.getItem(STANDALONE_MOBILE_EDITOR_RETURN_KEY);

export const writeMobileEditorReturnPreview = (preview: MobileEditorReturnPreview) => {
  sessionStorage.setItem(STANDALONE_MOBILE_EDITOR_RETURN_PREVIEW_KEY, JSON.stringify(preview));
};

export const readMobileEditorReturnPreview = (memoId: string | null): MobileEditorReturnPreview | null => {
  if (!memoId) {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(STANDALONE_MOBILE_EDITOR_RETURN_PREVIEW_KEY);
    const preview = raw ? (JSON.parse(raw) as Partial<MobileEditorReturnPreview>) : null;

    if (
      preview?.memoId !== memoId ||
      typeof preview.baseRevision !== "number" ||
      typeof preview.excerpt !== "string" ||
      !Array.isArray(preview.tags) ||
      typeof preview.updatedAt !== "string"
    ) {
      return null;
    }

    return {
      memoId: preview.memoId,
      baseRevision: preview.baseRevision,
      title: typeof preview.title === "string" ? preview.title : null,
      excerpt: preview.excerpt,
      tags: preview.tags.filter((tag): tag is string => typeof tag === "string"),
      updatedAt: preview.updatedAt,
    };
  } catch {
    return null;
  }
};

export const clearMobileEditorReturnPreview = (memoId: string | null) => {
  const preview = readMobileEditorReturnPreview(memoId);
  if (preview) {
    sessionStorage.removeItem(STANDALONE_MOBILE_EDITOR_RETURN_PREVIEW_KEY);
  }
};

export const consumeStandaloneMobileEditorReturn = (memoId: string | null) => {
  if (!memoId) {
    return false;
  }

  const returningMemoId = sessionStorage.getItem(STANDALONE_MOBILE_EDITOR_RETURN_KEY);
  const matched = returningMemoId === memoId;

  if (matched) {
    sessionStorage.removeItem(STANDALONE_MOBILE_EDITOR_RETURN_KEY);
    sessionStorage.removeItem(STANDALONE_MOBILE_EDITOR_MEMO_KEY);
  }

  return matched;
};
