import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
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
  SETTINGS_ITEM_DESCRIPTION_CLASSNAME,
  SETTINGS_ITEM_TITLE_CLASSNAME,
} from "./settings-ui";

type EditorShortcutSectionProps = {
  recordingId: EditorShortcutId | null;
  onRecordingChange: (id: EditorShortcutId | null) => void;
  captureMessage: string;
  onCaptureMessageChange: (message: string) => void;
  captureButtonRef: (node: HTMLButtonElement | null) => void;
};

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

export const useEditorShortcutSettingsState = () => {
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

export const EditorShortcutSettingsSection = ({
  recordingId,
  onRecordingChange,
  captureMessage,
  onCaptureMessageChange,
  captureButtonRef,
}: EditorShortcutSectionProps) => {
  const { t } = useTranslation();
  const { settings, customizations, updateBinding, reset } = useEditorShortcutSettingsState();

  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        onRecordingChange(null);
        onCaptureMessageChange("");
        return;
      }

      const binding = shortcutBindingFromKeyboardEvent(event);
      if (!binding) {
        onCaptureMessageChange(t("shortcuts.requireModifier"));
        return;
      }

      const conflict = EDITOR_SHORTCUT_IDS.find(
        (id) => id !== recordingId && editorShortcutBindingsEqual(settings[id], binding),
      );
      if (conflict) {
        onCaptureMessageChange(
          t("shortcuts.conflict", { label: t(EDITOR_SHORTCUT_I18N_KEYS[conflict]) }),
        );
        return;
      }

      updateBinding(recordingId, binding);
      onRecordingChange(null);
      onCaptureMessageChange("");
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, settings]);

  const hasCustomizations = Object.keys(customizations).length > 0;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("shortcuts.editorSection")}</div>
        {hasCustomizations && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => {
              reset();
              onRecordingChange(null);
              onCaptureMessageChange("");
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("shortcuts.resetSection")}
          </Button>
        )}
      </div>
      {EDITOR_SHORTCUT_IDS.map((id) => {
        const recording = recordingId === id;
        const customized = id in customizations;

        return (
          <div
            key={id}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className={cn(SETTINGS_ITEM_TITLE_CLASSNAME, "flex items-center gap-2")}>
                {t(EDITOR_SHORTCUT_I18N_KEYS[id])}
                {customized && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    {t("shortcuts.customized")}
                  </span>
                )}
              </div>
            </div>
            <Button
              ref={recording ? captureButtonRef : undefined}
              type="button"
              variant={recording ? "solid" : "outline"}
              className={cn("h-9 min-w-32 px-3 font-mono text-xs", !recording && "bg-card")}
              onClick={() => {
                onRecordingChange(recording ? null : id);
                onCaptureMessageChange("");
              }}
            >
              {recording ? t("shortcuts.recording") : formatShortcutBinding(settings[id])}
            </Button>
          </div>
        );
      })}
      {captureMessage ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
          {captureMessage}
        </div>
      ) : null}
    </div>
  );
};
