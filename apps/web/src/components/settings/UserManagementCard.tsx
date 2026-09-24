import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  KeyRound,
  MoreHorizontal,
  Power,
  PowerOff,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { InstanceUser } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ApiRequestError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface UserManagementCardProps {
  demoMode: boolean;
  currentUserId?: string | null;
}

type MemberStatusFilter = "all" | "enabled" | "disabled" | "archived";
type MemberSortKey = "createdAt" | "lastLoginAt" | "username";

const PAGE_SIZE = 20;

export const UserManagementCard = ({ demoMode, currentUserId = null }: UserManagementCardProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<InstanceUser | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MemberStatusFilter>("all");
  const [sortKey, setSortKey] = useState<MemberSortKey>("createdAt");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api.listUsers({ includeDeleted: true }),
  });
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const createMutation = useMutation({
    mutationFn: api.createUser,
    onSuccess: () => {
      setCreateOpen(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
      void refresh();
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({
      userId,
      input,
    }: {
      userId: string;
      input: { password?: string; isDisabled?: boolean; isDeleted?: boolean; role?: "owner" | "member" };
    }) => api.updateUser(userId, input),
    onSuccess: () => void refresh(),
  });
  const bulkMutation = useMutation({
    mutationFn: (input: { ids: string[]; isDisabled?: boolean; isDeleted?: boolean }) => api.bulkUpdateUsers(input),
    onSuccess: () => {
      setSelectedIds([]);
      void refresh();
    },
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = users.filter((user) => {
      if (statusFilter === "archived" && !user.isDeleted) return false;
      if (statusFilter !== "archived" && user.isDeleted) return false;
      if (statusFilter === "enabled" && user.isDisabled) return false;
      if (statusFilter === "disabled" && !user.isDisabled) return false;
      if (!needle) return true;
      return [user.username, user.displayName ?? "", user.email ?? ""]
        .some((value) => value.toLowerCase().includes(needle));
    });
    return matched.sort((left, right) => {
      if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
      if (sortKey === "username") return left.username.localeCompare(right.username);
      if (sortKey === "lastLoginAt") {
        return (right.lastLoginAt ? Date.parse(right.lastLoginAt) : 0) - (left.lastLoginAt ? Date.parse(left.lastLoginAt) : 0);
      }
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });
  }, [users, search, statusFilter, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, sortKey]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageIds = pageItems.filter((user) => user.role !== "owner").map((user) => user.id);
  const selectablePageIds = pageIds;
  const selectedOnPage = selectedIds.filter((id) => selectablePageIds.includes(id));
  const allOnPageSelected = selectablePageIds.length > 0 && selectedOnPage.length === selectablePageIds.length;
  const bulkBusy = bulkMutation.isPending || updateMutation.isPending;

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? selectablePageIds : []);
  };
  const toggleSelect = (userId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId),
    );
  };

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate({ username, displayName: displayName || null, password });
  };

  const handleCreateOpenChange = (open: boolean) => {
    setCreateOpen(open);
    if (!open) {
      setUsername("");
      setDisplayName("");
      setPassword("");
      createMutation.reset();
    }
  };

  const createError =
    createMutation.error instanceof ApiRequestError && createMutation.error.code === "username_exists"
      ? t("users.usernameExists")
      : t("users.failed");

  const handleReset = (event: FormEvent) => {
    event.preventDefault();
    if (!resetUser) return;
    updateMutation.mutate(
      { userId: resetUser.id, input: { password: resetPassword } },
      {
        onSuccess: () => {
          setResetUser(null);
          setResetPassword("");
        },
      },
    );
  };

  const statusFilters: { key: MemberStatusFilter; label: string }[] = [
    { key: "all", label: t("users.filterAll") },
    { key: "enabled", label: t("users.enabled") },
    { key: "disabled", label: t("users.disabled") },
    { key: "archived", label: t("users.archived") },
  ];

  return (
    <>
      <Card className="w-full min-w-0 overflow-hidden shadow-none">
        <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
                <Users className={SETTINGS_CARD_ICON_CLASSNAME} />
                {t("users.title")}
              </CardTitle>
              <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
                {t("users.descriptionList")}
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <UserPlus className="h-4 w-4" /> {t("users.create")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                className="h-9 pl-8"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("users.searchPlaceholder")}
                value={search}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {statusFilters.map((filter) => (
                <button
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
                    statusFilter === filter.key
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-card text-slate-600 hover:bg-slate-50",
                  )}
                  key={filter.key}
                  onClick={() => setStatusFilter(filter.key)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">
              {selectedIds.length > 0
                ? t("users.selectedCount", { count: selectedIds.length })
                : t("users.bulkHint")}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Button
                className="h-8"
                disabled={selectedIds.length === 0 || bulkBusy}
                onClick={() => bulkMutation.mutate({ ids: selectedIds, isDisabled: false })}
                size="sm"
                variant="outline"
              >
                {t("users.bulkEnable")}
              </Button>
              <Button
                className="h-8"
                disabled={selectedIds.length === 0 || bulkBusy}
                onClick={() => bulkMutation.mutate({ ids: selectedIds, isDisabled: true })}
                size="sm"
                variant="outline"
              >
                {t("users.bulkDisable")}
              </Button>
              <Button
                className="h-8"
                disabled={selectedIds.length === 0 || bulkBusy}
                onClick={() => bulkMutation.mutate({ ids: selectedIds, isDeleted: true })}
                size="sm"
                variant="outline"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("users.bulkArchive")}
              </Button>
              <Button
                className="h-8"
                disabled={selectedIds.length === 0 || bulkBusy}
                onClick={() => bulkMutation.mutate({ ids: selectedIds, isDeleted: false })}
                size="sm"
                variant="outline"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                {t("users.bulkRestore")}
              </Button>
            </div>
          </div>

          {usersQuery.isLoading ? (
            <p className="text-sm text-slate-500">{t("users.loading")}</p>
          ) : pageItems.length === 0 ? (
            <p className="text-sm text-slate-500">{t("users.empty")}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[50rem] border-collapse text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <Checkbox
                        aria-label={t("users.selectAll")}
                        checked={allOnPageSelected}
                        disabled={selectablePageIds.length === 0}
                        onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      />
                    </th>
                    <th className="px-3 py-2.5 text-left">
                      <button className="font-semibold" onClick={() => setSortKey("username")} type="button">
                        {t("users.columnMember")}
                      </button>
                    </th>
                    <th className="w-24 px-3 py-2.5 text-left">{t("users.columnRole")}</th>
                    <th className="w-[6.5rem] px-3 py-2.5 text-left">{t("users.columnStatus")}</th>
                    <th className="w-40 px-3 py-2.5 text-left">
                      <button className="font-semibold" onClick={() => setSortKey("lastLoginAt")} type="button">
                        {t("users.columnLastLogin")}
                      </button>
                    </th>
                    <th className="w-28 px-3 py-2.5 text-left">
                      <button className="font-semibold" onClick={() => setSortKey("createdAt")} type="button">
                        {t("users.columnCreatedAt")}
                      </button>
                    </th>
                    <th className="w-20 px-3 py-2.5 text-right">{t("users.columnEnabled")}</th>
                    <th className="w-16 px-3 py-2.5 text-right">{t("users.columnActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageItems.map((user) => {
                    const isOwner = user.role === "owner";
                    return (
                      <tr key={user.id} className={cn("align-middle", user.isDeleted && "bg-slate-50/60")}>
                        <td className="px-3 py-3">
                          <Checkbox
                            aria-label={user.username}
                            checked={selectedIds.includes(user.id)}
                            disabled={isOwner}
                            onCheckedChange={(checked) => toggleSelect(user.id, checked === true)}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {user.displayName || user.username}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            @{user.username}
                            {user.email ? ` · ${user.email}` : ""}
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                          {t(`users.roles.${user.role}`)}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5",
                              user.isDeleted
                                ? "border-slate-200 bg-slate-50 text-slate-600"
                                : user.isDisabled
                                  ? "border-amber-200 bg-amber-50 text-amber-800"
                                  : "border-emerald-200 bg-emerald-50 text-emerald-800",
                            )}
                          >
                            <span
                              className={cn(
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                user.isDeleted
                                  ? "bg-slate-400"
                                  : user.isDisabled
                                    ? "bg-amber-500"
                                    : "bg-emerald-500",
                              )}
                            />
                            {user.isDeleted
                              ? t("users.archived")
                              : user.isDisabled
                                ? t("users.disabled")
                                : t("users.enabled")}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                          {user.lastLoginAt
                            ? new Date(user.lastLoginAt).toLocaleString()
                            : t("users.neverLoggedIn")}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                          {new Date(user.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {isOwner ? null : (
                            <Switch
                              aria-label={`${user.displayName || user.username} · ${t("users.columnEnabled")}`}
                              checked={!user.isDisabled}
                              disabled={bulkBusy}
                              onCheckedChange={(checked) =>
                                updateMutation.mutate({ userId: user.id, input: { isDisabled: !checked } })
                              }
                            />
                          )}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {isOwner && demoMode ? null : (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  aria-label={t("users.moreActions")}
                                  className="h-8 w-8 p-0"
                                  size="icon"
                                  variant="ghost"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem onSelect={() => setResetUser(user)}>
                                  <KeyRound className="mr-2 h-3.5 w-3.5" />
                                  {t("users.resetPassword")}
                                </DropdownMenuItem>
                                {isOwner ? null : (
                                  <>
                                    <DropdownMenuItem
                                      disabled={bulkBusy}
                                      onSelect={() =>
                                        updateMutation.mutate({
                                          userId: user.id,
                                          input: { isDisabled: !user.isDisabled },
                                        })
                                      }
                                    >
                                      {user.isDisabled ? (
                                        <Power className="mr-2 h-3.5 w-3.5" />
                                      ) : (
                                        <PowerOff className="mr-2 h-3.5 w-3.5" />
                                      )}
                                      {user.isDisabled ? t("users.enable") : t("users.disable")}
                                    </DropdownMenuItem>
                                    {user.role === "member" ? (
                                      <DropdownMenuItem
                                        disabled={bulkBusy}
                                        onSelect={() =>
                                          updateMutation.mutate({ userId: user.id, input: { role: "owner" } })
                                        }
                                      >
                                        <ShieldCheck className="mr-2 h-3.5 w-3.5" />
                                        {t("users.makeAdmin")}
                                      </DropdownMenuItem>
                                    ) : user.id === currentUserId ? null : (
                                      <DropdownMenuItem
                                        disabled={bulkBusy}
                                        onSelect={() =>
                                          updateMutation.mutate({ userId: user.id, input: { role: "member" } })
                                        }
                                      >
                                        <ShieldOff className="mr-2 h-3.5 w-3.5" />
                                        {t("users.removeAdmin")}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    {user.isDeleted ? (
                                      <DropdownMenuItem
                                        disabled={bulkBusy}
                                        onSelect={() =>
                                          updateMutation.mutate({ userId: user.id, input: { isDeleted: false } })
                                        }
                                      >
                                        <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                                        {t("users.restore")}
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem
                                        className="text-rose-600 focus:bg-rose-50 focus:text-rose-700"
                                        disabled={bulkBusy}
                                        onSelect={() =>
                                          updateMutation.mutate({ userId: user.id, input: { isDeleted: true } })
                                        }
                                      >
                                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                                        {t("users.archive")}
                                      </DropdownMenuItem>
                                    )}
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">
              {t("users.totalCount", { count: filtered.length })}
              {totalPages > 1 ? ` · ${t("users.pageInfo", { page, pages: totalPages })}` : ""}
            </span>
            {totalPages > 1 ? (
              <div className="flex items-center gap-1.5">
                <Button
                  className="h-8"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  size="sm"
                  variant="outline"
                >
                  {t("users.pagePrev")}
                </Button>
                <Button
                  className="h-8"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  size="sm"
                  variant="outline"
                >
                  {t("users.pageNext")}
                </Button>
              </div>
            ) : null}
          </div>

          {usersQuery.isError || createMutation.isError || updateMutation.isError || bulkMutation.isError ? (
            <p className="text-xs font-medium text-rose-600">{t("users.failed")}</p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-100 px-6 py-5 pr-12">
            <DialogTitle>{t("users.createTitle")}</DialogTitle>
            <DialogDescription className="leading-6">{t("users.createDescription")}</DialogDescription>
          </DialogHeader>
          <form className="grid gap-5 px-6 py-5" autoComplete="off" onSubmit={handleCreate}>
            <label className="grid gap-2 text-sm font-medium text-slate-700" htmlFor="edgeever-new-account-username">
              {t("users.username")}
              <Input
                id="edgeever-new-account-username"
                name="edgeever-new-account-username"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t("users.usernamePlaceholder")}
                required
                maxLength={80}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700" htmlFor="edgeever-new-account-display-name">
              {t("users.displayName")}
              <Input
                id="edgeever-new-account-display-name"
                name="edgeever-new-account-display-name"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("users.displayNamePlaceholder")}
                maxLength={80}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700" htmlFor="edgeever-new-account-password">
              {t("users.password")}
              <Input
                id="edgeever-new-account-password"
                name="edgeever-new-account-password"
                type="password"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("users.passwordPlaceholder")}
                minLength={8}
                required
              />
              <span className="text-xs font-normal text-slate-500">{t("users.passwordHint")}</span>
            </label>
            {createMutation.isError ? <p className="text-sm font-medium text-rose-600" role="alert">{createError}</p> : null}
            <DialogFooter className="mt-1 gap-2 sm:space-x-0">
              <DialogClose asChild><Button type="button" variant="outline">{t("common.cancel")}</Button></DialogClose>
              <Button type="submit" variant="solid" disabled={createMutation.isPending}>
                {createMutation.isPending ? t("users.creating") : t("users.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(resetUser)} onOpenChange={(open) => { if (!open) setResetUser(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t("users.resetTitle", { username: resetUser?.username })}</DialogTitle><DialogDescription>{t("users.resetDescription")}</DialogDescription></DialogHeader>
          <form className="grid gap-4" autoComplete="off" onSubmit={handleReset}>
            <label className="grid gap-2 text-sm font-medium text-slate-700" htmlFor="edgeever-reset-account-password">
              {t("users.newPassword")}
              <Input id="edgeever-reset-account-password" name="edgeever-reset-account-password" type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder={t("users.passwordPlaceholder")} minLength={8} required />
            </label>
            <DialogFooter className="gap-2 sm:space-x-0">
              <DialogClose asChild><Button type="button" variant="outline">{t("common.cancel")}</Button></DialogClose>
              <Button type="submit" variant="solid" disabled={updateMutation.isPending}>{t("users.resetPassword")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
