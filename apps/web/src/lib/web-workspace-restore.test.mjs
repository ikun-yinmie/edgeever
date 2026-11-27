import { describe, expect, test } from "bun:test";
import {
  getWebWorkspaceRestoreStorageKey,
  readWebWorkspaceRestoreState,
  writeWebWorkspaceRestoreState,
  WEB_WORKSPACE_RESTORE_STORAGE_KEY_PREFIX,
} from "./web-workspace-restore.ts";

const createStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => { delete data[key]; },
  };
};

describe("web workspace restore", () => {
  test("round-trips the last notebook and memo per user", () => {
    const storage = createStorage();

    expect(writeWebWorkspaceRestoreState("user_1", {
      selectedMemoId: "memo_1",
      selectedNotebookId: "nb_1",
      memoView: "notebook",
    }, storage)).toBe(true);
    expect(readWebWorkspaceRestoreState("user_1", storage)).toEqual({
      selectedMemoId: "memo_1",
      selectedNotebookId: "nb_1",
      memoView: "notebook",
      openMemoTabs: ["memo_1"],
    });
    expect(storage.data[getWebWorkspaceRestoreStorageKey("user_1")]).toContain("memo_1");
  });

  test("keeps different users isolated and returns null without a stored snapshot", () => {
    const storage = createStorage();

    writeWebWorkspaceRestoreState("user_1", {
      selectedMemoId: "memo_1",
      selectedNotebookId: "nb_1",
      memoView: "notebook",
    }, storage);

    expect(readWebWorkspaceRestoreState("user_2", storage)).toBeNull();
    expect(readWebWorkspaceRestoreState("user_1", createStorage())).toBeNull();
    expect(readWebWorkspaceRestoreState("", storage)).toBeNull();
  });

  test("retains all tab ordering and active selection, including tabs outside the selected notebook", () => {
    const storage = createStorage();
    const state = { selectedMemoId: "memo_b", selectedNotebookId: "nb_a", memoView: "notebook", openMemoTabs: ["memo_c", "memo_b", "memo_a"] };
    writeWebWorkspaceRestoreState("user_1", state, storage);
    expect(readWebWorkspaceRestoreState("user_1", storage)).toEqual(state);
    writeWebWorkspaceRestoreState("user_2", { ...state, selectedMemoId: null, openMemoTabs: [] }, storage);
    expect(readWebWorkspaceRestoreState("user_1", storage)).toEqual(state);
    expect(readWebWorkspaceRestoreState("user_2", storage)?.openMemoTabs).toEqual([]);
  });

  test("explicitly closing the last tab survives another reload", () => {
    const storage = createStorage();
    const closed = { selectedMemoId: null, selectedNotebookId: "nb_a", memoView: "notebook", openMemoTabs: [] };
    writeWebWorkspaceRestoreState("user_1", closed, storage);
    expect(readWebWorkspaceRestoreState("user_1", storage)).toEqual(closed);
    writeWebWorkspaceRestoreState("user_1", readWebWorkspaceRestoreState("user_1", storage), storage);
    expect(readWebWorkspaceRestoreState("user_1", storage)).toEqual(closed);
  });

  test("cleans malformed and invalid records without touching another account", () => {
    const key = getWebWorkspaceRestoreStorageKey("user_1");
    for (const raw of ["{", "null", "[]", "false", "{}"] ) {
      const storage = createStorage({ [key]: raw, [getWebWorkspaceRestoreStorageKey("user_2")]: "untouched" });
      expect(readWebWorkspaceRestoreState("user_1", storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
      expect(storage.getItem(getWebWorkspaceRestoreStorageKey("user_2"))).toBe("untouched");
    }
  });

  test("ignores malformed snapshots and survives unavailable storage", () => {
    expect(readWebWorkspaceRestoreState("user_1", createStorage({
      [`${WEB_WORKSPACE_RESTORE_STORAGE_KEY_PREFIX}user_1`]: "{",
    }))).toBeNull();

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readWebWorkspaceRestoreState("user_1", blocked)).toBeNull();
    expect(writeWebWorkspaceRestoreState("user_1", {
      selectedMemoId: null,
      selectedNotebookId: null,
      memoView: "notebook",
    }, blocked)).toBe(false);
  });
});
