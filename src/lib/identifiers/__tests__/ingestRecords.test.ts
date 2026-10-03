/**
 * Unit tests — the shared Phase-2 ingestion module (v13 founder contract
 * + the v16/v13 post-commit seam). The pg Pool is mocked at the client
 * level (house route-test convention) and getDb is mocked so the event
 * emission's royalty_recon_jobs insert is captured without a database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityIngestionPayload } from '../globalIdentifiers';

const pgState = vi.hoisted(() => ({
  clients: [] as Array<{
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }>,
}));

const dbState = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('pg', () => {
  return {
    Pool: vi.fn(() => {
      throw new Error('raw Pool construction is not used by this suite');
    }),
  };
});

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      dbState.queries.push({ sql, params });
      return { rows: [{ id: 'event-row-1' }], rowCount: 1 };
    }),
  })),
}));

vi.mock('@/lib/identifiers/resolveGlobalIdentifier', () => ({
  invalidateResolvedGlobalIdentifier: vi.fn(async () => true),
}));

import { invalidateResolvedGlobalIdentifier } from '@/lib/identifiers/resolveGlobalIdentifier';

import { applyIngestionBatch } from '../ingestRecords';

type MockedClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function makePool(): { connect: ReturnType<typeof vi.fn> } {
  const client: MockedClient = {
    query: vi.fn(async (sql: string) => {
      // The PRIMARY upsert's RETURNING feeds the cross-ref inserts.
      if (sql.includes('RETURNING map_id')) {
        return { rows: [{ map_id: 'map-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  pgState.clients.push(client);
  return { connect: vi.fn().mockResolvedValue(client) };
}

const record: IdentityIngestionPayload = {
  entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
  verticalCategory: 'PRO_SPORTS',
  primaryCodeType: 'FIFA_CONNECT_ID',
  primaryCodeValue: '190ABC999999',
  crossReferences: [
    {
      linkedCodeType: 'OPTA_PERSON_ID',
      linkedCodeValue: 'p1234567',
      verificationSource: 'Stats Perform',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  pgState.clients.length = 0;
  dbState.queries.length = 0;
});

describe('applyIngestionBatch (v13 Phase 2, shared module)', () => {
  it('issues BEGIN, the primary upsert with created_at NOW(), xref upsert with verified_at NOW(), COMMIT — in order', async () => {
    const pool = makePool();
    await applyIngestionBatch(
      pool as unknown as Parameters<typeof applyIngestionBatch>[0],
      'tenant-alpha',
      [record],
    );

    const client = pgState.clients[0]!;
    const calls = client.query.mock.calls as Array<[string, unknown[]]>;
    expect(calls[0]![0]).toBe('BEGIN');
    expect(calls[calls.length - 1]![0]).toBe('COMMIT');

    const primarySql = calls[1]![0];
    expect(primarySql).toContain('INSERT INTO universal_identity_map');
    expect(primarySql).toContain(
      'ON CONFLICT (primary_code_type, primary_code_value)',
    );
    expect(primarySql).toContain('created_at = NOW()');

    const xrefSql = calls[2]![0];
    expect(xrefSql).toContain('INSERT INTO global_identifier_cross_ref');
    expect(xrefSql).toContain(
      'ON CONFLICT (map_id, linked_code_type, linked_code_value)',
    );
    expect(xrefSql).toContain('verified_at = NOW()');

    // The xref insert keys the RETURNING map_id — never a second lookup.
    expect(calls[2]![1]).toEqual([
      'map-1',
      'OPTA_PERSON_ID',
      'p1234567',
      'Stats Perform',
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back and rethrows on a database error, releasing the client', async () => {
    const pool = makePool();
    const client = pgState.clients[0]!;
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') return { rows: [], rowCount: 1 };
      if (sql.includes('universal_identity_map')) {
        throw new Error('duplicate key value violates unique constraint');
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      applyIngestionBatch(
        pool as unknown as Parameters<typeof applyIngestionBatch>[0],
        'tenant-alpha',
        [record],
      ),
    ).rejects.toThrow('duplicate key value violates unique constraint');

    const calls = client.query.mock.calls.map((call) => String(call[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('runs the post-commit seam: invalidates each distinct primary and emits ONE recon event with holds', async () => {
    const pool = makePool();
    const result = await applyIngestionBatch(
      pool as unknown as Parameters<typeof applyIngestionBatch>[0],
      'tenant-alpha',
      [record, { ...record, primaryCodeValue: '190ABC999998' }, record],
      {
        holds: [
          {
            index: 1,
            holdReason: 'UNCLAIMED_IDENTIFIER_HOLD',
            detail: 'no cross-links',
          },
        ],
      },
    );

    expect(result.processedRecords).toBe(3);
    expect(result.eventJobId).toBe('event-row-1');

    // Cache invalidation: DISTINCT primary codes only (the duplicate is skipped).
    expect(vi.mocked(invalidateResolvedGlobalIdentifier)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invalidateResolvedGlobalIdentifier)).toHaveBeenCalledWith(
      'FIFA_CONNECT_ID',
      '190ABC999999',
    );
    expect(vi.mocked(invalidateResolvedGlobalIdentifier)).toHaveBeenCalledWith(
      'FIFA_CONNECT_ID',
      '190ABC999998',
    );

    // ONE event row — the UCT enqueue contract.
    expect(dbState.queries).toHaveLength(1);
    const event = dbState.queries[0]!;
    expect(event.sql).toContain('INSERT INTO royalty_recon_jobs');
    expect(event.params[0]).toContain('"processedRecords":3');
    expect(event.params[0]).toContain('UNCLAIMED_IDENTIFIER_HOLD');
  });

  it('skips the event emission (but never the batch result) when no database is configured', async () => {
    const { getDb } = await import('@/lib/db');
    vi.mocked(getDb).mockReturnValueOnce(null);

    const pool = makePool();
    const result = await applyIngestionBatch(
      pool as unknown as Parameters<typeof applyIngestionBatch>[0],
      'tenant-alpha',
      [record],
    );

    expect(result.processedRecords).toBe(1);
    expect(result.eventJobId).toBeNull();
    expect(dbState.queries).toHaveLength(0);
  });

  it('never retro-fails the committed batch when the event emission throws', async () => {
    const { getDb } = await import('@/lib/db');
    vi.mocked(getDb).mockImplementationOnce(() => {
      throw new Error('connection terminated');
    });

    const pool = makePool();
    const result = await applyIngestionBatch(
      pool as unknown as Parameters<typeof applyIngestionBatch>[0],
      'tenant-alpha',
      [record],
    );

    expect(result.processedRecords).toBe(1);
    expect(result.eventJobId).toBeNull();
  });
});
