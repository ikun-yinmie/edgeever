import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type MemoTabItem = {
  id: string;
  title: string;
};

export const MemoTabsBar = ({
  tabs,
  activeMemoId,
  onSelect,
  onClose,
}: {
  tabs: MemoTabItem[];
  activeMemoId: string | null;
  onSelect: (memoId: string) => void;
  onClose: (memoId: string) => void;
}) => {
  const { t } = useTranslation();
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeMemoId, tabs]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-slate-200 bg-slate-50 px-1.5 pt-1"
      role="tablist"
      aria-label={t("memoTabs.label")}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeMemoId;
        return (
          <div key={tab.id} className="group relative flex max-w-[220px] shrink-0 items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  ref={active ? activeTabRef : undefined}
                  className={cn(
                    "flex h-full min-w-[96px] items-center rounded-t-md border border-b-0 px-2.5 pr-7 text-[13px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300",
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
        );
      })}
    </div>
  );
};
