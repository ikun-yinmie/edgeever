// Windows resolves a taskbar button's icon from the running window for the
// session, but the Start menu entry, the pinned shortcut and the "restart"
// affordance of a grouped button all read the AppUserModelId registration under
// HKCU\Software\Classes\AppUserModelId\<aumid>. Electron's app.setAppUserModelId
// only sets the process identity; it never writes that key, so a custom client
// icon updated the window title bar while the taskbar kept showing the icon
// embedded in the executable.
//
// See "Application User Model IDs" in the Windows shell documentation: the
// per-AUMID key carries DisplayName and IconUri, and the shell prefers IconUri
// over the executable's embedded icon.

export const WINDOWS_AUMID_REGISTRY_ROOT = "HKCU\\Software\\Classes\\AppUserModelId";

export const windowsAppUserModelIdRegistryKey = (aumid) => {
  if (typeof aumid !== "string" || !aumid.trim()) return null;
  return `${WINDOWS_AUMID_REGISTRY_ROOT}\\${aumid.trim()}`;
};

/**
 * Builds the reg.exe argument list for the current user only (no elevation).
 * `values` is ordered so the same call both creates the key and sets values.
 */
export const buildAumidRegistrationArgs = ({ aumid, name, iconPath }) => {
  const key = windowsAppUserModelIdRegistryKey(aumid);
  if (!key) return null;
  const args = ["add", key, "/f"];
  if (typeof name === "string" && name.trim()) {
    args.push("/v", "DisplayName", "/t", "REG_SZ", "/d", name.trim());
  }
  if (typeof iconPath === "string" && iconPath.trim()) {
    args.push("/v", "IconUri", "/t", "REG_SZ", "/d", iconPath.trim());
  }
  return args.length > 3 ? args : null;
};

/**
 * Reset path: drop the value instead of the key so other shell metadata that
 * Windows may have added stays intact, then let the executable icon win again.
 */
export const buildAumidResetArgs = ({ aumid, value }) => {
  const key = windowsAppUserModelIdRegistryKey(aumid);
  if (!key || typeof value !== "string" || !value.trim()) return null;
  return ["delete", key, "/v", value.trim(), "/f"];
};

export const buildAumidDeleteKeyArgs = (aumid) => {
  const key = windowsAppUserModelIdRegistryKey(aumid);
  return key ? ["delete", key, "/f"] : null;
};

/**
 * Applies the branding to the shell registration. `runReg` returns
 * { ok, stderr } so callers can log a diagnostic without throwing during
 * startup. Every call is best-effort: a locked-down registry must never stop
 * the desktop app from launching.
 */
export const syncWindowsAumidBranding = ({
  aumid,
  name,
  iconPath,
  runReg,
}) => {
  if (typeof runReg !== "function") return { ok: false, applied: [] };
  const applied = [];

  const write = (args) => {
    if (!args) return true;
    const result = runReg(args);
    return result?.ok !== false;
  };

  if (iconPath) {
    if (!write(buildAumidRegistrationArgs({ aumid, name, iconPath }))) {
      return { ok: false, applied };
    }
    applied.push("IconUri");
  }

  if (name && !iconPath) {
    const args = buildAumidRegistrationArgs({ aumid, name, iconPath: null });
    if (!write(args)) return { ok: false, applied };
    applied.push("DisplayName");
  }

  if (!iconPath) {
    // The custom icon is gone: make the shell fall back to the executable's
    // own icon instead of keeping the last custom one cached.
    write(buildAumidResetArgs({ aumid, value: "IconUri" }));
    applied.push("IconUri(reset)");
  }

  return { ok: true, applied };
};
