import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import type { ImagePreviewGroup } from "@/lib/image-preview-group";

type ImageViewerProps = {
  closeLabel: string;
  open: ImagePreviewGroup | null;
  viewerLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  previousLabel: string;
  nextLabel: string;
  onClose: () => void;
};

export const ImageViewer = ({
  closeLabel,
  open,
  viewerLabel,
  zoomInLabel,
  zoomOutLabel,
  previousLabel,
  nextLabel,
  onClose,
}: ImageViewerProps) => {
  if (!open || open.slides.length === 0) return null;

  const hasMultipleSlides = open.slides.length > 1;

  return (
    <Lightbox
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
      toolbar={{ buttons: ["zoom", "close"] }}
      carousel={{ finite: true, padding: 24, imageFit: "contain" }}
      controller={{
        closeOnBackdropClick: true,
        closeOnPullDown: false,
        closeOnPullUp: false,
        disableSwipeNavigation: !hasMultipleSlides,
      }}
      zoom={{
        maxZoomPixelRatio: 6,
        zoomInMultiplier: 1.5,
        keyboardMoveDistance: 80,
        pinchZoomV4: true,
        scrollToZoom: true,
      }}
      animation={{ fade: 160, zoom: 180 }}
      render={{
        buttonPrev: hasMultipleSlides ? undefined : () => null,
        buttonNext: hasMultipleSlides ? undefined : () => null,
      }}
    />
  );
};
