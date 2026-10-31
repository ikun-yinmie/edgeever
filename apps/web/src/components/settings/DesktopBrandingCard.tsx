import { useEffect, useRef, useState } from "react";
import { AppWindow, CheckCircle2, RotateCcw, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { setClientOverrideName, useSiteBranding, getSiteDisplayName } from "@/lib/site-branding";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const BRANDING_ICON_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const BRANDING_ICON_MAX_BYTES = 256 * 1024;
const BRANDING_ICON_DATA_URL_MAX_LENGTH = 400_000;

type EffectiveBrandingState = {
  customName: string | null;
  customIcon: string | null;
  serverName: string | null;
  serverIcon: string | null;
  effectiveName: string;
  effectiveIcon: string | null;
  nameSource: "custom" | "server" | "default";
  iconSource: "custom" | "server" | "default";
};

export const DesktopBrandingCard = () => {
  const { t } = useTranslation();
  const bridge = window.edgeeverDesktop;
  const siteBranding = useSiteBranding();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [brandingInfo, setBrandingInfo] = useState<EffectiveBrandingState | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftIcon, setDraftIcon] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (!bridge?.getClientBranding) return;
    void bridge.getClientBranding().then((info) => {
      setBrandingInfo(info);
      setDraftName(info.customName ?? "");
      setDraftIcon(info.customIcon);
    });
  }, [bridge]);

  if (!bridge?.setClientCustomBranding || !bridge?.getClientBranding) {
    return null;
  }

  const handleIconFile = (file: File) => {
    if (!BRANDING_ICON_MIME_TYPES.has(file.type)) {
      setIconError(t("adminConsole.siteIconInvalidType"));
      return;
    }
    if (file.size > BRANDING_ICON_MAX_BYTES) {
      setIconError(t("adminConsole.siteIconTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result || result.length > BRANDING_ICON_DATA_URL_MAX_LENGTH) {
        setIconError(t("adminConsole.siteIconTooLarge"));
        return;
      }
      setIconError(null);
      setDraftIcon(result);
    };
    reader.onerror = () => setIconError(t("adminConsole.siteIconReadFailed"));
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!bridge?.setClientCustomBranding) return;
    setIsSaving(true);
    setSavedSuccess(false);
    try {
      const trimmedName = draftName.trim() || null;
      const updated = await bridge.setClientCustomBranding({
        name: trimmedName,
        icon: draftIcon || null,
      });
      setBrandingInfo(updated);
      setClientOverrideName(updated.customName);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch {
      // ignore
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (!bridge?.setClientCustomBranding) return;
    setIsSaving(true);
    setSavedSuccess(false);
    try {
      const updated = await bridge.setClientCustomBranding({
        name: null,
        icon: null,
      });
      setBrandingInfo(updated);
      setDraftName("");
      setDraftIcon(null);
      setIconError(null);
      setClientOverrideName(null);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch {
      // ignore
    } finally {
      setIsSaving(false);
    }
  };

  const fallbackSiteName = siteBranding.name?.trim() || brandingInfo?.serverName || "EdgeEver";
  const displayIcon = draftIcon || brandingInfo?.serverIcon || "/favicon.svg";

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <AppWindow className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("desktopBranding.title")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("desktopBranding.description")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-slate-600">{t("desktopBranding.clientNameLabel")}</span>
          <Input
            className="h-9"
            maxLength={60}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder={t("desktopBranding.clientNamePlaceholder")}
            value={draftName}
          />
          <span className="block text-xs text-slate-500">
            {t("desktopBranding.clientNameHint", { fallback: fallbackSiteName })}
          </span>
        </label>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
              {t("desktopBranding.clientIconSection")}
            </h3>
            {draftIcon ? (
              <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                {t("desktopBranding.statusSourceCustom")}
              </span>
            ) : brandingInfo?.serverIcon ? (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {t("desktopBranding.statusSourceServer")}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-4">
            <img
              alt=""
              className="h-12 w-12 rounded-lg border border-slate-200 bg-slate-50 object-contain p-1"
              src={displayIcon}
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
                  {t("desktopBranding.uploadIcon")}
                </Button>
                {draftIcon ? (
                  <Button
                    className="h-8"
                    onClick={() => {
                      setIconError(null);
                      setDraftIcon(null);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw className="h-4 w-4" />
                    {t("desktopBranding.restoreDefaultIcon")}
                  </Button>
                ) : null}
                <input
                  accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleIconFile(file);
                    e.target.value = "";
                  }}
                  ref={fileInputRef}
                  type="file"
                />
              </div>
              <p className="text-xs text-slate-500">{t("desktopBranding.customIconHint")}</p>
              {iconError ? <p className="text-xs text-rose-600">{iconError}</p> : null}
            </div>
          </div>
        </section>

        <div className="flex items-center justify-between border-t border-slate-100 pt-4">
          <div className="flex items-center gap-2">
            {savedSuccess ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                <CheckCircle2 className="h-4 w-4" />
                {t("desktopBranding.saveSuccess")}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {(draftName || draftIcon || brandingInfo?.customName || brandingInfo?.customIcon) ? (
              <Button
                className="h-8"
                disabled={isSaving}
                onClick={() => void handleReset()}
                size="sm"
                type="button"
                variant="ghost"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("desktopBranding.reset")}
              </Button>
            ) : null}
            <Button
              className="h-8"
              disabled={isSaving}
              onClick={() => void handleSave()}
              size="sm"
              type="button"
            >
              {isSaving ? t("desktopBranding.saving") : t("desktopBranding.save")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
