import { afterEach, describe, expect, test } from "bun:test";
import { canRevealLocalStorage, revealLocalStorage } from "./desktop-storage.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete globalThis.window;
  }
});

describe("desktop local storage reveal", () => {
  test("prefers the account-aware reveal bridge", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        revealStorageLocation: async () => {
          calls.push("reveal");
          return { ok: true };
        },
        openStorageLocation: async () => {
          calls.push("open");
          return { ok: true };
        },
      },
    };

    expect(canRevealLocalStorage()).toBe(true);
    await expect(revealLocalStorage()).resolves.toBe(true);
    expect(calls).toEqual(["reveal"]);
  });

  test("falls back to the storage root on older desktop builds", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        openStorageLocation: async () => {
          calls.push("open");
          return { ok: true };
        },
      },
    };

    expect(canRevealLocalStorage()).toBe(true);
    await expect(revealLocalStorage()).resolves.toBe(true);
    expect(calls).toEqual(["open"]);
  });

  test("does nothing outside the desktop app", async () => {
    globalThis.window = {};

    expect(canRevealLocalStorage()).toBe(false);
    await expect(revealLocalStorage()).resolves.toBe(false);
  });
});
