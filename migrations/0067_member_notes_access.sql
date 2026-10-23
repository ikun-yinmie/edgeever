PRAGMA foreign_keys = ON;

-- The site owner may read members' personal notes from the workspace
-- directory ("人员簿"). The default is off; "all" exposes every active human
-- account, and "selected" limits access to the grants below.
ALTER TABLE instance_settings
  ADD COLUMN member_notes_access_mode TEXT NOT NULL DEFAULT 'off';

CREATE TABLE IF NOT EXISTS member_notes_access_grants (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_notes_access_grants_created
  ON member_notes_access_grants(created_at);
