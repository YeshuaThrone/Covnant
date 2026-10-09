import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_LOGIN_RATE_LIMIT,
  checkRateLimit,
  DON_API_RATE_LIMIT,
  MONEY_INITIATION_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
  resetRateLimits,
  SWEEP_THRESHOLD,
  type RateLimitConfig,
} from '../rateLimit';

/**
 * DON_API_RATE_LIMIT bucket behavior (Gen 14 foundation merge).
 *
 * The Don API routes share this module's in-memory fixed-window limiter
 * with admin login and signup. Pins: the Don rule is 30 requests per 60s
 * window, blocking starts on the 31st request, buckets reset after the
 * window, and the pre-existing rules keep their repo values (Cursor's drop
 * carried a different REGISTER_RATE_LIMIT — the repo's live consumers win).
 */
describe('rate limit rules', () => {
  it('adds the Don API rule at 30 requests per 60s window', () => {
    expect(DON_API_RATE_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it('keeps the repo-owned signup and admin-login rules untouched', () => {
    expect(REGISTER_RATE_LIMIT).toEqual({ limit: 5, windowMs: 60_000 });
    expect(ADMIN_LOGIN_RATE_LIMIT).toEqual({ limit: 5, windowMs: 60_000 });
  });
});

/**
 * The credential surfaces' in-memory fallback windows (bug-hunt C9). The
 * routes land on THIS limiter whenever the shared store is unavailable
 * (DATABASE_URL unset, or a store failure mid-flight) — the fallback must
 * keep enforcing each surface's window under the exact key its route uses.
 */
describe('credential surfaces in-memory fallback windows (bug-hunt C9)', () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimits();
  });

  it('blocks the 6th admin-login and signup attempt from one address within the window', () => {
    for (const [key, config] of [
      ['covnant-admin-login:203.0.113.5', ADMIN_LOGIN_RATE_LIMIT],
      ['covnant-signup:203.0.113.6', REGISTER_RATE_LIMIT],
    ] as const) {
      for (let i = 0; i < config.limit; i += 1) {
        expect(checkRateLimit(key, config).ok).toBe(true);
      }
      expect(checkRateLimit(key, config).ok).toBe(false);
    }
  });

  it('opens a fresh window once it elapses (the fallback stays a fixed window)', () => {
    const key = 'covnant-signup:203.0.113.6';
    for (let i = 0; i < REGISTER_RATE_LIMIT.limit; i += 1) {
      checkRateLimit(key, REGISTER_RATE_LIMIT);
    }
    expect(checkRateLimit(key, REGISTER_RATE_LIMIT).ok).toBe(false);

    vi.setSystemTime(1_000_000 + REGISTER_RATE_LIMIT.windowMs);
    expect(checkRateLimit(key, REGISTER_RATE_LIMIT).ok).toBe(true);
  });

  it('keeps the sync-license registration window at the Don rule for its bare-identity key', () => {
    for (let i = 0; i < DON_API_RATE_LIMIT.limit; i += 1) {
      checkRateLimit('203.0.113.7', DON_API_RATE_LIMIT);
    }
    expect(checkRateLimit('203.0.113.7', DON_API_RATE_LIMIT).ok).toBe(false);
    // A different address is untouched.
    expect(checkRateLimit('203.0.113.8', DON_API_RATE_LIMIT).ok).toBe(true);
  });
});

describe('DON_API_RATE_LIMIT bucket behavior', () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimits();
  });

  it('allows the first 30 requests and blocks the 31st', () => {
    for (let i = 0; i < DON_API_RATE_LIMIT.limit; i += 1) {
      expect(checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT).ok).toBe(true);
    }

    const blocked = checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('opens a fresh bucket once the 60s window elapses', () => {
    for (let i = 0; i < DON_API_RATE_LIMIT.limit; i += 1) {
      checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT);
    }
    expect(checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT).ok).toBe(false);

    vi.setSystemTime(1_000_000 + DON_API_RATE_LIMIT.windowMs);
    expect(checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT).ok).toBe(true);
  });

  it('tracks buckets per key: other clients and rules are unaffected', () => {
    for (let i = 0; i < DON_API_RATE_LIMIT.limit; i += 1) {
      checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT);
    }
    expect(checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT).ok).toBe(false);
    expect(checkRateLimit('don:5.6.7.8', DON_API_RATE_LIMIT).ok).toBe(true);
    expect(checkRateLimit('covnant-signup:1.2.3.4', REGISTER_RATE_LIMIT).ok).toBe(true);
  });

  it('reports whole seconds remaining when blocking mid-window', () => {
    for (let i = 0; i < DON_API_RATE_LIMIT.limit; i += 1) {
      checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT);
    }

    vi.setSystemTime(1_000_000 + 30_000); // halfway through the window
    const blocked = checkRateLimit('don:1.2.3.4', DON_API_RATE_LIMIT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBe(30);
    }
  });
});

/**
 * C10 — the sweep must judge each bucket by its OWN window, not the
 * triggering caller's.
 *
 * sweepExpired used to evaluate every bucket against the current caller's
 * windowMs: once the map crossed the sweep threshold, a caller on a short
 * window could delete live long-window (money-initiation) buckets
 * mid-window, silently restarting their count and lifting the throttle.
 * Pins: a 60s bucket at 4/5 survives a threshold sweep triggered by a
 * 5s-window caller and still enforces its own limit afterward.
 */
describe('sweepExpired judges each bucket by its own stored windowMs (C10)', () => {
  /** The short-window caller whose sweep must never touch the 60s bucket. */
  const SHORT_WINDOW: RateLimitConfig = { limit: 100, windowMs: 5_000 };
  const MONEY_KEY = 'money:1.2.3.4';

  beforeEach(() => {
    resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimits();
  });

  /** Push the map past the sweep threshold so the next fresh-key check sweeps. */
  function fillToSweepThreshold(): void {
    for (let i = 0; i < SWEEP_THRESHOLD; i += 1) {
      checkRateLimit(`sweep-filler:${i}`, SHORT_WINDOW);
    }
  }

  it('a live 60s bucket at 4/5 survives the sweep of a short-window caller and still exhausts at its own limit', () => {
    for (let i = 0; i < MONEY_INITIATION_RATE_LIMIT.limit - 1; i += 1) {
      expect(checkRateLimit(MONEY_KEY, MONEY_INITIATION_RATE_LIMIT).ok).toBe(true);
    }

    fillToSweepThreshold();

    // 6s in: past the short caller's whole window (so the buggy sweep reads
    // the money bucket as expired) but only 10% into the money bucket's own
    // 60s window.
    vi.setSystemTime(1_000_000 + 6_000);
    expect(checkRateLimit('sweep-trigger:9.9.9.9', SHORT_WINDOW).ok).toBe(true);

    // The bucket survived with its count intact: the 5th hit is still the
    // last allowed one ...
    expect(checkRateLimit(MONEY_KEY, MONEY_INITIATION_RATE_LIMIT).ok).toBe(true);
    // ... and the surviving bucket — not a fresh window — rejects the next hit.
    const blocked = checkRateLimit(MONEY_KEY, MONEY_INITIATION_RATE_LIMIT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('an exhausted 60s bucket still rejects immediately after the sweep of a short-window caller', () => {
    // Five allowed hits exhaust the 5-per-60s money budget (fixed-window
    // counting: the first rejection lands on the next hit).
    for (let i = 0; i < MONEY_INITIATION_RATE_LIMIT.limit; i += 1) {
      expect(checkRateLimit(MONEY_KEY, MONEY_INITIATION_RATE_LIMIT).ok).toBe(true);
    }

    fillToSweepThreshold();

    vi.setSystemTime(1_000_000 + 6_000);
    expect(checkRateLimit('sweep-trigger:9.9.9.9', SHORT_WINDOW).ok).toBe(true);

    // Pre-fix, the sweep deleted the exhausted bucket here, so this hit
    // opened a fresh 5-hit budget instead of being rejected.
    const blocked = checkRateLimit(MONEY_KEY, MONEY_INITIATION_RATE_LIMIT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // windowStart=1_000_000, now=1_006_000, own window 60s -> 54s left.
      expect(blocked.retryAfterSeconds).toBe(54);
    }
  });
});

