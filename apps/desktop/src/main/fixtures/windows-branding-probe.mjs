import { app, shell, nativeImage } from "electron";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeBrandingFiles, syncWindowsShortcuts } from "../client-branding.mjs";
import { notifyWindowsShell } from "../windows-shell-refresh.mjs";

// All shortcuts and runtime data live under a temporary root, never in the
// user's real Desktop/Start Menu/pinned folders. No application window is opened.
const root = process.env.EDGE_EVER_BRANDING_TEST_ROOT;
if (!root) throw new Error("Run this probe through windows-shell-native.test.mjs");
app.setPath("userData", root);
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
let exitCode = 0;
try {
  const appDataDir = join(root, "AppData");
  const desktopDir = join(root, "Desktop");
  const commonProgramsDir = join(root, "CommonPrograms");
  const publicDesktopDir = join(root, "PublicDesktop");
  const pinned = join(appDataDir, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
  const dirs = [desktopDir, commonProgramsDir, publicDesktopDir, pinned];
  const appUserModelId = "org.edgeever.branding-native-test";
  const args = '--user-data-dir="C:\\test notes" --language=zh-CN';
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    assert(shell.writeShortcutLink(join(dir, "EdgeEver.lnk"), "create", {
      target: process.execPath, args, cwd: root, description: "EdgeEver",
      icon: process.execPath, iconIndex: 0, appUserModelId,
    }));
  }
  const unrelated = join(desktopDir, "EdgeEver uninstall.lnk");
  assert(shell.writeShortcutLink(unrelated, "create", { target: join(process.env.SystemRoot, "notepad.exe") }));
  const unrelatedBefore = readFileSync(unrelated);
  const image = nativeImage.createFromPath(fileURLToPath(new URL("../../../assets/icon.png", import.meta.url)));
  assert(!image.isEmpty());
  const files = materializeBrandingFiles(root, image.toDataURL(), { nativeImageProvider: nativeImage.createFromBuffer });
  assert(files.hasIcon);
  assert(!nativeImage.createFromPath(files.icoPath).isEmpty());
  const options = {
    appDataDir, desktopDir, commonProgramsDir, publicDesktopDir,
    execPath: process.execPath, name: "岁玥史书", icoPath: files.icoPath, appUserModelId,
    shellReader: shell.readShortcutLink, shellWriter: shell.writeShortcutLink,
  };
  const first = syncWindowsShortcuts(options);
  assert.equal(first.failed, 0, JSON.stringify(first.errors));
  assert.equal(first.updated, dirs.length);
  assert.equal(first.renamed, dirs.length - 1);
  assert.equal(first.pinnedNameChanges.length, 1);
  for (const dir of dirs) {
    assert.equal(existsSync(join(dir, "EdgeEver.lnk")), dir === pinned);
    const link = shell.readShortcutLink(join(dir, dir === pinned ? "EdgeEver.lnk" : "岁玥史书.lnk"));
    assert.equal(link.description, "岁玥史书");
    assert.equal(link.icon, files.icoPath);
    assert.equal(link.appUserModelId, appUserModelId);
    assert.equal(link.args, args);
    assert.equal(link.cwd, root);
    assert.equal(link.target, process.execPath);
  }
  assert.deepEqual(readFileSync(unrelated), unrelatedBefore);
  assert.equal(syncWindowsShortcuts(options).changes.length, 0);
  const refresh = await notifyWindowsShell({ changes: first.changes, associationsChanged: true });
  assert.equal(refresh.ok, true, JSON.stringify(refresh));
  // Reproduce an installer restoring its original shortcut after an update.
  assert(shell.writeShortcutLink(join(desktopDir, "EdgeEver.lnk"), "create", {
    target: process.execPath, args, cwd: root, description: "EdgeEver", icon: process.execPath, iconIndex: 0, appUserModelId,
  }));
  const duplicate = syncWindowsShortcuts(options);
  assert.equal(duplicate.deduplicated, 1);
  assert.equal(duplicate.failed, 0);
  assert(!existsSync(join(desktopDir, "EdgeEver.lnk")));
  assert.equal((await notifyWindowsShell({ changes: duplicate.changes })).ok, true);
  const renamed = syncWindowsShortcuts({ ...options, name: "Another 中文" });
  assert.equal(renamed.renamed, dirs.length - 1);
  const reset = syncWindowsShortcuts({ ...options, name: "EdgeEver", icoPath: null });
  assert.equal(reset.failed, 0);
  for (const dir of dirs) assert.equal(shell.readShortcutLink(join(dir, "EdgeEver.lnk")).icon, process.execPath);
  console.log("WINDOWS_BRANDING_NATIVE_OK: real Electron links, Unicode rename, args/cwd, ICO decode, idempotency, reset, Shell32 notification");
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  // Chromium may hold runtime files until process exit; the parent cleans the
  // reported temporary root after the child has terminated.
  console.log(`WINDOWS_BRANDING_TEMP=${root}`);
  app.exit(exitCode);
}
});
