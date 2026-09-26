/**
 * platformAnalyticsFlows — the generation-4 analytics derivation's unit
 * suite (flow-kind rework per the 2026-09-22 founder directive). Pinned
 * against a fake store over the REAL record shapes (GlJournalRecord /
 * GlEntryRecord from src/modules/don/records.ts, SplitRunRecord /
 * RoyaltyLineItemRecord from src/lib/don/types.ts) with the REAL entity
 * resolver: the by-industry cut joins each journal's split-run line items
 * to their bound atomic entity class (music journals → MUSIC,
 * athlete-contract journals → SPORTS), the by-flow-kind cut groups the
 * same vault-credit legs by the registered structural economic kind of
 * the underlying asset (athlete contracts → BRAND_PARTNERSHIP,
 * tournament events → PRIZE_PURSE — the entity TYPES, never the
 * counterparty source string), and the by-transaction-type cut groups by
 * the journal kind of record. The platform dust vault, debit and
 * non-vault legs, non-royalty journals, and unresolvable runs contribute
 * nothing — store-read integer-cent math (bigint), nothing invented, no
 * counterparty or brand string anywhere in a cut.
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
    // The money is still real: the transaction-type cut keeps it.
    expect(flows.byTransactionType.state).toBe('ready');
    expect(flows.byTransactionType.rows).toEqual([
      { label: 'royalty_ingest', totalCents: 50_000n },
    ]);
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

describe('platformAnalyticsFlows — the by-flow-kind cut', () => {
  it('maps each bound entity type to its registered flow kind — athlete contracts to Brand Partnership', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1), // the athlete contract of record
          journal('j2', 'royalty_ingest', 'r2', 2), // the sponsorship deal of record
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 240_000_000),
          entry('j2', 'vault:payeeB:royalty', 95_000_000),
        ],
        runs: { r1: run('r1', 'Nike'), r2: run('r2', 'Acme Brands') },
        lineItems: [lineItem('r1', 'TPL-SPT-001'), lineItem('r2', 'TPL-SPN-001')],
      }),
    );

    // Both forms settle as the ONE structural row — the counterparty never
    // appears; the source strings are not the grouping key.
    expect(flows.byFlowKind.state).toBe('ready');
    expect(flows.byFlowKind.rows).toEqual([
      { label: 'BRAND_PARTNERSHIP', totalCents: 335_000_000n },
    ]);
    // The two brand forms stay SPORTS / SPONSORSHIP in the industry cut —
    // the flow-kind cut is a different structural view, not a duplicate.
    expect(flows.byIndustry.rows).toEqual([
      { label: 'SPORTS', totalCents: 240_000_000n },
      { label: 'SPONSORSHIP', totalCents: 95_000_000n },
    ]);
  });

  it('keeps the athlete-contract and tournament-event flow kinds distinct — the entity TYPE decides', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1), // the tournament purse of record
          journal('j2', 'royalty_ingest', 'r2', 2), // the athlete contract of record
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 1_250_000_000),
          entry('j2', 'vault:payeeB:royalty', 240_000_000),
        ],
        runs: { r1: run('r1', 'PGA Tour'), r2: run('r2', 'Nike') },
        lineItems: [lineItem('r1', 'TPL-TRN-001'), lineItem('r2', 'TPL-SPT-001')],
      }),
    );

    // One SPORTS industry row would collapse these two; the flow-kind cut
    // keeps the purse and the brand money structurally distinct.
    expect(flows.byIndustry.rows).toEqual([
      { label: 'SPORTS', totalCents: 1_490_000_000n },
    ]);
    expect(flows.byFlowKind.rows).toEqual([
      { label: 'PRIZE_PURSE', totalCents: 1_250_000_000n },
      { label: 'BRAND_PARTNERSHIP', totalCents: 240_000_000n },
    ]);
  });

  it('maps the rights-holding classes to Royalty Distribution and the creator-yield classes to Platform Content Monetization', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1), // the music entity of record
          journal('j2', 'royalty_ingest', 'r2', 2), // the esports stream of record
          journal('j3', 'royalty_ingest', 'r3', 3), // the social channel of record
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 833_333_333_336),
          entry('j2', 'vault:payeeB:royalty', 8_640_000),
          entry('j3', 'vault:payeeC:royalty', 1_200_000),
        ],
        runs: {
          r1: run('r1', 'Spotify'),
          r2: run('r2', 'Twitch'),
          r3: run('r3', 'TikTok'),
        },
        lineItems: [
          lineItem('r1', 'TPL-MUS-001'),
          lineItem('r2', 'TPL-ESX-001'),
          lineItem('r3', 'TPL-SOC-001'),
        ],
      }),
    );

    expect(flows.byFlowKind.rows).toEqual([
      { label: 'ROYALTY_DISTRIBUTION', totalCents: 833_333_333_336n },
      { label: 'PLATFORM_CONTENT_MONETIZATION', totalCents: 9_840_000n },
    ]);
  });

  it('carries no counterparty or brand string from the run sources — the structural kinds only', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [
          journal('j1', 'royalty_ingest', 'r1', 1),
          journal('j2', 'royalty_ingest', 'r2', 2),
        ],
        entries: [
          entry('j1', 'vault:payeeA:royalty', 240_000_000),
          entry('j2', 'vault:payeeB:royalty', 1_250_000_000),
        ],
        runs: { r1: run('r1', 'Nike'), r2: run('r2', 'PGA Tour') },
        lineItems: [lineItem('r1', 'TPL-SPT-001'), lineItem('r2', 'TPL-TRN-001')],
      }),
    );

    for (const cut of [flows.byIndustry, flows.byFlowKind, flows.byTransactionType]) {
      for (const row of cut.rows) {
        expect(row.label).not.toBe('Nike');
        expect(row.label).not.toBe('PGA Tour');
      }
    }
  });

  it('contributes no flow-kind row for an unresolvable run — the money stays in the transaction-type cut', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Spotify') },
        lineItems: [lineItem('r1', 'not-a-bound-reference')],
      }),
    );

    expect(flows.byFlowKind.state).toBe('empty');
    expect(flows.byTransactionType.rows).toEqual([
      { label: 'royalty_ingest', totalCents: 50_000n },
    ]);
  });

  it('contributes no flow-kind row for a run whose line items disagree on the kind', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({
        journals: [journal('j1', 'royalty_ingest', 'r1', 1)],
        entries: [entry('j1', 'vault:payeeA:royalty', 50_000)],
        runs: { r1: run('r1', 'Mixed') },
        lineItems: [lineItem('r1', 'TPL-SPT-001'), lineItem('r1', 'TPL-TRN-001')],
      }),
    );

    // The two SPORTS forms share an industry tag but disagree on the flow
    // kind — the mixed run is never force-fitted to one kind.
    expect(flows.byFlowKind.state).toBe('empty');
  });
});

describe('platformAnalyticsFlows — the by-transaction-type cut', () => {
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
    expect(flows.byFlowKind.rows).toEqual([
      { label: 'ROYALTY_DISTRIBUTION', totalCents: 50_000n },
    ]);
    // The kind is the journal's own record — no run resolution required —
    // so the unresolvable run's real holder credit still counts here:
    // 50,000 (r1) + 99,000 (r3) = 149,000. The structural cuts need the
    // asset binding; the transaction-type cut never force-fits, never hides.
    expect(flows.byTransactionType.rows).toEqual([
      { label: 'royalty_ingest', totalCents: 149_000n },
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
    expect(flows.byFlowKind.rows).toEqual([
      { label: 'ROYALTY_DISTRIBUTION', totalCents: 18_000_000_000_000_000n },
    ]);
  });
});

describe('platformAnalyticsFlows — the honest states', () => {
  it('reports all three cuts empty on an empty ledger', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({ journals: [], entries: [], runs: {} }),
    );

    expect(flows.byIndustry).toEqual({ state: 'empty', rows: [] });
    expect(flows.byFlowKind).toEqual({ state: 'empty', rows: [] });
    expect(flows.byTransactionType).toEqual({ state: 'empty', rows: [] });
  });

  it('reports all three cuts unavailable when the store read fails', async () => {
    const flows = await platformAnalyticsFlows(
      fakeStore({ journals: [], entries: [], runs: {}, failure: 'journals' }),
    );

    expect(flows.byIndustry).toEqual({ state: 'unavailable', rows: [] });
    expect(flows.byFlowKind).toEqual({ state: 'unavailable', rows: [] });
    expect(flows.byTransactionType).toEqual({ state: 'unavailable', rows: [] });
  });

  it('fails the industry and flow-kind cuts alone when their line-item read fails — the transaction-type cut stays ready', async () => {
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
    expect(flows.byFlowKind).toEqual({ state: 'unavailable', rows: [] });
    expect(flows.byTransactionType.state).toBe('ready');
  });
});
