/**
 * The food revenue record vocabulary (PR 40, migration 0044) — the founder
 * food directive's durable facts of record:
 *
 *   food_recipe_royalty_schedules    — the recipe royalty terms of record
 *                                      per (chef, recipe): the per-dish
 *                                      micro-payout bands, the percentage
 *                                      split bands (the founder's 4% base
 *                                      scaling to 7% once the location's
 *                                      monthly units pass the threshold),
 *                                      and the grocery CPG scanner royalty
 *                                      rate.
 *   food_location_unit_months        — the cumulative monthly unit tracker
 *                                      of record per (ghost kitchen
 *                                      location, month): the tier walk's
 *                                      position.
 *   food_host_operator_policies      — the host kitchen operator split's
 *                                      terms of record per location: the
 *                                      brand licensor payee and the
 *                                      holdback percentage cut.
 *   food_cook_cycle_policies         — the cook-cycle micro-fee of record
 *                                      per (chef, recipe): the master chef
 *                                      or food brand developer payee and
 *                                      the per-execution micro-fee.
 *   food_cobrand_weightings          — the co-branded menu split's
 *                                      ingredient and brand weighting legs
 *                                      of record per (recipe, leg).
 *   food_operator_waterfalls         — the virtual franchise operator
 *                                      routing legs of record per
 *                                      (location, operator): the supplier
 *                                      rebate routing's proportions.
 *   food_realization_applications    — the append-only Net Recipe
 *                                      Realization per delivery order
 *                                      event.
 *   food_recipe_royalty_applications — the append-only tiered recipe
 *                                      royalty per delivery order event.
 *   food_cobrand_split_applications  — the append-only weighted co-branded
 *                                      menu split per royalty event.
 *   food_host_operator_split_applications — the append-only host kitchen
 *                                      operator split per POS ticket
 *                                      event.
 *   food_cook_cycle_royalty_ledger   — the append-only per-execution
 *                                      micro-royalty per production batch.
 *   food_supplier_rebate_applications — the append-only proportional
 *                                      rebate routing per rebate event.
 *
 * Money is integer cents throughout; per-unit and per-execution royalty
 * rates are statement micros (1 dollar = 1e8 micros) so sub-cent per-unit
 * pricing stays exact. Rates are basis points where they price a share of
 * a money basis. No foreign keys by design — the tables key on
 * content-derived event ids, the feed's chef/recipe/location identifiers,
 * and reporting months (the 0036–0043 discipline).
 */

// ---------------------------------------------------------------------------
// Royalty bands — the per-dish micro-payout and percentage-split schedules.
// ---------------------------------------------------------------------------

/** One per-dish micro-payout band. `up_to` is the band's exclusive upper
 * bound ON THE LOCATION'S CUMULATIVE MONTHLY UNIT POSITION — null marks
 * the open top band. Exactly one band per schedule carries `up_to: null`,
 * and it is the LAST band. */
export type FoodUnitBand = {
  readonly up_to: number | null;
  /** The band's per-dish payout, statement micros (1 dollar = 1e8). */
  readonly micros_per_unit: number;
};

/**
 * Validates a schedule's per-dish micro-payout bands at registration —
 * bands in ascending order with strictly increasing bounds, the first
 * bound past zero, exactly one terminal open band (last), and every rate a
 * positive integer micros amount. A schedule that fails any clause is a
 * hostile registration, refused (the walk never guesses a rate).
 */
export function validateFoodUnitBands(
  bands: readonly FoodUnitBand[],
): { ok: true } | { ok: false; reason: string } {
  if (bands.length === 0) return { ok: false, reason: "empty_schedule" };
  let previousBound = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as FoodUnitBand;
    if (!Number.isInteger(band.micros_per_unit) || band.micros_per_unit <= 0) {
      return { ok: false, reason: `band_${index}:micros_per_unit_out_of_range` };
    }
    if (band.up_to === null) {
      if (index !== bands.length - 1) {
        return { ok: false, reason: `band_${index}:open_band_not_last` };
      }
      continue;
    }
    if (!Number.isInteger(band.up_to) || band.up_to <= previousBound) {
      return { ok: false, reason: `band_${index}:bound_not_increasing` };
    }
    previousBound = band.up_to;
  }
  const last = bands[bands.length - 1] as FoodUnitBand;
  if (last.up_to !== null) return { ok: false, reason: "no_open_top_band" };
  return { ok: true };
}

/** One percentage-split band. Same window shape as the unit bands —
 * `up_to` bounds the location's cumulative monthly unit position, null
 * marks the open top band (exactly one, last). The founder's example
 * shape: the first 2500 monthly location units at 400 bps (4%), everything
 * after at 700 bps (7%) — the scaled rate applies strictly POST 2500. */
export type FoodRoyaltyBpsBand = {
  readonly up_to: number | null;
  /** The band's royalty percentage, bps of the row's net basis. */
  readonly royalty_bps: number;
};

/** Validates a schedule's percentage-split bands — the same shape clauses
 * as the unit bands, every rate a positive integer bps 1–10000. */
export function validateFoodRoyaltyBpsBands(
  bands: readonly FoodRoyaltyBpsBand[],
): { ok: true } | { ok: false; reason: string } {
  if (bands.length === 0) return { ok: false, reason: "empty_schedule" };
  let previousBound = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as FoodRoyaltyBpsBand;
    if (
      !Number.isInteger(band.royalty_bps) ||
      band.royalty_bps <= 0 ||
      band.royalty_bps > 10_000
    ) {
      return { ok: false, reason: `band_${index}:royalty_bps_out_of_range` };
    }
    if (band.up_to === null) {
      if (index !== bands.length - 1) {
        return { ok: false, reason: `band_${index}:open_band_not_last` };
      }
      continue;
    }
    if (!Number.isInteger(band.up_to) || band.up_to <= previousBound) {
      return { ok: false, reason: `band_${index}:bound_not_increasing` };
    }
    previousBound = band.up_to;
  }
  const last = bands[bands.length - 1] as FoodRoyaltyBpsBand;
  if (last.up_to !== null) return { ok: false, reason: "no_open_top_band" };
  return { ok: true };
}

/** Re-validates a stored schedule at walk time — a corrupt or mutated
 * schedule is a fail-closed refusal, never a guessed walk (the fitness
 * schedule discipline). */
export function parseFoodUnitBands(
  bandsJson: string,
  scheduleRef: string,
): readonly FoodUnitBand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bandsJson);
  } catch (error) {
    throw new Error(
      `food_unit_bands_corrupt: ${scheduleRef} schedule is not valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`food_unit_bands_invalid: ${scheduleRef} — not an array`);
  }
  for (const band of parsed) {
    if (typeof band !== "object" || band === null) {
      throw new Error(`food_unit_bands_invalid: ${scheduleRef} — non-object band`);
    }
  }
  const bands = parsed as FoodUnitBand[];
  const outcome = validateFoodUnitBands(bands);
  if (!outcome.ok) {
    throw new Error(`food_unit_bands_invalid: ${scheduleRef} — ${outcome.reason}`);
  }
  return bands;
}

/** Re-validates a stored percentage-split schedule at walk time. */
export function parseFoodRoyaltyBpsBands(
  bandsJson: string,
  scheduleRef: string,
): readonly FoodRoyaltyBpsBand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bandsJson);
  } catch (error) {
    throw new Error(
      `food_royalty_bps_bands_corrupt: ${scheduleRef} schedule is not valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`food_royalty_bps_bands_invalid: ${scheduleRef} — not an array`);
  }
  for (const band of parsed) {
    if (typeof band !== "object" || band === null) {
      throw new Error(
        `food_royalty_bps_bands_invalid: ${scheduleRef} — non-object band`,
      );
    }
  }
  const bands = parsed as FoodRoyaltyBpsBand[];
  const outcome = validateFoodRoyaltyBpsBands(bands);
  if (!outcome.ok) {
    throw new Error(
      `food_royalty_bps_bands_invalid: ${scheduleRef} — ${outcome.reason}`,
    );
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Weighted splits — the co-brand weightings and the operator waterfalls.
// ---------------------------------------------------------------------------

/** The payee roles a co-branded menu split's weighting legs carry — the
 * chef of record and the ingredient brand payees. */
export type FoodCobrandLegRole = "chef" | "ingredient_brand";

/** One weighting leg of a co-branded menu split of record: the leg's payee
 * and its weighting of the recipe royalty pot, bps. The registered legs'
 * weights sum to exactly 10000 (validated at walk time — the walk never
 * normalizes an unvalidated split). */
export type FoodCobrandWeightingLeg = {
  readonly leg_id: string;
  readonly payee_id: string;
  readonly payee_role: FoodCobrandLegRole;
  readonly weight_bps: number;
};

/**
 * Validates a recipe's co-brand weighting legs at walk time — at least one
 * leg, unique leg ids, every payee present, every weight a positive
 * integer bps, and the weights summing to exactly 10000 bps. A weighting
 * that fails any clause is a fail-closed refusal (the split never guesses
 * a weighting).
 */
export function validateFoodCobrandWeightings(
  legs: readonly FoodCobrandWeightingLeg[],
): { ok: true } | { ok: false; reason: string } {
  if (legs.length === 0) return { ok: false, reason: "empty_weightings" };
  const seen = new Set<string>();
  let weightSum = 0;
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index] as FoodCobrandWeightingLeg;
    if (leg.leg_id === "") {
      return { ok: false, reason: `leg_${index}:id_empty` };
    }
    if (seen.has(leg.leg_id)) {
      return { ok: false, reason: `leg_${index}:duplicate_id` };
    }
    seen.add(leg.leg_id);
    if (leg.payee_id === "") {
      return { ok: false, reason: `leg_${index}:payee_empty` };
    }
    if (leg.payee_role !== "chef" && leg.payee_role !== "ingredient_brand") {
      return { ok: false, reason: `leg_${index}:role_out_of_vocabulary` };
    }
    if (!Number.isInteger(leg.weight_bps) || leg.weight_bps <= 0 || leg.weight_bps > 10_000) {
      return { ok: false, reason: `leg_${index}:weight_bps_out_of_range` };
    }
    weightSum += leg.weight_bps;
  }
  if (weightSum !== 10_000) {
    return { ok: false, reason: "weights_do_not_sum_to_10000" };
  }
  return { ok: true };
}

/** One routing leg of a location's virtual franchise operator waterfall of
 * record: the operator payee and its proportional share, bps. The
 * registered legs' weights sum to exactly 10000 (validated at walk time). */
export type FoodOperatorWaterfallLeg = {
  readonly operator_id: string;
  readonly weight_bps: number;
};

/**
 * Validates a location's operator waterfall at walk time — at least one
 * leg, unique operator ids, every weight a positive integer bps, and the
 * weights summing to exactly 10000 bps.
 */
export function validateFoodOperatorWaterfall(
  legs: readonly FoodOperatorWaterfallLeg[],
): { ok: true } | { ok: false; reason: string } {
  if (legs.length === 0) return { ok: false, reason: "empty_waterfall" };
  const seen = new Set<string>();
  let weightSum = 0;
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index] as FoodOperatorWaterfallLeg;
    if (leg.operator_id === "") {
      return { ok: false, reason: `leg_${index}:operator_empty` };
    }
    if (seen.has(leg.operator_id)) {
      return { ok: false, reason: `leg_${index}:duplicate_operator` };
    }
    seen.add(leg.operator_id);
    if (!Number.isInteger(leg.weight_bps) || leg.weight_bps <= 0 || leg.weight_bps > 10_000) {
      return { ok: false, reason: `leg_${index}:weight_bps_out_of_range` };
    }
    weightSum += leg.weight_bps;
  }
  if (weightSum !== 10_000) {
    return { ok: false, reason: "weights_do_not_sum_to_10000" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------

/** The food lane's application verdict of record. `paid` — every policy of
 * record was present and the money walked; `held_negative_net` — the
 * deduction legs exceeded the gross (the math is recorded visible; no
 * royalty posts). */
export type FoodApplicationVerdict = "paid" | "held_negative_net";

/** The recipe royalty terms of record per (chef, recipe) — the per-dish
 * micro-payout bands, the percentage-split bands, and the grocery CPG
 * scanner royalty rate. */
export type FoodRecipeRoyaltyScheduleRecord = {
  id: string;
  chef_id: string;
  recipe_id: string;
  /** The per-dish micro-payout bands — JSON-encoded FoodUnitBand[]. */
  unit_micros_bands: string;
  /** The percentage-split bands — JSON-encoded FoodRoyaltyBpsBand[]. */
  royalty_bps_bands: string;
  /** The grocery CPG scanner royalty, bps of the scan's gross sales
   * (0 = the schedule pays no CPG scanner royalty). */
  cpg_royalty_bps: number;
  created_at: string;
  updated_at: string;
};

/** The cumulative monthly unit tracker of record per (ghost kitchen
 * location, month) — the tier walk's position, advanced by every
 * unit-bearing row at the location. */
export type FoodLocationUnitMonthRecord = {
  id: string;
  ghost_kitchen_location_id: string;
  /** The reporting month of record (YYYY-MM) — the tracking is monthly. */
  month: string;
  cumulative_units: number;
  created_at: string;
  updated_at: string;
};

/** The host kitchen operator split's terms of record per ghost kitchen
 * location — the brand licensor payee and the percentage cut held back
 * from the physical preparation margin (the residual routes to the local
 * operator). */
export type FoodHostOperatorPolicyRecord = {
  id: string;
  ghost_kitchen_location_id: string;
  /** The brand licensor's payee identity of record. */
  brand_licensor_id: string;
  /** The licensor's percentage cut, bps of the physical preparation
   * margin. */
  brand_licensor_holdback_bps: number;
  created_at: string;
  updated_at: string;
};

/** The cook-cycle micro-fee of record per (chef, recipe) — the master
 * chef or food brand developer payee and the per-execution micro-fee
 * (statement micros per cook cycle). */
export type FoodCookCyclePolicyRecord = {
  id: string;
  chef_id: string;
  recipe_id: string;
  payee_id: string;
  micros_per_cook_cycle: number;
  created_at: string;
  updated_at: string;
};

/** One weighting leg of a recipe's co-branded menu split of record. */
export type FoodCobrandWeightingRecord = {
  id: string;
  recipe_id: string;
  leg_id: string;
  payee_id: string;
  payee_role: FoodCobrandLegRole;
  weight_bps: number;
  created_at: string;
  updated_at: string;
};

/** One routing leg of a location's virtual franchise operator waterfall of
 * record — the supplier rebate routing's proportions. */
export type FoodOperatorWaterfallRecord = {
  id: string;
  ghost_kitchen_location_id: string;
  operator_id: string;
  weight_bps: number;
  created_at: string;
  updated_at: string;
};

/** The per-event Net Recipe Realization of record — the founder's exact
 * identity keyed on the chef_id, recipe_id, and ghost_kitchen_location_id
 * columns:
 *
 *   Net Culinary IP Pool =
 *     gross menu item sales
 *     − approved ingredient COGS base
 *     − delivery platform engine cut
 *     − local food service taxes
 */
export type FoodRealizationApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  chef_id: string;
  recipe_id: string;
  ghost_kitchen_location_id: string;
  period: string;
  currency: string;
  gross_menu_item_sales_cents: number;
  approved_ingredient_cogs_cents: number;
  delivery_platform_engine_cut_cents: number;
  local_food_service_taxes_cents: number;
  /** gross − COGS − engine cut − taxes — the identity pinned in a CHECK. */
  net_culinary_ip_pool_cents: number;
  verdict: FoodApplicationVerdict;
  created_at: string;
};

/** One unit tier walk leg — the recipe royalty application's committed
 * per-dish band math (per-unit pricing: bigint-exact micros, no remainder
 * allocation). */
export type FoodUnitWalkLeg = {
  /** The band's exclusive lower bound on the monthly unit position. */
  readonly band_from: number;
  /** The band's exclusive upper bound (null = the open top band). */
  readonly band_to: number | null;
  readonly micros_per_unit: number;
  /** The row's units this band held. */
  readonly band_units: number;
  /** band_units × micros_per_unit, exact micros. */
  readonly band_payout_micros: number;
};

/** The per-event tiered recipe royalty of record — the per-dish micro-
 * payout band walk and the percentage split, both priced on the
 * location's cumulative monthly unit position (the founder's 4% scaling
 * to 7% strictly POST the threshold). */
export type FoodRecipeRoyaltyApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The sender family whose sheet the row walked. */
  sender: "delivery_app_order";
  chef_id: string;
  recipe_id: string;
  ghost_kitchen_location_id: string;
  period: string;
  currency: string;
  /** The delivery platform whose order feed the row came from. */
  platform: "doordash" | "ubereats" | "grubhub";
  /** The row's units of record. */
  units_sold: number;
  /** The row's realized net basis the percentage split prices. */
  net_basis_cents: number;
  schedule_ref: string | null;
  /** The committed unit tier walk — JSON-encoded FoodUnitWalkLeg[]. */
  unit_walk_legs: string;
  unit_payout_micros: number;
  unit_payout_cents: number;
  /** The percentage split's applied rate and floored amount. */
  royalty_bps: number;
  percentage_split_cents: number;
  /** The location-month tracker position before/after this row (null when
   * held — held rows advance nothing). */
  units_before: number | null;
  units_after: number | null;
  verdict: FoodApplicationVerdict;
  created_at: string;
};

/** One weighted split leg — the co-branded menu split's committed routing
 * (largest-remainder exact). */
export type FoodCobrandSplitLeg = {
  readonly leg_id: string;
  readonly payee_id: string;
  readonly payee_role: FoodCobrandLegRole;
  readonly weight_bps: number;
  /** The leg's allocated share, integer cents. */
  readonly allocated_cents: number;
};

/** The per-event weighted co-branded menu split of record — the recipe
 * royalty pot (a delivery order's walked royalty, or a grocery CPG scan's
 * priced scanner royalty) routed per the ingredient and brand weightings
 * of record. */
export type FoodCobrandSplitApplicationRecord = {
  id: string;
  source_event_id: string;
  chef_id: string;
  recipe_id: string;
  ghost_kitchen_location_id: string;
  period: string;
  currency: string;
  /** The royalty pot of record the weighting legs routed. */
  royalty_pot_cents: number;
  /** The committed routing — JSON-encoded FoodCobrandSplitLeg[]. */
  weighting_legs: string;
  /** The legs' allocated shares conserve the pot exactly (pinned). */
  allocated_total_cents: number;
  created_at: string;
};

/** The per-event host kitchen operator split of record — the physical
 * preparation margin routed to the local operator while the brand
 * licensor's percentage cut holds back (the ordering pinned in a CHECK). */
export type FoodHostOperatorSplitApplicationRecord = {
  id: string;
  source_event_id: string;
  chef_id: string;
  recipe_id: string;
  ghost_kitchen_location_id: string;
  period: string;
  currency: string;
  /** The POS platform whose ticket stream the row came from. */
  platform: "toast" | "square";
  tickets: number;
  physical_preparation_margin_cents: number;
  brand_licensor_id: string;
  brand_licensor_holdback_bps: number;
  /** floor(margin × bps / 10000). */
  brand_licensor_holdback_cents: number;
  /** margin − holdback — the local operator's route of record. */
  host_operator_cents: number;
  created_at: string;
};

/** The per-event cook-cycle micro-royalty of record — the per-execution
 * micro-fee routed to the master chef or food brand developer every time
 * a robotic kitchen or connected oven executes the branded cooking
 * profile. */
export type FoodCookCycleRoyaltyRecord = {
  id: string;
  source_event_id: string;
  chef_id: string;
  recipe_id: string;
  ghost_kitchen_location_id: string;
  period: string;
  currency: string;
  meal_kits_produced: number;
  cook_cycles_executed: number;
  payee_id: string;
  micros_per_cook_cycle: number;
  /** cook_cycles × rate, exact micros. */
  royalty_micros: number;
  royalty_cents: number;
  created_at: string;
};

/** One proportional routing leg — the supplier rebate application's
 * committed operator share (largest-remainder exact). */
export type FoodRebateRoutingLeg = {
  readonly operator_id: string;
  readonly weight_bps: number;
  /** The leg's allocated share, integer cents. */
  readonly routed_cents: number;
};

/** The per-event supplier rebate routing of record — the bulk food
 * supplier's volume kickback (Sysco, US Foods) passed proportionally back
 * to the location's virtual franchise operators. */
export type FoodSupplierRebateApplicationRecord = {
  id: string;
  source_event_id: string;
  /** The bulk food supplier whose rebate program the row reports. */
  supplier: "sysco" | "us_foods";
  ghost_kitchen_location_id: string;
  period: string;
  currency: string;
  /** The rebate program's purchase basis of record. */
  rebate_basis_cents: number;
  /** The volume kickback of record — the routing's pot. */
  volume_rebate_cents: number;
  /** The committed routing — JSON-encoded FoodRebateRoutingLeg[]. */
  routing_legs: string;
  /** The legs' routed shares conserve the rebate exactly (pinned). */
  routed_total_cents: number;
  created_at: string;
};
