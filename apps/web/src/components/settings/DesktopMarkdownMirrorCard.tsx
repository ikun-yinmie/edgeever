import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

type MarkdownMirrorErrorCode = DesktopMarkdownMirrorErrorCode | "unexpected";

const errorKeys: Record<DesktopMarkdownMirrorErrorCode, string> = {
  "invalid-directory": "markdownMirror.errors.invalidDirectory",
  "target-not-writable": "markdownMirror.errors.targetNotWritable",
  "sync-failed": "markdownMirror.errors.syncFailed",
};

export const DesktopMarkdownMirrorCard = () => {
  const { t } = useTranslation();
  const bridge = window.edgeeverDesktop;
  const [status, setStatus] = useState<DesktopMarkdownMirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<MarkdownMirrorErrorCode | null>(null);
  const [synced, setSynced] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge?.markdownMirrorStatus) return;
    try {
      const next = await bridge.markdownMirrorStatus();
      setStatus(next);
      if (next.lastError) setErrorCode("sync-failed");
    } catch {
      setErrorCode("unexpected");
    }
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The first sync of a large library runs in the background, so keep the card
  // in step with the main process while it is working.
  useEffect(() => {
    if (!status?.syncing) return;
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => window.clearInterval(timer);
  }, [status?.syncing, refresh]);

  if (!bridge?.markdownMirrorStatus) return null;

  const run = async (action: () => Promise<DesktopMarkdownMirrorResult | DesktopMarkdownMirrorStatus>) => {
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await action();
      if ("errorCode" in result && result.errorCode) setErrorCode(result.errorCode as MarkdownMirrorErrorCode);
      else if ("ok" in result && result.ok === false && !result.canceled) setErrorCode("unexpected");
      await refresh();
    } catch {
      setErrorCode("unexpected");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) => run(async () => {
    setSynced(false);
    const next = await bridge.setMarkdownMirrorEnabled(enabled);
    setStatus(next);
    return next;
  });

  const chooseDirectory = () => run(async () => {
    setSynced(false);
    const result = await bridge.chooseMarkdownMirrorDirectory();
    if (!result.canceled) setStatus(result);
    return result;
  });

  const restoreDefault = () => run(async () => {
    setSynced(false);
    const result = await bridge.resetMarkdownMirrorDirectory();
    setStatus(result);
    return result;
  });

  const syncNow = async () => {
    setBusy(true);
    setErrorCode(null);
    setSynced(false);
    try {
      const next = await bridge.syncMarkdownMirror();
      setStatus(next);
      setSynced(!next.lastError);
      if (next.lastError) setErrorCode("sync-failed");
    } catch {
      setErrorCode("unexpected");
    } finally {
      setBusy(false);
    }
  };

  const openDirectory = async () => {
    setErrorCode(null);
    try {
      await bridge.openMarkdownMirrorDirectory();
    } catch {
      setErrorCode("unexpected");
    }
  };

  const disabled = busy || status?.syncing === true;
  const lastSyncedLabel = status?.lastSyncedAt
    ? t("markdownMirror.lastSynced", { time: new Date(status.lastSyncedAt).toLocaleString() })
    : t("markdownMirror.neverSynced");

  return (
    <Card className="w-full min-w-0 overflow-hidden shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
          <FileText className={SETTINGS_CARD_ICON_CLASSNAME} />
          {t("markdownMirror.title")}
        </CardTitle>
        <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>{t("markdownMirror.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-0 sm:px-5 sm:pb-5">
        <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">{t("markdownMirror.toggle")}</p>
            <p className="text-xs text-slate-500">
              {status?.enabled ? t("markdownMirror.stateOn") : t("markdownMirror.stateOff")}
            </p>
          </div>
          <Switch
            checked={Boolean(status?.enabled)}
            disabled={disabled}
            aria-label={t("markdownMirror.toggle")}
            onCheckedChange={(checked) => { void toggle(checked); }}
          />
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-slate-500">{t("markdownMirror.currentDirectory")}</span>
          <code className="break-all rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-800">
            {status?.directory ?? t("storageLocation.loading")}
          </code>
          <p className="text-xs text-slate-500">
            {status?.syncing
              ? t("markdownMirror.syncing")
              : t("markdownMirror.files", { files: status?.fileCount ?? 0 })}
            {` · ${lastSyncedLabel}`}
          </p>
        </div>
        <p className="text-xs leading-5 text-slate-500">{t("markdownMirror.attachmentsHint")}</p>
        {errorCode ? (
          <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {errorCode === "unexpected" ? t("markdownMirror.errors.unexpected") : t(errorKeys[errorCode])}
          </p>
        ) : null}
        {synced && status?.lastError === "" ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700" role="status">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            {t("markdownMirror.syncComplete")}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button size="sm" type="button" disabled={disabled || !status?.enabled} onClick={() => void syncNow()}>
            <RefreshCw className={cn("h-4 w-4", status?.syncing && "animate-spin")} />
            {status?.syncing ? t("markdownMirror.syncing") : t("markdownMirror.syncNow")}
          </Button>
          <Button size="sm" variant="outline" type="button" disabled={disabled} onClick={() => void chooseDirectory()}>
            <FolderOpen className="h-4 w-4" />
            {t("markdownMirror.changeDirectory")}
          </Button>
          {status?.isCustom ? (
            <Button size="sm" variant="outline" type="button" disabled={disabled} onClick={() => void restoreDefault()}>
              {t("markdownMirror.restoreDefault")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => void openDirectory()}>
            {t("markdownMirror.openDirectory")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
