/**
 * Pre-posting reconciliation lock — client-side gate for contract creation
 * and posting actions.
 *
 * A contract may only be created or posted against an asset whose stored
 * multi-pool split sheet reconciles to EXACTLY 100.0000% per pool. The
 * per-pool validation itself is the server-side `validateMultiPoolSplits`
 * adapter (engine gate + strict gate); this module carries its serializable
 * verdict into the UI and renders the human-readable blocking reason.
 */

import { POOL_LABELS, TARGET_UNITS, formatUnitsAsPercent, poolUnitsFromShares, type PoolName } from './shared';
import type { PoolValidationResult, SplitPool } from './multi-pool';

export interface PoolReconciliation {
  pool: PoolName;
  /** Exact unit sum of the pool's true per-pool shares (1 unit = 0.0001%). */
  units: bigint;
  /** Verdict from validateMultiPoolSplits (engine gate + strict gate). */
  valid: boolean;
}

/**
 * Zip a stored sheet's pools with their validation results into the
 * serializable snapshot the contract UI gates on.
 */
export function zipReconciliation(pools: SplitPool[], results: PoolValidationResult[]): PoolReconciliation[] {
  return pools.map((p, i) => ({
    pool: p.pool,
    units: poolUnitsFromShares(p.holders.map((h) => h.splitPercentage)),
    valid: results[i]?.valid ?? false,
  }));
}

/**
 * The blocking reason for posting, or null when every pool reconciles.
 * Fail-closed: an empty snapshot (asset of record unavailable) blocks too.
 */
export function reconciliationBlocker(pools: PoolReconciliation[]): string | null {
  if (pools.length === 0) {
    return 'Pre-posting reconciliation locked — the asset of record is unavailable, so its split sheet could not be verified.';
  }
  const off = pools.filter((p) => !p.valid || p.units !== BigInt(TARGET_UNITS));
  if (off.length === 0) return null;
  const named = off
    .map((p) => `${POOL_LABELS[p.pool]} reads ${formatUnitsAsPercent(BigInt(p.units))}%, not exactly 100.0000%`)
    .join('; ');
  return `Pre-posting reconciliation locked — ${named}.`;
}

/** True when every pool reconciles exactly (the posting-unlocked state). */
export function poolsReconciled(pools: PoolReconciliation[]): boolean {
  return reconciliationBlocker(pools) === null;
}
