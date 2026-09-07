/**
 * Micro-accounting denomination conversions for the banking routes.
 *
 * The flat universal_royalty_ledger stores integer cents (BIGINT), while the
 * shared escrow withholding helper runs in the engine's smallest units at
 * 1e-8 dollar granularity — 1,000,000 units per cent. Both directions are
 * exact BigInt math; no float ever touches a money amount here.
 *
 * The units→cents direction asserts exactness: a sub-cent remainder means
 * the payout is not representable in whole cents, and rounding escrow dust
 * is never an option — callers fail closed instead.
 */

import { MICRO_SCALE } from '@/lib/fixed-point';

/** Thrown when engine units are not a whole-cent multiple. Fail closed — never round escrow dust. */
export class SubUnitRemainderError extends Error {
  constructor(units: bigint) {
    super(`Engine units ${units.toString()} are not a whole-cent multiple.`);
    this.name = 'SubUnitRemainderError';
  }
}

/** Engine accounting runs at 1e-8 dollar granularity (MICRO_SCALE = 10⁸ per dollar): 10⁶ units per cent. */
export const SMALLEST_UNITS_PER_CENT = MICRO_SCALE / 100n;

/** Integer cents → engine smallest units. Exact by construction (× 10⁶). */
export function centsToEngineUnits(cents: bigint): bigint {
  return cents * SMALLEST_UNITS_PER_CENT;
}

/** Engine smallest units → integer cents. Exact division; a nonzero remainder throws. */
export function engineUnitsToCents(units: bigint): bigint {
  const cents = units / SMALLEST_UNITS_PER_CENT;
  if (units % SMALLEST_UNITS_PER_CENT !== 0n) {
    throw new SubUnitRemainderError(units);
  }
  return cents;
}
