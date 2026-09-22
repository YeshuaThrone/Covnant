/**
 * platformAnalyticsFlows — the generation-4 analytics derivation's unit
 * suite. Pinned against a fake store over the REAL record shapes
 * (GlJournalRecord / GlEntryRecord from src/modules/don/records.ts,
 * SplitRunRecord / RoyaltyLineItemRecord from src/lib/don/types.ts) with
 * the REAL entity resolver: the by-industry cut joins each journal's
 * split-run line items to their bound atomic entity class (music
 * journals → MUSIC, athlete-contract journals → SPORTS), the by-source
 * cut groups the same vault-credit legs by the run's source of record,
 * the by-transaction-type cut groups by the journal kind of record. The
 * platform dust vault, debit and non-vault legs, non-royalty journals,
 * and unresolvable runs contribute nothing — store-read integer-cent
 * math (bigint), nothing invented.
 */
import { describe, expect, it } from 'vitest';

import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type { RoyaltyLineItemRecord, SplitRunRecord } from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import { platformAnalyticsFlows } from '../analyticsFlows';

const JOURNAL_BASE = {
  ref_type: 'split_run',
  created_at: '2026-09-22T00:00:00.000Z',
  prev_hash: '0x0',
  entry_hash: '0x0',
  state: 'posted' as const,
};

function journal(id: string, kind: string, refId: string, sequence: number): GlJournalRecord {
  return { id, kind, ref_id: refId, sequence, ...JOURNAL_BASE };
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

describe('platformAnalyticsFlows — the by-industry cut', () => {
  it('resolves music journals to MUSIC and athlete-contract journals to SPORTS', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1), // the music entity of record
          journal('j2', 'royalty_ingest', 'r2', 2), // the athlete contract of record
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 100_000),
          entry('j2', 'vault:payeeB:royalty', 240_000_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Nike') },
        lineItems: [lineItem('r1', 'TPL-MUS-001'), lineItem('r2', 'TPL-SPT-001')],
      }),
    );

    expect(flows.byIndustry.state).toBe('ready');
    expect(flows.byIndustry.rows).toEqual([
      { label: 'SPORTS', totalCents: 240_000_000n },
      { label: 'MUSIC', totalCents: 100_000n },
    ]);
  });

  it('resolves the demo CBT form through the sector binding of record', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'CBT-TRK-A51DF05B4279')],
      }),
    );

    expect(flows.byIndustry.state).toBe('ready');
    expect(flows.byIndustry.rows).toEqual([{ label: 'MUSIC', totalCents: 50_000n }]);
  });

  it('contributes no industry row for an unresolvable work reference — never force-fitted', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'not-a-bound-reference')],
      }),
    );

    expect(flows.byIndustry.state).toBe('empty');
    // The money is still real: the other cuts keep it.
    expect(flows.bySource.state).toBe('ready');
    expect(flows.bySource.rows).toEqual([{ label: 'Spotify', totalCents: 50_000n }]);
  });

  it('contributes no industry row for a run with no line items', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [],
      }),
    );

    expect(flows.byIndustry.state).toBe('empty');
  });

  it('contributes no industry row for a run whose line items disagree on the class', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001'), lineItem('r1', 'TPL-SPT-001')],
      }),
    );

    expect(flows.byIndustry.state).toBe('empty');
  });
});

describe('platformAnalyticsFlows — the by-source and by-transaction-type cuts', () => {
  it('groups holder-credit legs by split-run source, descending', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1),
          journal('j2', 'royalty_ingest', 'r2', 2),
          journal('j3', 'royalty_ingest', 'r3', 3),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 50_000),
          entry('j2', 'vault:payeeB:royalty', 75_000),
          entry('j3', 'vault:payeeA:royalty', 10_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Spotify'), r3: run('r3', 'Bandcamp') },
        lineItems: [
          lineItem('r1', 'TPL-MUS-001'),
          lineItem('r2', 'TPL-MUS-001'),
          lineItem('r3', 'TPL-MUS-001'),
        ],
      }),
    );

    expect(flows.bySource.state).toBe('ready');
    expect(flows.bySource.rows).toEqual([
      { label: 'Spotify', totalCents: 125_000n },
      { label: 'Bandcamp', totalCents: 10_000n },
    ]);
  });

  it('labels the transaction-type cut with the journal kind of record', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
      }),
    );

    expect(flows.byTransactionType.state).toBe('ready');
    expect(flows.byTransactionType.rows).toEqual([
      { label: 'royalty_ingest', totalCents: 50_000n },
    ]);
  });
});

describe('platformAnalyticsFlows — the exclusions every cut shares', () => {
  it('excludes the platform dust vault, debit legs, non-vault legs, non-royalty journals, and unresolvable runs', async () => {
    const flows = await platformAnalyticsFlows(
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
          // A holder credit on an unresolvable run — no row, nothing invented.
          entry('j3', 'vault:payeeA:royalty', 99_000),
          // A holder credit on a non-royalty journal — no row either.
          entry('j2', 'vault:payeeA:royalty', 88_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Payouts') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
      }),
    );

    expect(flows.byIndustry.rows).toEqual([{ label: 'MUSIC', totalCents: 50_000n }]);
    expect(flows.bySource.rows).toEqual([{ label: 'Spotify', totalCents: 50_000n }]);
    expect(flows.byTransactionType.rows).toEqual([
      { label: 'royalty_ingest', totalCents: 50_000n },
    ]);
  });

  it('sums in exact integer cents (bigint) — totals past the float-safe range stay exact', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1),
          journal('j2', 'royalty_ingest', 'r2', 2),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 9_000_000_000_000_000),
          entry('j2', 'vault:payeeA:royalty', 9_000_000_000_000_000),
        ],
        runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001'), lineItem('r2', 'TPL-MUS-001')],
      }),
    );

    // 18,000,000,000,000,000 exceeds Number.MAX_SAFE_INTEGER — the bigint sum is exact.
    expect(flows.bySource.rows).toEqual([
      { label: 'Spotify', totalCents: 18_000_000_000_000_000n },
    ]);
  });
});

describe('platformAnalyticsFlows — the honest states', () => {
  it('reports all three cuts empty on an empty ledger', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({ journals: [], entries: [], runs: {} }),
    );

    expect(flows.byIndustry).toEqual({ state: 'empty', rows: [] });
    expect(flows.bySource).toEqual({ state: 'empty', rows: [] });
    expect(flows.byTransactionType).toEqual({ state: 'empty', rows: [] });
  });

  it('reports all three cuts unavailable when the store read fails', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({ journals: [], entries: [], runs: {}, failure: 'journals' }),
    );

    expect(flows.byIndustry).toEqual({ state: 'unavailable', rows: [] });
    expect(flows.bySource).toEqual({ state: 'unavailable', rows: [] });
    expect(flows.byTransactionType).toEqual({ state: 'unavailable', rows: [] });
  });

  it('fails the industry cut alone when its line-item read fails — the other cuts stay ready', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'TPL-MUS-001')],
        failure: 'lineItems',
      }),
    );

    expect(flows.byIndustry).toEqual({ state: 'unavailable', rows: [] });
    expect(flows.bySource.state).toBe('ready');
    expect(flows.byTransactionType.state).toBe('ready');
  });
});
