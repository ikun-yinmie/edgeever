import {
  InstanceAdminSettingsUpdateSchema,
  RegistrationEmailCodeRequestSchema,
  RegistrationInviteCreateSchema,
  RegistrationInviteDeleteSchema,
  RegisterSchema,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { audit, auditStatement } from "./audit";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { hashPassword } from "./auth-crypto";
import { evaluateEmailPolicy, parseEmailPolicyEntries } from "./email-policy";
import { createId, isoNow } from "./entity-utils";
import { apiError, badRequest, conflict, forbidden, tooManyRequests, unauthorized } from "./http-errors";
import { INSTANCE_SETTINGS_ID } from "./instance-settings-service";
import { resolvePrimaryObjectStorageEncryptionKey } from "./object-storage";
import { decryptSecret, encryptSecret } from "./secret-encryption";
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
  code_hint: string;
  code_encrypted: string | null;
  note: string | null;
  max_uses: number;
  use_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  source: string;
  owner_user_id: string | null;
  used_by_user_id: string | null;
  used_at: string | null;
  created_at: string;
};

type InviteQueryRow = InviteRow & {
  owner_username: string | null;
  owner_display_name: string | null;
  used_username: string | null;
  used_display_name: string | null;
};

type InviteOwner = { id: string; username: string | null; displayName: string | null };

const INVITE_SELECT = `SELECT i.id, i.code_hash, i.code_hint, i.code_encrypted, i.note, i.max_uses,
  i.use_count, i.expires_at, i.revoked_at, i.source, i.owner_user_id, i.used_by_user_id,
  i.used_at, i.created_at,
  owner.username AS owner_username, owner.display_name AS owner_display_name,
  used.username AS used_username, used.display_name AS used_display_name
  FROM registration_invites i
  LEFT JOIN users owner ON owner.id = i.owner_user_id
  LEFT JOIN users used ON used.id = i.used_by_user_id`;

type InviteEnvironment = AppEnv["Bindings"];

// Invite codes are stored encrypted so they can be copied again at any time.
// Rows created before migration 0057 only hold a hash and stay unreadable.
const readInviteCode = async (row: Pick<InviteRow, "code_encrypted">, environment: InviteEnvironment) => {
  if (!row.code_encrypted) return null;
  const masterKey = resolvePrimaryObjectStorageEncryptionKey(environment);
  if (!masterKey) return null;
  try {
    return await decryptSecret(row.code_encrypted, masterKey);
  } catch {
    return null;
  }
};

const mapInviteRow = async (row: InviteQueryRow, environment: InviteEnvironment) => {
  const owner: InviteOwner | null = row.owner_user_id
    ? { id: row.owner_user_id, username: row.owner_username, displayName: row.owner_display_name }
    : null;
  const usedBy: InviteOwner | null = row.used_by_user_id
    ? { id: row.used_by_user_id, username: row.used_username, displayName: row.used_display_name }
    : null;
  return {
    id: row.id,
    code: await readInviteCode(row, environment),
    codeHint: row.code_hint,
    note: row.note,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    source: row.source === "user" ? "user" : "admin",
    owner,
    usedBy,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
};

const generateInviteSecret = async (
  environment: InviteEnvironment,
  options: { maxUses: number; expiresInDays?: number | null; note?: string | null; source: "admin" | "user"; ownerUserId: string | null; createdBy: string | null },
) => {
  const masterKey = resolvePrimaryObjectStorageEncryptionKey(environment);
  if (!masterKey) return null;
  const code = generateInviteCode();
  return {
    id: createId("inv"),
    code,
    codeHash: await sha256(`invite:${code}`),
    codeEncrypted: await encryptSecret(code, masterKey),
    codeHint: `${code.slice(0, 5)}…${code.slice(-4)}`,
    note: options.note ?? null,
    maxUses: options.maxUses,
    source: options.source,
    ownerUserId: options.ownerUserId,
    createdBy: options.createdBy,
    expiresAt: options.expiresInDays
      ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null,
  };
};

const insertInviteStatement = (
  database: DatabaseAdapter,
  secret: NonNullable<Awaited<ReturnType<typeof generateInviteSecret>>>,
  createdAt: string,
) =>
  database
    .prepare(
      `INSERT INTO registration_invites
         (id, code_hash, code_hint, code_encrypted, note, max_uses, use_count, expires_at,
          source, owner_user_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .bind(
      secret.id,
      secret.codeHash,
      secret.codeHint,
      secret.codeEncrypted,
      secret.note,
      secret.maxUses,
      secret.expiresAt,
      secret.source,
      secret.ownerUserId,
      secret.createdBy,
      createdAt,
    );

const findUsableInvite = async (database: DatabaseAdapter, code: string): Promise<InviteRow | null> => {
  const normalized = code.trim().toUpperCase();
  const codeHash = await sha256(`invite:${normalized}`);
  const invite = await database
    .prepare(`SELECT id, code_hash, use_count, max_uses, expires_at, revoked_at FROM registration_invites WHERE code_hash = ?`)
    .bind(codeHash)
    .first<InviteRow>();
  if (!invite) return null;
  if (invite.revoked_at) return null;
  if (invite.expires_at && Date.parse(invite.expires_at) < Date.now()) return null;
  if (invite.use_count >= invite.max_uses) return null;
  return invite;
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

      // Email policy runs before delivery so unwanted domains never consume an email.
      const verdict = evaluateEmailPolicy({
        email,
        allowlistEnabled: Boolean(settings.email_allowlist_enabled),
        allowlist: settings.email_allowlist,
        blocklist: settings.email_blocklist,
      });
      if (verdict === "blocked") {
        return apiError(context, "email_domain_blocked", "This email domain is not allowed to register.", 403);
      }
      if (verdict === "not-allowlisted") {
        return apiError(context, "email_domain_not_allowed", "This email is not on the registration allowlist.", 403);
      }

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

    const verdict = evaluateEmailPolicy({
      email: input.email,
      allowlistEnabled: Boolean(settings.email_allowlist_enabled),
      allowlist: settings.email_allowlist,
      blocklist: settings.email_blocklist,
    });
    if (verdict === "blocked") {
      return apiError(context, "email_domain_blocked", "This email domain is not allowed to register.", 403);
    }
    if (verdict === "not-allowlisted") {
      return apiError(context, "email_domain_not_allowed", "This email is not on the registration allowlist.", 403);
    }

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
    const userId = createId("usr");
    const now = isoNow();
    const inviteStatements: PreparedStatementAdapter[] = [];
    if (settings.registration_invite_required) {
      if (!input.inviteCode) {
        return apiError(context, "invite_required", "An invite code is required to register.", 403);
      }
      const invite = await findUsableInvite(database, input.inviteCode);
      if (!invite) {
        return apiError(context, "invite_invalid", "This invite code is invalid, used up or expired.", 403);
      }
      inviteStatements.push(
        database
          .prepare(
            `UPDATE registration_invites SET use_count = use_count + 1, used_by_user_id = ?, used_at = ?
             WHERE id = ? AND use_count < max_uses`,
          )
          .bind(userId, now, invite.id),
      );
    }

    const username = input.username.toLowerCase();
    const existingUser = await database
      .prepare(`SELECT id FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)`)
      .bind(username, input.email)
      .first();
    if (existingUser) {
      return conflict(context, "username_or_email_exists", "Username or email already registered.");
    }

    const workspaceId = createId("ws");
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
      if (input.emailAllowlistEnabled !== undefined) setColumn("email_allowlist_enabled", input.emailAllowlistEnabled ? 1 : 0, "emailAllowlistEnabled");
      if (input.emailAllowlist !== undefined) {
        const entries = parseEmailPolicyEntries(input.emailAllowlist);
        setColumn("email_allowlist", entries.length > 0 ? entries.join("\n") : null, "emailAllowlist");
      }
      if (input.emailBlocklist !== undefined) {
        const entries = parseEmailPolicyEntries(input.emailBlocklist);
        setColumn("email_blocklist", entries.length > 0 ? entries.join("\n") : null, "emailBlocklist");
      }
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

  // Invite codes: list / create / revoke / restore / delete.

  const MAX_LISTED_INVITES = 500;

  app.get("/api/v1/admin/registration/invites", async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const result = await database
      .prepare(`${INVITE_SELECT} ORDER BY i.created_at DESC LIMIT ${MAX_LISTED_INVITES}`)
      .all<InviteQueryRow>();
    const invites = await Promise.all(
      (result.results ?? []).map((row) => mapInviteRow(row, context.env)),
    );
    return context.json({ invites });
  });

  app.post("/api/v1/admin/registration/invites", zValidator("json", RegistrationInviteCreateSchema), async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const input = context.req.valid("json");
    const database = context.env.storage.db;
    const actorId = context.get("auth")!.actorId;

    const secret = await generateInviteSecret(context.env, {
      maxUses: input.maxUses,
      expiresInDays: input.expiresInDays ?? null,
      note: input.note ?? null,
      source: "admin",
      ownerUserId: null,
      createdBy: actorId,
    });
    if (!secret) {
      return apiError(context, "encryption_key_unavailable", "Credentials encryption key is not available.", 500);
    }

    await database.batch([
      insertInviteStatement(database, secret, isoNow()),
      auditStatement(database, "user", actorId, "registration_invite.create", "registration_invite", secret.id, {
        codeHint: secret.codeHint,
        maxUses: secret.maxUses,
        expiresInDays: input.expiresInDays ?? null,
      }),
    ]);

    return context.json(
      {
        invite: {
          id: secret.id,
          code: secret.code,
          codeHint: secret.codeHint,
          maxUses: secret.maxUses,
          expiresAt: secret.expiresAt,
        },
      },
      201,
    );
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

  // Parking an invite in the revoked list keeps it copyable and recoverable.
  app.post("/api/v1/admin/registration/invites/:inviteId/restore", async (context) => {
    const denied = await requireOwnerRequest(context);
    if (denied) return denied;
    const database = context.env.storage.db;
    const inviteId = context.req.param("inviteId");
    const invite = await database
      .prepare(`SELECT id, revoked_at FROM registration_invites WHERE id = ?`)
      .bind(inviteId)
      .first<{ id: string; revoked_at: string | null }>();
    if (!invite) return notFoundResponse(context);
    if (invite.revoked_at) {
      await database.batch([
        database.prepare(`UPDATE registration_invites SET revoked_at = NULL WHERE id = ?`).bind(inviteId),
        auditStatement(database, "user", context.get("auth")!.actorId, "registration_invite.restore", "registration_invite", inviteId, {}),
      ]);
    }
    return context.json({ ok: true });
  });

  app.post(
    "/api/v1/admin/registration/invites/delete",
    zValidator("json", RegistrationInviteDeleteSchema),
    async (context) => {
      const denied = await requireOwnerRequest(context);
      if (denied) return denied;
      const database = context.env.storage.db;
      const actorId = context.get("auth")!.actorId;
      const { ids } = context.req.valid("json");
      const placeholders = ids.map(() => "?").join(", ");
      await database.batch([
        database
          .prepare(`DELETE FROM registration_invites WHERE id IN (${placeholders})`)
          .bind(...ids),
        auditStatement(database, "user", actorId, "registration_invite.delete", "registration_invite", ids.join(","), {
          count: ids.length,
        }),
      ]);
      return context.json({ ok: true, deleted: ids.length });
    },
  );

  // --- Member self-service: everyone may hold one single-use invite code ---

  const requireMemberRequest = async (context: AppContext) => {
    const auth = await dependencies.authenticateRequest(context, true);
    if (!auth) return unauthorizedResponse(context);
    context.set("auth", auth);
    return null;
  };

  const loadOwnInvite = async (database: DatabaseAdapter, userId: string) =>
    database
      .prepare(`${INVITE_SELECT} WHERE i.owner_user_id = ? AND i.source = 'user' ORDER BY i.created_at DESC LIMIT 1`)
      .bind(userId)
      .first<InviteQueryRow>();

  app.get("/api/v1/me/invite-code", async (context) => {
    const denied = await requireMemberRequest(context);
    if (denied) return denied;
    const userId = context.get("auth")!.actorId;
    if (!userId) return unauthorizedResponse(context);
    const invite = await loadOwnInvite(context.env.storage.db, userId);
    return context.json({
      invite: invite ? await mapInviteRow(invite, context.env) : null,
      canCreate: !invite,
    });
  });

  app.post("/api/v1/me/invite-code", async (context) => {
    const denied = await requireMemberRequest(context);
    if (denied) return denied;
    const auth = context.get("auth")!;
    const userId = auth.actorId;
    if (!userId) return unauthorizedResponse(context);
    const database = context.env.storage.db;

    const existing = await loadOwnInvite(database, userId);
    if (existing) {
      // Still unused: hand the same code back so the member can copy it again.
      if (!existing.revoked_at && existing.use_count < existing.max_uses) {
        return context.json({ invite: await mapInviteRow(existing, context.env), canCreate: false });
      }
      // Single use is locked in: a consumed code is never replaced silently.
      return conflict(context, "invite_already_used", "Your invite code has already been used. Ask an administrator to reset it.");
    }

    const secret = await generateInviteSecret(context.env, {
      maxUses: 1,
      expiresInDays: null,
      note: null,
      source: "user",
      ownerUserId: userId,
      createdBy: userId,
    });
    if (!secret) {
      return apiError(context, "encryption_key_unavailable", "Credentials encryption key is not available.", 500);
    }

    const now = isoNow();
    await database.batch([
      insertInviteStatement(database, secret, now),
      auditStatement(database, "user", userId, "registration_invite.self_create", "registration_invite", secret.id, {
        codeHint: secret.codeHint,
      }),
    ]);

    return context.json(
      {
        invite: {
          id: secret.id,
          code: secret.code,
          codeHint: secret.codeHint,
          note: null,
          maxUses: 1,
          useCount: 0,
          expiresAt: null,
          revokedAt: null,
          source: "user",
          owner: { id: userId, username: auth.username, displayName: auth.displayName },
          usedBy: null,
          usedAt: null,
          createdAt: now,
        },
        canCreate: false,
      },
      201,
    );
  });
};



const unauthorizedResponse = (context: AppContext) => unauthorized(context, "Authentication required.");
const notFoundResponse = (context: AppContext) => apiError(context, "not_found", "Invite not found.", 404);
