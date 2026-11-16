-- Keep request identities after memo deletion so retries cannot recreate deleted notes.
CREATE TABLE memo_create_requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  creation_id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, creation_id)
);
