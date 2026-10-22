import { useEffect, useState } from "react";
import { Plus, Server, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ShareServerEntry } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AdminSettingsSaveFooter } from "./AdminSettingsSaveFooter";
import { useInstanceAdminSettings } from "./useInstanceAdminSettings";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

type EditableShareServer = {
  id: string;
  url: string;
  label: string;
};

const createRow = (server?: ShareServerEntry): EditableShareServer => ({
  id: crypto.randomUUID(),
  url: server?.url ?? "",
  label: server?.label ?? "",
});

const normalizeShareUrl = (value: string) => value.trim().replace(/\/+$/, "");

const isValidShareUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const ShareServerSettingsCard = () => {
  const { t } = useTranslation();
  const { draft, isLoading, isSaving, savedAt, saveError, save } = useInstanceAdminSettings();
  const [rows, setRows] = useState<EditableShareServer[]>([]);
  const [defaultRowId, setDefaultRowId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft) return;
    const servers = draft.shareServers ?? [];
    const nextRows = servers.map((server) => createRow(server));
    setRows(nextRows);
    const defaultRow = nextRows.find((row) => row.url === draft.defaultShareServerUrl) ?? nextRows[0] ?? null;
    setDefaultRowId(defaultRow?.id ?? null);
    setValidationError(null);
  }, [draft]);

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-slate-500">{t("common.loading")}</CardContent>
      </Card>
    );
  }

  const addRow = () => {
    const row = createRow();
    setRows((current) => [...current, row]);
    setDefaultRowId((current) => current ?? row.id);
  };

  const updateRow = (id: string, patch: Partial<Pick<EditableShareServer, "url" | "label">>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    const next = rows.filter((row) => row.id !== id);
    setRows(next);
    if (defaultRowId === id) setDefaultRowId(next[0]?.id ?? null);
  };

  const handleSave = () => {
    const seen = new Set<string>();
    const servers: ShareServerEntry[] = [];
    let defaultUrl: string | null = null;

    for (const row of rows) {
      const url = normalizeShareUrl(row.url);
      if (!url) continue;
      if (!isValidShareUrl(url)) {
        setValidationError(t("adminConsole.shareServersInvalidUrl"));
        return;
      }
      if (seen.has(url)) {
        setValidationError(t("adminConsole.shareServersDuplicate"));
        return;
      }
      seen.add(url);
      servers.push({ url, label: row.label.trim() || null });
      if (row.id === defaultRowId) defaultUrl = url;
    }

    if (!defaultUrl) defaultUrl = servers[0]?.url ?? null;
    setValidationError(null);
    save({
      shareServers: servers.length > 0 ? servers : null,
      defaultShareServerUrl: defaultUrl,
    });
  };

  return (
    <Card className="shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <Server className={cn(SETTINGS_CARD_ICON_CLASSNAME, "text-emerald-600")} />
        <div className="min-w-0 flex-1">
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>{t("adminConsole.shareServersSection")}</CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("adminConsole.shareServersCardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
            {t("adminConsole.shareServersEmpty")}
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3" key={row.id}>
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                    <input
                      aria-label={t("adminConsole.shareServerDefault")}
                      checked={row.id === defaultRowId}
                      className="h-4 w-4 accent-emerald-600"
                      disabled={!row.url.trim()}
                      name="default-share-server"
                      onChange={() => setDefaultRowId(row.id)}
                      type="radio"
                    />
                    {t("adminConsole.shareServerDefault")}
                  </label>
                  <Button
                    aria-label={t("adminConsole.shareServerRemove")}
                    className="h-8 w-8 text-slate-500 hover:text-rose-600"
                    onClick={() => removeRow(row.id)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                  <Input
                    aria-label={t("adminConsole.shareServerNameLabel")}
                    className="h-9"
                    maxLength={60}
                    onChange={(event) => updateRow(row.id, { label: event.target.value })}
                    placeholder={t("adminConsole.shareServerNamePlaceholder")}
                    value={row.label}
                  />
                  <Input
                    aria-label={t("adminConsole.shareServerUrlLabel")}
                    className="h-9 font-mono text-xs"
                    inputMode="url"
                    onChange={(event) => updateRow(row.id, { url: event.target.value })}
                    placeholder={t("adminConsole.shareServerUrlPlaceholder")}
                    spellCheck={false}
                    value={row.url}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <Button onClick={addRow} variant="outline">
          <Plus className="h-4 w-4" />
          {t("adminConsole.shareServerAdd")}
        </Button>
        <p className="text-xs leading-5 text-slate-500">{t("adminConsole.shareServersHint")}</p>

        {validationError ? <p className="text-sm text-rose-600" role="alert">{validationError}</p> : null}
        {saveError ? <p className="text-sm text-rose-600">{saveError}</p> : null}

        <AdminSettingsSaveFooter isSaving={isSaving} savedAt={savedAt} onSave={handleSave} />
      </CardContent>
    </Card>
  );
};
