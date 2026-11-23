import { devices, expect, test, type Page } from "@playwright/test";

const phone = devices["Pixel 7"];

test.use({ ...phone, storageState: { cookies: [], origins: [] } });

/** Mock every API request so account switching never touches real accounts or data. */
const mockAuthWorkspace = async (page: Page, authenticated = true) => {
  const state = {
    username: authenticated ? "mobile_first" : null,
    rejectLogin: false,
    rejectLogout: false,
  };
  const session = () => ({
    authRequired: true,
    authenticated: Boolean(state.username),
    demoMode: false,
    user: state.username ? {
      id: `user_${state.username}`,
      username: state.username,
      displayName: state.username,
      role: "member",
      accountType: "user",
    } : null,
  });

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/v1/auth/session") return json(session());
    if (path === "/api/v1/auth/login") {
      if (state.rejectLogin) {
        return json({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } }, 401);
      }
      state.username = route.request().postDataJSON().username;
      return json(session());
    }
    if (path === "/api/v1/auth/logout") {
      if (state.rejectLogout) {
        return json({ error: { code: "UNAVAILABLE", message: "Test logout failure" } }, 503);
      }
      state.username = null;
      return json({ ok: true });
    }
    if (path === "/api/v1/auth/sessions") {
      const timestamp = new Date().toISOString();
      return json({ sessions: [{
        id: "session_mobile_current", isCurrent: true, label: null,
        userAgent: phone.userAgent, createdAt: timestamp, lastSeenAt: timestamp,
        ipAddress: null, ipCountry: null, ipRegion: null,
      }] });
    }
    if (path === "/api/v1/public/registration") {
      return json({ registration: { enabled: false, codeRequired: false, inviteRequired: false } });
    }
    if (path === "/api/health") return json({ ok: true, runtime: "cloudflare-workers" });
    if (path === "/api/v1/notebooks") return json({ notebooks: [] });
    if (path === "/api/v1/memos") return json({ memos: [], totalCount: 0, nextCursor: null });
    if (path === "/api/v1/sync/bootstrap") {
      return json({
        notebooks: [], memos: [], snapshotCursor: 0,
        syncIdentity: `mobile-auth-${state.username}`, totalCount: 0, nextAfterId: null,
      });
    }
    if (path === "/api/v1/sync/changes") {
      return json({
        changes: [], cursor: 0, serverCursor: 0,
        syncIdentity: `mobile-auth-${state.username}`, hasMore: false,
      });
    }
    if (path === "/api/v1/tags") return json({ tags: [] });
    if (path === "/api/v1/shared-with-me") {
      return json({ groups: [], notebooks: [], memos: [], sharedByMe: [] });
    }
    if (path === "/api/v1/memo-link-shares") return json({ shares: [] });
    return json({ error: { code: "NOT_FOUND", message: "Not part of this test fixture" } }, 404);
  });

  return state;
};

const mobileNav = (page: Page) => page.getByRole("navigation", { name: "移动端主导航" });

const signIn = async (page: Page, username = "mobile_second") => {
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "开启工作区", exact: true }).click();
};

const expectHome = async (page: Page) => {
  await expect(page).toHaveURL("/");
  await expect(mobileNav(page).getByRole("button", { name: "首页", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect(mobileNav(page).getByRole("button", { name: "我的", exact: true }))
    .not.toHaveAttribute("aria-current", "page");
};

const openLoginSettings = async (page: Page) => {
  await mobileNav(page).getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "登录设置", exact: true }).click();
};

test("logging out from My and switching accounts opens home instead of the previous settings page", async ({ page }) => {
  await mockAuthWorkspace(page);
  await page.goto("/");
  await openLoginSettings(page);
  await expect(page.getByText("mobile_first", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出此设备", exact: true }).click();
  await expect(page.getByLabel("账号", { exact: true })).toBeVisible();
  await expect(page).toHaveURL("/");

  await signIn(page);
  await expectHome(page);
  await page.goBack();
  await expectHome(page);

  await openLoginSettings(page);
  await expect(page.getByText("mobile_second", { exact: true })).toBeVisible();
  await expect(page.getByText("mobile_first", { exact: true })).toHaveCount(0);
});

test("a successful login clears a stale settings URL including its query and hash", async ({ page }) => {
  await mockAuthWorkspace(page, false);
  await page.goto("/settings?view=trash#previous-account");
  await signIn(page);
  await expectHome(page);
});

test("a failed login stays on the login page and a successful retry opens home", async ({ page }) => {
  const state = await mockAuthWorkspace(page, false);
  state.rejectLogin = true;
  await page.goto("/settings");
  await signIn(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL("/settings");
  await expect(mobileNav(page)).toHaveCount(0);

  state.rejectLogin = false;
  await signIn(page);
  await expectHome(page);
});

test("refreshing an already authenticated settings page preserves the current page", async ({ page }) => {
  await mockAuthWorkspace(page);
  await page.goto("/settings");
  // 设置页在移动端是全屏页，底部导航按设计隐藏；这里只验证当前页面被保留。
  const loginSettings = page.getByRole("button", { name: "登录设置", exact: true });
  await expect(loginSettings).toBeVisible();
  await expect(page).toHaveURL("/settings");
  await page.reload();
  await expect(page).toHaveURL("/settings");
  await expect(loginSettings).toBeVisible();
});

test("a failed logout does not leave the current signed-in page", async ({ page }) => {
  const state = await mockAuthWorkspace(page);
  state.rejectLogout = true;
  await page.goto("/");
  await openLoginSettings(page);
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/v1/auth/logout");
  const logoutButton = page.getByRole("button", { name: "退出此设备", exact: true });
  await logoutButton.click();
  expect((await response).status()).toBe(503);
  await expect(logoutButton).toBeEnabled();
  await expect(page).toHaveURL("/settings");
  await expect(page.getByText("mobile_first", { exact: true })).toBeVisible();
});
