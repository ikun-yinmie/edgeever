import { useRef, useState } from "react";
import { Globe, Image, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { refreshSiteBranding } from "@/lib/site-branding";
import { cn } from "@/lib/utils";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const SITE_ICON_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const SITE_ICON_MAX_BYTES = 256 * 1024;
const SITE_ICON_DATA_URL_MAX_LENGTH = 400_000;

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-semibold text-slate-600">{label}</span>
    {children}
    {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
  </label>
);

/** Browser-facing identity of the instance: tab name, description and icon. */
export const SiteSettingsCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, update, save } = useInstanceAdminSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [iconError, setIconError] = useState<string | null>(null);

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  const handleIconFile = (file: File) => {
    if (!SITE_ICON_MIME_TYPES.has(file.type)) {
      setIconError(t("adminConsole.siteIconInvalidType"));
      return;
    }
    if (file.size > SITE_ICON_MAX_BYTES) {
      setIconError(t("adminConsole.siteIconTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result || result.length > SITE_ICON_DATA_URL_MAX_LENGTH) {
        setIconError(t("adminConsole.siteIconTooLarge"));
        return;
      }
      setIconError(null);
      update({ siteIcon: result });
    };
    reader.onerror = () => setIconError(t("adminConsole.siteIconReadFailed"));
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    save(
      {
        siteName: draft.siteName,
        siteDescription: draft.siteDescription,
        siteIcon: draft.siteIcon,
      },
      () => {
        void refreshSiteBranding();
      },
    );
  };

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <Globe className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.siteSection")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.siteCardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <Field hint={t("adminConsole.siteNameHint")} label={t("adminConsole.siteNameLabel")}>
          <Input
            className="h-9"
            maxLength={60}
            onChange={(event) => update({ siteName: event.target.value || null })}
            placeholder="EdgeEver"
            value={draft.siteName ?? ""}
          />
        </Field>

        <Field hint={t("adminConsole.siteDescriptionHint")} label={t("adminConsole.siteDescriptionLabel")}>
          <textarea
            className="min-h-[64px] w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
            maxLength={300}
            onChange={(event) => update({ siteDescription: event.target.value || null })}
            placeholder={t("adminConsole.siteDescriptionPlaceholder")}
            value={draft.siteDescription ?? ""}
          />
        </Field>

        <section className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
            {t("adminConsole.siteIconSection")}
          </h3>
          <div className="flex items-center gap-4">
            <img
              alt=""
              className="h-12 w-12 rounded-lg border border-slate-200 bg-slate-50 object-contain p-1"
              src={draft.siteIcon ?? "/favicon.svg"}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="h-8"
                  onClick={() => fileInputRef.current?.click()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Upload className="h-4 w-4" />
                  {t("adminConsole.siteIconUpload")}
                </Button>
                {draft.siteIcon ? (
                  <Button
                    className="h-8"
                    onClick={() => {
                      setIconError(null);
                      update({ siteIcon: null });
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("adminConsole.siteIconReset")}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">
                {draft.siteIcon ? t("adminConsole.siteIconHint") : t("adminConsole.siteIconDefaultHint")}
              </p>
            </div>
            <input
              accept={Array.from(SITE_ICON_MIME_TYPES).join(",")}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) handleIconFile(file);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
          {iconError ? <p className="text-sm text-rose-600">{iconError}</p> : null}
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <Image className="h-3.5 w-3.5" />
            {t("adminConsole.siteIconFormats")}
          </p>
        </section>

        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter isSaving={isSaving} savedAt={savedAt} onSave={handleSave} />
      </CardContent>
    </Card>
  );
};
