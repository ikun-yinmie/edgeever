import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Check, ChevronDown, CircleX, FileText, FolderOpen, Search, SquareX, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  canRevealMemoMarkdown,
  isMemoMarkdownAvailable,
  revealMemoMarkdown,
} from "@/lib/desktop-note-file";
import {
  MEMO_TAB_GAP_PX,
  MEMO_TAB_MORE_BUTTON_WIDTH_PX,
  resolveMemoTabOverflow,
} from "@/lib/memo-tabs";

export type MemoTabItem = {
  id: string;
  title: string;
};

const TAB_BAR_HORIZONTAL_PADDING_PX = 16;

export const MemoTabsBar = ({
  tabs,
  activeMemoId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onOpenInNewWindow,
  onReorder,
}: {
  tabs: MemoTabItem[];
  activeMemoId: string | null;
  onSelect: (memoId: string) => void;
  onClose: (memoId: string) => void;
  onCloseOthers: (memoId: string) => void;
  onCloseAll: () => void;
  onOpenInNewWindow: (memoId: string) => void;
  onReorder: (sourceMemoId: string, targetMemoId: string) => void;
}) => {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [tabWidths, setTabWidths] = useState<Record<string, number>>({});
  const [draggingMemoId, setDraggingMemoId] = useState<string | null>(null);
  const [dragOverMemoId, setDragOverMemoId] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowQuery, setOverflowQuery] = useState("");
  const [localMarkdownMemoIds, setLocalMarkdownMemoIds] = useState<Record<string, boolean>>({});
  const overflowSearchRef = useRef<HTMLInputElement | null>(null);

  const refreshLocalMarkdownAvailability = useCallback(async (memoId: string) => {
    if (!canRevealMemoMarkdown()) return;
    const available = await isMemoMarkdownAvailable(memoId);
    setLocalMarkdownMemoIds((current) => (
      current[memoId] === available ? current : { ...current, [memoId]: available }
    ));
  }, []);

  const tabsKey = useMemo(
    () => tabs.map((tab) => `${tab.id}\u0000${tab.title}`).join("\u0001"),
    [tabs],
  );

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) {
      return;
    }

    const updateWidth = () => setBarWidth(bar.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [tabsKey]);

  useLayoutEffect(() => {
    const measureRoot = measureRef.current;
    if (!measureRoot) {
      return;
    }

    let disposed = false;
    const measure = () => {
      if (disposed) {
        return;
      }
      const next: Record<string, number> = {};
      measureRoot.querySelectorAll<HTMLElement>("[data-memo-tab-measure-id]").forEach((node) => {
        const id = node.dataset.memoTabMeasureId;
        if (id) {
          next[id] = node.getBoundingClientRect().width;
        }
      });
      setTabWidths((current) => {
        const ids = Object.keys(next);
        if (
          ids.length === Object.keys(current).length &&
          ids.every((id) => Math.abs((current[id] ?? 0) - next[id]) < 0.5)
        ) {
          return current;
        }
        return next;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    measureRoot.querySelectorAll("[data-memo-tab-measure-id]").forEach((node) => observer.observe(node));
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [tabsKey]);

  useEffect(() => {
    if (!overflowOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => overflowSearchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [overflowOpen]);

  const activeIndex = tabs.findIndex((tab) => tab.id === activeMemoId);
  const { start, count } = resolveMemoTabOverflow({
    tabWidths: tabs.map((tab) => tabWidths[tab.id] ?? 0),
    availableWidth: Math.max(0, barWidth - TAB_BAR_HORIZONTAL_PADDING_PX),
    activeIndex,
    gap: MEMO_TAB_GAP_PX,
    moreButtonWidth: MEMO_TAB_MORE_BUTTON_WIDTH_PX,
  });
  const visibleTabs = tabs.slice(start, start + count);
  const hiddenTabs = tabs.filter((_, index) => index < start || index >= start + count);
  const overflowTabs = useMemo(() => {
    const query = overflowQuery.trim().toLocaleLowerCase();
    if (!query) {
      return tabs;
    }
    return tabs.filter((tab) => tab.title.toLocaleLowerCase().includes(query));
  }, [overflowQuery, tabs]);

  if (tabs.length === 0) {
    return null;
  }

  const handleDragStart = (event: DragEvent<HTMLDivElement>, memoId: string) => {
    setDraggingMemoId(memoId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", memoId);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, memoId: string) => {
    if (!draggingMemoId || draggingMemoId === memoId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverMemoId(memoId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, memoId: string) => {
    event.preventDefault();
    const sourceMemoId = event.dataTransfer.getData("text/plain") || draggingMemoId;
    if (sourceMemoId && sourceMemoId !== memoId) {
      onReorder(sourceMemoId, memoId);
    }
    setDraggingMemoId(null);
    setDragOverMemoId(null);
  };

  const handleOverflowSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const content = overflowSearchRef.current?.closest('[role="menu"]');
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const items = content?.querySelectorAll<HTMLElement>("[data-overflow-memo-tab-id]");
      if (items?.length) {
        items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const firstItem = content?.querySelector<HTMLElement>("[data-overflow-memo-tab-id]");
      firstItem?.click();
      return;
    }
    if (event.key !== "Escape") {
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={barRef}
      className="relative flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b border-slate-200/80 bg-slate-100/50 px-2 select-none dark:border-slate-800 dark:bg-slate-900/40"
      role="tablist"
      aria-label={t("memoTabs.label")}
    >
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex gap-1 px-2"
      >
        {tabs.map((tab) => (
          <span
            key={tab.id}
            data-memo-tab-measure-id={tab.id}
            className="flex h-8 min-w-[96px] max-w-[220px] items-center gap-1.5 rounded-lg border px-2.5 pr-7 text-[13px]"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{tab.title}</span>
          </span>
        ))}
      </div>

      {visibleTabs.map((tab) => {
        const active = tab.id === activeMemoId;
        return (
          <ContextMenu
            key={tab.id}
            onOpenChange={(open) => {
              if (open) void refreshLocalMarkdownAvailability(tab.id);
            }}
          >
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group relative flex max-w-[220px] shrink-0 items-center rounded-lg transition-all duration-150",
                  draggingMemoId === tab.id && "opacity-40 scale-[0.98]",
                  dragOverMemoId === tab.id && "ring-2 ring-emerald-500/50 shadow-sm",
                )}
                draggable
                data-memo-tab-wrapper-id={tab.id}
                onDragStart={(event) => handleDragStart(event, tab.id)}
                onDragEnd={() => {
                  setDraggingMemoId(null);
                  setDragOverMemoId(null);
                }}
                onDragOver={(event) => handleDragOver(event, tab.id)}
                onDragLeave={() => {
                  setDragOverMemoId((current) => (current === tab.id ? null : current));
                }}
                onDrop={(event) => handleDrop(event, tab.id)}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        "flex h-8 min-w-[96px] max-w-[220px] items-center gap-1.5 rounded-lg border px-2.5 pr-7 text-[13px] tracking-tight transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                        active
                          ? "border-slate-200/90 bg-white font-medium text-slate-900 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.03)] ring-1 ring-black/[0.03] dark:border-slate-700/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-white/[0.03]"
                          : "border-transparent text-slate-500 hover:bg-slate-200/60 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                      )}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-memo-tab-id={tab.id}
                      onClick={() => onSelect(tab.id)}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          onClose(tab.id);
                        }
                      }}
                    >
                      <FileText
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 transition-colors duration-150",
                          active
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-slate-400 group-hover:text-slate-500 dark:text-slate-500 dark:group-hover:text-slate-400"
                        )}
                      />
                      <span className="truncate">{tab.title}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{tab.title}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        "absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-md text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30",
                        active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70 group-hover:hover:opacity-100 group-focus-within:opacity-100"
                      )}
                      type="button"
                      aria-label={t("memoTabs.close")}
                      onClick={() => onClose(tab.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("memoTabs.close")}</TooltipContent>
                </Tooltip>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700 dark:text-slate-200"
                onSelect={() => onClose(tab.id)}
              >
                <X className="h-4 w-4" />
                {t("memoTabs.closeCurrent")}
              </ContextMenuItem>
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700 dark:text-slate-200"
                onSelect={() => onCloseOthers(tab.id)}
              >
                <CircleX className="h-4 w-4" />
                {t("memoTabs.closeOthers")}
              </ContextMenuItem>
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700 dark:text-slate-200"
                onSelect={onCloseAll}
              >
                <SquareX className="h-4 w-4" />
                {t("memoTabs.closeAll")}
              </ContextMenuItem>
              <ContextMenuSeparator className="my-1 h-px bg-slate-100 dark:bg-slate-800" />
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700 dark:text-slate-200"
                onSelect={() => onOpenInNewWindow(tab.id)}
              >
                <AppWindow className="h-4 w-4" />
                {t("memoTabs.openInNewWindow")}
              </ContextMenuItem>
              {localMarkdownMemoIds[tab.id] && (
                <ContextMenuItem
                  className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700 dark:text-slate-200"
                  onSelect={() => void revealMemoMarkdown(tab.id)}
                >
                  <FolderOpen className="h-4 w-4" />
                  {t("common.showInFileManager")}
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {hiddenTabs.length > 0 && (
        <DropdownMenu
          open={overflowOpen}
          onOpenChange={(open) => {
            setOverflowOpen(open);
            if (!open) {
              setOverflowQuery("");
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  className="ml-auto flex h-7.5 w-7.5 shrink-0 items-center justify-center self-center rounded-lg text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                  type="button"
                  aria-label={t("memoTabs.more")}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("memoTabs.more")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-72 p-0 shadow-lg border border-slate-200/80 dark:border-slate-800 rounded-lg">
            <div className="border-b border-slate-100 dark:border-slate-800 p-2">
              <div className="flex h-8 items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 shadow-xs">
                <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <input
                  ref={overflowSearchRef}
                  className="h-full w-full bg-transparent text-xs text-slate-950 dark:text-slate-100 outline-none placeholder:text-slate-400"
                  type="text"
                  value={overflowQuery}
                  onChange={(event) => setOverflowQuery(event.target.value)}
                  onKeyDown={handleOverflowSearchKeyDown}
                  placeholder={t("memoTabs.searchPlaceholder")}
                  aria-label={t("memoTabs.searchPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto p-1.5 space-y-0.5">
              {overflowTabs.map((tab) => {
                const isTabActive = tab.id === activeMemoId;
                return (
                  <div key={tab.id} className="group relative">
                    <DropdownMenuItem
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md pr-9 text-xs transition-colors",
                        isTabActive && "bg-slate-100 dark:bg-slate-800 font-medium"
                      )}
                      data-overflow-memo-tab-id={tab.id}
                      onSelect={() => onSelect(tab.id)}
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400",
                          isTabActive ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <FileText
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          isTabActive
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-slate-400 group-hover:text-slate-600 dark:text-slate-500"
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    </DropdownMenuItem>
                    <button
                      className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 opacity-0 group-hover:opacity-100 transition-all hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                      type="button"
                      aria-label={t("memoTabs.close")}
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose(tab.id);
                        overflowSearchRef.current?.focus();
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {overflowTabs.length === 0 && (
                <div className="px-2 py-6 text-center text-xs text-slate-500">
                  {t("memoTabs.noSearchResults")}
                </div>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};
