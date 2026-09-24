/**
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
 *    pin is untouched by this file), the 124-row game log newest first,
 *    and the window switch changing every value.
 *
 * renderToStaticMarkup under the node environment — the house convention.
 * Store-read figures only; nothing invented.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { createSeededStore } from '@/lib/server/devSeed';
import {
  creatorAnalytics,
  type CreatorAnalyticsFlows,
  type CreatorGameLogRow,
  type CreatorPayoutRow,
} from '@/lib/admin/creatorAnalytics';

import {
  CreatorAnalyticsSection,
  CreatorAnalyticsView,
  heatShare,
  payeeDisplayName,
} from '../CreatorAnalyticsSection';
import type { CreatorAnalyticsWindows } from '../../types';

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

function renderView(flows: CreatorAnalyticsFlows, demo = true): string {
  return renderToStaticMarkup(<CreatorAnalyticsView flows={flows} demo={demo} onWindowChange={() => {}} />);
}

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

  it('renders the 124-row game log in the module order — newest first', () => {
    const html = renderView(allPayload);
    expect(html.match(/data-testid="creator-analytics-gamelog-row"/g)?.length).toBe(124);
    const gameLog = html.slice(html.indexOf('data-testid="creator-analytics-gamelog"'));
    // The payeeId of record is the primary label in the drilldown.
    expect(gameLog).toContain('rh_thrones_label_don');
    expect(gameLog).toContain('rh_yeshua_throne_don');
    // Newest first: the seed's newest clearing day renders before the persona's last music day.
    expect(gameLog.indexOf('2026-09-23')).toBeLessThan(gameLog.indexOf('2026-09-07'));
    expect(gameLog).toMatch(/TPL-/); // the unanimous entity of record
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
        demo={true}
      />,
    );
    expect(html).toContain('demo-data-badge');
    expect(html).toContain('$8,445,103,733.36'); // the ALL window renders by default
    expect(html).toContain('Creator Analytics');
  });
});
