import { describe, expect, test } from "bun:test";
import {
  PROXY_SPEED_MARGIN_MS,
  chooseFasterRoute,
  normalizeProxySettings,
  proxyRulesFor,
  proxySessionConfig,
  startupProxySessionConfig,
} from "./network-proxy.mjs";

describe("desktop proxy settings", () => {
  test("normalizes valid settings and defaults the protocol", () => {
    expect(normalizeProxySettings({ mode: "auto", host: " 127.0.0.1 ", port: 7890 })).toEqual({
      mode: "auto",
      protocol: "http",
      host: "127.0.0.1",
      port: 7890,
    });
    expect(normalizeProxySettings({ mode: "always", protocol: "socks5", host: "proxy.local", port: "1080" })).toEqual({
      mode: "always",
      protocol: "socks5",
      host: "proxy.local",
      port: 1080,
    });
  });

  test("rejects unknown modes and unusable proxy endpoints", () => {
    expect(normalizeProxySettings(null)).toBeNull();
    expect(normalizeProxySettings({ mode: "sometimes", host: "127.0.0.1", port: 7890 })).toBeNull();
    expect(normalizeProxySettings({ mode: "auto", host: "", port: 7890 })).toBeNull();
    expect(normalizeProxySettings({ mode: "auto", host: "127.0.0.1", port: 0 })).toBeNull();
    expect(normalizeProxySettings({ mode: "always", host: "127.0.0.1", port: 70000 })).toBeNull();
    expect(normalizeProxySettings({ mode: "auto", host: "bad host", port: 7890 })).toBeNull();
    expect(normalizeProxySettings({ mode: "off", host: "", port: 0 })).toEqual({
      mode: "off",
      protocol: "http",
      host: "",
      port: 0,
    });
  });

  test("builds protocol specific proxy rules with localhost bypass", () => {
    expect(proxyRulesFor({ mode: "auto", protocol: "http", host: "127.0.0.1", port: 7890 })).toBe(
      "http=127.0.0.1:7890;https=127.0.0.1:7890"
    );
    expect(proxyRulesFor({ mode: "always", protocol: "socks5", host: "10.0.0.2", port: 1080 })).toBe("socks=10.0.0.2:1080");
    expect(proxyRulesFor({ mode: "off", protocol: "http", host: "127.0.0.1", port: 7890 })).toBe("");
    expect(proxySessionConfig({ mode: "auto", protocol: "http", host: "127.0.0.1", port: 7890 })).toEqual({
      mode: "fixed_servers",
      proxyRules: "http=127.0.0.1:7890;https=127.0.0.1:7890",
      proxyBypassRules: "<local>",
    });
    expect(proxySessionConfig({ mode: "off", protocol: "http", host: "", port: 0 })).toEqual({ mode: "direct" });
  });

  test("starts direct for auto and off, and proxied only for always", () => {
    const settings = { mode: "auto", protocol: "http", host: "127.0.0.1", port: 7890 };
    expect(startupProxySessionConfig(settings)).toEqual({ mode: "direct" });
    expect(startupProxySessionConfig({ ...settings, mode: "always" })).toMatchObject({ mode: "fixed_servers" });
    expect(startupProxySessionConfig(null)).toEqual({ mode: "direct" });
  });

  test("picks the faster measured route with a direct bias on near ties", () => {
    expect(chooseFasterRoute(120, 340)).toBe("direct");
    expect(chooseFasterRoute(400, 180)).toBe("proxy");
    expect(chooseFasterRoute(null, 300)).toBe("proxy");
    expect(chooseFasterRoute(300, null)).toBe("direct");
    expect(chooseFasterRoute(null, null)).toBe("direct");
    expect(chooseFasterRoute(300, 300 - PROXY_SPEED_MARGIN_MS + 1)).toBe("direct");
    expect(chooseFasterRoute(300, 300 - PROXY_SPEED_MARGIN_MS - 1)).toBe("proxy");
  });
});
