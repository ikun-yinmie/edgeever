import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const menuSource = readFileSync(new URL("./EditorInlineStyleMenu.tsx", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("./EditorToolbar.tsx", import.meta.url), "utf8");
const settingsCardSource = readFileSync(new URL("./settings/EditorShortcutSettingsCard.tsx", import.meta.url), "utf8");
const adminCardSource = readFileSync(new URL("./settings/EditorShortcutsAdminCard.tsx", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../../packages/shared/src/i18n/zh-CN.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../../packages/shared/src/i18n/en-US.ts", import.meta.url), "utf8");
const jaSource = readFileSync(new URL("../../../../packages/shared/src/i18n/ja.ts", import.meta.url), "utf8");

describe("editor font size controls", () => {
  test("keeps the custom size input as the first entry of the size dropdown", () => {
    const normalized = menuSource.replace(/\s+/g, " ");
    const customIndex = normalized.indexOf("editorToolbar.fontSizeCustom");
    const presetsIndex = normalized.indexOf("{FONT_SIZES.map(");
    expect(customIndex).toBeGreaterThan(-1);
    expect(presetsIndex).toBeGreaterThan(customIndex);
    expect(normalized).toContain("clampFontSizePx(parsedCustom)");
    expect(normalized).toContain("min={FONT_SIZE_PX_MIN}");
    expect(normalized).toContain("max={FONT_SIZE_PX_MAX}");
  });

  test("shares one scale between the dropdown, the step buttons and the shortcuts", () => {
    expect(menuSource).toContain("const FONT_SIZES = FONT_SIZE_SCALE.map((size) => `${size}px`)");
    expect(menuSource).toContain("export const EditorFontSizeStepButtons");
    expect(menuSource).toContain("stepFontSizePx(current, direction)");
    const stepButtonsIndex = toolbarSource.indexOf("<EditorFontSizeStepButtons");
    const sizeMenuIndex = toolbarSource.indexOf("<EditorFontSizeMenu");
    expect(sizeMenuIndex).toBeGreaterThan(-1);
    expect(stepButtonsIndex).toBeGreaterThan(sizeMenuIndex);
  });

  test("lists the increase and decrease shortcuts in both shortcut settings surfaces", () => {
    for (const source of [settingsCardSource, adminCardSource]) {
      expect(source).toContain('"font-size-increase": "editorToolbar.fontSizeIncrease"');
      expect(source).toContain('"font-size-decrease": "editorToolbar.fontSizeDecrease"');
    }
  });

  test("ships the new labels in every locale, next to the existing size labels", () => {
    for (const [source, apply] of [[zhSource, "应用"], [enSource, "Apply"], [jaSource, "適用"]]) {
      const normalized = source.replace(/\s+/g, " ");
      expect(normalized).toContain(`fontSizeApply: "${apply}"`);
      expect(normalized).toMatch(/fontSizeReset: "[^"]+", fontSizeIncrease: "[^"]+", fontSizeDecrease: "[^"]+", fontSizeCustom: "[^"]+", fontSizeApply: "[^"]+"/);
    }
  });
});
