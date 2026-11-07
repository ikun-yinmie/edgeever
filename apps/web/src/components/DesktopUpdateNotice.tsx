import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getDesktopUpdateDownloadLabel, getDesktopUpdateDownloadPercent } from "@/lib/desktop-update-progress";

export const DesktopUpdateNotice = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const bridge = window.edgeeverDesktop;

  const statusQuery = useQuery({
    queryKey: ["desktop-update-status"],
    queryFn: () => bridge!.updateStatus(),
    enabled: bridge?.isAvailable === true,
    refetchInterval: (query) => query.state.data?.state === "downloaded" ? false : 5_000,
    retry: 1,
  });
  const downloadMutation = useMutation({
    mutationFn: () => bridge!.downloadUpdate(),
    onSettled: () => {
      void statusQuery.refetch();
    },
  });
  const installMutation = useMutation({
    mutationFn: async () => {
      const result = await bridge!.installUpdate();
      if (!result?.started) throw new Error(result?.reason ?? "install-failed");
      return result;
    },
  });

  useEffect(() => {
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus((status) => {
      queryClient.setQueryData(["desktop-update-status"], status);
    });
  }, [bridge, queryClient]);

  const downloaded = bridge?.isAvailable === true && statusQuery.data?.state === "downloaded";
  const available = bridge?.isAvailable === true && statusQuery.data?.state === "available" && !statusQuery.data.downloadBlocked;
  const downloading = bridge?.isAvailable === true && statusQuery.data?.state === "downloading";
  if (!downloaded && !available && !downloading) return null;

  const pending = installMutation.isPending || downloadMutation.isPending;
  const label = installMutation.isError || downloadMutation.isError
    ? t("systemInfo.desktopUpdateFailed")
    : t(downloaded ? "systemInfo.desktopUpdateRestart" : "desktopUpdate.download");

  // The sidebar footer has room for a compact percentage, not the full size label.
  // Keep the complete progress accessible on both hover and keyboard focus.
  if (downloading) {
    const progressLabel = getDesktopUpdateDownloadLabel(statusQuery.data?.downloadProgress, t);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2 text-xs font-semibold tabular-nums text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
            tabIndex={0}
            role="status"
            aria-live="polite"
            aria-label={progressLabel}
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {getDesktopUpdateDownloadPercent(statusQuery.data?.downloadProgress) ?? "…"}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">{progressLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      className="h-8 shrink-0 rounded-full px-4 text-xs font-semibold shadow-sm"
      size="sm"
      variant={downloaded ? "solid" : "outline"}
      aria-live="polite"
      aria-label={statusQuery.data?.version ? `${label} v${statusQuery.data.version}` : label}
      disabled={pending}
      onClick={() => downloaded ? installMutation.mutate() : downloadMutation.mutate()}
    >
      {pending
        ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        : null}
      {label}
      {!pending ? <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> : null}
    </Button>
  );
};
