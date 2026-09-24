/**
 * creatorAnalytics — the creator-side derivation's unit suite. The mirror
 * of the companyAnalytics suite: a fake store over the REAL record shapes
 * (GlJournalRecord / GlEntryRecord from src/modules/don/records.ts,
 * SplitRunRecord / RoyaltyLineItemRecord / LedgerTransactionRecord from
 * src/lib/don/types.ts) with the REAL entity resolver (the master store's
 * entityRecordForWorkRef over the registered entity seeds). Pinned here:
 * the per-payee attribution from the vault account of record
 * (`vault:<payeeId>:<bucket>` — the reserve/pending buckets sum to the
 * payee's total), the store-carried payee_name label (null when the
 * ledger carries none — never invented), the platform-source cut (THIS is
 * the sanctioned surface for the brand strings of record), the game log's
 * per-transaction grain with the unanimous entity and the line-item
 * display title, every window (7/30/90/ALL) against the same ledger with
 * the gapless zero-filled trend, the standard-competition ranks with ties
 * (next rank vacant), the unanimous-resolution rules (unresolved and
 * mixed runs count in the money but attribute nothing structural), the
 * exclusion set (platform vault, debit legs, non-vault legs,
 * non-royalty journals, malformed payee segments), and the fail-closed
 * null on every store failure. Then the REAL 119-run dev-seed pins:
 * exact bigint strings for the ALL-window creator-paid total, the
 * per-payee sums, the source grouping, and the window math — booted
 * through createSeededStore, the same store the demo door renders.
 * Store-read integer math (bigint), nothing invented.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type {
  LedgerTransactionRecord,
  RoyaltyLineItemRecord,
  SplitRunRecord,
} from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import { createSeededStore } from '@/lib/server/devSeed';
import type { InMemoryStore } from '@/lib/server/inMemoryStore';
import { creatorAnalytics } from '../creatorAnalytics';

const JOURNAL_BASE = {
  ref_type: 'split_run',
  prev_hash: '0x0',
  entry_hash: '0x0',
  state: 'posted' as const,
};

function journal(
  id: string,
  kind: string,
  refId: string,
  sequence: number,
  createdAt = '2026-09-22T00:00:00.000Z',
): GlJournalRecord {
  return { id, kind, ref_id: refId, sequence, created_at: createdAt, ...JOURNAL_BASE };
}

function entry(journalId: string, account: string, creditCents: number): GlEntryRecord {
  return {
    id: `e-${journalId}-${account}-${creditCents}`,
    journal_id: journalId,
    account,
    debit_cents: 0,
    credit_cents: creditCents,
    created_at: '2026-09-22T00:00:00.000Z',
  };
}

function debitEntry(journalId: string, account: string, debitCents: number): GlEntryRecord {
  return { ...entry(journalId, account, 0), debit_cents: debitCents };
}

function run(id: string, source: string): SplitRunRecord {
  return {
    id,
    source,
    period: '2026-09',
    currency: 'USD',
    gross_cents: 0,
    line_item_count: 0,
    variance_account_cents: 0,
    created_at: '2026-09-22T00:00:00.000Z',
    status: 'posted',
  };
}

function lineItem(runId: string, workId: string, workTitle = 'Work of record'): RoyaltyLineItemRecord {
  return {
    id: `li-${runId}-${workId}`,
    split_run_id: runId,
    work_id: workId,
    work_title: workTitle,
    amount_cents: 0,
    splits_json: '[]',
    created_at: '2026-09-22T00:00:00.000Z',
  };
}

function tx(
  id: string,
  runId: string,
  lineItemId: string,
  payeeId: string,
  payeeName: string,
  amountCents: number,
): LedgerTransactionRecord {
  return {
    id,
    split_run_id: runId,
    line_item_id: lineItemId,
    payee_id: payeeId,
    payee_name: payeeName,
    role: 'creator',
    share_bps: 5_000,
    amount_cents: amountCents,
    currency: 'USD',
    status: 'pending_settlement',
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: '2026-09-22T00:00:00.000Z',
    settled_at: null,
    kind: 'royalty',
  };
}

interface FakeStoreInput {
  readonly journals: GlJournalRecord[];
  readonly entries: GlEntryRecord[];
  readonly runs: Record<string, SplitRunRecord | undefined>;
  readonly lineItems?: RoyaltyLineItemRecord[];
  readonly transactions?: LedgerTransactionRecord[];
  /** When set, the named read rejects — the store-failure states. */
  readonly failure?: 'journals' | 'lineItems' | 'transactions';
}

/** Minimal store — the derivation touches exactly these reads. */
function fakeStore(input: FakeStoreInput): Store {
  const reject = async (what: string): Promise<never> => {
    throw new Error(`store read failed: ${what}`);
  };
  return {
    listGlJournals: async () =>
      input.failure === 'journals' ? reject('journals') : input.journals,
    listGlEntries: async () =>
      input.failure === 'journals' ? reject('entries') : input.entries,
    getSplitRun: async (id: string) => input.runs[id],
    listRoyaltyLineItemsByRun: async (runId: string) => {
      if (input.failure === 'lineItems') return reject('line items');
      return (input.lineItems ?? []).filter((row) => row.split_run_id === runId);
    },
    listLedgerTransactionsByRun: async (runId: string) => {
      if (input.failure === 'transactions') return reject('ledger transactions');
      return (input.transactions ?? []).filter((row) => row.split_run_id === runId);
    },
  } as unknown as Store;
}

/** The derivation's payload, or the test failure — never a null read. */
async function readPayload(store: Store, windowDays: 7 | 30 | 90 | null) {
  const payload = await creatorAnalytics(store, windowDays);
  expect(payload).not.toBeNull();
  if (payload === null) throw new Error('creatorAnalytics degraded to null');
  return payload;
}

describe('creatorAnalytics — the creator-side readout over the one clearing ledger', () => {
  it('attributes every vault credit to its account-string payee and names payees from the ledger of record', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z')],
        entries: [
          // payeeA's allocation across its own buckets — reserve (the
          // withheld leg) plus pending — sums to the allocation.
          entry('j1', 'vault:payeeA:reserve', 240_000),
          entry('j1', 'vault:payeeA:pending', 760_000),
          entry('j1', 'vault:payeeB:pending', 1_200_000),
          debitEntry('j1', 'fbo_cash', 2_200_000),
        ],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001', 'Midnight Clear')],
        transactions: [
          tx('t1', 'r1', 'li-r1-TPL-MUS-001', 'payeeA', 'Payee A', 1_000_000),
          tx('t2', 'r1', 'li-r1-TPL-MUS-001', 'payeeB', 'Payee B', 1_200_000),
        ],
      }),
      30,
    );
    expect(payload.creatorPaidCents).toBe(2_200_000n); // the holder-credit measure
    expect(payload.grossClearedCents).toBe(2_200_000n); // the journal's full credit side
    expect(payload.activePayees).toBe(2);
    expect(payload.runsPaying).toBe(1);
    // The store-carried names of record ride along as labels.
    expect(payload.leaders.map((row) => [row.payeeId, row.label, row.rank, row.creditsCents])).toEqual([
      ['payeeB', 'Payee B', 1, 1_200_000n],
      ['payeeA', 'Payee A', 2, 1_000_000n], // reserve + pending legs sum per payee
    ]);
    // The leaders' credits sum to the KPI — same entries, same math.
    expect(payload.leaders.reduce((sum, row) => sum + row.creditsCents, 0n)).toBe(
      payload.creatorPaidCents,
    );
    // The game log — per transaction, newest first, payeeId as the tie-break.
    expect(payload.gameLog).toEqual([
      {
        day: '2026-09-22',
        payeeId: 'payeeA',
        entityId: 'TPL-MUS-001',
        workTitle: 'Midnight Clear',
        source: 'Spotify',
        creatorCents: 1_000_000n,
      },
      {
        day: '2026-09-22',
        payeeId: 'payeeB',
        entityId: 'TPL-MUS-001',
        workTitle: 'Midnight Clear',
        source: 'Spotify',
        creatorCents: 1_200_000n,
      },
    ]);
    expect(payload.sourceSplits).toEqual([
      { source: 'Spotify', creatorCents: 2_200_000n, runs: 1 },
    ]);
    // The trend fills the 30-day window gapless — one clearing day, honest zeros around it.
    expect(payload.trend).toHaveLength(30);
    expect(payload.trend[28]).toEqual({ day: '2026-09-21', creatorCents: 0n });
    expect(payload.trend[29]).toEqual({ day: '2026-09-22', creatorCents: 2_200_000n });
    // Every leader's series spans the same day range, zero-filled.
    for (const row of payload.leaders) {
      expect(row.series).toHaveLength(payload.trend.length);
      expect(row.series.reduce((sum, cents) => sum + cents, 0n)).toBe(row.creditsCents);
    }
  });

  it('measures only the royalty journals holder-credit legs — nothing else counts', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'payout_transfer', 'r2', 2, '2026-09-22T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 50_000),
          entry('j1', 'vault:platform:dust', 500), // the platform's vault — company money, not a payee
          debitEntry('j1', 'vault:payeeA:pending', 50_000), // the debit leg
          entry('j1', 'revenue:spotify', 50_000), // a non-vault leg
          entry('j1', 'vault:', 7_000), // a vault credit with no payee segment
          entry('j2', 'vault:payeeB:royalty', 88_000), // non-royalty journal — excluded
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Treasury') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
        transactions: [tx('t1', 'r1', 'li-r1-TPL-MUS-001', 'payeeA', 'Payee A', 50_000)],
      }),
      null,
    );
    expect(payload.creatorPaidCents).toBe(57_000n); // 50,000 + the malformed-key 7,000; no dust, no debit, no payout
    expect(payload.runsPaying).toBe(1);
    expect(payload.activePayees).toBe(1);
    // The malformed-key credit counts in the measure but attributes to NO
    // payee row — never force-fitted onto a malformed key. The leaders'
    // sum states the gap honestly.
    expect(payload.leaders).toEqual([
      {
        payeeId: 'payeeA',
        label: 'Payee A',
        rank: 1,
        creditsCents: 50_000n,
        runs: 1,
        lastDay: '2026-09-22',
        series: [50_000n],
      },
    ]);
    expect(payload.leaders.reduce((sum, row) => sum + row.creditsCents, 0n)).toBe(50_000n);
    expect(payload.sourceSplits).toEqual([
      { source: 'Spotify', creatorCents: 57_000n, runs: 1 },
    ]);
  });

  it('carries the brand strings of record HERE — the sanctioned surface for run sources', async () => {
    // The Analytics tab's structural cuts pin brands OUT; the Creator tab
    // is where the run sources of record render (spec art_UccVWZpj §5).
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-22T15:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-22T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 240_000),
          entry('j2', 'vault:payeeA:royalty', 1_250_000),
          entry('j3', 'vault:payeeB:royalty', 95_000),
        ],
        runs: { r1: run('r1', 'Nike'), r2: run('r2', 'PGA Tour'), r3: run('r3', 'Reader Platforms') },
        lineItems: [
          lineItem('r1', 'TPL-SPT-001'),
          lineItem('r2', 'TPL-TRN-001'),
          lineItem('r3', 'TPL-LIT-001'),
        ],
      }),
      null,
    );
    expect(payload.sourceSplits.map((row) => [row.source, row.creatorCents, row.runs])).toEqual([
      ['PGA Tour', 1_250_000n, 1],
      ['Nike', 240_000n, 1],
      ['Reader Platforms', 95_000n, 1],
    ]);
  });

  it('counts unresolved runs in the money while carrying no source and no game-log attribution', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r-missing', 2, '2026-09-21T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 50_000),
          entry('j2', 'vault:payeeB:royalty', 99_000), // the run record is gone; the vault account still names its payee
        ],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
        transactions: [tx('t1', 'r1', 'li-r1-TPL-MUS-001', 'payeeA', 'Payee A', 50_000)],
      }),
      null,
    );
    expect(payload.creatorPaidCents).toBe(149_000n); // both runs' money counts
    expect(payload.runsPaying).toBe(2);
    expect(payload.activePayees).toBe(2); // the vault account attributed payeeB
    // The source cut carries only the resolved run.
    expect(payload.sourceSplits).toEqual([
      { source: 'Spotify', creatorCents: 50_000n, runs: 1 },
    ]);
    // The game log has no row for the unresolved run — nothing to join.
    expect(payload.gameLog).toHaveLength(1);
    expect(payload.gameLog[0]).toMatchObject({ payeeId: 'payeeA', source: 'Spotify' });
    // payeeB's row renders its payeeId: no transaction ever named it — the honest null label.
    const orphan = payload.leaders.find((row) => row.payeeId === 'payeeB');
    expect(orphan?.label).toBeNull();
    expect(orphan?.creditsCents).toBe(99_000n);
  });

  it('states the unanimous null on a mixed-entity run while keeping per-transaction facts of record', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z')],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 60_000),
          entry('j1', 'vault:payeeB:royalty', 40_000),
        ],
        runs: { r1: run('r1', 'Mixed House') },
        lineItems: [lineItem('r1', 'TPL-MUS-001', 'Midnight Clear'), lineItem('r1', 'TPL-SPT-001', 'Nike Basketball Endorsement')],
        transactions: [
          tx('t1', 'r1', 'li-r1-TPL-MUS-001', 'payeeA', 'Payee A', 60_000),
          tx('t2', 'r1', 'li-r1-TPL-SPT-001', 'payeeB', 'Payee B', 40_000),
        ],
      }),
      null,
    );
    // The run's line items disagree — no unanimous entity anywhere in its rows.
    expect(payload.gameLog).toEqual([
      {
        day: '2026-09-22',
        payeeId: 'payeeA',
        entityId: null,
        workTitle: 'Midnight Clear', // the transaction's own line-item label — a fact of record
        source: 'Mixed House',
        creatorCents: 60_000n,
      },
      {
        day: '2026-09-22',
        payeeId: 'payeeB',
        entityId: null,
        workTitle: 'Nike Basketball Endorsement',
        source: 'Mixed House',
        creatorCents: 40_000n,
      },
    ]);
  });

  it('states the null work title when a transaction line item is gone', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z')],
        entries: [entry('j1', 'vault:payeeA:royalty', 60_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [], // the line-item row is gone; the transaction survives
        transactions: [tx('t1', 'r1', 'li-gone', 'payeeA', 'Payee A', 60_000)],
      }),
      null,
    );
    expect(payload.gameLog[0]).toMatchObject({ workTitle: null, entityId: null, source: 'Spotify' });
  });

  it('ranks ties on the shared rank and leaves the next rank vacant', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-22T15:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-22T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 300_000),
          entry('j2', 'vault:payeeB:royalty', 200_000),
          entry('j3', 'vault:payeeC:royalty', 200_000),
        ],
        runs: { r1: run('r1', 'Print A'), r2: run('r2', 'Print B'), r3: run('r3', 'Print C') },
        lineItems: [
          lineItem('r1', 'TPL-LIT-001'),
          lineItem('r2', 'TPL-LIT-003'),
          lineItem('r3', 'TPL-LIT-004'),
        ],
      }),
      null,
    );
    expect(payload.leaders.map((row) => [row.payeeId, row.rank, row.creditsCents])).toEqual([
      ['payeeA', 1, 300_000n],
      ['payeeB', 2, 200_000n], // the tie shares rank 2 —
      ['payeeC', 2, 200_000n], // — and rank 3 stays vacant.
    ]);
    expect(payload.leaders.some((row) => row.rank === 3)).toBe(false);
  });

  it('re-derives every KPI, the trend, and the leaderboard per window over the same ledger', async () => {
    const store = fakeStore({
      journals: [
        journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
        journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-17T15:00:00.000Z'),
        journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-15T15:00:00.000Z'),
        journal('j4', 'royalty_ingest', 'r4', 4, '2026-08-25T15:00:00.000Z'),
        journal('j5', 'royalty_ingest', 'r5', 5, '2026-08-24T15:00:00.000Z'),
        journal('j6', 'royalty_ingest', 'r6', 6, '2026-08-22T15:00:00.000Z'),
      ],
      entries: [
        entry('j1', 'vault:payeeA:royalty', 600),
        entry('j2', 'vault:payeeA:royalty', 500),
        entry('j3', 'vault:payeeA:royalty', 400),
        entry('j4', 'vault:payeeA:royalty', 300),
        entry('j5', 'vault:payeeA:royalty', 200),
        entry('j6', 'vault:payeeA:royalty', 100),
      ],
      runs: {
        r1: run('r1', 'Spotify'),
        r2: run('r2', 'Spotify'),
        r3: run('r3', 'Spotify'),
        r4: run('r4', 'Spotify'),
        r5: run('r5', 'Spotify'),
        r6: run('r6', 'Spotify'),
      },
      lineItems: [lineItem('r1', 'TPL-MUS-001')],
      transactions: [tx('t1', 'r1', 'li-r1-TPL-MUS-001', 'payeeA', 'Payee A', 600)],
    });
    const week = await readPayload(store, 7);
    expect(week.creatorPaidCents).toBe(1_100n); // anchor day back through 2026-09-16
    expect(week.runsPaying).toBe(2);
    expect(week.trend).toHaveLength(7);
    const month = await readPayload(store, 30);
    expect(month.creatorPaidCents).toBe(2_000n); // back through 2026-08-24
    expect(month.runsPaying).toBe(5);
    expect(month.trend).toHaveLength(30);
    const quarter = await readPayload(store, 90);
    expect(quarter.creatorPaidCents).toBe(2_100n); // back through 2026-06-25
    expect(quarter.runsPaying).toBe(6);
    expect(quarter.trend).toHaveLength(90);
    const all = await readPayload(store, null);
    expect(all.creatorPaidCents).toBe(2_100n);
    expect(all.trend).toHaveLength(32); // first activity 2026-08-22 → 2026-09-22; no fabricated pre-history
    expect(all.trend[0]?.day).toBe('2026-08-22');
    expect(all.leaders[0]?.series).toHaveLength(32);
    expect(all.leaders[0]?.lastDay).toBe('2026-09-22');
  });

  it('returns the honest zero payload on an empty ledger', async () => {
    const payload = await creatorAnalytics(
      fakeStore({ journals: [], entries: [], runs: {} }),
      30,
    );
    expect(payload).toEqual({
      windowDays: 30,
      creatorPaidCents: 0n,
      grossClearedCents: 0n,
      activePayees: 0,
      runsPaying: 0,
      trend: [],
      sourceSplits: [],
      leaders: [],
      gameLog: [],
    });
  });

  it('degrades to the honest null when a store read fails', async () => {
    const journals = [journal('j1', 'royalty_ingest', 'r1', 1)];
    expect(
      await creatorAnalytics(
        fakeStore({ journals, entries: [], runs: {}, failure: 'journals' }),
        null,
      ),
    ).toBeNull();
    expect(
      await creatorAnalytics(
        fakeStore({
          journals,
          entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
          runs: { r1: run('r1', 'Spotify') },
          lineItems: [lineItem('r1', 'TPL-MUS-001')],
          failure: 'lineItems',
        }),
        null,
      ),
    ).toBeNull();
    expect(
      await creatorAnalytics(
        fakeStore({
          journals,
          entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
          runs: { r1: run('r1', 'Spotify') },
          lineItems: [lineItem('r1', 'TPL-MUS-001')],
          failure: 'transactions',
        }),
        null,
      ),
    ).toBeNull();
  });
});

describe('creatorAnalytics — the real 119-run dev-seed pins', () => {
  let seeded: InMemoryStore;

  beforeAll(async () => {
    seeded = await createSeededStore();
  });

  it('pins the ALL-window creator-paid total, the gross, and the run counts exactly', async () => {
    const payload = await readPayload(seeded, null);
    // Σ holder credits over every royalty journal — the same total the
    // company tab pins as its ALL-window cleared figure ($8,445,103,733.36).
    expect(payload.creatorPaidCents).toBe(844_510_373_336n);
    expect(payload.grossClearedCents).toBe(844_510_373_336n); // zero dust in the seed
    expect(payload.runsPaying).toBe(119);
    expect(payload.activePayees).toBe(2);
    expect(payload.trend).toHaveLength(35); // 2026-08-20 → 2026-09-23
    expect(payload.trend[0]?.day).toBe('2026-08-20');
    expect(payload.trend[34]?.day).toBe('2026-09-23');
    expect(payload.gameLog).toHaveLength(124); // 5 two-payee music runs + 114 label-only runs
  });

  it('pins the per-payee sums, the store-carried labels, and the ranks exactly', async () => {
    const payload = await readPayload(seeded, null);
    expect(payload.leaders.map((row) => [row.payeeId, row.label, row.rank, row.runs, row.lastDay])).toEqual([
      ['rh_thrones_label_don', 'Thrones Rights Group', 1, 119, '2026-09-23'],
      ['rh_yeshua_throne_don', 'Yeshua Throne', 2, 5, '2026-09-07'], // the music runs' last clearing day
    ]);
    expect(payload.leaders[0]?.creditsCents).toBe(427_843_706_668n);
    // The persona's side — exactly the seed's stated Σ creator allocations.
    expect(payload.leaders[1]?.creditsCents).toBe(416_666_666_668n);
    expect(
      payload.leaders.reduce((sum, row) => sum + row.creditsCents, 0n),
    ).toBe(payload.creatorPaidCents);
    // Each series spans the 35-day trend range, zero-filled, summing to the row's total.
    for (const row of payload.leaders) {
      expect(row.series).toHaveLength(payload.trend.length);
      expect(row.series.reduce((sum, cents) => sum + cents, 0n)).toBe(row.creditsCents);
    }
  });

  it('pins the platform-source grouping exactly — all thirteen sources of record', async () => {
    const payload = await readPayload(seeded, null);
    expect(payload.sourceSplits).toEqual([
      { source: 'Spotify', creatorCents: 400_000_000_000n, runs: 2 },
      { source: 'Amazon Music', creatorCents: 200_000_000_000n, runs: 1 }, // the 200B tie — source name breaks it
      { source: 'YouTube Music', creatorCents: 200_000_000_000n, runs: 1 },
      { source: 'Bandcamp', creatorCents: 33_333_333_336n, runs: 1 },
      { source: 'Meridian Cinemas', creatorCents: 3_922_000_000n, runs: 36 },
      { source: 'PGA Tour', creatorCents: 2_425_000_000n, runs: 5 },
      { source: 'Ticketmaster', creatorCents: 2_389_600_000n, runs: 25 },
      { source: 'Nike', creatorCents: 872_000_000n, runs: 10 },
      { source: 'Reader Platforms', creatorCents: 676_000_000n, runs: 18 },
      { source: 'Broadcast Partners', creatorCents: 627_000_000n, runs: 5 },
      { source: 'Apple Podcasts', creatorCents: 243_960_000n, runs: 5 },
      { source: 'Twitch', creatorCents: 18_720_000n, runs: 5 },
      { source: 'TikTok', creatorCents: 2_760_000n, runs: 5 },
    ]);
    // Every seeded run resolves, so the source cut sums to the whole.
    expect(payload.sourceSplits.reduce((sum, row) => sum + row.creatorCents, 0n)).toBe(
      payload.creatorPaidCents,
    );
  });

  it('pins the window math for 7, 30, and 90 days against the same ledger', async () => {
    const week = await readPayload(seeded, 7);
    expect(week.creatorPaidCents).toBe(4_265_280_000n); // 2026-09-17 → 2026-09-23
    expect(week.runsPaying).toBe(47);
    expect(week.trend).toHaveLength(7);
    // The persona's music days all fall outside the trailing week — the
    // label is the only active payee.
    expect(week.activePayees).toBe(1);
    expect(week.leaders).toHaveLength(1);
    expect(week.leaders[0]?.payeeId).toBe('rh_thrones_label_don');

    const month = await readPayload(seeded, 30);
    expect(month.creatorPaidCents).toBe(643_899_373_336n); // everything but the pre-08-25 densifier days
    expect(month.runsPaying).toBe(106);
    expect(month.trend).toHaveLength(30);
    expect(month.activePayees).toBe(2);

    const quarter = await readPayload(seeded, 90);
    // The seed's whole span fits inside 90 days — the quarter reads the ALL totals.
    expect(quarter.creatorPaidCents).toBe(844_510_373_336n);
    expect(quarter.runsPaying).toBe(119);
    expect(quarter.trend).toHaveLength(90);
    expect(quarter.activePayees).toBe(2);
  });

  it('carries the unanimous entity and the line-item titles into the game log of record', async () => {
    const payload = await readPayload(seeded, null);
    // Every seeded run is one line item — the unanimous entity of each row
    // is that work's template id, and the title rides along as the display label.
    const newest = payload.gameLog[0];
    expect(newest?.day).toBe('2026-09-23');
    expect(newest?.entityId).toMatch(/^TPL-/);
    expect(newest?.workTitle).toBeTruthy();
    expect(newest?.source).toBeTruthy();
    for (const row of payload.gameLog) {
      expect(row.entityId).toMatch(/^TPL-/);
      expect(row.workTitle).toBeTruthy();
    }
  });
});
