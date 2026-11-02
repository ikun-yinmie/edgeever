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

  it("materializes branding icon to disk and cleans up when reset", () => {
    const { existsSync } = require("node:fs");
    const { BRANDING_ICON_FILE, materializeBrandingFiles } = require("./client-branding.mjs");
    const tempDir = mkdtempSync(join(tmpdir(), "branding-mat-test-"));
    try {
      const sample = Buffer.from("png-bytes", "utf8");
      const sampleDataUrl = `data:image/png;base64,${sample.toString("base64")}`;

      const res = materializeBrandingFiles(tempDir, sampleDataUrl);
      expect(res.hasIcon).toBe(true);
      expect(res.iconPath).toBe(join(tempDir, BRANDING_ICON_FILE));
      expect(existsSync(res.iconPath)).toBe(true);

      const resetRes = materializeBrandingFiles(tempDir, null);
      expect(resetRes.hasIcon).toBe(false);
      expect(existsSync(join(tempDir, BRANDING_ICON_FILE))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
