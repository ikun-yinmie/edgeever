PRAGMA foreign_keys = ON;

-- Invite codes have to stay copyable: the console (and the member who owns a
-- code) must be able to show and copy a code again long after creation. The
-- plaintext is therefore stored encrypted with the instance credentials key,
-- next to the existing hash that registration keeps validating against.
-- Codes created before this migration only keep their hash and can no longer be
-- displayed; they are marked as such in the console.
ALTER TABLE registration_invites ADD COLUMN code_encrypted TEXT;

-- Codes issued by a member instead of the administrator. A member code is
-- single-use and cannot be regenerated once it has been consumed.
ALTER TABLE registration_invites ADD COLUMN source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'user'));
ALTER TABLE registration_invites ADD COLUMN owner_user_id TEXT;
ALTER TABLE registration_invites ADD COLUMN used_by_user_id TEXT;
ALTER TABLE registration_invites ADD COLUMN used_at TEXT;

CREATE INDEX IF NOT EXISTS idx_registration_invites_source
  ON registration_invites(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_invites_owner
  ON registration_invites(owner_user_id, created_at DESC);

-- Members are archived instead of hard-deleted so their notes, attachments and
-- history stay recoverable; archived accounts disappear from member lists.
ALTER TABLE users ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_users_deleted
  ON users(is_deleted, created_at);
