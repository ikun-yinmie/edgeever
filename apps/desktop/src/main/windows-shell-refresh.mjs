import { execFile } from "node:child_process";
import { join } from "node:path";

// Static code only: paths travel as base64 UTF-8 JSON on stdin, never as
// interpolated PowerShell. No Explorer restart or pin database/cache deletion.
export const WINDOWS_SHELL_REFRESH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $payload = ConvertFrom-Json $json
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EdgeEverShellRefresh {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(int eventId, uint flags, string item1, string item2);
}
'@
  foreach ($change in $payload.changes) {
    if ($change.type -eq 'rename') {
      [EdgeEverShellRefresh]::SHChangeNotify(0x00000001, 0x2005, $change.path, $change.newPath)
    } elseif ($change.type -eq 'delete') {
      [EdgeEverShellRefresh]::SHChangeNotify(0x00000004, 0x2005, $change.path, $null)
    } elseif ($change.type -eq 'update') {
      [EdgeEverShellRefresh]::SHChangeNotify(0x00002000, 0x2005, $change.path, $null)
    }
  }
  if ($payload.associationsChanged) {
    [EdgeEverShellRefresh]::SHChangeNotify(0x08000000, 0x2000, $null, $null)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export const notifyWindowsShell = ({ changes = [], associationsChanged = false }, { run = execFile } = {}) => {
  if (!changes.length && !associationsChanged) return Promise.resolve({ ok: true, skipped: true });
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_SHELL_REFRESH_SCRIPT, "utf16le").toString("base64")];
  return new Promise((resolve) => {
    try {
      const child = run(executable, args, { windowsHide: true, timeout: 15000 }, (error, _stdout, stderr) => {
        resolve(error ? { ok: false, error: String(stderr || error.message).slice(0, 1000) } : { ok: true });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(JSON.stringify({ changes, associationsChanged }), "utf8").toString("base64"));
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error).slice(0, 1000) });
    }
  });
};
