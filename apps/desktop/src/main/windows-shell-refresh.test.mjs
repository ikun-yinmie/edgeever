import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { notifyWindowsShell, WINDOWS_SHELL_REFRESH_SCRIPT } from "./windows-shell-refresh.mjs";

describe("Windows shell refresh", () => {
  test("sends Unicode paths as data, never executable PowerShell", async () => {
    const changes = [{ type: "rename", path: "C:\\Notes\\旧名.lnk", newPath: "C:\\Notes\\$(not-a-command) '新名'.lnk" }];
    let payload;
    const result = await notifyWindowsShell({ changes, associationsChanged: true }, { run: (exe, args, options, callback) => {
      expect(exe.toLowerCase()).toEndWith("powershell.exe");
      expect(args).toContain("-NoProfile");
      expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).toBe(WINDOWS_SHELL_REFRESH_SCRIPT);
      expect(args.join(" ")).not.toContain("not-a-command");
      expect(options.windowsHide).toBe(true);
      expect(options.timeout).toBe(15000);
      return { stdin: { on() {}, end(value) { payload = JSON.parse(Buffer.from(value, "base64").toString("utf8")); callback(null, "", ""); } } };
    } });
    expect(result.ok).toBe(true);
    expect(payload).toEqual({ changes, associationsChanged: true });
  });

  test("does not start a process for a no-op", async () => {
    const result = await notifyWindowsShell({}, { run: () => { throw new Error("must not spawn"); } });
    expect(result).toEqual({ ok: true, skipped: true });
  });

  test("reports blocked PowerShell and timed-out shell operations without throwing", async () => {
    const denied = await notifyWindowsShell({ associationsChanged: true }, { run: () => { throw new Error("denied"); } });
    expect(denied).toEqual({ ok: false, error: "denied" });
    const timedOut = await notifyWindowsShell({ associationsChanged: true }, { run: (_exe, _args, _opts, callback) => {
      callback(new Error("timed out"), "", "");
      return { stdin: { on() {}, end() {} } };
    } });
    expect(timedOut).toEqual({ ok: false, error: "timed out" });
  });

  test("wires shortcut reading, packaged-only synchronization and pre-show taskbar details", () => {
    const source = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
    expect(source).toContain("shell.readShortcutLink(shortcutPath)");
    expect(source).toContain('if (process.platform !== "win32" || !app.isPackaged) return;');
    expect(source).toContain('writeDiagnostic("branding.windows-shell"');
    const creation = source.slice(source.indexOf("const createWindow = async"), source.indexOf("const confirmMacInstallation"));
    expect(creation).toContain('process.platform === "win32" ? { show: false }');
    expect(creation.indexOf("await syncWindowsShellBranding")).toBeLessThan(creation.indexOf("new BrowserWindow"));
    expect(creation.indexOf("updateWindowsTaskbarBranding(mainWindow")).toBeLessThan(creation.indexOf("mainWindow.show()"));
  });
});
