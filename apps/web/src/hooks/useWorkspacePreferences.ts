import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MEMO_LIST_WIDTH_PX,
  clampMemoListWidth,
  readDesktopFocusModePreference,
  readEditorContentAlignmentPreference,
  readImageCompressionPreference,
  readMemoListWidthPreference,
  readNotebookSidebarCollapsedPreference,
  writeDesktopFocusModePreference,
  writeEditorContentAlignmentPreference,
  writeImageCompressionPreference,
  writeMemoListWidthPreference,
  writeNotebookSidebarCollapsedPreference,
  type ShortcutSettings,
  type EditorContentAlignment,
} from "@/lib/app-helpers";
import {
  SHORTCUT_SETTINGS_CHANGED_EVENT,
  resolveShortcutSettings,
} from "@/lib/shortcut-settings";

export const useWorkspacePreferences = () => {
  const [imageCompressionEnabled, setImageCompressionEnabled] = useState(readImageCompressionPreference);
  const [desktopFocusMode, setDesktopFocusModeState] = useState(readDesktopFocusModePreference);
  const [notebookSidebarCollapsed, setNotebookSidebarCollapsedState] = useState(readNotebookSidebarCollapsedPreference);
  const [editorContentAlignment, setEditorContentAlignmentState] = useState(readEditorContentAlignmentPreference);
  const [shortcutSettings, setShortcutSettingsState] = useState<ShortcutSettings>(resolveShortcutSettings);
  const [memoListWidth, setMemoListWidthState] = useState(readMemoListWidthPreference);

  useEffect(() => writeImageCompressionPreference(imageCompressionEnabled), [imageCompressionEnabled]);

  // Keep the resolved shortcut settings in sync with personal edits and admin
  // default updates; both paths broadcast the same change event.
  useEffect(() => {
    const syncShortcutSettings = () => setShortcutSettingsState(resolveShortcutSettings());
    window.addEventListener(SHORTCUT_SETTINGS_CHANGED_EVENT, syncShortcutSettings);
    window.addEventListener("storage", syncShortcutSettings);
    return () => {
      window.removeEventListener(SHORTCUT_SETTINGS_CHANGED_EVENT, syncShortcutSettings);
      window.removeEventListener("storage", syncShortcutSettings);
    };
  }, []);

  /**
   * Persist a full settings snapshot as personal overrides: entries matching
   * the effective default (builtin + instance) are dropped so the action
   * follows the default again.
   */
  const setDesktopFocusMode = useCallback((enabled: boolean) => {
    setDesktopFocusModeState(enabled);
    writeDesktopFocusModePreference(enabled);
  }, []);

  const setNotebookSidebarCollapsed = useCallback((collapsed: boolean) => {
    setNotebookSidebarCollapsedState(collapsed);
    writeNotebookSidebarCollapsedPreference(collapsed);
  }, []);

  const setEditorContentAlignment = useCallback((alignment: EditorContentAlignment) => {
    setEditorContentAlignmentState(alignment);
    writeEditorContentAlignmentPreference(alignment);
  }, []);

  const setMemoListWidth = useCallback((width: number) => {
    const nextWidth = clampMemoListWidth(width);
    setMemoListWidthState(nextWidth);
    writeMemoListWidthPreference(nextWidth);
  }, []);

  const resetMemoListWidth = useCallback(() => {
    setMemoListWidth(DEFAULT_MEMO_LIST_WIDTH_PX);
  }, [setMemoListWidth]);

  return {
    desktopFocusMode,
    editorContentAlignment,
    imageCompressionEnabled,
    memoListWidth,
    notebookSidebarCollapsed,
    resetMemoListWidth,
    setDesktopFocusMode,
    setEditorContentAlignment,
    setImageCompressionEnabled,
    setMemoListWidth,
    setNotebookSidebarCollapsed,
    shortcutSettings,
  };
};
