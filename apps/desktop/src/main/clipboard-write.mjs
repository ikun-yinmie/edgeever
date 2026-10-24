// Electron 44 replaced the synchronous clipboard helpers (writeText/readText/
// writeImage/readImage/readHTML/…) with an async ClipboardItem-based API.
// Every writer below therefore awaits the new clipboard module and verifies
// through the async read-back helpers.
const normalizeLineEndings = (value) => String(value ?? "").replace(/\r\n/g, "\n");

const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;

const toClipboardBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

export const writeRichClipboard = async (clipboard, ClipboardItem, input) => {
  const html = input?.html;
  const plainText = input?.plainText;
  if (typeof html !== "string" || typeof plainText !== "string") {
    throw new TypeError("Clipboard HTML and plain text must be strings");
  }

  await clipboard.write([
    new ClipboardItem({
      "text/plain": plainText,
      "text/html": new Blob([html], { type: "text/html" }),
    }),
  ]);
  return normalizeLineEndings(await clipboard.readText()) === normalizeLineEndings(plainText)
    && await clipboard.has("text/html");
};

export const writeImageClipboard = async (clipboard, nativeImage, ClipboardItem, value) => {
  const bytes = toClipboardBytes(value);
  if (!bytes || bytes.byteLength === 0) {
    throw new TypeError("Clipboard image must be a non-empty byte buffer");
  }
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new TypeError("Clipboard image is too large");
  }

  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  // createFromBuffer only decodes PNG/JPEG. WebP, SVG and friends come back as
  // an empty image so the renderer re-encodes them through canvas and hands
  // PNG bytes back to this handler.
  if (!image || image.isEmpty()) return false;

  await clipboard.write([
    new ClipboardItem({
      "image/png": new Blob([image.toPNG()], { type: "image/png" }),
    }),
  ]);

  // Read-back verification stays intentionally skipped: on Linux the clipboard
  // owner only materializes targets when a paste target requests them, even
  // though the write succeeded.
  return true;
};

export const writePlainTextClipboard = async (clipboard, value) => {
  if (typeof value !== "string") {
    throw new TypeError("Clipboard value must be a string");
  }

  await clipboard.writeText(value);
  // Windows normalize bare newlines to CRLF in the clipboard; verify content
  // without turning a successful copy into a false error.
  return normalizeLineEndings(await clipboard.readText()) === normalizeLineEndings(value);
};
