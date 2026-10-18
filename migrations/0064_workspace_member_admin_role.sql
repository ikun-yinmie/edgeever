-- Instance roles grow from two levels (owner/member) to three:
--   owner  = site owner (the account that runs the instance, "站长")
--   admin  = administrator, appointed by the site owner, almost the same powers
--   member = regular member
-- The CHECK constraint on workspace_members.role cannot be altered in place, so
-- the table is rebuilt with its primary key, foreign keys and indexes preserved.
CREATE TABLE workspace_members_next (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

INSERT INTO workspace_members_next (workspace_id, user_id, role, created_at)
SELECT workspace_id, user_id, role, created_at FROM workspace_members;

DROP TABLE workspace_members;

ALTER TABLE workspace_members_next RENAME TO workspace_members;

CREATE UNIQUE INDEX idx_workspace_members_personal_user
  ON workspace_members(user_id);

CREATE INDEX idx_workspace_members_workspace
  ON workspace_members(workspace_id, role);

CREATE UNIQUE INDEX idx_workspace_single_owner
  ON workspace_members(workspace_id)
  WHERE role = 'owner';
