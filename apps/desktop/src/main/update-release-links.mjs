// The updater can fail for reasons the user cannot fix from inside the app
// (an unsigned manifest that has not been published yet, a release asset that
// is still uploading, or a network path that blocks GitHub). In those cases the
// settings card must still offer a way to get the new build, so the main
// process publishes concrete release/download URLs together with the status.

export const UPDATE_RELEASE_REPOSITORY = "ikun-yinmie/edgeever";

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

const normalizedArch = (arch) => {
  if (arch === "arm64") return "arm64";
  if (arch === "x64" || arch === "amd64") return "x64";
  return null;
};

/**
 * Release asset names follow electron-builder's artifactName templates in
 * apps/desktop/electron-builder.yml. Only the combinations the project
 * actually publishes are returned; anything else falls back to the release
 * page so the UI never links to a 404.
 */
export const desktopReleaseAssetName = ({ platform, arch, version }) => {
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) return null;
  const targetArch = normalizedArch(arch);
  if (!targetArch) return null;

  if (platform === "win32") {
    return targetArch === "x64" ? `EdgeEver-${version}-windows-x64.exe` : null;
  }
  if (platform === "darwin") {
    return `EdgeEver-${version}-mac-${targetArch}.dmg`;
  }
  if (platform === "linux") {
    return targetArch === "x64" ? `EdgeEver-${version}-linux-x64.AppImage` : null;
  }
  return null;
};

export const desktopReleaseLinks = ({
  platform,
  arch,
  version,
  repository = UPDATE_RELEASE_REPOSITORY,
} = {}) => {
  const base = `https://github.com/${repository}/releases`;
  const releaseTag = typeof version === "string" && STABLE_VERSION.test(version) ? `v${version}` : null;
  const assetName = desktopReleaseAssetName({ platform, arch, version });
  return {
    assetName,
    releaseTag,
    releasePageUrl: releaseTag ? `${base}/tag/${releaseTag}` : `${base}/latest`,
    downloadUrl: assetName && releaseTag ? `${base}/download/${releaseTag}/${assetName}` : `${base}/latest`,
  };
};
