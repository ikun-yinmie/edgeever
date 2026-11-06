import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let electronPath;
try { electronPath = createRequire(import.meta.url)("electron"); } catch { /* No runtime on non-desktop CI jobs. */ }
const available = process.platform === "win32" && typeof electronPath === "string" && existsSync(electronPath);
test.skipIf(!available)("Windows native Electron shortcut branding and Shell32 notification", () => {
  const root = mkdtempSync(join(tmpdir(), "edgeever-native-branding-"));
  try {
    const env = { ...process.env, EDGE_EVER_BRANDING_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electronPath, [fileURLToPath(new URL("./fixtures/windows-branding-probe.mjs", import.meta.url))], {
      env, encoding: "utf8", timeout: 60000, windowsHide: true,
    });
    expect({ error: result.error?.message, status: result.status, output: result.status === 0 ? "" : result.stdout + result.stderr })
      .toEqual({ error: undefined, status: 0, output: "" });
    expect(result.stdout).toContain("WINDOWS_BRANDING_NATIVE_OK");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 65000);
