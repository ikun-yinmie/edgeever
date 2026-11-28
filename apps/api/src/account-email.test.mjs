import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { AccountEmailCodeRequestSchema, AccountEmailVerifySchema } from "@edgeever/shared";
import { registerAccountEmailRoutes } from "./account-email-routes.ts";
import { getAccountEmailStatus, requestAccountEmailCode, verifyAccountEmail } from "./account-email-service.ts";
import { hashPassword } from "./auth-crypto.ts";
import { authenticateSession, getInstanceUser, verifyLogin } from "./auth-service.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerUserRoutes } from "./user-routes.ts";
import { registerInstanceAdminRoutes } from "./instance-admin-routes.ts";
import { submitFeedback } from "./feedback-service.ts";
import { sha256 } from "./hash-utils.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { createCloudflareStorageAdapter } from "./cloudflare-storage-adapter.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrations = globSync(join(root, "migrations/*.sql")).sort();
const migration = migrations.find((path) => path.endsWith("0076_account_email_verification.sql"));
const password = "account-test-password";
const passwordHash = await hashPassword(password);
const details = { ip: "192.0.2.17", locale: "zh-CN" };
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

const seedUser = (sqlite, id, email = null, accountType = "user") => {
  const now = new Date().toISOString();
  sqlite.query(`INSERT INTO users (id, username, password_hash, display_name, email, account_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, id, passwordHash, id, email, accountType, now, now);
  sqlite.query(`INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(`ws_${id}`, id, now, now);
  sqlite.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`)
    .run(`ws_${id}`, id, now);
};

// Every fixture applies the real historical migration chain before adding users
// and upgrading to 0076. No production DB, bindings, or credentials are read.
const setup = ({ fileBacked = false } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-account-email-"));
  const sqlite = new Database(fileBacked ? join(directory, "upgrade.sqlite") : ":memory:");
  cleanup.push(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const path of migrations) if (path !== migration) sqlite.exec(readFileSync(path, "utf8"));
  seedUser(sqlite, "alice", "Legacy.Case@Example.COM");
  seedUser(sqlite, "bob", "bob@example.com");
  sqlite.exec(readFileSync(migration, "utf8"));
  const environment = { storage: createSelfHostedStorageAdapter(sqlite, join(directory, "resources")) };
  const sent = [];
  const dependencies = { sendEmail: async (...args) => { sent.push(args); } };
  const account = (id = "alice") => sqlite.query(`SELECT * FROM users WHERE id = ?`).get(id);
  const challenge = (id = "alice") => sqlite.query(`SELECT * FROM account_email_verifications WHERE user_id = ?`).get(id);
  const configure = (patch = {}) => {
    const settings = { smtp_host: "relay.example.test", smtp_port: 25, smtp_secure: 0,
      smtp_from_address: "sender@example.com", smtp_username: null, smtp_password_encrypted: null,
      ...patch };
    sqlite.query(`UPDATE instance_settings SET ${Object.keys(settings).map((key) => `${key} = ?`).join(", ")} WHERE id = 'instance'`)
      .run(...Object.values(settings));
  };
  const request = (email = "New.Case@example.com", id = "alice", extra = {}) =>
    requestAccountEmailCode(environment, id, { email, currentPassword: password, ...extra }, details, dependencies);
  const verify = (email = sent.at(-1)?.[1], id = "alice", extra = {}) =>
    verifyAccountEmail(environment, id, { email, code: sent.at(-1)?.[2], currentPassword: password, ...extra }, details);
  const ageChallenge = (id = "alice") => sqlite.query(`UPDATE account_email_verifications SET created_at = ? WHERE user_id = ?`)
    .run(new Date(Date.now() - 120_000).toISOString(), id);
  return { sqlite, environment, sent, dependencies, account, challenge, configure, request, verify, ageChallenge };
};

// D1 computes meta.changes using total_changes() deltas, including trigger
// effects. Exercise this explicitly instead of inheriting Bun's metadata.
const withD1Counting = (fixture) => {
  const { sqlite } = fixture;
  const claimCounts = [];
  const execute = (sql, bindings) => {
    const before = sqlite.query("SELECT total_changes() AS count").get().count;
    sqlite.query(sql).run(...bindings);
    const changes = sqlite.query("SELECT total_changes() AS count").get().count - before;
    if (sql.startsWith("UPDATE users SET email = ?")) claimCounts.push(changes);
    return { results: [], success: true, meta: { changes } };
  };
  const statement = (sql, bindings = []) => ({
    sql, bindings,
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.query(sql).get(...bindings) ?? null,
    all: async () => ({ results: sqlite.query(sql).all(...bindings), success: true, meta: {} }),
    run: async () => execute(sql, bindings),
  });
  fixture.environment.storage = createCloudflareStorageAdapter({
    DB: { prepare: statement, batch: async (statements) => sqlite.transaction(() => statements.map(({ sql, bindings }) => execute(sql, bindings)))() },
    RESOURCES: fixture.environment.storage.resources,
  });
  return claimCounts;
};

const personalAuth = (id = "alice") => ({ kind: "user", actorType: "user", actorId: id, username: id,
  displayName: id, accountType: "user", role: "member", scopes: [], workspaceId: `ws_${id}`, sessionId: `session_${id}` });
const makeApp = (fixture, overrides = {}) => {
  const app = new Hono();
  registerAccountEmailRoutes(app, { authenticateSession: async () => personalAuth(), isDemoEnvironment: () => false,
    ...fixture.dependencies, ...overrides });
  return app;
};
const post = (app, environment, path, input) => app.request(`/api/v1/auth/email${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}, environment);
const jsonPost = (app, environment, path, input) => app.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}, environment);

// Inject a concurrent database write just before the final atomic email claim.
const beforeClaim = (fixture, effect) => {
  const original = fixture.environment.storage.db;
  let active = true;
  fixture.environment.storage.db = {
    prepare(sql) {
      const statement = original.prepare(sql);
      if (!sql.startsWith("UPDATE users SET email = ?")) return statement;
      const wrap = (bound) => ({
        bind: (...values) => wrap(bound.bind(...values)),
        run: async () => { if (active) { active = false; effect(); } return bound.run(); },
      });
      return wrap(statement);
    },
    batch: (statements) => original.batch(statements),
  };
};

describe("account email migration and compatibility", () => {
  test("upgrades a temporary old database without changing legacy email or password login", async () => {
    const f = setup({ fileBacked: true });
    expect(f.account()).toMatchObject({ email: "Legacy.Case@Example.COM", email_verified_at: null, password_hash: passwordHash });
    expect(await verifyLogin(f.environment, "alice", password)).toMatchObject({ id: "alice" });
    expect(await verifyLogin(f.environment, "Legacy.Case@Example.COM", password)).toMatchObject({ id: "alice" });
    expect(await verifyLogin(f.environment, "BOB@EXAMPLE.COM", password)).toMatchObject({ id: "bob" });
    expect(await verifyLogin(f.environment, "alice", "wrong-password")).toBeNull();
    expect(await getInstanceUser(f.environment.storage.db, "alice")).toMatchObject({ email: "Legacy.Case@Example.COM", is_deleted: 0 });
    expect(f.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("does not merge distinct historic addresses that differ only by case", async () => {
    const f = setup();
    seedUser(f.sqlite, "case_lower", "legacy.case@example.com");
    expect(await verifyLogin(f.environment, "Legacy.Case@Example.COM", password)).toMatchObject({ id: "alice" });
    expect(await verifyLogin(f.environment, "legacy.case@example.com", password)).toMatchObject({ id: "case_lower" });
  });

  test("status is separate from sessions and SMTP availability ignores registration and feedback flags", async () => {
    const f = setup();
    expect(await getAccountEmailStatus(f.environment, "alice")).toEqual({
      email: "Legacy.Case@Example.COM", emailVerifiedAt: null, canManage: true, emailDeliveryConfigured: false,
    });
    f.configure({ registration_enabled: 0, registration_invite_required: 1, feedback_enabled: 0 });
    expect((await getAccountEmailStatus(f.environment, "alice")).emailDeliveryConfigured).toBe(true);
    await f.request();
    expect(f.account().email).toBe("Legacy.Case@Example.COM");
    expect(f.account().email_verified_at).toBeNull();
    expect(f.sent[0][0]).toMatchObject({ username: null, password: null });
  });

  test("shared schemas preserve case, trim addresses and require a six-digit code", () => {
    expect(AccountEmailCodeRequestSchema.parse({ email: " Case@Example.COM ", currentPassword: password }).email).toBe("Case@Example.COM");
    expect(AccountEmailVerifySchema.safeParse({ email: "a@example.com", currentPassword: password, code: "123456" }).success).toBe(true);
    for (const code of ["12345", "1234567", "abcdef"]) {
      expect(AccountEmailVerifySchema.safeParse({ email: "a@example.com", currentPassword: password, code }).success).toBe(false);
    }
  });
});

describe("account email challenge safety", () => {
  test("stores only a user/purpose/target-bound hash and verifies with the current password", async () => {
    const f = setup(); f.configure({ code_ttl_seconds: 90, code_resend_cooldown_seconds: 30 });
    const response = await f.request();
    expect(response).toEqual({ ok: true, expiresInMinutes: 2, cooldownSeconds: 30 });
    const challenge = f.challenge();
    expect(f.sent[0].slice(1)).toEqual(["New.Case@example.com", expect.stringMatching(/^\d{6}$/), "zh-CN", 90]);
    expect(challenge).toMatchObject({ user_id: "alice", purpose: "account_email", email: "New.Case@example.com", attempts: 0, delivered: 1 });
    expect(challenge.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain(`"${f.sent[0][2]}"`);
    const status = await f.verify();
    expect(status).toEqual({ email: "New.Case@example.com", emailVerifiedAt: expect.any(String), canManage: true, emailDeliveryConfigured: true });
    expect(f.challenge()).toBeNull();
    expect(f.account().account_email_version).toBe(1);
    expect(await verifyLogin(f.environment, "New.Case@example.com", password)).toMatchObject({ id: "alice" });
    expect(await verifyLogin(f.environment, "alice", password)).toMatchObject({ id: "alice" });
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
  });

  test("requires the current password at both issuance and confirmation", async () => {
    const f = setup(); f.configure();
    await expect(f.request(undefined, "alice", { currentPassword: "bad" })).rejects.toMatchObject({ code: "invalid_current_password" });
    expect(f.sent).toHaveLength(0);
    await f.request();
    await expect(f.verify(undefined, "alice", { currentPassword: "bad" })).rejects.toMatchObject({ code: "invalid_current_password" });
    expect(f.account().email_verified_at).toBeNull();
    await f.verify();
  });

  test("enforces persistent password limits even when failures are concurrent", async () => {
    const f = setup(); f.configure();
    const results = await Promise.allSettled(Array.from({ length: 14 }, () => f.request(undefined, "alice", { currentPassword: "bad" })));
    expect(results.filter((r) => r.status === "rejected" && r.reason.code === "invalid_current_password")).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected" && r.reason.code === "account_email_rate_limited")).toHaveLength(4);
    expect(f.sent).toHaveLength(0);
    await expect(f.request()).rejects.toMatchObject({ code: "account_email_rate_limited" });
    f.sqlite.query("UPDATE account_email_rate_limits SET window_started_at = ?").run(new Date(Date.now() - 16 * 60_000).toISOString());
    await f.request();
  });

  test("password IP budget bounds concurrent failures across multiple accounts", async () => {
    const f = setup(); f.configure();
    for (let i = 0; i < 7; i++) seedUser(f.sqlite, `limited_${i}`);
    const outcomes = await Promise.allSettled(Array.from({ length: 56 }, (_, i) =>
      f.request(`target${i}@example.com`, `limited_${Math.floor(i / 8)}`, { currentPassword: "wrong-password" })));
    expect(outcomes.filter((outcome) => outcome.reason?.code === "invalid_current_password")).toHaveLength(50);
    expect(outcomes.filter((outcome) => outcome.reason?.code === "account_email_rate_limited")).toHaveLength(6);
    expect(f.sent).toHaveLength(0);
  });

  test("can verify the existing legacy address without replacing it and still consumes the code", async () => {
    const f = setup(); f.configure(); await f.request("Legacy.Case@Example.COM");
    await f.verify();
    expect(f.account().email).toBe("Legacy.Case@Example.COM");
    expect(f.account().email_verified_at).not.toBeNull();
    expect(f.account().account_email_version).toBe(1);
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
  });

  test("can bind an account with no existing email", async () => {
    const f = setup(); f.configure(); seedUser(f.sqlite, "no_email");
    await f.request("first@example.com", "no_email");
    expect(f.account("no_email").email).toBeNull();
    await f.verify("first@example.com", "no_email");
    expect(f.account("no_email").email).toBe("first@example.com");
    expect(f.account("no_email").email_verified_at).not.toBeNull();
  });

  test("IP budgets apply across different accounts and remain on when registration abuse protection is off", async () => {
    const f = setup(); f.configure({ code_ip_hourly_limit: 1, abuse_guard_enabled: 0 });
    await f.request();
    await expect(f.request("another@example.com", "bob")).rejects.toMatchObject({ code: "account_email_rate_limited" });
    expect(f.sent).toHaveLength(1);
  });

  test("per-account delivery budget survives IP changes, expired challenges and resends", async () => {
    const f = setup(); f.configure();
    for (let i = 0; i < 5; i++) {
      f.ageChallenge();
      await requestAccountEmailCode(f.environment, "alice", { email: `target${i}@example.com`, currentPassword: password },
        { ip: `192.0.2.${i}` }, f.dependencies);
    }
    f.ageChallenge();
    await expect(f.request()).rejects.toMatchObject({ code: "account_email_rate_limited" });
    expect(f.sent).toHaveLength(5);
  });

  test("cooldown is atomic for concurrent sends and cannot be bypassed by changing target", async () => {
    const f = setup(); f.configure();
    const results = await Promise.allSettled([f.request("first@example.com"), f.request("second@example.com")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe("email_code_cooldown");
    expect(f.sent).toHaveLength(1);
    await expect(f.request("third@example.com")).rejects.toMatchObject({ code: "email_code_cooldown" });
  });

  test("resend replaces a pending target without modifying the old account binding", async () => {
    const f = setup(); f.configure();
    await f.request("old-target@example.com");
    const firstCode = f.sent[0][2];
    f.ageChallenge();
    await f.request("new-target@example.com");
    await expect(f.verify("old-target@example.com", "alice", { code: firstCode })).rejects.toMatchObject({ code: "email_code_invalid" });
    expect(f.account().email).toBe("Legacy.Case@Example.COM");
    await f.verify();
    expect(f.account().email).toBe("new-target@example.com");
  });

  test("rejects codes from another account, purpose, target or registration flow", async () => {
    const f = setup(); f.configure();
    await f.request();
    const code = f.sent[0][2];
    await expect(f.verify("New.Case@example.com", "bob", { code })).rejects.toMatchObject({ code: "email_code_invalid" });
    await expect(f.verify("wrong@example.com", "alice", { code })).rejects.toMatchObject({ code: "email_code_invalid" });
    f.sqlite.query("UPDATE account_email_verifications SET code_hash = ? WHERE user_id = 'alice'")
      .run(await sha256(`New.Case@example.com:${code}`));
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
    expect(() => f.sqlite.query("UPDATE account_email_verifications SET purpose = 'registration'").run()).toThrow();
    expect(f.account().email_verified_at).toBeNull();
  });

  test("rejects expired challenges", async () => {
    const f = setup(); f.configure(); await f.request();
    f.sqlite.query("UPDATE account_email_verifications SET expires_at = ?").run(new Date(Date.now() - 1).toISOString());
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_expired" });
    expect(f.account().email_verified_at).toBeNull();
  });

  test("caps concurrent wrong guesses at six and locks the code even when later correct", async () => {
    const f = setup(); f.configure(); await f.request();
    const wrong = f.sent[0][2] === "000000" ? "000001" : "000000";
    await Promise.allSettled(Array.from({ length: 8 }, () => f.verify(undefined, "alice", { code: wrong })));
    expect(f.challenge().attempts).toBe(6);
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
    expect(f.account().email_verified_at).toBeNull();
  });

  test("parallel confirmations consume the challenge exactly once", async () => {
    const f = setup({ fileBacked: true }); f.configure(); await f.request();
    const results = await Promise.allSettled([f.verify(), f.verify()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.challenge()).toBeNull();
    expect(f.account().account_email_version).toBe(1);
  });

  test("two accounts cannot claim the same unique email concurrently", async () => {
    const f = setup(); f.configure(); await f.request("shared-target@example.com");
    const aliceCode = f.sent[0][2];
    await f.request("shared-target@example.com", "bob");
    const bobCode = f.sent[1][2];
    const results = await Promise.allSettled([
      f.verify("shared-target@example.com", "alice", { code: aliceCode }),
      f.verify("shared-target@example.com", "bob", { code: bobCode }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe("email_exists");
    expect(f.sqlite.query("SELECT id FROM users WHERE email = 'shared-target@example.com'").all()).toHaveLength(1);
  });

  test("returns a clear unique-conflict error for a race after the availability check", async () => {
    const f = setup(); f.configure(); await f.request();
    beforeClaim(f, () => f.sqlite.query("UPDATE users SET email = 'New.Case@example.com' WHERE id = 'bob'").run());
    await expect(f.verify()).rejects.toMatchObject({ code: "email_exists", status: 409 });
    expect(f.account().email).toBe("Legacy.Case@Example.COM");
    expect(f.challenge()).not.toBeNull();
  });

  test("rejects an already-owned email before sending", async () => {
    const f = setup(); f.configure();
    await expect(f.request("bob@example.com")).rejects.toMatchObject({ code: "email_exists" });
    expect(f.sent).toHaveLength(0);
  });

  test("failed SMTP delivery never activates a code or changes the account", async () => {
    const f = setup(); f.configure();
    await expect(requestAccountEmailCode(f.environment, "alice", { email: "failed@example.com", currentPassword: password }, details,
      { sendEmail: async (...args) => { f.sent.push(args); throw new Error("Controlled mail failure"); } }))
      .rejects.toMatchObject({ code: "email_delivery_failed" });
    expect(f.challenge().delivered).toBe(0);
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
    expect(f.account().email_verified_at).toBeNull();
  });

  test("a delayed send cannot recreate a challenge after an administrator changes the account", async () => {
    const f = setup(); f.configure();
    await expect(requestAccountEmailCode(f.environment, "alice", { email: "delayed@example.com", currentPassword: password }, details,
      { sendEmail: async () => { f.sqlite.query("UPDATE users SET email = 'admin@example.com' WHERE id = 'alice'").run(); } }))
      .rejects.toMatchObject({ code: "account_email_state_changed" });
    expect(f.challenge()).toBeNull();
    expect(f.account().email).toBe("admin@example.com");
  });

  test.each(["email", "password_hash", "is_disabled", "is_deleted", "account_type"])("a concurrent %s change prevents the final email claim", async (column) => {
    const f = setup(); f.configure(); await f.request();
    const replacement = { email: "admin@example.com", password_hash: await hashPassword("new-password"), is_disabled: 1, is_deleted: 1, account_type: "group" }[column];
    beforeClaim(f, () => f.sqlite.query(`UPDATE users SET ${column} = ? WHERE id = 'alice'`).run(replacement));
    await expect(f.verify()).rejects.toMatchObject({ code: "account_email_state_changed" });
    expect(f.account().email).not.toBe("New.Case@example.com");
    expect(f.challenge()).toBeNull();
  });

  test("changing email away and back still invalidates the old challenge with recursive triggers enabled", async () => {
    const f = setup(); f.configure(); f.sqlite.exec("PRAGMA recursive_triggers = ON"); await f.request();
    f.sqlite.query("UPDATE users SET email = 'temporary@example.com' WHERE id = 'alice'").run();
    f.sqlite.query("UPDATE users SET email = 'Legacy.Case@Example.COM' WHERE id = 'alice'").run();
    expect(f.account().account_email_version).toBe(2);
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
  });
});

describe("account email HTTP contracts and linked account changes", () => {
  test("GET and verification share the exact response envelope; disabled registration can bind", async () => {
    const f = setup(); f.configure({ registration_enabled: 0, registration_invite_required: 1 });
    const app = makeApp(f);
    const initial = await app.request("/api/v1/auth/email", {}, f.environment);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ accountEmail: {
      email: "Legacy.Case@Example.COM", emailVerifiedAt: null, canManage: true, emailDeliveryConfigured: true,
    } });
    const input = { email: "route@example.com", currentPassword: password };
    const requested = await post(app, f.environment, "/code", input);
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ ok: true, expiresInMinutes: 1, cooldownSeconds: 60 });
    const verified = await post(app, f.environment, "/verify", { ...input, code: f.sent[0][2] });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ accountEmail: {
      email: "route@example.com", emailVerifiedAt: expect.any(String), canManage: true, emailDeliveryConfigured: true,
    } });
  });

  test("D1 total_changes includes trigger consumption: first confirmation is 200 and replay fails", async () => {
    const f = setup(); f.configure(); const claimCounts = withD1Counting(f);
    const app = makeApp(f);
    const input = { email: "d1-count@example.com", currentPassword: password };
    expect((await post(app, f.environment, "/code", input)).status).toBe(200);
    const verify = () => post(app, f.environment, "/verify", { ...input, code: f.sent[0][2] });
    expect((await verify()).status).toBe(200);
    expect(claimCounts).toEqual([2]);
    expect(f.challenge()).toBeNull();
    const replay = await verify();
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: "email_code_invalid" } });
    expect(f.account().account_email_version).toBe(1);
  });

  test("D1 concurrent confirmations still consume one challenge exactly once", async () => {
    const f = setup(); f.configure(); withD1Counting(f); await f.request();
    const outcomes = await Promise.allSettled([f.verify(), f.verify()]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(f.challenge()).toBeNull();
    expect(f.account().account_email_version).toBe(1);
  });

  test("untrusted forwarding headers create no shared IP budget and cannot bypass account cooldown", async () => {
    const f = setup(); f.configure({ code_ip_hourly_limit: 1 });
    const app = makeApp(f, { authenticateSession: async (context) => personalAuth(context.req.header("X-Test-User") ?? "alice") });
    const send = (id, fakeIp, email) => app.request("/api/v1/auth/email/code", {
      method: "POST", headers: { "content-type": "application/json", "X-Test-User": id,
        "CF-Connecting-IP": fakeIp, "X-Real-IP": fakeIp, "X-Forwarded-For": fakeIp },
      body: JSON.stringify({ email, currentPassword: password }),
    }, f.environment);
    expect((await send("alice", "198.51.100.1", "alice-target@example.com")).status).toBe(200);
    expect((await send("bob", "198.51.100.1", "bob-target@example.com")).status).toBe(200);
    // Exactly three account buckets each; no forged-IP or shared-unknown buckets.
    expect(f.sqlite.query("SELECT COUNT(*) AS count FROM account_email_rate_limits").get().count).toBe(6);
    const cooldown = await send("alice", "203.0.113.99", "changed-target@example.com");
    expect(cooldown.status).toBe(429);
    expect(await cooldown.json()).toMatchObject({ error: { code: "email_code_cooldown" } });
  });

  test("Cloudflare runtime metadata enforces trusted-IP limits despite spoofed forwarding headers", async () => {
    const f = setup(); f.configure({ code_ip_hourly_limit: 1 });
    const app = makeApp(f, { authenticateSession: async (context) => personalAuth(context.req.header("X-Test-User") ?? "alice") });
    const send = (id, forwarded) => {
      const request = new Request("http://localhost/api/v1/auth/email/code", {
        method: "POST", headers: { "content-type": "application/json", "X-Test-User": id,
          "CF-Connecting-IP": "198.51.100.20", "X-Real-IP": forwarded, "X-Forwarded-For": forwarded },
        body: JSON.stringify({ email: `${id}-target@example.com`, currentPassword: password }),
      });
      Object.defineProperty(request, "cf", { value: { colo: "TEST" } });
      return app.fetch(request, f.environment);
    };
    expect((await send("alice", "198.51.100.1")).status).toBe(200);
    const limited = await send("bob", "203.0.113.99");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "account_email_rate_limited" } });
  });

  test("auth route registration exposes the account-email endpoints", async () => {
    const f = setup(); const app = new Hono();
    registerAuthRoutes(app, { authenticateSession: async () => personalAuth(), isDemoEnvironment: () => false });
    expect((await app.request("/api/v1/auth/email", {}, f.environment)).status).toBe(200);
  });

  test("uses real cookie sessions and rejects bearer API tokens before body validation", async () => {
    const f = setup(); const app = makeApp(f, { authenticateSession });
    const now = new Date().toISOString();
    f.sqlite.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES ('session_alice', 'alice', ?, ?, ?, ?)`).run(await sha256("interactive-cookie"), new Date(Date.now() + 60_000).toISOString(), now, now);
    const denied = await app.request("/api/v1/auth/email/code", { method: "POST", headers: { authorization: "Bearer token_test", "content-type": "application/json" }, body: "{}" }, f.environment);
    expect(denied.status).toBe(401);
    const allowed = await app.request("/api/v1/auth/email", { headers: { cookie: "edgeever_session=interactive-cookie" } }, f.environment);
    expect(allowed.status).toBe(200);
  });

  test.each([
    [null, false, 401],
    [{ ...personalAuth(), kind: "agent", actorType: "agent" }, false, 401],
    [{ ...personalAuth(), sessionId: undefined }, false, 401],
    [{ ...personalAuth(), tokenId: "token_test" }, false, 401],
    [{ ...personalAuth(), accountType: "group" }, false, 403],
    [{ ...personalAuth(), actorId: "local" }, false, 403],
    [personalAuth(), true, 403],
  ])("rejects unsupported session context %#", async (auth, demo, status) => {
    const f = setup(); const app = makeApp(f, { authenticateSession: async () => auth, isDemoEnvironment: () => demo });
    expect((await app.request("/api/v1/auth/email", {}, f.environment)).status).toBe(status);
    expect((await post(app, f.environment, "/code", {})).status).toBe(status);
    expect((await post(app, f.environment, "/verify", {})).status).toBe(status);
  });

  test("rejects malformed payloads and returns typed password/SMTP failures", async () => {
    const f = setup(); const app = makeApp(f);
    expect((await post(app, f.environment, "/code", { email: "bad", currentPassword: password })).status).toBe(400);
    const badPassword = await post(app, f.environment, "/code", { email: "valid@example.com", currentPassword: "bad" });
    expect(await badPassword.json()).toMatchObject({ error: { code: "invalid_current_password" } });
    const noSmtp = await post(app, f.environment, "/code", { email: "valid@example.com", currentPassword: password });
    expect(await noSmtp.json()).toMatchObject({ error: { code: "smtp_not_configured" } });
  });

  test("administrator same-value email preserves verification; replacement clears it and invalidates pending codes", async () => {
    const f = setup(); f.configure(); await f.request("verified@example.com"); await f.verify();
    const verifiedAt = f.account().email_verified_at;
    await f.request("pending@example.com");
    const app = new Hono();
    registerUserRoutes(app, { authenticateRequest: async () => ({ ...personalAuth(), role: "owner" }), getInstanceUser });
    const patch = (email) => app.request("/api/v1/users/alice", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }, f.environment);
    expect((await patch("verified@example.com")).status).toBe(200);
    expect(f.account().email_verified_at).toBe(verifiedAt);
    expect(f.challenge()).not.toBeNull();
    const changed = await patch("admin@example.com");
    expect(changed.status).toBe(200);
    expect((await changed.json()).user.email).toBe("admin@example.com");
    expect(f.account().email_verified_at).toBeNull();
    expect(f.challenge()).toBeNull();
    await expect(f.verify()).rejects.toMatchObject({ code: "email_code_invalid" });
    expect((await patch(null)).status).toBe(200);
    expect(f.account().email).toBeNull();
  });

  test("actual password-change route invalidates pending email challenges while preserving password login", async () => {
    const f = setup(); f.configure(); await f.request();
    const app = new Hono();
    registerAuthRoutes(app, { authenticateSession: async () => personalAuth(), isDemoMode: () => false });
    const response = await jsonPost(app, f.environment, "/api/v1/auth/change-password", {
      currentPassword: password, newPassword: "changed-password", confirmPassword: "changed-password",
    });
    expect(response.status).toBe(200);
    expect(f.challenge()).toBeNull();
    expect(await verifyLogin(f.environment, "alice", "changed-password")).toMatchObject({ id: "alice" });
    await expect(f.verify(undefined, "alice", { currentPassword: "changed-password" })).rejects.toMatchObject({ code: "email_code_invalid" });
  });

  test("binding and changing email integrate with authoritative feedback identity", async () => {
    const f = setup(); f.configure({ feedback_enabled: 1, feedback_recipient_email: "owner@example.com" });
    const sentFeedback = [];
    const send = async (...args) => { sentFeedback.push(args); };
    const feedback = () => submitFeedback(f.environment, "alice", { requestId: crypto.randomUUID(), content: "Integration feedback" }, { send });
    await expect(feedback()).rejects.toMatchObject({ code: "feedback_email_unverified" });
    await f.request("verified@example.com");
    await expect(feedback()).rejects.toMatchObject({ code: "feedback_email_unverified" });
    await f.verify(); await feedback();
    expect(sentFeedback[0][2]).toMatchObject({ replyTo: "verified@example.com", sender: { accountId: "alice", username: "alice", email: "verified@example.com" } });
    await f.request("replacement@example.com"); await feedback();
    expect(sentFeedback[1][2].replyTo).toBe("verified@example.com");
    await f.verify(); await feedback();
    expect(sentFeedback[2][2]).toMatchObject({ replyTo: "replacement@example.com", sender: { accountId: "alice", username: "alice", email: "replacement@example.com" } });
  });
});

describe("registration verification marker and shared SMTP delivery", () => {
  test.each([false, true])("only marks actually code-verified new registrations (required=%s)", async (required) => {
    const f = setup(); f.configure({ registration_enabled: 1, registration_code_required: required ? 1 : 0, code_ttl_seconds: 90 });
    const app = new Hono(); const sent = [];
    registerInstanceAdminRoutes(app, { authenticateRequest: async () => null, sendRegistrationCodeEmail: async (...args) => { sent.push(args); } });
    const email = "registered@example.com";
    expect((await jsonPost(app, f.environment, "/api/v1/public/registration/code", { email })).status).toBe(200);
    expect(sent[0][4]).toBe(90);
    const response = await jsonPost(app, f.environment, "/api/v1/public/registration/register", {
      username: "registered", email, password, emailCode: sent[0][2],
    });
    expect(response.status).toBe(201);
    const user = f.sqlite.query("SELECT * FROM users WHERE username = 'registered'").get();
    expect(Boolean(user.email_verified_at)).toBe(required);
    expect(await verifyLogin(f.environment, email, password)).toMatchObject({ id: user.id });
    if (required) expect(f.sqlite.query("SELECT * FROM email_verifications WHERE email = ?").get(email)).toBeNull();
  });

  test("registration rechecks the exact challenge inside the batch and rolls back a replaced code", async () => {
    const f = setup(); f.configure({ registration_enabled: 1, registration_code_required: 1 });
    const app = new Hono(); const sent = [];
    registerInstanceAdminRoutes(app, { authenticateRequest: async () => null, sendRegistrationCodeEmail: async (...args) => { sent.push(args); } });
    const email = "replaced-registration@example.com";
    expect((await jsonPost(app, f.environment, "/api/v1/public/registration/code", { email })).status).toBe(200);
    const previousWorkspaces = f.sqlite.query("SELECT COUNT(*) AS count FROM workspaces").get().count;
    const database = f.environment.storage.db;
    f.environment.storage.db = {
      prepare: (sql) => database.prepare(sql),
      batch: async (statements) => {
        if (statements.some((statement) => statement.sql.includes("INSERT INTO users"))) {
          f.sqlite.query("UPDATE email_verifications SET id = 'replacement-record' WHERE email = ?").run(email);
        }
        return database.batch(statements);
      },
    };
    const response = await jsonPost(app, f.environment, "/api/v1/public/registration/register", {
      username: "replaced_registration", email, password, emailCode: sent[0][2],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "email_code_invalid" } });
    expect(f.sqlite.query("SELECT id FROM users WHERE email = ?").get(email)).toBeNull();
    expect(f.sqlite.query("SELECT COUNT(*) AS count FROM workspaces").get().count).toBe(previousWorkspaces);
    expect(f.sqlite.query("SELECT id FROM email_verifications WHERE email = ?").get(email).id).toBe("replacement-record");
  });

  test("concurrent registration consumes a verified challenge only once", async () => {
    const f = setup(); f.configure({ registration_enabled: 1, registration_code_required: 1 });
    const app = new Hono(); const sent = [];
    registerInstanceAdminRoutes(app, { authenticateRequest: async () => null, sendRegistrationCodeEmail: async (...args) => { sent.push(args); } });
    const email = "concurrent-registration@example.com";
    expect((await jsonPost(app, f.environment, "/api/v1/public/registration/code", { email })).status).toBe(200);
    const previousWorkspaces = f.sqlite.query("SELECT COUNT(*) AS count FROM workspaces").get().count;
    const responses = await Promise.all(["concurrent_a", "concurrent_b"].map((username) =>
      jsonPost(app, f.environment, "/api/v1/public/registration/register", { username, email, password, emailCode: sent[0][2] })));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.every((response) => [201, 400, 409].includes(response.status))).toBe(true);
    expect(f.sqlite.query("SELECT id FROM users WHERE email = ? AND email_verified_at IS NOT NULL").all(email)).toHaveLength(1);
    expect(f.sqlite.query("SELECT COUNT(*) AS count FROM workspaces").get().count).toBe(previousWorkspaces + 1);
  });

  test("invalid registration codes never create a verified user", async () => {
    const f = setup(); f.configure({ registration_enabled: 1, registration_code_required: 1 });
    const app = new Hono();
    registerInstanceAdminRoutes(app, { authenticateRequest: async () => null, sendRegistrationCodeEmail: async () => {} });
    const response = await jsonPost(app, f.environment, "/api/v1/public/registration/register", {
      username: "invalidnew", email: "invalidnew@example.com", password, emailCode: "123456",
    });
    expect(response.status).toBe(400);
    expect(f.sqlite.query("SELECT * FROM users WHERE username = 'invalidnew'").get()).toBeNull();
  });
});
