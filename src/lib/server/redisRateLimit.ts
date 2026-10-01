/**
 * Redis-backed sliding-window rate limiter — the identifier-engine surfaces
 * (canon v22), adapted from the founder's Express middleware to a framework-
 * neutral verdict helper; the op sequence carries verbatim.
 *
 * ZSET semantics per canon v22 (op order is load-bearing):
 *   MULTI: zRemRangeByScore -> zAdd -> zCard -> expire, single flat EXEC —
 *   node-redis v4 flat exec returns a plain results array (index 2 = zCard).
 * Identity chain: x-tenant-id -> client IP -> anonymous terminal fallback.
 * Availability: FAIL-OPEN on Redis unavailability — a limiter outage never
 * takes the ingestion surface down; it degrades to unlimited traffic with
 * the error surfaced (never swallowed).
 */

import { clientAddress } from './clientAddress';
import { getRedisClient } from './redisCache';

export interface RedisRateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

/**
 * The identifier-engine ingestion surface. The house public beta routes run
 * the in-memory fixed-window limiter at 30 req/min — this Redis window
 * matches that budget while being correct across isolates, and the two
 * limiters coexist by surface (canon v22: independent windows).
 */
export const IDENTIFIER_INGEST_RATE_LIMIT: RedisRateLimitConfig = {
  windowSeconds: 60,
  maxRequests: 30,
};

export type RedisRateLimitVerdict =
  | { ok: true; requestCount: number }
  | { ok: false; retryAfterSeconds: number };

/** The founder limiter's 429 body — carried verbatim. */
export const RATE_LIMIT_EXCEEDED_BODY = {
  status: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many requests. Rate limit threshold exceeded.',
} as const;

export async function redisSlidingWindowRateLimiter(
  request: Request,
  config: RedisRateLimitConfig,
): Promise<RedisRateLimitVerdict> {
  // Identity chain (canon v22): x-tenant-id -> req.ip -> anonymous. Express
  // req.ip maps to the house x-forwarded-for extraction (as in PR #73, the
  // Vercel-deployment adaptation); 'anonymous_client' is the terminal
  // fallback for a request with neither header nor extractable address.
  const clientId =
    request.headers.get('x-tenant-id') ||
    clientAddress(request) ||
    'anonymous_client';
  const key = `ratelimit:${clientId}`;
  const now = Date.now();
  const windowMillis = config.windowSeconds * 1000;
  const clearBefore = now - windowMillis;

  try {
    const redisClient = await getRedisClient();
    if (!redisClient) {
      // No Redis configured — fail open, zero traffic displaced.
      return { ok: true, requestCount: 0 };
    }
    const multi = redisClient.multi();
    multi.zRemRangeByScore(key, 0, clearBefore);
    multi.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    multi.zCard(key);
    multi.expire(key, config.windowSeconds);
    const results = await multi.exec();

    const requestCount = results ? (results[2] as number) : 0;

    if (requestCount > config.maxRequests) {
      return { ok: false, retryAfterSeconds: config.windowSeconds };
    }
    return { ok: true, requestCount };
  } catch (err) {
    console.error('Rate limiter encountered an error (failing open):', err);
    return { ok: true, requestCount: 0 };
  }
}
