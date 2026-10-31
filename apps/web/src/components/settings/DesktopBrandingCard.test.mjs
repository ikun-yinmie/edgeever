import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("desktop branding settings card", () => {
  test("is wired into SettingsPane and handles custom branding inputs", () => {
    const settingsPane = readFileSync(new URL("../SettingsPane.tsx", import.meta.url), "utf8");
    const brandingCard = readFileSync(new URL("./DesktopBrandingCard.tsx", import.meta.url), "utf8");
    const siteSettingsCard = readFileSync(new URL("./SiteSettingsCard.tsx", import.meta.url), "utf8");

    // SettingsPane wires the card
    expect(settingsPane).toContain('import { DesktopBrandingCard } from "./settings/DesktopBrandingCard";');
    expect(settingsPane).toContain("<DesktopBrandingCard />");

    // DesktopBrandingCard checks bridge availability and provides UI
    expect(brandingCard).toContain("bridge?.setClientCustomBranding");
    expect(brandingCard).toContain("bridge?.getClientBranding");
    expect(brandingCard).toContain('t("desktopBranding.title")');
    expect(brandingCard).toContain('t("desktopBranding.clientNameLabel")');
    expect(brandingCard).toContain('t("desktopBranding.clientIconSection")');
    expect(brandingCard).toContain("setClientOverrideName");

    // SiteSettingsCard syncs site branding changes to desktop
    expect(siteSettingsCard).toContain("window.edgeeverDesktop?.syncServerBranding");
  });
});
