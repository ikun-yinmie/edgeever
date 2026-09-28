import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  PenLine,
  Share2,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GroupShareSummary } from "@/lib/api";
import { ApiRequestError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { GroupSharePolicyDialog } from "@/components/settings/GroupSharePolicyDialog";
import { ShareToGroupDialog } from "@/components/dialogs/ShareToGroupDialog";
import { describeEditPolicy, groupSharedItems } from "@/lib/shared-with-me";
import { cn } from "@/lib/utils";

export const SHARED_WITH_ME_QUERY_KEY = ["shared-with-me"];
export const MEMO_LINK_SHARES_QUERY_KEY = ["memo-link-shares"];

const buildShareUrl = (token: string) => `${window.location.origin}/share/${encodeURIComponent(token)}`;

interface SharedWithMePaneProps {
  onClose: () => void;
  onOpenMemo: (memoId: string) => void;
}

export const SharedWithMePane = ({ onClose, onOpenMemo }: SharedWithMePaneProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const sharedQuery = useQuery({ queryKey: SHARED_WITH_ME_QUERY_KEY, queryFn: api.getSharedWithMe });
  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: api.listGroups });
  const linkSharesQuery = useQuery({ queryKey: MEMO_LINK_SHARES_QUERY_KEY, queryFn: api.listMemoLinkShares, staleTime: 60_000 });
  const [expandedNotebookId, setExpandedNotebookId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [policyTarget, setPolicyTarget] = useState<{ share: GroupShareSummary; groupId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [confirmRevokeToken, setConfirmRevokeToken] = useState<string | null>(null);

  const notebookMemosQuery = useQuery({
    queryKey: ["shared-notebook-memos", expandedNotebookId],
    queryFn: () => api.listSharedNotebookMemos(expandedNotebookId as string),
    enabled: Boolean(expandedNotebookId),
  });

  const membersGroupId = policyTarget?.groupId ?? null;
  const membersQuery = useQuery({
    queryKey: ["group-members", membersGroupId],
    queryFn: () => api.listGroupMembers(membersGroupId as string),
    enabled: Boolean(membersGroupId),
  });

  const revokeMutation = useMutation({
    mutationFn: ({ groupId, shareId }: { groupId: string; shareId: string }) =>
      api.revokeGroupShare(groupId, shareId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: SHARED_WITH_ME_QUERY_KEY });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
    },
  });

  const revokeLinkShareMutation = useMutation({
    mutationFn: (memoId: string) => api.revokeMemoShare(memoId),
    onSuccess: () => {
      setError(null);
      setConfirmRevokeToken(null);
      void queryClient.invalidateQueries({ queryKey: MEMO_LINK_SHARES_QUERY_KEY });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof ApiRequestError ? mutationError.message : String(mutationError));
    },
  });

  const copyShareLink = async (token: string) => {
    const { copyTextToClipboard } = await import("@/lib/clipboard");
    const copied = await copyTextToClipboard(buildShareUrl(token));
    if (copied) {
      setCopiedToken(token);
      window.setTimeout(() => setCopiedToken((current) => (current === token ? null : current)), 1800);
    }
  };

  const sections = useMemo(
    () =>
      groupSharedItems({
        groups: sharedQuery.data?.groups ?? [],
        notebooks: sharedQuery.data?.notebooks ?? [],
        memos: sharedQuery.data?.memos ?? [],
      }),
    [sharedQuery.data],
  );
  const myShares = sharedQuery.data?.sharedByMe ?? [];
  const hasSharedContent = sections.some((section) => section.notebooks.length > 0 || section.memos.length > 0);

  const policyLabel = (share: { editMode: "author" | "group"; editorUserIds: string[] }) => {
    const policy = describeEditPolicy(share);
    if (policy === "author") return t("sharedPane.policyAuthor");
    if (policy === "selected") return t("sharedPane.policySelected");
    return t("sharedPane.policyGroup");
  };

  return (
    <main className="flex h-full min-w-0 flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-card px-4 py-3">
        <Button
          aria-label={t("common.back")}
          className="h-9 w-9 shrink-0 p-0"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="h-4.5 w-4.5" />
        </Button>
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-white">
          <Users className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-bold leading-tight">{t("sharedPane.title")}</h1>
          <p className="truncate text-xs text-slate-500">{t("sharedPane.subtitle")}</p>
        </div>
        <Button className="h-9 shrink-0" onClick={() => setShareOpen(true)} size="sm">
          <Share2 className="h-4 w-4" />
          {t("sharedPane.shareToGroup")}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
          {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700">{t("sharedPane.sectionSharedWithMe")}</h2>
            {sharedQuery.isLoading ? (
              <p className="text-sm text-slate-500">{t("common.loading")}</p>
            ) : !hasSharedContent ? (
              <p className="rounded-lg border border-slate-200 bg-card px-3.5 py-3 text-sm text-slate-500">
                {t("sharedPane.emptyShared")}
              </p>
            ) : (
              sections.map((section) => (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-card shadow-sm" key={section.group.id}>
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{section.group.name}</p>
                      <p className="text-xs text-slate-500">
                        {t("sharedPane.groupMeta", {
                          members: section.group.memberCount,
                          shares: section.group.shareCount,
                        })}
                      </p>
                    </div>
                  </div>

                  {section.notebooks.length === 0 && section.memos.length === 0 ? (
                    <p className="px-3.5 py-3 text-xs text-slate-500">{t("sharedPane.emptyGroup")}</p>
                  ) : null}

                  <ul className="divide-y divide-slate-100">
                    {section.notebooks.map((notebook) => {
                      const expanded = expandedNotebookId === notebook.id;
                      return (
                        <li key={`nb-${notebook.id}`}>
                          <button
                            className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-slate-50"
                            onClick={() => setExpandedNotebookId(expanded ? null : notebook.id)}
                            type="button"
                          >
                            <BookOpen className="h-4 w-4 shrink-0 text-emerald-600" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-900">{notebook.name}</span>
                              <span className="block truncate text-xs text-slate-500">
                                {t("sharedPane.notebookMeta", { count: notebook.memoCount })}
                                {notebook.authorDisplayName || notebook.authorUsername
                                  ? ` · ${t("sharedPane.fromAuthor", {
                                      name: notebook.authorDisplayName || notebook.authorUsername,
                                    })}`
                                  : ""}
                              </span>
                            </span>
                            <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", notebook.canEdit ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-600")}>
                              {notebook.canEdit ? t("sharedPane.canEdit") : t("sharedPane.readOnly")}
                            </span>
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                            )}
                          </button>
                          {expanded ? (
                            <div className="bg-slate-50/70 px-3.5 pb-3">
                              {notebookMemosQuery.isLoading ? (
                                <p className="py-2 text-xs text-slate-500">{t("common.loading")}</p>
                              ) : (notebookMemosQuery.data?.memos ?? []).length === 0 ? (
                                <p className="py-2 text-xs text-slate-500">{t("sharedPane.notebookEmpty")}</p>
                              ) : (
                                <ul className="space-y-1">
                                  {(notebookMemosQuery.data?.memos ?? []).map((memo) => (
                                    <li key={memo.id}>
                                      <button
                                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-card"
                                        onClick={() => onOpenMemo(memo.id)}
                                        type="button"
                                      >
                                        <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                        <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                                          {memo.title || t("common.untitledMemo")}
                                        </span>
                                        {memo.canEdit ? <PenLine className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}

                    {section.memos.map((memo) => (
                      <li key={`memo-${memo.id}`}>
                        <button
                          className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-slate-50"
                          onClick={() => onOpenMemo(memo.id)}
                          type="button"
                        >
                          <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-900">
                              {memo.title || t("common.untitledMemo")}
                            </span>
                            <span className="block truncate text-xs text-slate-500">
                              {memo.authorDisplayName || memo.authorUsername
                                ? t("sharedPane.fromAuthor", { name: memo.authorDisplayName || memo.authorUsername })
                                : ""}
                            </span>
                          </span>
                          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", memo.canEdit ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-600")}>
                            {memo.canEdit ? t("sharedPane.canEdit") : t("sharedPane.readOnly")}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700">{t("sharedPane.sectionMyShares")}</h2>
            {myShares.length === 0 && (linkSharesQuery.data?.shares.filter((share) => !share.memoDeleted).length ?? 0) === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-card px-3.5 py-3 text-sm text-slate-500">
                {t("sharedPane.emptyMyShares")}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-card shadow-sm">
                {myShares.map((share) => (
                  <li className="flex flex-wrap items-center gap-3 px-3.5 py-3" key={share.id}>
                    {share.targetType === "notebook" ? (
                      <BookOpen className="h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">{share.title || t("common.untitledMemo")}</p>
                      <p className="truncate text-xs text-slate-500">
                        {t("sharedPane.mySharesGroupLabel")} · {share.groupName} · {policyLabel(share)}
                      </p>
                    </div>
                    <Button
                      className="h-8"
                      onClick={() => setPolicyTarget({ share, groupId: share.groupId })}
                      size="sm"
                      variant="outline"
                    >
                      {t("sharedPane.editPolicy")}
                    </Button>
                    <Button
                      className="h-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate({ groupId: share.groupId, shareId: share.id })}
                      size="sm"
                      variant="ghost"
                    >
                      {t("sharedPane.revoke")}
                    </Button>
                  </li>
                ))}
                {(linkSharesQuery.data?.shares ?? [])
                  .filter((linkShare) => !linkShare.memoDeleted)
                  .map((linkShare) => (
                    <li className="flex flex-wrap items-center gap-3 px-3.5 py-3" key={`link-${linkShare.memoId}`}>
                      <ExternalLink className="h-4 w-4 shrink-0 text-sky-600" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {linkShare.memoTitle || t("common.untitledMemo")}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {t("sharedPane.mySharesLinkLabel")}
                          {linkShare.passwordProtected ? " · 🔒" : ""}
                        </p>
                      </div>
                      {confirmRevokeToken === linkShare.token ? (
                        <>
                          <span className="text-xs text-slate-500">{t("sharedPane.revokeLinkShareConfirm")}</span>
                          <Button
                            className="h-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                            disabled={revokeLinkShareMutation.isPending}
                            onClick={() => revokeLinkShareMutation.mutate(linkShare.memoId)}
                            size="sm"
                            variant="ghost"
                          >
                            {t("sharedPane.revokeLinkShare")}
                          </Button>
                          <Button className="h-8" onClick={() => setConfirmRevokeToken(null)} size="sm" variant="outline">
                            {t("common.cancel")}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            className="h-8"
                            onClick={() => void copyShareLink(linkShare.token)}
                            size="sm"
                            variant="outline"
                          >
                            {copiedToken === linkShare.token ? (
                              <>
                                <Check className="h-4 w-4" />
                                {t("sharedPane.mySharesLinkCopied")}
                              </>
                            ) : (
                              <>
                                <Copy className="h-4 w-4" />
                                {t("sharedPane.copyLink")}
                              </>
                            )}
                          </Button>
                          <Button
                            className="h-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                            onClick={() => setConfirmRevokeToken(linkShare.token)}
                            size="sm"
                            variant="ghost"
                          >
                            {t("sharedPane.revokeLinkShare")}
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {shareOpen ? (
        <ShareToGroupDialog
          groups={groupsQuery.data?.groups ?? []}
          onClose={() => setShareOpen(false)}
          onShared={() => {
            setShareOpen(false);
            setError(null);
            void queryClient.invalidateQueries({ queryKey: SHARED_WITH_ME_QUERY_KEY });
          }}
        />
      ) : null}

      {policyTarget && membersQuery.data ? (
        <GroupSharePolicyDialog
          groupId={policyTarget.groupId}
          members={membersQuery.data.members}
          onChange={() => {
            setPolicyTarget(null);
            void queryClient.invalidateQueries({ queryKey: SHARED_WITH_ME_QUERY_KEY });
          }}
          onClose={() => setPolicyTarget(null)}
          share={policyTarget.share}
        />
      ) : null}
    </main>
  );
};

