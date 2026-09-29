import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ShortcutAction, ShortcutBinding, ShortcutSettings } from "@/lib/app-helpers";
import {
  formatShortcutBinding,
  getShortcutActionOptions,
  shortcutBindingFromKeyboardEvent,
  shortcutBindingsEqual,
} from "@/lib/app-helpers";
import {
  SHORTCUT_SETTINGS_CHANGED_EVENT,
  readShortcutSettingsCustomizations,
  resetShortcutSettingsCustomizations,
  resolveShortcutSettings,
  updateShortcutSettingsOverride,
} from "@/lib/shortcut-settings";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  SETTINGS_ITEM_ICON_CLASSNAME,
  SETTINGS_ITEM_TITLE_CLASSNAME,
} from "./settings-ui";

const getConflictAction = (
  action: ShortcutAction,
  binding: ShortcutBinding,
  settings: ShortcutSettings,
  shortcutActionOptions: ReturnType<typeof getShortcutActionOptions>
) => shortcutActionOptions.find((item) => item.value !== action && shortcutBindingsEqual(settings[item.value], binding));

/** App-level shortcut card following the layered editor-shortcut pattern. */
export const ShortcutSettingsItem = () => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ShortcutSettings>(() => resolveShortcutSettings());
  const [customizations, setCustomizations] = useState<Partial<ShortcutSettings>>(
    () => readShortcutSettingsCustomizations(),
  );
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [captureMessage, setCaptureMessage] = useState("");
  const captureButtonRef = useRef<HTMLButtonElement | null>(null);
  const shortcutActionOptions = useMemo(() => getShortcutActionOptions(t), [t]);

  // The workspace keydown resolver reacts to this event; keep this card in
  // sync with it too so reopen shows fresh bindings.
  useEffect(() => {
    const sync = () => {
      setSettings(resolveShortcutSettings());
      setCustomizations(readShortcutSettingsCustomizations());
    };
    window.addEventListener(SHORTCUT_SETTINGS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SHORTCUT_SETTINGS_CHANGED_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!recordingAction) {
      return;
    }

    captureButtonRef.current?.focus();
  }, [recordingAction]);

  useEffect(() => {
    if (!recordingAction) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingAction(null);
        setCaptureMessage("");
        return;
      }

      const nextBinding = shortcutBindingFromKeyboardEvent(event);
      if (!nextBinding) {
        setCaptureMessage(t("shortcuts.requireModifier"));
        return;
      }

      const conflictAction = getConflictAction(recordingAction, nextBinding, settings, shortcutActionOptions);
      if (conflictAction) {
        setCaptureMessage(t("shortcuts.conflict", { label: conflictAction.label }));
        return;
      }

      setCustomizations(updateShortcutSettingsOverride(recordingAction, nextBinding));
      setSettings(resolveShortcutSettings());
      setRecordingAction(null);
      setCaptureMessage("");
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [recordingAction, settings, shortcutActionOptions, t]);

  const hasCustomizations = useMemo(() => Object.keys(customizations).length > 0, [customizations]);

  const handleResetShortcuts = () => {
    resetShortcutSettingsCustomizations();
    setSettings(resolveShortcutSettings());
    setCustomizations({});
    setRecordingAction(null);
    setCaptureMessage("");
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <Keyboard className={SETTINGS_ITEM_ICON_CLASSNAME} />
          <div className="min-w-0">
            <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("shortcuts.title")}</div>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{t("shortcuts.description")}</p>
          </div>
        </div>
        {hasCustomizations && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 px-2 text-xs text-slate-600"
            type="button"
            onClick={handleResetShortcuts}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("shortcuts.resetSection")}
          </Button>
        )}
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2">
        {shortcutActionOptions.map((item) => {
          const recording = recordingAction === item.value;
          const customized = item.value in customizations;

          return (
            <div
              key={item.value}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                <span className="truncate">{item.label}</span>
                {customized && (
                  <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    {t("shortcuts.customized")}
                  </span>
                )}
              </span>
              <Button
                ref={recording ? captureButtonRef : null}
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
        <div className="mx-4 mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
          {captureMessage}
        </div>
      ) : null}
    </div>
  );
};
