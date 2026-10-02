/**
 * CVT recon worker — the merch lane's pure COGS / split engine (PR 22,
 * founder merchandise directive). The store-touching passes live in
 * merchQueue.ts / merchPosting.ts; this module is the math and the identity
 * spaces, no store, no clock, no IO — the same discipline as the podcast,
 * gaming, livestream, and webtoon engines.
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
 * The money math the directive pins:
 *
 *   1. DTC NET REALIZED PROFIT — a Shopify order-fulfillment row's net is
 *      gross − unit production COGS × units − shipping − fulfillment −
 *      gateway (− the storefront's deducted designer royalty), exact bigint
 *      micros. The per-unit COGS rides the row verbatim (the recorded-rate
 *      rule) AND the row's sku_id + per-unit micros are the addendum 8
 *      columns the queue row records — the FIFO amortization key the
 *      collaboration waterfall's release consumes.
 *
 *   2. POD PRINTING-BEFORE-SPLIT — a Printful/Gelato row's base item
 *      printing cost subtracts from the gross customer price FIRST; split
 *      percentages apply to the AFTER-printing remainder, never the gross.
 *      The collaborator's share floors (bps × remainder / 10_000); the
 *      brand's residual is the complement. Pricing the split off the gross
 *      would overpay the collaborator by the printing cost — that basis
 *      error is the exact behavior the lane exists to prevent.
 *
 *   3. CONSIGNMENT RECONCILIATION — a wholesale consignment payout row
 *      carries its own arithmetic (gross − commission − shrinkage
 *      allowance = reported net payout). A row that disagrees with itself
 *      is rejected whole at parse time; the shrinkage allowance is the
 *      OFFSET against the net payout — physical inventory shrinkage and
 *      loss reduces what the partner owes, never silently, never twice.
 *
 * The four event-id spaces, content-derived per row identity (the webtoon
 * fingerprint discipline — identity, never money): `merch:dtc:` per
 * (order, sku), `merch:pod:` per (platform, order, sku), `merch:consign:`
 * per payout id, `merch:pos:` per (sale, sku). A re-shipped dump replays
 * as counted no-ops through the queue's UNIQUE event_id.
 */

import { createHash } from "node:crypto";

import type {
  MerchConsignmentPlatform,
  MerchDtcPlatform,
  MerchLineDetail,
  MerchPodPlatform,
  MerchPosPlatform,
} from "./records";

export type {
  MerchConsignmentPlatform,
  MerchDtcPlatform,
  MerchPodPlatform,
  MerchPosPlatform,
};

/** House micro-dollar scale: 1 dollar = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** The POD dump's two print partners — one strict layout, a bounded column. */
export const MERCH_POD_PLATFORMS: readonly MerchPodPlatform[] = [
  "printful",
  "gelato",
];

export function isMerchPodPlatform(platform: string): platform is MerchPodPlatform {
  return MERCH_POD_PLATFORMS.includes(platform as MerchPodPlatform);
}

/**
 * A positive whole-units cell — merch rows ship physical goods; a zero or
 * fractional unit count is a hostile row (validated at parse).
 */
export function validateMerchUnits(units: number, rowNumber: number): number {
  if (!Number.isInteger(units) || units <= 0) {
    throw new RangeError(`invalid_merch_units:${units}:row_${rowNumber}`);
  }
  return units;
}

/**
 * A split-share percent in 0-100 as whole basis points (the webtoon percent
 * cell's parser produces it); a POD row outside the band is hostile.
 */
export function validateMerchSplitShareBps(bps: number, rowNumber: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`invalid_split_share_bps:${bps}:row_${rowNumber}`);
  }
  return bps;
}

/**
 * The DTC fulfillment-event identity — content-derived per (order, sku):
 * one fulfillment event per order line, so a re-shipped dump (the same
 * order in a later export) replays instead of double-posting.
 */
export function merchDtcEventId(detail: MerchLineDetail & { kind: "dtc_order" }): string {
  return `merch:dtc:${merchIdentityHash([
    detail.platform,
    detail.orderId,
    detail.skuId,
  ])}`;
}

/** The POD fulfillment-event identity — per (platform, order, sku). */
export function merchPodEventId(detail: MerchLineDetail & { kind: "pod_fulfillment" }): string {
  return `merch:pod:${merchIdentityHash([
    detail.platform,
    detail.orderId,
    detail.skuId,
  ])}`;
}

/** The consignment payout identity — the report row's own payout id. */
export function merchConsignmentEventId(
  detail: MerchLineDetail & { kind: "consignment_payout" },
): string {
  return `merch:consign:${merchIdentityHash([detail.platform, detail.payoutId])}`;
}

/** The POS sale identity — per (sale, sku). */
export function merchPosEventId(detail: MerchLineDetail & { kind: "pos_sale" }): string {
  return `merch:pos:${merchIdentityHash([
    detail.platform,
    detail.saleId,
    detail.skuId,
  ])}`;
}

/** The sha256 identity fingerprint — identity fields only, never money. */
function merchIdentityHash(fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The DTC net realized profit — gross − COGS×units − shipping −
 * fulfillment − gateway − designer royalty, exact bigint micros. Every leg
 * is the row's own recorded cell; the equation is the directive's, term for
 * term. A negative result means the row's costs exceed its revenue — the
 * posting pass refuses it (an operator quarantine, never a negative
 * settlement).
 */
export function dtcNetRealizedProfitMicros(
  detail: MerchLineDetail & { kind: "dtc_order" },
  grossMicros: bigint,
): bigint {
  const cogs = BigInt(detail.unitProductionCogsMicros) * BigInt(detail.units);
  // The dump's royalty cell is the flat PER-UNIT rate (the directive bills
  // e.g. $3.50 per garment) — the same per-unit semantics as the COGS leg.
  const royalty = BigInt(detail.designerRoyaltyMicros) * BigInt(detail.units);
  return (
    grossMicros -
    cogs -
    BigInt(detail.shippingFeeMicros) -
    BigInt(detail.fulfillmentFeeMicros) -
    BigInt(detail.gatewayFeeMicros) -
    royalty
  );
}

/**
 * The POD split basis — the AFTER-printing remainder: gross − printing
 * cost × units. THE BASIS INVARIANT: split percentages price this, never
 * the gross.
 */
export function podNetAfterPrintingMicros(
  detail: MerchLineDetail & { kind: "pod_fulfillment" },
  grossMicros: bigint,
): bigint {
  return grossMicros - BigInt(detail.printingCostPerUnitMicros) * BigInt(detail.units);
}

/**
 * The POD collaborator's split share — bps × the after-printing remainder,
 * FLOORED (sub-cent residue never rounds up). Returns the split and the
 * brand's residual (the complement) so the caller can record both without
 * recomputing.
 */
export function podSplitShareMicros(
  detail: MerchLineDetail & { kind: "pod_fulfillment" },
  grossMicros: bigint,
): { splitShareMicros: bigint; brandResidualMicros: bigint } {
  const netAfterPrinting = podNetAfterPrintingMicros(detail, grossMicros);
  const splitShareMicros = (netAfterPrinting * BigInt(detail.splitShareBps)) / 10_000n;
  return { splitShareMicros, brandResidualMicros: netAfterPrinting - splitShareMicros };
}

/**
 * The POS sale's net — gross − processing fee, exact micros. A negative
 * result refuses at post time (same posture as the DTC leg).
 */
export function posNetMicros(
  detail: MerchLineDetail & { kind: "pos_sale" },
  grossMicros: bigint,
): bigint {
  return grossMicros - BigInt(detail.processingFeeMicros);
}
