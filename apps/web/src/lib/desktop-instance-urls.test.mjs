import { describe, expect, test } from "bun:test";
import {
  collectDesktopProbeUrls,
  pickFastestInstanceUrl,
} from "./desktop-instance-urls.ts";

describe("desktop instance url candidates", () => {
  test("collects the primary plus alternates with dedupe and normalization", () => {
    expect(collectDesktopProbeUrls("https://notes.example.com/", [
      "https://notes.example.com",
      "http://192.168.1.5:9634/",
      "not a url",
      "",
    ])).toEqual(["https://notes.example.com", "http://192.168.1.5:9634"]);
  });

  test("ignores unreachable candidates and picks the fastest reachable one", () => {
    expect(pickFastestInstanceUrl([
      { url: "https://notes.example.com", ms: 420 },
      { url: "http://192.168.1.5:9634", ms: null },
      { url: "http://127.0.0.1:9634", ms: 12 },
    ])).toEqual({ url: "http://127.0.0.1:9634", ms: 12 });
  });

  test("returns null when every candidate is unreachable", () => {
    expect(pickFastestInstanceUrl([
      { url: "https://notes.example.com", ms: null },
      { url: "http://192.168.1.5:9634", ms: null },
    ])).toBeNull();
    expect(pickFastestInstanceUrl([])).toBeNull();
  });
});
