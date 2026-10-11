// Materializing a merged collaboration document back into the memo.
//
// The CRDT room is the live authority while collaborators are connected, but
// everything else (list previews, search, mobile, the public share page and
// the LWW web save path) reads memo_contents. This writer keeps those two
// views converged: it converts the merged TipTap JSON into the same columns
// a normal save would write (content_json/markdown/text, excerpt, hash,
// revision) and fires the same memos-row touch, so the mobile-sync trigger
// and the search index see the write exactly like any other save.
//
// Deliberately not done here: audit rows (a flush every quiet period would
// spam the audit log; the merge is a system action, not an actor action) and
// memo_revisions snapshots (continuous collab edits are not revisions).

import {
  createExcerpt,
  docToMarkdown,
  docToText,
  type TiptapDoc,
} from "@edgeever/shared";
import { isoNow, parseJsonArray } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { upsertMemoSearchDocumentStatement } from "./memo-search-index";
import type { DatabaseAdapter } from "./storage-contract";

export type CollabMaterializeResult =
  | { materialized: true; contentHash: string }
  | { materialized: false; contentHash: string | null };

/** Same formula the memo service hashes saved content with. */
export const collabContentHash = async (contentMarkdown: string, contentJson: TiptapDoc) =>
  sha256(contentMarkdown + JSON.stringify(contentJson));

export const createCollabMemoWriter = (database: DatabaseAdapter) => {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function"
  ) {
    throw new Error("createCollabMemoWriter requires a database adapter with a prepare() method");
  }

  const materialize = async (
    memoId: string,
    contentJson: TiptapDoc,
  ): Promise<CollabMaterializeResult> => {
    const current = await database
      .prepare(
        `SELECT m.title, m.tags_json, c.revision, c.content_hash
         FROM memos m
         INNER JOIN memo_contents c ON c.memo_id = m.id
         WHERE m.id = ? AND m.is_deleted = 0`,
      )
      .bind(memoId)
      .first<{ title: string | null; tags_json: string | null; revision: number; content_hash: string | null }>();
    if (!current) return { materialized: false, contentHash: null };

    const contentMarkdown = docToMarkdown(contentJson);
    const contentText = docToText(contentJson);
    const contentHash = await collabContentHash(contentMarkdown, contentJson);
    if (contentHash === current.content_hash) {
      return { materialized: false, contentHash };
    }

    const tags = parseJsonArray(current.tags_json ?? "[]");
    const excerpt = createExcerpt(contentText);
    const updatedAt = isoNow();

    await database.batch([
      database
        .prepare(
          `UPDATE memo_contents
           SET content_json = ?, content_markdown = ?, content_text = ?, content_hash = ?,
               revision = ?, updated_at = ?
           WHERE memo_id = ?`,
        )
        .bind(
          JSON.stringify(contentJson),
          contentMarkdown,
          contentText,
          contentHash,
          current.revision + 1,
          updatedAt,
          memoId,
        ),
      // Touching the memo row fires the mobile-sync upsert trigger, so
      // sidecar/mirrored clients pull the merged content on their next poll.
      database
        .prepare(`UPDATE memos SET excerpt = ?, updated_at = ? WHERE id = ? AND is_deleted = 0`)
        .bind(excerpt, updatedAt, memoId),
      upsertMemoSearchDocumentStatement(database, memoId, current.title, contentText, tags.join(" ")),
    ]);

    return { materialized: true, contentHash };
  };

  return { materialize };
};

export type CollabMemoWriter = ReturnType<typeof createCollabMemoWriter>;
