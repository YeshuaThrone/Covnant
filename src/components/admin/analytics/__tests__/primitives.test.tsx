/**
 * Chart primitives — the company analytics kit's render suite. Pins each
 * primitive to its props: the geometry helpers' integer bigint math, the
 * path/arc/bar outputs that markup carries, the exact money figures
 * through `formatCentsBigint` (never a float, never a fabricated dollar),
 * the accessible labels, and the honest empty state per the
 * no-empty-states canon — copy, never a blank block.
 *
 * Rendered through `renderToStaticMarkup` (the house convention — the
 * suite runs in the node environment, no jsdom).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AreaChart,
  areaSeriesPoints,
  barWidthPercent,
  bubbleRadius,
  Donut,
  donutAngles,
  GroupedBars,
  HBar,
  heatAlpha,
  HeatCell,
  midTickLabels,
  polylinePoints,
  Scatter,
  scatterPositions,
  shareLabel,
  Sparkline,
  sparklinePointGeometry,
  sparklinePointTitles,
  sparklinePoints,
} from '../primitives';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — bigint cents figures standing in for what the derivation hands
// the page; every expected string below is the formatter's own output.
// ─────────────────────────────────────────────────────────────────────────────

const AREA_SERIES = [
  { label: 'Sep 1', valueCents: 1_000_000n },
  { label: 'Sep 2', valueCents: 2_500_000n },
  { label: 'Sep 3', valueCents: 500_000n },
  { label: 'Sep 4', valueCents: 4_000_000n },
];

const render = (jsx: React.ReactElement): string => renderToStaticMarkup(jsx);

const count = (html: string, marker: string): number =>
  (html.match(new RegExp(marker, 'g')) ?? []).length;

// ─── barWidthPercent ─────────────────────────────────────────────────────────

describe('barWidthPercent — the bar-width derivation', () => {
  it("charts each value against the chart's peak — integer percent, bigint math", () => {
    expect(barWidthPercent(2_000_000n, 2_000_000n)).toBe(100);
    expect(barWidthPercent(500_000n, 2_000_000n)).toBe(25);
    // Truncating integer division: 1 of 3 → 33%, not 33.33.
    expect(barWidthPercent(1n, 3n)).toBe(33);
  });

  it('floors a nonzero value at a 1% sliver so small moments stay on the chart', () => {
    expect(barWidthPercent(1n, 299_000_000n)).toBe(1);
  });

  it('renders nothing for empty math — never a fabricated width', () => {
    expect(barWidthPercent(0n, 100n)).toBe(0);
    expect(barWidthPercent(5n, 0n)).toBe(0);
  });
});

// ─── areaSeriesPoints / polylinePoints / sparklinePoints ─────────────────────

describe('areaSeriesPoints — the coordinate derivation', () => {
  it('spreads points evenly in x and scales y against the peak by integer bigint math', () => {
    const geometry = areaSeriesPoints(
      [1_000_000n, 2_000_000n, 4_000_000n],
      300,
      180,
    );
    expect(geometry).toEqual([
      { x: 0, y: 135 },
      { x: 150, y: 90 },
      { x: 300, y: 0 },
    ]);
  });

  it('honors an explicit shared peak — paired series scale against the main series', () => {
    const geometry = areaSeriesPoints(
      [1_000_000n, 2_000_000n, 4_000_000n],
      300,
      180,
      8_000_000n,
    );
    // Half the peak's height: half the plot. Truncation: 1M×180/8M → 22.
    expect(geometry.map((p) => p.y)).toEqual([158, 135, 90]);
  });

  it('puts an all-zero series on the baseline and centers a single point', () => {
    expect(areaSeriesPoints([0n, 0n], 300, 180)).toEqual([
      { x: 0, y: 180 },
      { x: 300, y: 180 },
    ]);
    expect(areaSeriesPoints([7n], 300, 180)).toEqual([{ x: 150, y: 0 }]);
    expect(areaSeriesPoints([], 300, 180)).toEqual([]);
  });
});

describe('polylinePoints / sparklinePoints — the line outputs', () => {
  it('renders one coordinate pair per point, main-scale peak applied', () => {
    expect(polylinePoints([1_000_000n, 2_000_000n, 4_000_000n], 300, 180)).toBe(
      '0,135 150,90 300,0',
    );
  });

  it('insets the sparkline so its stroke stays inside the cell', () => {
    const points = sparklinePoints([1n, 2n, 4n, 3n], 96, 28);
    expect(points).toBe('1,21 32.33,14 63.67,1 95,8');
  });
});

// ─── donutAngles / shareLabel ────────────────────────────────────────────────

describe('donutAngles — the arc derivation', () => {
  it('apportions integer degrees proportional to value', () => {
    expect(donutAngles([4_000_000n, 3_000_000n, 2_500_000n, 500_000n])).toEqual([
      144, 108, 90, 18,
    ]);
  });

  it('closes the ring to exactly 360 degrees — slivers rebalanced on the largest segment', () => {
    // Seven equal values truncate to 51° each (357 total) — the drift lands
    // on the largest segment (the first of the tied largest here) and the
    // ring closes.
    const angles = donutAngles([1n, 1n, 1n, 1n, 1n, 1n, 1n]);
    expect(angles.reduce((sum, a) => sum + a, 0)).toBe(360);
    expect(angles).toEqual([54, 51, 51, 51, 51, 51, 51]);
  });

  it('is honest about zero — a zero row draws nothing, an all-zero donut draws nothing', () => {
    expect(donutAngles([5n, 0n])).toEqual([360, 0]);
    expect(donutAngles([0n, 0n])).toEqual([0, 0]);
    expect(donutAngles([1_000_000n])).toEqual([360]);
  });
});

describe('shareLabel — the legend share voice', () => {
  it('states whole percents and sub-1% shares honestly', () => {
    expect(shareLabel(4_000_000n, 10_000_000n)).toBe('40%');
    expect(shareLabel(1n, 299_000_000n)).toBe('<1%');
    expect(shareLabel(0n, 10_000_000n)).toBe('0%');
    expect(shareLabel(5n, 0n)).toBe('0%');
  });
});

// ─── AreaChart ───────────────────────────────────────────────────────────────

describe('AreaChart', () => {
  it('renders every point, the gradient fill, the slate track, and first/last x labels', () => {
    const html = render(
      <AreaChart
        series={AREA_SERIES}
        ariaLabel="Cleared volume by day"
        emptyLabel="No runs cleared in this window."
      />,
    );

    expect(html).toContain('data-testid="chart-area"');
    expect(count(html, 'data-testid="chart-area-point"')).toBe(4);
    expect(html).toContain('data-testid="chart-area-track"');
    expect(html).toContain('data-testid="chart-area-fill"');
    expect(html).toContain('data-testid="chart-area-line"');
    expect(html).toContain('url(#covnant-area-gold-gradient)');
    expect(html).toContain('id="covnant-area-gold-gradient"');
    // First and last x labels — the window's edges.
    expect(html).toContain('Sep 1');
    expect(html).toContain('Sep 4');
  });

  it('carries the exact window total in its accessible label', () => {
    const html = render(
      <AreaChart
        series={AREA_SERIES}
        ariaLabel="Cleared volume by day"
        emptyLabel="No runs cleared in this window."
      />,
    );
    // 8,000,000 cents through the ledger formatter — the money voice, exact.
    expect(html).toContain(
      'aria-label="Cleared volume by day — $80,000.00 cleared across 4 points"',
    );
  });

  it('pairs thin line series on the main scale with a legend', () => {
    const html = render(
      <AreaChart
        series={AREA_SERIES}
        pairedSeries={[
          {
            label: 'Creator paid',
            tone: 'champagne',
            points: AREA_SERIES.map((p) => p.valueCents * 35n / 100n),
          },
        ]}
        ariaLabel="Cleared volume by day"
        emptyLabel="No runs cleared in this window."
      />,
    );
    expect(count(html, 'data-testid="chart-area-paired-line"')).toBe(1);
    expect(html).toContain('data-paired-label="Creator paid"');
    expect(html).toContain('Creator paid'); // the legend entry
  });

  it('renders the honest empty state — copy, never a blank block or a fabricated figure', () => {
    const html = render(
      <AreaChart
        series={[]}
        ariaLabel="Cleared volume by day"
        emptyLabel="No runs cleared in this window."
      />,
    );
    expect(html).toContain('data-testid="chart-empty"');
    expect(html).toContain('No runs cleared in this window.');
    expect(html).not.toContain('$');
    expect(html).not.toContain('<svg');
  });

  it('renders no interior ticks by default — the first/last-only treatment is unchanged', () => {
    const html = render(
      <AreaChart series={AREA_SERIES} ariaLabel="Cleared volume by day" emptyLabel="No runs cleared in this window." />,
    );
    expect(html).not.toContain('chart-area-mid-tick');
    expect(html).not.toContain('Sep 2');
    expect(html).not.toContain('Sep 3');
  });

  it('opts into evenly spaced interior date ticks between the endpoint labels', () => {
    const html = render(
      <AreaChart
        series={AREA_SERIES}
        ariaLabel="Cleared volume by day"
        emptyLabel="No runs cleared in this window."
        xAxisMidTicks
      />,
    );
    expect(count(html, 'data-testid="chart-area-mid-tick"')).toBe(2);
    expect(html).toContain('Sep 2');
    expect(html).toContain('Sep 3');
    // The endpoints keep their own labels exactly as before.
    expect(html).toContain('Sep 1');
    expect(html).toContain('Sep 4');
  });
});

describe('midTickLabels — the interior x-axis tick derivation', () => {
  const DAYS = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 20 + i));
    return d.toISOString().slice(0, 10);
  });

  it('picks evenly spaced interior positions and renders YYYY-MM-DD days as MM-DD', () => {
    const ticks = midTickLabels(DAYS);
    expect(ticks).toHaveLength(5);
    expect(ticks.map((t) => t.label)).toEqual(['08-26', '08-31', '09-06', '09-12', '09-17']);
    expect(ticks.map((t) => t.fraction)).toEqual([6 / 34, 11 / 34, 17 / 34, 23 / 34, 28 / 34]);
  });

  it('returns nothing for a short series and passes non-date labels through verbatim', () => {
    expect(midTickLabels(DAYS, 0)).toEqual([]);
    expect(midTickLabels(['a', 'b'])).toEqual([]);
    const passthrough = midTickLabels(['a', 'b', 'c', 'd']);
    expect(passthrough.map((t) => t.label)).toEqual(['b', 'c']);
  });
});

// ─── Sparkline ───────────────────────────────────────────────────────────────

describe('Sparkline', () => {
  it('draws a tiny gold polyline — one vertex per point', () => {
    const html = render(
      <Sparkline values={[1n, 2n, 4n, 3n]} ariaLabel="Cleared history" emptyLabel="No history" />,
    );
    expect(html).toContain('data-testid="chart-sparkline"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Cleared history"');
    expect(html).toContain('stroke="#d4af37"');
    expect(sparklinePoints([1n, 2n, 4n, 3n], 96, 28).split(' ')).toHaveLength(4);
  });

  it('carries NO <title> elements by default — the tooltip opt-in stays off', () => {
    const html = render(
      <Sparkline values={[1n, 2n, 4n, 3n]} ariaLabel="Cleared history" emptyLabel="No history" />,
    );
    expect(html).not.toContain('<title');
    expect(html).not.toContain('chart-sparkline-point');
  });

  it('renders per-point native <title> tooltips when opted in — the label and the exact value', () => {
    const html = render(
      <Sparkline
        values={[1_00n, 250_00n, 0n]}
        pointLabels={['2026-09-21', '2026-09-22', '2026-09-23']}
        ariaLabel="Cleared history"
        emptyLabel="No history"
      />,
    );
    expect(html).toContain('<title>2026-09-21 — $1.00</title>');
    expect(html).toContain('<title>2026-09-22 — $250.00</title>');
    expect(html).toContain('<title>2026-09-23 — $0.00</title>'); // an honest zero point titles as zero
    expect(html.match(/<title>/g)?.length).toBe(3);
    expect(html.match(/data-testid="chart-sparkline-point"/g)?.length).toBe(3);
  });

  it('titles only the points that carry labels — never a guessed date', () => {
    const html = render(
      <Sparkline
        values={[1_00n, 250_00n, 0n, 5_00n]}
        pointLabels={['2026-09-21']}
        ariaLabel="Cleared history"
        emptyLabel="No history"
      />,
    );
    expect(html.match(/<title>/g)?.length).toBe(1);
    expect(html).toContain('<title>2026-09-21 — $1.00</title>');
  });

  it('renders the honest empty copy in place of the line', () => {
    const html = render(
      <Sparkline values={[]} ariaLabel="Cleared history" emptyLabel="No cleared history yet." />,
    );
    expect(html).toContain('data-testid="chart-sparkline-empty"');
    expect(html).toContain('No cleared history yet.');
    expect(html).not.toContain('<svg');
  });
});

describe('sparklinePointTitles', () => {
  it("pairs the polyline's own vertex geometry with the composed title text", () => {
    const titles = sparklinePointTitles([4n, 1n], ['Sep 1', 'Sep 2'], 96, 28);
    expect(titles).toHaveLength(2);
    expect(titles[0].title).toBe('Sep 1 — $0.04');
    expect(titles[1].title).toBe('Sep 2 — $0.01');
    // The transparent hover targets sit on the polyline's own vertices.
    const geometry = sparklinePointGeometry([4n, 1n], 96, 28);
    expect(titles[0].x).toBe(geometry[0].x);
    expect(titles[0].y).toBe(geometry[0].y);
    expect(titles[1].x).toBe(geometry[1].x);
    expect(titles[1].y).toBe(geometry[1].y);
  });
});

// ─── Donut ───────────────────────────────────────────────────────────────────

const DONUT_ROWS = [
  { label: 'Royalty Distribution', valueCents: 4_000_000n },
  { label: 'Brand Partnership', valueCents: 3_000_000n },
  { label: 'Prize Purse', valueCents: 2_500_000n },
  { label: 'Platform Content Monetization', valueCents: 500_000n },
];

describe('Donut', () => {
  it('renders one arc per nonzero row, and the arcs close the ring to 360 degrees', () => {
    const html = render(
      <Donut rows={DONUT_ROWS} ariaLabel="Runs by flow kind" emptyLabel="No runs in this window." />,
    );
    expect(count(html, 'data-testid="chart-donut-segment"')).toBe(4);

    const starts = [...html.matchAll(/data-start-angle="(\d+)"/g)].map((m) => Number(m[1]));
    const ends = [...html.matchAll(/data-end-angle="(\d+)"/g)].map((m) => Number(m[1]));
    const spanSum = ends.reduce((sum, end, i) => sum + (end - starts[i]), 0);
    expect(spanSum).toBe(360);
    expect(ends[ends.length - 1]).toBe(360);
  });

  it('renders legend rows with the exact formatted values and honest shares', () => {
    const html = render(
      <Donut rows={DONUT_ROWS} ariaLabel="Runs by flow kind" emptyLabel="No runs in this window." />,
    );
    expect(count(html, 'data-testid="chart-donut-legend-row"')).toBe(4);
    expect(html).toContain('Royalty Distribution');
    expect(html).toContain('$40,000.00');
    expect(html).toContain('$30,000.00');
    expect(html).toContain('$25,000.00');
    expect(html).toContain('$5,000.00');
    expect(html).toContain('40%');
    expect(html).toContain('5%');
    // The svg's accessible label carries the exact donut total.
    expect(html).toContain('aria-label="Runs by flow kind — $100,000.00 across 4 kinds"');
  });

  it('draws a zero-value row as nothing but keeps its honest legend line', () => {
    const html = render(
      <Donut
        rows={[DONUT_ROWS[0], { label: 'Prize Purse', valueCents: 0n }]}
        ariaLabel="Runs by flow kind"
        emptyLabel="No runs in this window."
      />,
    );
    expect(count(html, 'data-testid="chart-donut-segment"')).toBe(1);
    expect(count(html, 'data-testid="chart-donut-legend-row"')).toBe(2);
    expect(html).toContain('$0.00');
    expect(html).toContain('0%');
  });

  it('renders the honest empty state for an empty or all-zero donut', () => {
    for (const rows of [[], DONUT_ROWS.map((r) => ({ ...r, valueCents: 0n }))]) {
      const html = render(
        <Donut rows={rows} ariaLabel="Runs by flow kind" emptyLabel="No runs in this window." />,
      );
      expect(html).toContain('data-testid="chart-empty"');
      expect(html).toContain('No runs in this window.');
      expect(html).not.toContain('data-start-angle');
    }
  });
});

// ─── HBar ────────────────────────────────────────────────────────────────────

describe('HBar', () => {
  it('renders each row with its label, proportional fill, and exact formatted value', () => {
    const html = render(
      <HBar
        rows={[
          { label: 'MUSIC', valueCents: 2_000_000n },
          { label: 'SPORTS', valueCents: 500_000n },
        ]}
        ariaLabel="Cleared by industry"
        emptyLabel="No industries cleared in this window."
      />,
    );
    expect(count(html, 'data-testid="chart-hbar-row"')).toBe(2);
    expect(count(html, 'data-testid="chart-hbar-fill"')).toBe(2);
    expect(html).toContain('MUSIC');
    expect(html).toContain('SPORTS');
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('$20,000.00');
    expect(html).toContain('$5,000.00');
    expect(html).toContain('aria-label="Cleared by industry"');
  });

  it('renders the honest empty state', () => {
    const html = render(
      <HBar
        rows={[]}
        ariaLabel="Cleared by industry"
        emptyLabel="No industries cleared in this window."
      />,
    );
    expect(html).toContain('data-testid="chart-empty"');
    expect(html).toContain('No industries cleared in this window.');
    expect(html).not.toContain('$');
  });
});

// ─── GroupedBars ─────────────────────────────────────────────────────────────

describe('GroupedBars', () => {
  const rows = [
    { label: 'Feature films', promisedCents: 1_000_000n, clearedCents: 2_000_000n },
    { label: 'Social channels', promisedCents: null, clearedCents: 500_000n },
  ];

  it('renders both bars per category on one shared scale, with the legend', () => {
    const html = render(
      <GroupedBars
        rows={rows}
        ariaLabel="Promised versus cleared"
        emptyLabel="No classes cleared in this window."
      />,
    );
    expect(html).toContain('data-testid="chart-grouped-legend"');
    expect(html).toContain('Promised');
    expect(html).toContain('Cleared');
    expect(count(html, 'data-testid="chart-grouped-promised-bar"')).toBe(1);
    expect(count(html, 'data-testid="chart-grouped-cleared-bar"')).toBe(2);
    // Shared peak is the 2,000,000-cent cleared figure: promised 1M = 50%,
    // cleared 2M = 100%, the null class's cleared 500k = 25%.
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:50%"');
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('$10,000.00');
    expect(html).toContain('$20,000.00');
    expect(html).toContain('$5,000.00');
  });

  it('states the absent promised field honestly — never a fabricated comparison', () => {
    const html = render(
      <GroupedBars
        rows={rows}
        ariaLabel="Promised versus cleared"
        emptyLabel="No classes cleared in this window."
      />,
    );
    expect(html).toContain('data-testid="chart-grouped-promised-null"');
    expect(html).toContain('No promised value in canon — cleared production stands alone.');
  });

  it('renders the honest empty state', () => {
    const html = render(
      <GroupedBars
        rows={[]}
        ariaLabel="Promised versus cleared"
        emptyLabel="No classes cleared in this window."
      />,
    );
    expect(html).toContain('data-testid="chart-empty"');
    expect(html).not.toContain('$');
  });
});

// ─── Scatter ─────────────────────────────────────────────────────────────────

describe('scatterPositions — the scatter coordinate derivation', () => {
  const points = [
    { label: 'Alpha', x: 10, yCents: 1_000_000n, runs: 2 },
    { label: 'Beta', x: 50, yCents: 2_000_000n, runs: 8 },
    { label: 'Gamma', x: 90, yCents: 4_000_000n, runs: null },
  ];

  it('spreads x across the data min..max and scales y against the cleared peak', () => {
    expect(scatterPositions(points, 316, 188)).toEqual([
      { x: 0, y: 141 },
      { x: 158, y: 94 },
      { x: 316, y: 0 },
    ]);
  });

  it('centers equal-x data and puts an empty set nowhere', () => {
    const equal = [
      { label: 'Alpha', x: 50, yCents: 1n, runs: null },
      { label: 'Beta', x: 50, yCents: 2n, runs: null },
    ];
    expect(scatterPositions(equal, 300, 180)).toEqual([
      { x: 150, y: 90 },
      { x: 150, y: 0 },
    ]);
    expect(scatterPositions([], 300, 180)).toEqual([]);
  });
});

describe('bubbleRadius — the bubble weight derivation', () => {
  it('scales the radius linearly in a 4..12px band against the heaviest run count', () => {
    expect(bubbleRadius(8, 8)).toBe(12);
    expect(bubbleRadius(2, 8)).toBe(6);
  });

  it('rides the base radius without a run count', () => {
    expect(bubbleRadius(null, 8)).toBe(4);
    expect(bubbleRadius(0, 8)).toBe(4);
    expect(bubbleRadius(5, 0)).toBe(4);
  });
});

describe('Scatter', () => {
  const points = [
    { label: 'Alpha', x: 10, yCents: 1_000_000n, runs: 2 },
    { label: 'Beta', x: 50, yCents: 2_000_000n, runs: 8 },
    { label: 'Gamma', x: 90, yCents: 4_000_000n, runs: null },
  ];

  it('renders every point with its run weight and exact figure in its own label', () => {
    const html = render(
      <Scatter
        points={points}
        ariaLabel="Cleared versus momentum"
        emptyLabel="No entities to plot in this window."
        xAxisLabel="30-day momentum (%)"
      />,
    );
    expect(html).toContain('data-testid="chart-scatter"');
    expect(count(html, 'data-testid="chart-scatter-point"')).toBe(3);
    expect(html).toContain('data-runs="2"');
    expect(html).toContain('data-runs="8"');
    // The null-run point carries no weight attribute at all.
    expect(count(html, 'data-runs=')).toBe(2);
    expect(html).toContain('aria-label="Alpha — $10,000.00, 2 runs"');
    expect(html).toContain('aria-label="Gamma — $40,000.00"');
    // The y axis states the exact cleared peak; the x caption names its unit.
    expect(html).toContain('30-day momentum (%)');
    expect(html).toContain('$40,000.00');
  });

  it('renders the honest empty state', () => {
    const html = render(
      <Scatter
        points={[]}
        ariaLabel="Cleared versus momentum"
        emptyLabel="No entities to plot in this window."
      />,
    );
    expect(html).toContain('data-testid="chart-empty"');
    expect(html).toContain('No entities to plot in this window.');
    expect(html).not.toContain('<svg');
  });
});

// ─── HeatCell ────────────────────────────────────────────────────────────────

describe('heatAlpha — the heat intensity derivation', () => {
  it('clamps the heat onto the gold alpha band', () => {
    expect(heatAlpha(0)).toBe(0);
    expect(heatAlpha(0.5)).toBe(0.23);
    expect(heatAlpha(1)).toBe(0.45);
    expect(heatAlpha(-1)).toBe(0);
    expect(heatAlpha(2)).toBe(0.45);
    expect(heatAlpha(Number.NaN)).toBe(0);
  });
});

describe('HeatCell', () => {
  it('tints the cell on the gold alpha scale and renders its value text', () => {
    const html = render(<HeatCell heat={0.5} ariaLabel="Gross, above median">$20,000.00</HeatCell>);
    expect(html).toContain('data-testid="chart-heat-cell"');
    expect(html).toContain('data-heat="0.5"');
    expect(html).toContain('background-color:rgb(212 175 55 / 0.23)');
    expect(html).toContain('$20,000.00');
    expect(html).toContain('aria-label="Gross, above median"');
  });

  it('renders no tint at zero heat — the figure still renders', () => {
    const html = render(<HeatCell heat={0}>$0.00</HeatCell>);
    expect(html).toContain('data-heat="0"');
    expect(html).not.toContain('background-color');
    expect(html).toContain('$0.00');
  });
});
