import { useTranslation } from "react-i18next";
import { MessageSquareText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-semibold text-slate-600">{label}</span>
    {children}
  </label>
);

/** Visitor-facing copy that can be reworded without touching registration settings. */
export const MessagesSettingsCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, update, save } = useInstanceAdminSettings();

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <MessageSquareText className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.messagesSection")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.messagesCardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field label={t("adminConsole.shareMissingMessage")}>
          <textarea
            className="min-h-[96px] w-full rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
            maxLength={500}
            onChange={(event) => update({ shareMissingMessage: event.target.value || null })}
            placeholder={t("adminConsole.shareMissingMessagePlaceholder")}
            value={draft.shareMissingMessage ?? ""}
          />
        </Field>
        <p className="text-xs text-slate-500">{t("adminConsole.shareMissingMessageHint")}</p>

        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter
          isSaving={isSaving}
          savedAt={savedAt}
          onSave={() => save({ shareMissingMessage: draft.shareMissingMessage })}
        />
      </CardContent>
    </Card>
  );
};
