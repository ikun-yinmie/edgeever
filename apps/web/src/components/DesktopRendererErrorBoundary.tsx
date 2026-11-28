import React, { type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Copy } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { copyTextToClipboard } from "@/lib/clipboard";
import { markRendererRecoveryRequired } from "@/lib/renderer-recovery";
import { reportDesktopRendererReadyAfterPaint } from "@/lib/desktop-renderer-ready";
import { formatRendererErrorReport, getRendererErrorSections } from "@/lib/renderer-error-details";

type RendererErrorDetails = {
  kind: "react-error";
  message: string;
  stack: string;
  componentStack: string;
};

type State = {
  error: RendererErrorDetails | null;
  reporting: boolean;
  diagnosticsExpanded: boolean;
  copyStatus: "idle" | "copied" | "error";
};

const isChineseInterface = () => navigator.language.toLowerCase().startsWith("zh");

export class DesktopRendererErrorBoundary extends React.Component<{ children: ReactNode }, State> {
  state: State = { error: null, reporting: false, diagnosticsExpanded: false, copyStatus: "idle" };

  static getDerivedStateFromError(error: unknown): Pick<State, "error"> {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      error: {
        kind: "react-error",
        message: normalized.message,
        stack: normalized.stack ?? "",
        componentStack: "",
      },
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    markRendererRecoveryRequired();
    const details: RendererErrorDetails = {
      kind: "react-error",
      message: error.message,
      stack: error.stack ?? "",
      componentStack: info.componentStack ?? "",
    };
    this.setState({ error: details });
    console.error("Caught React renderer error", error, info.componentStack);
    void window.edgeeverDesktop?.recordRendererError(details).catch(() => undefined);
    reportDesktopRendererReadyAfterPaint();
  }

  private report = async () => {
    const { error } = this.state;
    if (!error || !window.edgeeverDesktop) return;
    this.setState({ reporting: true });
    try {
      await window.edgeeverDesktop.openRendererIssue(error);
    } finally {
      this.setState({ reporting: false });
    }
  };

  private copyDiagnostics = async () => {
    const { error } = this.state;
    if (!error) return;

    try {
      const sections = getRendererErrorSections(error, isChineseInterface());
      const copied = await copyTextToClipboard(formatRendererErrorReport(sections));
      this.setState({ copyStatus: copied ? "copied" : "error" });
    } catch {
      this.setState({ copyStatus: "error" });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const zh = isChineseInterface();
    const desktop = Boolean(window.edgeeverDesktop?.isAvailable);

    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-slate-900 sm:p-8">
        <section className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5" role="alert">
          <div className="h-1 bg-rose-500" aria-hidden="true" />
          <div className="p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-700">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase text-slate-500">EdgeEver</p>
                <h1 className="mt-1 text-lg font-semibold leading-6 text-slate-900">
                  {zh ? "页面暂时遇到问题" : "This page ran into a problem"}
                </h1>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-600">
              {desktop
                ? (zh
                    ? "问题已记录到这台设备。安全重新加载会进入恢复模式，不会自动打开刚才的笔记。"
                    : "The problem was recorded on this device. A safe reload starts in recovery mode without reopening the previous note.")
                : (zh
                    ? "可以安全重新加载页面。如果问题仍然出现，请展开诊断信息并在反馈时一并提供。"
                    : "You can safely reload the page. If the problem persists, expand the diagnostics and include them with your feedback.")}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                type="button"
                onClick={() => window.location.reload()}
              >
                {zh ? "安全重新加载" : "Reload safely"}
              </button>
              {desktop ? (
                <button
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                  type="button"
                  disabled={this.state.reporting}
                  onClick={() => void this.report()}
                >
                  {this.state.reporting
                    ? (zh ? "正在打开…" : "Opening…")
                    : (zh ? "报告到 GitHub" : "Report to GitHub")}
                </button>
              ) : null}
            </div>

            <div className="mt-6 border-t border-slate-200 pt-4">
              <Collapsible
                open={this.state.diagnosticsExpanded}
                onOpenChange={(diagnosticsExpanded) => this.setState({ diagnosticsExpanded, copyStatus: "idle" })}
              >
                <CollapsibleTrigger asChild>
                  <button
                    className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md text-left text-sm font-medium text-slate-700 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                    type="button"
                  >
                    <span>{zh ? "诊断信息" : "Diagnostic details"}</span>
                    <span className="flex items-center gap-2 text-xs font-normal text-slate-500">
                      {zh ? (this.state.diagnosticsExpanded ? "收起" : "展开查看") : (this.state.diagnosticsExpanded ? "Hide" : "Show")}
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${this.state.diagnosticsExpanded ? "rotate-180" : "rotate-0"}`}
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-3 space-y-4">
                    {getRendererErrorSections(this.state.error, zh).map((section) => (
                      <div key={section.label}>
                        <h2 className="mb-1 text-xs font-semibold text-slate-600">{section.label}</h2>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-700 select-text">
                          {section.value}
                        </pre>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <button
                        className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                        type="button"
                        onClick={() => void this.copyDiagnostics()}
                      >
                        {this.state.copyStatus === "copied"
                          ? <Check className="h-4 w-4" aria-hidden="true" />
                          : <Copy className="h-4 w-4" aria-hidden="true" />}
                        {this.state.copyStatus === "copied"
                          ? (zh ? "已复制" : "Copied")
                          : (zh ? "复制诊断信息" : "Copy diagnostics")}
                      </button>
                      <span className="text-xs text-slate-500" role="status" aria-live="polite">
                        {this.state.copyStatus === "error"
                          ? (zh ? "复制失败，请选择并复制上方内容。" : "Copy failed. Select and copy the details above.")
                          : this.state.copyStatus === "copied"
                            ? (zh ? "诊断信息已复制到剪贴板。" : "Diagnostics copied to the clipboard.")
                            : null}
                      </span>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        </section>
      </main>
    );
  }
}
