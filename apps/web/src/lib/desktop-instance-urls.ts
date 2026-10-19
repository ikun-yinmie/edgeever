import { normalizeInstanceUrl } from "@edgeever/shared";

export const DESKTOP_INSTANCE_CANDIDATES_STORAGE_KEY = "edgeever.desktop.api-base-urls";
export const MAX_DESKTOP_INSTANCE_CANDIDATES = 8;

const normalizeCandidate = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const normalized = normalizeInstanceUrl(value);
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalized;
  } catch {
    return null;
  }
};

export const readDesktopInstanceCandidates = (): string[] => {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(DESKTOP_INSTANCE_CANDIDATES_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const entry of parsed) {
      const normalized = normalizeCandidate(entry);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push(normalized);
      if (candidates.length >= MAX_DESKTOP_INSTANCE_CANDIDATES) break;
    }
    return candidates;
  } catch {
    return [];
  }
};

export const writeDesktopInstanceCandidates = (values: string[]) => {
  if (typeof window === "undefined") return [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const value of values) {
    const normalized = normalizeCandidate(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
    if (candidates.length >= MAX_DESKTOP_INSTANCE_CANDIDATES) break;
  }
  try {
    window.localStorage.setItem(DESKTOP_INSTANCE_CANDIDATES_STORAGE_KEY, JSON.stringify(candidates));
  } catch {
    // Storage restrictions only disable the convenience list.
  }
  return candidates;
};

export const rememberDesktopInstanceCandidate = (primary: string, alternates: string[]) => {
  const normalizedPrimary = normalizeCandidate(primary);
  if (!normalizedPrimary) return readDesktopInstanceCandidates();
  return writeDesktopInstanceCandidates([normalizedPrimary, ...alternates]);
};

export const collectDesktopProbeUrls = (primary: string, alternates: string[]) => {
  const urls: string[] = [];
  for (const value of [primary, ...alternates]) {
    const normalized = normalizeCandidate(value);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  }
  return urls.slice(0, MAX_DESKTOP_INSTANCE_CANDIDATES);
};

export type DesktopInstanceProbeTiming = {
  url: string;
  ms: number | null;
};

export type DesktopInstanceProbeWinner = {
  url: string;
  ms: number;
};

export const pickFastestInstanceUrl = (timings: DesktopInstanceProbeTiming[]): DesktopInstanceProbeWinner | null => {
  let fastest: DesktopInstanceProbeWinner | null = null;
  for (const timing of timings) {
    if (typeof timing.ms !== "number") continue;
    if (!fastest || timing.ms < fastest.ms) fastest = { url: timing.url, ms: timing.ms };
  }
  return fastest;
};
