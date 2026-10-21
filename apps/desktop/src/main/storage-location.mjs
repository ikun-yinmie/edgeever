import { existsSync } from "node:fs";
import { cp, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, relative } from "node:path";

export const STORAGE_LOCATION_FILE = "storage-location.json";

// Sidecar-owned entries that live at the storage root. The account databases
// live under `accounts/`, while a logged-out sidecar keeps its database and
// caches directly at the root.
export const SIDECAR_ROOT_ENTRIES = [
  "accounts",
  "edgeever.sqlite",
  "edgeever.sqlite-wal",
  "edgeever.sqlite-shm",
  "backups",
  "resource-outbox",
  "resource-cache",
];

export const storageLocationConfigPath = (userDataDirectory) =>
  join(userDataDirectory, STORAGE_LOCATION_FILE);

export const normalizeStorageDirectory = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) return "";
  const normalized = normalize(trimmed);
  const root = parse(trimmed).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
};

export const parseStorageLocationConfig = (text) => {
  if (typeof text !== "string" || !text.trim()) return "";
  try {
    return normalizeStorageDirectory(JSON.parse(text)?.dataDirectory);
  } catch {
    return "";
  }
};

export const serializeStorageLocationConfig = (directory) =>
  `${JSON.stringify({ dataDirectory: normalizeStorageDirectory(directory) }, null, 2)}\n`;

export const isPathInside = (parent, child) => {
  if (!parent || !child) return false;
  const relativePath = relative(parent, child);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
};

export const validateStorageTarget = ({ target, currentRoot, protectedRoots = [] }) => {
  if (!target) return "invalid-directory";
  if (currentRoot && target === currentRoot) return "unchanged";
  if (currentRoot && (isPathInside(currentRoot, target) || isPathInside(target, currentRoot))) {
    return "unsupported-directory";
  }
  for (const root of protectedRoots) {
    if (!root) continue;
    const normalizedRoot = normalizeStorageDirectory(root);
    if (normalizedRoot && (target === normalizedRoot || isPathInside(normalizedRoot, target))) {
      return "unsupported-directory";
    }
  }
  return "";
};

export const hasSidecarData = (directory) =>
  existsSync(join(directory, "accounts")) || existsSync(join(directory, "edgeever.sqlite"));

export const storageRevealTarget = (directory) => {
  const databasePath = join(directory, "edgeever.sqlite");
  return existsSync(databasePath) ? databasePath : directory;
};

// Rename keeps the move atomic on the same volume; copying covers removable or
// network targets where rename fails with EXDEV.
export const movePath = async (source, destination) => {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true, errorOnExist: true });
    await rm(source, { recursive: true, force: true });
  }
};

export const moveSidecarData = async (sourceRoot, targetRoot) => {
  const moved = [];
  try {
    for (const name of SIDECAR_ROOT_ENTRIES) {
      const sourcePath = join(sourceRoot, name);
      if (!existsSync(sourcePath)) continue;
      await movePath(sourcePath, join(targetRoot, name));
      moved.push(name);
    }
  } catch (error) {
    await rollbackSidecarData(sourceRoot, targetRoot, moved);
    throw error;
  }
  return moved;
};

export const rollbackSidecarData = async (sourceRoot, targetRoot, moved) => {
  for (const name of [...moved].reverse()) {
    try {
      await movePath(join(targetRoot, name), join(sourceRoot, name));
    } catch {
      // Rollback is best effort; the failed move is reported either way.
    }
  }
};

export const directoryUsage = async (path) => {
  let bytes = 0;
  let files = 0;
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        try {
          const info = await stat(entryPath);
          bytes += info.size;
          files += 1;
        } catch {
          // Usage display is best effort and must never fail the settings card.
        }
      }
    }
  };
  try {
    const info = await stat(path);
    if (info.isFile()) return { bytes: info.size, files: 1 };
  } catch {
    return { bytes: 0, files: 0 };
  }
  await walk(path);
  return { bytes, files };
};

// The default storage root is the Electron user-data directory, which also
// holds caches and logs that are not part of the local notebook library. Only
// the sidecar-owned entries are reported as storage usage.
export const sidecarStorageUsage = async (root) => {
  let bytes = 0;
  let files = 0;
  for (const name of SIDECAR_ROOT_ENTRIES) {
    const usage = await directoryUsage(join(root, name));
    bytes += usage.bytes;
    files += usage.files;
  }
  return { bytes, files };
};
