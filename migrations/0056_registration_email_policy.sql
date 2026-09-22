PRAGMA foreign_keys = ON;

-- Email policy for self-registration: an admin-maintained allowlist (when
-- enabled, only these emails/domains may register) and a blocklist that always
-- wins. Entries are newline-separated domains (example.com, subdomains
-- included) or full addresses (name@example.com).
ALTER TABLE instance_settings ADD COLUMN email_allowlist_enabled INTEGER NOT NULL DEFAULT 0 CHECK (email_allowlist_enabled IN (0, 1));
ALTER TABLE instance_settings ADD COLUMN email_allowlist TEXT;
ALTER TABLE instance_settings ADD COLUMN email_blocklist TEXT;
