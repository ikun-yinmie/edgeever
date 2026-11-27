import type { z } from "zod";
import { z as validator } from "zod";
import type { FeedbackSubmitSchema } from "@edgeever/shared";
import type { Bindings } from "./api-context";
import { getInstanceSettingsRow, getSmtpPassword, type SmtpConfig } from "./instance-settings-service";
import { sendFeedbackEmail } from "./smtp-client";
import type { DatabaseAdapter } from "./storage-contract";

export const FEEDBACK_WINDOW_MS = 5 * 60 * 60 * 1000;
export const FEEDBACK_SUCCESS_LIMIT = 3;
// SMTP has a 30-second total deadline. Leave ample time for database round trips
// and record the result before another process may recover the account lease.
export const FEEDBACK_LEASE_MS = 2 * 60 * 1000;

type FeedbackInput = z.infer<typeof FeedbackSubmitSchema>;
type FeedbackDetails = { contactEmail?: string | null; retryAfterSeconds?: number };
type FeedbackErrorCode = "feedback_disabled" | "feedback_rate_limited" | "feedback_busy" | "email_delivery_failed";
export class FeedbackError extends Error {
  constructor(
    readonly code: FeedbackErrorCode,
    message: string,
    readonly status: number,
    readonly details: FeedbackDetails,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

export type FeedbackDependencies = {
  send?: typeof sendFeedbackEmail;
  now?: () => number;
};

type FeedbackConfiguration = {
  contactEmail: string | null;
  recipient: string | null;
  smtp: SmtpConfig | null;
};

const emailSchema = validator.string().email();
const normalizeEmail = (value: string | null | undefined) => {
  const email = value?.trim();
  return email && emailSchema.safeParse(email).success ? email : null;
};

const getConfiguration = async (environment: Bindings): Promise<FeedbackConfiguration> => {
  const settings = await getInstanceSettingsRow(environment.storage.db);
  const contactEmail = normalizeEmail(settings.contact_email);
  const recipient = normalizeEmail(settings.feedback_recipient_email);
  const disabled = { contactEmail, recipient, smtp: null };
  if (!settings.feedback_enabled || !recipient) return disabled;

  const host = settings.smtp_host?.trim();
  const fromAddress = normalizeEmail(settings.smtp_from_address);
  const port = settings.smtp_port ?? 587;
  if (!host || /[\s\x00-\x1f\x7f]/.test(host) || !fromAddress ||
      !Number.isInteger(port) || port < 1 || port > 65535) return disabled;

  const username = settings.smtp_username?.trim() || null;
  if (username && /[\r\n\x00]/.test(username)) return disabled;
  // No username means an unauthenticated relay; ignore any leftover secret.
  const password = username ? await getSmtpPassword(environment, settings) : null;
  if (username && !password) return disabled;
  const fromName = settings.smtp_from_name?.trim() || null;
  if (fromName && /[\r\n\x00]/.test(fromName)) return disabled;
  return {
    contactEmail,
    recipient,
    smtp: { host, port, secure: Boolean(settings.smtp_secure), username, password, fromAddress, fromName },
  };
};

export const getPublicFeedback = async (environment: Bindings) => {
  const configuration = await getConfiguration(environment);
  return { enabled: configuration.smtp !== null, contactEmail: configuration.contactEmail };
};

const findSuccess = (database: DatabaseAdapter, accountId: string, requestId: string) =>
  database.prepare(`SELECT succeeded_at FROM feedback_requests
    WHERE account_id = ? AND request_id = ? AND succeeded_at IS NOT NULL`)
    .bind(accountId, requestId).first<{ succeeded_at: number }>();

const retrySeconds = (deadline: number, now: number) => Math.max(1, Math.ceil((deadline - now) / 1000));

export const submitFeedback = async (
  environment: Bindings,
  accountId: string,
  input: FeedbackInput,
  dependencies: FeedbackDependencies = {},
): Promise<void> => {
  const database = environment.storage.db;
  // A completed operation remains idempotent even if an administrator later
  // disables feedback or removes the delivery configuration.
  if (await findSuccess(database, accountId, input.requestId)) return;
  const configuration = await getConfiguration(environment);
  const details = { contactEmail: configuration.contactEmail };
  if (!configuration.smtp || !configuration.recipient) {
    throw new FeedbackError("feedback_disabled", "Feedback delivery is not configured or is disabled.", 403, details);
  }

  const now = dependencies.now ?? Date.now;
  const token = crypto.randomUUID();
  const acquiredAt = now();
  const lease = await database.prepare(`INSERT INTO feedback_account_leases (account_id, token, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE feedback_account_leases.expires_at <= ?
    RETURNING token`)
    .bind(accountId, token, acquiredAt + FEEDBACK_LEASE_MS, acquiredAt).first<{ token: string }>();
  if (!lease) {
    // The winner may have finished between our initial lookup and acquisition.
    if (await findSuccess(database, accountId, input.requestId)) return;
    const active = await database.prepare("SELECT expires_at FROM feedback_account_leases WHERE account_id = ?")
      .bind(accountId).first<{ expires_at: number }>();
    throw new FeedbackError("feedback_busy", "Another feedback request is being processed. Please retry later.", 409,
      { ...details, retryAfterSeconds: retrySeconds(active?.expires_at ?? now() + 1000, now()) });
  }

  let deliveryAccepted = false;
  let successRecorded = false;
  try {
    if (await findSuccess(database, accountId, input.requestId)) return;
    const quotaNow = now();
    const quota = await database.prepare(`SELECT COUNT(*) AS count, MIN(succeeded_at) AS oldest
      FROM feedback_requests WHERE account_id = ? AND succeeded_at > ?`)
      .bind(accountId, quotaNow - FEEDBACK_WINDOW_MS).first<{ count: number; oldest: number | null }>();
    if (quota && quota.count >= FEEDBACK_SUCCESS_LIMIT) {
      throw new FeedbackError("feedback_rate_limited", "Only three successful feedback submissions are allowed in five hours.", 429,
        { ...details, retryAfterSeconds: retrySeconds((quota.oldest ?? quotaNow) + FEEDBACK_WINDOW_MS, quotaNow) });
    }

    await database.prepare(`INSERT INTO feedback_requests (account_id, request_id, token, created_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM feedback_account_leases WHERE account_id = ? AND token = ? AND expires_at > ?
      )
      ON CONFLICT(account_id, request_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at
      WHERE feedback_requests.succeeded_at IS NULL`)
      .bind(accountId, input.requestId, token, quotaNow, accountId, token, quotaNow).run();

    const beforeSend = now();
    // This is a single atomic preflight: a delayed/stale owner cannot start
    // SMTP after lease takeover, nor send against a quota changed meanwhile.
    const confirmed = await database.prepare(`UPDATE feedback_account_leases SET expires_at = ?
      WHERE account_id = ? AND token = ? AND expires_at > ?
      AND (SELECT COUNT(*) FROM feedback_requests WHERE account_id = ? AND succeeded_at > ?) < ?
      AND EXISTS (SELECT 1 FROM feedback_requests WHERE account_id = ? AND request_id = ? AND token = ? AND succeeded_at IS NULL)
      RETURNING token`)
      .bind(beforeSend + FEEDBACK_LEASE_MS, accountId, token, beforeSend,
        accountId, beforeSend - FEEDBACK_WINDOW_MS, FEEDBACK_SUCCESS_LIMIT, accountId, input.requestId, token)
      .first<{ token: string }>();
    if (!confirmed) {
      throw new FeedbackError("feedback_busy", "Feedback reservation expired. Please retry later.", 409,
        { ...details, retryAfterSeconds: 1 });
    }

    try {
      await (dependencies.send ?? sendFeedbackEmail)(configuration.smtp, configuration.recipient, {
        content: input.content,
        replyTo: input.replyTo,
        systemInfo: input.systemInfo,
      });
    } catch {
      throw new FeedbackError("email_delivery_failed", "Feedback email could not be delivered. Please try again later.", 502, details);
    }
    deliveryAccepted = true;
    const succeededAt = now();
    // SMTP DATA acceptance and SQL cannot form one atomic transaction. Retry
    // transient bookkeeping failures; never turn accepted mail into an error.
    // A process crash here (or persistent SQL outage) can cause duplicate mail
    // on a retry after lease expiry. This is deliberately not exactly-once.
    for (let attempt = 0; attempt < 3 && !successRecorded; attempt += 1) {
      try {
        const recorded = await database.prepare(`UPDATE feedback_requests SET succeeded_at = ?
          WHERE account_id = ? AND request_id = ? AND token = ? RETURNING succeeded_at`)
          .bind(succeededAt, accountId, input.requestId, token).first<{ succeeded_at: number }>();
        successRecorded = recorded !== null;
      } catch {
        // Retain the lease if all retries fail, to delay ambiguous redelivery.
      }
    }
    if (!successRecorded) console.error("Feedback accepted by SMTP, but success bookkeeping could not be persisted.");
  } finally {
    // Cleanup failure must neither mask the delivery error nor reverse success.
    if (!deliveryAccepted) {
      try {
        await database.prepare(`DELETE FROM feedback_requests
          WHERE account_id = ? AND request_id = ? AND token = ? AND succeeded_at IS NULL`)
          .bind(accountId, input.requestId, token).run();
      } catch {
        console.error("Feedback pending-request cleanup failed; expired reservations can be recovered.");
      }
    }
    if (!deliveryAccepted || successRecorded) {
      try {
        await database.prepare("DELETE FROM feedback_account_leases WHERE account_id = ? AND token = ?")
          .bind(accountId, token).run();
      } catch {
        console.error("Feedback lease cleanup failed; the lease will expire automatically.");
      }
    }
  }
};
