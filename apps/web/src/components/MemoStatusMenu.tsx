import { useRef, useState } from "react";
import type { MemoStatus } from "@edgeever/shared";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MemoStatusBadge } from "@/components/MemoStatusBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const statuses: MemoStatus[] = ["in_progress", "completed", "cancelled"];
const NO_STATUS = "none";

export const MemoStatusMenu = ({
  status = null,
  disabled = false,
  onStatusChange,
}: {
  status?: MemoStatus | null;
  disabled?: boolean;
  onStatusChange: (status: MemoStatus | null) => void | Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const pendingRef = useRef(false);
  const changeStatus = async (value: string) => {
    const nextStatus = value === NO_STATUS ? null : statuses.find((candidate) => candidate === value);
    if (nextStatus === undefined || nextStatus === status || disabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onStatusChange(nextStatus);
    } catch {
      setFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <TooltipProvider delayDuration={0}>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={disabled || pending}
                  aria-label={t("memoStatus.menu")}
                  aria-busy={pending}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-card px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                  <span>{t("memoStatus.menu")}</span>
                  <MemoStatusBadge status={status} />
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("memoStatus.menu")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" aria-label={t("memoStatus.menu")}>
            <DropdownMenuRadioGroup value={status ?? NO_STATUS} onValueChange={(value) => void changeStatus(value)}>
              {statuses.map((value) => (
                <DropdownMenuRadioItem key={value} value={value} disabled={disabled || pending}>
                  <MemoStatusBadge status={value} />
                </DropdownMenuRadioItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuRadioItem value={NO_STATUS} disabled={disabled || pending}>
                {t("memoStatus.clear")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
      {failed ? <span role="alert" className="max-w-48 whitespace-normal text-xs text-rose-700 dark:text-rose-300">{t("memoStatus.saveError")}</span> : null}
    </div>
  );
};
