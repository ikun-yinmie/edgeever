// Shared (public) group accounts.
//
// A "group account" is a normal users row with account_type = 'group'. It is a
// shared credential: many people may sign in with it at the same time, so new
// sign-ins must never revoke existing sessions (unlike personal accounts,
// where a fresh sign-in replaces the previous session on the same device).
// Group accounts are members only: they never hold owner power, cannot mint
// API tokens, and their value is collaborating on notes shared into groups.

import { createId, isoNow } from "./entity-utils";
import { hashPassword } from "./auth-crypto";
import type { DatabaseAdapter } from "./storage-contract";
import { auditStatement } from "./audit";

export const GROUP_ACCOUNT_PREFIX = "shared_";

export type AccountType = "user" | "group";

export type GroupAccountRow = {
  id: string;
  username: string;
  display_name: string | null;
  is_disabled: number;
  created_at: string;
  group_count: number;
};

export const isGroupAccount = (accountType: string | null | undefined) => accountType === "group";

export const isGroupAccountUsername = (username: string) => username.startsWith(GROUP_ACCOUNT_PREFIX);

const normalizeUsername = (input: string) => {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  return isGroupAccountUsername(trimmed)
    ? trimmed
    : `${GROUP_ACCOUNT_PREFIX}${trimmed}`;
};

export const listGroupAccounts = async (database: DatabaseAdapter) => {
  const rows = await database
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_disabled, u.created_at,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.user_id = u.id) AS group_count
       FROM users u
       WHERE u.account_type = 'group' AND u.is_deleted = 0
       ORDER BY u.created_at ASC`,
    )
    .all<GroupAccountRow>();
  return rows.results ?? [];
};

export const createGroupAccount = async (
  database: DatabaseAdapter,
  input: { name: string; displayName: string | null; password: string; createdBy: string | null },
) => {
  const username = normalizeUsername(input.name);
  if (!username) throw new Error("A shared account name is required.");
  if (username.length > 80) throw new Error("The shared account name is too long.");

  const existing = await database
    .prepare(`SELECT id FROM users WHERE username = ?`)
    .bind(username)
    .first<{ id: string }>();
  if (existing) {
    return { ok: false as const, reason: "username_exists" as const, username };
  }

  const userId = createId("usr");
  const workspaceId = createId("ws");
  const now = isoNow();
  const passwordHash = await hashPassword(input.password);

  await database.batch([
    database
      .prepare(
        `INSERT INTO users (id, username, password_hash, display_name, account_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'group', ?, ?)`,
      )
      .bind(userId, username, passwordHash, input.displayName ?? username, now, now),
    // Shared accounts get a placeholder personal workspace so every workspace-
    // scoped query keeps working; they create no content of their own there.
    database
      .prepare(`INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .bind(workspaceId, `${input.displayName ?? username} (shared)`, now, now),
    database
      .prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
      .bind(workspaceId, userId, now),
    auditStatement(database, "user", input.createdBy, "user.create_group_account", "user", userId, {
      username,
    }),
  ]);
  return { ok: true as const, userId, username };
};

export const addGroupAccountToGroups = async (
  database: DatabaseAdapter,
  userId: string,
  groupIds: string[],
) => {
  if (groupIds.length === 0) return;
  const now = isoNow();
  const placeholders = groupIds.map(() => "(?, ?, 'member', ?)").join(", ");
  const binds = groupIds.flatMap((groupId) => [groupId, userId, now]);
  await database
    .prepare(
      `INSERT INTO group_members (group_id, user_id, role, created_at) VALUES ${placeholders}
       ON CONFLICT(group_id, user_id) DO NOTHING`,
    )
    .bind(...binds)
    .run();
};

export const listGroupAccountGroups = async (database: DatabaseAdapter, userId: string) => {
  const rows = await database
    .prepare(
      `SELECT g.id, g.name FROM groups g
       INNER JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ?
       ORDER BY g.name COLLATE NOCASE ASC`,
    )
    .bind(userId)
    .all<{ id: string; name: string }>();
  return rows.results ?? [];
};
