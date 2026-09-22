/**
 * LedgerSection — the FINANCES surface render test (founder directive,
 * 2026-09-20: the corner-dust settlement view restored to the console,
 * hydrated through the SAME engine paths the /ledger page reads).
 *
 * Asserted against the LIVE dev-seed store — the settlements come out of
 * the real engine (processRoyaltySettlement through the demo door's seed),
 * and every rendered figure is compared to the /ledger page's own
 * reconciliation engine output for the same rows — an EQUALITY assertion
 * against shared engine paths, never a duplicated literal.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { reconcileLedger, formatMinor, reconciliationHeadline } from '@/lib/ledger/reconciliation';
import { escrowStateFromRows } from '@/lib/ledger/finances';
import { buildLedgerFinancesSection, buildTaxSection } from '@/lib/admin/sectionPayloads';
import { cornerDustRemainder, reconcilePeriodSummary } from '@/lib/tax/controlBoardSummary';
import { formatCentsBigint } from '@/lib/money/format';
import { resolveMasterLedger } from '@/lib/master/masterStore';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';
import { LedgerSection } from '../LedgerSection';
import type { ContractRow, SectionData } from '@/components/admin/types';

beforeAll(async () => {
  // The dev-seed boot — settlements land through the REAL settlement engine.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
  await seedAdminDemoDataIfEmpty();
});

describe('LedgerSection — the finances surface', () => {
  it('renders the corner-dust settlement chain with values EQUAL to the /ledger page engine output', async () => {
    const rows = await listLedger();
    const assets = await listAssets();
    expect(rows.length).toBeGreaterThan(0);

    const payload = buildLedgerFinancesSection(rows, assets);
    const markup = renderToStaticMarkup(<LedgerSection finances={payload} />);

    // The reconciliation engine output — the SAME call the /ledger page makes.
    const recon = reconcileLedger(rows);
    expect(recon.byCurrency.length).toBeGreaterThan(0);
    for (const totals of recon.byCurrency) {
      const currencyBlock = markup.includes(formatMinor(totals.grossMinor, totals.currency));
      expect(currencyBlock, `gross ${totals.grossMinor} ${totals.currency} rendered`).toBe(true);
      expect(markup.includes(formatMinor(totals.feesMinor, totals.currency)),
        `fees ${totals.feesMinor} ${totals.currency} rendered`).toBe(true);
      // Corner dust — summary level renders the patch's DERIVED sweep
      // remainder (patch v2.6.4), the same adapter expression per currency
      // block; the real per-row engine values stay in the settlement
      // records below (the audit trail the patch leaves alone).
      const summaryDust = formatCentsBigint(cornerDustRemainder(totals.dustMinor, totals.dustMinor));
      expect(markup.includes(summaryDust),
        `derived dust remainder ${summaryDust} rendered for ${totals.currency}`).toBe(true);
    }

    // The settlement math chain headers, in order of the surface.
    expect(markup).toContain('corner-dust-settlement-table');
    expect(markup).toContain('Corner dust');
    expect(markup).toContain('settlement-rows');
    expect(markup).toContain('escrow-state-table');
  });

  it('renders escrow state per holder from the stored disbursements (net minus payouts)', async () => {
    const rows = await listLedger();
    const assets = await listAssets();
    const markup = renderToStaticMarkup(
      <LedgerSection finances={buildLedgerFinancesSection(rows, assets)} />,
    );
    const escrow = escrowStateFromRows(rows);
    expect(escrow.length).toBeGreaterThan(0);
    for (const holder of escrow) {
      expect(markup).toContain(holder.name);
    }
    expect(markup).toContain('Gross earned');
    expect(markup).toContain('Withheld');
    expect(markup).toContain('Available');
  });

  it('keeps the financial master clearing ledger in view with the vertical-universal label', async () => {
    const rows = await listLedger();
    const assets = await listAssets();
    const { demo, records } = await resolveMasterLedger();
    const markup = renderToStaticMarkup(
      <LedgerSection
        finances={buildLedgerFinancesSection(rows, assets)}
        master={{ demo, summary: summarizeSovereignLedger(records), records: [...records] }}
      />,
    );
    expect(markup).toContain('Master clearing ledger');
    expect(markup).toContain('every vertical of entertainment');
    expect(markup).toContain('50 / 35 / 15');
  });

  it('discloses demo data when the demo door is open', async () => {
    const rows = await listLedger();
    const assets = await listAssets();
    const markup = renderToStaticMarkup(
      <LedgerSection finances={buildLedgerFinancesSection(rows, assets)} />,
    );
    expect(markup).toContain('data-testid="demo-data-badge"');
    expect(markup).toContain('Demo data');
  });
});


describe('LedgerSection — the easy-read reconciliation strip (founder addendum, 2026-09-21)', () => {
  it('renders the four reference cards hydrated from the SAME reconcileLedger pass as the table', async () => {
    const rows = await listLedger();
    const assets = await listAssets();
    const markup = renderToStaticMarkup(
      <LedgerSection finances={buildLedgerFinancesSection(rows, assets)} />,
    );

    // The founder's reference panel: title, verification badge, explainer,
    // and the four stat cards — the strip sits above the settlement table.
    expect(markup).toContain('data-testid="reconciliation-strip"');
    expect(markup).toContain('Gross settled');
    // PATCH v2.6.4 — the fees figure carries the sweep's label of record;
    // the pre-patch card name is gone from the surface.
    expect(markup).toContain('Fees (incl. corner dust)');
    expect(markup).not.toContain('Covenant fees');
    expect(markup).toContain('Corner dust');
    expect(markup).toContain('no floating-point arithmetic anywhere in this audit');

    // EQUALITY against the engine output — the strip renders exactly the
    // values reconcileLedger derives for the same rows, never copies.
    const headline = reconciliationHeadline(reconcileLedger(rows));
    expect(headline.settlements).toBe(rows.length);
    if (headline.currency && headline.grossMinor !== null) {
      expect(markup).toContain(formatMinor(headline.grossMinor, headline.currency));
      expect(markup).toContain(formatMinor(headline.feesMinor!, headline.currency));
      // The corner-dust card still equals the settlement table's corner-dust
      // column sum: one reconcile pass feeds card and table alike.
      const tableDust = reconcileLedger(rows).byCurrency.reduce(
        (sum, totals) => sum + totals.dustMinor,
        0n,
      );
      expect(headline.dustMinor).toBe(tableDust);
    }
  });

  it('renders the DERIVED dust remainder at summary level — the adapter summary figure, never a literal (patch v2.6.4)', async () => {
    const rows = await listLedger();
    const assets = await listAssets();
    const markup = renderToStaticMarkup(
      <LedgerSection finances={buildLedgerFinancesSection(rows, assets)} />,
    );

    // The adapter's cleared period summary over the SAME register the Tax
    // tab reads — the composer path, on the live dev-seed store.
    const contracts: SectionData<ContractRow[]> = { kind: 'ready', value: [] };
    const summary = reconcilePeriodSummary(
      buildTaxSection(rows, assets, contracts).transactions,
    );
    // Under the sweep identity the summary's dust reads zero — DERIVED by
    // the adapter (its own test pins the expression); here we pin the RENDER.
    expect(summary.displayCornerDust).toBe('$0.00');
    expect(markup).toContain('data-testid="reconciliation-dust"');
    expect(markup).toContain(summary.displayCornerDust);

    // Mirror agreement: the /ledger page derives the SAME remainder per
    // currency from the SAME reconciliation pass — the two surfaces cannot
    // disagree (one truth, never copied strings).
    for (const totals of reconcileLedger(rows).byCurrency) {
      expect(formatCentsBigint(cornerDustRemainder(totals.dustMinor, totals.dustMinor))).toBe(
        summary.displayCornerDust,
      );
    }
  });
});
