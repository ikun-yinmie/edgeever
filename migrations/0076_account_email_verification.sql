-- Existing addresses are deliberately NOT marked verified.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN account_email_version INTEGER NOT NULL DEFAULT 0;

-- One pending account-email challenge per user, separate from registration.
CREATE TABLE account_email_verifications (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose = 'account_email'),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  user_version INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Atomic reservations bound password work and delivery across Workers/processes.
CREATE TABLE account_email_rate_limits (
  rate_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at TEXT NOT NULL
);
CREATE INDEX idx_account_email_rate_limits_window ON account_email_rate_limits(window_started_at);

-- A monotonic revision also catches an administrator changing an address away
-- and back. Password resets from ANY entry point invalidate pending challenges.
CREATE TRIGGER users_account_email_state_changed AFTER UPDATE OF email, password_hash, is_disabled, is_deleted, account_type ON users WHEN (OLD.email IS NOT NEW.email OR OLD.password_hash IS NOT NEW.password_hash OR OLD.is_disabled IS NOT NEW.is_disabled OR OLD.is_deleted IS NOT NEW.is_deleted OR OLD.account_type IS NOT NEW.account_type) AND OLD.account_email_version = NEW.account_email_version BEGIN UPDATE users SET account_email_version = account_email_version + 1 WHERE id = NEW.id; END;

-- Verification advances the revision in the SAME UPDATE that sets the email,
-- so consuming the challenge and claiming the unique address are atomic.
CREATE TRIGGER users_account_email_challenge_invalidated AFTER UPDATE OF account_email_version ON users WHEN OLD.account_email_version IS NOT NEW.account_email_version BEGIN DELETE FROM account_email_verifications WHERE user_id = NEW.id; END;
