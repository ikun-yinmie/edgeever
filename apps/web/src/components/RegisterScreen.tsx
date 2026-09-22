import { useEffect, useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiRequestError, api } from "@/lib/api";

interface RegisterScreenProps {
  codeRequired: boolean;
  onSuccess: () => void;
  onBackToLogin: () => void;
}

const RESEND_COOLDOWN_SECONDS = 60;

export const RegisterScreen = ({ codeRequired, onSuccess, onBackToLogin }: RegisterScreenProps) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const mapError = (error: unknown, fallback: string) => {
    if (error instanceof ApiRequestError) {
      return t(`register.errors.${error.code}`, fallback);
    }
    return fallback;
  };

  const handleSendCode = async () => {
    if (!email.trim() || cooldown > 0) return;
    setSendingCode(true);
    setCodeError(null);
    try {
      await api.requestRegistrationCode({ email: email.trim() });
      setCodeSent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      setCodeError(mapError(error, t("register.codeSendFailed")));
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !email.trim() || password.length < 8 || (codeRequired && !emailCode.trim())) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.register({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        email: email.trim(),
        password,
        emailCode: emailCode.trim() || "-",
      });
      onSuccess();
    } catch (error) {
      setSubmitError(mapError(error, t("register.submitFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex h-[100dvh] items-center justify-center bg-[var(--workspace-canvas)] px-4 py-8 text-slate-950">
      <section className="relative w-full max-w-[400px] rounded-2xl border border-slate-200 bg-card/95 p-8 shadow-[0_20px_50px_rgb(0_0_0/0.08)] backdrop-blur-md">
        <div className="mb-6 flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-[0_8px_18px_-8px_rgb(var(--brand-green-rgb)/0.45)]">
            <UserPlus className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight tracking-tight text-slate-900">{t("register.title")}</h1>
            <p className="mt-1 text-xs font-medium tracking-wide text-slate-500">{t("register.subtitle")}</p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {submitError || codeError ? (
            <div className="rounded-lg border border-rose-100 bg-rose-50/80 px-3.5 py-3 text-rose-800" role="alert">
              <p className="text-sm font-medium leading-6">{submitError ?? codeError}</p>
            </div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("register.username")}</span>
            <Input
              autoComplete="username"
              className="h-10"
              onChange={(event) => setUsername(event.target.value)}
              pattern="[a-zA-Z0-9_-]{2,80}"
              required
              value={username}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("register.displayName")}</span>
            <Input
              autoComplete="name"
              className="h-10"
              onChange={(event) => setDisplayName(event.target.value)}
              value={displayName}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("register.email")}</span>
            <div className="flex gap-2">
              <Input
                autoComplete="email"
                className="h-10 min-w-0 flex-1"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
              {codeRequired ? (
                <Button
                  className="h-10 shrink-0"
                  disabled={!email.trim() || cooldown > 0 || sendingCode}
                  onClick={handleSendCode}
                  type="button"
                  variant="outline"
                >
                  {cooldown > 0
                    ? t("register.resendIn", { seconds: cooldown })
                    : codeSent
                      ? t("register.resendCode")
                      : t("register.sendCode")}
                </Button>
              ) : null}
            </div>
          </label>

          {codeRequired ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-slate-600">{t("register.emailCode")}</span>
              <Input
                className="h-10 tracking-[0.3em]"
                inputMode="numeric"
                onChange={(event) => setEmailCode(event.target.value)}
                required
                value={emailCode}
              />
            </label>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-600">{t("register.password")}</span>
            <Input
              autoComplete="new-password"
              className="h-10"
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>

          <Button className="w-full" disabled={submitting} type="submit">
            {submitting ? t("register.submitting") : t("register.submit")}
          </Button>

          <button
            className="w-full text-center text-xs font-medium text-emerald-700 transition hover:text-emerald-800"
            onClick={onBackToLogin}
            type="button"
          >
            {t("register.backToLogin")}
          </button>
        </form>
      </section>
    </main>
  );
};
