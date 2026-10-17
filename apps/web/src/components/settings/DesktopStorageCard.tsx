import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FolderOpen, HardDrive, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

type StorageLocationInfo = {
  rootDirectory: string;
  accountDirectory: string;
  defaultRootDirectory: string;
  isCustom: boolean;
  usageBytes: number;
  usageFiles: number;
};

type StorageLocationErrorCode =
  | "invalid-directory"
  | "unsupported-directory"
  | "target-has-data"
  | "target-not-writable"
  | "migration-in-progress"
  | "migration-failed";

const errorKeys: Record<StorageLocationErrorCode, string> = {
  "invalid-directory": "storageLocation.errors.invalidDirectory",
  "unsupported-directory": "storageLocation.errors.unsupportedDirectory",
  "target-has-data": "storageLocation.errors.targetHasData",
  "target-not-writable": "storageLocation.errors.targetNotWritable",
  "migration-in-progress": "storageLocation.errors.migrationInProgress",
  "migration-failed": "storageLocation.errors.migrationFailed",
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const DesktopStorageCard = () => {
  const { t } = useTranslation();
  const bridge = window.edgeeverDesktop;
  const [info, setInfo] = useState<StorageLocationInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<StorageLocationErrorCode | "unexpected" | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge?.storageLocation) return;
    setIsLoading(true);
    setErrorCode(null);
    try {
      setInfo(await bridge.storageLocation());
    } catch {
      setErrorCode("unexpected");
    } finally {
      setIsLoading(false);
    }
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!bridge?.storageLocation) return null;

  const chooseDirectory = async () => {
    setErrorCode(null);
    try {
      const result = await bridge.chooseStorageLocation();
      if (result.path && result.path !== info?.rootDirectory) setPendingTarget(result.path);
    } catch {
      setErrorCode("unexpected");
    }
  };

  const confirmMove = async () => {
    if (!pendingTarget) return;
    setIsMoving(true);
    setErrorCode(null);
    try {
      const result = await bridge.setStorageLocation(pendingTarget);
      if (result.ok) {
        setMovedTo(result.rootDirectory);
        setPendingTarget(null);
        window.setTimeout(() => window.location.reload(), 700);
      } else {
        setPendingTarget(null);
        setErrorCode(result.errorCode as StorageLocationErrorCode);
      }
    } catch {
      setPendingTarget(null);
      setErrorCode("unexpected");
    } finally {
      setIsMoving(false);
    }
  };

  const restoreDefault = async () => {
    setIsMoving(true);
    setErrorCode(null);
    try {
      const result = await bridge.resetStorageLocation();
      if (result.ok) {
        setMovedTo(result.rootDirectory);
        window.setTimeout(() => window.location.reload(), 700);
      } else {
        setErrorCode(result.errorCode as StorageLocationErrorCode);
      }
    } catch {
      setErrorCode("unexpected");
    } finally {
      setIsMoving(false);
    }
  };

  const openDirectory = async () => {
    try {
      await bridge.openStorageLocation();
    } catch {
      setErrorCode("unexpected");
    }
  };

  return (
    <>
      <Card className="w-full min-w-0 overflow-hidden shadow-none">
        <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
            <HardDrive className={SETTINGS_CARD_ICON_CLASSNAME} />
            {t("storageLocation.title")}
          </CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>{t("storageLocation.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0 sm:px-5 sm:pb-5">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-slate-500">{t("storageLocation.currentDirectory")}</span>
            <code className="break-all rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-800">
              {info?.rootDirectory ?? t("storageLocation.loading")}
            </code>
            <p className="text-xs text-slate-500">
              {t("storageLocation.usage", { size: formatSize(info?.usageBytes ?? 0), files: info?.usageFiles ?? 0 })}
              {info?.isCustom ? ` · ${t("storageLocation.customActive")}` : ` · ${t("storageLocation.defaultActive")}`}
            </p>
          </div>
          {errorCode ? (
            <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {t(errorCode === "unexpected" ? "storageLocation.errors.unexpected" : errorKeys[errorCode])}
            </p>
          ) : null}
          {movedTo ? (
            <p className="flex items-center gap-1.5 text-xs text-emerald-700" role="status">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              {t("storageLocation.moveComplete", { directory: movedTo })}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button size="sm" type="button" disabled={isMoving || isLoading} onClick={() => void chooseDirectory()}>
              <FolderOpen className="h-4 w-4" />
              {t("storageLocation.changeDirectory")}
            </Button>
            {info?.isCustom ? (
              <Button size="sm" variant="outline" type="button" disabled={isMoving} onClick={() => void restoreDefault()}>
                {t("storageLocation.restoreDefault")}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" type="button" disabled={isMoving || isLoading} onClick={() => void refresh()}>
              <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              {t("common.refresh")}
            </Button>
            <Button size="sm" variant="ghost" type="button" disabled={isMoving} onClick={() => void openDirectory()}>
              {t("storageLocation.openDirectory")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={pendingTarget !== null}
        onOpenChange={(open) => {
          if (!isMoving && !open) setPendingTarget(null);
        }}
      >
        <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="flex flex-row items-start gap-4 border-b border-slate-200 px-5 py-5 text-left">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <HardDrive className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base leading-6">{t("storageLocation.dialogTitle")}</DialogTitle>
              <DialogDescription className="mt-1 text-sm leading-5">
                {t("storageLocation.dialogDescription")}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="grid gap-3 px-5 py-4 text-sm leading-5 text-slate-600">
            <code className="break-all rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-xs text-slate-800">
              {pendingTarget}
            </code>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-medium text-amber-800">
              {t("storageLocation.dialogWarning")}
            </p>
          </div>
          <DialogFooter className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={isMoving} onClick={() => setPendingTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={isMoving} onClick={() => void confirmMove()}>
              {isMoving ? t("storageLocation.moving") : t("storageLocation.confirmMove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
