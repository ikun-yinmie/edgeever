import { describe, expect, test } from "bun:test";
import { writeImageClipboard, writePlainTextClipboard, writeRichClipboard } from "./clipboard-write.mjs";

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

describe("writeImageClipboard", () => {
  const createBridge = ({ empty = false, readBack = true } = {}) => {
    const image = { isEmpty: () => empty };
    const writes = [];
    return {
      writes,
      nativeImage: {
        createFromBuffer: (buffer) => {
          writes.push(buffer);
          return image;
        },
      },
      clipboard: {
        writeImage: (value) => writes.push(value),
        readImage: () => ({ isEmpty: () => !readBack }),
      },
    };
  };

  test("writes the decoded bitmap through the native clipboard", () => {
    const bridge = createBridge();

    expect(writeImageClipboard(bridge.clipboard, bridge.nativeImage, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bridge.writes).toHaveLength(2);
    expect(Buffer.isBuffer(bridge.writes[0])).toBe(true);
    expect(bridge.writes[1]).toEqual({ isEmpty: expect.any(Function) });
  });

  test("accepts an ArrayBuffer from the renderer", () => {
    const bridge = createBridge();
    expect(writeImageClipboard(bridge.clipboard, bridge.nativeImage, new Uint8Array([4, 5]).buffer)).toBe(true);
  });

  test("reports failure when the bytes are not a decodable image", () => {
    const bridge = createBridge({ empty: true });
    expect(writeImageClipboard(bridge.clipboard, bridge.nativeImage, new Uint8Array([9]))).toBe(false);
  });

  test("rejects empty and missing image bytes", () => {
    const bridge = createBridge();
    expect(() => writeImageClipboard(bridge.clipboard, bridge.nativeImage, new Uint8Array())).toThrow(
      "Clipboard image must be a non-empty byte buffer",
    );
    expect(() => writeImageClipboard(bridge.clipboard, bridge.nativeImage, null)).toThrow(
      "Clipboard image must be a non-empty byte buffer",
    );
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
