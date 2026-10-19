export type DesktopProxyMode = "off" | "auto" | "always";
export type DesktopProxyProtocol = "http" | "socks5";

export type DesktopProxySettings = {
  mode: DesktopProxyMode;
  protocol: DesktopProxyProtocol;
  host: string;
  port: number;
};

export type DesktopProxyProbeResult = {
  directMs: number | null;
  proxyMs: number | null;
  chosen: "direct" | "proxy";
};

export const DEFAULT_DESKTOP_PROXY_SETTINGS: DesktopProxySettings = {
  mode: "off",
  protocol: "http",
  host: "",
  port: 0,
};

const PROXY_MODES: DesktopProxyMode[] = ["off", "auto", "always"];
const PROXY_PROTOCOLS: DesktopProxyProtocol[] = ["http", "socks5"];
const PROXY_HOST_PATTERN = /^[a-z0-9._\-[\]:]+$/i;

export const isDesktopProxyConfigured = (settings: DesktopProxySettings) =>
  Boolean(settings.host.trim())
  && PROXY_HOST_PATTERN.test(settings.host.trim())
  && Number.isInteger(settings.port)
  && settings.port >= 1
  && settings.port <= 65535;

export const normalizeDesktopProxySettings = (value: unknown): DesktopProxySettings | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DesktopProxySettings>;
  if (!PROXY_MODES.includes(candidate.mode as DesktopProxyMode)) return null;
  const settings: DesktopProxySettings = {
    mode: candidate.mode as DesktopProxyMode,
    protocol: PROXY_PROTOCOLS.includes(candidate.protocol as DesktopProxyProtocol)
      ? (candidate.protocol as DesktopProxyProtocol)
      : "http",
    host: typeof candidate.host === "string" ? candidate.host.trim() : "",
    port: Number.isInteger(candidate.port) ? (candidate.port as number) : 0,
  };
  if (settings.mode === "off") return settings;
  return isDesktopProxyConfigured(settings) ? settings : null;
};

const proxyBridge = () => (
  typeof window === "undefined" ? undefined : window.edgeeverDesktop
);

export const getDesktopProxySettings = (): DesktopProxySettings => {
  const bridge = proxyBridge();
  if (!bridge?.getProxySettings) return DEFAULT_DESKTOP_PROXY_SETTINGS;
  try {
    return normalizeDesktopProxySettings(bridge.getProxySettings()) ?? DEFAULT_DESKTOP_PROXY_SETTINGS;
  } catch {
    return DEFAULT_DESKTOP_PROXY_SETTINGS;
  }
};

export const saveDesktopProxySettings = async (settings: DesktopProxySettings) => {
  const normalized = normalizeDesktopProxySettings(settings);
  if (!normalized) throw new Error("Invalid desktop proxy settings");
  const bridge = proxyBridge();
  if (!bridge?.setProxySettings) return normalized;
  return normalizeDesktopProxySettings(await bridge.setProxySettings(normalized)) ?? normalized;
};

export const probeDesktopProxyForSession = async (baseUrl: string): Promise<DesktopProxyProbeResult | null> => {
  const bridge = proxyBridge();
  if (!bridge?.probeProxyForSession) return null;
  const result = await bridge.probeProxyForSession(baseUrl);
  if (!result || typeof result !== "object") return null;
  return {
    directMs: typeof result.directMs === "number" ? result.directMs : null,
    proxyMs: typeof result.proxyMs === "number" ? result.proxyMs : null,
    chosen: result.chosen === "proxy" ? "proxy" : "direct",
  };
};
