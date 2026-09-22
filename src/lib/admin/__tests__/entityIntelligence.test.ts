/**
 * entityIntelligence — the per-entity intelligence derivation's unit suite.
 * Pinned against a fake store over the REAL record shapes (GlJournalRecord /
 * GlEntryRecord from src/modules/don/records.ts, SplitRunRecord /
 * RoyaltyLineItemRecord from src/lib/don/types.ts) with the REAL entity
 * resolver (the master store's entityRecordForWorkRef over the registered
 * entity seeds — TPL-MUS-001 is the canonical master recording,
 * TPL-SPT-001 the athlete contract, and so on). Pinned here: the four reads
 * per entity (class telemetry profile, promised-vs-cleared, timestamped
 * trend, cohort rank), the standard-competition rank math with ties, the
 * atomic-class cohort boundary (the SPORTS industry tag groups two classes;
 * a cohort does not), the per-class promised mapping including every honest
 * null, the unanimous run resolution (mixed and unresolvable runs attribute
 * nothing), the fail-closed null on store failure, and the zero-cleared
 * honesty of an uncredentialed entity. Store-read integer math (bigint),
 * nothing invented.
 */
import { describe, expect, it } from 'vitest';

import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type { RoyaltyLineItemRecord, SplitRunRecord } from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import { entityIntelligence } from '../entityIntelligence';

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

describe('entityIntelligence — the derivation over the real entity binding', () => {
  it('resolves a music journal to the canonical master recording with its real telemetry and cleared credits', async () => {
    const readout = await entityIntelligence(
      'TPL-MUS-001',
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
      }),
    );

    expect(readout).not.toBeNull();
    if (readout === null || readout.class !== 'MASTER_RECORDING') {
      throw new Error('readout unexpectedly missing or wrong class');
    }
    expect(readout.class).toBe('MASTER_RECORDING');
    expect(readout.templateId).toBe('TPL-MUS-001');
    // The profile is the class record of read — ISRC US-S1Z-26-00001,
    // micro royalty 0.0035, ASCAP (the drop-5 canon seed).
    expect(readout.isrcCode).toBe('US-S1Z-26-00001');
    expect(readout.subSecondMicroRoyaltyRate).toBe(0.0035);
    expect(readout.proTelemetryBinding).toBe('ASCAP');
    expect(readout.cleared).toBe(50_000n);
    expect(readout.trend).toEqual([
      { at: '2026-09-22T00:00:00.000Z', credit: 50_000n },
    ]);
  });

  it('resolves the demo CBT form to the same entity identity as the template-id form', async () => {
    const ledger = {
      journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
      entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
      runs: { r1: run('r1', 'Spotify') },
      lineItems: [lineItem('r1', 'CBT-TRK-A51DF05B4279')],
    };

    const byCbt = await entityIntelligence('CBT-TRK-A51DF05B4279', fakeStore(ledger));
    const byTemplateId = await entityIntelligence('TPL-MUS-001', fakeStore(ledger));

    expect(byCbt).not.toBeNull();
    if (byCbt === null) throw new Error('readout unexpectedly null');
    // Both reference forms are ONE entity: the CBT resolves through the
    // sector binding to the same master recording of record.
    expect(byCbt.class).toBe('MASTER_RECORDING');
    expect(byCbt.templateId).toBe('TPL-MUS-001');
    expect(byCbt.cleared).toBe(50_000n);
    expect(byTemplateId?.cleared).toBe(50_000n);
  });
});

describe('entityIntelligence — the cohort rank (standard competition ranking)', () => {
  it('shares a rank across a tie — two films with an equal cleared total both rank 1 of 2', async () => {
    const ledger = {
      journals: [
        journal('j1', 'royalty_ingest', 'r1', 1),
        journal('j2', 'royalty_ingest', 'r2', 2),
      ],
      entries: [
        entry('j1', 'vault:payeeA:royalty', 50_000),
        entry('j2', 'vault:payeeB:royalty', 50_000),
      ],
      runs: { r1: run('r1', 'Studio A'), r2: run('r2', 'Studio B') },
      lineItems: [lineItem('r1', 'TPL-FLM-001'), lineItem('r2', 'TPL-FLM-002')],
    };

    const first = await entityIntelligence('TPL-FLM-001', fakeStore(ledger));
    const second = await entityIntelligence('TPL-FLM-002', fakeStore(ledger));

    expect(first?.cohort).toEqual({ rank: 1n, of: 2n });
    expect(second?.cohort).toEqual({ rank: 1n, of: 2n });
    // The tie shares the cleared total but not the class record — the
    // promised values differ (the canon escrows), the ledger tie holds.
    expect(first?.promisedUSD).toBe(4_250_000n);
    expect(second?.promisedUSD).toBe(640_000n);
  });

  it('ranks strictly greater totals first — 300/200/200 gives ranks 1, 2, 2 of 3', async () => {
    const ledger = {
      journals: [
        journal('j1', 'royalty_ingest', 'r1', 1),
        journal('j2', 'royalty_ingest', 'r2', 2),
        journal('j3', 'royalty_ingest', 'r3', 3),
      ],
      entries: [
        entry('j1', 'vault:payeeA:royalty', 300_000),
        entry('j2', 'vault:payeeB:royalty', 200_000),
        entry('j3', 'vault:payeeC:royalty', 200_000),
      ],
      runs: { r1: run('r1', 'Studio A'), r2: run('r2', 'Studio B'), r3: run('r3', 'Studio C') },
      lineItems: [
        lineItem('r1', 'TPL-FLM-001'),
        lineItem('r2', 'TPL-FLM-002'),
        lineItem('r3', 'TPL-FLM-003'),
      ],
    };

    expect((await entityIntelligence('TPL-FLM-001', fakeStore(ledger)))?.cohort).toEqual({
      rank: 1n,
      of: 3n,
    });
    expect((await entityIntelligence('TPL-FLM-002', fakeStore(ledger)))?.cohort).toEqual({
      rank: 2n,
      of: 3n,
    });
    expect((await entityIntelligence('TPL-FLM-003', fakeStore(ledger)))?.cohort).toEqual({
      rank: 2n,
      of: 3n,
    });
  });

  it('keeps the cohort inside the atomic class — the tournament never leaks into the athlete cohort', async () => {
    const ledger = {
      journals: [
        journal('j1', 'royalty_ingest', 'r1', 1), // the athlete contract of record
        journal('j2', 'royalty_ingest', 'r2', 2), // the tournament purse of record
      ],
      entries: [
        entry('j1', 'vault:payeeA:royalty', 240_000),
        entry('j2', 'vault:payeeB:royalty', 1_250_000),
      ],
      runs: { r1: run('r1', 'Nike'), r2: run('r2', 'PGA Tour') },
      lineItems: [lineItem('r1', 'TPL-SPT-001'), lineItem('r2', 'TPL-TRN-001')],
    };

    // Both share the SPORTS industry tag but not the atomic class: each is
    // alone in its own cohort — rank 1 of 1, stated plainly — despite the
    // tournament having cleared strictly more.
    const athlete = await entityIntelligence('TPL-SPT-001', fakeStore(ledger));
    const tournament = await entityIntelligence('TPL-TRN-001', fakeStore(ledger));

    expect(athlete?.class).toBe('ATHLETE_CONTRACT');
    expect(athlete?.cohort).toEqual({ rank: 1n, of: 1n });
    expect(tournament?.class).toBe('TOURNAMENT_EVENT');
    expect(tournament?.cohort).toEqual({ rank: 1n, of: 1n });
  });
});

describe('entityIntelligence — the per-class promised mapping and the honest nulls', () => {
  const CASES = [
    ['TPL-FLM-001', 'FEATURE_FILM', 4_250_000n],
    ['TPL-TV-001', 'LINEAR_TV', null],
    ['TPL-MUS-001', 'MASTER_RECORDING', null],
    ['TPL-PDC-001', 'PODCAST_NETWORK', null],
    ['TPL-LVE-001', 'STAGE_PERFORMANCE', null],
    ['TPL-PUB-001', 'LITERARY_WORK', null],
    ['TPL-SPT-001', 'ATHLETE_CONTRACT', 2_400_000n],
    ['TPL-TRN-001', 'TOURNAMENT_EVENT', 12_500_000n],
    ['TPL-ESX-001', 'ESPORTS_STREAM', 86_400n],
    ['TPL-SOC-001', 'SOCIAL_CHANNEL', null],
    ['TPL-SPN-001', 'SPONSORSHIP_DEAL', 950_000n],
  ] as const;

  it('maps every registered class to its canon promised field — or states the honest null', async () => {
    const emptyStore = fakeStore({ journals: [], entries: [], runs: {} });

    for (const [templateId, expectedClass, promised] of CASES) {
      const readout = await entityIntelligence(templateId, emptyStore);
      expect(readout, templateId).not.toBeNull();
      if (readout === null) throw new Error(`readout unexpectedly null for ${templateId}`);
      expect(readout.class, templateId).toBe(expectedClass);
      expect(readout.promisedUSD, templateId).toEqual(promised);
      // Every registered class has an arm — the runtime mirror of the
      // compile-time exhaustiveness pin.
      expect(readout.cleared, templateId).toBe(0n);
      expect(readout.trend, templateId).toEqual([]);
    }
  });

  it('reads the sponsorship deal value from the canon dealValueUSD field', async () => {
    const readout = await entityIntelligence(
      'TPL-SPN-001',
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 95_000_000)],
        runs: { r1: run('r1', 'Acme Brands') },
        lineItems: [lineItem('r1', 'TPL-SPN-001')],
      }),
    );

    expect(readout).not.toBeNull();
    if (readout === null) throw new Error('readout unexpectedly null');
    expect(readout.class).toBe('SPONSORSHIP_DEAL');
    expect(readout.promisedUSD).toBe(950_000n);
    expect(readout.cleared).toBe(95_000_000n);
  });

  it('renders entity-level counterparty facts on the sponsorship profile — where they belong', async () => {
    const readout = await entityIntelligence(
      'TPL-SPN-001',
      fakeStore({ journals: [], entries: [], runs: {} }),
    );

    expect(readout).not.toBeNull();
    if (readout === null || readout.class !== 'SPONSORSHIP_DEAL') {
      throw new Error('readout unexpectedly missing or wrong class');
    }
    // The brand partner is the entity record's own canon field — entity
    // level renders it; the platform cuts stay brand-free (their pinned
    // exclusion test is untouched).
    expect(readout.brandPartner).toBe('Nike');
    expect(readout.campaignId).toBe('SPN-2026-40');
  });
});

describe('entityIntelligence — promised vs. cleared', () => {
  it('subtracts exactly in bigint once the units align — the consumer comparison', async () => {
    const readout = await entityIntelligence(
      'TPL-SPT-001',
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 125_000_000)],
        runs: { r1: run('r1', 'Nike') },
        lineItems: [lineItem('r1', 'TPL-SPT-001')],
      }),
    );

    expect(readout).not.toBeNull();
    if (readout === null || readout.class !== 'ATHLETE_CONTRACT') {
      throw new Error('readout unexpectedly missing or wrong class');
    }
    expect(readout.class).toBe('ATHLETE_CONTRACT');
    // promisedUSD is whole USD (the canon guarantee, 2,400,000); cleared is
    // integer cents (the ledger's unit, 1,250,000.00). The comparison is
    // bigint end to end once the display units align — no float anywhere.
    expect(readout.promisedUSD).toBe(2_400_000n);
    expect(readout.cleared).toBe(125_000_000n);
    expect(readout.promisedUSD * 100n - readout.cleared).toBe(115_000_000n);
  });

  it('sums in exact integer cents (bigint) — totals past the float-safe range stay exact', async () => {
    const readout = await entityIntelligence(
      'TPL-FLM-001',
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1),
          journal('j2', 'royalty_ingest', 'r2', 2),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 9_000_000_000_000_000),
          entry('j2', 'vault:payeeA:royalty', 9_000_000_000_000_000),
        ],
        runs: { r1: run('r1', 'Studio A'), r2: run('r2', 'Studio A') },
        lineItems: [lineItem('r1', 'TPL-FLM-001'), lineItem('r2', 'TPL-FLM-001')],
      }),
    );

    // 18,000,000,000,000,000 exceeds Number.MAX_SAFE_INTEGER — the bigint sum is exact.
    expect(readout?.cleared).toBe(18_000_000_000_000_000n);
  });
});

describe('entityIntelligence — the cleared-flow trend', () => {
  it('groups the entity journal credits by their own timestamps, newest point first', async () => {
    const readout = await entityIntelligence(
      'TPL-ESX-001',
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1, '2026-09-01T10:00:00.000Z'),
          journal('j2', 'royalty_ingest', 'r2', 2, '2026-09-02T10:00:00.000Z'),
          journal('j3', 'royalty_ingest', 'r3', 3, '2026-09-02T10:00:00.000Z'),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 10_000),
          entry('j2', 'vault:payeeB:royalty', 20_000),
          entry('j3', 'vault:payeeC:royalty', 5_000),
        ],
        runs: { r1: run('r1', 'Twitch'), r2: run('r2', 'Twitch'), r3: run('r3', 'Twitch') },
        lineItems: [
          lineItem('r1', 'TPL-ESX-001'),
          lineItem('r2', 'TPL-ESX-001'),
          lineItem('r3', 'TPL-ESX-001'),
        ],
      }),
    );

    expect(readout).not.toBeNull();
    if (readout === null) throw new Error('readout unexpectedly null');
    // Two journals share the Sep 2 timestamp — grouped into one point.
    // The window is rendered as the journals carry it, newest first.
    expect(readout.class).toBe('ESPORTS_STREAM');
    expect(readout.trend).toEqual([
      { at: '2026-09-02T10:00:00.000Z', credit: 25_000n },
      { at: '2026-09-01T10:00:00.000Z', credit: 10_000n },
    ]);
    expect(readout.cleared).toBe(35_000n);
  });
});

describe('entityIntelligence — the exclusions the readout shares with the platform cuts', () => {
  it('excludes the platform dust vault, debit legs, non-vault legs, non-royalty journals, and unresolvable runs', async () => {
    const readout = await entityIntelligence(
      'TPL-MUS-001',
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1), // counts
          journal('j2', 'payout_transfer', 'r2', 2), // not a royalty ingest
          journal('j3', 'royalty_ingest', 'r-missing', 3), // run no longer resolves
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 50_000),
          // The platform's corner dust credit on the same journal — company money.
          entry('j1', 'vault:platform:dust', 500),
          // Debit and non-vault legs — never counted.
          debitEntry('j1', 'vault:payeeA:pending', 50_000),
          entry('j1', 'revenue:spotify', 50_000),
          // Holder credits on an unresolvable run and a non-royalty journal.
          entry('j3', 'vault:payeeA:royalty', 99_000),
          entry('j2', 'vault:payeeA:royalty', 88_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Payouts') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
      }),
    );

    expect(readout?.cleared).toBe(50_000n);
    expect(readout?.trend).toEqual([
      { at: '2026-09-22T00:00:00.000Z', credit: 50_000n },
    ]);
  });

  it('attributes nothing for a mixed run — the entity profile is never force-fitted', async () => {
    const readout = await entityIntelligence(
      'TPL-MUS-001',
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Mixed') },
        lineItems: [lineItem('r1', 'TPL-MUS-001'), lineItem('r1', 'TPL-SPT-001')],
      }),
    );

    // The run's line items disagree on the bound entity — the money counts
    // toward no profile, and the music profile renders its honest zero.
    expect(readout?.cleared).toBe(0n);
    expect(readout?.trend).toEqual([]);
  });

  it('attributes nothing for a run with no line items', async () => {
    const readout = await entityIntelligence(
      'TPL-MUS-001',
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [],
      }),
    );

    expect(readout?.cleared).toBe(0n);
  });
});

describe('entityIntelligence — the honest states', () => {
  it('renders a never-cleared entity as its profile, a zero cleared total, an empty trend, and rank 1 of 1', async () => {
    const readout = await entityIntelligence(
      'TPL-SPT-001',
      fakeStore({ journals: [], entries: [], runs: {} }),
    );

    expect(readout).not.toBeNull();
    if (readout === null || readout.class !== 'ATHLETE_CONTRACT') {
      throw new Error('readout unexpectedly missing or wrong class');
    }
    // The zero-literal honesty pin, behaviorally: an empty ledger yields
    // exactly 0n — the derivation invents no cleared value.
    expect(readout.cleared).toBe(0n);
    expect(readout.trend).toEqual([]);
    expect(readout.cohort).toEqual({ rank: 1n, of: 1n });
    expect(readout.promisedUSD).toBe(2_400_000n);
    expect(readout.sport).toBe('Basketball');
    expect(readout.contractId).toBe('NK-404-BAL');
  });

  it('returns null for a reference that binds no entity — never a force-fitted profile', async () => {
    const readout = await entityIntelligence(
      'not-a-bound-reference',
      fakeStore({ journals: [], entries: [], runs: {} }),
    );

    expect(readout).toBeNull();
  });

  it('returns null when the store read fails — the fail-closed unavailable state', async () => {
    const readout = await entityIntelligence(
      'TPL-MUS-001',
      fakeStore({ journals: [], entries: [], runs: {}, failure: 'journals' }),
    );

    expect(readout).toBeNull();
  });

  it('returns null when the line-item read fails — the join is part of the read', async () => {
    const readout = await entityIntelligence(
      'TPL-MUS-001',
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
        failure: 'lineItems',
      }),
    );

    expect(readout).toBeNull();
  });
});
