import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const nativeReleaseAssetsReady = ({
  platform,
  rebuild,
  currentTag,
  desktopVersion,
  assetNames,
  requireWindowsSignature = true,
}) => {
  if (platform === "mobile") {
    const apkNames = assetNames.filter((name) =>
      /^edgeever-android-v.*-arm64-v8a\.apk$/.test(name),
    );
    if (apkNames.length !== 1) return false;
    return (
      !rebuild ||
      apkNames[0] === `edgeever-android-${currentTag}-arm64-v8a.apk`
    );
  }

  if (platform === "desktop") {
    const versions = new Set();
    const windowsInstallerNames = assetNames.filter((name) =>
      /^EdgeEver-(.+)-windows-x64\.exe$/.test(name)
    );
    if (windowsInstallerNames.length !== 1) return false;
    const windowsVersion = /^EdgeEver-(.+)-windows-x64\.exe$/
      .exec(windowsInstallerNames[0])?.[1];
    if (!windowsVersion) return false;
    versions.add(windowsVersion);
    const linuxAppImageNames = assetNames.filter((name) =>
      /^EdgeEver-(.+)-linux-x64\.AppImage$/.test(name)
    );
    if (linuxAppImageNames.length !== 1) return false;
    const linuxVersion = /^EdgeEver-(.+)-linux-x64\.AppImage$/
      .exec(linuxAppImageNames[0])?.[1];
    if (!linuxVersion) return false;
    versions.add(linuxVersion);
    for (const name of [
      "latest.yml",
      "latest-windows.json",
      "SHA256SUMS-windows.txt",
      "latest-linux.yml",
      "SHA256SUMS-linux.txt",
    ]) {
      if (assetNames.filter((assetName) => assetName === name).length !== 1) {
        return false;
      }
    }
    const signatureCount = assetNames.filter(
      (name) => name === "latest-windows.json.sig",
    ).length;
    if (requireWindowsSignature ? signatureCount !== 1 : signatureCount > 1) {
      return false;
    }
    return (
      versions.size === 1 &&
      (!rebuild || versions.has(desktopVersion)) &&
      assetNames.filter((name) => name === "latest-mac.yml").length === 0
    );
  }

  throw new Error(`Unsupported native release platform: ${platform}`);
};

const run = () => {
  const [platform, rebuildValue, currentTag, desktopVersion = "", signatureMode = "required"] =
    process.argv.slice(2);
  if (
    !["mobile", "desktop"].includes(platform) ||
    !["true", "false"].includes(rebuildValue) ||
    !currentTag ||
    !["required", "allow-missing-windows-signature"].includes(signatureMode)
  ) {
    console.error(
      "Usage: node scripts/check-native-release-assets.mjs <mobile|desktop> <true|false> <current-tag> [desktop-version] [required|allow-missing-windows-signature]",
    );
    process.exit(1);
  }

  const assetNames = readFileSync(0, "utf8").split("\n").filter(Boolean);
  process.stdout.write(
    String(
      nativeReleaseAssetsReady({
        platform,
        rebuild: rebuildValue === "true",
        currentTag,
        desktopVersion,
        assetNames,
        requireWindowsSignature: signatureMode === "required",
      }),
    ),
  );
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
