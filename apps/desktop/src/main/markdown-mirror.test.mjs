import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildMirrorEntries,
  MARKDOWN_MIRROR_MANIFEST_FILE,
  notebookDirectorySegments,
  parseMarkdownMirrorConfig,
  removeMarkdownMirrorFiles,
  renderMirrorDocument,
  sanitizePathSegment,
  serializeMarkdownMirrorConfig,
  syncMarkdownMirror,
} from "./markdown-mirror.mjs";

const note = (overrides = {}) => ({
  id: "memo_1",
  notebookId: "notebook_work",
  title: "Weekly plan",
  excerpt: "Weekly plan body",
  tags: [],
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  contentMarkdown: "Body",
  ...overrides,
});

const fakeRequest = ({ notebooks = [], memos = [] } = {}) => {
  const details = new Map(memos.map((memo) => [memo.id, memo]));
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === "notebook.list") return { notebooks };
    if (method === "memo.list") {
      const limit = params?.limit ?? 50;
      const offset = params?.offset ?? 0;
      const page = memos.slice(offset, offset + limit).map((memo) => ({ ...memo, contentMarkdown: undefined }));
      const nextOffset = offset + page.length;
      return { memos: page, totalCount: memos.length, nextCursor: nextOffset < memos.length ? String(nextOffset) : null };
    }
    if (method === "memo.get") {
      const memo = details.get(params?.memoId);
      if (!memo) throw new Error("missing memo");
      return { memo };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { request, calls };
};

describe("markdown mirror paths", () => {
  test("sanitizes user text into safe cross-platform segments", () => {
    expect(sanitizePathSegment("  Weekly / plan: Q1  ")).toBe("Weekly plan Q1");
    expect(sanitizePathSegment("")).toBe("Untitled");
    expect(sanitizePathSegment(".hidden.")).toBe("hidden");
    expect(sanitizePathSegment("CON")).toBe("_CON");
    expect(sanitizePathSegment("a".repeat(120))).toHaveLength(80);
  });

  test("mirrors the notebook hierarchy and keeps duplicate sibling names apart", () => {
    const notebooks = [
      { id: "root", parentId: null, name: "Work" },
      { id: "child", parentId: "root", name: "2026" },
      { id: "duplicate_a", parentId: "root", name: "Inbox" },
      { id: "duplicate_b", parentId: "root", name: "Inbox" },
    ];
    expect(notebookDirectorySegments(notebooks, "child")).toEqual(["Work", "2026"]);
    const duplicates = notebooks
      .filter((notebook) => notebook.name === "Inbox")
      .map((notebook) => notebookDirectorySegments(notebooks, notebook.id).join("/"));
    expect(new Set(duplicates).size).toBe(2);
    expect(notebookDirectorySegments(notebooks, "missing")).toEqual(["Unsorted"]);
  });

  test("caps deep notebook chains and survives cycles", () => {
    const notebooks = Array.from({ length: 12 }, (_, index) => ({
      id: `n${index}`,
      parentId: index === 0 ? null : `n${index - 1}`,
      name: `Level ${index}`,
    }));
    expect(notebookDirectorySegments(notebooks, "n11")).toHaveLength(8);
    const cyclic = [
      { id: "a", parentId: "b", name: "A" },
      { id: "b", parentId: "a", name: "B" },
    ];
    expect(notebookDirectorySegments(cyclic, "a").length).toBeLessThanOrEqual(2);
    const longNames = [
      { id: "l1", parentId: null, name: "n".repeat(70) },
      { id: "l2", parentId: "l1", name: "m".repeat(70) },
      { id: "l3", parentId: "l2", name: "o".repeat(70) },
    ];
    expect(notebookDirectorySegments(longNames, "l3").join("/").length).toBeLessThanOrEqual(100);
  });

  test("builds one markdown entry per note and resolves filename collisions", () => {
    const notebooks = [{ id: "notebook_work", parentId: null, name: "Work" }];
    const entries = buildMirrorEntries({
      notebooks,
      memos: [
        note({ id: "memo_1", title: "Plan" }),
        note({ id: "memo_2", title: "Plan" }),
        note({ id: "memo_3", title: "", excerpt: "Diary entry from the trip" }),
      ],
    });
    expect(entries.map((entry) => entry.path)).toEqual([
      "Work/Plan.md",
      "Work/Plan (memo_2).md",
      "Work/Diary entry from the trip.md",
    ]);
  });

  test("renders YAML front matter that keeps note metadata readable", () => {
    const entry = { memoId: "memo_1", notebookPath: "Work/2026" };
    const document = renderMirrorDocument(note({ tags: ["plan", "q1"], contentMarkdown: "# Heading\n" }), entry);
    expect(document).toContain('title: "Weekly plan"');
    expect(document).toContain('notebook: "Work/2026"');
    expect(document).toContain('tags: ["plan", "q1"]');
    expect(document.endsWith("# Heading\n")).toBe(true);
  });
});

describe("markdown mirror sync", () => {
  test("writes files by notebook, skips unchanged notes, and prunes removed ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "edgeever-mirror-"));
    try {
      const notebooks = [
        { id: "notebook_work", parentId: null, name: "Work" },
        { id: "notebook_life", parentId: null, name: "Life" },
      ];
      const memos = [
        note({ id: "memo_1", notebookId: "notebook_work", title: "Plan", contentMarkdown: "Plan body" }),
        note({ id: "memo_2", notebookId: "notebook_life", title: "Groceries", contentMarkdown: "- milk" }),
      ];
      const first = fakeRequest({ notebooks, memos });
      const firstSync = await syncMarkdownMirror({ root, request: first.request });
      expect(firstSync).toMatchObject({ files: 2, written: 2, removed: 0, unchanged: 0 });
      expect(await readFile(join(root, "Work", "Plan.md"), "utf8")).toContain("Plan body");
      expect(JSON.parse(await readFile(join(root, MARKDOWN_MIRROR_MANIFEST_FILE), "utf8")).files.memo_1.path)
        .toBe("Work/Plan.md");

      const second = fakeRequest({ notebooks, memos });
      const secondSync = await syncMarkdownMirror({ root, request: second.request });
      expect(secondSync).toMatchObject({ files: 2, written: 0, removed: 0, unchanged: 2 });
      expect(second.calls.filter((call) => call.method === "memo.get")).toHaveLength(0);

      const updatedMemos = [
        note({ id: "memo_1", notebookId: "notebook_work", title: "Plan", contentMarkdown: "Plan body v2", revision: 2 }),
      ];
      const third = fakeRequest({ notebooks, memos: updatedMemos });
      const thirdSync = await syncMarkdownMirror({ root, request: third.request });
      expect(thirdSync).toMatchObject({ files: 1, written: 1, removed: 1 });
      expect(third.calls.filter((call) => call.method === "memo.get")).toHaveLength(1);
      expect(await readFile(join(root, "Work", "Plan.md"), "utf8")).toContain("Plan body v2");
      expect(existsSync(join(root, "Life", "Groceries.md"))).toBe(false);
      expect(existsSync(join(root, "Life"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rewrites a note when its notebook or title moves and keeps stale paths intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "edgeever-mirror-move-"));
    try {
      const notebooks = [
        { id: "notebook_work", parentId: null, name: "Work" },
        { id: "notebook_life", parentId: null, name: "Life" },
      ];
      await syncMarkdownMirror({
        root,
        request: fakeRequest({ notebooks, memos: [note({ id: "memo_1", title: "Plan" })] }).request,
      });
      const moved = await syncMarkdownMirror({
        root,
        request: fakeRequest({
          notebooks,
          memos: [note({ id: "memo_1", notebookId: "notebook_life", title: "Plan", revision: 2 })],
        }).request,
      });
      expect(moved).toMatchObject({ files: 1, written: 1, removed: 1 });
      expect(existsSync(join(root, "Work", "Plan.md"))).toBe(false);
      expect(existsSync(join(root, "Life", "Plan.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never deletes files outside the mirror root from a tampered manifest", async () => {
    const base = await mkdtemp(join(tmpdir(), "edgeever-mirror-guard-"));
    const root = join(base, "mirror");
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(base, "outside.md"), "keep me");
      await writeFile(join(root, MARKDOWN_MIRROR_MANIFEST_FILE), JSON.stringify({
        version: 1,
        files: {
          memo_1: { path: "../outside.md", revision: 1, updatedAt: "" },
        },
      }));
      await syncMarkdownMirror({ root, request: fakeRequest({ memos: [] }).request });
      expect(await readFile(join(base, "outside.md"), "utf8")).toBe("keep me");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("removes only manifest-owned files when the mirror directory changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "edgeever-mirror-remove-"));
    try {
      await syncMarkdownMirror({
        root,
        request: fakeRequest({
          notebooks: [{ id: "notebook_work", parentId: null, name: "Work" }],
          memos: [note({ id: "memo_1" })],
        }).request,
      });
      await writeFile(join(root, "Work", "user-file.txt"), "mine");
      expect(await removeMarkdownMirrorFiles(root)).toBe(1);
      expect(await readdir(join(root, "Work"))).toEqual(["user-file.txt"]);
      expect(existsSync(join(root, MARKDOWN_MIRROR_MANIFEST_FILE))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("desktop markdown mirror wiring", () => {
  const mainSource = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const preloadSource = readFileSync(new URL("../preload/index.cjs", import.meta.url), "utf8");
  const cardSource = readFileSync(new URL("../../../web/src/components/settings/DesktopMarkdownMirrorCard.tsx", import.meta.url), "utf8");

  test("loads the saved configuration before the first sidecar start", () => {
    expect(mainSource).toContain("await loadMarkdownMirrorConfig();");
    expect(mainSource).toContain("requestMarkdownMirrorSync(1_000);");
    expect(mainSource).toContain("if (MARKDOWN_MIRROR_SYNC_METHODS.has(method)) requestMarkdownMirrorSync();");
  });

  test("exposes the mirror controls through the preload bridge", () => {
    for (const method of [
      "markdownMirrorStatus",
      "setMarkdownMirrorEnabled",
      "chooseMarkdownMirrorDirectory",
      "resetMarkdownMirrorDirectory",
      "syncMarkdownMirror",
      "openMarkdownMirrorDirectory",
    ]) {
      expect(preloadSource).toContain(`${method}:`);
      expect(mainSource).toContain(`"desktop:${method.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}"`);
    }
  });

  test("renders the settings card with translated copy", () => {
    expect(cardSource).toContain('t("markdownMirror.title")');
    expect(cardSource).toContain("setMarkdownMirrorEnabled");
    expect(cardSource).toContain("syncMarkdownMirror");
  });
});

describe("markdown mirror configuration", () => {
  test("defaults to enabled with the default directory and tolerates broken JSON", () => {
    expect(parseMarkdownMirrorConfig("")).toMatchObject({ enabled: true, directory: "", fileCount: 0 });
    expect(parseMarkdownMirrorConfig("{not json")).toMatchObject({ enabled: true, directory: "" });
    expect(parseMarkdownMirrorConfig(JSON.stringify({ enabled: false, directory: "/notes" })))
      .toMatchObject({ enabled: false, directory: "/notes" });
  });

  test("round-trips the persisted configuration", () => {
    const serialized = serializeMarkdownMirrorConfig({
      enabled: false,
      directory: "/notes/",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      fileCount: 12,
      lastError: "disk full",
    });
    expect(parseMarkdownMirrorConfig(serialized)).toEqual({
      enabled: false,
      directory: "/notes",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      fileCount: 12,
      lastError: "disk full",
    });
  });
});
