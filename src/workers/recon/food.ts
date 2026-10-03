/**
 * CVT recon worker — the food lane's pure engine (PR 40, the founder food
 * directive): the identity spaces, THE NET RECIPE REALIZATION CALCULATOR,
 * the tiered recipe royalty walk (per-dish micro-payouts plus percentage
 * splits on the location's cumulative monthly units — the founder's 4%
 * scaling to 7% strictly POST the 2500-unit threshold), the host kitchen
 * operator split with its brand licensor holdback, the weighted co-branded
 * menu splits, the cook-cycle micro-royalties, and the proportional
 * supplier rebate routing.
 *
 * Every function here is pure — no store, no I/O — and exact to the cent:
 * deductions and splits floor per leg (never round up — the house money
 * discipline), the calculators' identities hold on every input, the unit
 * tier walk's band allocations conserve the units exactly, and every
 * micro-royalty is bigint-exact statement micros floored into payable
 * cents. The queue writer consumes these; the profiles parse into them.
 */

import { createHash } from "node:crypto";

import type {
  FoodCobrandWeightingLeg,
  FoodCobrandSplitLeg,
  FoodOperatorWaterfallLeg,
  FoodRebateRoutingLeg,
  FoodRoyaltyBpsBand,
  FoodUnitBand,
  FoodUnitWalkLeg,
} from "@/modules/food/records";

/** The food lane's statement senders — the five strict layouts' families. */
export type FoodSenderCode =
  | "delivery_app_order"
  | "pos_ticket"
  | "meal_kit_production"
  | "grocery_cpg_scan"
  | "supplier_rebate";

function foodFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (ledger, sender, chef, recipe, location,
 * period, sender row id). The sender's row id of record is the identity
 * core: a re-shipped sheet replays as a counted no-op, and two senders'
 * sheets for the same chef stay distinct identities. The ledger namespace
 * rides the prefix — one source event can appear in several ledgers (a
 * delivery order walks the realization, royalty, and co-brand ledgers)
 * without colliding.
 */
export function foodRowEventId(
  ledger:
    | "realization"
    | "royalty"
    | "cobrand"
    | "host"
    | "cookcycle"
    | "rebate",
  detail: {
    sender: FoodSenderCode;
    // The rebate sender carries no chef/recipe identity (a supplier
    // statement is dish-agnostic) — absent fields fingerprint as "".
    chefId?: string;
    recipeId?: string;
    ghostKitchenLocationId: string;
    period: string;
    senderRowId: string;
  },
): string {
  return `food:${ledger}:${detail.sender}:${foodFingerprint(
    detail.chefId ?? "",
    detail.recipeId ?? "",
    detail.ghostKitchenLocationId,
    detail.period,
    detail.senderRowId,
  )}`;
}

/** Floors micros to integer cents — the application ledgers' pricing
 * pin (cents = micros / 1,000,000, never rounded up). Accepts the band
 * walks' bigint micros natively. */
export function foodMicrosToCents(micros: number | bigint): number {
  return Math.floor(Number(micros) / 1_000_000);
}

/** The reporting period's shape of record (YYYY-MM) — the tracking is
 * monthly. */
export function isFoodPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function foodBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE NET RECIPE REALIZATION CALCULATOR (the founder directive's exact
 * identity, keyed on the row's chef_id, recipe_id, and
 * ghost_kitchen_location_id columns — the identity legs ride the
 * application):
 *
 *   Net Culinary IP Pool =
 *     gross menu item sales
 *     − approved ingredient COGS base
 *     − delivery platform engine cut
 *     − local food service taxes
 *
 * Every leg is a recorded money amount (the order feed's own figures —
 * never a rate guess). The identity (COGS + cut + taxes + net === gross)
 * pins the math. A deduction set larger than the gross yields a negative
 * net — the CALLER holds that application (held_negative_net); this
 * function records the arithmetic honestly either way.
 */
export function netRecipeRealizationCents(input: {
  grossMenuItemSalesCents: number;
  approvedIngredientCogsCents: number;
  deliveryPlatformEngineCutCents: number;
  localFoodServiceTaxesCents: number;
}): {
  grossMenuItemSalesCents: number;
  netCulinaryIpPoolCents: number;
} {
  const legs = [
    input.grossMenuItemSalesCents,
    input.approvedIngredientCogsCents,
    input.deliveryPlatformEngineCutCents,
    input.localFoodServiceTaxesCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`food_realization_invalid_leg:${leg}`);
    }
  }
  const netCulinaryIpPoolCents =
    input.grossMenuItemSalesCents -
    input.approvedIngredientCogsCents -
    input.deliveryPlatformEngineCutCents -
    input.localFoodServiceTaxesCents;
  return {
    grossMenuItemSalesCents: input.grossMenuItemSalesCents,
    netCulinaryIpPoolCents,
  };
}

/**
 * The band containing one position — the band whose (lower, upper] window
 * holds it (the first band's lower is 0; the open top band's upper is
 * infinite). Position 2500 prices in the first band ("the first 2500
 * monthly units" include the 2500th); position 2501 prices in the open top
 * band — the founder's 7% applies strictly POST 2500. Works for both the
 * per-dish unit bands (micros per unit) and the percentage-split bands
 * (bps of the net basis) — the same window shape. Returns undefined when
 * no band holds the position (an unvalidated schedule — callers
 * re-validate bands at read).
 */
export function foodBandForPosition<B extends { up_to: number | null }>(
  position: number,
  bands: readonly B[],
): { band: B; lower: number } | undefined {
  let lower = 0;
  for (const band of bands) {
    const upper = band.up_to;
    if (upper === null || position <= upper) {
      return { band, lower };
    }
    lower = upper;
  }
  return undefined;
}

/**
 * THE TIERED RECIPE ROYALTY WALK — the row's units cross the location's
 * cumulative monthly position, and the units split across the per-dish
 * micro-payout bands they occupy (largest position first), each band's
 * payout exactly band_units × band micros (bigint-exact, per-unit pricing
 * — no remainder allocation):
 *
 *   band payout = band_units × band_micros_per_unit
 *
 * A row entirely inside the first band prices wholly at that band's rate; a
 * row straddling the threshold boundary splits exactly — the cumulative
 * position tracks the location's monthly units across every row of the
 * month. Requires units > 0; the position must be non-negative.
 */
export function unitTierWalk(input: {
  units: number;
  cumulativeBefore: number;
  bands: readonly FoodUnitBand[];
}): {
  legs: FoodUnitWalkLeg[];
  payoutMicros: bigint;
  cumulativeAfter: number;
} {
  const { units, cumulativeBefore, bands } = input;
  if (!Number.isInteger(units) || units <= 0) {
    throw new Error(`food_walk_invalid_units:${units}`);
  }
  if (!Number.isInteger(cumulativeBefore) || cumulativeBefore < 0) {
    throw new Error(`food_walk_invalid_position:${cumulativeBefore}`);
  }
  const cumulativeAfter = cumulativeBefore + units;

  // The units each band holds: band window ∩ (before, after].
  const legs: FoodUnitWalkLeg[] = [];
  let payoutMicros = 0n;
  let lower = 0;
  for (let index = 0; index < bands.length && cumulativeBefore + units > lower; index += 1) {
    const band = bands[index] as FoodUnitBand;
    const upper = band.up_to ?? cumulativeBefore + units;
    const bandUnits = Math.min(upper, cumulativeBefore + units) - Math.max(lower, cumulativeBefore);
    if (bandUnits > 0) {
      const bandPayoutMicros = BigInt(bandUnits) * BigInt(band.micros_per_unit);
      legs.push({
        band_from: lower,
        band_to: band.up_to,
        micros_per_unit: band.micros_per_unit,
        band_units: bandUnits,
        band_payout_micros: Number(bandPayoutMicros),
      });
      payoutMicros += bandPayoutMicros;
    }
    lower = upper;
  }

  return { legs, payoutMicros, cumulativeAfter };
}

/**
 * The percentage-split rate of record — the band holding the row's CLOSING
 * cumulative monthly position prices the row's net-basis share (the
 * spatial occupancy precedent: a row-level money rate reads the position
 * the row itself joins). A row whose units push the location past the
 * threshold prices at the scaled rate — "once monthly location thresholds
 * pass 2500 units". Returns undefined when no band holds the position.
 */
export function royaltyBpsForPosition(
  position: number,
  bands: readonly FoodRoyaltyBpsBand[],
): number | undefined {
  return foodBandForPosition(position, bands)?.band.royalty_bps;
}

/**
 * THE HOST KITCHEN OPERATOR SPLIT — the physical preparation margin's two
 * routes: the brand licensor's percentage cut floors off the margin, and
 * the LOCAL OPERATOR routes the residual — the margin conserves exactly:
 *
 *   host operator cents = margin − floor(margin × holdback bps / 10000)
 *
 * The brief's ordering is pinned: the physical preparation margin routes
 * DIRECTLY to the local operator; the brand licensor percentage cuts hold
 * back. A margin below zero is hostile upstream; this function never sees
 * one.
 */
export function hostOperatorSplitCents(input: {
  physicalPreparationMarginCents: number;
  brandLicensorHoldbackBps: number;
}): {
  brandLicensorHoldbackCents: number;
  hostOperatorCents: number;
} {
  const { physicalPreparationMarginCents, brandLicensorHoldbackBps } = input;
  if (!Number.isInteger(physicalPreparationMarginCents) || physicalPreparationMarginCents < 0) {
    throw new Error(`food_host_split_invalid_margin:${physicalPreparationMarginCents}`);
  }
  if (!Number.isInteger(brandLicensorHoldbackBps) || brandLicensorHoldbackBps < 0 || brandLicensorHoldbackBps > 10_000) {
    throw new Error(`food_host_split_invalid_holdback_bps:${brandLicensorHoldbackBps}`);
  }
  const brandLicensorHoldbackCents = foodBpsShareCents(
    physicalPreparationMarginCents,
    brandLicensorHoldbackBps,
  );
  return {
    brandLicensorHoldbackCents,
    hostOperatorCents: physicalPreparationMarginCents - brandLicensorHoldbackCents,
  };
}

/**
 * THE COOK-CYCLE MICRO-ROYALTY — per-execution exact: the branded cooking
 * profile's executions price at the policy's micro-fee, bigint-exact
 * statement micros floored into payable cents by the caller. A negative
 * count or rate is hostile upstream; this helper never sees one.
 */
export function cookCycleRoyaltyMicros(input: {
  cookCycles: number;
  microsPerCookCycle: number;
}): { royaltyMicros: bigint } {
  const { cookCycles, microsPerCookCycle } = input;
  if (!Number.isInteger(cookCycles) || cookCycles <= 0) {
    throw new Error(`food_cook_cycle_invalid_count:${cookCycles}`);
  }
  if (!Number.isInteger(microsPerCookCycle) || microsPerCookCycle <= 0) {
    throw new Error(`food_cook_cycle_invalid_rate:${microsPerCookCycle}`);
  }
  return { royaltyMicros: BigInt(cookCycles) * BigInt(microsPerCookCycle) };
}

/**
 * THE WEIGHTED SPLIT (largest-remainder exact) — a pot divides across the
 * weighting legs' bps shares: each leg floors pot × weight / 10000, then
 * the leftover dust distributes one cent at a time to the legs with the
 * largest fractional remainders (ties break by the legs' registration
 * order). The legs' allocated shares conserve the pot EXACTLY — the
 * identity the co-brand and rebate applications pin. Works for both the
 * co-branded menu splits (leg ids + chef/brand roles) and the supplier
 * rebate routings (operator ids) — the same proportioning shape.
 */
export function weightedSplitCents(input: {
  potCents: number;
  legs: readonly { key: string; weightBps: number }[];
}): { keys: string[]; allocated: number[] } {
  const { potCents, legs } = input;
  if (!Number.isInteger(potCents) || potCents < 0) {
    throw new Error(`food_weighted_split_invalid_pot:${potCents}`);
  }
  if (legs.length === 0) {
    throw new Error("food_weighted_split_no_legs");
  }
  // Floor every leg, track its fractional remainder, then distribute the
  // dust largest-remainder-first (ties by registration order).
  const floored = legs.map((leg, index) => {
    const exact = (potCents * leg.weightBps) / 10_000;
    return { index, key: leg.key, allocated: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const dust = potCents - floored.reduce((sum, leg) => sum + leg.allocated, 0);
  const byRemainder = [...floored].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let index = 0; index < dust; index += 1) {
    const leg = byRemainder[index % byRemainder.length] as { allocated: number };
    leg.allocated += 1;
  }
  return {
    keys: floored.map((leg) => leg.key),
    allocated: floored.map((leg) => leg.allocated),
  };
}

/**
 * The co-branded menu split's committed legs — validates the weighting legs
 * of record, then proportionates the pot (largest-remainder exact). The
 * caller has already validated; this re-checks the conservation identity.
 */
export function cobrandWeightedSplitCents(input: {
  royaltyPotCents: number;
  legs: readonly FoodCobrandWeightingLeg[];
}): { legs: FoodCobrandSplitLeg[]; allocatedTotalCents: number } {
  const split = weightedSplitCents({
    potCents: input.royaltyPotCents,
    legs: input.legs.map((leg) => ({ key: leg.leg_id, weightBps: leg.weight_bps })),
  });
  const splitLegs: FoodCobrandSplitLeg[] = input.legs.map((leg, index) => ({
    leg_id: leg.leg_id,
    payee_id: leg.payee_id,
    payee_role: leg.payee_role,
    weight_bps: leg.weight_bps,
    allocated_cents: split.allocated[index] ?? 0,
  }));
  const allocatedTotalCents = splitLegs.reduce((sum, leg) => sum + leg.allocated_cents, 0);
  if (allocatedTotalCents !== input.royaltyPotCents) {
    throw new Error(
      `food_cobrand_split_not_conserving:${allocatedTotalCents} != ${input.royaltyPotCents}`,
    );
  }
  return { legs: splitLegs, allocatedTotalCents };
}

/**
 * The supplier rebate's proportional routing — the location's operator
 * waterfall of record proportionates the volume kickback
 * (largest-remainder exact; the routing conserves the rebate exactly).
 */
export function rebateProportionalRoutingCents(input: {
  volumeRebateCents: number;
  legs: readonly FoodOperatorWaterfallLeg[];
}): { legs: FoodRebateRoutingLeg[]; routedTotalCents: number } {
  const split = weightedSplitCents({
    potCents: input.volumeRebateCents,
    legs: input.legs.map((leg) => ({ key: leg.operator_id, weightBps: leg.weight_bps })),
  });
  const routingLegs: FoodRebateRoutingLeg[] = input.legs.map((leg, index) => ({
    operator_id: leg.operator_id,
    weight_bps: leg.weight_bps,
    routed_cents: split.allocated[index] ?? 0,
  }));
  const routedTotalCents = routingLegs.reduce((sum, leg) => sum + leg.routed_cents, 0);
  if (routedTotalCents !== input.volumeRebateCents) {
    throw new Error(
      `food_rebate_routing_not_conserving:${routedTotalCents} != ${input.volumeRebateCents}`,
    );
  }
  return { legs: routingLegs, routedTotalCents };
}
