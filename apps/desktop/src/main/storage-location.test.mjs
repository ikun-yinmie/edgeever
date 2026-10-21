import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  directoryUsage,
  hasSidecarData,
  isPathInside,
  moveSidecarData,
  normalizeStorageDirectory,
  parseStorageLocationConfig,
  rollbackSidecarData,
  serializeStorageLocationConfig,
  sidecarStorageUsage,
  storageLocationConfigPath,
  storageRevealTarget,
  validateStorageTarget,
} from "./storage-location.mjs";

const mainSource = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/index.cjs", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../../../web/src/components/settings/DesktopStorageCard.tsx", import.meta.url), "utf8");

describe("storage location configuration", () => {
  test("normalizes absolute directories and rejects unusable values", () => {
    expect(normalizeStorageDirectory("  /data/EdgeEver/  ")).toBe("/data/EdgeEver");
    expect(normalizeStorageDirectory("/data/EdgeEver/./notes/..")).toBe("/data/EdgeEver");
    expect(normalizeStorageDirectory("relative/path")).toBe("");
    expect(normalizeStorageDirectory("")).toBe("");
    expect(normalizeStorageDirectory(null)).toBe("");
  });

  test("round-trips the config file and tolerates broken JSON", () => {
    expect(storageLocationConfigPath("/home/user/.config/EdgeEver")).toBe(join("/home/user/.config/EdgeEver", "storage-location.json"));
    const serialized = serializeStorageLocationConfig("/data/EdgeEver");
    expect(parseStorageLocationConfig(serialized)).toBe("/data/EdgeEver");
    expect(parseStorageLocationConfig("{not json")).toBe("");
    expect(parseStorageLocationConfig(JSON.stringify({ dataDirectory: "relative" }))).toBe("");
  });

  test("detects nested paths without matching siblings that share a prefix", () => {
    expect(isPathInside("/data", "/data/EdgeEver")).toBe(true);
    expect(isPathInside("/data", "/data")).toBe(false);
    expect(isPathInside("/data", "/database")).toBe(false);
    expect(isPathInside("/data", "/other/EdgeEver")).toBe(false);
  });

  test("validates targets against the current root and protected app paths", () => {
    expect(validateStorageTarget({ target: "/data/EdgeEver", currentRoot: "/home/user/.config/EdgeEver" })).toBe("");
    expect(validateStorageTarget({ target: "", currentRoot: "/home/user/.config/EdgeEver" })).toBe("invalid-directory");
    expect(validateStorageTarget({ target: "/home/user/.config/EdgeEver", currentRoot: "/home/user/.config/EdgeEver" })).toBe("unchanged");
    expect(validateStorageTarget({ target: "/home/user/.config/EdgeEver/notes", currentRoot: "/home/user/.config/EdgeEver" })).toBe("unsupported-directory");
    expect(validateStorageTarget({ target: "/home/user/.config", currentRoot: "/home/user/.config/EdgeEver" })).toBe("unsupported-directory");
    expect(validateStorageTarget({
      target: "/Applications/EdgeEver.app/Contents/Resources/data",
      currentRoot: "/home/user/.config/EdgeEver",
      protectedRoots: ["/Applications/EdgeEver.app"],
    })).toBe("unsupported-directory");
  });
});

describe("storage directory inspection", () => {
  test("detects existing sidecar data and measures directory usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "edgeever-storage-test-"));
    try {
      expect(hasSidecarData(root)).toBe(false);
      await mkdir(join(root, "accounts", "scope"), { recursive: true });
      await writeFile(join(root, "accounts", "scope", "edgeever.sqlite"), "abcdef");
      expect(hasSidecarData(root)).toBe(true);
      await mkdir(join(root, "resource-outbox"), { recursive: true });
      await writeFile(join(root, "resource-outbox", "staged.bin"), "wxyz");
      await writeFile(join(root, "unrelated-cache.bin"), "ignored");
      const usage = await directoryUsage(join(root, "accounts"));
      expect(usage.files).toBe(1);
      expect(usage.bytes).toBe(6);
      const fileUsage = await directoryUsage(join(root, "accounts", "scope", "edgeever.sqlite"));
      expect(fileUsage).toEqual({ bytes: 6, files: 1 });
      const rootUsage = await sidecarStorageUsage(root);
      expect(rootUsage).toEqual({ bytes: 10, files: 2 });
      const missing = await directoryUsage(join(root, "missing"));
      expect(missing).toEqual({ bytes: 0, files: 0 });
      expect(storageRevealTarget(root)).toBe(root);
      expect(storageRevealTarget(join(root, "accounts", "scope"))).toBe(join(root, "accounts", "scope", "edgeever.sqlite"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("moves sidecar entries into the new root and rolls them back", async () => {
    const base = await mkdtemp(join(tmpdir(), "edgeever-storage-move-"));
    const source = join(base, "source");
    const target = join(base, "target");
    try {
      await mkdir(join(source, "accounts", "scope"), { recursive: true });
      await writeFile(join(source, "accounts", "scope", "edgeever.sqlite"), "db");
      await mkdir(join(source, "backups"), { recursive: true });
      await writeFile(join(source, "backups", "index.json"), "{}");
      await mkdir(join(source, "resource-outbox"), { recursive: true });
      await writeFile(join(source, "resource-outbox", "staged.bin"), "blob");
      await mkdir(target, { recursive: true });

      const moved = await moveSidecarData(source, target);
      expect(moved).toEqual(["accounts", "backups", "resource-outbox"]);
      expect(hasSidecarData(source)).toBe(false);
      expect(hasSidecarData(target)).toBe(true);
      expect(await sidecarStorageUsage(target)).toEqual({ bytes: 8, files: 3 });

      await rollbackSidecarData(source, target, moved);
      expect(hasSidecarData(target)).toBe(false);
      expect(await sidecarStorageUsage(source)).toEqual({ bytes: 8, files: 3 });
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rolls back partially moved entries when a later entry fails", async () => {
    const base = await mkdtemp(join(tmpdir(), "edgeever-storage-fail-"));
    const source = join(base, "source");
    const target = join(base, "target");
    try {
      await mkdir(join(source, "accounts", "scope"), { recursive: true });
      await writeFile(join(source, "accounts", "scope", "edgeever.sqlite"), "db");
      await mkdir(join(source, "backups"), { recursive: true });
      await writeFile(join(source, "backups", "index.json"), "{}");
      await mkdir(join(target, "backups"), { recursive: true });
      await writeFile(join(target, "backups", "occupied.bin"), "keep");

      await expect(moveSidecarData(source, target)).rejects.toThrow();
      expect(hasSidecarData(source)).toBe(true);
      expect(await readdir(join(target, "backups"))).toEqual(["occupied.bin"]);
      expect(await readdir(target)).toEqual(["backups"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("desktop storage location wiring", () => {
  test("reads the configured root before the first sidecar start", () => {
    expect(mainSource).toContain("await loadStorageLocation();");
    expect(mainSource).toContain("const currentStorageRoot = () => storageDataRoot || app.getPath(\"userData\");");
    expect(mainSource).toContain("dataDir: sidecarDataDirectory(activeAccountId)");
    expect(mainSource).toContain("moved = await moveSidecarData(currentRoot, target);");
    expect(mainSource).toContain("await rollbackSidecarData(currentRoot, target, moved);");
  });

  test("exposes storage location IPC through the preload bridge", () => {
    for (const method of ["storageLocation", "chooseStorageLocation", "setStorageLocation", "resetStorageLocation", "openStorageLocation", "revealStorageLocation"]) {
      expect(preloadSource).toContain(`${method}:`);
    }
    expect(mainSource).toContain('ipcMain.handle("desktop:set-storage-location"');
    expect(mainSource).toContain('ipcMain.handle("desktop:reset-storage-location"');
    expect(mainSource).toContain('ipcMain.handle("desktop:choose-storage-location"');
    expect(mainSource).toContain('ipcMain.handle("desktop:storage-location"');
    expect(mainSource).toContain('ipcMain.handle("desktop:reveal-storage-location"');
    expect(mainSource).toContain("shell.showItemInFolder(target)");
    expect(cardSource).toContain("chooseStorageLocation");
    expect(cardSource).toContain('t("storageLocation.title")');
  });
});
