/**
 * platformRevenueStreams — the admin Overview's platform-wide revenue
 * derivation (founder directive 2026-09-22: the strip moved off the Gold
 * Board onto the admin Overview under Smart Ledger Verification).
 *
 * Pinned against a fake store over the REAL record shapes (GlJournalRecord,
 * GlEntryRecord from src/modules/don/records.ts, SplitRunRecord from
 * src/lib/don/types.ts): every royalty_ingest journal's vault-credit legs
 * across ALL payees group by the split run's source; the platform dust
 * vault (vault:platform:…) is company money, not a revenue stream, so it
 * is excluded; unresolvable split runs and non-royalty journals contribute
 * no row — store-read only, nothing invented.
 */
import { describe, expect, it } from 'vitest';

import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type { SplitRunRecord } from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import { platformRevenueStreams } from '../revenueStreams';

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

/** Minimal store — the derivation touches exactly these three reads. */
function fakeStore(
  journals: GlJournalRecord[],
  entries: GlEntryRecord[],
  runs: Record<string, SplitRunRecord | undefined>,
): Store {
  return {
    listGlJournals: async () => journals,
    listGlEntries: async () => entries,
    getSplitRun: async (id: string) => runs[id],
  } as unknown as Store;
}

describe('platformRevenueStreams', () => {
  it('aggregates vault-credit legs across ALL payees by split-run source, descending', async () => {
    const store = fakeStore(
      [
        journal('j1', 'royalty_ingest', 'r1', 1), // Spotify, payee A
        journal('j2', 'royalty_ingest', 'r2', 2), // Spotify, payee B
        journal('j3', 'royalty_ingest', 'r3', 3), // Bandcamp, payee A
      ],
      [
        entry('j1', 'vault:payeeA:royalty', 50_000),
        entry('j2', 'vault:payeeB:royalty', 75_000),
        entry('j3', 'vault:payeeA:royalty', 10_000),
        // Debit legs of the same journals — never counted.
        entry('j1', 'revenue:spotify', 50_000),
        entry('j3', 'revenue:bandcamp', 10_000),
      ],
      { r1: run('r1', 'Spotify'), r2: run('r2', 'Spotify'), r3: run('r3', 'Bandcamp') },
    );

    const streams = await platformRevenueStreams(store);
    expect(streams).toEqual([
      { source: 'Spotify', total_cents: 125_000 },
      { source: 'Bandcamp', total_cents: 10_000 },
    ]);
  });

  it('excludes the platform dust vault — company money is not a revenue stream', async () => {
    const store = fakeStore(
      [journal('j1', 'royalty_ingest', 'r1', 1)],
      [
        entry('j1', 'vault:payeeA:royalty', 50_000),
        // The platform's corner dust credit on the same journal — excluded.
        entry('j1', 'vault:platform:dust', 500),
      ],
      { r1: run('r1', 'Spotify') },
    );

    const streams = await platformRevenueStreams(store);
    expect(streams).toEqual([{ source: 'Spotify', total_cents: 50_000 }]);
  });

  it('contributes no row for an unresolvable split run or a non-royalty journal', async () => {
    const store = fakeStore(
      [
        journal('j1', 'royalty_ingest', 'r-missing', 1), // run no longer resolves
        journal('j2', 'payout_transfer', 'r2', 2), // not a royalty ingest
        journal('j3', 'royalty_ingest', 'r3', 3), // counts
      ],
      [
        entry('j1', 'vault:payeeA:royalty', 99_000),
        entry('j2', 'vault:payeeA:royalty', 88_000),
        entry('j3', 'vault:payeeB:royalty', 25_000),
      ],
      { 'r-missing': undefined, r3: run('r3', 'YouTube Music') },
    );

    const streams = await platformRevenueStreams(store);
    expect(streams).toEqual([{ source: 'YouTube Music', total_cents: 25_000 }]);
  });

  it('returns an empty array over an empty ledger — honest empty state upstream', async () => {
    const store = fakeStore([], [], {});
    expect(await platformRevenueStreams(store)).toEqual([]);
  });
});
