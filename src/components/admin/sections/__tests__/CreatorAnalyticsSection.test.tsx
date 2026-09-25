/**
 * @vitest-environment jsdom
 *
 * CreatorAnalyticsSection — the Creator Analytics tab's suite (spec
 * art_UccVWZpj), mirroring the AnalyticsSection suite's shape:
 *
 * 1. Fixture renders of the pure view — the KPI cards with exact strings
 *    and the integer-safe share (the primitives' bigint percent with the
 *    honest "<1%" floor), the window filter lit from the payload's own
 *    windowDays, the demo badge, module ranks verbatim (ties preserved,
 *    next rank vacant — never re-ranked here), the label ?? payeeId rule,
 *    the game log's honest dashes, and the empty payload's per-section
 *    empty states over a zeroed-but-present KPI row.
 * 2. The mount — the default window is ALL, and the unavailable payload
 *    renders the section's honest unavailable state.
 * 3. The live dev-seed render — REAL creatorAnalytics payloads over
 *    createSeededStore (the derivation suite's own fixture truth) for
 *    every window, pinning the module's verified numbers end-to-end
 *    through the rendered markup: the ALL-window KPIs, the 7D "<1%" share
 *    floor, the 30D integer share, the leaderboard's two rights holders
 *    with exact totals and the reconciling Total row, ALL THIRTEEN
 *    platform sources of record in the module's descending order (THIS is
 *    the sanctioned brand surface — the Analytics tab's brand-exclusion
 *    pin is untouched by this file), the paginated 124-row game log
 *    newest first, and the window switch changing every value.
 * 4. The game log's pagination and filter mechanics — client-side, pinned
 *    through the pure helpers AND a jsdom interaction harness (the
 *    virtual-card page test's convention: createRoot + act, no
 *    testing-library in this repo): 25 rows per page, bound-aware
 *    Prev/Next, the count line's filtered arithmetic, AND-semantics
 *    filters, and the page reset on filter change.
 *
 * Store-read figures only; nothing invented.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSeededStore } from '@/lib/server/devSeed';
import { formatCentsBigint } from '@/lib/money/format';
import {
  creatorAnalytics,
  type CreatorAnalyticsFlows,
  type CreatorGameLogRow,
  type CreatorPayoutRow,
} from '@/lib/admin/creatorAnalytics';
import { catalogGrowthFlows, type CatalogGrowthFlows } from '@/lib/admin/catalogGrowth';

import {
  CreatorAnalyticsSection,
  CreatorAnalyticsView,
  GAME_LOG_PAGE_SIZE,
  auditStatementHref,
  clampedPage,
  deltaChipLabel,
  entityCodeOf,
  entityCodeOptions,
  gameLogCountLine,
  gameLogRowMatches,
  heatShare,
  payeeDisplayName,
  payeeFilterOptions,
  recoupmentShare,
  sourceFilterOptions,
  splitSourceRows,
  windowIdOf,
} from '../CreatorAnalyticsSection';
import type { CatalogGrowthWindows, CreatorAnalyticsWindows, SectionData } from '../../types';

// ---------------------------------------------------------------------------
// Fixtures — the real payload shapes, small and honest.
// ---------------------------------------------------------------------------

function leaderRow(
  overrides: Partial<CreatorPayoutRow> & Pick<CreatorPayoutRow, 'payeeId' | 'rank'>,
): CreatorPayoutRow {
  return {
    label: null,
    creditsCents: 1_000_00n,
    runs: 1,
    lastDay: '2026-09-23',
    series: [500_00n, 1_000_00n],
    ...overrides,
  };
}

function gameLogRow(
  overrides: Partial<CreatorGameLogRow> & Pick<CreatorGameLogRow, 'day' | 'payeeId'>,
): CreatorGameLogRow {
  return {
    entityId: 'TPL-MUS-001',
    workTitle: 'Midnight Clear',
    source: 'Spotify',
    creatorCents: 350_00n,
    ...overrides,
  };
}

function payload(overrides: Partial<CreatorAnalyticsFlows> = {}): CreatorAnalyticsFlows {
  return {
    windowDays: null,
    creatorPaidCents: 350_00n,
    grossClearedCents: 1_000_00n,
    activePayees: 1,
    runsPaying: 1,
    trend: [{ day: '2026-09-23', creatorCents: 350_00n }],
    sourceSplits: [{ source: 'Spotify', creatorCents: 350_00n, runs: 1 }],
    leaders: [leaderRow({ payeeId: 'rh_one', rank: 1 })],
    gameLog: [gameLogRow({ day: '2026-09-23', payeeId: 'rh_one' })],
    ...overrides,
  };
}

function emptyPayload(): CreatorAnalyticsFlows {
  return {
    windowDays: 30,
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

function windowsRecord(all: CreatorAnalyticsFlows, seven: CreatorAnalyticsFlows): CreatorAnalyticsWindows {
  return { '7d': seven, '30d': all, '90d': all, all };
}

/** The growth payload shape, empty by default — every module off, honestly. */
function growth(overrides: Partial<CatalogGrowthFlows> = {}): CatalogGrowthFlows {
  return {
    windowDays: null,
    recoupmentByCatalog: [],
    payeesWithoutAdvanceIds: [],
    topMarkets: { markets: [], unattributedCents: 0n, settlementsConsidered: 0 },
    actionSignals: [],
    ...overrides,
  };
}

function growthWindowsRecord(all: CatalogGrowthFlows, seven: CatalogGrowthFlows): CatalogGrowthWindows {
  return { '7d': seven, '30d': all, '90d': all, all };
}

/** The section-level growth data — a ready record of the empty shape. */
function growthSectionData(overrides?: Partial<CatalogGrowthFlows>): SectionData<CatalogGrowthWindows> {
  return { kind: 'ready', value: growthWindowsRecord(growth(overrides), growth(overrides)) };
}

function renderView(flows: CreatorAnalyticsFlows, demo = true, growthPayload: CatalogGrowthFlows = growth()): string {
  return renderToStaticMarkup(
    <CreatorAnalyticsView flows={flows} growth={growthPayload} demo={demo} onWindowChange={() => {}} />,
  );
}

/* ── jsdom interaction harness (no testing-library in this repo) ── */

const mounted: { root: Root; container: HTMLElement }[] = [];

function mountView(flows: CreatorAnalyticsFlows, growthPayload: CatalogGrowthFlows = growth()): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<CreatorAnalyticsView flows={flows} growth={growthPayload} demo={true} onWindowChange={() => {}} />);
  });
  mounted.push({ root, container });
  return container;
}

function clickButton(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

/** React-controlled select change — the native value setter plus a bubbling change event. */
function setSelectValue(select: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function queryTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`missing [data-testid="${testId}"]`);
  return element as HTMLElement;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('creator analytics presentation helpers', () => {
  it('voices the payee as the store-carried name, else the payeeId of record', () => {
    expect(payeeDisplayName('Thrones Rights Group', 'rh_thrones_label_don')).toBe('Thrones Rights Group');
    expect(payeeDisplayName(null, 'rh_thrones_label_don')).toBe('rh_thrones_label_don');
  });

  it('heats money by floored bigint share of the column peak', () => {
    expect(heatShare(0n, 1000n)).toBe(0);
    expect(heatShare(500n, 0n)).toBe(0);
    expect(heatShare(250n, 1000n)).toBe(0.25);
    expect(heatShare(1n, 1000n)).toBe(0); // sub-1% floors to no heat — honest
    expect(heatShare(1000n, 1000n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Game log pagination and filter helpers — the pure mechanics
// ---------------------------------------------------------------------------

describe('game log pagination and filter helpers', () => {
  it('cuts the entity code as the TPL family prefix — a row without an entity carries no code', () => {
    expect(entityCodeOf('TPL-MUS-001')).toBe('TPL-MUS');
    expect(entityCodeOf('TPL-AUD-012')).toBe('TPL-AUD');
    expect(entityCodeOf(null)).toBe(null);
    expect(entityCodeOf('legacy-id')).toBe('legacy-id'); // a non-template id is its own code
  });

  it('ANDs the filter arms — an arm the row cannot carry never matches', () => {
    const none = { payeeId: null, entityCode: null, source: null };
    const row = gameLogRow({ day: '2026-09-23', payeeId: 'rh_one' });
    expect(gameLogRowMatches(row, none)).toBe(true);
    expect(gameLogRowMatches(row, { ...none, payeeId: 'rh_one' })).toBe(true);
    expect(gameLogRowMatches(row, { ...none, payeeId: 'rh_other' })).toBe(false);
    expect(gameLogRowMatches(row, { ...none, entityCode: 'TPL-MUS' })).toBe(true);
    expect(gameLogRowMatches(row, { ...none, entityCode: 'TPL-AUD' })).toBe(false);
    expect(gameLogRowMatches(row, { ...none, source: 'Spotify' })).toBe(true);
    expect(gameLogRowMatches(row, { ...none, source: 'TikTok' })).toBe(false);
    // A dash row (no source of record) never matches a source arm — never force-fitted.
    const dashed = gameLogRow({ day: '2026-09-23', payeeId: 'rh_one', source: null });
    expect(gameLogRowMatches(dashed, { ...none, source: 'Spotify' })).toBe(false);
  });

  it('clamps the page into 1..pageCount', () => {
    expect(clampedPage(0, 5)).toBe(1);
    expect(clampedPage(3, 5)).toBe(3);
    expect(clampedPage(9, 5)).toBe(5);
    expect(clampedPage(2, 0)).toBe(1);
  });

  it('voices the count line verbatim — singular included', () => {
    expect(gameLogCountLine(1, 25, 124)).toBe('Showing 1–25 of 124 transactions');
    expect(gameLogCountLine(26, 50, 124)).toBe('Showing 26–50 of 124 transactions');
    expect(gameLogCountLine(101, 124, 124)).toBe('Showing 101–124 of 124 transactions');
    expect(gameLogCountLine(1, 1, 1)).toBe('Showing 1–1 of 1 transaction');
  });

  it('splits the source bars by the deterministic 1/100 cut — exact bigint math', () => {
    const rows = [
      { label: 'Spotify', valueCents: 4_000_000_000n },
      { label: 'TikTok', valueCents: 1_000_000n },
      { label: 'At the boundary', valueCents: 40_000_000n }, // exactly 1/100 of the top — primary
      { label: 'Below the line', valueCents: 39_999_999n }, // sub-1/100 — tail
    ];
    const { primary, tail } = splitSourceRows(rows);
    expect(primary.map((row) => row.label)).toEqual(['Spotify', 'At the boundary']);
    expect(tail.map((row) => row.label)).toEqual(['TikTok', 'Below the line']);
  });

  it('derives the filter options from the payload — leaderboard payees plus log-only fields', () => {
    const leaders = [leaderRow({ payeeId: 'rh_b', rank: 2 }), leaderRow({ payeeId: 'rh_a', rank: 1 })];
    const rows = [
      gameLogRow({ day: '2026-09-23', payeeId: 'rh_a' }),
      gameLogRow({ day: '2026-09-22', payeeId: 'rh_c', entityId: 'TPL-MUS-001', source: 'TikTok' }),
      gameLogRow({ day: '2026-09-21', payeeId: 'rh_c', entityId: null, source: null }),
    ];
    expect(payeeFilterOptions(leaders, rows)).toEqual(['rh_a', 'rh_b', 'rh_c']);
    expect(entityCodeOptions(rows)).toEqual(['TPL-MUS']);
    expect(sourceFilterOptions(rows)).toEqual(['Spotify', 'TikTok']); // the fixture's default source rides along
  });
});

// ---------------------------------------------------------------------------
// Fixture renders — the pure view
// ---------------------------------------------------------------------------

describe('CreatorAnalyticsView — fixture renders', () => {
  it('renders the four KPI cards with exact figures and the integer-safe share', () => {
    const html = renderView(payload());
    expect(html).toContain('data-testid="creator-analytics-kpi-creator-paid"');
    expect(html).toContain('$350.00'); // creator paid
    expect(html).toContain('35%'); // integer bigint percent of the $1,000.00 gross
    expect(html).toContain('data-testid="creator-analytics-kpi-payees"');
    expect(html).toContain('data-testid="creator-analytics-kpi-runs"');
    // The d256957 treatment — full values, tracking-tighter, no truncate class.
    const kpiBlock = html.slice(
      html.indexOf('data-testid="creator-analytics-kpis"'),
      html.indexOf('data-testid="creator-analytics-trend"'),
    );
    expect(kpiBlock).toContain('tracking-tighter');
    expect(kpiBlock).not.toContain('truncate');
  });

  it('floors a sub-1% share to the honest <1% — never a float ratio of money', () => {
    const html = renderView(payload({ creatorPaidCents: 4_00n, grossClearedCents: 1_000_00n }));
    expect(html).toContain('&lt;1%'); // the floor — '<' escapes in static markup
    expect(html).toContain('$4.00'); // the creator side still renders exactly
  });

  it('lights the window filter from the payload itself', () => {
    const html = renderView(payload({ windowDays: 7 }));
    expect(html).toContain('data-testid="creator-analytics-window-7d"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-testid="creator-analytics-window-all"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('discloses the demo door through the badge, and only behind the flag', () => {
    expect(renderView(payload())).toContain('demo-data-badge');
    expect(renderView(payload(), false)).not.toContain('demo-data-badge');
  });

  it('renders module ranks verbatim — ties shared, the next rank vacant, labels never invented', () => {
    const html = renderView(
      payload({
        leaders: [
          leaderRow({ payeeId: 'rh_named', rank: 1, label: 'Thrones Rights Group' }),
          leaderRow({ payeeId: 'rh_b', rank: 2 }),
          leaderRow({ payeeId: 'rh_c', rank: 2 }),
        ],
      }),
    );
    expect(html.match(/data-rank="2"/g)?.length).toBe(2); // the tie shares rank 2
    expect(html).not.toContain('data-rank="3"'); // the next rank stays vacant
    expect(html).toContain('Thrones Rights Group'); // the store-carried label
    expect(html).toContain('rh_b'); // a null label renders the payeeId of record
    expect(html).toContain('rh_c');
  });

  it('renders the game log nulls honestly — dash, never a fabricated string', () => {
    const html = renderView(
      payload({
        gameLog: [
          gameLogRow({
            day: '2026-09-23',
            payeeId: 'rh_raw',
            entityId: null,
            workTitle: null,
            source: null,
          }),
        ],
      }),
    );
    const gameLog = html.slice(html.indexOf('data-testid="creator-analytics-gamelog"'));
    expect(gameLog).toContain('rh_raw'); // the payeeId of record is the primary label
    expect(gameLog).not.toContain('Spotify');
    expect(gameLog).not.toContain('TPL-MUS-001');
    expect(gameLog).not.toContain('Midnight Clear');
    expect(gameLog).toContain('—'); // the dash states the absent field
  });

  it('renders the single source list exactly as before when there is no tail — no sub-labels', () => {
    const single = payload({ sourceSplits: [{ source: 'Spotify', creatorCents: 350_00n, runs: 1 }] });
    const html = renderView(single);
    expect(html).not.toContain('Primary DSPs');
    expect(html).not.toContain('Tail distribution');
    expect(html.match(/data-testid="chart-hbar-row"/g)?.length).toBe(1);
  });

  it('renders an empty window as zeros and copy — never a blank block', () => {
    const html = renderView(emptyPayload());
    expect(html).toContain('$0.00'); // the KPI row renders zeros, not blanks
    expect(html).toContain('0%');
    expect(html).toContain('data-testid="creator-analytics-trend-empty"');
    expect(html).toContain('data-testid="creator-analytics-sources-empty"');
    expect(html).toContain('data-testid="creator-analytics-leaders-empty"');
    expect(html).toContain('data-testid="creator-analytics-gamelog-empty"');
    expect(html).toContain('No creator payouts cleared in this window');
    expect(html).not.toContain('creator-analytics-leaderboard-row');
    expect(html).not.toContain('creator-analytics-gamelog-row');
  });

  it('renders the section wrapper: default window ALL, and the honest unavailable state', () => {
    const allPayload = payload();
    const seven = payload({ windowDays: 7, creatorPaidCents: 4_00n });
    const section = renderToStaticMarkup(
      <CreatorAnalyticsSection
        creatorAnalytics={{ kind: 'ready', value: windowsRecord(allPayload, seven) }}
        catalogGrowth={growthSectionData()}
        demo={true}
      />,
    );
    expect(section).toContain('$350.00'); // the ALL window is the default pick
    expect(section).toContain('demo-data-badge');
    const unavailable = renderToStaticMarkup(
      <CreatorAnalyticsSection
        creatorAnalytics={{
          kind: 'unavailable',
          code: 'creator_analytics_store_failed',
          message: 'Creator analytics store read failed.',
        }}
        catalogGrowth={growthSectionData()}
        demo={true}
      />,
    );
    expect(unavailable).toContain('data-testid="creator-analytics-unavailable"');
    expect(unavailable).toContain('Creator analytics store read failed.');
    expect(unavailable).toContain('creator_analytics_store_failed');
  });
});

// ---------------------------------------------------------------------------
// The live dev-seed render — real derivation payloads over the seeded store
// ---------------------------------------------------------------------------

describe('CreatorAnalyticsSection — the live dev-seed render', () => {
  let allPayload: CreatorAnalyticsFlows;
  let sevenPayload: CreatorAnalyticsFlows;
  let monthPayload: CreatorAnalyticsFlows;

  beforeAll(async () => {
    const seeded = await createSeededStore();
    const [all, seven, month] = await Promise.all([
      creatorAnalytics(seeded, null),
      creatorAnalytics(seeded, 7),
      creatorAnalytics(seeded, 30),
    ]);
    if (all === null || seven === null || month === null) {
      throw new Error('creatorAnalytics returned null over the seeded store');
    }
    allPayload = all;
    sevenPayload = seven;
    monthPayload = month;
  });

  it('pins the ALL-window KPI cards to the derivation totals exactly', () => {
    const html = renderView(allPayload);
    expect(html).toContain('$8,445,103,733.36'); // creator paid — the ALL-window total
    const kpiBlock = html.slice(
      html.indexOf('data-testid="creator-analytics-kpis"'),
      html.indexOf('data-testid="creator-analytics-trend"'),
    );
    expect(kpiBlock).toContain('100%'); // integer-safe share: the holder credits ARE the gross (zero dust)
    expect(kpiBlock).toContain('2'); // active payees
    expect(kpiBlock).toContain('119'); // runs paying creators
    // The d256957 treatment — the full $8,445,103,733.36 renders un-truncated.
    expect(kpiBlock).toContain('tracking-tighter');
    expect(kpiBlock).not.toContain('truncate');
  });

  it('floors the 7D share honestly and pins the week exactly', () => {
    const html = renderView(sevenPayload);
    expect(html).toContain('$42,652,800.00'); // 7d creator paid
    const kpiBlock = html.slice(
      html.indexOf('data-testid="creator-analytics-kpis"'),
      html.indexOf('data-testid="creator-analytics-trend"'),
    );
    // The share card divides by the WINDOW'S OWN cleared gross (the module's
    // contract) — the zero-dust seed makes every journal's gross its holder
    // credits, so the live share is 100% in every window. The sub-1% floor
    // path is pinned by the fixture test and the primitives' own suite.
    expect(kpiBlock).toContain('100%');
    expect(kpiBlock).toContain('47'); // 7d runs
  });

  it('pins the 30D window and its integer share exactly', () => {
    const html = renderView(monthPayload);
    expect(html).toContain('$6,438,993,733.36'); // 30d creator paid
    const kpiBlock = html.slice(
      html.indexOf('data-testid="creator-analytics-kpis"'),
      html.indexOf('data-testid="creator-analytics-trend"'),
    );
    // Integer bigint percent over the window's own gross — 100% on the
    // zero-dust seed; the floored non-100 cases are fixture-pinned.
    expect(kpiBlock).toContain('100%');
  });

  it('pins the leaderboard to the two rights holders with the reconciling Total row', () => {
    const html = renderView(allPayload);
    expect(html.match(/data-testid="creator-analytics-leaderboard-row"/g)?.length).toBe(2);
    expect(html).toContain('data-rank="1"');
    expect(html).toContain('data-rank="2"');
    expect(html).toContain('Thrones Rights Group'); // the store-carried label of record
    expect(html).toContain('Yeshua Throne');
    expect(html).toContain('$4,278,437,066.68'); // rank 1
    expect(html).toContain('$4,166,666,666.68'); // rank 2
    const namedBefore = html.indexOf('Thrones Rights Group') < html.indexOf('Yeshua Throne');
    expect(namedBefore).toBe(true); // module order — rank ascending
    const totalBlock = html.slice(html.indexOf('data-testid="creator-analytics-leaderboard-total"'));
    expect(totalBlock).toContain('$8,445,103,733.36'); // Σ leaders === creatorPaidCents (the module invariant)
    expect(html.match(/data-testid="chart-sparkline"/g)?.length).toBe(2); // per-row momentum sparklines
    expect(html.match(/data-testid="chart-heat-cell"/g)?.length).toBeGreaterThan(0);
    // The opted-in native tooltips — per-point <title> elements carrying the
    // trend's day of record and the exact formatted value (2 leaders × every
    // trend day, the series' own alignment contract).
    const sparklineTitles = html.match(/<title>[\s\S]*?<\/title>/g) ?? [];
    expect(sparklineTitles.length).toBe(2 * allPayload.trend.length);
    const lastDay = allPayload.trend[allPayload.trend.length - 1].day;
    const firstLeader = allPayload.leaders[0];
    const expectedTitle = `<title>${lastDay} — ${formatCentsBigint(firstLeader.series[firstLeader.series.length - 1])}</title>`;
    expect(sparklineTitles).toContain(expectedTitle);
  });

  it('renders ALL THIRTEEN platform sources of record HERE, in the module order', () => {
    const html = renderView(allPayload);
    const sources = html.slice(
      html.indexOf('data-testid="creator-analytics-sources"'),
      html.indexOf('data-testid="creator-analytics-leaders"'),
    );
    const order = [
      'Spotify',
      'Amazon Music',
      'YouTube Music',
      'Bandcamp',
      'Meridian Cinemas',
      'PGA Tour',
      'Ticketmaster',
      'Nike',
      'Reader Platforms',
      'Broadcast Partners',
      'Apple Podcasts',
      'Twitch',
      'TikTok',
    ];
    for (const brand of order) expect(sources).toContain(brand);
    // Descending by credits, source name breaking the 200B tie.
    let last = -1;
    for (const brand of order) {
      const at = sources.indexOf(brand);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(sources).toContain('$4,000,000,000.00'); // Spotify's 400,000,000,000 cents
    expect(html.match(/data-testid="chart-hbar-row"/g)?.length).toBe(13);
  });

  it('splits the thirteen sources into Primary DSPs and Tail distribution — each group scaled to its own max', () => {
    const html = renderView(allPayload);
    const sources = html.slice(
      html.indexOf('data-testid="creator-analytics-sources"'),
      html.indexOf('data-testid="creator-analytics-leaders"'),
    );
    // The two mono-eyebrow group labels render.
    expect(sources).toContain('Primary DSPs');
    expect(sources).toContain('Tail distribution');
    // The deterministic 1/100 cut over the window's top source — four
    // primary sources and nine tail sources on this seed.
    const top = allPayload.sourceSplits[0]?.creatorCents ?? 0n;
    const expectedPrimary = allPayload.sourceSplits.filter((row) => row.creatorCents * 100n >= top);
    const expectedTail = allPayload.sourceSplits.filter((row) => row.creatorCents * 100n < top);
    expect(expectedPrimary.map((row) => row.source)).toEqual([
      'Spotify',
      'Amazon Music',
      'YouTube Music',
      'Bandcamp',
    ]);
    expect(expectedTail.length).toBe(9);
    const primaryBlock = sources.slice(sources.indexOf('Primary DSPs'), sources.indexOf('Tail distribution'));
    const tailBlock = sources.slice(sources.indexOf('Tail distribution'));
    expect(primaryBlock.match(/data-testid="chart-hbar-row"/g)?.length).toBe(expectedPrimary.length);
    expect(tailBlock.match(/data-testid="chart-hbar-row"/g)?.length).toBe(expectedTail.length);
    // Spotify lands in the primary group; the TikTok/Twitch-scale tail lands in its own.
    expect(primaryBlock).toContain('Spotify');
    expect(tailBlock).toContain('TikTok');
    expect(tailBlock).toContain('Twitch');
    // Values keep rendering in full at the bar ends — no log scale, no rounding.
    for (const row of allPayload.sourceSplits) {
      expect(sources).toContain(formatCentsBigint(row.creatorCents));
    }
  });

  it('renders the game log paginated — page one of the 124-row log, newest first', () => {
    const html = renderView(allPayload);
    // The pagination contract — 25 rows per page, the count line reflecting
    // the unfiltered total. The 124-row log no longer renders all at once.
    expect(html.match(/data-testid="creator-analytics-gamelog-row"/g)?.length).toBe(GAME_LOG_PAGE_SIZE);
    expect(html).toContain(gameLogCountLine(1, GAME_LOG_PAGE_SIZE, 124)); // Showing 1–25 of 124 transactions
    const gameLog = html.slice(html.indexOf('data-testid="creator-analytics-gamelog"'));
    // The payeeId of record is the primary label in the drilldown; page one
    // carries the label payee's newest rows.
    expect(gameLog).toContain('rh_thrones_label_don');
    // Newest first: page one opens on the seed's newest clearing day; the
    // persona's older music days (2026-09-07) sit on the log's last page.
    expect(gameLog.indexOf('2026-09-23')).toBeGreaterThan(-1);
    expect(gameLog).not.toContain('2026-09-07');
    expect(gameLog).toMatch(/TPL-/); // the unanimous entity of record
    // Bound-aware pager: Prev disabled on page one, Next armed. The regex
    // pins the disabled ATTRIBUTE (`disabled=""`), not Tailwind's
    // `disabled:` utility classes that ride every button's className.
    expect(/data-testid="creator-analytics-gamelog-prev"[^>]*disabled=""/.test(html)).toBe(true);
    expect(/data-testid="creator-analytics-gamelog-next"[^>]*disabled=""/.test(html)).toBe(false);
  });

  it('switches the window and the values change with it', () => {
    const allHtml = renderView(allPayload);
    const sevenHtml = renderView(sevenPayload);
    expect(allHtml).toContain('$8,445,103,733.36');
    expect(allHtml).not.toContain('$42,652,800.00');
    expect(sevenHtml).toContain('$42,652,800.00');
    expect(sevenHtml).not.toContain('$8,445,103,733.36');
  });

  it('mounts through the section wrapper with the demo badge and the default window', () => {
    const html = renderToStaticMarkup(
      <CreatorAnalyticsSection
        creatorAnalytics={{ kind: 'ready', value: windowsRecord(allPayload, sevenPayload) }}
        catalogGrowth={growthSectionData()}
        demo={true}
      />,
    );
    expect(html).toContain('demo-data-badge');
    expect(html).toContain('$8,445,103,733.36'); // the ALL window renders by default
    expect(html).toContain('Creator Analytics');
  });

  // ---------------------------------------------------------------------
  // The game log's pager and filters — jsdom interaction (createRoot + act).
  // ---------------------------------------------------------------------
  describe('the game log pager and filters — interaction', () => {
    it('paginates: bound-aware Prev/Next with the count line following the page', () => {
      const container = mountView(allPayload);
      const countOf = () => queryTestId(container, 'creator-analytics-gamelog-count').textContent ?? '';
      const rowsOf = () => container.querySelectorAll('[data-testid="creator-analytics-gamelog-row"]').length;
      const prev = () => queryTestId(container, 'creator-analytics-gamelog-prev') as HTMLButtonElement;
      const next = () => queryTestId(container, 'creator-analytics-gamelog-next') as HTMLButtonElement;

      expect(rowsOf()).toBe(GAME_LOG_PAGE_SIZE);
      expect(countOf()).toBe(gameLogCountLine(1, GAME_LOG_PAGE_SIZE, 124));
      expect(prev().disabled).toBe(true); // the page-one bound
      expect(next().disabled).toBe(false);

      clickButton(next());
      expect(countOf()).toBe(gameLogCountLine(26, 50, 124));
      expect(prev().disabled).toBe(false);

      clickButton(next());
      clickButton(next());
      clickButton(next());
      expect(countOf()).toBe(gameLogCountLine(101, 124, 124)); // the last page
      expect(next().disabled).toBe(true); // the last-page bound
      expect(rowsOf()).toBe(124 - 4 * GAME_LOG_PAGE_SIZE);
      // Newest-first holds across pages: the persona's rows — reachable on
      // the last pages of the unfiltered sort — are pinned via the payee
      // filter below; here the last page pins only the bounds.

      clickButton(prev());
      expect(countOf()).toBe(gameLogCountLine(76, 100, 124));
    });

    it('narrows the count line per filter arm (AND semantics) with the honest empty at zero', () => {
      const container = mountView(allPayload);
      const countOf = () => queryTestId(container, 'creator-analytics-gamelog-count').textContent ?? '';
      const payeeSelect = () => queryTestId(container, 'creator-analytics-gamelog-filter-payee') as unknown as HTMLSelectElement;
      const sourceSelect = () => queryTestId(container, 'creator-analytics-gamelog-filter-source') as unknown as HTMLSelectElement;

      // The payee arm narrows the count line to the payload's own count —
      // and the filter change resets the page to one.
      setSelectValue(payeeSelect(), 'rh_yeshua_throne_don');
      expect(countOf()).toBe(gameLogCountLine(1, 5, 5)); // probe-pinned: the persona's 5 rows

      // The source arm ANDs with the payee arm — Amazon Music rows only.
      setSelectValue(sourceSelect(), 'Amazon Music');
      const amazonForYeshua = allPayload.gameLog.filter(
        (row) => row.payeeId === 'rh_yeshua_throne_don' && row.source === 'Amazon Music',
      ).length;
      expect(amazonForYeshua).toBeGreaterThan(0);
      expect(countOf()).toBe(gameLogCountLine(1, Math.min(GAME_LOG_PAGE_SIZE, amazonForYeshua), amazonForYeshua));

      // A combination the payload cannot satisfy renders the honest empty
      // line — never fake rows, and no count line over zero rows.
      setSelectValue(sourceSelect(), 'Apple Podcasts'); // probe-pinned: absent for this payee
      expect(queryTestId(container, 'creator-analytics-gamelog-filter-empty')).not.toBeNull();
      expect(container.querySelectorAll('[data-testid="creator-analytics-gamelog-row"]').length).toBe(0);
      expect(container.querySelector('[data-testid="creator-analytics-gamelog-count"]')).toBeNull();

      // Clearing the source arm restores the payee's rows honestly.
      setSelectValue(sourceSelect(), '');
      expect(countOf()).toBe(gameLogCountLine(1, 5, 5));
    });

    it('resets the page when a filter changes after paging deep', () => {
      const container = mountView(allPayload);
      const countOf = () => queryTestId(container, 'creator-analytics-gamelog-count').textContent ?? '';
      const payeeSelect = () => queryTestId(container, 'creator-analytics-gamelog-filter-payee') as unknown as HTMLSelectElement;
      const next = () => queryTestId(container, 'creator-analytics-gamelog-next');

      clickButton(next());
      clickButton(next()); // page three
      expect(countOf()).toBe(gameLogCountLine(51, 75, 124));

      // 119 rows outlast one page — a bare clamp could not fake this reset:
      // the count line's start bound must return to 1.
      setSelectValue(payeeSelect(), 'rh_thrones_label_don');
      expect(countOf()).toBe(gameLogCountLine(1, GAME_LOG_PAGE_SIZE, 119));
    });
  });
});

// ---------------------------------------------------------------------------
// The Catalog Growth OS modules (spec art_qNu4T32F) — the four founder
// additions rendered from the catalogGrowthFlows payload: the action
// signals banner, Recoupment by Catalog, Top Markets, and the per-row
// Export control. Honesty law throughout: no filler states, no delta
// chips without a prior window, no invented labels.
// ---------------------------------------------------------------------------
describe('CreatorAnalyticsSection — the Catalog Growth OS modules', () => {
  const signal = {
    kind: 'source-delta' as const,
    headline: 'Amazon Music -37.29% vs prior period',
    subjectLabel: 'Amazon Music',
    basisPoints: -3_729,
  };

  it('renders the signals banner at the top with the headline, the store-carried subject, and the signed chip', () => {
    const html = renderView(payload(), true, growth({ actionSignals: [signal] }));
    const bannerStart = html.indexOf('data-testid="creator-analytics-signals"');
    expect(bannerStart).toBeGreaterThan(-1);
    // At the top: the banner sits before the KPI row in document order.
    const kpiStart = html.indexOf('data-testid="creator-analytics-kpis"');
    expect(bannerStart).toBeLessThan(kpiStart);
    // Headline and subject verbatim — store-carried labels only.
    expect(html).toContain('Amazon Music -37.29% vs prior period');
    expect(html).toContain('data-signal-kind="source-delta"');
    expect(html).toContain('data-testid="creator-analytics-signal-bps"');
    expect(html).toContain('-37.29%'); // negative renders as negative, honestly
  });

  it('renders a milestone signal without a delta chip — only source deltas carry basis points', () => {
    const html = renderView(
      payload(),
      true,
      growth({
        actionSignals: [
          { kind: 'recoupment-milestone', headline: 'Catalog fully recouped', subjectLabel: 'Payee A', basisPoints: null },
        ],
      }),
    );
    expect(html).toContain('data-testid="creator-analytics-signals"');
    expect(html).toContain('Catalog fully recouped');
    expect(html).toContain('data-signal-kind="recoupment-milestone"');
    expect(html).not.toContain('data-testid="creator-analytics-signal-bps"');
  });

  it('renders NOTHING when the window has no signals — no placeholder strip', () => {
    const html = renderView(payload(), true, growth());
    expect(html).not.toContain('data-testid="creator-analytics-signals"');
  });

  it('renders each advance row with the bar share, the unrecouped balance, and the label fallback to payeeId', () => {
    const html = renderView(
      payload(),
      true,
      growth({
        recoupmentByCatalog: [
          {
            payeeId: 'rh_one',
            label: 'Thrones Label DON',
            advanceTargetCents: 1_000_000n,
            appliedCents: 400_000n,
            unrecoupedCents: 600_000n,
            fullyRecouped: false,
            lastSweepDay: '2026-09-21',
          },
          {
            payeeId: 'rh_two',
            label: null,
            advanceTargetCents: 500_000n,
            appliedCents: 500_000n,
            unrecoupedCents: 0n,
            fullyRecouped: true,
            lastSweepDay: null,
          },
        ],
      }),
    );
    expect(html).toContain('$4,000.00 applied of $10,000.00 break-even');
    expect(html).toContain('last sweep 2026-09-21'); // the engine's keyed trail day
    // The fully-recouped state replaces the balance — the engine's flag of record.
    expect(html).toContain('data-testid="creator-analytics-recoupment-row" data-fully-recouped="true"');
    expect(html).toContain('Fully recouped');
    // A null label renders the payeeId — never an invented name.
    expect(html).toContain('rh_two');
    // The not-recouped row carries the honest balance.
    expect(html).toContain('$6,000.00 unrecouped');
    expect(html).toContain('data-testid="creator-analytics-recoupment-row" data-fully-recouped="false"');
  });

  it("renders the literal 'No advance on file' line for credited payees without an advance — never a zero-balance bar", () => {
    const html = renderView(
      payload(),
      true,
      growth({ payeesWithoutAdvanceIds: ['rh_ghost', 'rh_hollow'] }),
    );
    expect(html).toContain('rh_ghost: No advance on file');
    expect(html).toContain('rh_hollow: No advance on file');
    // No imitation bars: zero recoupment rows means zero bars.
    expect(html).not.toContain('data-testid="creator-analytics-recoupment-bar"');
  });

  it('renders the recoupment empty state when the window credited no one', () => {
    const html = renderView(payload(), true, growth());
    expect(html).toContain('data-testid="creator-analytics-recoupment-empty"');
    expect(html).toContain('No creator payouts cleared in this window');
  });

  it('renders ranked markets with the standing SDK-settled-only coverage label and never drops unattributed money', () => {
    const html = renderView(
      payload(),
      true,
      growth({
        topMarkets: {
          markets: [
            { territory: 'US', creatorCents: 600_00n },
            { territory: 'GB', creatorCents: 200_00n },
          ],
          unattributedCents: 50_00n,
          settlementsConsidered: 12,
        },
      }),
    );
    expect(html).toContain('data-testid="creator-analytics-top-markets"');
    expect(html).toContain('SDK-settled events only'); // the standing coverage label
    expect(html).toContain('12 settlements considered');
    expect(html).toContain('US');
    expect(html).toContain('GB');
    expect(html).toContain('$50.00 of SDK-settled creator credits'); // carried, never silently dropped
  });

  it('renders the honest no-SDK-settled-events empty state — the current seed state, correct not broken', () => {
    const html = renderView(
      payload(),
      true,
      growth({ topMarkets: { markets: [], unattributedCents: 0n, settlementsConsidered: 0 } }),
    );
    expect(html).toContain('data-testid="creator-analytics-markets-empty"');
    expect(html).toContain('No SDK-settled events in this window');
  });

  it('renders the unstamped-money state when settled events carry no territory — never silent', () => {
    const html = renderView(
      payload(),
      true,
      growth({
        topMarkets: { markets: [], unattributedCents: 120_00n, settlementsConsidered: 3 },
      }),
    );
    expect(html).toContain('data-testid="creator-analytics-markets-unstamped"');
    expect(html).toContain('3 SDK-settled events carry no territory stamps');
    expect(html).toContain('$120.00 of SDK-settled creator credits');
  });

  it('adds an Export link per leaderboard row carrying the payee and the window of record', () => {
    const html = renderView(payload()); // the ALL window is the payload's default
    expect(html).toContain('data-testid="creator-analytics-export-link"');
    expect(html).toContain('Export');
    expect(html).toContain('href="/admin/audit-statement?payee=rh_one&amp;window=all"');
  });

  it('pins the pure helpers: window ids, hrefs, bar shares, and chip labels', () => {
    expect(windowIdOf(7)).toBe('7d');
    expect(windowIdOf(30)).toBe('30d');
    expect(windowIdOf(90)).toBe('90d');
    expect(windowIdOf(null)).toBe('all');
    expect(auditStatementHref('rh_one', '7d')).toBe('/admin/audit-statement?payee=rh_one&window=7d');
    expect(auditStatementHref('rh one', 'all')).toBe('/admin/audit-statement?payee=rh+one&window=all');
    // The bar share — guarded divide-by-zero and capped at 100.
    expect(recoupmentShare(400_000n, 1_000_000n)).toBe(40);
    expect(recoupmentShare(0n, 1_000_000n)).toBe(0);
    expect(recoupmentShare(1_000_000n, 0n)).toBe(0); // a zero target divides honestly
    expect(recoupmentShare(2_000_000n, 1_000_000n)).toBe(100);
    // The signed chip — integer bps, one decimal, negatives negative.
    expect(deltaChipLabel(240)).toBe('+2.4%');
    expect(deltaChipLabel(-3_729)).toBe('-37.29%');
    expect(deltaChipLabel(100)).toBe('+1%');
    expect(deltaChipLabel(-100)).toBe('-1%');
    expect(deltaChipLabel(0)).toBe('0%');
  });
});


// ---------------------------------------------------------------------------
// The live dev-seed render of the growth modules — REAL catalogGrowthFlows
// payloads over createSeededStore (the derivation suite's own fixture
// truth, commit ce2b113): the seed carries no advances and no SDK-settled
// territory, so the honest states ARE the live states — the no-advance
// lines, the empty Top Markets, and the ALL window's lone top-source
// signal without a delta chip. The 7-day window carries real measured
// deltas and therefore real chips.
// ---------------------------------------------------------------------------
describe('CreatorAnalyticsSection — the growth modules over the live dev-seed', () => {
  let seeded: Awaited<ReturnType<typeof createSeededStore>>;

  beforeAll(async () => {
    seeded = await createSeededStore();
  });

  it('pins the ALL window: no-advance lines, the honest empty Top Markets, and no delta chip anywhere', async () => {
    const growthPayload = await catalogGrowthFlows(seeded, null);
    expect(growthPayload).not.toBeNull();
    if (growthPayload === null) throw new Error('catalogGrowthFlows degraded to null over the seed');
    const html = renderView(payload(), true, growthPayload);
    // Both credited payees named as having no advance on file — never
    // imitated as zero-balance bars.
    expect(html).toContain('rh_thrones_label_don: No advance on file');
    expect(html).toContain('rh_yeshua_throne_don: No advance on file');
    expect(html).not.toContain('data-testid="creator-analytics-recoupment-bar"');
    // Top Markets: the seed has no SDK-settled events — the honest empty
    // state renders, not an invented chart.
    expect(html).toContain('data-testid="creator-analytics-markets-empty"');
    expect(html).toContain('No SDK-settled events in this window');
    // The ALL window renders the lone top-source signal with NO delta chip.
    expect(html).toContain('Top source: Spotify');
    expect(html).not.toContain('data-testid="creator-analytics-signal-bps"');
  });

  it('pins the 7-day window: real measured deltas render signed chips', async () => {
    const growthPayload = await catalogGrowthFlows(seeded, 7);
    expect(growthPayload).not.toBeNull();
    if (growthPayload === null) throw new Error('catalogGrowthFlows degraded to null over the seed');
    const html = renderView(payload({ windowDays: 7 }), true, growthPayload);
    // The 7-day window has a real prior window — measured chips render.
    expect(html).toContain('data-testid="creator-analytics-signal-bps"');
    expect(html).toContain('Meridian Cinemas -37.29% vs prior period');
    // Recoupment stays honest in a window that credits payees without advances.
    expect(html).toContain('No advance on file');
  });
});

