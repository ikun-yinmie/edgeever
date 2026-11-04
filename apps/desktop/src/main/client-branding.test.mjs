import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLIENT_NAME,
  normalizeClientBranding,
  parseClientBranding,
  readClientBranding,
  resolveEffectiveBranding,
  serializeClientBranding,
  writeClientBranding,
} from "./client-branding.mjs";

describe("desktop client-branding", () => {
  it("defaults to null for all fields and EdgeEver as default effective name", () => {
    const empty = normalizeClientBranding(null);
    expect(empty).toEqual({
      customName: null,
      customIcon: null,
      serverName: null,
      serverIcon: null,
    });

    const effective = resolveEffectiveBranding(empty);
    expect(effective.effectiveName).toBe(DEFAULT_CLIENT_NAME);
    expect(effective.nameSource).toBe("default");
    expect(effective.effectiveIcon).toBeNull();
    expect(effective.iconSource).toBe("default");
  });

  it("server name and icon take effect when custom fields are empty", () => {
    const config = {
      serverName: "My Notes Server",
      serverIcon: "data:image/png;base64,serverIconData",
    };
    const effective = resolveEffectiveBranding(config);
    expect(effective.effectiveName).toBe("My Notes Server");
    expect(effective.nameSource).toBe("server");
    expect(effective.effectiveIcon).toBe("data:image/png;base64,serverIconData");
    expect(effective.iconSource).toBe("server");
  });

  it("custom name and icon take precedence over server settings", () => {
    const config = {
      customName: "Personal Desktop App",
      customIcon: "data:image/png;base64,customIconData",
      serverName: "My Notes Server",
      serverIcon: "data:image/png;base64,serverIconData",
    };
    const effective = resolveEffectiveBranding(config);
    expect(effective.effectiveName).toBe("Personal Desktop App");
    expect(effective.nameSource).toBe("custom");
    expect(effective.effectiveIcon).toBe("data:image/png;base64,customIconData");
    expect(effective.iconSource).toBe("custom");
  });

  it("handles partial customization (custom name with server icon)", () => {
    const config = {
      customName: "My Custom Work App",
      customIcon: null,
      serverName: "Corporate Wiki",
      serverIcon: "data:image/png;base64,serverIconData",
    };
    const effective = resolveEffectiveBranding(config);
    expect(effective.effectiveName).toBe("My Custom Work App");
    expect(effective.nameSource).toBe("custom");
    expect(effective.effectiveIcon).toBe("data:image/png;base64,serverIconData");
    expect(effective.iconSource).toBe("server");
  });

  it("persists and reads back from file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "desktop-branding-test-"));
    try {
      const initial = readClientBranding(tempDir);
      expect(initial.customName).toBeNull();

      const configToSave = {
        customName: "Saved Client",
        customIcon: "data:image/png;base64,icon123",
        serverName: "Site Backend",
        serverIcon: null,
      };

      const success = writeClientBranding(tempDir, configToSave);
      expect(success).toBe(true);

      const readBack = readClientBranding(tempDir);
      expect(readBack).toEqual({
        customName: "Saved Client",
        customIcon: "data:image/png;base64,icon123",
        serverName: "Site Backend",
        serverIcon: null,
      });

      const effective = resolveEffectiveBranding(readBack);
      expect(effective.effectiveName).toBe("Saved Client");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("safely handles corrupt files", () => {
    const parsed = parseClientBranding("invalid json content {{{");
    expect(parsed.customName).toBeNull();
    expect(parsed.serverName).toBeNull();
  });

  it("exposes branding IPC through the preload bridge and wires main handlers", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const currentDirectory = import.meta.dir;
    const preloadSource = readFileSync(join(currentDirectory, "../preload/index.cjs"), "utf8");
    const mainSource = readFileSync(join(currentDirectory, "index.mjs"), "utf8");

    expect(preloadSource).toContain("getClientBranding:");
    expect(preloadSource).toContain("setClientCustomBranding:");
    expect(preloadSource).toContain("syncServerBranding:");

    expect(mainSource).toContain('ipcMain.handle("desktop:get-client-branding"');
    expect(mainSource).toContain('ipcMain.handle("desktop:set-client-custom-branding"');
    expect(mainSource).toContain('ipcMain.handle("desktop:sync-server-branding"');
    expect(mainSource).toContain("applyClientBrandingToSystem");
    expect(mainSource).toContain("updateWindowsTaskbarBranding");
    expect(mainSource).toContain("setAppDetails");
  });

  it("exposes client relaunch capability to restart the desktop app", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const currentDirectory = import.meta.dir;
    const preloadSource = readFileSync(join(currentDirectory, "../preload/index.cjs"), "utf8");
    const mainSource = readFileSync(join(currentDirectory, "index.mjs"), "utf8");

    expect(preloadSource).toContain('relaunch: () => ipcRenderer.invoke("desktop:relaunch")');
    expect(mainSource).toContain('ipcMain.handle("desktop:relaunch"');
    expect(mainSource).toContain("relaunchDesktopApp");
    expect(mainSource).toContain("copy.relaunch");
  });

  it("decodes dataUrl to buffer and handles invalid inputs", () => {
    const { dataUrlToBuffer } = require("./client-branding.mjs");
    expect(dataUrlToBuffer(null)).toBeNull();
    expect(dataUrlToBuffer("")).toBeNull();
    expect(dataUrlToBuffer("invalid-data")).toBeNull();

    const sample = Buffer.from("sample image content", "utf8");
    const sampleDataUrl = `data:image/png;base64,${sample.toString("base64")}`;
    const decoded = dataUrlToBuffer(sampleDataUrl);
    expect(decoded).not.toBeNull();
    expect(decoded.toString("utf8")).toBe("sample image content");
  });

  it("materializes cache-busting branding icons and preserves referenced ICO files on reset", () => {
    const { basename } = require("node:path");
    const { existsSync } = require("node:fs");
    const {
      BRANDING_ICON_FILE,
      BRANDING_ICON_ICO_PREFIX,
      BRANDING_TRAY_ICON_FILE,
      materializeBrandingFiles,
    } = require("./client-branding.mjs");
    const tempDir = mkdtempSync(join(tmpdir(), "branding-mat-test-"));
    try {
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const sample = Buffer.from([...pngSignature, 0x01]);
      const sampleDataUrl = `data:image/png;base64,${sample.toString("base64")}`;

      const res = materializeBrandingFiles(tempDir, sampleDataUrl);
      expect(res.hasIcon).toBe(true);
      expect(res.iconPath).toBe(join(tempDir, BRANDING_ICON_FILE));
      expect(basename(res.icoPath)).toMatch(new RegExp(`^${BRANDING_ICON_ICO_PREFIX}[a-f0-9]{16}\\.ico$`));
      expect(res.trayIconPath).toBe(join(tempDir, BRANDING_TRAY_ICON_FILE));
      expect(existsSync(res.iconPath)).toBe(true);
      expect(existsSync(res.icoPath)).toBe(true);
      expect(existsSync(res.trayIconPath)).toBe(true);

      const same = materializeBrandingFiles(tempDir, sampleDataUrl);
      expect(same.icoPath).toBe(res.icoPath);

      const changed = Buffer.from([...pngSignature, 0x02]);
      const changedResult = materializeBrandingFiles(
        tempDir,
        `data:image/png;base64,${changed.toString("base64")}`,
      );
      expect(changedResult.icoPath).not.toBe(res.icoPath);

      const resetRes = materializeBrandingFiles(tempDir, null);
      expect(resetRes.hasIcon).toBe(false);
      expect(existsSync(join(tempDir, BRANDING_ICON_FILE))).toBe(false);
      expect(existsSync(join(tempDir, BRANDING_TRAY_ICON_FILE))).toBe(false);
      expect(existsSync(res.icoPath)).toBe(true);
      expect(existsSync(changedResult.icoPath)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds valid Windows ICO header and entries from PNG buffers", () => {
    const { createIcoBufferFromPngBuffers } = require("./client-branding.mjs");
    const png16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
    const png32 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03, 0x04, 0x05]);

    const ico = createIcoBufferFromPngBuffers([
      { width: 16, height: 16, buffer: png16 },
      { width: 32, height: 32, buffer: png32 },
    ]);
    expect(ico).not.toBeNull();
    // 6-byte header + 2 * 16-byte entries = 38 bytes header
    expect(ico.length).toBe(6 + 32 + png16.length + png32.length);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // ICO type
    expect(ico.readUInt16LE(4)).toBe(2); // 2 images

    // Entry 1: 16x16
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt32LE(14)).toBe(png16.length);
    expect(ico.readUInt32LE(18)).toBe(38); // offset

    // Entry 2: 32x32
    expect(ico.readUInt8(22)).toBe(32);
    expect(ico.readUInt8(23)).toBe(32);
    expect(ico.readUInt32LE(30)).toBe(png32.length);
    expect(ico.readUInt32LE(34)).toBe(38 + png16.length);
  });

  it("synchronizes Windows shortcuts across Start Menu, Desktop and User Pinned TaskBar", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { syncWindowsShortcuts } = require("./client-branding.mjs");
    const tempRoot = mkdtempSync(join(tmpdir(), "win-shortcuts-test-"));
    try {
      const appData = join(tempRoot, "AppData");
      const desktop = join(tempRoot, "Desktop");
      const startMenu = join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
      const pinnedTaskbar = join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
      mkdirSync(startMenu, { recursive: true });
      mkdirSync(pinnedTaskbar, { recursive: true });
      mkdirSync(desktop, { recursive: true });

      // Create dummy shortcuts
      writeFileSync(join(startMenu, "EdgeEver.lnk"), "dummy");
      writeFileSync(join(desktop, "EdgeEver.lnk"), "dummy");
      writeFileSync(join(pinnedTaskbar, "EdgeEver.lnk"), "dummy");
      const fakeIcoPath = join(tempRoot, "branding-icon.ico");
      writeFileSync(fakeIcoPath, "dummy-ico");

      const written = [];
      const fakeWriter = (shortcutPath, operation, options) => {
        written.push({ shortcutPath, operation, options });
        return true;
      };

      const result = syncWindowsShortcuts({
        appDataDir: appData,
        desktopDir: desktop,
        execPath: "C:\\Program Files\\EdgeEver\\EdgeEver.exe",
        name: "岁玥史书",
        icoPath: fakeIcoPath,
        appUserModelId: "org.edgeever.desktop",
        shellWriter: fakeWriter,
      });

      expect(result.updated).toBe(3);
      expect(result.failed).toBe(0);
      expect(written.length).toBe(3);
      for (const item of written) {
        expect(item.operation).toBe("update");
        expect(item.options.description).toBe("岁玥史书");
        expect(item.options.icon).toBe(fakeIcoPath);
        expect(item.options.appUserModelId).toBe("org.edgeever.desktop");
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("restores Windows shortcut icons to the executable when custom branding is cleared", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { syncWindowsShortcuts } = require("./client-branding.mjs");
    const tempRoot = mkdtempSync(join(tmpdir(), "win-shortcuts-reset-test-"));
    try {
      const appData = join(tempRoot, "AppData");
      const startMenu = join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
      mkdirSync(startMenu, { recursive: true });
      writeFileSync(join(startMenu, "EdgeEver.lnk"), "dummy");
      const execPath = "C:\\Program Files\\EdgeEver\\EdgeEver.exe";
      const written = [];

      const result = syncWindowsShortcuts({
        appDataDir: appData,
        desktopDir: null,
        execPath,
        name: "EdgeEver",
        icoPath: null,
        shellWriter: (shortcutPath, operation, options) => {
          written.push({ shortcutPath, operation, options });
          return true;
        },
      });

      expect(result).toEqual({ updated: 1, failed: 0 });
      expect(written[0].options.icon).toBe(execPath);
      expect(written[0].options.iconIndex).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds Windows taskbar details with a stable app identity and versioned icon", () => {
    const {
      WINDOWS_APP_USER_MODEL_ID,
      buildWindowsTaskbarAppDetails,
    } = require("./client-branding.mjs");
    const execPath = "C:\\Program Files\\EdgeEver\\EdgeEver.exe";
    const iconPath = "C:\\Users\\me\\AppData\\Roaming\\EdgeEver\\branding-icon-a1b2c3d4.ico";

    expect(buildWindowsTaskbarAppDetails({
      iconPath,
      execPath,
      name: "岁玥史书",
      packaged: true,
    })).toEqual({
      appId: WINDOWS_APP_USER_MODEL_ID,
      appIconPath: iconPath,
      appIconIndex: 0,
      relaunchCommand: `"${execPath}"`,
      relaunchDisplayName: "岁玥史书",
    });

    expect(buildWindowsTaskbarAppDetails({
      iconPath: null,
      execPath,
      name: "EdgeEver",
      packaged: false,
    })).toEqual({
      appId: WINDOWS_APP_USER_MODEL_ID,
      appIconPath: execPath,
      appIconIndex: 0,
    });
  });

  it("builds and synchronizes linux desktop entry with custom branding", () => {
    const { readFileSync } = require("node:fs");
    const { buildLinuxDesktopEntryContent, syncLinuxDesktopEntry } = require("./client-branding.mjs");
    const content = buildLinuxDesktopEntryContent({
      name: "My App",
      execPath: "/opt/EdgeEver/EdgeEver",
      iconPath: "/home/user/.config/EdgeEver/branding-icon.png",
    });
    expect(content).toContain("Name=My App");
    expect(content).toContain('Exec="/opt/EdgeEver/EdgeEver" %U');
    expect(content).toContain("Icon=/home/user/.config/EdgeEver/branding-icon.png");
    expect(content).toContain("StartupWMClass=EdgeEver");

    const tempDir = mkdtempSync(join(tmpdir(), "desktop-entry-test-"));
    try {
      const ok = syncLinuxDesktopEntry({
        applicationsDir: tempDir,
        execPath: "/usr/bin/EdgeEver",
        name: "Sync Test",
        iconPath: "/tmp/icon.png",
      });
      expect(ok).toBe(true);
      const readContent = readFileSync(join(tempDir, "org.edgeever.desktop"), "utf8");
      expect(readContent).toContain("Name=Sync Test");
      expect(readContent).toContain("Icon=/tmp/icon.png");

      const edgeEverContent = readFileSync(join(tempDir, "EdgeEver.desktop"), "utf8");
      expect(edgeEverContent).toContain("Name=Sync Test");
      const lowerContent = readFileSync(join(tempDir, "edgeever.desktop"), "utf8");
      expect(lowerContent).toContain("Name=Sync Test");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
