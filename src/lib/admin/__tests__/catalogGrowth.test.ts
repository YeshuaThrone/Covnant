/**
 * catalogGrowthFlows — the Catalog Growth OS derivation's unit suite (spec
 * art_qNu4T32F), mirroring the creatorAnalytics suite's fixture patterns:
 * a fake store over the REAL record shapes (GlJournalRecord /
 * GlEntryRecord from src/modules/don/records.ts, RecoupmentAdvanceRecord /
 * RecoupmentLedgerRecord, TerritorySettlementRecord from the seam) with
 * the engine's OWN pure arithmetic (sweepRecoupment — no parallel math is
 * pinned anywhere). Pinned here: the per-advance recoupment row straight
 * from the engine's state query (the floored remaining and the completed
 * flag of record — an over-recouped advance floors at zero, a payee one
 * cent short never reads as recouped), the sweep trail's newest-day fact
 * through the keyed Store read (a fully-swept run the scan skips must
 * still reach the trail), the honest no-advance emission (payees WITHOUT
 * an advance are named, never imitated as zero-balance rows), the Top
 * Markets fold (per-territory cents with the name tiebreak, null-territory
 * money carried unattributed and never attributed, the honest empty fold
 * of the current seed, and the real-money-no-market state), the action
 * signals (integer-bps deltas incl. negative deltas and the exact
 * half-away-from-zero rounding direction, zero-base suppression, the ALL
 * window's honest absence of every delta signal, milestones only off the
 * engine's completed flag, the top source of record, and the empty signal
 * array as a valid payload), the fail-closed null on every store failure,
 * and the REAL dev-seed pins booted through createSeededStore. Store-read
 * integer math (bigint), nothing invented.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  GlEntryRecord,
  GlJournalRecord,
  RecoupmentAdvanceRecord,
  RecoupmentLedgerRecord,
} from '@/modules/don/records';
import type { SplitRunRecord } from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import { createSeededStore } from '@/lib/server/devSeed';
import type { InMemoryStore } from '@/lib/server/inMemoryStore';
import type { TerritorySettlementRecord } from '@/lib/server/territorySettlement';
import { catalogGrowthFlows } from '../catalogGrowth';

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

function advance(
  payeeId: string,
  name: string,
  targetCents: number,
  currentCents: number,
): RecoupmentAdvanceRecord {
  return {
    creator_id: payeeId,
    creator_name: name,
    recoupment_target_cents: targetCents,
    recoupment_current_cents: currentCents,
    recoupment_bps: 10_000,
    updated_at: '2026-09-22T00:00:00.000Z',
  };
}

/** One sweep-trail row — the engine's keyed ledger record of a run's sweep. */
function trail(
  id: string,
  payeeId: string,
  runId: string,
  currentCents: number,
  createdAt: string,
): RecoupmentLedgerRecord {
  return {
    id,
    creator_id: payeeId,
    split_run_id: runId,
    incoming_cents: 100_000,
    recouped_cents: 100_000,
    excess_cents: 0,
    recoupment_current_cents: currentCents,
    created_at: createdAt,
  };
}

/** One SDK-settled tier credit — the territory seam's projected record. */
function settlement(
  territory: string | null,
  amountCents: number,
  createdAt = '2026-09-22T00:00:00.000Z',
): TerritorySettlementRecord {
  return {
    split_run_id: 'sr-1',
    territory,
    rights_holder_id: 'rh_one',
    amount_cents: BigInt(amountCents),
    created_at: createdAt,
  };
}

interface FakeStoreInput {
  readonly journals: GlJournalRecord[];
  readonly entries: GlEntryRecord[];
  readonly runs: Record<string, SplitRunRecord | undefined>;
  readonly advances?: RecoupmentAdvanceRecord[];
  readonly recoupmentLedger?: RecoupmentLedgerRecord[];
  readonly settlements?: TerritorySettlementRecord[];
  /** When set, the named read rejects — the store-failure states. */
  readonly failure?: 'journals' | 'advances' | 'settlements' | 'trail';
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
    listRecoupmentAdvances: async () =>
      input.failure === 'advances' ? reject('recoupment advances') : input.advances ?? [],
    listRecoupmentLedgerByRun: async (runId: string) => {
      if (input.failure === 'trail') return reject('recoupment ledger');
      return (input.recoupmentLedger ?? []).filter((row) => row.split_run_id === runId);
    },
    listTerritorySettlements: async () =>
      input.failure === 'settlements' ? reject('territory settlements') : input.settlements ?? [],
  } as unknown as Store;
}

/** The derivation's payload, or the test failure — never a null read. */
async function readPayload(store: Store, windowDays: 7 | 30 | 90 | null) {
  const payload = await catalogGrowthFlows(store, windowDays);
  expect(payload).not.toBeNull();
  if (payload === null) throw new Error('catalogGrowthFlows degraded to null');
  return payload;
}

describe('catalogGrowthFlows — recoupment by catalog, the engine\'s own numbers', () => {
  it('emits the engine\'s own state per advance and names the credited payees with no advance on file', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-22T15:00:00.000Z')],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 100_000),
          entry('j1', 'vault:payeeC:royalty', 80_000),
        ],
        runs: { r1: run('r1', 'Spotify') },
        advances: [
          advance('payeeA', 'Payee A', 1_000_000, 400_000),
          advance('payeeB', 'Payee B', 500_000, 500_000),
        ],
        recoupmentLedger: [
          trail('rl1', 'payeeA', 'r1', 300_000, '2026-09-20T10:00:00.000Z'),
          trail('rl2', 'payeeA', 'r1', 400_000, '2026-09-21T10:00:00.000Z'),
        ],
      }),
      30,
    );
    // The engine's own numbers: target/current from the advance of record,
    // the floored remaining and the completed flag from the engine's state
    // query. Sorted by payeeId.
    expect(payload.recoupmentByCatalog).toEqual([
      {
        payeeId: 'payeeA',
        label: 'Payee A',
        advanceTargetCents: 1_000_000n,
        appliedCents: 400_000n,
        unrecoupedCents: 600_000n,
        fullyRecouped: false,
        lastSweepDay: '2026-09-21', // the newest trail day of record
      },
      {
        payeeId: 'payeeB',
        label: 'Payee B',
        advanceTargetCents: 500_000n,
        appliedCents: 500_000n,
        unrecoupedCents: 0n,
        fullyRecouped: true, // the engine's completed flag
        lastSweepDay: null, // no run-keyed sweep row — the honest null
      },
    ]);
    // No parallel arithmetic: the row's applied cents equal the engine's
    // newest keyed trail snapshot exactly.
    expect(payload.recoupmentByCatalog[0]?.appliedCents).toBe(400_000n);
    // The honest no-advance emission: payeeC is credited in the window and
    // carries no advance. payeeB carries an advance with no window credits
    // and is correctly NOT in the list.
    expect(payload.payeesWithoutAdvanceIds).toEqual(['payeeC']);
  });

  it('floors the unrecouped balance at zero and reads break-even ONLY from the engine\'s completed flag', async () => {
    // An empty ledger still reads the standing catalog state — an advance
    // on a catalog with no settlements yet is a real row.
    const payload = await readPayload(
      fakeStore({
        journals: [],
        entries: [],
        runs: {},
        advances: [
          advance('payeeA', 'Payee A', 400_000, 900_000), // over-recouped (retarget below current)
          advance('payeeB', '', 1_000_000, 999_999), // one cent short; the store carries no name
          advance('payeeC', '', 250_000, 250_000), // completed; the store carries no name
        ],
      }),
      30,
    );
    expect(payload.recoupmentByCatalog).toEqual([
      {
        payeeId: 'payeeA',
        label: 'Payee A',
        advanceTargetCents: 400_000n,
        appliedCents: 900_000n,
        unrecoupedCents: 0n, // the engine's own floor — never a negative balance
        fullyRecouped: true,
        lastSweepDay: null,
      },
      {
        payeeId: 'payeeB',
        label: null, // the store carries no name — the section renders the payeeId
        advanceTargetCents: 1_000_000n,
        appliedCents: 999_999n,
        unrecoupedCents: 1n,
        fullyRecouped: false, // one cent short NEVER reads as recouped
        lastSweepDay: null,
      },
      {
        payeeId: 'payeeC',
        label: null,
        advanceTargetCents: 250_000n,
        appliedCents: 250_000n,
        unrecoupedCents: 0n,
        fullyRecouped: true,
        lastSweepDay: null,
      },
    ]);
    // Milestones fire ONLY off the engine's completed flag — the one-cent
    // short payee emits none — and the unnamed payee's subject is the
    // payeeId of record, never an invented name.
    expect(payload.actionSignals).toEqual([
      {
        kind: 'recoupment-milestone',
        headline: 'Catalog fully recouped',
        subjectLabel: 'Payee A',
        basisPoints: null,
      },
      {
        kind: 'recoupment-milestone',
        headline: 'Catalog fully recouped',
        subjectLabel: 'payeeC',
        basisPoints: null,
      },
    ]);
  });

  it('degrades to the honest null when any store read fails', async () => {
    const journals = [journal('j1', 'royalty_ingest', 'r1', 1)];
    expect(
      await catalogGrowthFlows(fakeStore({ journals, entries: [], runs: {}, failure: 'journals' }), null),
    ).toBeNull();
    expect(
      await catalogGrowthFlows(fakeStore({ journals, entries: [], runs: {}, failure: 'advances' }), null),
    ).toBeNull();
    expect(
      await catalogGrowthFlows(fakeStore({ journals, entries: [], runs: {}, failure: 'settlements' }), null),
    ).toBeNull();
    expect(
      await catalogGrowthFlows(fakeStore({ journals, entries: [], runs: {}, failure: 'trail' }), null),
    ).toBeNull();
  });
});

describe('catalogGrowthFlows — Top Markets, the SDK-settled fold', () => {
  it('folds creator cents per stamped territory and carries null-territory money unattributed', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [],
        entries: [],
        runs: {},
        settlements: [
          settlement('US', 100_000),
          settlement('US', 50_000),
          settlement('GB', 75_000),
          settlement('GB', 75_000),
          settlement(null, 25_000), // real money belonging to no market of record
        ],
      }),
      null,
    );
    // Desc by cents; the 150k tie is broken by the territory name (GB first).
    expect(payload.topMarkets).toEqual({
      markets: [
        { territory: 'GB', creatorCents: 150_000n },
        { territory: 'US', creatorCents: 150_000n },
      ],
      unattributedCents: 25_000n, // carried, never dropped, never attributed
      settlementsConsidered: 5,
    });
  });

  it('pins the honest empty fold when no SDK-settled events exist — the current seed\'s state', async () => {
    const payload = await readPayload(
      fakeStore({ journals: [], entries: [], runs: {}, settlements: [] }),
      null,
    );
    expect(payload.topMarkets).toEqual({
      markets: [],
      unattributedCents: 0n,
      settlementsConsidered: 0,
    });
  });

  it('pins the real-money-no-market state when SDK-settled credits carry no territory', async () => {
    const payload = await readPayload(
      fakeStore({
        journals: [],
        entries: [],
        runs: {},
        settlements: [settlement(null, 40_000), settlement(null, 8_000)],
      }),
      null,
    );
    expect(payload.topMarkets).toEqual({
      markets: [], // no market may be invented for unstamped money
      unattributedCents: 48_000n,
      settlementsConsidered: 2,
    });
  });
});

describe('catalogGrowthFlows — action signals, measured statements only', () => {
  /** Five sources across the 7-day window and its preceding seven days. */
  function deltaFixture() {
    return fakeStore({
      journals: [
        // The current window's anchor day (2026-09-22; window 7 → 09-16..09-22).
        journal('j-hotel', 'royalty_ingest', 'r-hotel', 1, '2026-09-22T15:00:00.000Z'),
        journal('j-echo', 'royalty_ingest', 'r-echo', 2, '2026-09-22T15:00:00.000Z'),
        journal('j-alpha', 'royalty_ingest', 'r-alpha', 3, '2026-09-22T15:00:00.000Z'),
        journal('j-beta', 'royalty_ingest', 'r-beta', 4, '2026-09-22T15:00:00.000Z'),
        // The prior window (09-09..09-15).
        journal('j-echo-p', 'royalty_ingest', 'r-echo-p', 5, '2026-09-10T15:00:00.000Z'),
        journal('j-alpha-p', 'royalty_ingest', 'r-alpha-p', 6, '2026-09-10T15:00:00.000Z'),
        journal('j-beta-p', 'royalty_ingest', 'r-beta-p', 7, '2026-09-10T15:00:00.000Z'),
        journal('j-zulu-p', 'royalty_ingest', 'r-zulu-p', 8, '2026-09-10T15:00:00.000Z'),
        journal('j-foxtrot-p', 'royalty_ingest', 'r-foxtrot-p', 9, '2026-09-10T15:00:00.000Z'),
      ],
      entries: [
        entry('j-hotel', 'vault:payeeA:royalty', 100_000), // no prior money — no delta signal
        entry('j-echo', 'vault:payeeA:royalty', 30_000), // flat — a zero delta is still measured
        entry('j-alpha', 'vault:payeeA:royalty', 20_001), // +0.5 bps exactly — rounds AWAY from zero
        entry('j-beta', 'vault:payeeA:royalty', 19_999), // −0.5 bps exactly — rounds AWAY from zero
        entry('j-echo-p', 'vault:payeeA:royalty', 30_000),
        entry('j-alpha-p', 'vault:payeeA:royalty', 20_000),
        entry('j-beta-p', 'vault:payeeA:royalty', 20_000),
        entry('j-zulu-p', 'vault:payeeA:royalty', 50_000), // paid prior, unpaid now — a real −100%
        entry('j-foxtrot-p', 'vault:payeeA:royalty', 10_000),
      ],
      runs: {
        'r-hotel': run('r-hotel', 'Hotel'),
        'r-echo': run('r-echo', 'Echo'),
        'r-alpha': run('r-alpha', 'Alpha'),
        'r-beta': run('r-beta', 'Beta'),
        'r-echo-p': run('r-echo-p', 'Echo'),
        'r-alpha-p': run('r-alpha-p', 'Alpha'),
        'r-beta-p': run('r-beta-p', 'Beta'),
        'r-zulu-p': run('r-zulu-p', 'Zulu'),
        'r-foxtrot-p': run('r-foxtrot-p', 'Foxtrot'),
      },
    });
  }

  it('emits integer-bps deltas vs the prior window — gains, losses, rounding direction, zero-base suppression', async () => {
    const payload = await readPayload(deltaFixture(), 7);
    // Order: the window's cut (money desc), then prior-only sources by
    // prior money. 'Hotel' (the window's top money, zero prior) emits NO
    // delta — no ratio is invented over a zero base — yet remains the top
    // source of record. A zero delta is a measured statement, not filler —
    // it emits. Rounding at the exact .5 boundary is away from zero, both
    // directions pinned.
    expect(payload.actionSignals).toEqual([
      { kind: 'source-delta', headline: 'Echo 0% vs prior period', subjectLabel: 'Echo', basisPoints: 0 },
      { kind: 'source-delta', headline: 'Alpha +0.01% vs prior period', subjectLabel: 'Alpha', basisPoints: 1 },
      { kind: 'source-delta', headline: 'Beta -0.01% vs prior period', subjectLabel: 'Beta', basisPoints: -1 },
      { kind: 'source-delta', headline: 'Zulu -100% vs prior period', subjectLabel: 'Zulu', basisPoints: -10_000 },
      { kind: 'source-delta', headline: 'Foxtrot -100% vs prior period', subjectLabel: 'Foxtrot', basisPoints: -10_000 },
      { kind: 'top-source', headline: 'Top source: Hotel', subjectLabel: 'Hotel', basisPoints: null },
    ]);
  });

  it('never emits a delta signal on the ALL window — no prior window exists', async () => {
    const payload = await readPayload(deltaFixture(), null);
    expect(payload.actionSignals).toEqual([
      { kind: 'top-source', headline: 'Top source: Hotel', subjectLabel: 'Hotel', basisPoints: null },
    ]);
  });

  it('renders nothing when nothing is measured — the empty signal array is valid', async () => {
    // Money flows, but the run record is gone: no source of record means
    // no cut, no deltas, no top source — and no advances, no milestones.
    const payload = await readPayload(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r-missing', 1, '2026-09-22T15:00:00.000Z')],
        entries: [entry('j1', 'vault:payeeB:royalty', 99_000)],
        runs: {},
      }),
      7,
    );
    expect(payload.actionSignals).toEqual([]);
  });
});

describe('catalogGrowthFlows — the real dev-seed pins', () => {
  let seeded: InMemoryStore;

  beforeAll(async () => {
    seeded = await createSeededStore();
  });

  it('pins the seed\'s honest catalog state — no advances, no SDK-settled territory', async () => {
    const payload = await readPayload(seeded, null);
    // The seed carries no advances — the honest empty rows, and both
    // credited payees named as having no advance on file.
    expect(payload.recoupmentByCatalog).toEqual([]);
    expect(payload.payeesWithoutAdvanceIds).toEqual([
      'rh_thrones_label_don',
      'rh_yeshua_throne_don',
    ]);
    // Path B held: the seed has no SDK-settled rows — the fold is
    // honestly empty until the founder decides on a seed cohort.
    expect(payload.topMarkets).toEqual({
      markets: [],
      unattributedCents: 0n,
      settlementsConsidered: 0,
    });
    // ALL window: no deltas ever; no advances, no milestones; the top
    // source of record stands alone.
    expect(payload.actionSignals).toEqual([
      {
        kind: 'top-source',
        headline: 'Top source: Spotify',
        subjectLabel: 'Spotify',
        basisPoints: null,
      },
    ]);
  });

  it('pins the 7-day window\'s source deltas against the seed\'s real prior window', async () => {
    const payload = await readPayload(seeded, 7);
    const deltas = payload.actionSignals.filter((signal) => signal.kind === 'source-delta');
    // Every delta is a measured integer-bps statement — negative included.
    for (const signal of deltas) {
      expect(signal.basisPoints).not.toBeNull();
      expect(Number.isInteger(signal.basisPoints)).toBe(true);
      expect(signal.headline).toMatch(/ vs prior period$/);
      expect(signal.headline).not.toMatch(/due to|because|driven by|from /);
    }
    // No advances in the seed → no milestones; the top source of the
    // 7-day window is present exactly once.
    expect(payload.actionSignals.filter((s) => s.kind === 'recoupment-milestone')).toEqual([]);
    expect(payload.actionSignals.filter((s) => s.kind === 'top-source')).toHaveLength(1);
    // The exact measured signals of record (booted through
    // createSeededStore; the anchor is the store's own clock — the newest
    // royalty journal day — so these pins hold on every run): eight
    // measured deltas — gains and losses alike — and the 7-day window's
    // top source, Meridian Cinemas.
    expect(payload.actionSignals).toEqual([
      { kind: 'source-delta', headline: 'Meridian Cinemas -37.29% vs prior period', subjectLabel: 'Meridian Cinemas', basisPoints: -3729 },
      { kind: 'source-delta', headline: 'Ticketmaster -3.37% vs prior period', subjectLabel: 'Ticketmaster', basisPoints: -337 },
      { kind: 'source-delta', headline: 'PGA Tour -40.8% vs prior period', subjectLabel: 'PGA Tour', basisPoints: -4080 },
      { kind: 'source-delta', headline: 'Broadcast Partners +511.27% vs prior period', subjectLabel: 'Broadcast Partners', basisPoints: 51127 },
      { kind: 'source-delta', headline: 'Nike -15.52% vs prior period', subjectLabel: 'Nike', basisPoints: -1552 },
      { kind: 'source-delta', headline: 'Apple Podcasts +221.33% vs prior period', subjectLabel: 'Apple Podcasts', basisPoints: 22133 },
      { kind: 'source-delta', headline: 'Twitch -22.22% vs prior period', subjectLabel: 'Twitch', basisPoints: -2222 },
      { kind: 'source-delta', headline: 'TikTok -16.67% vs prior period', subjectLabel: 'TikTok', basisPoints: -1667 },
      { kind: 'top-source', headline: 'Top source: Meridian Cinemas', subjectLabel: 'Meridian Cinemas', basisPoints: null },
    ]);
  });
});
