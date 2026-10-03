/**
 * RegistryAdminDashboard data-module tests (canon v20 Section 2).
 * getDb and getRedisClient are mocked at the module seam (house route-test
 * convention) — the honesty law is what's under test: every number comes
 * from the read, unconfigured/failed reads render their honest state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  nextError: null as Error | null,
}));

const redisState = vi.hoisted(() => ({
  client: undefined as { ping: () => Promise<string> } | undefined,
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (dbState.nextError) throw dbState.nextError;
      dbState.queries.push({ sql, params });
      if (sql.includes('total_identities')) {
        return {
          rows: [
            {
              total_identities: 12,
              total_cross_references: 7,
              vertical_count: 3,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('GROUP BY m.vertical_category')) {
        return {
          rows: [
            { vertical_category: 'PRO_SPORTS', identities: 6, cross_references: 5 },
            { vertical_category: 'FINE_ART', identities: 4, cross_references: 2 },
            { vertical_category: 'CORPORATE', identities: 2, cross_references: 0 },
          ],
          rowCount: 3,
        };
      }
      if (sql.includes('UNION ALL')) {
        return {
          rows: [
            {
              entity_id: '11111111-1111-4111-8111-111111111111',
              vertical_category: 'PRO_SPORTS',
              code_type: 'FIFA_CONNECT_ID',
              code_value: '190ABC999999',
              linkage_tier: 'PRIMARY',
              created_at: new Date('2026-10-03T12:00:00Z'),
            },
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [
          {
            entity_id: '22222222-2222-4222-8222-222222222222',
            vertical_category: 'PRO_SPORTS',
            code_type: 'OPTA_PERSON_ID',
            code_value: 'p999999',
            linkage_tier: 'CROSS_REFERENCE',
            created_at: new Date('2026-10-03T12:30:00Z'),
          },
        ],
        rowCount: 1,
      };
    }),
  })),
}));

vi.mock('@/lib/server/redisCache', () => ({
  getRedisClient: vi.fn(async () => redisState.client ?? null),
}));

import {
  registryDashboardData,
  verticalFilterFromParam,
} from '../registryDashboard';

beforeEach(() => {
  dbState.queries.length = 0;
  dbState.nextError = null;
  redisState.client = undefined;
});

describe('registryDashboardData (v20 Section 2)', () => {
  it('returns real metrics, verticals, audit log, and rows from the 0012 reads', async () => {
    const result = await registryDashboardData(undefined, 'ALL');

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.metrics).toEqual({
      totalIdentities: 12,
      totalCrossReferences: 7,
      verticalCount: 3,
    });
    expect(result.verticals).toHaveLength(3);
    expect(result.entities[0]).toMatchObject({
      codeType: 'FIFA_CONNECT_ID',
      codeValue: '190ABC999999',
      linkageTier: 'PRIMARY',
    });
    expect(result.auditLog[0]).toMatchObject({
      codeType: 'OPTA_PERSON_ID',
      linkageTier: 'CROSS_REFERENCE',
    });
  });

  it('binds the search term and vertical filter as parameters (never interpolated)', async () => {
    const result = await registryDashboardData('190ABC', 'PRO_SPORTS');

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.searched).toBe('190ABC');
    expect(result.verticalFilter).toBe('PRO_SPORTS');

    const entitiesCall = dbState.queries.find((q) => q.sql.includes('UNION ALL'));
    expect(entitiesCall!.params).toEqual(['190ABC', 'PRO_SPORTS']);
  });

  it('sends NULL parameters under the ALL filter with no search', async () => {
    await registryDashboardData(undefined, 'ALL');
    const entitiesCall = dbState.queries.find((q) => q.sql.includes('UNION ALL'));
    expect(entitiesCall!.params).toEqual([null, null]);
  });

  it('reports Redis reachable only on a real ping', async () => {
    redisState.client = { ping: async () => 'PONG' };
    const reachable = await registryDashboardData(undefined, 'ALL');
    expect(reachable.available && reachable.redis.reachable).toBe(true);

    redisState.client = undefined;
    const unreachable = await registryDashboardData(undefined, 'ALL');
    expect(unreachable.available && unreachable.redis.reachable).toBe(false);
  });

  it('renders the honest DATABASE_ERROR state when a read fails', async () => {
    dbState.nextError = new Error(
      'relation "universal_identity_map" does not exist',
    );
    const result = await registryDashboardData(undefined, 'ALL');
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe('DATABASE_ERROR');
    expect(result.message).toContain('universal_identity_map');
  });
});

describe('verticalFilterFromParam (v20 filter vocabulary)', () => {
  it('accepts the canon filters and falls back to ALL', () => {
    expect(verticalFilterFromParam('PRO_SPORTS')).toBe('PRO_SPORTS');
    expect(verticalFilterFromParam('CORPORATE')).toBe('CORPORATE');
    expect(verticalFilterFromParam('NOT_A_VERTICAL')).toBe('ALL');
    expect(verticalFilterFromParam(undefined)).toBe('ALL');
  });
});
