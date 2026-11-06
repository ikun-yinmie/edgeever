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

  test("keeps long desktop settings sections collapsed and accessible", () => {
    const brandingCard = readFileSync(new URL("./DesktopBrandingCard.tsx", import.meta.url), "utf8");
    const updateCard = readFileSync(new URL("./DesktopUpdateCard.tsx", import.meta.url), "utf8");

    for (const source of [brandingCard, updateCard]) {
      expect(source).toContain("const [expanded, setExpanded] = useState(false);");
      expect(source).toContain("<Collapsible open={expanded} onOpenChange={setExpanded} asChild>");
      expect(source).toContain("<CollapsibleTrigger asChild>");
      expect(source).toContain("<CollapsibleContent asChild>");
      expect(source).toContain('type="button"');
      expect(source).toContain("focus-visible:ring-2");
    }

    expect(updateCard).toContain("const shouldRevealUpdateDetails = available || downloading || downloaded");
    expect(updateCard).toContain("if (shouldRevealUpdateDetails) setExpanded(true);");
  });
});
