import { useEffect, useMemo, useState } from "react";
import { Keyboard, RotateCcw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ShortcutAction, ShortcutSettings } from "@/lib/app-helpers";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  formatShortcutBinding,
  getShortcutActionOptions,
  shortcutBindingFromKeyboardEvent,
  shortcutBindingsEqual,
} from "@/lib/app-helpers";
import { api } from "@/lib/api";
import { writeInstanceAppShortcutDefaults } from "@/lib/shortcut-settings";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  SETTINGS_ITEM_ICON_CLASSNAME,
  SETTINGS_ITEM_TITLE_CLASSNAME,
} from "./settings-ui";

/** Owner card for the instance-wide default bindings of the 13 app shortcuts. */
export const AppShortcutsAdminCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, save } = useInstanceAdminSettings();
  const [showSaveError, setShowSaveError] = useState(false);
  const [settings, setSettings] = useState<ShortcutSettings>(DEFAULT_SHORTCUT_SETTINGS);
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [captureMessage, setCaptureMessage] = useState("");
  const shortcutActionOptions = useMemo(() => getShortcutActionOptions(t), [t]);

  useEffect(() => {
    if (!draft) return;
    setSettings({
      ...DEFAULT_SHORTCUT_SETTINGS,
      ...(draft.appShortcuts ?? {}),
    });
  }, [draft]);

  useEffect(() => {
    if (!recordingAction) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingAction(null);
        setCaptureMessage("");
        return;
      }

      const binding = shortcutBindingFromKeyboardEvent(event);
      if (!binding) {
        setCaptureMessage(t("shortcuts.requireModifier"));
        return;
      }

      const conflict = shortcutActionOptions.find(
        (item) => item.value !== recordingAction && shortcutBindingsEqual(settings[item.value], binding),
      );
      if (conflict) {
        setCaptureMessage(t("shortcuts.conflict", { label: conflict.label }));
        return;
      }

      setSettings((current) => ({ ...current, [recordingAction]: binding }));
      setRecordingAction(null);
      setCaptureMessage("");
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [recordingAction, settings, shortcutActionOptions, t]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    const stored = { ...DEFAULT_SHORTCUT_SETTINGS, ...(draft.appShortcuts ?? {}) };
    return shortcutActionOptions.some((item) => !shortcutBindingsEqual(stored[item.value], settings[item.value]));
  }, [draft, settings, shortcutActionOptions]);

  const handleSave = () => {
    save(
      { appShortcuts: settings },
      () => {
        // Cache the new instance defaults locally so clients pick them up immediately.
        writeInstanceAppShortcutDefaults(settings);
      },
    );
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-card">
      <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3.5">
        <Keyboard className={SETTINGS_ITEM_ICON_CLASSNAME} />
        <div className="min-w-0 flex-1">
          <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("adminConsole.appShortcuts.title")}</div>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">{t("adminConsole.appShortcuts.description")}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-sm text-slate-500">{t("common.loading")}</div>
      ) : (
        <>
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {shortcutActionOptions.map((item) => {
              const recording = recordingAction === item.value;
              return (
                <div
                  key={item.value}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5"
                >
                  <span className="min-w-0 truncate text-sm text-slate-700">{item.label}</span>
                  <Button
                    type="button"
                    variant={recording ? "solid" : "outline"}
                    className={cn("h-8 min-w-28 shrink-0 px-2.5 font-mono text-xs", !recording && "bg-card")}
                    onClick={() => {
                      setRecordingAction(recording ? null : item.value);
                      setCaptureMessage("");
                    }}
                  >
                    {recording ? t("shortcuts.recording") : formatShortcutBinding(settings[item.value])}
                  </Button>
                </div>
              );
            })}
          </div>

          {captureMessage ? (
            <div className="mx-4 mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
              {captureMessage}
            </div>
          ) : null}

          {saveError && showSaveError ? (
            <div className="mx-4 mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              {saveError}
            </div>
          ) : null}

          <div className="px-4 pb-3">
            <AdminSettingsSaveFooter
              savedAt={savedAt}
              isSaving={isSaving}
              onSave={handleSave}
            />
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs text-slate-600"
              onClick={() => {
                setSettings(DEFAULT_SHORTCUT_SETTINGS);
                setRecordingAction(null);
                setCaptureMessage("");
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("shortcuts.resetSection")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 px-3"
              disabled={!dirty || isSaving}
              onClick={handleSave}
            >
              <Save className="h-3.5 w-3.5" />
              {t("common.save")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
