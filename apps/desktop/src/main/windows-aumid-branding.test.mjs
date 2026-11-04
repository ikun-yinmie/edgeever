import { describe, expect, test } from "bun:test";
import {
  buildAumidRegistrationArgs,
  buildAumidResetArgs,
  syncWindowsAumidBranding,
  windowsAppUserModelIdRegistryKey,
} from "./windows-aumid-branding.mjs";

describe("windows AUMID branding registration", () => {
  test("builds the per-user key for the desktop app id", () => {
    expect(windowsAppUserModelIdRegistryKey("org.edgeever.desktop"))
      .toBe("HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop");
    expect(windowsAppUserModelIdRegistryKey("  ")).toBeNull();
    expect(windowsAppUserModelIdRegistryKey(null)).toBeNull();
  });

  test("writes DisplayName and IconUri in a single reg add", () => {
    expect(buildAumidRegistrationArgs({
      aumid: "org.edgeever.desktop",
      name: "岁玥史书",
      iconPath: "C:\\Users\\me\\AppData\\Roaming\\EdgeEver\\branding-icon-a1b2.ico",
    })).toEqual([
      "add",
      "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop",
      "/f",
      "/v", "DisplayName", "/t", "REG_SZ", "/d", "岁玥史书",
      "/v", "IconUri", "/t", "REG_SZ", "/d",
      "C:\\Users\\me\\AppData\\Roaming\\EdgeEver\\branding-icon-a1b2.ico",
    ]);
  });

  test("omits IconUri when no custom icon exists", () => {
    const args = buildAumidRegistrationArgs({
      aumid: "org.edgeever.desktop",
      name: "EdgeEver",
      iconPath: null,
    });
    expect(args).not.toContain("IconUri");
    expect(args).toEqual([
      "add",
      "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop",
      "/f",
      "/v", "DisplayName", "/t", "REG_SZ", "/d", "EdgeEver",
    ]);
    expect(buildAumidRegistrationArgs({ aumid: null, name: "x", iconPath: "y" })).toBeNull();
  });

  test("resets only the icon value so the executable icon wins again", () => {
    expect(buildAumidResetArgs({ aumid: "org.edgeever.desktop", value: "IconUri" })).toEqual([
      "delete",
      "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop",
      "/v", "IconUri", "/f",
    ]);
    expect(buildAumidResetArgs({ aumid: "org.edgeever.desktop", value: "" })).toBeNull();
  });

  test("applies and resets through the injected reg runner", () => {
    const calls = [];
    const ok = syncWindowsAumidBranding({
      aumid: "org.edgeever.desktop",
      name: "Custom",
      iconPath: "C:\\icon.ico",
      runReg: (args) => { calls.push(args); return { ok: true }; },
    });
    expect(ok.ok).toBe(true);
    expect(ok.applied).toEqual(["IconUri"]);
    expect(calls).toHaveLength(1);

    const resetCalls = [];
    syncWindowsAumidBranding({
      aumid: "org.edgeever.desktop",
      name: "EdgeEver",
      iconPath: null,
      runReg: (args) => { resetCalls.push(args); return { ok: true }; },
    });
    expect(resetCalls.map((args) => args[1])).toEqual([
      "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop",
      "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop",
    ]);
    expect(resetCalls[0]).toContain("DisplayName");
    expect(resetCalls[1]).toEqual([
      "delete",
      "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop",
      "/v", "IconUri", "/f",
    ]);
  });

  test("reports failure without throwing when the registry is locked", () => {
    const result = syncWindowsAumidBranding({
      aumid: "org.edgeever.desktop",
      name: "Custom",
      iconPath: "C:\\icon.ico",
      runReg: () => ({ ok: false, stderr: "access denied" }),
    });
    expect(result).toEqual({ ok: false, applied: [] });
    expect(syncWindowsAumidBranding({ aumid: "x", name: "y", iconPath: "z" })).toEqual({ ok: false, applied: [] });
  });
});
