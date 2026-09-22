import {
  InstanceAdminSettingsUpdateSchema,
  RegistrationEmailCodeRequestSchema,
  RegistrationInviteCreateSchema,
  RegisterSchema,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { audit, auditStatement } from "./audit";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { hashPassword } from "./auth-crypto";
import { createId, isoNow } from "./entity-utils";
import { apiError, badRequest, conflict, forbidden, tooManyRequests, unauthorized } from "./http-errors";
import { INSTANCE_SETTINGS_ID } from "./instance-settings-service";
import { resolvePrimaryObjectStorageEncryptionKey } from "./object-storage";
import { encryptSecret } from "./secret-encryption";
import {
  getInstanceSettingsRow,
  getSmtpPassword,
  isRegistrationCodeRequired,
  isRegistrationEnabled,
  mapInstanceSettingsRow,
} from "./instance-settings-service";
import { requireOwner } from "./request-auth";
import { hitRateLimit } from "./rate-limit";
import { sendRegistrationCodeEmail } from "./smtp-client";
import { sha256 } from "./hash-utils";
import { createDefaultNotebookRows, createWorkspaceDefaultSeedStatements } from "./workspace-provisioning";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";

const CODE_MAX_VERIFY_ATTEMPTS = 6;
const CODE_MAX_PENDING_PER_EMAIL = 3;
const INVITE_CODE_PREFIX = "EE-";
const INVITE_CODE_BYTES = 12;
const ABUSE_HOURLY_WINDOW_MS = 60 * 60 * 1000;
const ABUSE_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const ABUSE_REGISTER_HOURLY_LIMIT = 10;
const ABUSE_REGISTER_DAILY_LIMIT = 30;
const ABUSE_FAILURE_HOURLY_LIMIT = 20;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const generateVerificationCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

// Human-friendly invite code: EE-XXXX-XXXX-XXXX-XXXX (base32-ish alphabet
// without easily confused characters).
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const generateInviteCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_BYTES));
  const chars = Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
  return `${INVITE_CODE_PREFIX}${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
};

const getRequestIp = (context: AppContext): string | null => {
  const forwarded = context.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return context.req.header("x-real-ip") ?? null;
};

type RegistrationRouteDependencies = {
  authenticateRequest: (context: AppContext, touch: boolean) => Promise<AuthContext | null>;
};

type InviteRow = {
  id: string;
  code_hash: string;
  use_count: number;
  max_uses: number;
  expires_at: string | null;
  revoked_at: string | null;
};

const consumeInviteCode = async (
  database: DatabaseAdapter,
  code: string,
  statements: PreparedStatementAdapter[],
): Promise<boolean> => {
  const normalized = code.trim().toUpperCase();
  const codeHash = await sha256(`invite:${normalized}`);
  const invite = await database
    .prepare(`SELECT id, code_hash, use_count, max_uses, expires_at, revoked_at FROM registration_invites WHERE code_hash = ?`)
    .bind(codeHash)
    .first<InviteRow>();
  if (!invite) return false;
  if (invite.revoked_at) return false;
  if (invite.expires_at && Date.parse(invite.expires_at) < Date.now()) return false;
  if (invite.use_count >= invite.max_uses) return false;
  statements.push(
    database.prepare(`UPDATE registration_invites SET use_count = use_count + 1 WHERE id = ? AND use_count < max_uses`).bind(invite.id),
  );
  return true;
};

export const registerInstanceAdminRoutes = (
  app: Hono<AppEnv>,
  dependencies: RegistrationRouteDependencies,
) => {
  // --- Public endpoints (no auth): registration & email codes ---

  app.get("/api/v1/public/registration", async (context) => {
    const database = context.env.storage.db;
    const [enabled, codeRequired, inviteRequired] = await Promise.all([
      isRegistrationEnabled(database),
      isRegistrationCodeRequired(database),
      database
        .prepare(`SELECT registration_invite_required FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
        .first<{ registration_invite_required: number }>()
        .then((row) => Boolean(row?.registration_invite_required)),
    ]);
    return context.json({
      registration: {
        enabled,
        codeRequired,
        inviteRequired,
      },
    });
  });

  app.post(
    "/api/v1/public/registration/code",
    zValidator("json", RegistrationEmailCodeRequestSchema),
    async (context) => {
      const database = context.env.storage.db;
      const settings = await getInstanceSettingsRow(database);
      if (!settings.registration_enabled) {
        return forbidden(context, "Registration is disabled on this instance.");
      }

      const { email, deviceId } = context.req.valid("json");
      const smtpPassword = await getSmtpPassword(context.env, settings);
      if (!settings.smtp_host || !settings.smtp_from_address || !smtpPassword) {
        return apiError(context, "smtp_not_configured", "Email delivery is not configured by the administrator.", 400);
      }

      if (!EMAIL_PATTERN.test(email)) {
        return apiError(context, "invalid_email", "A valid email address is required.", 400);
      }

      // Device binding is only meaningful when the requesting device is known,
      // so it is enforced at request time instead of silently passing later.
      if (settings.code_bind_device && !deviceId) {
        return apiError(context, "device_id_required", "A device identifier is required to request a code.", 400);
      }

      const now = Date.now();
      const ip = getRequestIp(context);
      const cooldownMs = Math.max(10, settings.code_resend_cooldown_seconds) * 1000;
      const ttlMs = Math.max(30, settings.code_ttl_seconds) * 1000;

      // Per-email pending + cooldown guard (always on; cheap DB queries).
      const recent = await database
        .prepare(`SELECT created_at FROM email_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 4`)
        .bind(email)
        .all<{ created_at: string }>();
      const pending = recent.results ?? [];
      if (pending.length >= CODE_MAX_PENDING_PER_EMAIL) {
        return tooManyRequests(context, "Too many pending codes for this email. Wait for them to expire.");
      }
      if (pending[0] && now - Date.parse(pending[0].created_at) < cooldownMs) {
        return tooManyRequests(context, "Please wait a moment before requesting another code.");
      }

      // Abuse guard: per-IP sliding window limits (switchable by the admin).
      if (settings.abuse_guard_enabled && ip) {
        if (!hitRateLimit(`code:ip:${ip}:h`, Math.max(1, settings.code_ip_hourly_limit), ABUSE_HOURLY_WINDOW_MS)) {
          return tooManyRequests(context, "Too many verification codes requested from this network. Try again later.");
        }
        if (!hitRateLimit(`code:ip:${ip}:d`, Math.max(1, settings.code_ip_daily_limit), ABUSE_DAILY_WINDOW_MS)) {
          return tooManyRequests(context, "Too many verification codes requested from this network today. Try again tomorrow.");
        }
      }

      const code = generateVerificationCode();
      const codeHash = await sha256(`${email}:${code}`);
      const expiresAt = new Date(now + ttlMs).toISOString();
      const nowIso = isoNow();

      await database.batch([
        database.prepare(`DELETE FROM email_verifications WHERE email = ?`).bind(email),
        database.prepare(
          `INSERT INTO email_verifications (id, email, code_hash, attempts, expires_at, created_at, ip, device_id)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
        ).bind(createId("evc"), email, codeHash, expiresAt, nowIso, ip, deviceId ?? null),
      ]);

      try {
        await sendRegistrationCodeEmail(
          {
            host: settings.smtp_host,
            port: settings.smtp_port ?? 587,
            secure: settings.smtp_port === 465,
            username: settings.smtp_username,
            password: smtpPassword,
            fromAddress: settings.smtp_from_address,
            fromName: settings.smtp_from_name,
          },
          email,
          code,
          context.req.header("accept-language") ?? null,
        );
      } catch (error) {
        console.error("[registration] failed to send verification code", error);
        return apiError(context, "email_delivery_failed", "Failed to send the verification email. Please try again later.", 502);
      }

      return context.json({
        ok: true,
        expiresInMinutes: Math.max(1, Math.round(ttlMs / 60000)),
        cooldownSeconds: Math.round(cooldownMs / 1000),
      });
    },
  );

  app.post("/api/v1/public/registration/register", zValidator("json", RegisterSchema), async (context) => {
    const database = context.env.storage.db;
    const settings = await getInstanceSettingsRow(database);
    if (!settings.registration_enabled) {
      return forbidden(context, "Registration is disabled on this instance.");
    }

    const input = context.req.valid("json");
    const ip = getRequestIp(context);

    // Abuse guard: per-IP registration caps (switchable by the admin).
    if (settings.abuse_guard_enabled && ip) {
      if (!hitRateLimit(`register:ip:${ip}:h`, ABUSE_REGISTER_HOURLY_LIMIT, ABUSE_HOURLY_WINDOW_MS)) {
        return tooManyRequests(context, "Too many registrations from this network. Try again later.");
      }
      if (!hitRateLimit(`register:ip:${ip}:d`, ABUSE_REGISTER_DAILY_LIMIT, ABUSE_DAILY_WINDOW_MS)) {
        return tooManyRequests(context, "Too many registrations from this network today. Try again tomorrow.");
      }
    }

    const codeRequired = Boolean(settings.registration_code_required);
    if (codeRequired) {
      const record = await database
        .prepare(`SELECT id, code_hash, attempts, expires_at, ip, device_id FROM email_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(input.email)
        .first<{ id: string; code_hash: string; attempts: number; expires_at: string; ip: string | null; device_id: string | null }>();
      if (!record) {
        return apiError(context, "email_code_invalid", "Request a verification code first.", 400);
      }
      if (record.attempts >= CODE_MAX_VERIFY_ATTEMPTS) {
        return apiError(context, "email_code_invalid", "Too many incorrect code attempts. Request a new code.", 400);
      }
      if (Date.parse(record.expires_at) < Date.now()) {
        await database.prepare(`DELETE FROM email_verifications WHERE email = ?`).bind(input.email).run();
        return apiError(context, "email_code_expired", "The verification code has expired. Request a new one.", 400);
      }
      if (settings.code_bind_ip && record.ip && ip && record.ip !== ip) {
        return apiError(context, "email_code_invalid", "This code was requested from a different network. Request a new code.", 400);
      }
      if (settings.code_bind_device && record.device_id && input.deviceId && record.device_id !== input.deviceId) {
        return apiError(context, "email_code_invalid", "This code was requested from a different device. Request a new code.", 400);
      }
      const candidateHash = await sha256(`${input.email}:${input.emailCode}`);
      if (candidateHash !== record.code_hash) {
        await database
          .prepare(`UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?`)
          .bind(record.id)
          .run();
        // Abuse guard: cap repeated wrong-code attempts per IP.
        if (settings.abuse_guard_enabled && ip && !hitRateLimit(`register:fail:${ip}:h`, ABUSE_FAILURE_HOURLY_LIMIT, ABUSE_HOURLY_WINDOW_MS)) {
          return tooManyRequests(context, "Too many failed attempts from this network. Try again later.");
        }
        return apiError(context, "email_code_invalid", "Incorrect verification code.", 400);
      }
    }

    // Invite code gate: consume a valid invite when required.
    const inviteStatements: PreparedStatementAdapter[] = [];
    if (settings.registration_invite_required) {
      if (!input.inviteCode) {
        return apiError(context, "invite_required", "An invite code is required to register.", 403);
      }
      const consumed = await consumeInviteCode(database, input.inviteCode, inviteStatements);
      if (!consumed) {
        return apiError(context, "invite_invalid", "This invite code is invalid, used up or expired.", 403);
      }
    }

    const username = input.username.toLowerCase();
    const existingUser = await database
      .prepare(`SELECT id FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)`)
      .bind(username, input.email)
      .first();
    if (existingUser) {
      return conflict(context, "username_or_email_exists", "Username or email already registered.");
    }

    const userId = createId("usr");
    const workspaceId = createId("ws");
    const now = isoNow();
    const passwordHash = await hashPassword(input.password);
    const displayName = input.displayName || input.username;
    const notebooks = createDefaultNotebookRows(workspaceId);
    const statements = [
      database.prepare(
        `INSERT INTO users (id, username, password_hash, display_name, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(userId, username, passwordHash, displayName, input.email, now, now),
      database.prepare(
        `INSERT INTO workspaces (id, name, is_personal, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
      ).bind(workspaceId, `${displayName}'s workspace`, now, now),
      database.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
      ).bind(workspaceId, userId, now),
      ...notebooks.map((notebook) => database.prepare(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'notebook', ?, ?, ?, ?)`,
      ).bind(notebook.id, workspaceId, notebook.name, notebook.slug, notebook.color, notebook.sortOrder, now, now)),
      ...createWorkspaceDefaultSeedStatements(database, workspaceId, now, context.req.header("accept-language")),
      ...(codeRequired
        ? [database.prepare(`DELETE FROM email_verifications WHERE email = ?`).bind(input.email)]
        : []),
      ...inviteStatements,
      auditStatement(database, "user", userId, "user.register", "user", userId, {
        username,
        email: input.email,
      }),
    ];
    await database.batch(statements);

    return context.json({ ok: true }, 201);
  });

  // --- Owner-only admin endpoints: settings + invite management ---

  const requireOwnerRequest = async (context: AppContext) => {
    const auth = await dependencies.authenticateRequest(context, true);
    if (!auth) return unauthorizedResponse(context);
    context.set("auth", auth);
    return requireOwner(context);
  };

  app.get("/api/v1/admin/instance-settings", async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const settings = await getInstanceSettingsRow(context.env.storage.db);
    return context.json({ settings: mapInstanceSettingsRow(settings) });
  });

  app.patch(
    "/api/v1/admin/instance-settings",
    zValidator("json", InstanceAdminSettingsUpdateSchema),
    async (context) => {
      const denied = await requireOwnerRequest(context);
      if (denied) return denied;

      const input = context.req.valid("json");
      const database = context.env.storage.db;
      const updates: string[] = [];
      const binds: unknown[] = [];
      const auditPayload: Record<string, unknown> = {};

      const setColumn = (column: string, value: unknown, key: string) => {
        updates.push(`${column} = ?`);
        binds.push(value);
        auditPayload[key] = value;
      };

      if (input.registrationEnabled !== undefined) setColumn("registration_enabled", input.registrationEnabled ? 1 : 0, "registrationEnabled");
      if (input.registrationCodeRequired !== undefined) setColumn("registration_code_required", input.registrationCodeRequired ? 1 : 0, "registrationCodeRequired");
      if (input.registrationInviteRequired !== undefined) setColumn("registration_invite_required", input.registrationInviteRequired ? 1 : 0, "registrationInviteRequired");
      if (input.codeTtlSeconds !== undefined) setColumn("code_ttl_seconds", input.codeTtlSeconds, "codeTtlSeconds");
      if (input.codeResendCooldownSeconds !== undefined) setColumn("code_resend_cooldown_seconds", input.codeResendCooldownSeconds, "codeResendCooldownSeconds");
      if (input.codeBindIp !== undefined) setColumn("code_bind_ip", input.codeBindIp ? 1 : 0, "codeBindIp");
      if (input.codeBindDevice !== undefined) setColumn("code_bind_device", input.codeBindDevice ? 1 : 0, "codeBindDevice");
      if (input.abuseGuardEnabled !== undefined) setColumn("abuse_guard_enabled", input.abuseGuardEnabled ? 1 : 0, "abuseGuardEnabled");
      if (input.codeIpHourlyLimit !== undefined) setColumn("code_ip_hourly_limit", input.codeIpHourlyLimit, "codeIpHourlyLimit");
      if (input.codeIpDailyLimit !== undefined) setColumn("code_ip_daily_limit", input.codeIpDailyLimit, "codeIpDailyLimit");
      if (input.smtpHost !== undefined) setColumn("smtp_host", input.smtpHost, "smtpHost");
      if (input.smtpPort !== undefined) setColumn("smtp_port", input.smtpPort, "smtpPort");
      if (input.smtpSecure !== undefined) setColumn("smtp_secure", input.smtpSecure ? 1 : 0, "smtpSecure");
      if (input.smtpUsername !== undefined) setColumn("smtp_username", input.smtpUsername, "smtpUsername");
      if (input.smtpFromAddress !== undefined) setColumn("smtp_from_address", input.smtpFromAddress, "smtpFromAddress");
      if (input.smtpFromName !== undefined) setColumn("smtp_from_name", input.smtpFromName, "smtpFromName");
      if (input.shareMissingMessage !== undefined) setColumn("share_missing_message", input.shareMissingMessage, "shareMissingMessage");

      if (input.smtpPassword !== undefined) {
        if (input.smtpPassword === null) {
          setColumn("smtp_password_encrypted", null, "smtpPassword");
        } else {
          const masterKey = resolvePrimaryObjectStorageEncryptionKey(context.env);
          if (!masterKey) {
            return apiError(context, "encryption_key_unavailable", "Credentials encryption key is not available.", 500);
          }
          const encrypted = await encryptSecret(input.smtpPassword, masterKey);
          setColumn("smtp_password_encrypted", encrypted, "smtpPassword");
        }
      }

      updates.push("updated_at = ?");
      binds.push(isoNow(), INSTANCE_SETTINGS_ID);

      await database.batch([
        database.prepare(
          `UPDATE instance_settings SET ${updates.join(", ")} WHERE id = ?`,
        ).bind(...binds),
        auditStatement(database, "user", context.get("auth")!.actorId, "instance_settings.update", "instance_settings", INSTANCE_SETTINGS_ID, auditPayload),
      ]);

      const settings = await getInstanceSettingsRow(database);
      return context.json({ settings: mapInstanceSettingsRow(settings) });
    },
  );

  // Invite codes: list / create / revoke.

  app.get("/api/v1/admin/registration/invites", async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const result = await database
      .prepare(
        `SELECT id, code_hint, note, max_uses, use_count, expires_at, revoked_at, created_at
         FROM registration_invites ORDER BY created_at DESC LIMIT 200`,
      )
      .all<{
        id: string;
        code_hint: string;
        note: string | null;
        max_uses: number;
        use_count: number;
        expires_at: string | null;
        revoked_at: string | null;
        created_at: string;
      }>();
    return context.json({
      invites: (result.results ?? []).map((row) => ({
        id: row.id,
        codeHint: row.code_hint,
        note: row.note,
        maxUses: row.max_uses,
        useCount: row.use_count,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      })),
    });
  });

  app.post("/api/v1/admin/registration/invites", zValidator("json", RegistrationInviteCreateSchema), async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const input = context.req.valid("json");
    const database = context.env.storage.db;

    const code = generateInviteCode();
    const codeHash = await sha256(`invite:${code}`);
    const id = createId("inv");
    const now = isoNow();
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const codeHint = `${code.slice(0, 5)}…${code.slice(-4)}`;

    await database.batch([
      database.prepare(
        `INSERT INTO registration_invites (id, code_hash, code_hint, note, max_uses, use_count, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).bind(id, codeHash, codeHint, input.note ?? null, input.maxUses, expiresAt, context.get("auth")!.actorId, now),
      auditStatement(database, "user", context.get("auth")!.actorId, "registration_invite.create", "registration_invite", id, {
        codeHint,
        maxUses: input.maxUses,
        expiresInDays: input.expiresInDays ?? null,
      }),
    ]);

    // The plaintext code is returned exactly once, at creation time.
    return context.json({ invite: { id, code, codeHint, maxUses: input.maxUses, expiresAt } }, 201);
  });

  app.post("/api/v1/admin/registration/invites/:inviteId/revoke", async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const inviteId = context.req.param("inviteId");
    const invite = await database
      .prepare(`SELECT id, revoked_at FROM registration_invites WHERE id = ?`)
      .bind(inviteId)
      .first<{ id: string; revoked_at: string | null }>();
    if (!invite) return notFoundResponse(context);
    if (!invite.revoked_at) {
      await database.batch([
        database.prepare(`UPDATE registration_invites SET revoked_at = ? WHERE id = ?`).bind(isoNow(), inviteId),
        auditStatement(database, "user", context.get("auth")!.actorId, "registration_invite.revoke", "registration_invite", inviteId, {}),
      ]);
    }
    return context.json({ ok: true });
  });

  // Demo mode keeps the whole surface closed.
};


const unauthorizedResponse = (context: AppContext) => unauthorized(context, "Authentication required.");
const notFoundResponse = (context: AppContext) => apiError(context, "not_found", "Invite not found.", 404);
