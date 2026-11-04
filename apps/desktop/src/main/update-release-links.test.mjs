import { describe, expect, test } from "bun:test";
import { desktopReleaseAssetName, desktopReleaseLinks } from "./update-release-links.mjs";

describe("desktop release links", () => {
  test("builds the Windows installer URL that matches the artifact name template", () => {
    expect(desktopReleaseAssetName({ platform: "win32", arch: "x64", version: "1.103.11" }))
      .toBe("EdgeEver-1.103.11-windows-x64.exe");
    expect(desktopReleaseLinks({ platform: "win32", arch: "x64", version: "1.103.11" })).toEqual({
      assetName: "EdgeEver-1.103.11-windows-x64.exe",
      releaseTag: "v1.103.11",
      releasePageUrl: "https://github.com/ikun-yinmie/edgeever/releases/tag/v1.103.11",
      downloadUrl: "https://github.com/ikun-yinmie/edgeever/releases/download/v1.103.11/EdgeEver-1.103.11-windows-x64.exe",
    });
  });

  test("covers the macOS and Linux artifact names", () => {
    expect(desktopReleaseAssetName({ platform: "darwin", arch: "arm64", version: "1.103.11" }))
      .toBe("EdgeEver-1.103.11-mac-arm64.dmg");
    expect(desktopReleaseAssetName({ platform: "darwin", arch: "x64", version: "1.103.11" }))
      .toBe("EdgeEver-1.103.11-mac-x64.dmg");
    expect(desktopReleaseAssetName({ platform: "linux", arch: "x64", version: "1.103.11" }))
      .toBe("EdgeEver-1.103.11-linux-x64.AppImage");
  });

  test("falls back to the release page instead of guessing a missing asset", () => {
    for (const input of [
      { platform: "win32", arch: "arm64", version: "1.103.11" },
      { platform: "linux", arch: "arm64", version: "1.103.11" },
      { platform: "win32", arch: "x64", version: "1.103.11-beta.1" },
      { platform: "win32", arch: "x64", version: null },
    ]) {
      const links = desktopReleaseLinks(input);
      expect(links.assetName).toBeNull();
      expect(links.downloadUrl).toBe("https://github.com/ikun-yinmie/edgeever/releases/latest");
      const stableVersion = typeof input.version === "string" && /^\d+\.\d+\.\d+$/.test(input.version);
      expect(links.releasePageUrl).toBe(stableVersion
        ? `https://github.com/ikun-yinmie/edgeever/releases/tag/v${input.version}`
        : "https://github.com/ikun-yinmie/edgeever/releases/latest");
    }
  });

  test("keeps the release page on the exact tag when the version is known", () => {
    const links = desktopReleaseLinks({ platform: "win32", arch: "x64", version: "2.0.0" });
    expect(links.releasePageUrl).toContain("/releases/tag/v2.0.0");
  });
});
