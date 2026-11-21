// Materializing a merged collaboration document back into the memo.
//
// The CRDT room is the live authority while collaborators are connected, but
// everything else (list previews, search, mobile, the public share page and
// the LWW web save path) reads memo_contents. This writer keeps those two
// views converged: it converts the merged TipTap JSON into the same columns
// a normal save would write (content_json/markdown/text, excerpt, hash,
// revision), records the authenticated editor on the memo and creates a
// history revision when that editor changes, then fires the same memos-row
// touch so the mobile-sync trigger and the search index see the write.

import {
  createExcerpt,
  docToMarkdown,
  docToText,
  type TiptapDoc,
} from "@edgeever/shared";
import { isoNow, parseJsonArray } from "./entity-utils";
import { sha256 } from "./hash-utils";
import {
  createMemoRevisionStatement,
  shouldSnapshotMemoRevision,
  trimMemoRevisionsStatement,
} from "./memo-revision-service";
import { upsertMemoSearchDocumentStatement } from "./memo-search-index";
import type { DatabaseAdapter } from "./storage-contract";

export type CollabMaterializeResult =
  | { materialized: true; contentHash: string }
  | { materialized: false; contentHash: string | null };

export type CollabMaterializeOptions = {
  /** Authenticated editor behind this flush; never the client-advertised name. */
  actorLabel?: string | null;
};

/** Same formula the memo service hashes saved content with. */
export const collabContentHash = async (contentMarkdown: string, contentJson: TiptapDoc) =>
  sha256(contentMarkdown + JSON.stringify(contentJson));

type CollabCurrentRow = {
  id: string;
  title: string | null;
  tags_json: string | null;
  revision: number;
  content_json: string;
  content_markdown: string;
  content_text: string;
  content_hash: string | null;
};

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
    options: CollabMaterializeOptions = {},
  ): Promise<CollabMaterializeResult> => {
    const current = await database
      .prepare(
        `SELECT m.id, m.title, m.tags_json, c.revision, c.content_json, c.content_markdown,
                c.content_text, c.content_hash
         FROM memos m
         INNER JOIN memo_contents c ON c.memo_id = m.id
         WHERE m.id = ? AND m.is_deleted = 0`,
      )
      .bind(memoId)
      .first<CollabCurrentRow>();
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
    const actorLabel = options.actorLabel?.trim() || null;

    // Attribution without a verified actor is not evidence, so leave the memo
    // untouched by system flushes and only snapshot editor-switch boundaries.
    const snapshot = actorLabel
      ? await shouldSnapshotMemoRevision(
        database,
        {
          id: current.id,
          revision: current.revision,
          title: current.title,
          tags_json: current.tags_json ?? "[]",
          content_json: current.content_json,
          content_markdown: current.content_markdown,
          content_text: current.content_text,
          content_hash: current.content_hash ?? "",
        },
        current.title,
        current.tags_json ?? "[]",
        contentHash,
        updatedAt,
        actorLabel,
      )
      : false;

    await database.batch([
      ...(snapshot
        ? [
            createMemoRevisionStatement(
              database,
              {
                id: current.id,
                revision: current.revision,
                title: current.title,
                tags_json: current.tags_json ?? "[]",
                content_json: current.content_json,
                content_markdown: current.content_markdown,
                content_text: current.content_text,
                content_hash: current.content_hash ?? "",
              },
              actorLabel!,
              updatedAt,
            ),
            trimMemoRevisionsStatement(database, memoId),
          ]
        : []),
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
      actorLabel
        ? database
            .prepare(`UPDATE memos SET excerpt = ?, updated_by = ?, updated_at = ? WHERE id = ? AND is_deleted = 0`)
            .bind(excerpt, actorLabel, updatedAt, memoId)
        : database
            .prepare(`UPDATE memos SET excerpt = ?, updated_at = ? WHERE id = ? AND is_deleted = 0`)
            .bind(excerpt, updatedAt, memoId),
      upsertMemoSearchDocumentStatement(database, memoId, current.title, contentText, tags.join(" ")),
    ]);

    return { materialized: true, contentHash };
  };

  return { materialize };
};

export type CollabMemoWriter = ReturnType<typeof createCollabMemoWriter>;
