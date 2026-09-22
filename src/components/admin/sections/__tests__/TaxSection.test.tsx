/**
 * TaxSection — the TAX DATA SHEET render test (founder directive,
 * 2026-09-21: "now we need a tax data sheet so the tax agents job is
 * easier and we are in compliance").
 *
 * Asserted against the LIVE dev-seed store — the section receives the
 * same composed payload the admin page builds (buildTaxSection through
 * CovnantTaxEngineSDK), and every rendered figure is compared to that
 * composer's output for the same rows: an EQUALITY assertion against
 * shared engine paths, never a duplicated literal. The every-creator
 * rule is checked at the UI layer — the register renders a row for
 * EVERY payee of record, with the escrow locks amber and the lock
 * reason visible.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { buildTaxSection } from '@/lib/admin/sectionPayloads';
import { buildTaxExportCsv, parseCsv } from '@/lib/tax/exportCsv';
import { formatWithholdingRow, tinStatusOf } from '@/lib/tax/controlBoardSummary';
import { formatCentsBigint } from '@/lib/money/format';
import { TaxSection } from '../TaxSection';
import type { LedgerRow } from '@/lib/ledger/store';
import type { ContractRow, SectionData, TaxSectionData } from '@/components/admin/types';

let rows: LedgerRow[];
let tax: TaxSectionData;
let markup: string;
let payeeNames: string[];
let heldPayees: { name: string; reason: string | null }[];

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
  await seedAdminDemoDataIfEmpty();
  rows = await listLedger();
  const assets = await listAssets();
  const contracts: SectionData<ContractRow[]> = { kind: 'ready', value: [] };
  tax = buildTaxSection(rows, assets, contracts);
  markup = renderToStaticMarkup(<TaxSection tax={tax} />);

  payeeNames = tax.payees.map((payee) => payee.payeeName);
  heldPayees = tax.payees
    .filter((payee) => payee.lockState === 'HELD_IN_TAX_ESCROW')
    .map((payee) => ({ name: payee.payeeName, reason: payee.lockReason }));
});

describe('TaxSection — the tax data sheet', () => {
  it('renders a register row for EVERY creator of record (never a curated subset)', () => {
    expect(payeeNames.length).toBeGreaterThan(0);
    for (const name of payeeNames) {
      expect(markup, `register renders ${name}`).toContain(name);
    }
  });

  it('discloses the demo data and offers the gated CSV download', () => {
    expect(markup).toContain('data-testid="demo-data-badge"');
    expect(markup).toContain('data-testid="tax-export-link"');
    expect(markup).toContain('href="/api/v1/admin/tax/export"');
    expect(markup).toContain('Download tax sheet (CSV)');
  });

  it('renders the escrow locks with the reason visible for held rows', () => {
    expect(heldPayees.length).toBeGreaterThan(0);
    for (const held of heldPayees) {
      expect(markup).toContain('Held in tax escrow');
      if (held.reason) {
        expect(markup, `lock reason visible for ${held.name}`).toContain(held.reason);
      }
    }
  });

  it('renders CLEARED escrow rows as Released — the label layer alone (patch v2.6.4)', () => {
    const clearedPayees = tax.payees.filter((payee) => payee.lockState === 'CLEARED');
    expect(clearedPayees.length, 'the demo branches include a cleared payee').toBeGreaterThan(0);
    // The patch's label voice rendered for cleared payouts...
    expect(markup).toContain('Released');
    // ...while the state of record stays CLEARED on every composer row —
    // the render maps the adapter's escrowStatus token, never the stored
    // TaxLockState + lockReason (C4: both engine lock reasons survive).
    for (const payee of clearedPayees) {
      expect(payee.lockState).toBe('CLEARED');
    }
    expect(markup).toContain('Held in tax escrow');
  });

  it('renders the adapter form tags — corporate suppression and the PENDING tag', () => {
    // EQUALITY against the adapter's own display mapping over the same
    // composer rows — never a duplicated literal.
    for (const payee of tax.payees) {
      expect(markup, `form tag for ${payee.payeeName}`).toContain(formatWithholdingRow(payee).formTag);
    }
    const exempt = tax.payees.find((payee) => payee.forms.includes('EXEMPT_CORPORATE'));
    expect(exempt, 'the demo branches include an EXEMPT_CORPORATE payee').toBeDefined();
    expect(formatWithholdingRow(exempt!).formTag).toBe('EXEMPT_CORPORATE');
    const pending = tax.payees.find((payee) => payee.tinStatus === 'PENDING');
    expect(pending, 'the demo branches include a PENDING TIN payee').toBeDefined();
    // This dataset's PENDING payee carries the corporate exemption: the
    // suppression rule takes precedence over the (PENDING) tag. The suffix
    // itself is pinned at the adapter on a non-exempt row
    // (controlBoardSummary.test.ts — 'tags the form (PENDING)...'); here the
    // render maps whatever the adapter decides, per the equality loop above.
    expect(formatWithholdingRow(pending!).formTag).toBe('EXEMPT_CORPORATE');
    expect(markup).toContain(formatWithholdingRow(pending!).formTag);
  });

  it('renders the TIN labels through the adapter boundary map', () => {
    for (const payee of tax.payees) {
      expect(markup, `TIN label for ${payee.payeeName}`).toContain(tinStatusOf(payee.tinStatus));
    }
  });

  it('renders the engine figures through the shared bigint formatter (no float path)', () => {
    // The engine totals of record, formatted by the shared formatCentsBigint
    // — the composer's own figures, never a duplicated literal.
    for (const period of tax.periods) {
      expect(markup).toContain(formatCentsBigint(period.engine.withheldCents));
      expect(markup).toContain(formatCentsBigint(period.engine.stateTaxCents));
      expect(markup).toContain(formatCentsBigint(period.engine.netCents));
    }
    for (const row of tax.transactions) {
      expect(markup).toContain(formatCentsBigint(row.engine.netCents));
    }
  });

  it('shows the effective rate column on the register', () => {
    expect(markup).toContain('Effective rate');
  });

  it('renders the CBT-stamped transaction register, period summary, and currency rollup', () => {
    expect(markup).toContain('data-testid="tax-transaction-register"');
    expect(markup).toContain('data-testid="tax-period-summary"');
    expect(markup).toContain('data-testid="tax-withholding-register"');
    expect(markup).toContain('data-testid="tax-currency-rollup"');
  });

  it('keeps the new copy ampersand-free', () => {
    // The canon bans ampersands in NEW copy; the sheet's own labels comply.
    expect(markup.includes(' & ')).toBe(false);
  });
});

describe('TaxSection — the CSV the download hands the tax agent', () => {
  it('parses back with every creator and every CBT stamp of record', async () => {
    const assets = await listAssets();
    const contracts: SectionData<ContractRow[]> = { kind: 'ready', value: [] };
    const exportTax = buildTaxSection(rows, assets, contracts);
    const csv = buildTaxExportCsv(exportTax);
    const flat = parseCsv(csv).flat();
    for (const name of payeeNames) {
      expect(flat).toContain(name);
    }
    for (const row of exportTax.transactions) {
      expect(flat).toContain(row.cbt);
    }
  });
});
