-- Per-note editor theme. NULL keeps the note on each device's default theme;
-- a named theme id (e.g. "letter") renders everywhere the note is read.
ALTER TABLE memos ADD COLUMN theme TEXT;
