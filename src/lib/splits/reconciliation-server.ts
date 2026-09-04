/**
 * Server-side composition of the pre-posting reconciliation lock.
 *
 * Validates the stored sheet through the FULL engine gate (validateSplits via
 * getSdk) plus the strict exact-unit gate, then folds both into the UI's
 * blocking reason. Server components only — this module pulls the engine
 * bundle; client code consumes the lock via props instead.
 */

import { getSdk } from '@/lib/sdk';
import { poolsFromSheet, validateMultiPoolSplits, type SplitPool } from './multi-pool';
import { poolUnitsFromShares } from './shared';
import { reconciliationBlocker, zipReconciliation } from './reconciliation';

/** Fail-closed reason when the asset of record cannot be read at all. */
export const ASSET_OF_RECORD_BLOCKER =
  'Pre-posting reconciliation locked — the asset of record is unavailable, so its split sheet could not be verified.';

export interface ReconciliationSnapshot {
  /** Exact per-pool unit sums (1 unit = 0.0001%) for the verification strip. */
  poolUnits: number[];
  /** Human-readable posting blocker, or null when every pool reconciles. */
  blocker: string | null;
}

export function reconciliationSnapshotForPools(pools: SplitPool[]): ReconciliationSnapshot {
  const results = validateMultiPoolSplits(getSdk(), pools);
  return {
    poolUnits: pools.map((pool) =>
      Number(poolUnitsFromShares(pool.holders.map((h) => h.splitPercentage))),
    ),
    blocker: reconciliationBlocker(zipReconciliation(pools, results)),
  };
}

export function reconciliationSnapshotForAsset(
  asset: Parameters<typeof poolsFromSheet>[0] | undefined,
): ReconciliationSnapshot {
  if (!asset) return { poolUnits: [], blocker: ASSET_OF_RECORD_BLOCKER };
  return reconciliationSnapshotForPools(poolsFromSheet(asset));
}
