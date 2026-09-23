import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ticket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ApiRequestError, api } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export const MY_INVITE_QUERY_KEY = ["my-invite-code"];

export const MyInviteCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inviteQuery = useQuery({ queryKey: MY_INVITE_QUERY_KEY, queryFn: api.getMyRegistrationInvite });
  const registrationQuery = useQuery({ queryKey: ["registration-config"], queryFn: api.getRegistrationConfig });
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: api.createMyRegistrationInvite,
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: MY_INVITE_QUERY_KEY });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
    },
  });

  const invite = inviteQuery.data?.invite ?? null;
  const inviteRequired = registrationQuery.data?.registration.inviteRequired ?? false;
  const consumed = Boolean(invite && (invite.revokedAt || invite.useCount >= invite.maxUses));

  const handleCopy = async () => {
    if (!invite?.code) return;
    const ok = await copyTextToClipboard(invite.code);
    setCopied(ok);
    if (!ok) setError(t("adminConsole.invites.copyFailed", "Copy failed — select the code manually."));
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-card px-4 py-3.5 shadow-sm">
      <div className="flex items-start gap-3">
        <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-sm font-semibold text-slate-900">{t("myInvite.title")}</p>
            <p className="text-xs leading-5 text-slate-500">{t("myInvite.description")}</p>
          </div>

          {!inviteRequired ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
              {t("myInvite.registrationHint")}
            </p>
          ) : null}

          {inviteQuery.isLoading ? (
            <p className="text-xs text-slate-500">{t("common.loading")}</p>
          ) : invite ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-slate-100 px-2.5 py-1 font-mono text-sm font-semibold tracking-wide text-slate-900">
                  {invite.code ?? invite.codeHint}
                </code>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    consumed
                      ? "border-slate-200 bg-slate-50 text-slate-600"
                      : "border-emerald-200 bg-emerald-50 text-emerald-800",
                  )}
                >
                  {consumed ? t("myInvite.statusUsed") : t("myInvite.statusUnused")}
                </span>
                {invite.code ? (
                  <Button className="h-8" onClick={() => void handleCopy()} size="sm" variant="outline">
                    {copied ? t("adminConsole.invites.copied") : t("adminConsole.invites.copy")}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">
                {consumed ? t("myInvite.usedHint") : t("myInvite.unusedHint")}
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="h-8"
                disabled={createMutation.isPending}
                onClick={() => createMutation.mutate()}
                size="sm"
              >
                {createMutation.isPending ? t("myInvite.generating") : t("myInvite.generate")}
              </Button>
              <span className="text-xs text-slate-500">{t("myInvite.generateHint")}</span>
            </div>
          )}

          {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
        </div>
      </div>
    </section>
  );
};
