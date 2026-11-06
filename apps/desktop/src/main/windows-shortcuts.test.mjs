import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncWindowsShortcuts, windowsShortcutFileName, WINDOWS_APP_USER_MODEL_ID } from "./client-branding.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "edgeever-shortcuts-"));
  roots.push(root);
  const options = {
    appDataDir: join(root, "AppData"), desktopDir: join(root, "OneDrive", "Desktop"),
    commonProgramsDir: join(root, "CommonPrograms"), publicDesktopDir: join(root, "PublicDesktop"),
    execPath: "C:\\Apps\\EdgeEver\\EdgeEver.exe", name: "新名称", icoPath: join(root, "icon.ico"),
    shellReader: (path) => JSON.parse(readFileSync(path, "utf8")),
    shellWriter: (path, operation, details) => {
      expect(operation).toBe("update");
      expect(details.target).toBeUndefined();
      writeFileSync(path, JSON.stringify({ ...options.shellReader(path), ...details }));
      return true;
    },
  };
  writeFileSync(options.icoPath, "icon");
  const add = (path, details = {}) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ target: options.execPath, args: '--profile="my notes"', cwd: "C:\\Apps\\EdgeEver", ...details }));
    return path;
  };
  return { root, options, add };
};

describe("Windows shortcut migration", () => {
  test("finds old custom names and nested/public/pinned launchers by target, then renames and resets", () => {
    const { options, add } = fixture();
    const dirs = [
      options.desktopDir, options.publicDesktopDir, join(options.commonProgramsDir, "Notes", "旧名称"),
      join(options.appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", "Custom", "Nested"),
      join(options.appDataDir, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "ImplicitAppShortcuts", "123"),
    ];
    for (const dir of dirs) add(join(dir, "旧名称.LNK"), { target: "c:/apps/edgeever/EDGEEVER.exe" });
    const result = syncWindowsShortcuts(options);
    expect(result.updated).toBe(dirs.length);
    expect(result.renamed).toBe(dirs.length - 1);
    expect(result.pinnedNameChanges).toHaveLength(1);
    expect(result.failed).toBe(0);
    for (const dir of dirs) {
      const isPinned = dir === dirs.at(-1);
      expect(existsSync(join(dir, "旧名称.LNK"))).toBe(isPinned);
      const details = options.shellReader(join(dir, isPinned ? "旧名称.LNK" : "新名称.lnk"));
      expect(details.args).toBe('--profile="my notes"');
      expect(details.cwd).toBe("C:\\Apps\\EdgeEver");
      expect(details.appUserModelId).toBe(WINDOWS_APP_USER_MODEL_ID);
      expect(details.icon).toBe(options.icoPath);
    }
    const unchanged = syncWindowsShortcuts(options);
    expect(unchanged.changes).toEqual([]);
    expect(unchanged.pinnedNameChanges).toHaveLength(1);
    const reset = syncWindowsShortcuts({ ...options, name: "EdgeEver", icoPath: null });
    expect(reset.renamed).toBe(dirs.length - 1);
    for (const dir of dirs) {
      expect(options.shellReader(join(dir, dir === dirs.at(-1) ? "旧名称.LNK" : "EdgeEver.lnk")).icon).toBe(options.execPath);
    }
  });

  test("never rewrites uninstallers, another installation, or similarly named foreign shortcuts", () => {
    const { options, add } = fixture();
    const paths = [
      add(join(options.desktopDir, "Uninstall EdgeEver.lnk"), { target: "C:\\Apps\\EdgeEver\\Uninstall EdgeEver.exe" }),
      add(join(options.desktopDir, "EdgeEver.lnk"), { target: "D:\\Other\\EdgeEver.exe", appUserModelId: WINDOWS_APP_USER_MODEL_ID }),
      add(join(options.desktopDir, "新名称.lnk"), { target: "C:\\Windows\\notepad.exe" }),
    ];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    expect(syncWindowsShortcuts(options).changes).toEqual([]);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  test("does not overwrite a colliding shortcut or remove a launcher when writing is denied", () => {
    const { options, add } = fixture();
    const original = add(join(options.desktopDir, "EdgeEver.lnk"));
    const collision = add(join(options.desktopDir, "新名称.lnk"), { target: "C:\\Other.exe" });
    const before = readFileSync(collision, "utf8");
    const result = syncWindowsShortcuts(options);
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.renamed).toBe(0);
    expect(existsSync(original)).toBe(true);
    expect(readFileSync(collision, "utf8")).toBe(before);
    const denied = syncWindowsShortcuts({ ...options, name: "Another", shellWriter: () => false });
    expect(denied.failed).toBe(1);
    expect(denied.renamed).toBe(0);
    expect(existsSync(original)).toBe(true);
    expect(denied.errors[0].message).toContain("permissions");
  });

  test("merges an installer-recreated duplicate but never discards a different launch command", () => {
    const { options, add } = fixture();
    const original = add(join(options.desktopDir, "EdgeEver.lnk"));
    expect(syncWindowsShortcuts(options).renamed).toBe(1);
    add(original);
    const migrated = syncWindowsShortcuts(options);
    expect(migrated.failed).toBe(0);
    expect(migrated.deduplicated).toBe(1);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(join(options.desktopDir, "新名称.lnk"))).toBe(true);
    add(original, { args: "--different-profile" });
    const conflict = syncWindowsShortcuts(options);
    expect(conflict.deduplicated).toBe(0);
    expect(conflict.failed).toBe(1);
    expect(existsSync(original)).toBe(true);
    expect(options.shellReader(original).args).toBe("--different-profile");
  });

  test("does not follow junctions or scan arbitrary desktop project directories", () => {
    const { root, options, add } = fixture();
    const outside = join(root, "unrelated");
    const externalLink = add(join(outside, "EdgeEver.lnk"));
    const projectLink = add(join(options.desktopDir, "project", "EdgeEver.lnk"));
    mkdirSync(options.commonProgramsDir, { recursive: true });
    const junction = join(options.commonProgramsDir, "linked-folder");
    symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(syncWindowsShortcuts(options).changes).toEqual([]);
      expect(existsSync(externalLink)).toBe(true);
      expect(existsSync(projectLink)).toBe(true);
    } finally {
      // Remove the junction itself before the fixture cleanup.
      rmSync(junction, { recursive: true, force: true });
    }
  });

  test("sanitizes path separators, reserved device names and trailing dots", () => {
    expect(windowsShortcutFileName("  My: Notes/书\\册?  ")).toBe("My_ Notes_书_册_.lnk");
    expect(windowsShortcutFileName("CON")).toBe("_CON.lnk");
    expect(windowsShortcutFileName("com1.txt")).toBe("_com1.txt.lnk");
    expect(windowsShortcutFileName("... ")).toBe("EdgeEver.lnk");
    expect(windowsShortcutFileName(" x. ")).toBe("x.lnk");
    expect(windowsShortcutFileName("a".repeat(300)).length).toBe(104);
  });
});
