import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { getDesktopUpdateDownloadLabel } from "./desktop-update-progress";
import { zhCN } from "../../../../packages/shared/src/i18n/zh-CN";
import { enUS } from "../../../../packages/shared/src/i18n/en-US";
import { ja } from "../../../../packages/shared/src/i18n/ja";

const i18n = createInstance();
await i18n.init({ lng: "zh-CN", resources: {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
  ja: { translation: ja },
} });
const t = i18n.getFixedT("zh-CN");

describe("desktop download progress labels", () => {
  test("shows the percentage, downloaded size and total size", () => {
    expect(getDesktopUpdateDownloadLabel({ percent: 25, transferred: 25 * 1024 ** 2, total: 100 * 1024 ** 2 }, t))
      .toBe("正在下载更新… · 25.0% · 已下载 25.0 MB / 总大小 100.0 MB");
  });

  test("supports older bridges and downloads with unknown totals", () => {
    expect(getDesktopUpdateDownloadLabel(undefined, t)).toBe("正在下载更新… · 已下载 0 B / 总大小 未知");
    expect(getDesktopUpdateDownloadLabel({ percent: null, transferred: 1024, total: null }, t))
      .toBe("正在下载更新… · 已下载 1.00 KB / 总大小 未知");
  });

  test("shows a real zero and completion, without NaN percentages", () => {
    expect(getDesktopUpdateDownloadLabel({ percent: 0, transferred: 0, total: 100 }, t))
      .toContain("0.0% · 已下载 0 B / 总大小 100 B");
    expect(getDesktopUpdateDownloadLabel({ percent: 100, transferred: 100, total: 100 }, t)).toContain("100.0%");
    expect(getDesktopUpdateDownloadLabel({ percent: NaN, transferred: 0, total: 0 }, t)).not.toContain("NaN");
  });

  test("localizes the same progress in English and Japanese", () => {
    const progress = { percent: 50, transferred: 50, total: 100 };
    expect(getDesktopUpdateDownloadLabel(progress, i18n.getFixedT("en-US"))).toContain("Downloaded 50 B / Total 100 B");
    expect(getDesktopUpdateDownloadLabel(progress, i18n.getFixedT("ja"))).toContain("ダウンロード済み 50 B / 合計 100 B");
  });
});
