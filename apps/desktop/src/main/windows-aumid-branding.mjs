// Per-user shell identity metadata supplements, but does not replace, .lnk icons/names.
export const WINDOWS_AUMID_REGISTRY_ROOT = "HKCU\\Software\\Classes\\AppUserModelId";

export const windowsAppUserModelIdRegistryKey = (aumid) => {
  if (typeof aumid !== "string" || !aumid.trim()) return null;
  return `${WINDOWS_AUMID_REGISTRY_ROOT}\\${aumid.trim()}`;
};

// reg.exe accepts ONE /v value per invocation, not repeated /v /t /d groups.
export const buildAumidRegistrationArgs = ({ aumid, name, iconPath }) => {
  const key = windowsAppUserModelIdRegistryKey(aumid);
  if (!key) return [];
  return [["DisplayName", name], ["IconUri", iconPath]]
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([valueName, value]) => ["add", key, "/f", "/v", valueName, "/t", "REG_SZ", "/d", value.trim()]);
};

export const buildAumidResetArgs = ({ aumid, value }) => {
  const key = windowsAppUserModelIdRegistryKey(aumid);
  if (!key || typeof value !== "string" || !value.trim()) return null;
  return ["delete", key, "/v", value.trim(), "/f"];
};

export const buildAumidDeleteKeyArgs = (aumid) => {
  const key = windowsAppUserModelIdRegistryKey(aumid);
  return key ? ["delete", key, "/f"] : null;
};

export const syncWindowsAumidBranding = ({ aumid, name, iconPath, runReg }) => {
  const applied = [];
  const errors = [];
  const key = windowsAppUserModelIdRegistryKey(aumid);
  if (typeof runReg !== "function" || !key) return { ok: false, applied, errors: ["Invalid registry runner or app ID"] };
  const run = (args) => {
    try { return runReg(args) || { ok: false, stderr: "Registry runner returned no result" }; }
    catch (error) { return { ok: false, stderr: String(error?.message || error) }; }
  };
  for (const args of buildAumidRegistrationArgs({ aumid, name, iconPath })) {
    const value = args[args.indexOf("/v") + 1];
    const result = run(args);
    if (result.ok) applied.push(value);
    else errors.push(`${value}: ${result.stderr || "Registry write failed"}`);
  }
  if (!iconPath) {
    const result = run(buildAumidResetArgs({ aumid, value: "IconUri" }));
    if (result.ok) applied.push("IconUri(reset)");
    else {
      // A missing value is an idempotent reset, but a failed delete of an
      // existing value (or an inaccessible key) is not success.
      const query = run(["query", key, "/v", "IconUri"]);
      if (query.ok) errors.push(`IconUri(reset): ${result.stderr || "Registry delete failed"}`);
      else if (!run(["query", key]).ok) errors.push(`IconUri(reset): ${result.stderr || "Registry key inaccessible"}`);
    }
  }
  return { ok: errors.length === 0, applied, errors };
};
