import { describe, expect, test } from "bun:test";
import { writeImageClipboard, writePlainTextClipboard, writeRichClipboard } from "./clipboard-write.mjs";

class FakeClipboardItem {
  constructor(payload) {
    this.payload = payload;
  }
}

const createAsyncClipboard = ({ storedText = "", htmlTypes = [] } = {}) => {
  const writes = [];
  return {
    writes,
    writeText: async (value) => {
      writes.push({ text: value });
    },
    readText: async () => storedText,
    write: async (items) => {
      writes.push({ items });
    },
    has: async (type) => htmlTypes.includes(type),
  };
};

describe("writePlainTextClipboard", () => {
  test("writes plain text and accepts platform newline normalization", async () => {
    const clipboard = createAsyncClipboard({ storedText: "line one\r\nline two" });

    expect(await writePlainTextClipboard(clipboard, "line one\nline two")).toBe(true);
    expect(clipboard.writes).toEqual([{ text: "line one\nline two" }]);
  });

  test("reports a mismatch when the clipboard content differs", async () => {
    const clipboard = createAsyncClipboard({ storedText: "something else" });

    expect(await writePlainTextClipboard(clipboard, "expected")).toBe(false);
  });

  test("rejects malformed renderer input", () => {
    const clipboard = createAsyncClipboard();
    expect(() => writePlainTextClipboard(clipboard, 42)).toThrow("Clipboard value must be a string");
  });
});

describe("writeImageClipboard", () => {
  const createBridge = ({ empty = false } = {}) => {
    const writes = [];
    const image = {
      isEmpty: () => empty,
      toPNG: () => Buffer.from("png-bytes"),
    };
    return {
      writes,
      nativeImage: {
        createFromBuffer: (buffer) => {
          writes.push(buffer);
          return image;
        },
      },
      clipboard: {
        write: async (items) => {
          writes.push(items);
        },
      },
    };
  };

  test("writes the decoded bitmap through the native clipboard", async () => {
    const bridge = createBridge();

    expect(await writeImageClipboard(bridge.clipboard, bridge.nativeImage, FakeClipboardItem, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bridge.writes).toHaveLength(2);
    expect(Buffer.isBuffer(bridge.writes[0])).toBe(true);
    const [item] = bridge.writes[1];
    expect(item).toBeInstanceOf(FakeClipboardItem);
    const blob = item.payload["image/png"];
    expect(blob).toBeInstanceOf(Blob);
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe("png-bytes");
  });

  test("accepts an ArrayBuffer from the renderer", async () => {
    const bridge = createBridge();
    expect(await writeImageClipboard(bridge.clipboard, bridge.nativeImage, FakeClipboardItem, new Uint8Array([4, 5]).buffer)).toBe(true);
  });

  test("reports failure when the bytes are not a decodable image", async () => {
    const bridge = createBridge({ empty: true });
    expect(await writeImageClipboard(bridge.clipboard, bridge.nativeImage, FakeClipboardItem, new Uint8Array([9]))).toBe(false);
    expect(bridge.writes).toHaveLength(1);
  });

  test("rejects empty and missing image bytes", () => {
    const bridge = createBridge();
    expect(() => writeImageClipboard(bridge.clipboard, bridge.nativeImage, FakeClipboardItem, new Uint8Array())).toThrow(
      "Clipboard image must be a non-empty byte buffer",
    );
    expect(() => writeImageClipboard(bridge.clipboard, bridge.nativeImage, FakeClipboardItem, null)).toThrow(
      "Clipboard image must be a non-empty byte buffer",
    );
  });
});

describe("writeRichClipboard", () => {
  test("writes and verifies both rich HTML and plain text", async () => {
    const clipboard = createAsyncClipboard({ storedText: "Hello", htmlTypes: ["text/html"] });

    expect(await writeRichClipboard(clipboard, FakeClipboardItem, {
      html: "<strong>Hello</strong>",
      plainText: "Hello",
    })).toBe(true);
    const [item] = clipboard.writes[0].items;
    expect(item).toBeInstanceOf(FakeClipboardItem);
    expect(item.payload["text/plain"]).toBe("Hello");
    expect(item.payload["text/html"]).toBeInstanceOf(Blob);
    expect(await item.payload["text/html"].text()).toBe("<strong>Hello</strong>");
  });

  test("does not report success when rich HTML is missing after the write", async () => {
    const clipboard = createAsyncClipboard({ storedText: "Hello", htmlTypes: [] });

    expect(await writeRichClipboard(clipboard, FakeClipboardItem, {
      html: "<strong>Hello</strong>",
      plainText: "Hello",
    })).toBe(false);
  });

  test("rejects malformed renderer input", () => {
    const clipboard = createAsyncClipboard();
    expect(() => writeRichClipboard(clipboard, FakeClipboardItem, { html: "<p>Hello</p>" })).toThrow(
      "Clipboard HTML and plain text must be strings",
    );
  });
});
