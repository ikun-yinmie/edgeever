import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { ApiRequestError, api } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { createClientUuid } from "@/lib/client-id";
import { getClientRuntimeDiagnostics } from "@/lib/system-diagnostics";
import { getShareableWebSystemInfoItems, type SystemInfoDiagnostics } from "./SystemInfoPanel";

type FeedbackPayload = Parameters<typeof api.submitFeedback>[0];

export const FeedbackDialog = ({
  diagnostics,
  extraSystemInfo,
  open,
  onOpenChange,
}: {
  diagnostics?: SystemInfoDiagnostics | null;
  /** Already sanitized diagnostics included only when the user opts in. */
  extraSystemInfo?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t, i18n } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [includeSystemInfo, setIncludeSystemInfo] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ content?: string; replyTo?: string }>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  // Keep the exact payload for a failed attempt, including its diagnostics snapshot.
  const requestRef = useRef<FeedbackPayload | null>(null);
  const submittingRef = useRef(false);
  const configQuery = useQuery({
    queryKey: ["public-feedback"],
    queryFn: api.getFeedbackConfig,
    enabled: open,
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

  useEffect(() => {
    if (open) {
      setSucceeded(false);
      setCopyState("idle");
    }
  }, [open]);

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
      || (includeSystemInfo && clientRuntimeQuery.isFetching)) return;
    const trimmedContent = content.trim();
    const trimmedReplyTo = replyTo.trim();
    const nextErrors = {
      ...(trimmedContent.length < 1 || trimmedContent.length > 5000 ? { content: t("feedback.contentInvalid") } : {}),
      ...(trimmedReplyTo && !z.email().max(200).safeParse(trimmedReplyTo).success ? { replyTo: t("feedback.replyToInvalid") } : {}),
    };
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    submittingRef.current = true;
    setErrorKey(null);
    try {
      requestRef.current ??= {
        requestId: createClientUuid(),
        content: trimmedContent,
        replyTo: trimmedReplyTo || null,
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
      setReplyTo("");
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
          : code === "email_delivery_failed" ? "feedback.deliveryFailed" : "feedback.submitFailed");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("feedback.title")}</DialogTitle>
          <DialogDescription>{t("feedback.dialogDescription")}</DialogDescription>
        </DialogHeader>

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
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor={`${id}-content`}>{t("feedback.issueContentHeading")}</label>
              <textarea
                aria-describedby={fieldErrors.content ? `${id}-content-error` : `${id}-limit`}
                aria-invalid={Boolean(fieldErrors.content)}
                className="flex min-h-36 w-full resize-y rounded-md border border-slate-200 bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 sm:text-sm"
                disabled={submitMutation.isPending}
                id={`${id}-content`}
                onChange={(event) => { changeDraft(); setContent(event.target.value); }}
                placeholder={t("feedback.issueContentPrompt")}
                value={content}
              />
              <p className="text-xs text-slate-500" id={`${id}-limit`}>{t("feedback.contentLimit", { count: content.trim().length })}</p>
              {fieldErrors.content ? <p className="text-xs text-rose-600" id={`${id}-content-error`} role="alert">{fieldErrors.content}</p> : null}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor={`${id}-reply`}>{t("feedback.replyToLabel")}</label>
              <Input
                aria-describedby={fieldErrors.replyTo ? `${id}-reply-error` : undefined}
                aria-invalid={Boolean(fieldErrors.replyTo)}
                autoComplete="email"
                disabled={submitMutation.isPending}
                id={`${id}-reply`}
                maxLength={200}
                onChange={(event) => { changeDraft(); setReplyTo(event.target.value); }}
                type="email"
                value={replyTo}
              />
              {fieldErrors.replyTo ? <p className="text-xs text-rose-600" id={`${id}-reply-error`} role="alert">{fieldErrors.replyTo}</p> : null}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={includeSystemInfo} disabled={submitMutation.isPending} onCheckedChange={(checked) => { changeDraft(); setIncludeSystemInfo(checked === true); }} />
              <span>{t("feedback.includeSystemInfo")}<span className="mt-1 block text-xs text-slate-500">{t("feedback.systemInfoNotice")}</span></span>
            </label>
            <p className="text-xs text-slate-500">{t("feedback.onlinePrivacyNotice")}</p>
            <p className="text-xs text-slate-500">{t("feedback.quotaHint")}</p>
            {errorKey ? <p className="text-sm text-rose-600" role="alert">{t(errorKey)}</p> : null}
            {errorKey && contactDetails ? <div className="space-y-2 text-sm"><p>{t("feedback.contactAdminHint")}</p>{contactDetails}</div> : null}
            {retryAt !== null ? <p className="text-sm text-amber-800" role="status">{t("feedback.retryAt", { time: new Date(retryAt).toLocaleString(i18n.language) })}</p> : null}
          </form>
        )}

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">{t("common.close")}</Button>
          {feedback?.enabled && !configQuery.isFetching && !configQuery.isError && !succeeded ? (
            <Button disabled={submitMutation.isPending || retryAt !== null || (includeSystemInfo && clientRuntimeQuery.isFetching)} form={`${id}-form`} type="submit" variant="solid">
              {t(submitMutation.isPending ? "feedback.submitting" : "feedback.submit")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
