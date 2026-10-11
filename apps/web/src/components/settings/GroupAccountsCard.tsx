import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, UserCog } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ApiRequestError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";
import { cn } from "@/lib/utils";

/**
 * Admin card for shared (public) group accounts: one credential that many
 * people sign in with at the same time, meant for collaborative editing of
 * group notes.
 */
export const GroupAccountsCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accountsQuery = useQuery({ queryKey: ["group-accounts"], queryFn: api.listGroupAccounts });
  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: api.listGroups });

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdUsername, setCreatedUsername] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<{ id: string; username: string } | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const accounts = accountsQuery.data?.accounts ?? [];
  const groups = groupsQuery.data?.groups ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["group-accounts"] });

  const reportError = (mutationError: unknown) => {
    setError(
      mutationError instanceof ApiRequestError && mutationError.code === "username_exists"
        ? t("users.usernameExists")
        : mutationError instanceof ApiRequestError
          ? mutationError.message
          : String(mutationError),
    );
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.createGroupAccount({
        name,
        displayName: displayName.trim() || null,
        password,
        groupIds,
      }),
    onSuccess: (data) => {
      setCreateOpen(false);
      setName("");
      setDisplayName("");
      setPassword("");
      setGroupIds([]);
      setError(null);
      setCreatedUsername(data.username);
      void refresh();
    },
    onError: reportError,
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; body: { isDisabled?: boolean; password?: string } }) =>
      api.updateGroupAccount(payload.id, payload.body),
    onSuccess: () => {
      setResetTarget(null);
      setResetPassword("");
      setError(null);
      void refresh();
    },
    onError: reportError,
  });

  const closeCreate = () => {
    setCreateOpen(false);
    setError(null);
  };

  return (
    <Card>
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <UserCog className={SETTINGS_CARD_ICON_CLASSNAME} aria-hidden />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("groupAccounts.title")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("groupAccounts.description")}
          </CardDescription>
        </div>
        <Button
          className="shrink-0"
          onClick={() => setCreateOpen(true)}
          size="sm"
          variant="outline"
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {t("groupAccounts.create")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {createdUsername ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900" role="status">
            {t("groupAccounts.created", { username: createdUsername })}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm font-medium text-rose-600" role="alert">{error}</p>
        ) : null}
        {accounts.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs text-slate-500">
            {t("groupAccounts.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {accounts.map((account) => (
              <li className="flex flex-wrap items-center gap-2 px-3 py-2.5" key={account.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {account.displayName || account.username}
                    {account.isDisabled ? (
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                        {t("users.disabledStatus", { defaultValue: t("users.disabled") })}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {account.username}
                    {" · "}
                    {account.groupCount > 0
                      ? t("groupAccounts.joinedGroups", { count: account.groupCount })
                      : t("groupAccounts.groupsNone")}
                  </p>
                </div>
                <Button
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => {
                    setResetTarget({ id: account.id, username: account.username });
                    setResetPassword("");
                  }}
                  size="sm"
                  variant="outline"
                >
                  <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {t("groupAccounts.passwordReset")}
                </Button>
                <Button
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ id: account.id, body: { isDisabled: !account.isDisabled } })}
                  size="sm"
                  variant={account.isDisabled ? "solid" : "outline"}
                >
                  {account.isDisabled ? t("users.enable") : t("users.disable")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={createOpen} onOpenChange={(next) => { if (!next) closeCreate(); }}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("groupAccounts.createTitle")}</DialogTitle>
            <DialogDescription>{t("groupAccounts.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {error ? <p className="text-sm font-medium text-rose-600" role="alert">{error}</p> : null}
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700" htmlFor="group-account-name">
                {t("groupAccounts.nameLabel")}
              </label>
              <Input
                id="group-account-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="team"
                value={name}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700" htmlFor="group-account-display">
                {t("groupAccounts.displayNameLabel")}
              </label>
              <Input
                id="group-account-display"
                onChange={(event) => setDisplayName(event.target.value)}
                value={displayName}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700" htmlFor="group-account-password">
                {t("groupAccounts.passwordLabel")}
              </label>
              <Input
                autoComplete="new-password"
                id="group-account-password"
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-700">{t("groupAccounts.groupsLabel")}</p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {groups.map((group) => (
                  <label
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                    key={group.id}
                  >
                    <Checkbox
                      checked={groupIds.includes(group.id)}
                      onCheckedChange={(checked) =>
                        setGroupIds((current) =>
                          checked === true
                            ? [...new Set([...current, group.id])]
                            : current.filter((id) => id !== group.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button onClick={closeCreate} type="button" variant="outline">{t("common.cancel")}</Button>
            <Button
              disabled={!name.trim() || password.length < 8 || createMutation.isPending}
              onClick={() => createMutation.mutate()}
              variant="solid"
            >
              {t("groupAccounts.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(resetTarget)} onOpenChange={(next) => { if (!next) setResetTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("groupAccounts.passwordReset")}</DialogTitle>
            <DialogDescription>{resetTarget?.username}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoComplete="new-password"
              onChange={(event) => setResetPassword(event.target.value)}
              placeholder={t("groupAccounts.passwordLabel")}
              type="password"
              value={resetPassword}
            />
            <p className="text-xs text-slate-500">{t("groupAccounts.passwordResetHint", "重置后所有正在使用该账号的登录都会立即失效，需要重新登录。")}</p>
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button onClick={() => setResetTarget(null)} type="button" variant="outline">{t("common.cancel")}</Button>
            <Button
              disabled={resetPassword.length < 8 || updateMutation.isPending}
              onClick={() =>
                resetTarget && updateMutation.mutate({ id: resetTarget.id, body: { password: resetPassword } })
              }
              variant="solid"
            >
              {t("groupAccounts.passwordReset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
