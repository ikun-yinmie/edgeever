import type { MemoStatus } from "@edgeever/shared";
import { Check, CircleDashed, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const statusAppearance = {
  in_progress: {
    icon: CircleDashed,
    className: "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
  },
  completed: {
    icon: Check,
    className: "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200",
  },
  cancelled: {
    icon: X,
    className: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200",
  },
} satisfies Record<MemoStatus, { icon: typeof Check; className: string }>;

export const MemoStatusBadge = ({
  status,
  className,
}: {
  status?: MemoStatus | null;
  className?: string;
}) => {
  const { t } = useTranslation();
  if (!status) return null;
  const appearance = statusAppearance[status];
  const Icon = appearance.icon;

  return (
    <span
      data-memo-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-4 tracking-normal",
        appearance.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(`memoStatus.${status}`)}
    </span>
  );
};
