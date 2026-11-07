import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ChevronDown, ExternalLink, LoaderCircle, Network, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getDesktopProxySettings,
  isDesktopProxyConfigured,
  saveDesktopProxySettings,
  type DesktopProxyProtocol,
  type DesktopProxySettings,
} from "@/lib/desktop-proxy";
import { getDesktopUpdateDownloadLabel } from "@/lib/desktop-update-progress";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const UPDATE_PREFERENCES_QUERY_KEY = ["desktop-update-preferences"] as const;
const UPDATE_STATUS_QUERY_KEY = ["desktop-update-status"] as const;

const DesktopUpdateCardContent = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const bridge = window.edgeeverDesktop!;
  const [expanded, setExpanded] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);
  const [checkFailedOnce, setCheckFailedOnce] = useState(false);
  const [proxy, setProxy] = useState<DesktopProxySettings>(() => getDesktopProxySettings());
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyError, setProxyError] = useState(false);
  const [proxyIncomplete, setProxyIncomplete] = useState(false);

  const preferencesQuery = useQuery({
    queryKey: UPDATE_PREFERENCES_QUERY_KEY,
    queryFn: () => bridge.updatePreferences(),
    retry: 1,
  });
  const statusQuery = useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: () => bridge.updateStatus(),
    retry: 1,
    refetchInterval: (query) => query.state.data?.state === "downloading" ? 3_000 : false,
  });

  useEffect(() => {
    if (!bridge.onUpdateStatus) return;
    return bridge.onUpdateStatus((status) => {
      queryClient.setQueryData(UPDATE_STATUS_QUERY_KEY, status);
    });
  }, [bridge, queryClient]);

  const savePreferences = useMutation({
    mutationFn: (value: DesktopUpdatePreferenceInput) => bridge.setUpdatePreferences(value),
    onSuccess: (data) => {
      queryClient.setQueryData(UPDATE_PREFERENCES_QUERY_KEY, data);
    },
  });

  const checkUpdate = useMutation({
    mutationFn: () => bridge.checkUpdate(),
    onSuccess: (data) => {
      setCheckedOnce(true);
      setCheckFailedOnce(false);
      queryClient.setQueryData(UPDATE_STATUS_QUERY_KEY, data);
    },
    // The IPC call rejects on failure; the status payload carries the
    // classified reason (network vs. everything else), so pull it back in.
    onError: () => {
      setCheckFailedOnce(true);
      void statusQuery.refetch();
    },
  });

  const downloadUpdate = useMutation({
    mutationFn: () => bridge.downloadUpdate(),
    onSuccess: () => {
      setCheckFailedOnce(false);
      void statusQuery.refetch();
    },
    onError: () => {
      setCheckFailedOnce(true);
      void statusQuery.refetch();
    },
  });

  const installUpdate = useMutation({
    mutationFn: async () => {
      const result = await bridge.installUpdate();
      if (!result?.started) throw new Error(result?.reason ?? "install-failed");
      return result;
    },
  });

  const preferences = preferencesQuery.data;
  const status = statusQuery.data;
  const available = status?.state === "available" && !status.downloadBlocked;
  const downloading = status?.state === "downloading";
  const downloaded = status?.state === "downloaded";
  const autoUpdateSupported = preferences?.autoUpdateSupported !== false;
  const proxySupported = typeof bridge.getProxySettings === "function" && typeof bridge.setProxySettings === "function";
  const busy = checkUpdate.isPending || downloadUpdate.isPending || downloading || installUpdate.isPending || savePreferences.isPending;
  const savingPreferences = savePreferences.isPending;
  const updateError = status?.error ?? null;
  const networkFailed = updateError?.kind === "network";
  const checkFailed = checkFailedOnce || statusQuery.isError;
  const shouldRevealUpdateDetails = available || downloading || downloaded
    || installUpdate.isError
    || networkFailed
    || checkFailed
    || status?.downloadBlocked === "verification"
    || (preferencesQuery.isError && !preferences);

  useEffect(() => {
    if (shouldRevealUpdateDetails) setExpanded(true);
  }, [shouldRevealUpdateDetails]);

  const persistProxy = (next: DesktopProxySettings) => {
    setProxy(next);
    if (next.mode !== "off" && !isDesktopProxyConfigured(next)) {
      setProxyIncomplete(true);
      return;
    }
    setProxyIncomplete(false);
    setProxySaving(true);
    void saveDesktopProxySettings(next)
      .then((saved) => {
        setProxy(saved);
        setProxyError(false);
        // Configuring a proxy in response to a failed check is a request to
        // retry; do it immediately instead of waiting for the next tick.
        if (networkFailed && !checkUpdate.isPending) checkUpdate.mutate();
      })
      .catch(() => setProxyError(true))
      .finally(() => setProxySaving(false));
  };

  useEffect(() => {
    if (networkFailed) setProxyOpen(true);
  }, [networkFailed]);

  const updatePreferences = (patch: Partial<DesktopUpdatePreferenceInput>) => {
    if (!preferences) return;
    savePreferences.mutate({
      autoUpdateEnabled: preferences.autoUpdateEnabled,
      windowEnabled: preferences.windowEnabled,
      windowStart: preferences.windowStart,
      windowEnd: preferences.windowEnd,
      ...patch,
    });
  };

  const proxySummary = proxy.mode === "off"
    ? t("desktopUpdate.proxySummaryOff")
    : isDesktopProxyConfigured(proxy)
      ? `${proxy.protocol.toUpperCase()} · ${proxy.host}:${proxy.port}`
      : t("desktopUpdate.proxyIncomplete");

  const currentVersionTag = status?.currentVersion
    ? (status.currentVersion.startsWith("v") ? status.currentVersion : `v${status.currentVersion}`)
    : `v${__EDGEEVER_APP_VERSION__}`;
  const latestResolvedVersion = status?.latestVersion
    ?? status?.version
    ?? ((checkedOnce || status?.state === "idle") && !checkFailed && !updateError && !checkUpdate.isPending
      ? (status?.currentVersion ?? __EDGEEVER_APP_VERSION__)
      : null);
  const latestVersionTag = latestResolvedVersion
    ? (latestResolvedVersion.startsWith("v") ? latestResolvedVersion : `v${latestResolvedVersion}`)
    : null;
  // A newer build was discovered but the updater cannot install it itself
  // (failed signature gate / rejected manifest). Manual download is then the
  // only path, so it gets its own state instead of a generic failure.
  const manualDownloadRequired = status?.downloadBlocked === "verification" && Boolean(status?.latestVersion);
  const manualDownloadUrl = status?.downloadUrl
    ?? (latestVersionTag ? `https://github.com/ikun-yinmie/edgeever/releases/tag/${latestVersionTag}` : null);
  const manualDownloadNetwork = manualDownloadRequired && networkFailed;

  const statusLabel = installUpdate.isError
    ? t("desktopUpdate.syncBlocked")
    : installUpdate.isPending
      ? t("desktopUpdate.installing")
      : downloaded
        ? t("desktopUpdate.ready")
        : downloading
          ? getDesktopUpdateDownloadLabel(status?.downloadProgress, t)
          : available
            ? t(checkUpdate.isPending || downloadUpdate.isPending ? "desktopUpdate.confirming" : "desktopUpdate.available")
            : checkUpdate.isPending
              ? t("desktopUpdate.checking")
              : manualDownloadRequired
                ? t("desktopUpdate.manualDownloadTitle", { version: latestVersionTag ?? currentVersionTag })
                : networkFailed
                  ? t("desktopUpdate.failedNetwork")
                  : checkFailed || updateError
                    ? t("desktopUpdate.failed")
                    : checkedOnce || Boolean(status?.latestVersion)
                      ? t("desktopUpdate.upToDate", { version: latestVersionTag ?? currentVersionTag })
                      : null;

  const actionLabel = downloaded
    ? t("desktopUpdate.restart")
    : downloading
      ? t("desktopUpdate.downloading")
      : available
        ? t("desktopUpdate.download")
        : checkUpdate.isPending
          ? t("desktopUpdate.checking")
          : t("desktopUpdate.check");

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <Card className="w-full min-w-0 overflow-hidden shadow-none">
        <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
          <CollapsibleTrigger asChild>
            <button
              className="flex w-full min-w-0 items-start justify-between gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
              type="button"
            >
              <span className="min-w-0">
                <span className={SETTINGS_CARD_TITLE_CLASSNAME}>
                  <RefreshCw aria-hidden="true" className={SETTINGS_CARD_ICON_CLASSNAME} />
                  {t("desktopUpdate.title")}
                </span>
                <span className={cn(SETTINGS_CARD_DESCRIPTION_CLASSNAME, "block")}>
                  {t("desktopUpdate.description")}
                </span>
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn("mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform", expanded && "rotate-180")}
              />
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent asChild>
          <CardContent className="grid gap-3 p-4 pt-0 sm:px-5 sm:pb-5">
        <div className="grid gap-1.5 rounded-md border border-slate-200 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-500">{t("desktopUpdate.currentVersion")}</p>
              <p className="font-mono text-sm font-semibold text-slate-800">
                v{status?.currentVersion ?? __EDGEEVER_APP_VERSION__}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!downloaded && bridge?.relaunch ? (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => void bridge.relaunch?.()}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("desktopUpdate.relaunchApp")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={busy || !autoUpdateSupported || (statusQuery.isError && !status)}
                onClick={() => {
                  if (downloaded) installUpdate.mutate();
                  else if (available) downloadUpdate.mutate();
                  else checkUpdate.mutate();
                }}
              >
                {installUpdate.isPending || checkUpdate.isPending || downloadUpdate.isPending || downloading
                  ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  : downloaded
                    ? <RotateCcw className="h-3.5 w-3.5" />
                    : <RefreshCw className="h-3.5 w-3.5" />}
                {actionLabel}
              </Button>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            {t("desktopUpdate.latestVersion")}
            {": "}
            <span className="font-mono text-slate-700">
              {latestVersionTag ?? t("desktopUpdate.notChecked")}
            </span>
          </p>
          {statusLabel ? (
            <p
              className={cn(
                "flex items-center gap-1.5 text-xs",
                installUpdate.isError || networkFailed || checkFailed || updateError
                  ? "text-red-600"
                  : manualDownloadRequired
                    ? "text-amber-700"
                    : "text-slate-500",
              )}
              role="status"
              aria-live="polite"
            >
              {installUpdate.isError || networkFailed || (checkFailed && !checkUpdate.isPending) || updateError
                ? <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                : manualDownloadRequired
                  ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  : installUpdate.isPending || checkUpdate.isPending || downloadUpdate.isPending || downloading
                    ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
              {statusLabel}
            </p>
          ) : null}
          {!networkFailed && !manualDownloadRequired && (checkFailed || updateError) ? (
            <div
              className="grid gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-700"
              role="alert"
            >
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span>{t("desktopUpdate.checkFailedWithLink")}</span>
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5">
                <a
                  className="inline-flex items-center gap-1 font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
                  href={manualDownloadUrl ?? "https://github.com/ikun-yinmie/edgeever/releases/latest"}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("desktopUpdate.downloadInstaller")} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
                {status?.releasePageUrl ? (
                  <a
                    className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-slate-900"
                    href={status.releasePageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("desktopUpdate.downloadLatest")} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
              {updateError?.message ? (
                <details className="pl-5">
                  <summary className="cursor-pointer text-[11px] text-slate-500">
                    {t("desktopUpdate.lastErrorDetail")}
                  </summary>
                  <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{updateError.message}</p>
                </details>
              ) : null}
            </div>
          ) : null}
          {networkFailed ? (
            <div
              className="grid gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900"
              role="alert"
            >
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {manualDownloadNetwork
                    ? t("desktopUpdate.manualDownloadNetworkHint", { version: latestVersionTag ?? currentVersionTag })
                    : t("desktopUpdate.networkHint")}
                </span>
              </p>
              {updateError?.message ? (
                <p className="break-all pl-5 font-mono text-[11px] text-amber-800/80">{updateError.message}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5">
                {autoUpdateSupported ? (
                  <button
                    className="font-semibold underline underline-offset-2 hover:text-amber-950"
                    type="button"
                    onClick={() => setProxyOpen(true)}
                  >
                    {t("desktopUpdate.configureProxy")}
                  </button>
                ) : null}
                {manualDownloadUrl ? (
                  <a
                    className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-amber-950"
                    href={manualDownloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("desktopUpdate.downloadInstaller")} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
          {manualDownloadRequired && !networkFailed ? (
            <div
              className="grid gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900"
              role="alert"
            >
              <p className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t("desktopUpdate.manualDownloadHint")}</span>
              </p>
              {updateError?.message ? (
                <p className="break-all pl-5 font-mono text-[11px] text-amber-800/80">{updateError.message}</p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5">
                {manualDownloadUrl ? (
                  <a
                    className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-amber-950"
                    href={manualDownloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("desktopUpdate.downloadInstaller")} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
                {status?.releasePageUrl ? (
                  <a
                    className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-amber-950"
                    href={status.releasePageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("desktopUpdate.downloadLatest")} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {!autoUpdateSupported ? (
          <p className="flex items-start gap-1.5 text-xs leading-5 text-slate-500" role="status">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span>{t("desktopUpdate.unsupported")}</span>
          </p>
        ) : (
          <>
            {proxySupported ? (
              <div className="grid gap-2 rounded-md border border-slate-200 px-3 py-2.5">
                <button
                  aria-expanded={proxyOpen}
                  className="flex w-full items-center justify-between gap-3 text-left"
                  type="button"
                  onClick={() => setProxyOpen((value) => !value)}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                      <Network className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      {t("desktopUpdate.proxyTitle")}
                      {proxySaving ? <LoaderCircle className="h-3 w-3 animate-spin text-slate-400" /> : null}
                    </p>
                    <p className="truncate text-xs text-slate-500">{proxySummary}</p>
                  </div>
                  <ChevronDown
                    className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", proxyOpen && "rotate-180")}
                  />
                </button>
                {proxyOpen ? (
                  <div className="grid gap-2.5">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="grid gap-1 text-xs font-medium text-slate-600">
                        {t("desktopUpdate.proxyMode")}
                        <select
                          className="h-9 w-full rounded-md border border-slate-200 bg-card px-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                          value={proxy.mode}
                          onChange={(event) => persistProxy({
                            ...proxy,
                            mode: event.target.value as DesktopProxySettings["mode"],
                          })}
                        >
                          <option value="off">{t("desktopUpdate.proxyModeOff")}</option>
                          <option value="auto">{t("desktopUpdate.proxyModeAuto")}</option>
                          <option value="always">{t("desktopUpdate.proxyModeAlways")}</option>
                        </select>
                      </label>
                      {proxy.mode !== "off" ? (
                        <label className="grid gap-1 text-xs font-medium text-slate-600">
                          {t("desktopUpdate.proxyProtocol")}
                          <select
                            className="h-9 w-full rounded-md border border-slate-200 bg-card px-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                            value={proxy.protocol}
                            onChange={(event) => persistProxy({
                              ...proxy,
                              protocol: event.target.value as DesktopProxyProtocol,
                            })}
                          >
                            <option value="http">HTTP</option>
                            <option value="socks5">SOCKS5</option>
                          </select>
                        </label>
                      ) : null}
                    </div>
                    {proxy.mode !== "off" ? (
                      <div className="grid gap-2 sm:grid-cols-[1fr_96px]">
                        <label className="grid gap-1 text-xs font-medium text-slate-600">
                          {t("desktopUpdate.proxyHost")}
                          <Input
                            autoCapitalize="none"
                            autoCorrect="off"
                            className="h-9 rounded-md px-2.5 text-sm"
                            placeholder="127.0.0.1"
                            spellCheck={false}
                            value={proxy.host}
                            onBlur={() => persistProxy(proxy)}
                            onChange={(event) => setProxy({ ...proxy, host: event.target.value })}
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-medium text-slate-600">
                          {t("desktopUpdate.proxyPort")}
                          <Input
                            className="h-9 rounded-md px-2.5 text-sm"
                            inputMode="numeric"
                            placeholder="7890"
                            value={proxy.port > 0 ? String(proxy.port) : ""}
                            onBlur={() => persistProxy(proxy)}
                            onChange={(event) => {
                              const port = Number.parseInt(event.target.value.replace(/\D/g, ""), 10);
                              setProxy({ ...proxy, port: Number.isInteger(port) ? port : 0 });
                            }}
                          />
                        </label>
                      </div>
                    ) : null}
                    <p className="text-[11px] leading-4 text-slate-500">{t("desktopUpdate.proxyHint")}</p>
                    {proxyIncomplete ? (
                      <p className="text-[11px] leading-4 text-amber-600" role="status">{t("desktopUpdate.proxyIncomplete")}</p>
                    ) : null}
                    {proxyError ? (
                      <p className="text-[11px] leading-4 text-red-600" role="alert">{t("desktopUpdate.proxySaveFailed")}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{t("desktopUpdate.autoUpdate")}</p>
                <p className="text-xs text-slate-500">
                  {preferences?.autoUpdateEnabled ? t("desktopUpdate.stateOn") : t("desktopUpdate.stateOff")}
                  {" · "}
                  {t("desktopUpdate.autoUpdateDescription")}
                </p>
              </div>
              <Switch
                checked={Boolean(preferences?.autoUpdateEnabled)}
                disabled={!preferences || savingPreferences}
                aria-label={t("desktopUpdate.autoUpdate")}
                onCheckedChange={(checked) => updatePreferences({ autoUpdateEnabled: checked })}
              />
            </div>

            <div className="grid gap-3 rounded-md border border-slate-200 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{t("desktopUpdate.window")}</p>
                  <p className="text-xs text-slate-500">{t("desktopUpdate.windowDescription")}</p>
                </div>
                <Switch
                  checked={Boolean(preferences?.windowEnabled)}
                  disabled={!preferences || !preferences.autoUpdateEnabled || savingPreferences}
                  aria-label={t("desktopUpdate.window")}
                  onCheckedChange={(checked) => updatePreferences({ windowEnabled: checked })}
                />
              </div>
              {preferences?.windowEnabled ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs font-medium text-slate-600">
                    {t("desktopUpdate.windowStart")}
                    <Input
                      type="time"
                      value={preferences.windowStart}
                      disabled={savingPreferences}
                      onChange={(event) => {
                        if (event.target.value) updatePreferences({ windowStart: event.target.value });
                      }}
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-medium text-slate-600">
                    {t("desktopUpdate.windowEnd")}
                    <Input
                      type="time"
                      value={preferences.windowEnd}
                      disabled={savingPreferences}
                      onChange={(event) => {
                        if (event.target.value) updatePreferences({ windowEnd: event.target.value });
                      }}
                    />
                  </label>
                  <p className="text-xs text-slate-500 sm:col-span-2">{t("desktopUpdate.windowOvernight")}</p>
                </div>
              ) : null}
            </div>
          </>
        )}

        <p className="text-xs leading-5 text-slate-500">{t("desktopUpdate.syncHint")}</p>
        {preferencesQuery.isError && !preferences ? (
          <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {t("desktopUpdate.loadFailed")}
          </p>
        ) : null}
        {!autoUpdateSupported ? (
          <a
            className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
            href="https://github.com/ikun-yinmie/edgeever/releases/latest"
            target="_blank"
            rel="noreferrer"
          >
            {t("desktopUpdate.downloadLatest")} <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};

export const DesktopUpdateCard = () => {
  const bridge = window.edgeeverDesktop;
  if (
    !bridge?.isAvailable
    || typeof bridge.updatePreferences !== "function"
    || typeof bridge.setUpdatePreferences !== "function"
  ) return null;
  return <DesktopUpdateCardContent />;
};
