import { useState, type FormEvent } from "react";
import { Gauge, LockKeyhole, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normalizeInstanceUrl } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { GitHubRepositoryLink } from "@/components/GitHubRepositoryLink";
import { Input } from "@/components/ui/input";
import { getSiteDisplayName, useSiteBranding } from "@/lib/site-branding";
import { getConfiguredDesktopApiBaseUrl, probeDesktopInstanceUrls, selectActiveDesktopApiBaseUrl } from "@/lib/api";
import {
  DEFAULT_DESKTOP_PROXY_SETTINGS,
  getDesktopProxySettings,
  isDesktopProxyConfigured,
  probeDesktopProxyForSession,
  saveDesktopProxySettings,
  type DesktopProxyProbeResult,
  type DesktopProxyProtocol,
  type DesktopProxySettings,
} from "@/lib/desktop-proxy";
import {
  MAX_DESKTOP_INSTANCE_CANDIDATES,
  collectDesktopProbeUrls,
  pickFastestInstanceUrl,
  readDesktopInstanceCandidates,
  rememberDesktopInstanceCandidate,
} from "@/lib/desktop-instance-urls";

interface LoginScreenProps {
  error: { message: string; diagnosticCode: string; rayId?: string } | null;
  instanceUrl?: string;
  isSubmitting: boolean;
  onRegister?: () => void;
  onSubmit: (payload: { instanceUrl?: string; instanceActiveUrl?: string; username: string; password: string }) => void;
}

const DEMO_LOGIN_CREDENTIALS = {
  username: "ee-demo",
  password: "demo#dZ6Q29Zjfor%",
};

const getDefaultLoginCredentials = () => {
  const hostname = window.location.hostname;
  const isDemoHost = hostname === "demo.edgeever.org" || hostname.startsWith("edgeever-demo.");

  return isDemoHost ? DEMO_LOGIN_CREDENTIALS : { username: "admin", password: "" };
};

export const LoginScreen = ({ error, instanceUrl: initialInstanceUrl, isSubmitting, onRegister, onSubmit }: LoginScreenProps) => {
  const { t } = useTranslation();
  const siteName = getSiteDisplayName(useSiteBranding());
  const [instanceUrl, setInstanceUrl] = useState(initialInstanceUrl ?? "");
  const [username, setUsername] = useState(() => getDefaultLoginCredentials().username);
  const [password, setPassword] = useState(() => getDefaultLoginCredentials().password);
  const desktopNetworkSettings = initialInstanceUrl !== undefined && Boolean(window.edgeeverDesktop?.isAvailable);
  const [proxySettings, setProxySettings] = useState<DesktopProxySettings>(() => (
    desktopNetworkSettings ? getDesktopProxySettings() : DEFAULT_DESKTOP_PROXY_SETTINGS
  ));
  const [proxyProbe, setProxyProbe] = useState<DesktopProxyProbeResult | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const desktopInstanceSwitch = desktopNetworkSettings && typeof window.edgeeverDesktop?.probeInstanceUrls === "function";
  const [alternates, setAlternates] = useState<string[]>(() => {
    if (!desktopNetworkSettings) return [];
    const primary = initialInstanceUrl ? normalizeInstanceUrl(initialInstanceUrl) : "";
    return readDesktopInstanceCandidates().filter((candidate) => candidate !== primary);
  });
  const [alternateDraft, setAlternateDraft] = useState("");
  const [instanceProbe, setInstanceProbe] = useState<{ url: string; ms: number } | null>(null);
  const [instanceProbeFailed, setInstanceProbeFailed] = useState(false);
  const [instanceBusy, setInstanceBusy] = useState(false);

  const currentPrimaryUrl = () => (instanceUrl.trim() ? normalizeInstanceUrl(instanceUrl) : getConfiguredDesktopApiBaseUrl());

  const persistProxySettings = (next: DesktopProxySettings) => {
    setProxySettings(next);
    if (next.mode === "off" || isDesktopProxyConfigured(next)) {
      void saveDesktopProxySettings(next).catch(() => {});
    }
  };

  const runProxyProbe = async () => {
    if (proxyBusy || !isDesktopProxyConfigured(proxySettings)) return;
    setProxyBusy(true);
    try {
      const result = await probeDesktopProxyForSession(normalizeInstanceUrl(instanceUrl));
      setProxyProbe(result);
    } catch {
      setProxyProbe(null);
    } finally {
      setProxyBusy(false);
    }
  };

  const runInstanceProbe = async () => {
    if (instanceBusy || alternates.length === 0) return null;
    const urls = collectDesktopProbeUrls(currentPrimaryUrl(), alternates);
    if (urls.length < 2) return null;
    setInstanceBusy(true);
    try {
      const timings = await probeDesktopInstanceUrls(urls);
      if (timings.length === 0) return null;
      const fastest = pickFastestInstanceUrl(timings);
      setInstanceProbeFailed(!fastest);
      setInstanceProbe(fastest);
      if (fastest && fastest.url !== getConfiguredDesktopApiBaseUrl()) {
        await selectActiveDesktopApiBaseUrl(fastest.url);
      }
      return fastest;
    } catch {
      setInstanceProbeFailed(true);
      return null;
    } finally {
      setInstanceBusy(false);
    }
  };

  const addAlternate = () => {
    const raw = alternateDraft.trim();
    if (!raw) return;
    setAlternateDraft("");
    try {
      const normalized = normalizeInstanceUrl(raw);
      const parsed = new URL(normalized);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (normalized === currentPrimaryUrl() || alternates.includes(normalized)) return;
      const next = [...alternates, normalized].slice(0, MAX_DESKTOP_INSTANCE_CANDIDATES - 1);
      setAlternates(next);
      rememberDesktopInstanceCandidate(currentPrimaryUrl(), next);
    } catch {
      // Invalid addresses are simply not added.
    }
  };

  const removeAlternate = (value: string) => {
    const next = alternates.filter((candidate) => candidate !== value);
    setAlternates(next);
    rememberDesktopInstanceCandidate(currentPrimaryUrl(), next);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if ((initialInstanceUrl !== undefined && !instanceUrl.trim()) || !username.trim() || !password) {
      return;
    }

    if (desktopInstanceSwitch && instanceUrl.trim()) {
      rememberDesktopInstanceCandidate(normalizeInstanceUrl(instanceUrl), alternates);
    }
    if (desktopNetworkSettings && proxySettings.mode === "auto" && isDesktopProxyConfigured(proxySettings)) {
      await runProxyProbe();
    }
    const fastestInstance = desktopInstanceSwitch && instanceUrl.trim() && alternates.length > 0
      ? await runInstanceProbe()
      : null;

    onSubmit({
      ...(initialInstanceUrl !== undefined ? { instanceUrl: normalizeInstanceUrl(instanceUrl) } : {}),
      ...(fastestInstance ? { instanceActiveUrl: fastestInstance.url } : {}),
      username: username.trim(),
      password,
    });
  };

  const proxyLatency = (value: number | null) =>
    value === null ? t("login.desktopProxyProbeUnavailable") : t("login.desktopProxyProbeLatencyValue", { ms: value });

  return (
    <main className="flex h-[100dvh] items-center justify-center bg-[var(--workspace-canvas)] px-4 py-8 text-slate-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgb(var(--brand-green-rgb)/0.045),transparent_42%)]" />
      <GitHubRepositoryLink className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 h-10 w-10 justify-center rounded-full border border-slate-200 bg-card/85 text-slate-600 backdrop-blur transition hover:border-slate-300 hover:bg-card hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60" iconClassName="h-5 w-5" />

      <section className="relative w-full max-w-[400px] rounded-2xl border border-slate-200 bg-card/95 p-8 shadow-[0_20px_50px_rgb(0_0_0/0.08)] backdrop-blur-md">
        <div className="mb-8 flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-[0_8px_18px_-8px_rgb(var(--brand-green-rgb)/0.45)]">
            <LockKeyhole className="h-5.5 w-5.5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight tracking-tight text-slate-900">{t("login.title", { site: siteName })}</h1>
            <p className="mt-1 text-xs font-medium tracking-wide text-slate-500">{t("login.subtitle")}</p>
          </div>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          {error ? (
            <div
              className="rounded-lg border border-rose-100 bg-rose-50/80 px-3.5 py-3 text-rose-800 transition duration-150 animate-shake"
              role="alert"
            >
              <p className="text-sm font-medium leading-6">{error.message}</p>
              <p className="mt-1 font-mono text-[11px] text-rose-500">
                {t("login.diagnosticCode", { code: error.diagnosticCode })}
              </p>
              {error.rayId ? (
                <p className="mt-0.5 break-all font-mono text-[11px] text-rose-500">
                  {t("login.cloudflareRayId", { id: error.rayId })}
                </p>
              ) : null}
            </div>
          ) : null}

          {initialInstanceUrl !== undefined ? (
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-700">{t("login.desktopInstanceUrl")}</span>
              <Input
                autoCapitalize="none"
                autoComplete="url"
                autoCorrect="off"
                className="h-11 rounded-lg bg-slate-50/50 px-3.5 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-emerald-500/20"
                inputMode="url"
                placeholder={t("login.instanceUrlPlaceholder")}
                required
                spellCheck={false}
                value={instanceUrl}
                onChange={(event) => setInstanceUrl(event.target.value)}
              />
            </label>
          ) : null}

          {desktopNetworkSettings ? (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-700">{t("login.desktopProxySection")}</span>
                {proxyProbe ? (
                  <span className="text-[11px] font-medium text-emerald-700">
                    {t(proxyProbe.chosen === "proxy" ? "login.desktopProxyProbeChosenProxy" : "login.desktopProxyProbeChosenDirect")}
                  </span>
                ) : null}
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-500">{t("login.desktopProxyMode")}</span>
                <select
                  className="h-9 w-full rounded-md border border-slate-200 bg-card px-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                  value={proxySettings.mode}
                  onChange={(event) => persistProxySettings({ ...proxySettings, mode: event.target.value as DesktopProxySettings["mode"] })}
                >
                  <option value="off">{t("login.desktopProxyModeOff")}</option>
                  <option value="auto">{t("login.desktopProxyModeAuto")}</option>
                  <option value="always">{t("login.desktopProxyModeAlways")}</option>
                </select>
              </label>
              {proxySettings.mode !== "off" ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-[104px_1fr_78px] gap-2">
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-500">{t("login.desktopProxyProtocol")}</span>
                      <select
                        className="h-9 w-full rounded-md border border-slate-200 bg-card px-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                        value={proxySettings.protocol}
                        onChange={(event) => persistProxySettings({ ...proxySettings, protocol: event.target.value as DesktopProxyProtocol })}
                      >
                        <option value="http">HTTP</option>
                        <option value="socks5">SOCKS5</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-500">{t("login.desktopProxyHost")}</span>
                      <Input
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="h-9 rounded-md bg-card px-2.5 text-sm"
                        placeholder="127.0.0.1"
                        spellCheck={false}
                        value={proxySettings.host}
                        onBlur={() => persistProxySettings(proxySettings)}
                        onChange={(event) => setProxySettings({ ...proxySettings, host: event.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-slate-500">{t("login.desktopProxyPort")}</span>
                      <Input
                        className="h-9 rounded-md bg-card px-2.5 text-sm"
                        inputMode="numeric"
                        placeholder="7890"
                        value={proxySettings.port > 0 ? String(proxySettings.port) : ""}
                        onBlur={() => persistProxySettings(proxySettings)}
                        onChange={(event) => {
                          const port = Number.parseInt(event.target.value.replace(/\D/g, ""), 10);
                          setProxySettings({ ...proxySettings, port: Number.isInteger(port) ? port : 0 });
                        }}
                      />
                    </label>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] leading-4 text-slate-500">
                      {proxyProbe
                        ? t("login.desktopProxyProbeResult", {
                            direct: proxyLatency(proxyProbe.directMs),
                            proxy: proxyLatency(proxyProbe.proxyMs),
                          })
                        : t("login.desktopProxyHint")}
                    </span>
                    <Button
                      className="h-8 shrink-0 rounded-md px-2.5 text-xs"
                      disabled={proxyBusy || !isDesktopProxyConfigured(proxySettings)}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => {
                        void runProxyProbe();
                      }}
                    >
                      <Gauge className="mr-1 h-3.5 w-3.5" />
                      {proxyBusy ? t("login.desktopProxyProbing") : t("login.desktopProxyProbe")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {desktopInstanceSwitch ? (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-700">{t("login.desktopAlternatesSection")}</span>
                <Button
                  className="h-8 shrink-0 rounded-md px-2.5 text-xs"
                  disabled={instanceBusy || alternates.length === 0}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void runInstanceProbe();
                  }}
                >
                  <Gauge className="mr-1 h-3.5 w-3.5" />
                  {instanceBusy ? t("login.desktopInstanceProbing") : t("login.desktopInstanceProbe")}
                </Button>
              </div>
              <p className="text-[11px] leading-4 text-slate-500">{t("login.desktopAlternatesHint")}</p>
              {alternates.length > 0 ? (
                <ul className="space-y-1.5">
                  {alternates.map((candidate) => (
                    <li
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-card px-2.5 py-1.5"
                      key={candidate}
                    >
                      <span className="truncate text-xs text-slate-700">{candidate}</span>
                      <button
                        aria-label={t("login.desktopAlternateRemove")}
                        className="shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                        type="button"
                        onClick={() => removeAlternate(candidate)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-center gap-2">
                <Input
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="h-9 flex-1 rounded-md bg-card px-2.5 text-sm"
                  placeholder={t("login.desktopAlternatePlaceholder")}
                  spellCheck={false}
                  value={alternateDraft}
                  onChange={(event) => setAlternateDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addAlternate();
                    }
                  }}
                />
                <Button
                  className="h-9 shrink-0 rounded-md px-3 text-xs"
                  disabled={!alternateDraft.trim() || alternates.length >= MAX_DESKTOP_INSTANCE_CANDIDATES - 1}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={addAlternate}
                >
                  {t("login.desktopAlternateAdd")}
                </Button>
              </div>
              {instanceProbe ? (
                <p className="text-[11px] leading-4 text-emerald-700">
                  {t("login.desktopInstanceProbeFastest", { url: instanceProbe.url, ms: instanceProbe.ms })}
                </p>
              ) : null}
              {instanceProbeFailed ? (
                <p className="text-[11px] leading-4 text-amber-600">{t("login.desktopInstanceProbeAllUnreachable")}</p>
              ) : null}
              <p className="text-[11px] leading-4 text-slate-400">{t("login.desktopAlternatesPrimaryHint")}</p>
            </div>
          ) : null}

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">{t("login.username")}</span>
            <Input
              autoComplete="username"
              className="h-11 rounded-lg bg-slate-50/50 px-3.5 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-emerald-500/20"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">{t("login.password")}</span>
            <Input
              autoComplete="current-password"
              className="h-11 rounded-lg bg-slate-50/50 px-3.5 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-emerald-500/20"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <Button
            className="h-11 w-full justify-center rounded-lg bg-emerald-500 font-semibold text-white shadow-[0_8px_20px_-8px_rgb(var(--brand-green-rgb)/0.35)] transition-colors duration-200 hover:bg-emerald-600"
            size="md"
            type="submit"
            variant="solid"
            disabled={isSubmitting}
          >
            <LockKeyhole className="h-4 w-4 mr-1" />
            {isSubmitting ? t("login.submitting") : t("login.submit")}
          </Button>

          {onRegister ? (
            <button
              className="w-full text-center text-xs font-medium text-emerald-700 transition hover:text-emerald-800"
              onClick={onRegister}
              type="button"
            >
              {t("register.goToRegister")}
            </button>
          ) : null}
        </form>
      </section>
    </main>
  );
};
