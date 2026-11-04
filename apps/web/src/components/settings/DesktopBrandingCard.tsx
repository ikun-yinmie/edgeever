import { useEffect, useRef, useState } from "react";
import { AppWindow, CheckCircle2, ChevronDown, RotateCcw, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

export const convertIconFileToPngDataUrl = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const size = Math.min(512, Math.max(img.naturalWidth || 512, img.naturalHeight || 512));
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          const pngUrl = canvas.toDataURL("image/png");
          URL.revokeObjectURL(url);
          resolve(pngUrl);
          return;
        }
      } catch {
        // fallback to standard readAsDataURL
      }
      URL.revokeObjectURL(url);
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("Image decode failed"));
      reader.readAsDataURL(file);
    };
    img.src = url;
  });
};

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
  const [expanded, setExpanded] = useState(false);

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

  const handleIconFile = async (file: File) => {
    if (!BRANDING_ICON_MIME_TYPES.has(file.type)) {
      setIconError(t("adminConsole.siteIconInvalidType"));
      return;
    }
    if (file.size > BRANDING_ICON_MAX_BYTES) {
      setIconError(t("adminConsole.siteIconTooLarge"));
      return;
    }
    try {
      const pngDataUrl = await convertIconFileToPngDataUrl(file);
      if (!pngDataUrl || pngDataUrl.length > BRANDING_ICON_DATA_URL_MAX_LENGTH) {
        setIconError(t("adminConsole.siteIconTooLarge"));
        return;
      }
      setIconError(null);
      setDraftIcon(pngDataUrl);
    } catch {
      setIconError(t("adminConsole.siteIconReadFailed"));
    }
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
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <Card className="w-full min-w-0 overflow-hidden shadow-none">
        <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
          <CollapsibleTrigger asChild>
            <button
              className="flex w-full min-w-0 items-start justify-between gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
              type="button"
            >
              <span className="flex min-w-0 items-start gap-2">
                <AppWindow aria-hidden="true" className={cn(SETTINGS_CARD_ICON_CLASSNAME, "mt-0.5 text-emerald-600")} />
                <span className="min-w-0">
                  <span className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("desktopBranding.title")}</span>
                  <span className={cn(SETTINGS_CARD_DESCRIPTION_CLASSNAME, "block")}>
                    {t("desktopBranding.description")}
                  </span>
                </span>
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn("mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform", expanded && "rotate-180")}
              />
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent asChild>
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

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {savedSuccess ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {t("desktopBranding.saveSuccess")}
                </span>
                <span className="text-xs text-slate-500">
                  {t("desktopBranding.relaunchHint")}
                </span>
                {bridge?.relaunch ? (
                  <Button
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => void bridge.relaunch?.()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t("desktopBranding.relaunchButton")}
                  </Button>
                ) : null}
              </div>
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
