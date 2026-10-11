import { AlertTriangle, Copy, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type CollabConflictBarProps = {
  /** The person/actor who currently owns the note, when known. */
  peerNames: string[];
  onLoadLatest: () => void;
  onOverwrite: () => void;
  onCopyMine: () => void;
};

/**
 * Yuque-style collaboration conflict bar: instead of a bare error, tell the
 * editor someone else saved first and offer the collaborative way out —
 * load the newest version (keeping a copy of local edits) or consciously
 * overwrite. Never shown for personal notes.
 */
export const CollabConflictBar = ({ peerNames, onLoadLatest, onOverwrite, onCopyMine }: CollabConflictBarProps) => {
  const { t } = useTranslation();
  const who = peerNames.length > 0 ? peerNames.join("、") : t("collab.someone", "其他成员");

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="mr-auto">
        {t("collab.conflictMessage", "{{who}} 刚刚更新了这篇笔记，你的修改还没有保存。", { who })}
      </span>
      <Button size="sm" variant="solid" onClick={onLoadLatest}>
        <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
        {t("collab.loadLatest", "载入最新，保留我的修改")}
      </Button>
      <Button size="sm" variant="outline" onClick={onCopyMine}>
        <Copy className="mr-1 h-3.5 w-3.5" aria-hidden />
        {t("collab.copyMine", "复制我的版本")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onOverwrite}>
        {t("collab.overwrite", "仍要覆盖")}
      </Button>
    </div>
  );
};

/** Compact "who is here" pill for the editor chrome. */
export const CollabPresenceBadge = ({ peerNames }: { peerNames: string[] }) => {
  const { t } = useTranslation();
  if (peerNames.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {t("collab.editingNow", "{{names}} 正在编辑", { names: peerNames.join("、") })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{peerNames.join("、")}</TooltipContent>
    </Tooltip>
  );
};
