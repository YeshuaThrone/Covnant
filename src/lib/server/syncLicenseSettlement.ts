/**
 * The Sync License settlement lane (spec art_ZIdWlYUX — the
 * SyncMarketplaceRegistry amendment). A net-new module that composes the
 * locked chain FROM OUTSIDE — zero diffs to splitEngine.ts, dust.ts,
 * wire.ts, or src/lib/don/**:
 *
 *   parse fail-closed (SDK contract validators)
 *     → exact cbt_code catalog match (fail-closed when absent)
 *     → refuse any asset where is_pre_cleared !== true
 *     → exact asset-sheet match through the injected reader
 *     → allocateMicro partition of feePaidCents 50/35/15
 *     → ONE calculateUdrSplits run, three line items (one per tier), each
 *       summing exactly 10,000 BPS under zeroBalanceHolds
 *     → server-minted CBT settlement stamp (the explicitly-authorized
 *       fourth withCbtSettlementCode call site) as the write-back record.
 *
 * Replay is keyed on the minted stamp: duplicate purchases land on the
 * idempotent existing credit — the FBO GL debit balances exactly once per
 * purchase, because a replay returns the existing record without running
 * calculateUdrSplits again. No platform-side capture exists anywhere in
 * this lane; the whole fee flows to the three creator pools.
 */

import { allocateMicro, percentNumberToUnits } from '@/lib/fixed-point';
import { withCbtSettlementCode, type CbtSettlementTag } from '@/lib/ledger/cbt-settlement';
import { poolsFromSheet } from '@/lib/splits/multi-pool';
import { TARGET_UNITS } from '@/lib/splits/shared';
import type { CovenantBlockAsset, SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import type { PayeeRole, RoyaltyLineItemInput, SplitCalculateInput, SplitPartyInput } from '@/lib/don/types';
import { calculateUdrSplits, type SplitCalculateSuccess } from '@/lib/server/udrSplits';
import type { Store } from '@/lib/server/store';
import type { SyncLicensePurchaseRecord } from '@/modules/sdk/records';
import type { SyncLicensePurchaseRequest } from '../../../covnant-sdk/src/contracts/syncLibraryMarketplace';

/**
 * The Universal 50/35/15 Gross Allocation Architecture, as integer BPS of
 * the 10,000 total: Tier 1 Ownership 5,000 · Tier 2 Creative 3,500 ·
 * Tier 3 Production 1,500. Hard-locked — the lane accepts no other shape.
 */
export const SYNC_TIER_WEIGHTS = [5000n, 3500n, 1500n] as const;

/**
 * The locked Universal 50/35/15 structure, echoed in every sync-license
 * 201 response. Lives beside SYNC_TIER_WEIGHTS (its single source) — route
 * files may only export handlers and route config, so the constant cannot
 * be exported from the register route itself.
 */
export const LOCKED_SYNC_SPLITS = {
  tier1OwnershipBps: Number(SYNC_TIER_WEIGHTS[0] ?? 0n),
  tier2CreativeBps: Number(SYNC_TIER_WEIGHTS[1] ?? 0n),
  tier3ProductionBps: Number(SYNC_TIER_WEIGHTS[2] ?? 0n),
} as const;


/** The asset-sheet pool backing each tier, index-aligned with SYNC_TIER_WEIGHTS. */
const TIER_POOLS = ['MASTER_RECORDING', 'WRITER_COMPOSITION', 'PUBLISHER_ADMIN'] as const;

/**
 * The deterministic purchase reference the stamp derives from. The fee is
 * part of the identity: the same buyer/license/asset at a different fee is
 * a different purchase, never a replay of the old one.
 */
export function syncLicensePurchaseReference(request: SyncLicensePurchaseRequest): string {
  return `sync-license:${request.cvtAssetTag}:${request.buyerUct}:${request.licenseType}:${request.feePaidCents}`;
}

/** Injected asset-sheet reader — the lane never touches the SDK engine directly. */
export type SyncAssetSheetReader = (cbtCode: string) => Promise<CovenantBlockAsset | null>;

export type SyncLicenseSettlement =
  | {
      ok: true;
      /** True when the purchase had already settled — the existing record stands. */
      replay: true;
      purchase: SyncLicensePurchaseRecord;
      /** Nothing new settled on a replay — settlement is always null. */
      settlement: null;
    }
  | {
      ok: true;
      replay: false;
      purchase: SyncLicensePurchaseRecord;
      settlement: SplitCalculateSuccess['value'];
    }
  | { ok: false; status: number; code: string; message: string };

/** Holder role → payee role (the Don store's role vocabulary). */
function payeeRoleFor(role: SelfServeRightsHolder['role']): PayeeRole {
  switch (role) {
    case 'COMPOSER':
    case 'LYRICIST':
      return 'creator';
    case 'PRODUCER':
      return 'producer';
    case 'PUBLISHER':
      return 'publisher';
    default:
      return 'other';
  }
}

/**
 * One pool's holders → split parties summing EXACTLY 10,000 BPS.
 *
 * The studio save gate stores each pool at exactly 100.0000% (1,000,000
 * units at 1 unit = 0.0001%). Units divide by 100 into BPS with a
 * remainder; the remainder is handed out one BPS at a time to the largest
 * holders (ties by original order) so the pool recombines to exactly
 * 10,000 — zeroBalanceHolds inside calculateUdrSplits then balances every
 * line item. A corrupted sheet that no longer totals exactly 100.0000%
 * fails closed here rather than disbursing wrong shares.
 */
function tierSplitsFromPool(
  poolName: string,
  holders: Array<SelfServeRightsHolder & { splitPercentage: number }>,
): { ok: true; splits: SplitPartyInput[] } | { ok: false; code: string } {
  if (holders.length === 0) return { ok: false, code: `empty_pool:${poolName}` };
  const units = holders.map((holder) => percentNumberToUnits(holder.splitPercentage));
  const unitSum = units.reduce((acc, unitsValue) => acc + unitsValue, 0n);
  if (unitSum !== BigInt(TARGET_UNITS)) return { ok: false, code: `pool_not_exact:${poolName}` };

  const floors = units.map((unitsValue) => unitsValue / 100n);
  let residual = 10000n - floors.reduce((acc, floor) => acc + floor, 0n);
  const order = units
    .map((unitsValue, index) => ({ unitsValue, index }))
    .sort((a, b) =>
      b.unitsValue !== a.unitsValue
        ? b.unitsValue > a.unitsValue
          ? 1
          : -1
        : a.index - b.index,
    );
  const bps = [...floors];
  for (const { index } of order) {
    if (residual === 0n) break;
    const current = bps[index];
    if (current === undefined) break; // unreachable: index maps the same array
    bps[index] = current + 1n;
    residual -= 1n;
  }

  return {
    ok: true,
    splits: holders.map((holder, index) => ({
      payee_id: holder.id,
      payee_name: holder.name,
      role: payeeRoleFor(holder.role),
      share_bps: Number(bps[index] ?? 0n),
    })),
  };
}

/** The UNIQUE-violation shapes the three backends surface (never swallowed). */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23505') || message.includes('UNIQUE constraint failed') ||
    message.toLowerCase().includes('unique violation');
}

/**
 * Settles one sync license purchase through the locked chain. Everything
 * fails closed with a named code; the only success paths are a fresh
 * settlement (replay: false) or the idempotent existing credit (replay:
 * true).
 */
export async function settleSyncLicensePurchase(
  store: Store,
  assetSheet: SyncAssetSheetReader,
  request: SyncLicensePurchaseRequest,
  now: Date = new Date(),
): Promise<SyncLicenseSettlement> {
  // The server-minted stamp — the explicitly-authorized fourth
  // withCbtSettlementCode call site. Deterministic from the purchase
  // reference, so replay resolves to the identical stamp.
  const referenceId = syncLicensePurchaseReference(request);
  const metadata = withCbtSettlementCode({}, referenceId);
  const stamp = (metadata.cbt as CbtSettlementTag).settlementCode;

  // 1. Replay: the stamp is the idempotency key. An already-settled
  //    purchase returns the existing record — no second split run, no
  //    second FBO debit, no re-mint.
  const existing = await store.getSyncLicensePurchaseByStamp(stamp);
  if (existing !== undefined) {
    return { ok: true, replay: true, purchase: existing, settlement: null };
  }

  // 2. Exact cbt_code catalog match — fail-closed when absent.
  const catalogItem = await store.getSyncCatalogItem(request.cvtAssetTag);
  if (catalogItem === undefined) {
    return {
      ok: false,
      status: 404,
      code: 'asset_not_registered',
      message: `Asset ${request.cvtAssetTag} is not registered in the Sync Library.`,
    };
  }

  // 3. Pre-clearance gate: anything not explicitly cleared is refused.
  if (catalogItem.is_pre_cleared !== true) {
    return {
      ok: false,
      status: 403,
      code: 'not_pre_cleared',
      message: 'Asset is pending pre-clearance and cannot be licensed yet.',
    };
  }

  // 4. Exact asset-sheet match through the injected reader.
  const asset = await assetSheet(request.cvtAssetTag);
  if (asset === null) {
    return {
      ok: false,
      status: 404,
      code: 'asset_sheet_not_found',
      message: `Asset sheet ${request.cvtAssetTag} not found.`,
    };
  }

  // 5. Per-tier splits from the stored pool-tagged sheet.
  const pools = poolsFromSheet(asset);
  const tierSplits: SplitPartyInput[][] = [];
  for (let tier = 0; tier < SYNC_TIER_WEIGHTS.length; tier += 1) {
    const pool = pools.find((candidate) => candidate.pool === TIER_POOLS[tier]);
    if (pool === undefined) {
      return { ok: false, status: 422, code: `empty_pool:${TIER_POOLS[tier]}`, message: `Asset sheet has no ${TIER_POOLS[tier]} pool.` };
    }
    const splits = tierSplitsFromPool(TIER_POOLS[tier], pool.holders as Array<SelfServeRightsHolder & { splitPercentage: number }>);
    if (!splits.ok) {
      return { ok: false, status: 422, code: splits.code, message: `Pool ${splits.code.split(':')[1]} does not total exactly 100.0000%.` };
    }
    tierSplits.push(splits.splits);
  }

  // 6. The 50/35/15 partition — exact-recombining integer cents.
  const parts = allocateMicro(BigInt(request.feePaidCents), [...SYNC_TIER_WEIGHTS]);
  const lineItems: RoyaltyLineItemInput[] = tierSplits.map((splits, tier) => ({
    work_id: request.cvtAssetTag,
    work_title: asset.title,
    amount_cents: Number(parts[tier] ?? 0n),
    splits,
  }));

  // 7. ONE calculateUdrSplits run — one split_run covers all three tiers;
  //    the GL FBO debit balances exactly once per purchase.
  const input: SplitCalculateInput = {
    source: 'sync_license',
    period: null,
    currency: 'USD',
    settle: false, // credits land in the creators' pending buckets, not BaaS
    rail: 'ach', // unused while settle is false; the type requires the slot
    line_items: lineItems,
  };
  const result = await calculateUdrSplits(store, input, now);
  if (!result.ok) return result;

  // 8. The write-back record. A concurrent duplicate insert loses to the
  //    UNIQUE stamp and recovers the idempotent existing row (the
  //    settlement wire's replay precedent) — the error is never swallowed.
  try {
    const purchase = await store.insertSyncLicensePurchase({
      cvt_asset_tag: request.cvtAssetTag,
      buyer_uct: request.buyerUct,
      license_type: request.licenseType,
      fee_paid_cents: request.feePaidCents,
      cbt_settlement_stamp: stamp,
      split_run_id: result.value.split_run.id,
      metadata,
    });
    return { ok: true, replay: false, purchase, settlement: result.value };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const replayed = await store.getSyncLicensePurchaseByStamp(stamp);
    if (replayed === undefined) throw error;
    return { ok: true, replay: true, purchase: replayed, settlement: null };
  }
}
