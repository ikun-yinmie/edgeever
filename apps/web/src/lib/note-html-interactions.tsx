import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { ImageViewer, type ImageViewerState } from "@/components/ImageViewer";
import { copyTextToClipboard } from "./clipboard";
import type { NoteHtmlInteractionLabels } from "./note-html-export";

const labels: NoteHtmlInteractionLabels = JSON.parse(document.body.dataset.edgeeverExportLabels!);
const content = document.querySelector<HTMLElement>(".edgeever-html-content")!;
const blocks = Array.from(content.querySelectorAll<HTMLElement>("[data-edgeever-code-interactive]")).map((block) => {
  const toolbar = document.createElement("div");
  toolbar.className = "edgeever-html-code-toolbar";
  block.insertBefore(toolbar, block.querySelector(":scope > pre"));
  return {
    toolbar,
    source: block.querySelector<HTMLElement>(":scope > pre")!,
    preview: block.querySelector<HTMLElement>(":scope > .edgeever-html-code-preview"),
    language: block.dataset.codeLanguage || "text",
  };
});

type CodeBlock = typeof blocks[number];

const CodeToolbar = ({ block }: { block: CodeBlock }) => {
  const [previewVisible, setPreviewVisible] = useState(Boolean(block.preview));
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    block.source.hidden = previewVisible;
    if (block.preview) block.preview.hidden = !previewVisible;
  }, [block, previewVisible]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return <>
    <span className="edgeever-html-code-language">{block.language}</span>
    {block.preview && <button type="button" aria-pressed={previewVisible} onClick={() => setPreviewVisible(!previewVisible)}>
      {previewVisible ? labels.source : labels.preview}
    </button>}
    <button type="button" onClick={async () => {
      const copied = await copyTextToClipboard(block.source.textContent ?? "");
      setCopyState(copied ? "copied" : "failed");
    }}><span aria-live="polite">{copyState === "idle" ? labels.copy : copyState === "copied" ? labels.copied : labels.copyFailed}</span></button>
  </>;
};

const ExportInteractions = () => {
  const [viewer, setViewer] = useState<ImageViewerState | null>(null);
  useEffect(() => {
    const images = Array.from(content.querySelectorAll<HTMLImageElement>("img[src]"));
    images.forEach((image) => {
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-haspopup", "dialog");
      image.setAttribute("aria-label", image.alt ? `${labels.viewer}: ${image.alt}` : labels.viewer);
      image.classList.add("edgeever-html-preview-image");
    });
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !images.includes(image)) return;
      event.preventDefault();
      image.focus({ preventScroll: true });
      setViewer({ index: images.indexOf(image), slides: images.map((item) => ({ src: item.src, alt: item.alt })) });
    };
    content.addEventListener("click", open);
    content.addEventListener("keydown", open);
    return () => {
      content.removeEventListener("click", open);
      content.removeEventListener("keydown", open);
    };
  }, []);

  return <>
    {blocks.map((block, index) => createPortal(<CodeToolbar block={block} />, block.toolbar, String(index)))}
    <ImageViewer
      open={viewer}
      onClose={() => setViewer(null)}
      closeLabel={labels.close}
      viewerLabel={labels.viewer}
      zoomInLabel={labels.zoomIn}
      zoomOutLabel={labels.zoomOut}
      resetZoomLabel={labels.resetZoom}
      previousLabel={labels.previous}
      nextLabel={labels.next}
    />
  </>;
};

const root = document.createElement("div");
root.className = "edgeever-html-interactions";
document.body.appendChild(root);
createRoot(root).render(<ExportInteractions />);
