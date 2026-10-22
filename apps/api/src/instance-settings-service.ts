import type { ShareServerConfig, ShareServerEntry } from "@edgeever/shared";
import { decryptSecret } from "./secret-encryption";
import { resolvePrimaryObjectStorageEncryptionKey } from "./object-storage";
import type { DatabaseAdapter } from "./storage-contract";

export const INSTANCE_SETTINGS_ID = "instance";

export type InstanceSettingsRow = {
  id: string;
  registration_enabled: number;
  registration_code_required: number;
  registration_invite_required: number;
  code_ttl_seconds: number;
  code_resend_cooldown_seconds: number;
  code_bind_ip: number;
  code_bind_device: number;
  abuse_guard_enabled: number;
  code_ip_hourly_limit: number;
  code_ip_daily_limit: number;
  email_allowlist_enabled: number;
  email_allowlist: string | null;
  email_blocklist: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number;
  smtp_username: string | null;
  smtp_password_encrypted: string | null;
  smtp_from_address: string | null;
  smtp_from_name: string | null;
  share_missing_message: string | null;
  share_servers: string | null;
  default_share_server_url: string | null;
  editor_shortcuts: string | null;
  app_shortcuts: string | null;
  site_name: string | null;
  site_description: string | null;
  site_icon: string | null;
  site_icon_updated_at: string | null;
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

/** Normalizes a share endpoint and rejects non-HTTP(S) values. */
export const normalizeShareServerUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
};

export const parseShareServerEntries = (value: string | null): ShareServerEntry[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const servers: ShareServerEntry[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as { url?: unknown; label?: unknown };
      const url = normalizeShareServerUrl(candidate.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const label = typeof candidate.label === "string" ? candidate.label.trim().slice(0, 60) : "";
      servers.push({ url, label: label || null });
    }
    return servers;
  } catch {
    return [];
  }
};

export const getShareServerConfig = async (database: DatabaseAdapter): Promise<ShareServerConfig> => {
  const row = await database
    .prepare(
      `SELECT share_servers, default_share_server_url FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`,
    )
    .first<{ share_servers: string | null; default_share_server_url: string | null }>();
  const servers = parseShareServerEntries(row?.share_servers ?? null);
  const configuredDefault = normalizeShareServerUrl(row?.default_share_server_url);
  const defaultUrl = configuredDefault && servers.some((server) => server.url === configuredDefault)
    ? configuredDefault
    : servers[0]?.url ?? null;
  return { servers, defaultUrl };
};

export const mapInstanceSettingsRow = (row: InstanceSettingsRow) => ({
  registrationEnabled: Boolean(row.registration_enabled),
  registrationCodeRequired: Boolean(row.registration_code_required),
  registrationInviteRequired: Boolean(row.registration_invite_required),
  codeTtlSeconds: row.code_ttl_seconds,
  codeResendCooldownSeconds: row.code_resend_cooldown_seconds,
  codeBindIp: Boolean(row.code_bind_ip),
  codeBindDevice: Boolean(row.code_bind_device),
  abuseGuardEnabled: Boolean(row.abuse_guard_enabled),
  codeIpHourlyLimit: row.code_ip_hourly_limit,
  codeIpDailyLimit: row.code_ip_daily_limit,
  emailAllowlistEnabled: Boolean(row.email_allowlist_enabled),
  emailAllowlist: row.email_allowlist,
  emailBlocklist: row.email_blocklist,
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpSecure: Boolean(row.smtp_secure),
  smtpUsername: row.smtp_username,
  smtpFromAddress: row.smtp_from_address,
  smtpFromName: row.smtp_from_name,
  shareMissingMessage: row.share_missing_message,
  shareServers: parseShareServerEntries(row.share_servers),
  defaultShareServerUrl: normalizeShareServerUrl(row.default_share_server_url),
  editorShortcuts: row.editor_shortcuts,
  appShortcuts: row.app_shortcuts,
  siteName: row.site_name,
  siteDescription: row.site_description,
  siteIcon: row.site_icon,
  siteIconUpdatedAt: row.site_icon_updated_at,
});

const SETTINGS_SELECT = `SELECT id, registration_enabled, registration_code_required,
  registration_invite_required, code_ttl_seconds, code_resend_cooldown_seconds,
  code_bind_ip, code_bind_device, abuse_guard_enabled, code_ip_hourly_limit,
  code_ip_daily_limit, email_allowlist_enabled, email_allowlist, email_blocklist,
  smtp_host, smtp_port, smtp_secure, smtp_username,
  smtp_password_encrypted, smtp_from_address, smtp_from_name, share_missing_message,
  share_servers, default_share_server_url, editor_shortcuts, app_shortcuts,
  site_name, site_description, site_icon, site_icon_updated_at, updated_at
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
    registration_invite_required: 0,
    code_ttl_seconds: 60,
    code_resend_cooldown_seconds: 60,
    code_bind_ip: 0,
    code_bind_device: 0,
    abuse_guard_enabled: 1,
    code_ip_hourly_limit: 10,
    code_ip_daily_limit: 30,
    email_allowlist_enabled: 0,
    email_allowlist: null,
    email_blocklist: null,
    smtp_host: null,
    smtp_port: null,
    smtp_secure: 1,
    smtp_username: null,
    smtp_password_encrypted: null,
    smtp_from_address: null,
    smtp_from_name: null,
    share_missing_message: null,
    share_servers: null,
    default_share_server_url: null,
    editor_shortcuts: null,
    app_shortcuts: null,
    site_name: null,
    site_description: null,
    site_icon: null,
    site_icon_updated_at: null,
    updated_at: "",
  };
};

export const getEditorShortcutsDefault = async (database: DatabaseAdapter) => {
  const row = await database
    .prepare(`SELECT editor_shortcuts FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ editor_shortcuts: string | null }>();
  return row?.editor_shortcuts ?? null;
};

export const getAppShortcutsDefault = async (database: DatabaseAdapter) => {
  const row = await database
    .prepare(`SELECT app_shortcuts FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ app_shortcuts: string | null }>();
  return row?.app_shortcuts ?? null;
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

export type PublicSiteBranding = {
  name: string | null;
  description: string | null;
  iconUpdatedAt: string | null;
};

export const getPublicSiteBranding = async (database: DatabaseAdapter): Promise<PublicSiteBranding> => {
  const row = await database
    .prepare(`SELECT site_name, site_description, site_icon_updated_at FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ site_name: string | null; site_description: string | null; site_icon_updated_at: string | null }>();
  return {
    name: row?.site_name?.trim() || null,
    description: row?.site_description?.trim() || null,
    iconUpdatedAt: row?.site_icon_updated_at ?? null,
  };
};

export const getSiteIconDataUrl = async (database: DatabaseAdapter) => {
  const row = await database
    .prepare(`SELECT site_icon FROM instance_settings WHERE id = '${INSTANCE_SETTINGS_ID}'`)
    .first<{ site_icon: string | null }>();
  return row?.site_icon ?? null;
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
