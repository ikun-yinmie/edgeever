import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export const DesktopUpdateNotice = () => {
  const { t } = useTranslation();
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
    return bridge.onUpdateStatus(() => {
      void statusQuery.refetch();
    });
  }, [bridge, statusQuery.refetch]);

  const downloaded = bridge?.isAvailable === true && statusQuery.data?.state === "downloaded";
  const available = bridge?.isAvailable === true && statusQuery.data?.state === "available" && !statusQuery.data.downloadBlocked;
  if (!downloaded && !available) return null;

  const pending = installMutation.isPending || downloadMutation.isPending;
  const label = installMutation.isError || downloadMutation.isError
    ? t("systemInfo.desktopUpdateFailed")
    : t(downloaded ? "systemInfo.desktopUpdateRestart" : "desktopUpdate.download");

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
