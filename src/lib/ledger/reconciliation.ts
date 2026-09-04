/**
 * Ledger reconciliation — integer-safe audit math for the Universal Royalty
 * Ledger. Directive §5: the audit view reports reconciliation status without
 * float arithmetic, and the parallel ledger-precision module has not merged,
 * so this module is the integer-safe stopgap: every sum, difference, and
 * comparison runs on BigInt minor units.
 *
 * The vendored engine (SHA-locked) settles in scaled BigInt units and stores
 * `Number(scaledBI) / scaleNum` on the ledger row. Recovering the scaled
 * integers with `Math.round(value * scale)` round-trips exactly at v1
 * magnitudes; no float sum is ever formed.
 *
 * Client-safe by design: no engine import, no server-only import — the audit
 * view renders this on the server today and can reuse it on the client later.
 */

import { CURRENCY_DECIMALS } from './currency-precision';
import type { LedgerRow } from './store';

/** Decimal places per currency (engine's CURRENCY_DECIMALS mirror). */
export function decimalsFor(currency: string): number {
  return CURRENCY_DECIMALS[currency] ?? 4;
}

function scaleFor(currency: string): bigint {
  return 10n ** BigInt(decimalsFor(currency));
}

/**
 * Ledger units → minor units. Inverse of the engine's storage conversion
 * (`Number(scaledBI) / scaleNum`), so integer identities hold exactly.
 * Throws on non-finite input — callers surface corrupt data as DRIFT, they
 * do not silently re-derive it.
 */
export function toMinor(amount: number, currency: string): bigint {
  if (!Number.isFinite(amount)) {
    throw new TypeError(`Non-finite ledger amount: ${amount}`);
  }
  const scale = Number(scaleFor(currency));
  return BigInt(Math.round(amount * scale));
}

/**
 * Minor units → display string, integer-only (no float formatting path).
 * `12345678n` at 4 decimals → "12,345.6789".
 */
export function formatMinor(minor: bigint, currency: string): string {
  const decimals = decimalsFor(currency);
  const scale = 10n ** BigInt(decimals);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const units = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0) return `${negative ? '-' : ''}${units}`;
  const frac = (abs % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${units}.${frac}`;
}

export interface CurrencyTotals {
  currency: string;
  settlements: number;
  grossMinor: bigint;
  feesMinor: bigint;
  dustMinor: bigint;
}

/**
 * Per-currency totals in minor units. Unlike a raw float rollup, currencies
 * are never summed across each other — each line is exact.
 */
export function totalsByCurrency(rows: LedgerRow[]): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>();
  for (const row of rows) {
    const entry = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      settlements: 0,
      grossMinor: 0n,
      feesMinor: 0n,
      dustMinor: 0n,
    };
    entry.settlements += 1;
    entry.grossMinor += toMinor(row.grossSettled, row.currency);
    entry.feesMinor += toMinor(row.covenantFee, row.currency);
    entry.dustMinor += toMinor(row.cornerDustCollected, row.currency);
    byCurrency.set(row.currency, entry);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface RowReconciliation {
  transactionId: string;
  currency: string;
  /** Σ holder gross vs gross − fee, in minor units. */
  expectedMinor: bigint;
  distributedMinor: bigint;
  /** expected − distributed; 0n means the row distributes exactly. */
  driftMinor: bigint;
  /** Count of disbursements where gross − withheld ≠ net. */
  netDriftCount: number;
  /** Count of disbursements whose currency differs from the settlement. */
  currencyMismatchCount: number;
  findings: string[];
  status: 'PASS' | 'DRIFT';
}

/**
 * Reconcile one settlement row against the engine's own settlement identities
 * (covenant-master-sdk.ts, processRoyaltySettlement):
 *
 *   1. Distribution — the row's stored fee already contains the corner dust
 *      (finalFee = fee + dust), so Σ holder gross == gross − fee exactly.
 *   2. Per holder — net == gross − withheld exactly.
 *   3. Currency — every disbursement carries the settlement's currency.
 *
 * Rows the engine settled all three pass; drift means the stored data no
 * longer satisfies the engine's arithmetic.
 */
export function reconcileRow(row: LedgerRow): RowReconciliation {
  const findings: string[] = [];
  let netDriftCount = 0;
  let currencyMismatchCount = 0;

  const stored = [
    row.grossSettled,
    row.covenantFee,
    row.cornerDustCollected,
    ...row.disbursements.flatMap((d) => [d.grossShare, d.withholdingTaxDeducted, d.netShare]),
  ];
  if (stored.some((a) => !Number.isFinite(a))) {
    findings.push('non-finite amount stored in the row');
    return {
      transactionId: row.transactionId,
      currency: row.currency,
      expectedMinor: 0n,
      distributedMinor: 0n,
      driftMinor: 0n,
      netDriftCount,
      currencyMismatchCount,
      findings,
      status: 'DRIFT',
    };
  }

  const expectedMinor =
    toMinor(row.grossSettled, row.currency) - toMinor(row.covenantFee, row.currency);
  const distributedMinor = row.disbursements.reduce<bigint>(
    (sum, d) => sum + toMinor(d.grossShare, row.currency),
    0n,
  );
  const driftMinor = expectedMinor - distributedMinor;
  if (driftMinor !== 0n) {
    findings.push(
      `distribution drift: expected ${formatMinor(expectedMinor, row.currency)}, ` +
        `distributed ${formatMinor(distributedMinor, row.currency)}`,
    );
  }

  for (const d of row.disbursements) {
    const grossMinor = toMinor(d.grossShare, row.currency);
    const withheldMinor = toMinor(d.withholdingTaxDeducted, row.currency);
    const netMinor = toMinor(d.netShare, row.currency);
    if (grossMinor - withheldMinor !== netMinor) {
      netDriftCount += 1;
      findings.push(
        `net identity drift for ${d.rightsHolderName}: ` +
          `${formatMinor(grossMinor - withheldMinor, row.currency)} ≠ net ` +
          `${formatMinor(netMinor, row.currency)}`,
      );
    }
    if (d.currency !== row.currency) {
      currencyMismatchCount += 1;
      findings.push(
        `currency mismatch: disbursement ${d.currency} on a ${row.currency} settlement`,
      );
    }
  }

  const status =
    driftMinor === 0n && netDriftCount === 0 && currencyMismatchCount === 0 ? 'PASS' : 'DRIFT';
  return {
    transactionId: row.transactionId,
    currency: row.currency,
    expectedMinor,
    distributedMinor,
    driftMinor,
    netDriftCount,
    currencyMismatchCount,
    findings,
    status,
  };
}

export interface LedgerReconciliation {
  totalRows: number;
  passCount: number;
  driftCount: number;
  status: 'RECONCILED' | 'ATTENTION';
  rows: RowReconciliation[];
  byCurrency: CurrencyTotals[];
}

/** Reconcile the whole ledger and produce exact per-currency totals. */
export function reconcileLedger(rows: LedgerRow[]): LedgerReconciliation {
  const reconciled = rows.map(reconcileRow);
  const driftCount = reconciled.filter((r) => r.status === 'DRIFT').length;
  return {
    totalRows: reconciled.length,
    passCount: reconciled.length - driftCount,
    driftCount,
    status: driftCount === 0 ? 'RECONCILED' : 'ATTENTION',
    rows: reconciled,
    byCurrency: totalsByCurrency(rows),
  };
}
