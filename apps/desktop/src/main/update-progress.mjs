/** Normalize electron-updater's byte progress for the renderer; unknown totals stay unknown. */
export const normalizeDesktopUpdateProgress = (progress) => {
  const total = Number.isFinite(progress?.total) && progress.total > 0 ? progress.total : null;
  const transferred = Number.isFinite(progress?.transferred) && progress.transferred >= 0
    ? progress.transferred
    : 0;
  const percent = Number.isFinite(progress?.percent)
    ? progress.percent
    : total === null ? null : transferred / total * 100;
  return {
    percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
    transferred,
    total,
  };
};
