'use client';

/**
 * The Analytics tab — the Company Metrics & Analytics Elite Dashboard
 * (spec art_rRYEJBpS). The company's settlement instrument panel: six KPI
 * cards, the cleared-volume gradient area with paired creator/ops lines,
 * the flow-kind donut and industry bars, the promised-vs-cleared grouped
 * bars, the sortable entity leaderboard with heat-mapped momentum and
 * sparklines, and the per-run game log — all rendered from the
 * `companyAnalytics` derivation module's payload (the module owns the
 * math; this file renders props). The window filter (7/30/90/ALL) is a
 * client-side pick over the four pre-derived windows the page received —
 * it never re-fetches and never re-derives.
 *
 * Honesty law, in this file's own grammar: money renders only through
 * `formatCentsBigint`; an empty window says so in copy (never a blank
 * block, never a placeholder number); a class without a promised field
 * in canon states that; the structural cuts (KPIs, charts, leaderboard)
 * speak the platform's structural vocabulary only — counterparties never
 * render there. The game log is the run-level drilldown: its source
 * column is the run's own field of record, with honest dashes where the
 * record carries none.
 */

import { useState } from 'react';

import type { AnalyticsWindow, CompanyAnalytics, GameLogRow, LeaderboardRow } from '@/lib/admin/companyAnalytics';
import { formatCentsBigint } from '@/lib/money/format';
import { flowKindLabel } from '@/lib/master/flowKinds';
import type { EntityIntelligence } from '@/lib/admin/entityIntelligence';

import {
  AreaChart,
  ChartEmpty,
  Donut,
  GroupedBars,
  HBar,
  HeatCell,
  Sparkline,
  type GroupedBarRow,
} from '../analytics/primitives';
import { SectionEyebrow, SectionUnavailable } from '../shared';
import type { CompanyAnalyticsWindows, SectionData } from '../types';
import { CLASS_LABELS } from './IntelligenceSection';

/** The window-filter options — the derivation's registered windows, in display order. */
const WINDOW_OPTIONS: readonly { readonly id: AnalyticsWindow; readonly label: string }[] = [
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
  { id: 'all', label: 'ALL' },
];

/** The honest copy every empty block in an empty window renders — never a blank block. */
const EMPTY_WINDOW_COPY =
  'No runs cleared in this window — the charts and tables fill when the first run of the window clears.';

// ---------------------------------------------------------------------------
// Pure presentation helpers — exported and unit-tested; the JSX renders them.
// ---------------------------------------------------------------------------

/** A leaderboard column's sort state — the rank column's default order is rank ascending. */
export type LeaderboardSortKey = 'rank' | 'gross' | 'creator' | 'runs' | 'momentum';

export interface LeaderboardSort {
  readonly key: LeaderboardSortKey;
  readonly dir: 'asc' | 'desc';
}

/** The game log's sortable columns — day descending by default (newest first). */
export type GameLogSortKey = 'day' | 'gross' | 'creator';

export interface GameLogSort {
  readonly key: GameLogSortKey;
  readonly dir: 'asc' | 'desc';
}

function tieBreak(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The class vocabulary's display label. The derivation's `classLabel` is
 * a plain string (the module renders it union-free), while CLASS_LABELS
 * is keyed by the closed class union so a missing arm fails the
 * intelligence build — the bridge is a membership-guarded lookup that
 * falls back to the raw class key, never a miss-crash and never a cast
 * around an unguarded index.
 */
function classLabelOf(classKey: string): string {
  return classKey in CLASS_LABELS ? CLASS_LABELS[classKey as keyof typeof CLASS_LABELS] : classKey;
}

function byCents(dirFactor: 1 | -1, a: bigint, b: bigint): number {
  if (a === b) return 0;
  return (a > b ? 1 : -1) * dirFactor;
}

/**
 * The leaderboard's display order. Momentum nulls sort last in BOTH
 * directions — an entity with no prior window has no momentum to rank,
 * and a null must never masquerade as the best or worst momentum. Every
 * key falls back to the entity id so equal values keep a stable order.
 */
export function sortLeaderboard(rows: readonly LeaderboardRow[], sort: LeaderboardSort): readonly LeaderboardRow[] {
  const dirFactor: 1 | -1 = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'rank':
        return (a.rank - b.rank) * dirFactor || tieBreak(a.entityId, b.entityId);
      case 'gross':
        return byCents(dirFactor, a.grossCents, b.grossCents) || tieBreak(a.entityId, b.entityId);
      case 'creator':
        return byCents(dirFactor, a.creatorPaidCents, b.creatorPaidCents) || tieBreak(a.entityId, b.entityId);
      case 'runs':
        return (a.runCount - b.runCount) * dirFactor || tieBreak(a.entityId, b.entityId);
      case 'momentum': {
        if (a.momentum30 === null && b.momentum30 === null) return tieBreak(a.entityId, b.entityId);
        if (a.momentum30 === null) return 1;
        if (b.momentum30 === null) return -1;
        return (a.momentum30 - b.momentum30) * dirFactor || tieBreak(a.entityId, b.entityId);
      }
    }
  });
}

/** The game log's display order — newest first by default, ties broken by run id then day. */
export function sortGameLog(rows: readonly GameLogRow[], sort: GameLogSort): readonly GameLogRow[] {
  const dirFactor: 1 | -1 = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'day':
        return (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) * dirFactor || tieBreak(a.runId ?? '', b.runId ?? '');
      case 'gross':
        return byCents(dirFactor, a.grossCents, b.grossCents) || tieBreak(a.runId ?? '', b.runId ?? '');
      case 'creator':
        return byCents(dirFactor, a.creatorCents, b.creatorCents) || tieBreak(a.runId ?? '', b.runId ?? '');
    }
  });
}

/** The next sort state after a header click — same key flips, a new key starts at its natural order. */
export function nextLeaderboardSort(current: LeaderboardSort, key: LeaderboardSortKey): LeaderboardSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'rank' ? 'asc' : 'desc' };
}

/** The game log's natural order is day descending; a new key starts there. */
export function nextGameLogSort(current: GameLogSort, key: GameLogSortKey): GameLogSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'desc' };
}

/** Momentum as the cell's voice — '+' gains, a true minus sign for losses, a dash for no prior point. */
export function formatMomentumPercent(momentum: number | null): string {
  if (momentum === null) return '—';
  if (momentum === 0) return '0%';
  const sign = momentum > 0 ? '+' : '−';
  const grouped = Math.abs(momentum).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}%`;
}

/**
 * Momentum's heat intensity — a gain's share of the table's peak gain.
 * Nulls and losses render no heat (gold is the house's positive signal;
 * a loss shows its true sign in text, untinted).
 */
export function momentumHeat(momentum: number | null, peakMomentum: number): number {
  if (momentum === null || momentum <= 0 || peakMomentum <= 0) return 0;
  return Math.min(1, momentum / peakMomentum);
}

/**
 * A money column's heat intensity — the cell's floored share of the
 * column peak (bigint math, so a $2B run against a $8.4B ledger is
 * exact bigint division, never a float ratio of money).
 */
export function heatShare(cents: bigint, peakCents: bigint): number {
  if (peakCents <= 0n || cents <= 0n) return 0;
  return Number((cents * 100n) / peakCents) / 100;
}

/** The per-class cohort benchmark from the intelligence readouts — "3 of 9", or null when the readout is absent. */
export function cohortRankLabel(readouts: readonly EntityIntelligence[], entityId: string): string | null {
  const readout = readouts.find((r) => r.templateId === entityId);
  return readout === undefined ? null : `${readout.cohort.rank.toString()} of ${readout.cohort.of.toString()}`;
}

export interface PromisedClearedRow {
  readonly label: string;
  /** The class canon's promised value in bigint cents — null when no promised field exists. */
  readonly promisedCents: bigint | null;
  readonly clearedCents: bigint;
}

/**
 * The promised-vs-cleared rows: one per entity class on either side of
 * the comparison. Promised sums the readouts' own `promisedUSD` (already
 * bigint cents — the intelligence layer's canon field); cleared sums the
 * window's leaderboard rows. A class with cleared money but no promised
 * field renders the honest no-promised state; a class with a promise but
 * nothing cleared yet renders cleared zero — both truthful.
 */
export function promisedClearedRows(
  leaderboard: readonly LeaderboardRow[],
  readouts: readonly EntityIntelligence[],
): readonly PromisedClearedRow[] {
  const clearedByClass = new Map<string, bigint>();
  for (const row of leaderboard) {
    clearedByClass.set(row.classLabel, (clearedByClass.get(row.classLabel) ?? 0n) + row.grossCents);
  }
  const promisedByClass = new Map<string, bigint>();
  for (const readout of readouts) {
    if (readout.promisedUSD === null) continue;
    promisedByClass.set(readout.class, (promisedByClass.get(readout.class) ?? 0n) + readout.promisedUSD);
  }
  const classKeys = new Set<string>([...clearedByClass.keys(), ...promisedByClass.keys()]);
  return [...classKeys]
    .map((classKey) => ({
      label: classLabelOf(classKey),
      promisedCents: promisedByClass.get(classKey) ?? null,
      clearedCents: clearedByClass.get(classKey) ?? 0n,
    }))
    .sort(
      (a, b) =>
        (a.clearedCents === b.clearedCents ? 0 : a.clearedCents > b.clearedCents ? -1 : 1) ||
        tieBreak(a.label, b.label),
    );
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

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
 * the words, with label and copy flowing below it (IntelligenceSection's
 * ProfileBlock pattern). The rule element is height:1px; wrapping text
 * INSIDE it overflows the hairline and piles the header onto the block
 * below — text over text, text over table.
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

function SortHeaderButton({
  testid,
  label,
  sort,
  active,
  onClick,
}: {
  testid: string;
  label: string;
  sort: LeaderboardSort | GameLogSort;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" data-testid={testid} onClick={onClick} className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40 transition hover:text-gold-champagne">
      {label}
      {active ? <span className="ml-1 text-gold-champagne">{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}

function EmptyLine({ testid, children }: { testid: string; children: string }) {
  return (
    <div data-testid={testid} className="mt-4 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
      <ChartEmpty label={children} />
    </div>
  );
}

/**
 * The pure company page — every figure arrives in props. `analytics` is
 * the payload of the SELECTED window (its own `window` field lights the
 * filter); `intelligence` feeds the promised-vs-cleared comparison and
 * the per-class cohort ranks.
 */
export function CompanyAnalyticsView({
  analytics,
  intelligence,
  demo,
  onWindowChange,
  leaderboardSort,
  onLeaderboardSort,
  gameLogSort,
  onGameLogSort,
}: {
  analytics: CompanyAnalytics;
  intelligence: SectionData<readonly EntityIntelligence[]>;
  demo: boolean;
  onWindowChange: (window: AnalyticsWindow) => void;
  leaderboardSort: LeaderboardSort;
  onLeaderboardSort: (sort: LeaderboardSort) => void;
  gameLogSort: GameLogSort;
  onGameLogSort: (sort: GameLogSort) => void;
}) {
  const { kpis } = analytics;
  const emptyWindow = kpis.runCount === 0;
  const readouts = intelligence.kind === 'ready' ? intelligence.value : [];
  const intelligenceReady = intelligence.kind === 'ready';

  const leaderboardRows = emptyWindow ? [] : sortLeaderboard(analytics.leaderboard, leaderboardSort);
  const gameLogRows = emptyWindow ? [] : sortGameLog(analytics.gameLog, gameLogSort);
  const promisedRows = intelligenceReady ? promisedClearedRows(analytics.leaderboard, readouts).map(
    (row): GroupedBarRow => ({ label: row.label, promisedCents: row.promisedCents, clearedCents: row.clearedCents }),
  ) : [];
  const peakMomentum = analytics.leaderboard.reduce((peak, row) => Math.max(peak, row.momentum30 ?? 0), 0);
  const peakGross = analytics.gameLog.reduce((peak, row) => (row.grossCents > peak ? row.grossCents : peak), 0n);
  const peakCompany = analytics.gameLog.reduce((peak, row) => (row.companyCents > peak ? row.companyCents : peak), 0n);
  const totalRuns = analytics.leaderboard.reduce((sum, row) => sum + row.runCount, 0);
  const totalCleared = analytics.leaderboard.reduce((sum, row) => sum + row.grossCents, 0n);
  const totalCreator = analytics.leaderboard.reduce((sum, row) => sum + row.creatorPaidCents, 0n);

  return (
    <div aria-label="Analytics">
      {/* Header: eyebrow + window filter + disclosed demo badge. */}
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Company Analytics</SectionEyebrow>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-full border border-slate-600/50 p-1" data-testid="analytics-window-filter">
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`analytics-window-${option.id}`}
                aria-pressed={analytics.window === option.id}
                onClick={() => onWindowChange(option.id)}
                className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition ${
                  analytics.window === option.id ? 'bg-gold-champagne/15 text-gold-champagne' : 'text-white/40 hover:text-white/70'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {demo ? (
            <span
              data-testid="demo-data-badge"
              className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
            >
              Demo data
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/50">
        The company&apos;s cleared settlement ledger, read as one instrument panel — every card, chart, and cell
        derives from the GL journals and split runs through the real engine paths. Cleared money is the only stat.
      </p>

      {emptyWindow ? (
        <div data-testid="analytics-empty-window" className="mt-6 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
          <ChartEmpty label={EMPTY_WINDOW_COPY} />
        </div>
      ) : null}

      {/* Six KPI cards. */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="analytics-kpis">
        <KpiCard testid="analytics-kpi-total-cleared" label="Total cleared" value={formatCentsBigint(kpis.totalClearedCents)} note="Gross cleared across the window" />
        <KpiCard testid="analytics-kpi-creator-paid" label="Creator paid" value={formatCentsBigint(kpis.creatorPaidCents)} note="35% canon side of every run" />
        <KpiCard testid="analytics-kpi-ops-yield" label="Operations yield" value={formatCentsBigint(kpis.operationsYieldCents)} note="15% canon side of every run" />
        <KpiCard testid="analytics-kpi-company-reserve" label="Company reserve" value={formatCentsBigint(kpis.companyReserveCents)} note="50% canon side of every run" />
        <KpiCard testid="analytics-kpi-runs" label="Runs cleared" value={kpis.runCount.toLocaleString('en-US')} note="Split runs settled" />
        <KpiCard
          testid="analytics-kpi-avg-run"
          label="Avg run"
          value={kpis.avgRunCents === null ? '—' : formatCentsBigint(kpis.avgRunCents)}
          note={kpis.avgRunCents === null ? 'No runs cleared yet' : 'Per-run average'}
        />
      </div>

      {/* Cleared volume by day — the gradient area with paired thin lines. */}
      <div className="mt-10" data-testid="analytics-daily">
        <BlockHeader label="Cleared volume by day" copy="Gross cleared per day — the gold gradient area — with the creator (35%) and operations (15%) canon sides as paired thin lines." />
        <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
          <AreaChart
            series={emptyWindow ? [] : analytics.daily.map((point) => ({ label: point.day, valueCents: point.grossCents }))}
            pairedSeries={[
              { label: 'Creator paid', tone: 'champagne', points: analytics.daily.map((point) => point.creatorCents) },
              { label: 'Operations yield', tone: 'slate', points: analytics.daily.map((point) => point.opsCents) },
            ]}
            seriesLabel="Cleared gross"
            ariaLabel="Cleared volume by day"
            emptyLabel={EMPTY_WINDOW_COPY}
            xAxisMidTicks
          />
        </div>
      </div>

      {/* Flow-kind donut + industry bars. */}
      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <div data-testid="analytics-flow-kind">
          <BlockHeader label="By flow kind" copy="Gross cleared by the registered economic flow kind of the underlying asset — the clearinghouse's structural vocabulary." />
          <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <Donut
              rows={emptyWindow ? [] : analytics.flowKindSplit.map((split) => ({ label: flowKindLabel(split.kind), valueCents: split.grossCents }))}
              ariaLabel="Cleared gross by flow kind"
              emptyLabel={EMPTY_WINDOW_COPY}
            />
          </div>
        </div>
        <div data-testid="analytics-industry">
          <BlockHeader label="By industry" copy="Gross cleared by the bound entity class of the underlying asset." />
          <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <HBar
              rows={emptyWindow ? [] : analytics.industryTotals.map((industry) => ({ label: industry.label, valueCents: industry.grossCents }))}
              ariaLabel="Cleared gross by industry"
              emptyLabel={EMPTY_WINDOW_COPY}
            />
          </div>
        </div>
      </div>

      {/* Promised vs cleared per class — promised from the intelligence readouts, by import only. */}
      <div className="mt-10" data-testid="analytics-promised">
        <BlockHeader label="Promised vs cleared by class" copy="What the class canon promises beside what actually cleared in the window — classes without a promised field in canon say so." />
        <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
          {intelligenceReady ? (
            <GroupedBars rows={promisedRows} ariaLabel="Promised versus cleared by entity class" emptyLabel={EMPTY_WINDOW_COPY} />
          ) : (
            <p data-testid="analytics-promised-unavailable" className="text-[13px] leading-relaxed text-white/40">
              The promised readout is unavailable — the comparison renders when the intelligence read is back.
            </p>
          )}
        </div>
      </div>

      {/* Entity leaderboard — sortable, heat-mapped momentum, sparklines, total row. */}
      <div className="mt-10" data-testid="analytics-leaderboard">
        <BlockHeader label="Entity leaderboard" copy="Every cleared entity ranked by the window's cleared total — standard-competition ranks with ties preserved and the next rank vacant. Sort any column; the momentum cell carries the heat." />
        {leaderboardRows.length === 0 ? (
          <EmptyLine testid="analytics-leaderboard-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <table className="w-full min-w-[820px] border-collapse text-left" aria-label="Entity leaderboard">
              <thead>
                <tr className="border-b border-slate-600/50">
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Rank</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Entity</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Class</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Class rank</th>
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-leaderboard-sort-runs" label="Runs" sort={leaderboardSort} active={leaderboardSort.key === 'runs'} onClick={() => onLeaderboardSort(nextLeaderboardSort(leaderboardSort, 'runs'))} />
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-leaderboard-sort-gross" label="Cleared" sort={leaderboardSort} active={leaderboardSort.key === 'gross'} onClick={() => onLeaderboardSort(nextLeaderboardSort(leaderboardSort, 'gross'))} />
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-leaderboard-sort-creator" label="Creator paid" sort={leaderboardSort} active={leaderboardSort.key === 'creator'} onClick={() => onLeaderboardSort(nextLeaderboardSort(leaderboardSort, 'creator'))} />
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-leaderboard-sort-momentum" label="30-day momentum" sort={leaderboardSort} active={leaderboardSort.key === 'momentum'} onClick={() => onLeaderboardSort(nextLeaderboardSort(leaderboardSort, 'momentum'))} />
                  </th>
                  <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Trend</th>
                </tr>
              </thead>
              <tbody>
                {leaderboardRows.map((row) => (
                  <tr key={row.entityId} data-testid="analytics-leaderboard-row" className="border-b border-slate-600/30">
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100" data-rank={row.rank}>
                      {row.rank}
                      <span className="text-white/30"> / {row.rankOf}</span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-200">{row.entityId}</td>
                    <td className="py-2 pr-3 text-sm text-slate-300">{classLabelOf(row.classLabel)}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-white/50">{cohortRankLabel(readouts, row.entityId) ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100">{row.runCount}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-gold-champagne">{formatCentsBigint(row.grossCents)}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100">{formatCentsBigint(row.creatorPaidCents)}</td>
                    <HeatCell heat={momentumHeat(row.momentum30, peakMomentum)}>
                      <span className="font-mono text-sm text-slate-100">{formatMomentumPercent(row.momentum30)}</span>
                    </HeatCell>
                    <td className="py-2">
                      <Sparkline values={row.spark} ariaLabel={`${row.entityId} cleared history`} emptyLabel="No cleared history yet" />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="analytics-leaderboard-total" className="border-t border-gold-champagne/30">
                  <td className="py-2 pr-3 font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne" colSpan={4}>Total</td>
                  <td className="py-2 pr-3 font-mono text-sm text-slate-100">{totalRuns}</td>
                  <td className="py-2 pr-3 font-mono text-sm text-gold-champagne">{formatCentsBigint(totalCleared)}</td>
                  <td className="py-2 pr-3 font-mono text-sm text-slate-100">{formatCentsBigint(totalCreator)}</td>
                  <td className="py-2" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Game log — one row per cleared run; source is the run's own field of record. */}
      <div className="mt-10" data-testid="analytics-gamelog">
        <BlockHeader label="Game log" copy="Every split run the window cleared, newest first — the run-level drilldown. Source is the run's own field of record; a dash means the record carries none." />
        {gameLogRows.length === 0 ? (
          <EmptyLine testid="analytics-gamelog-empty">{EMPTY_WINDOW_COPY}</EmptyLine>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <table className="w-full min-w-[860px] border-collapse text-left" aria-label="Game log">
              <thead>
                <tr className="border-b border-slate-600/50">
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-gamelog-sort-day" label="Day" sort={gameLogSort} active={gameLogSort.key === 'day'} onClick={() => onGameLogSort(nextGameLogSort(gameLogSort, 'day'))} />
                  </th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Run</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Entity</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Class</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Flow kind</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Source</th>
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-gamelog-sort-gross" label="Gross" sort={gameLogSort} active={gameLogSort.key === 'gross'} onClick={() => onGameLogSort(nextGameLogSort(gameLogSort, 'gross'))} />
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    <SortHeaderButton testid="analytics-gamelog-sort-creator" label="Creator" sort={gameLogSort} active={gameLogSort.key === 'creator'} onClick={() => onGameLogSort(nextGameLogSort(gameLogSort, 'creator'))} />
                  </th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Ops</th>
                  <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Company</th>
                </tr>
              </thead>
              <tbody>
                {gameLogRows.map((row, index) => (
                  <tr key={row.runId ?? `${row.day}-${row.entityId}-${index}`} data-testid="analytics-gamelog-row" className="border-b border-slate-600/30">
                    <td className="py-2 pr-3 font-mono text-sm text-slate-300">{row.day}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-white/40">{row.runId ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-200">{row.entityId ?? '—'}</td>
                    <td className="py-2 pr-3 text-sm text-slate-300">{row.classLabel === null ? '—' : classLabelOf(row.classLabel)}</td>
                    <td className="py-2 pr-3 text-sm text-slate-300">{row.flowKind === null ? '—' : flowKindLabel(row.flowKind)}</td>
                    <td className="py-2 pr-3 text-sm text-slate-300">{row.source ?? '—'}</td>
                    <HeatCell heat={heatShare(row.grossCents, peakGross)}>
                      <span className="font-mono text-sm text-gold-champagne">{formatCentsBigint(row.grossCents)}</span>
                    </HeatCell>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100">{formatCentsBigint(row.creatorCents)}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-100">{formatCentsBigint(row.opsCents)}</td>
                    <HeatCell heat={heatShare(row.companyCents, peakCompany)}>
                      <span className="font-mono text-sm text-slate-100">{formatCentsBigint(row.companyCents)}</span>
                    </HeatCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Analytics tab's mount — the stateful wrapper over the pure view.
 * The window filter and both sort states live here; every window the
 * page can show was already derived server-side before first paint.
 */
export function AnalyticsSection({
  analytics,
  intelligence,
  demo,
}: {
  analytics: SectionData<CompanyAnalyticsWindows>;
  intelligence: SectionData<readonly EntityIntelligence[]>;
  demo: boolean;
}) {
  const [windowId, setWindowId] = useState<AnalyticsWindow>('all');
  const [leaderboardSort, setLeaderboardSort] = useState<LeaderboardSort>({ key: 'rank', dir: 'asc' });
  const [gameLogSort, setGameLogSort] = useState<GameLogSort>({ key: 'day', dir: 'desc' });

  if (analytics.kind === 'unavailable') {
    return (
      <div aria-label="Analytics">
        <div className="flex items-center justify-between gap-3">
          <SectionEyebrow>Company Analytics</SectionEyebrow>
          {demo ? (
            <span
              data-testid="demo-data-badge"
              className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
            >
              Demo data
            </span>
          ) : null}
        </div>
        <div className="mt-8" data-testid="analytics-unavailable">
          <SectionUnavailable code={analytics.code} message={analytics.message} />
        </div>
      </div>
    );
  }

  return (
    <CompanyAnalyticsView
      analytics={analytics.value[windowId]}
      intelligence={intelligence}
      demo={demo}
      onWindowChange={setWindowId}
      leaderboardSort={leaderboardSort}
      onLeaderboardSort={setLeaderboardSort}
      gameLogSort={gameLogSort}
      onGameLogSort={setGameLogSort}
    />
  );
}
