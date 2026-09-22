/**
 * Platform analytics flows — the operator's three views over the one
 * clearing ledger (generation-4 spec, 2026-09-22): gross royalty inflow
 * grouped BY INDUSTRY (the bound atomic entity class of the underlying
 * asset), BY SOURCE (the split run's source of record), and BY
 * TRANSACTION TYPE (the journal kind of record).
 *
 * Same derivation family as `revenueStreams.ts`, generalized across every
 * payee and every entity class: every `royalty_ingest` journal's
 * vault-credit legs across ALL payees, the platform dust vault excluded
 * (company money, not rights-holder inflow), split runs resolved before
 * they count, integer-cent math throughout (bigint accumulation — the
 * cents never touch a float), every grouping sorted descending.
 *
 * Honesty law, per cut: an industry row is never force-fitted — a journal
 * whose split run resolves to no bound entity class contributes to the
 * source and transaction-type cuts but no industry row; a cut with no
 * rows reports `empty`; a store read that fails reports `unavailable`.
 * Nothing invented, nothing averaged, no fabricated totals.
 */

import type { AtomicEntityClassTag } from '@/lib/master/CovnantAtomicDataSDK';
import { entityClassForWorkRef } from '@/lib/master/masterStore';
import type { SplitRunRecord } from '@/lib/don/types';
import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type { Store } from '@/lib/server/store';

/** Any rights holder's vault account — `vault:<payeeId>:…` — except the platform's own dust vault. */
function isHolderVaultCredit(entry: GlEntryRecord): boolean {
  return (
    entry.account.startsWith('vault:') &&
    !entry.account.startsWith('vault:platform:') &&
    entry.credit_cents > 0
  );
}

/** A single grouped row — integer cents, exact (bigint, never a float). */
export interface AnalyticsFlowRow {
  readonly label: string;
  readonly totalCents: bigint;
}

/** Per-cut state: ready rows, an honest empty, or an unavailable read. */
export type AnalyticsCutState = 'empty' | 'ready' | 'unavailable';

export interface AnalyticsCut {
  readonly state: AnalyticsCutState;
  readonly rows: readonly AnalyticsFlowRow[];
}

export interface PlatformAnalyticsFlows {
  readonly byIndustry: AnalyticsCut;
  readonly bySource: AnalyticsCut;
  readonly byTransactionType: AnalyticsCut;
}

/** The royalty journals of record and their per-journal entry groups and split runs. */
interface RoyaltyFlowScan {
  readonly journals: readonly GlJournalRecord[];
  readonly entriesByJournal: ReadonlyMap<string, readonly GlEntryRecord[]>;
  readonly runOf: ReadonlyMap<string, SplitRunRecord | undefined>;
}

async function scanRoyaltyFlows(store: Store): Promise<RoyaltyFlowScan> {
  const journals = (await store.listGlJournals()).filter(
    (journal) => journal.kind === 'royalty_ingest',
  );
  const entriesByJournal = new Map<string, GlEntryRecord[]>();
  for (const entry of await store.listGlEntries()) {
    const group = entriesByJournal.get(entry.journal_id);
    if (group !== undefined) group.push(entry);
    else entriesByJournal.set(entry.journal_id, [entry]);
  }
  const runOf = new Map<string, SplitRunRecord | undefined>();
  for (const journal of journals) {
    if (journal.ref_type !== 'split_run' || journal.ref_id === null) continue;
    runOf.set(journal.id, await store.getSplitRun(journal.ref_id));
  }
  return { journals, entriesByJournal, runOf };
}

/** The journal's holder-side vault-credit sum — the measure every cut groups. */
function holderCreditOf(entries: readonly GlEntryRecord[] | undefined): bigint {
  let holderCredit = 0n;
  for (const entry of entries ?? []) {
    if (isHolderVaultCredit(entry)) holderCredit += BigInt(entry.credit_cents);
  }
  return holderCredit;
}

/** Group and sort a cut — descending by total, label as the deterministic tie-break. */
function cutFrom(totals: ReadonlyMap<string, bigint>): AnalyticsCut {
  if (totals.size === 0) return { state: 'empty', rows: [] };
  const rows = [...totals.entries()]
    .map(([label, totalCents]) => ({ label, totalCents }))
    .sort((a, b) =>
      a.totalCents > b.totalCents ? -1 : a.totalCents < b.totalCents ? 1 : a.label.localeCompare(b.label),
    );
  return { state: 'ready', rows };
}

function unavailableCut(): AnalyticsCut {
  return { state: 'unavailable', rows: [] };
}

/**
 * The entity class of record of a split run — resolved when EVERY line
 * item of the run resolves and they all agree on one class (the
 * settlement shape of record: one asset per run). A run whose line items
 * resolve to nothing or disagree contributes no industry row — its money
 * stays in the source and transaction-type cuts, never misattributed.
 */
async function industryOfClass(
  store: Store,
  run: SplitRunRecord,
): Promise<AtomicEntityClassTag | null> {
  const lineItems = await store.listRoyaltyLineItemsByRun(run.id);
  if (lineItems.length === 0) return null;
  let industry: AtomicEntityClassTag | null = null;
  for (const lineItem of lineItems) {
    const boundClass = entityClassForWorkRef(lineItem.work_id);
    if (boundClass === null) return null;
    if (industry === null) industry = boundClass;
    else if (industry !== boundClass) return null;
  }
  return industry;
}

/** The by-industry cut — the line items' bound entity classes, holder credits attributed. */
async function industryTotals(store: Store, scan: RoyaltyFlowScan): Promise<Map<string, bigint>> {
  const totals = new Map<string, bigint>();
  for (const journal of scan.journals) {
    const run = scan.runOf.get(journal.id);
    if (run === undefined) continue;
    const holderCredit = holderCreditOf(scan.entriesByJournal.get(journal.id));
    if (holderCredit <= 0n) continue;
    const industry = await industryOfClass(store, run);
    if (industry === null) continue;
    totals.set(industry, (totals.get(industry) ?? 0n) + holderCredit);
  }
  return totals;
}

/**
 * The platform analytics derivation — the three cuts over the one ledger.
 * Never throws: a store failure degrades to the honest per-cut
 * `unavailable` state (the /admin page's own safe read is the second
 * layer, for failures upstream of this module).
 */
export async function platformAnalyticsFlows(store: Store): Promise<PlatformAnalyticsFlows> {
  let scan: RoyaltyFlowScan;
  try {
    scan = await scanRoyaltyFlows(store);
  } catch {
    return {
      byIndustry: unavailableCut(),
      bySource: unavailableCut(),
      byTransactionType: unavailableCut(),
    };
  }

  const bySource = new Map<string, bigint>();
  const byTransactionType = new Map<string, bigint>();
  for (const journal of scan.journals) {
    const holderCredit = holderCreditOf(scan.entriesByJournal.get(journal.id));
    if (holderCredit <= 0n) continue;
    const run = scan.runOf.get(journal.id);
    if (run === undefined) continue;
    bySource.set(run.source, (bySource.get(run.source) ?? 0n) + holderCredit);
    byTransactionType.set(
      journal.kind,
      (byTransactionType.get(journal.kind) ?? 0n) + holderCredit,
    );
  }

  // The industry cut fails alone: its extra join (the per-run line items
  // and the entity binding) is the only read the other two cuts don't need.
  let byIndustry: AnalyticsCut;
  try {
    byIndustry = cutFrom(await industryTotals(store, scan));
  } catch {
    byIndustry = unavailableCut();
  }

  return {
    byIndustry,
    bySource: cutFrom(bySource),
    byTransactionType: cutFrom(byTransactionType),
  };
}
