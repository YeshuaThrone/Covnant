/**
 * In-memory fixed-window rate limiter (the drop's in-memory limiter).
 *
 * SERVERLESS CAVEAT — read before trusting this in production: the counters
 * below live in module memory. On a serverless platform (Vercel functions)
 * memory is per-isolate: counters reset on every cold start and are NOT
 * shared across concurrently warm instances, so the limit is both
 * bypassable (requests spread across isolates) and self-defeating (a cold
 * start wipes the bucket). This is a dev-phase best-effort guard — the live
 * route header had deferred abuse-hardening by directive. Production
 * hardening needs an external store (Upstash Redis, or a Supabase counter
 * table behind the service role); the signup contract doc carries the same
 * caveat.
 */

export type RateLimitConfig = {
  /** Maximum requests allowed per window per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/** Signup registration: 5 requests per client address per minute. */
export const REGISTER_RATE_LIMIT: RateLimitConfig = { limit: 5, windowMs: 60_000 };

/** Admin console sign-in: 5 attempts per client address per minute (the shared secret's brute-force window). */
export const ADMIN_LOGIN_RATE_LIMIT: RateLimitConfig = { limit: 5, windowMs: 60_000 };

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();

/** Bound the map: drop expired buckets once the table grows past this size. */
const SWEEP_THRESHOLD = 10_000;

function sweepExpired(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitVerdict {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket === undefined || now - bucket.windowStart >= config.windowMs) {
    if (buckets.size >= SWEEP_THRESHOLD) {
      sweepExpired(now, config.windowMs);
    }
    buckets.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (bucket.count >= config.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStart + config.windowMs - now) / 1000),
    );
    return { ok: false, retryAfterSeconds };
  }
  bucket.count += 1;
  return { ok: true };
}

/** Test-only: clear every bucket (module state outlives individual tests). */
export function resetRateLimits(): void {
  buckets.clear();
}
