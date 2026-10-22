import type {
  GroupShareSummary,
  SharedWithMeGroup,
  SharedWithMeMemo,
  SharedWithMeNotebook,
} from "@/lib/api";

export type SharedEditPolicy = "author" | "group" | "selected";

/** Which slice of the shared pane to show: everything, group shares or link shares. */
export type SharedPaneScope = "all" | "group" | "link";

/** Where the shared pane should land: a scope, or a specific group's page. */
export type SharedPaneTarget = SharedPaneScope | { groupId: string };

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

/** A share the viewer may read but not write: the editor must stay in preview. */
export const isSharedAccessReadOnly = (
  access: { canEdit: boolean } | null | undefined,
) => Boolean(access && !access.canEdit);

/** Same-name notes from different members stay distinguishable in a notebook. */
export const buildSharedCopyTitle = (
  title: string | null | undefined,
  authorName: string | null | undefined,
  format: {
    withAuthor: (title: string, author: string) => string;
    withoutAuthor: (title: string) => string;
  },
) => {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) return "";
  const normalizedAuthor = authorName?.trim();
  return normalizedAuthor
    ? format.withAuthor(normalizedTitle, normalizedAuthor)
    : format.withoutAuthor(normalizedTitle);
};

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
