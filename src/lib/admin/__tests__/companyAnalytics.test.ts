/**
 * companyAnalytics — the company-level derivation's unit suite. The mirror
 * of the entityIntelligence suite: a fake store over the REAL record
 * shapes (GlJournalRecord / GlEntryRecord from src/modules/don/records.ts,
 * SplitRunRecord / RoyaltyLineItemRecord from src/lib/don/types.ts) with
 * the REAL entity resolver (the master store's entityRecordForWorkRef over
 * the registered entity seeds — TPL-MUS-001 the canonical master
 * recording, TPL-SPN-001 the sponsorship deal, and so on). Pinned here:
 * the six KPI cards with the canon 50/35/15 split summing to gross exactly
 * in bigint cents (dust to the reserve), the daily grouping across a month
 * boundary with gapless zero fill, every window (7/30/90/all) against the
 * same ledger, the standard-competition ranks with ties (next rank
 * vacant), momentum30 with the honest null and the floored loss, the
 * spark history, the unanimous attribution rules (unresolved and
 * mixed-kind runs count but carry no attribution), the exclusion set
 * (platform dust, debit legs, non-vault legs, non-royalty journals),
 * the fail-closed null on store failure, and the counterparty boundary —
 * no brand string in the structural payload. Store-read integer math
 * (bigint), nothing invented.
 */
import { describe, expect, it } from 'vitest';

import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type { RoyaltyLineItemRecord, SplitRunRecord } from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import { companyAnalytics, type AnalyticsWindow } from '../companyAnalytics';

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
    idempotency_key: null,
    variance_account_cents: 0,
    created_at: '2026-09-22T00:00:00.000Z',
    status: 'posted',
  };
}

function lineItem(runId: string, workId: string): RoyaltyLineItemRecord {
  return {
    id: `li-${runId}-${workId}`,
    split_run_id: runId,
    work_id: workId,
    work_title: 'Work of record',
    amount_cents: 0,
    splits_json: '[]',
    created_at: '2026-09-22T00:00:00.000Z',
  };
}

interface FakeStoreInput {
  readonly journals: GlJournalRecord[];
  readonly entries: GlEntryRecord[];
  readonly runs: Record<string, SplitRunRecord | undefined>;
  readonly lineItems?: RoyaltyLineItemRecord[];
  /** When set, the named read rejects — the store-failure states. */
  readonly failure?: 'journals' | 'lineItems';
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
  } as unknown as Store;
}

/** The derivation's payload, or the test failure — never a null read. */
async function readPayload(store: Store, window: AnalyticsWindow) {
  const payload = await companyAnalytics(store, window);
  expect(payload).not.toBeNull();
  if (payload === null) throw new Error('companyAnalytics degraded to null');
  return payload;
}

describe('companyAnalytics — the company readout over the one clearing ledger', () => {
  it('splits every run gross into the canon 50/35/15 with the dust sweeping to the reserve', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z')],
        entries: [entry('j1', 'vault:payeeA:royalty', 1_000_001)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
      }),
      'all',
    );
    expect(payload.kpis.totalClearedCents).toBe(1_000_001n);
    expect(payload.kpis.creatorPaidCents).toBe(350_000n); // 35% floors: 350,000.35 → 350,000
    expect(payload.kpis.operationsYieldCents).toBe(150_000n);
    expect(payload.kpis.companyReserveCents).toBe(500_001n); // 50% plus the swept dust
    expect(
      payload.kpis.creatorPaidCents + payload.kpis.operationsYieldCents + payload.kpis.companyReserveCents,
    ).toBe(payload.kpis.totalClearedCents);
    expect(payload.kpis.runCount).toBe(1);
    expect(payload.kpis.avgRunCents).toBe(1_000_001n);
    const row = payload.leaderboard[0];
    expect(row?.entityId).toBe('TPL-MUS-001');
    expect(row?.classLabel).toBe('MASTER_RECORDING');
    expect(row?.rank).toBe(1);
    expect(row?.rankOf).toBe(1);
    expect(row?.grossCents).toBe(1_000_001n);
    expect(row?.creatorPaidCents).toBe(350_000n);
    expect(payload.gameLog[0]).toMatchObject({
      runId: 'r1',
      day: '2026-09-22',
      entityId: 'TPL-MUS-001',
      classLabel: 'MASTER_RECORDING',
      flowKind: 'ROYALTY_DISTRIBUTION',
      source: 'Spotify',
      grossCents: 1_000_001n,
      creatorCents: 350_000n,
      opsCents: 150_000n,
      companyCents: 500_001n,
    });
  });

  it('groups the daily series across a month boundary without merging the days', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-08-31T23:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-01T01:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 30_000),
          entry('j2', 'vault:payeeB:royalty', 20_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Apple Music') },
        lineItems: [lineItem('r1', 'TPL-MUS-001'), lineItem('r2', 'TPL-MUS-001')],
      }),
      'all',
    );
    expect(payload.daily.map((day) => [day.day, day.grossCents])).toEqual([
      ['2026-08-31', 30_000n],
      ['2026-09-01', 20_000n],
    ]);
    expect(payload.daily[0]?.creatorCents).toBe(10_500n);
    expect(payload.daily[0]?.opsCents).toBe(4_500n);
    expect(payload.daily[1]?.creatorCents).toBe(7_000n);
    expect(payload.daily[1]?.opsCents).toBe(3_000n);
    const dailySum = payload.daily.reduce((sum, day) => sum + day.grossCents, 0n);
    expect(dailySum).toBe(payload.kpis.totalClearedCents);
  });

  it('fills the daily series with honest zero days so the curve has no holes', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-03T12:00:00.000Z')],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
      }),
      '7d',
    );
    expect(payload.daily).toHaveLength(7); // anchor 2026-09-03 back through 2026-08-28
    expect(payload.daily[0]).toEqual({
      day: '2026-08-28',
      grossCents: 0n,
      creatorCents: 0n,
      opsCents: 0n,
    });
    expect(payload.daily[6]?.day).toBe('2026-09-03');
    expect(payload.daily[6]?.grossCents).toBe(50_000n);
  });

  it('re-derives every KPI, series, and cut per window over the same ledger', async () => {
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
      lineItems: [
        lineItem('r1', 'TPL-MUS-001'),
        lineItem('r2', 'TPL-MUS-001'),
        lineItem('r3', 'TPL-MUS-001'),
        lineItem('r4', 'TPL-MUS-001'),
        lineItem('r5', 'TPL-MUS-001'),
        lineItem('r6', 'TPL-MUS-001'),
      ],
    });
    const week = await readPayload(store, '7d');
    expect(week.kpis.totalClearedCents).toBe(1_100n); // anchor day back through 2026-09-16
    expect(week.kpis.runCount).toBe(2);
    expect(week.kpis.avgRunCents).toBe(550n);
    expect(week.daily).toHaveLength(7);
    const month = await readPayload(store, '30d');
    expect(month.kpis.totalClearedCents).toBe(2_000n); // back through 2026-08-24
    expect(month.kpis.runCount).toBe(5);
    expect(month.daily).toHaveLength(30);
    const quarter = await readPayload(store, '90d');
    expect(quarter.kpis.totalClearedCents).toBe(2_100n); // back through 2026-06-25
    expect(quarter.kpis.runCount).toBe(6);
    expect(quarter.daily).toHaveLength(90);
    const all = await readPayload(store, 'all');
    expect(all.kpis.totalClearedCents).toBe(2_100n);
    expect(all.daily).toHaveLength(32); // first activity 2026-08-22 → 2026-09-22
    expect(all.leaderboard[0]?.runCount).toBe(6);
    expect(all.leaderboard[0]?.momentum30).toBe(1_900); // 2,000 current vs 100 prior (2026-08-22)
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
      'all',
    );
    expect(payload.leaderboard.map((row) => [row.entityId, row.rank, row.rankOf])).toEqual([
      ['TPL-LIT-001', 1, 3],
      ['TPL-LIT-003', 2, 3],
      ['TPL-LIT-004', 2, 3],
    ]);
    // The next rank after a tie is vacant — no row carries rank 3.
    expect(payload.leaderboard.some((row) => row.rank === 3)).toBe(false);
  });

  it('carries momentum30 honestly — null without a prior point, the floored loss never shrunk', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-08-01T15:00:00.000Z'), // FLM prior
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-01T15:00:00.000Z'), // FLM current
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-01T15:00:00.000Z'), // ESX current only
          journal('j4', 'royalty_ingest', 'r4', 4, '2026-08-01T15:00:00.000Z'), // LVE prior only
          journal('j5', 'royalty_ingest', 'r5', 5, '2026-08-01T15:00:00.000Z'), // SPT prior
          journal('j6', 'royalty_ingest', 'r6', 6, '2026-09-01T15:00:00.000Z'), // SPT current
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 100_000),
          entry('j2', 'vault:payeeA:royalty', 150_000),
          entry('j3', 'vault:payeeB:royalty', 10_000),
          entry('j4', 'vault:payeeC:royalty', 40_000),
          entry('j5', 'vault:payeeD:royalty', 3_000),
          entry('j6', 'vault:payeeD:royalty', 1_000),
        ],
        runs: {
          r1: run('r1', 'Box Office'),
          r2: run('r2', 'Box Office'),
          r3: run('r3', 'Stream'),
          r4: run('r4', 'Box Office'),
          r5: run('r5', 'League'),
          r6: run('r6', 'League'),
        },
        lineItems: [
          lineItem('r1', 'TPL-FLM-001'),
          lineItem('r2', 'TPL-FLM-001'),
          lineItem('r3', 'TPL-ESX-001'),
          lineItem('r4', 'TPL-LVE-001'),
          lineItem('r5', 'TPL-SPT-001'),
          lineItem('r6', 'TPL-SPT-001'),
        ],
      }),
      'all',
    );
    const momentumOf = (entityId: string) =>
      payload.leaderboard.find((row) => row.entityId === entityId)?.momentum30;
    expect(momentumOf('TPL-FLM-001')).toBe(50); // 150,000 vs 100,000 → +50
    expect(momentumOf('TPL-ESX-001')).toBeNull(); // no prior-window point
    expect(momentumOf('TPL-LVE-001')).toBe(-100); // zeroed out against its prior activity
    expect(momentumOf('TPL-SPT-001')).toBe(-67); // −66.67 floored — the loss not shrunk
  });

  it('returns the honest zero payload on an empty ledger — the average null at zero runs', async () => {
    const payload = await companyAnalytics(
      fakeStore({ journals: [], entries: [], runs: {} }),
      '30d',
    );
    expect(payload).toEqual({
      window: '30d',
      kpis: {
        totalClearedCents: 0n,
        creatorPaidCents: 0n,
        operationsYieldCents: 0n,
        companyReserveCents: 0n,
        runCount: 0,
        avgRunCents: null,
      },
      daily: [],
      flowKindSplit: [],
      industryTotals: [],
      leaderboard: [],
      gameLog: [],
    });
  });

  it('keeps every brand and counterparty string out of the structural payload', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-22T15:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-22T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 240_000),
          entry('j2', 'vault:payeeB:royalty', 1_250_000),
          entry('j3', 'vault:payeeC:royalty', 95_000),
        ],
        runs: { r1: run('r1', 'Nike'), r2: run('r2', 'PGA Tour'), r3: run('r3', 'Acme Brands') },
        lineItems: [
          lineItem('r1', 'TPL-SPT-001'),
          lineItem('r2', 'TPL-TRN-001'),
          lineItem('r3', 'TPL-SPN-001'),
        ],
      }),
      'all',
    );
    const rendered = JSON.stringify(
      {
        kpis: payload.kpis,
        daily: payload.daily,
        flowKindSplit: payload.flowKindSplit,
        industryTotals: payload.industryTotals,
        leaderboard: payload.leaderboard,
      },
      (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
    );
    expect(rendered).not.toContain('Nike');
    expect(rendered).not.toContain('PGA Tour');
    expect(rendered).not.toContain('Acme');
    // The leaderboard carries structural identity only — ids and class tags.
    for (const row of payload.leaderboard) {
      expect(row.entityId).toMatch(/^TPL-/);
      expect(row.classLabel).toMatch(/^[A-Z_]+$/);
    }
    // The game log's source column is the runs' own field of record.
    expect(payload.gameLog.map((row) => row.source)).toEqual(['Nike', 'PGA Tour', 'Acme Brands']);
    // The industry cut stays structural (lexicographic order after sort).
    expect(payload.industryTotals.map((row) => row.industry).sort()).toEqual([
      'SPONSORSHIP',
      'SPORTS',
    ]);
  });

  it('counts unresolved and mixed-kind runs in the totals while carrying no attribution', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r-missing', 2, '2026-09-21T15:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-20T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 50_000),
          entry('j2', 'vault:payeeB:royalty', 99_000),
          entry('j3', 'vault:payeeC:royalty', 77_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r3: run('r3', 'Mixed House') },
        lineItems: [
          lineItem('r1', 'TPL-MUS-001'),
          lineItem('r3', 'TPL-MUS-001'),
          lineItem('r3', 'TPL-SPT-001'),
        ],
      }),
      'all',
    );
    expect(payload.kpis.totalClearedCents).toBe(226_000n);
    expect(payload.kpis.runCount).toBe(3);
    // The cuts attribute only the unanimous run.
    expect(payload.flowKindSplit).toEqual([
      { kind: 'ROYALTY_DISTRIBUTION', runCount: 1, grossCents: 50_000n },
    ]);
    expect(payload.industryTotals).toEqual([
      { industry: 'MUSIC', label: 'Music', runCount: 1, grossCents: 50_000n },
    ]);
    expect(payload.leaderboard).toHaveLength(1);
    expect(payload.leaderboard[0]?.entityId).toBe('TPL-MUS-001');
    expect(payload.leaderboard[0]?.rankOf).toBe(1);
    // The game log carries all three rows newest first, the unresolved and
    // mixed rows stating their missing structure as nulls.
    expect(payload.gameLog.map((row) => row.runId)).toEqual(['r1', 'r-missing', 'r3']);
    expect(payload.gameLog[1]).toMatchObject({
      entityId: null,
      classLabel: null,
      flowKind: null,
      source: null,
    });
    expect(payload.gameLog[2]).toMatchObject({
      entityId: null,
      classLabel: null,
      flowKind: null,
    });
    // Every row's three canon sides still sum to its gross.
    for (const row of payload.gameLog) {
      expect(row.creatorCents + row.opsCents + row.companyCents).toBe(row.grossCents);
    }
  });

  it('measures only the royalty journals holder-credit legs — nothing else counts', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z'),
          journal('j2', 'payout_transfer', 'r2', 2, '2026-09-22T15:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-22T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 50_000),
          entry('j1', 'vault:platform:dust', 500), // the platform's dust vault — not a holder
          debitEntry('j1', 'vault:payeeA:pending', 50_000), // the debit leg
          entry('j1', 'revenue:spotify', 50_000), // a non-vault leg
          entry('j2', 'vault:payeeB:royalty', 88_000), // non-royalty journal — excluded
          entry('j3', 'vault:payeeC:royalty', 70_000), // unresolvable run — counted, unattributed
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Treasury'), r3: run('r3', 'Orphan') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')], // r3 has no line items — unresolvable
      }),
      'all',
    );
    expect(payload.kpis.totalClearedCents).toBe(120_000n); // 50,000 + 70,000; no dust, no payout
    expect(payload.kpis.runCount).toBe(2);
    expect(payload.industryTotals).toEqual([
      { industry: 'MUSIC', label: 'Music', runCount: 1, grossCents: 50_000n },
    ]);
    expect(payload.gameLog.map((row) => row.runId)).toEqual(['r1', 'r3']);
  });

  it('carries the spark as the entity per-point window history in chronological order', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-07-01T15:00:00.000Z'), // outside the 30-day window
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-01T15:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-01T18:00:00.000Z'), // same UTC day as j2
          journal('j4', 'royalty_ingest', 'r4', 4, '2026-09-05T15:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 99_000),
          entry('j2', 'vault:payeeA:royalty', 10_000),
          entry('j3', 'vault:payeeA:royalty', 2_000),
          entry('j4', 'vault:payeeA:royalty', 5_000),
        ],
        runs: {
          r1: run('r1', 'Box Office'),
          r2: run('r2', 'Box Office'),
          r3: run('r3', 'Box Office'),
          r4: run('r4', 'Box Office'),
        },
        lineItems: [
          lineItem('r1', 'TPL-FLM-001'),
          lineItem('r2', 'TPL-FLM-001'),
          lineItem('r3', 'TPL-FLM-001'),
          lineItem('r4', 'TPL-FLM-001'),
        ],
      }),
      '30d',
    );
    const row = payload.leaderboard[0];
    expect(row?.entityId).toBe('TPL-FLM-001');
    expect(row?.spark).toEqual([10_000n, 2_000n, 5_000n]); // per-timestamp points, oldest first (the trendFrom grouping)
    expect(row?.grossCents).toBe(17_000n); // only the window's points
    expect(row?.momentum30).toBeNull(); // no prior-window point
  });

  it('degrades to the honest null when a store read fails', async () => {
    const journals = [journal('j1', 'royalty_ingest', 'r1', 1)];
    expect(
      await companyAnalytics(
        fakeStore({ journals, entries: [], runs: {}, failure: 'journals' }),
        'all',
      ),
    ).toBeNull();
    expect(
      await companyAnalytics(
        fakeStore({
          journals,
          entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
          runs: { r1: run('r1', 'Spotify') },
          lineItems: [lineItem('r1', 'TPL-MUS-001')],
          failure: 'lineItems',
        }),
        'all',
      ),
    ).toBeNull();
  });
});
