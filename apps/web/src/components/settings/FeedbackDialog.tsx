import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { ApiRequestError, api, type AccountEmail } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { createClientUuid } from "@/lib/client-id";
import { getClientRuntimeDiagnostics } from "@/lib/system-diagnostics";
import { AccountEmailForm, accountEmailQueryKey } from "./AccountEmailCard";
import { getShareableWebSystemInfoItems, type SystemInfoDiagnostics } from "./SystemInfoPanel";

type FeedbackPayload = Parameters<typeof api.submitFeedback>[0];

type FeedbackDialogProps = {
  diagnostics?: SystemInfoDiagnostics | null;
  /** Already sanitized diagnostics included only when the user opts in. */
  extraSystemInfo?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId?: string | null;
  accountType?: "user" | "group";
  authRequired?: boolean;
  demoMode?: boolean;
  sessionKey?: string;
};

export const FeedbackDialog = ({
  diagnostics,
  extraSystemInfo,
  open,
  onOpenChange,
  accountId = null,
  accountType,
  authRequired = false,
  demoMode = false,
  sessionKey = "default",
}: FeedbackDialogProps) => {
  const { t, i18n } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [includeSystemInfo, setIncludeSystemInfo] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ content?: string }>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [showEmailManager, setShowEmailManager] = useState(false);
  // Keep the exact payload for a failed attempt, including its diagnostics snapshot.
  const requestRef = useRef<FeedbackPayload | null>(null);
  const submittingRef = useRef(false);
  const supportedAccount = Boolean(accountId && authRequired && !demoMode && accountType !== "group");
  const configQuery = useQuery({
    queryKey: ["public-feedback"],
    queryFn: api.getFeedbackConfig,
    enabled: open,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const accountEmailQuery = useQuery({
    queryKey: accountEmailQueryKey(accountId, sessionKey),
    queryFn: api.getAccountEmail,
    enabled: open && supportedAccount,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const clientRuntimeQuery = useQuery({
    queryKey: ["system-info-client-runtime"],
    queryFn: getClientRuntimeDiagnostics,
    enabled: open && includeSystemInfo,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const submitMutation = useMutation({ mutationFn: api.submitFeedback, retry: false });
  const feedback = configQuery.data?.feedback;
  const accountEmail: AccountEmail | undefined = accountEmailQuery.data?.accountEmail;
  const accountEmailReady = Boolean(
    supportedAccount
    && !accountEmailQuery.isFetching
    && !accountEmailQuery.isError
    && accountEmail?.email
    && accountEmail.emailVerifiedAt
    && accountEmail.canManage
    && accountEmail.emailDeliveryConfigured,
  );

  useEffect(() => {
    if (open) {
      setSucceeded(false);
      setCopyState("idle");
      setShowEmailManager(false);
    }
  }, [open]);

  useEffect(() => {
    setContent("");
    setIncludeSystemInfo(false);
    setFieldErrors({});
    setErrorKey(null);
    setSucceeded(false);
    setShowEmailManager(false);
    requestRef.current = null;
  }, [accountId, sessionKey]);

  useEffect(() => {
    if (retryAt === null) return;
    const timeout = window.setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [retryAt]);

  const changeDraft = () => {
    requestRef.current = null;
    setFieldErrors({});
    // A server-provided waiting period survives draft changes and reopening.
    if (retryAt === null) setErrorKey(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || retryAt !== null || !feedback?.enabled || configQuery.isFetching
      || accountEmailQuery.isFetching || !accountEmailReady || (includeSystemInfo && clientRuntimeQuery.isFetching)) return;
    const trimmedContent = content.trim();
    const nextErrors = trimmedContent.length < 1 || trimmedContent.length > 5000
      ? { content: t("feedback.contentInvalid") }
      : {};
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    submittingRef.current = true;
    setErrorKey(null);
    try {
      requestRef.current ??= {
        requestId: createClientUuid(),
        content: trimmedContent,
        systemInfo: includeSystemInfo
          ? [
            getShareableWebSystemInfoItems(t, i18n.language, {
              ...diagnostics,
              clientRuntime: clientRuntimeQuery.data,
            }).map(({ label, value }) => `${label}: ${value}`).join("\n"),
            extraSystemInfo,
          ].filter(Boolean).join("\n\n")
          : null,
      };
      await submitMutation.mutateAsync(requestRef.current);
      setContent("");
      setIncludeSystemInfo(false);
      requestRef.current = null;
      setRetryAt(null);
      setSucceeded(true);
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      const details = error instanceof ApiRequestError && error.details && typeof error.details === "object"
        ? error.details as { contactEmail?: unknown; retryAfterSeconds?: unknown }
        : {};
      if (code === "feedback_disabled") {
        queryClient.setQueryData(["public-feedback"], {
          feedback: {
            enabled: false,
            contactEmail: details.contactEmail === null || typeof details.contactEmail === "string" ? details.contactEmail : feedback.contactEmail,
          },
        });
      } else {
        setErrorKey(code === "feedback_rate_limited" ? "feedback.rateLimited"
          : code === "feedback_busy" ? "feedback.busy"
          : code === "email_delivery_failed" ? "feedback.deliveryFailed"
          : code === "feedback_email_unverified" ? "feedback.emailUnverified"
          : code === "feedback_email_mismatch" ? "feedback.emailMismatch"
          : "feedback.submitFailed");
        if (code === "feedback_email_unverified") await accountEmailQuery.refetch();
        if ((code === "feedback_rate_limited" || code === "feedback_busy")
          && typeof details.retryAfterSeconds === "number" && Number.isFinite(details.retryAfterSeconds)
          && details.retryAfterSeconds > 0) {
          setRetryAt(Date.now() + details.retryAfterSeconds * 1000);
        }
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const copyContact = async () => {
    if (!feedback?.contactEmail) return;
    try {
      setCopyState(await copyTextToClipboard(feedback.contactEmail) ? "copied" : "error");
    } catch {
      setCopyState("error");
    }
  };

  const contactDetails = feedback?.contactEmail ? (
    <div className="flex flex-wrap items-center gap-3">
      <a className="break-all font-medium text-emerald-700 underline" href={`mailto:${feedback.contactEmail}`}>{feedback.contactEmail}</a>
      <Button onClick={() => void copyContact()} type="button" variant="outline">{t("feedback.copyEmail")}</Button>
      {copyState !== "idle" ? <p className="w-full text-xs" role="status">{t(copyState === "copied" ? "feedback.emailCopied" : "feedback.emailCopyFailed")}</p> : null}
    </div>
  ) : null;

  const accountGate = !supportedAccount ? (
    <div className="space-y-3" role="status">
      <p className="text-sm text-amber-900">{t(demoMode ? "feedback.emailUnsupportedDemo" : accountType === "group" ? "feedback.emailUnsupportedGroup" : "feedback.emailUnsupportedLocal")}</p>
    </div>
  ) : accountEmailQuery.isFetching ? (
    <LoadingIndicator label={t("feedback.loadingEmail")} centered />
  ) : accountEmailQuery.isError ? (
    <div className="space-y-3" role="alert">
      <p className="text-sm text-rose-600">{t("feedback.emailUnavailable")}</p>
      <Button onClick={() => void accountEmailQuery.refetch()} type="button" variant="outline">{t("feedback.retry")}</Button>
    </div>
  ) : !accountEmail?.emailDeliveryConfigured ? (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{t("feedback.smtpNotConfigured")}</p>
  ) : !accountEmail?.email || !accountEmail.emailVerifiedAt ? (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3" role="status">
      <p className="text-sm text-amber-900">{t(accountEmail?.email ? "feedback.emailUnverified" : "feedback.emailNotBound")}</p>
      <Button onClick={() => setShowEmailManager(true)} type="button" variant="outline">{t("feedback.manageEmail")}</Button>
    </div>
  ) : (
    <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 px-3 py-2.5">
      <p className="text-xs font-semibold text-emerald-800">{t("feedback.fixedEmailLabel")}</p>
      <p className="mt-1 break-all text-sm font-medium text-emerald-950">{accountEmail.email}</p>
      <p className="mt-1 text-xs text-emerald-800">{t("feedback.fixedEmailHint")}</p>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t(showEmailManager ? "accountEmail.title" : "feedback.title")}</DialogTitle>
          <DialogDescription>{t(showEmailManager ? "accountEmail.description" : "feedback.dialogDescription")}</DialogDescription>
        </DialogHeader>

        {showEmailManager ? (
          <>
            <AccountEmailForm
              accountId={accountId}
              accountType={accountType}
              authRequired={authRequired}
              demoMode={demoMode}
              embedded
              onCompleted={() => setShowEmailManager(false)}
              sessionKey={sessionKey}
            />
            <DialogFooter>
              <Button onClick={() => setShowEmailManager(false)} type="button" variant="outline">{t("feedback.backToFeedback")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {configQuery.isFetching ? (
              <LoadingIndicator label={t("feedback.loadingConfig")} centered />
            ) : configQuery.isError ? (
              <div className="space-y-3">
                <p className="text-sm text-rose-600" role="alert">{t("feedback.configFailed")}</p>
                <Button onClick={() => void configQuery.refetch()} type="button" variant="outline">{t("feedback.retry")}</Button>
              </div>
            ) : !feedback?.enabled ? (
              <div className="space-y-3 text-sm" role="status">
                <p className="break-words">{t(feedback?.contactEmail ? "feedback.disabledWithContact" : "feedback.disabledWithoutContact", { email: feedback?.contactEmail })}</p>
                {contactDetails}
              </div>
            ) : succeeded ? (
              <p className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800" role="status">{t("feedback.success")}</p>
            ) : (
              <form className="space-y-4" id={`${id}-form`} noValidate onSubmit={(event) => void handleSubmit(event)}>
                {accountGate}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor={`${id}-content`}>{t("feedback.issueContentHeading")}</label>
                  <textarea
                    aria-describedby={fieldErrors.content ? `${id}-content-error` : `${id}-limit`}
                    aria-invalid={Boolean(fieldErrors.content)}
                    className="flex min-h-36 w-full resize-y rounded-md border border-slate-200 bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 sm:text-sm"
                    disabled={submitMutation.isPending || !accountEmailReady}
                    id={`${id}-content`}
                    onChange={(event) => { changeDraft(); setContent(event.target.value); }}
                    placeholder={t("feedback.issueContentPrompt")}
                    value={content}
                  />
                  <p className="text-xs text-slate-500" id={`${id}-limit`}>{t("feedback.contentLimit", { count: content.trim().length })}</p>
                  {fieldErrors.content ? <p className="text-xs text-rose-600" id={`${id}-content-error`} role="alert">{fieldErrors.content}</p> : null}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={includeSystemInfo} disabled={submitMutation.isPending || !accountEmailReady} onCheckedChange={(checked) => { changeDraft(); setIncludeSystemInfo(checked === true); }} />
                  <span>{t("feedback.includeSystemInfo")}<span className="mt-1 block text-xs text-slate-500">{t("feedback.systemInfoNotice")}</span></span>
                </label>
                <p className="text-xs text-slate-500">{t("feedback.onlinePrivacyNotice")}</p>
                <p className="text-xs text-slate-500">{t("feedback.quotaHint")}</p>
                {errorKey ? <p className="text-sm text-rose-600" role="alert">{t(errorKey)}</p> : null}
                {errorKey && contactDetails ? <div className="space-y-2 text-sm"><p>{t("feedback.contactAdminHint")}</p>{contactDetails}</div> : null}
                {retryAt !== null ? <p className="text-sm text-amber-800" role="status">{t("feedback.retryAt", { time: new Date(retryAt).toLocaleString(i18n.language) })}</p> : null}
              </form>
            )}
          </>
        )}

        {!showEmailManager ? (
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">{t("common.close")}</Button>
            {feedback?.enabled && !configQuery.isFetching && !configQuery.isError && !succeeded && !showEmailManager ? (
              <Button disabled={submitMutation.isPending || retryAt !== null || !accountEmailReady || (includeSystemInfo && clientRuntimeQuery.isFetching)} form={`${id}-form`} type="submit" variant="solid">
                {t(submitMutation.isPending ? "feedback.submitting" : "feedback.submit")}
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
