import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GroupShareSummary } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GroupSharePolicyDialog } from "./GroupSharePolicyDialog";
import { describeEditPolicy } from "@/lib/shared-with-me";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";
import { cn } from "@/lib/utils";

export const GROUPS_QUERY_KEY = ["groups"];

export const GroupManagementCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const groupsQuery = useQuery({ queryKey: GROUPS_QUERY_KEY, queryFn: api.listGroups });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: () => api.listUsers({}) });
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [pendingMemberIds, setPendingMemberIds] = useState<string[]>([]);
  const [policyTarget, setPolicyTarget] = useState<GroupShareSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = groupsQuery.data?.groups ?? [];
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null;
  const resolvedGroupId = activeGroup?.id ?? null;

  useEffect(() => {
    if (!activeGroupId && groups.length > 0) setActiveGroupId(groups[0].id);
  }, [activeGroupId, groups]);

  const membersQuery = useQuery({
    queryKey: ["group-members", resolvedGroupId],
    queryFn: () => api.listGroupMembers(resolvedGroupId as string),
    enabled: Boolean(resolvedGroupId),
  });
  const sharesQuery = useQuery({
    queryKey: ["group-shares", resolvedGroupId],
    queryFn: () => api.listGroupShares(resolvedGroupId as string),
    enabled: Boolean(resolvedGroupId),
  });

  const reportError = (mutationError: unknown) => {
    setError(
      mutationError instanceof ApiRequestError && mutationError.code === "username_exists"
        ? t("users.usernameExists")
        : mutationError instanceof ApiRequestError
          ? mutationError.message
          : String(mutationError),
    );
  };

  const refreshGroups = () => queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
  const refreshDetails = () => {
    void queryClient.invalidateQueries({ queryKey: ["group-members", resolvedGroupId] });
    void queryClient.invalidateQueries({ queryKey: ["group-shares", resolvedGroupId] });
    void refreshGroups();
  };

  const createMutation = useMutation({
    mutationFn: () => api.createGroup({ name, description: description.trim() || null }),
    onSuccess: (data) => {
      setCreateOpen(false);
      setName("");
      setDescription("");
      setError(null);
      setActiveGroupId(data.group.id);
      void refreshGroups();
    },
    onError: reportError,
  });
  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) => api.deleteGroup(groupId),
    onSuccess: () => {
      setActiveGroupId(null);
      setError(null);
      void refreshGroups();
    },
    onError: reportError,
  });
  const addMembersMutation = useMutation({
    mutationFn: (userIds: string[]) => api.addGroupMembers(resolvedGroupId as string, userIds),
    onSuccess: () => {
      setAddMembersOpen(false);
      setPendingMemberIds([]);
      setError(null);
      refreshDetails();
    },
    onError: reportError,
  });
  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.removeGroupMember(resolvedGroupId as string, userId),
    onSuccess: () => {
      setError(null);
      refreshDetails();
    },
    onError: reportError,
  });
  const revokeShareMutation = useMutation({
    mutationFn: (shareId: string) => api.revokeGroupShare(resolvedGroupId as string, shareId),
    onSuccess: () => {
      setError(null);
      refreshDetails();
    },
    onError: reportError,
  });

  const members = membersQuery.data?.members ?? [];
  const shares = sharesQuery.data?.shares ?? [];
  const memberIds = new Set(members.map((member) => member.userId));
  const candidates = (usersQuery.data?.users ?? []).filter((user) => !memberIds.has(user.id));

  const policyLabel = (share: GroupShareSummary) => {
    const policy = describeEditPolicy(share);
    if (policy === "author") return t("sharedPane.policyAuthor");
    if (policy === "selected") return t("sharedPane.policySelected");
    return t("sharedPane.policyGroup");
  };

  return (
    <>
      <Card className="w-full min-w-0 overflow-hidden shadow-none">
        <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
                <Users className={SETTINGS_CARD_ICON_CLASSNAME} />
                {t("groups.title")}
              </CardTitle>
              <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
                {t("groups.description")}
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> {t("groups.create")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 p-4 pt-0 lg:grid-cols-[16rem_1fr]">
          <div className="space-y-1.5">
            {groupsQuery.isLoading ? <p className="text-sm text-slate-500">{t("common.loading")}</p> : null}
            {!groupsQuery.isLoading && groups.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                {t("groups.empty")}
              </p>
            ) : null}
            {groups.map((group) => (
              <button
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left transition",
                  activeGroup?.id === group.id
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-slate-200 bg-card hover:bg-slate-50",
                )}
                key={group.id}
                onClick={() => setActiveGroupId(group.id)}
                type="button"
              >
                <span className="block truncate text-sm font-medium text-slate-900">{group.name}</span>
                <span className="block text-xs text-slate-500">
                  {t("groups.groupMeta", { members: group.memberCount, shares: group.shareCount })}
                </span>
              </button>
            ))}
          </div>

          <div className="min-w-0 space-y-4">
            {error ? <p className="text-sm text-rose-600">{error}</p> : null}
            {!activeGroup ? (
              <p className="text-sm text-slate-500">{t("groups.selectHint")}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{activeGroup.name}</p>
                    {activeGroup.description ? (
                      <p className="truncate text-xs text-slate-500">{activeGroup.description}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button className="h-8" onClick={() => setAddMembersOpen(true)} size="sm" variant="outline">
                      <UserPlus className="h-3.5 w-3.5" />
                      {t("groups.addMember")}
                    </Button>
                    <Button
                      className="h-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      disabled={deleteGroupMutation.isPending}
                      onClick={() => deleteGroupMutation.mutate(activeGroup.id)}
                      size="sm"
                      variant="ghost"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("groups.delete")}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-600">
                    {t("groups.members")} · {members.length}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((member) => (
                      <span
                        className="flex items-center gap-2 rounded-full border border-slate-200 bg-card px-2.5 py-1 text-xs text-slate-700"
                        key={member.userId}
                      >
                        {member.displayName || member.username || member.userId}
                        {member.role === "manager" ? (
                          <span className="text-[10px] text-emerald-700">{t("groups.manager")}</span>
                        ) : null}
                        <button
                          className="text-slate-400 transition hover:text-rose-600"
                          onClick={() => removeMemberMutation.mutate(member.userId)}
                          type="button"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-600">
                    {t("groups.shares")} · {shares.length}
                  </p>
                  {shares.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                      {t("groups.noShares")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                      {shares.map((share) => (
                        <li className="flex flex-wrap items-center gap-2 px-3 py-2.5" key={share.id}>
                          {share.targetType === "notebook" ? (
                            <BookOpen className="h-4 w-4 shrink-0 text-emerald-600" />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-900">
                              {share.title || t("common.untitledMemo")}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {share.authorDisplayName || share.authorUsername || "—"} · {policyLabel(share)}
                            </p>
                          </div>
                          <Button
                            className="h-8"
                            onClick={() => setPolicyTarget(share)}
                            size="sm"
                            variant="outline"
                          >
                            {t("sharedPane.editPolicy")}
                          </Button>
                          <Button
                            className="h-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                            disabled={revokeShareMutation.isPending}
                            onClick={() => revokeShareMutation.mutate(share.id)}
                            size="sm"
                            variant="ghost"
                          >
                            {t("sharedPane.revoke")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("groups.createTitle")}</DialogTitle>
            <DialogDescription>{t("groups.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              {t("groups.name")}
              <Input className="h-9" onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">
              {t("groups.descriptionLabel")}
              <Input
                className="h-9"
                onChange={(event) => setDescription(event.target.value)}
                value={description}
              />
            </label>
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
            <Button
              disabled={!name.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
              variant="solid"
            >
              {t("groups.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addMembersOpen} onOpenChange={setAddMembersOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("groups.addMemberTitle", { group: activeGroup?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("groups.addMemberDescription")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {candidates.length === 0 ? (
              <p className="px-2 py-3 text-xs text-slate-500">{t("groups.noCandidates")}</p>
            ) : (
              candidates.map((candidate) => (
                <label
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  key={candidate.id}
                >
                  <Checkbox
                    checked={pendingMemberIds.includes(candidate.id)}
                    onCheckedChange={(checked) =>
                      setPendingMemberIds((current) =>
                        checked === true
                          ? [...new Set([...current, candidate.id])]
                          : current.filter((id) => id !== candidate.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{candidate.displayName || candidate.username}</span>
                  <span className="text-xs text-slate-400">@{candidate.username}</span>
                </label>
              ))
            )}
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
            <Button
              disabled={pendingMemberIds.length === 0 || addMembersMutation.isPending}
              onClick={() => addMembersMutation.mutate(pendingMemberIds)}
              variant="solid"
            >
              {t("groups.addMember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {policyTarget && resolvedGroupId ? (
        <GroupSharePolicyDialog
          groupId={resolvedGroupId}
          members={members}
          onChange={() => {
            setPolicyTarget(null);
            refreshDetails();
          }}
          onClose={() => setPolicyTarget(null)}
          share={policyTarget}
        />
      ) : null}
    </>
  );
};
