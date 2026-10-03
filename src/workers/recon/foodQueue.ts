/**
 * CVT recon worker — the food lane's store-touching pass (PR 40, the
 * founder food directive). The math and identity spaces live in food.ts,
 * the profiles in foodProfiles.ts; THIS module is the only place the lane
 * touches the store — the same discipline as fitnessQueue.ts, spatialQueue.ts,
 * and nilQueue.ts.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative net is a HELD verdict (visible, never dropped,
 *   never posted), and a recipe without a royalty schedule of record, a
 *   recipe with no registered co-brand weightings, a location without a
 *   host operator policy of record, a recipe without a cook-cycle policy
 *   of record, and a location with no registered operator waterfall are
 *   counted skips — the walk never guesses a rate or a weighting.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (foodRowEventId, the ledger namespace riding the
 *   prefix): a re-shipped sheet replays as a counted no-op.
 * - REALIZATION BEFORE THE ROYALTY — the percentage split prices the
 *   row's committed Net Culinary IP Pool (the realized net, never the
 *   gross); a row the realization held (negative net) posts no royalty.
 * - THE ROYALTY POT FEEDS THE CO-BRAND SPLIT — the weighted routing
 *   divides the royalty application of record's committed pot (the unit
 *   payout plus the percentage split), largest-remainder exact; the
 *   application row pins the conservation identity at the database.
 *
 * The five senders' walks:
 *
 *   1. DELIVERY APP ORDER FEEDS (sender 'delivery_app_order') — the Net
 *      Recipe Realization (gross menu item sales − approved ingredient
 *      COGS base − delivery platform engine cut − local food service
 *      taxes = Net Culinary IP Pool), then the tiered recipe royalty
 *      (the per-dish micro-payout band walk plus the percentage split on
 *      the location's cumulative monthly units), then — when the recipe
 *      has registered weightings — the weighted co-branded menu split of
 *      the royalty pot.
 *   2. POS TICKET STREAMS (sender 'pos_ticket') — the host kitchen
 *      operator split: the physical preparation margin routes directly to
 *      the local operator while the brand licensor's percentage cut holds
 *      back.
 *   3. MEAL-KIT PRODUCTION (sender 'meal_kit_production') — the
 *      cook-cycle micro-royalty: per-execution micro-fees at the policy
 *      of record.
 *   4. GROCERY CPG SCANNER LOGS (sender 'grocery_cpg_scan') — the
 *      schedule's CPG royalty rate prices the scanner sales, and the
 *      weighted co-branded menu split routes the pot.
 *   5. SUPPLIER REBATE STATEMENTS (sender 'supplier_rebate') — the
 *      volume kickback routes proportionally to the location's virtual
 *      franchise operators per the waterfall of record.
 *
 * Food rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import {
  parseFoodRoyaltyBpsBands,
  parseFoodUnitBands,
  validateFoodCobrandWeightings,
  validateFoodOperatorWaterfall,
  type FoodCobrandWeightingLeg,
  type FoodOperatorWaterfallLeg,
} from "@/modules/food/records";
import type { ParsedStatementLine, FoodLineDetail } from "./records";
import {
  cobrandWeightedSplitCents,
  cookCycleRoyaltyMicros,
  foodMicrosToCents,
  foodRowEventId,
  hostOperatorSplitCents,
  netRecipeRealizationCents,
  rebateProportionalRoutingCents,
  royaltyBpsForPosition,
  unitTierWalk,
} from "./food";

/** The food lane's per-pass counters — the honest outcome summary. */
export interface FoodWriteCounts {
  /** Realization applications committed / counted replay no-ops / the
   * negative-pool holds (the money pauses, visible). */
  realizationApplicationsWritten: number;
  realizationApplicationsReplayed: number;
  realizationHeldNegativeNet: number;
  /** Recipe royalty applications committed / counted replay no-ops /
   * fail-closed skips (no schedule of record) / negative-net holds. */
  royaltyApplicationsWritten: number;
  royaltyApplicationsReplayed: number;
  royaltySkippedNoSchedule: number;
  royaltyHeldNegativeNet: number;
  /** Co-brand splits committed / counted replay no-ops / fail-closed
   * skips (no registered weightings of record). */
  cobrandSplitsWritten: number;
  cobrandSplitsReplayed: number;
  cobrandSkippedNoWeightings: number;
  /** Host operator splits committed / counted replay no-ops / fail-closed
   * skips (no host operator policy of record for the location). */
  hostOperatorSplitsWritten: number;
  hostOperatorSplitsReplayed: number;
  hostOperatorSkippedNoPolicy: number;
  /** Cook-cycle micro-royalties committed / counted replay no-ops /
   * fail-closed skips (no cook-cycle policy of record). */
  cookCycleRoyaltiesWritten: number;
  cookCycleRoyaltiesReplayed: number;
  cookCycleSkippedNoPolicy: number;
  /** Supplier rebate routings committed / counted replay no-ops /
   * fail-closed skips (no registered operator waterfall). */
  supplierRebatesWritten: number;
  supplierRebatesReplayed: number;
  supplierRebatesSkippedNoWaterfall: number;
  /** The committed money, integer cents. */
  netCulinaryIpPoolCents: number;
  unitPayoutCents: number;
  percentageSplitCents: number;
  cobrandAllocatedCents: number;
  hostOperatorCents: number;
  brandLicensorHoldbackCents: number;
  cookCycleRoyaltyCents: number;
  supplierRebateRoutedCents: number;
}

/**
 * The food lane's one pass over a parsed statement's lines — the six
 * application ledgers (realization, recipe royalties, co-brand splits,
 * host operator splits, cook-cycle royalties, and supplier rebate
 * routings) land in the store's food tables. Throws into the job's
 * fail-closed error path on any store failure.
 */
export async function writeFoodRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<FoodWriteCounts> {
  const counts: FoodWriteCounts = {
    realizationApplicationsWritten: 0,
    realizationApplicationsReplayed: 0,
    realizationHeldNegativeNet: 0,
    royaltyApplicationsWritten: 0,
    royaltyApplicationsReplayed: 0,
    royaltySkippedNoSchedule: 0,
    royaltyHeldNegativeNet: 0,
    cobrandSplitsWritten: 0,
    cobrandSplitsReplayed: 0,
    cobrandSkippedNoWeightings: 0,
    hostOperatorSplitsWritten: 0,
    hostOperatorSplitsReplayed: 0,
    hostOperatorSkippedNoPolicy: 0,
    cookCycleRoyaltiesWritten: 0,
    cookCycleRoyaltiesReplayed: 0,
    cookCycleSkippedNoPolicy: 0,
    supplierRebatesWritten: 0,
    supplierRebatesReplayed: 0,
    supplierRebatesSkippedNoWaterfall: 0,
    netCulinaryIpPoolCents: 0,
    unitPayoutCents: 0,
    percentageSplitCents: 0,
    cobrandAllocatedCents: 0,
    hostOperatorCents: 0,
    brandLicensorHoldbackCents: 0,
    cookCycleRoyaltyCents: 0,
    supplierRebateRoutedCents: 0,
  };

  for (const line of lines) {
    const detail = line.foodDetail;
    // The food profiles always attach the detail; a line without one is a
    // lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`food_detail_missing: line ${line.lineNumber} has no food detail`);
    }

    switch (detail.sender) {
      case "delivery_app_order":
        await walkRealization(store, detail, counts);
        await walkRecipeRoyalty(store, detail, counts);
        await walkDeliveryCobrandSplit(store, detail, counts);
        continue;
      case "pos_ticket":
        await walkHostOperatorSplit(store, detail, counts);
        continue;
      case "meal_kit_production":
        await walkCookCycleRoyalty(store, detail, counts);
        continue;
      case "grocery_cpg_scan":
        await walkCpgScanSplit(store, detail, counts);
        continue;
      case "supplier_rebate":
        await walkSupplierRebate(store, detail, counts);
        continue;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Sender 1 — the Net Recipe Realization: the founder's exact identity on
// the order feed's own figures.
// ---------------------------------------------------------------------------

async function walkRealization(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "delivery_app_order" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("realization", detail);

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getFoodRealizationApplication(sourceEventId);
  if (existing !== undefined) {
    counts.realizationApplicationsReplayed += 1;
    return;
  }

  // THE NET RECIPE REALIZATION — the order feed's own figures (never a
  // rate guess); the identity (COGS + cut + taxes + net === gross) pins
  // the math at the database.
  const realization = netRecipeRealizationCents({
    grossMenuItemSalesCents: detail.grossMenuItemSalesCents,
    approvedIngredientCogsCents: detail.approvedIngredientCogsCents,
    deliveryPlatformEngineCutCents: detail.deliveryPlatformEngineCutCents,
    localFoodServiceTaxesCents: detail.localFoodServiceTaxesCents,
  });

  // A NEGATIVE POOL — the deduction legs exceeded the gross menu item
  // sales. Recorded visible (the held row's truth); the royalty walk
  // prices nothing on a held row.
  const held = realization.netCulinaryIpPoolCents < 0;

  await store.insertFoodRealizationApplication({
    source_event_id: sourceEventId,
    chef_id: detail.chefId,
    recipe_id: detail.recipeId,
    ghost_kitchen_location_id: detail.ghostKitchenLocationId,
    period: detail.period,
    currency: detail.currency,
    gross_menu_item_sales_cents: detail.grossMenuItemSalesCents,
    approved_ingredient_cogs_cents: detail.approvedIngredientCogsCents,
    delivery_platform_engine_cut_cents: detail.deliveryPlatformEngineCutCents,
    local_food_service_taxes_cents: detail.localFoodServiceTaxesCents,
    net_culinary_ip_pool_cents: realization.netCulinaryIpPoolCents,
    verdict: held ? "held_negative_net" : "paid",
  });
  counts.realizationApplicationsWritten += 1;
  // The pool of record includes the held row's negative net — the pass
  // summary shows the truth (the spatial lane's precedent).
  counts.netCulinaryIpPoolCents += realization.netCulinaryIpPoolCents;
  if (held) {
    counts.realizationHeldNegativeNet += 1;
  }
}

// ---------------------------------------------------------------------------
// Sender 1 — the tiered recipe royalty: the per-dish micro-payout band
// walk and the percentage split, both priced on the location's cumulative
// monthly unit position (the founder's 4% scaling to 7% strictly POST the
// 2500-unit threshold).
// ---------------------------------------------------------------------------

async function walkRecipeRoyalty(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "delivery_app_order" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("royalty", detail);

  const existing = await store.getFoodRecipeRoyaltyApplication(sourceEventId);
  if (existing !== undefined) {
    counts.royaltyApplicationsReplayed += 1;
    return;
  }

  // The realization of record — the percentage split prices the row's
  // committed Net Culinary IP Pool. A row the realization walk held
  // (negative net) has no positive pool to price (skip, visible through
  // the realization hold count).
  const realizationApp = await store.getFoodRealizationApplication(
    foodRowEventId("realization", detail),
  );
  if (realizationApp === undefined || realizationApp.verdict !== "paid") {
    return;
  }
  const netBasisCents = realizationApp.net_culinary_ip_pool_cents;

  // The royalty schedule of record — no schedule, no royalty (the walk
  // never guesses a rate).
  const schedule = await store.getFoodRecipeRoyaltySchedule(
    detail.chefId,
    detail.recipeId,
  );
  if (schedule === undefined) {
    counts.royaltySkippedNoSchedule += 1;
    return;
  }
  const unitBands = parseFoodUnitBands(schedule.unit_micros_bands, schedule.id);
  const bpsBands = parseFoodRoyaltyBpsBands(schedule.royalty_bps_bands, schedule.id);

  const month = detail.period;

  // The tracker position BEFORE this row — the cumulative monthly
  // position the walk prices from (the tracking is per location).
  const before = await store.getFoodLocationUnitMonth(
    detail.ghostKitchenLocationId,
    month,
  );
  const cumulativeBefore = before?.cumulative_units ?? 0;

  // THE PER-DISH MICRO-PAYOUT BAND WALK — the row's units split across
  // the bands they occupy on the cumulative position.
  const walk = unitTierWalk({
    units: detail.unitsSold,
    cumulativeBefore,
    bands: unitBands,
  });
  const unitPayoutCents = foodMicrosToCents(walk.payoutMicros);

  // THE PERCENTAGE SPLIT — the band holding the row's CLOSING position
  // prices the row's net-basis share (the scaled rate applies strictly
  // POST the threshold).
  const royaltyBps = royaltyBpsForPosition(walk.cumulativeAfter, bpsBands);
  const percentageSplitCents =
    royaltyBps === undefined ? 0 : Math.floor((netBasisCents * royaltyBps) / 10_000);

  // The tracker advance — the paid row's units join the cumulative
  // monthly position.
  const after = await store.advanceFoodLocationUnitMonth(
    detail.ghostKitchenLocationId,
    month,
    detail.unitsSold,
  );

  await store.insertFoodRecipeRoyaltyApplication({
    source_event_id: sourceEventId,
    sender: "delivery_app_order",
    chef_id: detail.chefId,
    recipe_id: detail.recipeId,
    ghost_kitchen_location_id: detail.ghostKitchenLocationId,
    period: detail.period,
    currency: detail.currency,
    platform: detail.platform,
    units_sold: detail.unitsSold,
    net_basis_cents: netBasisCents,
    schedule_ref: schedule.id,
    unit_walk_legs: JSON.stringify(walk.legs),
    unit_payout_micros: Number(walk.payoutMicros),
    unit_payout_cents: unitPayoutCents,
    royalty_bps: royaltyBps ?? 0,
    percentage_split_cents: percentageSplitCents,
    units_before: cumulativeBefore,
    units_after: after.cumulative_units,
    verdict: "paid",
  });
  counts.royaltyApplicationsWritten += 1;
  counts.unitPayoutCents += unitPayoutCents;
  counts.percentageSplitCents += percentageSplitCents;
}

// ---------------------------------------------------------------------------
// Sender 1 — the weighted co-branded menu split: the royalty application
// of record's pot routes per the recipe's ingredient and brand weightings
// (largest-remainder exact).
// ---------------------------------------------------------------------------

async function walkDeliveryCobrandSplit(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "delivery_app_order" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("cobrand", detail);

  const existing = await store.getFoodCobrandSplitApplication(sourceEventId);
  if (existing !== undefined) {
    counts.cobrandSplitsReplayed += 1;
    return;
  }

  // The royalty walk of record — the split prices the committed royalty
  // pot. A row the royalty walk skipped (no schedule) or that priced no
  // royalty has no pot to split (silently nothing — the skip is the
  // royalty walk's counted outcome).
  const royaltyApp = await store.getFoodRecipeRoyaltyApplication(
    foodRowEventId("royalty", detail),
  );
  if (royaltyApp === undefined) {
    return;
  }
  const royaltyPotCents = royaltyApp.unit_payout_cents + royaltyApp.percentage_split_cents;
  if (royaltyPotCents <= 0) {
    return;
  }

  await walkCobrandSplit(store, detail, sourceEventId, royaltyPotCents, counts);
}

/** The shared co-brand routing — delivery royalties and CPG scanner
 * royalties both route their pots through the recipe's weightings of
 * record. */
async function walkCobrandSplit(
  store: Store,
  detail: Extract<
    FoodLineDetail,
    { sender: "delivery_app_order" | "grocery_cpg_scan" }
  >,
  sourceEventId: string,
  royaltyPotCents: number,
  counts: FoodWriteCounts,
): Promise<void> {
  // The weightings of record — no registered weightings, no split (a
  // recipe without a registered co-brand split routes nothing).
  const weightingRecords = await store.listFoodCobrandWeightings(detail.recipeId);
  if (weightingRecords.length === 0) {
    counts.cobrandSkippedNoWeightings += 1;
    return;
  }
  const legs: FoodCobrandWeightingLeg[] = weightingRecords.map((record) => ({
    leg_id: record.leg_id,
    payee_id: record.payee_id,
    payee_role: record.payee_role,
    weight_bps: record.weight_bps,
  }));

  // The weighting of record — re-validated at read (an unvalidated
  // weighting skips fail-closed; the split never guesses a weighting).
  const weighting = validateFoodCobrandWeightings(legs);
  if (!weighting.ok) {
    counts.cobrandSkippedNoWeightings += 1;
    return;
  }

  // THE WEIGHTED CO-BRAND SPLIT — largest-remainder exact; the legs'
  // allocated shares conserve the pot exactly.
  const split = cobrandWeightedSplitCents({
    royaltyPotCents,
    legs,
  });

  await store.insertFoodCobrandSplitApplication({
    source_event_id: sourceEventId,
    chef_id: detail.chefId,
    recipe_id: detail.recipeId,
    ghost_kitchen_location_id: detail.ghostKitchenLocationId,
    period: detail.period,
    currency: detail.currency,
    royalty_pot_cents: royaltyPotCents,
    weighting_legs: JSON.stringify(split.legs),
    allocated_total_cents: split.allocatedTotalCents,
  });
  counts.cobrandSplitsWritten += 1;
  counts.cobrandAllocatedCents += split.allocatedTotalCents;
}

// ---------------------------------------------------------------------------
// Sender 2 — the host kitchen operator split: the physical preparation
// margin routes directly to the local operator while the brand licensor's
// percentage cut holds back.
// ---------------------------------------------------------------------------

async function walkHostOperatorSplit(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "pos_ticket" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("host", detail);

  const existing = await store.getFoodHostOperatorSplitApplication(sourceEventId);
  if (existing !== undefined) {
    counts.hostOperatorSplitsReplayed += 1;
    return;
  }

  // The host operator policy of record — no policy, no split (the walk
  // never guesses a holdback).
  const policy = await store.getFoodHostOperatorPolicy(detail.ghostKitchenLocationId);
  if (policy === undefined) {
    counts.hostOperatorSkippedNoPolicy += 1;
    return;
  }

  // THE HOST OPERATOR SPLIT — the margin conserves exactly (the
  // ordering the application row pins: the margin routes DIRECTLY to the
  // local operator; the licensor's cut holds back).
  const split = hostOperatorSplitCents({
    physicalPreparationMarginCents: detail.physicalPreparationMarginCents,
    brandLicensorHoldbackBps: policy.brand_licensor_holdback_bps,
  });

  await store.insertFoodHostOperatorSplitApplication({
    source_event_id: sourceEventId,
    chef_id: detail.chefId,
    recipe_id: detail.recipeId,
    ghost_kitchen_location_id: detail.ghostKitchenLocationId,
    period: detail.period,
    currency: detail.currency,
    platform: detail.platform,
    tickets: detail.tickets,
    physical_preparation_margin_cents: detail.physicalPreparationMarginCents,
    brand_licensor_id: policy.brand_licensor_id,
    brand_licensor_holdback_bps: policy.brand_licensor_holdback_bps,
    brand_licensor_holdback_cents: split.brandLicensorHoldbackCents,
    host_operator_cents: split.hostOperatorCents,
  });
  counts.hostOperatorSplitsWritten += 1;
  counts.hostOperatorCents += split.hostOperatorCents;
  counts.brandLicensorHoldbackCents += split.brandLicensorHoldbackCents;
}

// ---------------------------------------------------------------------------
// Sender 3 — the cook-cycle micro-royalty: per-execution micro-fees at
// the policy of record.
// ---------------------------------------------------------------------------

async function walkCookCycleRoyalty(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "meal_kit_production" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("cookcycle", detail);

  const existing = await store.getFoodCookCycleRoyalty(sourceEventId);
  if (existing !== undefined) {
    counts.cookCycleRoyaltiesReplayed += 1;
    return;
  }

  // The cook-cycle policy of record — no policy, no micro-royalty (the
  // walk never guesses a rate; the route to the master chef or food
  // brand developer is the policy's payee identity).
  const policy = await store.getFoodCookCyclePolicy(detail.chefId, detail.recipeId);
  if (policy === undefined) {
    counts.cookCycleSkippedNoPolicy += 1;
    return;
  }

  // THE COOK-CYCLE MICRO-ROYALTY — per-execution exact, bigint micros
  // floored into payable cents.
  const royalty = cookCycleRoyaltyMicros({
    cookCycles: detail.cookCyclesExecuted,
    microsPerCookCycle: policy.micros_per_cook_cycle,
  });
  const royaltyCents = foodMicrosToCents(royalty.royaltyMicros);

  await store.insertFoodCookCycleRoyalty({
    source_event_id: sourceEventId,
    chef_id: detail.chefId,
    recipe_id: detail.recipeId,
    ghost_kitchen_location_id: detail.ghostKitchenLocationId,
    period: detail.period,
    currency: detail.currency,
    meal_kits_produced: detail.mealKitsProduced,
    cook_cycles_executed: detail.cookCyclesExecuted,
    payee_id: policy.payee_id,
    micros_per_cook_cycle: policy.micros_per_cook_cycle,
    royalty_micros: Number(royalty.royaltyMicros),
    royalty_cents: royaltyCents,
  });
  counts.cookCycleRoyaltiesWritten += 1;
  counts.cookCycleRoyaltyCents += royaltyCents;
}

// ---------------------------------------------------------------------------
// Sender 4 — the grocery CPG scanner royalty: the schedule's CPG rate
// prices the scanner sales, and the weighted co-brand split routes the
// pot.
// ---------------------------------------------------------------------------

async function walkCpgScanSplit(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "grocery_cpg_scan" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("cobrand", detail);

  const existing = await store.getFoodCobrandSplitApplication(sourceEventId);
  if (existing !== undefined) {
    counts.cobrandSplitsReplayed += 1;
    return;
  }

  // The royalty schedule of record — no schedule, no scanner royalty
  // (the walk never guesses a rate).
  const schedule = await store.getFoodRecipeRoyaltySchedule(
    detail.chefId,
    detail.recipeId,
  );
  if (schedule === undefined) {
    counts.cobrandSkippedNoWeightings += 1;
    return;
  }
  if (schedule.cpg_royalty_bps <= 0) {
    // A zero-rate schedule is the operator's explicit "no scanner
    // royalty" statement — the split's pot is zero and nothing routes.
    return;
  }

  const royaltyPotCents = Math.floor(
    (detail.grossScannerSalesCents * schedule.cpg_royalty_bps) / 10_000,
  );
  if (royaltyPotCents <= 0) {
    return;
  }

  await walkCobrandSplit(store, detail, sourceEventId, royaltyPotCents, counts);
}

// ---------------------------------------------------------------------------
// Sender 5 — the supplier rebate routing: the volume kickback routes
// proportionally to the location's virtual franchise operators per the
// waterfall of record.
// ---------------------------------------------------------------------------

async function walkSupplierRebate(
  store: Store,
  detail: Extract<FoodLineDetail, { sender: "supplier_rebate" }>,
  counts: FoodWriteCounts,
): Promise<void> {
  const sourceEventId = foodRowEventId("rebate", detail);

  const existing = await store.getFoodSupplierRebateApplication(sourceEventId);
  if (existing !== undefined) {
    counts.supplierRebatesReplayed += 1;
    return;
  }

  // The operator waterfall of record — no registered waterfall, no
  // routing (a location without operators routes nothing).
  const waterfallRecords = await store.listFoodOperatorWaterfallLegs(
    detail.ghostKitchenLocationId,
  );
  if (waterfallRecords.length === 0) {
    counts.supplierRebatesSkippedNoWaterfall += 1;
    return;
  }
  const legs: FoodOperatorWaterfallLeg[] = waterfallRecords.map((record) => ({
    operator_id: record.operator_id,
    weight_bps: record.weight_bps,
  }));

  // The waterfall of record — re-validated at read (an unvalidated
  // waterfall skips fail-closed; the routing never guesses a share).
  const waterfall = validateFoodOperatorWaterfall(legs);
  if (!waterfall.ok) {
    counts.supplierRebatesSkippedNoWaterfall += 1;
    return;
  }

  // THE PROPORTIONAL ROUTING — largest-remainder exact; the legs' routed
  // shares conserve the rebate exactly.
  const routing = rebateProportionalRoutingCents({
    volumeRebateCents: detail.volumeRebateCents,
    legs,
  });

  await store.insertFoodSupplierRebateApplication({
    source_event_id: sourceEventId,
    supplier: detail.supplier,
    ghost_kitchen_location_id: detail.ghostKitchenLocationId,
    period: detail.period,
    currency: detail.currency,
    rebate_basis_cents: detail.rebateBasisCents,
    volume_rebate_cents: detail.volumeRebateCents,
    routing_legs: JSON.stringify(routing.legs),
    routed_total_cents: routing.routedTotalCents,
  });
  counts.supplierRebatesWritten += 1;
  counts.supplierRebateRoutedCents += routing.routedTotalCents;
}
