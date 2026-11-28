import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`startup loading follows ${theme} theme and reduced motion`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(theme => localStorage.setItem("edgeever.theme", theme), theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/v1/plugins/github/**", route => route.fulfill({ status: 404, body: "Disabled in this test" }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/auth/session", async route => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto("/");
      const surface = page.locator('[data-loading-surface="startup"]');
      await expect(surface).toBeVisible({ timeout: 30_000 });
      await expect(surface).toHaveAttribute("role", "status");
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      const animations = await surface.evaluate(element => [element, ...element.querySelectorAll("*")].flatMap(node => {
        return ["", "::before", "::after"].map(pseudo => getComputedStyle(node, pseudo || null).animationName);
      }));
      expect(animations.every(animation => animation === "none")).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`startup-${theme}-reduced-motion.png`) });
      release();
      await expect(surface).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "待办总览", exact: true })).toBeVisible({ timeout: 60_000 });
    } finally {
      release();
    }
  });
}

test("note and task initial loading use skeletons while background refresh keeps task content", async ({ page }) => {
  test.setTimeout(180_000);
  await page.route("**/api/v1/plugins/github/**", route => route.fulfill({ status: 404, body: "Disabled in this test" }));
  const { notebooks } = await (await page.request.get("/api/v1/notebooks")).json();
  const title = `loading-surface-${Date.now()}`;
  const response = await page.request.post("/api/v1/memos", { data: {
    notebookId: notebooks[0].id, title, contentMarkdown: "- [ ] Loading test task",
  } });
  expect(response.status()).toBe(201);
  const { memo } = await response.json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/memos/${memo.id}`, async route => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  try {
    await page.goto(`/?openMemo=${memo.id}`);
    await expect(page.locator('[data-loading-surface="editor"]')).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: test.info().outputPath("editor-loading-skeleton.png") });
    release();
    await expect(page.locator('[data-loading-surface="editor"]')).toHaveCount(0, { timeout: 60_000 });
    let releaseTasks!: () => void;
    const tasksGate = new Promise<void>(resolve => { releaseTasks = resolve; });
    const listPattern = /\/api\/v1\/memos\?/;
    await page.route(listPattern, async route => { await tasksGate; await route.continue(); });
    try {
      await page.getByRole("button", { name: "待办总览", exact: true }).click();
      await expect(page.locator('[data-loading-surface="tasks"]')).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: test.info().outputPath("tasks-loading-skeleton.png") });
    } finally {
      releaseTasks();
    }
    await expect(page.locator(`[data-task-memo="${memo.id}"]`)).toBeVisible({ timeout: 60_000 });
    await page.unroute(listPattern);
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    await page.route(listPattern, async route => { await refreshGate; await route.continue(); });
    try {
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await expect(page.locator(`[data-task-memo="${memo.id}"]`)).toBeVisible();
      await expect(page.locator('[data-loading-surface="tasks"]')).toHaveCount(0);
    } finally {
      releaseRefresh();
    }
  } finally {
    release();
    await page.unroute(`**/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}`);
    await page.request.delete(`/api/v1/memos/${memo.id}?permanent=1`);
  }
});
