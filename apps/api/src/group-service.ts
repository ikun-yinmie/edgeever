// Group-based collaboration layer.
//
// Groups never move notes around: a note keeps living in its author's personal
// workspace, and a share row grants every group member read access to it (plus,
// for notebooks, to everything nested underneath). Editing is granted by the
// share through `edit_mode`:
//
//   author -> only the note's author (the owner of the source workspace) writes
//   group  -> group members write, optionally narrowed to `editor_user_ids`
//
// This module is the single source of truth for that decision, so the memo
// routes only have to ask "may this actor read/write this note?".

import { createId, isoNow } from "./entity-utils";
import type { DatabaseAdapter } from "./storage-contract";

export type GroupRow = {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type GroupMemberRow = {
  group_id: string;
  user_id: string;
  role: "manager" | "member";
  created_at: string;
  username: string | null;
  display_name: string | null;
};

export type GroupShareRow = {
  id: string;
  group_id: string;
  target_type: "notebook" | "memo";
  target_id: string;
  source_workspace_id: string;
  edit_mode: "author" | "group";
  editor_user_ids: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type GroupShareView = {
  id: string;
  groupId: string;
  groupName: string;
  targetType: "notebook" | "memo";
  targetId: string;
  title: string;
  editMode: "author" | "group";
  editorUserIds: string[];
  note: string | null;
  createdAt: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
};

export type SharedWithMeGroup = {
  id: string;
  name: string;
  description: string | null;
  shareCount: number;
  memberCount: number;
};

export type SharedWithMeNotebook = {
  id: string;
  name: string;
  icon: string | null;
  parentId: string | null;
  groupId: string;
  groupName: string;
  editMode: "author" | "group";
  canEdit: boolean;
  memoCount: number;
  authorUsername: string | null;
  authorDisplayName: string | null;
};

export type SharedWithMeMemo = {
  id: string;
  title: string | null;
  excerpt: string;
  updatedAt: string;
  groupId: string;
  groupName: string;
  editMode: "author" | "group";
  canEdit: boolean;
  authorUsername: string | null;
  authorDisplayName: string | null;
};

export type SharedMemoSummary = {
  id: string;
  title: string | null;
  excerpt: string;
  updatedAt: string;
  createdAt: string;
  notebookId: string;
  canEdit: boolean;
};

export type SharedAccess = {
  /** Workspace that actually owns the row; use it for every follow-up query. */
  workspaceId: string;
  isOwner: boolean;
  canRead: boolean;
  canEdit: boolean;
  shareId: string | null;
  groupId: string | null;
  groupName: string | null;
  editMode: "author" | "group" | null;
};

const parseEditorIds = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

const groupEditAllowed = (share: Pick<GroupShareRow, "edit_mode" | "editor_user_ids">, userId: string) => {
  if (share.edit_mode !== "group") return false;
  const editors = parseEditorIds(share.editor_user_ids);
  return editors.length === 0 || editors.includes(userId);
};

const emptyAccess = (workspaceId: string): SharedAccess => ({
  workspaceId,
  isOwner: false,
  canRead: false,
  canEdit: false,
  shareId: null,
  groupId: null,
  groupName: null,
  editMode: null,
});

/** The shared notebook itself and every notebook nested underneath it. */
export const loadNotebookDescendantIds = async (database: DatabaseAdapter, notebookId: string) => {
  const rows = await database
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM notebooks WHERE id = ?
         UNION ALL
         SELECT n.id FROM notebooks n INNER JOIN tree t ON n.parent_id = t.id
       ) SELECT id FROM tree`,
    )
    .bind(notebookId)
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
};

/** The notebook itself plus every ancestor, used to match notebook shares. */
const loadNotebookAncestorIds = async (database: DatabaseAdapter, notebookId: string) => {
  const rows = await database
    .prepare(
      `WITH RECURSIVE chain(id, parent_id) AS (
         SELECT id, parent_id FROM notebooks WHERE id = ?
         UNION ALL
         SELECT n.id, n.parent_id FROM notebooks n INNER JOIN chain c ON n.id = c.parent_id
       ) SELECT id FROM chain`,
    )
    .bind(notebookId)
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
};

type ActiveShareRow = Pick<
  GroupShareRow,
  "id" | "group_id" | "target_type" | "target_id" | "edit_mode" | "editor_user_ids"
> & { group_name: string };

const findSharesForActor = async (database: DatabaseAdapter, userId: string) => {
  const rows = await database
    .prepare(
      `SELECT s.id, s.group_id, s.target_type, s.target_id, s.edit_mode, s.editor_user_ids,
              g.name AS group_name
       FROM group_shares s
       INNER JOIN groups g ON g.id = s.group_id
       INNER JOIN group_members gm ON gm.group_id = s.group_id AND gm.user_id = ?
       WHERE s.revoked_at IS NULL`,
    )
    .bind(userId)
    .all<ActiveShareRow>();
  return rows.results ?? [];
};

const pickShare = (
  shares: ActiveShareRow[],
  memoId: string,
  notebookChain: string[],
  userId: string,
) => {
  const matching = shares.filter((share) =>
    share.target_type === "memo"
      ? share.target_id === memoId
      : notebookChain.includes(share.target_id),
  );
  if (matching.length === 0) return null;
  return matching.find((share) => groupEditAllowed(share, userId)) ?? matching[0];
};

export const resolveMemoAccess = async (
  database: DatabaseAdapter,
  options: { userId: string; ownWorkspaceId: string; memoId: string },
): Promise<(SharedAccess & { memoId: string; notebookId: string; isDeleted: boolean }) | null> => {
  const memo = await database
    .prepare(`SELECT id, workspace_id, notebook_id, is_deleted FROM memos WHERE id = ?`)
    .bind(options.memoId)
    .first<{ id: string; workspace_id: string; notebook_id: string; is_deleted: number }>();
  if (!memo) return null;

  const base = { memoId: memo.id, notebookId: memo.notebook_id, isDeleted: memo.is_deleted === 1 };
  if (memo.workspace_id === options.ownWorkspaceId) {
    return {
      ...base,
      workspaceId: memo.workspace_id,
      isOwner: true,
      canRead: true,
      canEdit: true,
      shareId: null,
      groupId: null,
      groupName: null,
      editMode: null,
    };
  }

  const shares = await findSharesForActor(database, options.userId);
  if (shares.length === 0) return { ...base, ...emptyAccess(memo.workspace_id) };
  const chain = await loadNotebookAncestorIds(database, memo.notebook_id);
  const share = pickShare(shares, memo.id, chain, options.userId);
  if (!share) return { ...base, ...emptyAccess(memo.workspace_id) };

  return {
    ...base,
    workspaceId: memo.workspace_id,
    isOwner: false,
    // Deleted notes stay invisible through a share; only the owner sees the bin.
    canRead: !base.isDeleted,
    canEdit: !base.isDeleted && groupEditAllowed(share, options.userId),
    shareId: share.id,
    groupId: share.group_id,
    groupName: share.group_name,
    editMode: share.edit_mode,
  };
};

export const resolveNotebookAccess = async (
  database: DatabaseAdapter,
  options: { userId: string; ownWorkspaceId: string; notebookId: string },
): Promise<SharedAccess | null> => {
  const notebook = await database
    .prepare(`SELECT id, workspace_id, is_deleted FROM notebooks WHERE id = ?`)
    .bind(options.notebookId)
    .first<{ id: string; workspace_id: string; is_deleted: number }>();
  if (!notebook) return null;
  if (notebook.workspace_id === options.ownWorkspaceId) {
    return { ...emptyAccess(notebook.workspace_id), isOwner: true, canRead: true, canEdit: true };
  }

  const shares = await findSharesForActor(database, options.userId);
  const chain = await loadNotebookAncestorIds(database, notebook.id);
  const share = shares.find((entry) => entry.target_type === "notebook" && chain.includes(entry.target_id));
  if (!share || notebook.is_deleted === 1) return emptyAccess(notebook.workspace_id);

  return {
    workspaceId: notebook.workspace_id,
    isOwner: false,
    canRead: true,
    canEdit: groupEditAllowed(share, options.userId),
    shareId: share.id,
    groupId: share.group_id,
    groupName: share.group_name,
    editMode: share.edit_mode,
  };
};

export const listGroupsForUser = async (database: DatabaseAdapter, userId: string) => {
  const rows = await database
    .prepare(
      `SELECT g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
              (SELECT COUNT(*) FROM group_shares s WHERE s.group_id = g.id AND s.revoked_at IS NULL) AS share_count,
              gm.role AS my_role
       FROM groups g
       INNER JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
       ORDER BY g.name COLLATE NOCASE ASC`,
    )
    .bind(userId)
    .all<GroupRow & { member_count: number; share_count: number; my_role: "manager" | "member" }>();
  return rows.results ?? [];
};

export const getGroupRow = async (database: DatabaseAdapter, groupId: string) =>
  database
    .prepare(`SELECT id, name, description, created_by, created_at, updated_at FROM groups WHERE id = ?`)
    .bind(groupId)
    .first<GroupRow>();

export const isGroupMember = async (database: DatabaseAdapter, groupId: string, userId: string) => {
  const row = await database
    .prepare(`SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`)
    .bind(groupId, userId)
    .first<{ role: "manager" | "member" }>();
  return row?.role ?? null;
};

export const listGroupMembers = async (database: DatabaseAdapter, groupId: string) => {
  const rows = await database
    .prepare(
      `SELECT gm.group_id, gm.user_id, gm.role, gm.created_at,
              u.username, u.display_name
       FROM group_members gm
       LEFT JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY gm.role = 'manager' DESC, u.username COLLATE NOCASE ASC`,
    )
    .bind(groupId)
    .all<GroupMemberRow>();
  return rows.results ?? [];
};

export const createGroup = async (
  database: DatabaseAdapter,
  input: { name: string; description: string | null; createdBy: string | null },
) => {
  const id = createId("grp");
  const now = isoNow();
  await database.batch([
    database
      .prepare(
        `INSERT INTO groups (id, name, description, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.name, input.description, input.createdBy, now, now),
    ...(input.createdBy
      ? [
          database
            .prepare(`INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, 'manager', ?)`)
            .bind(id, input.createdBy, now),
        ]
      : []),
  ]);
  return getGroupRow(database, id);
};

export const updateGroup = async (
  database: DatabaseAdapter,
  groupId: string,
  input: { name?: string; description?: string | null },
) => {
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) {
    updates.push("name = ?");
    binds.push(input.name);
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    binds.push(input.description);
  }
  if (updates.length === 0) return getGroupRow(database, groupId);
  updates.push("updated_at = ?");
  binds.push(isoNow(), groupId);
  await database.prepare(`UPDATE groups SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
  return getGroupRow(database, groupId);
};

export const deleteGroup = async (database: DatabaseAdapter, groupId: string) => {
  await database.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId).run();
};

export const addGroupMembers = async (
  database: DatabaseAdapter,
  groupId: string,
  userIds: string[],
) => {
  if (userIds.length === 0) return 0;
  const now = isoNow();
  const placeholders = userIds.map(() => "(?, ?, 'member', ?)").join(", ");
  const binds = userIds.flatMap((userId) => [groupId, userId, now]);
  await database
    .prepare(
      `INSERT INTO group_members (group_id, user_id, role, created_at) VALUES ${placeholders}
       ON CONFLICT(group_id, user_id) DO NOTHING`,
    )
    .bind(...binds)
    .run();
  return userIds.length;
};

export const removeGroupMember = async (database: DatabaseAdapter, groupId: string, userId: string) => {
  await database
    .prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`)
    .bind(groupId, userId)
    .run();
};

const SHARE_SELECT = `SELECT s.id, s.group_id, s.target_type, s.target_id, s.source_workspace_id,
    s.edit_mode, s.editor_user_ids, s.note, s.created_by, s.created_at, s.updated_at, s.revoked_at,
    g.name AS group_name,
    COALESCE(n.name, m.title, '') AS target_title,
    u.username AS author_username, u.display_name AS author_display_name
  FROM group_shares s
  INNER JOIN groups g ON g.id = s.group_id
  LEFT JOIN notebooks n ON s.target_type = 'notebook' AND n.id = s.target_id
  LEFT JOIN memos m ON s.target_type = 'memo' AND m.id = s.target_id
  LEFT JOIN users u ON u.id = s.created_by`;

const mapShareView = (row: GroupShareRow & {
  group_name: string;
  target_title: string;
  author_username: string | null;
  author_display_name: string | null;
}): GroupShareView => ({
  id: row.id,
  groupId: row.group_id,
  groupName: row.group_name,
  targetType: row.target_type,
  targetId: row.target_id,
  title: row.target_title,
  editMode: row.edit_mode,
  editorUserIds: parseEditorIds(row.editor_user_ids),
  note: row.note,
  createdAt: row.created_at,
  authorUsername: row.author_username,
  authorDisplayName: row.author_display_name,
});

export const listGroupShares = async (database: DatabaseAdapter, groupId: string) => {
  const rows = await database
    .prepare(`${SHARE_SELECT} WHERE s.group_id = ? AND s.revoked_at IS NULL ORDER BY s.created_at DESC`)
    .bind(groupId)
    .all<GroupShareRow & { group_name: string; target_title: string; author_username: string | null; author_display_name: string | null }>();
  return (rows.results ?? []).map(mapShareView);
};

export const listSharesCreatedBy = async (database: DatabaseAdapter, userId: string) => {
  const rows = await database
    .prepare(`${SHARE_SELECT} WHERE s.created_by = ? AND s.revoked_at IS NULL ORDER BY s.created_at DESC`)
    .bind(userId)
    .all<GroupShareRow & { group_name: string; target_title: string; author_username: string | null; author_display_name: string | null }>();
  return (rows.results ?? []).map(mapShareView);
};

export const getGroupShareRow = async (database: DatabaseAdapter, shareId: string) =>
  database
    .prepare(
      `SELECT id, group_id, target_type, target_id, source_workspace_id, edit_mode,
              editor_user_ids, note, created_by, created_at, updated_at, revoked_at
       FROM group_shares WHERE id = ?`,
    )
    .bind(shareId)
    .first<GroupShareRow>();

export const createGroupShare = async (
  database: DatabaseAdapter,
  input: {
    groupId: string;
    targetType: "notebook" | "memo";
    targetId: string;
    sourceWorkspaceId: string;
    editMode: "author" | "group";
    editorUserIds: string[];
    note: string | null;
    createdBy: string | null;
  },
) => {
  const id = createId("shr");
  const now = isoNow();
  await database
    .prepare(
      `INSERT INTO group_shares (id, group_id, target_type, target_id, source_workspace_id,
          edit_mode, editor_user_ids, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.groupId,
      input.targetType,
      input.targetId,
      input.sourceWorkspaceId,
      input.editMode,
      JSON.stringify(input.editorUserIds),
      input.note,
      input.createdBy,
      now,
      now,
    )
    .run();
  return id;
};

export const updateGroupShare = async (
  database: DatabaseAdapter,
  shareId: string,
  input: { editMode?: "author" | "group"; editorUserIds?: string[]; note?: string | null },
) => {
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (input.editMode !== undefined) {
    updates.push("edit_mode = ?");
    binds.push(input.editMode);
  }
  if (input.editorUserIds !== undefined) {
    updates.push("editor_user_ids = ?");
    binds.push(JSON.stringify(input.editorUserIds));
  }
  if (input.note !== undefined) {
    updates.push("note = ?");
    binds.push(input.note);
  }
  if (updates.length === 0) return;
  updates.push("updated_at = ?");
  binds.push(isoNow(), shareId);
  await database.prepare(`UPDATE group_shares SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
};

export const revokeGroupShare = async (database: DatabaseAdapter, shareId: string) => {
  await database
    .prepare(`UPDATE group_shares SET revoked_at = ?, updated_at = ? WHERE id = ?`)
    .bind(isoNow(), isoNow(), shareId)
    .run();
};

type SharedQueryRow = GroupShareRow & {
  group_name: string;
  notebook_name: string | null;
  notebook_icon: string | null;
  notebook_parent_id: string | null;
  memo_title: string | null;
  memo_excerpt: string | null;
  memo_updated_at: string | null;
  author_username: string | null;
  author_display_name: string | null;
};

const SHARED_WITH_ME_SELECT = `SELECT s.id, s.group_id, s.target_type, s.target_id, s.source_workspace_id,
    s.edit_mode, s.editor_user_ids, s.note, s.created_by, s.created_at, s.updated_at, s.revoked_at,
    g.name AS group_name,
    n.name AS notebook_name, n.icon AS notebook_icon, n.parent_id AS notebook_parent_id,
    m.title AS memo_title, m.excerpt AS memo_excerpt, m.updated_at AS memo_updated_at,
    u.username AS author_username, u.display_name AS author_display_name
  FROM group_shares s
  INNER JOIN groups g ON g.id = s.group_id
  INNER JOIN group_members gm ON gm.group_id = s.group_id AND gm.user_id = ?
  LEFT JOIN notebooks n ON s.target_type = 'notebook' AND n.id = s.target_id
  LEFT JOIN memos m ON s.target_type = 'memo' AND m.id = s.target_id
  LEFT JOIN users u ON u.id = s.created_by
  WHERE s.revoked_at IS NULL AND s.source_workspace_id <> ?
  ORDER BY g.name COLLATE NOCASE ASC, s.created_at DESC`;

export const listSharedWithMe = async (
  database: DatabaseAdapter,
  options: { userId: string; ownWorkspaceId: string },
) => {
  const rows = await database
    .prepare(SHARED_WITH_ME_SELECT)
    .bind(options.userId, options.ownWorkspaceId)
    .all<SharedQueryRow>();
  const shares = rows.results ?? [];

  const notebooks: SharedWithMeNotebook[] = [];
  const memos: SharedWithMeMemo[] = [];
  const groupIndex = new Map<string, SharedWithMeGroup>();

  for (const share of shares) {
    const countRow = groupIndex.get(share.group_id) ?? { id: share.group_id, name: share.group_name, description: null, shareCount: 0, memberCount: 0 };
    countRow.shareCount += 1;
    groupIndex.set(share.group_id, countRow);

    const canEdit = groupEditAllowed(share, options.userId);
    if (share.target_type === "notebook") {
      if (!share.notebook_name) continue;
      const descendants = await loadNotebookDescendantIds(database, share.target_id);
      const placeholders = descendants.map(() => "?").join(", ");
      const memoCount = await database
        .prepare(
          `SELECT COUNT(*) AS count FROM memos
           WHERE notebook_id IN (${placeholders}) AND is_deleted = 0`,
        )
        .bind(...descendants)
        .first<{ count: number }>();
      notebooks.push({
        id: share.target_id,
        name: share.notebook_name,
        icon: share.notebook_icon,
        parentId: share.notebook_parent_id,
        groupId: share.group_id,
        groupName: share.group_name,
        editMode: share.edit_mode,
        canEdit,
        memoCount: memoCount?.count ?? 0,
        authorUsername: share.author_username,
        authorDisplayName: share.author_display_name,
      });
      continue;
    }

    if (!share.memo_updated_at) continue;
    memos.push({
      id: share.target_id,
      title: share.memo_title,
      excerpt: share.memo_excerpt ?? "",
      updatedAt: share.memo_updated_at,
      groupId: share.group_id,
      groupName: share.group_name,
      editMode: share.edit_mode,
      canEdit,
      authorUsername: share.author_username,
      authorDisplayName: share.author_display_name,
    });
  }

  // Groups the actor belongs to, even when they hold no shares yet.
  const memberRows = await database
    .prepare(
      `SELECT g.id, g.name, g.description,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM groups g
       INNER JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
       ORDER BY g.name COLLATE NOCASE ASC`,
    )
    .bind(options.userId)
    .all<{ id: string; name: string; description: string | null; member_count: number }>();
  const groups: SharedWithMeGroup[] = (memberRows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    shareCount: groupIndex.get(row.id)?.shareCount ?? 0,
    memberCount: row.member_count,
  }));

  return { groups, notebooks, memos };
};

export const listSharedNotebookMemos = async (
  database: DatabaseAdapter,
  options: { userId: string; ownWorkspaceId: string; notebookId: string },
): Promise<SharedMemoSummary[]> => {
  const descendants = await loadNotebookDescendantIds(database, options.notebookId);
  if (descendants.length === 0) return [];
  const placeholders = descendants.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT m.id, m.title, m.excerpt, m.updated_at, m.created_at, m.notebook_id
       FROM memos m
       WHERE m.notebook_id IN (${placeholders}) AND m.is_deleted = 0
       ORDER BY m.updated_at DESC
       LIMIT 500`,
    )
    .bind(...descendants)
    .all<{ id: string; title: string | null; excerpt: string; updated_at: string; created_at: string; notebook_id: string }>();

  const accessByNotebook = new Map<string, boolean>();
  const summaries: SharedMemoSummary[] = [];
  for (const row of rows.results ?? []) {
    let canEdit = accessByNotebook.get(row.notebook_id);
    if (canEdit === undefined) {
      const access = await resolveNotebookAccess(database, {
        userId: options.userId,
        ownWorkspaceId: options.ownWorkspaceId,
        notebookId: row.notebook_id,
      });
      canEdit = Boolean(access?.canEdit);
      accessByNotebook.set(row.notebook_id, canEdit);
    }
    summaries.push({
      id: row.id,
      title: row.title,
      excerpt: row.excerpt,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      notebookId: row.notebook_id,
      canEdit,
    });
  }
  return summaries;
};
