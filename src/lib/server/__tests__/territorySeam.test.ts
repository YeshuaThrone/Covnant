/**
 * Territory settlement seam (spec art_qNu4T32F) — the read-side projection
 * over universal_royalty_ledger: SDK-settled credits ONLY, territory from
 * metadata.sdk, the split_run_id join, bigint cents, honest empty states.
 *
 * PATH B pin: the seed (devSeed) carries NO SDK-settled rows — the wire is
 * the only writer of tier credits and the seed never calls it. The seam's
 * landing therefore adds zero rows to the demo data: the pins at the bottom
 * assert the seed's totals are untouched AND the seeded territory read is
 * honestly empty.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { bootDevSeedStore } from '@/lib/server/devSeed';
import { SqliteStore } from '@/lib/server/sqliteStore';
import { SupabaseStore } from '@/lib/server/supabaseStore';
import { creatorAnalytics } from '@/lib/admin/creatorAnalytics';
import {
  isSdkSettlementTransactionType,
  parsedMetadataOf,
  sdkPayloadOf,
  SDK_SETTLEMENT_TRANSACTION_TYPE,
  territorySettlementOfRow,
  type UniversalRoyaltyLedgerRow,
} from '@/lib/server/territorySettlement';

/** A tier credit exactly as the wire's INSERT writes it (covnant-sdk/src/engine/wire.ts settleEvent). */
const tierRow = (overrides: Partial<UniversalRoyaltyLedgerRow> = {}): UniversalRoyaltyLedgerRow => ({
  transaction_id: 'ul_001',
  rights_holder_id: 'rh_creator_don',
  amount_cents: '1234567',
  transaction_type: SDK_SETTLEMENT_TRANSACTION_TYPE,
  reference_id: 'ref_sdk_evt_001',
  metadata: { sdk: { split_run_id: 'run_sdk_001', territory: 'US' } },
  created_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

describe('territory settlement seam — pure projection', () => {
  it('gates on the wire transaction_type of record', () => {
    expect(SDK_SETTLEMENT_TRANSACTION_TYPE).toBe('SDK_ROYALTY_SETTLEMENT');
    expect(isSdkSettlementTransactionType('SDK_ROYALTY_SETTLEMENT')).toBe(true);
    expect(isSdkSettlementTransactionType('increase')).toBe(false);
    expect(isSdkSettlementTransactionType('CARD_AUTHORIZATION')).toBe(false);
    expect(isSdkSettlementTransactionType(null)).toBe(false);
    expect(isSdkSettlementTransactionType(undefined)).toBe(false);
  });

  it('parses TEXT-stored and client-decoded metadata, honestly null otherwise', () => {
    expect(parsedMetadataOf('{"sdk":{"territory":"GB"}}')).toEqual({ sdk: { territory: 'GB' } });
    expect(parsedMetadataOf({ sdk: { territory: 'GB' } })).toEqual({ sdk: { territory: 'GB' } });
    expect(parsedMetadataOf('not json')).toBeNull();
    expect(parsedMetadataOf(null)).toBeNull();
    expect(parsedMetadataOf([1, 2])).toBeNull();
    expect(sdkPayloadOf({ other: true })).toBeNull();
    expect(sdkPayloadOf(null)).toBeNull();
  });

  it('projects the wire stamp: verbatim territory, join key, bigint cents', () => {
    const record = territorySettlementOfRow(tierRow());
    expect(record).toEqual({
      split_run_id: 'run_sdk_001',
      territory: 'US',
      rights_holder_id: 'rh_creator_don',
      amount_cents: 1234567n,
      created_at: '2026-09-01T00:00:00Z',
    });
  });

  it('keeps absent identity fields honest null — never guessed', () => {
    const record = territorySettlementOfRow(
      tierRow({ metadata: null, rights_holder_id: null }),
    );
    expect(record.split_run_id).toBeNull();
    expect(record.territory).toBeNull();
    expect(record.rights_holder_id).toBeNull();
    // A credit without a territory stamp still carries its amount — the
    // derivation folds it into no market on its own.
    expect(record.amount_cents).toBe(1234567n);
  });

  it('projects a wire-legal null territory stamp (events may carry none)', () => {
    const record = territorySettlementOfRow(
      tierRow({ metadata: { sdk: { split_run_id: 'run_sdk_002', territory: null } } }),
    );
    expect(record.territory).toBeNull();
    expect(record.split_run_id).toBe('run_sdk_002');
  });

  it('parses cents from number or text, and a corrupt amount fails loudly (never a guessed cent)', () => {
    expect(territorySettlementOfRow(tierRow({ amount_cents: 42 })).amount_cents).toBe(42n);
    expect(() => territorySettlementOfRow(tierRow({ amount_cents: '12.5 cents' }))).toThrow();
  });
});

describe('territory settlement seam — InMemoryStore read', () => {
  it('reads SDK-settled credits only — non-SDK events contribute nothing', async () => {
    const store = new InMemoryStore();
    await store.insertUniversalRoyaltyLedgerRow(tierRow());
    // A tier row of another transaction type — its territory stamp (if any)
    // belongs to a non-SDK universe and must never surface.
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({
        transaction_id: 'ul_nonsdk',
        transaction_type: 'increase',
        metadata: { sdk: { split_run_id: 'run_x', territory: 'FR' } },
      }),
    );
    // An SDK credit with no metadata at all — returned with honest nulls.
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({ transaction_id: 'ul_nostamp', metadata: null }),
    );

    const rows = await store.listTerritorySettlements();
    expect(rows.map((row) => row.territory)).toEqual(['US', null]);
    expect(rows).toHaveLength(2);
  });

  it('orders oldest first with the transaction_id tiebreak — deterministic across backends', async () => {
    const store = new InMemoryStore();
    // Insert newest-first on purpose: the read must not leak insertion order.
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({ transaction_id: 'ul_c', metadata: { sdk: { split_run_id: 'run_c', territory: 'JP' } }, created_at: '2026-09-02T00:00:00Z' }),
    );
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({ transaction_id: 'ul_b', metadata: { sdk: { split_run_id: 'run_b', territory: 'GB' } }, created_at: '2026-09-02T00:00:00Z' }),
    );
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({ transaction_id: 'ul_a', metadata: { sdk: { split_run_id: 'run_a', territory: 'US' } }, created_at: '2026-09-01T00:00:00Z' }),
    );

    const rows = await store.listTerritorySettlements();
    // Oldest first; the created_at tie resolves by transaction_id.
    expect(rows.map((row) => row.territory)).toEqual(['US', 'GB', 'JP']);
  });

  it('is honest about emptiness — a fresh store reads []', async () => {
    await expect(new InMemoryStore().listTerritorySettlements()).resolves.toEqual([]);
  });

  it('joins via metadata.sdk.split_run_id — the derivation consumes the key verbatim', async () => {
    const store = new SqliteStore(':memory:');
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({ metadata: { sdk: { split_run_id: 'run_join_probe', territory: 'GB' } } }),
    );
    const rows = await store.listTerritorySettlements();
    expect(rows[0]?.split_run_id).toBe('run_join_probe');
    expect(rows[0]?.territory).toBe('GB');
    expect(rows[0]?.amount_cents).toBe(1234567n);
  });
});

describe('territory settlement seam — SqliteStore read', () => {
  it('mirrors the wire write shape and reads back identically to the in-memory projection', async () => {
    const store = new SqliteStore(':memory:');
    await store.insertUniversalRoyaltyLedgerRow(tierRow());
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({
        transaction_id: 'ul_002',
        amount_cents: '900000000000000000',
        metadata: '{"sdk":{"split_run_id":"run_sdk_002","territory":"JP"}}',
        created_at: '2026-09-03T00:00:00Z',
      }),
    );
    await store.insertUniversalRoyaltyLedgerRow(
      tierRow({
        transaction_id: 'ul_nonsdk',
        transaction_type: 'CARD_AUTHORIZATION',
        metadata: { sdk: { territory: 'FR' } },
      }),
    );

    const rows = await store.listTerritorySettlements();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      split_run_id: 'run_sdk_001',
      territory: 'US',
      rights_holder_id: 'rh_creator_don',
      amount_cents: 1234567n,
      created_at: '2026-09-01T00:00:00Z',
    });
    // TEXT cents survive bigint magnitudes beyond Number's integer range.
    expect(rows[1]?.amount_cents).toBe(900000000000000000n);
    expect(rows[1]?.territory).toBe('JP');
  });

  it('is honest about emptiness — a fresh store reads []', async () => {
    await expect(new SqliteStore(':memory:').listTerritorySettlements()).resolves.toEqual([]);
  });
});

// --- SupabaseStore degradation: a minimal thenable stub over the builder
// vocabulary the read uses (select/eq/order), shaped like the parity fake. ---

interface StubResult {
  data: unknown;
  error: { message: string; code: string } | null;
}

class StubBuilder {
  constructor(private readonly result: StubResult) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  order(): this {
    return this;
  }
  then<TResult1 = StubResult, TResult2 = never>(
    onFulfilled?: (value: StubResult) => TResult1,
    onRejected?: (reason: unknown) => TResult2,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onFulfilled, onRejected);
  }
}

const stubSupabaseStore = (result: StubResult) =>
  new SupabaseStore({
    from: () => new StubBuilder(result),
  } as unknown as ConstructorParameters<typeof SupabaseStore>[0]);

describe('territory settlement seam — SupabaseStore degradation', () => {
  it('degrades to the honest empty read when the tier ledger predates the stamp columns (PGRST204)', async () => {
    const store = stubSupabaseStore({
      data: null,
      error: {
        message: "Could not find the 'transaction_type' column of 'universal_royalty_ledger' in the schema cache",
        code: 'PGRST204',
      },
    });
    await expect(store.listTerritorySettlements()).resolves.toEqual([]);
  });

  it('propagates every other query failure — never a silent zero', async () => {
    const store = stubSupabaseStore({
      data: null,
      error: { message: 'relation "universal_royalty_ledger" does not exist', code: '42P01' },
    });
    await expect(store.listTerritorySettlements()).rejects.toThrow(/42P01/);
  });

  it('projects real rows through the same pure projection as the other backends', async () => {
    const store = stubSupabaseStore({
      data: [
        {
          transaction_id: 'ul_001',
          rights_holder_id: 'rh_creator_don',
          amount_cents: '1234567',
          transaction_type: 'SDK_ROYALTY_SETTLEMENT',
          reference_id: 'ref_sdk_evt_001',
          metadata: { sdk: { split_run_id: 'run_sdk_001', territory: 'US' } },
          created_at: '2026-09-01T00:00:00Z',
        },
      ],
      error: null,
    });
    await expect(store.listTerritorySettlements()).resolves.toEqual([
      {
        split_run_id: 'run_sdk_001',
        territory: 'US',
        rights_holder_id: 'rh_creator_don',
        amount_cents: 1234567n,
        created_at: '2026-09-01T00:00:00Z',
      },
    ]);
  });
});

// --- Path B pins: the seed is untouched and its territory read is empty. ---

describe('territory settlement seam — seed pins (Path B: zero rows added)', () => {
  let seeded: InMemoryStore;

  beforeAll(async () => {
    seeded = await bootDevSeedStore();
  });

  it('the demo seed still carries exactly 126 GL journals — 119 royalty_ingest', async () => {
    const all = await seeded.listGlJournals();
    expect(all).toHaveLength(126);
    const royalty = all.filter((j) => j.kind === 'royalty_ingest');
    expect(royalty).toHaveLength(119);
  });

  it('the seeded territory read is honestly empty — no SDK-settled rows, no invented markets', async () => {
    await expect(seeded.listTerritorySettlements()).resolves.toEqual([]);
  });

  it('the Creator Analytics pins are untouched: game log 124, KPI 844510373336 cents', async () => {
    const payload = await creatorAnalytics(seeded, null);
    expect(payload?.gameLog).toHaveLength(124);
    expect(payload?.creatorPaidCents).toBe(844_510_373_336n);
  });
});
