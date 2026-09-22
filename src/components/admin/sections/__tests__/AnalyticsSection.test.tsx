/**
 * AnalyticsSection — the generation-4 analytics render suite. Pins the
 * three honest states per the no-empty-states canon: a ready payload
 * renders all three cuts with rows; an empty cut renders the honest copy
 * (never a blank block, never '--'); an unavailable read renders the
 * section-unavailable state. The live dev-seed case renders the REAL
 * derivation over the REAL seeded store — the multi-industry clearing
 * demo (MUSIC, SPORTS, ESPORTS, SOCIAL, SPONSORSHIP rows, descending)
 * with the demo-data badge disclosing it.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore, getSeededStore } from '@/lib/server/devSeed';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { platformAnalyticsFlows } from '@/lib/admin/analyticsFlows';
import type { PlatformAnalyticsFlows } from '@/lib/admin/analyticsFlows';
import { AnalyticsSection } from '../AnalyticsSection';

function cut(state: 'empty' | 'unavailable'): PlatformAnalyticsFlows {
  const c = { state, rows: [] };
  return { byIndustry: c, bySource: c, byTransactionType: c };
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
      rows: [
        { label: 'SPORTS', totalCents: 1_490_000_000n },
        { label: 'MUSIC', totalCents: 833_333_333_336n },
      ],
    },
    bySource: {
      state: 'ready',
      rows: [{ label: 'Nike', totalCents: 335_000_000n }],
    },
    byTransactionType: {
      state: 'ready',
      rows: [{ label: 'royalty_ingest', totalCents: 335_000_000n }],
    },
  };

  it('renders all three cuts with their rows and exact formatted totals', () => {
    const html = renderSection(flows);

    expect(html).toContain('By industry');
    expect(html).toContain('By source');
    expect(html).toContain('By transaction type');
    expect(html).toContain('SPORTS');
    expect(html).toContain('MUSIC');
    expect(html).toContain('Nike');
    expect(html).toContain('royalty_ingest');
    // The bigint-cent formatter's exact figures — never a rounded float.
    expect(html).toContain('$14,900,000.00');
    expect(html).toContain('$3,350,000.00');
  });

  it('renders each cut as a row block with stable testids', () => {
    const html = renderSection(flows);

    expect(html).toContain('data-testid="analytics-cut-industry-row"');
    expect(html).toContain('data-testid="analytics-cut-source-row"');
    expect(html).toContain('data-testid="analytics-cut-transaction-type-row"');
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
    expect(html).toContain('data-testid="analytics-cut-source-empty"');
    expect(html).toContain('data-testid="analytics-cut-transaction-type-empty"');
    expect(html).toContain('No royalty postings yet');
    // The canon: never a placeholder value.
    expect(html).not.toContain('--');
  });

  it('renders the honest unavailable copy for failed cuts', () => {
    const html = renderSection(cut('unavailable'));

    expect(html).toContain('data-testid="analytics-cut-industry-unavailable"');
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

  it('renders the multi-industry clearing demo — all five classes including the four new ones', () => {
    for (const label of ['MUSIC', 'SPORTS', 'ESPORTS', 'SOCIAL', 'SPONSORSHIP']) {
      expect(html).toContain(`>${label}</span>`);
    }
  });

  it('renders the seeded industry totals exactly — descending, store-read', () => {
    // The five music-platform runs (Σ gross = 833,333,333,336 cents) land
    // as the MUSIC row; the athlete guarantee + tournament purse as SPORTS.
    expect(html).toContain('$8,333,333,333.36');
    expect(html).toContain('$14,900,000.00');
    // Descending order: the MUSIC row precedes the SPORTS row.
    expect(html.indexOf('$8,333,333,333.36')).toBeLessThan(html.indexOf('$14,900,000.00'));
  });

  it('renders the seeded source and transaction-type cuts exactly', () => {
    // The two Nike settlements merge into one source row; the royalty
    // journals' kind of record is the single transaction-type row.
    expect(html).toContain('$3,350,000.00');
    expect(html).toContain('royalty_ingest');
    expect(
      (html.match(/data-testid="analytics-cut-transaction-type-row"/g) ?? []).length,
    ).toBe(1);
  });

  it('discloses the demo ledger with the demo-data badge', () => {
    expect(html).toContain('data-testid="demo-data-badge"');
  });
});
