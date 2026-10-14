import { contrastRatio } from "./color-contrast";

export interface ThemeColors {
  background: string;
  text: string;
  muted: string;
  heading: string;
  accent: string;
  soft: string;
  codeBackground: string;
  border: string;
}

export interface CustomEditorTheme {
  id: string;
  name: string;
  light: ThemeColors;
  dark: ThemeColors;
  customCss?: string;
  backgroundImage?: ThemeBackgroundImage;
}

/** Editor backdrop image, stored downscaled so it fits browser storage. */
export interface ThemeBackgroundImage {
  /** Downscaled JPEG data URL. */
  dataUrl: string;
  /** Scrim strength over the image (0-90); higher keeps text readable. */
  overlay: number;
}

export const THEME_BACKGROUND_IMAGE_MAX_INPUT_BYTES = 12 * 1024 * 1024;
export const THEME_BACKGROUND_IMAGE_MAX_DIMENSION = 1600;
export const THEME_BACKGROUND_IMAGE_JPEG_QUALITY = 0.78;
export const THEME_BACKGROUND_IMAGE_MAX_DATA_URL_BYTES = 380 * 1024;
export const THEME_BACKGROUND_IMAGE_MAX_OVERLAY = 90;
export const THEME_BACKGROUND_IMAGE_DEFAULT_OVERLAY = 82;

const BACKGROUND_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export type BackgroundImageFileErrorCode = "invalidType" | "fileTooLarge" | "processFailed" | "outputTooLarge";

/** Pre-check an upload before paying for decode/resize. */
export const validateBackgroundImageFile = (file: { type: string; size: number }): BackgroundImageFileErrorCode | null => {
  if (typeof file.type !== "string" || !file.type.startsWith("image/")) return "invalidType";
  if (!Number.isFinite(file.size) || file.size <= 0) return "invalidType";
  if (file.size > THEME_BACKGROUND_IMAGE_MAX_INPUT_BYTES) return "fileTooLarge";
  return null;
};

export const isValidThemeBackgroundImage = (value: unknown): value is ThemeBackgroundImage =>
  isRecord(value)
  && typeof value.dataUrl === "string"
  && value.dataUrl.length <= THEME_BACKGROUND_IMAGE_MAX_DATA_URL_BYTES
  && BACKGROUND_IMAGE_DATA_URL_PATTERN.test(value.dataUrl)
  && typeof value.overlay === "number"
  && Number.isFinite(value.overlay)
  && value.overlay >= 0
  && value.overlay <= THEME_BACKGROUND_IMAGE_MAX_OVERLAY;

export const normalizeThemeBackgroundImage = (value: unknown): ThemeBackgroundImage | undefined =>
  isValidThemeBackgroundImage(value)
    ? { dataUrl: value.dataUrl, overlay: Math.round(value.overlay) }
    : undefined;

/** CSS variable values consumed by the editor canvas (see base.css). */
export const buildBackgroundImageVars = (image: ThemeBackgroundImage): Record<string, string> => ({
  "--editor-theme-bg-image": `url("${image.dataUrl}")`,
  "--editor-theme-bg-overlay": `${Math.round(image.overlay)}%`,
});

/**
 * Downscale an uploaded picture to a storage-safe JPEG data URL. Canvas-only
 * (called from the theme dialog, never on a hot path).
 */
export const downscaleImageToDataUrl = async (file: Blob): Promise<string> => {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image cannot be decoded."));
    });
    const scale = Math.min(1, THEME_BACKGROUND_IMAGE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Image has no dimensions.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2d context is unavailable.");
      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", THEME_BACKGROUND_IMAGE_JPEG_QUALITY);
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const DEFAULT_CUSTOM_LIGHT_COLORS: ThemeColors = {
  background: "#fffdf7",
  text: "#292524",
  muted: "#57534e",
  heading: "#1c1917",
  accent: "#0f766e",
  soft: "#f0fdfa",
  codeBackground: "#e0ece9",
  border: "#99f6e4",
};

export const DEFAULT_CUSTOM_DARK_COLORS: ThemeColors = {
  background: "#1c1917",
  text: "#fafaf9",
  muted: "#d6d3d1",
  heading: "#fafaf9",
  accent: "#2dd4bf",
  soft: "#292524",
  codeBackground: "#3a3635",
  border: "#44403c",
};

export const DEFAULT_CUSTOM_EDITOR_THEME_NAME = "My custom theme";

export const DEFAULT_CUSTOM_EDITOR_THEME: CustomEditorTheme = {
  id: "custom-default",
  name: DEFAULT_CUSTOM_EDITOR_THEME_NAME,
  light: DEFAULT_CUSTOM_LIGHT_COLORS,
  dark: DEFAULT_CUSTOM_DARK_COLORS,
  customCss: "",
};

const NEW_THEME_NAME_PATTERN = /^New theme (\d+)$/;

export const localizeStoredCustomThemeName = (
  name: string,
  copy: { defaultName: string; newName: (index: number) => string },
) => {
  if (name === DEFAULT_CUSTOM_EDITOR_THEME_NAME) return copy.defaultName;
  const match = NEW_THEME_NAME_PATTERN.exec(name);
  if (match) return copy.newName(Number(match[1]));
  return name;
};

export const CUSTOM_EDITOR_THEME_FILE_SCHEMA = "edgeever.editor-theme";
export const CUSTOM_EDITOR_THEME_FILE_VERSION = 1;
export const MAX_CUSTOM_EDITOR_THEME_FILE_BYTES = 512 * 1024;
export const MAX_CUSTOM_EDITOR_THEME_CSS_LENGTH = 2000;
/** Draft budget below the browser store ceiling, checked before saving. */
export const MAX_CUSTOM_THEME_DRAFT_BYTES = 450 * 1024;

const LEGACY_COLOR_FIELDS = ["background", "text", "muted", "heading", "accent", "soft", "border"] as const;
const COLOR_FIELDS = [...LEGACY_COLOR_FIELDS, "codeBackground"] as const;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

type PortableCustomEditorTheme = Omit<CustomEditorTheme, "id">;

export type EditorThemeContrastIssue = "text" | "muted" | "heading" | "accent" | "codeBackground";
export type CustomEditorThemeFileErrorCode = "invalidFile" | "unsupportedVersion" | "fileTooLarge";

export class CustomEditorThemeFileError extends Error {
  readonly code: CustomEditorThemeFileErrorCode;

  constructor(code: CustomEditorThemeFileErrorCode, message: string) {
    super(message);
    this.name = "CustomEditorThemeFileError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isValidThemeColors = (value: unknown): value is ThemeColors =>
  isRecord(value) && COLOR_FIELDS.every((field) => typeof value[field] === "string" && HEX_COLOR_PATTERN.test(value[field]));

// Follow the existing palette: darken light quote surfaces and lighten dark ones.
const deriveCodeBackground = (soft: string, text: string) => `#${[1, 3, 5].map((offset) =>
  Math.round(Number.parseInt(soft.slice(offset, offset + 2), 16) * 0.92
    + Number.parseInt(text.slice(offset, offset + 2), 16) * 0.08).toString(16).padStart(2, "0"),
).join("")}`;

export const normalizeThemeColors = (value: Partial<ThemeColors> | undefined, fallback: ThemeColors): ThemeColors => {
  const colors = { ...fallback };
  for (const field of COLOR_FIELDS) {
    const color = value?.[field];
    if (typeof color === "string" && HEX_COLOR_PATTERN.test(color)) colors[field] = color;
  }
  if (typeof value?.codeBackground !== "string" || !HEX_COLOR_PATTERN.test(value.codeBackground)) {
    colors.codeBackground = deriveCodeBackground(colors.soft, colors.text);
  }
  return colors;
};

const isValidImportedThemeColors = (value: unknown): value is Partial<ThemeColors> =>
  isRecord(value)
  && LEGACY_COLOR_FIELDS.every((field) => typeof value[field] === "string" && HEX_COLOR_PATTERN.test(value[field]))
  && (value.codeBackground === undefined || (typeof value.codeBackground === "string" && HEX_COLOR_PATTERN.test(value.codeBackground)));

export const getEditorThemeContrastIssues = (colors: ThemeColors): EditorThemeContrastIssue[] => {
  const issues: EditorThemeContrastIssue[] = [];
  if (contrastRatio(colors.text, colors.background) < 4.5) issues.push("text");
  if (contrastRatio(colors.muted, colors.soft) < 4.5) issues.push("muted");
  if (contrastRatio(colors.heading, colors.background) < 4.5) issues.push("heading");
  if (contrastRatio(colors.accent, colors.background) < 3) issues.push("accent");
  if (contrastRatio(colors.text, colors.codeBackground) < 4.5) issues.push("codeBackground");
  return issues;
};

export const serializeCustomEditorTheme = (theme: CustomEditorTheme) => JSON.stringify({
  schema: CUSTOM_EDITOR_THEME_FILE_SCHEMA,
  version: CUSTOM_EDITOR_THEME_FILE_VERSION,
  name: theme.name,
  light: theme.light,
  dark: theme.dark,
  customCss: theme.customCss ?? "",
  ...(theme.backgroundImage ? { backgroundImage: theme.backgroundImage } : {}),
}, null, 2);

export const parseCustomEditorThemeFile = (source: string): PortableCustomEditorTheme => {
  if (new TextEncoder().encode(source).byteLength > MAX_CUSTOM_EDITOR_THEME_FILE_BYTES) {
    throw new CustomEditorThemeFileError("fileTooLarge", "Editor theme file is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new CustomEditorThemeFileError("invalidFile", "Editor theme file must contain valid JSON.");
  }
  if (!isRecord(parsed) || parsed.schema !== CUSTOM_EDITOR_THEME_FILE_SCHEMA) {
    throw new CustomEditorThemeFileError("invalidFile", "Editor theme file has an invalid schema.");
  }
  if (parsed.version !== CUSTOM_EDITOR_THEME_FILE_VERSION) {
    throw new CustomEditorThemeFileError("unsupportedVersion", "Editor theme file version is not supported.");
  }
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0 || parsed.name.trim().length > 32) {
    throw new CustomEditorThemeFileError("invalidFile", "Editor theme name must contain 1 to 32 characters.");
  }
  if (!isValidImportedThemeColors(parsed.light) || !isValidImportedThemeColors(parsed.dark)) {
    throw new CustomEditorThemeFileError("invalidFile", "Editor theme colors must use six-digit hex values.");
  }
  if (parsed.customCss !== undefined && (typeof parsed.customCss !== "string" || parsed.customCss.length > MAX_CUSTOM_EDITOR_THEME_CSS_LENGTH)) {
    throw new CustomEditorThemeFileError("invalidFile", "Editor theme CSS is invalid or too long.");
  }
  if (parsed.backgroundImage !== undefined && !isValidThemeBackgroundImage(parsed.backgroundImage)) {
    throw new CustomEditorThemeFileError("invalidFile", "Editor theme background image is invalid.");
  }

  return {
    name: parsed.name.trim(),
    light: normalizeThemeColors(parsed.light, DEFAULT_CUSTOM_LIGHT_COLORS),
    dark: normalizeThemeColors(parsed.dark, DEFAULT_CUSTOM_DARK_COLORS),
    customCss: parsed.customCss ?? "",
    backgroundImage: normalizeThemeBackgroundImage(parsed.backgroundImage),
  };
};

export const customEditorThemeFileName = (name: string) => {
  const safeName = name
    .trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "custom-theme";
  return `EdgeEver-${safeName}.json`;
};
