-- 0061: Group collaboration, shared accounts and share display policies.
--
-- account_type marks shared/group accounts that allow many concurrent sessions
-- (multi-device sign-in) for collaborative editing of group notes.
--
-- display_policy_json carries the owner's { html, markdown } display decision
-- applied server-side to every public-link and group share payload:
--   "rendered" -> transcribe and show as rich content (default, current behavior)
--   "source"   -> show the raw source text instead of rendering it
--   "hidden"   -> collapse the block behind a placeholder for the audience
--
-- memo_collab_presence tracks "who is editing right now" for the collaboration
-- bar; rows are advisory only, expiring automatically.

ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'user'
  CHECK (account_type IN ('user', 'group'));

ALTER TABLE group_shares ADD COLUMN display_policy_json TEXT NOT NULL
  DEFAULT '{"html":"rendered","markdown":"rendered"}';

ALTER TABLE memo_shares ADD COLUMN display_policy_json TEXT NOT NULL
  DEFAULT '{"html":"rendered","markdown":"rendered"}';

CREATE TABLE IF NOT EXISTS memo_collab_presence (
  memo_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (memo_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_collab_presence_expiry
  ON memo_collab_presence(expires_at);
