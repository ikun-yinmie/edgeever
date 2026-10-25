import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const isInternalAppWindowUrl = (targetUrl, appUrl) => {
  try {
    const target = new URL(targetUrl);
    const currentApp = new URL(appUrl);

    if (currentApp.protocol === "file:") {
      return target.protocol === "file:" && target.pathname === currentApp.pathname;
    }

    if (target.protocol !== currentApp.protocol || target.hostname !== currentApp.hostname || target.port !== currentApp.port) {
      return false;
    }

    if (currentApp.protocol === "http:" || currentApp.protocol === "https:") {
      return true;
    }

    return target.pathname === currentApp.pathname || target.pathname === "/";
  } catch {
    return false;
  }
};

// The note list opens `about:blank` synchronously inside the context-menu
// click so a later async navigation to the print preview keeps the user
// activation. The blank shell carries no content; the real navigation is
// still gated by the will-navigate allowlist.
export const isAllowedBlankWindowUrl = (targetUrl) => {
  try {
    return new URL(targetUrl).protocol === "about:";
  } catch {
    return false;
  }
};

export const isAllowedPrintPreviewUrl = (targetUrl, appUrl) => {
  try {
    const target = new URL(targetUrl);
    const currentApp = new URL(appUrl);

    if (currentApp.protocol === "file:") {
      const expected = pathToFileURL(join(dirname(fileURLToPath(currentApp)), "note-print.html"));
      return target.protocol === "file:" && target.pathname === expected.pathname;
    }

    const expected = new URL("/note-print.html", currentApp);
    return target.protocol === expected.protocol &&
      target.hostname === expected.hostname &&
      target.port === expected.port &&
      target.pathname === expected.pathname;
  } catch {
    return false;
  }
};
