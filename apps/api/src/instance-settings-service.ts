import { decryptSecret } from "./secret-encryption";
import { resolvePrimaryObjectStorageEncryptionKey } from "./object-storage";
import type { DatabaseAdapter } from "./storage-contract";

export const INSTANCE_SETTINGS_ID = "instance";

export type InstanceSettingsRow = {
  id: string;
  registration_enabled: number;
  registration_code_required: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number;
  smtp_username: string | null;
  smtp_password_encrypted: string | null;
  smtp_from_address: string | null;
  smtp_from_name: string | null;
  share_missing_message: string | null;
  updated_at: string;
};

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
};

export type InstanceRegistrationConfig = {
  enabled: boolean;
  codeRequired: boolean;
};

export const mapInstanceSettingsRow = (row: InstanceSettingsRow) => ({
  registrationEnabled: Boolean(row.registration_enabled),
  registrationCodeRequired: Boolean(row.registration_code_required),
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpSecure: Boolean(row.smtp_secure),
  smtpUsername: row.smtp_username,
  smtpFromAddress: row.smtp_from_address,
  smtpFromName: row.smtp_from_name,
  shareMissingMessage: row.share_missing_message,
});

const SETTINGS_SELECT = `SELECT id, registration_enabled, registration_code_required,
  smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_encrypted,
  smtp_from_address, smtp_from_name, share_missing_message, updated_at
  FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`;

export const getInstanceSettingsRow = async (
  database: DatabaseAdapter,
): Promise<InstanceSettingsRow> => {
  const row = await database.prepare(SETTINGS_SELECT).first<InstanceSettingsRow>();
  if (row) return row;
  return {
    id: INSTANCE_SETTINGS_ID,
    registration_enabled: 0,
    registration_code_required: 0,
    smtp_host: null,
    smtp_port: null,
    smtp_secure: 1,
    smtp_username: null,
    smtp_password_encrypted: null,
    smtp_from_address: null,
    smtp_from_name: null,
    share_missing_message: null,
    updated_at: "",
  };
};

export const isRegistrationEnabled = async (database: DatabaseAdapter) => {
  const row = await database
    .prepare(`SELECT registration_enabled FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ registration_enabled: number }>();
  return Boolean(row?.registration_enabled);
};

export const isRegistrationCodeRequired = async (database: DatabaseAdapter) => {
  const row = await database
    .prepare(`SELECT registration_code_required FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ registration_code_required: number }>();
  return Boolean(row?.registration_code_required);
};

export const getShareMissingMessage = async (database: DatabaseAdapter) => {
  const row = await database
    .prepare(`SELECT share_missing_message FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ share_missing_message: string | null }>();
  return row?.share_missing_message?.trim() || null;
};

// The SMTP password uses the same derived credentials key as object storage
// secrets, so backups of /data keep working after container rebuilds.
export const getSmtpPassword = async (
  environment: Parameters<typeof resolvePrimaryObjectStorageEncryptionKey>[0],
  settings: InstanceSettingsRow,
): Promise<string | null> => {
  if (!settings.smtp_password_encrypted) return null;
  const masterKey = resolvePrimaryObjectStorageEncryptionKey(environment);
  if (!masterKey) return null;
  try {
    return await decryptSecret(settings.smtp_password_encrypted, masterKey);
  } catch {
    return null;
  }
};
