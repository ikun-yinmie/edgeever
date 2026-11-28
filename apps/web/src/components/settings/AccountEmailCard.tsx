import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { ApiRequestError, api, type AccountEmail } from "@/lib/api";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

export const accountEmailQueryKey = (accountId: string | null | undefined, sessionKey = "default") =>
  ["account-email", accountId ?? "anonymous", sessionKey] as const;

type AccountEmailFormProps = {
  accountId: string | null | undefined;
  sessionKey?: string;
  authRequired: boolean;
  demoMode: boolean;
  accountType?: "user" | "group";
  embedded?: boolean;
  onCompleted?: () => void;
};

const isSupported = ({ accountId, authRequired, demoMode, accountType }: AccountEmailFormProps) =>
  Boolean(accountId && authRequired && !demoMode && accountType !== "group");

const errorMessageKey = (code: string | undefined) => {
  switch (code) {
    case "invalid_current_password": return "accountEmail.errors.invalidCurrentPassword";
    case "smtp_not_configured": return "accountEmail.errors.smtpNotConfigured";
    case "email_exists": return "accountEmail.errors.emailExists";
    case "email_code_invalid": return "accountEmail.errors.codeInvalid";
    case "email_code_expired": return "accountEmail.errors.codeExpired";
    case "email_code_rate_limited":
    case "account_email_rate_limited":
    case "email_code_cooldown": return "accountEmail.errors.codeRateLimited";
    case "account_email_unavailable": return "accountEmail.errors.unavailable";
    default: return "accountEmail.errors.generic";
  }
};

const getErrorMessage = (error: unknown, t: (key: string) => string) =>
  t(error instanceof ApiRequestError ? errorMessageKey(error.code) : "accountEmail.errors.generic");

export const AccountEmailForm = ({
  accountId,
  sessionKey = "default",
  authRequired,
  demoMode,
  accountType,
  embedded = false,
  onCompleted,
}: AccountEmailFormProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const supported = isSupported({ accountId, authRequired, demoMode, accountType });
  const emailQuery = useQuery({
    queryKey: accountEmailQueryKey(accountId, sessionKey),
    queryFn: api.getAccountEmail,
    enabled: supported,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [codeRequested, setCodeRequested] = useState(false);
  const requestCodeMutation = useMutation({ mutationFn: api.requestAccountEmailCode });
  const verifyMutation = useMutation({ mutationFn: api.verifyAccountEmail });
  const accountEmail: AccountEmail | undefined = emailQuery.data?.accountEmail;

  useEffect(() => {
    if (cooldownUntil === null) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= cooldownUntil) setCooldownUntil(null);
    }, 250);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const cooldownSeconds = cooldownUntil === null ? 0 : Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const isBusy = requestCodeMutation.isPending || verifyMutation.isPending;
  const isEmailDeliveryUnavailable = accountEmail ? !accountEmail.emailDeliveryConfigured : false;
  const canManage = accountEmail?.canManage !== false;

  const requestCode = async () => {
    setNotice(null);
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setNotice({ type: "error", message: t("accountEmail.errors.invalidEmail") });
      return;
    }
    if (!currentPassword) {
      setNotice({ type: "error", message: t("accountEmail.errors.currentPasswordRequired") });
      return;
    }
    try {
      const result = await requestCodeMutation.mutateAsync({ email: normalizedEmail, currentPassword });
      setEmail(normalizedEmail);
      setCodeRequested(true);
      const requestedAt = Date.now();
      setNow(requestedAt);
      setCooldownUntil(requestedAt + result.cooldownSeconds * 1000);
      setNotice({ type: "success", message: t("accountEmail.codeSent", { minutes: result.expiresInMinutes }) });
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error, t) });
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    if (!code.trim()) {
      setNotice({ type: "error", message: t("accountEmail.errors.codeRequired") });
      return;
    }
    try {
      const result = await verifyMutation.mutateAsync({
        email: email.trim(),
        code: code.trim(),
        currentPassword,
      });
      queryClient.setQueryData(accountEmailQueryKey(accountId, sessionKey), result);
      await queryClient.invalidateQueries({ queryKey: accountEmailQueryKey(accountId, sessionKey) });
      setCode("");
      setCurrentPassword("");
      setCodeRequested(false);
      setCooldownUntil(null);
      setNotice({ type: "success", message: t("accountEmail.verified") });
      onCompleted?.();
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error, t) });
      await emailQuery.refetch();
    }
  };

  if (!supported) {
    return <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">{t(demoMode ? "accountEmail.unsupportedDemo" : accountType === "group" ? "accountEmail.unsupportedGroup" : "accountEmail.unsupportedLocal")}</p>;
  }

  if (emailQuery.isLoading) return <LoadingIndicator centered label={t("common.loading")} />;
  if (emailQuery.isError) {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-rose-600">{getErrorMessage(emailQuery.error, t)}</p>
        <Button onClick={() => void emailQuery.refetch()} type="button" variant="outline">{t("accountEmail.retry")}</Button>
      </div>
    );
  }

  return (
    <div className={embedded ? "space-y-4" : "space-y-4 p-4 pt-0"}>
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
        <p className="text-xs font-semibold text-slate-500">{t("accountEmail.statusLabel")}</p>
        <p className="mt-1 text-sm font-medium text-slate-900">
          {accountEmail?.emailVerifiedAt ? t("accountEmail.statusVerified") : accountEmail?.email ? t("accountEmail.statusUnverified") : t("accountEmail.statusUnbound")}
        </p>
        {accountEmail?.email ? <p className="mt-1 break-all text-sm text-slate-700">{accountEmail.email}</p> : null}
      </div>

      {accountEmail?.emailVerifiedAt && accountEmail.email ? (
        <p className="text-xs text-amber-800">{t("accountEmail.oldEmailContinues")}</p>
      ) : null}
      {isEmailDeliveryUnavailable ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{t("accountEmail.errors.smtpNotConfigured")}</p> : null}
      {!canManage ? <p className="text-sm text-slate-600" role="status">{t("accountEmail.errors.unavailable")}</p> : null}

      <form className="grid gap-3" onSubmit={(event) => void verify(event)}>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          {t("accountEmail.newEmail")}
          <Input aria-label={t("accountEmail.newEmail")} autoComplete="email" disabled={isBusy || isEmailDeliveryUnavailable || !canManage} onChange={(event) => { setEmail(event.target.value); setCodeRequested(false); setNotice(null); }} required type="email" value={email} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">
          {t("accountEmail.currentPassword")}
          <Input aria-label={t("accountEmail.currentPassword")} autoComplete="current-password" disabled={isBusy || isEmailDeliveryUnavailable || !canManage} onChange={(event) => { setCurrentPassword(event.target.value); setNotice(null); }} required type="password" value={currentPassword} />
        </label>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">
            {t("accountEmail.code")}
            <Input aria-label={t("accountEmail.code")} autoComplete="one-time-code" disabled={isBusy || !codeRequested || isEmailDeliveryUnavailable || !canManage} inputMode="numeric" onChange={(event) => { setCode(event.target.value); setNotice(null); }} required value={code} />
          </label>
          <Button disabled={isBusy || cooldownSeconds > 0 || isEmailDeliveryUnavailable || !canManage} onClick={() => void requestCode()} type="button" variant="outline">
            {requestCodeMutation.isPending ? t("accountEmail.sendingCode") : cooldownSeconds > 0 ? t("accountEmail.resendIn", { seconds: cooldownSeconds }) : t("accountEmail.sendCode")}
          </Button>
        </div>
        <p className="text-xs leading-5 text-slate-500">{t("accountEmail.requirements")}</p>
        {notice ? <p className={notice.type === "error" ? "text-sm text-rose-600" : "text-sm text-emerald-700"} role="alert">{notice.message}</p> : null}
        <div className="flex justify-end">
          <Button disabled={isBusy || !codeRequested || isEmailDeliveryUnavailable || !canManage} type="submit" variant="solid">
            {verifyMutation.isPending ? t("accountEmail.verifying") : t("accountEmail.confirm")}
          </Button>
        </div>
      </form>
    </div>
  );
};

export const AccountEmailCard = (props: Omit<AccountEmailFormProps, "embedded">) => {
  const { t } = useTranslation();
  return (
    <Card aria-label={t("accountEmail.title")} className="w-full min-w-0 overflow-hidden shadow-none" role="region">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}><Mail className={SETTINGS_CARD_ICON_CLASSNAME} />{t("accountEmail.title")}</CardTitle>
        <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>{t("accountEmail.description")}</CardDescription>
      </CardHeader>
      <AccountEmailForm {...props} />
    </Card>
  );
};

export const AccountEmailStatusIcon = () => <ShieldCheck className="h-4 w-4 text-emerald-600" />;
