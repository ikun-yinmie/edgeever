import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiRequestError, api } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

export const INVITE_CODES_QUERY_KEY = ["registration-invites"];

type InviteStatus = "active" | "usedUp" | "revoked" | "expired";

const resolveInviteStatus = (invite: {
  revokedAt: string | null;
  expiresAt: string | null;
  useCount: number;
  maxUses: number;
}): InviteStatus => {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) return "expired";
  if (invite.useCount >= invite.maxUses) return "usedUp";
  return "active";
};

const STATUS_STYLES: Record<InviteStatus, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  usedUp: "border-slate-200 bg-slate-50 text-slate-600",
  revoked: "border-rose-200 bg-rose-50 text-rose-700",
  expired: "border-amber-200 bg-amber-50 text-amber-800",
};

export const RegistrationInvitesCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const invitesQuery = useQuery({
    queryKey: INVITE_CODES_QUERY_KEY,
    queryFn: api.listRegistrationInvites,
  });
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createRegistrationInvite({
        note: note.trim() || null,
        maxUses: Math.max(1, Math.min(1000, Number(maxUses) || 1)),
        expiresInDays: expiresInDays.trim() ? Math.max(1, Math.min(365, Number(expiresInDays) || 1)) : null,
      }),
    onSuccess: (data) => {
      setCreatedCode(data.invite.code);
      setCopied(false);
      setNote("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: INVITE_CODES_QUERY_KEY });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => api.revokeRegistrationInvite(inviteId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: INVITE_CODES_QUERY_KEY });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
    },
  });

  const handleCopy = async (value: string) => {
    const ok = await copyTextToClipboard(value);
    setCopied(ok);
    if (!ok) setError(t("adminConsole.invites.copyFailed", "Copy failed — select the code manually."));
  };

  const invites = invitesQuery.data?.invites ?? [];

  return (
    <Card>
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <KeyRound className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.invites.title")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.invites.description")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("adminConsole.invites.note")}</span>
            <Input
              className="h-9"
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("adminConsole.invites.notePlaceholder")}
              value={note}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("adminConsole.invites.maxUses")}</span>
            <Input
              className="h-9"
              max={1000}
              min={1}
              onChange={(event) => setMaxUses(event.target.value)}
              type="number"
              value={maxUses}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("adminConsole.invites.expiresInDays")}</span>
            <Input
              className="h-9"
              max={365}
              min={1}
              onChange={(event) => setExpiresInDays(event.target.value)}
              type="number"
              value={expiresInDays}
            />
          </label>
          <Button className="h-9" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? t("adminConsole.invites.creating") : t("adminConsole.invites.create")}
          </Button>
        </div>
        <p className="text-xs text-slate-500">{t("adminConsole.invites.expiresNeverHint")}</p>

        {createdCode ? (
          <div className="space-y-1.5 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3.5 py-3">
            <p className="text-xs font-semibold text-emerald-900">{t("adminConsole.invites.createdLabel")}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-sm font-semibold tracking-wide text-emerald-900">
                {createdCode}
              </code>
              <Button className="h-8 shrink-0" onClick={() => void handleCopy(createdCode)} size="sm" variant="outline">
                {copied ? t("adminConsole.invites.copied") : t("adminConsole.invites.copy")}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-rose-600">{error}</p> : null}

        {invitesQuery.isLoading ? (
          <p className="text-sm text-slate-500">{t("common.loading")}</p>
        ) : invites.length === 0 ? (
          <p className="text-sm text-slate-500">{t("adminConsole.invites.empty")}</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {invites.map((invite) => {
              const status = resolveInviteStatus(invite);
              return (
                <li className="flex items-center gap-3 px-3.5 py-3" key={invite.id}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm font-semibold text-slate-900">{invite.codeHint}</code>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLES[status])}>
                        {t(`adminConsole.invites.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {invite.note ? `${invite.note} · ` : ""}
                      {t("adminConsole.invites.usage", { used: invite.useCount, max: invite.maxUses })}
                      {" · "}
                      {invite.expiresAt
                        ? t("adminConsole.invites.expiresAt", { date: new Date(invite.expiresAt).toLocaleDateString() })
                        : t("adminConsole.invites.neverExpires")}
                    </p>
                  </div>
                  <Button
                    className="h-8 shrink-0"
                    disabled={Boolean(invite.revokedAt) || revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(invite.id)}
                    size="sm"
                    variant="ghost"
                  >
                    {t("adminConsole.invites.revoke")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
