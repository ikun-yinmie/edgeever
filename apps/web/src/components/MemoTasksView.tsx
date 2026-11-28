import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, FileText, FolderOpen, ListChecks, Minus, Search, X, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { nextMemoTaskMark, type MemoTask, type MemoTaskMark, type MemoTaskStatus } from "@/lib/memo-tasks";
import { resolveMemoTaskTreeRows } from "@/lib/memo-task-tree";
import { taskOverviewFoldKey, type MemoTaskOverview, type MemoTaskOverviewFilter } from "@/lib/memo-task-overview";

/** Opt-in global presentation; note dialogs keep their existing status groups. */
export type MemoTasksOverviewConfig = {
  model: MemoTaskOverview;
  filter: MemoTaskOverviewFilter;
  categoryPicker: ReactNode;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onFilterChange: (status: MemoTaskOverviewFilter["status"]) => void;
  onQueryChange: (query: string) => void;
  onClear: () => void;
};

const statuses: MemoTaskStatus[] = ["pending", "doing", "done", "rejected"];
const groupOrder: MemoTaskStatus[] = ["doing", "pending", "done", "rejected"];

export const MemoTaskStatusIcon = ({ status }: { status: MemoTaskStatus }) => (
  <span aria-hidden="true" className={cn("inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[4px] border",
    status === "pending" && "border-muted-foreground text-muted-foreground",
    status === "doing" && "border-amber-700 bg-amber-50 text-amber-800 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-300",
    status === "done" && "border-emerald-700 bg-emerald-50 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-300",
    status === "rejected" && "border-[#dc2626] bg-red-50 text-[#dc2626] dark:border-red-400 dark:bg-red-950 dark:text-red-400")}
  >
    {status === "doing" ? <Minus className="h-3 w-3" /> : status === "done" ? <Check className="h-3 w-3" /> : status === "rejected" ? <X className="h-3 w-3" /> : null}
  </span>
);

export const MemoTasksView = ({ tasks, memoTitles, readOnly = false, onMark, onNavigate, onSelect, selectedId, overview }: {
  tasks: MemoTask[];
  memoTitles: ReadonlyMap<string, string>;
  readOnly?: boolean;
  onMark: (task: MemoTask, mark: MemoTaskMark) => void | Promise<void>;
  onNavigate: (task: MemoTask) => void;
  onSelect?: (task: MemoTask) => void;
  selectedId?: string;
  overview?: MemoTasksOverviewConfig;
}) => {
  const { t } = useTranslation();
  const [localFilter, setFilter] = useState<MemoTaskStatus | "all">("all");
  const [localQuery, setQuery] = useState("");
  const filter = overview?.filter.status ?? localFilter;
  const query = overview?.filter.query ?? localQuery;
  const [collapsed, setCollapsed] = useState(new Set<MemoTaskStatus>(["done", "rejected"]));
  const [expanded, setExpanded] = useState(new Set<string>());
  const [collapsedFiltered, setCollapsedFiltered] = useState(new Set<string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const byId = useMemo(() => overview?.model.byId ?? new Map(tasks.map(task => [task.id, task])), [tasks, overview?.model]);
  const children = useMemo(() => {
    if (overview) return overview.model.children;
    const result = new Map<string, MemoTask[]>();
    for (const task of tasks) if (task.parentId) result.set(task.parentId, [...(result.get(task.parentId) ?? []), task]);
    return result;
  }, [tasks, overview?.model]);
  const ancestors = (task: MemoTask): MemoTask[] => {
    const parent = task.parentId ? byId.get(task.parentId) : null;
    return parent ? [...ancestors(parent), parent] : [];
  };
  const descendants = (task: MemoTask): MemoTask[] => (children.get(task.id) ?? []).flatMap(child => [child, ...descendants(child)]);
  const pathLabel = (task: MemoTask) => [memoTitles.get(task.memoId), task.heading, ...ancestors(task).map(parent => parent.text)].filter(Boolean).join(" / ");
  const searching = query.trim().toLocaleLowerCase();
  const filteredTree = filter !== "all" || Boolean(searching);
  const shown = overview?.model.matching ?? tasks.filter(task => (filter === "all" || task.status === filter) && (!searching || `${task.text} ${pathLabel(task)}`.toLocaleLowerCase().includes(searching)));
  // Context and subtree semantics are shared with the single-note task view.
  const { visibleIds, roots: treeRoots, matchingIds } = overview?.model ?? resolveMemoTaskTreeRows({ tasks, matching: shown, filtered: filteredTree });
  const clear = () => {
    if (overview) overview.onClear();
    else { setQuery(""); setFilter("all"); }
  };
  const changeMark = async (task: MemoTask, mark: MemoTaskMark) => {
    setPending(true);
    setError("");
    try { await onMark(task, mark); }
    catch (error) { setError(error instanceof Error ? error.message : t("memoTasks.saveFailed")); }
    finally { setPending(false); }
  };
  const toggleRow = (taskId: string) => {
    if (overview) { overview.onToggle(taskOverviewFoldKey("task", taskId)); return; }
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
    const isExpanded = overview ? !overview.collapsed.has(taskOverviewFoldKey("task", task.id)) : filteredTree ? !collapsedFiltered.has(task.id) : expanded.has(task.id);
    return (
      <div key={task.id}>
        <div data-task-id={task.id} data-task-status={task.status} data-task-context={context || undefined} className={cn("group flex min-w-0 items-center gap-1.5 rounded-md border-b border-border/60 py-2 pl-1 pr-2", nested || overview ? "min-h-11" : "min-h-16", context && "opacity-60", selectedId === task.id && "bg-accent shadow-[inset_3px_0_0_hsl(var(--primary))]")}>
          {visibleChildren.length > 0 ? (
            <button type="button" className="flex h-7 w-6 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={t(isExpanded ? "memoTasks.collapse" : "memoTasks.expand", { name: task.text })} aria-expanded={isExpanded} onClick={() => toggleRow(task.id)}>
              <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground", isExpanded && "rotate-90")} />
            </button>
          ) : <span className={cn("w-6 shrink-0", nested && "hidden")} />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60" disabled={readOnly || pending} aria-label={t("memoTasks.change", { name: task.text, status: t(`memoTasks.${task.status}`) })} onClick={() => void changeMark(task, nextMemoTaskMark(task))}>
                <MemoTaskStatusIcon status={task.status} />
              </button>
            </TooltipTrigger>
            <TooltipContent><p>{t("memoTasks.cycleHint")}</p><p className="mt-1">{t("memoTasks.markHint")}</p></TooltipContent>
          </Tooltip>
          <button type="button" className="min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-pressed={onSelect ? selectedId === task.id : undefined} onClick={() => onSelect ? onSelect(task) : onNavigate(task)}>
            <span className={cn("block break-words text-sm text-foreground", task.status === "done" && "text-muted-foreground line-through", task.status === "rejected" && "line-through decoration-[#dc2626] decoration-[1.5px] dark:decoration-red-400")}>{task.text || t("common.untitledMemo")}</span>
            {(allChildren.length > 0 || !overview || task.heading) && <span className="mt-1 flex min-w-0 items-start gap-1 text-[11px] leading-relaxed text-muted-foreground">
              {allChildren.length > 0 ? t("memoTasks.progress", { done: allChildren.filter(child => child.checked).length, rejected: allChildren.filter(child => child.rejected).length, pending: allChildren.filter(child => !child.checked && !child.rejected).length }) : overview ? task.heading : <><FileText className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-words">{pathLabel(task)}</span></>}
            </span>}
          </button>
          {task.status === "doing" && <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="hidden rounded border px-1 text-[10px] text-muted-foreground sm:inline">{t("memoTasks.automatic")}</span></TooltipTrigger><TooltipContent>{t("memoTasks.rule")}</TooltipContent></Tooltip>}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={t("memoTasks.locate") + " · " + task.text} className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-primary opacity-80 hover:bg-accent group-focus-within:opacity-100 group-hover:opacity-100" onClick={() => onNavigate(task)}><ArrowUpRight className="h-4 w-4" /></button>
            </TooltipTrigger>
            <TooltipContent>{t("memoTasks.locate")}</TooltipContent>
          </Tooltip>
        </div>
        {isExpanded && visibleChildren.length > 0 && <div className={cn("mb-2 border-l pl-2", overview ? "ml-3 sm:ml-7" : "ml-8")}>{visibleChildren.map(child => row(child, true, !matchingIds.has(child.id)))}</div>}
      </div>
    );
  };
  return (
    <TooltipProvider>
    <div className="min-w-0">
      {overview && <div className="mb-3 flex flex-wrap items-center gap-2">
        {overview.categoryPicker}
        <label className="relative min-w-0 flex-[1_1_12rem]"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="h-9 bg-card pl-9 text-sm" value={query} aria-label={t("memoTasks.search")} placeholder={t("memoTasks.search")} onChange={event => overview.onQueryChange(event.target.value)} /></label>
        {shown.length > 0 && (filter !== "all" || searching || overview.filter.notebookId) && <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-xs text-muted-foreground" onClick={clear}><X className="h-3.5 w-3.5" />{t("memoTasks.clear")}</Button>}
      </div>}
      <div role="group" data-task-status-filters className={cn("mb-4 flex gap-1 overflow-x-auto pb-3", overview ? "rounded-lg border bg-muted/30 p-1" : "border-b")} aria-label={t("memoTasks.statusLabel")}>
        {(["all", ...statuses] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs transition-colors", filter === value ? "bg-accent font-semibold text-accent-foreground shadow-sm" : "text-muted-foreground hover:bg-muted")} onClick={() => {
          if (overview) { overview.onFilterChange(value); return; }
          setFilter(value); setCollapsedFiltered(new Set());
          if (value !== "all") setCollapsed(current => { const next = new Set(current); next.delete(value); return next; });
        }}>
          {value !== "all" && <MemoTaskStatusIcon status={value} />}{t(`memoTasks.${value}`)}<span className="rounded bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">{overview ? overview.model.statusCounts[value] : value === "all" ? tasks.length : tasks.filter(task => task.status === value).length}</span>
        </button>)}
      </div>
      {!overview && <label className="relative mb-3 block"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={query} aria-label={t("memoTasks.search")} placeholder={t("memoTasks.search")} onChange={event => { setQuery(event.target.value); setCollapsedFiltered(new Set()); if (event.target.value.trim()) setCollapsed(new Set()); }} /></label>}
      <p className="mb-3 text-[11px] text-muted-foreground" role="status">{pending ? t("memoTasks.saving") : t(overview ? "memoTasks.matched" : "memoTasks.total", { count: shown.length })}</p>
      {error && <p role="alert" className="mb-3 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
      {shown.length === 0 ? <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground"><ListChecks className="mx-auto mb-3 h-7 w-7" /><p>{t("memoTasks.empty")}</p><p className="mt-2 text-xs">{t("memoTasks.emptyHint")}</p><Button variant="outline" className="mt-4" onClick={clear}>{t("memoTasks.clear")}</Button></div> : overview ? (
        <div className="space-y-5">{overview.model.groups.map(group => {
          const notebookKey = taskOverviewFoldKey("notebook", group.notebookId);
          const notebookClosed = overview.collapsed.has(notebookKey);
          return <section key={group.notebookId} data-task-notebook={group.notebookId}>
            <button type="button" className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={t(notebookClosed ? "memoTasks.expand" : "memoTasks.collapse", { name: group.path })} aria-expanded={!notebookClosed} onClick={() => overview.onToggle(notebookKey)}>
              <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", !notebookClosed && "rotate-90")} /><FolderOpen className="h-4 w-4 shrink-0 text-primary" /><h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{group.path}</h2><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{group.matchingCount}</span>
            </button>
            {!notebookClosed && <div className="space-y-3">{group.memos.map(memo => {
              const memoKey = taskOverviewFoldKey("memo", memo.memoId);
              const memoClosed = overview.collapsed.has(memoKey);
              return <article key={memo.memoId} data-task-memo={memo.memoId} className="overflow-hidden rounded-xl border bg-card shadow-sm">
                <div className="flex min-w-0 items-center gap-2 bg-muted/30 px-2 py-2 sm:px-3">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded p-1 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={t(memoClosed ? "memoTasks.expand" : "memoTasks.collapse", { name: memo.title })} aria-expanded={!memoClosed} onClick={() => overview.onToggle(memoKey)}>
                    <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", !memoClosed && "rotate-90")} /><FileText className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0"><h3 className="truncate text-sm font-medium">{memo.title}</h3><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{memo.notebookPath}</span></span>
                  </button>
                  <span className="shrink-0 px-1 text-[11px] tabular-nums text-muted-foreground">{t("memoTasks.taskCount", { count: memo.matchingCount })}</span>
                </div>
                {!memoClosed && <div className="px-1 pb-1 sm:px-2" data-task-group-content>{memo.roots.map(task => row(task, false, !matchingIds.has(task.id)))}</div>}
              </article>;
            })}</div>}
          </section>;
        })}</div>
      ) : filteredTree ? (
        <section className="mb-4" data-task-group="filtered">
          <div className="ml-[104px]" data-task-group-content>{treeRoots.map(task => row(task, false, !matchingIds.has(task.id)))}</div>
        </section>
      ) : groupOrder.map(status => {
        const matching = shown.filter(task => task.status === status);
        const rows = matching.filter(task => !ancestors(task).some(parent => parent.status === status));
        if (rows.length === 0) return null;
        const closed = collapsed.has(status);
        return <section key={status} className="mb-4" data-task-group={status}>
          <button type="button" className="mb-1 flex w-full items-center gap-2 rounded py-2 pr-2 text-left text-xs font-semibold hover:bg-muted" aria-expanded={!closed} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(status) ? next.delete(status) : next.add(status); return next; })}>
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground", !closed && "rotate-90")} /><MemoTaskStatusIcon status={status} /><span data-task-group-label>{t(`memoTasks.${status}`)}</span><span className="rounded bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">{matching.length}</span>
          </button>
          {!closed && <div className="ml-[104px]" data-task-group-content>{rows.map(task => row(task))}</div>}
        </section>;
      })}
    </div>
    </TooltipProvider>
  );
};
