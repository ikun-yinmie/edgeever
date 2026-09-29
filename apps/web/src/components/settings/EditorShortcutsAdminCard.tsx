import { useEffect, useMemo, useState } from "react";
import { Keyboard, RotateCcw, Save } from "lucide-react";import { useTranslation } from "react-i18next";
import {
  DEFAULT_EDITOR_SHORTCUT_SETTINGS,
  EDITOR_SHORTCUT_IDS,
  editorShortcutBindingsEqual,
  normalizeEditorShortcutSettings,
  type EditorShortcutId,
  type EditorShortcutSettings,
} from "@edgeever/shared";
import { api } from "@/lib/api";
import { formatShortcutBinding, shortcutBindingFromKeyboardEvent } from "@/lib/app-helpers";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import { writeInstanceEditorShortcutDefaults } from "@/lib/editor-shortcuts-settings";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  SETTINGS_ITEM_ICON_CLASSNAME,
  SETTINGS_ITEM_TITLE_CLASSNAME,
} from "./settings-ui";

const EDITOR_SHORTCUT_I18N_KEYS: Record<EditorShortcutId, string> = {
  "heading-1": "editorToolbar.heading1",
  "heading-2": "editorToolbar.heading2",
  "heading-3": "editorToolbar.heading3",
  "heading-4": "editorToolbar.heading4",
  "heading-5": "editorToolbar.heading5",
  "heading-6": "editorToolbar.heading6",
  paragraph: "editorToolbar.paragraph",
  bold: "editorToolbar.bold",
  italic: "editorToolbar.italic",
  underline: "editorToolbar.underline",
  strikethrough: "editorToolbar.strikethrough",
  code: "editorToolbar.inlineCode",
  bulletList: "editorToolbar.bulletList",
  orderedList: "editorToolbar.orderedList",
  taskList: "editorToolbar.taskList",
  blockquote: "editorToolbar.quote",
  codeBlock: "editorToolbar.codeBlock",
  horizontalRule: "editorToolbar.horizontalRule",
  clearFormatting: "editorToolbar.clearFormatting",
};

export const EditorShortcutsAdminCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, save } = useInstanceAdminSettings();
  const [showSaveError, setShowSaveError] = useState(false);
  const [settings, setSettings] = useState<EditorShortcutSettings>(DEFAULT_EDITOR_SHORTCUT_SETTINGS);
  const [recordingId, setRecordingId] = useState<EditorShortcutId | null>(null);
  const [captureMessage, setCaptureMessage] = useState("");

  useEffect(() => {
    if (draft?.editorShortcuts) {
      setSettings(normalizeEditorShortcutSettings(draft.editorShortcuts));
    }
  }, [draft?.editorShortcuts]);

  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingId(null);
        setCaptureMessage("");
        return;
      }

      const binding = shortcutBindingFromKeyboardEvent(event);
      if (!binding) {
        setCaptureMessage(t("shortcuts.requireModifier"));
        return;
      }

      const conflict = EDITOR_SHORTCUT_IDS.find(
        (id) => id !== recordingId && editorShortcutBindingsEqual(settings[id], binding),
      );
      if (conflict) {
        setCaptureMessage(t("shortcuts.conflict", { label: t(EDITOR_SHORTCUT_I18N_KEYS[conflict]) }));
        return;
      }

      setSettings((current) => ({ ...current, [recordingId]: binding }));
      setRecordingId(null);
      setCaptureMessage("");
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [recordingId, settings, t]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    const stored = draft.editorShortcuts
      ? normalizeEditorShortcutSettings(draft.editorShortcuts)
      : DEFAULT_EDITOR_SHORTCUT_SETTINGS;
    return EDITOR_SHORTCUT_IDS.some((id) => !editorShortcutBindingsEqual(stored[id], settings[id]));
  }, [draft, settings]);

  const handleSave = () => {
    save(
      { editorShortcuts: settings },
      () => {
        // Cache the new instance defaults locally so clients pick them up immediately.
        writeInstanceEditorShortcutDefaults(settings);
      },
    );
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-card">
      <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3.5">
        <Keyboard className={SETTINGS_ITEM_ICON_CLASSNAME} />
        <div className="min-w-0 flex-1">
          <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("adminConsole.editorShortcuts.title")}</div>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">{t("adminConsole.editorShortcuts.description")}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-sm text-slate-500">{t("common.loading")}</div>
      ) : (
        <>
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {EDITOR_SHORTCUT_IDS.map((id) => {
              const recording = recordingId === id;
              return (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5"
                >
                  <span className="min-w-0 truncate text-sm text-slate-700">{t(EDITOR_SHORTCUT_I18N_KEYS[id])}</span>
                  <Button
                    type="button"
                    variant={recording ? "solid" : "outline"}
                    className={cn("h-8 min-w-28 shrink-0 px-2.5 font-mono text-xs", !recording && "bg-card")}
                    onClick={() => {
                      setRecordingId(recording ? null : id);
                      setCaptureMessage("");
                    }}
                  >
                    {recording ? t("shortcuts.recording") : formatShortcutBinding(settings[id])}
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
                setSettings(DEFAULT_EDITOR_SHORTCUT_SETTINGS);
                setRecordingId(null);
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
