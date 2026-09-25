'use client';

/**
 * The Creator Analytics tab — the creator side of the clearing ledger
 * (spec art_UccVWZpj). The payees' instrument panel over the SAME engine
 * paths the Analytics tab renders for the company: KPI cards, the payout
 * trend area, the platform-source bars, the rights-holder leaderboard with
 * per-day momentum sparklines and heat, and the per-transaction game log —
 * all rendered from the `creatorAnalytics` derivation module's payload
 * (the module owns the math; this file renders props). The window filter
 * (7/30/90/ALL) is a client-side pick over the four pre-derived windows
 * the page received — it never re-fetches and never re-derives.
 *
 * Honesty law, this file's own grammar: money renders only through
 * `formatCentsBigint`; the share card is the primitives' integer share
 * (bigint percent, sub-1% states "<1%" — never a float ratio of money);
 * ranks render verbatim from the module (standard competition, ties
 * preserved, next rank vacant — never re-ranked here); a payee renders
 * its store-carried name or its payeeId, never an invented display name;
 * a missing record states a dash. Empty is copy, never a blank block.
 * The platform-source bars are the SANCTIONED surface for the run-source
 * brand strings of record (spec §5) — the Analytics tab's structural cuts
 * stay brand-free and its exclusion pin is untouched by this file.
 */

import { useEffect, useState } from 'react';

import type {
  CreatorAnalyticsFlows,
  CreatorGameLogRow,
  CreatorPayoutRow,
  CreatorWindowDays,
} from '@/lib/admin/creatorAnalytics';
import { formatCentsBigint } from '@/lib/money/format';

import {
  AreaChart,
  ChartEmpty,
  HBar,
  HeatCell,
  Sparkline,
  shareLabel,
} from '../analytics/primitives';
import { SectionEyebrow, SectionUnavailable } from '../shared';
import type {
  CatalogGrowthWindows,
  CreatorAnalyticsWindowId,
  CreatorAnalyticsWindows,
  SectionData,
} from '../types';
import type {
  ActionSignal,
  CatalogGrowthFlows,
  CatalogRecoupmentRow,
} from '@/lib/admin/catalogGrowth';

/** The window-filter options — the page's pre-derived creator windows, in display order. */
const WINDOW_OPTIONS: readonly {
  readonly id: CreatorAnalyticsWindowId;
  readonly days: CreatorWindowDays;
  readonly label: string;
}[] = [
  { id: '7d', days: 7, label: '7D' },
  { id: '30d', days: 30, label: '30D' },
  { id: '90d', days: 90, label: '90D' },
  { id: 'all', days: null, label: 'ALL' },
];

/** The honest copy every empty block in an empty window renders — never a blank block. */
const EMPTY_WINDOW_COPY =
  'No creator payouts cleared in this window — the panels fill when the first run of the window clears.';

// ---------------------------------------------------------------------------
// Pure presentation helpers — exported and unit-tested; the JSX renders them.
// ---------------------------------------------------------------------------

/**
 * The payee's display voice — the store-carried name of record when the
 * ledger transactions carry one, else the payeeId of record. Never an
 * invented display name.
 */
export function payeeDisplayName(label: string | null, payeeId: string): string {
  return label ?? payeeId;
}

/**
 * A money column's heat intensity — the cell's floored integer-percent
 * share of the column peak (bigint math, never a float ratio of money).
 * The sibling section's mirror of the same helper: presentation kit is
 * per-file, mirrored not shared.
 */
export function heatShare(cents: bigint, peakCents: bigint): number {
  if (peakCents <= 0n || cents <= 0n) return 0;
  return Number((cents * 100n) / peakCents) / 100;
}

/** The game log's page size — the pagination contract, 25 rows per page. */
export const GAME_LOG_PAGE_SIZE = 25;

/** One game-log row's filter arms — `null` is that arm's honest "no filter". */
export interface GameLogFilters {
  readonly payeeId: string | null;
  readonly entityCode: string | null;
  readonly source: string | null;
}

/**
 * The game log's entity code — the entity id's `TPL-XXX` family prefix
 * (TPL-MUS-001 filters under TPL-MUS). A row carrying no entity id has no
 * code (it matches only by the other arms); a non-template id is its own
 * code. Never invented — the id of record is cut, not renamed.
 */
export function entityCodeOf(entityId: string | null): string | null {
  if (entityId === null) return null;
  const match = /^TPL-[A-Z0-9]+/.exec(entityId);
  return match === null ? entityId : match[0];
}

/**
 * The game log's AND predicate — every set arm must match the row, and an
 * arm the row cannot carry (no entity code, no source) never matches.
 * Rows the filters cannot attribute are excluded honestly, never
 * force-fitted into a bucket.
 */
export function gameLogRowMatches(row: CreatorGameLogRow, filters: GameLogFilters): boolean {
  if (filters.payeeId !== null && row.payeeId !== filters.payeeId) return false;
  if (filters.entityCode !== null && entityCodeOf(row.entityId) !== filters.entityCode) return false;
  if (filters.source !== null && (row.source === null || row.source !== filters.source)) return false;
  return true;
}

/** Payee options — the payload's leaderboard payees plus any payee the log itself lists, sorted. */
export function payeeFilterOptions(
  leaders: readonly CreatorPayoutRow[],
  rows: readonly CreatorGameLogRow[],
): readonly string[] {
  const ids = new Set<string>();
  for (const leader of leaders) ids.add(leader.payeeId);
  for (const row of rows) ids.add(row.payeeId);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Entity-code options — the TPL-XXX families present in the log's own rows, sorted. */
export function entityCodeOptions(rows: readonly CreatorGameLogRow[]): readonly string[] {
  const codes = new Set<string>();
  for (const row of rows) {
    const code = entityCodeOf(row.entityId);
    if (code !== null) codes.add(code);
  }
  return [...codes].sort((a, b) => a.localeCompare(b));
}

/** Source options — the run sources present in the log's own rows, sorted. */
export function sourceFilterOptions(rows: readonly CreatorGameLogRow[]): readonly string[] {
  const sources = new Set<string>();
  for (const row of rows) {
    if (row.source !== null) sources.add(row.source);
  }
  return [...sources].sort((a, b) => a.localeCompare(b));
}

/** The page clamp — 1..pageCount, a stale page never renders out of bounds. */
export function clampedPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pageCount));
}

/**
 * The pager's count line — the filtered totals' own arithmetic, verbatim:
 * `Showing 1–25 of 124 transactions`.
 */
export function gameLogCountLine(start: number, end: number, total: number): string {
  return `Showing ${start}–${end} of ${total} transaction${total === 1 ? '' : 's'}`;
}

/** The source bars' deterministic cut — the primary group and the tail. */
export interface SourceSplitGroups<T> {
  readonly primary: readonly T[];
  readonly tail: readonly T[];
}

/**
 * The source bars' deterministic cut — a source is PRIMARY when its value
 * is at least 1/100 of the window's top source (bigint math:
 * `valueCents × 100 ≥ top`, exact — no float, no floor), the rest are the
 * TAIL. Both groups keep the module's descending order; an empty tail is
 * the caller's signal to render the single list exactly as before.
 */
export function splitSourceRows<T extends { valueCents: bigint }>(
  rows: readonly T[],
): SourceSplitGroups<T> {
  const top = rows.reduce((peak, row) => (row.valueCents > peak ? row.valueCents : peak), 0n);
  const primary = rows.filter((row) => row.valueCents * 100n >= top);
  return { primary, tail: rows.filter((row) => row.valueCents * 100n < top) };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────────
// Catalog Growth OS — pure presentation helpers. The payload's measured
// facts (bigint cents, integer bps, engine flags) are the record; these
// format them for the modules. No money arithmetic happens here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The window filter's id for a derivation window of record — the view's
 * index into the page's pre-derived windows and the statement link's
 * window parameter. Exhaustive over the derivation's window arms.
 */
export function windowIdOf(windowDays: CreatorWindowDays): CreatorAnalyticsWindowId {
  switch (windowDays) {
    case 7:
      return '7d';
    case 30:
      return '30d';
    case 90:
      return '90d';
    case null:
      return 'all';
    default: {
      const unregistered: never = windowDays;
      throw new Error(`CreatorAnalyticsSection: no window id for ${String(unregistered)}`);
    }
  }
}

/** The audit statement route — per-payee, window-aware, under /admin. */
export function auditStatementHref(payeeId: string, windowId: CreatorAnalyticsWindowId): string {
  const params = new URLSearchParams({ payee: payeeId, window: windowId });
  return `/admin/audit-statement?${params.toString()}`;
}

/**
 * The recoupment bar's fill share, 0–100 — integer bigint math, floored,
 * capped at 100 (a bar never overflows its track). A non-positive target
 * (no measurable threshold) fills nothing.
 */
export function recoupmentShare(appliedCents: bigint, targetCents: bigint): number {
  if (targetCents <= 0n || appliedCents <= 0n) return 0;
  const share = Number((appliedCents * 100n) / targetCents);
  return share > 100 ? 100 : share;
}

/**
 * The delta chip's label — the payload's own integer basis points voiced
 * as a signed percent. The sign is never dropped: a negative delta reads
 * negative, honestly. Zero is exactly '0%' — neither gain nor loss.
 */
export function deltaChipLabel(basisPoints: number): string {
  if (basisPoints === 0) return '0%';
  const sign = basisPoints < 0 ? '-' : '+';
  const abs = Math.abs(basisPoints);
  const whole = Math.floor(abs / 100);
  const hundredths = abs % 100;
  const decimals = hundredths === 0 ? 0 : hundredths % 10 === 0 ? 1 : 2;
  return `${sign}${(whole + hundredths / 100).toFixed(decimals)}%`;
}

/**
 * The action signals banner — the tab's top strip. Measured statements
 * only, rendered verbatim; a null basisPoints renders NO chip (the ALL
 * window never shows one); empty signals render NOTHING — no placeholder
 * strip, no filler.
 */
function SignalsBanner({ signals }: { signals: readonly ActionSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <div
      className="mt-6 rounded-2xl border border-gold-champagne/30 bg-gold-champagne/[0.06] p-4"
      data-testid="creator-analytics-signals"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">Action signals</p>
      <ul className="mt-2 space-y-2">
        {signals.map((signal, index) => (
          <li
            key={`${signal.kind}-${signal.subjectLabel}-${index}`}
            data-testid="creator-analytics-signal"
            data-signal-kind={signal.kind}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span className="text-sm text-slate-100">{signal.headline}</span>
            {signal.basisPoints === null ? null : (
              <span
                data-testid="creator-analytics-signal-bps"
                className={`font-mono text-xs ${signal.basisPoints < 0 ? 'text-red-300' : 'text-emerald-300'}`}
              >
                {deltaChipLabel(signal.basisPoints)}
              </span>
            )}
            <span className="font-mono text-[11px] text-white/40">{signal.subjectLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The recoupment bar — the engine's applied-vs-threshold share of record. */
function RecoupmentBar({ appliedCents, targetCents }: { appliedCents: bigint; targetCents: bigint }) {
  const share = recoupmentShare(appliedCents, targetCents);
  return (
    <span
      className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-600/40"
      data-testid="creator-analytics-recoupment-bar"
      data-share={share}
      role="presentation"
    >
      <span
        className="block h-full rounded-full bg-gradient-to-r from-gold-champagne/80 to-gold/60"
        style={{ width: `${share}%` }}
      />
    </span>
  );
}

/**
 * Recoupment by Catalog — per advance-carrying payee, the engine's own
 * state of record: applied against the break-even threshold, the
 * unrecouped balance, the fully-recouped verdict. Payees the window
 * credited without an advance render the honest line — never a
 * zero-balance imitation.
 */
function RecoupmentPanel({
  rows,
  withoutAdvanceIds,
}: {
  rows: readonly CatalogRecoupmentRow[];
  withoutAdvanceIds: readonly string[];
}) {
  return (
    <div className="mt-10" data-testid="creator-analytics-recoupment">
      <BlockHeader
        label="Recoupment by catalog"
        copy="Each advance-carrying payee against the recoupment engine's own sweep state — net earnings applied toward the break-even threshold of record. A payee without an advance on file says so; no zero-balance imitation."
      />
      {rows.length === 0 && withoutAdvanceIds.length === 0 ? (
        <EmptyLine testid="creator-analytics-recoupment-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
      ) : (
        <div className="mt-3 space-y-3">
          {rows.map((row) => (
            <div
              key={row.payeeId}
              data-testid="creator-analytics-recoupment-row"
              data-fully-recouped={row.fullyRecouped ? 'true' : 'false'}
              className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm text-slate-200">{payeeDisplayName(row.label, row.payeeId)}</span>
                {row.fullyRecouped ? (
                  <span
                    data-testid="creator-analytics-recoupment-state"
                    className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300"
                  >
                    Fully recouped
                  </span>
                ) : (
                  <span data-testid="creator-analytics-recoupment-state" className="font-mono text-xs text-white/50">
                    {formatCentsBigint(row.unrecoupedCents)} unrecouped
                  </span>
                )}
              </div>
              <div className="mt-3">
                <RecoupmentBar appliedCents={row.appliedCents} targetCents={row.advanceTargetCents} />
              </div>
              <p className="mt-2 font-mono text-[11px] text-white/40">
                {formatCentsBigint(row.appliedCents)} applied of {formatCentsBigint(row.advanceTargetCents)} break-even
                · last sweep {row.lastSweepDay ?? '—'}
              </p>
            </div>
          ))}
          {withoutAdvanceIds.map((payeeId) => (
            <p
              key={payeeId}
              data-testid="creator-analytics-recoupment-no-advance"
              className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4 font-mono text-sm text-white/50"
            >
              {payeeId}: No advance on file
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Top Markets — the territory fold over SDK-settled events ONLY, under
 * the standing coverage label. The three honest states: no SDK-settled
 * events at all; events that carry no territory stamps; and the ranked
 * markets with the unattributed money never silently dropped.
 */
function TopMarketsPanel({ markets }: { markets: CatalogGrowthFlows['topMarkets'] }) {
  const { markets: rows, unattributedCents, settlementsConsidered } = markets;
  const barRows: readonly { label: string; valueCents: bigint }[] = rows.map((market) => ({
    label: market.territory,
    valueCents: market.creatorCents,
  }));
  return (
    <div className="mt-10" data-testid="creator-analytics-top-markets">
      <BlockHeader
        label="Top markets"
        copy="Creator credits per market across the SDK-settled events' own territory stamps of record. Markets absent from that data are absent here, honestly — the chart never implies complete geographic coverage."
      />
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40" data-testid="creator-analytics-markets-coverage">
        SDK-settled events only · {settlementsConsidered} settlement{settlementsConsidered === 1 ? '' : 's'} considered
      </p>
      {rows.length === 0 ? (
        settlementsConsidered === 0 ? (
          <EmptyLine testid="creator-analytics-markets-empty">
            No SDK-settled events in this window — no market data exists to chart.
          </EmptyLine>
        ) : (
          <EmptyLine testid="creator-analytics-markets-unstamped">
            {unattributedCents > 0n
              ? `${settlementsConsidered} SDK-settled event${settlementsConsidered === 1 ? '' : 's'} carr${settlementsConsidered === 1 ? 'ies' : 'y'} no territory stamps — no market data exists to chart.`
              : 'No market data exists to chart.'}
          </EmptyLine>
        )
      ) : (
        <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
          <HBar rows={barRows} ariaLabel="Creator credits by market" emptyLabel="No SDK-settled market data" />
        </div>
      )}
      {unattributedCents > 0n ? (
        <p className="mt-3 font-mono text-[11px] text-white/40" data-testid="creator-analytics-markets-unattributed">
          {formatCentsBigint(unattributedCents)} of SDK-settled creator credits carry no territory stamp and chart
          under no market.
        </p>
      ) : null}
    </div>
  );
}

function KpiCard({ testid, label, value, note }: { testid: string; label: string; value: string; note: string }) {
  return (
    <div
      data-testid={testid}
      className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">{label}</p>
      <p className="mt-2 font-mono text-base tracking-tighter text-gold-champagne" title={value}>
        {value}
      </p>
      <p className="mt-1 font-mono text-[10px] text-white/30">{note}</p>
    </div>
  );
}

/**
 * The section-header rhythm — the gold rule is a standalone hairline ABOVE
 * the words, with label and copy flowing below it (the 3a6ab00 fix, copied
 * exactly from the sibling section). The rule element is height:1px;
 * wrapping text INSIDE it overflows the hairline and piles the header onto
 * the block below — text over text, text over table.
 */
function BlockHeader({ label, copy }: { label: string; copy: string }) {
  return (
    <div>
      <div className="gold-rule w-64" aria-hidden="true" />
      <p className="mt-8 font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">{label}</p>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-white/40">{copy}</p>
    </div>
  );
}

function EmptyLine({ testid, children }: { testid: string; children: string }) {
  return (
    <div data-testid={testid} className="mt-4 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
      <ChartEmpty label={children} />
    </div>
  );
}

/** The demo-door disclosure badge — the Analytics and Intelligence tabs' own badge markup. */
function DemoBadge() {
  return (
    <span
      data-testid="demo-data-badge"
      className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
    >
      Demo data
    </span>
  );
}

/** The pager buttons' voice — the window filter's own pill treatment, bound-aware. */
const PAGER_BUTTON_CLASS =
  'rounded-full border border-slate-600/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-white/60 transition hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40';

/** The log filters' select treatment — the IntelligenceSection selector's own classes. */
const FILTER_SELECT_CLASS =
  'mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-gold';

/** One filter arm's options — the operator's active selection always stays selectable, even when the window's data no longer carries it. */
function withActiveOption(options: readonly string[], active: string): readonly string[] {
  if (active === '' || options.includes(active)) return options;
  return [...options, active].sort((a, b) => a.localeCompare(b));
}

/**
 * The game log's sticky filter sub-header — three AND-ed arms (payee of
 * record, the entity's TPL-XXX family code, the run's source of record)
 * in the established select treatment. It sticks inside the log's card so
 * the arms stay in reach while the log scrolls; empty arms state their
 * honest "all" rather than hiding.
 */
function GameLogFilterBar({
  payeeOptions,
  entityOptions,
  sourceOptions,
  payeeValue,
  entityValue,
  sourceValue,
  onPayeeChange,
  onEntityChange,
  onSourceChange,
}: {
  payeeOptions: readonly string[];
  entityOptions: readonly string[];
  sourceOptions: readonly string[];
  payeeValue: string;
  entityValue: string;
  sourceValue: string;
  onPayeeChange: (value: string) => void;
  onEntityChange: (value: string) => void;
  onSourceChange: (value: string) => void;
}) {
  return (
    <div
      data-testid="creator-analytics-gamelog-filters"
      className="sticky top-0 z-10 -mx-5 -mt-5 mb-4 rounded-t-2xl border-b border-slate-600/50 bg-obsidian-950/95 px-5 pb-4 pt-4 backdrop-blur-sm"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Payee</span>
          <select
            data-testid="creator-analytics-gamelog-filter-payee"
            aria-label="Filter the game log by payee"
            value={payeeValue}
            onChange={(event) => onPayeeChange(event.target.value)}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All payees</option>
            {withActiveOption(payeeOptions, payeeValue).map((payeeId) => (
              <option key={payeeId} value={payeeId}>
                {payeeId}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Entity</span>
          <select
            data-testid="creator-analytics-gamelog-filter-entity"
            aria-label="Filter the game log by entity code"
            value={entityValue}
            onChange={(event) => onEntityChange(event.target.value)}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All entities</option>
            {withActiveOption(entityOptions, entityValue).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Source</span>
          <select
            data-testid="creator-analytics-gamelog-filter-source"
            aria-label="Filter the game log by source"
            value={sourceValue}
            onChange={(event) => onSourceChange(event.target.value)}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All sources</option>
            {withActiveOption(sourceOptions, sourceValue).map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

/**
 * The game log's client-side pagination and filters — the 124-row seed log
 * scales without redesigning the table: the module's newest-first rows,
 * AND-filtered by the three arms, 25 per page with the count line and the
 * bound-aware Prev/Next pair beneath. The page resets to 1 whenever the
 * filters or the window's rows change; a zero-row filter result renders
 * the honest empty line, never fake rows, and dash-when-null rows still
 * render their dashes. Filter state is the panel's own — the rows stay
 * the module's order, never re-sorted here.
 */
function GameLogPanel({
  rows,
  peakCents,
  payeeOptions,
  entityOptions,
  sourceOptions,
}: {
  rows: readonly CreatorGameLogRow[];
  peakCents: bigint;
  payeeOptions: readonly string[];
  entityOptions: readonly string[];
  sourceOptions: readonly string[];
}) {
  const [payeeFilter, setPayeeFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(1);

  const filteredRows = rows.filter((row) =>
    gameLogRowMatches(row, {
      payeeId: payeeFilter === '' ? null : payeeFilter,
      entityCode: entityFilter === '' ? null : entityFilter,
      source: sourceFilter === '' ? null : sourceFilter,
    }),
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / GAME_LOG_PAGE_SIZE));
  const safePage = clampedPage(page, pageCount);
  const pageStart = (safePage - 1) * GAME_LOG_PAGE_SIZE;
  const pageRows = filteredRows.slice(pageStart, pageStart + GAME_LOG_PAGE_SIZE);

  // The page is window dressing over the rows — any change to the filters
  // or the window's own rows resets it to the first page.
  useEffect(() => {
    setPage(1);
  }, [payeeFilter, entityFilter, sourceFilter, rows]);

  const filterBar = (
    <GameLogFilterBar
      payeeOptions={payeeOptions}
      entityOptions={entityOptions}
      sourceOptions={sourceOptions}
      payeeValue={payeeFilter}
      entityValue={entityFilter}
      sourceValue={sourceFilter}
      onPayeeChange={setPayeeFilter}
      onEntityChange={setEntityFilter}
      onSourceChange={setSourceFilter}
    />
  );

  if (filteredRows.length === 0) {
    return (
      <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
        {filterBar}
        <p data-testid="creator-analytics-gamelog-filter-empty" className="py-2 text-sm text-white/40">
          No transactions match the filters — clear a filter to widen the log.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
      {filterBar}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left" aria-label="Creator payout game log">
          <thead>
            <tr className="border-b border-slate-600/50">
              <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Day</th>
              <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Payee</th>
              <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Entity</th>
              <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Work</th>
              <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Source</th>
              <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Creator paid</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, index) => (
              <tr key={`${row.day}-${row.payeeId}-${index}`} data-testid="creator-analytics-gamelog-row" className="border-b border-slate-600/30">
                <td className="py-2 pr-3 font-mono text-sm text-slate-300">{row.day}</td>
                <td className="py-2 pr-3 font-mono text-sm text-slate-200">{row.payeeId}</td>
                <td className="py-2 pr-3 font-mono text-sm text-slate-200">{row.entityId ?? '—'}</td>
                <td className="py-2 pr-3 text-sm text-slate-300">{row.workTitle ?? '—'}</td>
                <td className="py-2 pr-3 text-sm text-slate-300">{row.source ?? '—'}</td>
                <HeatCell heat={heatShare(row.creatorCents, peakCents)}>
                  <span className="font-mono text-sm text-gold-champagne">{formatCentsBigint(row.creatorCents)}</span>
                </HeatCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3" data-testid="creator-analytics-gamelog-pager">
        <p data-testid="creator-analytics-gamelog-count" className="font-mono text-[11px] text-white/40">
          {gameLogCountLine(pageStart + 1, pageStart + pageRows.length, filteredRows.length)}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="creator-analytics-gamelog-prev"
            onClick={() => setPage((current) => clampedPage(current - 1, pageCount))}
            disabled={safePage === 1}
            className={PAGER_BUTTON_CLASS}
          >
            Prev
          </button>
          <button
            type="button"
            data-testid="creator-analytics-gamelog-next"
            onClick={() => setPage((current) => clampedPage(current + 1, pageCount))}
            disabled={safePage === pageCount}
            className={PAGER_BUTTON_CLASS}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The pure creator page — every figure arrives in props. `flows` is the
 * payload of the SELECTED window (its own `windowDays` field lights the
 * filter). A zero window renders honest zeros in the KPI row and copy in
 * every panel — never a blank block, never a placeholder number.
 */
export function CreatorAnalyticsView({
  flows,
  growth,
  demo,
  onWindowChange,
}: {
  flows: CreatorAnalyticsFlows;
  growth: CatalogGrowthFlows;
  demo: boolean;
  onWindowChange: (window: CreatorAnalyticsWindowId) => void;
}) {
  const emptyWindow = flows.runsPaying === 0;
  const trendPoints: readonly { readonly day: string; readonly creatorCents: bigint }[] = emptyWindow ? [] : flows.trend;
  const sourceRows: readonly { readonly source: string; readonly creatorCents: bigint }[] = emptyWindow ? [] : flows.sourceSplits;
  const leaders: readonly CreatorPayoutRow[] = emptyWindow ? [] : flows.leaders;
  const gameLogRows: readonly CreatorGameLogRow[] = emptyWindow ? [] : flows.gameLog;
  const peakCredits = leaders.reduce((peak, row) => (row.creditsCents > peak ? row.creditsCents : peak), 0n);
  const peakLogCents = gameLogRows.reduce((peak, row) => (row.creatorCents > peak ? row.creatorCents : peak), 0n);
  const totalRuns = leaders.reduce((sum, row) => sum + row.runs, 0);
  const totalCredits = leaders.reduce((sum, row) => sum + row.creditsCents, 0n);
  // The sparklines' tooltip labels — the trend's days of record, index-aligned
  // with every leader row's series (the derivation's alignment contract).
  const trendDays = flows.trend.map((point) => point.day);
  // The source bars' deterministic primary/tail cut — mapped to the bar rows
  // first, so the groups carry exactly what HBar draws.
  const sourceBarRows = sourceRows.map((split) => ({ label: split.source, valueCents: split.creatorCents }));
  const { primary: primarySources, tail: tailSources } = splitSourceRows(sourceBarRows);
  // The window filter's id of record — the statement links' window parameter.
  const windowId = windowIdOf(flows.windowDays);

  return (
    <div aria-label="Creator Analytics">
      {/* Header: eyebrow + window filter + disclosed demo badge. */}
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Creator Analytics</SectionEyebrow>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-full border border-slate-600/50 p-1" data-testid="creator-analytics-window-filter">
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`creator-analytics-window-${option.id}`}
                aria-pressed={flows.windowDays === option.days}
                onClick={() => onWindowChange(option.id)}
                className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition ${
                  flows.windowDays === option.days ? 'bg-gold-champagne/15 text-gold-champagne' : 'text-white/40 hover:text-white/70'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {demo ? <DemoBadge /> : null}
        </div>
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/50">
        The creators&apos; side of the cleared settlement ledger — every card, chart, and cell derives from the GL
        journals, split runs, line items, and ledger transactions through the real engine paths. Attribution is the
        vault account&apos;s payee of record; the label is the store-carried name, else the payee id — never invented.
      </p>

      {/* Action signals — the tab's top strip; renders nothing when the window has no signals. */}
      <SignalsBanner signals={growth.actionSignals} />

      {/* Four KPI cards — a zero window renders zeros, not blanks. */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="creator-analytics-kpis">
        <KpiCard
          testid="creator-analytics-kpi-creator-paid"
          label="Creator paid (window)"
          value={formatCentsBigint(flows.creatorPaidCents)}
          note="Holder credits — the payees' side of record"
        />
        <KpiCard
          testid="creator-analytics-kpi-share"
          label="Creator share of cleared gross"
          value={shareLabel(flows.creatorPaidCents, flows.grossClearedCents)}
          note="Of the window's cleared gross of record"
        />
        <KpiCard
          testid="creator-analytics-kpi-payees"
          label="Active payees"
          value={flows.activePayees.toLocaleString('en-US')}
          note="Rights holders credited in the window"
        />
        <KpiCard
          testid="creator-analytics-kpi-runs"
          label="Runs paying creators"
          value={flows.runsPaying.toLocaleString('en-US')}
          note="Split runs settled with holder credits"
        />
      </div>

      {/* Recoupment by Catalog — the engine's own advance state per payee. */}
      <RecoupmentPanel rows={growth.recoupmentByCatalog} withoutAdvanceIds={growth.payeesWithoutAdvanceIds} />

      {/* Top Markets — the territory fold over SDK-settled events only. */}
      <TopMarketsPanel markets={growth.topMarkets} />

      {/* Creator payout trend — the daily holder-credit area. */}
      <div className="mt-10" data-testid="creator-analytics-trend">
        <BlockHeader label="Creator payout trend" copy="Creator credits per day across the window — gapless: a day with no settlement is an honest zero point the chart never interpolates across." />
        {trendPoints.length === 0 ? (
          <EmptyLine testid="creator-analytics-trend-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
        ) : (
          <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <AreaChart
              series={flows.trend.map((point) => ({ label: point.day, valueCents: point.creatorCents }))}
              seriesLabel="Creator paid"
              ariaLabel="Creator payout trend"
              emptyLabel={EMPTY_WINDOW_COPY}
            />
          </div>
        )}
      </div>

      {/* Where creator money comes from — the run sources of record. THIS is the sanctioned brand surface. */}
      <div className="mt-10" data-testid="creator-analytics-sources">
        <BlockHeader label="Where creator money comes from" copy="Creator credits by the split runs' own platform sources of record — the sanctioned surface for these names. A run whose record is gone attributes to no source; its money stays in the totals above." />
        {sourceRows.length === 0 ? (
          <EmptyLine testid="creator-analytics-sources-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
        ) : tailSources.length === 0 ? (
          // No tail — the single list renders exactly as before, no sub-labels.
          <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <HBar
              rows={sourceBarRows}
              ariaLabel="Creator credits by platform source"
              emptyLabel={EMPTY_WINDOW_COPY}
            />
          </div>
        ) : (
          // Primary and tail, each scaled to its own max — the tail's
          // TikTok-scale bars stay readable without a dishonest log scale.
          <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <div data-testid="creator-analytics-sources-primary">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Primary DSPs</p>
              <HBar
                rows={primarySources}
                ariaLabel="Creator credits by primary platform source"
                emptyLabel={EMPTY_WINDOW_COPY}
              />
            </div>
            <div data-testid="creator-analytics-sources-tail" className="mt-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Tail distribution</p>
              <HBar
                rows={tailSources}
                ariaLabel="Creator credits by tail platform sources"
                emptyLabel={EMPTY_WINDOW_COPY}
              />
            </div>
          </div>
        )}
      </div>

      {/* Creator leaderboard — module ranks verbatim, momentum sparklines, heat, total row. */}
      <div className="mt-10" data-testid="creator-analytics-leaders">
        <BlockHeader label="Creator leaderboard" copy="Every rights holder the window credited, ranked by the derivation's standard-competition ranks — ties share a rank, the next rank vacant. The trend cell carries the per-day credit series; the total reconciles to the KPI above." />
        {leaders.length === 0 ? (
          <EmptyLine testid="creator-analytics-leaders-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <table className="w-full min-w-[680px] border-collapse text-left" aria-label="Creator leaderboard">
              <thead>
                <tr className="border-b border-slate-600/50">
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Rank</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Payee</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Runs</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Last clearing</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Creator paid</th>
                  <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Trend</th>
                  <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Export</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((row) => (
                  <tr key={row.payeeId} data-testid="creator-analytics-leaderboard-row" className="border-b border-slate-600/30">
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100" data-rank={row.rank}>
                      {row.rank}
                    </td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-200">{payeeDisplayName(row.label, row.payeeId)}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100">{row.runs}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-white/50">{row.lastDay}</td>
                    <HeatCell heat={heatShare(row.creditsCents, peakCredits)}>
                      <span className="font-mono text-sm text-gold-champagne">{formatCentsBigint(row.creditsCents)}</span>
                    </HeatCell>
                    <td className="py-2">
                      <Sparkline
                        values={row.series}
                        pointLabels={trendDays}
                        ariaLabel={`${payeeDisplayName(row.label, row.payeeId)} credit history`}
                        emptyLabel="No credit history yet"
                      />
                    </td>
                    <td className="py-2">
                      <a
                        data-testid="creator-analytics-export-link"
                        data-payee={row.payeeId}
                        href={auditStatementHref(row.payeeId, windowId)}
                        className="font-mono text-xs text-gold-champagne underline decoration-gold-champagne/40 underline-offset-4 transition hover:decoration-gold-champagne"
                      >
                        Export
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="creator-analytics-leaderboard-total" className="border-t border-gold-champagne/30">
                  <td className="py-2 pr-3 font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne" colSpan={2}>Total</td>
                  <td className="py-2 pr-3 font-mono text-sm text-slate-100">{totalRuns}</td>
                  <td className="py-2 pr-3" />
                  <td className="py-2 pr-3 font-mono text-sm text-gold-champagne">{formatCentsBigint(totalCredits)}</td>
                  <td className="py-2" />
                  <td className="py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Game log — one row per royalty ledger transaction, module order (newest first). */}
      <div className="mt-10" data-testid="creator-analytics-gamelog">
        <BlockHeader label="Creator payout game log" copy="Every royalty ledger transaction the window cleared, newest first — the payee-level drilldown. The entity, the work title, and the source are the records' own fields; a dash means the record carries none." />
        {gameLogRows.length === 0 ? (
          <EmptyLine testid="creator-analytics-gamelog-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
        ) : (
          <GameLogPanel
            rows={gameLogRows}
            peakCents={peakLogCents}
            payeeOptions={payeeFilterOptions(leaders, gameLogRows)}
            entityOptions={entityCodeOptions(gameLogRows)}
            sourceOptions={sourceFilterOptions(gameLogRows)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The Creator Analytics tab's mount — the stateful wrapper over the pure
 * view. The window filter lives here; every window the page can show was
 * already derived server-side before first paint.
 */
export function CreatorAnalyticsSection({
  creatorAnalytics,
  catalogGrowth,
  demo,
}: {
  creatorAnalytics: SectionData<CreatorAnalyticsWindows>;
  catalogGrowth: SectionData<CatalogGrowthWindows>;
  demo: boolean;
}) {
  const [windowId, setWindowId] = useState<CreatorAnalyticsWindowId>('all');

  if (creatorAnalytics.kind === 'unavailable') {
    return (
      <div aria-label="Creator Analytics">
        <div className="flex items-center justify-between gap-3">
          <SectionEyebrow>Creator Analytics</SectionEyebrow>
          {demo ? <DemoBadge /> : null}
        </div>
        <div className="mt-8" data-testid="creator-analytics-unavailable">
          <SectionUnavailable code={creatorAnalytics.code} message={creatorAnalytics.message} />
        </div>
      </div>
    );
  }

  // The growth layer's own fail-closed state — the same honest wrapper,
  // carrying the growth read's code and message of record.
  if (catalogGrowth.kind === 'unavailable') {
    return (
      <div aria-label="Creator Analytics">
        <div className="flex items-center justify-between gap-3">
          <SectionEyebrow>Creator Analytics</SectionEyebrow>
          {demo ? <DemoBadge /> : null}
        </div>
        <div className="mt-8" data-testid="creator-analytics-unavailable">
          <SectionUnavailable code={catalogGrowth.code} message={catalogGrowth.message} />
        </div>
      </div>
    );
  }

  return (
    <CreatorAnalyticsView
      flows={creatorAnalytics.value[windowId]}
      growth={catalogGrowth.value[windowId]}
      demo={demo}
      onWindowChange={setWindowId}
    />
  );
}
