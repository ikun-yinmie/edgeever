import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLIENT_BRANDING_FILE = "client-branding.json";
export const BRANDING_ICON_FILE = "branding-icon.png";
export const BRANDING_TRAY_ICON_FILE = "branding-tray-icon.png";
export const CLIENT_BRANDING_VERSION = 1;
export const DEFAULT_CLIENT_NAME = "EdgeEver";

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

export const materializeBrandingFiles = (userDataDir, effectiveIcon) => {
  if (!userDataDir || typeof userDataDir !== "string") {
    return { iconPath: null, hasIcon: false };
  }
  const iconPath = join(userDataDir, BRANDING_ICON_FILE);
  const trayIconPath = join(userDataDir, BRANDING_TRAY_ICON_FILE);

  const buffer = dataUrlToBuffer(effectiveIcon);
  if (!buffer || buffer.length === 0) {
    try {
      if (existsSync(iconPath)) rmSync(iconPath, { force: true });
      if (existsSync(trayIconPath)) rmSync(trayIconPath, { force: true });
    } catch {
      // ignore
    }
    return { iconPath: null, hasIcon: false };
  }

  try {
    if (!existsSync(userDataDir)) {
      mkdirSync(userDataDir, { recursive: true });
    }
    writeFileSync(iconPath, buffer);
    return { iconPath, hasIcon: true };
  } catch {
    return { iconPath: null, hasIcon: false };
  }
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
