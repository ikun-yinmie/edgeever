import { AppError } from "./app-error";
import { createId } from "./entity-utils";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";

export type MemoWriteBase = {
  id: string;
  revision: number;
  content_hash: string | null;
};

/**
 * A read/check followed by an unconditional batch is not an optimistic lock:
 * another request can commit while hashing or preparing a history snapshot.
 * Assert the base inside the same atomic batch as every affected column,
 * history entry, collaboration document, search update and audit event.
 *
 * Uses the existing transaction-local CHECK pattern (companion_action_checks),
 * with a named constraint so unrelated storage failures are never misreported
 * as conflicts. It works through both the D1 and SQLite adapters.
 */
export const runMemoWriteBatch = async (
  db: DatabaseAdapter,
  base: MemoWriteBase,
  statements: PreparedStatementAdapter[],
) => {
  const checkId = createId("memo_write");
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO memo_write_checks (id, valid)
         VALUES (?, CASE WHEN EXISTS (
           SELECT 1 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
           WHERE m.id = ? AND m.is_deleted = 0
             AND c.revision = ? AND c.content_hash IS ?
         ) THEN 1 ELSE 0 END)`,
      ).bind(checkId, base.id, base.revision, base.content_hash),
      ...statements,
      db.prepare("DELETE FROM memo_write_checks WHERE id = ?").bind(checkId),
    ]);
    return results.slice(1, -1);
  } catch (error) {
    if (String(error).includes("memo_write_current")) {
      throw new AppError("revision_conflict", "Memo was updated elsewhere. Reload before saving.", 409);
    }
    throw error;
  }
};
