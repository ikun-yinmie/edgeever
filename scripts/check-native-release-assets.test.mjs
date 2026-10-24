import { describe, expect, test } from "bun:test";
import { nativeReleaseAssetsReady } from "./check-native-release-assets.mjs";

describe("Windows/Linux release asset readiness", () => {
  const assets = (version, { signature = true } = {}) => [
    `EdgeEver-${version}-windows-x64.exe`,
    "latest.yml",
    "latest-windows.json",
    ...(signature ? ["latest-windows.json.sig"] : []),
    "SHA256SUMS-windows.txt",
    `EdgeEver-${version}-linux-x64.AppImage`,
    "latest-linux.yml",
    "SHA256SUMS-linux.txt",
  ];

  test("accepts matching reused Windows/Linux assets", () => {
    expect(nativeReleaseAssetsReady({
      platform: "desktop", rebuild: false, currentTag: "v1.6.35", desktopVersion: "1.6.35", assetNames: assets("1.6.33"),
    })).toBe(true);
  });

  test("requires current Windows/Linux assets after rebuild", () => {
    expect(nativeReleaseAssetsReady({
      platform: "desktop", rebuild: true, currentTag: "v1.6.35", desktopVersion: "1.6.35", assetNames: assets("1.6.35"),
    })).toBe(true);
    expect(nativeReleaseAssetsReady({
      platform: "desktop", rebuild: true, currentTag: "v1.6.35", desktopVersion: "1.6.35", assetNames: assets("1.6.34"),
    })).toBe(false);
  });

  test("requires both Windows and Linux installers", () => {
    expect(nativeReleaseAssetsReady({
      platform: "desktop", rebuild: true, currentTag: "v1.6.35", desktopVersion: "1.6.35", assetNames: assets("1.6.35").slice(0, 5),
    })).toBe(false);
  });

  test("allows CI staging to omit only the offline signature", () => {
    const names = assets("1.6.35", { signature: false });
    expect(nativeReleaseAssetsReady({
      platform: "desktop", rebuild: true, currentTag: "v1.6.35", desktopVersion: "1.6.35", assetNames: names, requireWindowsSignature: false,
    })).toBe(true);
    expect(nativeReleaseAssetsReady({
      platform: "desktop", rebuild: true, currentTag: "v1.6.35", desktopVersion: "1.6.35", assetNames: names,
    })).toBe(false);
  });
});
