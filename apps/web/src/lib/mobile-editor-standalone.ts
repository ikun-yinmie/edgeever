import { emptyDoc, resolveMemoContentDoc, type MemoDetail, type Resource, type TiptapDoc } from "@edgeever/shared";
import { ApiRequestError, api } from "@/lib/api";

export const MOBILE_EDITOR_INITIAL_FOCUS_DELAY_MS = 160;
export const MOBILE_EDITOR_DRAFT_STORAGE_PREFIX = "edgeever-mobile-tiptap-draft:";
export const DEFAULT_MOBILE_EDITOR_MEMO_TITLE = "无标题笔记";

export type MobileEditorMemoResponse = {
  memo: MemoDetail;
};

export type MobileEditorResourceResponse = {
  resource: Resource;
};

export type MobileEditorDraft = {
  expectedRevision?: number;
  title: string;
  tagsText: string;
  contentJson: TiptapDoc;
  updatedAt: string;
};

export type MobileEditorSaveState =
  | "loading"
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "compressing"
  | "uploading"
  | "error"
  | "local-draft"
  | "leaving";

export const getMobileEditorSaveLabel = (saveState: MobileEditorSaveState) =>
  saveState === "loading"
    ? "加载中"
    : saveState === "saving"
      ? "保存中"
      : saveState === "compressing"
        ? "压缩中"
        : saveState === "uploading"
          ? "上传中"
          : saveState === "dirty"
            ? "未保存"
            : saveState === "saved"
              ? "已保存"
              : saveState === "local-draft"
                ? "本地草稿"
                : saveState === "leaving"
                  ? "返回中"
                  : saveState === "error"
                    ? "保存失败"
                    : "已保存";

export const getMobileEditorStatusClassName = (saveState: MobileEditorSaveState) =>
  saveState === "error"
    ? "error"
    : saveState === "dirty" || saveState === "saving" || saveState === "compressing" || saveState === "uploading" || saveState === "leaving"
      ? "active"
      : "";

export const getMobileEditorParams = () =>
  new URLSearchParams(window.location.hash ? window.location.hash.slice(1) : window.location.search);

export const getMobileEditorDraftKey = (memoId: string | null) =>
  memoId ? `${MOBILE_EDITOR_DRAFT_STORAGE_PREFIX}${memoId}` : "";

export const parseMobileEditorTags = (value: string) =>
  value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

export const safeMobileEditorReturnPath = (value: string | null) => {
  const fallback = import.meta.env.BASE_URL.startsWith(".")
    ? `${import.meta.env.BASE_URL}index.html`
    : import.meta.env.BASE_URL;

  if (value?.startsWith("/")) return value;
  if (import.meta.env.BASE_URL.startsWith(".") && value?.startsWith(`${import.meta.env.BASE_URL}index.html`)) {
    return value;
  }
  return fallback;
};

/**
 * Every standalone-editor request must settle. Without a deadline a stalled
 * connection leaves `saveNow` pending forever, which keeps the header in
 * "saving" (Done disabled) and the document read-only after `leavePage` froze
 * it. 408 is already treated as a retryable save error by the sync queue.
 */
export const MOBILE_EDITOR_REQUEST_TIMEOUT_MS = 20_000;

export const requestMobileEditorJson = async <T,>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> => {
  const { timeoutMs = MOBILE_EDITOR_REQUEST_TIMEOUT_MS, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers);
  const isFormData = requestInit.body instanceof FormData;

  if (!isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetch(path, {
      credentials: "include",
      ...requestInit,
      headers,
      signal: controller.signal,
    });
  } catch (requestError) {
    if (controller.signal.aborted) {
      throw new ApiRequestError("请求超时，请检查网络后重试", 408, "REQUEST_TIMEOUT");
    }
    throw requestError;
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = body && typeof body === "object" && "error" in body ? (body as { error?: { code?: string; message?: string } }).error : undefined;
    const message =
      body && typeof body === "object" && "error" in body
        ? error?.message
        : response.statusText;
    throw new ApiRequestError(message || "Request failed", response.status, error?.code);
  }

  return response.json() as Promise<T>;
};

export const uploadMobileEditorResource = async (memoId: string, file: File) => {
  return api.uploadMemoResource(memoId, file);
};

export const normalizeMobileEditorDoc = (memo: MemoDetail): TiptapDoc => {
  if (!memo.contentJson && !memo.contentMarkdown) {
    return emptyDoc();
  }

  return resolveMemoContentDoc(memo.contentJson, memo.contentMarkdown);
};
