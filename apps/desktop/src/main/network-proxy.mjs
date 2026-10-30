export const PROXY_MODES = ["off", "auto", "always"];
export const PROXY_PROTOCOLS = ["http", "socks5"];
export const PROXY_SPEED_MARGIN_MS = 25;

const HOST_PATTERN = /^[a-z0-9._\-[\]:]+$/i;

export const normalizeProxySettings = (input) => {
  if (!input || typeof input !== "object") return null;
  const mode = PROXY_MODES.includes(input.mode) ? input.mode : null;
  if (!mode) return null;

  const protocol = PROXY_PROTOCOLS.includes(input.protocol) ? input.protocol : "http";
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const port = typeof input.port === "number" && Number.isInteger(input.port)
    ? input.port
    : Number.parseInt(String(input.port ?? ""), 10);
  const settings = { mode, protocol, host, port: Number.isInteger(port) ? port : 0 };

  if (mode === "off") return settings;
  if (!host || host.length > 255 || !HOST_PATTERN.test(host)) return null;
  if (!(settings.port >= 1 && settings.port <= 65535)) return null;
  return settings;
};

export const proxyRulesFor = (settings) => {
  if (!settings || settings.mode === "off" || !settings.host || !(settings.port >= 1)) return "";
  const server = `${settings.host}:${settings.port}`;
  // Chromium ignores unknown per-scheme tokens ("socks5=host:port" falls back
  // to DIRECT) and maps a bare "socks" scheme to SOCKS4. The SOCKS5 variant is
  // expressed as a socks entry with an explicit socks5:// URL.
  return settings.protocol === "socks5" ? `socks=socks5://${server}` : `http=${server};https=${server}`;
};

export const proxySessionConfig = (settings) => {
  const rules = proxyRulesFor(settings);
  if (!rules) return { mode: "direct" };
  return { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: "<local>" };
};

/**
 * Startup policy: only an explicit "always" uses the proxy before the first
 * login probe. "auto" waits for the probe so a slow proxy never delays the
 * session restore of a reachable server.
 */
export const startupProxySessionConfig = (settings) => (
  settings?.mode === "always" ? proxySessionConfig(settings) : { mode: "direct" }
);

/**
 * Update traffic runs in electron-updater's own session partition, so it never
 * sees the proxy chosen for the main session. A configured proxy therefore
 * always covers update checks: the updater cannot probe the instance URL, and
 * a direct route that reaches the instance may still be blocked for GitHub.
 */
export const updaterProxySessionConfig = (settings) => {
  if (!settings || settings.mode === "off") return { mode: "direct" };
  if (!settings.host || !(settings.port >= 1 && settings.port <= 65535)) return { mode: "direct" };
  return proxySessionConfig(settings);
};

export const chooseFasterRoute = (directMs, proxyMs) => {
  if (directMs === null && proxyMs === null) return "direct";
  if (directMs === null) return "proxy";
  if (proxyMs === null) return "direct";
  return proxyMs + PROXY_SPEED_MARGIN_MS < directMs ? "proxy" : "direct";
};
