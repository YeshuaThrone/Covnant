/**
 * AnalyticsSection — the generation-4 analytics render suite. Pins the
 * three honest states per the no-empty-states canon: a ready payload
 * renders all three cuts with rows; an empty cut renders the honest copy
 * (never a blank block, never '--'); an unavailable read renders the
 * section-unavailable state. The live dev-seed case renders the REAL
 * derivation over the REAL seeded store — the whole-entertainment-world
 * clearing demo (every industry class tag, every registered flow kind,
 * descending) with the demo-data badge disclosing it — and pins the
 * 2026-09-22 structural directive: NO counterparty or brand string from
 * the seeds renders on the intelligence layer.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore, getSeededStore } from '@/lib/server/devSeed';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { platformAnalyticsFlows } from '@/lib/admin/analyticsFlows';
import type { PlatformAnalyticsFlows } from '@/lib/admin/analyticsFlows';
import { AnalyticsSection, shareOfCutTotal } from '../AnalyticsSection';

describe('shareOfCutTotal — the bar-width derivation', () => {
  it("is the row's integer-percent share of the cut total — bigint math", () => {
    // 250 of 1,000 → 25%.
    expect(shareOfCutTotal(250n, 1_000n)).toBe(25);
    // Truncating integer division: 1 of 3 → 33%, not 33.33.
    expect(shareOfCutTotal(1n, 3n)).toBe(33);
  });

  it('floors a nonzero row at a 1% sliver so descending order stays visible', () => {
    // 1,490,000,000 of 834,823,333,336 truncates to 0 — the sliver keeps it on screen.
    expect(shareOfCutTotal(1_490_000_000n, 834_823_333_336n)).toBe(1);
    expect(shareOfCutTotal(1n, 1n)).toBe(100);
  });

  it('renders nothing for empty math — never a fabricated width', () => {
    expect(shareOfCutTotal(0n, 0n)).toBe(0);
    expect(shareOfCutTotal(5n, 0n)).toBe(0);
  });
});

function cut(state: 'empty' | 'unavailable'): PlatformAnalyticsFlows {
  const c = { state, rows: [] };
  return { byIndustry: c, byFlowKind: c, byTransactionType: c };
}

function renderSection(
  analytics: PlatformAnalyticsFlows,
  demo: boolean = true,
): string {
  return renderToStaticMarkup(
    <AnalyticsSection analytics={{ kind: 'ready', value: analytics }} demo={demo} />,
  );
}

describe('AnalyticsSection — the ready state', () => {
  const flows: PlatformAnalyticsFlows = {
    byIndustry: {
      state: 'ready',
      // Descending, as the derivation emits — MUSIC first.
      rows: [
        { label: 'MUSIC', totalCents: 833_333_333_336n },
        { label: 'SPORTS', totalCents: 1_490_000_000n },
      ],
    },
    byFlowKind: {
      state: 'ready',
      // The registered structural kinds — the derivation emits the kind
      // of record, the section maps it through the registered labels.
      rows: [{ label: 'BRAND_PARTNERSHIP', totalCents: 335_000_000n }],
    },
    byTransactionType: {
      state: 'ready',
      rows: [{ label: 'royalty_ingest', totalCents: 335_000_000n }],
    },
  };

  it('renders all three cuts with their rows and exact formatted totals', () => {
    const html = renderSection(flows);

    expect(html).toContain('By industry');
    expect(html).toContain('By flow kind');
    expect(html).toContain('By transaction type');
    expect(html).toContain('SPORTS');
    expect(html).toContain('MUSIC');
    expect(html).toContain('Brand Partnership');
    expect(html).toContain('royalty_ingest');
    // The bigint-cent formatter's exact figures — never a rounded float.
    expect(html).toContain('$14,900,000.00');
    expect(html).toContain('$3,350,000.00');
  });

  it('renders the flow-kind rows through the registered structural labels — never the raw kind enum', () => {
    const html = renderSection(flows);

    expect(html).toContain('Brand Partnership');
    expect(html).not.toContain('BRAND_PARTNERSHIP');
  });

  it('never renders a counterparty or brand string — the intelligence layer speaks structure', () => {
    const html = renderSection(flows);

    expect(html).not.toContain('Nike');
    expect(html).not.toContain('Spotify');
  });

  it('renders each cut as a row block with stable testids', () => {
    const html = renderSection(flows);

    expect(html).toContain('data-testid="analytics-cut-industry-row"');
    expect(html).toContain('data-testid="analytics-cut-flow-kind-row"');
    expect(html).toContain('data-testid="analytics-cut-transaction-type-row"');
  });

  it('renders each cut as a titled block with the gold-rule divider', () => {
    const html = renderSection(flows);

    // One gold rule per cut block, in the Overview's Revenue Streams rhythm.
    expect((html.match(/gold-rule/g) ?? []).length).toBe(3);
    expect(html).toContain('data-testid="analytics-cut-industry"');
    expect(html).toContain('data-testid="analytics-cut-flow-kind"');
    expect(html).toContain('data-testid="analytics-cut-transaction-type"');
  });

  it('renders each row as a proportional gold bar over the strip treatment', () => {
    const html = renderSection(flows);

    // Every row carries the strip's bar vocabulary — slate track, gold fill.
    expect(html).toContain('bg-slate-700/50');
    expect(html).toContain('from-gold-champagne/80 to-gold/60');
    // Exact integer-percent shares: byIndustry total 834,823,333,336 —
    // MUSIC truncates to 99%, SPORTS floors to the 1% sliver; the single-row
    // cuts render the full 100%.
    expect(html).toContain('data-testid="analytics-cut-industry-bar"');
    expect(html).toContain('style="width:99%"');
    expect(html).toContain('style="width:1%"');
    expect(html).toContain('style="width:100%"');
    // Descending order stays visible through the bars: MUSIC (99) precedes SPORTS (1).
    expect(html.indexOf('style="width:99%"')).toBeLessThan(html.indexOf('style="width:1%"'));
  });

  it('renders every ready row with a bar — rows and bars are 1:1', () => {
    const html = renderSection(flows);
    const rows = (html.match(/data-testid="analytics-cut-[a-z-]+-row"/g) ?? []).length;
    const bars = (html.match(/data-testid="analytics-cut-[a-z-]+-bar"/g) ?? []).length;

    expect(rows).toBe(4); // 2 industry + 1 flow-kind + 1 transaction-type
    expect(bars).toBe(rows);
  });

  it('discloses demo data only when the demo flag is set', () => {
    expect(renderSection(flows, true)).toContain('data-testid="demo-data-badge"');
    expect(renderSection(flows, false)).not.toContain('data-testid="demo-data-badge"');
  });
});

describe('AnalyticsSection — the honest off-happy-path states', () => {
  it('renders the honest empty copy for cuts with no rows — never a blank block', () => {
    const html = renderSection(cut('empty'));

    expect(html).toContain('data-testid="analytics-cut-industry-empty"');
    expect(html).toContain('data-testid="analytics-cut-flow-kind-empty"');
    expect(html).toContain('data-testid="analytics-cut-transaction-type-empty"');
    expect(html).toContain('No royalty postings yet');
    // The canon: never a placeholder value.
    expect(html).not.toContain('--');
  });

  it('renders the honest unavailable copy for failed cuts', () => {
    const html = renderSection(cut('unavailable'));

    expect(html).toContain('data-testid="analytics-cut-industry-unavailable"');
    expect(html).toContain('data-testid="analytics-cut-flow-kind-unavailable"');
    expect(html).toContain('showing nothing rather than a wrong number');
  });

  it('renders the section-unavailable state when the whole payload read fails', () => {
    const html = renderToStaticMarkup(
      <AnalyticsSection
        analytics={{
          kind: 'unavailable',
          code: 'analytics_store_failed',
          message: 'Analytics store read failed.',
        }}
        demo={true}
      />,
    );

    expect(html).toContain('data-testid="analytics-unavailable"');
    expect(html).toContain('analytics_store_failed');
    expect(html).toContain('Analytics store read failed.');
  });
});

describe('AnalyticsSection — the live dev-seed render', () => {
  let html = '';

  beforeAll(async () => {
    // The dev-seed boot — the same store the dashboard page tests render over.
    process.env.DON_DEV_SEED = '1';
    await bootDevSeedStore();
    await seedAdminDemoDataIfEmpty();
    const flows = await platformAnalyticsFlows(await getSeededStore());
    html = renderSection(flows, true);
  });

  it('renders the whole-entertainment-world clearing demo — every industry class tag', () => {
    for (const label of [
      'MUSIC',
      'FILM',
      'TV',
      'PODCASTING',
      'LIVE',
      'PUBLISHING',
      'SPORTS',
      'ESPORTS',
      'SOCIAL',
      'SPONSORSHIP',
    ]) {
      expect(html).toContain(`>${label}</span>`);
    }
  });

  it('renders every registered flow kind through the structural labels', () => {
    for (const label of [
      'Royalty Distribution',
      'Brand Partnership',
      'Prize Purse',
      'Platform Content Monetization',
    ]) {
      expect(html).toContain(`>${label}</span>`);
    }
    // The raw kind enums never render — the registered labels do.
    expect(html).not.toContain('ROYALTY_DISTRIBUTION');
  });

  it('renders NO counterparty or brand string from the seeds — the 2026-09-22 structural directive', () => {
    // Every seeded source of record — the counterparties live in the store
    // (ledger drilldowns, entity cards), never on the intelligence layer.
    for (const brand of [
      'Nike',
      'Spotify',
      'YouTube Music',
      'Amazon Music',
      'Bandcamp',
      'PGA Tour',
      'Twitch',
      'TikTok',
      'Meridian Cinemas',
      'Broadcast Partners',
      'Apple Podcasts',
      'Ticketmaster',
      'Reader Platforms',
    ]) {
      expect(html).not.toContain(brand);
    }
  });

  it('renders the seeded industry totals exactly — descending, store-read', () => {
    // The five music-platform runs (Σ gross = 833,333,333,336 cents) land
    // as the MUSIC row; the athlete guarantee + tournament purse as SPORTS.
    expect(html).toContain('$8,333,333,333.36');
    expect(html).toContain('$20,860,000.00');
    // Descending order: the MUSIC row precedes the SPORTS row.
    expect(html.indexOf('$8,333,333,333.36')).toBeLessThan(html.indexOf('$20,860,000.00'));
  });

  it('renders the descending order through the industry bars', () => {
    // Extract the industry block's bar widths in render order — the
    // derivation sorts descending, so the widths must never increase.
    const block = html.split('data-testid="analytics-cut-industry"')[1] ?? '';
    const widths = [...block.matchAll(/data-testid="analytics-cut-industry-bar"/g)].map(
      (match) => block.slice(match.index).match(/width:(\d+)%/)?.[1] ?? '',
    );
    expect(widths.length).toBeGreaterThanOrEqual(10);
    const numeric = widths.map(Number);
    for (let i = 1; i < numeric.length; i += 1) {
      expect(numeric[i]).toBeLessThanOrEqual(numeric[i - 1]);
    }
    // MUSIC dominates the seeded cut — the leading bar carries the cut's share.
    expect(numeric[0]).toBeGreaterThanOrEqual(90);
  });

  it('renders the seeded flow-kind cut exactly — every kind, descending, structural only', () => {
    // Σ over the royalty-holding classes (music + film + tv + podcast +
    // live + publishing runs); the purse, the brand money, the platform
    // creator yields — each its own structural row.
    expect(html).toContain('$8,391,958,933.36'); // Royalty Distribution
    expect(html).toContain('$17,500,000.00'); // Prize Purse
    expect(html).toContain('$4,785,000.00'); // Brand Partnership
    expect(html).toContain('$147,600.00'); // Platform Content Monetization
    const flowRows = (html.match(/data-testid="analytics-cut-flow-kind-row"/g) ?? []).length;
    expect(flowRows).toBe(4);
  });

  it('renders the transaction-type cut honest to the journals — one kind of record', () => {
    // Every royalty journal's kind of record — the single royalty_ingest row
    // over the whole widened demo ledger (Σ all seeded grosses).
    expect(html).toContain('$8,414,391,533.36');
    expect(html).toContain('royalty_ingest');
    expect(
      (html.match(/data-testid="analytics-cut-transaction-type-row"/g) ?? []).length,
    ).toBe(1);
  });

  it('discloses the demo ledger with the demo-data badge', () => {
    expect(html).toContain('data-testid="demo-data-badge"');
  });
});
