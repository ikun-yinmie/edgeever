import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  buildAumidRegistrationArgs,
  buildAumidResetArgs,
  syncWindowsAumidBranding,
  windowsAppUserModelIdRegistryKey,
} from "./windows-aumid-branding.mjs";

const aumid = "org.edgeever.desktop";
const key = "HKCU\\Software\\Classes\\AppUserModelId\\org.edgeever.desktop";
const name = "岁玥史书";
const iconPath = "C:\\Users\\me\\AppData\\Roaming\\EdgeEver\\branding-icon-a1b2.ico";

describe("windows AUMID branding registration", () => {
  test("builds the per-user key for the desktop app id", () => {
    expect(windowsAppUserModelIdRegistryKey(aumid)).toBe(key);
    expect(windowsAppUserModelIdRegistryKey("  ")).toBeNull();
    expect(windowsAppUserModelIdRegistryKey(null)).toBeNull();
  });

  test("writes DisplayName and IconUri in separate valid reg add calls", () => {
    expect(buildAumidRegistrationArgs({ aumid, name, iconPath })).toEqual([
      ["add", key, "/f", "/v", "DisplayName", "/t", "REG_SZ", "/d", name],
      ["add", key, "/f", "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath],
    ]);
    expect(buildAumidRegistrationArgs({ aumid, name, iconPath: null })).toHaveLength(1);
    expect(buildAumidRegistrationArgs({ aumid: null, name, iconPath })).toEqual([]);
  });

  test("resets only the icon value", () => {
    expect(buildAumidResetArgs({ aumid, value: "IconUri" })).toEqual(["delete", key, "/v", "IconUri", "/f"]);
    expect(buildAumidResetArgs({ aumid, value: "" })).toBeNull();
  });

  test("records both applied values and attempts the icon even if name writing fails", () => {
    const calls = [];
    expect(syncWindowsAumidBranding({ aumid, name, iconPath, runReg: (args) => {
      calls.push(args);
      return { ok: true };
    } })).toEqual({ ok: true, applied: ["DisplayName", "IconUri"], errors: [] });
    expect(calls).toHaveLength(2);
    const partial = syncWindowsAumidBranding({ aumid, name, iconPath, runReg: (args) => ({
      ok: args.includes("IconUri"), stderr: "access denied",
    }) });
    expect(partial.ok).toBe(false);
    expect(partial.applied).toEqual(["IconUri"]);
    expect(partial.errors[0]).toContain("DisplayName");
  });

  test("does not claim success on a denied reset or thrown runner", () => {
    const reset = syncWindowsAumidBranding({ aumid, name, iconPath: null, runReg: (args) => ({
      ok: args[0] !== "delete", stderr: "access denied",
    }) });
    expect(reset.ok).toBe(false);
    expect(reset.applied).toEqual(["DisplayName"]);
    expect(reset.errors[0]).toContain("IconUri(reset)");
    expect(syncWindowsAumidBranding({ aumid, name, iconPath, runReg: () => { throw new Error("blocked"); } }).ok).toBe(false);
    expect(syncWindowsAumidBranding({ aumid, name, iconPath }).ok).toBe(false);
  });

  test("missing IconUri is an idempotent reset when its parent key is accessible", () => {
    const result = syncWindowsAumidBranding({ aumid, name, iconPath: null, runReg: (args) => ({
      ok: args[0] === "add" || (args[0] === "query" && args.length === 2),
    }) });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual(["DisplayName"]);
  });

  test.skipIf(process.platform !== "win32")("real reg.exe rejects the old syntax and applies/reads/resets both values", () => {
    // An isolated test key only. Never mutate the installed app registration.
    const testId = `org.edgeever.branding-test.${randomUUID()}`;
    const testKey = windowsAppUserModelIdRegistryKey(testId);
    const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    const exec = (args) => execFileSync(reg, args, { windowsHide: true, stdio: "pipe", timeout: 5000 });
    const runReg = (args) => {
      try { exec(args); return { ok: true }; }
      catch (error) { return { ok: false, stderr: error.message }; }
    };
    try {
      expect(() => exec(["add", testKey, "/f", "/v", "DisplayName", "/t", "REG_SZ", "/d", name,
        "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath])).toThrow();
      expect(syncWindowsAumidBranding({ aumid: testId, name, iconPath, runReg }).ok).toBe(true);
      // reg query is locale-encoded; compare raw bytes to reg query output with
      // /z omitted only for ASCII path, while the native probe checks Unicode .lnk names.
      expect(exec(["query", testKey, "/v", "DisplayName"]).length).toBeGreaterThan(0);
      expect(exec(["query", testKey, "/v", "IconUri"]).toString()).toContain(iconPath);
      expect(syncWindowsAumidBranding({ aumid: testId, name: "EdgeEver", iconPath: null, runReg }).ok).toBe(true);
      expect(() => exec(["query", testKey, "/v", "IconUri"])).toThrow();
      expect(exec(["query", testKey, "/v", "DisplayName"]).toString()).toContain("EdgeEver");
      expect(syncWindowsAumidBranding({ aumid: testId, name: "EdgeEver", iconPath: null, runReg }).ok).toBe(true);
    } finally {
      exec(["delete", testKey, "/f"]);
    }
  }, 30000);
});
