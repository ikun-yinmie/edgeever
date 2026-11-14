import { decodeCodeMetaJson } from "@edgeever/shared";
import hljs from "highlight.js/lib/common";
import { renderMermaidSVG, THEMES } from "beautiful-mermaid";
import { MERMAID_THEME_PALETTES } from "@/components/ThemeProvider";
import { buildNoteHtmlOutline, NOTE_HTML_OUTLINE_SCRIPT, type NoteHtmlOutlineLabels } from "./note-html-outline";
import { buildHtmlCodePreviewDocument, getCodeBlockPreviewLanguage } from "./code-block-preview";
import { renderMarkdownCodePreview } from "./markdown-code-preview";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const EXPORT_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export type NoteHtmlExportMeta = {
  title: string;
  notebook?: string;
  tags?: string[];
  updatedAt?: string;
  language?: string;
};

export type NoteHtmlInteractionLabels = {
  copy: string;
  copied: string;
  copyFailed: string;
  preview: string;
  source: string;
  close: string;
  viewer: string;
  zoomIn: string;
  zoomOut: string;
  resetZoom: string;
  previous: string;
  next: string;
};

const DEFAULT_INTERACTION_LABELS: NoteHtmlInteractionLabels = {
  copy: "Copy code", copied: "Copied", copyFailed: "Copy failed",
  preview: "Preview", source: "Show source", close: "Close",
  viewer: "Image viewer", zoomIn: "Zoom in", zoomOut: "Zoom out",
  resetZoom: "Reset zoom", previous: "Previous image", next: "Next image",
};

export type BuildStandaloneHtmlDocumentOptions = NoteHtmlExportMeta & {
  interactionScript?: string;
  interactionLabels?: NoteHtmlInteractionLabels;
  bodyHtml: string;
  styles?: string;
  includeOutline?: boolean;
  outlineLabel?: string;
  outlineLabels?: NoteHtmlOutlineLabels;
};

export type DownloadNoteHtmlOptions = NoteHtmlExportMeta & {
  interactionScript?: string;
  interactionLabels?: NoteHtmlInteractionLabels;
  bodyHtml: string;
  fallbackTitle: string;
  styles?: string;
  includeOutline?: boolean;
  outlineLabel?: string;
  outlineLabels?: NoteHtmlOutlineLabels;
};

export type HtmlImageEmbedResult = {
  /** Images with a non-empty src attribute. */
  total: number;
  /** Already data: URLs plus successfully fetched/inlined images. */
  embedded: number;
  /** Images that could not be inlined and may break offline. */
  failed: number;
};

export type PreparedNoteHtmlExport = {
  bodyHtml: string;
  images: HtmlImageEmbedResult;
};

export type DownloadNoteHtmlResult = {
  filename: string;
  images: HtmlImageEmbedResult;
};

export const createEmptyHtmlImageEmbedResult = (): HtmlImageEmbedResult => ({
  total: 0,
  embedded: 0,
  failed: 0,
});

/** Decide whether the UI should warn about image embedding after a successful download. */
export const getHtmlImageEmbedNoticeKind = (
  images: HtmlImageEmbedResult,
): "none" | "partial" | "failed-all" => {
  if (images.total === 0 || images.failed === 0) {
    return "none";
  }
  if (images.embedded === 0) {
    return "failed-all";
  }
  return "partial";
};

export const buildHtmlFilename = (title: string, fallback: string) => {
  const sanitized = title
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  const basename = sanitized || fallback;
  const safeBasename = WINDOWS_RESERVED_NAME.test(basename) ? `_${basename}` : basename;
  return /\.html?$/i.test(safeBasename) ? safeBasename.replace(/\.htm$/i, ".html") : `${safeBasename}.html`;
};

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const buildNoteHtmlContentMarkup = ({
  title,
  notebook = "",
  tags = [],
  updatedAt = "",
  bodyHtml,
  outlineHtml = "",
}: Pick<BuildStandaloneHtmlDocumentOptions, "title" | "notebook" | "tags" | "updatedAt" | "bodyHtml"> & { outlineHtml?: string }) => {
  const metadataParts = [notebook, updatedAt, ...tags.map((tag) => `#${tag}`)].filter(Boolean);
  const metaHtml = metadataParts.length > 0
    ? `<div class="edgeever-html-meta">${escapeHtml(metadataParts.join(" · "))}</div>`
    : "";

  return `<div class="edgeever-html-shell${outlineHtml ? " edgeever-html-shell-with-outline" : ""}">
<article class="edgeever-html-document">
<h1 class="edgeever-html-title">${escapeHtml(title)}</h1>
${metaHtml}
<div class="edgeever-html-content">
${bodyHtml}
</div>
</article>
${outlineHtml}
</div>`;
};

export const buildStandaloneHtmlDocument = ({
  title,
  notebook = "",
  tags = [],
  updatedAt = "",
  language = "en",
  bodyHtml,
  styles = "",
  includeOutline = false,
  outlineLabel = "Outline",
  outlineLabels,
  interactionScript = "",
  interactionLabels = DEFAULT_INTERACTION_LABELS,
}: BuildStandaloneHtmlDocumentOptions) => {
  const outlined = includeOutline ? buildNoteHtmlOutline(bodyHtml, outlineLabel, outlineLabels) : { bodyHtml, outlineHtml: "" };
  const contentMarkup = buildNoteHtmlContentMarkup({ title, notebook, tags, updatedAt, ...outlined });

  return `<!DOCTYPE html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="EdgeEver" />
<title>${escapeHtml(title)}</title>
<style>
${styles}
</style>
</head>
<body${interactionScript ? ` data-edgeever-export-labels="${escapeHtml(JSON.stringify(interactionLabels))}"` : ""}>
${contentMarkup}
${outlined.outlineHtml ? `<script>${NOTE_HTML_OUTLINE_SCRIPT}</script>` : ""}
${interactionScript ? `<script>${interactionScript.replace(/<\/script/gi, "<\\/script")}</script>` : ""}
</body>
</html>
`;
};

export const createHtmlFile = (html: string, title: string, fallback: string) => ({
  blob: new Blob([html], { type: "text/html;charset=utf-8" }),
  filename: buildHtmlFilename(title, fallback),
});

export const downloadHtmlFile = (html: string, title: string, fallback: string) => {
  const { blob, filename } = createHtmlFile(html, title, fallback);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to encode resource as data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read resource blob"));
    reader.readAsDataURL(blob);
  });

const resolveResourceUrl = (src: string) => {
  try {
    return new URL(src, window.location.href).href;
  } catch {
    return src;
  }
};

/** Turn serialized code-block metadata into a visible caption, before Mermaid replaces the pre. */
export const renderCodeBlockTitlesForHtmlExport = (root: HTMLElement) => {
  root.querySelectorAll<HTMLElement>("pre[data-edgeever-code-meta]").forEach((pre) => {
    const meta = decodeCodeMetaJson(pre.getAttribute("data-edgeever-code-meta") ?? "");
    if (!meta?.title.trim() || pre.parentElement?.classList.contains("edgeever-html-code-block")) return;

    const figure = document.createElement("figure");
    figure.className = "edgeever-html-code-block";
    const caption = document.createElement("figcaption");
    caption.className = "edgeever-html-code-title";
    // Titles are user text, not HTML (including titles that look like tags).
    caption.textContent = meta.title;
    pre.replaceWith(figure);
    figure.appendChild(caption);
    figure.appendChild(pre);
  });
};

export const renderMermaidBlocksForHtmlExport = async (root: HTMLElement, interactive = false) => {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre > code.language-mermaid"));
  await Promise.all(blocks.map(async (code) => {
    const source = code.textContent?.trim();
    const container = code.closest("pre");
    if (!source || !container) {
      return;
    }

    try {
      const svg = renderMermaidSVG(source, {
        ...THEMES["zinc-light"],
        ...MERMAID_THEME_PALETTES["zinc-light"],
        transparent: true,
        font: EXPORT_FONT_FAMILY,
        padding: 24,
      });
      const figure = document.createElement("figure");
      figure.className = "edgeever-html-mermaid";
      figure.innerHTML = svg;
      if (interactive) {
        figure.classList.add("edgeever-html-code-preview");
        figure.hidden = true;
        container.insertAdjacentElement("afterend", figure);
      } else {
        container.replaceWith(figure);
      }
    } catch {
      // Keep invalid Mermaid source readable in the exported document.
    }
  }));
};

export const highlightCodeBlocksForHtmlExport = (root: HTMLElement) => {
  root.querySelectorAll<HTMLElement>("pre > code:not(.language-mermaid)").forEach((code) => {
    try {
      hljs.highlightElement(code);
    } catch {
      // Leave unhighlighted source readable when language detection fails.
    }
  });
};

export const embedImagesForHtmlExport = async (root: HTMLElement): Promise<HtmlImageEmbedResult> => {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"));
  const result = createEmptyHtmlImageEmbedResult();

  await Promise.all(images.map(async (image) => {
    const src = image.getAttribute("src")?.trim();
    if (!src) {
      return;
    }

    result.total += 1;

    if (src.startsWith("data:")) {
      result.embedded += 1;
      return;
    }

    try {
      const response = await fetch(src.startsWith("blob:") ? src : resolveResourceUrl(src), {
        credentials: src.startsWith("blob:") ? "omit" : "include",
      });
      if (!response.ok) {
        result.failed += 1;
        return;
      }
      image.setAttribute("src", await blobToDataUrl(await response.blob()));
      result.embedded += 1;
    } catch {
      // Leave the original URL so partial exports still open, but report the miss.
      result.failed += 1;
    }
  }));

  return result;
};

const prepareInteractiveCodeBlocks = (root: HTMLElement) => {
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const pre = code.parentElement!;
    let block = pre.parentElement!;
    if (!block.classList.contains("edgeever-html-code-block")) {
      block = document.createElement("figure");
      block.className = "edgeever-html-code-block";
      pre.replaceWith(block);
      block.appendChild(pre);
    }
    block.setAttribute("data-edgeever-code-interactive", "");
    if (block.querySelector(":scope > .edgeever-html-code-preview")) return;
    const language = Array.from(code.classList).find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    block.setAttribute("data-code-language", language);
    const previewLanguage = getCodeBlockPreviewLanguage(language);
    if (!previewLanguage) return;
    const source = code.textContent ?? "";
    const preview = document.createElement("div");
    preview.className = "edgeever-html-code-preview";
    preview.hidden = true;
    if (previewLanguage === "html") {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("title", "HTML preview");
      frame.srcdoc = buildHtmlCodePreviewDocument(source);
      preview.appendChild(frame);
    } else {
      preview.innerHTML = renderMarkdownCodePreview(source);
    }
    block.appendChild(preview);
  });
};

/** Enrich note body HTML for a self-contained offline file. */
export const prepareNoteBodyHtmlForExport = async (bodyHtml: string, interactive = false): Promise<PreparedNoteHtmlExport> => {
  const container = document.createElement("div");
  container.innerHTML = bodyHtml;
  renderCodeBlockTitlesForHtmlExport(container);
  if (interactive) prepareInteractiveCodeBlocks(container);
  await renderMermaidBlocksForHtmlExport(container, interactive);
  highlightCodeBlocksForHtmlExport(container);
  const images = await embedImagesForHtmlExport(container);
  return {
    bodyHtml: container.innerHTML,
    images,
  };
};

export const downloadNoteHtmlFile = async ({
  bodyHtml,
  title,
  notebook,
  tags,
  updatedAt,
  language,
  fallbackTitle,
  styles = "",
  includeOutline = false,
  outlineLabel,
  outlineLabels,
  interactionScript = "",
  interactionLabels,
}: DownloadNoteHtmlOptions): Promise<DownloadNoteHtmlResult> => {
  const prepared = await prepareNoteBodyHtmlForExport(bodyHtml, Boolean(interactionScript));
  const html = buildStandaloneHtmlDocument({
    title,
    notebook,
    tags,
    updatedAt,
    language,
    bodyHtml: prepared.bodyHtml,
    styles,
    includeOutline,
    outlineLabel,
    outlineLabels,
    interactionScript,
    interactionLabels,
  });
  return {
    filename: downloadHtmlFile(html, title, fallbackTitle),
    images: prepared.images,
  };
};
