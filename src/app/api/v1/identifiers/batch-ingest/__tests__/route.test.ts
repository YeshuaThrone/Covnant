/**
 * Route unit tests — house convention: server modules (redisCache) are
 * vi.mock'ed; the limiter verdict, metrics counter, and pg pool are faked.
 * Real-database behavior is covered by route.integration.test.ts (canon v22).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestionCounter, logger } from '@/lib/observability/ingestionMetrics';
import {
  IDENTIFIER_INGEST_RATE_LIMIT,
  redisSlidingWindowRateLimiter,
} from '@/lib/server/redisRateLimit';

vi.mock('@/lib/server/redisRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/redisRateLimit')>();
  return {
    ...actual,
    redisSlidingWindowRateLimiter: vi.fn(),
  };
});

vi.mock('@/lib/observability/ingestionMetrics', () => ({
  ingestionCounter: { labels: vi.fn(() => ({ inc: vi.fn() })) },
  logger: { info: vi.fn() },
}));

const pgState = vi.hoisted(() => ({
  clients: [] as Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>,
}));

vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const release = vi.fn();
  return {
    Pool: vi.fn(() => {
      const client = { query, release };
      pgState.clients.push(client);
      return { connect: vi.fn().mockResolvedValue(client) };
    }),
  };
});

import { POST } from '../route';

const mockLimiter = vi.mocked(redisSlidingWindowRateLimiter);
const mockLabels = vi.mocked(ingestionCounter.labels);

const postBatch = async (body: unknown, tenant?: string): Promise<Response> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenant) headers['x-tenant-id'] = tenant;
  return POST(
    new Request('http://localhost:3000/api/v1/identifiers/batch-ingest', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
};

const validRecord = {
  entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
  verticalCategory: 'PRO_SPORTS',
  primaryCodeType: 'FIFA_CONNECT_ID',
  primaryCodeValue: '190ABC999999',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLimiter.mockResolvedValue({ ok: true, requestCount: 1 });
});

describe('strict structural validation (canon v22 refinement 3)', () => {
  it('rejects an empty records list with 400 and counts VALIDATION_ERROR', async () => {
    const res = await postBatch({ tenantId: 'tenant-malformed', records: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid payload structure or empty records list.');
    expect(mockLabels).toHaveBeenCalledWith({
      vertical: 'unknown',
      status: 'VALIDATION_ERROR',
    });
  });

  it('rejects a missing tenantId with 400', async () => {
    const res = await postBatch({ records: [validRecord] });
    expect(res.status).toBe(400);
  });

  it('rejects an unparseable body with 400 (never a 5xx)', async () => {
    const res = await POST(
      new Request('http://localhost:3000/api/v1/identifiers/batch-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json-at-all',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('syntax validation envelope (v13 contract)', () => {
  it('rejects the whole batch with 422 REJECTED on a malformed code', async () => {
    const res = await postBatch({
      tenantId: 'tenant-alpha',
      records: [{ ...validRecord, primaryCodeValue: 'INVALID' }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      status: string;
      message: string;
      errors: Array<{ index: number }>;
    };
    expect(body.status).toBe('REJECTED');
    expect(body.message).toBe('Payload contained syntax validation errors.');
    expect(body.errors[0]?.index).toBe(0);
    expect(mockLabels).toHaveBeenCalledWith({
      vertical: 'unknown',
      status: 'REJECTED',
    });
  });

  it('validates cross-references against the registry too', async () => {
    const res = await postBatch({
      tenantId: 'tenant-alpha',
      records: [
        {
          ...validRecord,
          crossReferences: [
            {
              linkedCodeType: 'OPTA_PERSON_ID',
              linkedCodeValue: 'P999999', // uppercase p is malformed (canon v23)
              verificationSource: 'Stats Perform',
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(422);
  });
});

describe('v22 rate limiting', () => {
  it('returns the founder 429 body and counts RATE_LIMITED', async () => {
    mockLimiter.mockResolvedValue({
      ok: false,
      retryAfterSeconds: IDENTIFIER_INGEST_RATE_LIMIT.windowSeconds,
    });

    const res = await postBatch(
      { tenantId: 'tenant-flood', records: [validRecord] },
      'tenant-flood',
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      status: string;
      message: string;
      retryAfterSeconds: number;
    };
    expect(body.status).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.message).toBe('Too many requests. Rate limit threshold exceeded.');
    expect(body.retryAfterSeconds).toBe(IDENTIFIER_INGEST_RATE_LIMIT.windowSeconds);
    expect(mockLabels).toHaveBeenCalledWith({
      vertical: 'unknown',
      status: 'RATE_LIMITED',
    });
  });
});

describe('successful batch ingestion (v13 contract, mocked pool)', () => {
  it('commits a single-vertical batch and counts batch-length under one vertical', async () => {
    const res = await postBatch({
      tenantId: 'tenant-alpha',
      records: [validRecord, { ...validRecord, primaryCodeValue: '190ABC999998' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      processedRecords: number;
      tenantId: string;
    };
    expect(body.status).toBe('SUCCESS');
    expect(body.processedRecords).toBe(2);
    expect(body.tenantId).toBe('tenant-alpha');
    expect(mockLabels).toHaveBeenCalledWith({
      vertical: 'PRO_SPORTS',
      status: 'SUCCESS',
    });
    expect(logger.info).toHaveBeenCalledWith(
      { tenantId: 'tenant-alpha', count: 2 },
      'Successfully queued batch ingestion',
    );
  });

  it('counts mixed-vertical batches per record under each own vertical', async () => {
    const res = await postBatch({
      tenantId: 'tenant-alpha',
      records: [
        validRecord,
        {
          entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ac',
          verticalCategory: 'CULINARY',
          primaryCodeType: 'FDC_ID',
          primaryCodeValue: '123456',
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(mockLabels).toHaveBeenCalledWith({
      vertical: 'PRO_SPORTS',
      status: 'SUCCESS',
    });
    expect(mockLabels).toHaveBeenCalledWith({
      vertical: 'CULINARY',
      status: 'SUCCESS',
    });
  });

  it('issues BEGIN/COMMIT around the upserts', async () => {
    await postBatch({ tenantId: 'tenant-alpha', records: [validRecord] });
    // The route caches its pool across tests, so the first-constructed
    // client sees every query — including this test's transaction.
    const client = pgState.clients.at(-1);
    expect(client).toBeDefined();
    const queries = client!.query.mock.calls.map((call) => String(call[0]));
    expect(queries[0]).toBe('BEGIN');
    expect(queries).toContain('COMMIT');
  });
});
