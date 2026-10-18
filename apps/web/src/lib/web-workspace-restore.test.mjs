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
