import { describe, expect, test } from "bun:test";
import {
  countEditableShares,
  describeEditPolicy,
  editableMemberNames,
  groupSharedItems,
} from "./shared-with-me.ts";

const group = (id, name, extra = {}) => ({
  id,
  name,
  description: null,
  shareCount: 0,
  memberCount: 2,
  ...extra,
});

const notebook = (id, groupId, groupName, extra = {}) => ({
  id,
  name: id,
  icon: null,
  parentId: null,
  groupId,
  groupName,
  editMode: "author",
  canEdit: false,
  memoCount: 0,
  authorUsername: "alice",
  authorDisplayName: "Alice",
  ...extra,
});

const memo = (id, groupId, groupName) => ({
  id,
  title: id,
  excerpt: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
  groupId,
  groupName,
  editMode: "author",
  canEdit: false,
  authorUsername: "alice",
  authorDisplayName: "Alice",
});

describe("shared with me grouping", () => {
  test("keeps empty groups visible next to shared items", () => {
    const sections = groupSharedItems({
      groups: [group("g2", "工作"), group("g1", "家庭")],
      notebooks: [notebook("nb1", "g1", "家庭")],
      memos: [memo("m1", "g1", "家庭"), memo("m2", "g2", "工作")],
    });

    expect(sections.map((section) => section.group.name)).toEqual(["工作", "家庭"]);
    expect(sections[0].memos.map((entry) => entry.id)).toEqual(["m2"]);
    expect(sections[1].notebooks.map((entry) => entry.id)).toEqual(["nb1"]);
    expect(sections[1].memos.map((entry) => entry.id)).toEqual(["m1"]);
  });

  test("describes the editing policy of a share", () => {
    expect(describeEditPolicy({ editMode: "author", editorUserIds: [] })).toBe("author");
    expect(describeEditPolicy({ editMode: "group", editorUserIds: [] })).toBe("group");
    expect(describeEditPolicy({ editMode: "group", editorUserIds: ["usr_1"] })).toBe("selected");
    expect(countEditableShares([
      { editMode: "group", editorUserIds: [] },
      { editMode: "author", editorUserIds: [] },
    ])).toBe(1);
  });

  test("resolves the members that may write a shared item", () => {
    const members = [{ userId: "usr_1", username: "alice", displayName: "Alice" }];
    expect(editableMemberNames({ editMode: "author", editorUserIds: [] }, members)).toEqual([]);
    expect(editableMemberNames({ editMode: "group", editorUserIds: [] }, members)).toEqual([]);
    expect(editableMemberNames({ editMode: "group", editorUserIds: ["usr_1"] }, members)).toEqual(["Alice"]);
    expect(editableMemberNames({ editMode: "group", editorUserIds: ["usr_9"] }, members)).toEqual(["usr_9"]);
  });
});
