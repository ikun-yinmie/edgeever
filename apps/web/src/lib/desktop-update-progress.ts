import { formatAttachmentByteSize } from "@edgeever/shared";
import type { TFunction } from "i18next";

export const getDesktopUpdateDownloadPercent = (progress: DesktopUpdateStatus["downloadProgress"]) =>
  typeof progress?.percent === "number" && Number.isFinite(progress.percent)
    ? `${Math.min(100, Math.max(0, progress.percent)).toFixed(1)}%`
    : null;

/** A shared label for settings, system info, and the always-visible update notice. */
export const getDesktopUpdateDownloadLabel = (
  progress: DesktopUpdateStatus["downloadProgress"],
  t: TFunction,
): string => {
  const percent = getDesktopUpdateDownloadPercent(progress);
  const downloaded = formatAttachmentByteSize(progress?.transferred) ?? "0 B";
  const total = formatAttachmentByteSize(progress?.total) ?? t("desktopUpdate.unknownSize");
  return [
    t("desktopUpdate.downloading"),
    percent,
    t("desktopUpdate.downloadSize", { downloaded, total }),
  ].filter(Boolean).join(" · ");
};
