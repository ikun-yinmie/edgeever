import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  UpdateDownloadPausedError,
  hashFileSha512,
  partialPaths,
  parseContentRange,
  resumeRequestHeaders,
  runResumableUpdateDownload,
} from "./update-resume.mjs";

const sha512Of = (bytes) => createHash("sha512").update(bytes).digest("base64");

const createDirectory = () => mkdtemp(join(tmpdir(), "edgeever-update-test-"));

const streamFrom = (chunks, { status = 200, headers = {}, signal, delayMs = 0, errorOnAbort } = {}) => {
  const stream = new ReadableStream({
    async start(controller) {
      for (const [index, chunk] of chunks.entries()) {
        // Delay only between chunks so a pause can land after the first write.
        if (delayMs > 0 && index > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) {
          controller.error(errorOnAbort ?? new Error("aborted"));
          return;
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
};

const bytesOf = (text) => new TextEncoder().encode(text);

const runOptions = (directory, overrides = {}) => ({
  url: "http://127.0.0.1/EdgeEver.AppImage",
  version: "2.0.0",
  fileName: "EdgeEver.AppImage",
  directory,
  signal: new AbortController().signal,
  ...overrides,
});

describe("update resume helpers", () => {
  test("parses byte ranges and ignores unusable ones", () => {
    expect(parseContentRange("bytes 100-199/1000")).toEqual({ start: 100, end: 199, total: 1000 });
    expect(parseContentRange("bytes 0-9/*")).toEqual({ start: 0, end: 9, total: null });
    expect(parseContentRange("bytes 10-5/100")).toBeNull();
    expect(parseContentRange("bytes 0-100/100")).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });

  test("only resumes from a positive offset", () => {
    expect(resumeRequestHeaders(0, "etag")).toEqual({});
    expect(resumeRequestHeaders(128, null)).toEqual({ Range: "bytes=128-" });
    expect(resumeRequestHeaders(128, "\"abc\"")).toEqual({
      Range: "bytes=128-",
      "If-Range": "\"abc\"",
    });
  });

  test("derives a version-scoped part path", () => {
    const paths = partialPaths("/tmp/updates", "2.0.0", "EdgeEver.AppImage");
    expect(paths.dataPath).toBe("/tmp/updates/2.0.0--EdgeEver.AppImage.part");
    expect(paths.metaPath).toBe("/tmp/updates/2.0.0--EdgeEver.AppImage.part.json");
  });
});

describe("resumable update download", () => {
  test("downloads, verifies sha512, and hands the completed file to the updater", async () => {
    const directory = await createDirectory();
    try {
      const body = bytesOf("edgeever-update-payload");
      const delivered = [];
      const progress = [];
      const result = await runResumableUpdateDownload(runOptions(directory, {
        sha512: sha512Of(body),
        expectedSize: body.byteLength,
        fetchImpl: async (_url, init) => {
          expect(init.headers.Range).toBeUndefined();
          return streamFrom([body.subarray(0, 8), body.subarray(8)], {
            headers: { "content-length": String(body.byteLength), etag: "\"v2\"" },
          });
        },
        onProgress: (value) => progress.push(value),
        deliver: async ({ completedPath, fileName, size }) => {
          delivered.push({ completedPath, fileName, size, bytes: new Uint8Array(await readFile(completedPath)) });
        },
      }));
      expect(result).toEqual({ transferred: body.byteLength, total: body.byteLength });
      expect(delivered).toHaveLength(1);
      expect(delivered[0].fileName).toBe("EdgeEver.AppImage");
      expect(Buffer.from(delivered[0].bytes).toString()).toBe("edgeever-update-payload");
      expect(progress.at(-1)).toEqual({ percent: 100, transferred: body.byteLength, total: body.byteLength });
      const { metaPath } = partialPaths(directory, "2.0.0", "EdgeEver.AppImage");
      expect(await stat(metaPath).catch(() => null)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a pause keeps the bytes and the resume continues with a Range request", async () => {
    const directory = await createDirectory();
    try {
      const head = bytesOf("first-half-of-the-update-");
      const tail = bytesOf("second-half");
      const body = new Uint8Array([...head, ...tail]);
      const controller = new AbortController();
      const { dataPath } = partialPaths(directory, "2.0.0", "EdgeEver.AppImage");

      const paused = runResumableUpdateDownload(runOptions(directory, {
        sha512: sha512Of(body),
        expectedSize: body.byteLength,
        signal: controller.signal,
        fetchImpl: async () => streamFrom([head, tail], {
          delayMs: 25,
          signal: controller.signal,
          headers: { "content-length": String(body.byteLength), etag: "\"v2\"" },
        }),
        deliver: async () => {
          throw new Error("a paused download must not deliver");
        },
      })).catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const pausedError = await paused;
      expect(pausedError).toBeInstanceOf(UpdateDownloadPausedError);
      expect((await stat(dataPath)).size).toBe(head.byteLength);

      const seenHeaders = [];
      const delivered = [];
      const result = await runResumableUpdateDownload(runOptions(directory, {
        sha512: sha512Of(body),
        expectedSize: body.byteLength,
        fetchImpl: async (_url, init) => {
          seenHeaders.push(init.headers);
          return streamFrom([tail], {
            status: 206,
            headers: {
              "content-range": `bytes ${head.byteLength}-${body.byteLength - 1}/${body.byteLength}`,
            },
          });
        },
        deliver: async ({ completedPath }) => {
          delivered.push(new Uint8Array(await readFile(completedPath)));
        },
      }));
      expect(seenHeaders[0]).toMatchObject({
        Range: `bytes=${head.byteLength}-`,
        "If-Range": "\"v2\"",
      });
      expect(result.transferred).toBe(body.byteLength);
      expect(Buffer.from(delivered[0]).toString()).toBe("first-half-of-the-update-second-half");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restarts from zero when the server ignores the range", async () => {
    const directory = await createDirectory();
    try {
      const head = bytesOf("stale-prefix");
      const body = bytesOf("fresh-payload");
      const { dataPath, metaPath } = partialPaths(directory, "2.0.0", "EdgeEver.AppImage");
      await writeFile(dataPath, head);
      await writeFile(metaPath, JSON.stringify({ sha512: "ignored", total: null }));

      const delivered = [];
      await runResumableUpdateDownload(runOptions(directory, {
        sha512: sha512Of(body),
        expectedSize: body.byteLength,
        fetchImpl: async () => streamFrom([body], {
          status: 200,
          headers: { "content-length": String(body.byteLength) },
        }),
        deliver: async ({ completedPath }) => {
          delivered.push(new Uint8Array(await readFile(completedPath)));
        },
      }));
      expect(Buffer.from(delivered[0]).toString()).toBe("fresh-payload");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects and removes the part file when sha512 does not match", async () => {
    const directory = await createDirectory();
    try {
      const body = bytesOf("tampered-payload");
      const { dataPath, metaPath } = partialPaths(directory, "2.0.0", "EdgeEver.AppImage");
      await expect(runResumableUpdateDownload(runOptions(directory, {
        sha512: sha512Of(bytesOf("expected-payload")),
        expectedSize: body.byteLength,
        fetchImpl: async () => streamFrom([body], {
          headers: { "content-length": String(body.byteLength) },
        }),
        deliver: async () => {
          throw new Error("a corrupted download must not be delivered");
        },
      }))).rejects.toThrow("sha512");
      expect(await stat(dataPath).catch(() => null)).toBeNull();
      expect(await stat(metaPath).catch(() => null)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("hashes files as base64 sha512", async () => {
    const directory = await createDirectory();
    try {
      const path = join(directory, "payload.bin");
      await writeFile(path, bytesOf("hash-me"));
      expect(await hashFileSha512(path)).toBe(sha512Of(bytesOf("hash-me")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
