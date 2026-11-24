-- Transaction-local optimistic-lock assertions, shared by HTTP saves,
-- collaboration materialization and revision restores. Invalid checks abort
-- the entire batch; successful batches delete their check before committing.
CREATE TABLE memo_write_checks (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT memo_write_current CHECK (valid = 1)
);
