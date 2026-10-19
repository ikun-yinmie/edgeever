import { describe, expect, test } from "bun:test";
import { zhCN } from "./zh-CN.ts";

describe("editor theme labels", () => {
  test("keeps Chinese preset names at four characters", () => {
    for (const [id, label] of Object.entries(zhCN.settings.editorThemes)) {
      // `followDevice` is the article's "use the device theme" option, not a preset name.
      if (id === "followDevice") continue;
      expect(label, id).toHaveLength(4);
    }
    expect(zhCN.settings.customEditorTheme.defaultName).toHaveLength(4);
  });
});
