import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ListTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { getEditorOutlineItems } from "@/lib/editor-outline-editor";
import { getOutlineDisplaySegments, type OutlineItem } from "@/lib/editor-outline";
import { cn } from "@/lib/utils";

const MOBILE_READ_LINE_OFFSET = 88;
const DRAWER_CLOSE_DELAY_MS = 240;

type MobileOutlineSheetProps = {
  editor: Editor | null;
  scrollContainer?: HTMLElement | null;
  documentKey?: string;
  className?: string;
};

const resolveScrollTarget = (scrollContainer: HTMLElement | null | undefined) =>
  scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight + 1
    ? scrollContainer
    : null;

export const MobileOutlineSheet = ({
  editor,
  scrollContainer = null,
  documentKey,
  className,
}: MobileOutlineSheetProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);

  const refresh = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setItems([]);
      return;
    }
    setItems(getEditorOutlineItems(editor));
  }, [editor]);

  useEffect(() => {
    refresh();
    if (!editor || editor.isDestroyed) {
      return;
    }

    editor.on("update", refresh);
    return () => {
      editor.off("update", refresh);
    };
  }, [editor, refresh]);

  useEffect(() => {
    setActivePos(null);
  }, [documentKey]);

  useEffect(() => {
    if (!open || items.length === 0 || !editor || editor.isDestroyed) {
      return;
    }

    const scrollTarget = resolveScrollTarget(scrollContainer);
    const updateActive = () => {
      const threshold = scrollTarget
        ? scrollTarget.getBoundingClientRect().top + MOBILE_READ_LINE_OFFSET
        : MOBILE_READ_LINE_OFFSET;
      let nextActive: number | null = null;

      for (const item of items) {
        const element = editor.view.nodeDOM(item.pos);
        if (element instanceof HTMLElement && element.getBoundingClientRect().top <= threshold) {
          nextActive = item.pos;
        }
      }

      setActivePos(nextActive ?? items[0]?.pos ?? null);
    };

    const target: HTMLElement | Window = scrollTarget ?? window;
    target.addEventListener("scroll", updateActive, { passive: true });
    updateActive();
    return () => target.removeEventListener("scroll", updateActive);
  }, [editor, items, open, scrollContainer]);

  const jumpToHeading = useCallback((item: OutlineItem) => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    setOpen(false);
    setActivePos(item.pos);
    window.setTimeout(() => {
      const element = editor.view.nodeDOM(item.pos);
      if (!(element instanceof HTMLElement)) {
        return;
      }

      const scrollTarget = resolveScrollTarget(scrollContainer);
      if (scrollTarget) {
        const delta = element.getBoundingClientRect().top
          - (scrollTarget.getBoundingClientRect().top + MOBILE_READ_LINE_OFFSET);
        scrollTarget.scrollTo({ top: scrollTarget.scrollTop + delta, behavior: "smooth" });
        return;
      }

      window.scrollTo({
        top: element.getBoundingClientRect().top + window.scrollY - MOBILE_READ_LINE_OFFSET,
        behavior: "smooth",
      });
    }, DRAWER_CLOSE_DELAY_MS);
  }, [editor, scrollContainer]);

  const rows = useMemo(() => items.map((item) => ({
    item,
    segments: getOutlineDisplaySegments(item),
    indent: 12 + Math.max(0, Math.min(item.level - 1, 5)) * 14,
  })), [items]);

  if (items.length === 0) {
    return null;
  }

  const buttonLabel = t("editor.outlineShort");

  return (
    <>
      <button
        type="button"
        className={cn(
          "fixed bottom-5 left-4 z-30 flex h-10 items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/95 px-3.5 text-xs font-semibold text-slate-600 shadow-[0_8px_24px_rgba(15,23,42,0.12)] backdrop-blur transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-300 dark:hover:border-emerald-500/60 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300 lg:hidden",
          className,
        )}
        onClick={() => {
          refresh();
          setOpen(true);
        }}
        aria-label={buttonLabel}
        aria-expanded={open}
        data-mobile-outline-trigger="true"
      >
        <ListTree className="h-4 w-4" aria-hidden="true" />
        {buttonLabel}
      </button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent
          className="max-h-[70dvh] border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] lg:hidden"
          data-mobile-outline-sheet="true"
        >
          <DrawerHeader className="min-w-0 px-5 pb-2 pt-4">
            <DrawerTitle className="flex items-center gap-2 text-base">
              <ListTree className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              {t("editor.outline")}
            </DrawerTitle>
            <DrawerDescription className="sr-only">{t("editor.outlineShort")}</DrawerDescription>
          </DrawerHeader>
          <nav
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/70"
            aria-label={t("editor.outline")}
          >
            {rows.map(({ item, segments, indent }) => {
              const isActive = item.pos === activePos;
              return (
                <button
                  key={item.pos}
                  type="button"
                  className={cn(
                    "flex min-h-10 w-full items-center rounded-lg pr-3 text-left text-sm transition-colors",
                    isActive
                      ? "bg-emerald-50/90 font-medium text-emerald-800"
                      : "text-slate-600 hover:bg-slate-100/80 active:bg-slate-100",
                  )}
                  style={{ paddingLeft: indent }}
                  onClick={() => jumpToHeading(item)}
                  aria-current={isActive ? "location" : undefined}
                >
                  <span className="min-w-0 flex-1 truncate py-1">
                    {segments.map((segment, segmentIndex) => (
                      <span
                        key={`${segmentIndex}-${segment.strike ? "strike" : "plain"}`}
                        className={segment.strike ? "line-through" : undefined}
                      >
                        {segment.text}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </nav>
        </DrawerContent>
      </Drawer>
    </>
  );
};
