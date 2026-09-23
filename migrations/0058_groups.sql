PRAGMA foreign_keys = ON;

-- Groups are the collaboration container requested for self-hosted instances:
-- the administrator assembles a group, and any member can share one of their own
-- notebooks (with everything under it) or a single note into that group. Every
-- group member can then read it; editing is granted per share, either to the
-- author alone or to the group (optionally narrowed to listed members).
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_user
  ON group_members(user_id, group_id);

-- One row per shared notebook/note. `source_workspace_id` keeps the owning
-- workspace so read/write access can be resolved without scanning shares.
CREATE TABLE IF NOT EXISTS group_shares (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('notebook', 'memo')),
  target_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  edit_mode TEXT NOT NULL DEFAULT 'author' CHECK (edit_mode IN ('author', 'group')),
  editor_user_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(editor_user_ids)),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  FOREIGN KEY (group_id) REFERENCES groups(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_shares_active_target
  ON group_shares(group_id, target_type, target_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_group_shares_group
  ON group_shares(group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_shares_target
  ON group_shares(target_type, target_id, revoked_at);
