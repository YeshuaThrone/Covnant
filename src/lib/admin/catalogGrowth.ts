/**
 * Catalog Growth OS — the derivation layer for the founder-requested
 * modules on the Creator Analytics tab (spec art_qNu4T32F): the recoupment
 * tracker (Recoupment by Catalog), the territory view (Top Markets), and
 * the action-signal banner. Same derivation family as
 * `creatorAnalytics.ts` — the discipline is mirrored, not shared: the
 * journal scan, the holder-credit measure, the run resolution, and the
 * window arithmetic are re-implemented here privately so this module stays
 * a pure addition and the shipped modules stay untouched (zero edits to
 * any existing module, nothing in components/). The section builder
 * consumes this payload beside the creator one, under the same window —
 * the same call shape, the same fail-closed `null` on a store failure.
 *
 * THE ENGINE'S OWN NUMBERS, stated once: recoupment state is read THROUGH
 * the engine — `sweepRecoupment` (src/modules/recoupment/engine.ts, the
 * sweep live at src/lib/server/udrSplits.ts) with zero incoming is the
 * engine's own state query. Its `completed` flag is the break-even verdict
 * of record and its `recoupment_remaining_cents` is the target-minus-
 * current balance floored at zero BY the engine. No figure here re-derives
 * engine arithmetic — the no-parallel-arithmetic law: if a number exists
 * in the engine's structures, that is the number this module reports.
 * Advances are read via `Store.listRecoupmentAdvances`; the sweep trail is
 * read via `Store.listRecoupmentLedgerByRun` (the engine's keyed rows —
 * the newest-day fact per payee, and the test-pinned agreement with the
 * advance of record).
 *
 * TERRITORY, honestly: the Top Markets fold consumes the territory seam's
 * records (`Store.listTerritorySettlements`) — SDK-settled credits ONLY,
 * the territory verbatim as stamped. A credit whose stamp carries no
 * territory is real money belonging to no market: its cents are carried
 * in `unattributedCents`, never dropped and never attributed. Markets
 * absent from the stamped data are absent from the ranking — coverage is
 * labeled at the section (SDK-settled events only), never widened here.
 *
 * SIGNALS, measured only: source deltas are an integer-bps comparison of
 * the window's source cut against the immediately preceding window of
 * equal length — a second fold over the same materialized scan rows. A
 * source with no measurable prior (absent, or zero cents) emits NO delta
 * — no ratio is invented over a zero base — and the ALL window has no
 * prior, so it never emits a delta at all. Negative deltas are valid
 * signals. Recoupment milestones fire only on the engine's completed
 * flag. The top source is the head of the window's cut. Headlines are
 * measured statements ONLY — no causation language anywhere: the why is
 * not in any ledger. An empty signal array is valid — the banner renders
 * nothing rather than filler.
 *
 * PAYEES without an advance are emitted as such (`payeesWithoutAdvanceIds`
 * — the window's credited universe the advance map does not name), so the
 * section renders the honest "No advance on file" line instead of a
 * zero-balance imitation.
 *
 * Units: every money figure is integer CENTS as bigint — the ledger's own
 * unit, the engine-path money. Integer math only; the delta's bps is exact
 * integer rounding (half away from zero at the exact boundary) — no float
 * ever touches a ratio. Nothing here divides, formats, or converts money
 * (rendering belongs to the component; the delta's percent is formatted
 * exactly from its integer bps, bps being hundredths of a percent).
 *
 * TIME: the same store clock as the creator module — the anchor is the
 * newest royalty journal day in the scan; bounded windows (7/30/90) are
 * the anchor day inclusive going back; `null` is ALL, unbounded. The
 * recoupment rows and the territory fold are the catalog's STANDING state
 * (unwindowed by design): an advance and a stamped credit are standing
 * facts, not window facts — the window selector re-derives the signals
 * and the no-advance universe.
 *
 * Honesty law: an empty ledger still reads the standing catalog state (an
 * advance on a catalog with no settlements yet is a real row — target X,
 * applied 0, fully unrecouped). A store read that fails degrades the
 * whole payload to the honest `null` (the unavailable state, the
 * siblings' treatment). No placeholder attribution, no invented names, no
 * invented territory, ever.
 */

import type { Store } from '@/lib/server/store';
import type { GlEntryRecord, RecoupmentAdvanceRecord } from '@/modules/don/records';
import { sweepRecoupment } from '@/modules/recoupment/engine';
import type { TerritorySettlementRecord } from '@/lib/server/territorySettlement';
import type { CreatorWindowDays } from '@/lib/admin/creatorAnalytics';

// ─────────────────────────────────────────────────────────────────────────────
// The payload types — one safe read, bigint cents throughout, rendering
// happens downstream.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One catalog recoupment row — the engine's own state of record for one
 * payee's advance, through `sweepRecoupment` with zero incoming. Every
 * payee carrying an advance appears here (windowed or not — a standing
 * fact); payees WITHOUT one are in `payeesWithoutAdvanceIds`, never
 * imitated as a zero-balance row.
 */
export interface CatalogRecoupmentRow {
  /** The advance's payee of record (`creator_id`). */
  readonly payeeId: string;
  /**
   * The advance's store-carried `creator_name` of record — null when it
   * carries none (the section then renders the payeeId). Never invented.
   */
  readonly label: string | null;
  /** The advance's target of record — the break-even threshold. */
  readonly advanceTargetCents: bigint;
  /** The engine's current recouped — the net earnings applied of record. */
  readonly appliedCents: bigint;
  /** The engine's own remaining — target − current floored at zero by the engine. */
  readonly unrecoupedCents: bigint;
  /** The engine's completed flag — the break-even verdict of record, never re-derived. */
  readonly fullyRecouped: boolean;
  /**
   * The sweep trail's newest day of record for this payee (the engine's
   * keyed ledger rows via `listRecoupmentLedgerByRun`) — null when no
   * run-keyed sweep row exists.
   */
  readonly lastSweepDay: string | null;
}

/** One market row — a stamped territory and its SDK-settled creator cents. */
export interface TopMarketRow {
  /** Exactly the stamped metadata value (ISO 3166-1 alpha-2 of record). */
  readonly territory: string;
  /** Σ SDK-settled credit cents stamped to this territory. */
  readonly creatorCents: bigint;
}

/**
 * The Top Markets fold over the territory seam's records — SDK-settled
 * credits ONLY. The standing coverage label (SDK-settled events only;
 * markets absent from the stamp are absent here) belongs to the section;
 * the fold carries the honest facts themselves.
 */
export interface TopMarketsSummary {
  /** Markets sorted by creator cents desc, territory name as the tiebreak. */
  readonly markets: readonly TopMarketRow[];
  /**
   * Real SDK-settled money whose credit carries no territory — belonging
   * to no market of record. Never dropped, never attributed.
   */
  readonly unattributedCents: bigint;
  /**
   * How many SDK-settled credits the fold considered — distinguishes "no
   * SDK-settled events at all" (0) from "events, none carrying a
   * territory" (markets empty, unattributed positive).
   */
  readonly settlementsConsidered: number;
}

/**
 * One action signal — a measured statement of what the data shows, never
 * why. `basisPoints` is the integer delta of record for source deltas and
 * the honest null everywhere a delta does not exist (no prior window, no
 * prior money, or not a delta at all).
 */
export interface ActionSignal {
  readonly kind: 'source-delta' | 'recoupment-milestone' | 'top-source';
  /** The measured statement — rendered verbatim; no causation language, ever. */
  readonly headline: string;
  /** The store-carried label of record (source string, or the payee's name of record). */
  readonly subjectLabel: string;
  /** The integer bps of the delta — null when no measurable delta exists. */
  readonly basisPoints: number | null;
}

/** The one safe payload — the whole Catalog Growth OS layer derives from this alone. */
export interface CatalogGrowthFlows {
  readonly windowDays: CreatorWindowDays;
  /** Every payee carrying an advance — the engine's own state of record. */
  readonly recoupmentByCatalog: readonly CatalogRecoupmentRow[];
  /** The window's credited payees the advance map does not name — the honest "No advance on file" emission. */
  readonly payeesWithoutAdvanceIds: readonly string[];
  /** The territory fold — SDK-settled credits only, standing (unwindowed). */
  readonly topMarkets: TopMarketsSummary;
  /** Measured signals for the window — empty is valid; the banner renders nothing. */
  readonly actionSignals: readonly ActionSignal[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger scan — the creator module's treatment, mirrored privately:
// the royalty journals, the holder-credit measure, and the per-entry payee
// attribution from the vault account of record. The signal cut needs the
// source and the money; the no-advance universe needs the payees.
// ─────────────────────────────────────────────────────────────────────────────

/** Any rights holder's vault account — `vault:<payeeId>:…` — except the platform's own dust vault. */
function isHolderVaultCredit(entry: GlEntryRecord): boolean {
  return (
    entry.account.startsWith('vault:') &&
    !entry.account.startsWith('vault:platform:') &&
    entry.credit_cents > 0
  );
}

/**
 * The vault account's payee segment — the `vault:<payeeId>:<bucket>`
 * middle (vaultGlAccount's format). Null when the account string cannot
 * carry one: that credit counts in the measure but attributes to no payee
 * (never force-fitted onto a malformed key).
 */
function payeeOfVaultAccount(account: string): string | null {
  if (!account.startsWith('vault:') || account.startsWith('vault:platform:')) return null;
  const segments = account.split(':');
  const payeeId = segments[1];
  return payeeId !== undefined && payeeId !== '' ? payeeId : null;
}

/** The journal's holder-side vault-credit sum — the measure every cut groups. */
function holderCreditOf(entries: readonly GlEntryRecord[] | undefined): bigint {
  let holderCredit = 0n;
  for (const entry of entries ?? []) {
    if (isHolderVaultCredit(entry)) holderCredit += BigInt(entry.credit_cents);
  }
  return holderCredit;
}

/** One cleared-run scan row — the journal of record plus its signal attributions. */
interface CatalogSourceScan {
  /** The journal's UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  /** The run's own source of record — null when the run record is gone. */
  readonly source: string | null;
  /** The journal's holder-credit sum — the measure of record. */
  readonly holderCredit: bigint;
  /** Per-payee attribution of this journal's vault credits (well-formed keys only). */
  readonly creditsByPayee: ReadonlyMap<string, bigint>;
}

/**
 * The ledger scan — every royalty-ingest journal with holder credits,
 * resolved to its run's source of record and its per-payee attribution.
 * Mirrors the creator module's scan exactly: an unresolved run keeps its
 * money in the totals with no source attribution.
 */
async function scanCatalogSources(store: Store): Promise<readonly CatalogSourceScan[]> {
  const journals = (await store.listGlJournals()).filter(
    (journal) => journal.kind === 'royalty_ingest',
  );
  const entriesByJournal = new Map<string, GlEntryRecord[]>();
  for (const entry of await store.listGlEntries()) {
    const group = entriesByJournal.get(entry.journal_id);
    if (group !== undefined) group.push(entry);
    else entriesByJournal.set(entry.journal_id, [entry]);
  }

  const scans: CatalogSourceScan[] = [];
  for (const journal of journals) {
    const entries = entriesByJournal.get(journal.id);
    const holderCredit = holderCreditOf(entries);
    if (holderCredit <= 0n) continue;

    // Per-entry payee attribution — the vault account's own segment.
    const creditsByPayee = new Map<string, bigint>();
    for (const entry of entries ?? []) {
      if (!isHolderVaultCredit(entry)) continue;
      const payeeId = payeeOfVaultAccount(entry.account);
      if (payeeId === null) continue;
      creditsByPayee.set(
        payeeId,
        (creditsByPayee.get(payeeId) ?? 0n) + BigInt(entry.credit_cents),
      );
    }

    // The run's own source of record — an unresolved run carries none.
    let source: string | null = null;
    if (journal.ref_type === 'split_run' && journal.ref_id !== null) {
      const run = await store.getSplitRun(journal.ref_id);
      if (run !== undefined) source = run.source;
    }

    scans.push({
      day: journal.created_at.slice(0, 10),
      source,
      holderCredit,
      creditsByPayee,
    });
  }
  return scans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recoupment — the engine's own numbers, read through the Store's own
// paths. `sweepRecoupment` with zero incoming is the engine's state query;
// nothing here re-derives its arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recoupment sweep trail's newest day per payee, read through the
 * Store's keyed read over every royalty-ingest run of record. A run fully
 * swept to the platform carries no holder credit — the scan skips it, the
 * trail must not, so the run refs come from the journals themselves. A
 * payee with no run-keyed sweep row is absent — the honest null.
 */
async function recoupmentTrailLastDays(store: Store): Promise<ReadonlyMap<string, string>> {
  const runIds = new Set<string>();
  for (const journal of await store.listGlJournals()) {
    if (
      journal.kind === 'royalty_ingest' &&
      journal.ref_type === 'split_run' &&
      journal.ref_id !== null &&
      journal.ref_id !== ''
    ) {
      runIds.add(journal.ref_id);
    }
  }
  const lastDayByPayee = new Map<string, string>();
  for (const runId of runIds) {
    for (const row of await store.listRecoupmentLedgerByRun(runId)) {
      const day = row.created_at.slice(0, 10);
      const known = lastDayByPayee.get(row.creator_id);
      if (known === undefined || day > known) lastDayByPayee.set(row.creator_id, day);
    }
  }
  return lastDayByPayee;
}

/**
 * Every payee carrying an advance, THROUGH the engine: the advance of
 * record supplies the target and the current recouped; the engine's own
 * state query supplies the floored remaining and the completed flag.
 * Sorted by payeeId for a deterministic payload.
 */
function recoupmentRowsFrom(
  advances: readonly RecoupmentAdvanceRecord[],
  trailLastDayByPayee: ReadonlyMap<string, string>,
): readonly CatalogRecoupmentRow[] {
  return advances
    .map((advance) => {
      const engine = sweepRecoupment({
        incoming_cents: 0,
        recoupment_target_cents: advance.recoupment_target_cents,
        recoupment_current_cents: advance.recoupment_current_cents,
        recoupment_bps: advance.recoupment_bps,
      });
      return {
        payeeId: advance.creator_id,
        label: advance.creator_name !== '' ? advance.creator_name : null,
        advanceTargetCents: BigInt(advance.recoupment_target_cents),
        appliedCents: BigInt(engine.recoupment_current_cents),
        unrecoupedCents: BigInt(engine.recoupment_remaining_cents),
        fullyRecouped: engine.completed,
        lastSweepDay: trailLastDayByPayee.get(advance.creator_id) ?? null,
      };
    })
    .sort((a, b) => a.payeeId.localeCompare(b.payeeId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Top Markets — the territory seam's fold. SDK-settled credits ONLY; the
// territory verbatim; null-territory money carried, never dropped.
// ─────────────────────────────────────────────────────────────────────────────

/** Group rows descending by cents, structural key as the tie-break (the cutFrom pattern). */
function byCreditsDesc<T extends { creatorCents: bigint }>(
  a: T,
  b: T,
  keyOf: (row: T) => string,
): number {
  if (a.creatorCents > b.creatorCents) return -1;
  if (a.creatorCents < b.creatorCents) return 1;
  return keyOf(a).localeCompare(keyOf(b));
}

/**
 * The Top Markets fold — creator cents per territory over the SDK-settled
 * credits of record. A credit with no stamped territory is real money
 * belonging to no market: its cents land in `unattributedCents`. The fold
 * is the catalog's standing view (every SDK-settled credit on file,
 * unwindowed).
 */
function topMarketsFrom(settlements: readonly TerritorySettlementRecord[]): TopMarketsSummary {
  const byTerritory = new Map<string, bigint>();
  let unattributedCents = 0n;
  for (const record of settlements) {
    if (record.territory === null) {
      unattributedCents += record.amount_cents;
      continue;
    }
    byTerritory.set(
      record.territory,
      (byTerritory.get(record.territory) ?? 0n) + record.amount_cents,
    );
  }
  return {
    markets: [...byTerritory.entries()]
      .map(([territory, creatorCents]) => ({ territory, creatorCents }))
      .sort((a, b) => byCreditsDesc(a, b, (row) => row.territory)),
    unattributedCents,
    settlementsConsidered: settlements.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Time — the store's own clock, mirrored from the creator module: windows
// are UTC-day arithmetic off the anchor, string-keyed on the journals' own
// ISO granularity (lexicographic order IS chronology).
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The UTC day shifted by whole days — integer epoch math, deterministic. */
function shiftDay(day: string, offsetDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offsetDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The window's inclusive lower bound, or null for ALL. Each arm covers
 * exactly its day count with the anchor day itself; the exhaustiveness
 * pin is the flowKinds pattern family — a new window without an arm
 * fails the build here, and the throw beneath is the runtime fail-closed
 * twin.
 */
function windowStartDay(anchorDay: string, windowDays: CreatorWindowDays): string | null {
  switch (windowDays) {
    case 7:
      return shiftDay(anchorDay, -6);
    case 30:
      return shiftDay(anchorDay, -29);
    case 90:
      return shiftDay(anchorDay, -89);
    case null:
      return null;
    default: {
      const unregistered: never = windowDays;
      throw new Error(`catalogGrowth: no window arm for ${String(unregistered)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action signals — measured statements only. Exact integer bps math; no
// causation language anywhere; an empty array is a valid payload.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The window delta in integer basis points — round(((curr − prior) /
 * prior) × 10000) computed in EXACT integer math: the scaled difference
 * divided by the prior, rounded half AWAY FROM ZERO at the exact boundary
 * (a symmetric rule — a +0.5 bps edge and a −0.5 bps edge round to equal
 * magnitudes; pinned in tests). `null` when the prior is unmeasurable:
 * no ratio is invented over a zero base.
 */
function deltaBasisPoints(currentCents: bigint, priorCents: bigint): number | null {
  if (priorCents <= 0n) return null;
  const scaled = (currentCents - priorCents) * 10_000n;
  const quotient = scaled / priorCents; // bigint division truncates toward zero
  const remainder = scaled % priorCents;
  const twiceAbsRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const absPrior = priorCents < 0n ? -priorCents : priorCents;
  const rounded =
    twiceAbsRemainder >= absPrior ? (scaled < 0n ? quotient - 1n : quotient + 1n) : quotient;
  return Number(rounded);
}

/**
 * The delta's percent of record, formatted EXACTLY from the integer bps —
 * bps are hundredths of a percent, so the split is integer math and at
 * most two decimals, never a float. Sign: `+` for gains, `-` for losses,
 * nothing for zero.
 */
function formatDeltaPercent(basisPoints: number): string {
  const absBps = BigInt(Math.abs(basisPoints));
  const whole = absBps / 100n;
  const fraction = absBps % 100n;
  const magnitude =
    fraction === 0n
      ? `${whole}`
      : fraction % 10n === 0n
        ? `${whole}.${fraction / 10n}`
        : `${whole}.${fraction.toString().padStart(2, '0')}`;
  const sign = basisPoints > 0 ? '+' : basisPoints < 0 ? '-' : '';
  return `${sign}${magnitude}%`;
}

/** The window's source cut — holder credits per source of record, money desc, name tiebreak. */
function sourceCutFrom(scans: readonly CatalogSourceScan[]): readonly {
  source: string;
  creatorCents: bigint;
}[] {
  const bySource = new Map<string, bigint>();
  for (const scan of scans) {
    if (scan.source === null) continue;
    bySource.set(scan.source, (bySource.get(scan.source) ?? 0n) + scan.holderCredit);
  }
  return [...bySource.entries()]
    .map(([source, creatorCents]) => ({ source, creatorCents }))
    .sort((a, b) => byCreditsDesc(a, b, (row) => row.source));
}

/**
 * The action signals — measured statements ONLY: what the data shows,
 * never why. Source deltas compare the window's cut against the prior
 * window of equal length (`priorBySource` null = no prior exists — the
 * ALL window — so no delta signal is ever emitted). A source with no
 * measurable prior money emits nothing; a source the prior window paid
 * and this one didn't is a real −100% signal. Recoupment milestones fire
 * only on the engine's completed flag. The top source is the head of the
 * window's cut. Order: deltas in cut order then prior-only sources by
 * prior money, then milestones in row order, then the top source.
 */
function actionSignalsFrom(
  windowSources: readonly { source: string; creatorCents: bigint }[],
  priorBySource: ReadonlyMap<string, bigint> | null,
  recoupmentRows: readonly CatalogRecoupmentRow[],
): readonly ActionSignal[] {
  const signals: ActionSignal[] = [];

  if (priorBySource !== null) {
    const emitted = new Set<string>();
    for (const split of windowSources) {
      const priorCents = priorBySource.get(split.source) ?? 0n;
      const basisPoints = deltaBasisPoints(split.creatorCents, priorCents);
      if (basisPoints === null) continue; // no measurable prior — no delta signal for this source
      emitted.add(split.source);
      signals.push({
        kind: 'source-delta',
        headline: `${split.source} ${formatDeltaPercent(basisPoints)} vs prior period`,
        subjectLabel: split.source,
        basisPoints,
      });
    }
    const priorOnly = [...priorBySource.entries()]
      .filter(([source, cents]) => cents > 0n && !emitted.has(source))
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0])));
    for (const [source, priorCents] of priorOnly) {
      const basisPoints = deltaBasisPoints(0n, priorCents);
      if (basisPoints === null) continue; // unreachable — priorCents > 0 is filtered above
      signals.push({
        kind: 'source-delta',
        headline: `${source} ${formatDeltaPercent(basisPoints)} vs prior period`,
        subjectLabel: source,
        basisPoints,
      });
    }
  }

  for (const row of recoupmentRows) {
    if (!row.fullyRecouped) continue;
    signals.push({
      kind: 'recoupment-milestone',
      headline: 'Catalog fully recouped',
      subjectLabel: row.label ?? row.payeeId,
      basisPoints: null,
    });
  }

  const top = windowSources[0];
  if (top !== undefined) {
    signals.push({
      kind: 'top-source',
      headline: `Top source: ${top.source}`,
      subjectLabel: top.source,
      basisPoints: null,
    });
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Catalog Growth OS payload — the whole derivation over one store.
 * Never throws on a store failure: it degrades to the honest `null` (the
 * unavailable state, the siblings' treatment). An empty ledger still
 * reads the standing catalog state — an advance with no settlements yet
 * is a real recoupment row; no SDK-settled territory is the honest empty
 * fold.
 */
export async function catalogGrowthFlows(
  store: Store,
  windowDays: CreatorWindowDays,
): Promise<CatalogGrowthFlows | null> {
  let scan: readonly CatalogSourceScan[];
  let advances: readonly RecoupmentAdvanceRecord[];
  let settlements: readonly TerritorySettlementRecord[];
  let trailLastDayByPayee: ReadonlyMap<string, string>;
  try {
    scan = await scanCatalogSources(store);
    advances = await store.listRecoupmentAdvances();
    settlements = await store.listTerritorySettlements();
    trailLastDayByPayee = await recoupmentTrailLastDays(store);
  } catch {
    return null;
  }

  // The catalog-standing reads — the engine's own advance state and the
  // territory seam's SDK-settled fold. Unwindowed by design (an advance
  // and a stamped credit are standing facts, not window facts).
  const recoupmentByCatalog = recoupmentRowsFrom(advances, trailLastDayByPayee);
  const topMarkets = topMarketsFrom(settlements);

  if (scan.length === 0) {
    return {
      windowDays,
      recoupmentByCatalog,
      payeesWithoutAdvanceIds: [], // no credited universe on an empty ledger
      topMarkets,
      actionSignals: actionSignalsFrom([], null, recoupmentByCatalog),
    };
  }

  // The store clock — the newest royalty journal day in the scan.
  const anchorDay = scan.reduce(
    (newest, run) => (run.day > newest ? run.day : newest),
    scan[0].day,
  );
  const startDay = windowStartDay(anchorDay, windowDays);
  const windowScans =
    startDay === null
      ? scan
      : scan.filter((run) => run.day >= startDay && run.day <= anchorDay);

  // The prior-window source fold — the SAME materialized scan rows, the
  // window immediately preceding of equal length. ALL windows have no
  // prior (the honest null): no delta signal is ever emitted for them.
  let priorBySource: ReadonlyMap<string, bigint> | null = null;
  if (startDay !== null) {
    const lengthDays =
      Math.round(
        (Date.parse(`${anchorDay}T00:00:00.000Z`) - Date.parse(`${startDay}T00:00:00.000Z`)) /
          DAY_MS,
      ) + 1;
    const priorEnd = shiftDay(startDay, -1);
    const priorStart = shiftDay(startDay, -lengthDays);
    const priorMap = new Map<string, bigint>();
    for (const run of scan) {
      if (run.day < priorStart || run.day > priorEnd) continue;
      if (run.source === null) continue;
      priorMap.set(run.source, (priorMap.get(run.source) ?? 0n) + run.holderCredit);
    }
    priorBySource = priorMap;
  }

  // The window's credited universe minus the advance map — the honest
  // "No advance on file" emission for the section.
  const advanceIds = new Set(advances.map((advance) => advance.creator_id));
  const creditedPayees = new Set<string>();
  for (const run of windowScans) {
    for (const payeeId of run.creditsByPayee.keys()) creditedPayees.add(payeeId);
  }

  return {
    windowDays,
    recoupmentByCatalog,
    payeesWithoutAdvanceIds: [...creditedPayees]
      .filter((payeeId) => !advanceIds.has(payeeId))
      .sort((a, b) => a.localeCompare(b)),
    topMarkets,
    actionSignals: actionSignalsFrom(
      sourceCutFrom(windowScans),
      priorBySource,
      recoupmentByCatalog,
    ),
  };
}
