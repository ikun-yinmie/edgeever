import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CollaborationGroupMember } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const RECENT_MEMO_LIMIT = 50;

const memberName = (member: CollaborationGroupMember) =>
  member.displayName || member.username || member.userId;

export interface ShareToGroupFormProps {
  groups: { id: string; name: string; memberCount: number }[];
  /** Preselected note so the author can share the note they are on directly. */
  memoId?: string;
  memoTitle?: string | null;
  /** Leave the group-share form; the host decides whether to close or switch tabs. */
  onCancel: () => void;
  onShared: () => void;
}

const useGroupShareForm = ({ groups, memoId, onCancel, onShared }: Omit<ShareToGroupFormProps, "memoTitle">) => {
  const { t } = useTranslation();
  const hasPresetMemo = Boolean(memoId);
  const [targetType, setTargetType] = useState<"notebook" | "memo">(hasPresetMemo ? "memo" : "notebook");
  const [targetId, setTargetId] = useState(hasPresetMemo ? memoId! : "");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [editMode, setEditMode] = useState<"author" | "group">("author");
  const [editorIds, setEditorIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const notebooksQuery = useQuery({ queryKey: ["notebooks"], queryFn: api.listNotebooks });
  const memosQuery = useQuery({
    queryKey: ["memos", "recent-for-sharing"],
    queryFn: () => api.listMemos({ limit: RECENT_MEMO_LIMIT, sort: "updated-desc" }),
    enabled: !hasPresetMemo,
  });
  const membersQuery = useQuery({
    queryKey: ["group-members", groupId],
    queryFn: () => api.listGroupMembers(groupId),
    enabled: Boolean(groupId),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createGroupShare(groupId, {
        targetType,
        targetId,
        editMode,
        editorUserIds: editMode === "group" ? editorIds : [],
      }),
    onSuccess: onShared,
    onError: (mutationError) => {
      setError(
        mutationError instanceof ApiRequestError && mutationError.code === "already_shared"
          ? t("sharedPane.alreadyShared")
          : mutationError instanceof ApiRequestError
            ? mutationError.message
            : String(mutationError),
      );
    },
  });

  const needle = search.trim().toLowerCase();
  const notebookOptions = useMemo(
    () => (notebooksQuery.data?.notebooks ?? []).filter(
      (notebook) => !needle || notebook.name.toLowerCase().includes(needle),
    ),
    [notebooksQuery.data, needle],
  );
  const memoOptions = useMemo(
    () => (memosQuery.data?.memos ?? []).filter(
      (memo) => !needle || (memo.title ?? "").toLowerCase().includes(needle),
    ),
    [memosQuery.data, needle],
  );

  return {
    createMutation,
    editMode,
    editorIds,
    error,
    groupId,
    hasPresetMemo,
    membersQuery,
    memoOptions,
    needle,
    notebookOptions,
    search,
    setEditMode,
    setEditorIds,
    setGroupId,
    setSearch,
    setTargetId,
    setTargetType,
    targetType,
    targetId,
  };
};

/**
 * Inner form of the "share into a group" flow. The shared-with-me pane hosts it
 * inside its own dialog; the note share dialog embeds it as a tab.
 */
export const ShareToGroupForm = ({ groups, memoId, memoTitle, onCancel, onShared }: ShareToGroupFormProps) => {
  const { t } = useTranslation();
  const form = useGroupShareForm({ groups, memoId, onCancel, onShared });
  const { hasPresetMemo } = form;

  return (
    <>
      {groups.length === 0 ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
          {t("sharedPane.noGroups")}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-700">{t("sharedPane.chooseGroup")}</p>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <button
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
                    form.groupId === group.id
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-card text-slate-600 hover:bg-slate-50",
                  )}
                  key={group.id}
                  onClick={() => {
                    form.setGroupId(group.id);
                    form.setEditorIds([]);
                  }}
                  type="button"
                >
                  {group.name}
                  <span className="ml-1.5 text-[10px] text-slate-400">{group.memberCount}</span>
                </button>
              ))}
            </div>
          </div>

          {hasPresetMemo ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                {memoTitle || t("common.untitledMemo")}
              </span>
              <span className="shrink-0 rounded-full border border-slate-200 bg-card px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {t("sharedPane.contentMemo")}
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-slate-700">{t("sharedPane.chooseContent")}</p>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium",
                      form.targetType === "notebook" ? "bg-emerald-50 text-emerald-800" : "text-slate-500",
                    )}
                    onClick={() => {
                      form.setTargetType("notebook");
                      form.setTargetId("");
                    }}
                    type="button"
                  >
                    {t("sharedPane.contentNotebook")}
                  </button>
                  <button
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium",
                      form.targetType === "memo" ? "bg-emerald-50 text-emerald-800" : "text-slate-500",
                    )}
                    onClick={() => {
                      form.setTargetType("memo");
                      form.setTargetId("");
                    }}
                    type="button"
                  >
                    {t("sharedPane.contentMemo")}
                  </button>
                </div>
              </div>
              <Input
                className="h-9"
                onChange={(event) => form.setSearch(event.target.value)}
                placeholder={t("sharedPane.searchPlaceholder")}
                value={form.search}
              />
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {(form.targetType === "notebook" ? form.notebookOptions : form.memoOptions).map((option) => (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      form.targetId === option.id ? "bg-emerald-50 text-emerald-900" : "text-slate-700 hover:bg-slate-50",
                    )}
                    key={option.id}
                    onClick={() => form.setTargetId(option.id)}
                    type="button"
                  >
                    {form.targetType === "notebook" ? (
                      <BookOpen className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {form.targetType === "notebook"
                        ? (option as { name: string }).name
                        : (option as { title: string | null }).title || t("common.untitledMemo")}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">{t("sharedPane.whoCanEdit")}</p>
            <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5">
              <input
                checked={form.editMode === "author"}
                className="mt-0.5 accent-emerald-600"
                onChange={() => form.setEditMode("author")}
                type="radio"
              />
              <span className="text-sm">
                <span className="block font-medium text-slate-900">{t("sharedPane.editAuthor")}</span>
                <span className="block text-xs text-slate-500">{t("sharedPane.editAuthorHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5">
              <input
                checked={form.editMode === "group"}
                className="mt-0.5 accent-emerald-600"
                onChange={() => form.setEditMode("group")}
                type="radio"
              />
              <span className="text-sm">
                <span className="block font-medium text-slate-900">{t("sharedPane.editGroup")}</span>
                <span className="block text-xs text-slate-500">{t("sharedPane.editGroupHint")}</span>
              </span>
            </label>
            {form.editMode === "group" ? (
              <div className="space-y-1">
                <p className="text-xs text-slate-500">{t("sharedPane.chooseEditorsHint")}</p>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                  {(form.membersQuery.data?.members ?? []).map((member) => (
                    <label
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                      key={member.userId}
                    >
                      <Checkbox
                        checked={form.editorIds.includes(member.userId)}
                        onCheckedChange={(checked) =>
                          form.setEditorIds((current) =>
                            checked === true
                              ? [...new Set([...current, member.userId])]
                              : current.filter((id) => id !== member.userId),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{memberName(member)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {form.error ? <p className="text-sm font-medium text-rose-600">{form.error}</p> : null}
        </div>
      )}

      <DialogFooter className="gap-2 sm:space-x-0">
        <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button
          disabled={groups.length === 0 || !form.targetId || form.createMutation.isPending}
          onClick={() => form.createMutation.mutate()}
          variant="solid"
        >
          {form.createMutation.isPending ? t("sharedPane.sharing") : t("sharedPane.shareSubmit")}
        </Button>
      </DialogFooter>
    </>
  );
};

interface ShareToGroupDialogProps {
  groups: { id: string; name: string; memberCount: number }[];
  memoId?: string;
  memoTitle?: string | null;
  onClose: () => void;
  onShared: () => void;
}

/** Standalone dialog wrapper, used by the shared-with-me pane. */
export const ShareToGroupDialog = ({ groups, memoId, memoTitle, onClose, onShared }: ShareToGroupDialogProps) => {
  const { t } = useTranslation();
  return (
  <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t("sharedPane.shareDialogTitle")}</DialogTitle>
        <DialogDescription>{t("sharedPane.shareDialogDescription")}</DialogDescription>
      </DialogHeader>
      <ShareToGroupForm
        groups={groups}
        memoId={memoId}
        memoTitle={memoTitle}
        onCancel={onClose}
        onShared={onShared}
      />
    </DialogContent>
  </Dialog>
  );
};
