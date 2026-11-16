import { resolveMemoContentDoc, type MemoDetail } from "@edgeever/shared";
import { collectMemoTasks, updateMemoTaskDocument, type MemoTask, type MemoTaskMark } from "./memo-tasks";
import type { EdgeEverRepository } from "./repository";
import { localDb } from "./local-db";
import { readEmergencyDraft } from "./emergency-draft";
import { createLocalEditSession } from "@/components/editor/editor-pane-helpers";
import { isDesktopRenderer } from "./runtime";
import { getMemoUpdateQueueId } from "./sync-queue";

export const loadTaskMemos = async (repository: EdgeEverRepository, scope: string, signal: AbortSignal): Promise<MemoDetail[]> => {
  const result: MemoDetail[] = [];
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const page = await repository.listMemos({ trash: false, filter: "all", sort: "updated-desc", offset, limit: 200 });
    const cached = isDesktopRenderer() ? [] : await localDb.memos.bulkGet(page.memos.map(memo => [scope, memo.id] as [string, string]));
    const byId = new Map(cached.flatMap(memo => memo ? [[memo.id, memo] as const] : []));
    for (let index = 0; index < page.memos.length; index += 8) {
      signal.throwIfAborted();
      const memos = await Promise.all(page.memos.slice(index, index + 8).filter(memo => !memo.isDeleted && !memo.diagramKind).map(async summary => {
        const local = byId.get(summary.id);
        return local && local.revision === summary.revision && local.updatedAt === summary.updatedAt
          ? local : (await repository.getMemo(summary.id)).memo;
      }));
      for (const memo of memos) if (!memo.isDeleted && collectMemoTasks(resolveMemoContentDoc(memo.contentJson, memo.contentMarkdown), memo.id).length > 0) result.push(memo);
    }
    if (!page.nextCursor) break;
    offset = Number(page.nextCursor);
  }
  signal.throwIfAborted();
  return result;
};

export class MemoTaskUpdateError extends Error {
  constructor(public readonly reason: "changed" | "draft") { super(reason); }
}

export const saveTaskMark = async (repository: EdgeEverRepository, displayedMemo: MemoDetail, task: MemoTask, mark: MemoTaskMark): Promise<MemoDetail> => {
  const { memo, access } = await repository.getMemo(displayedMemo.id);
  const doc = resolveMemoContentDoc(memo.contentJson, memo.contentMarkdown);
  const displayed = resolveMemoContentDoc(displayedMemo.contentJson, displayedMemo.contentMarkdown);
  if (memo.isDeleted || access?.shared || memo.revision !== displayedMemo.revision || JSON.stringify(doc) !== JSON.stringify(displayed)) throw new MemoTaskUpdateError("changed");
  const [draft, queued] = await Promise.all([localDb.drafts.get(memo.id), localDb.syncQueue.get(getMemoUpdateQueueId(memo.id))]);
  for (const local of [draft, readEmergencyDraft(memo.id)]) {
    if (local && (JSON.stringify(local.contentJson) !== JSON.stringify(doc) || local.title !== (memo.title ?? "") || local.tagsText !== memo.tags.join(", "))) throw new MemoTaskUpdateError("draft");
  }
  if (queued?.status === "conflict" || queued?.status === "error") throw new MemoTaskUpdateError("changed");
  const contentJson = updateMemoTaskDocument(doc, task, mark);
  if (!contentJson) throw new MemoTaskUpdateError("changed");
  const { memo: updated } = await repository.updateMemo(memo, {
    expectedRevision: memo.revision,
    expectedContentHash: memo.contentHash,
    editSessionId: createLocalEditSession(memo).id,
    title: memo.title ?? "",
    tags: memo.tags,
    contentJson,
  });
  return updated;
};
