import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_LOGIN_RATE_LIMIT,
  checkRateLimit,
  DON_API_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
  resetRateLimits,
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
