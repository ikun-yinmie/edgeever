import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, ListTree, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildOutlineTree,
  getOutlineDisplaySegments,
  getOutlineParentPositions,
  trimOutlineSegments,
  type OutlineItem,
  type OutlineTextSegment,
  type OutlineTreeItem,
} from "@/lib/editor-outline";
import { cn } from "@/lib/utils";
import { EDITOR_OUTLINE_WIDTH } from "@/lib/workspace-ui";

type EditorOutlineProps = {
  editor: Editor | null;
  scrollContainer?: HTMLElement | null;
  previewContainer?: HTMLDivElement | null;
  collapsed: boolean;
  shortcutLabel?: string;
  /** Identifies the open document so a new note starts with its nested
   * headings collapsed again. */
  documentKey?: string;
  /** Public share pages scroll with the window instead of an editor pane. */
  trackWindowScroll?: boolean;
  /** Docked mode: the outline lives as an independent column beside the
   * article scroller (own scroll, own collapse affordances) instead of a
   * sticky panel inside the article scroll flow. */
  docked?: boolean;
  className?: string;
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

export const EditorOutline = ({
  editor,
  scrollContainer = null,
  previewContainer = null,
  collapsed,
  shortcutLabel = "",
  documentKey,
  trackWindowScroll = false,
  docked = false,
  className,
  onCollapsedChange,
}: EditorOutlineProps) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activePos, setActivePos] = useState<number | null>(null);
  const [collapsedPositions, setCollapsedPositions] = useState<Set<number>>(() => new Set());
  const scrollTrackingPausedUntilRef = useRef(0);
  const initializedDocumentKeyRef = useRef<string | null>(null);
  const tree = useMemo(() => buildOutlineTree(items), [items]);
  const parentPositions = useMemo(() => getOutlineParentPositions(tree), [tree]);
  const allCollapsed = parentPositions.length > 0
    && parentPositions.every((pos) => collapsedPositions.has(pos));
  const activeChain = useMemo(() => {
    if (activePos === null) {
      return [] as OutlineTreeItem[];
    }

    const chain: OutlineTreeItem[] = [];
    const find = (nodes: OutlineTreeItem[], trail: OutlineTreeItem[]): boolean => {
      for (const node of nodes) {
        const nextTrail = [...trail, node];
        if (node.pos === activePos) {
          chain.push(...nextTrail);
          return true;
        }
        if (node.children.length > 0 && find(node.children, nextTrail)) {
          return true;
        }
      }
      return false;
    };

    find(tree, []);
    return chain;
  }, [activePos, tree]);
  // Keep a highlight visible when the active heading sits inside a collapsed
  // branch: the nearest expanded ancestor represents it in the outline.
  const visibleActivePos = useMemo(() => {
    let visible: number | null = null;

    for (let index = 0; index < activeChain.length; index += 1) {
      const node = activeChain[index]!;
      visible = node.pos;
      if (collapsedPositions.has(node.pos) && index < activeChain.length - 1) {
        break;
      }
    }

    return visible;
  }, [activeChain, collapsedPositions]);

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

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    const key = documentKey ?? "editor";
    if (initializedDocumentKeyRef.current === key) {
      return;
    }

    // Defer a tick so a note switch has swapped in the new document before the
    // default collapse set is derived from its headings.
    const frame = window.setTimeout(() => {
      if (!editor || editor.isDestroyed) {
        return;
      }

      const nextTree = buildOutlineTree(getOutlineItems(editor));
      if (nextTree.length === 0) {
        // Empty or still-hydrating document: retry when headings arrive.
        return;
      }

      initializedDocumentKeyRef.current = key;
      setCollapsedPositions(new Set(getOutlineParentPositions(nextTree)));
    }, 0);

    return () => window.clearTimeout(frame);
  }, [documentKey, editor, items.length]);

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
    if (items.length === 0 || (!trackWindowScroll && !trackingContainer)) {
      return;
    }

    const updateFromScroll = () => {
      if (Date.now() < scrollTrackingPausedUntilRef.current) {
        return;
      }

      const offset = previewContainer ? PREVIEW_READ_LINE_OFFSET : EDITOR_READ_LINE_OFFSET;
      const threshold = trackWindowScroll || !trackingContainer
        ? offset
        : trackingContainer.getBoundingClientRect().top + offset;
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

    if (trackWindowScroll) {
      window.addEventListener("scroll", updateFromScroll, { passive: true });
      updateFromScroll();
      return () => window.removeEventListener("scroll", updateFromScroll);
    }

    trackingContainer?.addEventListener("scroll", updateFromScroll, { passive: true });
    updateFromScroll();
    return () => trackingContainer?.removeEventListener("scroll", updateFromScroll);
  }, [items, previewContainer, resolveHeadingElement, scrollContainer, trackWindowScroll]);

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
      // Setting the text selection makes ProseMirror run its own instant
      // scroll-into-view, which races the smooth scroll and leaves the heading
      // at a random viewport position. Scroll the editor pane explicitly to a
      // fixed read line instead (same pattern as the phone preview branch),
      // after the selection update so ProseMirror's scroll lands first. In a
      // read-only document (public share) there is no caret to move, and the
      // selection's scroll-into-view would override the explicit scroll.
      if (editor.isEditable) {
        try {
          const maxPos = editor.state.doc.content.size;
          const targetPos = Math.min(item.pos + 1, maxPos);
          editor.chain().focus().setTextSelection(targetPos).run();
        } catch {
          // ignore selection positioning error
        }
      }

      if (scrollContainer instanceof HTMLElement) {
        const delta = domElement.getBoundingClientRect().top
          - (scrollContainer.getBoundingClientRect().top + EDITOR_READ_LINE_OFFSET);
        if (Math.abs(delta) >= ALIGN_TOLERANCE_PX) {
          scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: "smooth" });
        }
      } else {
        domElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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

  const toggleAllCollapsed = () => {
    setCollapsedPositions(allCollapsed ? new Set() : new Set(parentPositions));
  };

  const collapseAllLabel = t(allCollapsed ? "editor.expandAllOutline" : "editor.collapseAllOutline");
  const collapseAllButton = parentPositions.length > 0 ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          onClick={toggleAllCollapsed}
          aria-pressed={allCollapsed}
          aria-label={collapseAllLabel}
        >
          {allCollapsed ? (
            <ChevronsDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronsUp className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{collapseAllLabel}</TooltipContent>
    </Tooltip>
  ) : null;

  const renderItems = (treeItems: OutlineTreeItem[], depth = 0) => (
    <ol className={cn("space-y-0.5", depth > 0 && "py-0.5")}>
      {treeItems.map((item) => {
        const isActive = visibleActivePos === item.pos;
        const hasChildren = item.children.length > 0;
        const itemCollapsed = collapsedPositions.has(item.pos);
        const displaySegments = getOutlineDisplaySegments(item);
        const toggleLabel = t(itemCollapsed ? "editor.expandOutlineHeading" : "editor.collapseOutlineHeading", { name: item.text });

        return (
          <li key={item.pos}>
            <div
              className={cn(
                "group relative flex min-h-8 items-center rounded-md pr-2 text-[13px] leading-5 transition-colors duration-150",
                isActive
                  ? "bg-emerald-50/90 text-emerald-800"
                  : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900"
              )}
              style={{
                marginLeft: `${depth * -24}px`,
                paddingLeft: `${depth * 24}px`,
                width: `calc(100% + ${depth * 24}px)`,
              }}
            >
              {isActive && (
                <span
                  className="absolute left-1 top-1/2 h-4 -translate-y-1/2 rounded-full bg-emerald-500"
                  style={{ width: 2.5 }}
                  aria-hidden="true"
                />
              )}
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
              <div className="ml-3 border-l border-slate-200/70 pl-3">
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

  const outlineToggleBaseLabel = t(collapsed ? "editor.showOutline" : "editor.hideOutline");
  const outlineToggleLabel = shortcutLabel ? `${outlineToggleBaseLabel} (${shortcutLabel})` : outlineToggleBaseLabel;

  if (docked) {
    return (
      <TooltipProvider delayDuration={350} skipDelayDuration={100}>
        <aside
          className={cn(
            "select-none h-full shrink-0",
            collapsed ? "relative w-0" : "flex flex-col pl-1 pr-2 pt-5",
            className
          )}
          style={{
            ...(!collapsed ? { width: EDITOR_OUTLINE_WIDTH } : {}),
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
          }}
          aria-label={t("editor.outline")}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="group absolute right-0 top-5 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200/80 bg-white/90 text-slate-400 shadow-sm backdrop-blur transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                  onClick={() => onCollapsedChange(false)}
                  aria-expanded={false}
                  aria-label={outlineToggleLabel}
                >
                  <PanelRightOpen className="h-4 w-4 group-hover:scale-105" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{outlineToggleLabel}</TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-slate-50/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <div className="flex items-center justify-between px-3 pb-1 pt-3">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  <ListTree className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("editor.outline")}
                </span>
                <div className="flex items-center gap-0.5">
                  {collapseAllButton}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                        onClick={() => onCollapsedChange(true)}
                        aria-expanded
                        aria-label={outlineToggleLabel}
                      >
                        <PanelRightClose className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">{outlineToggleLabel}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <nav
                className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300/70 [&::-webkit-scrollbar-thumb]:hover:bg-slate-400/70"
                aria-label={t("editor.outline")}
              >
                {renderItems(tree)}
              </nav>
            </div>
          )}
        </aside>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={100}>
      <aside
        className={cn(
          "select-none",
          collapsed
            ? "sticky top-6 z-20 h-8 w-0 shrink-0 self-start overflow-visible"
            : "sticky top-6 h-fit max-h-[calc(100vh-8rem)] shrink-0 overflow-y-auto overflow-x-hidden py-2",
          className
        )}
        style={{
          ...(!collapsed ? { width: EDITOR_OUTLINE_WIDTH } : {}),
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
        }}
        aria-label={t("editor.outline")}
      >
        <div className={cn("flex", collapsed ? "absolute right-0 top-0 h-8 w-8 justify-center" : "mb-3 items-center justify-between px-1")}>
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
          {!collapsed && collapseAllButton ? (
            <div className="flex items-center">{collapseAllButton}</div>
          ) : null}
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
