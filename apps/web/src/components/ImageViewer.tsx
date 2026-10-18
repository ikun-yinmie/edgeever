import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import Lightbox, { type ZoomRef } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface ImageViewerSlide {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
}

interface ImageViewerProps {
  closeLabel: string;
  open: ImageViewerSlide | null;
  resetZoomLabel: string;
  viewerLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  onClose: () => void;
}

export const ImageViewer = ({
  closeLabel,
  open,
  resetZoomLabel,
  viewerLabel,
  zoomInLabel,
  zoomOutLabel,
  onClose,
}: ImageViewerProps) => {
  const zoomRef = useRef<ZoomRef | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) setZoom(1);
  }, [open]);

  if (!open) return null;

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
      index={0}
      slides={[{
        src: open.src,
        alt: open.alt ?? viewerLabel,
        width: open.width,
        height: open.height,
        imageFit: "contain",
      }]}
      plugins={[Zoom]}
      labels={{
        Close: closeLabel,
        "Photo gallery": viewerLabel,
        "Zoom in": zoomInLabel,
        "Zoom out": zoomOutLabel,
      }}
      toolbar={{ buttons: ["zoom", resetButton, "close"] }}
      carousel={{ finite: true, padding: 24, imageFit: "contain" }}
      controller={{
        closeOnBackdropClick: true,
        closeOnPullDown: false,
        closeOnPullUp: false,
        disableSwipeNavigation: true,
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
        buttonPrev: () => null,
        buttonNext: () => null,
      }}
    />
  );
};
