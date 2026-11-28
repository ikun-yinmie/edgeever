import type {
  AccountEmailCodeRequestInput,
  AccountEmailCodeResponse,
  AccountEmailStatus,
  AccountEmailVerifyInput,
} from "@edgeever/shared";
import type { Bindings } from "./api-context";
import { AppError } from "./app-error";
import { verifyPassword } from "./auth-crypto";
import { createId } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { getInstanceSettingsRow, getSmtpConfig } from "./instance-settings-service";
import { sendAccountEmailCodeEmail } from "./smtp-client";
import type { DatabaseAdapter, DatabaseQueryResult } from "./storage-contract";

const PURPOSE = "account_email";
const MAX_ATTEMPTS = 6;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type AccountRow = {
  id: string;
  email: string | null;
  email_verified_at: string | null;
  password_hash: string;
  account_email_version: number;
};
type ChallengeRow = {
  id: string;
  email: string;
  code_hash: string;
  user_version: number;
  attempts: number;
  delivered: number;
  expires_at: string;
};
export type AccountEmailDependencies = {
  sendEmail?: typeof sendAccountEmailCodeEmail;
};
type RequestDetails = { ip: string | null; locale?: string | null };

// All writes target one unique row. Bun/SQLite may include trigger deletions
// in meta.changes, while D1 may count only the direct update; both must be > 0.
const changed = (result: DatabaseQueryResult<unknown>) => Number(result.meta.changes) > 0;
const invalidCode = () => new AppError("email_code_invalid", "The verification code is invalid or has already been used. Request a new code.", 400);
const stateChanged = () => new AppError("account_email_state_changed", "Your account changed during verification. Request a new code.", 409);

const loadAccount = async (database: DatabaseAdapter, userId: string): Promise<AccountRow> => {
  const account = await database.prepare(
    `SELECT id, email, email_verified_at, password_hash, account_email_version FROM users
     WHERE id = ? AND is_disabled = 0 AND is_deleted = 0 AND COALESCE(account_type, 'user') = 'user'`,
  ).bind(userId).first<AccountRow>();
  if (!account) throw new AppError("account_email_unavailable", "A personal user account is required.", 403);
  return account;
};

export const getAccountEmailStatus = async (environment: Bindings, userId: string): Promise<AccountEmailStatus> => {
  const account = await loadAccount(environment.storage.db, userId);
  return {
    email: account.email,
    emailVerifiedAt: account.email_verified_at,
    canManage: true,
    emailDeliveryConfigured: Boolean(await getSmtpConfig(environment)),
  };
};

// Each counter is reserved with one conditional UPSERT, not a read-then-write.
// A rejected reservation may charge another key too; it never grants work.
const reserveLimits = async (
  database: DatabaseAdapter,
  limits: { key: string; max: number; window: number }[],
  now: number,
) => {
  const nowIso = new Date(now).toISOString();
  await database.prepare(`DELETE FROM account_email_rate_limits WHERE window_started_at <= ?`)
    .bind(new Date(now - 2 * DAY).toISOString()).run();
  const results = await database.batch(await Promise.all(limits.map(async ({ key, max, window }) => {
    const boundary = new Date(now - window).toISOString();
    return database.prepare(
      `INSERT INTO account_email_rate_limits (rate_key, attempts, window_started_at) VALUES (?, 1, ?)
       ON CONFLICT(rate_key) DO UPDATE SET
         attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
         window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END
       WHERE window_started_at <= ? OR attempts < ?`,
    ).bind(await sha256(key), nowIso, boundary, boundary, boundary, max);
  })));
  if (results.some((result) => !changed(result))) {
    throw new AppError("account_email_rate_limited", "Too many email verification attempts. Try again later.", 429);
  }
};

const authenticatePassword = async (
  environment: Bindings,
  userId: string,
  password: string,
  ip: string | null,
) => {
  const database = environment.storage.db;
  // Bound all password checks, including concurrent failures and alternating
  // correct/incorrect passwords. Do not clear the budget on successful checks.
  await reserveLimits(database, [
    { key: `password:user:${userId}`, max: 10, window: HOUR / 4 },
    ...(ip ? [{ key: `password:ip:${ip}`, max: 50, window: HOUR / 4 }] : []),
  ], Date.now());
  const account = await loadAccount(database, userId);
  if (!(await verifyPassword(password, account.password_hash))) {
    throw new AppError("invalid_current_password", "Current password is incorrect.", 400);
  }
  return account;
};

const assertAvailable = async (database: DatabaseAdapter, email: string, userId: string) => {
  const taken = await database.prepare(`SELECT id FROM users WHERE email = ? AND id <> ?`).bind(email, userId).first();
  if (taken) throw new AppError("email_exists", "This email address is already associated with another account.", 409);
};

const generateCode = () => {
  const random = new Uint32Array(1);
  // Rejection sampling avoids modulo bias for the six-digit code.
  do { crypto.getRandomValues(random); } while (random[0]! >= 4_294_000_000);
  return String(random[0]! % 1_000_000).padStart(6, "0");
};
const hashCode = (userId: string, id: string, email: string, code: string) =>
  sha256(JSON.stringify([PURPOSE, userId, id, email, code]));

export const requestAccountEmailCode = async (
  environment: Bindings,
  userId: string,
  input: AccountEmailCodeRequestInput,
  details: RequestDetails,
  dependencies: AccountEmailDependencies = {},
): Promise<AccountEmailCodeResponse> => {
  const database = environment.storage.db;
  const account = await authenticatePassword(environment, userId, input.currentPassword, details.ip);
  const settings = await getInstanceSettingsRow(database);
  const smtp = await getSmtpConfig(environment, settings);
  if (!smtp) throw new AppError("smtp_not_configured", "Email delivery is not configured by the administrator.", 400);
  await assertAvailable(database, input.email, userId);
  const now = Date.now();
  const cooldownSeconds = Math.min(3600, Math.max(10, settings.code_resend_cooldown_seconds));
  const ttlSeconds = Math.min(3600, Math.max(30, settings.code_ttl_seconds));
  await reserveLimits(database, [
    { key: `send:user:hour:${userId}`, max: 5, window: HOUR },
    { key: `send:user:day:${userId}`, max: 20, window: DAY },
    ...(details.ip ? [
      { key: `send:ip:hour:${details.ip}`, max: Math.min(20, Math.max(1, settings.code_ip_hourly_limit)), window: HOUR },
      { key: `send:ip:day:${details.ip}`, max: Math.min(100, Math.max(1, settings.code_ip_daily_limit)), window: DAY },
    ] : []),
  ], now);
  const code = generateCode();
  const id = createId("aec");
  const nowIso = new Date(now).toISOString();
  const result = await database.prepare(
    `INSERT INTO account_email_verifications
       (user_id, id, purpose, email, code_hash, user_version, attempts, delivered, expires_at, created_at)
     SELECT id, ?, ?, ?, ?, account_email_version, 0, 0, ?, ? FROM users
     WHERE id = ? AND account_email_version = ? AND password_hash = ?
       AND is_disabled = 0 AND is_deleted = 0 AND COALESCE(account_type, 'user') = 'user'
     ON CONFLICT(user_id) DO UPDATE SET
       id = excluded.id, purpose = excluded.purpose, email = excluded.email, code_hash = excluded.code_hash,
       user_version = excluded.user_version, attempts = 0, delivered = 0,
       expires_at = excluded.expires_at, created_at = excluded.created_at
     WHERE account_email_verifications.created_at <= ?`,
  ).bind(id, PURPOSE, input.email, await hashCode(userId, id, input.email, code),
    new Date(now + ttlSeconds * 1000).toISOString(), nowIso, userId, account.account_email_version,
    account.password_hash, new Date(now - cooldownSeconds * 1000).toISOString()).run();
  if (!changed(result)) {
    const current = await loadAccount(database, userId);
    if (current.account_email_version !== account.account_email_version) throw stateChanged();
    throw new AppError("email_code_cooldown", "Please wait before requesting another verification code.", 429);
  }
  try {
    await (dependencies.sendEmail ?? sendAccountEmailCodeEmail)(smtp, input.email, code, details.locale ?? null, ttlSeconds);
  } catch {
    // Retain the cooldown, but a failed or ambiguous delivery cannot be used.
    await database.prepare(`UPDATE account_email_verifications SET expires_at = created_at WHERE user_id = ? AND id = ?`)
      .bind(userId, id).run();
    throw new AppError("email_delivery_failed", "Failed to send the verification email. Please try again later.", 502);
  }
  const delivered = await database.prepare(`UPDATE account_email_verifications SET delivered = 1 WHERE user_id = ? AND id = ?`)
    .bind(userId, id).run();
  if (!changed(delivered)) throw stateChanged();
  return { ok: true, expiresInMinutes: Math.max(1, Math.ceil(ttlSeconds / 60)), cooldownSeconds };
};

const isEmailUniqueConflict = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (/UNIQUE constraint failed: users\.email|idx_users_email/i.test(String(current))) return true;
    current = typeof current === "object" && "cause" in current ? current.cause : null;
  }
  return false;
};

export const verifyAccountEmail = async (
  environment: Bindings,
  userId: string,
  input: AccountEmailVerifyInput,
  details: RequestDetails,
): Promise<AccountEmailStatus> => {
  const database = environment.storage.db;
  const account = await authenticatePassword(environment, userId, input.currentPassword, details.ip);
  const challenge = await database.prepare(
    `SELECT id, email, code_hash, user_version, attempts, delivered, expires_at
     FROM account_email_verifications WHERE user_id = ? AND purpose = ?`,
  ).bind(userId, PURPOSE).first<ChallengeRow>();
  if (!challenge || !challenge.delivered || challenge.email !== input.email || challenge.attempts >= MAX_ATTEMPTS) throw invalidCode();
  if (challenge.user_version !== account.account_email_version) throw stateChanged();
  const now = new Date().toISOString();
  if (challenge.expires_at <= now) throw new AppError("email_code_expired", "The verification code has expired. Request a new code.", 400);
  // Reserve an attempt before comparing, so parallel guesses cannot exceed six.
  const attempt = await database.prepare(
    `UPDATE account_email_verifications SET attempts = attempts + 1
     WHERE user_id = ? AND id = ? AND attempts < ? AND expires_at > ? AND delivered = 1`,
  ).bind(userId, challenge.id, MAX_ATTEMPTS, now).run();
  if (!changed(attempt)) throw invalidCode();
  const candidate = await hashCode(userId, challenge.id, input.email, input.code);
  if (candidate !== challenge.code_hash) throw invalidCode();
  await assertAvailable(database, input.email, userId);
  let result: DatabaseQueryResult<unknown>;
  try {
    result = await database.prepare(
      `UPDATE users SET email = ?, email_verified_at = ?, updated_at = ?, account_email_version = account_email_version + 1
       WHERE id = ? AND account_email_version = ? AND password_hash = ?
         AND is_disabled = 0 AND is_deleted = 0 AND COALESCE(account_type, 'user') = 'user'
         AND EXISTS (SELECT 1 FROM account_email_verifications
           WHERE user_id = users.id AND id = ? AND purpose = ? AND email = ? AND code_hash = ?
             AND user_version = users.account_email_version AND attempts <= ? AND expires_at > ? AND delivered = 1)`,
    ).bind(input.email, now, now, userId, account.account_email_version, account.password_hash,
      challenge.id, PURPOSE, input.email, candidate, MAX_ATTEMPTS, new Date().toISOString()).run();
  } catch (error) {
    if (isEmailUniqueConflict(error)) throw new AppError("email_exists", "This email address is already associated with another account.", 409);
    throw error;
  }
  if (!changed(result)) throw stateChanged();
  return getAccountEmailStatus(environment, userId);
};
