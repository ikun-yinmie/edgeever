import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isPathInside, normalizeStorageDirectory } from "./storage-location.mjs";

export const MARKDOWN_MIRROR_CONFIG_FILE = "markdown-mirror.json";
export const MARKDOWN_MIRROR_MANIFEST_FILE = ".edgeever-mirror.json";
export const MARKDOWN_MIRROR_MANIFEST_VERSION = 1;
export const MARKDOWN_MIRROR_DEFAULT_ENABLED = true;
export const MARKDOWN_MIRROR_UNSORTED_DIRECTORY = "Unsorted";

const DEFAULT_FALLBACK_TITLE = "Untitled";
const MAX_PATH_SEGMENT_LENGTH = 80;
const MAX_NOTEBOOK_DEPTH = 8;
// Windows still enforces MAX_PATH for many tools, so the folder part of the
// mirror path stays short even when users nest long notebook names.
const MAX_DIRECTORY_PATH_LENGTH = 100;
const MAX_MEMO_PAGES = 500;
const MEMO_PAGE_SIZE = 200;

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const markdownMirrorConfigPath = (userDataDirectory) =>
  join(userDataDirectory, MARKDOWN_MIRROR_CONFIG_FILE);

export const normalizeMirrorDirectory = (value) => normalizeStorageDirectory(value);

const shortId = (memoId) => String(memoId).replace(/[^A-Za-z0-9_-]/g, "").slice(-6) || "note";

const truncate = (value, maximum) => (value.length > maximum ? value.slice(0, maximum).trim() : value);

// Titles, notebook names and tag values are user-controlled, so every path
// segment is stripped of characters that break Windows, macOS or Linux paths.
export const sanitizePathSegment = (value, fallback = DEFAULT_FALLBACK_TITLE) => {
  let segment = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  segment = truncate(segment, MAX_PATH_SEGMENT_LENGTH);
  if (!segment || segment === "." || segment === "..") segment = fallback;
  if (WINDOWS_RESERVED_NAMES.test(segment)) segment = `_${segment}`;
  return segment;
};

const firstMeaningfulLine = (value) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? truncate(text, 60) : "";
};

const siblingNameConflicts = (notebook, name, notebooks) =>
  notebooks.some((candidate) =>
    candidate.id !== notebook.id
    && (candidate.parentId ?? null) === (notebook.parentId ?? null)
    && sanitizePathSegment(candidate.name, MARKDOWN_MIRROR_UNSORTED_DIRECTORY) === name);

// Notes are grouped by their notebook hierarchy so the mirror reads like a
// normal folder tree. Duplicate sibling names stay separate instead of being
// silently merged into one folder.
export const notebookDirectorySegments = (notebooks, notebookId, unsortedName = MARKDOWN_MIRROR_UNSORTED_DIRECTORY) => {
  const byId = new Map((Array.isArray(notebooks) ? notebooks : []).map((notebook) => [notebook.id, notebook]));
  const segments = [];
  const seen = new Set();
  let currentId = notebookId ?? null;
  while (currentId && !seen.has(currentId) && segments.length < MAX_NOTEBOOK_DEPTH) {
    seen.add(currentId);
    const notebook = byId.get(currentId);
    if (!notebook) break;
    let name = sanitizePathSegment(notebook.name, unsortedName);
    if (siblingNameConflicts(notebook, name, notebooks)) {
      name = `${truncate(name, MAX_PATH_SEGMENT_LENGTH - 9)} (${shortId(notebook.id)})`;
    }
    segments.unshift(name);
    currentId = notebook.parentId ?? null;
  }
  if (segments.length === 0) return [unsortedName];
  const directoryLength = segments.reduce((total, segment) => total + segment.length, 0) + segments.length - 1;
  if (directoryLength <= MAX_DIRECTORY_PATH_LENGTH) return segments;
  const budget = Math.max(12, Math.floor((MAX_DIRECTORY_PATH_LENGTH - (segments.length - 1)) / segments.length));
  return segments.map((segment) => truncate(segment, budget));
};

const uniqueEntryPath = (directorySegments, title, memoId, usedPaths) => {
  const base = `${truncate(title, MAX_PATH_SEGMENT_LENGTH - 12)}.md`;
  const prefix = directorySegments.length > 0 ? `${directorySegments.join("/")}/` : "";
  let candidate = `${prefix}${base}`;
  if (usedPaths.has(candidate.toLowerCase())) {
    candidate = `${prefix}${truncate(title, MAX_PATH_SEGMENT_LENGTH - 22)} (${shortId(memoId)}).md`;
  }
  let counter = 2;
  while (usedPaths.has(candidate.toLowerCase())) {
    candidate = `${prefix}${truncate(title, MAX_PATH_SEGMENT_LENGTH - 26)} (${shortId(memoId)}) ${counter}.md`;
    counter += 1;
  }
  return candidate;
};

export const buildMirrorEntries = ({
  notebooks = [],
  memos = [],
  fallbackTitle = DEFAULT_FALLBACK_TITLE,
  unsortedName = MARKDOWN_MIRROR_UNSORTED_DIRECTORY,
} = {}) => {
  const directoryCache = new Map();
  const usedPaths = new Set();
  const entries = [];
  const ordered = [...memos].sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")));
  for (const memo of ordered) {
    if (!memo?.id) continue;
    const notebookId = memo.notebookId ?? "";
    if (!directoryCache.has(notebookId)) {
      directoryCache.set(notebookId, notebookDirectorySegments(notebooks, notebookId, unsortedName));
    }
    const directorySegments = directoryCache.get(notebookId);
    const title = sanitizePathSegment(
      String(memo.title ?? "").trim() || firstMeaningfulLine(memo.excerpt) || fallbackTitle,
      fallbackTitle,
    );
    const path = uniqueEntryPath(directorySegments, title, memo.id, usedPaths);
    usedPaths.add(path.toLowerCase());
    entries.push({
      memoId: memo.id,
      path,
      directorySegments,
      notebookPath: directorySegments.join("/"),
      revision: Number.isFinite(memo.revision) ? memo.revision : 0,
      updatedAt: typeof memo.updatedAt === "string" ? memo.updatedAt : "",
    });
  }
  return entries;
};

const yamlString = (value) => JSON.stringify(String(value ?? ""));

// A YAML front matter block keeps the file self-describing when the folder is
// opened in an editor or synced by another tool.
export const renderMirrorDocument = (memo, entry) => {
  const tags = Array.isArray(memo?.tags) ? memo.tags.map((tag) => String(tag)).filter(Boolean) : [];
  const body = String(memo?.contentMarkdown ?? "").replace(/\r\n/g, "\n");
  const frontMatter = [
    "---",
    `title: ${yamlString(memo?.title ?? "")}`,
    `memoId: ${yamlString(memo?.id ?? entry?.memoId ?? "")}`,
    `notebook: ${yamlString(entry?.notebookPath ?? "")}`,
    `tags: [${tags.map(yamlString).join(", ")}]`,
    `created: ${yamlString(memo?.createdAt ?? "")}`,
    `updated: ${yamlString(memo?.updatedAt ?? "")}`,
    "---",
    "",
  ].join("\n");
  return `${frontMatter}${body.replace(/\n*$/, "")}\n`;
};

const mirrorAbsolutePath = (root, relativePath) => join(root, ...String(relativePath).split("/"));

const isInsideRoot = (root, absolutePath) => {
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(absolutePath);
  return normalizedPath !== normalizedRoot && isPathInside(normalizedRoot, normalizedPath);
};

export const readMarkdownMirrorManifest = async (root) => {
  try {
    const parsed = JSON.parse(await readFile(join(root, MARKDOWN_MIRROR_MANIFEST_FILE), "utf8"));
    const files = parsed?.files && typeof parsed.files === "object" ? parsed.files : {};
    const normalized = {};
    for (const [memoId, value] of Object.entries(files)) {
      if (typeof value?.path !== "string" || !value.path) continue;
      normalized[memoId] = {
        path: value.path,
        revision: Number.isFinite(value.revision) ? value.revision : 0,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      };
    }
    return { version: MARKDOWN_MIRROR_MANIFEST_VERSION, files: normalized };
  } catch {
    return { version: MARKDOWN_MIRROR_MANIFEST_VERSION, files: {} };
  }
};

const writeJsonAtomically = async (path, value) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
};

const writeMarkdownAtomically = async (path, content) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
};

const removeEmptyParents = async (root, absolutePath) => {
  let current = dirname(absolutePath);
  while (isInsideRoot(root, current)) {
    try {
      const entries = await readdir(current);
      if (entries.length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
};

const removeMirrorFile = async (root, relativePath) => {
  const absolutePath = mirrorAbsolutePath(root, relativePath);
  if (!isInsideRoot(root, absolutePath)) return false;
  try {
    await rm(absolutePath, { force: true });
  } catch {
    return false;
  }
  await removeEmptyParents(root, absolutePath);
  return true;
};

const listAllMemos = async (request) => {
  const memos = [];
  let offset = 0;
  for (let page = 0; page < MAX_MEMO_PAGES; page += 1) {
    const result = await request("memo.list", { limit: MEMO_PAGE_SIZE, offset, trash: false });
    const batch = Array.isArray(result?.memos) ? result.memos : [];
    memos.push(...batch);
    const nextCursor = Number(result?.nextCursor);
    if (!result?.nextCursor || !Number.isFinite(nextCursor) || nextCursor <= offset) break;
    offset = nextCursor;
  }
  return memos;
};

// Mirroring is one-way: the database stays authoritative and the files are a
// readable copy. Unchanged notes are skipped entirely, so a sync after a single
// edit only reads and writes that one note.
export const syncMarkdownMirror = async ({
  root,
  request,
  fallbackTitle = DEFAULT_FALLBACK_TITLE,
  unsortedName = MARKDOWN_MIRROR_UNSORTED_DIRECTORY,
  onProgress,
} = {}) => {
  const directory = normalizeMirrorDirectory(root);
  if (!directory || !isAbsolute(directory)) throw new Error("Invalid markdown mirror directory");
  const previous = await readMarkdownMirrorManifest(directory);
  const notebooksResult = await request("notebook.list", {});
  const notebooks = Array.isArray(notebooksResult?.notebooks) ? notebooksResult.notebooks : [];
  const memos = await listAllMemos(request);
  const entries = buildMirrorEntries({ notebooks, memos, fallbackTitle, unsortedName });
  const files = {};
  const pendingWrites = [];
  let unchanged = 0;

  for (const entry of entries) {
    const prior = previous.files[entry.memoId];
    const absolutePath = mirrorAbsolutePath(directory, entry.path);
    if (
      prior
      && prior.path === entry.path
      && prior.revision === entry.revision
      && prior.updatedAt === entry.updatedAt
      && existsSync(absolutePath)
    ) {
      unchanged += 1;
      files[entry.memoId] = { path: entry.path, revision: entry.revision, updatedAt: entry.updatedAt };
      continue;
    }
    const result = await request("memo.get", { memoId: entry.memoId });
    const memo = result?.memo;
    if (!memo) throw new Error(`Markdown mirror could not read note ${entry.memoId}`);
    pendingWrites.push({ entry, content: renderMirrorDocument(memo, entry) });
    files[entry.memoId] = {
      path: entry.path,
      revision: Number.isFinite(memo.revision) ? memo.revision : entry.revision,
      updatedAt: typeof memo.updatedAt === "string" ? memo.updatedAt : entry.updatedAt,
    };
    onProgress?.({ completed: unchanged + pendingWrites.length, total: entries.length });
  }

  for (const { entry, content } of pendingWrites) {
    await writeMarkdownAtomically(mirrorAbsolutePath(directory, entry.path), content);
  }

  // Stale files are removed only after every write succeeded, and never when
  // another note now owns the same path.
  const nextPaths = new Set(Object.values(files).map((file) => file.path));
  let removed = 0;
  for (const prior of Object.values(previous.files)) {
    if (nextPaths.has(prior.path)) continue;
    if (await removeMirrorFile(directory, prior.path)) removed += 1;
  }

  await writeJsonAtomically(join(directory, MARKDOWN_MIRROR_MANIFEST_FILE), {
    version: MARKDOWN_MIRROR_MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    files,
  });

  return { directory, files: Object.keys(files).length, written: pendingWrites.length, removed, unchanged };
};

// Used when the mirror moves to a different folder: only files recorded in the
// manifest are deleted, so unrelated user files are never touched.
export const removeMarkdownMirrorFiles = async (root) => {
  const directory = normalizeMirrorDirectory(root);
  if (!directory) return 0;
  const manifest = await readMarkdownMirrorManifest(directory);
  let removed = 0;
  for (const file of Object.values(manifest.files)) {
    if (await removeMirrorFile(directory, file.path)) removed += 1;
  }
  await rm(join(directory, MARKDOWN_MIRROR_MANIFEST_FILE), { force: true });
  return removed;
};

export const parseMarkdownMirrorConfig = (text) => {
  let parsed = null;
  try {
    parsed = typeof text === "string" && text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : MARKDOWN_MIRROR_DEFAULT_ENABLED,
    directory: normalizeMirrorDirectory(parsed?.directory),
    lastSyncedAt: typeof parsed?.lastSyncedAt === "string" ? parsed.lastSyncedAt : "",
    fileCount: Number.isFinite(parsed?.fileCount) ? parsed.fileCount : 0,
    lastError: typeof parsed?.lastError === "string" ? parsed.lastError : "",
  };
};

export const serializeMarkdownMirrorConfig = (config) => `${JSON.stringify({
  version: 1,
  enabled: Boolean(config?.enabled),
  directory: normalizeMirrorDirectory(config?.directory),
  lastSyncedAt: typeof config?.lastSyncedAt === "string" ? config.lastSyncedAt : "",
  fileCount: Number.isFinite(config?.fileCount) ? config.fileCount : 0,
  lastError: typeof config?.lastError === "string" ? config.lastError : "",
}, null, 2)}\n`;
