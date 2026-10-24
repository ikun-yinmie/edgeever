import { afterEach, describe, expect, test } from "bun:test";
import { copyHtmlToClipboard, copyImageBlobToClipboard, copyTextToClipboard } from "./clipboard.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

const restoreGlobal = (name, descriptor) => {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete globalThis[name];
  }
};

afterEach(() => {
  restoreGlobal("window", originalWindow);
  restoreGlobal("navigator", originalNavigator);
  restoreGlobal("document", originalDocument);
});

describe("copyTextToClipboard", () => {
  test("uses the verified native clipboard bridge in the desktop app", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyText: async (value) => {
          calls.push(value);
          return true;
        },
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: () => { throw new Error("browser clipboard should not be used"); } } },
    });

    await expect(copyTextToClipboard("https://example.com/share/token")).resolves.toBe(true);
    expect(calls).toEqual(["https://example.com/share/token"]);
  });

  test("falls back to the browser clipboard when native verification fails", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyText: async () => false,
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (value) => calls.push(value) } },
    });

    await expect(copyTextToClipboard("new value")).resolves.toBe(true);
    expect(calls).toEqual(["new value"]);
  });

  test("reports failure when every clipboard path is unavailable", async () => {
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyText: async () => false,
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });

    await expect(copyTextToClipboard("new value")).resolves.toBe(false);
  });

  test("keeps the browser clipboard path outside the desktop app", async () => {
    const calls = [];
    globalThis.window = {};
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (value) => calls.push(value) } },
    });

    await expect(copyTextToClipboard("browser value")).resolves.toBe(true);
    expect(calls).toEqual(["browser value"]);
  });
});

describe("copyImageBlobToClipboard", () => {
  test("writes image bytes through the native desktop clipboard", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyImage: async (bytes) => {
          calls.push(new Uint8Array(bytes));
          return true;
        },
      },
    };

    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    await expect(copyImageBlobToClipboard(blob)).resolves.toBe(true);
    expect(calls).toEqual([new Uint8Array([7, 8, 9])]);
  });

  test("falls through when the native clipboard rejects the image", async () => {
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyImage: async () => false,
      },
    };

    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    await expect(copyImageBlobToClipboard(blob)).resolves.toBe(false);
  });

  test("does nothing outside the desktop app without a browser clipboard", async () => {
    globalThis.window = {};
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    await expect(copyImageBlobToClipboard(blob)).resolves.toBe(false);
  });
});

describe("copyHtmlToClipboard", () => {
  test("uses the native rich clipboard bridge in the desktop app", async () => {
    const calls = [];
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyHtml: async (...values) => {
          calls.push(values);
          return true;
        },
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write: () => { throw new Error("browser clipboard should not be used"); } } },
    });

    await expect(copyHtmlToClipboard("<strong>Hello</strong>", "Hello")).resolves.toBeUndefined();
    expect(calls).toEqual([["<strong>Hello</strong>", "Hello"]]);
  });

  test("fails when native rich clipboard verification fails", async () => {
    globalThis.window = {
      edgeeverDesktop: {
        isAvailable: true,
        copyHtml: async () => false,
      },
    };

    await expect(copyHtmlToClipboard("<strong>Hello</strong>", "Hello")).rejects.toThrow(
      "Native rich clipboard verification failed",
    );
  });
});
