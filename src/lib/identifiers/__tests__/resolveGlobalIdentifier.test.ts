/**
 * Resolver tests — canon v16: cache hit/miss/null, fail-open on Redis
 * errors, write-back failure that never blocks resolution, post-commit
 * invalidation. getRedisClient is mocked at the module seam (house
 * convention); the pool is a stub capturing the SQL + params.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const redisState = vi.hoisted(() => {
  const store = new Map<string, string>();
  const calls = {
    get: 0,
    setEx: 0,
    del: 0,
    failNextGet: null as Error | null,
    failNextSetEx: null as Error | null,
    failNextDel: null as Error | null,
  };
  return { store, calls };
});

vi.mock('@/lib/server/redisCache', () => ({
  getRedisClient: vi.fn(async () => ({
    get: async (key: string) => {
      redisState.calls.get += 1;
      if (redisState.calls.failNextGet) throw redisState.calls.failNextGet;
      return redisState.store.get(key) ?? null;
    },
    setEx: async (key: string, _ttl: number, value: string) => {
      redisState.calls.setEx += 1;
      if (redisState.calls.failNextSetEx) throw redisState.calls.failNextSetEx;
      redisState.store.set(key, value);
    },
    del: async (key: string) => {
      redisState.calls.del += 1;
      if (redisState.calls.failNextDel) throw redisState.calls.failNextDel;
      redisState.store.delete(key);
    },
  })),
}));

import {
  RESOLUTION_TTL_SECONDS,
  invalidateResolvedGlobalIdentifier,
  resolutionCacheKey,
  resolveGlobalIdentifier,
} from '../resolveGlobalIdentifier';
import type { GlobalIdentifierType } from '../globalIdentifiers';

const TYPE: GlobalIdentifierType = 'FIFA_CONNECT_ID';

function makePool(
  rows: Array<Record<string, unknown>>,
): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> };
}

const DB_ROW = {
  entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
  verticalCategory: 'PRO_SPORTS',
  primaryCodeType: 'FIFA_CONNECT_ID',
  primaryCodeValue: '190ABC999999',
};

// What pg actually returns — snake_case; the resolver maps to camelCase.
const STUB_ROW = {
  entity_id: DB_ROW.entityId,
  vertical_category: DB_ROW.verticalCategory,
  primary_code_type: DB_ROW.primaryCodeType,
  primary_code_value: DB_ROW.primaryCodeValue,
};

beforeEach(() => {
  redisState.store.clear();
  redisState.calls.get = 0;
  redisState.calls.setEx = 0;
  redisState.calls.del = 0;
  redisState.calls.failNextGet = null;
  redisState.calls.failNextSetEx = null;
  redisState.calls.failNextDel = null;
});

describe('resolutionCacheKey (v16 key shape)', () => {
  it('builds id_map:<type>:<value>', () => {
    expect(resolutionCacheKey('FIFA_CONNECT_ID', '190ABC999999')).toBe(
      'id_map:FIFA_CONNECT_ID:190ABC999999',
    );
  });
});

describe('resolveGlobalIdentifier (v16)', () => {
  it('serves a cache hit with source CACHE and never touches the database', async () => {
    redisState.store.set(
      resolutionCacheKey(TYPE, '190ABC999999'),
      JSON.stringify({ ...DB_ROW, source: 'DATABASE' }),
    );
    const pool = makePool([]);

    const resolved = await resolveGlobalIdentifier(pool, TYPE, '190ABC999999');

    expect(resolved).toEqual({ ...DB_ROW, source: 'CACHE' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('on a cache miss falls through to the database and writes back with the 24h TTL', async () => {
    const pool = makePool([STUB_ROW]);

    const resolved = await resolveGlobalIdentifier(pool, TYPE, '190ABC999999');

    expect(resolved).toEqual({ ...DB_ROW, source: 'DATABASE' });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual([TYPE, '190ABC999999']);
    expect(redisState.calls.setEx).toBe(1);
    expect(redisState.store.get(resolutionCacheKey(TYPE, '190ABC999999'))).toBe(
      JSON.stringify(resolved),
    );
    expect(RESOLUTION_TTL_SECONDS).toBe(86400);
  });

  it('returns null for an unregistered identifier and does not cache the null', async () => {
    const pool = makePool([]);

    const resolved = await resolveGlobalIdentifier(pool, TYPE, '190NOPE00001');

    expect(resolved).toBeNull();
    expect(redisState.calls.setEx).toBe(0);
    expect(redisState.store.size).toBe(0);
  });

  it('fails open to the database path when the Redis lookup throws', async () => {
    redisState.calls.failNextGet = new Error('ECONNREFUSED');
    const pool = makePool([STUB_ROW]);

    const resolved = await resolveGlobalIdentifier(pool, TYPE, '190ABC999999');

    expect(resolved).toEqual({ ...DB_ROW, source: 'DATABASE' });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('still resolves from the database when the write-back throws', async () => {
    redisState.calls.failNextSetEx = new Error('cache down');
    const pool = makePool([STUB_ROW]);

    const resolved = await resolveGlobalIdentifier(pool, TYPE, '190ABC999999');

    expect(resolved).toEqual({ ...DB_ROW, source: 'DATABASE' });
  });
});

describe('invalidateResolvedGlobalIdentifier (post-commit seam)', () => {
  it('deletes the canonical cache key', async () => {
    redisState.store.set(resolutionCacheKey(TYPE, '190ABC999999'), 'stale');
    await invalidateResolvedGlobalIdentifier(TYPE, '190ABC999999');
    expect(
      redisState.store.has(resolutionCacheKey(TYPE, '190ABC999999')),
    ).toBe(false);
  });

  it('fails open when the DEL throws — TTL bounds staleness', async () => {
    redisState.calls.failNextDel = new Error('cache down');
    await expect(
      invalidateResolvedGlobalIdentifier(TYPE, '190ABC999999'),
    ).resolves.toBeUndefined();
  });
});
