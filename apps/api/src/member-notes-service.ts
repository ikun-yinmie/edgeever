import type {
  MemberNotesAccessMode,
  MemberNotesAccessSettings,
  MemberNotesMember,
  MemberNotesMembersResponse,
} from "@edgeever/shared";
import { auditStatement } from "./audit";
import { AppError } from "./app-error";
import { isoNow } from "./entity-utils";
import { INSTANCE_SETTINGS_ID } from "./instance-settings-service";
import type { ResourceRow } from "./resource-service";
import type { DatabaseAdapter } from "./storage-contract";

type MemberNotesAccessRow = {
  member_notes_access_mode: string | null;
};

type MemberNotesGrantRow = {
  user_id: string;
};

type MemberNotesMemberRow = {
  id: string;
  username: string;
  display_name: string | null;
  account_type: "user" | "group" | null;
  workspace_id: string;
  memo_count: number;
  last_memo_updated_at: string | null;
};

export type MemberNotesTarget = {
  id: string;
  username: string;
  displayName: string | null;
  accountType: "user" | "group";
  workspaceId: string;
};

const MEMBER_NOTES_ACCESS_MODES = new Set<MemberNotesAccessMode>(["off", "all", "selected"]);

const normalizeAccessMode = (value: string | null | undefined): MemberNotesAccessMode =>
  value && MEMBER_NOTES_ACCESS_MODES.has(value as MemberNotesAccessMode)
    ? value as MemberNotesAccessMode
    : "off";

const mapMemberRow = (row: MemberNotesMemberRow): MemberNotesMember => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  accountType: row.account_type === "group" ? "group" : "user",
  memoCount: Number(row.memo_count ?? 0),
  lastMemoUpdatedAt: row.last_memo_updated_at,
});

export const getMemberNotesAccessSettings = async (
  database: DatabaseAdapter,
): Promise<MemberNotesAccessSettings> => {
  const [settingsRow, grantRows] = await Promise.all([
    database
      .prepare(`SELECT member_notes_access_mode FROM instance_settings WHERE id = ?`)
      .bind(INSTANCE_SETTINGS_ID)
      .first<MemberNotesAccessRow>(),
    database
      .prepare(
        `SELECT g.user_id
         FROM member_notes_access_grants g
         INNER JOIN users u ON u.id = g.user_id
         WHERE u.is_deleted = 0 AND COALESCE(u.account_type, 'user') <> 'group'
         ORDER BY g.created_at ASC`,
      )
      .all<MemberNotesGrantRow>(),
  ]);

  return {
    mode: normalizeAccessMode(settingsRow?.member_notes_access_mode),
    selectedUserIds: (grantRows.results ?? []).map((row) => row.user_id),
  };
};

export const listMemberNotesMembers = async (
  database: DatabaseAdapter,
  ownerUserId: string,
): Promise<MemberNotesMembersResponse> => {
  const settings = await getMemberNotesAccessSettings(database);
  if (settings.mode === "off") {
    return { mode: settings.mode, members: [] };
  }

  const conditions = [
    "u.is_deleted = 0",
    "u.id <> ?",
    "COALESCE(u.account_type, 'user') <> 'group'",
  ];
  const binds: unknown[] = [ownerUserId];

  if (settings.mode === "selected") {
    if (settings.selectedUserIds.length === 0) {
      return { mode: settings.mode, members: [] };
    }
    conditions.push(`u.id IN (${settings.selectedUserIds.map(() => "?").join(", ")})`);
    binds.push(...settings.selectedUserIds);
  }

  const rows = await database
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.account_type, wm.workspace_id,
              COUNT(CASE WHEN m.is_deleted = 0 THEN 1 END) AS memo_count,
              MAX(CASE WHEN m.is_deleted = 0 THEN m.updated_at END) AS last_memo_updated_at
       FROM users u
       INNER JOIN workspace_members wm ON wm.user_id = u.id
       LEFT JOIN memos m ON m.workspace_id = wm.workspace_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY u.id, u.username, u.display_name, u.account_type, wm.workspace_id, u.created_at
       ORDER BY u.created_at ASC, u.username COLLATE NOCASE ASC`,
    )
    .bind(...binds)
    .all<MemberNotesMemberRow>();

  return { mode: settings.mode, members: (rows.results ?? []).map(mapMemberRow) };
};

export const resolveMemberNotesTarget = async (
  database: DatabaseAdapter,
  ownerUserId: string,
  targetUserId: string,
): Promise<MemberNotesTarget | null> => {
  if (!targetUserId || targetUserId === ownerUserId) return null;

  const settings = await getMemberNotesAccessSettings(database);
  if (settings.mode === "off") return null;
  if (settings.mode === "selected" && !settings.selectedUserIds.includes(targetUserId)) {
    return null;
  }

  const row = await database
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.account_type, wm.workspace_id
       FROM users u
       INNER JOIN workspace_members wm ON wm.user_id = u.id
       WHERE u.id = ? AND u.is_deleted = 0
         AND COALESCE(u.account_type, 'user') <> 'group'`,
    )
    .bind(targetUserId)
    .first<Omit<MemberNotesMemberRow, "memo_count" | "last_memo_updated_at">>();

  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    accountType: row.account_type === "group" ? "group" : "user",
    workspaceId: row.workspace_id,
  };
};

export const updateMemberNotesAccess = async (
  database: DatabaseAdapter,
  input: { mode: MemberNotesAccessMode; selectedUserIds?: string[]; actorId: string | null },
): Promise<MemberNotesAccessSettings> => {
  const selectedUserIds = input.selectedUserIds === undefined
    ? undefined
    : Array.from(new Set(input.selectedUserIds));

  if (selectedUserIds !== undefined && selectedUserIds.length > 0) {
    const rows = await database
      .prepare(
        `SELECT u.id
         FROM users u
         INNER JOIN workspace_members wm ON wm.user_id = u.id
         WHERE u.id IN (${selectedUserIds.map(() => "?").join(", ")})
           AND u.id <> ?
           AND u.is_deleted = 0
           AND COALESCE(u.account_type, 'user') <> 'group'`,
      )
      .bind(...selectedUserIds, input.actorId ?? "")
      .all<{ id: string }>();
    const allowedIds = new Set((rows.results ?? []).map((row) => row.id));
    if (allowedIds.size !== selectedUserIds.length) {
      throw new AppError(
        "member_notes_invalid_members",
        "One or more selected members are unavailable.",
        400,
      );
    }
  }

  const now = isoNow();
  const statements = [
    database
      .prepare(
        `UPDATE instance_settings
         SET member_notes_access_mode = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.mode, now, INSTANCE_SETTINGS_ID),
  ];

  if (selectedUserIds !== undefined) {
    statements.push(
      database.prepare(`DELETE FROM member_notes_access_grants`),
      ...selectedUserIds.map((userId) =>
        database
          .prepare(`INSERT INTO member_notes_access_grants (user_id, created_at) VALUES (?, ?)`)
          .bind(userId, now),
      ),
    );
  }

  statements.push(
    auditStatement(
      database,
      "user",
      input.actorId,
      "member_notes_access.update",
      "instance_settings",
      INSTANCE_SETTINGS_ID,
      {
        mode: input.mode,
        selectedCount: selectedUserIds?.length,
      },
    ),
  );

  await database.batch(statements);
  return getMemberNotesAccessSettings(database);
};

/**
 * Images and attachments inside another member's note bypass the owner's own
 * workspace, so the resource route asks this helper after its normal and group
 * share lookups both miss.
 */
export const resolveMemberNotesResourceRow = async (
  database: DatabaseAdapter,
  ownerUserId: string,
  resourceId: string,
): Promise<ResourceRow | null> => {
  const resource = await database
    .prepare(
      `SELECT r.id, r.memo_id, r.original_memo_id, r.bucket_name, r.object_key, r.storage_config_id,
              r.kind, r.mime_type, r.filename, r.byte_size, r.sha256, r.width, r.height,
              r.created_at, r.updated_at, r.is_deleted, m.workspace_id AS memo_workspace_id
       FROM resources r
       INNER JOIN memos m ON m.id = r.memo_id
       WHERE r.id = ? AND r.is_deleted = 0 AND m.is_deleted = 0`,
    )
    .bind(resourceId)
    .first<ResourceRow & { memo_workspace_id: string }>();
  if (!resource) return null;

  const membership = await database
    .prepare(
      `SELECT user_id FROM workspace_members
       WHERE workspace_id = ?
       ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
    )
    .bind(resource.memo_workspace_id)
    .first<{ user_id: string }>();
  if (!membership) return null;

  const target = await resolveMemberNotesTarget(database, ownerUserId, membership.user_id);
  return target ? resource : null;
};
