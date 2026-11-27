-- Desktop-client session lifetime is an instance policy owned by the admin
-- console; NULL keeps the EDGE_EVER_SESSION_TTL_DAYS default. Browser and
-- mobile sessions are unaffected and follow each account's own retention.
ALTER TABLE instance_settings ADD COLUMN desktop_session_ttl_days INTEGER;
