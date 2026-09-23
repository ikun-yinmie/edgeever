import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CollaborationGroupMember, GroupShareSummary } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface GroupSharePolicyDialogProps {
  groupId: string;
  share: GroupShareSummary;
  members: CollaborationGroupMember[];
  onClose: () => void;
  onChange: () => void;
}

export const GroupSharePolicyDialog = ({ groupId, share, members, onClose, onChange }: GroupSharePolicyDialogProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [editMode, setEditMode] = useState<"author" | "group">(share.editMode);
  const [editorIds, setEditorIds] = useState<string[]>(share.editorUserIds);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditMode(share.editMode);
    setEditorIds(share.editorUserIds);
  }, [share.editMode, share.editorUserIds]);

  const updateMutation = useMutation({
    mutationFn: (payload: { editMode?: "author" | "group"; editorUserIds?: string[]; note?: string | null }) =>
      api.updateGroupShare(groupId, share.id, payload),
    onSuccess: () => {
      setOpen(false);
      onChange();
    },
    onError: (mutationError) => {
      setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
    },
  });

  const toggleEditor = (userId: string, checked: boolean) => {
    setEditorIds((current) =>
      checked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId),
    );
  };

  const memberName = (member: CollaborationGroupMember) =>
    member.displayName || member.username || member.userId;

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sharedPane.policyTitle")}</DialogTitle>
          <DialogDescription>{t("sharedPane.policyDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">{t("sharedPane.whoCanEdit")}</p>
            <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5">
              <input
                checked={editMode === "author"}
                className="mt-0.5 accent-emerald-600"
                name="editMode"
                onChange={() => setEditMode("author")}
                type="radio"
              />
              <span className="text-sm">
                <span className="block font-medium text-slate-900">{t("sharedPane.editAuthor")}</span>
                <span className="block text-xs text-slate-500">{t("sharedPane.editAuthorHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5">
              <input
                checked={editMode === "group"}
                className="mt-0.5 accent-emerald-600"
                name="editMode"
                onChange={() => setEditMode("group")}
                type="radio"
              />
              <span className="text-sm">
                <span className="block font-medium text-slate-900">{t("sharedPane.editGroup")}</span>
                <span className="block text-xs text-slate-500">{t("sharedPane.editGroupHint")}</span>
              </span>
            </label>
          </div>

          {editMode === "group" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">{t("sharedPane.chooseEditors")}</p>
              <p className="text-xs text-slate-500">{t("sharedPane.chooseEditorsHint")}</p>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {members.map((member) => (
                  <label
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                    key={member.userId}
                  >
                    <Checkbox
                      checked={editorIds.includes(member.userId)}
                      onCheckedChange={(checked) => toggleEditor(member.userId, checked === true)}
                    />
                    <span className="min-w-0 flex-1 truncate">{memberName(member)}</span>
                    <span className="text-xs text-slate-400">@{member.username ?? member.userId}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {error ? <p className="text-sm font-medium text-rose-600">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:space-x-0">
          <DialogClose asChild>
            <Button type="button" variant="outline">{t("common.cancel")}</Button>
          </DialogClose>
          <Button
            disabled={updateMutation.isPending}
            onClick={() =>
              updateMutation.mutate({
                editMode,
                editorUserIds: editMode === "group" ? editorIds : [],
              })
            }
            variant="solid"
          >
            {updateMutation.isPending ? t("common.saving") : t("sharedPane.savePolicy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};