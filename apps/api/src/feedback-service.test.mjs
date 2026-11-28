import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Hono } from "hono";
import { registerFeedbackRoutes } from "./feedback-routes.ts";
import { FEEDBACK_LEASE_MS, FEEDBACK_WINDOW_MS, getPublicFeedback, submitFeedback } from "./feedback-service.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { encryptSecret } from "./secret-encryption.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const migrations = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
const fixtures = [];
const logMocks = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    for (const sqlite of fixture.connections) sqlite.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  for (const mock of logMocks.splice(0)) mock.mockRestore();
});

const createFixture = ({ beforeFeedbackMigration = false, beforeSmtpCompatibility = false } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-feedback-"));
  const path = join(directory, "test.sqlite");
  const sqlite = new Database(path);
  const connections = [sqlite];
  fixtures.push({ directory, connections });
  for (const migration of migrations) {
    if (beforeFeedbackMigration && migration >= "0071_") continue;
    if (beforeSmtpCompatibility && migration === "0075_smtp_mode_compat.sql") continue;
    sqlite.exec(readFileSync(join(migrationsDirectory, migration), "utf8"));
  }
  const environment = {
    EDGE_EVER_AUTH_PASSWORD: "feedback-test-password",
    storage: createSelfHostedStorageAdapter(sqlite, join(directory, "resources")),
  };
  const patch = (values) => {
    const entries = Object.entries(values);
    sqlite.query(`UPDATE instance_settings SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = 'instance'`)
      .run(...entries.map(([, value]) => value));
  };
  if (!beforeFeedbackMigration) {
    patch({
      feedback_enabled: 1,
      feedback_recipient_email: "private-feedback@example.com",
      contact_email: "public-contact@example.com",
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_from_address: "edgeever@example.com",
    });
    const now = new Date().toISOString();
    for (const [id, email] of [["user-a", "reply@example.com"], ["user-b", "other@example.com"]]) {
      sqlite.query(`INSERT INTO users (id, username, password_hash, display_name, email, email_verified_at, created_at, updated_at)
        VALUES (?, ?, 'test-hash', ?, ?, ?, ?, ?)`).run(id, id, id, email, now, now, now);
    }
  }
  return {
    sqlite, environment, patch,
    reopen() {
      const connection = new Database(path);
      connections.push(connection);
      return { ...environment, storage: createSelfHostedStorageAdapter(connection, join(directory, "resources")) };
    },
  };
};
const input = (overrides = {}) => ({ requestId: crypto.randomUUID(), content: "A feedback message", ...overrides });
const successCount = (sqlite, accountId = "user-a") => sqlite.query(
  "SELECT COUNT(*) AS count FROM feedback_requests WHERE account_id = ? AND succeeded_at IS NOT NULL",
).get(accountId).count;
const leaseCount = (sqlite) => sqlite.query("SELECT COUNT(*) AS count FROM feedback_account_leases").get().count;
const quietLogs = () => logMocks.push(spyOn(console, "error").mockImplementation(() => {}));
const instrumentDatabase = (database, intercept) => ({
  prepare(sql) {
    const wrap = (statement) => ({
      bind: (...values) => wrap(statement.bind(...values)),
      first: (...args) => intercept(sql, "first", () => statement.first(...args)),
      run: (...args) => intercept(sql, "run", () => statement.run(...args)),
      all: (...args) => intercept(sql, "all", () => statement.all(...args)),
    });
    return wrap(database.prepare(sql));
  },
  batch: database.batch.bind(database),
});
const wrapEnvironment = (environment, intercept) => ({
  ...environment,
  storage: { ...environment.storage, db: instrumentDatabase(environment.storage.db, intercept) },
});

const auth = (overrides = {}) => ({
  kind: "user", actorType: "user", actorId: "user-a", username: "user-a", displayName: "User A",
  scopes: [], workspaceId: "workspace-a", role: "member", accountType: "user", ...overrides,
});
const createApp = (dependencies) => {
  const app = new Hono();
  registerFeedbackRoutes(app, { authenticateRequest: async () => auth(), ...dependencies });
  return app;
};
const post = (app, environment, body = input()) => app.request("/api/v1/feedback", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}, environment);

describe("feedback persistence and quota", () => {
  test("allows three successful sends and rejects the fourth with the exact retry time", async () => {
    const { sqlite, environment } = createFixture();
    let delivered = 0;
    const now = Date.UTC(2026, 10, 26);
    const dependencies = { now: () => now, send: async () => { delivered += 1; } };
    for (let index = 0; index < 3; index += 1) await submitFeedback(environment, "user-a", input(), dependencies);
    await expect(submitFeedback(environment, "user-a", input(), dependencies)).rejects.toMatchObject({
      code: "feedback_rate_limited", status: 429,
      details: { retryAfterSeconds: FEEDBACK_WINDOW_MS / 1000, contactEmail: "public-contact@example.com" },
    });
    expect(delivered).toBe(3);
    expect(successCount(sqlite)).toBe(3);
    expect(leaseCount(sqlite)).toBe(0);
  });

  test("uses a rolling window and frees the first slot exactly at five hours", async () => {
    const { environment } = createFixture();
    const start = Date.UTC(2026, 10, 26);
    let clock = start;
    let delivered = 0;
    const dependencies = { now: () => clock, send: async () => { delivered += 1; } };
    for (let index = 0; index < 3; index += 1) {
      clock = start + index * 1000;
      await submitFeedback(environment, "user-a", input(), dependencies);
    }
    clock = start + FEEDBACK_WINDOW_MS - 1;
    await expect(submitFeedback(environment, "user-a", input(), dependencies)).rejects.toMatchObject({
      code: "feedback_rate_limited", details: { retryAfterSeconds: 1 },
    });
    clock += 1;
    await submitFeedback(environment, "user-a", input(), dependencies);
    expect(delivered).toBe(4);
    await expect(submitFeedback(environment, "user-a", input(), dependencies)).rejects.toMatchObject({
      code: "feedback_rate_limited", details: { retryAfterSeconds: 1 },
    });
  });

  test("counts completion time rather than reservation time", async () => {
    const { environment, sqlite } = createFixture();
    let clock = Date.UTC(2026, 10, 26);
    const submitted = input();
    await submitFeedback(environment, "user-a", submitted, { now: () => clock, send: async () => { clock += 29_000; } });
    expect(sqlite.query("SELECT succeeded_at FROM feedback_requests WHERE request_id = ?").get(submitted.requestId).succeeded_at)
      .toBe(clock);
  });

  test("failed sends consume no quota, release reservations, and may retry the same requestId", async () => {
    const { environment, sqlite } = createFixture();
    const submitted = input();
    for (let index = 0; index < 4; index += 1) {
      await expect(submitFeedback(environment, "user-a", submitted, {
        send: async () => { throw new Error("secret upstream SMTP failure"); },
      })).rejects.toMatchObject({ code: "email_delivery_failed", status: 502 });
    }
    expect(successCount(sqlite)).toBe(0);
    expect(leaseCount(sqlite)).toBe(0);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM feedback_requests").get().count).toBe(0);
    await submitFeedback(environment, "user-a", submitted, { send: async () => {} });
    expect(successCount(sqlite)).toBe(1);
  });

  test("isolates accounts even when they reuse the same requestId", async () => {
    const { environment, sqlite } = createFixture();
    const submitted = input();
    let delivered = 0;
    const dependencies = { send: async () => { delivered += 1; } };
    await submitFeedback(environment, "user-a", submitted, dependencies);
    await submitFeedback(environment, "user-b", submitted, dependencies);
    await submitFeedback(environment, "user-a", input(), dependencies);
    await submitFeedback(environment, "user-a", input(), dependencies);
    await submitFeedback(environment, "user-b", input(), dependencies);
    expect(delivered).toBe(5);
    expect(successCount(sqlite)).toBe(3);
    expect(successCount(sqlite, "user-b")).toBe(2);
  });

  test("completed requestId is idempotent across connections, full quota, and disabled delivery", async () => {
    const { environment, sqlite, patch, reopen } = createFixture();
    const submitted = input();
    let delivered = 0;
    const dependencies = { send: async () => { delivered += 1; } };
    await submitFeedback(environment, "user-a", submitted, dependencies);
    await submitFeedback(environment, "user-a", input(), dependencies);
    await submitFeedback(environment, "user-a", input(), dependencies);
    patch({ feedback_enabled: 0 });
    await submitFeedback(reopen(), "user-a", submitted, dependencies);
    expect(delivered).toBe(3);
    expect(successCount(sqlite)).toBe(3);
  });

  test("serializes concurrent attempts through the database and reserves the last slot once", async () => {
    const { environment, sqlite, reopen } = createFixture();
    for (let index = 0; index < 2; index += 1) {
      await submitFeedback(environment, "user-a", input(), { send: async () => {} });
    }
    let finishSend;
    const gate = new Promise((resolve) => { finishSend = resolve; });
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    let delivered = 0;
    const submitted = input();
    const first = submitFeedback(environment, "user-a", submitted, { send: async () => {
      delivered += 1;
      notifyStarted();
      await gate;
    } });
    await started;
    expect(FEEDBACK_LEASE_MS).toBeGreaterThan(30_000 * 2);
    const otherProcess = reopen();
    await expect(submitFeedback(otherProcess, "user-a", input(), { send: async () => { delivered += 1; } }))
      .rejects.toMatchObject({ code: "feedback_busy" });
    await expect(submitFeedback(otherProcess, "user-a", submitted, { send: async () => { delivered += 1; } }))
      .rejects.toMatchObject({ code: "feedback_busy" });
    // Another account may send while the first account's SMTP is in flight.
    await submitFeedback(otherProcess, "user-b", input(), { send: async () => {} });
    finishSend();
    await first;
    await submitFeedback(otherProcess, "user-a", submitted, { send: async () => { delivered += 1; } });
    await expect(submitFeedback(otherProcess, "user-a", input(), { send: async () => { delivered += 1; } }))
      .rejects.toMatchObject({ code: "feedback_rate_limited" });
    expect(delivered).toBe(1);
    expect(successCount(sqlite)).toBe(3);
  });

  test("recovers an expired reservation left by a previous process", async () => {
    const { environment, sqlite, reopen } = createFixture();
    const submitted = input();
    const clock = Date.now();
    sqlite.query("INSERT INTO feedback_account_leases VALUES (?, ?, ?)").run("user-a", "old-token", clock + 1);
    sqlite.query("INSERT INTO feedback_requests VALUES (?, ?, ?, ?, NULL)")
      .run("user-a", submitted.requestId, "old-token", clock - FEEDBACK_LEASE_MS);
    let delivered = 0;
    const dependencies = { now: () => clock, send: async () => { delivered += 1; } };
    await expect(submitFeedback(environment, "user-a", submitted, dependencies)).rejects.toMatchObject({ code: "feedback_busy" });
    await submitFeedback(reopen(), "user-a", submitted, { ...dependencies, now: () => clock + 1 });
    expect(delivered).toBe(1);
    expect(successCount(sqlite)).toBe(1);
    expect(leaseCount(sqlite)).toBe(0);
  });

  test("a stale token cannot send or release a successor's lease", async () => {
    const { environment, sqlite } = createFixture();
    const wrapped = wrapEnvironment(environment, async (sql, method, execute) => {
      const result = await execute();
      if (sql.startsWith("INSERT INTO feedback_requests") && method === "run") {
        sqlite.query("UPDATE feedback_account_leases SET token = 'successor-token'").run();
      }
      return result;
    });
    let delivered = 0;
    await expect(submitFeedback(wrapped, "user-a", input(), { send: async () => { delivered += 1; } }))
      .rejects.toMatchObject({ code: "feedback_busy" });
    expect(delivered).toBe(0);
    expect(sqlite.query("SELECT token FROM feedback_account_leases").get().token).toBe("successor-token");
  });

  test("rechecks quota atomically immediately before SMTP", async () => {
    const { environment, sqlite } = createFixture();
    const clock = Date.now();
    const wrapped = wrapEnvironment(environment, async (sql, method, execute) => {
      const result = await execute();
      if (sql.startsWith("INSERT INTO feedback_requests") && method === "run") {
        for (let index = 0; index < 3; index += 1) {
          sqlite.query("INSERT INTO feedback_requests VALUES (?, ?, ?, ?, ?)")
            .run("user-a", crypto.randomUUID(), "previous-owner", clock, clock);
        }
      }
      return result;
    });
    let delivered = 0;
    await expect(submitFeedback(wrapped, "user-a", input(), { now: () => clock, send: async () => { delivered += 1; } }))
      .rejects.toMatchObject({ code: "feedback_busy" });
    expect(delivered).toBe(0);
  });

  test("accepted SMTP delivery remains successful if lease cleanup fails", async () => {
    const { environment, sqlite } = createFixture();
    quietLogs();
    const wrapped = wrapEnvironment(environment, (sql, method, execute) => {
      if (sql.startsWith("DELETE FROM feedback_account_leases")) throw new Error("database unavailable");
      return execute();
    });
    const submitted = input();
    let delivered = 0;
    const dependencies = { send: async () => { delivered += 1; } };
    await submitFeedback(wrapped, "user-a", submitted, dependencies);
    await submitFeedback(wrapped, "user-a", submitted, dependencies);
    expect(delivered).toBe(1);
    expect(successCount(sqlite)).toBe(1);
  });

  test("retries transient success-recording errors without redelivering", async () => {
    const { environment, sqlite } = createFixture();
    let errors = 2;
    const wrapped = wrapEnvironment(environment, (sql, method, execute) => {
      if (sql.startsWith("UPDATE feedback_requests SET succeeded_at") && errors-- > 0) throw new Error("transient SQL error");
      return execute();
    });
    const submitted = input();
    let delivered = 0;
    const dependencies = { send: async () => { delivered += 1; } };
    await submitFeedback(wrapped, "user-a", submitted, dependencies);
    await submitFeedback(environment, "user-a", submitted, dependencies);
    expect(delivered).toBe(1);
    expect(successCount(sqlite)).toBe(1);
  });

  test("does not reverse accepted mail on persistent recording failure and keeps its lease", async () => {
    const { environment, sqlite } = createFixture();
    quietLogs();
    const wrapped = wrapEnvironment(environment, (sql, method, execute) => {
      if (sql.startsWith("UPDATE feedback_requests SET succeeded_at")) throw new Error("SQL outage");
      return execute();
    });
    const submitted = input();
    await submitFeedback(wrapped, "user-a", submitted, { send: async () => {} });
    expect(successCount(sqlite)).toBe(0);
    expect(leaseCount(sqlite)).toBe(1);
    await expect(submitFeedback(environment, "user-a", submitted, { send: async () => {} }))
      .rejects.toMatchObject({ code: "feedback_busy" });
  });
});

describe("feedback verified account identity", () => {
  test.each([
    ["missing account", "DELETE FROM users WHERE id = 'user-a'"],
    ["no bound email", "UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = 'user-a'"],
    ["unverified email", "UPDATE users SET email_verified_at = NULL WHERE id = 'user-a'"],
    ["invalid stored email", "UPDATE users SET email = 'invalid' WHERE id = 'user-a'"],
    ["disabled account", "UPDATE users SET is_disabled = 1 WHERE id = 'user-a'"],
    ["archived account", "UPDATE users SET is_deleted = 1 WHERE id = 'user-a'"],
    ["shared group account", "UPDATE users SET account_type = 'group' WHERE id = 'user-a'"],
  ])("rejects %s without sending or consuming quota", async (_, change) => {
    const { environment, sqlite } = createFixture();
    sqlite.exec(change);
    let delivered = 0;
    const response = await post(createApp({ send: async () => { delivered += 1; } }), environment);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("feedback_email_unverified");
    expect(delivered).toBe(0);
    expect(successCount(sqlite)).toBe(0);
    expect(leaseCount(sqlite)).toBe(0);
  });

  test.each([undefined, null, "reply@example.com"])("derives the sender from the account when replyTo is %s", async (replyTo) => {
    const { environment } = createFixture();
    const sent = [];
    const response = await post(createApp({ send: async (...args) => { sent.push(args); } }), environment,
      input({ replyTo, accountId: "user-b", sender: { username: "forged" } }));
    expect(response.status).toBe(200);
    expect(sent[0][2]).toMatchObject({
      replyTo: "reply@example.com",
      sender: { accountId: "user-a", username: "user-a", email: "reply@example.com" },
    });
  });

  test("rejects a different legacy reply address without sending or reserving quota", async () => {
    const { environment, sqlite } = createFixture();
    let delivered = 0;
    const response = await post(createApp({ send: async () => { delivered += 1; } }), environment,
      input({ replyTo: "other@example.com" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("feedback_email_mismatch");
    expect(delivered).toBe(0);
    expect(successCount(sqlite)).toBe(0);
    expect(leaseCount(sqlite)).toBe(0);
  });

  test("rechecks a revoked binding immediately before SMTP and releases the reservation", async () => {
    const { environment, sqlite } = createFixture();
    const wrapped = wrapEnvironment(environment, async (sql, method, execute) => {
      const result = await execute();
      if (sql.startsWith("UPDATE feedback_account_leases SET expires_at") && method === "first") {
        sqlite.query("UPDATE users SET email_verified_at = NULL WHERE id = 'user-a'").run();
      }
      return result;
    });
    let delivered = 0;
    await expect(submitFeedback(wrapped, "user-a", input(), { send: async () => { delivered += 1; } }))
      .rejects.toMatchObject({ code: "feedback_email_unverified", status: 403 });
    expect(delivered).toBe(0);
    expect(successCount(sqlite)).toBe(0);
    expect(leaseCount(sqlite)).toBe(0);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM feedback_requests").get().count).toBe(0);
  });

  test("a successful request remains idempotent after its binding is revoked", async () => {
    const { environment, sqlite } = createFixture();
    const submitted = input();
    let delivered = 0;
    const dependencies = { send: async () => { delivered += 1; } };
    await submitFeedback(environment, "user-a", submitted, dependencies);
    sqlite.query("UPDATE users SET email_verified_at = NULL WHERE id = 'user-a'").run();
    await submitFeedback(environment, "user-a", submitted, dependencies);
    expect(delivered).toBe(1);
    expect(successCount(sqlite)).toBe(1);
  });
});

describe("feedback public configuration and routes", () => {
  // The product requirement is an account-scoped quota. Nothing in the feedback
  // path may fall back to the request IP, which would let one account on a
  // shared network block everybody else.
  test("keys every quota decision on the signed-in account instead of the request IP", () => {
    for (const file of ["feedback-service.ts", "feedback-routes.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source).not.toContain("getRequestIp");
      expect(source).not.toContain("cf-connecting-ip");
      expect(source).not.toContain("x-forwarded-for");
      expect(source).not.toContain(":ip:");
    }
    expect(readFileSync(fileURLToPath(new URL("feedback-service.ts", import.meta.url)), "utf8"))
      .toContain("WHERE account_id = ? AND succeeded_at > ?");
  });

  test("publishes actual availability and only the public contact address", async () => {
    const { environment } = createFixture();
    const app = createApp({ authenticateRequest: async () => { throw new Error("GET must not authenticate"); } });
    app.use("/api/v1/*", () => { throw new Error("global auth must not capture the public route"); });
    const response = await app.request("/api/v1/public/feedback", {}, environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ feedback: { enabled: true, contactEmail: "public-contact@example.com" } });
  });

  test.each([
    ["switch disabled", { feedback_enabled: 0 }],
    ["recipient removed", { feedback_recipient_email: null }],
    ["invalid recipient", { feedback_recipient_email: "not-an-email" }],
    ["SMTP host removed", { smtp_host: null }],
    ["invalid SMTP host", { smtp_host: "smtp.example.com\r\nINJECT" }],
    ["invalid SMTP port", { smtp_port: 70000 }],
    ["SMTP sender removed", { smtp_from_address: null }],
    ["SMTP credentials incomplete", { smtp_username: "mail-user" }],
    ["SMTP credentials undecryptable", { smtp_username: "mail-user", smtp_password_encrypted: "bad-ciphertext" }],
  ])("disables delivery when %s", async (_, patch) => {
    const fixture = createFixture();
    fixture.patch(patch);
    expect(await getPublicFeedback(fixture.environment)).toEqual({ enabled: false, contactEmail: "public-contact@example.com" });
    let delivered = 0;
    const response = await post(createApp({ send: async () => { delivered += 1; } }), fixture.environment);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: {
      code: "feedback_disabled", message: "Feedback delivery is not configured or is disabled.",
      details: { contactEmail: "public-contact@example.com" },
    } });
    expect(delivered).toBe(0);
    expect(leaseCount(fixture.sqlite)).toBe(0);
  });

  test("validates encrypted authenticated SMTP and forwards the private recipient only to the sender", async () => {
    const { environment, patch } = createFixture();
    patch({
      smtp_username: "mail-user",
      smtp_password_encrypted: await encryptSecret("smtp-secret", "edgeever:object-storage:v1:feedback-test-password"),
    });
    const sent = [];
    const response = await post(createApp({ send: async (...args) => { sent.push(args); } }), environment,
      input({ content: "  useful feedback  ", replyTo: "reply@example.com", systemInfo: "client info" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({ username: "mail-user", password: "smtp-secret", secure: false });
    expect(sent[0][1]).toBe("private-feedback@example.com");
    expect(sent[0][2]).toEqual({
      content: "useful feedback", replyTo: "reply@example.com", systemInfo: "client info",
      sender: { accountId: "user-a", username: "user-a", email: "reply@example.com" },
    });
  });

  test("migrates legacy port 587 delivery to STARTTLS and keeps later explicit choices", async () => {
    const fixture = createFixture({ beforeSmtpCompatibility: true });
    fixture.patch({ smtp_port: 587, smtp_secure: 1 });
    fixture.sqlite.exec(readFileSync(join(migrationsDirectory, "0075_smtp_mode_compat.sql"), "utf8"));
    const sent = [];
    const app = createApp({ send: async (...args) => { sent.push(args); } });

    expect((await post(app, fixture.environment)).status).toBe(200);
    expect(sent[0][0]).toMatchObject({ port: 587, secure: false });

    fixture.patch({ smtp_secure: 1 });
    expect((await post(app, fixture.environment)).status).toBe(200);
    expect(sent[1][0]).toMatchObject({ port: 587, secure: true });
  });

  test("ignores a leftover undecryptable password when no SMTP username is configured", async () => {
    const { environment, patch } = createFixture();
    patch({ smtp_password_encrypted: "leftover-unreadable-password", smtp_username: null });
    expect(await getPublicFeedback(environment)).toEqual({ enabled: true, contactEmail: "public-contact@example.com" });
    const sent = [];
    const response = await post(createApp({ send: async (config) => { sent.push(config); } }), environment);
    expect(response.status).toBe(200);
    expect(sent[0]).toMatchObject({ username: null, password: null });
  });

  test("a missing or invalid public contact never disables otherwise valid delivery", async () => {
    const { environment, patch } = createFixture();
    patch({ contact_email: "invalid\r\ncontact" });
    expect(await getPublicFeedback(environment)).toEqual({ enabled: true, contactEmail: null });
  });

  test.each([
    ["anonymous", null, 401],
    ["API token", auth({ kind: "agent", actorType: "agent" }), 403],
    ["unauthenticated owner placeholder", auth({ actorId: null }), 401],
  ])("rejects %s before validating the body or sending", async (_, authentication, status) => {
    const { environment } = createFixture();
    let delivered = 0;
    const app = createApp({ authenticateRequest: async () => authentication, send: async () => { delivered += 1; } });
    expect((await post(app, environment, {})).status).toBe(status);
    expect(delivered).toBe(0);
  });

  test.each([
    ["UUID", { requestId: "bad-id" }],
    ["empty content", { content: " \n " }],
    ["long content", { content: "x".repeat(5001) }],
    ["reply email", { replyTo: "invalid" }],
    ["reply injection", { replyTo: "reply@example.com\r\nBcc: other@example.com" }],
    ["long system information", { systemInfo: "x".repeat(6001) }],
  ])("validates %s", async (_, overrides) => {
    const { environment } = createFixture();
    let delivered = 0;
    expect((await post(createApp({ send: async () => { delivered += 1; } }), environment, input(overrides))).status).toBe(400);
    expect(delivered).toBe(0);
  });

  test("accepts null optional fields and the content/systemInfo boundaries", async () => {
    const { environment } = createFixture();
    const app = createApp({ send: async () => {} });
    expect((await post(app, environment, input({ content: "x".repeat(5000), systemInfo: "x".repeat(6000), replyTo: null }))).status).toBe(200);
    expect((await post(app, environment, input({ content: "x", systemInfo: null }))).status).toBe(200);
  });

  test("returns standard errors with readable details and Retry-After", async () => {
    const { environment } = createFixture();
    const app = createApp({ now: () => Date.UTC(2026, 10, 26), send: async () => {} });
    for (let index = 0; index < 3; index += 1) expect((await post(app, environment)).status).toBe(200);
    const response = await post(app, environment);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("18000");
    expect((await response.json()).error).toMatchObject({
      code: "feedback_rate_limited", details: { contactEmail: "public-contact@example.com", retryAfterSeconds: 18000 },
    });
  });

  test("returns busy retry details and sanitizes delivery failures", async () => {
    const { environment, sqlite } = createFixture();
    const clock = Date.now();
    sqlite.query("INSERT INTO feedback_account_leases VALUES (?, ?, ?)").run("user-a", "busy", clock + 10_001);
    const app = createApp({ now: () => clock, send: async () => { throw new Error("SMTP password must not leak"); } });
    const busy = await post(app, environment);
    expect(busy.status).toBe(409);
    expect(busy.headers.get("Retry-After")).toBe("11");
    expect((await busy.json()).error.details.retryAfterSeconds).toBe(11);
    sqlite.query("DELETE FROM feedback_account_leases").run();
    const failed = await post(app, environment);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Retry-After")).toBeNull();
    expect(await failed.json()).toEqual({ error: {
      code: "email_delivery_failed", message: "Feedback email could not be delivered. Please try again later.",
      details: { contactEmail: "public-contact@example.com" },
    } });
  });

  test("wires feedback before global auth without moving other route registrations", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.indexOf("registerFeedbackRoutes(app,")).toBeLessThan(source.indexOf('app.use("/api/v1/*"'));
    expect(source).toContain("authenticateRequest: (...args) => authenticateRequest(...args)");
  });
});

describe("feedback migration", () => {
  test("upgrades the actual pre-feedback schema while preserving saved settings and business data", () => {
    const { sqlite, patch } = createFixture({ beforeFeedbackMigration: true });
    patch({ registration_enabled: 1, smtp_host: "existing-smtp.example.com", smtp_password_encrypted: "existing-secret",
      share_missing_message: "preserved share message", site_name: "Existing instance" });
    const previousSettings = sqlite.query("SELECT * FROM instance_settings").get();
    const previousMemos = sqlite.query("SELECT * FROM memos ORDER BY id").all();
    const previousUsers = sqlite.query("SELECT * FROM users ORDER BY id").all();
    sqlite.exec(readFileSync(join(migrationsDirectory, "0071_feedback.sql"), "utf8"));
    // Bun caches query() column metadata; prepare a fresh statement after ALTER.
    const { feedback_enabled, feedback_recipient_email, contact_email, ...settings } = sqlite.prepare("SELECT * FROM instance_settings").get();
    expect(settings).toEqual(previousSettings);
    expect([feedback_enabled, feedback_recipient_email, contact_email]).toEqual([0, null, null]);
    expect(sqlite.query("SELECT * FROM memos ORDER BY id").all()).toEqual(previousMemos);
    expect(sqlite.query("SELECT * FROM users ORDER BY id").all()).toEqual(previousUsers);
    expect(sqlite.query("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_requests_success_window'").get()).not.toBeNull();
  });
});
