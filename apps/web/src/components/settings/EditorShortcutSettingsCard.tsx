import { useEffect, useMemo, useState } from "react";
import { Keyboard, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_EDITOR_SHORTCUT_SETTINGS,
  EDITOR_SHORTCUT_IDS,
  editorShortcutBindingsEqual,
  type EditorShortcutId,
  type EditorShortcutSettings,
} from "@edgeever/shared";
import { formatShortcutBinding, shortcutBindingFromKeyboardEvent } from "@/lib/app-helpers";
import {
  readEditorShortcutCustomizations,
  writeEditorShortcutCustomizations,
} from "@/lib/editor-shortcuts-settings";
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
  strikethrough: "editorToolbar.strike",
  code: "editorToolbar.inlineCode",
  bulletList: "editorToolbar.bulletList",
  orderedList: "editorToolbar.orderedList",
  taskList: "editorToolbar.taskList",
  blockquote: "editorToolbar.quote",
  codeBlock: "editorToolbar.codeBlock",
  horizontalRule: "editorToolbar.horizontalRule",
  clearFormatting: "editorToolbar.clearFormatting",
};

/** Personal editor-shortcut customizations merged over the defaults, persisted to localStorage. */
const useEditorShortcutSettingsState = () => {
  const [customizations, setCustomizations] = useState<Partial<EditorShortcutSettings>>(() =>
    readEditorShortcutCustomizations() ?? {},
  );

  const settings = useMemo<EditorShortcutSettings>(() => ({
    ...DEFAULT_EDITOR_SHORTCUT_SETTINGS,
    ...customizations,
  }), [customizations]);

  const updateBinding = (id: EditorShortcutId, binding: EditorShortcutSettings[EditorShortcutId] | null) => {
    setCustomizations((current) => {
      const next = { ...current };
      if (!binding || JSON.stringify(binding) === JSON.stringify(DEFAULT_EDITOR_SHORTCUT_SETTINGS[id])) {
        delete next[id];
      } else {
        next[id] = binding;
      }
      writeEditorShortcutCustomizations(next);
      return next;
    });
  };

  const reset = () => {
    setCustomizations({});
    writeEditorShortcutCustomizations(null);
  };

  return { settings, customizations, updateBinding, reset };
};

/** Standalone personal settings card for editor formatting shortcuts. */
export const EditorShortcutSettingsCard = () => {
  const { t } = useTranslation();
  const { settings, customizations, updateBinding, reset } = useEditorShortcutSettingsState();
  const [recordingId, setRecordingId] = useState<EditorShortcutId | null>(null);
  const [captureMessage, setCaptureMessage] = useState("");
  const [captureButtonNode, setCaptureButtonNode] = useState<HTMLButtonElement | null>(null);

  useEffect(() => {
    captureButtonNode?.focus();
  }, [recordingId, captureButtonNode]);

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

      updateBinding(recordingId, binding);
      setRecordingId(null);
      setCaptureMessage("");
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [recordingId, settings, t, updateBinding]);

  const hasCustomizations = useMemo(() => Object.keys(customizations).length > 0, [customizations]);

  return (
    <div className="rounded-xl border border-slate-200 bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <Keyboard className={SETTINGS_ITEM_ICON_CLASSNAME} />
          <div className="min-w-0">
            <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("shortcuts.editorShortcuts.title")}</div>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{t("shortcuts.editorShortcuts.description")}</p>
          </div>
        </div>
        {hasCustomizations && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 px-2 text-xs text-slate-600"
            onClick={() => {
              reset();
              setRecordingId(null);
              setCaptureMessage("");
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("shortcuts.resetSection")}
          </Button>
        )}
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2">
        {EDITOR_SHORTCUT_IDS.map((id) => {
          const recording = recordingId === id;
          const customized = id in customizations;

          return (
            <div
              key={id}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                <span className="truncate">{t(EDITOR_SHORTCUT_I18N_KEYS[id])}</span>
                {customized && (
                  <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    {t("shortcuts.customized")}
                  </span>
                )}
              </span>
              <Button
                ref={recording ? setCaptureButtonNode : undefined}
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
        <div className="mx-4 mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
          {captureMessage}
        </div>
      ) : null}
    </div>
  );
};
