import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db';
import { IDENTIFIER_KINDS, IDENTIFIER_SPECS } from '../../../../covnant-sdk/src/contracts/identifiers';
import {
  VAULT_EXTERNAL_IDENTIFIER_KINDS,
  assertVaultKindsMatchRegistry,
  attachExternalIdentifier,
  findByIdentifier,
  normalizeVaultIdentifier,
} from '../vault';

/**
 * V6 — the CVT vault surface. The vault's outward-facing handle is the
 * STORED cvt_code from the PR #22 dual-code registration; ingestion is
 * exact-match only in both directions: attach dedupes on the canonical
 * identifier pair, lookup never auto-creates, never fuzzy.
 *
 * PR 4 (vault activation) widens the kind union to the SDK contracts
 * registry's asset-level kinds (minus the NIL sentinel) and moves
 * canonicalization onto the registry's IdentifierSpec — one canonicalizer
 * for attach and lookup, so PR 7's matcher sees consistent forms on both
 * sides. The registry's ISWC is ISO 15707 (nine work digits, dashed); the
 * vault's legacy pattern required ten — the divergence is reconciled at
 * the lookup boundary (SQL folds the stored side), never by rewriting
 * historical stored data.
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

describe('vault kind union (PR 4 — widened to the registry)', () => {
  it('carries the registry asset kinds minus the NIL sentinel — drift-guarded', () => {
    // The registry itself is the source of truth; this pins the vault set
    // to "asset-applies kinds, minus NIL" so the two can never drift.
    expect(() => assertVaultKindsMatchRegistry()).not.toThrow();

    const expected = IDENTIFIER_KINDS.filter(
      (kind) => IDENTIFIER_SPECS[kind].appliesTo === 'asset' && kind !== 'NIL',
    );
    expect([...VAULT_EXTERNAL_IDENTIFIER_KINDS]).toEqual(expected);
  });

  it('excludes creator-party kinds and the NIL sentinel', () => {
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).not.toContain('ISNI');
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).not.toContain('IPI');
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).not.toContain('IPN');
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).not.toContain('NIL');
  });

  it('still carries the three Generation 8 kinds first-class', () => {
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).toContain('ISRC');
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).toContain('ISWC');
    expect(VAULT_EXTERNAL_IDENTIFIER_KINDS).toContain('UPC');
  });
});

describe('normalizeVaultIdentifier (delegates to the registry IdentifierSpec)', () => {
  it('canonicalizes ISRC to the 12-char dashless lineage form', () => {
    expect(normalizeVaultIdentifier('ISRC', 'us-x7u-26-00001')).toBe('USX7U2600001');
    expect(normalizeVaultIdentifier('ISRC', 'USX7U2600001')).toBe('USX7U2600001');
  });

  it('canonicalizes ISWC to the registry ISO form: dashed, NINE work digits', () => {
    expect(normalizeVaultIdentifier('ISWC', 'T-123456789-1')).toBe('T-123456789-1');
    expect(normalizeVaultIdentifier('ISWC', 't-123456789-1')).toBe('T-123456789-1');
  });

  it('rejects the legacy ten-digit ISWC form — canonicalization is not repair', () => {
    // The vault's pre-registry pattern accepted ten work digits; the
    // registry's ISO 15707 form is nine. Legacy stored values stay stored
    // (see the lookup-boundary tests) but never re-enter through attach.
    expect(normalizeVaultIdentifier('ISWC', 'T-1234567890-1')).toBeNull();
  });

  it('canonicalizes the widened kinds through the registry (spot checks)', () => {
    expect(
      normalizeVaultIdentifier('EIDR', '10.5240/abcd-efgh-jklm-nopq-rstu-v'),
    ).toBe('10.5240/ABCD-EFGH-JKLM-NOPQ-RSTU-V');
    expect(normalizeVaultIdentifier('DOI', '10.1234/ABC')).toBe('10.1234/abc');
    expect(normalizeVaultIdentifier('ISBN', '978-0-306-40615-7')).toBe('9780306406157');
    expect(normalizeVaultIdentifier('EAN', '4006381333931')).toBe('4006381333931');
    expect(normalizeVaultIdentifier('GTIN', '09870987098715')).toBe('09870987098715');
    expect(normalizeVaultIdentifier('ISAN', '0123456789abcdef')).toBe('0123456789ABCDEF');
    expect(normalizeVaultIdentifier('ISMN', '9790123456789')).toBe('979-0-1234-5678-9');
    expect(normalizeVaultIdentifier('GRID', 'A10234567890123456')).toBe('A1-02345-6789012345-6');
    expect(normalizeVaultIdentifier('ISSN', '12345678')).toBe('1234-5678');
    expect(normalizeVaultIdentifier('MLC_WORK_ID', 'mlc-123456')).toBe('MLC-123456');
    expect(normalizeVaultIdentifier('HFA_SONG_ID', 'hfa-1001')).toBe('HFA-1001');
    expect(normalizeVaultIdentifier('TUNE_CODE', 't0123456')).toBe('T0123456');
    expect(
      normalizeVaultIdentifier('EPC_RFID', 'urn:epc:id:sgtin:0614141.107346.2017'),
    ).toBe('urn:epc:id:sgtin:0614141.107346.2017');
  });

  it('rejects repair-shaped inputs the registry refuses (ISBN-10, wrong shapes)', () => {
    expect(normalizeVaultIdentifier('ISBN', '0306406152')).toBeNull(); // ISBN-10 → 13 is arithmetic repair
    expect(normalizeVaultIdentifier('EIDR', '10.9999/ABCD-EFGH-JKLM-NOPQ-RSTU-V')).toBeNull(); // wrong root issuer
    expect(normalizeVaultIdentifier('ISWC', 'not-a-code')).toBeNull();
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
      value: 'T-123456789-1',
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
    expect(updates[0].params).toEqual(['iswc', 'T-123456789-1', 'CVT-9F3A7C21-2026']);
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

  it('the merge is additive — every other mapped_identifiers key survives untouched', async () => {
    const { db, txQueries } = vaultDb(
      assetRow({ mapped_identifiers: { isrc: 'USX7U2600001', title: 'free-form sibling' } }),
    );

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-9F3A7C21-2026', {
      kind: 'MLC_WORK_ID',
      value: 'MLC-123456',
    });

    expect(result).toEqual({
      ok: true,
      attached: true,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    const updates = txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'));
    expect(updates).toHaveLength(1);
    // The SQL is a JSONB concat, not a replace — siblings survive at the
    // storage level, and only the new key/value is passed.
    expect(updates[0].sql).toContain("COALESCE(mapped_identifiers, '{}'::jsonb) || jsonb_build_object($1, $2)");
    expect(updates[0].params).toEqual(['mlc_work_id', 'MLC-123456', 'CVT-9F3A7C21-2026']);
  });

  it('attaching over a LEGACY stored ISWC form supersedes it in place — one value per kind', async () => {
    // A historical row may hold the vault's old ten-digit ISWC. The
    // registry canonicalizer no longer validates that form, so the dedupe
    // correctly treats it as a DIFFERENT value: the explicit attach
    // replaces it (one value per kind). No background rewrite ever runs —
    // this only happens when an admin attaches the ISO form.
    const { db, txQueries } = vaultDb(assetRow({ mapped_identifiers: { iswc: 'T-1234567890-1' } }));

    const result = await attachExternalIdentifier(db as unknown as Db, 'CVT-9F3A7C21-2026', {
      kind: 'ISWC',
      value: 'T-123456789-1',
    });

    expect(result).toEqual({
      ok: true,
      attached: true,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    const updates = txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(['iswc', 'T-123456789-1', 'CVT-9F3A7C21-2026']);
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
    // The lookup canonicalizes with the SAME rules the attach path applies
    // (the registry's), folded dashless for ISRC at the boundary.
    expect(poolQueries[0]?.params).toEqual(['USX7U2600001']);
  });

  it('folds the ISWC lookup boundary dashless — stored legacy variants stay matchable without a rewrite', async () => {
    const { db, poolQueries } = vaultDb(assetRow());

    const record = await findByIdentifier(db as unknown as Db, 'ISWC', 'T-123456789-1');

    expect(record).not.toBeNull();
    // Query param: the registry canonical form with separators folded —
    // the same fold the SQL applies to the stored side, so a dashless-
    // stored registration value matches without any data rewrite.
    expect(poolQueries[0]?.params).toEqual(['T1234567891']);
    expect(poolQueries[0]?.sql).toContain("UPPER(REPLACE(a.mapped_identifiers->>'iswc', '-', '')) = $1");
  });

  it('routes widened kinds to their persisted JSONB keys (engine field names where modeled)', async () => {
    const { db, poolQueries } = vaultDb(assetRow());

    await findByIdentifier(db as unknown as Db, 'EIDR', '10.5240/ABCD-EFGH-JKLM-NOPQ-RSTU-V');
    expect(poolQueries[0]?.sql).toContain("a.mapped_identifiers->>'eidrCanonical'");

    await findByIdentifier(db as unknown as Db, 'MLC_WORK_ID', 'MLC-123456');
    expect(poolQueries[1]?.sql).toContain("a.mapped_identifiers->>'mlc_work_id'");

    await findByIdentifier(db as unknown as Db, 'TUNE_CODE', 'T0123456');
    expect(poolQueries[2]?.sql).toContain("a.mapped_identifiers->>'prs_tunecode'");
  });

  it('folds lowercase-canonical kinds case-folded-down (DOI), never upper-floated', async () => {
    const { db, poolQueries } = vaultDb(assetRow());

    await findByIdentifier(db as unknown as Db, 'DOI', '10.1234/ABC');

    expect(poolQueries[0]?.params).toEqual(['10.1234/abc']);
    expect(poolQueries[0]?.sql).toContain("LOWER(a.mapped_identifiers->>'doi') = $1");
  });

  it('an unknown identifier returns not-found — no auto-create, no error', async () => {
    const { db } = vaultDb(null);

    expect(await findByIdentifier(db as unknown as Db, 'ISRC', 'GBX7U2600009')).toBeNull();
    expect(await findByIdentifier(db as unknown as Db, 'UPC', '999999999999')).toBeNull();
  });

  it('an invalid identifier cannot match anything and returns not-found', async () => {
    const { db, poolQueries } = vaultDb(assetRow());

    // Includes the legacy ten-digit ISWC form: no longer a canonical value,
    // so it cannot match anything — without rewriting the stored rows.
    expect(await findByIdentifier(db as unknown as Db, 'ISWC', 'T-1234567890-1')).toBeNull();
    expect(await findByIdentifier(db as unknown as Db, 'ISWC', 'garbage')).toBeNull();
    expect(await findByIdentifier(db as unknown as Db, 'ISRC', '')).toBeNull();
    expect(poolQueries).toHaveLength(0);
  });

  it('a row missing the stored CVT tag resolves to not-found (the handle is the contract)', async () => {
    const { db } = vaultDb(assetRow({ cvt_code: null }));

    expect(await findByIdentifier(db as unknown as Db, 'ISRC', 'USX7U2600001')).toBeNull();
  });
});
