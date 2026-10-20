import { describe, expect, test } from "bun:test";
import { writePlainTextClipboard, writeRichClipboard } from "./clipboard-write.mjs";

describe("writePlainTextClipboard", () => {
  test("writes plain text and accepts platform newline normalization", () => {
    const writes = [];
    const clipboard = {
      writeText: (value) => writes.push(value),
      readText: () => "line one\r\nline two",
    };

    expect(writePlainTextClipboard(clipboard, "line one\nline two")).toBe(true);
    expect(writes).toEqual(["line one\nline two"]);
  });

  test("reports a mismatch when the clipboard content differs", () => {
    const clipboard = {
      writeText: () => {},
      readText: () => "something else",
    };

    expect(writePlainTextClipboard(clipboard, "expected")).toBe(false);
  });

  test("rejects malformed renderer input", () => {
    const clipboard = { writeText: () => {}, readText: () => "" };
    expect(() => writePlainTextClipboard(clipboard, 42)).toThrow("Clipboard value must be a string");
  });
});

describe("writeRichClipboard", () => {
  test("writes and verifies both rich HTML and plain text", () => {
    const writes = [];
    const clipboard = {
      write: (value) => writes.push(value),
      readText: () => "Hello",
      readHTML: () => '<meta charset="utf-8"><strong>Hello</strong>',
    };

    expect(writeRichClipboard(clipboard, {
      html: "<strong>Hello</strong>",
      plainText: "Hello",
    })).toBe(true);
    expect(writes).toEqual([{
      html: "<strong>Hello</strong>",
      text: "Hello",
    }]);
  });

  test("does not report success when rich HTML is missing after the write", () => {
    const clipboard = {
      write: () => {},
      readText: () => "Hello",
      readHTML: () => "",
    };

    expect(writeRichClipboard(clipboard, {
      html: "<strong>Hello</strong>",
      plainText: "Hello",
    })).toBe(false);
  });

  test("rejects malformed renderer input", () => {
    const clipboard = { write: () => {}, readText: () => "", readHTML: () => "" };
    expect(() => writeRichClipboard(clipboard, { html: "<p>Hello</p>" })).toThrow(
      "Clipboard HTML and plain text must be strings",
    );
  });
});
