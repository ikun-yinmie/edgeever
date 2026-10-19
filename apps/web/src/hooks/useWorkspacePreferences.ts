import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MEMO_LIST_WIDTH_PX,
  DEFAULT_NOTEBOOK_SIDEBAR_WIDTH_PX,
  clampMemoListWidth,
  clampNotebookSidebarWidth,
  readDesktopFocusModePreference,
  readEditorContentAlignmentPreference,
  readImageCompressionPreference,
  readMemoListWidthPreference,
  readNotebookSidebarCollapsedPreference,
  readNotebookSidebarWidthPreference,
  writeDesktopFocusModePreference,
  writeEditorContentAlignmentPreference,
  writeImageCompressionPreference,
  writeMemoListWidthPreference,
  writeNotebookSidebarCollapsedPreference,
  writeNotebookSidebarWidthPreference,
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
  const [notebookSidebarWidth, setNotebookSidebarWidthState] = useState(readNotebookSidebarWidthPreference);

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

  const setNotebookSidebarWidth = useCallback((width: number) => {
    const nextWidth = clampNotebookSidebarWidth(width);
    setNotebookSidebarWidthState(nextWidth);
    writeNotebookSidebarWidthPreference(nextWidth);
  }, []);

  const resetNotebookSidebarWidth = useCallback(() => {
    setNotebookSidebarWidth(DEFAULT_NOTEBOOK_SIDEBAR_WIDTH_PX);
  }, [setNotebookSidebarWidth]);

  return {
    desktopFocusMode,
    editorContentAlignment,
    imageCompressionEnabled,
    memoListWidth,
    notebookSidebarCollapsed,
    notebookSidebarWidth,
    resetMemoListWidth,
    resetNotebookSidebarWidth,
    setDesktopFocusMode,
    setEditorContentAlignment,
    setImageCompressionEnabled,
    setMemoListWidth,
    setNotebookSidebarCollapsed,
    setNotebookSidebarWidth,
    shortcutSettings,
  };
};
