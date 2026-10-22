import { useQuery } from "@tanstack/react-query";
import type { ShareServerConfig, ShareServerEntry } from "@edgeever/shared";
import { api, getConfiguredDesktopApiBaseUrl } from "./api";

export const SHARE_SERVERS_QUERY_KEY = ["share-servers"] as const;

export const useShareServerConfig = (enabled = true) =>
  useQuery<ShareServerConfig>({
    queryKey: SHARE_SERVERS_QUERY_KEY,
    queryFn: api.listShareServers,
    enabled,
    staleTime: 60_000,
  });

export const resolveDefaultShareServerUrl = (config: ShareServerConfig | undefined) =>
  config?.defaultUrl || config?.servers[0]?.url || "";

export const resolveFallbackShareBaseUrl = () => {
  if (typeof window === "undefined") return "";
  return getConfiguredDesktopApiBaseUrl() || window.location.origin;
};

export const buildPublicShareUrl = (token: string, baseUrl?: string | null) => {
  const resolvedBase = (baseUrl ?? "").trim() || resolveFallbackShareBaseUrl();
  return `${resolvedBase.replace(/\/+$/, "")}/share/${encodeURIComponent(token)}`;
};

export const findShareServer = (
  servers: ShareServerEntry[] | undefined,
  url: string | null | undefined,
) => servers?.find((server) => server.url === url) ?? null;
