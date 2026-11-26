import { describe, expect, test } from "bun:test";

const {
  getStandaloneMobileEditorScope,
  markStandaloneMobileEditorOpened,
  requiresRemoteMemoForStandaloneMobileEditor,
} = await import("./mobile-editor.ts");
const { setActiveSyncScope } = await import("./sync-preferences.ts");

const installSessionStorage = () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
};

describe("standalone mobile editor handoff", () => {
  test("requires a server memo before opening the web mobile editor", () => {
    expect(requiresRemoteMemoForStandaloneMobileEditor({
      mobileViewport: true,
      desktopRuntime: false,
    })).toBe(true);
  });

  test("keeps desktop and wide web creation on their repositories", () => {
    expect(requiresRemoteMemoForStandaloneMobileEditor({
      mobileViewport: false,
      desktopRuntime: false,
    })).toBe(false);
    expect(requiresRemoteMemoForStandaloneMobileEditor({
      mobileViewport: true,
      desktopRuntime: true,
    })).toBe(false);
  });

  test("hands the workspace mirror scope to the standalone editor document", () => {
    installSessionStorage();
    setActiveSyncScope("https://demo.edgeever.org|user-1");

    markStandaloneMobileEditorOpened("memo-1");

    expect(getStandaloneMobileEditorScope()).toBe("https://demo.edgeever.org|user-1");
  });

  test("drops a stale scope when the opener has none", () => {
    installSessionStorage();
    markStandaloneMobileEditorOpened("memo-1", "https://demo.edgeever.org|user-1");

    markStandaloneMobileEditorOpened("memo-2", null);

    expect(getStandaloneMobileEditorScope()).toBeNull();
  });
});
