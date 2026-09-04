/**
 * Ledger display adapter — routes every settlement amount through the
 * fixed-point micro handler (8 decimal places), so no display path multiplies
 * or sums floats. The ledger store/persistence layer is untouched.
 */

import { CURRENCY_DECIMALS } from './currency-precision';
import { addMicro, formatMicro, microFromNumber } from '@/lib/fixed-point';
import type { LedgerRow } from './store';

/**
 * Format a ledger amount for display: the number crosses into integer space
 * once (microFromNumber), then formatting is pure string/BigInt work grouped
 * with thousands separators at the currency's engine precision.
 */
export function formatLedgerAmount(amount: number, currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 4;
  return groupThousands(formatMicro(microFromNumber(amount), decimals));
}

function groupThousands(formatted: string): string {
  const [intPart, ...rest] = formatted.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rest.length > 0 ? `${grouped}.${rest.join('.')}` : grouped;
}

export interface LedgerMicroTotals {
  count: number;
  gross: bigint;
  fees: bigint;
  cornerDust: bigint;
}

/**
 * Totals for the ledger strip, summed in micro units per column. Raw units
 * across currencies stay mixed (per the ledger's no-FX contract) — the sum is
 * exact integer arithmetic instead of the float reduce it replaces.
 */
export function ledgerTotalsMicro(rows: LedgerRow[]): LedgerMicroTotals {
  return rows.reduce<LedgerMicroTotals>(
    (acc, row) => ({
      count: acc.count + 1,
      gross: addMicro(acc.gross, microFromNumber(row.grossSettled)),
      fees: addMicro(acc.fees, microFromNumber(row.covenantFee)),
      cornerDust: addMicro(acc.cornerDust, microFromNumber(row.cornerDustCollected)),
    }),
    { count: 0, gross: 0n, fees: 0n, cornerDust: 0n },
  );
}

/** Format a micro-unit total at the reference currency's precision. */
export function formatMicroTotal(total: bigint, currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 4;
  return groupThousands(formatMicro(total, decimals));
}
