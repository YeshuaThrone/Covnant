/**
 * Creator analytics — the creator-side (the payees') readout over the one
 * clearing ledger (the Creator Analytics tab spec, art_UccVWZpj). Where
 * `companyAnalytics` answers the COMPANY's questions about the whole
 * settlement substrate and `entityIntelligence` answers the questions a
 * league asks about ONE cleared atomic entity, this module answers the
 * questions about the OTHER side of every run — the rights holders the
 * ledger actually paid:
 *
 *   1. KPIs — creator paid (the holder-credit measure of record), the
 *      same-window cleared gross (the share card's denominator), active
 *      payees, and runs paying creators.
 *   2. Payout trend — the holder credits grouped per day, gapless across
 *      the window: a day with no settlement is an honest zero point,
 *      never a hole for an area chart to interpolate across.
 *   3. Platform-source splits — where the creator money comes from: the
 *      run `source` strings of record (Spotify, Ticketmaster, Reader
 *      Platforms — the thirteen seeded values). THIS is the sanctioned
 *      surface for them (spec §5, the feasibility verdict: run source
 *      belongs on artist/entity surfaces, never in the platform cuts —
 *      the Analytics tab's brand-exclusion pin is untouched by this file).
 *   4. Creator leaderboard — payees ranked by window credits under the
 *      CohortRank standard-competition rule (ties share a rank, the next
 *      rank vacant), each row carrying its per-day credit series (the
 *      momentum sparkline's source, aligned with the trend's day range).
 *   5. Payout game log — per ledger transaction, newest first: day, payee,
 *      the run's unanimous entity, the line item's work title as the
 *      display label, the run's source, and the transaction's cents.
 *
 * Same derivation family as `companyAnalytics.ts`, `entityIntelligence.ts`,
 * and `analyticsFlows.ts` — the discipline is mirrored, not shared: the
 * journal scan, the holder-credit measure, the run resolution, and the
 * unanimity rules are re-implemented here privately so this module stays a
 * pure addition and the shipped modules stay untouched (zero edits to any
 * existing module; the section builder consumes this payload).
 *
 * THE MEASURE, stated once: `holderCreditOf` — the journal's vault-credit
 * sum over every rights-holder account (`vault:<payeeId>:<bucket>`), the
 * platform's own vault (`vault:platform:…`, the company dust and the
 * recoupment landings) excluded. This is the established creator-side
 * measure both sibling modules already group — the payee hop of record,
 * not a re-derived 35% approximation. Per-payee attribution reads the
 * SAME entries' account strings: the store's own
 * `vault:<payeeId>:<bucket>` format (vaultGlAccount) is the payee of
 * record for every credit leg. A vault credit whose account string cannot
 * carry a payee segment (malformed) still counts in the measure but
 * contributes to no payee row — attribution is never force-fitted onto a
 * malformed key. Because payee rows group the same entries the measure
 * sums, the leaders' credits sum to the KPI exactly on a well-formed
 * ledger — an invariant the tests pin.
 *
 * LABELS, never invented: the payeeId of record is the primary label. The
 * store-carried payee name (LedgerTransactionRecord.payee_name — the
 * chain of record's own field) rides along as a display label when the
 * store's ledger transactions carry it; when they don't, the label is
 * null and the section renders the payeeId. Work titles render as
 * line-item display labels only — the work identity of record is the
 * entity template, and no per-song accounting is claimed anywhere.
 *
 * Units: every money figure is integer CENTS as bigint — the ledger's own
 * unit, the engine-path money. Integer math only; nothing here divides,
 * formats, or converts (rendering belongs to the component).
 *
 * TIME: the anchor is the store's own clock — the newest royalty journal
 * timestamp in the scanned ledger (the siblings' treatment; the demo
 * seed's fixed instants would age out of wall-clock windows). Bounded
 * windows (7/30/90) are the anchor day inclusive going back; `null` is
 * ALL, unbounded.
 *
 * Honesty law: a run the store cannot resolve still counts in the KPIs,
 * the trend, and the per-payee totals (its vault accounts name their
 * payees) but contributes no source split and no game-log rows — its
 * missing facts are never fabricated. A mixed-entity run states the
 * unanimous null in its game-log rows; its per-line-item work titles stay
 * per-transaction facts of record. A cut with no rows is empty; a store
 * read that fails degrades the whole payload to the honest `null` (the
 * unavailable state, the siblings' treatment). No placeholder
 * attribution, no invented names, ever.
 */

import type { Store } from '@/lib/server/store';
import type {
  RoyaltyLineItemRecord,
  SplitRunRecord,
} from '@/lib/don/types';
import type { GlEntryRecord } from '@/modules/don/records';
import { entityRecordForWorkRef } from '@/lib/master/masterStore';
import type { SovereignAtomicEntity } from '@/lib/master/CovnantAtomicDataSDK';

// ─────────────────────────────────────────────────────────────────────────────
// The payload types — one safe read, bigint cents throughout, rendering
// happens downstream.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The page's window filter, in days — 7, 30, 90, or `null` for ALL.
 * Re-derives every KPI, chart, table, and row.
 */
export type CreatorWindowDays = 7 | 30 | 90 | null;

/** One leaderboard row — the payee's standing for the window. */
export interface CreatorPayoutRow {
  /** The vault account's payee segment — the attribution key of record. */
  readonly payeeId: string;
  /**
   * The store-carried payee name (the ledger transactions' payee_name of
   * record), or null when the store carries none — the section then
   * renders the payeeId. Never invented.
   */
  readonly label: string | null;
  /** Standard competition rank — ties share it, the next rank vacant. */
  readonly rank: number;
  /** Σ holder credits in window — the creator side of record. */
  readonly creditsCents: bigint;
  /** The distinct clearing runs of the window that credited this payee. */
  readonly runs: number;
  /** The payee's most recent clearing day in the window, `YYYY-MM-DD`. */
  readonly lastDay: string;
  /**
   * Per-day credits across the window's day range (zero-filled), oldest
   * first — index-aligned with the payload trend, the sparkline's source.
   */
  readonly series: readonly bigint[];
}

/** One trend point — a UTC day of record and the credits grouped under it. */
export interface CreatorTrendPoint {
  readonly day: string;
  readonly creatorCents: bigint;
}

/** One platform-source row — the run source of record, runs and credits. */
export interface CreatorSourceSplit {
  /** The split run's own source string of record (e.g. `Spotify`). */
  readonly source: string;
  readonly creatorCents: bigint;
  readonly runs: number;
}

/**
 * One game-log row — per ledger transaction (the payee allocation of
 * record), newest first. The nullable fields are the fail-closed states:
 * a run whose record is gone or whose line items disagree states the
 * missing fact as null rather than attributing it.
 */
export interface CreatorGameLogRow {
  /** The journal's UTC day of record, `YYYY-MM-DD`. */
  readonly day: string;
  readonly payeeId: string;
  /** The run's unanimous bound entity — null when unresolved or mixed. */
  readonly entityId: string | null;
  /** The transaction's line-item display label — null when the item is gone. */
  readonly workTitle: string | null;
  /** The run's own source of record — null when the run record is gone. */
  readonly source: string | null;
  /** The transaction's allocation cents of record. */
  readonly creatorCents: bigint;
}

/** The one safe payload — the whole Creator Analytics page derives from this alone. */
export interface CreatorAnalyticsFlows {
  readonly windowDays: CreatorWindowDays;
  /** Σ holder credits in window — creator paid, the payees' side of record. */
  readonly creatorPaidCents: bigint;
  /**
   * The same-window cleared gross of record — the journals' full credit
   * side (the zero-balance invariant makes it the runs' gross). The share
   * card's denominator; the holder credits are its payee-side subset.
   */
  readonly grossClearedCents: bigint;
  /** Payees with credits in the window. */
  readonly activePayees: number;
  /** Window runs whose journals carry holder credits. */
  readonly runsPaying: number;
  readonly trend: readonly CreatorTrendPoint[];
  readonly sourceSplits: readonly CreatorSourceSplit[];
  readonly leaders: readonly CreatorPayoutRow[];
  readonly gameLog: readonly CreatorGameLogRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger scan — the siblings' treatment, mirrored privately: the
// royalty journals, the holder-credit measure, and the per-entry payee
// attribution from the vault account of record.
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

/** The journal's full credit side — its cleared gross of record (zero-balance canon). */
function journalGrossOf(entries: readonly GlEntryRecord[] | undefined): bigint {
  let gross = 0n;
  for (const entry of entries ?? []) {
    if (entry.credit_cents > 0) gross += BigInt(entry.credit_cents);
  }
  return gross;
}

/**
 * The run's bound atomic entity records — resolved when EVERY line item
 * of the run resolves (the settlement shape of record: one asset per
 * run). A run whose line items resolve to nothing contributes no entity
 * attribution — the identity is never misattributed.
 */
function recordsOfLineItems(
  lineItems: readonly RoyaltyLineItemRecord[],
): readonly SovereignAtomicEntity[] | null {
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
 * The run's unanimous bound entity identity — the shared template id when
 * every record IS the same entity, null when they disagree (a mixed run
 * is never force-fitted to one entity).
 */
function unanimousEntityIdentity(
  records: readonly SovereignAtomicEntity[],
): string | null {
  if (records.length === 0) return null;
  const identity = records[0].templateId;
  for (const record of records) {
    if (record.templateId !== identity) return null;
  }
  return identity;
}

/** One cleared-run scan row — the journal of record plus its attributions. */
interface CreatorRunScan {
  /** The journal timestamp of record (the settlement instant). */
  readonly at: string;
  /** The journal's UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  /** The journal's holder-credit sum — the measure of record. */
  readonly holderCredit: bigint;
  /** The journal's full credit side — the cleared gross of record. */
  readonly grossCents: bigint;
  /** The run's own source of record — null when the run record is gone. */
  readonly source: string | null;
  /** Per-payee attribution of this journal's vault credits (well-formed keys only). */
  readonly creditsByPayee: ReadonlyMap<string, bigint>;
  /** The run's unanimous entity — null when unresolvable or mixed. */
  readonly entityId: string | null;
  /** Game-log rows — per royalty ledger transaction of a resolved run. */
  readonly transactions: readonly CreatorGameLogRow[];
  /** The store-carried payee names these transactions carry, payee_id keyed. */
  readonly labels: ReadonlyMap<string, string>;
}

/**
 * The ledger scan — every royalty-ingest journal with holder credits,
 * resolved to its run, its payees, and its per-transaction game-log rows.
 * Mirrors the siblings' scan exactly: runs resolved before they count,
 * the unanimity rule fails closed, unresolved runs keep their money in
 * the totals with no source or game-log attribution.
 */
async function scanCreatorRuns(store: Store): Promise<readonly CreatorRunScan[]> {
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

  const scans: CreatorRunScan[] = [];
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

    // The run's own join: source, line items, unanimous entity, and the
    // per-transaction game-log rows. An unresolved run contributes none
    // of these — its money stays in the KPIs and per-payee totals.
    const run =
      journal.ref_type === 'split_run' ? runOf.get(journal.id) : undefined;
    let source: string | null = null;
    let entityId: string | null = null;
    let transactions: CreatorGameLogRow[] = [];
    const labels = new Map<string, string>();
    if (run !== undefined) {
      source = run.source;
      const lineItems = await store.listRoyaltyLineItemsByRun(run.id);
      const records = recordsOfLineItems(lineItems);
      entityId = records === null ? null : unanimousEntityIdentity(records);
      const titleOfItem = new Map<string, string>();
      for (const lineItem of lineItems) {
        titleOfItem.set(lineItem.id, lineItem.work_title);
      }
      const ledger = await store.listLedgerTransactionsByRun(run.id);
      transactions = ledger
        .filter((tx) => tx.kind === 'royalty')
        .map((tx) => {
          if (tx.payee_name !== '') labels.set(tx.payee_id, tx.payee_name);
          return {
            day: journal.created_at.slice(0, 10),
            payeeId: tx.payee_id,
            entityId,
            workTitle: titleOfItem.get(tx.line_item_id) ?? null,
            source: run.source,
            creatorCents: BigInt(tx.amount_cents),
          };
        });
    }

    scans.push({
      at: journal.created_at,
      day: journal.created_at.slice(0, 10),
      holderCredit,
      grossCents: journalGrossOf(entries),
      source,
      creditsByPayee,
      entityId,
      transactions,
      labels,
    });
  }
  return scans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time — the store's own clock. The anchor is the newest royalty journal
// day in the scan; windows are UTC-day arithmetic off it, string-keyed on
// the journals' own ISO granularity (lexicographic order IS chronology).
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
      throw new Error(`creatorAnalytics: no window arm for ${String(unregistered)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The aggregations — pure folds over the window's scan rows.
// ─────────────────────────────────────────────────────────────────────────────

/** Group rows descending by credits, structural key as the tie-break (the cutFrom pattern). */
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
 * The day range the trend and every leader series span — bounded windows
 * fill from their start (gapless zeros); ALL fills from the first
 * activity day (no fabricated pre-history zeros). Returns [] for an
 * empty window (start === null with no rows).
 */
function dayRange(fillStart: string | null, anchorDay: string): readonly string[] {
  if (fillStart === null || fillStart > anchorDay) return [];
  const days: string[] = [];
  for (let day = fillStart; day <= anchorDay; day = shiftDay(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The leaderboard — the payees the window's journals credited, ranked by
 * the CohortRank standard-competition rule over window credits (ties
 * share the rank, the next rank vacant). Labels read the store-carried
 * payee names of record; a payee the ledger transactions never name
 * carries the honest null. Series are per-day credits across the trend's
 * day range — zero on days the payee didn't clear, so the sparkline has
 * no holes to interpolate across.
 */
function leadersFrom(
  windowRuns: readonly CreatorRunScan[],
  creditsByPayee: ReadonlyMap<string, bigint>,
  labels: ReadonlyMap<string, string>,
  fillStart: string | null,
  anchorDay: string,
): readonly CreatorPayoutRow[] {
  const perPayee = new Map<
    string,
    { creditsCents: bigint; runs: number; lastDay: string; perDay: Map<string, bigint> }
  >();
  for (const run of windowRuns) {
    for (const [payeeId, cents] of run.creditsByPayee) {
      const row =
        perPayee.get(payeeId) ??
        { creditsCents: 0n, runs: 0, lastDay: run.day, perDay: new Map<string, bigint>() };
      row.creditsCents += cents;
      row.runs += 1;
      if (run.day > row.lastDay) row.lastDay = run.day;
      row.perDay.set(run.day, (row.perDay.get(run.day) ?? 0n) + cents);
      perPayee.set(payeeId, row);
    }
  }
  const days = dayRange(fillStart, anchorDay);
  const rows: CreatorPayoutRow[] = [...perPayee.entries()].map(([payeeId, row]) => {
    // The CohortRank rule — 1 + the count of payees with a strictly
    // greater credit total; ties share the rank.
    let strictlyGreater = 0n;
    for (const [otherId, otherCredits] of creditsByPayee) {
      if (otherId !== payeeId && otherCredits > row.creditsCents) strictlyGreater += 1n;
    }
    return {
      payeeId,
      label: labels.get(payeeId) ?? null,
      rank: Number(1n + strictlyGreater),
      creditsCents: row.creditsCents,
      runs: row.runs,
      lastDay: row.lastDay,
      series: days.map((day) => row.perDay.get(day) ?? 0n),
    };
  });
  return rows.sort((a, b) => a.rank - b.rank || a.payeeId.localeCompare(b.payeeId));
}

/** The game log — one row per ledger transaction, newest first. */
function gameLogFrom(windowRuns: readonly CreatorRunScan[]): readonly CreatorGameLogRow[] {
  return windowRuns
    .flatMap((run) => run.transactions)
    .sort((a, b) =>
      a.day > b.day ? -1 : a.day < b.day ? 1 : a.payeeId.localeCompare(b.payeeId),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The creator analytics payload — the whole window-filtered read over one
 * store. Never throws on a store failure: it degrades to the honest
 * `null` (the unavailable state, the siblings' treatment). An empty
 * ledger yields the honest zero payload — zeroed KPIs and empty series,
 * the page's honest empty states.
 */
export async function creatorAnalytics(
  store: Store,
  windowDays: CreatorWindowDays,
): Promise<CreatorAnalyticsFlows | null> {
  let scan: readonly CreatorRunScan[];
  try {
    scan = await scanCreatorRuns(store);
  } catch {
    return null;
  }
  if (scan.length === 0) {
    return {
      windowDays,
      creatorPaidCents: 0n,
      grossClearedCents: 0n,
      activePayees: 0,
      runsPaying: 0,
      trend: [],
      sourceSplits: [],
      leaders: [],
      gameLog: [],
    };
  }

  // The store clock — the newest royalty journal day in the scan.
  const anchorDay = scan.reduce(
    (newest, run) => (run.day > newest ? run.day : newest),
    scan[0].day,
  );
  const startDay = windowStartDay(anchorDay, windowDays);
  const windowRuns =
    startDay === null
      ? scan
      : scan.filter((run) => run.day >= startDay && run.day <= anchorDay);
  // ALL fills its trend from the first activity day — no fabricated
  // pre-history zeros; bounded windows fill from their start.
  const fillStart =
    startDay ??
    scan.reduce((oldest, run) => (run.day < oldest ? run.day : oldest), scan[0].day);

  // The payee fold — window credits and the label hints the resolved
  // runs' ledger transactions carried (the store-carried names of record).
  const creditsByPayee = new Map<string, bigint>();
  const labels = new Map<string, string>();
  for (const run of windowRuns) {
    for (const [payeeId, cents] of run.creditsByPayee) {
      creditsByPayee.set(payeeId, (creditsByPayee.get(payeeId) ?? 0n) + cents);
    }
    for (const [payeeId, payeeName] of run.labels) {
      if (!labels.has(payeeId)) labels.set(payeeId, payeeName);
    }
  }

  // The KPIs — creator paid (the holder-credit measure), the window's
  // cleared gross of record, and the run counts.
  let creatorPaidCents = 0n;
  let grossClearedCents = 0n;
  let runsPaying = 0;
  for (const run of windowRuns) {
    creatorPaidCents += run.holderCredit;
    grossClearedCents += run.grossCents;
    runsPaying += 1;
  }

  // The trend — the window's holder credits grouped per day, gapless.
  const perDay = new Map<string, bigint>();
  for (const run of windowRuns) {
    perDay.set(run.day, (perDay.get(run.day) ?? 0n) + run.holderCredit);
  }
  const trend = dayRange(fillStart, anchorDay).map((day) => ({
    day,
    creatorCents: perDay.get(day) ?? 0n,
  }));

  // The platform-source cut — resolved runs only: a journal whose run
  // record is gone carries no source of record, so it attributes to no
  // source row (never force-fitted).
  const bySource = new Map<string, { creatorCents: bigint; runs: number }>();
  for (const run of windowRuns) {
    if (run.source === null) continue;
    const row = bySource.get(run.source) ?? { creatorCents: 0n, runs: 0 };
    row.creatorCents += run.holderCredit;
    row.runs += 1;
    bySource.set(run.source, row);
  }
  const sourceSplits = [...bySource.entries()]
    .map(([source, row]) => ({ source, creatorCents: row.creatorCents, runs: row.runs }))
    .sort((a, b) => byCreditsDesc(a, b, (row) => row.source));

  return {
    windowDays,
    creatorPaidCents,
    grossClearedCents,
    activePayees: creditsByPayee.size,
    runsPaying,
    trend,
    sourceSplits,
    leaders: leadersFrom(windowRuns, creditsByPayee, labels, fillStart, anchorDay),
    gameLog: gameLogFrom(windowRuns),
  };
}
