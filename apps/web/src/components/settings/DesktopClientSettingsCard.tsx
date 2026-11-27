import { Clock3, MonitorSmartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { cn } from "@/lib/utils";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const MIN_DESKTOP_SESSION_TTL_DAYS = 1;
const MAX_DESKTOP_SESSION_TTL_DAYS = 3650;

/**
 * Instance-wide lifetime of desktop-client sessions. Browser and mobile
 * sessions follow each account's own retention, and shared accounts keep the
 * group lifetime, so this tab only owns the desktop terminal.
 */
export const DesktopClientSettingsCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, update, save } = useInstanceAdminSettings();

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8"><LoadingIndicator label={t("common.loading")} centered /></CardContent>
      </Card>
    );
  }

  const value = draft.desktopSessionTtlDays;
  const invalid = typeof value === "number"
    && (!Number.isInteger(value) || value < MIN_DESKTOP_SESSION_TTL_DAYS || value > MAX_DESKTOP_SESSION_TTL_DAYS);

  const handleSave = () => {
    save({ desktopSessionTtlDays: value ?? null });
  };

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <MonitorSmartphone className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
            {t("adminConsole.desktopClientSection")}
          </CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.desktopClientDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <label className="block space-y-1.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            <Clock3 className="h-3.5 w-3.5 text-slate-400" />
            {t("adminConsole.desktopSessionTtlLabel")}
          </span>
          <Input
            className="h-9 max-w-40"
            inputMode="numeric"
            max={MAX_DESKTOP_SESSION_TTL_DAYS}
            min={MIN_DESKTOP_SESSION_TTL_DAYS}
            type="number"
            value={value ?? ""}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (!raw) {
                update({ desktopSessionTtlDays: null });
                return;
              }
              const days = Number.parseInt(raw.replace(/\D/g, ""), 10);
              update({ desktopSessionTtlDays: Number.isInteger(days) && days > 0 ? days : 0 });
            }}
          />
          <span className="block text-xs text-slate-500">
            {t("adminConsole.desktopSessionTtlHint", { days: MAX_DESKTOP_SESSION_TTL_DAYS })}
          </span>
        </label>

        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600">
          {t("adminConsole.desktopSessionTtlScope")}
        </p>

        {invalid ? <p className="text-sm text-rose-600">{t("adminConsole.desktopSessionTtlInvalid")}</p> : null}
        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter
          disabled={invalid}
          isSaving={isSaving}
          savedAt={savedAt}
          onSave={handleSave}
        />
      </CardContent>
    </Card>
  );
};
