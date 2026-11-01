/**
 * Best-effort in-memory sliding-window rate limiter for public endpoints (login, cron probes).
 * NOTE: per-instance memory — on serverless this limits bursts per warm instance only. For hard guarantees put an
 * edge limiter (Vercel WAF / Upstash) in front; recorded in docs/HANDOFF.md.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, opts: { limit: number; windowMs: number }, now: number = Date.now()): { allowed: boolean; remaining: number } {
  const cutoff = now - opts.windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= opts.limit) {
    buckets.set(key, hits);
    return { allowed: false, remaining: 0 };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.every((t) => t <= cutoff)) buckets.delete(k);
  }
  return { allowed: true, remaining: opts.limit - hits.length };
}
