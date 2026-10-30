import { describe, expect, test } from "bun:test";
import { classifyUpdateError, isNetworkUpdateError, updateErrorMessage } from "./update-error.mjs";

describe("desktop update error classification", () => {
  test("flags Chromium and Node transport failures as network errors", () => {
    for (const message of [
      "net::ERR_CONNECTION_TIMED_OUT",
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_PROXY_CONNECTION_FAILED",
      "net::ERR_TUNNEL_CONNECTION_FAILED",
      "net::ERR_INTERNET_DISCONNECTED",
      "connect ETIMEDOUT 140.82.113.5:443",
      "getaddrinfo ENOTFOUND api.github.com",
      "connect ECONNREFUSED 127.0.0.1:7890",
    ]) {
      expect(isNetworkUpdateError(message)).toBe(true);
      expect(classifyUpdateError(new Error(message))).toMatchObject({ kind: "network", message });
    }
  });

  test("keeps feed and signature failures out of the network bucket", () => {
    for (const message of [
      "HttpError: 404 Not Found",
      "HttpError: 403 Forbidden",
      "Downloaded Windows update has no matching trusted manifest",
      "Windows update metadata has not passed the signature gate",
      "App version is not a valid semver version: \"dev\"",
    ]) {
      expect(isNetworkUpdateError(message)).toBe(false);
      expect(classifyUpdateError(new Error(message))).toMatchObject({ kind: "other", message });
    }
  });

  test("accepts strings, tolerates empty input, and caps the stored message", () => {
    expect(classifyUpdateError("net::ERR_FAILED").message).toBe("net::ERR_FAILED");
    expect(classifyUpdateError(null)).toMatchObject({ kind: "other", message: "" });
    expect(updateErrorMessage(undefined)).toBe("");
    expect(updateErrorMessage("x".repeat(2000))).toHaveLength(500);
    expect(classifyUpdateError({ message: "  net::ERR_FAILED  " }).message).toBe("net::ERR_FAILED");
  });
});
