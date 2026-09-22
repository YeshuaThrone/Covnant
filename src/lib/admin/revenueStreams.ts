/**
 * Platform-wide revenue streams for the admin Overview — the operator's
 * mirror of the Gold Board strip (founder directive 2026-09-22: the
 * Revenue Streams strip moved OFF the Gold Board onto the admin Overview,
 * under Smart Ledger Verification).
 *
 * Same derivation as dashboardLive's holder-scoped aggregation, widened to
 * the whole platform: every `royalty_ingest` journal's vault-credit legs
 * across ALL payees, grouped by the journal's split run's source, sorted
 * descending, capped at the Gold Board's stream limit. Store-read only —
 * a journal whose split run no longer resolves contributes no row, a
 * journal with no vault-credit legs contributes nothing, nothing invented.
 *
 * The platform dust vault (payee `platform`) is EXCLUDED: the strip counts
 * royalty inflow to rights holders — the platform-wide form of the same
 * holder-facing semantics the Gold Board strip carried. The platform's
 * corner dust is company money, not a revenue stream from a source.
 */

import type { GoldBoardRevenueStream } from '../../../covnant-sdk/src/contracts/goldBoardUiSpec';
import { REVENUE_STREAM_LIMIT } from '../../../covnant-sdk/src/contracts/goldBoardUiSpec';
import type { GlEntryRecord } from '@/modules/don/records';
import type { Store } from '@/lib/server/store';

/** Any rights holder's vault account — `vault:<payeeId>:…` — except the platform's own dust vault. */
function isHolderVaultCredit(entry: GlEntryRecord): boolean {
  return (
    entry.account.startsWith('vault:') &&
    !entry.account.startsWith('vault:platform:') &&
    entry.credit_cents > 0
  );
}

export async function platformRevenueStreams(store: Store): Promise<GoldBoardRevenueStream[]> {
  const [journals, entries] = await Promise.all([store.listGlJournals(), store.listGlEntries()]);

  const entriesByJournal = new Map<string, GlEntryRecord[]>();
  for (const entry of entries) {
    const legs = entriesByJournal.get(entry.journal_id);
    if (legs) {
      legs.push(entry);
    } else {
      entriesByJournal.set(entry.journal_id, [entry]);
    }
  }

  const streamTotals = new Map<string, number>();
  for (const journal of journals) {
    if (journal.kind !== 'royalty_ingest') continue;
    const run = await store.getSplitRun(journal.ref_id);
    if (!run) continue;
    const holderCredit = (entriesByJournal.get(journal.id) ?? [])
      .filter(isHolderVaultCredit)
      .reduce((sum, entry) => sum + entry.credit_cents, 0);
    if (holderCredit <= 0) continue;
    streamTotals.set(run.source, (streamTotals.get(run.source) ?? 0) + holderCredit);
  }

  return [...streamTotals.entries()]
    .map(([source, total_cents]) => ({ source, total_cents }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, REVENUE_STREAM_LIMIT);
}
