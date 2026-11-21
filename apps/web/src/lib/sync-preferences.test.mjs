import { afterEach, describe, expect, test } from "bun:test";

class MemoryStorage {
  map = new Map();

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

const previousWindow = globalThis.window;

const installWindow = () => {
  const target = Object.assign(new EventTarget(), { localStorage: new MemoryStorage() });
  globalThis.window = target;
  return () => {
    globalThis.window = previousWindow;
  };
};

const {
  SyncPausedError,
  canPullFromServer,
  canPushToServer,
  getActiveSyncScope,
  getSyncPreferences,
  isSyncPausedError,
  requireSyncDirection,
  setActiveSyncScope,
  setSyncPause,
  setSyncPreferences,
  subscribeSyncPreferences,
} = await import("./sync-preferences.ts");

afterEach(() => {
  setSyncPause("all", false, "scope-a");
  setSyncPause("all", false, "scope-b");
  setActiveSyncScope(null);
});

describe("sync preferences", () => {
  test("defaults to syncing in both directions", () => {
    const restore = installWindow();
    try {
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: false, pausePush: false });
      expect(canPullFromServer("scope-a")).toBe(true);
      expect(canPushToServer("scope-a")).toBe(true);
    } finally {
      restore();
    }
  });

  test("pauses pull and push independently", () => {
    const restore = installWindow();
    try {
      setSyncPause("push", true, "scope-a");
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: false, pausePush: true });
      expect(canPullFromServer("scope-a")).toBe(true);
      expect(canPushToServer("scope-a")).toBe(false);

      setSyncPause("pull", true, "scope-a");
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: true, pausePush: true });

      setSyncPause("push", false, "scope-a");
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: true, pausePush: false });
    } finally {
      restore();
    }
  });

  test("keeps session preferences when storage reads and writes throw", () => {
    const restore = installWindow();
    try {
      window.localStorage.getItem = () => { throw new Error("Storage unavailable"); };
      window.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: false, pausePush: false });
      setSyncPause("push", true, "scope-a");
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: false, pausePush: true });
      expect(canPullFromServer("scope-a")).toBe(true);
      expect(canPushToServer("scope-a")).toBe(false);
    } finally {
      restore();
    }
  });

  test("the all switch sets and clears both directions", () => {
    const restore = installWindow();
    try {
      setSyncPause("all", true, "scope-a");
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: true, pausePush: true });
      setSyncPause("all", false, "scope-a");
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: false, pausePush: false });
    } finally {
      restore();
    }
  });

  test("keeps accounts isolated", () => {
    const restore = installWindow();
    try {
      setSyncPause("push", true, "scope-a");
      expect(getSyncPreferences("scope-a").pausePush).toBe(true);
      expect(getSyncPreferences("scope-b").pausePush).toBe(false);
      expect(getSyncPreferences()).toEqual({ pausePull: false, pausePush: false });
    } finally {
      restore();
    }
  });

  test("uses the active scope when none is passed", () => {
    const restore = installWindow();
    try {
      setActiveSyncScope("scope-a");
      expect(getActiveSyncScope()).toBe("scope-a");
      setSyncPreferences(undefined, { pausePull: true, pausePush: false });
      expect(getSyncPreferences()).toEqual({ pausePull: true, pausePush: false });
      expect(getSyncPreferences("scope-a")).toEqual({ pausePull: true, pausePush: false });
    } finally {
      restore();
    }
  });

  test("throws a typed pause error from direction guards", () => {
    const restore = installWindow();
    try {
      setSyncPause("pull", true, "scope-a");
      expect(() => requireSyncDirection("pull", "scope-a")).toThrow(SyncPausedError);
      try {
        requireSyncDirection("pull", "scope-a");
      } catch (error) {
        expect(isSyncPausedError(error)).toBe(true);
        expect(error.code).toBe("sync_paused");
        expect(error.direction).toBe("pull");
      }
      expect(() => requireSyncDirection("push", "scope-a")).not.toThrow();
    } finally {
      restore();
    }
  });

  test("notifies local listeners and cross-tab storage updates", () => {
    const restore = installWindow();
    try {
      const seen = [];
      const unsubscribe = subscribeSyncPreferences("scope-a", (preferences) => seen.push(preferences));
      setSyncPause("pull", true, "scope-a");
      expect(seen.at(-1)).toEqual({ pausePull: true, pausePush: false });

      window.localStorage.setItem("edgeever.sync-preferences:scope-a", JSON.stringify({ pausePull: false, pausePush: true }));
      const storageEvent = Object.assign(new Event("storage"), { key: "edgeever.sync-preferences:scope-a" });
      window.dispatchEvent(storageEvent);
      expect(seen.at(-1)).toEqual({ pausePull: false, pausePush: true });

      const otherScope = [];
      const unsubscribeOther = subscribeSyncPreferences("scope-b", (preferences) => otherScope.push(preferences));
      setSyncPause("pull", true, "scope-a");
      setSyncPause("pull", true, "scope-b");
      expect(otherScope.at(-1)).toEqual({ pausePull: true, pausePush: false });
      unsubscribe();
      unsubscribeOther();
    } finally {
      restore();
    }
  });
});