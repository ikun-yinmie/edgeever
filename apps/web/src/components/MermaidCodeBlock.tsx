import { useEffect, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Check, CircleAlert, Code2, Copy, Maximize2, ChevronsLeft, ChevronsRight, ChevronDown, ChevronRight } from "lucide-react";
import { MERMAID_THEME_PALETTES, useMermaidTheme } from "./ThemeProvider";
import { MermaidViewer } from "./MermaidViewer";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/clipboard";
import { renderMermaidWithFallback } from "@/lib/mermaid-renderer";
import { getOfficialMermaidThemeVariables } from "@/lib/mermaid-theme";

type MermaidModule = typeof import("mermaid")["default"];
type BeautifulMermaidModule = typeof import("beautiful-mermaid");

let mermaidModulePromise: Promise<MermaidModule> | null = null;
let mermaidRenderSequence = 0;
let beautifulMermaidModulePromise: Promise<BeautifulMermaidModule> | null = null;

const loadMermaid = () => {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then(({ default: mermaid }) => {
      return mermaid;
    });
  }

  return mermaidModulePromise;
};

const loadBeautifulMermaid = () => {
  if (!beautifulMermaidModulePromise) {
    beautifulMermaidModulePromise = import("beautiful-mermaid");
  }
  return beautifulMermaidModulePromise;
};

export const MermaidCodeBlock = ({ editor, node, updateAttributes }: NodeViewProps) => {
  const { t } = useTranslation();
  const { mermaidTheme } = useMermaidTheme();
  const language = typeof node.attrs.language === "string" ? node.attrs.language.toLowerCase() : "plaintext";
  const source = node.textContent.trim();
  const isMermaid = language === "mermaid";
  const meta = (node.attrs.meta ?? {}) as { title?: string; width?: string; collapsed?: boolean };
  const blockTitle = typeof meta.title === "string" ? meta.title : "";
  const isWide = meta.width === "wide";
  const isCollapsed = meta.collapsed === true;
  const canEdit = editor.isEditable;
  // In read mode the collapse toggle uses view-local state and never edits the document.
  const [viewCollapsed, setViewCollapsed] = useState(false);
  const collapsed = canEdit ? isCollapsed : viewCollapsed;
  const [svg, setSvg] = useState("");
  const [sourceVisible, setSourceVisible] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [renderState, setRenderState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const handleCopy = async () => {
    const copied = await copyTextToClipboard(node.textContent);
    setCopyState(copied ? "copied" : "error");
  };

  useEffect(() => {
    if (!isMermaid || !source || collapsed) {
      setSvg("");
      setRenderState("idle");
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setRenderState("loading");
      const palette = MERMAID_THEME_PALETTES[mermaidTheme];

      const renderBeautiful = () => loadBeautifulMermaid()
        .then(({ renderMermaidSVG, THEMES }) => renderMermaidSVG(source, {
          ...THEMES[mermaidTheme],
          ...palette,
          transparent: true,
          font: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          padding: 24,
        }));
      const renderOfficial = () => loadMermaid().then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "base",
          themeVariables: getOfficialMermaidThemeVariables(palette),
        });
        const valid = await mermaid.parse(source, { suppressErrors: true });
        if (!valid) throw new Error("Invalid Mermaid diagram");

        mermaidRenderSequence += 1;
        const { svg: renderedSvg } = await mermaid.render(`edgeever-mermaid-${mermaidRenderSequence}`, source);
        return renderedSvg;
      });
      const renderPromise = renderMermaidWithFallback({
        renderBeautiful,
        renderOfficial,
      });

      void renderPromise
        .then((nextSvg) => {
          if (!cancelled) {
            setSvg(nextSvg);
            setRenderState("ready");
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSvg("");
            setRenderState("error");
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isMermaid, mermaidTheme, source, collapsed]);

  // The header always shows: language label, collapse and copy also serve read mode.
  const showHeader = true;

  return (
    <NodeViewWrapper
      className={[
        isMermaid
          ? `edgeever-mermaid-code-block${sourceVisible ? " is-source-visible" : ""}`
          : "edgeever-code-block",
        showHeader ? "edgeever-code-block-has-header" : "",
        isWide ? "edgeever-code-block-wide" : "",
        collapsed ? "edgeever-code-block-collapsed" : "",
      ].filter(Boolean).join(" ")}
      data-language={language}
    >
      {showHeader && (
        <div className="edgeever-code-header" contentEditable={false}>
          <span className="edgeever-code-lang" aria-hidden="true">{language}</span>
          {canEdit ? (
            <input
              type="text"
              className="edgeever-code-title-input"
              value={blockTitle}
              placeholder={t("editorToolbar.codeTitlePlaceholder")}
              aria-label={t("editorToolbar.codeTitle")}
              onChange={(event) => updateAttributes({ meta: { ...meta, title: event.target.value.slice(0, 300) } })}
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape") {
                  event.preventDefault();
                  (event.target as HTMLInputElement).blur();
                }
                event.stopPropagation();
              }}
            />
          ) : (
            blockTitle && <span className="edgeever-code-title-label">{blockTitle}</span>
          )}
          <div className="edgeever-code-header-actions">
            {canEdit && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="edgeever-code-tool-button"
                      aria-label={t(collapsed ? "editorToolbar.codeExpand" : "editorToolbar.codeCollapse")}
                      aria-pressed={collapsed}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (canEdit) {
                          updateAttributes({ meta: { ...meta, collapsed: !collapsed } });
                        } else {
                          setViewCollapsed((value) => !value);
                        }
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t(collapsed ? "editorToolbar.codeExpand" : "editorToolbar.codeCollapse")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="edgeever-code-tool-button"
                      aria-label={t("editorToolbar.codeToggleWidth")}
                      aria-pressed={isWide}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        updateAttributes({ meta: { ...meta, width: isWide ? "normal" : "wide" } });
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {isWide ? <ChevronsLeft aria-hidden="true" /> : <ChevronsRight aria-hidden="true" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("editorToolbar.codeToggleWidth")}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="edgeever-code-tool-button"
                  data-state={copyState}
                  aria-label={t(copyState === "copied" ? "editorToolbar.codeCopied" : copyState === "error" ? "editorToolbar.codeCopyFailed" : "editorToolbar.copyCode")}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void handleCopy();
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  {copyState === "copied"
                    ? <Check aria-hidden="true" />
                    : copyState === "error"
                      ? <CircleAlert aria-hidden="true" />
                      : <Copy aria-hidden="true" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t(copyState === "copied" ? "editorToolbar.codeCopied" : copyState === "error" ? "editorToolbar.codeCopyFailed" : "editorToolbar.copyCode")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
      {isMermaid ? (
        <TooltipProvider delayDuration={0} skipDelayDuration={0}>
          <div className="edgeever-mermaid-toolbar" contentEditable={false}>
            {canEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="edgeever-mermaid-tool-button"
                    aria-label={t(sourceVisible ? "editorToolbar.mermaidHideSource" : "editorToolbar.mermaidShowSource")}
                    aria-pressed={sourceVisible}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSourceVisible((visible) => !visible);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <Code2 aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t(sourceVisible ? "editorToolbar.mermaidHideSource" : "editorToolbar.mermaidShowSource")}
                </TooltipContent>
              </Tooltip>
            )}
            {svg && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="edgeever-mermaid-tool-button"
                    aria-label={t("editorToolbar.mermaidOpenViewer")}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setViewerOpen(true);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <Maximize2 aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("editorToolbar.mermaidOpenViewer")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      ) : null}
      {isMermaid && (
        <div
          className="edgeever-mermaid-preview"
          contentEditable={false}
          aria-label={t("editorToolbar.mermaidPreview")}
          style={{ backgroundColor: MERMAID_THEME_PALETTES[mermaidTheme].bg }}
        >
          {!source && <p className="edgeever-mermaid-message">{t("editorToolbar.mermaidEmpty")}</p>}
          {source && renderState === "loading" && !svg && (
            <p className="edgeever-mermaid-message">{t("editorToolbar.mermaidRendering")}</p>
          )}
          {renderState === "error" && (
            <p className="edgeever-mermaid-error" role="alert">
              {t("editorToolbar.mermaidInvalid")}
            </p>
          )}
          {svg && (
            <div
              className="edgeever-mermaid-svg"
              role="img"
              aria-label={t("editorToolbar.mermaidPreview")}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>
      )}
      {!collapsed && (
        <NodeViewContent
          className={isMermaid ? "edgeever-code-source edgeever-mermaid-source" : "edgeever-code-source"}
          role="textbox"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label={isMermaid ? t("editorToolbar.mermaidSource") : undefined}
          aria-multiline="true"
          aria-readonly={!editor.isEditable}
        />
      )}
      {isMermaid && svg && (
        <MermaidViewer
          closeLabel={t("editorToolbar.mermaidCloseViewer")}
          fallbackBackgroundColor={MERMAID_THEME_PALETTES[mermaidTheme].bg}
          open={viewerOpen}
          resetZoomLabel={t("editorToolbar.mermaidResetZoom")}
          svg={svg}
          viewerLabel={t("editorToolbar.mermaidViewer")}
          zoomInLabel={t("editorToolbar.mermaidZoomIn")}
          zoomOutLabel={t("editorToolbar.mermaidZoomOut")}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </NodeViewWrapper>
  );
};
