import { expect, test } from "@playwright/test";

test.use({ actionTimeout: 10_000 });

test("desktop update controls stay usable after cancellation and distinguish available from downloading", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "个人中心", exact: true })).toBeVisible();
  await page.evaluate(() => {
    type Status = { state: "idle" | "available" | "downloading" | "downloaded"; currentVersion: string; latestVersion: string | null; version: string | null; downloadProgress?: { percent: number | null; transferred: number; total: number | null } | null };
    const callbacks = new Set<(status: Status) => void>();
    const status: Status = { state: "idle", currentVersion: "1.0.0", latestVersion: null, version: null };
    const preferences = { autoUpdateSupported: true, autoUpdateEnabled: true, windowEnabled: false, windowStart: "22:00", windowEnd: "06:00" };
    let confirm: ((accepted: boolean) => void) | null = null;
    let downloads = 0;
    const emit = () => callbacks.forEach((callback) => callback({ ...status }));
    const requestDownload = async () => {
      const accepted = await new Promise<boolean>((resolve) => { confirm = resolve; });
      confirm = null;
      if (!accepted) return { started: false, reason: "cancelled" };
      downloads += 1;
      status.state = "downloading";
      emit();
      return { started: true };
    };
    const browser = window as typeof window & {
      edgeeverDesktop: unknown;
      updateTest: { accept: (accepted: boolean) => void; pending: () => boolean; downloads: () => number; progress: (percent: number) => void; finish: () => void };
    };
    browser.edgeeverDesktop = {
      isAvailable: true,
      canClearLocalData: false,
      apiBaseUrl: location.origin,
      onCommand: () => () => {},
      onImportMarkdown: () => () => {},
      onScheduledTask: () => () => {},
      syncScheduledTasks: async () => ({ scheduled: 0 }),
      setAccountScope: async () => ({ ready: true, scope: "test" }),
      sidecarRequest: async (method: string) => {
        if (method === "sync.status") return { pending: 0, syncing: 0, error: 0, conflict: 0, cursor: 0, syncIdentity: null, lastSyncedAt: null };
        if (method === "notebook.list") return { notebooks: [] };
        if (method === "memo.list") return { memos: [], totalCount: 0, nextCursor: null };
        if (method === "sync.outbox.list") return { items: [] };
        throw new Error(`Unexpected test RPC: ${method}`);
      },
      getProxySettings: () => ({ mode: "off", protocol: "http", host: "", port: 0 }),
      updateStatus: async () => ({ ...status }),
      updatePreferences: async () => ({ ...preferences }),
      setUpdatePreferences: async () => ({ ...preferences }),
      onUpdateStatus: (callback: (value: Status) => void) => {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      checkUpdate: async () => {
        status.state = "available";
        status.latestVersion = "2.0.0";
        status.version = "2.0.0";
        emit();
        await requestDownload();
        return { ...status };
      },
      downloadUpdate: requestDownload,
      installUpdate: async () => ({ started: true }),
      systemInfo: async () => ({ appVersion: "1.0.0", autoUpdateSupported: true, platform: "linux", architecture: "x64", deviceModel: "Test", osVersion: "Linux", osRelease: "6.6", electron: "40", chrome: "144", dataDir: "" }),
    };
    browser.updateTest = {
      accept: (accepted) => confirm?.(accepted),
      pending: () => confirm !== null,
      downloads: () => downloads,
      progress: (percent) => {
        status.downloadProgress = { percent, transferred: percent * 1024 ** 2, total: 100 * 1024 ** 2 };
        emit();
      },
      finish: () => { status.state = "downloaded"; status.downloadProgress = null; emit(); },
    };
  });
  await page.getByRole("button", { name: "个人中心", exact: true }).click();
  await page.getByRole("button", { name: /客户端更新.*查看当前版本/ }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("等待下载确认…", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { updateTest: { downloads: () => number } }).updateTest.downloads())).toBe(0);
  await page.evaluate(() => (window as unknown as { updateTest: { accept: (value: boolean) => void } }).updateTest.accept(false));
  await expect(page.getByText("发现新版本，确认后才会下载。", { exact: true })).toBeVisible();
  const downloadButton = page.getByRole("button", { name: "下载更新", exact: true });
  await expect(downloadButton).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("desktop-update-cancelled.png") });
  await downloadButton.click();
  await expect(page.getByText("等待下载确认…", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { updateTest: { accept: (value: boolean) => void } }).updateTest.accept(true));
  await expect(page.getByRole("button", { name: "正在下载更新…", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { updateTest: { downloads: () => number } }).updateTest.downloads())).toBe(1);
  await page.evaluate(() => (window as unknown as { updateTest: { progress: (percent: number) => void } }).updateTest.progress(25));
  await expect(page.getByText("正在下载更新… · 25.0% · 已下载 25.0 MB / 总大小 100.0 MB", { exact: true }).first()).toBeVisible();
  await page.evaluate(() => (window as unknown as { updateTest: { progress: (percent: number) => void } }).updateTest.progress(75));
  await expect(page.getByText("正在下载更新… · 75.0% · 已下载 75.0 MB / 总大小 100.0 MB", { exact: true }).first()).toBeVisible();
  const progressNotice = page.getByRole("status", { name: "正在下载更新… · 75.0% · 已下载 75.0 MB / 总大小 100.0 MB", exact: true });
  await expect(progressNotice).toHaveText("75.0%");
  expect(await progressNotice.evaluate((element) => {
    const footer = element.closest("footer")!;
    return element.getBoundingClientRect().right <= footer.getBoundingClientRect().right;
  })).toBe(true);
  await progressNotice.focus();
  await expect(page.getByRole("tooltip")).toContainText("已下载 75.0 MB / 总大小 100.0 MB");
  await page.screenshot({ path: test.info().outputPath("desktop-update-progress.png") });
  await page.evaluate(() => (window as unknown as { updateTest: { finish: () => void } }).updateTest.finish());
  await expect(page.getByText(/已下载 .*总大小/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重启以更新", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("desktop-update-ready.png") });
  expect(errors).toEqual([]);
});
