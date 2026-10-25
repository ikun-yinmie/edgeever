export type ContextMenuPoint = { x: number; y: number };

const DEFAULT_EDGE_MARGIN = 8;

/**
 * Frames spent re-applying the placement. Radix repositions the menu again
 * after it predicts the content size (and after a max-height change), so a
 * single correction is not enough; keep correcting until both sides settle.
 */
const ALIGN_FRAMES = 30;

const alignTokens = new WeakMap<HTMLElement, number>();

/**
 * Offset that turns Radix's placement into native context-menu placement: the
 * menu starts at the click when it fits below, otherwise its bottom edge ends
 * at the click. A menu taller than the remaining space stays on screen instead
 * of clipping above the viewport.
 */
export const resolveContextMenuOffset = (
  pointY: number,
  rectTop: number,
  rectHeight: number,
  viewportHeight: number,
  edgeMargin = DEFAULT_EDGE_MARGIN
): number => {
  if (rectHeight <= 0) {
    return 0;
  }

  const spaceBelow = viewportHeight - pointY - edgeMargin;
  const targetTop =
    rectHeight <= spaceBelow ? pointY : Math.max(edgeMargin, pointY - rectHeight);

  return targetTop - rectTop;
};

/**
 * Radix anchors a menu from its trigger and lets a flipped-up menu run past
 * the click point. Re-anchor like a native context menu instead: start at the
 * click when there is room below, otherwise end at it. When neither side fits
 * the full menu, cap it to the larger side and let it scroll, so the anchored
 * edge still lands on the click.
 *
 * The wrapper is measured rather than the content because the content carries
 * our corrective translate; the wrapper only reflects Radix's own placement,
 * which keeps the correction idempotent across frames.
 */
export const alignContextMenuToPoint = (
  element: HTMLElement | null,
  point: ContextMenuPoint | null
): void => {
  const wrapper = element?.parentElement;
  if (!element || !point || !wrapper) {
    return;
  }

  const token = (alignTokens.get(element) ?? 0) + 1;
  alignTokens.set(element, token);

  let frame = 0;

  const align = () => {
    if (alignTokens.get(element) !== token) {
      return;
    }

    // The enter animation scales and translates the content for a few frames;
    // freezing it keeps the measured box equal to the final box.
    if (element.style.animation !== "none") {
      element.style.animation = "none";
    }

    const viewportHeight = window.innerHeight;
    const available = Math.max(
      point.y - DEFAULT_EDGE_MARGIN,
      viewportHeight - point.y - DEFAULT_EDGE_MARGIN
    );
    if (element.offsetHeight > available) {
      element.style.maxHeight = `${Math.floor(available)}px`;
    }

    const height = element.offsetHeight;
    if (height > 0) {
      const wrapperTop = wrapper.getBoundingClientRect().top;
      const dy = resolveContextMenuOffset(point.y, wrapperTop, height, viewportHeight);
      element.style.transform = Math.abs(dy) > 1 ? `translateY(${Math.round(dy)}px)` : "";
    }

    frame += 1;
    if (frame < ALIGN_FRAMES) {
      requestAnimationFrame(align);
    }
  };

  requestAnimationFrame(align);
};
