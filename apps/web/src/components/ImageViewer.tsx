import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import Lightbox, { type ZoomRef } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ImagePreviewGroup, ImagePreviewSlide } from "@/lib/image-preview-group";

export type ImageViewerSlide = ImagePreviewSlide;
export type ImageViewerState = ImagePreviewGroup;

interface ImageViewerProps {
  closeLabel: string;
  open: ImageViewerState | null;
  resetZoomLabel: string;
  viewerLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  previousLabel: string;
  nextLabel: string;
  onClose: () => void;
}

export const ImageViewer = ({
  closeLabel,
  open,
  resetZoomLabel,
  viewerLabel,
  zoomInLabel,
  zoomOutLabel,
  previousLabel,
  nextLabel,
  onClose,
}: ImageViewerProps) => {
  const zoomRef = useRef<ZoomRef | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) setZoom(1);
  }, [open]);

  if (!open || open.slides.length === 0) return null;

  const hasMultipleSlides = open.slides.length > 1;
  const resetButton = (
    <TooltipProvider key="reset-image-zoom" delayDuration={0} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="edgeever-image-viewer-reset"
            disabled={zoom <= 1}
            aria-label={resetZoomLabel}
            onClick={() => zoomRef.current?.changeZoom(1)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{resetZoomLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <Lightbox
      className="edgeever-image-viewer"
      open
      close={onClose}
      index={Math.min(open.index, open.slides.length - 1)}
      slides={open.slides.map((slide) => ({
        src: slide.src,
        alt: slide.alt ?? viewerLabel,
        imageFit: "contain",
      }))}
      plugins={[Zoom]}
      labels={{
        Close: closeLabel,
        "Photo gallery": viewerLabel,
        "Zoom in": zoomInLabel,
        "Zoom out": zoomOutLabel,
        Previous: previousLabel,
        Next: nextLabel,
      }}
      toolbar={{ buttons: ["zoom", resetButton, "close"] }}
      carousel={{ finite: true, padding: 24, imageFit: "contain" }}
      controller={{
        closeOnBackdropClick: true,
        closeOnPullDown: false,
        closeOnPullUp: false,
        disableSwipeNavigation: !hasMultipleSlides,
      }}
      zoom={{
        ref: zoomRef,
        maxZoomPixelRatio: 6,
        zoomInMultiplier: 1.5,
        keyboardMoveDistance: 80,
        pinchZoomV4: true,
        scrollToZoom: true,
      }}
      animation={{ fade: 160, zoom: 180 }}
      on={{ zoom: ({ zoom: nextZoom }) => setZoom(nextZoom) }}
      render={{
        buttonPrev: hasMultipleSlides ? undefined : () => null,
        buttonNext: hasMultipleSlides ? undefined : () => null,
      }}
    />
  );
};
