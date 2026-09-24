import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const SECTION_CLASSNAME = "text-xs font-bold uppercase tracking-wide text-slate-500";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-semibold text-slate-600">{label}</span>
    {children}
  </label>
);

/** SMTP sender plus the send-rate limits that guard the verification endpoint. */
export const EmailSettingsCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, update, save } = useInstanceAdminSettings();
  const [smtpPassword, setSmtpPassword] = useState("");

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  const handleSave = () => {
    save(
      {
        smtpHost: draft.smtpHost,
        smtpPort: draft.smtpPort,
        smtpSecure: draft.smtpSecure,
        smtpUsername: draft.smtpUsername,
        smtpFromAddress: draft.smtpFromAddress,
        smtpFromName: draft.smtpFromName,
        abuseGuardEnabled: draft.abuseGuardEnabled,
        codeIpHourlyLimit: draft.codeIpHourlyLimit,
        codeIpDailyLimit: draft.codeIpDailyLimit,
        ...(smtpPassword ? { smtpPassword } : {}),
      },
      () => setSmtpPassword(""),
    );
  };

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <Mail className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.smtpSection")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.emailCardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {draft.registrationEnabled && draft.registrationCodeRequired ? null : (
          <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900">
            {t("adminConsole.emailInactiveHint")}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("adminConsole.smtpHost")}>
            <Input
              className="h-9"
              onChange={(event) => update({ smtpHost: event.target.value || null })}
              value={draft.smtpHost ?? ""}
            />
          </Field>
          <Field label={t("adminConsole.smtpPort")}>
            <Input
              className="h-9"
              max={65535}
              min={1}
              onChange={(event) => update({ smtpPort: event.target.value ? Number(event.target.value) : null })}
              type="number"
              value={draft.smtpPort ?? ""}
            />
          </Field>
          <Field label={t("adminConsole.smtpUsername")}>
            <Input
              className="h-9"
              onChange={(event) => update({ smtpUsername: event.target.value || null })}
              value={draft.smtpUsername ?? ""}
            />
          </Field>
          <Field label={t("adminConsole.smtpPassword")}>
            <Input
              className="h-9"
              onChange={(event) => setSmtpPassword(event.target.value)}
              placeholder={t("adminConsole.smtpPasswordPlaceholder")}
              type="password"
              value={smtpPassword}
            />
          </Field>
          <Field label={t("adminConsole.smtpFromAddress")}>
            <Input
              className="h-9"
              onChange={(event) => update({ smtpFromAddress: event.target.value || null })}
              type="email"
              value={draft.smtpFromAddress ?? ""}
            />
          </Field>
          <Field label={t("adminConsole.smtpFromName")}>
            <Input
              className="h-9"
              onChange={(event) => update({ smtpFromName: event.target.value || null })}
              value={draft.smtpFromName ?? ""}
            />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-slate-500">{t("adminConsole.smtpSecureHint")}</p>
          <Switch checked={draft.smtpSecure} onCheckedChange={(checked) => update({ smtpSecure: checked })} />
        </div>

        <section className="space-y-3 border-t border-slate-100 pt-5">
          <h3 className={SECTION_CLASSNAME}>{t("adminConsole.abuseSection")}</h3>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.abuseGuardEnabled")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.abuseGuardEnabledHint")}</p>
            </div>
            <Switch
              checked={draft.abuseGuardEnabled}
              onCheckedChange={(checked) => update({ abuseGuardEnabled: checked })}
            />
          </div>
          <div
            className={cn(
              "grid gap-3 transition sm:grid-cols-2",
              draft.abuseGuardEnabled ? "" : "pointer-events-none opacity-40",
            )}
          >
            <Field label={t("adminConsole.codeIpHourlyLimit")}>
              <Input
                className="h-9"
                min={1}
                max={1000}
                onChange={(event) =>
                  update({
                    codeIpHourlyLimit: event.target.value ? Number(event.target.value) : draft.codeIpHourlyLimit,
                  })
                }
                type="number"
                value={draft.codeIpHourlyLimit}
              />
            </Field>
            <Field label={t("adminConsole.codeIpDailyLimit")}>
              <Input
                className="h-9"
                min={1}
                max={10000}
                onChange={(event) =>
                  update({ codeIpDailyLimit: event.target.value ? Number(event.target.value) : draft.codeIpDailyLimit })
                }
                type="number"
                value={draft.codeIpDailyLimit}
              />
            </Field>
          </div>
          <p className="text-xs text-slate-500">{t("adminConsole.abuseHint")}</p>
        </section>

        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter isSaving={isSaving} savedAt={savedAt} onSave={handleSave} />
      </CardContent>
    </Card>
  );
};
