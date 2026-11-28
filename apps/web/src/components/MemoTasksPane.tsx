import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowUpRight, ChevronDown, FileText, FolderOpen, Info, ListChecks, RefreshCw, Search } from "lucide-react";
import { resolveMemoContentDoc, type MemoDetail, type Notebook } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { MemoTasksLoadingSurface } from "@/components/ui/LoadingSurface";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MemoTasksView, MemoTaskStatusIcon } from "./MemoTasksView";
import { collectMemoTasks, type MemoTask, type MemoTaskMark } from "@/lib/memo-tasks";
import { getMemoTaskNotebookOptions, getVisibleOverviewTasks, resolveMemoTaskOverview, resolveOverviewSelection, type MemoTaskOverviewFilter } from "@/lib/memo-task-overview";
import { loadTaskMemos, MemoTaskUpdateError, saveTaskMark } from "@/lib/memo-task-repository";
import { subscribeRepositoryMutations } from "@/lib/repository-events";
import { notebookIdMappingsFromEvent, remapNotebookId } from "@/lib/notebook-id-remap";
import { NOTEBOOK_ID_REMAPPED_EVENT } from "@/lib/sync-events";
import type { EdgeEverRepository } from "@/lib/repository";
import { cn } from "@/lib/utils";

const emptyMemos: MemoDetail[] = [];
const initialFilter: MemoTaskOverviewFilter = { notebookId: "", status: "all", query: "" };

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
  const [filter, setFilter] = useState(initialFilter);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryQuery, setCategoryQuery] = useState("");
  const categorySearchRef = useRef<HTMLInputElement | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => subscribeRepositoryMutations(scope, event => {
    if (event.type.startsWith("note.") || event.type === "workspace.synced") void queryClient.invalidateQueries({ queryKey });
  }), [queryClient, queryKey, scope]);
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries({ queryKey }); };
    window.addEventListener("edgeever:memo-detail-refreshed", refresh);
    return () => window.removeEventListener("edgeever:memo-detail-refreshed", refresh);
  }, [queryClient, queryKey]);
  useEffect(() => {
    if (!categoryOpen) return;
    const timer = window.setTimeout(() => categorySearchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [categoryOpen]);
  useEffect(() => {
    const handleRemap = (event: Event) => {
      const mappings = notebookIdMappingsFromEvent(event);
      if (mappings) setFilter(current => ({ ...current, notebookId: remapNotebookId(current.notebookId, mappings) }));
    };
    window.addEventListener(NOTEBOOK_ID_REMAPPED_EVENT, handleRemap);
    return () => window.removeEventListener(NOTEBOOK_ID_REMAPPED_EVENT, handleRemap);
  }, []);
  useEffect(() => {
    setFilter(current => current.notebookId && !notebooks.some(notebook => notebook.id === current.notebookId) ? { ...current, notebookId: "" } : current);
  }, [notebooks]);
  useEffect(() => { setFilter(initialFilter); setCollapsed(new Set()); setSelectedId(null); }, [scope]);

  const memos = query.data ?? emptyMemos;
  const loadFailed = query.isError && !query.data;
  const memoById = useMemo(() => new Map(memos.map(memo => [memo.id, memo])), [memos]);
  const sources = useMemo(() => memos.map(memo => ({ id: memo.id, title: memo.title || t("common.untitledMemo"), notebookId: memo.notebookId })), [memos, t]);
  const memoTitles = useMemo(() => new Map(sources.map(source => [source.id, source.title])), [sources]);
  const tasks = useMemo(() => memos.flatMap(memo => collectMemoTasks(resolveMemoContentDoc(memo.contentJson, memo.contentMarkdown), memo.id)), [memos]);
  const notebookOptions = useMemo(() => getMemoTaskNotebookOptions(notebooks), [notebooks]);
  const model = useMemo(() => resolveMemoTaskOverview({ tasks, sources, notebooks, notebookOptions, filter, unfiledLabel: t("memoTasks.unfiled") }), [tasks, sources, notebooks, notebookOptions, filter, t]);
  const visibleTasks = useMemo(() => getVisibleOverviewTasks(model, collapsed), [model, collapsed]);
  const selected = resolveOverviewSelection(visibleTasks, selectedId, model.matchingIds);
  const selectedMemo = selected ? memoById.get(selected.memoId) : null;
  const selectedNotebookPath = selectedMemo ? notebookOptions.find(option => option.id === selectedMemo.notebookId)?.path ?? t("memoTasks.unfiled") : "";
  const visibleById = new Map(visibleTasks.map(task => [task.id, task]));
  let previewRoot: MemoTask | undefined = selected;
  while (previewRoot?.parentId && visibleById.has(previewRoot.parentId)) previewRoot = visibleById.get(previewRoot.parentId);
  const previewChildren = new Map<string, MemoTask[]>();
  for (const task of visibleTasks) if (task.parentId) {
    const siblings = previewChildren.get(task.parentId) ?? [];
    siblings.push(task);
    previewChildren.set(task.parentId, siblings);
  }
  const clear = () => { setFilter(initialFilter); setCollapsed(new Set()); };
  const updateFilter = (changes: Partial<MemoTaskOverviewFilter>) => {
    setFilter(current => ({ ...current, ...changes }));
    setCollapsed(new Set());
  };
  const toggle = (key: string) => setCollapsed(current => {
    const next = new Set(current);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
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
    <button type="button" className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", task.id === selected?.id && "bg-accent", !model.matchingIds.has(task.id) && "opacity-60")} onClick={() => navigate(task)}>
      <span className="mt-0.5"><MemoTaskStatusIcon status={task.status} /></span><span className={cn("min-w-0 break-words", task.checked && "text-muted-foreground line-through", task.rejected && "line-through decoration-[#dc2626] decoration-[1.5px] dark:decoration-red-400")}>{task.text || t("common.untitledMemo")}</span>
    </button>
    {(previewChildren.get(task.id)?.length ?? 0) > 0 && <div className="ml-3 border-l pl-2">{previewChildren.get(task.id)!.map(preview)}</div>}
  </div>;
  const selectNotebook = (notebookId: string) => {
    updateFilter({ notebookId });
    setCategoryOpen(false);
    setCategoryQuery("");
  };
  const filteredNotebookOptions = useMemo(() => {
    const search = categoryQuery.trim().toLocaleLowerCase();
    return notebookOptions.filter(option => !search || [option.name, option.path].some(value => value.toLocaleLowerCase().includes(search)));
  }, [categoryQuery, notebookOptions]);
  const categoryPicker = <DropdownMenu open={categoryOpen} onOpenChange={open => { setCategoryOpen(open); setCategoryQuery(""); }}>
    <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-9 min-w-0 max-w-full gap-2 sm:max-w-64" aria-label={t("memoTasks.allNotebooks")}>
      <FolderOpen className="h-4 w-4 shrink-0 text-primary" /><span className="truncate">{notebookOptions.find(option => option.id === filter.notebookId)?.path ?? t("memoTasks.allNotebooks")}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden border-border p-0 text-foreground">
      <DropdownMenuLabel className="px-3 py-2 text-xs text-muted-foreground">{t("memoTasks.categoryHint")}</DropdownMenuLabel>
      <DropdownMenuSeparator className="m-0 bg-border" />
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={categorySearchRef}
          aria-label={t("memoTasks.searchNotebook")}
          className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t("memoTasks.searchNotebook")}
          value={categoryQuery}
          onChange={event => setCategoryQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              setCategoryOpen(false);
              setCategoryQuery("");
            } else if (event.key.length === 1) event.stopPropagation();
          }}
        />
      </div>
      <div className="max-h-[min(55dvh,24rem)] overflow-y-auto p-1">
        <DropdownMenuRadioGroup value={filter.notebookId} onValueChange={selectNotebook} aria-label={t("memoTasks.allNotebooks")}>
          {(!categoryQuery.trim() || t("memoTasks.allNotebooks").toLocaleLowerCase().includes(categoryQuery.trim().toLocaleLowerCase())) && <DropdownMenuRadioItem value="" textValue={t("memoTasks.allNotebooks")} data-task-notebook-option="all">
            {t("memoTasks.allNotebooks")}
          </DropdownMenuRadioItem>}
          {filteredNotebookOptions.map(option => <DropdownMenuRadioItem key={option.id} value={option.id} textValue={option.path} aria-label={option.path} data-task-notebook-option={option.id}>
            <span className="flex min-w-0 items-start gap-2" style={{ paddingLeft: Math.min(option.depth, 6) * 12 }}><FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block break-words">{option.name}</span>{option.depth > 0 && <span className="block break-words text-[10px] text-muted-foreground">{option.path}</span>}</span></span>
          </DropdownMenuRadioItem>)}
          {filteredNotebookOptions.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t("memoTasks.noNotebookFound")}</div>}
        </DropdownMenuRadioGroup>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
  return (
    <TooltipProvider>
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b bg-card px-3 py-3 sm:px-6">
        <div className="flex items-center gap-2 sm:gap-3">
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={t("memoTasks.close")} onClick={onClose}><ArrowLeft className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>{t("memoTasks.close")}</TooltipContent></Tooltip>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary"><ListChecks className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h1 className="text-base font-semibold tracking-tight">{t("memoTasks.title")}</h1><p className="mt-0.5 hidden text-xs text-muted-foreground sm:block">{t("memoTasks.description")}</p></div>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={t("memoTasks.rule")}><Info className="h-4 w-4 text-muted-foreground" /></Button></TooltipTrigger><TooltipContent className="max-w-xs">{t("memoTasks.rule")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" disabled={query.isFetching} aria-label={t("memoTasks.refresh")} onClick={() => void query.refetch()}><RefreshCw className={cn("h-4 w-4", query.isFetching && "animate-spin")} /></Button></TooltipTrigger><TooltipContent>{t("memoTasks.refresh")}</TooltipContent></Tooltip>
        </div>
        {!query.isPending && !loadFailed && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground sm:ml-12">
          <span className="inline-flex items-center gap-1.5"><ListChecks className="h-3.5 w-3.5 text-primary" /><strong className="font-semibold tabular-nums text-foreground">{model.matching.length}</strong>{t("memoTasks.tasksLabel")}</span>
          <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />{t("memoTasks.notesCount", { count: model.memoCount })}</span>
          <span className="inline-flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5" />{t("memoTasks.notebooksCount", { count: model.groups.length })}</span>
        </div>}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <section className="min-w-0 flex-1 overflow-y-auto px-3 py-4 pb-12 sm:px-6 sm:py-5" aria-label={t("memoTasks.title")}>
            {query.isError && query.data && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{t("memoTasks.loadFailed")}</p>}
            {query.isPending ? <MemoTasksLoadingSurface label={t("memoTasks.loading")} /> : loadFailed ? <div role="alert" className="rounded-xl border bg-card p-8 text-center text-sm text-destructive"><p>{t("memoTasks.loadFailed")}</p><Button variant="outline" className="mt-3" onClick={() => void query.refetch()}>{t("memoTasks.refresh")}</Button></div> : <MemoTasksView tasks={tasks} memoTitles={memoTitles} onMark={changeMark} onNavigate={navigate} onSelect={task => setSelectedId(task.id)} selectedId={selected?.id} overview={{ model, filter, categoryPicker, collapsed, onToggle: toggle, onFilterChange: status => updateFilter({ status }), onQueryChange: value => updateFilter({ query: value }), onClear: clear }} />}
          </section>
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-8 bg-gradient-to-t from-background/85 to-transparent md:block" data-list-bottom-fade />
        </div>
        <aside className="hidden w-80 shrink-0 flex-col border-l bg-card xl:flex" aria-label={t("memoTasks.preview")}>
          <header className="border-b bg-muted/30 px-5 py-4"><p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t("memoTasks.preview")}</p><h2 className="flex items-start gap-2 text-sm font-semibold"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 break-words">{selectedMemo?.title || t("memoTasks.selectPreview")}</span></h2>
            {selected && <dl className="mt-4 space-y-2 text-xs">
              <div><dt className="text-[10px] text-muted-foreground">{t("memoTasks.sourceNotebook")}</dt><dd className="mt-0.5 break-words leading-relaxed">{selectedNotebookPath}</dd></div>
              <div className="flex items-center justify-between gap-2"><dt className="text-muted-foreground">{t("memoTasks.statusLabel")}</dt><dd className="flex items-center gap-1.5"><MemoTaskStatusIcon status={selected.status} />{t(`memoTasks.${selected.status}`)}</dd></div>
            </dl>}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{selected && previewRoot ? <>{selected.heading && <h3 className="mb-3 break-words px-2 text-xs font-medium text-muted-foreground">{selected.heading}</h3>}{preview(previewRoot)}</> : <div className="px-2 py-8 text-center text-xs leading-relaxed text-muted-foreground"><ListChecks className="mx-auto mb-3 h-6 w-6 opacity-50" />{t("memoTasks.selectPreview")}</div>}</div>
          {selected && <div className="border-t p-4"><Button variant="outline" className="w-full gap-2 text-xs" onClick={() => navigate(selected)}><ArrowUpRight className="h-4 w-4" />{t("memoTasks.locate")}</Button></div>}
        </aside>
      </div>
    </div>
    </TooltipProvider>
  );
};
