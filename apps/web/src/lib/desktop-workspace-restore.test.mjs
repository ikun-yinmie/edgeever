import { describe, expect, test } from "bun:test";
import {
  DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY,
  normalizeWorkspaceRestoreState,
  readDesktopWorkspaceRestoreState,
  reconcileRestoredMemoTabs,
  shouldRestoreDesktopWorkspace,
  validateRestoredMemoTabs,
  writeDesktopWorkspaceRestoreState,
} from "./desktop-workspace-restore.ts";
import { remapMemoTabs, reorderMemoTabs } from "./memo-tabs.ts";

const createStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
};
const snapshot = {
  selectedMemoId: "memo_2",
  selectedNotebookId: "nb_1",
  memoView: "notebook",
  openMemoTabs: ["memo_3", "memo_1", "memo_2"],
};

describe("desktop workspace restore", () => {
  test("round-trips every tab in order with an independently selected tab", () => {
    const storage = createStorage();
    expect(writeDesktopWorkspaceRestoreState(snapshot, storage)).toBe(true);
    expect(readDesktopWorkspaceRestoreState(storage)).toEqual(snapshot);
  });

  test("persists reordering and a temporary-to-durable ID remap across reloads", () => {
    const storage = createStorage();
    const mappings = new Map([["local_1", "memo_1"]]);
    const tabs = reorderMemoTabs(["local_1", "memo_2", "memo_1"], "memo_2", "local_1");
    writeDesktopWorkspaceRestoreState({ ...snapshot, selectedMemoId: "memo_1", openMemoTabs: remapMemoTabs(tabs, mappings) }, storage);
    expect(readDesktopWorkspaceRestoreState(storage)).toEqual({ ...snapshot, selectedMemoId: "memo_1", openMemoTabs: ["memo_2", "memo_1"] });
  });

  test("upgrades an old single-selection snapshot but keeps trash separate from editor tabs", () => {
    const { openMemoTabs, ...legacy } = snapshot;
    expect(normalizeWorkspaceRestoreState(legacy)).toEqual({ ...legacy, openMemoTabs: ["memo_2"] });
    expect(normalizeWorkspaceRestoreState({ ...legacy, memoView: "trash" })).toEqual({ ...legacy, memoView: "trash", openMemoTabs: [] });
  });

  test("keeps an explicitly empty strip empty even if a stale selection remains", () => {
    const storage = createStorage();
    writeDesktopWorkspaceRestoreState({ ...snapshot, openMemoTabs: [] }, storage);
    expect(readDesktopWorkspaceRestoreState(storage)).toEqual({ ...snapshot, selectedMemoId: null, openMemoTabs: [] });
  });

  test("sanitizes duplicate/invalid IDs, selection, notebook and view", () => {
    expect(normalizeWorkspaceRestoreState({
      selectedMemoId: "missing", selectedNotebookId: {}, memoView: "wrong",
      openMemoTabs: [null, "memo_2", "", "memo_1", "memo_2", 7, "   ", {}],
    })).toEqual({ selectedMemoId: "memo_2", selectedNotebookId: null, memoView: "notebook", openMemoTabs: ["memo_2", "memo_1"] });
    expect(normalizeWorkspaceRestoreState({ ...snapshot, openMemoTabs: "bad" })).toEqual({ ...snapshot, selectedMemoId: null, openMemoTabs: [] });
  });

  test("discards malformed JSON and non-snapshot values and removes their stored records", () => {
    for (const raw of ["{", "null", "[]", "7", '"text"', "{}"] ) {
      const storage = createStorage({ [DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY]: raw });
      expect(readDesktopWorkspaceRestoreState(storage)).toBeNull();
      expect(storage.getItem(DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY)).toBeNull();
    }
  });

  test("isolates users and claims the old unscoped record only once", () => {
    const storage = createStorage({ [DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY]: JSON.stringify(snapshot) });
    expect(readDesktopWorkspaceRestoreState(storage, "user_1")).toEqual(snapshot);
    expect(readDesktopWorkspaceRestoreState(storage, "user_2")).toBeNull();
    const other = { ...snapshot, selectedMemoId: "other", openMemoTabs: ["other"] };
    writeDesktopWorkspaceRestoreState(other, storage, "user_2");
    expect(readDesktopWorkspaceRestoreState(storage, "user_1")).toEqual(snapshot);
    expect(readDesktopWorkspaceRestoreState(storage, "user_2")).toEqual(other);
    expect(storage.getItem(DESKTOP_WORKSPACE_RESTORE_STORAGE_KEY)).toBeNull();
  });

  test("survives unavailable storage", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readDesktopWorkspaceRestoreState(blocked)).toBeNull();
    expect(writeDesktopWorkspaceRestoreState(snapshot, blocked)).toBe(false);
  });

  test("is only used in the desktop renderer", () => {
    const previous = globalThis.window;
    globalThis.window = { edgeeverDesktop: { isAvailable: true } };
    try { expect(shouldRestoreDesktopWorkspace()).toBe(true); } finally { globalThis.window = previous; }
  });
});

describe("restored tab validation", () => {
  test("keeps cross-notebook tabs, fills titles, resolves old temporary IDs and drops confirmed deletions", async () => {
    const calls = [];
    const tabs = ["memo_1", "local_2", "trashed", "gone", "offline", "forbidden", "broken"];
    const result = await validateRestoredMemoTabs(tabs, async (id, includeDeleted) => {
      calls.push([id, includeDeleted]);
      if (id === "gone") throw { status: 404 };
      if (id === "offline") throw new Error("offline");
      if (id === "forbidden") throw { status: 403 };
      if (id === "broken") throw { status: 500 };
      return { memo: { id: id === "local_2" ? "memo_2" : id, title: `Title ${id}`, isDeleted: id === "trashed" } };
    });
    expect(calls).toEqual(tabs.map((id) => [id, true]));
    expect(result.removed).toEqual(new Set(["trashed", "gone"]));
    expect(result.titles).toEqual({ memo_1: "Title memo_1", memo_2: "Title local_2" });
    expect(reconcileRestoredMemoTabs({ openMemoTabs: tabs, selectedMemoId: "local_2" }, result)).toEqual({
      openMemoTabs: ["memo_1", "memo_2", "offline", "forbidden", "broken"], selectedMemoId: "memo_2",
    });
  });

  test("stops looking up more tabs after account teardown and accepts untitled notes", async () => {
    let active = true;
    const calls = [];
    const result = await validateRestoredMemoTabs(["first", "second"], async (id) => {
      calls.push(id);
      active = false;
      return { memo: { id, title: null } };
    }, () => active);
    expect(calls).toEqual(["first"]);
    expect(result.titles).toEqual({});
    expect(result.removed.size).toBe(0);
  });

  test("selects the nearest surviving neighbor when multiple tabs were deleted", () => {
    const validation = { removed: new Set(["b", "c"]), mappings: new Map() };
    expect(reconcileRestoredMemoTabs({ openMemoTabs: ["a", "b", "c", "d", "e"], selectedMemoId: "c" }, validation)).toEqual({ openMemoTabs: ["a", "d", "e"], selectedMemoId: "d" });
    expect(reconcileRestoredMemoTabs({ openMemoTabs: ["a", "b", "c"], selectedMemoId: "c" }, validation)).toEqual({ openMemoTabs: ["a"], selectedMemoId: "a" });
    expect(reconcileRestoredMemoTabs({ openMemoTabs: ["b", "c"], selectedMemoId: "c" }, validation)).toEqual({ openMemoTabs: [], selectedMemoId: null });
  });

  test("a late validation never resurrects tabs closed by the user or undoes a live ID remap", async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const validation = validateRestoredMemoTabs(["local_1"], async () => { await waiting; return { memo: { id: "memo_1", title: "Remote" } }; });
    release();
    const result = await validation;
    expect(reconcileRestoredMemoTabs({ openMemoTabs: [], selectedMemoId: null }, result)).toEqual({ openMemoTabs: [], selectedMemoId: null });
    expect(reconcileRestoredMemoTabs({ openMemoTabs: ["memo_1", "other"], selectedMemoId: "other" }, result)).toEqual({ openMemoTabs: ["memo_1", "other"], selectedMemoId: "other" });
  });
});
