import { expect, test, type Page } from "@playwright/test";

// Every API request is intercepted: this suite never needs SMTP or a real account.
test.use({ storageState: { cookies: [], origins: [] } });

type Failure = { code: string; status: number; details?: Record<string, unknown> };
type Submission = { requestId: string; content: string; replyTo?: string | null; systemInfo: string | null };

const mockWorkspace = async (page: Page) => {
  const state = {
    feedback: { enabled: true, contactEmail: null as string | null },
    configStatus: 200,
    configGate: null as Promise<void> | null,
    postGate: null as Promise<void> | null,
    failure: null as Failure | null,
    adminFailure: null as Failure | null,
    accountEmail: {
      email: "bound@example.test" as string | null,
      emailVerifiedAt: "2026-11-28T00:00:00.000Z" as string | null,
      canManage: true,
      emailDeliveryConfigured: true,
    },
    accountEmailFailure: null as Failure | null,
    accountEmailGate: null as Promise<void> | null,
    emailCodeFailure: null as Failure | null,
    emailVerifyFailure: null as Failure | null,
    emailCodeRequests: [] as Array<{ email: string; currentPassword: string }>,
    emailVerifyRequests: [] as Array<{ email: string; code: string; currentPassword: string }>,
    configReads: 0,
    submissions: [] as Submission[],
    patches: [] as Record<string, unknown>[],
    settings: {
      registrationEnabled: false, registrationCodeRequired: false, inviteRequired: false,
      smtpHost: "smtp.example.test", smtpPort: 587, smtpSecure: false, smtpUsername: "sender",
      smtpFromAddress: "sender@example.test", smtpFromName: "Test", smtpPasswordConfigured: true,
      abuseGuardEnabled: true, codeIpHourlyLimit: 10, codeIpDailyLimit: 50,
      feedbackEnabled: false, feedbackRecipientEmail: null as string | null, contactEmail: null as string | null,
      siteName: null, siteDescription: null, siteIcon: null,
    },
  };
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { copied = text; }, readText: async () => copied,
    } });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    const fail = (failure: Failure) => json({ error: {
      code: failure.code, message: "Untranslated server message must not leak", details: failure.details,
    } }, failure.status);
    if (path === "/api/v1/public/feedback") {
      state.configReads++;
      if (state.configGate) await state.configGate;
      return state.configStatus === 200 ? json({ feedback: state.feedback })
        : fail({ code: "unavailable", status: state.configStatus });
    }
    if (path === "/api/v1/feedback") {
      state.submissions.push(route.request().postDataJSON());
      if (state.postGate) await state.postGate;
      return state.failure ? fail(state.failure) : json({ ok: true });
    }
    if (path === "/api/v1/admin/instance-settings") {
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON();
        state.patches.push(patch);
        if (state.adminFailure) return fail(state.adminFailure);
        Object.assign(state.settings, patch);
      }
      return json({ settings: state.settings });
    }
    if (path === "/api/v1/auth/email") {
      if (state.accountEmailGate) await state.accountEmailGate;
      return state.accountEmailFailure ? fail(state.accountEmailFailure) : json({ accountEmail: state.accountEmail });
    }
    if (path === "/api/v1/auth/email/code") {
      state.emailCodeRequests.push(route.request().postDataJSON());
      return state.emailCodeFailure ? fail(state.emailCodeFailure)
        : json({ ok: true, expiresInMinutes: 10, cooldownSeconds: 60 });
    }
    if (path === "/api/v1/auth/email/verify") {
      const input = route.request().postDataJSON();
      state.emailVerifyRequests.push(input);
      if (state.emailVerifyFailure) return fail(state.emailVerifyFailure);
      if (input.code !== "654321") return fail({ code: "email_code_invalid", status: 400 });
      state.accountEmail.email = input.email;
      state.accountEmail.emailVerifiedAt = "2026-11-28T01:00:00.000Z";
      return json({ accountEmail: state.accountEmail });
    }
    if (path === "/api/v1/auth/session") return json({
      authRequired: true, authenticated: true, demoMode: false,
      user: { id: "feedback-test-user", username: "feedback_tester", displayName: "Feedback tester", role: "owner", accountType: "user" },
    });
    if (path === "/api/v1/public/registration") return json({ registration: { enabled: false, codeRequired: false, inviteRequired: false } });
    if (path === "/api/health") return json({ ok: true, runtime: "cloudflare-workers" });
    if (path === "/api/v1/notebooks") return json({ notebooks: [] });
    if (path === "/api/v1/memos") return json({ memos: [], totalCount: 0, nextCursor: null });
    if (path === "/api/v1/sync/bootstrap") return json({ notebooks: [], memos: [], snapshotCursor: 0, syncIdentity: "feedback-tests", totalCount: 0, nextAfterId: null });
    if (path === "/api/v1/sync/changes") return json({ changes: [], cursor: 0, serverCursor: 0, syncIdentity: "feedback-tests", hasMore: false });
    if (path === "/api/v1/tags") return json({ tags: [] });
    if (path === "/api/v1/shared-with-me") return json({ groups: [], notebooks: [], memos: [], sharedByMe: [] });
    if (path === "/api/v1/memo-link-shares") return json({ shares: [] });
    return json({ error: { code: "NOT_FOUND", message: "Not part of the feedback fixture" } }, 404);
  });
  return state;
};

const openFeedback = async (page: Page) => {
  await page.getByRole("button", { name: /意见反馈/ }).click();
  const dialog = page.getByRole("dialog", { name: "意见反馈", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
};

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  test.describe(`feedback ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("loads with retry, refreshes on reopen and offers public contact when disabled", async ({ page }) => {
      const state = await mockWorkspace(page);
      let release!: () => void;
      state.configGate = new Promise<void>((resolve) => { release = resolve; });
      state.configStatus = 503;
      await page.goto("/settings");
      const dialog = await openFeedback(page);
      await expect(dialog.getByText("正在检查反馈服务…", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "提交反馈", exact: true })).toHaveCount(0);
      release();
      await expect(dialog.getByRole("alert")).toContainText("无法加载反馈配置");
      state.configStatus = 200;
      state.configGate = null;
      await dialog.getByRole("button", { name: "重试", exact: true }).click();
      await expect(dialog.getByLabel("反馈内容", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      state.feedback = { enabled: false, contactEmail: "admin@example.test" };
      await openFeedback(page);
      await expect(dialog).toContainText("本站暂未开启在线反馈，请发送邮件至：admin@example.test");
      await expect(dialog.getByRole("link", { name: "admin@example.test", exact: true })).toHaveAttribute("href", "mailto:admin@example.test");
      await dialog.getByRole("button", { name: "复制邮箱", exact: true }).click();
      await expect(dialog.getByText("邮箱已复制。", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("admin@example.test");
      await dialog.screenshot({ path: test.info().outputPath(`feedback-disabled-${viewport.name}.png`) });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      state.feedback.contactEmail = null;
      await openFeedback(page);
      await expect(dialog).toContainText("尚未配置联系方式");
      await expect(dialog.getByRole("link")).toHaveCount(0);
      expect(state.configReads).toBe(4);
      expect(state.submissions).toHaveLength(0);
    });

    test("validates real fields, preserves failed drafts and idempotency, then clears successful drafts", async ({ page }) => {
      const state = await mockWorkspace(page);
      state.failure = { status: 502, code: "email_delivery_failed" };
      state.feedback.contactEmail = "support@example.test";
      await page.goto("/settings");
      const dialog = await openFeedback(page);
      const content = dialog.getByLabel("反馈内容", { exact: true });
      await expect(dialog).toContainText("bound@example.test");
      await expect(dialog.getByLabel("回复邮箱（可选）", { exact: true })).toHaveCount(0);
      const submit = dialog.getByRole("button", { name: "提交反馈", exact: true });
      await content.fill("   ");
      await submit.click();
      await expect(content).toHaveAttribute("aria-invalid", "true");
      await content.fill("a".repeat(5001));
      await submit.click();
      await expect(dialog.getByRole("alert")).toContainText("1–5000");
      expect(state.submissions).toHaveLength(0);
      await content.fill("  可复现的问题  ");
      await submit.click();
      await expect(dialog.getByRole("alert")).toContainText("反馈邮件发送失败");
      await expect(content).toHaveValue("  可复现的问题  ");
      await expect(dialog).toContainText("bound@example.test");
      await expect(dialog.getByRole("link", { name: "support@example.test", exact: true })).toHaveAttribute("href", "mailto:support@example.test");
      await dialog.getByRole("button", { name: "复制邮箱", exact: true }).click();
      await expect(dialog.getByText("邮箱已复制。", { exact: true })).toBeVisible();
      expect(state.submissions[0]).toMatchObject({ content: "可复现的问题", systemInfo: null });
      expect([undefined, null, "bound@example.test"]).toContain(state.submissions[0].replyTo);
      expect(state.submissions[0].requestId).toMatch(/^[a-f\d-]{36}$/i);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await openFeedback(page);
      await submit.click();
      await expect.poll(() => state.submissions.length).toBe(2);
      await expect(dialog.getByRole("alert")).toContainText("反馈邮件发送失败");
      expect(state.submissions[1]).toEqual(state.submissions[0]);
      await content.fill("修改后的问题");
      state.failure = null;
      let release!: () => void;
      state.postGate = new Promise<void>((resolve) => { release = resolve; });
      await submit.click();
      await expect(dialog.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
      await expect(content).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await openFeedback(page);
      await expect(dialog.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
      await expect(content).toHaveValue("修改后的问题");
      await expect.poll(() => state.submissions.length).toBe(3);
      expect(state.submissions[2].requestId).not.toBe(state.submissions[0].requestId);
      release();
      await expect(dialog).toContainText("反馈已发送");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await openFeedback(page);
      await expect(content).toHaveValue("");
      await expect(dialog).toContainText("bound@example.test");
      await expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(state.submissions).toHaveLength(3);
    });

    test("uses the server recovery interval, keeps waiting across reopen and recovers", async ({ page }) => {
      const state = await mockWorkspace(page);
      await page.clock.install();
      state.failure = { status: 429, code: "feedback_rate_limited", details: { retryAfterSeconds: 120 } };
      state.feedback.contactEmail = "support@example.test";
      await page.goto("/settings");
      const dialog = await openFeedback(page);
      await dialog.getByLabel("反馈内容", { exact: true }).fill("等待限频恢复");
      const submit = dialog.getByRole("button", { name: "提交反馈", exact: true });
      await submit.click();
      await expect(dialog.getByRole("alert")).toContainText("已达到反馈提交上限");
      await expect(dialog).toContainText("可重试时间：");
      await expect(dialog.getByRole("link", { name: "support@example.test", exact: true })).toBeVisible();
      await expect(submit).toBeDisabled();
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.clock.fastForward(60_000);
      await openFeedback(page);
      await expect(submit).toBeDisabled();
      await expect(dialog.getByLabel("反馈内容", { exact: true })).toHaveValue("等待限频恢复");
      await page.clock.fastForward(60_001);
      await expect(submit).toBeEnabled();
      state.failure = null;
      await submit.click();
      await expect(dialog).toContainText("反馈已发送");
      expect(state.submissions).toHaveLength(2);
      expect(state.submissions[1].requestId).toBe(state.submissions[0].requestId);
    });

    test("verifies a binding inside feedback and keeps the original draft through failures", async ({ page }) => {
      const state = await mockWorkspace(page);
      await page.goto("/settings");
      const dialog = await openFeedback(page);
      const content = dialog.getByLabel("反馈内容", { exact: true });
      await content.fill("验证完成后继续发送原来的反馈");
      state.accountEmail.emailVerifiedAt = null;
      state.failure = { code: "feedback_email_unverified", status: 403 };
      await dialog.getByRole("button", { name: "提交反馈", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "提交反馈", exact: true })).toBeDisabled();
      await expect(content).toHaveValue("验证完成后继续发送原来的反馈");
      await dialog.getByRole("button", { name: "绑定或验证邮箱", exact: true }).click();
      const manager = page.getByRole("dialog", { name: "账号邮箱", exact: true });
      await expect(manager).toBeVisible();
      await expect(manager.locator("form form")).toHaveCount(0);
      await manager.getByLabel("新邮箱", { exact: true }).fill("new-bound@example.test");
      await manager.getByLabel("当前密码", { exact: true }).fill("incorrect-password");
      state.emailCodeFailure = { code: "invalid_current_password", status: 400 };
      await manager.getByRole("button", { name: "发送验证码", exact: true }).click();
      await expect(manager.getByRole("alert")).toContainText("当前密码");
      await expect(manager.getByRole("alert")).not.toContainText("Untranslated server message");
      state.emailCodeFailure = null;
      await manager.getByLabel("当前密码", { exact: true }).fill("controlled-test-password");
      await manager.getByRole("button", { name: "发送验证码", exact: true }).click();
      await expect(manager.getByLabel("邮箱验证码", { exact: true })).toBeEnabled();
      expect(state.emailCodeRequests.at(-1)).toEqual({ email: "new-bound@example.test", currentPassword: "controlled-test-password" });
      await manager.getByLabel("邮箱验证码", { exact: true }).fill("000000");
      await manager.getByRole("button", { name: "确认绑定", exact: true }).click();
      await expect(manager.getByRole("alert")).toContainText("验证码");
      await expect(manager.getByLabel("新邮箱", { exact: true })).toHaveValue("new-bound@example.test");
      await manager.screenshot({ path: test.info().outputPath(`account-email-verification-${viewport.name}.png`) });
      await manager.getByLabel("邮箱验证码", { exact: true }).fill("654321");
      await manager.getByRole("button", { name: "确认绑定", exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("new-bound@example.test");
      await expect(content).toHaveValue("验证完成后继续发送原来的反馈");
      await expect(dialog.getByRole("button", { name: "提交反馈", exact: true })).toBeEnabled();
      await dialog.screenshot({ path: test.info().outputPath(`feedback-verified-${viewport.name}.png`) });
      state.failure = null;
      await dialog.getByRole("button", { name: "提交反馈", exact: true }).click();
      await expect(dialog).toContainText("反馈已发送");
      expect(state.submissions).toHaveLength(2);
      expect(state.submissions[1]).toEqual(state.submissions[0]);
      expect(state.submissions[1].replyTo).toBeUndefined();
    });

    test("account settings retain the old email until rebind confirmation and clear credentials afterwards", async ({ page }) => {
      const state = await mockWorkspace(page);
      await page.goto("/settings");
      await page.getByRole("button", { name: "登录设置", exact: true }).click();
      const card = page.getByRole("region", { name: "账号邮箱", exact: true });
      await expect(card).toContainText("bound@example.test");
      await card.getByLabel("新邮箱", { exact: true }).fill("Replacement@Example.test");
      await card.getByLabel("当前密码", { exact: true }).fill("controlled-test-password");
      await card.getByRole("button", { name: "发送验证码", exact: true }).click();
      await expect(card.getByLabel("邮箱验证码", { exact: true })).toBeEnabled();
      await expect(card).toContainText("bound@example.test");
      expect(state.accountEmail.email).toBe("bound@example.test");
      await card.getByLabel("邮箱验证码", { exact: true }).fill("654321");
      await card.getByRole("button", { name: "确认绑定", exact: true }).click();
      await expect(card).toContainText("邮箱已验证并绑定");
      await expect(card).toContainText("Replacement@Example.test");
      await expect(card.getByLabel("当前密码", { exact: true })).toHaveValue("");
      await expect(card.getByLabel("邮箱验证码", { exact: true })).toHaveValue("");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`account-email-settings-${viewport.name}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test("blocks stale verified-email cache while refreshing or after a failed refresh", async ({ page }) => {
      const state = await mockWorkspace(page);
      await page.goto("/settings");
      const dialog = await openFeedback(page);
      const submit = dialog.getByRole("button", { name: "提交反馈", exact: true });
      await expect(submit).toBeEnabled();
      await dialog.getByLabel("反馈内容", { exact: true }).fill("刷新失败时保留这段草稿");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      let release!: () => void;
      state.accountEmailGate = new Promise<void>((resolve) => { release = resolve; });
      state.accountEmailFailure = { code: "unavailable", status: 503 };
      await openFeedback(page);
      await expect(submit).toBeDisabled();
      release();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(submit).toBeDisabled();
      await expect(dialog.getByLabel("反馈内容", { exact: true })).toHaveValue("刷新失败时保留这段草稿");
      expect(state.submissions).toHaveLength(0);
      state.accountEmailGate = null;
      state.accountEmailFailure = null;
      await dialog.getByRole("button", { name: "重试", exact: true }).click();
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(dialog).toContainText("反馈已发送");
      expect(state.submissions).toHaveLength(1);
    });

    test("handles busy and disabled responses without exposing raw server errors", async ({ page }) => {
      const state = await mockWorkspace(page);
      state.failure = { status: 409, code: "feedback_busy" };
      await page.goto("/settings");
      const dialog = await openFeedback(page);
      const content = dialog.getByLabel("反馈内容", { exact: true });
      await content.fill("服务状态可能已改变");
      await dialog.getByRole("button", { name: "提交反馈", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("反馈服务繁忙");
      await expect(content).toHaveValue("服务状态可能已改变");
      state.failure = { status: 403, code: "feedback_disabled", details: { contactEmail: "fallback@example.test" } };
      await dialog.getByRole("button", { name: "提交反馈", exact: true }).click();
      await expect(dialog).toContainText("本站暂未开启在线反馈，请发送邮件至：fallback@example.test");
      await expect(dialog.getByRole("button", { name: "提交反馈", exact: true })).toHaveCount(0);
      await expect(dialog).not.toContainText("Untranslated server message");
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.height).toBeLessThanOrEqual(viewport.height);
    });
  });
}

test("opt-in diagnostics execute the real privacy filter and the submitted payload excludes local-only data", async ({ page }) => {
  const state = await mockWorkspace(page);
  await page.goto("/settings");
  const dialog = await openFeedback(page);
  const filtered = await page.evaluate(async () => {
    const modulePath = "/src/components/settings/SystemInfoPanel.tsx";
    const { getWebSystemInfoItems, getShareableWebSystemInfoItems } = await import(modulePath);
    const bridge = window.edgeeverDesktop;
    try {
      window.edgeeverDesktop = { isAvailable: true } as typeof bridge;
      const diagnostics = {
        instanceUrl: "https://private-instance.example.test",
        clientRuntime: { deviceModel: "Feedback device", dataDirectory: "/private/test-data" },
      };
      return {
        full: getWebSystemInfoItems((key: string) => key, "zh-CN", diagnostics),
        shareable: getShareableWebSystemInfoItems((key: string) => key, "zh-CN", diagnostics),
      };
    } finally { window.edgeeverDesktop = bridge; }
  });
  expect(filtered.full.some((item: { localOnly?: boolean }) => item.localOnly)).toBe(true);
  expect(JSON.stringify(filtered.shareable)).not.toContain("private-instance");
  expect(JSON.stringify(filtered.shareable)).not.toContain("/private/test-data");
  expect(JSON.stringify(filtered.shareable)).toContain("Feedback device");
  await dialog.getByLabel("反馈内容", { exact: true }).fill("附带安全诊断信息");
  await dialog.getByRole("checkbox").check();
  await expect(dialog).toContainText("请勿在反馈中填写密码、Token 或私人笔记内容");
  await dialog.getByRole("button", { name: "提交反馈", exact: true }).click();
  await expect(dialog).toContainText("反馈已发送");
  expect(state.submissions[0].systemInfo).toContain("屏幕分辨率");
  expect(state.submissions[0].systemInfo).not.toContain("http://127.0.0.1");
  expect(state.submissions[0].systemInfo).not.toContain("private-instance");
  expect(state.submissions[0].systemInfo).not.toContain("/private/test-data");
});

test("email card validates independently, localizes configuration failures and saves only its own fields", async ({ page }) => {
  const state = await mockWorkspace(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "邮件服务", exact: true }).click();
  const enabled = page.getByRole("switch", { name: "启用在线反馈收件", exact: true });
  const recipient = page.getByLabel("内部反馈收件邮箱", { exact: true });
  const contact = page.getByLabel("公开站长联系邮箱", { exact: true });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(page.getByText(/当前注册流程未使用邮箱验证码/)).toContainText("SMTP 仍可用于已启用的在线反馈");
  await enabled.check();
  await save.click();
  await expect(page.getByRole("alert")).toContainText("请填写内部反馈收件邮箱");
  await recipient.fill("invalid-address");
  await contact.fill("also-invalid");
  await save.click();
  await expect(recipient).toHaveAttribute("aria-invalid", "true");
  await expect(contact).toHaveAttribute("aria-invalid", "true");
  expect(state.patches).toHaveLength(0);
  await recipient.fill("private-inbox@example.test");
  await contact.fill("public-admin@example.test");
  state.adminFailure = { status: 400, code: "feedback_not_configured" };
  await save.click();
  await expect(page.getByText(/无法启用在线反馈：请检查 SMTP/)).toBeVisible();
  await expect(recipient).toHaveValue("private-inbox@example.test");
  await expect(contact).toHaveValue("public-admin@example.test");
  await expect(page.getByText("Untranslated server message must not leak", { exact: true })).toHaveCount(0);
  state.adminFailure = null;
  await enabled.uncheck();
  await save.click();
  await expect.poll(() => state.patches.length).toBe(2);
  expect(state.patches[1]).toMatchObject({ feedbackEnabled: false, feedbackRecipientEmail: "private-inbox@example.test", contactEmail: "public-admin@example.test" });
  expect(Object.keys(state.patches[1]).sort()).toEqual([
    "feedbackEnabled", "feedbackRecipientEmail", "contactEmail", "smtpHost", "smtpPort", "smtpSecure",
    "smtpUsername", "smtpFromAddress", "smtpFromName", "abuseGuardEnabled", "codeIpHourlyLimit", "codeIpDailyLimit",
  ].sort());
});
