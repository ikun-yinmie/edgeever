import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DESKTOP_PROXY_SETTINGS,
  isDesktopProxyConfigured,
  normalizeDesktopProxySettings,
} from "./desktop-proxy.ts";

describe("desktop proxy renderer helpers", () => {
  test("defaults to a disabled proxy", () => {
    expect(DEFAULT_DESKTOP_PROXY_SETTINGS).toEqual({ mode: "off", protocol: "http", host: "", port: 0 });
  });

  test("accepts off mode without an endpoint and requires one otherwise", () => {
    expect(normalizeDesktopProxySettings({ mode: "off", protocol: "http", host: "", port: 0 })).toEqual({
      mode: "off",
      protocol: "http",
      host: "",
      port: 0,
    });
    expect(normalizeDesktopProxySettings({ mode: "auto", host: "", port: 7890 })).toBeNull();
    expect(normalizeDesktopProxySettings({ mode: "always", host: "127.0.0.1", port: 0 })).toBeNull();
  });

  test("normalizes protocol, host and port", () => {
    expect(normalizeDesktopProxySettings({ mode: "auto", protocol: "socks5", host: " 127.0.0.1 ", port: 1080 })).toEqual({
      mode: "auto",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
    });
    expect(normalizeDesktopProxySettings({ mode: "auto", protocol: "ftp", host: "127.0.0.1", port: 1080 })).toMatchObject({
      protocol: "http",
    });
    expect(normalizeDesktopProxySettings(null)).toBeNull();
    expect(normalizeDesktopProxySettings("proxy")).toBeNull();
  });

  test("guards the configured endpoint used by probes", () => {
    expect(isDesktopProxyConfigured({ mode: "auto", protocol: "http", host: "127.0.0.1", port: 7890 })).toBe(true);
    expect(isDesktopProxyConfigured({ mode: "auto", protocol: "http", host: "bad host", port: 7890 })).toBe(false);
    expect(isDesktopProxyConfigured({ mode: "auto", protocol: "http", host: "127.0.0.1", port: 70000 })).toBe(false);
  });
});
