import { afterEach, describe, expect, test } from "bun:test";
import {
  canRevealMemoMarkdown,
  isMemoMarkdownAvailable,
  revealMemoMarkdown,
} from "./desktop-note-file.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete globalThis.window;
  }
});

describe("desktop note Markdown file bridge", () => {
  test("checks availability through the main process", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        memoMarkdownStatus: async (memoId) => {
          calls.push(memoId);
          return { available: memoId === "memo-1" };
        },
        revealMemoMarkdown: async () => ({ ok: true }),
      },
    };

    expect(canRevealMemoMarkdown()).toBe(true);
    await expect(isMemoMarkdownAvailable("memo-1")).resolves.toBe(true);
    await expect(isMemoMarkdownAvailable("memo-2")).resolves.toBe(false);
    expect(calls).toEqual(["memo-1", "memo-2"]);
  });

  test("reveals the mirrored file by note id", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        memoMarkdownStatus: async () => ({ available: true }),
        revealMemoMarkdown: async (memoId) => {
          calls.push(memoId);
          return { ok: true };
        },
      },
    };

    await expect(revealMemoMarkdown("memo-1")).resolves.toBe(true);
    expect(calls).toEqual(["memo-1"]);
  });

  test("stays hidden when the bridge or the file is unavailable", async () => {
    globalThis.window = { edgeeverDesktop: { isAvailable: true } };
    expect(canRevealMemoMarkdown()).toBe(false);
    await expect(isMemoMarkdownAvailable("memo-1")).resolves.toBe(false);
    await expect(revealMemoMarkdown("memo-1")).resolves.toBe(false);

    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        memoMarkdownStatus: async () => {
          throw new Error("main process unavailable");
        },
        revealMemoMarkdown: async () => {
          throw new Error("main process unavailable");
        },
      },
    };
    await expect(isMemoMarkdownAvailable("memo-1")).resolves.toBe(false);
    await expect(revealMemoMarkdown("memo-1")).resolves.toBe(false);
  });

  test("does nothing outside the desktop app", async () => {
    globalThis.window = {};
    expect(canRevealMemoMarkdown()).toBe(false);
    await expect(isMemoMarkdownAvailable("memo-1")).resolves.toBe(false);
    await expect(revealMemoMarkdown("memo-1")).resolves.toBe(false);
  });
});
