/**
 * Verification-badge derivation — pure, client-safe logic that turns the
 * read-only ledger API's settlements (GET /api/ledger) plus an asset's
 * per-pool unit sums into the three badge states:
 *
 * - Pre-Reconciled: every pool of the asset's stored sheet sums to exactly
 *   100.0000% (1,000,000 units).
 * - Audited: at least one ledger entry exists for the asset's CBT code —
 *   its provenance is traceable on the universal royalty ledger.
 * - Immutable Ledger Active: the asset is bound to live ledger entries AND
 *   its current sheet still reconciles — a fully verified instrument.
 */

import { TARGET_UNITS } from '@/lib/splits/shared';

export interface LedgerSettlementRef {
  cbtCode: string;
}

export interface AssetVerification {
  preReconciled: boolean;
  audited: boolean;
  immutableActive: boolean;
}

export function deriveAssetVerification(
  cbtCode: string,
  poolUnits: number[],
  settlements: readonly LedgerSettlementRef[],
): AssetVerification {
  const preReconciled =
    poolUnits.length > 0 && poolUnits.every((units) => BigInt(units) === BigInt(TARGET_UNITS));
  const audited = settlements.some((s) => s.cbtCode === cbtCode);
  return { preReconciled, audited, immutableActive: preReconciled && audited };
}
