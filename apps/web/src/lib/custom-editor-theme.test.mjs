import { describe, expect, test } from "bun:test";
import {
  CUSTOM_EDITOR_THEME_FILE_SCHEMA,
  CUSTOM_EDITOR_THEME_FILE_VERSION,
  CustomEditorThemeFileError,
  DEFAULT_CUSTOM_EDITOR_THEME_NAME,
  DEFAULT_CUSTOM_LIGHT_COLORS,
  DEFAULT_CUSTOM_DARK_COLORS,
  THEME_BACKGROUND_IMAGE_MAX_DATA_URL_BYTES,
  THEME_BACKGROUND_IMAGE_MAX_OVERLAY,
  buildBackgroundImageVars,
  isValidThemeBackgroundImage,
  localizeStoredCustomThemeName,
  normalizeThemeBackgroundImage,
  normalizeThemeColors,
  customEditorThemeFileName,
  getEditorThemeContrastIssues,
  parseCustomEditorThemeFile,
  serializeCustomEditorTheme,
  validateBackgroundImageFile,
} from "./custom-editor-theme.ts";

const theme = {
  id: "custom-local-only",
  name: "Calm / Green",
  light: {
    background: "#ffffff",
    text: "#111111",
    muted: "#444444",
    heading: "#000000",
    accent: "#087f5b",
    soft: "#f1f5f9",
    codeBackground: "#e2e8f0",
    border: "#cbd5e1",
  },
  dark: {
    background: "#111111",
    text: "#f8fafc",
    muted: "#cbd5e1",
    heading: "#ffffff",
    accent: "#34d399",
    soft: "#1f2937",
    codeBackground: "#303b49",
    border: "#475569",
  },
  customCss: "h1 { font-style: italic; }",
};

describe("custom editor theme files", () => {
  test("round-trips a versioned theme without exporting its local id", () => {
    const serialized = serializeCustomEditorTheme(theme);
    const document = JSON.parse(serialized);

    expect(document.schema).toBe(CUSTOM_EDITOR_THEME_FILE_SCHEMA);
    expect(document.version).toBe(CUSTOM_EDITOR_THEME_FILE_VERSION);
    expect(document.id).toBeUndefined();
    expect(parseCustomEditorThemeFile(serialized)).toEqual({
      name: theme.name,
      light: theme.light,
      dark: theme.dark,
      customCss: theme.customCss,
    });
  });

  test("migrates old version 1 files using each mode's existing palette", () => {
    const legacy = JSON.parse(serializeCustomEditorTheme(theme));
    delete legacy.light.codeBackground;
    delete legacy.dark.codeBackground;
    const imported = parseCustomEditorThemeFile(JSON.stringify(legacy));
    for (const [mode, fallback] of [["light", DEFAULT_CUSTOM_LIGHT_COLORS], ["dark", DEFAULT_CUSTOM_DARK_COLORS]]) {
      const normalized = normalizeThemeColors(legacy[mode], fallback);
      expect(imported[mode]).toEqual(normalized);
      expect(normalized.codeBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(normalized.codeBackground).not.toBe(normalized.soft);
      for (const field of Object.keys(legacy[mode])) expect(normalized[field]).toBe(legacy[mode][field]);
    }
    expect(imported.light.codeBackground).not.toBe(imported.dark.codeBackground);
  });

  test("preserves chosen code backgrounds and rejects malformed imported values", () => {
    expect(normalizeThemeColors(theme.light, DEFAULT_CUSTOM_LIGHT_COLORS)).toEqual(theme.light);
    for (const invalid of ["red", "", null, 123]) {
      const document = JSON.parse(serializeCustomEditorTheme(theme));
      document.dark.codeBackground = invalid;
      expect(() => parseCustomEditorThemeFile(JSON.stringify(document))).toThrow(CustomEditorThemeFileError);
    }
  });

  test("warns when code text is unreadable on its own background", () => {
    expect(getEditorThemeContrastIssues({ ...theme.light, codeBackground: theme.light.text })).toEqual(["codeBackground"]);
  });

  test("rejects invalid colors and unsupported versions", () => {
    const invalidColor = JSON.parse(serializeCustomEditorTheme(theme));
    invalidColor.light.text = "red";
    expect(() => parseCustomEditorThemeFile(JSON.stringify(invalidColor))).toThrow(CustomEditorThemeFileError);

    const unsupported = JSON.parse(serializeCustomEditorTheme(theme));
    unsupported.version = 2;
    try {
      parseCustomEditorThemeFile(JSON.stringify(unsupported));
      throw new Error("Expected an unsupported version error");
    } catch (error) {
      expect(error).toBeInstanceOf(CustomEditorThemeFileError);
      expect(error.code).toBe("unsupportedVersion");
    }
  });

  test("reports low contrast without making the theme structurally invalid", () => {
    expect(getEditorThemeContrastIssues({ ...theme.light, text: "#fefefe", accent: "#eeeeee" }))
      .toEqual(["text", "accent", "codeBackground"]);
  });

  test("creates a filesystem-safe descriptive filename", () => {
    expect(customEditorThemeFileName(theme.name)).toBe("EdgeEver-Calm - Green.json");
  });

  test("localizes factory custom theme names without rewriting user names", () => {
    const copy = { defaultName: "自定主题", newName: (index) => `新主题 ${index}` };
    expect(localizeStoredCustomThemeName(DEFAULT_CUSTOM_EDITOR_THEME_NAME, copy)).toBe("自定主题");
    expect(localizeStoredCustomThemeName("New theme 2", copy)).toBe("新主题 2");
    expect(localizeStoredCustomThemeName("Calm / Green", copy)).toBe("Calm / Green");
  });
});

describe("theme background images", () => {
  const dataUrl = "data:image/jpeg;base64,/9j/4AAQ";

  test("pre-validates uploads before paying for decode", () => {
    expect(validateBackgroundImageFile({ type: "image/png", size: 1024 })).toBe(null);
    expect(validateBackgroundImageFile({ type: "image/webp", size: 12 * 1024 * 1024 })).toBe(null);
    expect(validateBackgroundImageFile({ type: "image/png", size: 12 * 1024 * 1024 + 1 })).toBe("fileTooLarge");
    expect(validateBackgroundImageFile({ type: "application/pdf", size: 1024 })).toBe("invalidType");
    expect(validateBackgroundImageFile({ type: "", size: 1024 })).toBe("invalidType");
    expect(validateBackgroundImageFile({ type: "image/png", size: 0 })).toBe("invalidType");
  });

  test("accepts well-formed images and rejects junk", () => {
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: 82 })).toBe(true);
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: 0 })).toBe(true);
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: THEME_BACKGROUND_IMAGE_MAX_OVERLAY })).toBe(true);
    expect(isValidThemeBackgroundImage(undefined)).toBe(false);
    expect(isValidThemeBackgroundImage(null)).toBe(false);
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: -1 })).toBe(false);
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: 91 })).toBe(false);
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: Number.NaN })).toBe(false);
    expect(isValidThemeBackgroundImage({ dataUrl: "data:text/plain;base64,xx", overlay: 50 })).toBe(false);
    expect(isValidThemeBackgroundImage({ dataUrl: "https://example.com/bg.jpg", overlay: 50 })).toBe(false);
    expect(isValidThemeBackgroundImage({ dataUrl, overlay: 50, extra: 1 })).toBe(true);
  });

  test("normalizes stored images and drops malformed ones", () => {
    expect(normalizeThemeBackgroundImage({ dataUrl, overlay: 82.6 })).toEqual({ dataUrl, overlay: 83 });
    expect(normalizeThemeBackgroundImage(undefined)).toBe(undefined);
    expect(normalizeThemeBackgroundImage({ dataUrl: "nope", overlay: 10 })).toBe(undefined);
  });

  test("builds injectable canvas variables", () => {
    expect(buildBackgroundImageVars({ dataUrl, overlay: 82 })).toEqual({
      "--editor-theme-bg-image": `url("${dataUrl}")`,
      "--editor-theme-bg-overlay": "82%",
    });
  });

  test("round-trips an image through export and import", () => {
    const withImage = { ...theme, backgroundImage: { dataUrl, overlay: 70 } };
    const document = JSON.parse(serializeCustomEditorTheme(withImage));
    expect(document.backgroundImage).toEqual({ dataUrl, overlay: 70 });
    expect(parseCustomEditorThemeFile(JSON.stringify(document)).backgroundImage).toEqual({ dataUrl, overlay: 70 });
  });

  test("omits the image key for plain themes and rejects bad imports", () => {
    expect("backgroundImage" in JSON.parse(serializeCustomEditorTheme(theme))).toBe(false);
    const bad = JSON.parse(serializeCustomEditorTheme({ ...theme, backgroundImage: { dataUrl, overlay: 70 } }));
    bad.backgroundImage.overlay = 500;
    expect(() => parseCustomEditorThemeFile(JSON.stringify(bad))).toThrow(CustomEditorThemeFileError);
    bad.backgroundImage = { dataUrl: "data:image/jpeg;base64," + "A".repeat(THEME_BACKGROUND_IMAGE_MAX_DATA_URL_BYTES), overlay: 10 };
    expect(() => parseCustomEditorThemeFile(JSON.stringify(bad))).toThrow(CustomEditorThemeFileError);
  });
});
