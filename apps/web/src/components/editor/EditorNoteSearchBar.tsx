import type { KeyboardEvent, RefObject } from "react";
import { ChevronLeft, ChevronRight, ReplaceAll, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ButtonTooltip } from "@/components/ui/button-tooltip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const EditorNoteSearchBar = ({
  inputRef,
  query,
  replacement,
  replaceOpen,
  readOnly,
  matchCount,
  matchLabel,
  navigationOnly = false,
  onOpenSearch,
  onQueryChange,
  onReplacementChange,
  onMoveMatch,
  onReplaceAll,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  replacement: string;
  replaceOpen: boolean;
  readOnly: boolean;
  matchCount: number;
  matchLabel: string;
  navigationOnly?: boolean;
  onOpenSearch?: () => void;
  onQueryChange: (query: string) => void;
  onReplacementChange: (replacement: string) => void;
  onMoveMatch: (direction: -1 | 1) => void;
  onReplaceAll: () => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const handleEscape = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return false;
    event.preventDefault();
    onClose();
    return true;
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-slate-100 px-4 py-2 sm:px-7",
        navigationOnly ? "flex-nowrap" : "flex-wrap",
      )}
      data-note-search-mode={navigationOnly ? "content" : "note"}
    >
      <Search className="h-4 w-4 shrink-0 text-slate-400" />
      {navigationOnly ? (
        <ButtonTooltip title={query}>
          <Button
            variant="ghost"
            className="h-8 min-w-0 flex-1 justify-start px-0 font-normal text-slate-600"
            aria-label={`${t("editor.searchPlaceholder")}: ${query}`}
            onClick={() => onOpenSearch?.()}
          >
            <span className="truncate">{query}</span>
          </Button>
        </ButtonTooltip>
      ) : (
        <Input
          ref={inputRef}
          value={query}
          className="h-8 min-w-[12rem] flex-1"
          aria-label={t("editor.searchPlaceholder")}
          placeholder={t("editor.searchPlaceholder")}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (handleEscape(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              onMoveMatch(event.shiftKey ? -1 : 1);
            }
          }}
        />
      )}
      {!navigationOnly && replaceOpen ? (
        <Input
          value={replacement}
          className="h-8 min-w-[12rem] flex-1"
          placeholder={t("editor.replacePlaceholder")}
          disabled={readOnly}
          onChange={(event) => onReplacementChange(event.target.value)}
          onKeyDown={(event) => {
            if (handleEscape(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              onReplaceAll();
            }
          }}
        />
      ) : null}
      <span
        className={cn(
          "min-w-12 shrink-0 text-center text-xs tabular-nums",
          query.trim() && matchCount === 0 ? "text-rose-500" : "text-slate-500",
        )}
        aria-live="polite"
        aria-atomic="true"
      >
        {matchLabel}
      </span>
      <ButtonTooltip title={t("editor.previousSearchResult")}>
        <Button size="icon" variant="ghost" aria-label={t("editor.previousSearchResult")} disabled={matchCount === 0} onClick={() => onMoveMatch(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </ButtonTooltip>
      <ButtonTooltip title={t("editor.nextSearchResult")}>
        <Button size="icon" variant="ghost" aria-label={t("editor.nextSearchResult")} disabled={matchCount === 0} onClick={() => onMoveMatch(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </ButtonTooltip>
      {!navigationOnly && replaceOpen ? (
        <Button size="sm" variant="solid" aria-label={t("editor.replaceAll")} disabled={readOnly || matchCount === 0} onClick={onReplaceAll}>
          <ReplaceAll className="h-4 w-4" />
          {t("editor.replaceAll")}
        </Button>
      ) : null}
      {!navigationOnly ? (
        <ButtonTooltip title={t("editor.closeSearch")}>
          <Button size="icon" variant="ghost" aria-label={t("editor.closeSearch")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </ButtonTooltip>
      ) : null}
    </div>
  );
};
