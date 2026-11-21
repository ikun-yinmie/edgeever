import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getNotebookDescendantIds, type MemoSummary, type Notebook } from "@edgeever/shared";
import type { EdgeEverRepository } from "@/lib/repository";
import { getMemoTitle } from "@/lib/app-helpers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  COMMAND_ITEM_STRONG_SELECTED_CLASS_NAME,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

type QuickMemoSwitcherProps = {
  open: boolean;
  query: string;
  mode: "switcher" | "search";
  initialScope: "notebook" | "all";
  notebookId: string | null;
  notebooks: Notebook[];
  dataScope: string;
  repository: EdgeEverRepository;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onOpenMemo: (memo: MemoSummary) => void;
};

export const QuickMemoSwitcher = ({
  open,
  query,
  mode,
  initialScope,
  notebookId,
  notebooks,
  dataScope,
  repository,
  onOpenChange,
  onQueryChange,
  onOpenMemo,
}: QuickMemoSwitcherProps) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedMemoId, setSelectedMemoId] = useState("");
  const [scope, setScope] = useState(initialScope);
  const [visiblePageCount, setVisiblePageCount] = useState(1);
  const deferredQuery = useDeferredValue(query.trim());
  const currentNotebook = notebooks.find((notebook) => notebook.id === notebookId) ?? null;
  const scopedNotebookId = mode === "search" && scope === "notebook" ? currentNotebook?.id ?? null : null;
  const notebookIds = useMemo(() => scopedNotebookId
    ? getNotebookDescendantIds(notebooks, scopedNotebookId)
    : [], [notebooks, scopedNotebookId]);
  const notebookNames = useMemo(() => new Map(notebooks.map((notebook) => [notebook.id, notebook.name])), [notebooks]);
  const memoQuery = useInfiniteQuery({
    queryKey: ["memos", "notebook", scopedNotebookId, deferredQuery, "all", "updated-desc", notebookIds, null, Boolean(scopedNotebookId), "search-dialog", dataScope],
    queryFn: ({ pageParam }) => repository.listMemos({
      notebookId: scopedNotebookId,
      notebookIds: scopedNotebookId ? notebookIds : undefined,
      includeDescendants: Boolean(scopedNotebookId),
      q: deferredQuery,
      trash: false,
      filter: "all",
      sort: "updated-desc",
      offset: pageParam ? Number(pageParam) : 0,
      limit: 50,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open,
    staleTime: 0,
  });
  const memos = useMemo(() => Array.from(new Map(
    (memoQuery.data?.pages ?? []).slice(0, visiblePageCount).flatMap((page) => page.memos).map((memo) => [memo.id, memo]),
  ).values()), [memoQuery.data, visiblePageCount]);
  const availablePageCount = memoQuery.data?.pages.length ?? 0;
  const hasCachedMore = visiblePageCount < availablePageCount;
  const hasMore = hasCachedMore || memoQuery.hasNextPage;
  const loadMoreError = memoQuery.isFetchNextPageError && !hasCachedMore;
  const loading = memoQuery.isPending || query.trim() !== deferredQuery;
  const copyKey = mode === "search" ? "memoSearch" : "quickSwitcher";
  const paginationContext = JSON.stringify([mode, scopedNotebookId, deferredQuery, notebookIds, dataScope]);

  // Cached pages may be reused, but "load more" is local to this opening/search.
  useEffect(() => {
    setVisiblePageCount(1);
  }, [open, paginationContext]);

  const handleLoadMore = () => {
    if (hasCachedMore) {
      setVisiblePageCount((current) => Math.min(current + 1, availablePageCount));
      return;
    }
    // Advance before fetching so a late response cannot re-expand a closed dialog.
    // On retry, keep the same target page instead of skipping another page.
    setVisiblePageCount(availablePageCount + 1);
    void memoQuery.fetchNextPage();
  };

  useEffect(() => {
    if (open) setScope(initialScope);
  }, [open, initialScope]);

  useEffect(() => {
    setSelectedMemoId((current) => (
      memos.some((memo) => memo.id === current) ? current : memos[0]?.id ?? ""
    ));
  }, [memos]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[18%] flex max-h-[74dvh] w-[calc(100%-2rem)] max-w-xl translate-y-0 flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">{t(`${copyKey}.title`)}</DialogTitle>
        <DialogDescription className="sr-only">{t(`${copyKey}.description`)}</DialogDescription>
        <Command className="min-h-0" shouldFilter={false} value={selectedMemoId} onValueChange={setSelectedMemoId}>
          {mode === "search" && (
            <div className="shrink-0 space-y-2 px-4 pb-3 pr-12 pt-5">
              <div className="flex gap-1" role="group" aria-label={t("memoSearch.scope")} onKeyDown={(event) => event.stopPropagation()}>
                {(["notebook", "all"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={(scopedNotebookId ? "notebook" : "all") === value}
                    disabled={value === "notebook" && !currentNotebook}
                    onClick={() => setScope(value)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-40",
                      (scopedNotebookId ? "notebook" : "all") === value
                        ? "bg-emerald-100 text-emerald-700"
                        : "text-slate-500 hover:bg-slate-100",
                    )}
                  >
                    {t(value === "notebook" ? "memoSearch.currentNotebook" : "memoSearch.allMemos")}
                  </button>
                ))}
              </div>
              <p className="truncate text-xs text-slate-400">
                {scopedNotebookId
                  ? t("memoSearch.notebookHint", { name: currentNotebook?.name })
                  : t("memoSearch.allHint")}
              </p>
            </div>
          )}
          <CommandInput
            ref={inputRef}
            autoFocus
            aria-label={t(`${copyKey}.title`)}
            className={mode === "search" ? "h-11" : "pr-9"}
            wrapperClassName={mode === "search"
              ? "mx-4 mb-4 h-11 shrink-0 rounded-lg border border-slate-200 bg-slate-50 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/15 [&>svg]:text-slate-600"
              : "shrink-0"}
            placeholder={t("quickSwitcher.placeholder")}
            value={query}
            onValueChange={onQueryChange}
          />
          <CommandList className="min-h-0 max-h-[min(26rem,50dvh)] flex-1 p-1.5">
            {memoQuery.isError && !memoQuery.data ? (
              <div className="space-y-2 py-8 text-center text-sm text-slate-500" role="alert">
                <p>{t("memoSearch.failed")}</p>
                <Button size="sm" variant="outline" onKeyDown={(event) => event.stopPropagation()} onClick={() => void memoQuery.refetch()}>{t("memoSearch.retry")}</Button>
              </div>
            ) : loading ? (
              <LoadingIndicator label={t("quickSwitcher.loading")} centered className="py-8" />
            ) : (
              <>
                <CommandEmpty>{t("quickSwitcher.empty")}</CommandEmpty>
                <CommandGroup heading={deferredQuery ? t("quickSwitcher.results") : t("quickSwitcher.recent")}>
                  {memos.map((memo) => (
                    <CommandItem
                      key={memo.id}
                      className={COMMAND_ITEM_STRONG_SELECTED_CLASS_NAME}
                      value={memo.id}
                      onSelect={() => onOpenMemo(memo)}
                    >
                      <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                      <div className="min-w-0 flex-1 py-0.5">
                        <div className="truncate font-medium text-slate-900">{getMemoTitle(memo.title)}</div>
                        {memo.excerpt ? (
                          <div className="mt-0.5 truncate text-xs text-slate-500">{memo.excerpt}</div>
                        ) : null}
                        {mode === "search" && notebookNames.has(memo.notebookId) && (
                          <div className="mt-1 truncate text-[11px] text-slate-400">{notebookNames.get(memo.notebookId)}</div>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
          {!loading && hasMore && (
            <div className="shrink-0 px-3 pb-2 text-center" onKeyDown={(event) => event.stopPropagation()}>
              {loadMoreError && <p className="mb-2 text-xs text-red-600" role="alert">{t("memoSearch.failed")}</p>}
              <Button size="sm" variant="outline" disabled={memoQuery.isFetchingNextPage} onClick={handleLoadMore}>
                {t(memoQuery.isFetchingNextPage ? "quickSwitcher.loading" : loadMoreError ? "memoSearch.retry" : "memoSearch.loadMore")}
              </Button>
            </div>
          )}
          <div className="flex shrink-0 items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
            <span>{t("quickSwitcher.openHint")}</span>
            <span>{t("quickSwitcher.closeHint")}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
