import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const toolbarSource = readFileSync(new URL("./EditorToolbar.tsx", import.meta.url), "utf8");
const editorPaneSource = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const phonePreviewSource = readFileSync(new URL("./EditorPhonePreview.tsx", import.meta.url), "utf8");
const publicShareSource = readFileSync(new URL("./PublicSharePage.tsx", import.meta.url), "utf8");
const themeProviderSource = readFileSync(new URL("./ThemeProvider.tsx", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../../packages/shared/src/i18n/zh-CN.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../../packages/shared/src/i18n/en-US.ts", import.meta.url), "utf8");
const jaSource = readFileSync(new URL("../../../../packages/shared/src/i18n/ja.ts", import.meta.url), "utf8");

describe("article theme binding", () => {
  test("only built-in named themes can be bound to an article", () => {
    expect(themeProviderSource).toContain(
      "export const resolveMemoEditorTheme = (theme: string | null | undefined): EditorThemeName | null =>",
    );
    expect(themeProviderSource).toContain("isNamedEditorTheme(theme) ? theme : null");
  });

  test("the toolbar edits the article theme with the native theme as its default", () => {
    expect(toolbarSource).not.toContain("MEMO_THEME_FOLLOW_DEVICE");
    expect(toolbarSource).not.toContain("followDevice");
    expect(toolbarSource).toContain("const memoThemeMode = typeof onMemoThemeChange === \"function\";");
    expect(toolbarSource).toContain('const themeSelectValue = memoThemeMode ? (memoTheme ?? NATIVE_EDITOR_THEME) : editorTheme;');
    expect(toolbarSource).toContain("onMemoThemeChange(value);");
    expect(toolbarSource).toContain('const NATIVE_EDITOR_THEME = "default";');
  });

  test("the editor resolves the article theme with the native theme as its fallback", () => {
    expect(editorPaneSource).toContain("const memoEditorTheme = resolveMemoEditorTheme(memo?.theme ?? null);");
    expect(editorPaneSource).toContain('const resolvedEditorTheme = memoEditorTheme ?? "default";');
    expect(editorPaneSource).not.toContain("memoEditorTheme ?? editorTheme");
    expect(editorPaneSource).toContain("repository.setMemoTheme(currentMemo.id, theme)");
    expect(editorPaneSource).toContain("data-editor-theme={isNamedEditorTheme(resolvedEditorTheme) ? resolvedEditorTheme : \"custom\"}");
    expect(editorPaneSource).toContain("memoTheme={effectiveReadOnly ? undefined : memoEditorTheme}");
    expect(editorPaneSource).toContain("onMemoThemeChange={effectiveReadOnly ? undefined : handleMemoThemeChange}");
    expect(editorPaneSource).toContain("editorTheme={resolvedEditorTheme}");
  });

  test("the phone preview follows the article theme while the device preference stays the fallback", () => {
    expect(phonePreviewSource).toContain("editorTheme?: string;");
    expect(phonePreviewSource).toContain("const editorTheme = editorThemeOverride ?? deviceEditorTheme;");
  });

  test("a public share renders with the article theme", () => {
    expect(publicShareSource).toContain("const shareEditorTheme = resolveMemoEditorTheme(share.theme ?? null);");
    expect(publicShareSource).toContain("data-editor-theme={shareEditorTheme ?? \"default\"}");
    expect(publicShareSource).toContain("data-paper-theme={isPaperEditorTheme(shareEditorTheme) ? \"true\" : undefined}");
  });

  test("no longer ships the follow-device label in any locale", () => {
    for (const source of [zhSource, enSource, jaSource]) {
      expect(source).not.toContain("followDevice:");
    }
  });
});
