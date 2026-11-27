import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * electron-updater cancels a download by deleting its temp file, so a paused
 * update would always restart from zero. This downloader owns the HTTP transfer
 * instead: bytes are appended to a `.part` file, a pause only closes the
 * connection, and a resume continues with `Range: bytes=<n>-`. When the file is
 * complete it is checksum-verified and handed back to electron-updater's cache,
 * which then raises `update-downloaded` as usual.
 */

export class UpdateDownloadPausedError extends Error {
  constructor() {
    super("Update download paused");
    this.name = "UpdateDownloadPausedError";
  }
}

const PROGRESS_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 2;

export const parseContentRange = (value) => {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (total !== null && total <= end) return null;
  return { start, end, total };
};

const versionPrefix = (version) => `${String(version).replace(/[^\w.@+-]/g, "_")}--`;

export const partialFileName = (version, fileName) => `${versionPrefix(version)}${fileName}`;

export const partialPaths = (directory, version, fileName) => {
  const dataPath = join(directory, `${partialFileName(version, fileName)}.part`);
  return { dataPath, metaPath: `${dataPath}.json` };
};

/** `If-Range` makes the server restart from zero when the object changed. */
export const resumeRequestHeaders = (partialBytes, etag) => {
  if (!(partialBytes > 0)) return {};
  const headers = { Range: `bytes=${partialBytes}-` };
  if (etag) headers["If-Range"] = etag;
  return headers;
};

export const hashFileSha512 = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    hash.setEncoding("base64");
    createReadStream(path)
      .on("error", reject)
      .on("end", () => {
        hash.end();
        resolve(hash.read());
      })
      .pipe(hash, { end: false });
  });

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = (path, value) => writeFile(path, JSON.stringify(value));

const fileSize = async (path) => {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
};

const resetPartial = async (dataPath, metaPath) => {
  await unlink(dataPath).catch(() => undefined);
  await unlink(metaPath).catch(() => undefined);
};

const metaMatches = (meta, { sha512, expectedSize }) => Boolean(meta)
  && meta.sha512 === sha512
  && (!expectedSize || !meta.total || meta.total === expectedSize);

/** Drop leftovers from other versions so the directory cannot grow forever. */
export const prunePartialUpdates = async (directory, version) => {
  const prefix = versionPrefix(version);
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(entries
    .filter((entry) => !entry.startsWith(prefix))
    .map((entry) => unlink(join(directory, entry)).catch(() => undefined)));
};

const verifyPartial = async (dataPath, sha512, expectedSize) => {
  if (expectedSize && (await fileSize(dataPath)) !== expectedSize) return false;
  if (!sha512) return true;
  return (await hashFileSha512(dataPath)) === sha512;
};

const finish = async ({ dataPath, metaPath, fileName, sha512, deliver, total, transferred }) => {
  const size = await fileSize(dataPath);
  await deliver({ completedPath: dataPath, fileName, sha512, size });
  await unlink(metaPath).catch(() => undefined);
  return { transferred: transferred ?? size, total: total ?? size };
};

/**
 * Download (or continue downloading) one update asset.
 *
 * @returns {Promise<{ transferred: number, total: number }>}
 */
export const runResumableUpdateDownload = async ({
  url,
  version,
  fileName,
  sha512,
  expectedSize = null,
  directory,
  fetchImpl,
  headers = {},
  signal,
  onProgress = () => undefined,
  deliver,
}) => {
  await mkdir(directory, { recursive: true });
  await prunePartialUpdates(directory, version);
  const { dataPath, metaPath } = partialPaths(directory, version, fileName);

  let meta = await readJson(metaPath);
  if (!metaMatches(meta, { sha512, expectedSize })) {
    await resetPartial(dataPath, metaPath);
    meta = null;
  }
  let existing = meta ? await fileSize(dataPath) : 0;
  if (existing === 0 || (expectedSize && existing > expectedSize)) {
    await resetPartial(dataPath, metaPath);
    meta = null;
    existing = 0;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new UpdateDownloadPausedError();
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { ...headers, ...resumeRequestHeaders(existing, meta?.etag) },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new UpdateDownloadPausedError();
      throw error;
    }
    if (signal?.aborted) throw new UpdateDownloadPausedError();

    let total = expectedSize;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== existing) {
        // The part file and the server disagree about the offset; start over.
        await resetPartial(dataPath, metaPath);
        meta = null;
        existing = 0;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      total = expectedSize ?? range.total;
    } else if (response.status === 416) {
      if (await verifyPartial(dataPath, sha512, expectedSize)) {
        return finish({ dataPath, metaPath, fileName, sha512, deliver, total: expectedSize, transferred: existing });
      }
      await resetPartial(dataPath, metaPath);
      meta = null;
      existing = 0;
      continue;
    } else if (response.status === 200) {
      // The server ignored the range (or the object changed): truncate and take
      // the full body instead of gluing two versions together.
      if (existing > 0) {
        await truncate(dataPath, 0).catch(() => undefined);
        existing = 0;
      }
      const length = Number(response.headers.get("content-length"));
      total = expectedSize ?? (Number.isFinite(length) && length > 0 ? length : null);
    } else {
      throw new Error(`Update download failed with HTTP ${response.status}`);
    }

    const etag = response.headers.get("etag");
    meta = { sha512, total: total ?? null, ...(etag ? { etag } : {}) };
    await writeJson(metaPath, meta);

    const file = await open(dataPath, "a");
    let transferred = existing;
    let lastReport = 0;
    let paused = false;
    try {
      const report = (force) => {
        const now = Date.now();
        if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
        lastReport = now;
        const percent = total && total > 0
          ? Math.min(100, Math.max(0, transferred / total * 100))
          : null;
        onProgress({ percent, transferred, total: total ?? null });
      };
      report(true);
      try {
        for await (const chunk of response.body ?? []) {
          if (signal?.aborted) {
            paused = true;
            break;
          }
          await file.write(chunk);
          transferred += chunk.byteLength;
          report(false);
        }
      } catch (error) {
        // Electron's aborted body rejects instead of ending; either way the
        // bytes already written are kept for the resume.
        if (!signal?.aborted) throw error;
        paused = true;
      }
      report(true);
    } finally {
      await file.close().catch(() => undefined);
    }

    if (paused) throw new UpdateDownloadPausedError();

    const finalSize = await fileSize(dataPath);
    if (total && finalSize !== total) {
      // A clean EOF that is short of the declared size means the transfer was
      // cut short; drop it so the next attempt starts from a known state.
      await resetPartial(dataPath, metaPath);
      throw new Error(`Update download ended at ${finalSize} of ${total} bytes`);
    }
    if (!(await verifyPartial(dataPath, sha512, total))) {
      await resetPartial(dataPath, metaPath);
      throw new Error("Downloaded update failed its sha512 check");
    }
    return finish({ dataPath, metaPath, fileName, sha512, deliver, total, transferred });
  }

  throw new Error("Update server kept returning an unusable download range");
};
