import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowUpRight, FileText, ListChecks, LoaderCircle, RefreshCw } from "lucide-react";
import { resolveMemoContentDoc, type MemoDetail, type Notebook } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { MemoTasksView, MemoTaskStatusIcon } from "./MemoTasksView";
import { collectMemoTasks, type MemoTask, type MemoTaskMark } from "@/lib/memo-tasks";
import { loadTaskMemos, MemoTaskUpdateError, saveTaskMark } from "@/lib/memo-task-repository";
import { subscribeRepositoryMutations } from "@/lib/repository-events";
import type { EdgeEverRepository } from "@/lib/repository";
import { cn } from "@/lib/utils";

export const MemoTasksPane = ({ repository, scope, notebooks, onClose, onNavigate, onSaved }: {
  repository: EdgeEverRepository;
  scope: string;
  notebooks: Notebook[];
  onClose: () => void;
  onNavigate: (memo: MemoDetail, task: MemoTask) => void;
  onSaved: (memo: MemoDetail) => void;
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["memo-tasks", scope], [scope]);
  const query = useQuery({ queryKey, queryFn: ({ signal }) => loadTaskMemos(repository, scope, signal), staleTime: 0 });
  const [notebookId, setNotebookId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => subscribeRepositoryMutations(scope, event => {
    if (event.type.startsWith("note.") || event.type === "workspace.synced") void queryClient.invalidateQueries({ queryKey });
  }), [queryClient, queryKey, scope]);
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries({ queryKey }); };
    window.addEventListener("edgeever:memo-detail-refreshed", refresh);
    return () => window.removeEventListener("edgeever:memo-detail-refreshed", refresh);
  }, [queryClient, queryKey]);
  const memos = query.data ?? [];
  const memoById = useMemo(() => new Map(memos.map(memo => [memo.id, memo])), [memos]);
  const memoTitles = useMemo(() => new Map(memos.map(memo => [memo.id, memo.title || t("common.untitledMemo")])), [memos, t]);
  const tasks = useMemo(() => memos.filter(memo => !notebookId || memo.notebookId === notebookId).flatMap(memo => collectMemoTasks(resolveMemoContentDoc(memo.contentJson, memo.contentMarkdown), memo.id)), [memos, notebookId]);
  const selected = tasks.find(task => task.id === selectedId) ?? tasks[0];
  const selectedMemo = selected ? memoById.get(selected.memoId) : null;
  const byTaskId = new Map(tasks.map(task => [task.id, task]));
  let previewRoot = selected;
  while (previewRoot?.parentId) previewRoot = byTaskId.get(previewRoot.parentId)!;
  const navigate = (task: MemoTask) => {
    const memo = memoById.get(task.memoId);
    if (memo) onNavigate(memo, task);
  };
  const changeMark = async (task: MemoTask, mark: MemoTaskMark) => {
    const displayed = memoById.get(task.memoId);
    if (!displayed) return;
    try {
      const updated = await saveTaskMark(repository, displayed, task, mark);
      queryClient.setQueryData<MemoDetail[]>(queryKey, current => current?.map(memo => memo.id === displayed.id ? updated : memo));
      onSaved(updated);
    } catch (error) {
      if (error instanceof MemoTaskUpdateError) {
        void queryClient.invalidateQueries({ queryKey });
        throw new Error(t(`memoTasks.${error.reason}`));
      }
      throw new Error(t("memoTasks.saveFailed"));
    }
  };
  const preview = (task: MemoTask) => <div key={task.id}>
    <button type="button" className={cn("flex w-full items-start gap-2 rounded px-2 py-2 text-left text-sm", task.id === selected?.id && "bg-emerald-50 dark:bg-emerald-950/40")} onClick={() => navigate(task)}><span className="mt-0.5"><MemoTaskStatusIcon status={task.status} /></span><span className={cn("min-w-0 break-words", task.checked && "text-slate-500 line-through", task.rejected && "line-through decoration-[#dc2626] decoration-[1.5px] dark:decoration-red-400")}>{task.text}</span></button>
    <div className="ml-6">{tasks.filter(child => child.parentId === task.id).map(preview)}</div>
  </div>;
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6"><Button variant="ghost" size="icon" aria-label={t("memoTasks.close")} onClick={onClose}><ArrowLeft className="h-4 w-4" /></Button><ListChecks className="h-5 w-5 text-emerald-700" /><h1 className="font-semibold">{t("memoTasks.title")}</h1><span className="flex-1" /><Button variant="ghost" size="icon" disabled={query.isFetching} aria-label={t("memoTasks.refresh")} onClick={() => void query.refetch()}><RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} /></Button></header>
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-7">
          <p className="mb-1 text-sm text-slate-600 dark:text-slate-300">{t("memoTasks.description")}</p><p className="mb-5 max-w-3xl text-xs leading-relaxed text-slate-500">{t("memoTasks.rule")}</p>
          <select className="mb-4 max-w-full rounded-md border bg-card px-3 py-2 text-xs" aria-label={t("memoTasks.allNotebooks")} value={notebookId} onChange={event => setNotebookId(event.target.value)}><option value="">{t("memoTasks.allNotebooks")}</option>{notebooks.map(notebook => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}</select>
          {query.isPending ? <p role="status" className="flex items-center gap-2 py-12 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />{t("memoTasks.loading")}</p> : query.isError ? <div role="alert" className="py-12 text-sm text-rose-700"><p>{t("memoTasks.loadFailed")}</p><Button variant="outline" className="mt-3" onClick={() => void query.refetch()}>{t("memoTasks.refresh")}</Button></div> : <MemoTasksView tasks={tasks} memoTitles={memoTitles} onMark={changeMark} onNavigate={navigate} onSelect={task => setSelectedId(task.id)} selectedId={selected?.id} />}
        </section>
        <aside className="hidden w-80 shrink-0 flex-col border-l bg-slate-50/50 xl:flex dark:bg-slate-950/30">
          <header className="border-b px-5 py-5"><p className="mb-3 text-xs text-slate-500">{t("memoTasks.preview")}</p><h2 className="flex items-start gap-2 text-sm font-semibold"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />{selectedMemo?.title || t("memoTasks.selectPreview")}</h2></header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{selected && previewRoot ? <><h3 className="mb-3 text-sm font-semibold">{selected.heading}</h3>{preview(previewRoot)}</> : <p className="text-xs text-slate-500">{t("memoTasks.selectPreview")}</p>}</div>
          {selected && <div className="border-t p-5"><Button variant="outline" className="w-full gap-2" onClick={() => navigate(selected)}><ArrowUpRight className="h-4 w-4" />{t("memoTasks.locate")}</Button></div>}
        </aside>
      </div>
    </div>
  );
};
