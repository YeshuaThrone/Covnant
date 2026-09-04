/**
 * Multi-pool split adapter around the vendored CovenantMasterSDK.
 *
 * Locked constraints (spec §Locked 1, §04) and how this adapter satisfies
 * them without touching the engine:
 *
 * 1. The engine validates ONE sheet per call at exactly 100.0000% (±1 unit
 *    at scale 10,000) — and `registerCBTAsset` re-validates internally
 *    (engine L326). A naive union of three full pools sums 300% and is
 *    rejected.
 * 2. Settlement (`processRoyaltySettlement`) pays each stored holder
 *    splitPercentage/100 of net, and the auditor runs
 *    `validateSplits(asset.rightsHolders)` per asset — so the STORED sheet
 *    must sum to ~100% or settlements over-disburse (FAIL_OVER_DISBURSED)
 *    and the audit flags the asset.
 *
 * Therefore the directive's "each pool independently totals 100.0000%" is
 * enforced here as the SAVE GATE (validation per pool through the engine's
 * own validateSplits), while STORAGE writes the pool-weighted union —
 * equal thirds across the pools — that sums to exactly 10,000 units.
 * Every stored holder carries `pool` and `poolSplitPercentage` (the true
 * per-pool share) as additive JSON fields, so the per-pool truth is fully
 * recoverable for displays, contracts, and per-pool settlement later.
 *
 * The engine class itself is never modified; `registerCBTAsset` remains the
 * single registration write path.
 */
import type {
  CovenantBlockAsset,
  MediaMedium,
  SelfServeRightsHolder,
  TaxProfile,
  UniversalAssetIdentifier,
} from '@/engine/covenant-master-sdk';
import type { CovenantMasterSDK } from '@/engine/covenant-master-sdk';
import {
  POOL_NAMES,
  SPLIT_SCALE,
  TARGET_UNITS,
  sumPoolUnits,
  type HolderDraft,
  type PoolName,
} from './shared';

/**
 * The engine's DB insert is not idempotent (registerCBTAsset performs a plain
 * INSERT on cbt_assets), so a duplicate collision would surface as a raw
 * Postgres error. This adapter classifies the collision — via the pre-write
 * catalog probe and the DB unique-constraint catch below — so the UI can
 * render the gold banner instead. The engine file itself is never touched.
 */
export const DUPLICATE_ASSET_MESSAGE = 'Asset already registered in CBT catalog';

export class DuplicateAssetRegistrationError extends Error {
  readonly title: string;
  readonly medium: string;

  constructor(title: string, medium: string) {
    super(DUPLICATE_ASSET_MESSAGE);
    this.name = 'DuplicateAssetRegistrationError';
    this.title = title;
    this.medium = medium;
  }
}

/** Postgres 23505 as surfaced through the engine's `Database registration failed:` wrapper. */
export function isDuplicateKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key/i.test(message) || /unique constraint/i.test(message);
}

export interface SplitPool {
  pool: PoolName;
  holders: SelfServeRightsHolder[];
}

export interface PoolValidationResult {
  pool: PoolName;
  valid: boolean;
  /** Percentage sum at 4-decimal precision, e.g. 99.9999. */
  sum: number;
}

export type PoolTaggedHolder = SelfServeRightsHolder & {
  pool: PoolName;
  /** True per-pool share as entered in the studio (sums to 100.0000 per pool). */
  poolSplitPercentage: number;
};

/**
 * Validate each pool through TWO gates:
 *
 * 1. The engine's own validateSplits (scale 10,000, ±1 unit tolerance) —
 *    the untouched validation the registration and audit paths run.
 *    Pass `sdk: null` to skip this gate (client components cannot hold the
 *    engine bundle); every server write path passes the SDK and re-validates.
 * 2. The directive's strict save gate: the pool must read EXACTLY
 *    100.0000% (1,000,000 units). The engine alone would accept 99.9999%
 *    or 100.0001% within its ±1-unit tolerance; the save gate does not —
 *    and is therefore strictly tighter than gate 1 by construction.
 *
 * Never throws for invalid pools — returns per-pool results so the UI can
 * render all chips at once.
 */
export function validateMultiPoolSplits(
  sdk: CovenantMasterSDK | null,
  pools: SplitPool[],
): PoolValidationResult[] {
  return pools.map((p) => {
    let engineOk = true;
    if (sdk) {
      try {
        sdk.validateSplits(p.holders);
        engineOk = true;
      } catch {
        engineOk = false;
      }
    }
    const units = sumPoolUnits(p.holders.map((h) => h.splitPercentage));
    const strictOk = units === TARGET_UNITS;
    return {
      pool: p.pool,
      valid: engineOk && strictOk,
      sum: strictOk ? 100 : units / SPLIT_SCALE,
    };
  });
}

/**
 * Equal pool weights at unit granularity so the stored sheet always sums to
 * exactly 1,000,000 units (100.0000%) regardless of pool count (3 pools →
 * 333,334 / 333,333 / 333,333 — the first pool absorbs the 10⁶ % n remainder).
 */
export function poolWeightUnits(count: number): number[] {
  const base = Math.floor(TARGET_UNITS / count);
  const remainder = TARGET_UNITS % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Flatten pool-tagged holders into the engine-facing sheet: each holder's
 * stored splitPercentage is its pool share scaled by the pool's weight, with
 * the pool's residual unit (from integer flooring) assigned to the holder
 * holding the largest share of that pool. Deterministic, and the grand total
 * is exactly 1,000,000 units (100.0000%) by construction.
 */
export function buildPoolWeightedSheet(pools: SplitPool[]): PoolTaggedHolder[] {
  if (pools.length === 0) throw new Error('At least one pool is required.');
  const weights = poolWeightUnits(pools.length);
  const sheet: PoolTaggedHolder[] = [];

  pools.forEach((p, poolIndex) => {
    const alloc = weights[poolIndex];
    const poolUnits = p.holders.map((h) => Math.round(h.splitPercentage * SPLIT_SCALE));
    const storedUnits = poolUnits.map((u) => Math.floor((u * alloc) / TARGET_UNITS));
    if (p.holders.length > 0) {
      const residual = alloc - storedUnits.reduce((a, b) => a + b, 0);
      let largest = 0;
      for (let i = 1; i < storedUnits.length; i += 1) {
        if (poolUnits[i] > poolUnits[largest]) largest = i;
      }
      storedUnits[largest] += residual;
    }
    p.holders.forEach((h, i) => {
      sheet.push({
        ...h,
        pool: p.pool,
        poolSplitPercentage: h.splitPercentage,
        splitPercentage: storedUnits[i] / SPLIT_SCALE,
      });
    });
  });

  return sheet;
}

/**
 * Register a multi-pool asset. Every pool must independently read exactly
 * 100.0000% BEFORE any write happens (the gate invariant, enforced
 * server-side so a stale client cannot bypass it); the flattened sheet is
 * then registered through the engine's single write path.
 *
 * Duplicate prevention (adapter only): `options.findExisting` probes the
 * catalog for an identical medium+title BEFORE any write, and a raw DB
 * unique-constraint error from the engine's non-idempotent INSERT is caught
 * and rethrown as a DuplicateAssetRegistrationError — a Postgres error never
 * escapes this adapter.
 */
export async function registerMultiPoolAsset(
  sdk: CovenantMasterSDK,
  input: {
    title: string;
    medium: MediaMedium;
    identifiers: UniversalAssetIdentifier;
    pools: SplitPool[];
  },
  options: {
    /** Catalog probe (works in both data modes); resolves true when an identical asset exists. */
    findExisting?: (title: string, medium: string) => Promise<boolean>;
  } = {},
): Promise<{ cbtCode: string; success: boolean }> {
  const title = input.title.trim();
  if (options.findExisting && (await options.findExisting(title, input.medium))) {
    throw new DuplicateAssetRegistrationError(title, input.medium);
  }

  const invalid = validateMultiPoolSplits(sdk, input.pools).filter((r) => !r.valid);
  if (invalid.length > 0) {
    throw new Error(
      'Each pool must independently total 100.0000% — invalid pools: ' +
        invalid.map((r) => `${r.pool} at ${r.sum.toFixed(4)}%`).join(', '),
    );
  }

  try {
    return await sdk.registerCBTAsset(
      title,
      input.medium,
      input.identifiers,
      buildPoolWeightedSheet(input.pools),
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new DuplicateAssetRegistrationError(title, input.medium);
    }
    throw error;
  }
}

/**
 * Save a new split sheet for an existing asset. Re-validates every pool
 * through the engine before touching storage; the updated sheet is written
 * via the engine's public registerInMemory (Map.set on the same CBT code is
 * the update semantics the engine exposes) plus a DB upsert in Supabase
 * mode. Returns per-pool results; nothing is written when any pool is off.
 */
export async function saveAssetSplits(
  sdk: CovenantMasterSDK,
  cbtCode: string,
  pools: SplitPool[],
): Promise<PoolValidationResult[]> {
  const results = validateMultiPoolSplits(sdk, pools);
  if (results.some((r) => !r.valid)) return results;

  const existing = await sdk.getOrHydrateAsset(cbtCode);
  const sheet = buildPoolWeightedSheet(pools);
  const updated: CovenantBlockAsset = { ...existing, rightsHolders: sheet };
  sdk.registerInMemory(updated);

  if (sdk.dbClient) {
    const { error } = await sdk.dbClient
      .from('cbt_assets')
      .upsert(
        [
          {
            cbt_code: updated.cbtCode,
            title: updated.title,
            medium: updated.medium,
            mapped_identifiers: updated.mappedIdentifiers,
            rights_holders: updated.rightsHolders,
            created_timestamp: updated.createdTimestamp,
          },
        ],
        { onConflict: 'cbt_code' },
      );
    if (error) throw new Error(`Database splits update failed: ${error.message}`);
  }
  return results;
}

/** Map studio drafts to engine holders. v1 collects no raw tax IDs. */
export function holdersFromDrafts(drafts: HolderDraft[]): SelfServeRightsHolder[] {
  return drafts.map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role,
    splitPercentage: d.splitPercentage,
    taxProfile: {
      taxFormType: d.taxFormType,
      taxIdentifierEncrypted: 'NOT_COLLECTED_V1',
      usTaxResident: d.usTaxResident,
      treatyCountryCode: d.treatyCountryCode,
      treatyWithholdingRate: d.treatyWithholdingRate,
      isBackupWithholdingRequired: false,
      isVerified: d.isVerified,
    } satisfies TaxProfile,
    payoutRouting: { ...d.routing },
    confirmedByArtist: true,
  }));
}

/** Group a stored (pool-tagged) sheet back into per-pool true shares. */
export function poolsFromSheet(asset: CovenantBlockAsset): SplitPool[] {
  return POOL_NAMES.map((pool) => ({
    pool,
    holders: asset.rightsHolders
      .filter((h): h is PoolTaggedHolder => (h as PoolTaggedHolder).pool === pool)
      .map((h) => ({ ...h, splitPercentage: (h as PoolTaggedHolder).poolSplitPercentage })),
  }));
}
