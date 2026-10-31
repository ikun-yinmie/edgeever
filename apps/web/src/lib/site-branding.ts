import { useSyncExternalStore } from "react";
import type { SiteBranding } from "@/lib/api";
import { api, getSiteIconUrl } from "@/lib/api";
import { withEnvironmentTitlePrefix } from "@/lib/environment-title";

export const DEFAULT_SITE_NAME = "EdgeEver";
const DEFAULT_ICON_HREF = "/favicon.svg";
const DEFAULT_APPLE_ICON_HREF = "/apple-touch-icon.png";

const titleOptions = {
  development: Boolean(import.meta.env?.DEV),
  profile: typeof __EDGEEVER_DEVELOPMENT_PROFILE__ !== "undefined" ? __EDGEEVER_DEVELOPMENT_PROFILE__ : "",
};

let branding: SiteBranding = { name: null, description: null, iconUpdatedAt: null };
let clientOverrideName: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getSiteBranding = () => branding;

export const useSiteBranding = () => useSyncExternalStore(subscribe, getSiteBranding);

export const setClientOverrideName = (name: string | null) => {
  const previousName = getSiteDisplayName();
  clientOverrideName = name?.trim() || null;
  applyDocumentTitle(previousName, getSiteDisplayName());
  listeners.forEach((listener) => listener());
};

export const getSiteDisplayName = (value: SiteBranding = branding) =>
  clientOverrideName || value.name?.trim() || DEFAULT_SITE_NAME;

// Only swap the brand name while the tab still shows the default title, so
// page-specific titles (for example the public share page) stay intact.
const applyDocumentTitle = (previousName: string, nextName: string) => {
  if (previousName === nextName) return;
  if (typeof document === "undefined") return;
  if (document.title === withEnvironmentTitlePrefix(previousName, titleOptions)) {
    document.title = withEnvironmentTitlePrefix(nextName, titleOptions);
  }
};

const syncBrandingToDesktop = async (site: SiteBranding) => {
  const desktop = window.edgeeverDesktop;
  if (!desktop?.syncServerBranding) return;

  let iconDataUrl: string | null = null;
  if (site.iconUpdatedAt) {
    try {
      const iconUrl = getSiteIconUrl(site.iconUpdatedAt);
      const res = await fetch(iconUrl);
      if (res.ok) {
        const blob = await res.blob();
        iconDataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = () => resolve("");
          reader.readAsDataURL(blob);
        });
      }
    } catch {
      // ignore
    }
  }

  try {
    await desktop.syncServerBranding({
      name: site.name ?? null,
      icon: iconDataUrl || null,
    });
  } catch {
    // ignore
  }
};

const applyIconLinks = () => {
  const iconHref = branding.iconUpdatedAt ? getSiteIconUrl(branding.iconUpdatedAt) : null;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) {
    if (icon.dataset.defaultType === undefined) {
      icon.dataset.defaultType = icon.getAttribute("type") ?? "";
    }
    if (iconHref) {
      icon.href = iconHref;
      icon.removeAttribute("type");
    } else {
      icon.href = DEFAULT_ICON_HREF;
      if (icon.dataset.defaultType) icon.setAttribute("type", icon.dataset.defaultType);
    }
  }
  const appleIcon = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (appleIcon) {
    appleIcon.href = iconHref ?? DEFAULT_APPLE_ICON_HREF;
  }
};

const applyMetaDescription = () => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!meta) return;
  if (meta.dataset.defaultContent === undefined) {
    meta.dataset.defaultContent = meta.getAttribute("content") ?? "";
  }
  meta.setAttribute("content", branding.description?.trim() || meta.dataset.defaultContent);
};

export const applySiteBranding = (next: SiteBranding) => {
  const previousName = getSiteDisplayName(branding);
  branding = {
    name: next.name?.trim() || null,
    description: next.description?.trim() || null,
    iconUpdatedAt: next.iconUpdatedAt,
  };
  applyDocumentTitle(previousName, getSiteDisplayName(branding));
  applyIconLinks();
  applyMetaDescription();
  void syncBrandingToDesktop(branding);
  listeners.forEach((listener) => listener());
};

export const initDesktopBranding = async () => {
  const desktop = window.edgeeverDesktop;
  if (!desktop?.getClientBranding) return;
  try {
    const info = await desktop.getClientBranding();
    if (info?.customName) {
      setClientOverrideName(info.customName);
    }
  } catch {
    // ignore
  }
};

export const refreshSiteBranding = async () => {
  void initDesktopBranding();
  try {
    const response = await api.getSiteBranding();
    applySiteBranding(response.site);
  } catch {
    // Keep the built-in branding when the instance is unreachable.
  }
};
