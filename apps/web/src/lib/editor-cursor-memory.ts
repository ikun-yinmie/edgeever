export type EditorCursorSnapshot = {
  from: number;
  to: number;
  updatedAt: number;
};

const STORAGE_KEY = "edgeever.editor-cursor-positions.v1";
const MAX_ENTRIES = 400;

type CursorMap = Record<string, EditorCursorSnapshot>;

const getStorage = (): Storage | null => {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
};

const isSnapshot = (value: unknown): value is EditorCursorSnapshot => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EditorCursorSnapshot>;
  return Number.isInteger(candidate.from)
    && Number.isInteger(candidate.to)
    && (candidate.from ?? 0) >= 1
    && (candidate.to ?? 0) >= (candidate.from ?? 0)
    && typeof candidate.updatedAt === "number";
};

const readMap = (): CursorMap => {
  const storage = getStorage();
  if (!storage) return {};

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => isSnapshot(value)),
    ) as CursorMap;
  } catch {
    return {};
  }
};

const writeMap = (map: CursorMap) => {
  const storage = getStorage();
  if (!storage) return;

  const entries = Object.entries(map);
  const trimmed = entries.length <= MAX_ENTRIES
    ? entries
    : entries
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_ENTRIES);

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Storage can be full or blocked (private mode); cursor memory is optional.
  }
};

export const readEditorCursor = (memoId: string): EditorCursorSnapshot | null => {
  if (!memoId) return null;
  return readMap()[memoId] ?? null;
};

export const writeEditorCursor = (memoId: string, from: number, to: number) => {
  if (!memoId || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return;
  }

  const map = readMap();
  map[memoId] = { from, to, updatedAt: Date.now() };
  writeMap(map);
};

export const clearEditorCursor = (memoId: string) => {
  if (!memoId) return;
  const map = readMap();
  if (!(memoId in map)) return;
  delete map[memoId];
  writeMap(map);
};
