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

export const writePlainTextClipboard = (clipboard, value) => {
  if (typeof value !== "string") {
    throw new TypeError("Clipboard value must be a string");
  }

  clipboard.writeText(value);
  // Windows normalize bare newlines to CRLF in the clipboard; verify content
  // without turning a successful copy into a false error.
  return normalizeLineEndings(clipboard.readText()) === normalizeLineEndings(value);
};
