-- Instance-level default bindings for the 13 app shortcuts (create memo,
-- focus search, ...). NULL means "use the built-in defaults". Personal
-- overrides in the browser always win over these defaults.
ALTER TABLE instance_settings ADD COLUMN app_shortcuts TEXT;
