PRAGMA foreign_keys = ON;

-- Registration hardening requested by self-hosters: invite codes so not
-- everyone can register, configurable verification-code policy (TTL,
-- resend cooldown, IP/device binding) and per-IP abuse limits.

ALTER TABLE instance_settings ADD COLUMN registration_invite_required INTEGER NOT NULL DEFAULT 0 CHECK (registration_invite_required IN (0, 1));
ALTER TABLE instance_settings ADD COLUMN code_ttl_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE instance_settings ADD COLUMN code_resend_cooldown_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE instance_settings ADD COLUMN code_bind_ip INTEGER NOT NULL DEFAULT 0 CHECK (code_bind_ip IN (0, 1));
ALTER TABLE instance_settings ADD COLUMN code_bind_device INTEGER NOT NULL DEFAULT 0 CHECK (code_bind_device IN (0, 1));
ALTER TABLE instance_settings ADD COLUMN abuse_guard_enabled INTEGER NOT NULL DEFAULT 1 CHECK (abuse_guard_enabled IN (0, 1));
ALTER TABLE instance_settings ADD COLUMN code_ip_hourly_limit INTEGER NOT NULL DEFAULT 10;
ALTER TABLE instance_settings ADD COLUMN code_ip_daily_limit INTEGER NOT NULL DEFAULT 30;

-- Track how and where codes were requested so registration can enforce the
-- IP/device binding policy and per-IP abuse limits.
ALTER TABLE email_verifications ADD COLUMN ip TEXT;
ALTER TABLE email_verifications ADD COLUMN device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_email_verifications_ip
  ON email_verifications(ip, created_at)
  WHERE ip IS NOT NULL;

-- Admin-issued invite codes. Only the sha256 hash is stored; the plaintext
-- code is shown to the administrator exactly once when the invite is created.
CREATE TABLE IF NOT EXISTS registration_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  note TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
