// electron-updater reports transport failures as Chromium net errors
// ("net::ERR_CONNECTION_TIMED_OUT") or Node socket errors depending on the
// code path. Both mean the update server could not be reached, which is what
// the settings UI needs to tell apart from a broken feed or a signed-manifest
// rejection so it can offer a proxy hint.

const TRANSPORT_ERROR_PATTERN = new RegExp(
  [
    "net::ERR_",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NAME_NOT_RESOLVED",
    "ERR_CONNECTION_",
    "ERR_PROXY_",
    "ERR_TUNNEL_",
    "ERR_TIMED_OUT",
    "ERR_ADDRESS_UNREACHABLE",
    "ERR_SOCKET_NOT_CONNECTED",
    "\\bENOTFOUND\\b",
    "\\bEAI_AGAIN\\b",
    "\\bETIMEDOUT\\b",
    "\\bECONNREFUSED\\b",
    "\\bECONNRESET\\b",
    "\\bEHOSTUNREACH\\b",
    "\\bENETUNREACH\\b",
    "\\bEPIPE\\b",
  ].join("|"),
  "i",
);

const MAX_ERROR_MESSAGE_LENGTH = 500;

export const updateErrorMessage = (error) => {
  const raw = typeof error === "string" ? error : String(error?.message ?? error ?? "");
  return raw.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

export const isNetworkUpdateError = (error) => TRANSPORT_ERROR_PATTERN.test(updateErrorMessage(error));

/**
 * Shape published through desktop:update-status so the renderer can show a
 * network-specific hint (and point at the proxy settings) instead of a generic
 * "update failed".
 */
export const classifyUpdateError = (error) => {
  const message = updateErrorMessage(error);
  return {
    kind: isNetworkUpdateError(message) ? "network" : "other",
    message,
    at: new Date().toISOString(),
  };
};
