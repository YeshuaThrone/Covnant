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

import { useState } from 'react';

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
import type { CreatorAnalyticsWindowId, CreatorAnalyticsWindows, SectionData } from '../types';

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
      <p className="mt-2 truncate font-mono text-base text-gold-champagne" title={value}>
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

/**
 * The pure creator page — every figure arrives in props. `flows` is the
 * payload of the SELECTED window (its own `windowDays` field lights the
 * filter). A zero window renders honest zeros in the KPI row and copy in
 * every panel — never a blank block, never a placeholder number.
 */
export function CreatorAnalyticsView({
  flows,
  demo,
  onWindowChange,
}: {
  flows: CreatorAnalyticsFlows;
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
        ) : (
          <div className="mt-3 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <HBar
              rows={flows.sourceSplits.map((split) => ({ label: split.source, valueCents: split.creatorCents }))}
              ariaLabel="Creator credits by platform source"
              emptyLabel={EMPTY_WINDOW_COPY}
            />
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
                      <Sparkline values={row.series} ariaLabel={`${payeeDisplayName(row.label, row.payeeId)} credit history`} emptyLabel="No credit history yet" />
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
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
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
                {gameLogRows.map((row, index) => (
                  <tr key={`${row.day}-${row.payeeId}-${index}`} data-testid="creator-analytics-gamelog-row" className="border-b border-slate-600/30">
                    <td className="py-2 pr-3 font-mono text-sm text-slate-300">{row.day}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-200">{row.payeeId}</td>
                    <td className="py-2 pr-3 font-mono text-sm text-slate-200">{row.entityId ?? '—'}</td>
                    <td className="py-2 pr-3 text-sm text-slate-300">{row.workTitle ?? '—'}</td>
                    <td className="py-2 pr-3 text-sm text-slate-300">{row.source ?? '—'}</td>
                    <HeatCell heat={heatShare(row.creatorCents, peakLogCents)}>
                      <span className="font-mono text-sm text-gold-champagne">{formatCentsBigint(row.creatorCents)}</span>
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
 * The Creator Analytics tab's mount — the stateful wrapper over the pure
 * view. The window filter lives here; every window the page can show was
 * already derived server-side before first paint.
 */
export function CreatorAnalyticsSection({
  creatorAnalytics,
  demo,
}: {
  creatorAnalytics: SectionData<CreatorAnalyticsWindows>;
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

  return (
    <CreatorAnalyticsView
      flows={creatorAnalytics.value[windowId]}
      demo={demo}
      onWindowChange={setWindowId}
    />
  );
}
