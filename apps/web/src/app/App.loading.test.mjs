import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("auth loading screen", () => {
  test("shows a spinner and staged slow-network copy instead of a bare site name", () => {
    expect(source).toContain("Loader2");
    expect(source).toContain("animate-spin");
    expect(source).toContain('t("appLoading.waiting")');
    expect(source).toContain('t("appLoading.slowNetwork")');
    expect(source).toContain("setSlowNetwork(true), 10000");
  });

  test("offers a manual reload only after the request looks stalled", () => {
    expect(source).toContain("setStalled(true), 30000");
    expect(source).toContain('t("appLoading.reload")');
    expect(source).toContain("window.location.reload()");
  });

  test("keeps an explicit detail line when a caller provides one", () => {
    expect(source).toContain("detail ?? (slowNetwork ? t(\"appLoading.slowNetwork\") : t(\"appLoading.waiting\"))");
  });
});

describe("session bootstrap", () => {
  test("times out the session request instead of hanging on a blank screen", () => {
    expect(source).toContain("SESSION_REQUEST_TIMEOUT_MS = 15000");
    expect(source).toContain("class SessionRequestTimeoutError");
    expect(source).toContain("getSessionWithTimeout");
  });

  test("falls back to the cached session on timeout or offline instead of the login screen", () => {
    expect(source).toContain("error instanceof SessionRequestTimeoutError || isBrowserOffline()");
  });
});
