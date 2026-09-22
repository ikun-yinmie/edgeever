// Small in-process sliding-window rate limiter for abuse guards on
// unauthenticated endpoints (login, registration). Counters live in memory:
// they are per-container and reset on restart, which is acceptable for the
// single-container self-hosted deployment this app ships as.

const buckets = new Map<string, number[]>();
const MAX_BUCKETS = 20_000;

const prune = (now: number, windowMs: number) => {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, hits] of buckets) {
    if (hits.every((hit) => now - hit >= windowMs)) buckets.delete(key);
  }
};

/** Returns true when the action is allowed, false when it should be rejected. */
export const hitRateLimit = (key: string, limit: number, windowMs: number): boolean => {
  if (limit <= 0 || windowMs <= 0) return true;
  const now = Date.now();
  prune(now, windowMs);
  const hits = (buckets.get(key) ?? []).filter((hit) => now - hit < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
};
