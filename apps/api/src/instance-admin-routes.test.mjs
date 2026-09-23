import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { sha256 } from "./hash-utils.ts";
import { registerInstanceAdminRoutes } from "./instance-admin-routes.ts";
import { encryptSecret } from "./secret-encryption.ts";

class SqliteD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.db, this.sql, bindings);
  }

  async all() {
    return { results: this.db.query(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first() {
    return this.db.query(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    this.db.query(this.sql).run(...this.bindings);
    return { success: true, meta: {} };
  }
}

class SqliteD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    return this.db.transaction(() => statements.map((statement) =>
      this.db.query(statement.sql).run(...statement.bindings)))();
  }
}

const AUTH_PASSWORD = "test-password";
const ENCRYPTION_KEY = `edgeever:object-storage:v1:${AUTH_PASSWORD}`;

const createEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  return {
    sqlite,
    environment: {
      EDGE_EVER_AUTH_PASSWORD: AUTH_PASSWORD,
      storage: { db: new SqliteD1Database(sqlite) },
    },
  };
};

const createTestApp = (role = "owner") => {
  const app = new Hono();
  registerInstanceAdminRoutes(app, {
    authenticateRequest: async () => ({
      kind: "user",
      actorType: "user",
      actorId: "usr_owner",
      username: "admin",
      displayName: "Admin",
      scopes: [],
      workspaceId: "ws_owner",
      role,
    }),
  });
  return app;
};

const updateSettings = (sqlite, patch) => {
  const entries = Object.entries(patch);
  sqlite
    .query(`UPDATE instance_settings SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = 'instance'`)
    .run(...entries.map(([, value]) => value));
};

const configureSmtp = async (sqlite) => {
  updateSettings(sqlite, {
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    smtp_from_address: "noreply@example.com",
    smtp_password_encrypted: await encryptSecret("smtp-pass", ENCRYPTION_KEY),
  });
};

const jsonRequest = (app, path, body, environment, headers = {}) => app.request(
  path,
  {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  },
  environment,
);

const seedCode = async (sqlite, { email, code, expiresInMs = 60_000, attempts = 0, ip = null, deviceId = null }) => {
  sqlite
    .query(
      `INSERT INTO email_verifications (id, email, code_hash, attempts, expires_at, created_at, ip, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `evc_${email}`,
      email,
      await sha256(`${email}:${code}`),
      attempts,
      new Date(Date.now() + expiresInMs).toISOString(),
      new Date().toISOString(),
      ip,
      deviceId,
    );
};

const createInvite = async (app, environment, payload = {}) => {
  const response = await jsonRequest(app, "/api/v1/admin/registration/invites", payload, environment);
  expect(response.status).toBe(201);
  return (await response.json()).invite;
};

const registerPayload = (overrides = {}) => ({
  username: "newcomer",
  email: "newcomer@example.com",
  password: "password123",
  emailCode: "123456",
  ...overrides,
});

describe("public registration configuration", () => {
  test("reports the invite requirement configured by the administrator", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, {
      registration_enabled: 1,
      registration_code_required: 1,
      registration_invite_required: 1,
    });

    const response = await app.request("/api/v1/public/registration", {}, environment);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      registration: { enabled: true, codeRequired: true, inviteRequired: true },
    });
    sqlite.close();
  });

  test("closes registration entirely when the administrator disabled it", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();

    const response = await jsonRequest(app, "/api/v1/public/registration/register", registerPayload(), environment);

    expect(response.status).toBe(403);
    sqlite.close();
  });
});

describe("registration invite codes", () => {
  test("rejects a registration without an invite code when one is required", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });

    const response = await jsonRequest(app, "/api/v1/public/registration/register", registerPayload(), environment);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invite_required" } });
    sqlite.close();
  });

  test("rejects an unknown invite code", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: "EE-AAAA-BBBB-CCCC" }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invite_invalid" } });
    sqlite.close();
  });

  test("consumes one use per registration and rejects a used-up invite", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const invite = await createInvite(app, environment, { maxUses: 1, note: "single use" });

    const accepted = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: invite.code }),
      environment,
    );
    expect(accepted.status).toBe(201);
    expect(sqlite.query("SELECT use_count FROM registration_invites WHERE id = ?").get(invite.id).use_count).toBe(1);

    const reused = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ username: "second", email: "second@example.com", inviteCode: invite.code }),
      environment,
    );
    expect(reused.status).toBe(403);
    expect(await reused.json()).toMatchObject({ error: { code: "invite_invalid" } });
    sqlite.close();
  });

  test("lets an invite with remaining uses register another member", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const invite = await createInvite(app, environment, { maxUses: 2 });

    for (const [username, email] of [["first", "first@example.com"], ["second", "second@example.com"]]) {
      const response = await jsonRequest(
        app,
        "/api/v1/public/registration/register",
        registerPayload({ username, email, inviteCode: invite.code }),
        environment,
      );
      expect(response.status).toBe(201);
    }
    expect(sqlite.query("SELECT use_count FROM registration_invites WHERE id = ?").get(invite.id).use_count).toBe(2);

    const exhausted = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ username: "third", email: "third@example.com", inviteCode: invite.code }),
      environment,
    );
    expect(exhausted.status).toBe(403);
    sqlite.close();
  });

  test("rejects a revoked invite", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const invite = await createInvite(app, environment, { maxUses: 5 });

    const revokeResponse = await jsonRequest(
      app,
      `/api/v1/admin/registration/invites/${invite.id}/revoke`,
      {},
      environment,
    );
    expect(revokeResponse.status).toBe(200);

    const rejected = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: invite.code }),
      environment,
    );
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: { code: "invite_invalid" } });
    sqlite.close();
  });

  test("rejects an expired invite", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const invite = await createInvite(app, environment, { maxUses: 1 });
    sqlite
      .query("UPDATE registration_invites SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), invite.id);

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: invite.code }),
      environment,
    );

    expect(response.status).toBe(403);
    sqlite.close();
  });

  test("lists invites with the code itself so it stays copyable", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    const invite = await createInvite(app, environment, { maxUses: 3, note: "for Alex" });

    const response = await app.request("/api/v1/admin/registration/invites", {}, environment);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({
      id: invite.id,
      code: invite.code,
      note: "for Alex",
      maxUses: 3,
      useCount: 0,
      source: "admin",
      owner: null,
      usedBy: null,
      usedAt: null,
    });
    sqlite.close();
  });

  test("keeps a legacy invite readable as a hint when its code can no longer be decrypted", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    sqlite
      .query(
        `INSERT INTO registration_invites (id, code_hash, code_hint, max_uses, use_count, created_at)
         VALUES ('inv_legacy', ?, 'EE-OLD…1234', 1, 0, ?)`,
      )
      .run(await sha256("invite:EE-OLD-CODE-1234"), new Date().toISOString());

    const body = await (await app.request("/api/v1/admin/registration/invites", {}, environment)).json();
    expect(body.invites[0]).toMatchObject({ id: "inv_legacy", code: null, codeHint: "EE-OLD…1234" });
    sqlite.close();
  });

  test("restores a revoked invite from the revoked list", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    const invite = await createInvite(app, environment);

    await app.request(`/api/v1/admin/registration/invites/${invite.id}/revoke`, { method: "POST" }, environment);
    const revoked = await (await app.request("/api/v1/admin/registration/invites", {}, environment)).json();
    expect(revoked.invites[0].revokedAt).not.toBeNull();

    const restored = await app.request(
      `/api/v1/admin/registration/invites/${invite.id}/restore`,
      { method: "POST" },
      environment,
    );
    expect(restored.status).toBe(200);
    const afterRestore = await (await app.request("/api/v1/admin/registration/invites", {}, environment)).json();
    expect(afterRestore.invites[0].revokedAt).toBeNull();
    expect(afterRestore.invites[0].code).toBe(invite.code);
    sqlite.close();
  });

  test("deletes selected invites from either list", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    const keep = await createInvite(app, environment, { note: "keep" });
    const active = await createInvite(app, environment, { note: "active" });
    const revoked = await createInvite(app, environment, { note: "revoked" });
    await app.request(`/api/v1/admin/registration/invites/${revoked.id}/revoke`, { method: "POST" }, environment);

    const response = await jsonRequest(
      app,
      "/api/v1/admin/registration/invites/delete",
      { ids: [active.id, revoked.id] },
      environment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, deleted: 2 });

    const remaining = await (await app.request("/api/v1/admin/registration/invites", {}, environment)).json();
    expect(remaining.invites.map((invite) => invite.id)).toEqual([keep.id]);
    sqlite.close();
  });

  test("rejects an empty selection for deletion", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    const response = await jsonRequest(
      app,
      "/api/v1/admin/registration/invites/delete",
      { ids: [] },
      environment,
    );
    expect(response.status).toBe(400);
    sqlite.close();
  });

  test("records which member an invite brought in", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const invite = await createInvite(app, environment, { maxUses: 1 });

    const accepted = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: invite.code }),
      environment,
    );
    expect(accepted.status).toBe(201);

    const body = await (await app.request("/api/v1/admin/registration/invites", {}, environment)).json();
    expect(body.invites[0].usedAt).not.toBeNull();
    expect(body.invites[0].usedBy).toMatchObject({ username: "newcomer" });
    sqlite.close();
  });

  test("keeps invite management owner-only", async () => {
    const { sqlite, environment } = createEnvironment();
    const memberApp = createTestApp("member");

    const list = await memberApp.request("/api/v1/admin/registration/invites", {}, environment);
    const create = await jsonRequest(memberApp, "/api/v1/admin/registration/invites", {}, environment);

    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
    sqlite.close();
  });
});

describe("member invite codes", () => {
  test("hands every member one code that stays copyable", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp("member");

    const empty = await (await app.request("/api/v1/me/invite-code", {}, environment)).json();
    expect(empty).toMatchObject({ invite: null, canCreate: true });

    const created = await app.request("/api/v1/me/invite-code", { method: "POST" }, environment);
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.invite).toMatchObject({ source: "user", maxUses: 1, useCount: 0, expiresAt: null });
    expect(createdBody.invite.code).toMatch(/^EE-/);

    // Asking again returns the same code instead of minting a second one.
    const again = await app.request("/api/v1/me/invite-code", { method: "POST" }, environment);
    expect(again.status).toBe(200);
    expect((await again.json()).invite.code).toBe(createdBody.invite.code);

    const listed = await (await app.request("/api/v1/me/invite-code", {}, environment)).json();
    expect(listed.invite.code).toBe(createdBody.invite.code);
    expect(listed.canCreate).toBe(false);
    sqlite.close();
  });

  test("locks a member code after its single use", async () => {
    const { sqlite, environment } = createEnvironment();
    const memberApp = createTestApp("member");
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const created = await (await memberApp.request("/api/v1/me/invite-code", { method: "POST" }, environment)).json();

    const registered = await jsonRequest(
      memberApp,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: created.invite.code }),
      environment,
    );
    expect(registered.status).toBe(201);

    const retry = await memberApp.request("/api/v1/me/invite-code", { method: "POST" }, environment);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "invite_already_used" } });

    const listed = await (await memberApp.request("/api/v1/me/invite-code", {}, environment)).json();
    expect(listed.invite).toMatchObject({ useCount: 1, maxUses: 1 });
    sqlite.close();
  });

  test("lets the administrator recover a consumed member code by deleting it", async () => {
    const { sqlite, environment } = createEnvironment();
    const memberApp = createTestApp("member");
    const adminApp = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_invite_required: 1 });
    const created = await (await memberApp.request("/api/v1/me/invite-code", { method: "POST" }, environment)).json();
    await jsonRequest(
      memberApp,
      "/api/v1/public/registration/register",
      registerPayload({ inviteCode: created.invite.code }),
      environment,
    );

    const listed = await (await adminApp.request("/api/v1/admin/registration/invites", {}, environment)).json();
    expect(listed.invites[0]).toMatchObject({ id: created.invite.id, source: "user" });

    await jsonRequest(adminApp, "/api/v1/admin/registration/invites/delete", { ids: [created.invite.id] }, environment);
    const regenerated = await memberApp.request("/api/v1/me/invite-code", { method: "POST" }, environment);
    expect(regenerated.status).toBe(201);
    expect((await regenerated.json()).invite.code).not.toBe(created.invite.code);
    sqlite.close();
  });

  test("refuses to hand back a revoked member code", async () => {
    const { sqlite, environment } = createEnvironment();
    const memberApp = createTestApp("member");
    const adminApp = createTestApp();
    const created = await (await memberApp.request("/api/v1/me/invite-code", { method: "POST" }, environment)).json();
    await adminApp.request(`/api/v1/admin/registration/invites/${created.invite.id}/revoke`, { method: "POST" }, environment);

    const retry = await memberApp.request("/api/v1/me/invite-code", { method: "POST" }, environment);
    expect(retry.status).toBe(409);
    sqlite.close();
  });
});

describe("registration email policy", () => {
  test("refuses a blocked domain before any email is delivered", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, email_blocklist: "gmail.com" });

    const response = await jsonRequest(app, "/api/v1/public/registration/code", { email: "someone@gmail.com" }, environment);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "email_domain_blocked" } });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM email_verifications").get().count).toBe(0);
    sqlite.close();
  });

  test("refuses an email outside the allowlist", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, {
      registration_enabled: 1,
      registration_code_required: 1,
      email_allowlist_enabled: 1,
      email_allowlist: "qq.com",
    });

    const response = await jsonRequest(app, "/api/v1/public/registration/code", { email: "someone@gmail.com" }, environment);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "email_domain_not_allowed" } });
    sqlite.close();
  });

  test("lets an allowlisted domain reach email delivery", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, {
      registration_enabled: 1,
      registration_code_required: 1,
      email_allowlist_enabled: 1,
      email_allowlist: "qq.com",
    });
    await configureSmtp(sqlite);

    const response = await jsonRequest(app, "/api/v1/public/registration/code", { email: "someone@qq.com" }, environment);

    expect(response.status).not.toBe(403);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM email_verifications").get().count).toBe(1);
    sqlite.close();
  });

  test("blocks a disallowed domain at registration time as well", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, email_blocklist: "gmail.com" });
    await seedCode(sqlite, { email: "someone@gmail.com", code: "777777" });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ email: "someone@gmail.com", emailCode: "777777" }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "email_domain_blocked" } });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM users").get().count).toBe(0);
    sqlite.close();
  });

  test("normalizes the saved allowlist and blocklist entries", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();

    const response = await app.request(
      "/api/v1/admin/instance-settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailAllowlist: " QQ.com \n@GMAIL.com, qq.com ", emailBlocklist: " spam.example " }),
      },
      environment,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings.emailAllowlist).toBe("qq.com\ngmail.com");
    expect(body.settings.emailBlocklist).toBe("spam.example");
    sqlite.close();
  });
});

describe("email verification code policy", () => {
  test("stores the configured lifetime and reports the resend cooldown", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, code_ttl_seconds: 120 });
    await configureSmtp(sqlite);

    const startedAt = Date.now();
    await jsonRequest(app, "/api/v1/public/registration/code", { email: "code@example.com" }, environment);

    const row = sqlite.query("SELECT expires_at FROM email_verifications WHERE email = ?").get("code@example.com");
    const lifetimeSeconds = (Date.parse(row.expires_at) - startedAt) / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(110);
    expect(lifetimeSeconds).toBeLessThanOrEqual(121);
    sqlite.close();
  });

  test("defaults the code lifetime to sixty seconds", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1 });
    await configureSmtp(sqlite);

    const startedAt = Date.now();
    await jsonRequest(app, "/api/v1/public/registration/code", { email: "default@example.com" }, environment);

    const row = sqlite.query("SELECT expires_at FROM email_verifications WHERE email = ?").get("default@example.com");
    const lifetimeSeconds = (Date.parse(row.expires_at) - startedAt) / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(50);
    expect(lifetimeSeconds).toBeLessThanOrEqual(61);
    sqlite.close();
  });

  test("blocks a resend inside the configured cooldown", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, code_resend_cooldown_seconds: 120 });
    await configureSmtp(sqlite);
    await seedCode(sqlite, { email: "cooldown@example.com", code: "111111" });

    const response = await jsonRequest(app, "/api/v1/public/registration/code", { email: "cooldown@example.com" }, environment);

    expect(response.status).toBe(429);
    sqlite.close();
  });

  test("limits code requests per network when the abuse guard is enabled", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, {
      registration_enabled: 1,
      registration_code_required: 1,
      abuse_guard_enabled: 1,
      code_ip_hourly_limit: 2,
    });
    await configureSmtp(sqlite);
    const headers = { "x-forwarded-for": "203.0.113.9" };

    await jsonRequest(app, "/api/v1/public/registration/code", { email: "ip1@example.com" }, environment, headers);
    await jsonRequest(app, "/api/v1/public/registration/code", { email: "ip2@example.com" }, environment, headers);
    const third = await jsonRequest(app, "/api/v1/public/registration/code", { email: "ip3@example.com" }, environment, headers);

    expect(third.status).toBe(429);
    sqlite.close();
  });

  test("ignores per-network limits while the abuse guard is switched off", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, {
      registration_enabled: 1,
      registration_code_required: 1,
      abuse_guard_enabled: 0,
      code_ip_hourly_limit: 1,
    });
    await configureSmtp(sqlite);
    const headers = { "x-forwarded-for": "203.0.113.10" };

    await jsonRequest(app, "/api/v1/public/registration/code", { email: "off1@example.com" }, environment, headers);
    const second = await jsonRequest(app, "/api/v1/public/registration/code", { email: "off2@example.com" }, environment, headers);

    expect(second.status).not.toBe(429);
    sqlite.close();
  });

  test("requires a device identifier when device binding is enabled", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, code_bind_device: 1 });
    await configureSmtp(sqlite);

    const response = await jsonRequest(app, "/api/v1/public/registration/code", { email: "nodevice@example.com" }, environment);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "device_id_required" } });
    sqlite.close();
  });
});

describe("verification code binding", () => {
  test("rejects a code sent to an email but verified from another device", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, code_bind_device: 1 });
    await seedCode(sqlite, { email: "bound@example.com", code: "222222", deviceId: "device-aaaaaaaaaa" });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ email: "bound@example.com", emailCode: "222222", deviceId: "device-bbbbbbbbbb" }),
      environment,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "email_code_invalid" } });
    sqlite.close();
  });

  test("accepts the code from the device that requested it", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, code_bind_device: 1 });
    await seedCode(sqlite, { email: "same@example.com", code: "333333", deviceId: "device-cccccccccc" });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ email: "same@example.com", emailCode: "333333", deviceId: "device-cccccccccc" }),
      environment,
    );

    expect(response.status).toBe(201);
    sqlite.close();
  });

  test("rejects a code verified from a different network when IP binding is on", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1, code_bind_ip: 1 });
    await seedCode(sqlite, { email: "ipbound@example.com", code: "444444", ip: "198.51.100.7" });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ email: "ipbound@example.com", emailCode: "444444" }),
      environment,
      { "x-forwarded-for": "198.51.100.99" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "email_code_invalid" } });
    sqlite.close();
  });

  test("drops an expired code and asks for a new one", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1 });
    await seedCode(sqlite, { email: "expired@example.com", code: "555555", expiresInMs: -1000 });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ email: "expired@example.com", emailCode: "555555" }),
      environment,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "email_code_expired" } });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM email_verifications WHERE email = ?").get("expired@example.com").count).toBe(0);
    sqlite.close();
  });

  test("counts wrong codes and refuses further attempts after the limit", async () => {
    const { sqlite, environment } = createEnvironment();
    const app = createTestApp();
    updateSettings(sqlite, { registration_enabled: 1, registration_code_required: 1 });
    await seedCode(sqlite, { email: "attempts@example.com", code: "666666", attempts: 6 });

    const response = await jsonRequest(
      app,
      "/api/v1/public/registration/register",
      registerPayload({ email: "attempts@example.com", emailCode: "666666" }),
      environment,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "email_code_invalid" } });
    sqlite.close();
  });
});
