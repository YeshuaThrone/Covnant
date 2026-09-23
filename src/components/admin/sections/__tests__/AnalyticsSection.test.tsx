/**
 * AnalyticsSection — the Elite Dashboard company page's suite. Three
 * layers, mirroring the primitives' and derivation's suites:
 *
 * 1. The pure presentation helpers — sort orders (ties stable, momentum
 *    nulls last in both directions), the momentum and heat voices, the
 *    cohort-rank lookup, and the promised-vs-cleared aggregation.
 * 2. Fixture renders of the pure view — the six KPI cards, the window
 *    filter's pressed state, the publishing tie's shared rank with the
 *    next rank vacant, sort reordering through rendered row order, the
 *    honest nulls (source, flow kind, run id, avg), the promised
 *    comparison's canon-absence copy, and the empty-window honest state.
 * 3. The live dev-seed render — the REAL derivation payloads for the
 *    `all` and `7d` windows over the widened store, pinning the exact
 *    totals the seed reconciliation calls for (KPIs, flow-kind splits,
 *    industry rows), the daily curve's point counts, the full
 *    leaderboard (29 entities, TPL-MUS-001 at rank 1, the publishing
 *    tie LIT-003/LIT-004 shared at company rank 21 with 22 vacant AND
 *    cohort rank 3 of 9 with 4 vacant), the Total row, the extended
 *    brand-exclusion boundary (counterparties never render in the
 *    structural markup; the game log's source column is the run's own
 *    field of record), and the window switch changing the KPI values.
 *
 * renderToStaticMarkup under the node environment — the house
 * convention. Store-read figures only; nothing invented.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { bootDevSeedStore, getSeededStore } from '@/lib/server/devSeed';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { companyAnalytics } from '@/lib/admin/companyAnalytics';
import type { AnalyticsWindow, CompanyAnalytics, GameLogRow, LeaderboardRow } from '@/lib/admin/companyAnalytics';
import { entityIntelligence, type EntityIntelligence } from '@/lib/admin/entityIntelligence';
import {
  bindAtomicEntity,
  bindFactoryEntity,
  resolveAtomicRegistry,
  resolveMasterTemplates,
} from '@/lib/master/masterStore';

import {
  AnalyticsSection,
  CompanyAnalyticsView,
  cohortRankLabel,
  formatMomentumPercent,
  heatShare,
  momentumHeat,
  nextGameLogSort,
  nextLeaderboardSort,
  promisedClearedRows,
  sortGameLog,
  sortLeaderboard,
  type GameLogSort,
  type LeaderboardSort,
} from '../AnalyticsSection';
import type { CompanyAnalyticsWindows } from '../../types';

// ---------------------------------------------------------------------------
// Fixtures — the real payload shapes, small and honest.
// ---------------------------------------------------------------------------

function readout(overrides: Partial<EntityIntelligence> & Pick<EntityIntelligence, 'templateId' | 'class'>): EntityIntelligence {
  return {
    promisedUSD: null,
    cleared: 0n,
    trend: [],
    cohort: { rank: 1n, of: 1n },
    ...overrides,
  } as EntityIntelligence;
}

function leaderboardRow(
  overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, 'entityId' | 'rank'>,
): LeaderboardRow {
  return {
    classLabel: 'LITERARY_WORK',
    rankOf: 4,
    grossCents: 1_000_00n,
    creatorPaidCents: 350_00n,
    runCount: 1,
    momentum30: null,
    spark: [500_00n, 1_000_00n],
    ...overrides,
  };
}

function gameLogRow(overrides: Partial<GameLogRow> & Pick<GameLogRow, 'runId' | 'day'>): GameLogRow {
  return {
    entityId: 'TPL-LIT-001',
    classLabel: 'LITERARY_WORK',
    flowKind: 'ROYALTY_DISTRIBUTION',
    source: 'Meridian Cinemas',
    grossCents: 1_000_00n,
    creatorCents: 350_00n,
    opsCents: 150_00n,
    companyCents: 500_00n,
    ...overrides,
  };
}

function payload(overrides: Partial<CompanyAnalytics> = {}): CompanyAnalytics {
  return {
    window: 'all',
    kpis: {
      totalClearedCents: 1_000_00n,
      creatorPaidCents: 350_00n,
      operationsYieldCents: 150_00n,
      companyReserveCents: 500_00n,
      runCount: 1,
      avgRunCents: 1_000_00n,
    },
    daily: [{ day: '2026-09-23', grossCents: 1_000_00n, creatorCents: 350_00n, opsCents: 150_00n }],
    flowKindSplit: [{ kind: 'ROYALTY_DISTRIBUTION', runCount: 1, grossCents: 1_000_00n }],
    industryTotals: [{ industry: 'PUBLISHING', label: 'PUBLISHING', grossCents: 1_000_00n, runCount: 1 }],
    leaderboard: [leaderboardRow({ entityId: 'TPL-LIT-001', rank: 1 })],
    gameLog: [gameLogRow({ runId: 'run-1', day: '2026-09-23' })],
    ...overrides,
  };
}

function windowsRecord(all: CompanyAnalytics, seven: CompanyAnalytics): CompanyAnalyticsWindows {
  return { '7d': seven, '30d': all, '90d': all, all };
}

function renderView(
  analytics: CompanyAnalytics,
  intelligence: { kind: 'ready'; value: readonly EntityIntelligence[] } | { kind: 'unavailable'; code: string; message: string } = {
    kind: 'ready',
    value: [],
  },
  leaderboardSort: LeaderboardSort = { key: 'rank', dir: 'asc' },
  gameLogSort: GameLogSort = { key: 'day', dir: 'desc' },
): string {
  return renderToStaticMarkup(
    <CompanyAnalyticsView
      analytics={analytics}
      intelligence={intelligence}
      demo={true}
      onWindowChange={() => {}}
      leaderboardSort={leaderboardSort}
      onLeaderboardSort={() => {}}
      gameLogSort={gameLogSort}
      onGameLogSort={() => {}}
    />,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('analytics presentation helpers', () => {
  it('sorts the leaderboard by rank ascending with stable id tiebreaks', () => {
    const rows = [
      leaderboardRow({ entityId: 'TPL-B-001', rank: 2 }),
      leaderboardRow({ entityId: 'TPL-A-001', rank: 1 }),
      leaderboardRow({ entityId: 'TPL-A-000', rank: 2 }),
    ];
    const sorted = sortLeaderboard(rows, { key: 'rank', dir: 'asc' });
    expect(sorted.map((r) => r.entityId)).toEqual(['TPL-A-001', 'TPL-A-000', 'TPL-B-001']);
  });

  it('sorts by gross both ways through bigint comparison', () => {
    const rows = [
      leaderboardRow({ entityId: 'TPL-SMALL', rank: 2, grossCents: 100n }),
      leaderboardRow({ entityId: 'TPL-BIG', rank: 1, grossCents: 900n }),
    ];
    const desc = sortLeaderboard(rows, { key: 'gross', dir: 'desc' });
    expect(desc.map((r) => r.entityId)).toEqual(['TPL-BIG', 'TPL-SMALL']);
    const asc = sortLeaderboard(rows, { key: 'gross', dir: 'asc' });
    expect(asc.map((r) => r.entityId)).toEqual(['TPL-SMALL', 'TPL-BIG']);
  });

  it('sorts momentum with nulls last in BOTH directions', () => {
    const rows = [
      leaderboardRow({ entityId: 'TPL-NULL', rank: 1, momentum30: null }),
      leaderboardRow({ entityId: 'TPL-LOW', rank: 2, momentum30: 10 }),
      leaderboardRow({ entityId: 'TPL-HIGH', rank: 3, momentum30: 2000 }),
    ];
    const desc = sortLeaderboard(rows, { key: 'momentum', dir: 'desc' });
    expect(desc.map((r) => r.entityId)).toEqual(['TPL-HIGH', 'TPL-LOW', 'TPL-NULL']);
    const asc = sortLeaderboard(rows, { key: 'momentum', dir: 'asc' });
    expect(asc.map((r) => r.entityId)).toEqual(['TPL-LOW', 'TPL-HIGH', 'TPL-NULL']);
  });

  it('does not mutate the input rows', () => {
    const rows = [
      leaderboardRow({ entityId: 'TPL-A-001', rank: 2, grossCents: 1n }),
      leaderboardRow({ entityId: 'TPL-B-001', rank: 1, grossCents: 2n }),
    ];
    sortLeaderboard(rows, { key: 'gross', dir: 'desc' });
    expect(rows.map((r) => r.entityId)).toEqual(['TPL-A-001', 'TPL-B-001']);
  });

  it('clicks flip the same key and default a new key to its natural order', () => {
    const base: LeaderboardSort = { key: 'rank', dir: 'asc' };
    expect(nextLeaderboardSort(base, 'rank')).toEqual({ key: 'rank', dir: 'desc' });
    expect(nextLeaderboardSort(base, 'gross')).toEqual({ key: 'gross', dir: 'desc' });
    const gross: LeaderboardSort = { key: 'gross', dir: 'desc' };
    expect(nextLeaderboardSort(gross, 'gross')).toEqual({ key: 'gross', dir: 'asc' });
    const logBase: GameLogSort = { key: 'day', dir: 'desc' };
    expect(nextGameLogSort(logBase, 'day')).toEqual({ key: 'day', dir: 'asc' });
    expect(nextGameLogSort(logBase, 'gross')).toEqual({ key: 'gross', dir: 'desc' });
  });

  it('sorts the game log newest first and by gross on demand', () => {
    const rows = [
      gameLogRow({ runId: 'run-older', day: '2026-09-20' }),
      gameLogRow({ runId: 'run-newer', day: '2026-09-23' }),
    ];
    const byDay = sortGameLog(rows, { key: 'day', dir: 'desc' });
    expect(byDay.map((r) => r.runId)).toEqual(['run-newer', 'run-older']);
    const byDayAsc = sortGameLog(rows, { key: 'day', dir: 'asc' });
    expect(byDayAsc.map((r) => r.runId)).toEqual(['run-older', 'run-newer']);
    const big = gameLogRow({ runId: 'run-big', day: '2026-09-21', grossCents: 5_000_00n });
    const byGross = sortGameLog([...rows, big], { key: 'gross', dir: 'desc' });
    expect(byGross[0]?.runId).toBe('run-big');
  });

  it('voices momentum honestly — dash for no prior point, true sign both ways', () => {
    expect(formatMomentumPercent(null)).toBe('—');
    expect(formatMomentumPercent(0)).toBe('0%');
    expect(formatMomentumPercent(1245)).toBe('+1,245%');
    expect(formatMomentumPercent(-42)).toBe('−42%');
  });

  it('heats momentum gains only — nulls and losses carry no gold', () => {
    expect(momentumHeat(null, 1000)).toBe(0);
    expect(momentumHeat(-500, 1000)).toBe(0);
    expect(momentumHeat(500, 0)).toBe(0);
    expect(momentumHeat(500, 1000)).toBe(0.5);
    expect(momentumHeat(2500, 1000)).toBe(1);
  });

  it('heats money by floored bigint share of the column peak', () => {
    expect(heatShare(0n, 1000n)).toBe(0);
    expect(heatShare(500n, 0n)).toBe(0);
    expect(heatShare(250n, 1000n)).toBe(0.25);
    expect(heatShare(1n, 1000n)).toBe(0); // sub-1% floors to no heat — honest
    expect(heatShare(1000n, 1000n)).toBe(1);
  });

  it('voices the per-class cohort benchmark', () => {
    const readouts = [
      readout({ templateId: 'TPL-LIT-003', class: 'LITERARY_WORK', cohort: { rank: 3n, of: 9n } }),
    ];
    expect(cohortRankLabel(readouts, 'TPL-LIT-003')).toBe('3 of 9');
    expect(cohortRankLabel(readouts, 'TPL-LIT-004')).toBeNull();
  });

  it('aggregates promised vs cleared per class — cents pass through, union of both sides, nulls honest', () => {
    const leaderboard = [
      leaderboardRow({ entityId: 'TPL-FILM-1', rank: 1, classLabel: 'FEATURE_FILM', grossCents: 300_00n }),
      leaderboardRow({ entityId: 'TPL-LIT-1', rank: 2, classLabel: 'LITERARY_WORK', grossCents: 100_00n }),
    ];
    const readouts = [
      readout({ templateId: 'TPL-FILM-1', class: 'FEATURE_FILM', promisedUSD: 1_140_000_0n }),
      readout({ templateId: 'TPL-LIT-1', class: 'LITERARY_WORK' }), // no promised field in canon
      readout({ templateId: 'TPL-TRN-1', class: 'TOURNAMENT_EVENT', promisedUSD: 1_250_000_0n }), // promised, nothing cleared
    ];
    const rows = promisedClearedRows(leaderboard, readouts);
    expect(rows).toEqual([
      { label: 'Feature films', promisedCents: 1_140_000_0n, clearedCents: 300_00n },
      { label: 'Literary works', promisedCents: null, clearedCents: 100_00n },
      { label: 'Tournament events', promisedCents: 1_250_000_0n, clearedCents: 0n },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fixture renders — the pure view
// ---------------------------------------------------------------------------

describe('CompanyAnalyticsView — fixture renders', () => {
  it('renders the six KPI cards with exact figures and the honest avg dash', () => {
    const html = renderView(
      payload({ kpis: { ...payload().kpis, avgRunCents: null, runCount: 0 } }),
    );
    expect(html).toContain('$1,000.00'); // total cleared
    expect(html).toContain('$350.00'); // creator paid
    expect(html).toContain('$150.00'); // operations yield
    expect(html).toContain('$500.00'); // company reserve
    expect(html).toContain('data-testid="analytics-kpi-avg-run"');
    expect(html).toContain('No runs cleared yet');
  });

  it('lights the window filter from the payload itself', () => {
    const html = renderView(payload({ window: '7d' }));
    expect(html).toContain('data-testid="analytics-window-7d"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-testid="analytics-window-all"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('discloses the demo door through the badge', () => {
    const html = renderView(payload());
    expect(html).toContain('demo-data-badge');
  });

  it('renders the publishing tie as a shared rank with the next rank vacant', () => {
    const html = renderView(
      payload({
        leaderboard: [
          leaderboardRow({ entityId: 'TPL-A-001', rank: 1 }),
          leaderboardRow({ entityId: 'TPL-LIT-003', rank: 2, rankOf: 4 }),
          leaderboardRow({ entityId: 'TPL-LIT-004', rank: 2, rankOf: 4 }),
        ],
      }),
    );
    expect(html.match(/data-rank="2"/g)?.length).toBe(2);
    expect(html).not.toContain('data-rank="3"'); // the tie leaves rank 3 vacant
    expect(html.match(/ \/ 4<\/span>/g)?.length).toBe(3); // every row voices the rank-of denominator
  });

  it('carries the per-class cohort benchmark beside the company rank', () => {
    const html = renderView(
      payload({
        leaderboard: [leaderboardRow({ entityId: 'TPL-LIT-003', rank: 1 })],
      }),
      { kind: 'ready', value: [readout({ templateId: 'TPL-LIT-003', class: 'LITERARY_WORK', cohort: { rank: 3n, of: 9n } })] },
    );
    expect(html).toContain('3 of 9');
  });

  it('reorders leaderboard rows through the sort props', () => {
    const analytics = payload({
      leaderboard: [
        leaderboardRow({ entityId: 'TPL-BIG', rank: 1, grossCents: 900_00n }),
        leaderboardRow({ entityId: 'TPL-SMALL', rank: 2, grossCents: 100_00n }),
      ],
    });
    const rankOrder = renderView(analytics, undefined, { key: 'rank', dir: 'asc' });
    expect(rankOrder.indexOf('TPL-BIG')).toBeLessThan(rankOrder.indexOf('TPL-SMALL'));
    const grossAsc = renderView(analytics, undefined, { key: 'gross', dir: 'asc' });
    expect(grossAsc.indexOf('TPL-SMALL')).toBeLessThan(grossAsc.indexOf('TPL-BIG'));
    const grossDesc = renderView(analytics, undefined, { key: 'gross', dir: 'desc' });
    expect(grossDesc.indexOf('TPL-BIG')).toBeLessThan(grossDesc.indexOf('TPL-SMALL'));
  });

  it('reorders game-log rows through the sort props', () => {
    const analytics = payload({
      gameLog: [
        gameLogRow({ runId: 'run-old', day: '2026-09-20' }),
        gameLogRow({ runId: 'run-new', day: '2026-09-23' }),
      ],
    });
    const newestFirst = renderView(analytics, undefined, { key: 'rank', dir: 'asc' }, { key: 'day', dir: 'desc' });
    expect(newestFirst.indexOf('run-new')).toBeLessThan(newestFirst.indexOf('run-old'));
    const oldestFirst = renderView(analytics, undefined, { key: 'rank', dir: 'asc' }, { key: 'day', dir: 'asc' });
    expect(oldestFirst.indexOf('run-old')).toBeLessThan(oldestFirst.indexOf('run-new'));
  });

  it('renders the game log nulls honestly — dash, never a fabricated string', () => {
    const html = renderView(
      payload({
        gameLog: [
          gameLogRow({
            runId: null,
            day: '2026-09-23',
            entityId: null,
            classLabel: null,
            flowKind: null,
            source: null,
          }),
        ],
      }),
    );
    expect(html).not.toContain('ROYALTY_DISTRIBUTION');
    const gameLogBlock = html.slice(html.indexOf('data-testid="analytics-gamelog"'));
    expect(gameLogBlock).not.toContain('Meridian Cinemas');
  });

  it('states the promised comparison honestly when the intelligence read is down', () => {
    const html = renderView(payload(), {
      kind: 'unavailable',
      code: 'intelligence_store_failed',
      message: 'Intelligence store read failed.',
    });
    expect(html).toContain('analytics-promised-unavailable');
    expect(html).toContain('The promised readout is unavailable');
  });

  it('renders an empty window as copy and honest zeros — never a blank block', () => {
    const html = renderView(
      payload({
        kpis: {
          totalClearedCents: 0n,
          creatorPaidCents: 0n,
          operationsYieldCents: 0n,
          companyReserveCents: 0n,
          runCount: 0,
          avgRunCents: null,
        },
        daily: [],
        flowKindSplit: [],
        industryTotals: [],
        leaderboard: [],
        gameLog: [],
      }),
    );
    expect(html).toContain('analytics-empty-window');
    expect(html).toContain('No runs cleared in this window');
    expect(html).toContain('analytics-leaderboard-empty');
    expect(html).toContain('analytics-gamelog-empty');
    expect(html).not.toContain('analytics-leaderboard-row');
  });

  it('renders the section wrapper: default window, and the honest unavailable state', () => {
    const allPayload = payload();
    const seven = payload({ window: '7d' as AnalyticsWindow, kpis: { ...allPayload.kpis, totalClearedCents: 42_652_800_00n } });
    const section = renderToStaticMarkup(
      <AnalyticsSection
        analytics={{ kind: 'ready', value: windowsRecord(allPayload, seven) }}
        intelligence={{ kind: 'ready', value: [] }}
        demo={true}
      />,
    );
    expect(section).toContain('$1,000.00'); // the 'all' window is the default pick
    const unavailable = renderToStaticMarkup(
      <AnalyticsSection
        analytics={{ kind: 'unavailable', code: 'analytics_store_failed', message: 'Analytics store read failed.' }}
        intelligence={{ kind: 'ready', value: [] }}
        demo={true}
      />,
    );
    expect(unavailable).toContain('analytics-unavailable');
    expect(unavailable).toContain('Analytics store read failed.');
  });
});

// ---------------------------------------------------------------------------
// The live dev-seed render — real derivation payloads over the widened store
// ---------------------------------------------------------------------------

describe('AnalyticsSection — the live dev-seed render', () => {
  let allPayload: CompanyAnalytics;
  let sevenPayload: CompanyAnalytics;
  let readouts: EntityIntelligence[];

  beforeAll(async () => {
    process.env.DON_DEV_SEED = '1';
    await bootDevSeedStore();
    await seedAdminDemoDataIfEmpty();
    const store = await getSeededStore();
    const [all, seven] = await Promise.all([companyAnalytics(store, 'all'), companyAnalytics(store, '7d')]);
    if (all === null || seven === null) throw new Error('companyAnalytics returned null over the seeded store');
    allPayload = all;
    sevenPayload = seven;

    const [{ records: atomicRecords }, { records: factoryRecords }] = await Promise.all([
      resolveAtomicRegistry(),
      resolveMasterTemplates(),
    ]);
    const seen = new Set<string>();
    readouts = [];
    const addEntity = async (templateId: string) => {
      if (seen.has(templateId)) return;
      seen.add(templateId);
      const read = await entityIntelligence(templateId, store);
      if (read !== null) readouts.push(read);
    };
    for (const record of atomicRecords) {
      const entity = bindAtomicEntity(record);
      if (entity !== null) await addEntity(entity.templateId);
    }
    for (const record of factoryRecords) {
      const entity = bindFactoryEntity(record);
      if (entity !== null) await addEntity(entity.templateId);
    }
  });

  it('pins the six KPI cards to the derivation totals — the whole ledger, all window', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    expect(html).toContain('$8,445,103,733.36'); // total cleared
    expect(html).toContain('$2,955,786,306.67'); // creator paid (35%)
    expect(html).toContain('$1,266,765,560.00'); // operations yield (15%)
    expect(html).toContain('$4,222,551,866.69'); // company reserve (50%)
    expect(html).toContain('119'); // runs cleared
    expect(html).toContain('$70,967,258.26'); // avg run
  });

  it('pins the flow-kind donut to the reconciled structural totals', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    expect(html).toContain('$8,411,918,933.36'); // Royalty Distribution
    expect(html).toContain('$24,250,000.00'); // Prize Purse
    expect(html).toContain('$8,720,000.00'); // Brand Partnership
    expect(html).toContain('$214,800.00'); // Platform Content Monetization
    expect(html).toContain('Royalty Distribution');
    expect(html).not.toContain('ROYALTY_DISTRIBUTION'); // the raw enum never renders
  });

  it('pins the industry bars to the reconciled totals in descending order', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    for (const industry of ['Music', 'Film', 'Sports', 'Live', 'Publishing', 'TV', 'Sponsorship', 'Podcasting', 'Esports', 'Social']) {
      expect(html).toContain(`>${industry}<`);
    }
    expect(html).toContain('$8,333,333,333.36'); // MUSIC
    expect(html).toContain('$30,250,000.00'); // SPORTS
    const musicAt = html.indexOf('>Music<');
    const filmAt = html.indexOf('>Film<');
    const sportsAt = html.indexOf('>Sports<');
    expect(musicAt).toBeLessThan(filmAt);
    expect(filmAt).toBeLessThan(sportsAt);
  });

  it('renders the daily curve — points on the area, paired thin lines, all and 7d', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    expect(html.match(/data-testid="chart-area-point"/g)?.length).toBe(35);
    expect(html.match(/data-testid="chart-area-paired-line"/g)?.length).toBe(2);
    const seven = renderView(sevenPayload, { kind: 'ready', value: readouts });
    expect(seven.match(/data-testid="chart-area-point"/g)?.length).toBe(7);
  });

  it('renders the full 29-entity leaderboard with the tie and the Total row', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    expect(html.match(/data-testid="analytics-leaderboard-row"/g)?.length).toBe(29);
    expect(html).toContain('data-rank="1"');
    expect(html).toContain('TPL-MUS-001');
    // The publishing tie — company rank shared at 21, rank 22 vacant.
    expect(html.match(/data-rank="21"/g)?.length).toBe(2);
    expect(html).not.toContain('data-rank="22"');
    // The same tie's per-class cohort benchmark — 3 of 9 twice, 4 of 9 nowhere.
    expect(html.match(/>3 of 9</g)?.length).toBe(2);
    expect(html).not.toContain('>4 of 9<');
    // The Total row reconciles to the ledger.
    expect(html).toContain('data-testid="analytics-leaderboard-total"');
    expect(html).toContain('$8,445,103,733.36');
  });

  it('keeps counterparties out of the structural markup and renders the field of record in the game log', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    const gameLogStart = html.indexOf('data-testid="analytics-gamelog"');
    const structural = html.slice(0, gameLogStart);
    for (const brand of ['Nike', 'Spotify', 'Apple Music', 'PGA Tour', 'Netflix', 'Marvel Studios', 'ASCAP', 'Disney']) {
      expect(structural).not.toContain(brand);
    }
    const gameLog = html.slice(gameLogStart);
    expect(gameLog).toContain('Spotify'); // the run's own field of record — the drilldown column
    expect(html.match(/data-testid="chart-heat-cell"/g)?.length).toBeGreaterThan(0);
  });

  it('pins the promised-vs-cleared comparison to the canon values', () => {
    const html = renderView(allPayload, { kind: 'ready', value: readouts });
    expect(html).toContain('$125,000.00'); // TOURNAMENT_EVENT promised (12,500,000 cents)
    expect(html).toContain('$114,200.00'); // FEATURE_FILM promised sum (11,420,000 cents)
    expect(html.match(/No promised value in canon/g)?.length).toBe(6); // the honest nulls
    expect(html).toContain('data-testid="chart-grouped-promised-bar"');
    expect(html).toContain('data-testid="chart-grouped-cleared-bar"');
  });

  it('switches the window and the KPI values change with it', () => {
    const allHtml = renderView(allPayload, { kind: 'ready', value: readouts });
    const sevenHtml = renderView(sevenPayload, { kind: 'ready', value: readouts });
    expect(sevenHtml).toContain('$42,652,800.00'); // 7d total cleared
    expect(sevenHtml).toContain('$14,928,480.00'); // 7d creator paid
    expect(sevenHtml).toContain('$6,397,920.00'); // 7d operations yield
    expect(sevenHtml).toContain('$21,326,400.00'); // 7d company reserve
    expect(sevenHtml).toContain('47'); // 7d runs
    expect(sevenHtml).toContain('$907,506.38'); // 7d avg run
    expect(sevenHtml).not.toContain('$8,445,103,733.36');
    expect(allHtml).toContain('$8,445,103,733.36');
    expect(allHtml).not.toContain('$42,652,800.00');
  });

  it('mounts through the section wrapper with the demo badge and default window', () => {
    const html = renderToStaticMarkup(
      <AnalyticsSection
        analytics={{ kind: 'ready', value: windowsRecord(allPayload, sevenPayload) }}
        intelligence={{ kind: 'ready', value: readouts }}
        demo={true}
      />,
    );
    expect(html).toContain('demo-data-badge');
    expect(html).toContain('$8,445,103,733.36'); // the 'all' window renders by default
    expect(html).toContain('Company Analytics');
  });
});
