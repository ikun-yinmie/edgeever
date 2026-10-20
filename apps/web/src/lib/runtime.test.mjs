import { afterEach, describe, expect, test } from "bun:test";
import { isDesktopRenderer, isNativeDesktopRuntime } from "./runtime.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete globalThis.window;
  }
  delete globalThis.__EDGEEVER_DESKTOP_BUILD__;
});

describe("native desktop runtime detection", () => {
  test("detects the native desktop bridge", () => {
    globalThis.window = {
      edgeeverDesktop: { isAvailable: true },
    };

    expect(isNativeDesktopRuntime()).toBe(true);
  });

  test("does not expose desktop-only features in a browser", () => {
    globalThis.window = {};

    expect(isNativeDesktopRuntime()).toBe(false);
  });

  test("does not rely on an Electron user agent without the native bridge", () => {
    globalThis.window = {
      navigator: { userAgent: "Mozilla/5.0 Electron/39.0.0" },
    };

    expect(isNativeDesktopRuntime()).toBe(false);
  });

  test("returns false during server-side rendering", () => {
    delete globalThis.window;

    expect(isNativeDesktopRuntime()).toBe(false);
  });
});

describe("desktop renderer detection", () => {
  test("matches the router split used by the app entry", () => {
    globalThis.window = {};
    expect(isDesktopRenderer()).toBe(false);

    globalThis.window = { edgeeverDesktop: { isAvailable: true } };
    expect(isDesktopRenderer()).toBe(true);

    globalThis.window = {};
    globalThis.__EDGEEVER_DESKTOP_BUILD__ = true;
    expect(isDesktopRenderer()).toBe(true);
  });
});
