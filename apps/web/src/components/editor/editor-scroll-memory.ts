import { getEditorScrollProgress, restoreEditorScrollProgress } from "./editor-mode-scroll";

export const EDITOR_SCROLL_MEMORY_STORAGE_KEY = "edgeever.editor.scroll-memory:v1";
const MAX_ENTRIES = 40;

type ScrollMetrics = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type EditorScrollMemoryEntry = {
  progress: number;
  scrollHeight: number;
  scrollTop: number;
  updatedAt: number;
};

type EditorScrollMemory = Record<string, EditorScrollMemoryEntry>;

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isEntry = (value: unknown): value is EditorScrollMemoryEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<EditorScrollMemoryEntry>;
  return isFiniteNumber(entry.progress)
    && isFiniteNumber(entry.scrollHeight)
    && isFiniteNumber(entry.scrollTop)
    && isFiniteNumber(entry.updatedAt);
};

const readAll = (storage: StorageLike): EditorScrollMemory => {
  try {
    const raw = storage.getItem(EDITOR_SCROLL_MEMORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const entries: EditorScrollMemory = {};
    for (const [memoId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (memoId && isEntry(value)) entries[memoId] = value;
    }
    return entries;
  } catch {
    return {};
  }
};

export const readEditorScrollMemory = (
  memoId: string,
  storage: StorageLike | null = defaultStorage(),
): EditorScrollMemoryEntry | null => {
  if (!memoId || !storage) return null;
  return readAll(storage)[memoId] ?? null;
};

export const writeEditorScrollMemory = (
  memoId: string,
  entry: EditorScrollMemoryEntry,
  storage: StorageLike | null = defaultStorage(),
) => {
  if (!memoId || !storage) return false;
  try {
    const entries = readAll(storage);
    entries[memoId] = entry;
    const trimmed = Object.entries(entries)
      .sort(([, first], [, second]) => second.updatedAt - first.updatedAt)
      .slice(0, MAX_ENTRIES);
    storage.setItem(EDITOR_SCROLL_MEMORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
    return true;
  } catch {
    return false;
  }
};

export const captureEditorScrollMemory = (
  element: ScrollMetrics | null,
  updatedAt = Date.now(),
): EditorScrollMemoryEntry | null => {
  if (!element) return null;
  return {
    progress: getEditorScrollProgress(element),
    scrollHeight: Math.max(0, element.scrollHeight),
    scrollTop: Math.max(0, element.scrollTop),
    updatedAt,
  };
};

export const restoreEditorScrollMemory = (
  element: ScrollMetrics | null,
  entry: EditorScrollMemoryEntry,
) => {
  if (!element) return false;
  restoreEditorScrollProgress(element, entry.progress);
  if (Math.abs(element.scrollHeight - entry.scrollHeight) <= 2) {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(Math.max(0, entry.scrollTop), maxScrollTop);
  }
  return true;
};
