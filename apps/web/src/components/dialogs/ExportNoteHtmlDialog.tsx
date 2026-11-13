import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const ExportNoteHtmlDialog = ({ onClose, onExport }: {
  onClose: () => void;
  onExport: (includeOutline: boolean) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const [includeOutline, setIncludeOutline] = useState(true);
  const [exporting, setExporting] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !exporting) onClose(); }}>
      <DialogContent className="sm:max-w-md" onEscapeKeyDown={(event) => { if (exporting) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{t("editor.exportHtml")}</DialogTitle>
          <DialogDescription>{t("editor.htmlExport.outlineDescription")}</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-3 py-2">
          <Checkbox checked={includeOutline} disabled={exporting} onCheckedChange={(checked) => setIncludeOutline(checked === true)} />
          <span>{t("editor.htmlExport.includeOutline")}</span>
        </label>
        <DialogFooter>
          <Button variant="outline" disabled={exporting} onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={exporting} onClick={async () => {
            setExporting(true);
            try { await onExport(includeOutline); } finally { setExporting(false); }
          }}>{t(exporting ? "editor.htmlExport.exporting" : "editor.exportHtml")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
