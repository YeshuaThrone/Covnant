import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db';
import {
  attachExternalIdentifier,
  findByIdentifier,
  normalizeVaultIdentifier,
} from '../vault';

/**
 * V6 — the CVT vault surface. The vault's outward-facing handle is the
 * STORED cvt_code from the PR #22 dual-code registration; ingestion is
 * exact-match only in both directions: attach dedupes on the canonical
 * identifier pair, lookup never auto-creates, never fuzzy.
 */

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    cvt_code: 'CVT-9F3A7C21-2026',
    cbt_code: 'CBT-TRK-1234567890AB',
    title: 'Test Song',
    medium: 'MUSIC_TRACK',
    mapped_identifiers: { isrc: 'USX7U2600001' },
    // The holder UCT the lookup extracts from the first rights holder
    // (PR #27/#28 rights_holders JSONB) via the lineage-style join.
    uct: 'UCT-US-2026-9F3A7C21-K4',
    ...overrides,
  };
}

function vaultDb(row: Record<string, unknown> | null) {
  const txQueries: QueryCall[] = [];
  const poolQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    return Promise.resolve({ rows: row ? [row] : [] });
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params });
      return Promise.resolve({ rows: row ? [row] : [] });
    }),
    transaction: vi.fn(
      async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, txQueries, poolQueries };
}

describe('normalizeVaultIdentifier', () => {
  it('canonicalizes ISRC through the lineage module (uppercase, dashless, 12 chars)', () => {
    expect(normalizeVaultIdentifier('ISRC', 'us-x7u-26-00001')).toBe('USX7U2600001');
    expect(normalizeVaultIdentifier('ISRC', 'USX7U2600001')).toBe('USX7U2600001');
  });

  it('canonicalizes ISWC to dashed uppercase and rejects other shapes', () => {
    expect(normalizeVaultIdentifier('ISWC', 't-1234567890-1')).toBe('T-1234567890-1');
    expect(normalizeVaultIdentifier('ISWC', 'T12345678901')).toBeNull();
    expect(normalizeVaultIdentifier('ISWC', 'not-a-code')).toBeNull();
  });

  it('accepts exactly 12-digit UPC-A and rejects other shapes', () => {
    expect(normalizeVaultIdentifier('UPC', '012345678912')).toBe('012345678912');
    expect(normalizeVaultIdentifier('UPC', '01234567891')).toBeNull();
    expect(normalizeVaultIdentifier('UPC', '01234567891X')).toBeNull();
  });

  it('rejects empty and whitespace values', () => {
    expect(normalizeVaultIdentifier('ISRC', '   ')).toBeNull();
    expect(normalizeVaultIdentifier('UPC', '')).toBeNull();
  });
});

describe('attachExternalIdentifier (V6 — idempotent exact-match dedupe)', () => {
  it('attaches a new identifier with an additive JSONB merge keyed on the stored CVT code', async () => {
    const { db, txQueries } = vaultDb(assetRow());

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-9F3A7C21-2026', {
      kind: 'ISWC',
      value: 'T-1234567890-1',
    });

    expect(result).toEqual({
      ok: true,
      attached: true,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    const updates = txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('jsonb_build_object($1, $2)');
    expect(updates[0].params).toEqual(['iswc', 'T-1234567890-1', 'CVT-9F3A7C21-2026']);
  });

  it('re-attaching the IDENTICAL pair is a no-op — never a duplicate', async () => {
    const { db, txQueries } = vaultDb(assetRow());

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-9F3A7C21-2026', {
      kind: 'ISRC',
      value: 'US-X7U-26-00001', // same identifier, unnormalized form
    });

    expect(result).toEqual({
      ok: true,
      attached: false,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    expect(txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'))).toHaveLength(0);
  });

  it('replacing a kind with a different value is a single in-place update', async () => {
    const { db, txQueries } = vaultDb(assetRow());

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-9F3A7C21-2026', {
      kind: 'ISRC',
      value: 'GBX7U2600002',
    });

    expect(result).toEqual({
      ok: true,
      attached: true,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    const updates = txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(['isrc', 'GBX7U2600002', 'CVT-9F3A7C21-2026']);
  });

  it('an unknown CVT reference returns not-found and never auto-creates an asset', async () => {
    const { db, txQueries } = vaultDb(null);

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-DOES-NOT-EXIST', {
      kind: 'UPC',
      value: '012345678912',
    });

    expect(result).toEqual({ ok: false, reason: 'ASSET_NOT_FOUND' });
    expect(txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'))).toHaveLength(0);
  });

  it('an invalid identifier is rejected before any query runs', async () => {
    const { db, txQueries, poolQueries } = vaultDb(assetRow());

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-9F3A7C21-2026', {
      kind: 'UPC',
      value: 'not-a-upc',
    });

    expect(result).toEqual({ ok: false, reason: 'INVALID_IDENTIFIER' });
    expect(txQueries).toHaveLength(0);
    expect(poolQueries).toHaveLength(0);
  });
});

describe('findByIdentifier (V6 — exact-only lookup, never auto-create)', () => {
  it('resolves an external identifier to the asset with its stored CVT tag and holder UCT', async () => {
    const { db, poolQueries } = vaultDb(assetRow());

    const record = await findByIdentifier(db as unknown as Db, 'ISRC', 'US-X7U-26-00001');

    expect(record).toEqual({
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
      title: 'Test Song',
      medium: 'MUSIC_TRACK',
      externalIdentifiers: { isrc: 'USX7U2600001' },
      holderUct: 'UCT-US-2026-9F3A7C21-K4',
    });
    // The lookup canonicalizes with the SAME rules the attach path applies.
    expect(poolQueries[0]?.params).toEqual(['USX7U2600001']);
  });

  it('an unknown identifier returns not-found — no auto-create, no error', async () => {
    const { db } = vaultDb(null);

    expect(await findByIdentifier(db as unknown as Db, 'ISRC', 'GBX7U2600009')).toBeNull();
    expect(await findByIdentifier(db as unknown as Db, 'UPC', '999999999999')).toBeNull();
  });

  it('an invalid identifier cannot match anything and returns not-found', async () => {
    const { db, poolQueries } = vaultDb(assetRow());

    expect(await findByIdentifier(db as unknown as Db, 'ISWC', 'garbage')).toBeNull();
    expect(await findByIdentifier(db as unknown as Db, 'ISRC', '')).toBeNull();
    expect(poolQueries).toHaveLength(0);
  });

  it('a row missing the stored CVT tag resolves to not-found (the handle is the contract)', async () => {
    const { db } = vaultDb(assetRow({ cvt_code: null }));

    expect(await findByIdentifier(db as unknown as Db, 'ISRC', 'USX7U2600001')).toBeNull();
  });
});
