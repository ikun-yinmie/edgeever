-- Keep the public contact separate from the private feedback delivery address.
ALTER TABLE instance_settings ADD COLUMN feedback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (feedback_enabled IN (0, 1));
ALTER TABLE instance_settings ADD COLUMN feedback_recipient_email TEXT;
ALTER TABLE instance_settings ADD COLUMN contact_email TEXT;

-- Account-wide serialization survives Worker isolates and self-hosted restarts.
-- No message bodies or SMTP credentials are stored in these bookkeeping tables.
CREATE TABLE feedback_account_leases (
  account_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE feedback_requests (
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  PRIMARY KEY (account_id, request_id)
);

CREATE INDEX idx_feedback_requests_success_window
  ON feedback_requests(account_id, succeeded_at)
  WHERE succeeded_at IS NOT NULL;
