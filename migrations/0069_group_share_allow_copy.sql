-- 0069: Let the sharer decide whether the audience may keep a personal copy.
--
-- A group member reads a shared note straight from the author's workspace.
-- "Save as my note" duplicates it into the reader's own notebooks; when the
-- author turns that off the reader keeps read (and maybe write) access but can
-- no longer branch off a private copy. Existing shares keep the previous
-- behaviour (copy allowed) so nobody loses an action after upgrading.

ALTER TABLE group_shares ADD COLUMN allow_copy INTEGER NOT NULL DEFAULT 1
  CHECK (allow_copy IN (0, 1));
