import { useTranslation } from "react-i18next";
import { UserPlus } from "lucide-react";
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

/** Who may register, plus the email and verification-code rules for sign-up. */
export const RegistrationSettingsCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, update, save } = useInstanceAdminSettings();

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  const codeRequiredActive = draft.registrationEnabled && draft.registrationCodeRequired;

  const handleSave = () => {
    save({
      registrationEnabled: draft.registrationEnabled,
      registrationCodeRequired: draft.registrationCodeRequired,
      emailAllowlistEnabled: draft.emailAllowlistEnabled,
      emailAllowlist: draft.emailAllowlist,
      emailBlocklist: draft.emailBlocklist,
      codeTtlSeconds: draft.codeTtlSeconds,
      codeResendCooldownSeconds: draft.codeResendCooldownSeconds,
      codeBindIp: draft.codeBindIp,
      codeBindDevice: draft.codeBindDevice,
    });
  };

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <UserPlus className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.registrationSection")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.registrationCardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.registrationEnabled")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.registrationEnabledHint")}</p>
            </div>
            <Switch
              checked={draft.registrationEnabled}
              onCheckedChange={(checked) => update({ registrationEnabled: checked })}
            />
          </div>
          <div
            className={cn(
              "flex items-center justify-between gap-4 transition",
              draft.registrationEnabled ? "" : "pointer-events-none opacity-40",
            )}
          >
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.registrationCodeRequired")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.registrationCodeRequiredHint")}</p>
            </div>
            <Switch
              checked={draft.registrationCodeRequired}
              onCheckedChange={(checked) => update({ registrationCodeRequired: checked })}
            />
          </div>
        </div>

        <section
          className={cn("space-y-3 transition", draft.registrationEnabled ? "" : "pointer-events-none opacity-40")}
        >
          <h3 className={SECTION_CLASSNAME}>{t("adminConsole.emailPolicySection")}</h3>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.emailAllowlistEnabled")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.emailAllowlistEnabledHint")}</p>
            </div>
            <Switch
              checked={draft.emailAllowlistEnabled}
              onCheckedChange={(checked) => update({ emailAllowlistEnabled: checked })}
            />
          </div>
          <Field label={t("adminConsole.emailAllowlist")}>
            <textarea
              className="min-h-[72px] w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
              maxLength={4000}
              onChange={(event) => update({ emailAllowlist: event.target.value || null })}
              placeholder={"qq.com\nfriend@example.com"}
              value={draft.emailAllowlist ?? ""}
            />
          </Field>
          <Field label={t("adminConsole.emailBlocklist")}>
            <textarea
              className="min-h-[72px] w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
              maxLength={4000}
              onChange={(event) => update({ emailBlocklist: event.target.value || null })}
              placeholder={"gmail.com\ngooglemail.com"}
              value={draft.emailBlocklist ?? ""}
            />
          </Field>
          <p className="text-xs text-slate-500">{t("adminConsole.emailPolicyHint")}</p>
        </section>

        <section className={cn("space-y-3 transition", codeRequiredActive ? "" : "pointer-events-none opacity-40")}>
          <h3 className={SECTION_CLASSNAME}>{t("adminConsole.codePolicySection")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("adminConsole.codeTtlSeconds")}>
              <Input
                className="h-9"
                min={30}
                max={3600}
                onChange={(event) =>
                  update({ codeTtlSeconds: event.target.value ? Number(event.target.value) : draft.codeTtlSeconds })
                }
                type="number"
                value={draft.codeTtlSeconds}
              />
            </Field>
            <Field label={t("adminConsole.codeResendCooldownSeconds")}>
              <Input
                className="h-9"
                min={10}
                max={3600}
                onChange={(event) =>
                  update({
                    codeResendCooldownSeconds: event.target.value
                      ? Number(event.target.value)
                      : draft.codeResendCooldownSeconds,
                  })
                }
                type="number"
                value={draft.codeResendCooldownSeconds}
              />
            </Field>
          </div>
          <p className="text-xs text-slate-500">{t("adminConsole.codePolicyHint")}</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.codeBindIp")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.codeBindIpHint")}</p>
            </div>
            <Switch checked={draft.codeBindIp} onCheckedChange={(checked) => update({ codeBindIp: checked })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.codeBindDevice")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.codeBindDeviceHint")}</p>
            </div>
            <Switch checked={draft.codeBindDevice} onCheckedChange={(checked) => update({ codeBindDevice: checked })} />
          </div>
        </section>

        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter isSaving={isSaving} savedAt={savedAt} onSave={handleSave} />
      </CardContent>
    </Card>
  );
};
