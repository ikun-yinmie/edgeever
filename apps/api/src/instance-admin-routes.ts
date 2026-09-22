import {
  InstanceAdminSettingsUpdateSchema,
  RegistrationEmailCodeRequestSchema,
  RegisterSchema,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { audit, auditStatement } from "./audit";
import type { AppContext, AppEnv, AuthContext } from "./api-context";
import { hashPassword } from "./auth-crypto";
import { isDemoModeEnabled } from "./demo-mode";
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
import { sendRegistrationCodeEmail } from "./smtp-client";
import { sha256 } from "./hash-utils";
import { createDefaultNotebookRows, createWorkspaceDefaultSeedStatements } from "./workspace-provisioning";
import type { DatabaseAdapter } from "./storage-contract";

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_REQUEST_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_VERIFY_ATTEMPTS = 6;
const CODE_MAX_PENDING_PER_EMAIL = 3;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const generateVerificationCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

type RegistrationRouteDependencies = {
  authenticateRequest: (context: AppContext, touch: boolean) => Promise<AuthContext | null>;
};

export const registerInstanceAdminRoutes = (
  app: Hono<AppEnv>,
  dependencies: RegistrationRouteDependencies,
) => {
  // --- Public endpoints (no auth): registration & email codes ---

  app.get("/api/v1/public/registration", async (context) => {
    const database = context.env.storage.db;
    const [enabled, codeRequired] = await Promise.all([
      isRegistrationEnabled(database),
      isRegistrationCodeRequired(database),
    ]);
    return context.json({
      registration: {
        enabled,
        codeRequired,
      },
    });
  });

  app.post(
    "/api/v1/public/registration/code",
    zValidator("json", RegistrationEmailCodeRequestSchema),
    async (context) => {
      const database = context.env.storage.db;
      if (!(await isRegistrationEnabled(database))) {
        return forbidden(context, "Registration is disabled on this instance.");
      }

      const { email } = context.req.valid("json");
      const settings = await getInstanceSettingsRow(database);
      const smtpPassword = await getSmtpPassword(context.env, settings);
      if (!settings.smtp_host || !settings.smtp_from_address || !smtpPassword) {
        return apiError(context, "smtp_not_configured", "Email delivery is not configured by the administrator.", 400);
      }

      if (!EMAIL_PATTERN.test(email)) {
        return apiError(context, "invalid_email", "A valid email address is required.", 400);
      }

      const now = Date.now();
      const recent = await database
        .prepare(`SELECT created_at FROM email_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 4`)
        .bind(email)
        .all<{ created_at: string }>();
      const pending = recent.results ?? [];
      if (pending.length >= CODE_MAX_PENDING_PER_EMAIL) {
        return tooManyRequests(context, "Too many pending codes for this email. Wait for them to expire.");
      }
      if (pending[0] && now - Date.parse(pending[0].created_at) < CODE_REQUEST_COOLDOWN_MS) {
        return tooManyRequests(context, "Please wait a moment before requesting another code.");
      }


      const code = generateVerificationCode();
      const codeHash = await sha256(`${email}:${code}`);
      const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
      const nowIso = isoNow();

      await database.batch([
        database.prepare(`DELETE FROM email_verifications WHERE email = ?`).bind(email),
        database.prepare(
          `INSERT INTO email_verifications (id, email, code_hash, attempts, expires_at, created_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        ).bind(createId("evc"), email, codeHash, expiresAt, nowIso),
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

      return context.json({ ok: true, expiresInMinutes: CODE_TTL_MS / 60000 });
    },
  );

  app.post("/api/v1/public/registration/register", zValidator("json", RegisterSchema), async (context) => {
    const database = context.env.storage.db;
    if (!(await isRegistrationEnabled(database))) {
      return forbidden(context, "Registration is disabled on this instance.");
    }

    const input = context.req.valid("json");
    const codeRequired = await isRegistrationCodeRequired(database);

    if (codeRequired) {
      const record = await database
        .prepare(`SELECT id, code_hash, attempts, expires_at FROM email_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(input.email)
        .first<{ id: string; code_hash: string; attempts: number; expires_at: string }>();
      if (!record) {
        return apiError(context, "email_code_invalid", "Request a verification code first.", 400);
      }
      if (record.attempts >= CODE_MAX_VERIFY_ATTEMPTS) {
        return apiError(context, "email_code_invalid", "Too many incorrect code attempts. Request a new code.", 400);
      }
      if (Date.parse(record.expires_at) < Date.now()) {
        return apiError(context, "email_code_expired", "The verification code has expired. Request a new one.", 400);
      }
      const candidateHash = await sha256(`${input.email}:${input.emailCode}`);
      if (candidateHash !== record.code_hash) {
        await database
          .prepare(`UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?`)
          .bind(record.id)
          .run();
        return apiError(context, "email_code_invalid", "Incorrect verification code.", 400);
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
      auditStatement(database, "user", userId, "user.register", "user", userId, {
        username,
        email: input.email,
      }),
    ];
    await database.batch(statements);

    return context.json({ ok: true }, 201);
  });

  // --- Owner-only admin console endpoints ---

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
      const current = await getInstanceSettingsRow(database);
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
};

const unauthorizedResponse = (context: AppContext) => unauthorized(context, "Authentication required.");
