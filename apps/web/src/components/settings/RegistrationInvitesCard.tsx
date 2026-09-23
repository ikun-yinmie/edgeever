import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RegistrationInvite as RegistrationInviteRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
export const INSTANCE_SETTINGS_QUERY_KEY = ["instance-admin-settings"];

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

const STATUS_LABEL_KEYS: Record<InviteStatus, string> = {
  active: "adminConsole.invites.statusActive",
  usedUp: "adminConsole.invites.statusUsedUp",
  revoked: "adminConsole.invites.statusRevoked",
  expired: "adminConsole.invites.statusExpired",
};

export const RegistrationInvitesCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const invitesQuery = useQuery({
    queryKey: INVITE_CODES_QUERY_KEY,
    queryFn: api.listRegistrationInvites,
  });
  const settingsQuery = useQuery({
    queryKey: INSTANCE_SETTINGS_QUERY_KEY,
    queryFn: api.getInstanceAdminSettings,
  });

  const [tab, setTab] = useState<"active" | "revoked">("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reportError = (mutationError: unknown) => {
    setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: INVITE_CODES_QUERY_KEY });

  const copyCode = async (code: string, inviteId: string) => {
    const ok = await copyTextToClipboard(code);
    if (!ok) {
      setError(t("adminConsole.invites.copyFailed", "Copy failed — select the code manually."));
      return;
    }
    setCopiedId(inviteId);
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.createRegistrationInvite({
        note: note.trim() || null,
        maxUses: Math.max(1, Math.min(1000, Number(maxUses) || 1)),
        expiresInDays: expiresInDays.trim() ? Math.max(1, Math.min(365, Number(expiresInDays) || 1)) : null,
      }),
    onSuccess: (data) => {
      setNote("");
      setError(null);
      setTab("active");
      void refresh();
      void copyCode(data.invite.code, data.invite.id);
    },
    onError: reportError,
  });

  const requireMutation = useMutation({
    mutationFn: (registrationInviteRequired: boolean) =>
      api.updateInstanceAdminSettings({ registrationInviteRequired }),
    onSuccess: () => {
      setError(null);
      setSelectedIds([]);
      void queryClient.invalidateQueries({ queryKey: INSTANCE_SETTINGS_QUERY_KEY });
    },
    onError: reportError,
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => api.revokeRegistrationInvite(inviteId),
    onSuccess: (_data, inviteId) => {
      setError(null);
      setSelectedIds((current) => current.filter((id) => id !== inviteId));
      void refresh();
    },
    onError: reportError,
  });

  const restoreMutation = useMutation({
    mutationFn: (inviteId: string) => api.restoreRegistrationInvite(inviteId),
    onSuccess: (_data, inviteId) => {
      setError(null);
      setSelectedIds((current) => current.filter((id) => id !== inviteId));
      void refresh();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => api.deleteRegistrationInvites(ids),
    onSuccess: () => {
      setError(null);
      setSelectedIds([]);
      void refresh();
    },
    onError: reportError,
  });

  const invites = invitesQuery.data?.invites ?? [];
  const inviteRequired = settingsQuery.data?.settings.registrationInviteRequired ?? false;
  const registrationEnabled = settingsQuery.data?.settings.registrationEnabled ?? false;

  const { activeInvites, revokedInvites } = useMemo(() => {
    const active: RegistrationInviteRecord[] = [];
    const revoked: RegistrationInviteRecord[] = [];
    for (const invite of invites) {
      if (invite.revokedAt) revoked.push(invite);
      else active.push(invite);
    }
    return { activeInvites: active, revokedInvites: revoked };
  }, [invites]);

  const visibleInvites = tab === "active" ? activeInvites : revokedInvites;
  const visibleIds = visibleInvites.map((invite) => invite.id);
  const selectedVisibleIds = selectedIds.filter((id) => visibleIds.includes(id));
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;
  const actionsEnabled = inviteRequired;
  const busy = revokeMutation.isPending || restoreMutation.isPending || deleteMutation.isPending;

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? visibleIds : []);
  };

  const toggleSelect = (inviteId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked ? [...new Set([...current, inviteId])] : current.filter((id) => id !== inviteId),
    );
  };

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
        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">{t("adminConsole.inviteRequired")}</p>
            <p className="text-xs text-slate-500">
              {registrationEnabled
                ? t("adminConsole.inviteRequiredHint")
                : t("adminConsole.invites.registrationClosedHint")}
            </p>
          </div>
          <Switch
            checked={inviteRequired}
            disabled={!settingsQuery.data || requireMutation.isPending}
            onCheckedChange={(checked) => requireMutation.mutate(checked)}
          />
        </div>

        {!actionsEnabled ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900">
            {t("adminConsole.invites.actionsLocked")}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("adminConsole.invites.note")}</span>
            <Input
              className="h-9"
              disabled={!actionsEnabled}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("adminConsole.invites.notePlaceholder")}
              value={note}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("adminConsole.invites.maxUses")}</span>
            <Input
              className="h-9"
              disabled={!actionsEnabled}
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
              disabled={!actionsEnabled}
              max={365}
              min={1}
              onChange={(event) => setExpiresInDays(event.target.value)}
              type="number"
              value={expiresInDays}
            />
          </label>
          <Button
            className="h-9"
            disabled={!actionsEnabled || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? t("adminConsole.invites.creating") : t("adminConsole.invites.create")}
          </Button>
        </div>
        <p className="text-xs text-slate-500">{t("adminConsole.invites.expiresNeverHint")}</p>

        {error ? <p className="text-sm text-rose-600">{error}</p> : null}

        <div className="space-y-3">
          <div className="flex items-center gap-2 border-b border-slate-200">
            <button
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                tab === "active"
                  ? "border-emerald-500 text-emerald-700"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
              onClick={() => {
                setTab("active");
                setSelectedIds([]);
              }}
              type="button"
            >
              {t("adminConsole.invites.tabActive")}
              <span className="ml-1.5 text-xs text-slate-400">{activeInvites.length}</span>
            </button>
            <button
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
                tab === "revoked"
                  ? "border-emerald-500 text-emerald-700"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
              onClick={() => {
                setTab("revoked");
                setSelectedIds([]);
              }}
              type="button"
            >
              {t("adminConsole.invites.tabRevoked")}
              <span className="ml-1.5 text-xs text-slate-400">{revokedInvites.length}</span>
            </button>
            <div className="ml-auto flex items-center gap-2 pb-1">
              {selectedVisibleIds.length > 0 ? (
                <span className="text-xs text-slate-500">
                  {t("adminConsole.invites.selectedCount", { count: selectedVisibleIds.length })}
                </span>
              ) : null}
              <Button
                className="h-8"
                disabled={!actionsEnabled || selectedVisibleIds.length === 0 || deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(selectedVisibleIds)}
                size="sm"
                variant="outline"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("adminConsole.invites.deleteSelected")}
              </Button>
            </div>
          </div>

          {invitesQuery.isLoading ? (
            <p className="text-sm text-slate-500">{t("common.loading")}</p>
          ) : visibleInvites.length === 0 ? (
            <p className="text-sm text-slate-500">
              {tab === "active" ? t("adminConsole.invites.emptyActive") : t("adminConsole.invites.emptyRevoked")}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <Checkbox
                        aria-label={t("adminConsole.invites.selectAll")}
                        checked={allVisibleSelected}
                        disabled={!actionsEnabled}
                        onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      />
                    </th>
                    <th className="px-3 py-2.5 text-left">{t("adminConsole.invites.columnCode")}</th>
                    <th className="px-3 py-2.5 text-left">{t("adminConsole.invites.columnSource")}</th>
                    <th className="px-3 py-2.5 text-left">{t("adminConsole.invites.columnNote")}</th>
                    <th className="px-3 py-2.5 text-left">{t("adminConsole.invites.columnUsage")}</th>
                    <th className="px-3 py-2.5 text-right">{t("adminConsole.invites.columnActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleInvites.map((invite) => {
                    const status = resolveInviteStatus(invite);
                    const ownerName = invite.owner?.displayName || invite.owner?.username || null;
                    const usedByName = invite.usedBy?.displayName || invite.usedBy?.username || null;
                    return (
                      <tr key={invite.id} className="align-middle">
                        <td className="px-3 py-3">
                          <Checkbox
                            aria-label={invite.codeHint}
                            checked={selectedIds.includes(invite.id)}
                            disabled={!actionsEnabled}
                            onCheckedChange={(checked) => toggleSelect(invite.id, checked === true)}
                          />
                        </td>
                        <td className="px-3 py-3">
                          {invite.code ? (
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-sm font-semibold tracking-wide text-slate-900">
                                {invite.code}
                              </code>
                              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLES[status])}>
                                {t(STATUS_LABEL_KEYS[status])}
                              </span>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <code className="font-mono text-sm font-semibold text-slate-500">{invite.codeHint}</code>
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                                  {t("adminConsole.invites.codeUnavailable")}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-600">
                          {invite.source === "user"
                            ? t("adminConsole.invites.sourceUser", { name: ownerName ?? "—" })
                            : t("adminConsole.invites.sourceAdmin")}
                        </td>
                        <td className="max-w-[12rem] truncate px-3 py-3 text-xs text-slate-600">
                          {invite.note || "—"}
                          <span className="mt-0.5 block text-[11px] text-slate-400">
                            {invite.expiresAt
                              ? t("adminConsole.invites.expiresAt", { date: new Date(invite.expiresAt).toLocaleDateString() })
                              : t("adminConsole.invites.neverExpires")}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-600">
                          {t("adminConsole.invites.usage", { used: invite.useCount, max: invite.maxUses })}
                          {usedByName ? (
                            <span className="mt-0.5 block text-[11px] text-slate-400">
                              {t("adminConsole.invites.usedBy", { name: usedByName })}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {invite.code ? (
                              <Button
                                className="h-8"
                                onClick={() => void copyCode(invite.code!, invite.id)}
                                size="sm"
                                variant="ghost"
                              >
                                {copiedId === invite.id
                                  ? t("adminConsole.invites.copied")
                                  : t("adminConsole.invites.copy")}
                              </Button>
                            ) : null}
                            {invite.revokedAt ? (
                              <Button
                                className="h-8"
                                disabled={!actionsEnabled || busy}
                                onClick={() => restoreMutation.mutate(invite.id)}
                                size="sm"
                                variant="ghost"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {t("adminConsole.invites.restore")}
                              </Button>
                            ) : (
                              <Button
                                className="h-8"
                                disabled={!actionsEnabled || busy}
                                onClick={() => revokeMutation.mutate(invite.id)}
                                size="sm"
                                variant="ghost"
                              >
                                {t("adminConsole.invites.revoke")}
                              </Button>
                            )}
                            <Button
                              className="h-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                              disabled={!actionsEnabled || busy}
                              onClick={() => deleteMutation.mutate([invite.id])}
                              size="sm"
                              variant="ghost"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t("adminConsole.invites.delete")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-slate-500">{t("adminConsole.invites.memberCodeHint")}</p>
        </div>
      </CardContent>
    </Card>
  );
};
