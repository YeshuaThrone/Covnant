/**
 * Company analytics — the company-level readout over the one clearing
 * ledger (the Elite Dashboard spec, section 2). Where `entityIntelligence`
 * answers the questions a league asks about ONE cleared atomic entity and
 * `platformAnalyticsFlows` cuts the ledger three structural ways, this
 * module answers the COMPANY's own questions about the whole settlement
 * substrate:
 *
 *   1. KPIs — total cleared, the three canon sides of every run (creator
 *      paid 35%, operations yield 15%, company reserve 50%), run count,
 *      and the average run (the honest null at zero runs).
 *   2. Daily series — cleared volume grouped per day, gapless across the
 *      window: a day with no settlement is an honest zero point, never a
 *      hole for an area chart to interpolate across.
 *   3. Flow-kind split and industry totals — the structural cuts, the
 *      `analyticsFlows.ts` fail-closed unanimity carried over exactly.
 *   4. Entity leaderboard — per-entity window totals ranked by the
 *      `CohortRank` standard-competition rule (ties share a rank, the
 *      next rank vacant), each row carrying its momentum30 (the % delta
 *      vs the prior 30-day window, null when no prior point), its
 *      per-timestamp spark history, and its run count (the scatter's
 *      bubble-size source).
 *   5. Game log — one row per cleared-run journal, newest first, with the
 *      canon split's three sides beside the gross.
 *
 * Same derivation family as `entityIntelligence.ts` and
 * `analyticsFlows.ts` — the discipline is mirrored, not shared: the
 * journal scan, the holder-credit measure, the run resolution, and the
 * unanimous-view cuts are re-implemented here privately so this module
 * stays a pure addition and the shipped modules stay untouched.
 *
 * Units, stated plainly: every money figure is integer CENTS as bigint —
 * the ledger's own unit, the engine-path money. The canon split floors
 * each BPS side and sweeps the rounding dust to the company reserve (the
 * `allocateWithCompanyDustSweep` mechanic, mirrored in bigint), so the
 * three sides sum to the gross by construction. Percentages are floored
 * integer percents — a loss never renders smaller than it is. Nothing
 * here formats; rendering belongs to the component.
 *
 * TIME: the anchor is the store's own clock — the newest royalty journal
 * timestamp in the scanned ledger. The demo seed fixes every record to a
 * deterministic instant, so a real wall-clock anchor would age the demo
 * out of its own windows; the ledger's latest activity IS the timeline
 * the windows describe. Bounded windows (7/30/90) are the anchor day
 * inclusive going back; `all` is unbounded.
 *
 * Honesty law: a run the store cannot resolve (or a mixed-kind run)
 * still counts in the totals and the game log but carries no structural
 * attribution — its money is never force-fitted onto a cut or a profile,
 * and its row states the missing facts as nulls. A cut with no rows is
 * empty; a store read that fails degrades the whole payload to the
 * honest `null` (the unavailable state, the siblings' treatment). No
 * fabricated totals, no averaging beyond the stated floor, and the
 * counterparty boundary holds: the structural cuts and the leaderboard
 * carry entity ids and structural labels only — never a brand or
 * counterparty string. The game log's `source` column is the run's own
 * field of record (the store string the ledger drilldown renders), not a
 * module-invented attribution.
 */

import type { Store } from '@/lib/server/store';
import type { SplitRunRecord } from '@/lib/don/types';
import type { GlEntryRecord } from '@/modules/don/records';
import { BPS_DENOMINATOR } from '@/modules/don/constants';
import { SOVEREIGN_ALLOCATION_BPS } from '@/lib/master/sovereignLedger';
import { flowKindForEntity, type FlowKind } from '@/lib/master/flowKinds';
import {
  entityClassTag,
  type AtomicEntityClassTag,
  type SovereignAtomicEntity,
} from '@/lib/master/CovnantAtomicDataSDK';
import { entityRecordForWorkRef } from '@/lib/master/masterStore';
import type { CohortRank } from './entityIntelligence';

// ─────────────────────────────────────────────────────────────────────────────
// The payload types — one safe read, bigint cents throughout, rendering
// happens downstream.
// ─────────────────────────────────────────────────────────────────────────────

/** The page's window filter — re-derives every KPI, chart, table, and scatter. */
export type AnalyticsWindow = '7d' | '30d' | '90d' | 'all';

/** The six KPI cards — the company's own headline figures for the window. */
export interface CompanyKpis {
  /** Every holder-credit cent cleared through royalty ingests in the window. */
  readonly totalClearedCents: bigint;
  /** The canon 35% creative side of every cleared run. */
  readonly creatorPaidCents: bigint;
  /** The canon 15% production-operations side of every cleared run. */
  readonly operationsYieldCents: bigint;
  /** The canon 50% ownership-reserve side (the split dust sweeps here). */
  readonly companyReserveCents: bigint;
  /** The cleared runs of the window — unresolved runs included. */
  readonly runCount: number;
  /** totalCleared / runCount, floored to whole cents — null at zero runs. */
  readonly avgRunCents: bigint | null;
}

/** One day of the cleared-volume series — a zero day is an honest zero. */
export interface DailyClearedPoint {
  /** The UTC day of record, `YYYY-MM-DD` — the journals' own granularity. */
  readonly day: string;
  readonly grossCents: bigint;
  readonly creatorCents: bigint;
  readonly opsCents: bigint;
}

/** The flow-kind cut — the registered structural kinds, runs and gross per kind. */
export interface FlowKindSplitRow {
  readonly kind: FlowKind;
  readonly runCount: number;
  readonly grossCents: bigint;
}

/** The industry cut — the ten atomic class tags, runs and gross per tag. */
export interface IndustryTotalRow {
  /** The structural class tag of record (the analyticsFlows cut key). */
  readonly industry: string;
  /** The registered display label — structural vocabulary, never a brand. */
  readonly label: string;
  readonly grossCents: bigint;
  readonly runCount: number;
}

/** One leaderboard row — the entity's standing for the window. */
export interface LeaderboardRow {
  readonly entityId: string;
  /** The entity's atomic class of record (the EntityIntelligence `class` vocabulary). */
  readonly classLabel: string;
  /** Standard competition rank — ties share it, the next rank vacant. */
  readonly rank: number;
  /** The ranked cohort size — every entity the window's runs credited. */
  readonly rankOf: number;
  readonly grossCents: bigint;
  /** The canon 35% creative side of the entity's window gross. */
  readonly creatorPaidCents: bigint;
  /** The entity's run count in the window — the scatter's bubble size. */
  readonly runCount: number;
  /** % Δ trailing-30-day vs prior-30-day, floored — null when no prior point. */
  readonly momentum30: number | null;
  /** Per-timestamp cleared history in the window, oldest first. */
  readonly spark: readonly bigint[];
}

/**
 * One game-log row — per cleared-run journal, newest first. The nullable
 * structural fields are the fail-closed states: a run the store cannot
 * resolve or a mixed run counts here but carries no attribution.
 */
export interface GameLogRow {
  /** The split run of record — null when the journal carries no run reference. */
  readonly runId: string | null;
  /** The journal's UTC day of record. */
  readonly day: string;
  /** The unanimous bound entity — null when the run resolves to none or disagrees. */
  readonly entityId: string | null;
  /** The bound entity's atomic class — null with the entity. */
  readonly classLabel: string | null;
  /** The unanimous structural kind — null when unresolved or mixed-kind. */
  readonly flowKind: FlowKind | null;
  /** The run's own source of record — null when the run record is gone. */
  readonly source: string | null;
  /** The journal's holder-credit sum — the run's cleared measure. */
  readonly grossCents: bigint;
  readonly creatorCents: bigint;
  readonly opsCents: bigint;
  readonly companyCents: bigint;
}

/** The one safe payload — the whole company page derives from this alone. */
export interface CompanyAnalytics {
  readonly window: AnalyticsWindow;
  readonly kpis: CompanyKpis;
  readonly daily: readonly DailyClearedPoint[];
  readonly flowKindSplit: readonly FlowKindSplitRow[];
  readonly industryTotals: readonly IndustryTotalRow[];
  readonly leaderboard: readonly LeaderboardRow[];
  readonly gameLog: readonly GameLogRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The canon split — the engine's own 50/35/15 application, mirrored in
// bigint. The weights are the sovereign ledger's allocation weights (the
// master record's canon: 50% ownership reserve, 35% creative royalty, 15%
// production operations); the mechanic is `allocateWithCompanyDustSweep`:
// floor each BPS side, the rounding dust sweeps to the company reserve.
// ─────────────────────────────────────────────────────────────────────────────

/** The canon 35% creative-royalty weight — the creators' side. */
const CREATOR_PAID_BPS = BigInt(SOVEREIGN_ALLOCATION_BPS.creativeRoyalty);
/** The canon 15% production-operations weight — the operations side. */
const OPERATIONS_YIELD_BPS = BigInt(SOVEREIGN_ALLOCATION_BPS.productionOperations);
/**
 * The engine's BPS denominator, lifted into bigint once for the money math.
 * The company's own 50% side is never multiplied out — it is the swept
 * remainder of the gross (the dust-sweep canon), so its weight stays
 * readable here only through the ledger's own record.
 */
const BPS_DENOMINATOR_BIGINT = BigInt(BPS_DENOMINATOR);

/** The canon split's three sides of one run's cleared gross — integer cents. */
interface CanonSplit {
  readonly creatorCents: bigint;
  readonly opsCents: bigint;
  readonly companyCents: bigint;
}

/**
 * The canon 50/35/15 split of one run's cleared gross — the Don dust
 * canon in bigint: each side floors at its BPS weight, the remainder
 * sweeps to the company reserve, and the three sides sum to the gross by
 * construction. Applied per run, then summed — never per aggregate
 * (the floor is not linear across runs).
 */
function canonSplitOf(grossCents: bigint): CanonSplit {
  const creatorCents = (grossCents * CREATOR_PAID_BPS) / BPS_DENOMINATOR_BIGINT;
  const opsCents = (grossCents * OPERATIONS_YIELD_BPS) / BPS_DENOMINATOR_BIGINT;
  const companyCents = grossCents - creatorCents - opsCents;
  return { creatorCents, opsCents, companyCents };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger scan — the siblings' treatment, mirrored privately: the
// royalty journals, their holder-credit measure, and the run resolution
// with the exact per-view unanimity rules.
// ─────────────────────────────────────────────────────────────────────────────

/** Any rights holder's vault account — `vault:<payeeId>:…` — except the platform's own dust vault. */
function isHolderVaultCredit(entry: GlEntryRecord): boolean {
  return (
    entry.account.startsWith('vault:') &&
    !entry.account.startsWith('vault:platform:') &&
    entry.credit_cents > 0
  );
}

/** The journal's holder-side vault-credit sum — the measure every cut groups. */
function holderCreditOf(entries: readonly GlEntryRecord[] | undefined): bigint {
  let holderCredit = 0n;
  for (const entry of entries ?? []) {
    if (isHolderVaultCredit(entry)) holderCredit += BigInt(entry.credit_cents);
  }
  return holderCredit;
}

/**
 * The run's bound atomic entity records — resolved when EVERY line item
 * of the run resolves (the settlement shape of record: one asset per
 * run). A run whose line items resolve to nothing contributes no
 * structural attribution — its money is never misattributed.
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
 * The unanimous view over a run's records — the view value every record
 * agrees on, or null when they disagree (a mixed run is never
 * force-fitted to one row).
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

/**
 * The run's unanimous bound entity identity — the shared template id when
 * every record IS the same entity, null when they disagree.
 */
function unanimousEntityIdentity(records: readonly SovereignAtomicEntity[]): string | null {
  return unanimousView(records, (record) => record.templateId);
}

/** One cleared-run scan row — the journal of record plus its attributions. */
interface ClearedRunScan {
  /** The journal timestamp of record (the settlement instant). */
  readonly at: string;
  /** The journal's UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly runId: string | null;
  readonly source: string | null;
  readonly holderCredit: bigint;
  readonly entityId: string | null;
  readonly classLabel: string | null;
  readonly industry: string | null;
  readonly flowKind: FlowKind | null;
}

/**
 * The ledger scan — every royalty-ingest journal with holder credits,
 * resolved to its run and structural attributions. Mirrors the siblings'
 * scan exactly: runs resolved before they count, the per-view unanimity
 * rules fail closed, unresolved runs keep their money in the totals with
 * no attribution.
 */
async function scanClearedRuns(store: Store): Promise<readonly ClearedRunScan[]> {
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

  const scans: ClearedRunScan[] = [];
  for (const journal of journals) {
    const holderCredit = holderCreditOf(entriesByJournal.get(journal.id));
    if (holderCredit <= 0n) continue;
    const runId = journal.ref_type === 'split_run' ? journal.ref_id : null;
    const run = runOf.get(journal.id);
    if (run === undefined) {
      // The run record is gone — the journal's cleared money still counts
      // (totals and game log) with no structural attribution.
      scans.push({
        at: journal.created_at,
        day: dayKeyOf(journal.created_at),
        runId,
        source: null,
        holderCredit,
        entityId: null,
        classLabel: null,
        industry: null,
        flowKind: null,
      });
      continue;
    }
    const records = await recordsOfRun(store, run);
    const entityId = records === null ? null : unanimousEntityIdentity(records);
    // The bound entity's class of record — null with the identity (a
    // templateId-unanimous run always finds its record; a null identity
    // never matches). No assertion: the ternary narrows both reads.
    const classOfIdentity =
      entityId === null || records === null
        ? null
        : (records.find((record) => record.templateId === entityId) ?? null);
    scans.push({
      at: journal.created_at,
      day: dayKeyOf(journal.created_at),
      runId,
      source: run.source,
      holderCredit,
      entityId,
      classLabel: classOfIdentity === null ? null : classOfIdentity.entityType,
      industry: records === null ? null : unanimousView(records, entityClassTag),
      flowKind: records === null ? null : unanimousView(records, flowKindForEntity),
    });
  }
  return scans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time — the store's own clock. The anchor is the newest royalty journal
// day in the scan; windows are UTC-day arithmetic off it, string-keyed on
// the journals' own ISO granularity (lexicographic order IS chronology).
// ─────────────────────────────────────────────────────────────────────────────

/** The UTC day of record — the journal timestamp's own ISO date prefix. */
function dayKeyOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

const DAY_MS = 86_400_000;

/** The UTC day shifted by whole days — integer epoch math, deterministic. */
function shiftDay(day: string, offsetDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offsetDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The window's inclusive lower bound, or null for `all`. Each arm covers
 * exactly its day count with the anchor day itself; the exhaustiveness
 * pin is the flowKinds pattern family — a new window without an arm
 * fails the build here, and the throw beneath is the runtime fail-closed
 * twin.
 */
function windowStartDay(anchorDay: string, window: AnalyticsWindow): string | null {
  switch (window) {
    case '7d':
      return shiftDay(anchorDay, -6);
    case '30d':
      return shiftDay(anchorDay, -29);
    case '90d':
      return shiftDay(anchorDay, -89);
    case 'all':
      return null;
    default: {
      const unregistered: never = window;
      throw new Error(`companyAnalytics: no window arm for ${String(unregistered)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The aggregations — pure folds over the window's scan rows.
// ─────────────────────────────────────────────────────────────────────────────

/** The KPI fold — the canon split applied per run, then summed. */
function kpisFrom(windowRuns: readonly ClearedRunScan[]): CompanyKpis {
  let totalClearedCents = 0n;
  let creatorPaidCents = 0n;
  let operationsYieldCents = 0n;
  let companyReserveCents = 0n;
  for (const run of windowRuns) {
    const split = canonSplitOf(run.holderCredit);
    totalClearedCents += run.holderCredit;
    creatorPaidCents += split.creatorCents;
    operationsYieldCents += split.opsCents;
    companyReserveCents += split.companyCents;
  }
  return {
    totalClearedCents,
    creatorPaidCents,
    operationsYieldCents,
    companyReserveCents,
    runCount: windowRuns.length,
    avgRunCents:
      windowRuns.length === 0 ? null : totalClearedCents / BigInt(windowRuns.length),
  };
}

/**
 * The daily series — the window's runs grouped by their UTC day, then
 * every day from the fill start through the anchor day carried as a
 * point (zero where nothing cleared, so the curve never interpolates
 * across a hole).
 */
function dailyFrom(
  windowRuns: readonly ClearedRunScan[],
  fillStart: string | null,
  anchorDay: string,
): readonly DailyClearedPoint[] {
  if (fillStart === null) return [];
  const byDay = new Map<string, { gross: bigint; creator: bigint; ops: bigint }>();
  for (const run of windowRuns) {
    const sums = byDay.get(run.day) ?? { gross: 0n, creator: 0n, ops: 0n };
    const split = canonSplitOf(run.holderCredit);
    sums.gross += run.holderCredit;
    sums.creator += split.creatorCents;
    sums.ops += split.opsCents;
    byDay.set(run.day, sums);
  }
  const daily: DailyClearedPoint[] = [];
  for (let day = fillStart; day <= anchorDay; day = shiftDay(day, 1)) {
    const sums = byDay.get(day);
    daily.push({
      day,
      grossCents: sums?.gross ?? 0n,
      creatorCents: sums?.creator ?? 0n,
      opsCents: sums?.ops ?? 0n,
    });
  }
  return daily;
}

/** Group rows descending by gross, structural key as the tie-break (the cutFrom pattern). */
function byGrossDesc<T extends { grossCents: bigint }>(
  a: T,
  b: T,
  keyOf: (row: T) => string,
): number {
  if (a.grossCents > b.grossCents) return -1;
  if (a.grossCents < b.grossCents) return 1;
  return keyOf(a).localeCompare(keyOf(b));
}

/** The flow-kind cut — unanimous-kind runs only, runs and gross per kind. */
function flowKindSplitFrom(
  windowRuns: readonly ClearedRunScan[],
): readonly FlowKindSplitRow[] {
  const byKind = new Map<FlowKind, { runCount: number; grossCents: bigint }>();
  for (const run of windowRuns) {
    if (run.flowKind === null) continue;
    const row = byKind.get(run.flowKind) ?? { runCount: 0, grossCents: 0n };
    row.runCount += 1;
    row.grossCents += run.holderCredit;
    byKind.set(run.flowKind, row);
  }
  return [...byKind.entries()]
    .map(([kind, row]) => ({ kind, runCount: row.runCount, grossCents: row.grossCents }))
    .sort((a, b) => byGrossDesc(a, b, (row) => row.kind));
}

/**
 * The industry display labels — the ten atomic class tags' structural
 * vocabulary. An unregistered tag renders as itself (the flowKindLabel
 * pattern: never swallowed).
 */
const INDUSTRY_LABELS: Record<AtomicEntityClassTag, string> = {
  MUSIC: 'Music',
  FILM: 'Film',
  TV: 'TV',
  PODCASTING: 'Podcasting',
  LIVE: 'Live',
  PUBLISHING: 'Publishing',
  SPORTS: 'Sports',
  ESPORTS: 'Esports',
  SOCIAL: 'Social',
  SPONSORSHIP: 'Sponsorship',
};

function industryLabel(tag: string): string {
  return INDUSTRY_LABELS[tag as AtomicEntityClassTag] ?? tag;
}

/** The industry cut — unanimous-tag runs only, runs and gross per tag. */
function industryTotalsFrom(
  windowRuns: readonly ClearedRunScan[],
): readonly IndustryTotalRow[] {
  const byIndustry = new Map<string, { runCount: number; grossCents: bigint }>();
  for (const run of windowRuns) {
    if (run.industry === null) continue;
    const row = byIndustry.get(run.industry) ?? { runCount: 0, grossCents: 0n };
    row.runCount += 1;
    row.grossCents += run.holderCredit;
    byIndustry.set(run.industry, row);
  }
  return [...byIndustry.entries()]
    .map(([industry, row]) => ({
      industry,
      label: industryLabel(industry),
      runCount: row.runCount,
      grossCents: row.grossCents,
    }))
    .sort((a, b) => byGrossDesc(a, b, (row) => row.industry));
}

/**
 * The momentum percent — floored integer percent, so a loss never renders
 * smaller than it is (bigint division alone truncates toward zero, which
 * would shrink a negative delta's magnitude).
 */
function flooredPercentDelta(delta: bigint, prior: bigint): number {
  const scaled = delta * 100n;
  const quotient = scaled / prior;
  const floored = scaled % prior !== 0n && delta < 0n ? quotient - 1n : quotient;
  return Number(floored);
}

/**
 * The entity's momentum30 — the trailing 30-day cleared total vs the
 * prior 30-day total, anchored on the store clock. The honest null when
 * the entity has no prior-window point (nothing to compare against);
 * a zero-current entity with prior activity states its −100.
 */
function momentum30For(
  credits: ReadonlyMap<string, bigint> | undefined,
  anchorDay: string,
): number | null {
  if (credits === undefined) return null;
  const currentStart = shiftDay(anchorDay, -29);
  const priorStart = shiftDay(anchorDay, -59);
  const priorEnd = shiftDay(anchorDay, -30);
  let current = 0n;
  let prior = 0n;
  for (const [at, credit] of credits) {
    const day = dayKeyOf(at);
    if (day >= currentStart && day <= anchorDay) current += credit;
    else if (day >= priorStart && day <= priorEnd) prior += credit;
  }
  if (prior === 0n) return null;
  return flooredPercentDelta(current - prior, prior);
}

/**
 * The entity's spark history — its per-timestamp credits inside the
 * window, oldest first (the trendFrom grouping, chronological order).
 */
function sparkFrom(
  credits: ReadonlyMap<string, bigint> | undefined,
  startDay: string | null,
  anchorDay: string,
): readonly bigint[] {
  if (credits === undefined) return [];
  return [...credits.entries()]
    .filter(([at]) => {
      const day = dayKeyOf(at);
      return (startDay === null || day >= startDay) && day <= anchorDay;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, credit]) => credit);
}

/**
 * The leaderboard — the entities the window's resolved runs credited,
 * ranked by the CohortRank standard-competition rule over window gross
 * (ties share the rank, the next rank vacant). Momentum and spark read
 * the entity's FULL credit history: the momentum windows reach before
 * the payload window, so the credits map is unfiltered.
 */
function leaderboardFrom(
  windowRuns: readonly ClearedRunScan[],
  creditsByEntity: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  startDay: string | null,
  anchorDay: string,
): readonly LeaderboardRow[] {
  const totals = new Map<
    string,
    { grossCents: bigint; creatorPaidCents: bigint; runCount: number; classLabel: string }
  >();
  for (const run of windowRuns) {
    if (run.entityId === null || run.classLabel === null) continue;
    const split = canonSplitOf(run.holderCredit);
    const row =
      totals.get(run.entityId) ??
      { grossCents: 0n, creatorPaidCents: 0n, runCount: 0, classLabel: run.classLabel };
    row.grossCents += run.holderCredit;
    row.creatorPaidCents += split.creatorCents;
    row.runCount += 1;
    totals.set(run.entityId, row);
  }
  const rows: LeaderboardRow[] = [...totals.entries()].map(([entityId, row]) => {
    // The CohortRank rule — 1 + the count of cohort entities with a
    // strictly greater cleared total; ties share the rank.
    let strictlyGreater = 0n;
    for (const [otherId, other] of totals) {
      if (otherId !== entityId && other.grossCents > row.grossCents) strictlyGreater += 1n;
    }
    const cohort: CohortRank = { rank: 1n + strictlyGreater, of: BigInt(totals.size) };
    const credits = creditsByEntity.get(entityId);
    return {
      entityId,
      classLabel: row.classLabel,
      rank: Number(cohort.rank),
      rankOf: Number(cohort.of),
      grossCents: row.grossCents,
      creatorPaidCents: row.creatorPaidCents,
      runCount: row.runCount,
      momentum30: momentum30For(credits, anchorDay),
      spark: sparkFrom(credits, startDay, anchorDay),
    };
  });
  return rows.sort(
    (a, b) => a.rank - b.rank || byGrossDesc(a, b, (row) => row.entityId),
  );
}

/** The game log — one row per cleared-run journal, newest first. */
function gameLogFrom(windowRuns: readonly ClearedRunScan[]): readonly GameLogRow[] {
  return [...windowRuns]
    .sort((a, b) =>
      a.at > b.at ? -1 : a.at < b.at ? 1 : (a.runId ?? '').localeCompare(b.runId ?? ''),
    )
    .map((run) => {
      const split = canonSplitOf(run.holderCredit);
      return {
        runId: run.runId,
        day: run.day,
        entityId: run.entityId,
        classLabel: run.classLabel,
        flowKind: run.flowKind,
        source: run.source,
        grossCents: run.holderCredit,
        creatorCents: split.creatorCents,
        opsCents: split.opsCents,
        companyCents: split.companyCents,
      };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The company analytics payload — the whole window-filtered read over one
 * store. Never throws: a store failure degrades to the honest `null`
 * (the unavailable state, the siblings' treatment). An empty ledger
 * yields the honest zero payload — zeroed KPIs with the null average and
 * empty series, the page's honest empty states.
 */
export async function companyAnalytics(
  store: Store,
  window: AnalyticsWindow,
): Promise<CompanyAnalytics | null> {
  let scan: readonly ClearedRunScan[];
  try {
    scan = await scanClearedRuns(store);
  } catch {
    return null;
  }
  if (scan.length === 0) {
    return {
      window,
      kpis: kpisFrom([]),
      daily: [],
      flowKindSplit: [],
      industryTotals: [],
      leaderboard: [],
      gameLog: [],
    };
  }

  // The store clock — the newest royalty journal day in the scan.
  const anchorDay = scan.reduce(
    (newest, run) => (run.day > newest ? run.day : newest),
    scan[0].day,
  );
  const startDay = windowStartDay(anchorDay, window);
  const windowRuns =
    startDay === null ? scan : scan.filter((run) => run.day >= startDay && run.day <= anchorDay);
  // `all` fills its daily series from the first activity day — no
  // fabricated pre-history zeros; bounded windows fill from their start.
  const fillStart =
    startDay ??
    scan.reduce((oldest, run) => (run.day < oldest ? run.day : oldest), scan[0].day);

  // Per-entity per-timestamp credits over ALL resolved runs — momentum's
  // prior window reaches before the payload window, so this map is
  // unfiltered and every window reads it through its own bounds.
  const creditsByEntity = new Map<string, Map<string, bigint>>();
  for (const run of scan) {
    if (run.entityId === null) continue;
    const credits = creditsByEntity.get(run.entityId);
    if (credits === undefined) {
      creditsByEntity.set(run.entityId, new Map([[run.at, run.holderCredit]]));
    } else {
      credits.set(run.at, (credits.get(run.at) ?? 0n) + run.holderCredit);
    }
  }

  return {
    window,
    kpis: kpisFrom(windowRuns),
    daily: dailyFrom(windowRuns, fillStart, anchorDay),
    flowKindSplit: flowKindSplitFrom(windowRuns),
    industryTotals: industryTotalsFrom(windowRuns),
    leaderboard: leaderboardFrom(windowRuns, creditsByEntity, startDay, anchorDay),
    gameLog: gameLogFrom(windowRuns),
  };
}
