import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const EDGE_TOLERANCE_PX = 12;

type ScrollToEdgeButtonsProps = {
  /** Scrollable article element. `null` follows the document/window instead. */
  scrollContainer?: HTMLElement | null;
  /** Re-measure when the article changes (memo id, share token, ...). */
  contentKey?: string;
  className?: string;
};

type ScrollMetrics = {
  scrollTop: number;
  viewport: number;
  total: number;
};

const readScrollMetrics = (element: HTMLElement | null): ScrollMetrics => {
  if (element) {
    return {
      scrollTop: element.scrollTop,
      viewport: element.clientHeight,
      total: element.scrollHeight,
    };
  }

  const scrollingElement = document.scrollingElement ?? document.documentElement;
  return {
    scrollTop: window.scrollY || scrollingElement.scrollTop,
    viewport: window.innerHeight,
    total: scrollingElement.scrollHeight,
  };
};

export const ScrollToEdgeButtons = ({
  scrollContainer = null,
  contentKey,
  className,
}: ScrollToEdgeButtonsProps) => {
  const { t } = useTranslation();
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);

  useEffect(() => {
    const element = scrollContainer;
    let frame: number | null = null;

    const measure = () => {
      frame = null;
      const { scrollTop, viewport, total } = readScrollMetrics(element);
      const scrollable = total > viewport + 1;
      const lastTop = Math.max(0, total - viewport);

      setShowTop(scrollable && scrollTop > EDGE_TOLERANCE_PX);
      setShowBottom(scrollable && scrollTop < lastTop - EDGE_TOLERANCE_PX);
    };

    const scheduleMeasure = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(element ?? document.documentElement);
    if (element) {
      for (const child of Array.from(element.children)) {
        resizeObserver?.observe(child);
      }
    }

    const scrollTarget: HTMLElement | Window = element ?? window;
    scrollTarget.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    measure();

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver?.disconnect();
      scrollTarget.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [contentKey, scrollContainer]);

  const scrollToEdge = (edge: "top" | "bottom") => {
    const element = scrollContainer;
    if (element) {
      element.scrollTo({ top: edge === "top" ? 0 : element.scrollHeight, behavior: "smooth" });
      return;
    }

    const scrollingElement = document.scrollingElement ?? document.documentElement;
    window.scrollTo({ top: edge === "top" ? 0 : scrollingElement.scrollHeight, behavior: "smooth" });
  };

  if (!showTop && !showBottom) {
    return null;
  }

  const buttonClassName =
    "flex h-8 w-8 items-center justify-center rounded-full border border-slate-200/80 bg-white/90 text-slate-500 shadow-sm backdrop-blur transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-400 dark:hover:border-emerald-500/60 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300";
  const topLabel = t("editor.scrollToTop");
  const bottomLabel = t("editor.scrollToBottom");

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={0}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        {showTop ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={buttonClassName}
                onClick={() => scrollToEdge("top")}
                aria-label={topLabel}
                data-scroll-to-edge="top"
              >
                <ArrowUpToLine className="h-4 w-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{topLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        {showBottom ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={buttonClassName}
                onClick={() => scrollToEdge("bottom")}
                aria-label={bottomLabel}
                data-scroll-to-edge="bottom"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{bottomLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </TooltipProvider>
  );
};
