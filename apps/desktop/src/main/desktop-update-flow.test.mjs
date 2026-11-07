import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { normalizeDesktopUpdateProgress } from "./update-progress.mjs";

const mainSource = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/index.cjs", import.meta.url), "utf8");
const noticeSource = readFileSync(new URL("../../../web/src/components/DesktopUpdateNotice.tsx", import.meta.url), "utf8");
const systemInfoSource = readFileSync(new URL("../../../web/src/components/settings/SystemInfoPanel.tsx", import.meta.url), "utf8");
const notebookPaneSource = readFileSync(new URL("../../../web/src/components/NotebookPane.tsx", import.meta.url), "utf8");
const updateCardSource = readFileSync(new URL("../../../web/src/components/settings/DesktopUpdateCard.tsx", import.meta.url), "utf8");
const updateGuardSource = readFileSync(new URL("../../../web/src/hooks/useDesktopUpdateInstallGuard.ts", import.meta.url), "utf8");
const editorPaneSource = readFileSync(new URL("../../../web/src/components/EditorPane.tsx", import.meta.url), "utf8");
const updateFlushSource = readFileSync(new URL("../../../web/src/lib/update-install-flush.ts", import.meta.url), "utf8");

const sourceBetween = (start, end) => {
  const from = mainSource.indexOf(start);
  const to = mainSource.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing update source boundary: ${start}`);
  return mainSource.slice(from, to);
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const createUpdateHarness = ({ platform = "linux", env = {}, response = 1, verificationFails = false, automaticEnabled = true } = {}) => {
  const confirmation = deferred();
  const dialogOpened = deferred();
  const download = deferred();
  const dialogs = [];
  const statuses = [];
  const diagnostics = [];
  const handlers = new Map();
  let downloads = 0;
  let checks = 0;
  let destroyed = false;
  let latestVersion = "2.0.0";
  const autoUpdater = new EventEmitter();
  autoUpdater.netSession = { setProxy: async () => {}, fetch: async () => {} };
  autoUpdater.setFeedURL = () => {};
  autoUpdater.downloadUpdate = () => { downloads += 1; return download.promise; };
  autoUpdater.checkForUpdates = async () => {
    checks += 1;
    const info = { version: latestVersion };
    const isUpdateAvailable = latestVersion !== "1.0.0";
    autoUpdater.emit(isUpdateAvailable ? "update-available" : "update-not-available", info);
    return { isUpdateAvailable, updateInfo: info };
  };
  const state = {
    autoUpdater,
    process: { platform, env },
    app: { isPackaged: true, getLocale: () => "zh-CN", getVersion: () => "1.0.0", quit: () => {} },
    mainWindow: { isDestroyed: () => destroyed, webContents: { send: (_channel, status) => statuses.push(status) } },
    isQuitting: false,
    updateState: "idle",
    updateDownloadProgress: null,
    updateCheckInFlight: null,
    updateDownloadInFlight: null,
    updateDownloadPromptInFlight: null,
    downloadedUpdateVersion: null,
    latestCheckedVersion: null,
    trustedWindowsUpdate: null,
    windowsDownloadedUpdateVerified: false,
    updateDownloadBlocked: null,
    lastUpdateError: null,
    lastUpdateCheckAt: 0,
    updateCheckFocusThrottleMs: 0,
    updateCheckIntervalMs: 60_000,
    updateWindowTickMs: 60_000,
    updatePreferences: { autoUpdateEnabled: automaticEnabled, windowEnabled: false },
    updateCheckTimer: null,
    updateWindowTimer: null,
    promptedUpdateVersion: null,
    proxySettings: {},
    shouldAutoUpdateNow: (preferences) => preferences.autoUpdateEnabled,
    updaterProxySessionConfig: () => ({}),
    refreshTrayMenu: () => {},
    normalizeDesktopUpdateProgress,
    desktopReleaseLinks: () => ({}),
    writeDiagnostic: async (name, detail) => { diagnostics.push({ name, detail }); },
    classifyUpdateError: (error) => ({ kind: "network", message: error.message }),
    fetchTrustedWindowsUpdate: async ({ version }) => {
      if (verificationFails) throw new Error("Invalid signature");
      return { version, keyId: "test-key" };
    },
    verifyDownloadedWindowsUpdate: async () => {},
    installDownloadedUpdate: async () => {},
    promptForDownloadedUpdate: async () => {},
    powerMonitor: new EventEmitter(),
    scheduledTaskScheduler: { runMissedOccurrences: async () => {} },
    setInterval: () => 1,
    setTimeout: () => 1,
    dialog: { showMessageBox: async (_window, options) => {
      dialogs.push(options);
      dialogOpened.resolve();
      return response === null ? confirmation.promise : { response };
    } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  };
  const api = runInNewContext(`
    ${sourceBetween("const linuxUpdateTestMode =", "const requestedUserDataDirectory =")}
    ${sourceBetween("const desktopUpdateStatus =", "const UPDATE_INSTALL_PREPARE_TIMEOUT_MS")}
    ${sourceBetween("const trackDesktopUpdateDownload =", "const promptForDownloadedUpdate =")}
    ${sourceBetween("const applyUpdaterProxy =", "const startSidecar =")}
    ${sourceBetween('ipcMain.handle("desktop:check-update"', 'ipcMain.handle("desktop:install-update"')}
    ({ checkForDesktopUpdate, requestDesktopUpdateDownload, configureAutoUpdater });
  `, state);
  return {
    ...api, state, autoUpdater, dialogs, statuses, diagnostics, handlers, confirmation, download,
    dialogOpened: dialogOpened.promise,
    counts: () => ({ checks, downloads }),
    destroyWindow: () => { destroyed = true; },
    setLatestVersion: (value) => { latestVersion = value; },
    ready: async () => { api.configureAutoUpdater(); await state.updateCheckInFlight; },
  };
};

describe("desktop update flow", () => {
  test("enables automatic updates for packaged Linux AppImages", () => {
    expect(mainSource).not.toContain('process.platform === "linux" || !app.isPackaged');
    expect(mainSource).toContain('autoUpdateSupported: true');
    expect(mainSource).toContain('process.env.GITHUB_ACTIONS === "true"');
    expect(mainSource).toContain("Linux update verification requires a loopback HTTP feed");
    expect(systemInfoSource).toContain("desktopAutoUpdateSupported");
    expect(systemInfoSource).toContain('t("systemInfo.desktopDownloadLatest")');
  });

  test("requires confirmation before downloading and relaunches after installation", () => {
    expect(mainSource).toContain("autoUpdater.autoDownload = false");
    expect(mainSource).toContain("autoUpdater.autoRunAppAfterInstall = true");
    expect(mainSource).toContain('autoUpdater.quitAndInstall(process.platform === "win32", true)');
    expect(mainSource).not.toContain("result?.downloadPromise");
    expect(mainSource).toContain('await requestDesktopUpdateDownload("manual-check")');
    expect(mainSource).toContain('requestDesktopUpdateDownload("manual-download")');
  });

  test("fails closed around unsigned Windows automatic updates", () => {
    expect(mainSource).toContain("fetchTrustedWindowsUpdate({");
    expect(mainSource).toContain("verifyDownloadedWindowsUpdate({");
    expect(mainSource).toContain("autoUpdater.autoInstallOnAppQuit = false");
    expect(mainSource).toContain("windowsDownloadedUpdateVerified = true");
    expect(mainSource).toContain('writeDiagnostic("update.windows-package-blocked"');
    expect(mainSource).toContain('requestDesktopUpdateDownload("manual-download")');
  });

  test("offers a manual update check in desktop system settings", () => {
    expect(mainSource).toContain('ipcMain.handle("desktop:check-update"');
    expect(mainSource).toContain('checkForDesktopUpdate("manual", { force: true, throwOnError: true })');
    expect(preloadSource).toContain('checkUpdate: () => ipcRenderer.invoke("desktop:check-update")');
    expect(systemInfoSource).toContain('t("systemInfo.desktopCheckForUpdates")');
    expect(systemInfoSource).toContain("desktopBridge!.checkUpdate()");
    expect(systemInfoSource).toContain('t("systemInfo.desktopUpdateCurrent")');
  });

  test("shares precise desktop runtime diagnostics with the system information panel", () => {
    expect(mainSource).toContain('ipcMain.handle("desktop:system-info", () => desktopRuntimeSystemInfo())');
    expect(preloadSource).toContain('systemInfo: () => ipcRenderer.invoke("desktop:system-info")');
    expect(systemInfoSource).toContain("getClientRuntimeDiagnostics");
    expect(systemInfoSource).toContain('t("systemInfo.runtimeEngine")');
    expect(systemInfoSource).toContain('t("systemInfo.deviceModel")');
    expect(systemInfoSource).toContain('t("systemInfo.connectionSection")');
    expect(mainSource).toContain("deviceModel: desktopDeviceModel()");
    expect(systemInfoSource).not.toContain('t("systemInfo.dataDirectory")');
    expect(mainSource).toContain("dataDir: sidecarDataDirectory(activeAccountId)");
  });

  test("rechecks for updates while a packaged app remains open", () => {
    expect(mainSource).toContain('checkForDesktopUpdate("startup", { force: true })');
    expect(mainSource).toContain('checkForDesktopUpdate("interval", { force: true })');
    expect(mainSource).toContain('powerMonitor.on("resume"');
    expect(mainSource).toContain('checkForDesktopUpdate("activate")');
    expect(mainSource).toContain("if (updateCheckInFlight) {");
    expect(mainSource).toContain("return throwOnError ? updateCheckInFlight : updateCheckInFlight.catch(() => null)");
    expect(mainSource).toContain("clearInterval(updateCheckTimer)");
  });

  test("offers quiet download and restart actions without stealing focus", () => {
    expect(noticeSource).toContain('statusQuery.data?.state === "downloaded"');
    expect(noticeSource).toContain('statusQuery.data?.state === "available"');
    expect(noticeSource).toContain('"systemInfo.desktopUpdateRestart" : "desktopUpdate.download"');
    expect(noticeSource).toContain("bridge!.downloadUpdate()");
    expect(noticeSource).not.toContain("window.focus()");
    expect(updateCardSource).toContain("else if (available) downloadUpdate.mutate()");
    expect(systemInfoSource).toContain('else if (desktopUpdateState === "available") desktopUpdateDownloadMutation.mutate()');
  });

  test("pushes update status and shows a native restart prompt after download", () => {
    expect(mainSource).toContain('mainWindow.webContents.send("desktop:update-status-changed"');
    expect(mainSource).toContain("promptForDownloadedUpdate(downloadedUpdateVersion)");
    expect(mainSource).toContain('title: isChinese ? "EdgeEver 更新已就绪" : "EdgeEver update ready"');
    expect(preloadSource).toContain('ipcRenderer.on("desktop:update-status-changed"');
    expect(noticeSource).toContain("bridge.onUpdateStatus");
    expect(noticeSource).toContain('aria-live="polite"');
    expect(notebookPaneSource).toContain("<DesktopUpdateNotice />");
    expect(notebookPaneSource).toContain('className="flex items-center gap-1"');
  });

  test("persists auto-update preferences and gates background checks by time window", () => {
    expect(mainSource).toContain("UPDATE_PREFERENCES_FILE");
    expect(mainSource).toContain("loadUpdatePreferences()");
    expect(mainSource).toContain('ipcMain.handle("desktop:update-preferences"');
    expect(mainSource).toContain('ipcMain.handle("desktop:set-update-preferences"');
    expect(mainSource).toContain("persistUpdatePreferences()");
    expect(mainSource).toContain("shouldAutoUpdateNow(updatePreferences)");
    expect(mainSource).toContain('checkForDesktopUpdate("window")');
    expect(updateCardSource).toContain("desktopUpdate.autoUpdate");
    expect(updateCardSource).toContain("desktopUpdate.windowStart");
    expect(updateCardSource).toContain("bridge.setUpdatePreferences");
    expect(updateCardSource).toContain("desktopUpdate.currentVersion");
    expect(preloadSource).toContain('updatePreferences: () => ipcRenderer.invoke("desktop:update-preferences")');
  });

  test("syncs local notes before installing and cancels the restart when sync is incomplete", () => {
    expect(mainSource).toContain("prepareRendererForUpdateInstall");
    expect(mainSource).toContain('"desktop:update-install-prepare"');
    expect(mainSource).toContain('"desktop:update-install-prepared"');
    expect(mainSource).toContain('writeDiagnostic("update.install-sync-blocked"');
    expect(preloadSource).toContain("onUpdateInstallPrepare");
    expect(updateGuardSource).toContain("flushEditorBeforeUpdateInstall");
    expect(updateGuardSource).toContain("getDesktopSyncSummary");
    expect(updateGuardSource).toContain("summary.total === 0");
    expect(updateFlushSource).toContain("registerEditorUpdateFlush");
    expect(editorPaneSource).toContain("registerEditorUpdateFlush");
    expect(mainSource).not.toContain("autoUpdater.autoInstallOnAppQuit = true");
  });

  test("routes update traffic through the configured proxy and surfaces network failures", () => {
    expect(mainSource).toContain("updaterProxySessionConfig");
    expect(mainSource).toContain("autoUpdater.netSession.setProxy");
    expect(mainSource).toContain("const applyUpdaterProxy = async () => {");
    expect(mainSource).toContain("await applyUpdaterProxy();");
    expect(mainSource).toContain(".then(() => autoUpdater.checkForUpdates())");
    expect(mainSource).toContain("lastUpdateError = classifyUpdateError(error)");
    expect(mainSource).toContain("error: lastUpdateError");
    expect(mainSource).toContain('checkForDesktopUpdate("proxy", { force: true })');
    expect(updateCardSource).toContain('t("desktopUpdate.proxyTitle")');
    expect(updateCardSource).toContain("saveDesktopProxySettings");
    expect(updateCardSource).toContain('value="socks5"');
    expect(updateCardSource).toContain('t("desktopUpdate.failedNetwork")');
    expect(updateCardSource).toContain('t("desktopUpdate.networkHint")');
    expect(updateCardSource).toContain('status?.error');
    expect(systemInfoSource).toContain("systemInfo.desktopUpdateNetworkFailed");
  });

  test("does not hold auto-restart while the GitHub release is newer than the instance", () => {
    expect(mainSource).not.toContain("shouldHoldAutoRestartUpdate");
    expect(mainSource).not.toContain("holdAutoRestartUpdate");
    expect(mainSource).not.toContain("heldUpdateVersion");
    expect(mainSource).not.toContain("update.held-for-instance");
    expect(mainSource).toContain("promptForDownloadedUpdate(downloadedUpdateVersion)");
    expect(systemInfoSource).toContain("clientAheadOfInstanceByPlatform");
    expect(systemInfoSource).toContain("isClientAheadOfInstance");
  });

  test("displays the latest checked version when client is already up to date", () => {
    expect(mainSource).toContain("const resolvedLatestVersion = latestCheckedVersion");
    expect(mainSource).toContain("latestVersion: resolvedLatestVersion");
    expect(updateCardSource).toContain("latestResolvedVersion = status?.latestVersion");
    expect(updateCardSource).toContain("latestVersionTag ?? t(\"desktopUpdate.notChecked\")");
    expect(updateCardSource).toContain('t("desktopUpdate.upToDate", { version: latestVersionTag ?? currentVersionTag })');
    expect(systemInfoSource).toContain("desktopLatestVersionTag");
    expect(systemInfoSource).toContain('t("systemInfo.desktopUpdateCurrent", { version: desktopLatestVersionTag })');
  });

  test("only animates the status icon while checking, downloading, or installing", () => {
    expect(updateCardSource).not.toContain('checkedOnce && !downloaded && status?.state !== "available"');
    expect(updateCardSource).toMatch(/installUpdate\.isPending \|\| checkUpdate\.isPending \|\| downloadUpdate\.isPending \|\| downloading\s*\? <LoaderCircle[^>]+animate-spin[^>]+\/>\s*: <CheckCircle2/);
  });

  test("fetches the signed Windows manifest through the updater's proxy session", () => {
    // net.fetch follows the default session, which stays direct in "auto" mode,
    // so the verification step used to fail while the update check succeeded.
    expect(mainSource).toContain("const updaterFetch = (url, init) => autoUpdater.netSession.fetch(url, init);");
    expect(mainSource).toContain("fetchImpl: updaterFetch");
    expect(mainSource).not.toContain("fetchImpl: net.fetch");
  });

  test("keeps a discovered version usable when the signed manifest is rejected", () => {
    expect(mainSource).toContain("updateDownloadBlocked = \"verification\"");
    expect(mainSource).toContain('writeDiagnostic("update.windows-manifest-rejected"');
    // The failure is recorded, but the check itself must not throw away the
    // version it just discovered: the rejection is handled inside the check
    // instead of falling through to the outer catch that clears the state.
    expect(mainSource).toContain("updateDownloadBlocked = \"verification\"");
    expect(mainSource).toContain("await writeDiagnostic(\"update.windows-manifest-rejected\"");
    expect(mainSource).not.toContain("void downloadTrustedDesktopUpdate(reason);");
    expect(mainSource).toContain('if (linuxUpdateTestMode && result?.isUpdateAvailable)');
  });

  test("publishes a concrete download link with every update status", () => {
    expect(mainSource).toContain("import { desktopReleaseLinks } from \"./update-release-links.mjs\";");
    expect(mainSource).toContain("downloadUrl: links.downloadUrl");
    expect(mainSource).toContain("releasePageUrl: links.releasePageUrl");
    expect(updateCardSource).toContain('t("desktopUpdate.downloadInstaller")');
    expect(updateCardSource).toContain("manualDownloadRequired");
    expect(updateCardSource).toContain('t("desktopUpdate.manualDownloadHint")');
    expect(updateCardSource).toContain('t("desktopUpdate.checkFailedWithLink")');
    expect(systemInfoSource).toContain("desktopDownloadUrl");
  });
});

describe("desktop download progress publication", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    test(`${platform} publishes live progress, hides it on completion and ignores late events`, async () => {
      const harness = createUpdateHarness({ platform, response: 0 });
      await harness.ready();
      await harness.handlers.get("desktop:download-update")();
      expect(harness.statuses.at(-1).downloadProgress).toEqual({ percent: null, transferred: 0, total: null });
      harness.autoUpdater.emit("download-progress", { percent: 25, transferred: 25, total: 100 });
      expect(harness.statuses.at(-1)).toMatchObject({
        state: "downloading", downloadProgress: { percent: 25, transferred: 25, total: 100 },
      });
      harness.autoUpdater.emit("update-downloaded", { version: "2.0.0" });
      // Windows completes its existing signature gate before publishing readiness.
      await new Promise((resolve) => setImmediate(resolve));
      expect(harness.statuses.at(-1)).toMatchObject({ state: "downloaded", downloadProgress: null });
      const count = harness.statuses.length;
      harness.autoUpdater.emit("download-progress", { percent: 80, transferred: 80, total: 100 });
      expect(harness.statuses).toHaveLength(count);
      harness.download.resolve([]);
      await harness.state.updateDownloadInFlight;
    });
  }

  test("failed downloads hide stale progress and retries start from zero", async () => {
    const harness = createUpdateHarness({ response: 0 });
    await harness.ready();
    await harness.handlers.get("desktop:download-update")();
    harness.autoUpdater.emit("download-progress", { percent: 50, transferred: 50, total: 100 });
    const pending = harness.state.updateDownloadInFlight;
    harness.download.reject(new Error("Connection interrupted"));
    await pending;
    expect(harness.statuses.at(-1)).toMatchObject({ state: "idle", downloadProgress: null });
    const retry = deferred();
    harness.autoUpdater.downloadUpdate = () => retry.promise;
    await harness.handlers.get("desktop:check-update")();
    expect(harness.statuses.at(-1)).toMatchObject({
      state: "downloading", downloadProgress: { percent: null, transferred: 0, total: null },
    });
    retry.resolve([]);
    await harness.state.updateDownloadInFlight;
  });
});

describe("desktop download confirmation behavior", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    test(`${platform} background checks never prompt or download`, async () => {
      const harness = createUpdateHarness({ platform });
      await harness.ready();
      expect(harness.autoUpdater.autoDownload).toBe(false);
      for (const reason of ["interval", "resume", "activate", "window", "preferences", "proxy"]) {
        await harness.checkForDesktopUpdate(reason, { force: true });
      }
      expect(harness.state.updateState).toBe("available");
      expect(harness.dialogs).toHaveLength(0);
      expect(harness.counts().downloads).toBe(0);
    });

    test(`${platform} manual check waits for confirmation and merges concurrent download requests`, async () => {
      const harness = createUpdateHarness({ platform, response: null });
      await harness.ready();
      const first = harness.handlers.get("desktop:check-update")();
      const second = harness.handlers.get("desktop:download-update")();
      await harness.dialogOpened;
      expect(harness.counts().downloads).toBe(0);
      expect(harness.state.updateState).toBe("available");
      expect(harness.dialogs).toHaveLength(1);
      expect(harness.dialogs[0]).toMatchObject({ defaultId: 1, cancelId: 1, buttons: ["下载更新", "稍后"] });
      expect(harness.dialogs[0].detail).toContain("v1.0.0");
      expect(harness.dialogs[0].detail).toContain("v2.0.0");
      const checksBefore = harness.counts().checks;
      await harness.checkForDesktopUpdate("interval", { force: true });
      expect(harness.counts().checks).toBe(checksBefore);
      harness.confirmation.resolve({ response: 0 });
      await Promise.all([first, second]);
      expect(harness.counts().downloads).toBe(1);
      expect(harness.state.updateState).toBe("downloading");
      expect(harness.statuses.at(-1).state).toBe("downloading");
      expect(await harness.handlers.get("desktop:download-update")()).toMatchObject({ started: false });
      expect(harness.counts().downloads).toBe(1);
    });

    test(`${platform} cancelling leaves an available update and does not download on later checks`, async () => {
      const harness = createUpdateHarness({ platform });
      await harness.ready();
      const status = await harness.handlers.get("desktop:check-update")();
      expect(status.state).toBe("available");
      expect(harness.counts().downloads).toBe(0);
      await harness.checkForDesktopUpdate("interval", { force: true });
      expect(harness.dialogs).toHaveLength(1);
      expect(harness.counts().downloads).toBe(0);
      await harness.handlers.get("desktop:download-update")();
      expect(harness.dialogs).toHaveLength(2);
      expect(harness.counts().downloads).toBe(0);
    });
  }

  test("up-to-date and unsigned Windows updates do not offer download confirmation", async () => {
    const current = createUpdateHarness();
    current.setLatestVersion("1.0.0");
    await current.ready();
    expect((await current.handlers.get("desktop:check-update")()).state).toBe("idle");
    expect(current.dialogs).toHaveLength(0);
    const unsigned = createUpdateHarness({ platform: "win32", verificationFails: true, response: 0 });
    await unsigned.ready();
    await unsigned.handlers.get("desktop:check-update")();
    expect(unsigned.state.updateDownloadBlocked).toBe("verification");
    expect(unsigned.state.latestCheckedVersion).toBe("2.0.0");
    await unsigned.handlers.get("desktop:download-update")();
    expect(unsigned.dialogs).toHaveLength(0);
    expect(unsigned.counts().downloads).toBe(0);
  });

  test("closing the window or changing the target during confirmation prevents downloading", async () => {
    for (const invalidate of [
      (harness) => harness.destroyWindow(),
      (harness) => { harness.state.isQuitting = true; },
      (harness) => { harness.state.downloadedUpdateVersion = "3.0.0"; },
      (harness) => { harness.state.updateDownloadBlocked = "verification"; },
      (harness) => { harness.state.trustedWindowsUpdate = null; },
    ]) {
      const harness = createUpdateHarness({ platform: "win32", response: null });
      await harness.ready();
      const request = harness.handlers.get("desktop:download-update")();
      await harness.dialogOpened;
      invalidate(harness);
      harness.confirmation.resolve({ response: 0 });
      expect(await request).toMatchObject({ started: false });
      expect(harness.counts().downloads).toBe(0);
    }
  });

  test("download failures reset the state and require confirmation again on retry", async () => {
    const harness = createUpdateHarness({ response: 0 });
    await harness.ready();
    await harness.handlers.get("desktop:download-update")();
    const pending = harness.state.updateDownloadInFlight;
    harness.download.reject(new Error("Connection interrupted"));
    await pending;
    expect(harness.state.updateState).toBe("idle");
    expect(harness.state.updateDownloadInFlight).toBeNull();
    expect(harness.state.lastUpdateError.message).toBe("Connection interrupted");
    const retry = deferred();
    harness.autoUpdater.downloadUpdate = () => retry.promise;
    await harness.handlers.get("desktop:check-update")();
    expect(harness.dialogs).toHaveLength(2);
    expect(harness.state.updateState).toBe("downloading");
    retry.resolve([]);
    await harness.state.updateDownloadInFlight;
  });

  test("failed checks and dialogs cannot start downloads or leave the confirmation gate locked", async () => {
    const harness = createUpdateHarness();
    await harness.ready();
    harness.autoUpdater.checkForUpdates = async () => { throw new Error("Check unavailable"); };
    await expect(harness.handlers.get("desktop:check-update")()).rejects.toThrow("Check unavailable");
    expect(harness.dialogs).toHaveLength(0);
    expect(harness.counts().downloads).toBe(0);
    harness.state.updateState = "available";
    harness.state.downloadedUpdateVersion = "2.0.0";
    harness.state.dialog.showMessageBox = async () => { throw new Error("Window unavailable"); };
    await expect(harness.handlers.get("desktop:download-update")()).rejects.toThrow("Window unavailable");
    expect(harness.state.updateDownloadPromptInFlight).toBeNull();
    expect(harness.counts().downloads).toBe(0);
    harness.state.dialog.showMessageBox = async () => ({ response: 1 });
    expect(await harness.handlers.get("desktop:download-update")()).toMatchObject({ reason: "cancelled" });
  });

  test("manual checks remain available when automatic checking is disabled", async () => {
    const harness = createUpdateHarness({ automaticEnabled: false });
    await harness.ready();
    expect(harness.counts().checks).toBe(0);
    await harness.handlers.get("desktop:check-update")();
    expect(harness.counts().checks).toBe(1);
    expect(harness.dialogs).toHaveLength(1);
    expect(harness.counts().downloads).toBe(0);
  });

  test("only the Linux CI loopback harness bypasses confirmation for cross-version verification", async () => {
    const env = {
      EDGE_EVER_DESKTOP_UPDATE_TEST: "1",
      EDGE_EVER_DESKTOP_UPDATE_TEST_FEED_URL: "http://127.0.0.1:12345/",
    };
    const local = createUpdateHarness({ env });
    await local.ready();
    expect(local.counts().downloads).toBe(0);
    const ci = createUpdateHarness({ env: { ...env, GITHUB_ACTIONS: "true" } });
    await ci.ready();
    expect(ci.counts().downloads).toBe(1);
    expect(ci.dialogs).toHaveLength(0);
    const invalidFeed = createUpdateHarness({ env: { ...env, GITHUB_ACTIONS: "true", EDGE_EVER_DESKTOP_UPDATE_TEST_FEED_URL: "http://example.invalid/" } });
    expect(() => invalidFeed.configureAutoUpdater()).toThrow("loopback HTTP feed");
  });
});
