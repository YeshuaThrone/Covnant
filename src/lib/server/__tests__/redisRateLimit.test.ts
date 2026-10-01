/**
 * Unit tests for the v22 Redis sliding-window limiter — mocks redisCache
 * (house convention: server modules are vi.mock'ed, never spun up).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clientAddress } from '../clientAddress';
import { getRedisClient } from '../redisCache';
import {
  IDENTIFIER_INGEST_RATE_LIMIT,
  redisSlidingWindowRateLimiter,
} from '../redisRateLimit';

vi.mock('../redisCache', () => ({ getRedisClient: vi.fn() }));

const mockGetRedisClient = vi.mocked(getRedisClient);

/** Flat-exec fake: records MULTI op order, returns [1, 1, zCard, true]. */
function makeFakeClient(zCard: number, fail = false) {
  const ops: string[] = [];
  const multi = {
    zRemRangeByScore: vi.fn(() => {
      ops.push('zRemRangeByScore');
      return multi;
    }),
    zAdd: vi.fn(() => {
      ops.push('zAdd');
      return multi;
    }),
    zCard: vi.fn(() => {
      ops.push('zCard');
      return multi;
    }),
    expire: vi.fn(() => {
      ops.push('expire');
      return multi;
    }),
    exec: vi.fn(() =>
      fail
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve([1, 1, zCard, true]),
    ),
  };
  return { ops, multi, client: { multi: vi.fn(() => multi) } };
}

const requestWith = (headers: Record<string, string>): Request =>
  new Request('http://localhost:3000/api/v1/identifiers/batch-ingest', {
    method: 'POST',
    headers,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v22 op sequence', () => {
  it('runs zRemRangeByScore -> zAdd -> zCard -> expire in one MULTI and reads zCard at index 2', async () => {
    const fake = makeFakeClient(5);
    mockGetRedisClient.mockResolvedValue(fake.client as never);

    const verdict = await redisSlidingWindowRateLimiter(
      requestWith({ 'x-tenant-id': 'tenant-alpha' }),
      IDENTIFIER_INGEST_RATE_LIMIT,
    );

    expect(verdict).toEqual({ ok: true, requestCount: 5 });
    expect(fake.ops).toEqual([
      'zRemRangeByScore',
      'zAdd',
      'zCard',
      'expire',
    ]);
    // Identity chain: x-tenant-id wins; the key carries the client id.
    expect(fake.multi.zRemRangeByScore).toHaveBeenCalledWith(
      'ratelimit:tenant-alpha',
      0,
      expect.any(Number),
    );
  });

  it('falls back to the house client-IP extraction then anonymous', async () => {
    const fake = makeFakeClient(1);
    mockGetRedisClient.mockResolvedValue(fake.client as never);

    // No x-tenant-id -> x-forwarded-for first hop (house clientAddress).
    await redisSlidingWindowRateLimiter(
      requestWith({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }),
      IDENTIFIER_INGEST_RATE_LIMIT,
    );
    expect(clientAddress(requestWith({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }))).toBe(
      '203.0.113.7',
    );

    // Neither header present -> 'unknown' house fallback string.
    await redisSlidingWindowRateLimiter(requestWith({}), IDENTIFIER_INGEST_RATE_LIMIT);
    expect(fake.multi.zRemRangeByScore).toHaveBeenNthCalledWith(
      2,
      'ratelimit:unknown',
      0,
      expect.any(Number),
    );
  });

  it('returns a 429 verdict with retryAfterSeconds when over the budget', async () => {
    const fake = makeFakeClient(IDENTIFIER_INGEST_RATE_LIMIT.maxRequests + 1);
    mockGetRedisClient.mockResolvedValue(fake.client as never);

    const verdict = await redisSlidingWindowRateLimiter(
      requestWith({ 'x-tenant-id': 'tenant-flood' }),
      IDENTIFIER_INGEST_RATE_LIMIT,
    );

    expect(verdict).toEqual({
      ok: false,
      retryAfterSeconds: IDENTIFIER_INGEST_RATE_LIMIT.windowSeconds,
    });
  });
});

describe('v22 fail-open availability', () => {
  it('fails open when Redis MULTI/EXEC errors', async () => {
    const fake = makeFakeClient(0, true);
    mockGetRedisClient.mockResolvedValue(fake.client as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const verdict = await redisSlidingWindowRateLimiter(
      requestWith({ 'x-tenant-id': 'tenant-outage' }),
      IDENTIFIER_INGEST_RATE_LIMIT,
    );

    expect(verdict).toEqual({ ok: true, requestCount: 0 });
    errorSpy.mockRestore();
  });

  it('fails open when no Redis is configured (getRedisClient -> null)', async () => {
    mockGetRedisClient.mockResolvedValue(null);

    const verdict = await redisSlidingWindowRateLimiter(
      requestWith({ 'x-tenant-id': 'tenant-no-redis' }),
      IDENTIFIER_INGEST_RATE_LIMIT,
    );

    expect(verdict).toEqual({ ok: true, requestCount: 0 });
  });
});
