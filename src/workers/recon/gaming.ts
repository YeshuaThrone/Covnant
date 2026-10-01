/**
 * CVT recon worker — the gaming lane's pure fee/conversion engine (PR 12,
 * founder gaming directive). The store-touching passes live in
 * gamingQueue.ts / gamingPosting.ts and the split accrual module
 * (src/modules/gamingSplits/); this module is the math and the identity
 * spaces, no store, no clock, no IO — the same discipline as the podcast
 * and waterfall engines.
 *
 * House rules, restated as the module's contract:
 * - DETERMINISTIC BIGINT INTEGER MATH ONLY — the 1e-8 micros fixed-point
 *   discipline; a float anywhere in this file is a bug.
 * - SUB-CENT RESIDUE NEVER ROUNDS UP — every division floors; the ledger
 *   never invents money.
 * - FAIL-CLOSED — any row the lane cannot fully verify is a typed rejection
 *   at parse time (the profiles) or a refused post (the posting pass);
 *   nothing defaults to allowing.
 *
 * The four money movements the founder directive pins:
 *
 *   1. PLATFORM COMMISSION — per-platform bands, validated at parse time:
 *      Apple App Store 15-30% (1500-3000 bps, the founder's range), Steam
 *      30% (3000), Epic Games Store 12% (1200), Unity Asset Store 30%
 *      (3000), Roblox marketplace fee 30% (3000). The pinned-exact bands
 *      reject any other rate; Apple's band rejects anything outside it.
 *
 *   2. ENGINE ROYALTY — Epic family only: 0% up to $1M gross ANNUAL revenue
 *      per product, 3.5% (350 bps) on the portion once crossed, WAIVED on
 *      Epic Games Store sales. The accumulator is per-product-year state
 *      with store backing (gaming_engine_royalty_contributions): each
 *      royalty-bearing line contributes its gross at its write time, the
 *      contribution is unique per source event (the replay guard), and the
 *      marginal tax window is computed from the contributions recorded
 *      BEFORE the line — insert-order deterministic, replay-no-op.
 *
 *   3. DEVEX CONVERSION — a Roblox conversion log row's fiat gross is
 *      earned Robux × the recorded exchange rate, exact bigint math at
 *      1e-8 (virtual × rate / 1e8, floor). The rate is RECORDED on each
 *      conversion log row — the queue row carries virtual_currency_code,
 *      virtual_amount, and exchange_rate verbatim, so the conversion is
 *      auditable from the row alone.
 *
 *   4. SECONDARY RESALE ROYALTY — the secondary platform creator fee
 *      (5-10%, 500-1000 bps, validated at parse) on secondary_resale
 *      lines. The pool routes downstream to the item's registered split
 *      payees as automatic micro-payouts (gamingPosting + gamingSplits);
 *      the seller's net posts after the deduction.
 */

import type { MatchQueueSaleType } from "@/modules/sdk/records";
import type { GamingLineDetail, GamingPlatform } from "./records";

/** 1 ledger cent = 10^6 statement micros; 1e-8 micros is the money unit. */
export const MICROS_SCALE = 100_000_000n;

/**
 * The Unreal engine royalty threshold — $1,000,000 gross annual revenue
 * per product, in 1e-8 micros (100,000,000 cents × 10^6).
 */
export const ENGINE_ROYALTY_THRESHOLD_MICROS = 100_000_000n * MICROS_SCALE;

/** The engine royalty rate once the threshold is crossed — 3.5% = 350 bps. */
export const ENGINE_ROYALTY_BPS = 350;

/** The founder-pinned platform commission bands (whole basis points). */
export const APPLE_COMMISSION_MIN_BPS = 1500;
export const APPLE_COMMISSION_MAX_BPS = 3000;
export const STEAM_COMMISSION_BPS = 3000;
export const EPIC_COMMISSION_BPS = 1200;
export const UNITY_COMMISSION_BPS = 3000;
export const ROBLOX_COMMISSION_BPS = 3000;

/**
 * The secondary platform creator fee band — 5-10% of the resale gross
 * (500-1000 bps); outside the band is a hostile row, rejected at parse.
 */
export const MIN_RESALE_ROYALTY_BPS = 500;
export const MAX_RESALE_ROYALTY_BPS = 1000;

/** The platforms whose sales accumulate toward the engine-royalty threshold. */
export function isEpicFamilyPlatform(platform: GamingPlatform): boolean {
  return platform === "epic_games_store" || platform === "unreal_marketplace";
}

/**
 * The engine-royalty levy trigger for one line: Epic family, and NOT an
 * Epic Games Store sale (the founder's waiver — the store's 12% commission
 * is the engine's take on EGS sales; only Unreal Marketplace sales bear
 * the royalty).
 */
export function bearsEngineRoyalty(detail: GamingLineDetail): boolean {
  return isEpicFamilyPlatform(detail.platform) && detail.engineRoyaltySubject;
}

/**
 * Validates one platform commission against the platform's band. The
 * founder pinned Apple's 15-30% RANGE and Steam/EGS' exact rates; Unity
 * and Roblox carry their platforms' standard 30% (configurable constants,
 * pinned-exact like Steam). Outside the band is a hostile row.
 */
export function validateCommissionBps(
  platform: GamingPlatform,
  bps: number,
): void {
  switch (platform) {
    case "apple_vision_pro":
      if (bps < APPLE_COMMISSION_MIN_BPS || bps > APPLE_COMMISSION_MAX_BPS) {
        throw new RangeError(`commission_out_of_band:${platform}:${bps}`);
      }
      return;
    case "steamworks":
      if (bps !== STEAM_COMMISSION_BPS) {
        throw new RangeError(`commission_out_of_band:${platform}:${bps}`);
      }
      return;
    case "epic_games_store":
    case "unreal_marketplace":
      if (bps !== EPIC_COMMISSION_BPS) {
        throw new RangeError(`commission_out_of_band:${platform}:${bps}`);
      }
      return;
    case "unity_asset_store":
      if (bps !== UNITY_COMMISSION_BPS) {
        throw new RangeError(`commission_out_of_band:${platform}:${bps}`);
      }
      return;
    case "roblox":
      if (bps !== ROBLOX_COMMISSION_BPS) {
        throw new RangeError(`commission_out_of_band:${platform}:${bps}`);
      }
      return;
  }
}

/**
 * Validates the secondary platform creator fee — the 5-10% band, required
 * on secondary_resale lines, forbidden on primary lines (a royalty rate on
 * a primary sale is a contract error: nothing to route downstream).
 */
export function validateResaleRoyaltyBps(
  saleType: MatchQueueSaleType,
  bps: number | null,
): number | null {
  if (saleType === "primary") {
    if (bps !== null) {
      throw new RangeError(`unexpected_resale_royalty:${String(bps)}`);
    }
    return null;
  }
  if (bps === null || bps < MIN_RESALE_ROYALTY_BPS || bps > MAX_RESALE_ROYALTY_BPS) {
    throw new RangeError(`resale_royalty_out_of_band:${String(bps)}`);
  }
  return bps;
}

/**
 * Platform commission — gross × bps / 10000 in exact 1e-8 micros, bigint
 * floor. The deduction never touches the ledger's integer cents: the
 * queue row records it (platform_commission_micros) and the posting pass
 * posts the NET to holding.
 */
export function platformCommissionMicros(
  grossMicros: bigint,
  bps: number,
): bigint {
  if (grossMicros < 0n) {
    throw new Error(`negative_gross:${grossMicros}`);
  }
  return (grossMicros * BigInt(bps)) / 10000n;
}

/**
 * Secondary resale royalty pool — gross × bps / 10000 in exact 1e-8
 * micros, bigint floor. Routed downstream per the item's split schedule;
 * the seller's net deducts it.
 */
export function resaleRoyaltyPoolMicros(
  grossMicros: bigint,
  bps: number | null,
): bigint {
  if (bps === null) return 0n;
  return platformCommissionMicros(grossMicros, bps);
}

/**
 * The DevEx conversion — earned Robux × the recorded exchange rate, exact
 * bigint math in the 1e-8 space: both operands are 1e-8 fixed-point, so
 * the product is 1e-16 and the fiat gross (1e-8) is the product / 1e8,
 * floored. A rate or virtual amount that does not divide evenly leaves
 * sub-micro residue on the floor — never rounded up into invented money.
 */
export function devexGrossMicros(
  virtualAmountMicros: bigint,
  exchangeRateMicros: bigint,
): bigint {
  if (virtualAmountMicros < 0n || exchangeRateMicros < 0n) {
    throw new Error(
      `negative_devex_operand:${virtualAmountMicros}:${exchangeRateMicros}`,
    );
  }
  return (virtualAmountMicros * exchangeRateMicros) / MICROS_SCALE;
}

/**
 * The engine-royalty accumulator's marginal window for ONE line: the
 * line's gross enters the per-product annual pool at position
 * [cumBefore, cumBefore + gross); only the portion of that window at or
 * above the $1M threshold bears the 3.5% royalty, and only when the line
 * is royalty-bearing (the EGS waiver and non-Epic platforms levy zero).
 * Bigint floor on the rate division — sub-micro residue never rounds up.
 *
 * Pure: the caller supplies cumBefore (the sum of the product-year's
 * recorded contributions, which the store pass derives in insertion
 * order) and receives the exact royalty micros.
 */
export function engineRoyaltyMicros(
  detail: GamingLineDetail,
  grossMicros: bigint,
  cumBeforeMicros: bigint,
): bigint {
  if (grossMicros < 0n) {
    throw new Error(`negative_gross:${grossMicros}`);
  }
  if (cumBeforeMicros < 0n) {
    throw new Error(`negative_accumulator:${cumBeforeMicros}`);
  }
  if (!bearsEngineRoyalty(detail)) return 0n;
  const cumAfter = cumBeforeMicros + grossMicros;
  const taxableFloor =
    cumBeforeMicros > ENGINE_ROYALTY_THRESHOLD_MICROS
      ? cumBeforeMicros
      : ENGINE_ROYALTY_THRESHOLD_MICROS;
  if (cumAfter <= taxableFloor) return 0n;
  const taxable = cumAfter - taxableFloor;
  return (taxable * BigInt(ENGINE_ROYALTY_BPS)) / 10000n;
}

/**
 * The gaming lane's event-id spaces. `gaming:line:` counts (posts) —
 * ingest-scoped like the podcast subscription space, because a gaming
 * report row is plain money with no cross-platform impression to dedupe.
 * `gaming:royalty:` is the resale royalty's downstream payout space —
 * CONTENT-derived per (funding line, payee), unique in the GL journal-ref
 * space (the canonical posting seam's per-source guard reads the same id).
 */
export function gamingLineEventId(
  detail: GamingLineDetail,
  ingestId: string,
  lineNumber: number,
): string {
  return `gaming:line:${detail.platform}:${ingestId}:line:${lineNumber}`;
}

export function gamingResalePayoutEventId(
  lineEventId: string,
  payeeId: string,
): string {
  return `gaming:royalty:${lineEventId}:${payeeId}`;
}
