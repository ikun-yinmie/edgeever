import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseVideoEmbedUrl } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type VideoEmbedDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (url: string, title: string) => void;
};

export const VideoEmbedDialog = ({ open, onOpenChange, onConfirm }: VideoEmbedDialogProps) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (open) {
      setUrl("");
      setTitle("");
      setError(false);
    }
  }, [open]);

  const submit = () => {
    const parsed = parseVideoEmbedUrl(url);
    if (!parsed) {
      setError(true);
      return;
    }
    onConfirm(url.trim(), title.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("videoEmbed.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("videoEmbed.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="video-embed-url">
              {t("videoEmbed.urlLabel")}
            </label>
            <Input
              id="video-embed-url"
              value={url}
              placeholder={t("videoEmbed.urlPlaceholder")}
              autoFocus
              onChange={(event) => {
                setUrl(event.target.value);
                setError(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {error && <p className="text-xs text-rose-600">{t("videoEmbed.invalid")}</p>}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-700" htmlFor="video-embed-title">
              {t("videoEmbed.titleLabel")}
            </label>
            <Input
              id="video-embed-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit}>{t("videoEmbed.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
