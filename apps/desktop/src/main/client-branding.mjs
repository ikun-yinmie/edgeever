import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLIENT_BRANDING_FILE = "client-branding.json";
export const BRANDING_ICON_FILE = "branding-icon.png";
export const BRANDING_ICON_ICO_FILE = "branding-icon.ico";
export const BRANDING_ICON_ICO_PREFIX = "branding-icon-";
export const BRANDING_TRAY_ICON_FILE = "branding-tray-icon.png";
export const CLIENT_BRANDING_VERSION = 1;
export const DEFAULT_CLIENT_NAME = "EdgeEver";
export const WINDOWS_APP_USER_MODEL_ID = "org.edgeever.desktop";

export const dataUrlToBuffer = (dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;
  try {
    const base64Data = dataUrl.slice(commaIndex + 1).trim();
    if (!base64Data) return null;
    return Buffer.from(base64Data, "base64");
  } catch {
    return null;
  }
};

export const createIcoBufferFromPngBuffers = (pngEntries) => {
  if (!Array.isArray(pngEntries) || pngEntries.length === 0) return null;
  const validEntries = pngEntries.filter((e) => e && Buffer.isBuffer(e.buffer) && e.buffer.length > 0);
  if (validEntries.length === 0) return null;

  const count = validEntries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const directoryEntries = [];
  const imageBuffers = [];

  for (const { width, height, buffer } of validEntries) {
    const w = typeof width === "number" && width > 0 ? width : 256;
    const h = typeof height === "number" && height > 0 ? height : 256;
    const entry = Buffer.alloc(16);
    entry.writeUInt8(w >= 256 ? 0 : w, 0);
    entry.writeUInt8(h >= 256 ? 0 : h, 1);
    entry.writeUInt8(0, 2); // color palette count (0 for >=8bpp)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buffer.length, 8); // image size in bytes
    entry.writeUInt32LE(offset, 12); // image offset in file

    directoryEntries.push(entry);
    imageBuffers.push(buffer);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...directoryEntries, ...imageBuffers]);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isPngBuffer = (buffer) => Buffer.isBuffer(buffer)
  && buffer.length >= PNG_SIGNATURE.length
  && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

const brandingIconHash = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 16);

export const materializeBrandingFiles = (userDataDir, effectiveIcon, { nativeImageProvider } = {}) => {
  if (!userDataDir || typeof userDataDir !== "string") {
    return { iconPath: null, icoPath: null, trayIconPath: null, hasIcon: false };
  }
  const iconPath = join(userDataDir, BRANDING_ICON_FILE);
  const trayIconPath = join(userDataDir, BRANDING_TRAY_ICON_FILE);

  if (!effectiveIcon) {
    try {
      if (existsSync(iconPath)) rmSync(iconPath, { force: true });
      if (existsSync(trayIconPath)) rmSync(trayIconPath, { force: true });
    } catch {
      // Keep existing ICO files because older pinned shortcuts can still reference them.
    }
    return { iconPath: null, icoPath: null, trayIconPath: null, hasIcon: false };
  }

  const buffer = dataUrlToBuffer(effectiveIcon);
  if (!buffer || buffer.length === 0) {
    return { iconPath: null, icoPath: null, trayIconPath: null, hasIcon: false };
  }

  try {
    if (!existsSync(userDataDir)) {
      mkdirSync(userDataDir, { recursive: true });
    }

    let normalizedPng = null;
    let icoBuffer = null;
    let trayBuffer = null;
    if (typeof nativeImageProvider === "function") {
      try {
        const nativeImg = nativeImageProvider(buffer);
        if (nativeImg && !nativeImg.isEmpty()) {
          const sourcePng = nativeImg.toPNG();
          if (sourcePng && sourcePng.length > 0) normalizedPng = sourcePng;

          const sizes = [16, 24, 32, 48, 64, 128, 256];
          const entries = [];
          for (const size of sizes) {
            const resized = nativeImg.resize({ width: size, height: size, quality: "high" });
            const pngBuffer = resized.toPNG();
            if (pngBuffer && pngBuffer.length > 0) {
              entries.push({ width: size, height: size, buffer: pngBuffer });
            }
          }
          if (entries.length > 0) {
            icoBuffer = createIcoBufferFromPngBuffers(entries);
          }
          const trayResized = nativeImg.resize({ width: 32, height: 32, quality: "high" });
          trayBuffer = trayResized.toPNG();
        }
      } catch {
        // A valid PNG can still use the file-level fallback below.
      }
    }

    if (!normalizedPng && isPngBuffer(buffer)) normalizedPng = buffer;
    if (!normalizedPng) {
      return { iconPath: null, icoPath: null, trayIconPath: null, hasIcon: false };
    }
    if (!icoBuffer) {
      icoBuffer = createIcoBufferFromPngBuffers([{ width: 256, height: 256, buffer: normalizedPng }]);
    }
    if (!icoBuffer) {
      return { iconPath: null, icoPath: null, trayIconPath: null, hasIcon: false };
    }

    const icoPath = join(userDataDir, `${BRANDING_ICON_ICO_PREFIX}${brandingIconHash(normalizedPng)}.ico`);
    writeFileSync(iconPath, normalizedPng);
    writeFileSync(icoPath, icoBuffer);
    writeFileSync(trayIconPath, trayBuffer && trayBuffer.length > 0 ? trayBuffer : normalizedPng);

    return { iconPath, icoPath, trayIconPath, hasIcon: true };
  } catch {
    return { iconPath: null, icoPath: null, trayIconPath: null, hasIcon: false };
  }
};

export const syncWindowsShortcuts = ({
  appDataDir,
  desktopDir,
  execPath,
  name,
  icoPath,
  appUserModelId = WINDOWS_APP_USER_MODEL_ID,
  shellWriter,
}) => {
  const safeName = (typeof name === "string" && name.trim()) ? name.trim() : DEFAULT_CLIENT_NAME;
  const safeExec = (typeof execPath === "string" && execPath.trim()) ? execPath.trim() : "";
  const customIconPath = (typeof icoPath === "string" && icoPath.trim() && existsSync(icoPath)) ? icoPath.trim() : null;
  const shortcutIconPath = customIconPath || safeExec;
  if (typeof shellWriter !== "function" || !shortcutIconPath) {
    return { updated: 0, failed: 0 };
  }

  const targetShortcutNames = new Set([
    "EdgeEver.lnk",
    `${safeName}.lnk`,
  ]);

  const candidateDirectories = [];
  if (appDataDir && typeof appDataDir === "string") {
    candidateDirectories.push(
      join(appDataDir, "Microsoft", "Windows", "Start Menu", "Programs"),
      join(appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", "EdgeEver"),
      join(appDataDir, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
    );
  }
  if (desktopDir && typeof desktopDir === "string") {
    candidateDirectories.push(desktopDir);
  }

  let updated = 0;
  let failed = 0;

  for (const dir of candidateDirectories) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.toLowerCase().endsWith(".lnk")) continue;
        const matchesName = targetShortcutNames.has(file);
        const matchesEdgeEver = file.toLowerCase().includes("edgeever");
        if (!matchesName && !matchesEdgeEver) continue;

        const shortcutPath = join(dir, file);
        try {
          const ok = shellWriter(shortcutPath, "update", {
            target: safeExec || undefined,
            description: safeName,
            icon: shortcutIconPath,
            iconIndex: 0,
            appUserModelId,
          });
          if (ok) {
            updated++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
    } catch {
      // ignore directory access error
    }
  }

  return { updated, failed };
};

export const buildWindowsTaskbarAppDetails = ({
  appUserModelId = WINDOWS_APP_USER_MODEL_ID,
  iconPath,
  execPath,
  name,
  packaged = false,
}) => {
  const safeExec = typeof execPath === "string" ? execPath.trim() : "";
  const safeIcon = typeof iconPath === "string" ? iconPath.trim() : "";
  const safeName = typeof name === "string" && name.trim() ? name.trim() : DEFAULT_CLIENT_NAME;
  const details = {
    appId: appUserModelId,
    ...(safeIcon || safeExec ? { appIconPath: safeIcon || safeExec, appIconIndex: 0 } : {}),
  };

  if (packaged && safeExec) {
    details.relaunchCommand = `"${safeExec}"`;
    details.relaunchDisplayName = safeName;
  }
  return details;
};

export const buildLinuxDesktopEntryContent = ({ name, execPath, iconPath }) => {
  const safeName = (typeof name === "string" && name.trim()) ? name.trim() : DEFAULT_CLIENT_NAME;
  const safeExec = (typeof execPath === "string" && execPath.trim()) ? execPath.trim() : "EdgeEver";
  const iconLine = (typeof iconPath === "string" && iconPath.trim()) ? `Icon=${iconPath.trim()}` : "Icon=EdgeEver";

  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${safeName}`,
    "Comment=EdgeEver Desktop Client",
    `Exec="${safeExec}" %U`,
    iconLine,
    "Terminal=false",
    "StartupWMClass=EdgeEver",
    "Categories=Utility;Office;",
    "MimeType=x-scheme-handler/edgeever;text/markdown;",
    "",
  ].join("\n");
};

export const syncLinuxDesktopEntry = ({ applicationsDir, execPath, name, iconPath }) => {
  if (!applicationsDir || typeof applicationsDir !== "string") return false;
  try {
    if (!existsSync(applicationsDir)) {
      mkdirSync(applicationsDir, { recursive: true });
    }
    const content = buildLinuxDesktopEntryContent({ name, execPath, iconPath });
    const targetNames = ["edgeever.desktop", "EdgeEver.desktop", "org.edgeever.desktop"];
    for (const file of targetNames) {
      try {
        writeFileSync(join(applicationsDir, file), content, "utf8");
      } catch {
        // ignore single write error
      }
    }
    return true;
  } catch {
    return false;
  }
};

export const normalizeClientBranding = (value) => {
  const input = value && typeof value === "object" ? value : {};
  const cleanString = (val) => (typeof val === "string" && val.trim() ? val.trim() : null);

  return {
    customName: cleanString(input.customName),
    customIcon: cleanString(input.customIcon),
    serverName: cleanString(input.serverName),
    serverIcon: cleanString(input.serverIcon),
  };
};

export const resolveEffectiveBranding = (value) => {
  const normalized = normalizeClientBranding(value);

  const customName = normalized.customName;
  const serverName = normalized.serverName;
  let effectiveName = DEFAULT_CLIENT_NAME;
  let nameSource = "default";

  if (customName) {
    effectiveName = customName;
    nameSource = "custom";
  } else if (serverName) {
    effectiveName = serverName;
    nameSource = "server";
  }

  const customIcon = normalized.customIcon;
  const serverIcon = normalized.serverIcon;
  let effectiveIcon = null;
  let iconSource = "default";

  if (customIcon) {
    effectiveIcon = customIcon;
    iconSource = "custom";
  } else if (serverIcon) {
    effectiveIcon = serverIcon;
    iconSource = "server";
  }

  return {
    ...normalized,
    effectiveName,
    nameSource,
    effectiveIcon,
    iconSource,
  };
};

export const parseClientBranding = (text) => {
  let parsed = null;
  try {
    parsed = typeof text === "string" && text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return normalizeClientBranding(parsed);
};

export const serializeClientBranding = (value) => `${JSON.stringify({
  version: CLIENT_BRANDING_VERSION,
  ...normalizeClientBranding(value),
}, null, 2)}\n`;

export const readClientBranding = (userDataDir) => {
  if (!userDataDir || typeof userDataDir !== "string") {
    return normalizeClientBranding(null);
  }
  const filePath = join(userDataDir, CLIENT_BRANDING_FILE);
  if (!existsSync(filePath)) {
    return normalizeClientBranding(null);
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseClientBranding(raw);
  } catch {
    return normalizeClientBranding(null);
  }
};

export const writeClientBranding = (userDataDir, config) => {
  if (!userDataDir || typeof userDataDir !== "string") return false;
  const filePath = join(userDataDir, CLIENT_BRANDING_FILE);
  try {
    const serialized = serializeClientBranding(config);
    writeFileSync(filePath, serialized, "utf8");
    return true;
  } catch {
    return false;
  }
};
