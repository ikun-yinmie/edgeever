import { describe, expect, test } from "bun:test";
import {
  capDesktopSessionsToRetention,
  capSessionsToRetention,
  createSession,
  getLoginSessionPolicy,
} from "./auth-service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const createDatabase = (liveSessions = [], { desktopTtlDays = null } = {}) => {
  const statements = [];
  const db = {
    prepare: (sql) => ({
      first: async () => (sql.includes("desktop_session_ttl_days")
        ? { desktop_session_ttl_days: desktopTtlDays }
        : null),
      bind: (...args) => ({
        sql,
        args,
        all: async () => ({ results: liveSessions }),
        run: async () => ({}),
      }),
    }),
    batch: async (batch) => {
      statements.push(...batch);
    },
  };
  return { db, statements };
};

const createContext = ({
  ip = "203.0.113.5",
  userAgent = "Mozilla/5.0 Chrome/120",
  liveSessions = [],
  desktopTtlDays = null,
} = {}) => {
  const headers = { "user-agent": userAgent };
  if (ip) headers["cf-connecting-ip"] = ip;
  const { db, statements } = createDatabase(liveSessions, { desktopTtlDays });
  return {
    context: {
      req: {
        header: (name) => headers[name.toLowerCase()] ?? null,
        raw: { cf: {} },
      },
      env: { storage: { db } },
    },
    statements,
  };
};

const personalUser = { id: "usr_owner", username: "owner", account_type: "user", session_ttl_days: null };

const insertedSession = (statements) => statements.find((statement) => statement.sql.includes("INSERT INTO sessions"));

describe("personal session guard", () => {
  test("refuses a second login for the same terminal from another IP", async () => {
    const { context } = createContext({
      liveSessions: [{ id: "sess_web", client_kind: "web", user_agent: "Chrome", ip_address: "198.51.100.9" }],
    });
    await expect(createSession(context, personalUser, "web-device-device-id", "web"))
      .rejects.toMatchObject({ code: "terminal_ip_conflict", status: 409 });
  });

  test("allows the same device to reauthenticate from a new IP", async () => {
    const deviceId = "web-device-device-id";
    const { context, statements } = createContext({
      liveSessions: [{
        id: "sess_web",
        device_id: deviceId,
        client_kind: "web",
        user_agent: "Chrome",
        ip_address: "198.51.100.9",
      }],
    });
    await createSession(context, personalUser, deviceId, "web");
    expect(statements).toHaveLength(2);
    expect(statements[0].args).toContain(deviceId);
    expect(insertedSession(statements).args[8]).toBe("203.0.113.5");
  });

  test("a matching device does not hide a different device IP conflict", async () => {
    const { context, statements } = createContext({
      liveSessions: [
        { id: "sess_same", device_id: "web-device-device-id", client_kind: "web", user_agent: "Chrome", ip_address: "198.51.100.9" },
        { id: "sess_other", device_id: "other-web-device", client_kind: "web", user_agent: "Chrome", ip_address: "192.0.2.10" },
      ],
    });
    await expect(createSession(context, personalUser, "web-device-device-id", "web"))
      .rejects.toMatchObject({ code: "terminal_ip_conflict", status: 409 });
    expect(statements).toHaveLength(0);
  });

  test("a user-agent fallback is not treated as an explicit matching device", async () => {
    const userAgent = "Mozilla/5.0 Chrome/120";
    const { context, statements } = createContext({
      userAgent,
      liveSessions: [{
        id: "sess_legacy",
        device_id: `legacy-ua:${userAgent}`,
        client_kind: "web",
        user_agent: userAgent,
        ip_address: "198.51.100.9",
      }],
    });
    await expect(createSession(context, personalUser, undefined, "web"))
      .rejects.toMatchObject({ code: "terminal_ip_conflict", status: 409 });
    expect(statements).toHaveLength(0);
  });

  test("allows the same terminal from the same IP and a different terminal from another IP", async () => {
    const sameIp = createContext({
      ip: "203.0.113.5",
      liveSessions: [{ id: "sess_web", client_kind: "web", user_agent: "Chrome", ip_address: "203.0.113.5" }],
    });
    expect((await createSession(sameIp.context, personalUser, "web-device-device-id", "web")).token).toBeTruthy();

    const otherTerminal = createContext({
      ip: "203.0.113.5",
      liveSessions: [{ id: "sess_desktop", client_kind: "desktop", user_agent: "EdgeEver/1.0", ip_address: "198.51.100.9" }],
    });
    expect((await createSession(otherTerminal.context, personalUser, "mobile-device-identifier", "mobile")).token)
      .toBeTruthy();
  });

  test("classifies legacy rows from their user agent", async () => {
    const { context } = createContext({
      userAgent: "Mozilla/5.0 (iPhone) Mobile Safari",
      liveSessions: [{
        id: "sess_old",
        client_kind: null,
        user_agent: "Mozilla/5.0 (Android 14) Mobile",
        ip_address: "198.51.100.9",
      }],
    });
    await expect(createSession(context, personalUser, "mobile-device-identifier", "mobile"))
      .rejects.toMatchObject({ code: "terminal_ip_conflict" });
  });

  test("shared accounts keep every session and ignore the IP restriction", async () => {
    const { context, statements } = createContext({
      ip: "203.0.113.5",
      liveSessions: [{ id: "sess_web", client_kind: "web", user_agent: "Chrome", ip_address: "198.51.100.9" }],
    });
    await createSession(context, { ...personalUser, account_type: "group" }, "web-device-device-id", "web");
    // No same-device revocation either: every shared sign-in must coexist.
    expect(statements).toHaveLength(1);
    expect(insertedSession(statements)).toBeTruthy();
  });

  test("a fresh sign-in on the same device still replaces its old session", async () => {
    const { context, statements } = createContext();
    await createSession(context, personalUser, "web-device-device-id", "web");
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("UPDATE sessions SET revoked_at");
    expect(statements[0].args).toContain("web-device-device-id");
    expect(insertedSession(statements).args).toContain("web");
  });

  test("falls back to the forwarded client IP when the CF header is absent", async () => {
    const { db, statements } = createDatabase();
    const context = {
      req: {
        header: (name) => ({
          "user-agent": "Mozilla/5.0 Chrome/120",
          "x-real-ip": "198.51.100.44",
        })[name.toLowerCase()] ?? null,
        raw: { cf: {} },
      },
      env: { storage: { db } },
    };
    await createSession(context, personalUser, "web-device-device-id", "web");
    expect(insertedSession(statements).args).toContain("198.51.100.44");
  });
});

describe("configurable login retention", () => {
  test("browser and mobile sessions use the personal retention setting", async () => {
    const { context, statements } = createContext();
    const before = Date.now();
    await createSession(context, { ...personalUser, session_ttl_days: 7 }, "web-device-device-id", "web");
    const expiresAt = Date.parse(insertedSession(statements).args.at(-3));
    expect(expiresAt - before).toBeGreaterThan((7 * DAY_MS) - 60_000);
    expect(expiresAt - before).toBeLessThan((7 * DAY_MS) + 60_000);
  });

  test("the desktop client keeps the long instance default", async () => {
    const { context, statements } = createContext();
    const before = Date.now();
    await createSession(context, { ...personalUser, session_ttl_days: 3 }, "desktop-client-device", "desktop");
    const expiresAt = Date.parse(insertedSession(statements).args.at(-3));
    expect(expiresAt - before).toBeGreaterThan(399 * DAY_MS);
  });

  test("the admin console owns the desktop lifetime", async () => {
    const { context, statements } = createContext({ desktopTtlDays: 45 });
    const before = Date.now();
    await createSession(context, { ...personalUser, session_ttl_days: 3 }, "desktop-client-device", "desktop");
    const expiresAt = Date.parse(insertedSession(statements).args.at(-3));
    expect(expiresAt - before).toBeGreaterThan((45 * DAY_MS) - 60_000);
    expect(expiresAt - before).toBeLessThan((45 * DAY_MS) + 60_000);

    // Browser sessions still follow the personal setting, not the admin one.
    const web = createContext({ desktopTtlDays: 45 });
    const webBefore = Date.now();
    await createSession(web.context, { ...personalUser, session_ttl_days: 7 }, "web-device-device-id", "web");
    const webExpiry = Date.parse(insertedSession(web.statements).args.at(-3));
    expect(webExpiry - webBefore).toBeLessThan((8 * DAY_MS));
  });

  test("expiry ignores out-of-range choices and clamps into policy", () => {
    expect(getLoginSessionPolicy({}, null, "user")).toMatchObject({
      sessionTtlDays: 400,
      defaultSessionTtlDays: 400,
      minSessionTtlDays: 1,
      maxSessionTtlDays: 400,
      mutable: true,
    });
    expect(getLoginSessionPolicy({}, 90, "user").sessionTtlDays).toBe(90);
    expect(getLoginSessionPolicy({}, 9999, "user").sessionTtlDays).toBe(400);
    expect(getLoginSessionPolicy({}, 7, "group").mutable).toBe(false);
    expect(getLoginSessionPolicy({}, null, "user")).toMatchObject({ desktopSessionTtlDays: 400 });
    expect(getLoginSessionPolicy({}, null, "user", 30).desktopSessionTtlDays).toBe(30);
    expect(getLoginSessionPolicy({}, null, "user", 9999).desktopSessionTtlDays).toBe(3650);
  });

  test("an admin change caps desktop sessions only", async () => {
    const farFuture = new Date(Date.now() + 200 * DAY_MS).toISOString();
    const { db, statements } = createDatabase([
      { id: "sess_desktop", client_kind: "desktop", user_agent: "EdgeEver/1.0", ip_address: "1.1.1.1", expires_at: farFuture },
      { id: "sess_web", client_kind: "web", user_agent: "Chrome", ip_address: "1.1.1.1", expires_at: farFuture },
      { id: "sess_legacy_desktop", client_kind: null, user_agent: "EdgeEver/1.0", ip_address: "1.1.1.1", expires_at: farFuture },
    ]);
    const capped = await capDesktopSessionsToRetention(db, 30);
    expect(capped).toBe(2);
    expect(statements.map((statement) => statement.args[1]).sort()).toEqual(
      ["sess_desktop", "sess_legacy_desktop"].sort(),
    );
  });

  test("saving a shorter window caps browser and mobile sessions only", async () => {
    const farFuture = new Date(Date.now() + 200 * DAY_MS).toISOString();
    const { db, statements } = createDatabase([
      { id: "sess_desktop", client_kind: "desktop", user_agent: "EdgeEver/1.0", ip_address: "1.1.1.1", expires_at: farFuture },
      { id: "sess_web", client_kind: "web", user_agent: "Chrome", ip_address: "1.1.1.1", expires_at: farFuture },
      { id: "sess_legacy_web", client_kind: null, user_agent: "Firefox", ip_address: "1.1.1.1", expires_at: farFuture },
    ]);
    const capped = await capSessionsToRetention(db, "usr_owner", 7);
    expect(capped).toBe(2);
    expect(statements.map((statement) => statement.args[1]).sort()).toEqual(
      ["sess_legacy_web", "sess_web"].sort(),
    );
  });
});
