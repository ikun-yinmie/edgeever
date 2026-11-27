import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface AdminSettingsSaveFooterProps {
  isSaving: boolean;
  savedAt: number | null;
  onSave: () => void;
  disabled?: boolean;
}

/** Save row shared by the site-level admin tabs. */
export const AdminSettingsSaveFooter = ({ isSaving, savedAt, onSave, disabled = false }: AdminSettingsSaveFooterProps) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-end gap-3">
      {savedAt && !isSaving ? <span className="text-xs text-emerald-600">{t("adminConsole.saved")}</span> : null}
      <Button disabled={isSaving || disabled} onClick={onSave}>
        {isSaving ? t("adminConsole.saving") : t("adminConsole.save")}
      </Button>
    </div>
  );
};
