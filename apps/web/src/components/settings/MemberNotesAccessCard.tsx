import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookUser, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemberNotesAccessMode } from "@edgeever/shared";
import { ApiRequestError, api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const MEMBER_NOTES_ACCESS_QUERY_KEY = ["member-notes-access"];

const MODE_OPTIONS: Array<{
  mode: MemberNotesAccessMode;
  labelKey: string;
  hintKey: string;
}> = [
  { mode: "off", labelKey: "adminConsole.memberNotesModeOff", hintKey: "adminConsole.memberNotesModeOffHint" },
  { mode: "all", labelKey: "adminConsole.memberNotesModeAll", hintKey: "adminConsole.memberNotesModeAllHint" },
  { mode: "selected", labelKey: "adminConsole.memberNotesModeSelected", hintKey: "adminConsole.memberNotesModeSelectedHint" },
];

/** Owner-only switch that decides whether the workspace shows the 人员簿. */
export const MemberNotesAccessCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accessQuery = useQuery({
    queryKey: MEMBER_NOTES_ACCESS_QUERY_KEY,
    queryFn: api.getMemberNotesAccess,
  });
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api.listUsers(),
  });

  const [mode, setMode] = useState<MemberNotesAccessMode>("off");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!accessQuery.data?.settings) return;
    setMode(accessQuery.data.settings.mode);
    setSelectedUserIds(accessQuery.data.settings.selectedUserIds);
  }, [accessQuery.data]);

  const selectableUsers = useMemo(
    () =>
      (usersQuery.data?.users ?? [])
        .filter((user) => !user.isDeleted && user.role !== "owner" && user.accountType !== "group")
        .sort((left, right) =>
          (left.displayName || left.username).localeCompare(right.displayName || right.username),
        ),
    [usersQuery.data],
  );

  const filteredUsers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return selectableUsers;
    return selectableUsers.filter((user) =>
      [user.username, user.displayName ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [search, selectableUsers]);

  const selectedSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateMemberNotesAccess({
        mode,
        selectedUserIds: mode === "selected" ? selectedUserIds : [],
      }),
    onSuccess: (data) => {
      setSavedAt(Date.now());
      setMode(data.settings.mode);
      setSelectedUserIds(data.settings.selectedUserIds);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: MEMBER_NOTES_ACCESS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["member-notes-members"] }),
        queryClient.invalidateQueries({ queryKey: ["member-notes-memos"] }),
        queryClient.invalidateQueries({ queryKey: ["member-notes-memo"] }),
        queryClient.invalidateQueries({ queryKey: ["users"] }),
      ]);
    },
  });

  const toggleUser = (userId: string, checked: boolean) => {
    setSavedAt(null);
    setSelectedUserIds((current) =>
      checked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId),
    );
  };

  const saveError = saveMutation.error instanceof ApiRequestError
    ? saveMutation.error.message
    : saveMutation.error
      ? String(saveMutation.error)
      : null;

  if (accessQuery.isLoading || usersQuery.isLoading || !accessQuery.data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <BookUser className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.memberNotesSection")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.memberNotesCardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          {MODE_OPTIONS.map((option) => (
            <label
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 transition",
                mode === option.mode
                  ? "border-emerald-300 bg-emerald-50/60"
                  : "border-slate-200 bg-card hover:bg-slate-50/70",
              )}
              key={option.mode}
            >
              <input
                checked={mode === option.mode}
                className="mt-1 h-4 w-4 accent-emerald-600"
                name="member-notes-access-mode"
                onChange={() => {
                  setSavedAt(null);
                  setMode(option.mode);
                }}
                type="radio"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">
                  {t(option.labelKey)}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                  {t(option.hintKey)}
                </span>
              </span>
            </label>
          ))}
        </div>

        {mode === "selected" ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                {t("adminConsole.memberNotesSelectMembers")}
              </h3>
              <span className="text-xs text-slate-500">
                {t("adminConsole.memberNotesSelectedCount", { count: selectedUserIds.length })}
              </span>
            </div>
            <div className="flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <Input
                className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("adminConsole.memberNotesSearchPlaceholder")}
                value={search}
              />
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
              {filteredUsers.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-500">
                  {t("adminConsole.memberNotesNoMembers")}
                </p>
              ) : (
                filteredUsers.map((user) => {
                  const checked = selectedSet.has(user.id);
                  return (
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm transition",
                        checked ? "bg-emerald-50/70 text-slate-900" : "text-slate-700 hover:bg-slate-50",
                      )}
                      key={user.id}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => toggleUser(user.id, value === true)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{user.displayName || user.username}</span>
                        <span className="block truncate text-xs text-slate-500">@{user.username}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <p className="text-xs text-slate-500">{t("adminConsole.memberNotesReadOnlyHint")}</p>
          </section>
        ) : null}

        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter
          isSaving={saveMutation.isPending}
          savedAt={savedAt}
          onSave={() => saveMutation.mutate()}
        />
      </CardContent>
    </Card>
  );
};
