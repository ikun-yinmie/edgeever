import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Clock3, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

const SESSION_POLICY_QUERY_KEY = ["auth", "session-policy"] as const;
const RETENTION_DAY_OPTIONS = [1, 3, 7, 14, 30, 60, 90, 180, 365];

interface LoginSessionPolicyCardProps {
  authRequired: boolean;
  accountType?: "user" | "group";
}

/**
 * Retention for browser and mobile logins. The desktop client keeps the
 * instance lifetime, so only the other terminals follow this setting.
 */
export const LoginSessionPolicyCard = ({ authRequired, accountType }: LoginSessionPolicyCardProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const enabled = authRequired && accountType !== "group";
  const policyQuery = useQuery({
    queryKey: SESSION_POLICY_QUERY_KEY,
    queryFn: api.getLoginSessionPolicy,
    enabled,
    retry: 1,
  });
  const updateMutation = useMutation({
    mutationFn: (sessionTtlDays: number) => api.updateLoginSessionPolicy({ sessionTtlDays }),
    onSuccess: (data) => {
      queryClient.setQueryData(SESSION_POLICY_QUERY_KEY, data);
    },
  });

  if (!enabled) return null;

  const policy = policyQuery.data;
  const currentDays = policy?.sessionTtlDays;
  const options = currentDays && !RETENTION_DAY_OPTIONS.includes(currentDays)
    ? [...RETENTION_DAY_OPTIONS, currentDays].sort((left, right) => left - right)
    : RETENTION_DAY_OPTIONS;

  return (
    <Card className="w-full min-w-0 overflow-hidden shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <div>
          <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
            <Clock3 className={SETTINGS_CARD_ICON_CLASSNAME} />
            {t("loginSessionPolicy.title")}
          </CardTitle>
          <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
            {t("loginSessionPolicy.description")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 p-4 pt-0">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">{t("loginSessionPolicy.retention")}</p>
            <p className="text-xs text-slate-500">{t("loginSessionPolicy.retentionHint")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {updateMutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" /> : null}
            <Select
              value={currentDays ? String(currentDays) : ""}
              disabled={!policy || updateMutation.isPending || policyQuery.isError}
              onValueChange={(value) => {
                const nextDays = Number.parseInt(value, 10);
                if (Number.isInteger(nextDays) && nextDays > 0 && nextDays !== currentDays) {
                  updateMutation.mutate(nextDays);
                }
              }}
            >
              <SelectTrigger aria-label={t("loginSessionPolicy.retention")} className="h-9 w-32 text-sm">
                <SelectValue placeholder={t("loginSessionPolicy.loading")} />
              </SelectTrigger>
              <SelectContent>
                {options.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t("loginSessionPolicy.days", { days })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] leading-4 text-slate-500">
          {t("loginSessionPolicy.desktopExempt", { days: policy?.desktopSessionTtlDays ?? "?" })}
        </p>
        {policyQuery.isError ? (
          <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {t("loginSessionPolicy.loadFailed")}
          </p>
        ) : null}
        {updateMutation.isError ? (
          <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {t("loginSessionPolicy.saveFailed")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};
