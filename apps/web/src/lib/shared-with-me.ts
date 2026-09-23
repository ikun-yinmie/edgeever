import type {
  GroupShareSummary,
  SharedWithMeGroup,
  SharedWithMeMemo,
  SharedWithMeNotebook,
} from "@/lib/api";

export type SharedEditPolicy = "author" | "group" | "selected";

export type SharedGroupSection = {
  group: SharedWithMeGroup;
  notebooks: SharedWithMeNotebook[];
  memos: SharedWithMeMemo[];
};

/** How a share lets other people write: only me, everyone, or listed members. */
export const describeEditPolicy = (share: {
  editMode: "author" | "group";
  editorUserIds: string[];
}): SharedEditPolicy => {
  if (share.editMode === "author") return "author";
  return share.editorUserIds.length > 0 ? "selected" : "group";
};

/** Shared items grouped by their group, keeping empty groups visible. */
export const groupSharedItems = (input: {
  groups: SharedWithMeGroup[];
  notebooks: SharedWithMeNotebook[];
  memos: SharedWithMeMemo[];
}): SharedGroupSection[] => {
  const sections = new Map<string, SharedGroupSection>();
  for (const group of input.groups) {
    sections.set(group.id, { group, notebooks: [], memos: [] });
  }
  const ensure = (groupId: string, groupName: string): SharedGroupSection => {
    const existing = sections.get(groupId);
    if (existing) return existing;
    const created: SharedGroupSection = {
      group: { id: groupId, name: groupName, description: null, shareCount: 0, memberCount: 0 },
      notebooks: [],
      memos: [],
    };
    sections.set(groupId, created);
    return created;
  };

  for (const notebook of input.notebooks) {
    ensure(notebook.groupId, notebook.groupName).notebooks.push(notebook);
  }
  for (const memo of input.memos) {
    ensure(memo.groupId, memo.groupName).memos.push(memo);
  }

  return [...sections.values()].sort((left, right) =>
    left.group.name.localeCompare(right.group.name, "zh-Hans-CN"),
  );
};

export const countEditableShares = (shares: GroupShareSummary[]) =>
  shares.filter((share) => share.editMode === "group").length;

/** Members that may write a shared item: none means the whole group. */
export const editableMemberNames = (
  share: Pick<GroupShareSummary, "editMode" | "editorUserIds">,
  members: { userId: string; username: string | null; displayName: string | null }[],
) => {
  if (share.editMode !== "group") return [];
  if (share.editorUserIds.length === 0) return [];
  return share.editorUserIds.map((userId) => {
    const member = members.find((entry) => entry.userId === userId);
    return member?.displayName || member?.username || userId;
  });
};
