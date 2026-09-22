/**
 * PATCH v2.6.4 display-adapter tests. The adapter is presentation only —
 * these pins make sure it can never grow a mind of its own:
 *
 * - VOCABULARY TABLES: the patch's TIN and escrow tokens map onto the canon
 *   of record at the boundary (C3/C4), fail closed, and never lose an
 *   engine lock reason.
 * - THE RECONCILE IDENTITY: netPayout = gross − adjustedFee − withheld,
 *   exact in bigint — including negative dust and ≥$1B magnitudes — and
 *   agreeing with the rows' own stored nets.
 * - HONESTY LAW: the dust display is the sweep identity's remainder, never
 *   the banned display literal (the source is scanned for it).
 * - FORM TAGS: EXEMPT_CORPORATE suppression and the (PENDING) tag.
 * - LIVE STORE: the adapter maps the real dev-seed register and period
 *   summary through the same selectors the Tax tab reads.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';
import { listLedger } from '@/lib/ledger/store';
import { listAssets } from '@/lib/sdk';
import { buildTaxSection } from '@/lib/admin/sectionPayloads';
import { formatCentsBigint } from '@/lib/money/format';

import {
  cornerDustRemainder,
  escrowStatusOf,
  formatWithholdingRow,
  reconcilePeriodSummary,
  tinStatusOf,
} from '../controlBoardSummary';
import type { TaxPayeeRowView, TaxTransactionRowView } from '../withholding';
import type { SectionData } from '@/components/admin/types';
import type { ContractRow } from '@/components/admin/types';

/** A selector-shaped payee row (the adapter's input of record). */
function payeeView(overrides: Partial<TaxPayeeRowView> = {}): TaxPayeeRowView {
  return {
    payeeId: 'creator:demo',
    payeeName: 'Demo Payee',
    uctId: 'UCT-DEMO-001',
    isni: null,
    ipi: null,
    jurisdiction: 'US-TX Ledger Standard',
    tinStatus: 'UNSUBMITTED',
    forms: ['1099_NEC'],
    transactionCount: 1,
    grossMinor: 0n,
    withheldMinor: 0n,
    netMinor: 0n,
    ytdClearedGrossUsd: 0,
    engine: { grossCents: 0n, withheldCents: 0n, stateTaxCents: 0n, netCents: 0n },
    effectiveRate: 0,
    lockState: 'CLEARED',
    lockReason: null,
    ...overrides,
  };
}

/** A selector-shaped transaction row satisfying the ledger's own identity. */
function txnView(overrides: Partial<TaxTransactionRowView> = {}): TaxTransactionRowView {
  return {
    transactionId: 'TX-1',
    date: '2026-09-01T00:00:00.000Z',
    cbt: 'CBT-1',
    cvt: 'CVT-1',
    entityType: 'MASTER_RECORDING',
    template: 'TPL-MUS-001',
    payeeCount: 1,
    forms: ['1099_NEC'],
    grossMinor: 0n,
    feeMinor: 0n,
    dustMinor: 0n,
    withheldMinor: 0n,
    netMinor: 0n,
    engine: { grossCents: 0n, withheldCents: 0n, stateTaxCents: 0n, netCents: 0n },
    effectiveRate: 0,
    lockState: 'CLEARED',
    lockReason: null,
    ...overrides,
  };
}

describe('the TIN vocabulary map at the boundary (C3)', () => {
  it('maps the patch vocabulary onto the canon of record', () => {
    expect(tinStatusOf('VALID')).toBe('VERIFIED');
    expect(tinStatusOf('MISSING')).toBe('UNSUBMITTED');
    expect(tinStatusOf('PENDING')).toBe('PENDING');
    expect(tinStatusOf('INVALID')).toBe('INVALID');
  });

  it('passes the canon vocabulary through untouched and fails closed', () => {
    expect(tinStatusOf('VERIFIED')).toBe('VERIFIED');
    expect(tinStatusOf('UNSUBMITTED')).toBe('UNSUBMITTED');
    // The payeeProfiles law: an unrecognized token is an unverified payee.
    expect(tinStatusOf('SOME_FUTURE_TOKEN')).toBe('UNSUBMITTED');
  });
});

describe('the derived escrow status (C4)', () => {
  it('carries the lock reason of record for a held payout — both engine reasons verbatim', () => {
    expect(
      escrowStatusOf('HELD_IN_TAX_ESCROW', 'INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING'),
    ).toBe('INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING');
    expect(
      escrowStatusOf('HELD_IN_TAX_ESCROW', 'UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK'),
    ).toBe('UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK');
  });

  it('keeps the cleared data token bare — the Released wording is a UI-label decision', () => {
    expect(escrowStatusOf('CLEARED', null)).toBe('CLEARED');
    expect(escrowStatusOf('CLEARED', null)).not.toBe('Released');
  });
});

describe('the formatted withholding row over a selector view', () => {
  it("fills the patch's honest Not-on-file fallbacks for absent identity tags", () => {
    const absent = formatWithholdingRow(payeeView({ isni: null, ipi: null }));
    expect(absent.isni).toBe('Not on file');
    expect(absent.ipi).toBe('Not on file');
    const known = formatWithholdingRow(
      payeeView({ isni: '0000-0002-1825-0097', ipi: '00685046626' }),
    );
    expect(known.isni).toBe('0000-0002-1825-0097');
    expect(known.ipi).toBe('00685046626');
  });

  it('suppresses the 1099 tag when the corporate exemption is among the forms', () => {
    const exempt = formatWithholdingRow(
      payeeView({ forms: ['1099_NEC', 'EXEMPT_CORPORATE'], tinStatus: 'VERIFIED' }),
    );
    expect(exempt.formTag).toBe('EXEMPT_CORPORATE');
    expect(exempt.formTag).not.toContain('1099_NEC');
  });

  it('tags the form (PENDING) while TIN verification is pending', () => {
    const pending = formatWithholdingRow(payeeView({ forms: ['1099_NEC'], tinStatus: 'PENDING' }));
    expect(pending.formTag).toBe('1099_NEC (PENDING)');
    const verified = formatWithholdingRow(
      payeeView({ forms: ['1099_NEC'], tinStatus: 'VERIFIED' }),
    );
    expect(verified.formTag).toBe('1099_NEC');
  });

  it('normalizes a patch-shaped TIN token at the boundary without touching canon', () => {
    expect(formatWithholdingRow(payeeView({ tinStatus: 'VALID' })).tinStatus).toBe('VERIFIED');
    expect(formatWithholdingRow(payeeView({ tinStatus: 'VERIFIED' })).tinStatus).toBe('VERIFIED');
    expect(formatWithholdingRow(payeeView({ tinStatus: 'UNSUBMITTED' })).tinStatus).toBe(
      'UNSUBMITTED',
    );
  });

  it('renders money from the ledger fold and YTD from its own fold (C5)', () => {
    const row = formatWithholdingRow(
      payeeView({
        grossMinor: 123_456_789n,
        withheldMinor: 29_629_629n,
        netMinor: 93_827_160n,
        ytdClearedGrossUsd: 2_000_000_000,
      }),
    );
    expect(row.grossPaid).toBe('$1,234,567.89');
    // The ledger layer stores the withheld figure as a positive deduction
    // amount — no sign of its own. The true minus is the formatter's law
    // (pinned in format.test.ts), not the adapter's.
    expect(row.withheld).toBe('$296,296.29');
    expect(row.net).toBe('$938,271.60');
    expect(row.ytdGross).toBe('$2,000,000,000.00');
    // Distinct folds, distinct figures — never a copied value.
    expect(row.ytdGross).not.toBe(row.grossPaid);
    expect(row.txns).toBe(1);
  });

  it('carries the effective rate in the CSV percent voice, derived at render', () => {
    expect(formatWithholdingRow(payeeView({ effectiveRate: 0.24 })).effectiveRate).toBe('24.00%');
    expect(formatWithholdingRow(payeeView({ effectiveRate: 0.1 })).effectiveRate).toBe('10.00%');
  });
});

describe('the cleared period summary (reconcilePeriodSummary)', () => {
  it('holds the founder identity netPayout = gross − adjustedFee − withheld exactly in bigint', () => {
    const rows = [
      txnView({
        grossMinor: 200_000_000_000n,
        feeMinor: 1_234_567n,
        dustMinor: 890n,
        withheldMinor: 48_000_000_000n,
        netMinor: 200_000_000_000n - 1_234_567n - 48_000_000_000n,
      }),
      txnView({
        transactionId: 'TX-2',
        grossMinor: 7_777_777n,
        feeMinor: 12_345n,
        dustMinor: 5n,
        withheldMinor: 1_866_666n,
        netMinor: 7_777_777n - 12_345n - 1_866_666n,
      }),
    ];
    const summary = reconcilePeriodSummary(rows);
    const gross = rows.reduce((sum, row) => sum + row.grossMinor, 0n);
    const adjustedFee = rows.reduce((sum, row) => sum + row.feeMinor, 0n);
    const withheld = rows.reduce((sum, row) => sum + row.withheldMinor, 0n);
    expect(summary.txnsCount).toBe(2);
    expect(summary.gross).toBe(formatCentsBigint(gross));
    expect(summary.feeInclDust).toBe(formatCentsBigint(adjustedFee));
    expect(summary.withholding).toBe(formatCentsBigint(withheld));
    // The identity, exact — recomputed from the raw minors, not copied.
    expect(summary.netPayout).toBe(formatCentsBigint(gross - adjustedFee - withheld));
  });

  it('survives negative dust and ≥$1B magnitudes without losing a cent', () => {
    // Negative dust: the sub-cent rounding remainder on the social-fee path.
    const rows = [
      txnView({
        grossMinor: 200_000_000_000n,
        feeMinor: 999_999_999n,
        dustMinor: -3n,
        withheldMinor: 48_000_000_000n,
        netMinor: 200_000_000_000n - 999_999_999n - 48_000_000_000n,
      }),
      txnView({
        transactionId: 'TX-2',
        grossMinor: 100_000_000_000n,
        feeMinor: 500_000_000n,
        dustMinor: 7n,
        withheldMinor: 24_000_000_000n,
        netMinor: 100_000_000_000n - 500_000_000n - 24_000_000_000n,
      }),
    ];
    const summary = reconcilePeriodSummary(rows);
    expect(summary.gross).toBe('$3,000,000,000.00');
    expect(summary.feeInclDust).toBe('$14,999,999.99');
    expect(summary.withholding).toBe('$720,000,000.00');
    expect(summary.netPayout).toBe('$2,265,000,000.01');
    // The derived identity agrees with the rows' own stored nets — one truth.
    const storedNet = rows.reduce((sum, row) => sum + row.netMinor, 0n);
    expect(summary.netPayout).toBe(formatCentsBigint(storedNet));
  });

  it('maps the stored dust-inclusive fee without inventing a base fee (C7)', () => {
    const summary = reconcilePeriodSummary([
      txnView({
        grossMinor: 1_000n,
        feeMinor: 30n,
        dustMinor: 3n,
        withheldMinor: 0n,
        netMinor: 1_000n - 30n,
      }),
    ]);
    // adjustedFee IS the stored fee — the dust is already inside it.
    expect(summary.feeInclDust).toBe('$0.30');
    expect(summary.netPayout).toBe('$9.70');
  });
});

describe('the dust display is derived, never a literal (C2)', () => {
  it('carries no hardcoded display string in the adapter source', () => {
    const source = readFileSync(new URL('../controlBoardSummary.ts', import.meta.url), 'utf8');
    expect(source.includes('$0.00')).toBe(false);
  });

  it('renders the remainder of the sweep identity — nonzero the moment the sweep is partial', () => {
    expect(cornerDustRemainder(500n, 300n)).toBe(200n);
    expect(formatCentsBigint(cornerDustRemainder(500n, 300n))).toBe('$2.00');
  });

  it('reads as zero because the engine sweeps every recorded dust cent into the fee', () => {
    const summary = reconcilePeriodSummary([
      txnView({
        grossMinor: 1_000n,
        feeMinor: 30n,
        dustMinor: 3n,
        withheldMinor: 0n,
        netMinor: 1_000n - 30n,
      }),
    ]);
    expect(summary.displayCornerDust).toBe('$0.00');
  });
});

describe('the adapter over the live dev-seed selectors', () => {
  let tax: ReturnType<typeof buildTaxSection>;

  beforeAll(async () => {
    process.env.DON_DEV_SEED = '1';
    await bootDevSeedStore();
    const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
    await seedAdminDemoDataIfEmpty();
    const rows = await listLedger();
    const assets = await listAssets();
    const contracts: SectionData<ContractRow[]> = { kind: 'ready', value: [] };
    tax = buildTaxSection(rows, assets, contracts);
  });

  it('maps every register row the real selectors produce', () => {
    expect(tax.payees.length).toBeGreaterThan(0);
    for (const payee of tax.payees) {
      const row = formatWithholdingRow(payee);
      expect(row.payeeId).toBe(payee.payeeId);
      expect(row.payeeName).toBe(payee.payeeName);
      expect(row.grossPaid).toBe(formatCentsBigint(payee.grossMinor));
      expect(row.net).toBe(formatCentsBigint(payee.netMinor));
    }
  });

  it('applies the corporate suppression to the real exempt payee', () => {
    const exempt = tax.payees.find((payee) => payee.forms.includes('EXEMPT_CORPORATE'));
    expect(exempt, 'the demo branches include an EXEMPT_CORPORATE payee').toBeDefined();
    expect(formatWithholdingRow(exempt!).formTag).toBe('EXEMPT_CORPORATE');
  });

  it('holds the period identity and the zero dust remainder on the real ledger', () => {
    expect(tax.transactions.length).toBeGreaterThan(0);
    const summary = reconcilePeriodSummary(tax.transactions);
    expect(summary.txnsCount).toBe(tax.transactions.length);
    const storedNet = tax.transactions.reduce((sum, row) => sum + row.netMinor, 0n);
    expect(summary.netPayout).toBe(formatCentsBigint(storedNet));
    expect(summary.displayCornerDust).toBe('$0.00');
    // Real dev-seed magnitudes ride the same bigint path: the register's
    // gross crosses $1B by construction (the $1B reserve seed).
    expect(summary.gross).toContain(',');
  });
});
