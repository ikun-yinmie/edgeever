import { useEffect, useMemo, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, CircleAlert, Code2, Copy, Ellipsis, ListOrdered, Maximize2, WrapText } from "lucide-react";
import { MERMAID_THEME_PALETTES, useMermaidTheme } from "./ThemeProvider";
import { MermaidViewer } from "./MermaidViewer";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CODE_BLOCK_LANGUAGES } from "@/lib/code-block";
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

type LanguagePickerProps = {
  language: string;
  onPick: (language: string) => void;
  label: string;
};

/** The header language badge doubles as the type switcher while editing. */
const LanguagePicker = ({ language, onPick, label }: LanguagePickerProps) => {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="edgeever-code-lang edgeever-code-lang-picker"
              aria-label={label}
              aria-haspopup="menu"
              onMouseDown={(event) => event.preventDefault()}
            >
              {language}
              <ChevronDown className="edgeever-code-lang-caret" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="max-h-72 min-w-36 overflow-y-auto">
        {CODE_BLOCK_LANGUAGES.map((option) => (
          <DropdownMenuItem
            key={option.value}
            className={language === option.value ? "bg-emerald-50 text-emerald-800" : undefined}
            onSelect={() => onPick(option.value)}
          >
            {option.value === "plaintext" ? t("editorToolbar.plainText") : option.label}
            {language === option.value && <span className="ml-auto" aria-hidden="true">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const MermaidCodeBlock = ({ editor, node, updateAttributes }: NodeViewProps) => {
  const { t } = useTranslation();
  const { mermaidTheme } = useMermaidTheme();
  const language = typeof node.attrs.language === "string" ? node.attrs.language.toLowerCase() : "plaintext";
  const source = node.textContent.trim();
  const isMermaid = language === "mermaid";
  const meta = (node.attrs.meta ?? {}) as {
    title?: string;
    width?: string;
    collapsed?: boolean;
    lineNumbers?: boolean;
    wrap?: boolean;
  };
  const blockTitle = typeof meta.title === "string" ? meta.title : "";
  const isWide = meta.width === "wide";
  const isCollapsed = meta.collapsed === true;
  // Defaults match Yuque: line numbers on, wrapping off.
  const showLineNumbers = meta.lineNumbers !== false;
  const wrapLines = meta.wrap === true;
  const lineCount = useMemo(() => node.childCount > 0 ? node.textContent.split("\n").length : 1, [node]);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1),
    [lineCount],
  );
  const canEdit = editor.isEditable;
  // In read mode the collapse toggle uses view-local state and never edits the document.
  const [viewCollapsed, setViewCollapsed] = useState(false);
  const collapsed = canEdit ? isCollapsed : viewCollapsed;
  const [svg, setSvg] = useState("");
  const [sourceVisible, setSourceVisible] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [renderState, setRenderState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [syncToast, setSyncToast] = useState<string | null>(null);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (!syncToast) return;
    const timer = window.setTimeout(() => setSyncToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [syncToast]);

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
        !isMermaid && showLineNumbers && !collapsed ? "edgeever-code-block-numbered" : "",
        !isMermaid && wrapLines && !collapsed ? "edgeever-code-block-wrap" : "",
      ].filter(Boolean).join(" ")}
      data-language={language}
    >
      {showHeader && (
        <div className="edgeever-code-header" contentEditable={false}>
          {canEdit ? (
            <LanguagePicker
              language={language}
              onPick={(value) => updateAttributes({ language: value })}
              label={t("editorToolbar.codeLanguage")}
            />
          ) : (
            <span className="edgeever-code-lang" aria-hidden="true">{language}</span>
          )}
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
            {canEdit && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="edgeever-code-tool-button"
                        aria-label={t("editorToolbar.codeMoreActions")}
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <Ellipsis aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("editorToolbar.codeMoreActions")}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuCheckboxItem
                    checked={showLineNumbers}
                    onSelect={(event) => {
                      event.preventDefault();
                      updateAttributes({ meta: { ...meta, lineNumbers: !showLineNumbers } });
                    }}
                  >
                    <ListOrdered className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("editorToolbar.codeLineNumbers")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={wrapLines}
                    onSelect={(event) => {
                      event.preventDefault();
                      updateAttributes({ meta: { ...meta, wrap: !wrapLines } });
                    }}
                  >
                    <WrapText className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("editorToolbar.codeWrapLines")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      updateAttributes({ meta: { lineNumbers: showLineNumbers, wrap: wrapLines } });
                      setSyncToast(t("editorToolbar.codeSyncDone"));
                    }}
                  >
                    {t("editorToolbar.codeSyncStyleAll")}
                    <span className="ml-auto text-xs text-slate-400">⌘⇧S</span>
                    <span className="sr-only">meta only</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      const target = { ...meta };
                      const languageValue = typeof node.attrs.language === "string" ? node.attrs.language : "plaintext";
                      const chain = editor.chain().focus();
                      editor.state.doc.descendants((descNode, pos) => {
                        if (descNode.type.name !== "codeBlock") return true;
                        chain.setNodeSelection(pos).updateAttributes("codeBlock", {
                          language: languageValue,
                          meta: { ...target, collapsed: false },
                        });
                        return false;
                      });
                      chain.run();
                      setSyncToast(t("editorToolbar.codeSyncDone"));
                    }}
                  >
                    {t("editorToolbar.codeSyncStyleAndLanguageAll")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
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
      {!collapsed && !isMermaid && showLineNumbers && (
        <div className="edgeever-code-gutter" contentEditable={false} aria-hidden="true">
          {lineNumbers.map((value) => (
            <span key={value}>{value}</span>
          ))}
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
      {syncToast && (
        <div
          className="edgeever-code-sync-toast"
          role="status"
        >
          {syncToast}
        </div>
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
