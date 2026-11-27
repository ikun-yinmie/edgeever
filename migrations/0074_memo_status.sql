ALTER TABLE memos ADD COLUMN status TEXT DEFAULT NULL
  CHECK (status IS NULL OR status IN ('in_progress', 'completed', 'cancelled'));
