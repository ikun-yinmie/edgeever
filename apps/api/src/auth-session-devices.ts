import type { LoginDeviceSession, SessionClientKind } from "@edgeever/shared";

export type LoginDeviceSessionRow = {
  id: string;
  device_id: string | null;
  user_agent: string | null;
  client_kind?: string | null;
  device_label: string | null;
  ip_address: string | null;
  ip_country: string | null;
  ip_region: string | null;
  expires_at: string;
  created_at: string;
  last_seen_at: string | null;
};

export type SessionClientKindRow = {
  id: string;
  device_id?: string | null;
  client_kind?: string | null;
  user_agent: string | null;
  ip_address: string | null;
};

/**
 * A personal account is limited to one login per terminal, and that terminal is
 * pinned to the IP it signed in from. Native apps report the kind explicitly
 * (the desktop shell and the mobile app do not share a browser user agent
 * shape); anything older is classified from its user agent.
 */
export const isSessionClientKind = (value: unknown): value is SessionClientKind =>
  value === "desktop" || value === "web" || value === "mobile";

export const classifySessionUserAgent = (userAgent: string | null): SessionClientKind => {
  const ua = userAgent ?? "";
  if (!ua.trim()) return "web";
  // Apple's native networking stack reports "CFNetwork/Darwin" instead of a
  // mobile browser token, so an iOS app would otherwise look like Electron.
  if (/iPhone|iPad|iPod|Android|Mobile|IEMobile|Opera Mini|okhttp|CFNetwork|Darwin/i.test(ua)) return "mobile";
  // Electron appends "<productName>/<version>" to the Chromium user agent.
  if (/EdgeEver/i.test(ua)) return "desktop";
  return "web";
};

export const resolveSessionClientKind = (
  requestedClientKind: unknown,
  userAgent: string | null,
): SessionClientKind => (isSessionClientKind(requestedClientKind)
  ? requestedClientKind
  : classifySessionUserAgent(userAgent));

export const sessionClientKind = (row: Pick<SessionClientKindRow, "client_kind" | "user_agent">) =>
  isSessionClientKind(row.client_kind) ? row.client_kind : classifySessionUserAgent(row.user_agent);

export const resolveSessionDeviceId = (
  requestedDeviceId: string | undefined,
  userAgent: string | null,
  sessionId: string,
) => requestedDeviceId ?? (userAgent?.trim() ? `legacy-ua:${userAgent}` : `legacy-session:${sessionId}`);

export const groupLoginDeviceSessions = (
  rows: LoginDeviceSessionRow[],
  currentSessionId: string,
): LoginDeviceSession[] => {
  const grouped = new Map<
    string,
    { representative: LoginDeviceSessionRow; createdAt: string; lastSeenAt: string }
  >();

  for (const row of rows) {
    const key = row.device_id ?? `session:${row.id}`;
    const lastSeenAt = row.last_seen_at ?? row.created_at;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, { representative: row, createdAt: row.created_at, lastSeenAt });
      continue;
    }

    if (row.created_at < existing.createdAt) existing.createdAt = row.created_at;
    if (lastSeenAt > existing.lastSeenAt) existing.lastSeenAt = lastSeenAt;
    if (row.id === currentSessionId) existing.representative = row;
  }

  return [...grouped.values()].map(({ representative, createdAt, lastSeenAt }) => ({
    id: representative.id,
    userAgent: representative.user_agent,
    clientKind: sessionClientKind(representative),
    label: representative.device_label,
    ipAddress: representative.ip_address,
    ipCountry: representative.ip_country,
    ipRegion: representative.ip_region,
    isCurrent: representative.id === currentSessionId,
    createdAt,
    lastSeenAt,
    expiresAt: representative.expires_at,
  }));
};
