import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cardSource = readFileSync(new URL("./DesktopClientSettingsCard.tsx", import.meta.url), "utf8");
const consoleSource = readFileSync(new URL("../AdminConsolePane.tsx", import.meta.url), "utf8");
const policyCardSource = readFileSync(new URL("./LoginSessionPolicyCard.tsx", import.meta.url), "utf8");

describe("desktop client session policy admin card", () => {
  test("is wired into the admin console as its own tab", () => {
    expect(consoleSource).toContain('import { DesktopClientSettingsCard } from "@/components/settings/DesktopClientSettingsCard";');
    expect(consoleSource).toContain('| "client"');
    expect(consoleSource).toContain('{ key: "client", label: t("adminConsole.navClient"), icon: MonitorSmartphone }');
    expect(consoleSource).toContain("case \"client\":");
    expect(consoleSource).toContain("<DesktopClientSettingsCard />");
  });

  test("saves the lifetime through the shared admin settings hook", () => {
    expect(cardSource).toContain("useInstanceAdminSettings");
    expect(cardSource).toContain("desktopSessionTtlDays: value ?? null");
    expect(cardSource).toContain('t("adminConsole.desktopSessionTtlLabel")');
    expect(cardSource).toContain('t("adminConsole.desktopSessionTtlScope")');
    expect(cardSource).toContain("disabled={invalid}");
    expect(cardSource).toContain("MAX_DESKTOP_SESSION_TTL_DAYS = 3650");
  });

  test("personal settings state that the desktop lifetime is admin-controlled", () => {
    expect(policyCardSource).toContain('t("loginSessionPolicy.desktopExempt", { days: policy?.desktopSessionTtlDays ?? "?" })');
  });
});
