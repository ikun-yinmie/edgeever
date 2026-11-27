-- A personal account may keep one login per terminal (desktop client, desktop
-- web, mobile), and each terminal may only be used from the IP it signed in
-- from. Older rows have no kind; they are classified from their user agent so
-- the login guard and the device list stay accurate without a rewrite.
ALTER TABLE sessions ADD COLUMN client_kind TEXT;

-- Retention for browser/mobile sessions, configurable from the personal
-- center. NULL keeps the instance default; desktop-client sessions always use
-- the instance default so a laptop does not get signed out mid-edit.
ALTER TABLE users ADD COLUMN session_ttl_days INTEGER;
