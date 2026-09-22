PRAGMA foreign_keys = ON;

-- Instance-level settings managed by the owner from the admin console.
-- Secrets (SMTP password) are stored as AES-GCM ciphertext produced by
-- secret-encryption.ts with the instance credentials key; they are never
-- returned in plaintext by the API.
CREATE TABLE IF NOT EXISTS instance_settings (
  id TEXT PRIMARY KEY CHECK (id = 'instance'),
  registration_enabled INTEGER NOT NULL DEFAULT 0 CHECK (registration_enabled IN (0, 1)),
  registration_code_required INTEGER NOT NULL DEFAULT 0 CHECK (registration_code_required IN (0, 1)),
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure INTEGER NOT NULL DEFAULT 1 CHECK (smtp_secure IN (0, 1)),
  smtp_username TEXT,
  smtp_password_encrypted TEXT,
  smtp_from_address TEXT,
  smtp_from_name TEXT,
  share_missing_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO instance_settings (id) VALUES ('instance')
  ON CONFLICT(id) DO NOTHING;

-- Members can register with an email address and sign in with it.
ALTER TABLE users ADD COLUMN email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email)
  WHERE email IS NOT NULL;

-- Pending email verification codes for self-registration.
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_email
  ON email_verifications(email, created_at);
