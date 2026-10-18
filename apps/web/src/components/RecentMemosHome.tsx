import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { MemoSummary } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EdgeEverRepository } from "@/lib/repository";
import { getCalendarGridDayKeys, getDayKeyFromDate, getMemoDayKey, groupMemosByDay } from "@/lib/recent-memos";

const RECENT_MEMOS_PAGE_SIZE = 50;
const RECENT_MEMOS_AUTOLOAD_LIMIT = 2000;
const CALENDAR_WEEKDAY_REFERENCE = new Date(2026, 0, 5);

type RecentMemosHomeProps = {
  repository: EdgeEverRepository;
  onOpenMemo: (memo: MemoSummary) => void;
  onCreateMemo: () => void;
  onClose: () => void;
};

export const RecentMemosHome = ({
  repository,
  onOpenMemo,
  onCreateMemo,
  onClose,
}: RecentMemosHomeProps) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "zh-CN";
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), monthIndex: now.getMonth() };
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const memosQuery = useInfiniteQuery({
    queryKey: ["recent-memos-home"],
    queryFn: ({ pageParam }) => repository.listMemos({
      notebookId: null,
      trash: false,
      filter: "all",
      sort: "updated-desc",
      offset: pageParam,
      limit: RECENT_MEMOS_PAGE_SIZE,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loadedCount = pages.reduce((count, page) => count + page.memos.length, 0);
      return lastPage.memos.length < RECENT_MEMOS_PAGE_SIZE || loadedCount >= lastPage.totalCount
        ? null
        : loadedCount;
    },
  });

  const memos = useMemo(() => {
    const seen = new Set<string>();
    const flattened: MemoSummary[] = [];

    for (const page of memosQuery.data?.pages ?? []) {
      for (const memo of page.memos) {
        if (!seen.has(memo.id)) {
          seen.add(memo.id);
          flattened.push(memo);
        }
      }
    }

    return flattened;
  }, [memosQuery.data]);

  const todayKey = getDayKeyFromDate(new Date());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayKey = getDayKeyFromDate(yesterdayDate);

  const memoDayKeys = useMemo(() => new Set(memos.map((memo) => getMemoDayKey(memo.updatedAt))), [memos]);

  const selectedDayStart = selectedDay ? new Date(`${selectedDay}T00:00:00`).getTime() : null;
  const oldestLoadedMemo = memos[memos.length - 1];
  const shouldAutoloadOlderMemos = Boolean(
    selectedDayStart !== null
    && memosQuery.hasNextPage
    && !memosQuery.isFetchingNextPage
    && oldestLoadedMemo
    && new Date(oldestLoadedMemo.updatedAt).getTime() >= selectedDayStart
    && memos.length < RECENT_MEMOS_AUTOLOAD_LIMIT
  );

  useEffect(() => {
    if (!shouldAutoloadOlderMemos) {
      return;
    }

    void memosQuery.fetchNextPage();
  }, [memosQuery, shouldAutoloadOlderMemos]);

  const calendarDayKeys = useMemo(
    () => getCalendarGridDayKeys(calendarMonth.year, calendarMonth.monthIndex),
    [calendarMonth]
  );

  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" })
      .format(new Date(calendarMonth.year, calendarMonth.monthIndex, 1)),
    [calendarMonth.monthIndex, calendarMonth.year, locale]
  );

  const weekdayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: "short" })
      .format(new Date(CALENDAR_WEEKDAY_REFERENCE.getFullYear(), CALENDAR_WEEKDAY_REFERENCE.getMonth(), CALENDAR_WEEKDAY_REFERENCE.getDate() + index))),
    [locale]
  );

  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: true }),
    [locale]
  );

  const formatDayLabel = (dayKey: string) => {
    if (dayKey === todayKey) {
      return t("recentMemos.today");
    }

    if (dayKey === yesterdayKey) {
      return t("recentMemos.yesterday");
    }

    return dayKey.replaceAll("-", ".");
  };

  const visibleMemos = useMemo(
    () => (selectedDay ? memos.filter((memo) => getMemoDayKey(memo.updatedAt) === selectedDay) : memos),
    [memos, selectedDay]
  );
  const dayGroups = useMemo(() => groupMemosByDay(visibleMemos), [visibleMemos]);

  const showTodayPlaceholder = (!selectedDay || selectedDay === todayKey) && !memoDayKeys.has(todayKey);
  const showDayEmptyState = Boolean(selectedDay) && visibleMemos.length === 0 && !showTodayPlaceholder;

  const navigateCalendarMonth = (delta: number) => {
    setCalendarMonth((current) => {
      const next = new Date(current.year, current.monthIndex + delta, 1);
      return { year: next.getFullYear(), monthIndex: next.getMonth() };
    });
  };

  const navigateCalendarYear = (delta: number) => {
    setCalendarMonth((current) => ({ ...current, year: current.year + delta }));
  };

  const handleSelectDay = (dayKey: string) => {
    const date = new Date(`${dayKey}T00:00:00`);
    setCalendarMonth({ year: date.getFullYear(), monthIndex: date.getMonth() });
    setSelectedDay((current) => (current === dayKey ? null : dayKey));
  };

  const calendarNavButtonClassName =
    "flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/70";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card">
      <header className="flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-slate-200 px-4 pb-3 pt-[env(safe-area-inset-top)] lg:h-16 lg:pb-0 lg:pt-0">
        <Button
          className="lg:hidden"
          size="icon"
          variant="ghost"
          aria-label={t("notebookPane.backToList")}
          onClick={onClose}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-normal text-slate-950">{t("recentMemos.title")}</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl items-start gap-10 px-6 py-6">
          <div className="min-w-0 flex-1">
            {memosQuery.isPending ? (
              <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500" role="status">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {t("recentMemos.loading")}
              </div>
            ) : memosQuery.isError ? (
              <div className="flex flex-col items-center gap-3 py-20 text-sm text-slate-500" role="status">
                <span>{t("recentMemos.loadFailed")}</span>
                <Button size="sm" variant="outline" onClick={() => void memosQuery.refetch()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t("recentMemos.retry")}
                </Button>
              </div>
            ) : (
              <div data-recent-memos-timeline>
                {showTodayPlaceholder ? (
                  <section className="mb-4">
                    <div className="mb-1 flex items-center px-3">
                      <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-sm font-medium text-emerald-700">
                        {t("recentMemos.today")}
                      </span>
                    </div>
                    <button
                      className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
                      type="button"
                      onClick={onCreateMemo}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 text-slate-400 transition-colors group-hover:border-emerald-400 group-hover:text-emerald-600">
                        <Plus className="h-3 w-3" />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{t("recentMemos.newMemoHint")}</span>
                    </button>
                  </section>
                ) : null}

                {showDayEmptyState ? (
                  <div className="px-3 py-10 text-center text-sm text-slate-500">{t("recentMemos.emptyForDay")}</div>
                ) : null}

                {dayGroups.map((group) => (
                  <section className="mb-4" key={group.dayKey}>
                    <div className="mb-1 flex items-center px-3">
                      <span
                        className={cn(
                          "rounded-md px-2 py-0.5 text-sm font-medium",
                          group.dayKey === todayKey
                            ? "bg-emerald-500/10 text-emerald-700"
                            : "bg-slate-100 text-slate-600"
                        )}
                      >
                        {formatDayLabel(group.dayKey)}
                      </span>
                    </div>
                    <ul>
                      {group.memos.map((memo) => (
                        <li key={memo.id}>
                          <button
                            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
                            type="button"
                            onClick={() => onOpenMemo(memo)}
                          >
                            <span className="w-16 shrink-0 text-xs tabular-nums text-slate-400">
                              {timeFormatter.format(new Date(memo.updatedAt))}
                            </span>
                            <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{memo.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {memosQuery.hasNextPage ? (
                  <div className="flex justify-center py-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={memosQuery.isFetchingNextPage}
                      onClick={() => void memosQuery.fetchNextPage()}
                    >
                      {memosQuery.isFetchingNextPage ? (
                        <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {t("recentMemos.loadMore")}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <aside className="sticky top-0 hidden w-80 shrink-0 md:block" data-recent-memos-calendar>
            <TooltipProvider delayDuration={0} skipDelayDuration={0}>
              <div className="rounded-lg border border-slate-200 bg-card p-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
                <div className="mb-2 flex items-center justify-between px-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className={calendarNavButtonClassName}
                        type="button"
                        aria-label={t("recentMemos.prevYear")}
                        onClick={() => navigateCalendarYear(-1)}
                      >
                        <ChevronsLeft className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("recentMemos.prevYear")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className={calendarNavButtonClassName}
                        type="button"
                        aria-label={t("recentMemos.prevMonth")}
                        onClick={() => navigateCalendarMonth(-1)}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("recentMemos.prevMonth")}</TooltipContent>
                  </Tooltip>
                  <span className="text-sm font-semibold text-slate-900">{monthTitle}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className={calendarNavButtonClassName}
                        type="button"
                        aria-label={t("recentMemos.nextMonth")}
                        onClick={() => navigateCalendarMonth(1)}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("recentMemos.nextMonth")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className={calendarNavButtonClassName}
                        type="button"
                        aria-label={t("recentMemos.nextYear")}
                        onClick={() => navigateCalendarYear(1)}
                      >
                        <ChevronsRight className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("recentMemos.nextYear")}</TooltipContent>
                  </Tooltip>
                </div>

                <div className="grid grid-cols-7 gap-0.5">
                  {weekdayLabels.map((label, index) => (
                    <span
                      className={cn(
                        "flex h-7 items-center justify-center text-xs font-medium",
                        index >= 5 ? "text-rose-400" : "text-slate-500"
                      )}
                      key={label}
                    >
                      {label}
                    </span>
                  ))}
                  {calendarDayKeys.map((dayKey) => {
                    const date = new Date(`${dayKey}T00:00:00`);
                    const inMonth = date.getMonth() === calendarMonth.monthIndex;
                    const hasMemos = memoDayKeys.has(dayKey);
                    const isSelected = selectedDay === dayKey;
                    const isToday = dayKey === todayKey;
                    const isWeekend = date.getDay() === 0 || date.getDay() === 6;

                    return (
                      <button
                        className={cn(
                          "flex h-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70",
                          !inMonth && "text-slate-300",
                          inMonth && !hasMemos && !isSelected && (isWeekend ? "text-rose-500" : "text-slate-700"),
                          hasMemos && !isSelected && "bg-slate-200/70 font-medium text-slate-900 hover:bg-slate-200",
                          isToday && !isSelected && "ring-1 ring-inset ring-emerald-500/70",
                          isSelected ? "bg-emerald-500 font-medium text-white" : "hover:bg-slate-100"
                        )}
                        type="button"
                        key={dayKey}
                        aria-pressed={isSelected}
                        onClick={() => handleSelectDay(dayKey)}
                      >
                        {date.getDate()}
                      </button>
                    );
                  })}
                </div>

                {selectedDay ? (
                  <button
                    className="mt-2 w-full rounded-md px-2 py-1 text-center text-xs text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/70"
                    type="button"
                    onClick={() => setSelectedDay(null)}
                  >
                    {t("recentMemos.clearDayFilter")}
                  </button>
                ) : null}
              </div>
            </TooltipProvider>
          </aside>
        </div>
      </div>
    </div>
  );
};
