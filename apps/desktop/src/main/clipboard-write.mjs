export const writeRichClipboard = (clipboard, input) => {
  const html = input?.html;
  const plainText = input?.plainText;
  if (typeof html !== "string" || typeof plainText !== "string") {
    throw new TypeError("Clipboard HTML and plain text must be strings");
  }

  clipboard.write({ html, text: plainText });
  return clipboard.readText() === plainText && clipboard.readHTML().trim().length > 0;
};

const normalizeLineEndings = (value) => String(value ?? "").replace(/\r\n/g, "\n");

const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;

const toClipboardBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

// Electron renderers cannot reliably use navigator.clipboard for images, so the
// copy action hands the raw bytes to the main process instead.
export const writeImageClipboard = (clipboard, nativeImage, value) => {
  const bytes = toClipboardBytes(value);
  if (!bytes || bytes.byteLength === 0) {
    throw new TypeError("Clipboard image must be a non-empty byte buffer");
  }
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new TypeError("Clipboard image is too large");
  }

  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (!image || image.isEmpty()) return false;
  clipboard.writeImage(image);

  // Electron's readImage() is not a reliable write acknowledgement on Linux
  // and some Wayland/desktop clipboard providers. It may be empty until a
  // paste target requests the bitmap, even though writeImage() succeeded.
  return true;
};

export const writePlainTextClipboard = (clipboard, value) => {
  if (typeof value !== "string") {
    throw new TypeError("Clipboard value must be a string");
  }

  clipboard.writeText(value);
  // Windows normalize bare newlines to CRLF in the clipboard; verify content
  // without turning a successful copy into a false error.
  return normalizeLineEndings(clipboard.readText()) === normalizeLineEndings(value);
};
