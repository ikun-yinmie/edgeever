import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");

describe("session rejection resilience", () => {
  test("only explicit 401/403 responses or an unauthenticated payload disprove a session", () => {
    expect(apiSource).toContain("return response.status === 401 || response.status === 403;");
    expect(apiSource).toContain("return !session?.authenticated;");
    expect(apiSource).not.toContain("if (!response.ok) return true;");
  });

  test("a failed confirmation fetch keeps the session instead of signing the user out", () => {
    expect(apiSource).toContain("// The network itself failed, so the session cannot be disproved here;");
  });

  test("desktop 401 responses still stop retries and keep the replacement-token guard", () => {
    const notifyStart = apiSource.indexOf("const notifyUnauthorized");
    const notifyEnd = apiSource.indexOf("const beforeRequest");
    expect(notifyStart).toBeGreaterThanOrEqual(0);
    expect(notifyEnd).toBeGreaterThan(notifyStart);
    const notifySource = apiSource.slice(notifyStart, notifyEnd);
    expect(notifySource).toContain("getDesktopSessionToken() !== rejectedDesktopSessionToken");
    expect(notifySource).toContain("desktopSessionRejected = true;");
  });

  test("bootstrap treats timeouts, offline states, 5xx and parse failures as an unreachable server", () => {
    expect(appSource).toContain("const isServerUnreachableError = (error: unknown) => {");
    expect(appSource).toContain("error instanceof SessionRequestTimeoutError");
    expect(appSource).toContain("error.status === 0 || error.status >= 500");
    expect(appSource).toContain("error instanceof TypeError || error instanceof SyntaxError");
  });
});
