import { describe, expect, test } from "bun:test";
import { isAllowedPrintPreviewUrl, isInternalAppWindowUrl } from "./window-open-policy.mjs";

describe("desktop window open policy", () => {
  test("allows only the packaged print preview beside the app entry", () => {
    const appUrl = "file:///Applications/EdgeEver.app/Contents/Resources/web/index.html";

    expect(isAllowedPrintPreviewUrl(
      "file:///Applications/EdgeEver.app/Contents/Resources/web/note-print.html?token=abc",
      appUrl,
    )).toBe(true);
    expect(isAllowedPrintPreviewUrl("file:///note-print.html?token=abc", appUrl)).toBe(false);
    expect(isAllowedPrintPreviewUrl(
      "file:///Applications/EdgeEver.app/Contents/Resources/web/mobile-edit.html",
      appUrl,
    )).toBe(false);
  });

  test("allows the same-origin print preview in desktop development", () => {
    const appUrl = "http://127.0.0.1:5173/";

    expect(isAllowedPrintPreviewUrl("http://127.0.0.1:5173/note-print.html?token=abc", appUrl)).toBe(true);
    expect(isAllowedPrintPreviewUrl("https://example.com/note-print.html", appUrl)).toBe(false);
    expect(isAllowedPrintPreviewUrl("http://127.0.0.1:5173/settings", appUrl)).toBe(false);
  });

  test("allows same-origin app windows and rejects external pages", () => {
    expect(isInternalAppWindowUrl("http://127.0.0.1:5173/?openMemo=memo-1", "http://127.0.0.1:5173/")).toBe(true);
    expect(isInternalAppWindowUrl("http://127.0.0.1:5173/settings?openMemo=memo-1", "http://127.0.0.1:5173/")).toBe(true);
    expect(isInternalAppWindowUrl("http://127.0.0.1:5174/?openMemo=memo-1", "http://127.0.0.1:5173/")).toBe(false);
    expect(isInternalAppWindowUrl("https://example.com/?openMemo=memo-1", "http://127.0.0.1:5173/")).toBe(false);
  });

  test("only allows the app entry in packaged file and private protocol windows", () => {
    const fileAppUrl = "file:///Applications/EdgeEver.app/Contents/Resources/web/index.html";
    expect(isInternalAppWindowUrl(
      "file:///Applications/EdgeEver.app/Contents/Resources/web/index.html?openMemo=memo-1",
      fileAppUrl,
    )).toBe(true);
    expect(isInternalAppWindowUrl(
      "file:///Applications/EdgeEver.app/Contents/Resources/web/mobile-edit.html?openMemo=memo-1",
      fileAppUrl,
    )).toBe(false);

    const protocolAppUrl = "edgeever-app://app/index.html";
    expect(isInternalAppWindowUrl("edgeever-app://app/index.html?openMemo=memo-1", protocolAppUrl)).toBe(true);
    expect(isInternalAppWindowUrl("edgeever-app://app/?openMemo=memo-1", protocolAppUrl)).toBe(true);
    expect(isInternalAppWindowUrl("edgeever-app://app/note-print.html?openMemo=memo-1", protocolAppUrl)).toBe(false);
    expect(isInternalAppWindowUrl("edgeever-app://other/index.html?openMemo=memo-1", protocolAppUrl)).toBe(false);
  });

  test("allows only the print preview on the private desktop origin", () => {
    const appUrl = "edgeever-app://app/index.html";

    expect(isAllowedPrintPreviewUrl("edgeever-app://app/note-print.html?token=abc", appUrl)).toBe(true);
    expect(isAllowedPrintPreviewUrl("edgeever-app://other/note-print.html", appUrl)).toBe(false);
    expect(isAllowedPrintPreviewUrl("edgeever-app://app/mobile-edit.html", appUrl)).toBe(false);
  });
});
