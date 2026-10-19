import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const loginSource = readFileSync(new URL("./LoginScreen.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../../desktop/src/main/index.mjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../../../desktop/src/preload/index.cjs", import.meta.url), "utf8");

describe("desktop login proxy settings", () => {
  test("shows the proxy section only for the desktop client", () => {
    expect(loginSource).toContain("const desktopNetworkSettings = initialInstanceUrl !== undefined && Boolean(window.edgeeverDesktop?.isAvailable);");
    expect(loginSource).toContain('t("login.desktopProxySection")');
    expect(loginSource).toContain("<option value=\"off\">{t(\"login.desktopProxyModeOff\")}</option>");
    expect(loginSource).toContain("<option value=\"auto\">{t(\"login.desktopProxyModeAuto\")}</option>");
    expect(loginSource).toContain("<option value=\"always\">{t(\"login.desktopProxyModeAlways\")}</option>");
  });

  test("probes the faster route before submitting in smart mode", () => {
    expect(loginSource).toContain('if (desktopNetworkSettings && proxySettings.mode === "auto" && isDesktopProxyConfigured(proxySettings)) {');
    expect(loginSource).toContain("await runProxyProbe();");
    expect(loginSource).toContain("probeDesktopProxyForSession(normalizeInstanceUrl(instanceUrl))");
    expect(loginSource).toContain('t(proxyProbe.chosen === "proxy" ? "login.desktopProxyProbeChosenProxy" : "login.desktopProxyProbeChosenDirect")');
  });

  test("persists settings through the desktop bridge", () => {
    expect(loginSource).toContain("saveDesktopProxySettings(next)");
    expect(loginSource).toContain("getDesktopProxySettings()");
    expect(preloadSource).toContain('getProxySettings: () => ipcRenderer.sendSync("desktop:proxy-settings-sync")');
    expect(preloadSource).toContain('setProxySettings: (value) => ipcRenderer.invoke("desktop:set-proxy-settings", value)');
    expect(preloadSource).toContain('probeProxyForSession: (baseUrl) => ipcRenderer.invoke("desktop:probe-proxy-for-session", baseUrl)');
  });

  test("switches to the fastest alternate address without changing the account identity", () => {
    expect(loginSource).toContain('typeof window.edgeeverDesktop?.probeInstanceUrls === "function"');
    expect(loginSource).toContain("collectDesktopProbeUrls(currentPrimaryUrl(), alternates)");
    expect(loginSource).toContain("pickFastestInstanceUrl(timings)");
    expect(loginSource).toContain("await selectActiveDesktopApiBaseUrl(fastest.url)");
    expect(loginSource).toContain("...(fastestInstance ? { instanceActiveUrl: fastestInstance.url } : {})");
    expect(loginSource).toContain('t("login.desktopAlternatesPrimaryHint")');
    expect(preloadSource).toContain('setPrimaryApiBaseUrl: (value) => ipcRenderer.invoke("desktop:set-primary-api-base-url", value)');
    expect(preloadSource).toContain('probeInstanceUrls: (urls) => ipcRenderer.invoke("desktop:probe-instance-urls", urls)');
  });

  test("applies the stored proxy session at startup and on updates", () => {
    expect(mainSource).toContain("await session.defaultSession.setProxy(startupProxySessionConfig(proxySettings));");
    expect(mainSource).toContain('ipcMain.on("desktop:proxy-settings-sync"');
    expect(mainSource).toContain('ipcMain.handle("desktop:set-proxy-settings"');
    expect(mainSource).toContain('ipcMain.handle("desktop:probe-proxy-for-session"');
    expect(mainSource).toContain("await loadProxySettings();");
  });

  test("cancels proxy credential prompts instead of hanging", () => {
    expect(mainSource).toContain('app.on("login", (event, _webContents, _authenticationResponseDetails, authInfo, callback) => {');
    expect(mainSource).toContain("if (!authInfo?.isProxy) return;");
    expect(mainSource).toContain("callback();");
  });
});
