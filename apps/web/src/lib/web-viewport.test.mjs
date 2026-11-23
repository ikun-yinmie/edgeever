import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DESKTOP_WEB_VIEWPORT_WIDTH, shouldUseDesktopWebViewport } from "./web-viewport.ts";

const desktopUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
const environment = { userAgent: desktopUa, touchDevice: true, narrowViewport: true, desktopRuntime: false };

describe("desktop site requests on mobile browsers", () => {
  test("honors a desktop UA on a narrow touch device", () => {
    expect(shouldUseDesktopWebViewport(environment)).toBe(true);
    expect(DESKTOP_WEB_VIEWPORT_WIDTH).toBeGreaterThanOrEqual(1024);
  });

  test.each([
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  ])("keeps responsive layout for mobile/tablet UA %s", (userAgent) => {
    expect(shouldUseDesktopWebViewport({ ...environment, userAgent })).toBe(false);
  });

  test("does not override native desktops, wide viewports, mouse-only browsers or unknown UAs", () => {
    expect(shouldUseDesktopWebViewport({ ...environment, desktopRuntime: true })).toBe(false);
    expect(shouldUseDesktopWebViewport({ ...environment, narrowViewport: false })).toBe(false);
    expect(shouldUseDesktopWebViewport({ ...environment, touchDevice: false })).toBe(false);
    expect(shouldUseDesktopWebViewport({ ...environment, userAgent: "" })).toBe(false);
  });

  test("applies the viewport before mounting React so CSS and JS share the same breakpoints", () => {
    const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const bootstrap = source.split("const bootstrap = async () => {")[1];
    expect(bootstrap.indexOf("initializeWebViewport")).toBeLessThan(bootstrap.indexOf("mountApp()"));
    const viewportSource = readFileSync(new URL("./web-viewport.ts", import.meta.url), "utf8");
    expect(viewportSource).toContain("viewport.content =");
    expect(viewportSource).not.toContain("initial-scale=1");
  });
});
