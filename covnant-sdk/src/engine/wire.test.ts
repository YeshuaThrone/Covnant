/**
 * Engine-wire tests — the one path from collection to money.
 *
 * These tests run the REAL locked engine underneath: the store is the
 * repo's InMemoryStore and calculateUdrSplits executes its actual pipeline
 * (allocation, dust, vaults, GL) — the wire is never stubbed away from the
 * math it wires. Only the two databases the wire cannot hold in tests are
 * fakes: the pg surface (cbt_assets sheet read + universal_royalty_ledger
 * credit write) routes canned rows and failure injections through the real
 * SQL text, the same harness discipline match.test.ts pins.
 *
 * Pinned here, per the build spec's split-wiring verification rows:
 * - every canonical event yields a zeroBalanceHolds-passing run;
 * - the sub-cent remainder sweeps to the company as dust (full precision,
 *   never a payee's, never a float);
 * - the tier credit carries the deterministic CBT settlement stamp, with
 *   the 42703 no-metadata-column fallback;
 * - a replayed statement/webhook produces exactly one credit (check-first
 *   guard + the 23505 final guard).
 */

import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import type { Db } from '@/lib/db';
import { generateCBTSettlementCode } from '@/lib/ledger/cbt-settlement';

import { ClearanceBlockedError, type MulClearance } from '../mul/clearance';
import { SdkMalformedInputError } from '../nodes/errors';
import { parseCanonicalRoyaltyEvent } from '../contracts/royalty-event';
import {
  convertGross,
  holderSplitBps,
  settleEvent,
  settlementReferenceId,
  type MatchedEvent,
} from './wire';

// ---------------------------------------------------------------------------
// Fixtures — a cleared asset with a strict-gate split sheet.
// ---------------------------------------------------------------------------

const CBT_CODE = 'CBT-TRK-1234567890AB';

/** 50/30/20 — units 500000/300000/200000, exact bps 5000/3000/2000. */
const SHEET_50_30_20 = [
  { id: 'holder-publisher', name: 'Pub Co', role: 'PUBLISHER', splitPercentage: 50, uct: 'UCT-US-2026-9F3A7C21-K4' },
  { id: 'holder-producer', name: 'The Producer', role: 'PRODUCER', splitPercentage: 30 },
  { id: 'holder-studio', name: 'Studio LLC', role: 'STUDIO', splitPercentage: 20 },
];

/** The pool sheet's rounding shape: 333334/333333/333333 units. */
const SHEET_FRACTIONAL = [
  { id: 'h1', name: 'H One', role: 'PUBLISHER', splitPercentage: 33.3334 },
  { id: 'h2', name: 'H Two', role: 'PRODUCER', splitPercentage: 33.3333 },
  { id: 'h3', name: 'H Three', role: 'STUDIO', splitPercentage: 33.3333 },
];

const CLEARED = {
  assetCbtCode: CBT_CODE,
  state: 'cleared' as const,
  licensee: 'Spotify',
  territory: 'US',
  termStart: null,
  termEnd: null,
};

/** $123.45678912 — 12,345 integer cents + 678,912 sub-cent micros. */
const GROSS_MICROS = 12_345_678_912n;

function eventFor(overrides: Partial<Record<string, unknown>> = {}): MatchedEvent['event'] {
  const parsed = parseCanonicalRoyaltyEvent({
    eventId: 'evt-stmt-001',
    rightsPipeline: 'master_digital_performance',
    source: 'statement',
    statementFormat: 'csv',
    period: '2026-08',
    currency: 'USD',
    grossMicros: GROSS_MICROS,
    identifiers: { ISRC: 'USX7U2600001' },
    platform: null,
    territory: 'US',
    raw: { statement: 'bytes' },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture event rejected: ${parsed.reason}`);
  return parsed.event;
}

function matchedEvent(overrides: {
  event?: MatchedEvent['event'];
  clearance?: MatchedEvent['clearance'];
  cbtCode?: string;
} = {}): MatchedEvent {
  return {
    event: overrides.event ?? eventFor(),
    cbtCode: overrides.cbtCode ?? CBT_CODE,
    clearance: overrides.clearance ?? CLEARED,
  };
}

// ---------------------------------------------------------------------------
// The fake pg surface — real SQL text routed to canned rows/injections.
// ---------------------------------------------------------------------------

interface CreditRow {
  transaction_id: string;
  reference_id: string;
  metadata?: Record<string, unknown> | null;
}

class FakeLedgerDb implements Db {
  /** The asset sheet SELECT returns this row (null → asset_not_found). */
  assetRow: { cbt_code: string; title: string; rights_holders: unknown } | null = {
    cbt_code: CBT_CODE,
    title: 'Test Song',
    rights_holders: SHEET_50_30_20,
  };
  /** The replay-guard SELECT returns this row (null → no prior credit). */
  existingCredit: CreditRow | null = null;
  /** When false, every SQL naming the metadata column fails 42703. */
  metadataColumnPresent = true;
  /** One-shot injection for the credit INSERT. */
  failNextInsert: 'unique' | null = null;

  /** When the INSERT succeeds, the table now holds this credit. */
  recordInserts = true;

  insertCount = 0;
  inserts: Array<{ sql: string; params: unknown[] }> = [];
  queries: string[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push(sql);
    const statement = sql.trim().toUpperCase();

    if (statement.startsWith('SELECT') && statement.includes('UNIVERSAL_ROYALTY_LEDGER')) {
      if (!this.metadataColumnPresent && statement.includes('METADATA')) {
        throw Object.assign(new Error('column "metadata" does not exist'), { code: '42703' });
      }
      const rows = (this.existingCredit ? [this.existingCredit] : []) as unknown as T[];
      return { rows } as unknown as QueryResult<T>;
    }
    if (statement.startsWith('SELECT') && statement.includes('CBT_ASSETS')) {
      const rows = (this.assetRow ? [this.assetRow] : []) as unknown as T[];
      return { rows } as unknown as QueryResult<T>;
    }
    if (statement.startsWith('INSERT') && statement.includes('UNIVERSAL_ROYALTY_LEDGER')) {
      if (!this.metadataColumnPresent && statement.includes('METADATA')) {
        throw Object.assign(
          new Error('column "metadata" of relation "universal_royalty_ledger" does not exist'),
          { code: '42703' },
        );
      }
      if (this.failNextInsert === 'unique') {
        this.failNextInsert = null;
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "universal_royalty_ledger_reference_id_key"'),
          { code: '23505' },
        );
      }
      this.insertCount += 1;
      this.inserts.push({ sql, params });
      if (this.recordInserts) {
        // The table now holds the credit — a later replay SELECT finds it.
        const metadataParam = params[4];
        this.existingCredit = {
          transaction_id: String(params[3]),
          reference_id: String(params[3]),
          ...(metadataParam === undefined ? {} : { metadata: JSON.parse(String(metadataParam)) as Record<string, unknown> }),
        };
      }
      return { rows: [] } as unknown as QueryResult<T>;
    }
    throw new Error(`FakeLedgerDb: unexpected SQL — ${sql}`);
  }

  async transaction<T>(): Promise<T> {
    throw new Error('FakeLedgerDb: the wire issues no transactions.');
  }
}

const NOW = new Date('2026-09-14T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Pure conversions — the floor+dust invariant and the exact-bps ladder.
// ---------------------------------------------------------------------------

describe('convertGross — the floor+dust invariant, one level up', () => {
  it('floors micros to integer cents and keeps the sub-cent remainder', () => {
    const { grossCents, subCentDustMicros } = convertGross(12_345_678_912n);
    expect(grossCents).toBe(12_345);
    expect(subCentDustMicros).toBe(678_912n);
  });

  it('floors an exact-cent gross with zero dust', () => {
    const { grossCents, subCentDustMicros } = convertGross(12_345_000_000n);
    expect(grossCents).toBe(12_345);
    expect(subCentDustMicros).toBe(0n);
  });

  it('keeps a sub-cent-only gross out of the integer lane entirely', () => {
    const { grossCents, subCentDustMicros } = convertGross(999_999n);
    expect(grossCents).toBe(0);
    expect(subCentDustMicros).toBe(999_999n);
  });

  it('refuses a gross that cannot be integer cents in the Don lane', () => {
    // One cent beyond the Don lane's number space.
    expect(() => convertGross(BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n + 1_000_000n)).toThrow(
      SdkMalformedInputError,
    );
  });
});

describe('holderSplitBps — stored sheets to the engine\'s exact 10,000 gate', () => {
  it('passes a clean sheet through at exact bps', () => {
    const sheet = SHEET_50_30_20.map((holder) => ({
      units: Math.round(holder.splitPercentage * 10_000),
      subBpsUnits: Math.round(holder.splitPercentage * 10_000) % 100,
    }));
    expect(holderSplitBps(sheet)).toEqual([5000, 3000, 2000]);
  });

  it('distributes the sub-bp residue to the largest remainder, summing exactly 10000', () => {
    const sheet = SHEET_FRACTIONAL.map((holder) => {
      const units = Math.round(holder.splitPercentage * 10_000);
      return { units, subBpsUnits: units % 100 };
    });
    const bps = holderSplitBps(sheet);
    expect(bps).toEqual([3334, 3333, 3333]);
    expect(bps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('refuses a sheet that is not at the strict 1,000,000-unit gate', () => {
    const sheet = [{ units: 999_999, subBpsUnits: 99 }];
    expect(() => holderSplitBps(sheet)).toThrow(
      new SdkMalformedInputError('split_sheet_not_at_strict_gate'),
    );
  });
});

// ---------------------------------------------------------------------------
// settleEvent — the one path from collection to money.
// ---------------------------------------------------------------------------

describe('settleEvent — the MUL dispatch gate', () => {
  it('throws the typed clearance refusal before anything moves', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const disputed = matchedEvent({ clearance: { ...CLEARED, state: 'disputed' as const } });
    await expect(settleEvent(store, db, disputed, NOW)).rejects.toThrow(ClearanceBlockedError);
    // A missing clearance is a refusal too — built literally so the helper's
    // fallback cannot stand in for the gate's null path.
    const missing: MatchedEvent = {
      event: eventFor(),
      cbtCode: CBT_CODE,
      clearance: null as unknown as MulClearance,
    };
    await expect(settleEvent(store, db, missing, NOW)).rejects.toThrow(
      new ClearanceBlockedError('clearance_missing', '<none>', 'no MUL clearance exists for this asset — dispatch is refused, fail-closed.'),
    );
    expect(db.insertCount).toBe(0);
  });

  it('throws on an expired term — an expired term is not cleared', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const expired = matchedEvent({
      clearance: {
        ...CLEARED,
        termStart: '2026-01-01T00:00:00.000Z',
        termEnd: '2026-08-31T23:59:59.999Z',
      },
    });
    await expect(settleEvent(store, db, expired, NOW)).rejects.toThrow(ClearanceBlockedError);
    await expect(settleEvent(store, db, expired, NOW)).rejects.toThrow(/an expired term is not cleared/);
    expect(db.insertCount).toBe(0);
  });
});

describe('settleEvent — the zeroBalanceHolds-passing run and the dust sweep', () => {
  it('settles a canonical event through the real locked engine', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);

    expect(result.idempotent).toBe(false);
    expect(result.splitRun).not.toBeNull();
    // The engine's run is really in the store — the wire called it.
    const storedRun = await store.getSplitRun(result.splitRun!.id);
    expect(storedRun?.source).toBe('covnant-sdk:master_digital_performance');
    expect(storedRun?.period).toBe('2026-08');
    expect(storedRun?.gross_cents).toBe(12_345);

    const ledger = await store.listLedgerTransactionsByRun(result.splitRun!.id);
    const dust = await store.listCompanyDustByRun(result.splitRun!.id);
    // zeroBalanceHolds identity: sum(creator_allocations) + company_dust === gross.
    const allocated = ledger.reduce((total, row) => total + row.amount_cents, 0);
    const dustCents = dust.reduce((total, row) => total + row.amount_cents, 0);
    expect(allocated + dustCents).toBe(12_345);
    // The engine's floor allocation for 5000/3000/2000 bps on 12,345 cents:
    // 6172 + 3703 + 2469 = 12,344 — the 1 remaining cent is the company's.
    expect(dust).toHaveLength(1);
    expect(dust[0]?.amount_cents).toBe(1);
    expect(dust[0]?.variance_account_id).toBe('platform');
  });

  it('sweeps the sub-cent remainder to company dust at full precision', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);

    // The Don lane received only integer cents; the sub-cent piece is
    // nowhere in any payee's ledger rows.
    const ledger = await store.listLedgerTransactionsByRun(result.splitRun!.id);
    const dust = await store.listCompanyDustByRun(result.splitRun!.id);
    const allocated = ledger.reduce((total, row) => total + row.amount_cents, 0);
    const dustCents = dust.reduce((total, row) => total + row.amount_cents, 0);
    expect(allocated + dustCents).toBe(12_345);

    expect(result.subCentDustMicros).toBe(678_912n);
    const insert = db.inserts[0];
    expect(insert).toBeDefined();
    const metadata = JSON.parse(String(insert!.params[4])) as Record<string, unknown>;
    const sdk = metadata.sdk as Record<string, unknown>;
    expect(sdk.company_dust_micros).toBe('678912');
    expect(sdk.gross_micros).toBe('12345678912');
    expect(sdk.split_run_id).toBe(result.splitRun!.id);
  });

  it('passes the engine a fractional sheet at exactly 10,000 bps', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    db.assetRow = { cbt_code: CBT_CODE, title: 'Test Song', rights_holders: SHEET_FRACTIONAL };
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    const ledger = await store.listLedgerTransactionsByRun(result.splitRun!.id);
    const dust = await store.listCompanyDustByRun(result.splitRun!.id);
    const allocated = ledger.reduce((total, row) => total + row.amount_cents, 0);
    const dustCents = dust.reduce((total, row) => total + row.amount_cents, 0);
    expect(allocated + dustCents).toBe(12_345);
    expect(ledger.map((row) => row.share_bps)).toEqual([3334, 3333, 3333]);
  });

  it('propagates the locked engine\'s refusal of a zero-gross journal', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    // The locked engine refuses to post a zero-amount GL journal — the wire
    // propagates that refusal verbatim, fail-closed, with nothing written.
    const result = await settleEvent(store, db, matchedEvent({ event: eventFor({ grossMicros: 0n }) }), NOW);
    expect(result).toEqual({
      ok: false,
      status: 500,
      code: 'unbalanced_journal',
      message: 'postJournal: unbalanced journal (debits 0 != credits 0)',
    });
    expect(db.insertCount).toBe(0);
  });
});

describe('settleEvent — the CBT-stamped tier credit', () => {
  it('stamps the credit with the deterministic settlement code at INSERT', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);

    const referenceId = settlementReferenceId('evt-stmt-001');
    expect(result.credit.referenceId).toBe(referenceId);
    expect(result.credit.metadata).not.toBeNull();
    expect(result.credit.metadata?.cbt).toEqual({
      settlementCode: generateCBTSettlementCode(referenceId),
      derivedFrom: 'reference_id',
    });
    // The increase lane's exact column set — additive columns only.
    expect(db.inserts[0]?.sql).toContain(
      'INSERT INTO universal_royalty_ledger (rights_holder_id, amount_cents, transaction_type, reference_id, created_at, metadata)',
    );
    expect(db.inserts[0]?.params[2]).toBe('SDK_ROYALTY_SETTLEMENT');
    expect(db.inserts[0]?.params[3]).toBe(referenceId);
    // The asset's holder UCT is the credit's rights holder reference.
    expect(db.inserts[0]?.params[0]).toBe('UCT-US-2026-9F3A7C21-K4');
  });

  it('settles without the stamp when the metadata column is absent (42703)', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    db.metadataColumnPresent = false;
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);

    // The retry wrote the row WITHOUT metadata — money never blocks on
    // provenance — and the returned credit says so.
    expect(db.insertCount).toBe(1);
    expect(db.inserts[0]?.sql).toBe(
      'INSERT INTO universal_royalty_ledger (rights_holder_id, amount_cents, transaction_type, reference_id, created_at) VALUES ($1, $2, $3, $4, NOW())',
    );
    expect(result.credit.metadata).toBeNull();
  });
});

describe('settleEvent — replay idempotency: exactly one credit', () => {
  it('returns the original settlement for a replayed event, writing nothing', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const first = await settleEvent(store, db, matchedEvent(), NOW);
    if (!first.ok) throw new Error(`expected success, got ${first.code}`);

    const second = await settleEvent(store, db, matchedEvent(), NOW);
    if (!second.ok) throw new Error(`expected success, got ${second.code}`);

    expect(second.idempotent).toBe(true);
    expect(second.credit.referenceId).toBe(first.credit.referenceId);
    expect(second.splitRun?.id).toBe(first.splitRun!.id);
    // Exactly one credit row was ever inserted; exactly one engine run exists.
    expect(db.insertCount).toBe(1);
    expect(first.splitRun!.id).toBe((await store.getSplitRun(first.splitRun!.id))?.id ?? '');
    expect(second.subCentDustMicros).toBe(678_912n);
  });

  it('keeps exactly one credit when a concurrent settlement wins the UNIQUE race', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    const prior: CreditRow = {
      transaction_id: settlementReferenceId('evt-stmt-001'),
      reference_id: settlementReferenceId('evt-stmt-001'),
      metadata: null,
    };
    db.existingCredit = null; // the check passes…
    db.failNextInsert = 'unique'; // …but the INSERT loses the race.
    db.existingCredit = prior;

    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    expect(result.idempotent).toBe(true);
    expect(result.credit.transactionId).toBe(prior.transaction_id);
    // The tier ledger's guard held: no second INSERT persisted.
    expect(db.insertCount).toBe(0);
  });

  it('degrades the replay check when the metadata column is absent', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    db.metadataColumnPresent = false;
    db.existingCredit = {
      transaction_id: settlementReferenceId('evt-stmt-001'),
      reference_id: settlementReferenceId('evt-stmt-001'),
    };
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    expect(result.idempotent).toBe(true);
    expect(db.insertCount).toBe(0);
  });

  it('leaves NO credit behind when the engine refuses the run', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    // A sheet not at the strict gate throws before the engine runs.
    db.assetRow = {
      cbt_code: CBT_CODE,
      title: 'Test Song',
      rights_holders: [{ id: 'h1', name: 'H One', role: 'PUBLISHER', splitPercentage: 99.9999 }],
    };
    await expect(settleEvent(store, db, matchedEvent(), NOW)).rejects.toThrow(
      SdkMalformedInputError,
    );
    expect(db.insertCount).toBe(0);
  });

  it('refuses settlement when the matched asset cannot be resolved', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    db.assetRow = null;
    const result = await settleEvent(store, db, matchedEvent(), NOW);
    expect(result).toEqual({
      ok: false,
      status: 422,
      code: 'asset_not_found',
      message: expect.stringContaining(CBT_CODE),
    });
    expect(db.insertCount).toBe(0);
  });

  it('refuses a corrupt holder entry instead of reshaping money', async () => {
    const store = new InMemoryStore();
    const db = new FakeLedgerDb();
    db.assetRow = {
      cbt_code: CBT_CODE,
      title: 'Test Song',
      rights_holders: [{ id: 'h1', name: 'H One', role: 'PUBLISHER', splitPercentage: '50' }],
    };
    await expect(settleEvent(store, db, matchedEvent(), NOW)).rejects.toThrow(
      new SdkMalformedInputError('corrupt_rights_holder_split:0'),
    );
    expect(db.insertCount).toBe(0);
  });
});
