import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildOutlineTree,
  getOutlineDisplaySegments,
  trimOutlineSegments,
  type OutlineItem,
  type OutlineTextSegment,
  type OutlineTreeItem,
} from "@/lib/editor-outline";
import { cn } from "@/lib/utils";
import { EDITOR_OUTLINE_WIDTH } from "@/lib/workspace-ui";

type EditorOutlineProps = {
  editor: Editor | null;
  scrollContainer: HTMLDivElement | null;
  previewContainer?: HTMLDivElement | null;
  collapsed: boolean;
  shortcutLabel: string;
  onCollapsedChange: (collapsed: boolean) => void;
};

const EDITOR_READ_LINE_OFFSET = 96;
const PREVIEW_READ_LINE_OFFSET = 72;
const PREVIEW_HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const ALIGN_TOLERANCE_PX = 4;

const getPreviewHeadingElements = (container: HTMLDivElement | null) => {
  if (!container) {
    return [];
  }
  return [...container.querySelectorAll<HTMLElement>(PREVIEW_HEADING_SELECTOR)].filter(
    (element) => (element.textContent ?? "").trim().length > 0
  );
};

const getOutlineItems = (editor: Editor): OutlineItem[] => {
  const items: OutlineItem[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") {
      return;
    }

    const rawSegments: OutlineTextSegment[] = [];
    node.forEach((child) => {
      if (!child.isText || !child.text) {
        return;
      }

      const strike = child.marks.some((mark) => mark.type.name === "strike");
      const previous = rawSegments[rawSegments.length - 1];
      if (previous && previous.strike === strike) {
        previous.text += child.text;
      } else {
        rawSegments.push({ text: child.text, strike });
      }
    });

    const segments = trimOutlineSegments(rawSegments);
    const text = segments.map((segment) => segment.text).join("");
    if (text) {
      items.push({
        level: Number(node.attrs.level) || 1,
        pos,
        text,
        segments,
      });
    }
  });

  return items;
};

const sameOutlineSegments = (left: OutlineTextSegment[] | undefined, right: OutlineTextSegment[] | undefined) => {
  if (!left || !right) {
    return left === right;
  }

  return left.length === right.length && left.every((segment, index) => {
    const other = right[index];
    return other?.text === segment.text && other.strike === segment.strike;
  });
};

const sameOutlineItems = (left: OutlineItem[], right: OutlineItem[]) =>
  left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other?.level === item.level
      && other.pos === item.pos
      && other.text === item.text
      && sameOutlineSegments(other.segments, item.segments);
  });

export const EditorOutline = ({ editor, scrollContainer, previewContainer = null, collapsed, shortcutLabel, onCollapsedChange }: EditorOutlineProps) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);
  const [collapsedPositions, setCollapsedPositions] = useState<Set<number>>(() => new Set());
  const scrollTrackingPausedUntilRef = useRef(0);
  const tree = useMemo(() => buildOutlineTree(items), [items]);

  const refresh = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setItems([]);
      return;
    }

    const nextItems = getOutlineItems(editor);
    setItems((currentItems) => (sameOutlineItems(currentItems, nextItems) ? currentItems : nextItems));
  }, [editor]);

  const updateActiveItem = useCallback(() => {
    if (!editor || editor.isDestroyed || items.length === 0) {
      setActivePos(null);
      return;
    }

    const selectionPos = editor.state.selection.from;
    const activeItem = items.reduce<OutlineItem | null>((current, item) => (
      item.pos <= selectionPos ? item : current
    ), null);

    const nextActivePos = activeItem?.pos ?? items[0]?.pos ?? null;
    setActivePos((currentActivePos) => (currentActivePos === nextActivePos ? currentActivePos : nextActivePos));
  }, [editor, items]);

  useEffect(() => {
    refresh();
    if (!editor) {
      return;
    }

    editor.on("update", refresh);
    editor.on("selectionUpdate", updateActiveItem);
    return () => {
      editor.off("update", refresh);
      editor.off("selectionUpdate", updateActiveItem);
    };
  }, [editor, refresh, updateActiveItem]);

  useEffect(() => {
    updateActiveItem();
  }, [updateActiveItem]);

  useEffect(() => {
    const availablePositions = new Set(items.map((item) => item.pos));
    setCollapsedPositions((current) => {
      const next = new Set([...current].filter((pos) => availablePositions.has(pos)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const resolveHeadingElement = useCallback((item: OutlineItem): HTMLElement | null => {
    if (previewContainer) {
      const index = items.findIndex((candidate) => candidate.pos === item.pos);
      if (index < 0) {
        return null;
      }
      return getPreviewHeadingElements(previewContainer)[index] ?? null;
    }

    const element = editor?.view.nodeDOM(item.pos);
    return element instanceof HTMLElement ? element : null;
  }, [editor, items, previewContainer]);

  useEffect(() => {
    const trackingContainer = previewContainer ?? scrollContainer;
    if (!trackingContainer || items.length === 0) {
      return;
    }

    const updateFromScroll = () => {
      if (Date.now() < scrollTrackingPausedUntilRef.current) {
        return;
      }

      const offset = previewContainer ? PREVIEW_READ_LINE_OFFSET : EDITOR_READ_LINE_OFFSET;
      const threshold = trackingContainer.getBoundingClientRect().top + offset;
      let activeItem: OutlineItem | null = null;

      for (const item of items) {
        const element = resolveHeadingElement(item);
        if (element && element.getBoundingClientRect().top <= threshold) {
          activeItem = item;
        }
      }

      if (activeItem) {
        const nextActivePos = activeItem.pos;
        setActivePos((currentActivePos) => (currentActivePos === nextActivePos ? currentActivePos : nextActivePos));
      }
    };

    trackingContainer.addEventListener("scroll", updateFromScroll, { passive: true });
    updateFromScroll();
    return () => trackingContainer.removeEventListener("scroll", updateFromScroll);
  }, [items, previewContainer, resolveHeadingElement, scrollContainer]);

  const jumpToHeading = (item: OutlineItem) => {
    // Keep the clicked heading active while smooth scrolling. Without this
    // guard, intermediate scroll positions can briefly reactivate an earlier
    // heading and make two rows appear selected (active + hovered).
    scrollTrackingPausedUntilRef.current = Date.now() + 800;
    setActivePos(item.pos);

    if (previewContainer) {
      const previewElement = resolveHeadingElement(item);
      if (previewElement) {
        const delta = previewElement.getBoundingClientRect().top
          - (previewContainer.getBoundingClientRect().top + PREVIEW_READ_LINE_OFFSET);
        if (Math.abs(delta) >= ALIGN_TOLERANCE_PX) {
          previewContainer.scrollTo({ top: previewContainer.scrollTop + delta, behavior: "smooth" });
        }
      }
      return;
    }

    if (!editor || editor.isDestroyed) {
      return;
    }

    let domElement: HTMLElement | null = null;
    const domNode = editor.view.nodeDOM(item.pos);
    if (domNode instanceof HTMLElement) {
      domElement = domNode;
    } else {
      try {
        const domAtPos = editor.view.domAtPos(item.pos);
        if (domAtPos.node instanceof HTMLElement) {
          domElement = domAtPos.node;
        } else if (domAtPos.node.parentElement instanceof HTMLElement) {
          domElement = domAtPos.node.parentElement;
        }
      } catch {
        // ignore DOM resolution error
      }
    }

    if (domElement) {
      domElement.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    try {
      const maxPos = editor.state.doc.content.size;
      const targetPos = Math.min(item.pos + 1, maxPos);
      editor.chain().focus().setTextSelection(targetPos).run();
    } catch {
      // ignore selection positioning error
    }
  };

  const toggleItem = (pos: number) => {
    setCollapsedPositions((current) => {
      const next = new Set(current);
      if (next.has(pos)) {
        next.delete(pos);
      } else {
        next.add(pos);
      }
      return next;
    });
  };

  const renderItems = (treeItems: OutlineTreeItem[], depth = 0) => (
    <ol className={cn("space-y-0.5", depth > 0 && "py-0.5")}>
      {treeItems.map((item) => {
        const isActive = activePos === item.pos;
        const hasChildren = item.children.length > 0;
        const itemCollapsed = collapsedPositions.has(item.pos);
        const displaySegments = getOutlineDisplaySegments(item);
        const toggleLabel = t(itemCollapsed ? "editor.expandOutlineHeading" : "editor.collapseOutlineHeading", { name: item.text });

        return (
          <li key={item.pos}>
            <div
              className={cn(
                "group flex min-h-8 items-center rounded-[6px] pr-2 text-[13px] leading-5 transition-colors duration-150",
                isActive
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-700 hover:bg-slate-50/70 hover:text-slate-900"
              )}
              style={{
                marginLeft: `${depth * -24}px`,
                paddingLeft: `${depth * 24}px`,
                width: `calc(100% + ${depth * 24}px)`,
              }}
            >
              {hasChildren ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      onClick={() => toggleItem(item.pos)}
                      aria-label={toggleLabel}
                      aria-expanded={!itemCollapsed}
                    >
                      {itemCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{toggleLabel}</TooltipContent>
                </Tooltip>
              ) : (
                <span className="h-7 w-6 shrink-0" aria-hidden="true" />
              )}

              <button
                type="button"
                className="min-w-0 flex-1 truncate py-1 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                onClick={() => jumpToHeading(item)}
                aria-current={isActive ? "location" : undefined}
              >
                {displaySegments.map((segment, segmentIndex) => (
                  <span
                    key={`${segmentIndex}-${segment.strike ? "strike" : "plain"}`}
                    className={segment.strike ? "line-through" : undefined}
                  >
                    {segment.text}
                  </span>
                ))}
              </button>
            </div>

            {hasChildren && !itemCollapsed && (
              <div className="ml-3 border-l border-slate-200/90 pl-3">
                {renderItems(item.children, depth + 1)}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );

  if (items.length === 0) {
    return null;
  }

  const outlineToggleLabel = `${t(collapsed ? "editor.showOutline" : "editor.hideOutline")} (${shortcutLabel})`;

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <aside
        className={cn(
          "select-none",
          collapsed
            ? "sticky top-6 z-20 h-8 w-0 shrink-0 self-start overflow-visible"
            : "sticky top-6 h-fit max-h-[calc(100vh-8rem)] shrink-0 overflow-y-auto overflow-x-hidden py-2"
        )}
        style={{
          ...(!collapsed ? { width: EDITOR_OUTLINE_WIDTH } : {}),
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
        }}
        aria-label={t("editor.outline")}
      >
        <div className={cn("flex", collapsed ? "absolute right-0 top-0 h-8 w-8 justify-center" : "mb-3 justify-between px-1")}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "group flex items-center text-left text-[11px] font-bold uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60",
                  collapsed ? "h-7 w-7 justify-center rounded-md hover:bg-slate-100" : "gap-1.5 rounded-sm"
                )}
                onClick={() => onCollapsedChange(!collapsed)}
                aria-expanded={!collapsed}
                aria-label={outlineToggleLabel}
              >
                {collapsed ? (
                  <ListTree className="h-4 w-4 text-slate-400 group-hover:text-slate-600" aria-hidden="true" />
                ) : (
                  <>
                    <span>{t("editor.outline")}</span>
                    <ChevronDown className="h-3 w-3 text-slate-400 transition-transform duration-200 group-hover:text-slate-600" aria-hidden="true" />
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{outlineToggleLabel}</TooltipContent>
          </Tooltip>
        </div>

        {!collapsed && (
          <nav className="pr-2" aria-label={t("editor.outline")}>
            {renderItems(tree)}
          </nav>
        )}
      </aside>
    </TooltipProvider>
  );
};
