import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CloudDownload, CloudUpload, ExternalLink, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { buildGitHubFeedbackUrl, type DesktopOutboxItem, type Notebook } from "@edgeever/shared";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AppConfirmDialog } from "@/components/dialogs/ConfirmDialogs";
import { getShareableWebSystemInfoItems } from "@/components/settings/SystemInfoCard";
import { api, getConfiguredDesktopApiBaseUrl } from "@/lib/api";
import {
  createDesktopSyncDiagnosticText,
  discardDesktopSyncIssue,
  getDesktopSyncIssues,
  pullEverythingFromServer,
  recoverDesktopMemoUpdate,
  retryDesktopSyncIssue,
  uploadEverythingToServer,
  type DesktopGlobalSyncIssue,
  type DesktopMaintenanceProgress,
  type DesktopUploadAllResult,
} from "@/lib/desktop-sync";
import { getClientRuntimeDiagnostics } from "@/lib/system-diagnostics";

const isRecoverableMissingMemo = (item: DesktopOutboxItem) => item.kind === "memo.update"
  && item.status === "error"
  && (item.lastErrorCode === "memo_not_found" || /memo not found/i.test(item.lastError ?? ""));

const operationLabelKey = (kind: DesktopOutboxItem["kind"]) => `notebookPane.syncDetails.operations.${kind.replaceAll(".", "_")}`;

export const DesktopSyncIssuesDialog = ({
  notebooks,
  onOpenChange,
  onSyncNow,
  open,
}: {
  notebooks: Notebook[];
  onOpenChange: (open: boolean) => void;
  onSyncNow: () => Promise<void> | void;
  open: boolean;
}) => {
  const { i18n, t } = useTranslation();
  const [items, setItems] = useState<DesktopOutboxItem[]>([]);
  const [globalIssue, setGlobalIssue] = useState<DesktopGlobalSyncIssue | null>(null);
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [workingGlobal, setWorkingGlobal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<DesktopOutboxItem | null>(null);
  const [discarding, setDiscarding] = useState<DesktopOutboxItem | null>(null);
  const [recoveryNotebookId, setRecoveryNotebookId] = useState("");
  const [maintenanceBusy, setMaintenanceBusy] = useState<"pull" | "upload" | null>(null);
  const [maintenanceProgress, setMaintenanceProgress] = useState<DesktopMaintenanceProgress | null>(null);
  const [pullConfirm, setPullConfirm] = useState(false);
  const [uploadConfirm, setUploadConfirm] = useState(false);
  const [uploadResult, setUploadResult] = useState<DesktopUploadAllResult | null>(null);
  const instanceUrl = getConfiguredDesktopApiBaseUrl();
  const healthQuery = useQuery({
    queryKey: ["instance-health", instanceUrl],
    queryFn: async () => {
      const startedAt = performance.now();
      const health = await api.getInstanceHealth();
      return { health, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
    },
    enabled: open && Boolean(instanceUrl),
    staleTime: 60 * 1000,
    retry: 1,
  });
  const clientRuntimeQuery = useQuery({
    queryKey: ["system-info-client-runtime"],
    queryFn: getClientRuntimeDiagnostics,
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const releaseQuery = useQuery({
    queryKey: ["instance-release", instanceUrl],
    queryFn: () => api.getInstanceRelease(),
    enabled: open && Boolean(instanceUrl),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const availableNotebooks = notebooks;
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "medium" }),
    [i18n.language],
  );
  const reportIssueUrl = useMemo(() => buildGitHubFeedbackUrl({
    contentHeading: t("notebookPane.syncDetails.reportContentHeading"),
    contentPrompt: t("notebookPane.syncDetails.reportContentPrompt"),
    diagnostics: {
      heading: t("notebookPane.syncDetails.reportDiagnosticsHeading"),
      notice: t("notebookPane.syncDetails.reportDiagnosticsNotice"),
      text: createDesktopSyncDiagnosticText(items, globalIssue),
    },
    privacyNotice: t("feedback.privacyNotice"),
    systemInfo: getShareableWebSystemInfoItems(t, i18n.language, {
      clientRuntime: clientRuntimeQuery.data,
      instance: healthQuery.data?.health,
      instanceVersion: releaseQuery.data?.version,
    }),
    systemInfoHeading: t("feedback.systemInfoHeading"),
    systemInfoNotice: t("feedback.systemInfoNotice"),
    titlePrefix: t("notebookPane.syncDetails.reportTitlePrefix"),
  }), [clientRuntimeQuery.data, globalIssue, healthQuery.data, i18n.language, items, releaseQuery.data, t]);
  const collectingSystemInfo = clientRuntimeQuery.isFetching || healthQuery.isFetching || releaseQuery.isFetching;
  const canReportIssue = (items.length > 0 || Boolean(globalIssue)) && !collectingSystemInfo;
  const formatTime = (value: string | null | undefined) => {
    if (!value) return null;
    const time = new Date(value);
    return Number.isFinite(time.getTime()) ? dateTimeFormatter.format(time) : null;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const details = await getDesktopSyncIssues();
      setItems(details.items);
      setGlobalIssue(details.globalIssue);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const runAction = async (item: DesktopOutboxItem, action: () => Promise<unknown>) => {
    setWorkingId(item.id);
    setError(null);
    try {
      await action();
      await onSyncNow();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setWorkingId(null);
    }
  };

  const confirmRecovery = () => {
    if (!recovering || !recoveryNotebookId) return;
    const item = recovering;
    setRecovering(null);
    void runAction(item, () => recoverDesktopMemoUpdate(item, recoveryNotebookId));
  };

  const confirmDiscard = () => {
    if (!discarding) return;
    const item = discarding;
    setDiscarding(null);
    void runAction(item, () => discardDesktopSyncIssue(item));
  };

  const retryGlobalIssue = async () => {
    setWorkingGlobal(true);
    setError(null);
    try {
      await onSyncNow();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setWorkingGlobal(false);
    }
  };

  const runPullEverything = async () => {
    setMaintenanceBusy("pull");
    setError(null);
    try {
      await pullEverythingFromServer();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setMaintenanceBusy(null);
    }
  };

  const runUploadEverything = async () => {
    setMaintenanceBusy("upload");
    setMaintenanceProgress(null);
    setUploadResult(null);
    setError(null);
    try {
      const result = await uploadEverythingToServer(setMaintenanceProgress);
      setUploadResult(result);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setMaintenanceBusy(null);
      setMaintenanceProgress(null);
    }
  };

  return (
    <>
      <Dialog open={open && !recovering && !discarding && !pullConfirm && !uploadConfirm} onOpenChange={(nextOpen) => { if (workingId === null && !workingGlobal && maintenanceBusy === null) onOpenChange(nextOpen); }}>
        <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("notebookPane.syncDetails.title")}</DialogTitle>
            <DialogDescription>{t("notebookPane.syncDetails.description")}</DialogDescription>
          </DialogHeader>

          {error ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p> : null}
          {loading ? <p className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</p> : null}
          {!loading && items.length === 0 && !globalIssue ? <p className="py-8 text-center text-sm text-slate-500">{t("notebookPane.syncDetails.empty")}</p> : null}

          <div className="space-y-3">
            {globalIssue ? (
              <section className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">{t("notebookPane.syncDetails.globalFailure")}</p>
                    <p className="mt-1 break-words text-sm text-amber-900">{globalIssue.message || t("notebookPane.syncDetails.unknownError")}</p>
                    <p className="mt-1 text-xs text-slate-500">{t("notebookPane.syncDetails.errorCode", { code: globalIssue.errorCode ?? globalIssue.phase })}</p>
                    {formatTime(globalIssue.occurredAt) ? <p className="mt-1 text-xs text-slate-500">{t("notebookPane.syncDetails.lastAttempt", { time: formatTime(globalIssue.occurredAt) })}</p> : null}
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button size="sm" variant="outline" disabled={workingGlobal} onClick={() => void retryGlobalIssue()}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {t("notebookPane.syncDetails.retry")}
                  </Button>
                </div>
              </section>
            ) : null}
            {items.map((item) => {
              const recoverable = isRecoverableMissingMemo(item);
              const working = workingId === item.id;
              const lastAttemptAt = formatTime(item.updatedAt);
              const nextAttemptAt = item.retryable ? formatTime(item.nextAttemptAt) : null;
              return (
                <section key={item.id} className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-slate-900">{t(operationLabelKey(item.kind), { defaultValue: item.kind })}</span>
                        <span className="text-xs text-slate-500">{t("notebookPane.syncDetails.attempts", { count: item.attemptCount })}</span>
                      </div>
                      <p className="mt-1 break-words text-sm text-amber-900">{item.lastError || t("notebookPane.syncDetails.unknownError")}</p>
                      {item.lastErrorCode ? <p className="mt-1 text-xs text-slate-500">{t("notebookPane.syncDetails.errorCode", { code: item.lastErrorCode })}</p> : null}
                      {lastAttemptAt ? <p className="mt-1 text-xs text-slate-500">{t("notebookPane.syncDetails.lastAttempt", { time: lastAttemptAt })}</p> : null}
                      {nextAttemptAt ? <p className="mt-1 text-xs text-slate-500">{t("notebookPane.syncDetails.nextRetry", { time: nextAttemptAt })}</p> : null}
                      {recoverable ? <p className="mt-2 text-xs leading-5 text-slate-600">{t("notebookPane.syncDetails.missingMemoHint")}</p> : null}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {recoverable && (
                      <Button size="sm" variant="outline" disabled={working || availableNotebooks.length === 0} onClick={() => {
                        setRecoveryNotebookId(availableNotebooks[0]?.id ?? "");
                        setRecovering(item);
                      }}>
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        {t("notebookPane.syncDetails.recover")}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={working} onClick={() => void runAction(item, () => retryDesktopSyncIssue(item))}>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      {t("notebookPane.syncDetails.retry")}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-rose-700 hover:bg-rose-50 hover:text-rose-800" disabled={working} onClick={() => setDiscarding(item)}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      {t("notebookPane.syncDetails.discard")}
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>

          <section className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-900">{t("notebookPane.syncDetails.maintenanceTitle")}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{t("notebookPane.syncDetails.maintenanceHint")}</p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" disabled={maintenanceBusy !== null} onClick={() => setPullConfirm(true)}>
                <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
                {t("notebookPane.syncDetails.pullAll")}
              </Button>
              <Button size="sm" variant="outline" disabled={maintenanceBusy !== null} onClick={() => setUploadConfirm(true)}>
                <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                {t("notebookPane.syncDetails.uploadAll")}
              </Button>
            </div>
            {maintenanceBusy ? (
              <p className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-500">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {maintenanceBusy === "upload" && maintenanceProgress
                  ? t("notebookPane.syncDetails.maintenanceProgress", { done: maintenanceProgress.done, total: maintenanceProgress.total })
                  : t("notebookPane.syncDetails.maintenanceRunning")}
              </p>
            ) : null}
            {uploadResult ? (
              <p className="mt-3 text-right text-xs text-slate-500">
                {t("notebookPane.syncDetails.uploadAllResult", { uploaded: uploadResult.uploaded, skipped: uploadResult.skipped, failed: uploadResult.failed })}
              </p>
            ) : null}
          </section>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" disabled={!canReportIssue} asChild={canReportIssue}>
              {canReportIssue ? (
                <a href={reportIssueUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  {t("notebookPane.syncDetails.reportIssue")}
                </a>
              ) : (
                <span>
                  {collectingSystemInfo
                    ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
                    : <ExternalLink className="mr-1.5 h-4 w-4" />}
                  {t("notebookPane.syncDetails.reportIssue")}
                </span>
              )}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {recovering && (
        <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) setRecovering(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("notebookPane.syncDetails.recoverTitle")}</DialogTitle>
              <DialogDescription>{t("notebookPane.syncDetails.recoverDescription")}</DialogDescription>
            </DialogHeader>
            <Select value={recoveryNotebookId} onValueChange={setRecoveryNotebookId}>
              <SelectTrigger aria-label={t("notebookPane.syncDetails.recoveryNotebook")}>
                <SelectValue placeholder={t("notebookPane.syncDetails.recoveryNotebook")} />
              </SelectTrigger>
              <SelectContent>
                {availableNotebooks.map((notebook) => <SelectItem key={notebook.id} value={notebook.id}>{notebook.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRecovering(null)}>{t("common.cancel")}</Button>
              <Button disabled={!recoveryNotebookId} onClick={confirmRecovery}>{t("notebookPane.syncDetails.recover")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {discarding && (
        <AppConfirmDialog
          title={t("notebookPane.syncDetails.discardTitle")}
          description={t("notebookPane.syncDetails.discardDescription")}
          confirmLabel={t("notebookPane.syncDetails.discard")}
          onCancel={() => setDiscarding(null)}
          onConfirm={confirmDiscard}
        />
      )}

      {pullConfirm && (
        <AppConfirmDialog
          title={t("notebookPane.syncDetails.pullAllTitle")}
          description={t("notebookPane.syncDetails.pullAllDescription")}
          confirmLabel={t("notebookPane.syncDetails.pullAll")}
          onCancel={() => setPullConfirm(false)}
          onConfirm={() => {
            setPullConfirm(false);
            void runPullEverything();
          }}
        />
      )}

      {uploadConfirm && (
        <AppConfirmDialog
          title={t("notebookPane.syncDetails.uploadAllTitle")}
          description={t("notebookPane.syncDetails.uploadAllDescription")}
          confirmLabel={t("notebookPane.syncDetails.uploadAll")}
          onCancel={() => setUploadConfirm(false)}
          onConfirm={() => {
            setUploadConfirm(false);
            void runUploadEverything();
          }}
        />
      )}
    </>
  );
};
