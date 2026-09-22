import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SETTINGS_CARD_DESCRIPTION_CLASSNAME, SETTINGS_CARD_HEADER_CLASSNAME, SETTINGS_CARD_ICON_CLASSNAME, SETTINGS_CARD_TITLE_CLASSNAME } from "./settings-ui";
import { ApiRequestError, api, type InstanceAdminSettings } from "@/lib/api";
import { cn } from "@/lib/utils";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-semibold text-slate-600">{label}</span>
    {children}
  </label>
);

export const InstanceAdminCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["instance-admin-settings"], queryFn: api.getInstanceAdminSettings });
  const [draft, setDraft] = useState<InstanceAdminSettings | null>(null);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data?.settings) setDraft(settingsQuery.data.settings);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: Parameters<typeof api.updateInstanceAdminSettings>[0]) => api.updateInstanceAdminSettings(payload),
    onSuccess: (data) => {
      setDraft(data.settings);
      setSmtpPassword("");
      setSavedAt(Date.now());
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ["instance-admin-settings"] });
    },
    onError: (error) => {
      setSaveError(error instanceof ApiRequestError ? error.message : String(error));
    },
  });

  if (settingsQuery.isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  const update = (patch: Partial<InstanceAdminSettings>) => setDraft({ ...draft, ...patch });

  const handleSave = () => {
    saveMutation.mutate({
      registrationEnabled: draft.registrationEnabled,
      registrationCodeRequired: draft.registrationCodeRequired,
      smtpHost: draft.smtpHost,
      smtpPort: draft.smtpPort,
      smtpSecure: draft.smtpSecure,
      smtpUsername: draft.smtpUsername,
      smtpFromAddress: draft.smtpFromAddress,
      smtpFromName: draft.smtpFromName,
      shareMissingMessage: draft.shareMissingMessage,
      ...(smtpPassword ? { smtpPassword } : {}),
    });
  };

  return (
    <Card>
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <ShieldCheck className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.title")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.description")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{t("adminConsole.registrationSection")}</h3>
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
          <div className={cn("flex items-center justify-between gap-4 transition", draft.registrationEnabled ? "" : "pointer-events-none opacity-40")}>
            <div>
              <p className="text-sm font-medium text-slate-900">{t("adminConsole.registrationCodeRequired")}</p>
              <p className="text-xs text-slate-500">{t("adminConsole.registrationCodeRequiredHint")}</p>
            </div>
            <Switch
              checked={draft.registrationCodeRequired}
              onCheckedChange={(checked) => update({ registrationCodeRequired: checked })}
            />
          </div>
        </section>

        <section className={cn("space-y-3 transition", draft.registrationEnabled && draft.registrationCodeRequired ? "" : "pointer-events-none opacity-40")}>
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{t("adminConsole.smtpSection")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("adminConsole.smtpHost")}>
              <Input className="h-9" onChange={(event) => update({ smtpHost: event.target.value || null })} value={draft.smtpHost ?? ""} />
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
              <Input className="h-9" onChange={(event) => update({ smtpUsername: event.target.value || null })} value={draft.smtpUsername ?? ""} />
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
              <Input className="h-9" onChange={(event) => update({ smtpFromAddress: event.target.value || null })} type="email" value={draft.smtpFromAddress ?? ""} />
            </Field>
            <Field label={t("adminConsole.smtpFromName")}>
              <Input className="h-9" onChange={(event) => update({ smtpFromName: event.target.value || null })} value={draft.smtpFromName ?? ""} />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-slate-500">{t("adminConsole.smtpSecureHint")}</p>
            <Switch checked={draft.smtpSecure} onCheckedChange={(checked) => update({ smtpSecure: checked })} />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{t("adminConsole.messagesSection")}</h3>
          <Field label={t("adminConsole.shareMissingMessage")}>
            <textarea
              className="min-h-[72px] w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
              maxLength={500}
              onChange={(event) => update({ shareMissingMessage: event.target.value || null })}
              placeholder={t("adminConsole.shareMissingMessagePlaceholder")}
              value={draft.shareMissingMessage ?? ""}
            />
          </Field>
          <p className="text-xs text-slate-500">{t("adminConsole.shareMissingMessageHint")}</p>
        </section>

        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <div className="flex items-center justify-end gap-3">
          {savedAt && !saveMutation.isPending ? (
            <span className="text-xs text-emerald-600">{t("adminConsole.saved")}</span>
          ) : null}
          <Button disabled={saveMutation.isPending} onClick={handleSave}>
            {saveMutation.isPending ? t("adminConsole.saving") : t("adminConsole.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
