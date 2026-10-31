import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLIENT_BRANDING_FILE = "client-branding.json";
export const CLIENT_BRANDING_VERSION = 1;
export const DEFAULT_CLIENT_NAME = "EdgeEver";

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
