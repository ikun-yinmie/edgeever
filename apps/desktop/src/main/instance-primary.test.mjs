import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const mainSource = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");

describe("desktop primary instance identity", () => {
  test("keys account data scope by the primary address only", () => {
    expect(mainSource).toContain('const primaryApiBaseUrlPath = () => join(app.getPath("userData"), "instance-primary-url");');
    expect(mainSource).toContain("primaryApiBaseUrl = configuredApiBaseUrl;");
    expect(mainSource).toContain("accountDataDirectory(root, primaryApiBaseUrl, accountId)");
    expect(mainSource).toContain("sidecarScopeKey = accountScopeKey(primaryApiBaseUrl, accountId);");
    expect(mainSource).toContain("const nextScopeKey = accountScopeKey(primaryApiBaseUrl, normalizedAccountId);");
    expect(mainSource).not.toContain("accountScopeKey(configuredApiBaseUrl");
  });

  test("restarts the sidecar only when the scope actually changes", () => {
    expect(mainSource).toContain('ipcMain.handle("desktop:set-api-base-url"');
    expect(mainSource).toContain('ipcMain.handle("desktop:set-primary-api-base-url"');
    expect(mainSource).toContain("if (sidecar && sidecarScopeKey !== nextScopeKey) {");
    expect(mainSource).toContain("await loadPrimaryApiBaseUrl();");
  });

  test("probes candidate addresses from the main window only", () => {
    expect(mainSource).toContain('ipcMain.handle("desktop:probe-instance-urls"');
    expect(mainSource).toContain('throw new Error("Instance probes must come from the main window");');
    expect(mainSource).toContain("net.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(proxyProbeTimeoutMs) })");
  });
});
