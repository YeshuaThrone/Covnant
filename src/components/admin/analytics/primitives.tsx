/**
 * Company analytics chart primitives — the hand-rolled SVG kit for the
 * elite company metrics page (2026-09-23 founder directive: analytics
 * pages that feel like a professional analyst's instrument panel).
 *
 * Zero chart dependencies by design (no recharts, no d3, no chart.js):
 * every mark is drawn in the house language — dark obsidian surfaces,
 * slate tracks, gold gradient fills — scaled by bigint integer math, and
 * every money figure is the caller's store data through the ledger's
 * `formatCentsBigint`. Nothing is fabricated and nothing is a blank
 * block: each primitive renders its `emptyLabel` copy when handed no
 * data, and a derivation with no promised value says so honestly.
 *
 * Pure presentational: props in, marks out. No store reads, no fetch,
 * no state. The derivation module owns the math; these only draw it.
 *
 * Geometry discipline: display figures NEVER ride the coordinate math —
 * scales are integer bigint fixed-point, pixel outputs only. Colors are
 * the theme tokens from src/app/globals.css pinned here as constants:
 *   --color-gold: #d4af37 · --color-gold-champagne: #f3e5ab
 *   --color-gold-muted: #997a15 · Tailwind slate-700: rgb(51 65 85)
 */

import type { ReactNode } from 'react';
import { formatCentsBigint } from '@/lib/money/format';

// ─── House palette anchors (src/app/globals.css @theme) ─────────────────────

const GOLD = '#d4af37'; // --color-gold
const GOLD_CHAMPAGNE = '#f3e5ab'; // --color-gold-champagne
const GOLD_MUTED = '#997a15'; // --color-gold-muted
const SLATE_TRACK = 'rgb(51 65 85 / 0.5)'; // slate-700/50 — the strip track tone
const SLATE_LABEL = '#94a3b8'; // slate-400 — axis/label tone

/** The segment tone ladder — champagne first, then the gold family fading. */
const SEGMENT_LADDER: readonly { readonly fill: string; readonly opacity: number }[] = [
  { fill: GOLD_CHAMPAGNE, opacity: 1 },
  { fill: GOLD, opacity: 0.95 },
  { fill: GOLD, opacity: 0.7 },
  { fill: GOLD, opacity: 0.5 },
  { fill: GOLD_MUTED, opacity: 0.85 },
  { fill: GOLD_MUTED, opacity: 0.6 },
];

/** The honest empty state — house copy card, never a blank block. */
export function ChartEmpty({ label }: { label: string }) {
  return (
    <div
      role="status"
      data-testid="chart-empty"
      className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 text-sm text-white/40"
    >
      {label}
    </div>
  );
}

// ─── Shared derivations ──────────────────────────────────────────────────────

/**
 * Bar width — the value's integer-percent share of the chart's peak
 * (bigint numerator over bigint denominator — never a float). A nonzero
 * value shows at least a 1% sliver (the platform's visibility floor) so
 * small moments stay on the chart; zero stays honestly at zero.
 */
export function barWidthPercent(valueCents: bigint, peakCents: bigint): number {
  if (peakCents <= 0n || valueCents <= 0n) return 0;
  return Math.max(1, Number((valueCents * 100n) / peakCents));
}

const snap = (v: number): number => Math.round(v * 100) / 100;

/** The larger of two bigint cents — Math.max cannot take bigints. */
function biggestCents(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export interface AreaPointGeometry {
  readonly x: number;
  readonly y: number;
}

/**
 * Series coordinates — even x spacing across the plot width, y scaled
 * against the peak by integer bigint fixed-point (no float division).
 * An explicit peak lets paired series share the main series' scale so
 * their relative magnitudes stay truthful; an all-zero series sits on
 * the baseline. A single point centers.
 */
export function areaSeriesPoints(
  values: readonly bigint[],
  plotWidth: number,
  plotHeight: number,
  peak?: bigint,
): readonly AreaPointGeometry[] {
  const count = values.length;
  if (count === 0) return [];
  const peakCents = peak ?? values.reduce((m, v) => (v > m ? v : m), 0n);
  const height = BigInt(Math.max(0, Math.trunc(plotHeight)));
  return values.map((valueCents, i) => ({
    x: count === 1 ? plotWidth / 2 : (i * plotWidth) / (count - 1),
    y:
      peakCents <= 0n
        ? plotHeight
        : plotHeight - Number((valueCents * height) / peakCents),
  }));
}

function linePathFor(points: readonly AreaPointGeometry[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${snap(p.x)},${snap(p.y)}`)
    .join(' ');
}

function areaPathFor(points: readonly AreaPointGeometry[], baselineY: number): string {
  if (points.length === 0) return '';
  const last = points[points.length - 1];
  const first = points[0];
  return `${linePathFor(points)} L${snap(last.x)},${snap(baselineY)} L${snap(first.x)},${snap(baselineY)} Z`;
}

/** Polyline "x,y x,y" points — the shared scale `peak` keeps paired lines truthful. */
export function polylinePoints(
  values: readonly bigint[],
  width: number,
  height: number,
  peak?: bigint,
): string {
  return areaSeriesPoints(values, width, height, peak)
    .map((p) => `${snap(p.x)},${snap(p.y)}`)
    .join(' ');
}

/** Polyline "x,y x,y" points for the sparkline (1px inset so strokes stay inside). */
export function sparklinePoints(values: readonly bigint[], width: number, height: number): string {
  const inset = 1;
  return areaSeriesPoints(values, Math.max(0, width - inset * 2), Math.max(0, height - inset * 2))
    .map((p) => `${snap(p.x + inset)},${snap(p.y + inset)}`)
    .join(' ');
}

// ─── AreaChart ───────────────────────────────────────────────────────────────

export interface AreaSeriesPoint {
  readonly label: string;
  readonly valueCents: bigint;
}

/** A thin paired line under the area — same scale as the main series. */
export interface PairedLineSeries {
  readonly label: string;
  readonly tone: 'champagne' | 'slate';
  readonly points: readonly bigint[];
}

/** An interior axis tick — the label text plus its position as a 0..1 fraction of the plot width. */
export interface MidTick {
  readonly label: string;
  readonly fraction: number;
}

/**
 * Interior x-axis tick labels — `tickCount` evenly spaced positions strictly
 * between the series' first and last points (the edges keep their own
 * endpoint labels). A `YYYY-MM-DD` day of record renders as its MM-DD
 * form; any other label passes through verbatim — nothing is reformatted
 * by guess. Duplicate positions collapse so a short series never stacks
 * two ticks on one spot.
 */
export function midTickLabels(labels: readonly string[], tickCount = 5): readonly MidTick[] {
  const count = labels.length;
  if (tickCount <= 0 || count < 3) return [];
  const ticks: MidTick[] = [];
  const seen = new Set<number>();
  for (let k = 1; k <= tickCount; k += 1) {
    const index = Math.round((k * (count - 1)) / (tickCount + 1));
    if (index <= 0 || index >= count - 1 || seen.has(index)) continue;
    seen.add(index);
    const raw = labels[index];
    ticks.push({ label: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.slice(5) : raw, fraction: index / (count - 1) });
  }
  return ticks;
}

const PAIRED_TONES: Record<PairedLineSeries['tone'], string> = {
  champagne: GOLD_CHAMPAGNE,
  slate: SLATE_LABEL,
};

/**
 * Cleared volume over time — the gradient area under a gold line, on the
 * slate baseline track. Renders EVERY point (gold dots), pairs optional
 * thin line series on the main scale, and labels the first and last x
 * positions. `xAxisMidTicks` opts into evenly spaced interior date ticks
 * between the endpoints (default off — the first/last-only treatment is
 * unchanged for existing consumers). The wrapper's aria-label carries the
 * exact window total.
 */
export function AreaChart({
  series,
  pairedSeries,
  seriesLabel = 'Cleared',
  ariaLabel,
  emptyLabel,
  width = 720,
  height = 240,
  gradientId = 'covnant-area-gold-gradient',
  xAxisMidTicks = false,
}: {
  series: readonly AreaSeriesPoint[];
  pairedSeries?: readonly PairedLineSeries[];
  seriesLabel?: string;
  ariaLabel: string;
  emptyLabel: string;
  width?: number;
  height?: number;
  gradientId?: string;
  xAxisMidTicks?: boolean;
}) {
  if (series.length === 0) return <ChartEmpty label={emptyLabel} />;

  const PAD_X = 8;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 22;
  const plotWidth = width - PAD_X * 2;
  const plotHeight = height - PAD_TOP - PAD_BOTTOM;

  const values = series.map((p) => p.valueCents);
  const peak = values.reduce((m, v) => (v > m ? v : m), 0n);
  const geometry = areaSeriesPoints(values, plotWidth, plotHeight);
  const total = values.reduce((sum, v) => sum + v, 0n);

  return (
    <div
      data-testid="chart-area"
      role="img"
      aria-label={`${ariaLabel} — ${formatCentsBigint(total)} ${seriesLabel.toLowerCase()} across ${series.length} points`}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GOLD_CHAMPAGNE} stopOpacity={0.5} />
            <stop offset="100%" stopColor={GOLD} stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <g transform={`translate(${PAD_X}, ${PAD_TOP})`}>
          <rect
            data-testid="chart-area-track"
            x={0}
            y={plotHeight - 2}
            width={plotWidth}
            height={4}
            rx={2}
            fill={SLATE_TRACK}
          />
          <path
            data-testid="chart-area-fill"
            d={areaPathFor(geometry, plotHeight)}
            fill={`url(#${gradientId})`}
          />
          <path
            data-testid="chart-area-line"
            d={linePathFor(geometry)}
            fill="none"
            stroke={GOLD}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {(pairedSeries ?? []).map((line) => (
            <polyline
              key={line.label}
              data-testid="chart-area-paired-line"
              data-paired-label={line.label}
              points={polylinePoints(line.points, plotWidth, plotHeight, peak)}
              fill="none"
              stroke={PAIRED_TONES[line.tone]}
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {geometry.map((p, i) => (
            <circle
              key={series[i].label}
              data-testid="chart-area-point"
              cx={snap(p.x)}
              cy={snap(p.y)}
              r={3}
              fill={GOLD}
            />
          ))}
        </g>
        <text x={PAD_X} y={height - 6} fontSize={11} fill={SLATE_LABEL}>
          {series[0].label}
        </text>
        {(xAxisMidTicks ? midTickLabels(series.map((p) => p.label)) : []).map((tick) => (
          <text
            key={`chart-area-mid-tick-${tick.fraction}`}
            data-testid="chart-area-mid-tick"
            x={snap(PAD_X + tick.fraction * plotWidth)}
            y={height - 6}
            fontSize={11}
            fill={SLATE_LABEL}
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}
        <text x={width - PAD_X} y={height - 6} fontSize={11} fill={SLATE_LABEL} textAnchor="end">
          {series[series.length - 1].label}
        </text>
      </svg>
      <div
        data-testid="chart-area-legend"
        className="mt-2 flex flex-wrap items-center gap-4 font-mono text-[11px] text-white/50"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-gold" aria-hidden="true" />
          {seriesLabel}
        </span>
        {(pairedSeries ?? []).map((line) => (
          <span key={line.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: PAIRED_TONES[line.tone] }}
              aria-hidden="true"
            />
            {line.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

/**
 * The leaderboard's per-entity history — a tiny gold polyline. An empty
 * history renders the honest copy, never a blank cell.
 */
export function Sparkline({
  values,
  ariaLabel,
  emptyLabel,
  width = 96,
  height = 28,
}: {
  values: readonly bigint[];
  ariaLabel: string;
  emptyLabel: string;
  width?: number;
  height?: number;
}) {
  if (values.length === 0) {
    return (
      <span role="status" data-testid="chart-sparkline-empty" className="font-mono text-xs text-white/40">
        {emptyLabel}
      </span>
    );
  }
  return (
    <svg
      data-testid="chart-sparkline"
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      className="block h-7 w-24"
    >
      <polyline
        data-testid="chart-sparkline-line"
        points={sparklinePoints(values, width, height)}
        fill="none"
        stroke={GOLD}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Donut ───────────────────────────────────────────────────────────────────

export interface DonutRow {
  readonly label: string;
  readonly valueCents: bigint;
}

/**
 * Segment angles in integer degrees, clockwise from 12 o'clock — the
 * arcs always close the ring to exactly 360. A nonzero row floors at a
 * 1° sliver (drift rebalanced on the largest segment); a zero row is
 * honestly 0°, drawn as nothing.
 */
export function donutAngles(values: readonly bigint[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0n);
  if (total <= 0n) return values.map(() => 0);
  const angles = values.map((v) => (v > 0n ? Math.max(1, Number((v * 360n) / total)) : 0));
  const drift = 360 - angles.reduce((sum, a) => sum + a, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < angles.length; i += 1) if (angles[i] > angles[biggest]) biggest = i;
    angles[biggest] = Math.max(1, angles[biggest] + drift);
  }
  return angles;
}

/** The legend share's voice — sub-1% shares state that, never a lying "0%". */
export function shareLabel(valueCents: bigint, totalCents: bigint): string {
  if (totalCents <= 0n || valueCents <= 0n) return '0%';
  const percent = Number((valueCents * 100n) / totalCents);
  return percent === 0 ? '<1%' : `${percent}%`;
}

/**
 * The composition donut — arcs from the rows (dasharray ring segments on
 * the slate track ring), a legend of labels with exact formatted values
 * and honest shares. An empty row set or an all-zero total renders the
 * empty copy: no arcs are fabricated from nothing.
 */
export function Donut({
  rows,
  ariaLabel,
  emptyLabel,
  size = 200,
  ring = 26,
  format = formatCentsBigint,
}: {
  rows: readonly DonutRow[];
  ariaLabel: string;
  emptyLabel: string;
  size?: number;
  ring?: number;
  format?: (cents: bigint) => string;
}) {
  const total = rows.reduce((sum, r) => sum + r.valueCents, 0n);
  if (rows.length === 0 || total <= 0n) return <ChartEmpty label={emptyLabel} />;

  const angles = donutAngles(rows.map((r) => r.valueCents));
  const radius = (size - ring) / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  return (
    <div data-testid="chart-donut" className="flex flex-wrap items-center gap-6">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${ariaLabel} — ${formatCentsBigint(total)} across ${rows.length} kinds`}
        focusable="false"
      >
        <circle cx={center} cy={center} r={radius} fill="none" stroke={SLATE_TRACK} strokeWidth={ring} />
        {rows.map((row, i) => {
          const angle = angles[i];
          if (angle <= 0) return null;
          const arcLength = (angle / 360) * circumference;
          const tone = SEGMENT_LADDER[i % SEGMENT_LADDER.length];
          const cumulative = angles.slice(0, i).reduce((sum, a) => sum + a, 0);
          return (
            <circle
              key={row.label}
              data-testid="chart-donut-segment"
              data-start-angle={cumulative}
              data-end-angle={cumulative + angle}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={tone.fill}
              strokeOpacity={tone.opacity}
              strokeWidth={ring}
              strokeDasharray={`${arcLength} ${circumference - arcLength}`}
              transform={`rotate(${cumulative - 90} ${center} ${center})`}
            />
          );
        })}
      </svg>
      <ul aria-label={ariaLabel} className="min-w-0 flex-1 space-y-2">
        {rows.map((row, i) => {
          const tone = SEGMENT_LADDER[i % SEGMENT_LADDER.length];
          return (
            <li
              key={row.label}
              data-testid="chart-donut-legend-row"
              className="flex items-center gap-3 text-sm"
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: tone.fill, opacity: tone.opacity }}
                aria-hidden="true"
              />
              <span className="flex-1 text-slate-200">{row.label}</span>
              <span className="shrink-0 font-mono text-slate-100">{format(row.valueCents)}</span>
              <span className="w-10 shrink-0 text-right font-mono text-xs text-white/40">
                {shareLabel(row.valueCents, total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── HBar ────────────────────────────────────────────────────────────────────

export interface HBarRow {
  readonly label: string;
  readonly valueCents: bigint;
}

/** The strip track + gold gradient fill treatment, exactly as the house strips. */
const GOLD_FILL_CLASS = 'block h-full rounded-full bg-gradient-to-r from-gold-champagne/80 to-gold/60';

/**
 * Horizontal bars — one row per label, width proportional to the row
 * peak, exact formatted value at the right. The industry-cut treatment.
 */
export function HBar({
  rows,
  ariaLabel,
  emptyLabel,
  format = formatCentsBigint,
}: {
  rows: readonly HBarRow[];
  ariaLabel: string;
  emptyLabel: string;
  format?: (cents: bigint) => string;
}) {
  if (rows.length === 0) return <ChartEmpty label={emptyLabel} />;
  const peak = rows.reduce((m, r) => (r.valueCents > m ? r.valueCents : m), 0n);
  return (
    <div data-testid="chart-hbar">
      <ul role="list" aria-label={ariaLabel}>
        {rows.map((row) => (
          <li key={row.label} data-testid="chart-hbar-row" className="flex items-center gap-3 py-2">
            <span className="w-40 shrink-0 truncate text-sm text-slate-200">{row.label}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-700/50">
              <span
                data-testid="chart-hbar-fill"
                className={GOLD_FILL_CLASS}
                style={{ width: `${barWidthPercent(row.valueCents, peak)}%` }}
              />
            </span>
            <span className="shrink-0 font-mono text-sm text-slate-100">{format(row.valueCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── GroupedBars ─────────────────────────────────────────────────────────────

export interface GroupedBarRow {
  readonly label: string;
  /** The canon promised value — null when the class carries no promised field. */
  readonly promisedCents: bigint | null;
  readonly clearedCents: bigint;
}

/**
 * Promised vs cleared — two bars per category on one shared scale (the
 * peak across BOTH series, so the comparison stays truthful). A class
 * without a promised field in canon states that honestly in place of the
 * promised bar — never a fabricated comparison.
 */
export function GroupedBars({
  rows,
  ariaLabel,
  emptyLabel,
  format = formatCentsBigint,
}: {
  rows: readonly GroupedBarRow[];
  ariaLabel: string;
  emptyLabel: string;
  format?: (cents: bigint) => string;
}) {
  if (rows.length === 0) return <ChartEmpty label={emptyLabel} />;
  const peak = rows.reduce(
    (m, r) => biggestCents(m, biggestCents(r.clearedCents, r.promisedCents ?? 0n)),
    0n,
  );
  return (
    <div data-testid="chart-grouped">
      <div
        data-testid="chart-grouped-legend"
        className="mb-3 flex items-center gap-4 font-mono text-[11px] text-white/50"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-slate-300/80" aria-hidden="true" />
          Promised
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-gold" aria-hidden="true" />
          Cleared
        </span>
      </div>
      <ul role="list" aria-label={ariaLabel}>
        {rows.map((row) => (
          <li key={row.label} data-testid="chart-grouped-row" className="py-2">
            <span className="block truncate text-sm text-slate-200">{row.label}</span>
            {row.promisedCents === null ? (
              <span
                data-testid="chart-grouped-promised-null"
                className="mt-1 block text-[13px] leading-relaxed text-white/40"
              >
                No promised value in canon — cleared production stands alone.
              </span>
            ) : (
              <span className="mt-1 flex items-center gap-3">
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-700/50">
                  <span
                    data-testid="chart-grouped-promised-bar"
                    className="block h-full rounded-full bg-gradient-to-r from-slate-300/70 to-slate-400/50"
                    style={{ width: `${barWidthPercent(row.promisedCents, peak)}%` }}
                  />
                </span>
                <span className="shrink-0 font-mono text-xs text-white/60">
                  {format(row.promisedCents)}
                </span>
              </span>
            )}
            <span className="mt-1 flex items-center gap-3">
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-700/50">
                <span
                  data-testid="chart-grouped-cleared-bar"
                  className={GOLD_FILL_CLASS}
                  style={{ width: `${barWidthPercent(row.clearedCents, peak)}%` }}
                />
              </span>
              <span className="shrink-0 font-mono text-xs text-slate-100">
                {format(row.clearedCents)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Scatter ─────────────────────────────────────────────────────────────────

export interface ScatterPoint {
  readonly label: string;
  /** The x position in data units (e.g. momentum percent — may be negative). */
  readonly x: number;
  readonly yCents: bigint;
  /** Optional bubble weight — the run count behind the point. */
  readonly runs: number | null;
}

/**
 * Bubble radius from the run count — a linear 4..12px band against the
 * heaviest bubble; a point with no run count rides the 4px base.
 */
export function bubbleRadius(runs: number | null, maxRuns: number): number {
  const BASE_RADIUS = 4;
  const MAX_RADIUS = 12;
  if (maxRuns <= 0 || runs === null || runs <= 0) return BASE_RADIUS;
  return Math.round(BASE_RADIUS + ((MAX_RADIUS - BASE_RADIUS) * runs) / maxRuns);
}

/**
 * Scatter coordinates — x spread across the data's own min..max (momentum
 * is signed), y scaled against the cleared peak by integer bigint
 * fixed-point from the zero baseline. Equal-x data centers. Coordinates
 * only: display figures never ride this math.
 */
export function scatterPositions(
  points: readonly ScatterPoint[],
  plotWidth: number,
  plotHeight: number,
): readonly AreaPointGeometry[] {
  const count = points.length;
  if (count === 0) return [];
  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const peak = points.reduce((m, p) => (p.yCents > m ? p.yCents : m), 0n);
  const height = BigInt(Math.max(0, Math.trunc(plotHeight)));
  return points.map((p) => ({
    x: maxX === minX ? plotWidth / 2 : ((p.x - minX) / (maxX - minX)) * plotWidth,
    y: peak <= 0n ? plotHeight : plotHeight - Number((p.yCents * height) / peak),
  }));
}

/**
 * Cleared vs momentum — gold bubbles on slate axes, bubble weight from
 * the run count. Each point's aria-label names the entity, its exact
 * cleared figure, and its runs.
 */
export function Scatter({
  points,
  ariaLabel,
  emptyLabel,
  xAxisLabel,
  yAxisLabel,
  width = 340,
  height = 220,
  format = formatCentsBigint,
}: {
  points: readonly ScatterPoint[];
  ariaLabel: string;
  emptyLabel: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  width?: number;
  height?: number;
  format?: (cents: bigint) => string;
}) {
  if (points.length === 0) return <ChartEmpty label={emptyLabel} />;

  const PAD_X = 12;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 20;
  const plotWidth = width - PAD_X * 2;
  const plotHeight = height - PAD_TOP - PAD_BOTTOM;
  const positions = scatterPositions(points, plotWidth, plotHeight);
  const peak = points.reduce((m, p) => (p.yCents > m ? p.yCents : m), 0n);
  const maxRuns = points.reduce((m, p) => Math.max(m, p.runs ?? 0), 0);
  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  return (
    <div data-testid="chart-scatter" role="img" aria-label={`${ariaLabel} — ${points.length} points`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        aria-hidden="true"
        focusable="false"
      >
        <g transform={`translate(${PAD_X}, ${PAD_TOP})`}>
          <line x1={0} y1={plotHeight} x2={plotWidth} y2={plotHeight} stroke="#334155" strokeWidth={1} />
          <line x1={0} y1={0} x2={0} y2={plotHeight} stroke="#334155" strokeWidth={1} />
          {positions.map((pos, i) => {
            const point = points[i];
            const runs = point.runs;
            return (
              <circle
                key={point.label}
                data-testid="chart-scatter-point"
                data-runs={runs === null ? undefined : runs}
                cx={snap(pos.x)}
                cy={snap(pos.y)}
                r={bubbleRadius(runs, maxRuns)}
                fill={GOLD}
                fillOpacity={0.85}
                aria-label={`${point.label} — ${format(point.yCents)}${
                  runs === null ? '' : `, ${runs} run${runs === 1 ? '' : 's'}`
                }`}
              />
            );
          })}
        </g>
        <text x={PAD_X} y={height - 6} fontSize={10} fill={SLATE_LABEL}>
          {Math.round(minX)}
        </text>
        {xAxisLabel !== undefined && (
          <text x={width / 2} y={height - 6} fontSize={10} fill={SLATE_LABEL} textAnchor="middle">
            {xAxisLabel}
          </text>
        )}
        <text x={width - PAD_X} y={height - 6} fontSize={10} fill={SLATE_LABEL} textAnchor="end">
          {Math.round(maxX)}
        </text>
        {yAxisLabel !== undefined && (
          <text x={PAD_X} y={PAD_TOP - 4} fontSize={10} fill={SLATE_LABEL}>
            {yAxisLabel}
          </text>
        )}
        <text x={width - PAD_X} y={PAD_TOP - 4} fontSize={10} fill={SLATE_LABEL} textAnchor="end">
          {format(peak)}
        </text>
      </svg>
    </div>
  );
}

// ─── HeatCell ────────────────────────────────────────────────────────────────

/**
 * The heat value's gold alpha — clamped to 0..1, mapped onto a subtle
 * tint band (0..0.45 alpha of the house gold) so table text stays
 * legible, quantized to two decimals for stable markup. Zero heat is no
 * tint at all.
 */
export function heatAlpha(heat: number): number {
  if (!Number.isFinite(heat)) return 0;
  const clamped = Math.min(1, Math.max(0, heat));
  return Math.round(clamped * 0.45 * 100) / 100;
}

/**
 * The game log's heat-mapped gross cell — background intensity from the
 * 0..1 heat value on the gold alpha scale, the cell's own value as its
 * text. A heat of 0 renders no tint; the figure always renders.
 */
export function HeatCell({
  heat,
  children,
  ariaLabel,
}: {
  heat: number;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const alpha = heatAlpha(heat);
  return (
    <td
      data-testid="chart-heat-cell"
      data-heat={heat}
      aria-label={ariaLabel}
      style={alpha > 0 ? { backgroundColor: `rgb(212 175 55 / ${alpha})` } : undefined}
    >
      {children}
    </td>
  );
}
