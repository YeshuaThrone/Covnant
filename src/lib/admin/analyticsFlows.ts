/**
 * Platform analytics flows — the operator's three views over the one
 * clearing ledger (generation-4 spec, 2026-09-22; flow-kind rework per the
 * 2026-09-22 founder directive): gross royalty inflow grouped BY INDUSTRY
 * (the bound atomic entity class of the underlying asset), BY FLOW KIND
 * (the registered structural economic kind of the underlying asset — the
 * intelligence layer speaks structure, never counterparty names), and BY
 * TRANSACTION TYPE (the journal kind of record).
 *
 * Same derivation family as `revenueStreams.ts`, generalized across every
 * payee and every entity class: every `royalty_ingest` journal's
 * vault-credit legs across ALL payees, the platform dust vault excluded
 * (company money, not rights-holder inflow), split runs resolved before
 * they count, integer-cent math throughout (bigint accumulation — the
 * cents never touch a float), every grouping sorted descending.
 *
 * Honesty law, per cut: an industry or flow-kind row is never force-fitted
 * — a journal whose split run resolves to no bound entity contributes to
 * the transaction-type cut but no industry or flow-kind row; a cut with no
 * rows reports `empty`; a store read that fails reports `unavailable`.
 * Nothing invented, nothing averaged, no fabricated totals — and no
 * counterparty or brand string anywhere in a cut (those live on entity
 * cards and ledger drilldowns).
 */

import { flowKindForEntity, type FlowKind } from '@/lib/master/flowKinds';
import { entityClassTag, type SovereignAtomicEntity } from '@/lib/master/CovnantAtomicDataSDK';
import { entityRecordForWorkRef } from '@/lib/master/masterStore';
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
  readonly byFlowKind: AnalyticsCut;
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
 * The run's bound atomic entity records — resolved when EVERY line item
 * of the run resolves (the settlement shape of record: one asset per
 * run). A run whose line items resolve to nothing contributes no industry
 * or flow-kind row — its money stays in the transaction-type cut, never
 * misattributed.
 */
async function recordsOfRun(
  store: Store,
  run: SplitRunRecord,
): Promise<readonly SovereignAtomicEntity[] | null> {
  const lineItems = await store.listRoyaltyLineItemsByRun(run.id);
  if (lineItems.length === 0) return null;
  const records: SovereignAtomicEntity[] = [];
  for (const lineItem of lineItems) {
    const record = entityRecordForWorkRef(lineItem.work_id);
    if (record === null) return null;
    records.push(record);
  }
  return records;
}

/**
 * The unanimous structural view over a run's records — the view value
 * every record agrees on, or null when they disagree (a mixed run is
 * never force-fitted to one row).
 */
function unanimousView<T>(
  records: readonly SovereignAtomicEntity[],
  view: (record: SovereignAtomicEntity) => T,
): T | null {
  if (records.length === 0) return null;
  const first = view(records[0]);
  for (const record of records) {
    if (view(record) !== first) return null;
  }
  return first;
}

/** The by-industry and by-flow-kind cuts — the line-item join both share. */
async function structuralTotals(
  store: Store,
  scan: RoyaltyFlowScan,
): Promise<{ readonly byIndustry: Map<string, bigint>; readonly byFlowKind: Map<FlowKind, bigint> }> {
  const byIndustry = new Map<string, bigint>();
  const byFlowKind = new Map<FlowKind, bigint>();
  for (const journal of scan.journals) {
    const run = scan.runOf.get(journal.id);
    if (run === undefined) continue;
    const holderCredit = holderCreditOf(scan.entriesByJournal.get(journal.id));
    if (holderCredit <= 0n) continue;
    const records = await recordsOfRun(store, run);
    if (records === null) continue;
    const industry = unanimousView(records, entityClassTag);
    if (industry !== null) {
      byIndustry.set(industry, (byIndustry.get(industry) ?? 0n) + holderCredit);
    }
    const flowKind = unanimousView(records, flowKindForEntity);
    if (flowKind !== null) {
      byFlowKind.set(flowKind, (byFlowKind.get(flowKind) ?? 0n) + holderCredit);
    }
  }
  return { byIndustry, byFlowKind };
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
      byFlowKind: unavailableCut(),
      byTransactionType: unavailableCut(),
    };
  }

  const byTransactionType = new Map<string, bigint>();
  for (const journal of scan.journals) {
    const holderCredit = holderCreditOf(scan.entriesByJournal.get(journal.id));
    if (holderCredit <= 0n) continue;
    byTransactionType.set(
      journal.kind,
      (byTransactionType.get(journal.kind) ?? 0n) + holderCredit,
    );
  }

  // The industry and flow-kind cuts fail alone: their extra join (the
  // per-run line items and the entity binding) is the only read the
  // transaction-type cut doesn't need.
  let byIndustry: AnalyticsCut;
  let byFlowKind: AnalyticsCut;
  try {
    const structural = await structuralTotals(store, scan);
    byIndustry = cutFrom(structural.byIndustry);
    byFlowKind = cutFrom(structural.byFlowKind);
  } catch {
    byIndustry = unavailableCut();
    byFlowKind = unavailableCut();
  }

  return {
    byIndustry,
    byFlowKind,
    byTransactionType: cutFrom(byTransactionType),
  };
}
