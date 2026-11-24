import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, FileText, ListChecks, Minus, Search, X, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { nextMemoTaskMark, type MemoTask, type MemoTaskMark, type MemoTaskStatus } from "@/lib/memo-tasks";
import { resolveMemoTaskTreeRows } from "@/lib/memo-task-tree";

const statuses: MemoTaskStatus[] = ["pending", "doing", "done", "rejected"];
const groupOrder: MemoTaskStatus[] = ["doing", "pending", "done", "rejected"];

export const MemoTaskStatusIcon = ({ status }: { status: MemoTaskStatus }) => (
  <span aria-hidden="true" className={cn("inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[4px] border",
    status === "pending" && "border-slate-500 text-slate-500 dark:border-slate-400",
    status === "doing" && "border-amber-700 bg-amber-50 text-amber-800 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-300",
    status === "done" && "border-emerald-700 bg-emerald-50 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-300",
    status === "rejected" && "border-[#dc2626] bg-red-50 text-[#dc2626] dark:border-red-400 dark:bg-red-950 dark:text-red-400")}
  >
    {status === "doing" ? <Minus className="h-3 w-3" /> : status === "done" ? <Check className="h-3 w-3" /> : status === "rejected" ? <X className="h-3 w-3" /> : null}
  </span>
);

export const MemoTasksView = ({ tasks, memoTitles, readOnly = false, onMark, onNavigate, onSelect, selectedId }: {
  tasks: MemoTask[];
  memoTitles: ReadonlyMap<string, string>;
  readOnly?: boolean;
  onMark: (task: MemoTask, mark: MemoTaskMark) => void | Promise<void>;
  onNavigate: (task: MemoTask) => void;
  onSelect?: (task: MemoTask) => void;
  selectedId?: string;
}) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<MemoTaskStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<MemoTaskStatus>(["done", "rejected"]));
  const [expanded, setExpanded] = useState(new Set<string>());
  const [collapsedFiltered, setCollapsedFiltered] = useState(new Set<string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const byId = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const children = useMemo(() => {
    const result = new Map<string, MemoTask[]>();
    for (const task of tasks) if (task.parentId) result.set(task.parentId, [...(result.get(task.parentId) ?? []), task]);
    return result;
  }, [tasks]);
  const ancestors = (task: MemoTask): MemoTask[] => {
    const parent = task.parentId ? byId.get(task.parentId) : null;
    return parent ? [...ancestors(parent), parent] : [];
  };
  const descendants = (task: MemoTask): MemoTask[] => (children.get(task.id) ?? []).flatMap(child => [child, ...descendants(child)]);
  const pathLabel = (task: MemoTask) => [memoTitles.get(task.memoId), task.heading, ...ancestors(task).map(parent => parent.text)].filter(Boolean).join(" / ");
  const searching = query.trim().toLocaleLowerCase();
  const filteredTree = filter !== "all" || Boolean(searching);
  const shown = tasks.filter(task => (filter === "all" || task.status === filter) && (!searching || `${task.text} ${pathLabel(task)}`.toLocaleLowerCase().includes(searching)));
  // A filtered list keeps the outline: unmatched ancestors stay as muted
  // context rows so matching children are not torn out of their tree.
  const { visibleIds, roots: treeRoots, matchingIds } = resolveMemoTaskTreeRows({
    tasks,
    matching: shown,
    filtered: filteredTree,
  });

  const changeMark = async (task: MemoTask, mark: MemoTaskMark) => {
    setPending(true);
    setError("");
    try { await onMark(task, mark); }
    catch (error) { setError(error instanceof Error ? error.message : t("memoTasks.saveFailed")); }
    finally { setPending(false); }
  };
  const toggleRow = (taskId: string) => {
    if (filteredTree) {
      setCollapsedFiltered(current => { const next = new Set(current); next.has(taskId) ? next.delete(taskId) : next.add(taskId); return next; });
      return;
    }
    setExpanded(current => { const next = new Set(current); next.has(taskId) ? next.delete(taskId) : next.add(taskId); return next; });
  };
  const row = (task: MemoTask, nested = false, context = false) => {
    const cs = children.get(task.id) ?? [];
    const visibleChildren = visibleIds ? cs.filter(child => visibleIds.has(child.id)) : cs;
    const allChildren = descendants(task);
    const isExpanded = filteredTree ? !collapsedFiltered.has(task.id) : expanded.has(task.id);
    return (
      <div key={task.id}>
        <div data-task-id={task.id} data-task-status={task.status} data-task-context={context || undefined} className={cn("group flex min-w-0 items-center gap-1.5 rounded-md border-b border-slate-100 py-2 pl-1 pr-2 dark:border-slate-800", nested ? "min-h-11" : "min-h-16", context && "opacity-60", selectedId === task.id && "bg-emerald-50 shadow-[inset_3px_0_0_#16A06E] dark:bg-emerald-950/40")}>
          {visibleChildren.length > 0 ? (
            <button type="button" className="flex h-7 w-6 shrink-0 items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={t(isExpanded ? "memoTasks.collapse" : "memoTasks.expand", { name: task.text })} aria-expanded={isExpanded} onClick={() => toggleRow(task.id)}>
              <ChevronRight className={cn("h-3.5 w-3.5 text-slate-500", isExpanded && "rotate-90")} />
            </button>
          ) : <span className={cn("w-6 shrink-0", nested && "hidden")} />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-default disabled:opacity-60 dark:hover:bg-slate-800" disabled={readOnly || pending} aria-label={t("memoTasks.change", { name: task.text, status: t(`memoTasks.${task.status}`) })} onClick={() => void changeMark(task, nextMemoTaskMark(task))}>
                <MemoTaskStatusIcon status={task.status} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("memoTasks.cycleHint")}</p>
              <p className="mt-1">{t("memoTasks.markHint")}</p>
            </TooltipContent>
          </Tooltip>
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect ? onSelect(task) : onNavigate(task)}>
            <span className={cn("block break-words text-sm text-slate-900 dark:text-slate-100", task.status === "done" && "text-slate-500 line-through dark:text-slate-400", task.status === "rejected" && "line-through decoration-[#dc2626] decoration-[1.5px] dark:decoration-red-400")}>{task.text || t("common.untitledMemo")}</span>
            <span className="mt-1 flex min-w-0 items-start gap-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {allChildren.length > 0 ? t("memoTasks.progress", { done: allChildren.filter(child => child.checked).length, rejected: allChildren.filter(child => child.rejected).length, pending: allChildren.filter(child => !child.checked && !child.rejected).length }) : <><FileText className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-words">{pathLabel(task)}</span></>}
            </span>
          </button>
          {task.status === "doing" && <span className="hidden rounded border px-1 text-[10px] text-slate-500 sm:inline">{t("memoTasks.automatic")}</span>}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={t("memoTasks.locate") + " · " + task.text} className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-emerald-700 opacity-80 hover:bg-emerald-50 group-focus-within:opacity-100 group-hover:opacity-100 dark:text-emerald-400 dark:hover:bg-emerald-950" onClick={() => onNavigate(task)}><ArrowUpRight className="h-4 w-4" /></button>
            </TooltipTrigger>
            <TooltipContent>{t("memoTasks.locate")}</TooltipContent>
          </Tooltip>
        </div>
        {isExpanded && visibleChildren.length > 0 && <div className="mb-2 ml-8 border-l border-slate-200 pl-2 dark:border-slate-700">{visibleChildren.map(child => row(child, true, !matchingIds.has(child.id)))}</div>}
      </div>
    );
  };
  return (
    <TooltipProvider>
    <div className="min-w-0">
      <div className="mb-4 flex gap-1 overflow-x-auto border-b pb-3" aria-label={t("memoTasks.title")}>
        {(["all", ...statuses] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs", filter === value ? "bg-emerald-50 font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")} onClick={() => { setFilter(value); setCollapsedFiltered(new Set()); if (value !== "all") setCollapsed(current => { const next = new Set(current); next.delete(value); return next; }); }}>
          {value !== "all" && <MemoTaskStatusIcon status={value} />}{t(`memoTasks.${value}`)}<span className="rounded bg-slate-100 px-1.5 py-0.5 tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">{value === "all" ? tasks.length : tasks.filter(task => task.status === value).length}</span>
        </button>)}
      </div>
      <label className="relative mb-3 block"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><Input className="pl-9" value={query} aria-label={t("memoTasks.search")} placeholder={t("memoTasks.search")} onChange={event => { setQuery(event.target.value); setCollapsedFiltered(new Set()); if (event.target.value.trim()) setCollapsed(new Set()); }} /></label>
      <p className="mb-3 text-[11px] text-slate-500" role="status">{pending ? t("memoTasks.saving") : t("memoTasks.total", { count: shown.length })}</p>
      {error && <p role="alert" className="mb-3 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
      {shown.length === 0 ? <div className="py-12 text-center text-sm text-slate-500"><ListChecks className="mx-auto mb-3 h-7 w-7" /><p>{t("memoTasks.empty")}</p><p className="mt-2 text-xs">{t("memoTasks.emptyHint")}</p><Button variant="outline" className="mt-4" onClick={() => { setQuery(""); setFilter("all"); }}>{t("memoTasks.clear")}</Button></div> : filteredTree ? (
        <section className="mb-4" data-task-group="filtered">
          <div className="ml-[104px]" data-task-group-content>{treeRoots.map(task => row(task, false, !matchingIds.has(task.id)))}</div>
        </section>
      ) : groupOrder.map(status => {
        const matching = shown.filter(task => task.status === status);
        const rows = matching.filter(task => !ancestors(task).some(parent => parent.status === status));
        if (rows.length === 0) return null;
        const closed = collapsed.has(status);
        return <section key={status} className="mb-4" data-task-group={status}>
          <button type="button" className="mb-1 flex w-full items-center gap-2 rounded py-2 pr-2 text-left text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-900" aria-expanded={!closed} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(status) ? next.delete(status) : next.add(status); return next; })}>
            <ChevronRight className={cn("h-3.5 w-3.5 text-slate-500", !closed && "rotate-90")} /><MemoTaskStatusIcon status={status} /><span data-task-group-label>{t(`memoTasks.${status}`)}</span><span className="rounded bg-slate-100 px-1.5 py-0.5 tabular-nums text-slate-500 dark:bg-slate-800">{matching.length}</span>
          </button>
          {!closed && <div className="ml-[104px]" data-task-group-content>{rows.map(task => row(task))}</div>}
        </section>;
      })}
    </div>
    </TooltipProvider>
  );
};
