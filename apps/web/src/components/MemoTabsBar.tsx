import { useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Check, ChevronDown, CircleX, SquareX, X } from "lucide-react";
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
  MEMO_TAB_GAP_PX,
  MEMO_TAB_MORE_BUTTON_WIDTH_PX,
  resolveMemoTabOverflow,
} from "@/lib/memo-tabs";

export type MemoTabItem = {
  id: string;
  title: string;
};

const TAB_BAR_HORIZONTAL_PADDING_PX = 12;

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

  return (
    <div
      ref={barRef}
      className="relative flex h-9 shrink-0 items-stretch gap-0.5 overflow-hidden border-b border-slate-200 bg-slate-50 px-1.5 pt-1"
      role="tablist"
      aria-label={t("memoTabs.label")}
    >
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex gap-0.5 px-1.5"
      >
        {tabs.map((tab) => (
          <span
            key={tab.id}
            data-memo-tab-measure-id={tab.id}
            className="flex h-8 min-w-[96px] max-w-[220px] items-center rounded-t-md border border-b-0 px-2.5 pr-7 text-[13px]"
          >
            <span className="truncate">{tab.title}</span>
          </span>
        ))}
      </div>

      {visibleTabs.map((tab) => {
        const active = tab.id === activeMemoId;
        return (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group relative flex max-w-[220px] shrink-0 items-center rounded-t-md transition",
                  draggingMemoId === tab.id && "opacity-40",
                  dragOverMemoId === tab.id && "ring-2 ring-emerald-500/40",
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
                        "flex h-full min-w-[96px] max-w-[220px] items-center rounded-t-md border border-b-0 px-2.5 pr-7 text-[13px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300",
                        active
                          ? "border-slate-200 bg-card font-medium text-slate-900"
                          : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800"
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
                      <span className="truncate">{tab.title}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{tab.title}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        "absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-sm text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300",
                        active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
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
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700"
                onSelect={() => onClose(tab.id)}
              >
                <X className="h-4 w-4" />
                {t("memoTabs.closeCurrent")}
              </ContextMenuItem>
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700"
                onSelect={() => onCloseOthers(tab.id)}
              >
                <CircleX className="h-4 w-4" />
                {t("memoTabs.closeOthers")}
              </ContextMenuItem>
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700"
                onSelect={onCloseAll}
              >
                <SquareX className="h-4 w-4" />
                {t("memoTabs.closeAll")}
              </ContextMenuItem>
              <ContextMenuSeparator className="my-1 h-px bg-slate-100" />
              <ContextMenuItem
                className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm text-slate-700"
                onSelect={() => onOpenInNewWindow(tab.id)}
              >
                <AppWindow className="h-4 w-4" />
                {t("memoTabs.openInNewWindow")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {hiddenTabs.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-slate-500 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                  type="button"
                  aria-label={t("memoTabs.more")}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("memoTabs.more")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-64">
            <div className="max-h-72 overflow-y-auto">
              {hiddenTabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.id}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                  data-overflow-memo-tab-id={tab.id}
                  onSelect={() => onSelect(tab.id)}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      tab.id === activeMemoId ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{tab.title}</span>
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};
