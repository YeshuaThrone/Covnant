/**
 * OverviewSection — the Revenue Streams placement test (founder directive
 * 2026-09-22: the strip moved OFF the Gold Board onto the admin Overview,
 * under Smart Ledger Verification).
 *
 * Rendered against the LIVE dev-seed store: the platform-wide streams come
 * from the same engine paths the Gold Board strip used (royalty_ingest
 * journals → split-run source → vault credit legs), widened to every payee.
 * Pins the three honest states — ready, empty, unavailable — and the
 * placement UNDER the Smart Ledger Verification audit runner.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore, getSeededStore } from '@/lib/server/devSeed';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { platformRevenueStreams } from '@/lib/admin/revenueStreams';
import { registrySummary, ledgerSummary } from '@/lib/admin/overview';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import type { AdminConsoleData } from '../../types';
import type { ControlBoardState } from '@/lib/master/controlBoard';
import { OverviewSection } from '../OverviewSection';

let fixture: Omit<AdminConsoleData, 'revenueStreams'>;

beforeAll(async () => {
  // The dev-seed boot — the same store the dashboard page tests render over.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  await seedAdminDemoDataIfEmpty();

  const [assets, ledgerRows] = await Promise.all([listAssets(), listLedger()]);
  fixture = {
    registry: registrySummary(assets),
    ledger: ledgerSummary(ledgerRows),
    contracts: {
      kind: 'unavailable',
      code: 'contract_store_failed',
      message: 'Contract store read failed.',
    },
    creators: {
      kind: 'unavailable',
      code: 'creators_store_failed',
      message: 'Creator store read failed.',
    },
    creatorsDemo: true,
    allowlists: {
      kind: 'unavailable',
      code: 'allowlists_store_failed',
      message: 'Allowlist store read failed.',
    },
    master: {
      kind: 'unavailable',
      code: 'master_store_failed',
      message: 'Master ledger read failed.',
    },
    finances: { demo: true, rows: [] },
    contractRegistry: { demo: true, executions: [], templates: [] },
    tax: {
      demo: true,
      payees: [],
      periods: [],
      annual: [],
      transactions: [],
      currencies: [],
      excludedNonUsdSettlements: 0,
    },
    controlBoard: {} as ControlBoardState,
    analytics: {
      kind: 'unavailable',
      code: 'analytics_store_failed',
      message: 'Analytics store read failed.',
    },
    analyticsDemo: true,
    intelligence: {
      kind: 'unavailable',
      code: 'intelligence_store_failed',
      message: 'Intelligence store read failed.',
    },
    intelligenceDemo: true,
    creatorAnalytics: {
      kind: 'unavailable',
      code: 'creator_analytics_store_failed',
      message: 'Creator analytics store read failed.',
    },
    creatorAnalyticsDemo: true,
    catalogGrowth: {
      kind: 'unavailable',
      code: 'catalog_growth_store_failed',
      message: 'Catalog growth store read failed.',
    },
    operations: {
      kind: 'unavailable',
      code: 'operations_store_failed',
      message: 'Operations store read failed.',
    },
    operationsDemo: true,
  };
});

function renderOverview(revenueStreams: AdminConsoleData['revenueStreams']): string {
  return renderToStaticMarkup(
    <OverviewSection data={{ ...fixture, revenueStreams }} />,
  );
}

describe('OverviewSection — Revenue Streams placement (founder directive 2026-09-22)', () => {
  it('renders the platform-wide strip UNDER Smart Ledger Verification', async () => {
    const store = await getSeededStore();
    const html = renderOverview({
      kind: 'ready',
      value: await platformRevenueStreams(store),
    });

    // Placement: the strip's block follows the Smart Ledger Verification audit runner.
    const auditIndex = html.indexOf('Smart Ledger Verification');
    const stripIndex = html.indexOf('data-testid="revenue-streams"');
    expect(auditIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeGreaterThan(auditIndex);

    // Platform-wide aggregation over the seeded GL — the strip renders rows.
    expect(html).toContain('Revenue streams');
    expect((html.match(/data-testid="revenue-stream"/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain('Platform-wide royalty inflow by source');
  });

  it('renders the honest platform-voiced empty state when no streams exist', () => {
    const html = renderOverview({ kind: 'ready', value: [] });
    expect(html).toContain('data-testid="revenue-streams-empty-admin"');
    expect(html).toContain('No royalty postings yet');
    expect(html).not.toContain('data-testid="revenue-stream"');
  });

  it('renders the honest unavailable state when the store read fails', () => {
    const html = renderOverview({
      kind: 'unavailable',
      code: 'revenue_streams_store_failed',
      message: 'Revenue stream store read failed.',
    });
    expect(html).toContain('data-testid="revenue-streams-unavailable"');
    expect(html).toContain('revenue_streams_store_failed');
  });
});
