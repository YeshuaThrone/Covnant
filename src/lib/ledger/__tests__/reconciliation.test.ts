import { describe, expect, it } from 'vitest';
import type { DisbursementDetail } from '@/engine/covenant-master-sdk';
import {
  formatMinor,
  reconcileLedger,
  reconcileRow,
  toMinor,
  totalsByCurrency,
} from '../reconciliation';
import type { LedgerRow } from '../store';

/**
 * Integer-safe reconciliation math, exercised through the engine's own
 * storage conversion: BigInt-scaled arithmetic first, `Number(bi) / scale`
 * last — the exact path processRoyaltySettlement writes to the ledger row.
 * USD scales at 4 decimals (CURRENCY_DECIMALS), SAT at 8.
 */

const SCALE = 10000n; // USD minor scale (4 decimals)

function disbursement(overrides: Partial<DisbursementDetail> = {}): DisbursementDetail {
  return {
    rightsHolderId: 'rh-1',
    rightsHolderName: 'Alice Rights',
    role: 'MASTER_RECORDING',
    grossShare: 0,
    withholdingTaxRateApplied: 0,
    withholdingTaxDeducted: 0,
    netShare: 0,
    currency: 'USD',
    isTaxReportable: false,
    taxFormRequired: 'NONE',
    routing: {
      accountHolderName: 'Alice Rights',
      bankName: 'E2E Bank',
      accountNumberOrIBAN: 'DE89370400440532013000',
      routingOrBIC: 'COBADEFF',
      currency: 'USD',
      countryCode: 'DE',
      planetaryJurisdiction: 'EARTH',
      railType: 'IBAN',
    },
    ...overrides,
  };
}

/**
 * Build a row the way the engine stores one: exact BigInt distribution
 * converted to numbers at the end. gross 1,000 · platform fee 30 · net 970 ·
 * holders 60/40 split it with no floor remainder, so corner dust is 0 and
 * the stored fee is the platform fee. Engine identity: Σ holder gross ==
 * gross − storedFee (the stored fee carries any dust).
 */
function engineStoredRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  const grossBI = 1000n * SCALE;
  const platformFeeBI = 30n * SCALE;
  const netBI = grossBI - platformFeeBI;
  const holderA = (netBI * 60n) / 100n; // 5,820,000
  const holderB = netBI - holderA; // exact remainder, 3,880,000
  const toNum = (bi: bigint) => Number(bi) / Number(SCALE);

  return {
    transactionId: 'TX-1',
    cbtCode: 'CBT-TRK-TEST0001',
    platform: 'spotify',
    grossSettled: toNum(grossBI),
    covenantFee: toNum(platformFeeBI),
    cornerDustCollected: 0,
    currency: 'USD',
    disbursements: [
      disbursement({
        rightsHolderId: 'rh-a',
        rightsHolderName: 'Alice Rights',
        grossShare: toNum(holderA),
        withholdingTaxDeducted: toNum((holderA * 10n) / 100n),
        netShare: toNum(holderA - (holderA * 10n) / 100n),
      }),
      disbursement({
        rightsHolderId: 'rh-b',
        rightsHolderName: 'Bob Rights',
        grossShare: toNum(holderB),
        withholdingTaxDeducted: 0,
        netShare: toNum(holderB),
      }),
    ],
    createdAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('toMinor / formatMinor', () => {
  it('round-trips the engine storage conversion exactly', () => {
    const scaledBI = 987654321n;
    const stored = Number(scaledBI) / Number(SCALE);
    expect(toMinor(stored, 'USD')).toBe(scaledBI);
  });

  it('formats minor units with grouping and padding, integer-only', () => {
    expect(formatMinor(12345678n, 'USD')).toBe('1,234.5678');
    expect(formatMinor(5n, 'USD')).toBe('0.0005');
    expect(formatMinor(0n, 'USD')).toBe('0.0000');
    expect(formatMinor(-50n, 'USD')).toBe('-0.0050');
    expect(formatMinor(100000000n, 'USD')).toBe('10,000.0000');
  });

  it('honors the currency decimals map (JPY 2, SAT 8)', () => {
    expect(formatMinor(12345n, 'JPY')).toBe('123.45');
    expect(formatMinor(12345n, 'SAT')).toBe('0.00012345');
    expect(toMinor(0.01, 'JPY')).toBe(1n);
  });

  it('rejects non-finite amounts instead of silently rounding them', () => {
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(TypeError);
    expect(() => toMinor(Number.POSITIVE_INFINITY, 'USD')).toThrow(TypeError);
  });
});

describe('totalsByCurrency', () => {
  it('sums per currency in minor units, never across currencies', () => {
    const rows = [
      engineStoredRow(),
      engineStoredRow({ transactionId: 'TX-2' }),
      engineStoredRow({
        transactionId: 'TX-3',
        currency: 'EUR',
        grossSettled: 250,
        covenantFee: 7.5,
        cornerDustCollected: 0,
      }),
    ];
    const totals = totalsByCurrency(rows);
    expect(totals).toHaveLength(2);
    expect(totals.map((t) => t.currency)).toEqual(['EUR', 'USD']); // sorted

    const usd = totals.find((t) => t.currency === 'USD')!;
    expect(usd.settlements).toBe(2);
    expect(usd.grossMinor).toBe(2000n * SCALE);
    expect(usd.feesMinor).toBe(2n * 30n * SCALE);
    expect(usd.dustMinor).toBe(0n);
  });
});

describe('reconcileRow', () => {
  it('passes a row stored through the engine conversion', () => {
    const row = engineStoredRow();
    const recon = reconcileRow(row);
    expect(recon.status).toBe('PASS');
    expect(recon.driftMinor).toBe(0n);
    expect(recon.netDriftCount).toBe(0);
    expect(recon.findings).toEqual([]);
  });

  it('passes a row with floor-remainder corner dust inside the stored fee', () => {
    // Three holders at 33.3333/33.3333/33.3334% of net 970 floor to
    // 3,233,330 + 3,233,330 + 3,233,339 = 9,699,999 minor — one unit of
    // corner dust the engine folds into the stored platform fee.
    const netBI = 970n * SCALE;
    const a = (netBI * 333333n) / 1000000n;
    const b = (netBI * 333333n) / 1000000n;
    const c = (netBI * 333334n) / 1000000n;
    const dust = netBI - a - b - c; // 1 minor unit
    const toNum = (bi: bigint) => Number(bi) / Number(SCALE);
    const mk = (id: string, name: string, grossBI: bigint, taxBI: bigint): DisbursementDetail =>
      disbursement({
        rightsHolderId: id,
        rightsHolderName: name,
        grossShare: toNum(grossBI),
        withholdingTaxDeducted: toNum(taxBI),
        netShare: toNum(grossBI - taxBI),
      });
    const row = engineStoredRow({
      covenantFee: toNum(30n * SCALE + dust),
      cornerDustCollected: toNum(dust),
      disbursements: [
        mk('rh-a', 'Alice Rights', a, (a * 10n) / 100n),
        mk('rh-b', 'Bob Rights', b, 0n),
        mk('rh-c', 'Cara Rights', c, 0n),
      ],
    });
    const recon = reconcileRow(row);
    expect(recon.status).toBe('PASS');
    expect(recon.driftMinor).toBe(0n);
  });

  it('flags distribution drift at one minor unit', () => {
    const row = engineStoredRow();
    // Skim one minor unit off a holder's stored gross.
    row.disbursements[0].grossShare =
      (Number((engineStoredRow().disbursements[0].grossShare * Number(SCALE)).toFixed(0)) - 1) /
      Number(SCALE);
    const recon = reconcileRow(row);
    expect(recon.status).toBe('DRIFT');
    expect(recon.driftMinor).toBe(1n);
    expect(recon.findings[0]).toContain('distribution drift');
  });

  it('flags a per-holder net identity violation', () => {
    const row = engineStoredRow();
    row.disbursements[0].netShare += 0.0001;
    const recon = reconcileRow(row);
    expect(recon.status).toBe('DRIFT');
    expect(recon.netDriftCount).toBe(1);
    expect(recon.findings.some((f) => f.includes('net identity drift'))).toBe(true);
  });

  it('flags a disbursement currency mismatch', () => {
    const row = engineStoredRow();
    row.disbursements[1] = disbursement({
      ...row.disbursements[1],
      currency: 'EUR',
      grossShare: row.disbursements[1].grossShare,
      netShare: row.disbursements[1].netShare,
    });
    const recon = reconcileRow(row);
    expect(recon.status).toBe('DRIFT');
    expect(recon.currencyMismatchCount).toBe(1);
  });

  it('reports corrupt (non-finite) rows as DRIFT with a finding, not a crash', () => {
    const row = engineStoredRow({ grossSettled: Number.NaN });
    const recon = reconcileRow(row);
    expect(recon.status).toBe('DRIFT');
    expect(recon.findings[0]).toContain('non-finite');
  });
});

describe('reconcileLedger', () => {
  it('rolls row results into a ledger-level status', () => {
    const clean = reconcileLedger([engineStoredRow(), engineStoredRow({ transactionId: 'TX-2' })]);
    expect(clean.status).toBe('RECONCILED');
    expect(clean.passCount).toBe(2);
    expect(clean.driftCount).toBe(0);

    const drifted = engineStoredRow({ transactionId: 'TX-3' });
    drifted.disbursements[0].netShare += 0.0001;
    const mixed = reconcileLedger([engineStoredRow(), drifted]);
    expect(mixed.status).toBe('ATTENTION');
    expect(mixed.passCount).toBe(1);
    expect(mixed.driftCount).toBe(1);
  });

  it('handles an empty ledger as reconciled with no rows', () => {
    const empty = reconcileLedger([]);
    expect(empty.status).toBe('RECONCILED');
    expect(empty.totalRows).toBe(0);
    expect(empty.byCurrency).toEqual([]);
  });
});
