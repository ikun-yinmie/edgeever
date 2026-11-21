import { CloudDownload, CloudUpload, PauseCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useSyncPreferences } from "@/hooks/useSyncPreferences";
import { setSyncPause, type SyncDirection } from "@/lib/sync-preferences";
import { cn } from "@/lib/utils";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
  SETTINGS_ITEM_DESCRIPTION_CLASSNAME,
  SETTINGS_ITEM_ICON_CLASSNAME,
  SETTINGS_ITEM_TITLE_CLASSNAME,
} from "./settings-ui";

const SyncSwitchRow = ({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <div className="flex items-start justify-between gap-4 px-4 py-3.5">
    <div className="min-w-0">
      <div className={cn(SETTINGS_ITEM_TITLE_CLASSNAME, "flex items-center gap-2")}>
        {icon}
        <span>{title}</span>
      </div>
      <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{description}</p>
    </div>
    <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
  </div>
);

export const SyncControlCard = ({ scope }: { scope?: string }) => {
  const { t } = useTranslation();
  const preferences = useSyncPreferences(scope);
  const allPaused = preferences.pausePull && preferences.pausePush;
  const status = allPaused
    ? t("syncControl.statusAll")
    : preferences.pausePull
      ? t("syncControl.statusPull")
      : preferences.pausePush
        ? t("syncControl.statusPush")
        : t("syncControl.statusNone");

  const toggle = (direction: SyncDirection, paused: boolean) => {
    setSyncPause(direction, paused, scope);
  };

  return (
    <Card className="w-full min-w-0 overflow-hidden shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
          <PauseCircle className={SETTINGS_CARD_ICON_CLASSNAME} />
          {t("syncControl.title")}
        </CardTitle>
        <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
          {t("syncControl.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div
          className={cn(
            "mx-4 mb-1 rounded-lg px-3 py-2 text-xs font-medium",
            allPaused || preferences.pausePull || preferences.pausePush
              ? "bg-amber-50 text-amber-800"
              : "bg-emerald-50 text-emerald-800"
          )}
          role="status"
          aria-live="polite"
        >
          {status}
        </div>
        <div className="divide-y divide-slate-100">
          <SyncSwitchRow
            icon={<PauseCircle className={SETTINGS_ITEM_ICON_CLASSNAME} />}
            title={t("syncControl.pauseAll")}
            description={t("syncControl.pauseAllDescription")}
            checked={allPaused}
            onChange={(checked) => {
              setSyncPause("all", checked, scope);
            }}
          />
          <SyncSwitchRow
            icon={<CloudDownload className={SETTINGS_ITEM_ICON_CLASSNAME} />}
            title={t("syncControl.pausePull")}
            description={t("syncControl.pausePullDescription")}
            checked={preferences.pausePull}
            onChange={(checked) => toggle("pull", checked)}
          />
          <SyncSwitchRow
            icon={<CloudUpload className={SETTINGS_ITEM_ICON_CLASSNAME} />}
            title={t("syncControl.pausePush")}
            description={t("syncControl.pausePushDescription")}
            checked={preferences.pausePush}
            onChange={(checked) => toggle("push", checked)}
          />
        </div>
      </CardContent>
    </Card>
  );
};