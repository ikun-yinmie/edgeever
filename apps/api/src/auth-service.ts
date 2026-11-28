import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { hasBootstrapCredential, isSupportedPasswordHash, verifyBootstrapPassword } from "./auth-bootstrap";
import { hashPassword, randomToken, SESSION_TOKEN_BYTES, verifyPassword } from "./auth-crypto";
import type { LoginAttemptKey } from "./auth-login-limiter";
import {
  resolveSessionClientKind,
  resolveSessionDeviceId,
  sessionClientKind,
  type SessionClientKindRow,
} from "./auth-session-devices";
import {
  isDatabaseNotReadyError,
  isUnauthenticatedAccessEnabled,
  resolveInstanceAuthMode,
  type InstanceAuthMode,
} from "./auth-state";
import { isGroupAccount } from "./group-account-service";
import type { ApiTokenRow } from "./api-token-routes";
import type { AppContext, AuthContext, Bindings } from "./api-context";
import { AppError } from "./app-error";
import type { UserRow } from "./auth-routes";
import { createId, isoNow, parseJsonArray } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { apiError } from "./http-errors";
import type { DatabaseAdapter } from "./storage-contract";
import type { InstanceUserRow } from "./user-routes";
import { ensureUserWorkspace } from "./workspace-provisioning";

type SessionRow = {
  id: string;
  user_id: string;
  account_type: "user" | "group" | null;
  username: string;
  display_name: string | null;
  expires_at: string;
  last_seen_at: string | null;
  workspace_id: string | null;
  role: "owner" | "admin" | "member" | null;
};

const SESSION_COOKIE = "edgeever_session";
const DEFAULT_GROUP_SESSION_TTL_DAYS = 30;
const DEFAULT_SESSION_TTL_DAYS = 400;
const MAX_SESSION_TTL_DAYS = 400;
const MIN_SESSION_TTL_DAYS = 1;
// The admin console may hand the desktop client a longer-lived session than a
// browser; the ceiling is deliberately generous but still finite.
const MAX_DESKTOP_SESSION_TTL_DAYS = 3650;
const SECONDS_PER_DAY = 24 * 60 * 60;
const SESSION_LAST_SEEN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const clampNumber = (value: number, min: number, max: number) =>
  Number.isNaN(value) ? min : Math.min(Math.max(value, min), max);

export const getInstanceAuthMode = async (
  env: Bindings,
  verifyDatabase = false,
): Promise<InstanceAuthMode> => {
  if (!env.storage.db || typeof env.storage.db.prepare !== "function") {
    throw new AppError(
      "database_not_ready",
      "Database is not ready. Bind the D1 database as DB and apply the remote migrations.",
      503,
    );
  }

  const allowUnauthenticated = isUnauthenticatedAccessEnabled(env.EDGE_EVER_ALLOW_UNAUTHENTICATED);
  const bootstrapCredentialConfigured = hasBootstrapCredential(
    env.EDGE_EVER_AUTH_PASSWORD,
    env.EDGE_EVER_AUTH_PASSWORD_HASH,
  );

  if (!verifyDatabase) {
    if (allowUnauthenticated) return "disabled";
    if (bootstrapCredentialConfigured) return "required";
  }

  let user: { id: string } | null;
  try {
    user = await env.storage.db.prepare(`SELECT id FROM users WHERE is_disabled = 0 LIMIT 1`).first<{ id: string }>();
  } catch (error) {
    if (isDatabaseNotReadyError(error)) {
      throw new AppError(
        "database_not_ready",
        "Database is not ready. Bind the D1 database as DB and apply the remote migrations.",
        503,
      );
    }
    throw error;
  }

  return resolveInstanceAuthMode({
    allowUnauthenticated,
    hasBootstrapCredential: bootstrapCredentialConfigured,
    hasEnabledUser: Boolean(user),
  });
};

export const getLoginAttemptKeys = async (c: AppContext, username: string): Promise<LoginAttemptKey[]> => {
  const keys: LoginAttemptKey[] = [{ scope: "username", key: await sha256(username.trim()) }];
  const clientIp = getClientIp(c);

  if (clientIp) {
    keys.push({ scope: "ip", key: await sha256(clientIp) });
  }

  return keys;
};

const getClientIp = (c: Context) => {
  const cloudflareIp = c.req.header("CF-Connecting-IP")?.trim();
  if (cloudflareIp) return cloudflareIp;

  const realIp = c.req.header("X-Real-IP")?.trim();
  if (realIp) return realIp;

  const forwardedIp = c.req.header("X-Forwarded-For")?.split(",", 1)[0]?.trim();
  return forwardedIp || null;
};

export const tooManyLoginAttempts = (c: Context, retryAfterSeconds: number) => {
  c.header("Retry-After", String(retryAfterSeconds));
  return apiError(c, "login_rate_limited", "Too many login attempts. Try again later.", 429);
};

export const verifyLogin = async (env: Bindings, username: string, password: string): Promise<UserRow | null> => {
  const normalizedUsername = username.trim();
  // Members may sign in with their username or their registered email address.
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedUsername);
  const existingUser = isEmail
    ? (await getUserByEmail(env.storage.db, normalizedUsername)
      ?? (normalizedUsername !== normalizedUsername.toLowerCase()
        ? await getUserByEmail(env.storage.db, normalizedUsername.toLowerCase())
        : null))
    : await getUserByUsername(env.storage.db, normalizedUsername);

  if (existingUser) {
    if (await verifyPassword(password, existingUser.password_hash)) {
      return existingUser;
    }

    if (!isSupportedPasswordHash(existingUser.password_hash)) {
      throw new AppError(
        "password_hash_invalid",
        "This account has an invalid password hash. Reset it with the EdgeEver password reset command.",
        503,
      );
    }

    return null;
  }

  const configuredHash = env.EDGE_EVER_AUTH_PASSWORD_HASH?.trim();
  const configuredPassword = env.EDGE_EVER_AUTH_PASSWORD;

  if (!configuredHash && !configuredPassword) {
    return null;
  }

  const configuredUsername = env.EDGE_EVER_AUTH_USERNAME?.trim() || "admin";

  if (normalizedUsername !== configuredUsername) {
    return null;
  }

  const passwordMatches = await verifyBootstrapPassword(
    password,
    configuredPassword,
    configuredHash,
    verifyPassword,
  );

  if (!passwordMatches) {
    return null;
  }

  const now = isoNow();
  const userId = createId("usr");
  const passwordHash = await hashPassword(password);

  await env.storage.db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, normalizedUsername, passwordHash, normalizedUsername, now, now)
    .run();

  return getUserByUsername(env.storage.db, normalizedUsername);
};

const getUserByUsername = async (db: DatabaseAdapter, username: string) =>
  db
    .prepare(
      `SELECT id, username, password_hash, display_name, is_disabled, account_type, session_ttl_days
       FROM users
       WHERE username = ? AND is_disabled = 0`
    )
    .bind(username)
    .first<UserRow>();

const getUserByEmail = async (db: DatabaseAdapter, email: string) =>
  db
    .prepare(
      `SELECT id, username, password_hash, display_name, is_disabled, account_type, session_ttl_days
       FROM users
       WHERE email = ? AND is_disabled = 0`
    )
    .bind(email)
    .first<UserRow>();

export const getInstanceUser = (db: DatabaseAdapter, userId: string) =>
  db.prepare(
    `SELECT u.id, u.username, u.password_hash, u.display_name, u.email, u.is_disabled, u.is_deleted,
            u.last_login_at, u.created_at, u.account_type, wm.role
     FROM users u
     INNER JOIN workspace_members wm ON wm.user_id = u.id
     WHERE u.id = ?`
  ).bind(userId).first<InstanceUserRow>();

export const createSession = async (
  c: AppContext,
  user: UserRow,
  requestedDeviceId?: string,
  requestedClientKind?: string,
) => {
  const token = randomToken(SESSION_TOKEN_BYTES);
  const id = createId("sess");
  const now = isoNow();
  const isSharedAccount = isGroupAccount((user as { account_type?: string | null }).account_type);
  const userAgent = c.req.header("User-Agent") ?? null;
  const clientKind = resolveSessionClientKind(requestedClientKind, userAgent);
  // Browser and mobile logins follow the personal-center retention setting;
  // shared accounts keep their own instance-wide lifetime. The desktop client
  // is an instance policy: the admin console owns its lifetime.
  const desktopTtlDays = !isSharedAccount && clientKind === "desktop"
    ? await getDesktopSessionTtlDays(c.env.storage.db, c.env)
    : null;
  const maxAgeDays = isSharedAccount
    ? getGroupSessionMaxAgeDays(c.env)
    : clientKind === "desktop"
      ? (desktopTtlDays ?? getSessionMaxAgeDays(c.env))
      : resolveUserSessionTtlDays(c.env, user);
  const maxAge = maxAgeDays * SECONDS_PER_DAY;
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  const deviceId = resolveSessionDeviceId(requestedDeviceId, userAgent, id);
  const ip = getClientIp(c) ?? null;
  const ipHash = ip ? await sha256(ip) : null;
  const cf = c.req.raw.cf as { country?: string; region?: string } | undefined;
  const ipCountry = c.req.header("CF-IPCountry") ?? cf?.country ?? null;
  const ipRegion = cf?.region ?? null;

  // A personal account keeps one login per terminal (desktop client, desktop
  // web, mobile), and that terminal is pinned to the IP it signed in from. A login
  // from another IP on a different device is refused instead of replacing a live
  // session that may still hold unsynced notes. The desktop client (or a password
  // change) is the way to clear a conflicting session on another device.
  if (!isSharedAccount && ip) {
    const liveSessions = await c.env.storage.db.prepare(
      `SELECT id, device_id, client_kind, user_agent, ip_address
       FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(user.id, now).all<SessionClientKindRow>();
    const conflicting = (liveSessions.results ?? []).find((row) =>
      (!requestedDeviceId || row.device_id !== requestedDeviceId)
      && sessionClientKind(row) === clientKind
      && Boolean(row.ip_address)
      && row.ip_address !== ip);
    if (conflicting) {
      throw new AppError(
        "terminal_ip_conflict",
        `This account is already signed in to the ${clientKind} terminal from another IP address.`
          + " Sign that session out from the desktop client before signing in here.",
        409,
      );
    }
  }

  const statements = [
    // A personal account keeps one live session per device: a fresh sign-in
    // replaces the previous one. Shared group accounts never revoke — every
    // sign-in, anywhere, is meant to coexist so several people can collaborate
    // through the same credential at the same time.
    ...(isSharedAccount
      ? []
      : [
          c.env.storage.db.prepare(
            `UPDATE sessions SET revoked_at = ?
             WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`
          ).bind(now, user.id, deviceId),
        ]),
    c.env.storage.db.prepare(
      `INSERT INTO sessions (
        id, user_id, token_hash, device_id, client_kind, user_agent, ip_hash, device_label, ip_address, ip_country, ip_region, expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, await sha256(token), deviceId, clientKind, userAgent, ipHash, null, ip, ipCountry, ipRegion, expiresAt, now, now),
  ];

  await c.env.storage.db.batch(statements);

  return { id, token, maxAge };
};

/**
 * Shorten the live browser/mobile sessions of a personal account to the newly
 * configured retention window. Desktop-client sessions are left alone, and a
 * session is never extended past its original expiry.
 */
export const capSessionsToRetention = async (
  db: DatabaseAdapter,
  userId: string,
  ttlDays: number,
) => {
  const now = new Date();
  const cappedExpiry = new Date(now.getTime() + clampNumber(ttlDays, MIN_SESSION_TTL_DAYS, MAX_SESSION_TTL_DAYS) * SECONDS_PER_DAY * 1000)
    .toISOString();
  const rows = await db.prepare(
    `SELECT id, client_kind, user_agent, ip_address, expires_at
     FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(userId, now.toISOString()).all<SessionClientKindRow & { expires_at: string }>();
  const targets = (rows.results ?? []).filter((row) =>
    sessionClientKind(row) !== "desktop" && row.expires_at > cappedExpiry);
  if (targets.length === 0) return 0;
  await db.batch(targets.map((row) => db.prepare(
    `UPDATE sessions SET expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(cappedExpiry, row.id, cappedExpiry)));
  return targets.length;
};

/**
 * Admin-console counterpart of the personal retention: shrink existing
 * desktop-client sessions of personal accounts. Shared accounts keep their
 * group lifetime, so their desktop sessions are not touched.
 */
export const capDesktopSessionsToRetention = async (
  db: DatabaseAdapter,
  ttlDays: number,
) => {
  const now = new Date();
  const cappedExpiry = new Date(now.getTime() + clampNumber(ttlDays, MIN_SESSION_TTL_DAYS, MAX_DESKTOP_SESSION_TTL_DAYS) * SECONDS_PER_DAY * 1000)
    .toISOString();
  const rows = await db.prepare(
    `SELECT s.id, s.client_kind, s.user_agent, s.ip_address, s.expires_at
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.revoked_at IS NULL
       AND s.expires_at > ?
       AND (u.account_type IS NULL OR u.account_type != 'group')`,
  ).bind(now.toISOString()).all<SessionClientKindRow & { expires_at: string }>();
  const targets = (rows.results ?? []).filter((row) =>
    sessionClientKind(row) === "desktop" && row.expires_at > cappedExpiry);
  if (targets.length === 0) return 0;
  await db.batch(targets.map((row) => db.prepare(
    `UPDATE sessions SET expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(cappedExpiry, row.id, cappedExpiry)));
  return targets.length;
};

const resolveDesktopSessionTtlDays = (env: Bindings, configured: unknown) => {
  const value = Number(configured);
  if (!Number.isFinite(value) || value < MIN_SESSION_TTL_DAYS) return getSessionMaxAgeDays(env);
  return Math.floor(clampNumber(value, MIN_SESSION_TTL_DAYS, MAX_DESKTOP_SESSION_TTL_DAYS));
};

/** Instance-wide desktop-client lifetime, falling back to the deploy default. */
export const getDesktopSessionTtlDays = async (db: DatabaseAdapter, env: Bindings) => {
  let configured: unknown = null;
  try {
    const row = await db
      .prepare(`SELECT desktop_session_ttl_days FROM instance_settings WHERE id = 'instance'`)
      .first<{ desktop_session_ttl_days: number | null }>();
    configured = row?.desktop_session_ttl_days ?? null;
  } catch {
    // A deployment that has not run the migration yet still signs clients in;
    // it just uses the environment default.
    configured = null;
  }
  return resolveDesktopSessionTtlDays(env, configured);
};

export const getLoginSessionPolicy = (
  env: Bindings,
  ttlDays: number | null | undefined,
  accountType: string | null | undefined,
  desktopTtlDays: unknown = null,
) => ({
  sessionTtlDays: resolveUserSessionTtlDays(env, { session_ttl_days: ttlDays ?? null }),
  desktopSessionTtlDays: resolveDesktopSessionTtlDays(env, desktopTtlDays),
  defaultSessionTtlDays: getSessionMaxAgeDays(env),
  minSessionTtlDays: MIN_SESSION_TTL_DAYS,
  maxSessionTtlDays: MAX_SESSION_TTL_DAYS,
  mutable: !isGroupAccount(accountType),
});

export const setSessionCookie = (c: AppContext, token: string, maxAge: number) => {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
};

export const revokeSession = async (db: DatabaseAdapter, token: string) => {
  await db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .bind(isoNow(), await sha256(token))
    .run();
};

export const authenticateRequest = async (c: AppContext, touch: boolean): Promise<AuthContext | null> => {
  const bearerAuth = await authenticateBearerToken(c, touch);

  if (bearerAuth) {
    return bearerAuth;
  }

  return authenticateSession(c, touch);
};

const authenticateBearerToken = async (c: AppContext, touch: boolean): Promise<AuthContext | null> => {
  const token = getBearerToken(c);

  if (!token) {
    return null;
  }

  const sessionAuth = await authenticateSessionToken(c, token, touch);

  if (sessionAuth) {
    return sessionAuth;
  }

  const row = await c.env.storage.db.prepare(
    `SELECT id, name, token_value, scopes_json, last_used_at, expires_at, is_revoked, created_at, workspace_id
     FROM api_tokens
     WHERE token_hash = ?
       AND is_revoked = 0
       AND (expires_at IS NULL OR expires_at > ?)`
  )
    .bind(await sha256(token), isoNow())
    .first<ApiTokenRow>();

  if (!row) {
    return null;
  }

  const lastUsedAt = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
  if (
    touch
    && (!Number.isFinite(lastUsedAt) || lastUsedAt <= Date.now() - API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS)
  ) {
    const now = isoNow();
    const cutoff = new Date(Date.now() - API_TOKEN_LAST_USED_UPDATE_INTERVAL_MS).toISOString();
    await c.env.storage.db.prepare(
      `UPDATE api_tokens
       SET last_used_at = ?
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
    ).bind(now, row.id, cutoff).run();
  }

  return {
    kind: "agent",
    actorType: "agent",
    actorId: row.id,
    username: row.name,
    displayName: row.name,
    scopes: parseJsonArray(row.scopes_json),
    workspaceId: row.workspace_id,
    role: "member",
    accountType: "user",
    tokenId: row.id,
  };
};

const authenticateSessionToken = async (c: AppContext, token: string, touch: boolean): Promise<AuthContext | null> => {
  const now = isoNow();
  const row = await c.env.storage.db.prepare(
    `SELECT s.id, s.user_id, u.username, u.display_name, s.expires_at, s.last_seen_at,
            u.account_type, wm.workspace_id, wm.role
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     LEFT JOIN workspace_members wm ON wm.user_id = s.user_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
       AND u.is_disabled = 0`
  )
    .bind(await sha256(token), now)
    .first<SessionRow>();

  if (!row) {
    return null;
  }

  const lastSeenAt = row.last_seen_at ? Date.parse(row.last_seen_at) : Number.NaN;
  if (
    touch
    && (!Number.isFinite(lastSeenAt) || lastSeenAt <= Date.now() - SESSION_LAST_SEEN_UPDATE_INTERVAL_MS)
  ) {
    const cutoff = new Date(Date.now() - SESSION_LAST_SEEN_UPDATE_INTERVAL_MS).toISOString();
    await c.env.storage.db.prepare(
      `UPDATE sessions
       SET last_seen_at = ?
       WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
    ).bind(now, row.id, cutoff).run();
  }

  const workspace = row.workspace_id && row.role
    ? { workspaceId: row.workspace_id, role: row.role }
    : await ensureUserWorkspace(c.env.storage.db, row.user_id, row.username, c.req.header("accept-language"));

  return {
    kind: "user",
    actorType: "user",
    actorId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    scopes: [],
    workspaceId: workspace.workspaceId,
    role: workspace.role,
    accountType: row.account_type === "group" ? "group" : "user",
    sessionId: row.id,
  };
};

export const authenticateSession = async (c: AppContext, touch: boolean): Promise<AuthContext | null> => {
  const token = getCookie(c, SESSION_COOKIE);

  if (!token) {
    return null;
  }

  return authenticateSessionToken(c, token, touch);
};

export const getBearerToken = (c: AppContext) => {
  const authorization = c.req.header("Authorization");

  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token ? token : null;
};

const getSessionMaxAgeDays = (env: Bindings) =>
  Math.floor(clampNumber(
    Number(env.EDGE_EVER_SESSION_TTL_DAYS ?? DEFAULT_SESSION_TTL_DAYS),
    MIN_SESSION_TTL_DAYS,
    MAX_SESSION_TTL_DAYS,
  ));

/** Shared group accounts sign in from many places at once, so they use their own TTL. */
const getGroupSessionMaxAgeDays = (env: Bindings) =>
  Math.floor(clampNumber(
    Number(env.EDGE_EVER_GROUP_SESSION_TTL_DAYS ?? DEFAULT_GROUP_SESSION_TTL_DAYS),
    MIN_SESSION_TTL_DAYS,
    MAX_SESSION_TTL_DAYS,
  ));

/** Personal retention choice, falling back to the instance default when unset. */
const resolveUserSessionTtlDays = (env: Bindings, user: { session_ttl_days?: number | null }) => {
  const configured = Number(user.session_ttl_days);
  if (!Number.isFinite(configured) || configured < MIN_SESSION_TTL_DAYS) return getSessionMaxAgeDays(env);
  return Math.floor(clampNumber(configured, MIN_SESSION_TTL_DAYS, MAX_SESSION_TTL_DAYS));
};
