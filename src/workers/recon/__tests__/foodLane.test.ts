/**
 * The food lane's worker-path test (PR 40, the founder food directive) —
 * the full pass over the five senders' sheets through the real dispatch
 * (profiles) and the real store walk (foodQueue) on the in-memory
 * backend: the exact founder math (the Net Recipe Realization identity,
 * the royalty tier boundary at 2500 monthly units with cumulative
 * per-location tracking, the host operator split with the brand licensor
 * holdback, the weighted co-branded menu splits, the per-execution
 * cook-cycle micro-fees, and the supplier rebate proportional routing),
 * the replay no-ops, and the fail-closed skips.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dispatchStatementProfile } from "../profiles";
import {
  cookCycleRoyaltyMicros,
  cobrandWeightedSplitCents,
  foodRowEventId,
  hostOperatorSplitCents,
  netRecipeRealizationCents,
  rebateProportionalRoutingCents,
  royaltyBpsForPosition,
  unitTierWalk,
  weightedSplitCents,
} from "../food";
import { writeFoodRowsToStore } from "../foodQueue";
import type { FoodRoyaltyBpsBand, FoodUnitBand } from "@/modules/food/records";
import type { ParsedStatementLine } from "../records";
import { loadFixture } from "./fixtures";

/** Dispatches and parses one raw CSV through the pinned registry (the
 * worker's own two-step). */
function parseCsv(content: string): readonly ParsedStatementLine[] {
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error("content matched no profile");
  return profile.parse(content);
}

const CHEF = "chef-massimo";
const RECIPE = "rec-truffle-burger";

/** The founder's example tiers — 4% base royalty scaling to 7% once the
 * location's monthly units pass 2500, with the per-dish micro-payout
 * stepping from $0.30 to $0.45 at the same boundary (statement micros:
 * $1 = 1e8). */
const UNIT_BANDS: readonly FoodUnitBand[] = [
  { up_to: 2500, micros_per_unit: 30_000_000 },
  { up_to: null, micros_per_unit: 45_000_000 },
];
const ROYALTY_BANDS: readonly FoodRoyaltyBpsBand[] = [
  { up_to: 2500, royalty_bps: 400 },
  { up_to: null, royalty_bps: 700 },
];

/** Registers every policy of record the lane's walks read. */
function registerPolicies(store: InMemoryStore): void {
  store.upsertFoodRecipeRoyaltySchedule({
    chef_id: CHEF,
    recipe_id: RECIPE,
    unit_micros_bands: JSON.stringify(UNIT_BANDS),
    royalty_bps_bands: JSON.stringify(ROYALTY_BANDS),
    cpg_royalty_bps: 0,
  });
  store.upsertFoodRecipeRoyaltySchedule({
    chef_id: "chef-aria",
    recipe_id: "rec-hot-honey",
    unit_micros_bands: JSON.stringify([
      { up_to: null, micros_per_unit: 1_000_000 },
    ]),
    royalty_bps_bands: JSON.stringify([
      { up_to: null, royalty_bps: 200 },
    ]),
    cpg_royalty_bps: 500,
  });
  store.upsertFoodRecipeRoyaltySchedule({
    chef_id: "chef-zed",
    recipe_id: "rec-zero-cpg",
    unit_micros_bands: JSON.stringify([
      { up_to: null, micros_per_unit: 1_000_000 },
    ]),
    royalty_bps_bands: JSON.stringify([
      { up_to: null, royalty_bps: 100 },
    ]),
    cpg_royalty_bps: 0,
  });
  // The truffle burger's co-brand: the celebrity chef and the truffle
  // brand split every royalty pot 70/30.
  for (const leg of [
    { leg_id: "chef-leg", payee_id: CHEF, payee_role: "chef" as const, weight_bps: 7000 },
    {
      leg_id: "brand-leg",
      payee_id: "brand-truffleco",
      payee_role: "ingredient_brand" as const,
      weight_bps: 3000,
    },
  ]) {
    store.upsertFoodCobrandWeighting({ recipe_id: RECIPE, ...leg });
  }
  // The hot honey's co-brand: chef Aria and the hot sauce brand.
  for (const leg of [
    { leg_id: "chef-leg", payee_id: "chef-aria", payee_role: "chef" as const, weight_bps: 7000 },
    {
      leg_id: "brand-leg",
      payee_id: "brand-scorchio",
      payee_role: "ingredient_brand" as const,
      weight_bps: 3000,
    },
  ]) {
    store.upsertFoodCobrandWeighting({ recipe_id: "rec-hot-honey", ...leg });
  }
  // The Austin ghost kitchen's host operator terms: the brand licensor
  // holds back 15% of every physical preparation margin.
  store.upsertFoodHostOperatorPolicy({
    ghost_kitchen_location_id: "GK-AUSTIN",
    brand_licensor_id: "brand-licensor-atx",
    brand_licensor_holdback_bps: 1500,
  });
  // The truffle burger's branded cooking profile: $0.0025 per executed
  // cook cycle to the master chef.
  store.upsertFoodCookCyclePolicy({
    chef_id: CHEF,
    recipe_id: RECIPE,
    payee_id: CHEF,
    micros_per_cook_cycle: 250_000,
  });
  // Austin's virtual franchise operator waterfall: 60/40.
  for (const leg of [
    { operator_id: "op-north", weight_bps: 6000 },
    { operator_id: "op-south", weight_bps: 4000 },
  ]) {
    store.upsertFoodOperatorWaterfallLeg({ ghost_kitchen_location_id: "GK-AUSTIN", ...leg });
  }
  // A three-way waterfall whose thirds leave dust on the floor.
  for (const leg of [
    { operator_id: "op-x", weight_bps: 3333 },
    { operator_id: "op-y", weight_bps: 3333 },
    { operator_id: "op-z", weight_bps: 3334 },
  ]) {
    store.upsertFoodOperatorWaterfallLeg({ ghost_kitchen_location_id: "GK-DUST", ...leg });
  }
  // An unvalidated waterfall (weights sum to 11000) — the walk must
  // refuse it fail-closed, never guess a share.
  for (const leg of [
    { operator_id: "op-a", weight_bps: 5000 },
    { operator_id: "op-b", weight_bps: 6000 },
  ]) {
    store.upsertFoodOperatorWaterfallLeg({ ghost_kitchen_location_id: "GK-BADWATERFALL", ...leg });
  }
}

/** Parses the five senders' checked-in fixtures and walks the lane. */
async function walkFixtures(store: InMemoryStore) {
  const lines = [
    "food_delivery_orders.csv",
    "food_pos_tickets.csv",
    "food_meal_kit_production.csv",
    "food_grocery_cpg_scans.csv",
    "food_supplier_rebates.csv",
  ].flatMap((name) => parseCsv(loadFixture(name)));
  return writeFoodRowsToStore(store, lines);
}

/** The row event id for a delivery row (the replay guard's identity,
 * namespaced per ledger). */
function deliveryEventId(
  ledger: "realization" | "royalty" | "cobrand",
  senderRowId: string,
  location = "GK-AUSTIN",
  period = "2026-03",
): string {
  return foodRowEventId(ledger, {
    sender: "delivery_app_order",
    chefId: CHEF,
    recipeId: RECIPE,
    ghostKitchenLocationId: location,
    period,
    senderRowId,
  });
}

describe("the food lane's full pass over the five senders", () => {
  it("commits every ledger with the exact founder math and advances the trackers", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    const counts = await walkFixtures(store);

    // 6 delivery orders + 3 POS tickets + 2 meal-kit batches + 3 CPG
    // scans + 5 rebates: 6 realizations (1 held negative), 5 royalty
    // walks, 6 co-brand splits (5 delivery pots + 1 CPG pot), 2 host
    // splits, 1 cook-cycle royalty, and 3 rebate routings. The fail-
    // closed skips: 1 CPG scan with no schedule, 1 POS ticket with no
    // host policy, 1 batch with no cook-cycle policy, 2 rebates with no
    // (valid) waterfall, and 1 realization held negative. Nothing
    // replayed.
    expect(counts.realizationApplicationsWritten).toBe(6);
    expect(counts.realizationApplicationsReplayed).toBe(0);
    expect(counts.realizationHeldNegativeNet).toBe(1);
    expect(counts.royaltyApplicationsWritten).toBe(5);
    expect(counts.royaltyApplicationsReplayed).toBe(0);
    expect(counts.royaltySkippedNoSchedule).toBe(0);
    expect(counts.cobrandSplitsWritten).toBe(6);
    expect(counts.cobrandSplitsReplayed).toBe(0);
    expect(counts.cobrandSkippedNoWeightings).toBe(1);
    expect(counts.hostOperatorSplitsWritten).toBe(2);
    expect(counts.hostOperatorSplitsReplayed).toBe(0);
    expect(counts.hostOperatorSkippedNoPolicy).toBe(1);
    expect(counts.cookCycleRoyaltiesWritten).toBe(1);
    expect(counts.cookCycleRoyaltiesReplayed).toBe(0);
    expect(counts.cookCycleSkippedNoPolicy).toBe(1);
    expect(counts.supplierRebatesWritten).toBe(3);
    expect(counts.supplierRebatesReplayed).toBe(0);
    expect(counts.supplierRebatesSkippedNoWaterfall).toBe(2);

    // The pass's money of record, exact to the cent:
    // pools 600000 + 14000 + 120000 − 1000 (held) + 18000 + 8000;
    // unit payouts 75000 + 4500 + 79500 + 3000 + 1500;
    // percentage splits 24000 + 980 + 8400 + 720 + 320;
    // co-brand allocations 99000 + 5480 + 87900 + 3720 + 1820 + 120000;
    // host splits 52049 + 17425 with holdbacks 9185 + 3075;
    // cook cycles 300; rebates 480000 + 100000 + 1000.
    expect(counts.netCulinaryIpPoolCents).toBe(759_000);
    expect(counts.unitPayoutCents).toBe(163_500);
    expect(counts.percentageSplitCents).toBe(34_420);
    expect(counts.cobrandAllocatedCents).toBe(317_920);
    expect(counts.hostOperatorCents).toBe(69_474);
    expect(counts.brandLicensorHoldbackCents).toBe(12_260);
    expect(counts.cookCycleRoyaltyCents).toBe(300);
    expect(counts.supplierRebateRoutedCents).toBe(581_000);

    // THE NET RECIPE REALIZATION — exact to the cent on the order feed's
    // own figures: 10000.00 − 2500.00 − 1250.00 − 250.00 = 6000.00.
    const realization = await store.getFoodRealizationApplication(
      deliveryEventId("realization", "DO-2026-03-0001"),
    );
    expect(realization).toMatchObject({
      chef_id: CHEF,
      recipe_id: RECIPE,
      ghost_kitchen_location_id: "GK-AUSTIN",
      period: "2026-03",
      gross_menu_item_sales_cents: 1_000_000,
      approved_ingredient_cogs_cents: 250_000,
      delivery_platform_engine_cut_cents: 125_000,
      local_food_service_taxes_cents: 25_000,
      net_culinary_ip_pool_cents: 600_000,
      verdict: "paid",
    });

    // A NEGATIVE POOL — the deduction legs exceeded the gross: recorded
    // visible and held; the royalty walk prices nothing on it.
    const held = await store.getFoodRealizationApplication(
      deliveryEventId("realization", "DO-2026-05-0001", "GK-AUSTIN", "2026-05"),
    );
    expect(held).toMatchObject({
      net_culinary_ip_pool_cents: -1_000,
      verdict: "held_negative_net",
    });

    // THE TIERED RECIPE ROYALTY — the first 2500-unit row prices wholly
    // in the base band at the base rate (closing position 2500 is still
    // the first band's: "the first 2500 monthly units" include the
    // 2500th).
    const baseRow = await store.getFoodRecipeRoyaltyApplication(
      deliveryEventId("royalty", "DO-2026-03-0001"),
    );
    expect(baseRow).toMatchObject({
      units_sold: 2500,
      net_basis_cents: 600_000,
      unit_payout_cents: 75_000,
      unit_payout_micros: 75_000_000_000,
      royalty_bps: 400,
      percentage_split_cents: 24_000,
      units_before: 0,
      units_after: 2500,
      verdict: "paid",
    });
    expect(JSON.parse(baseRow?.unit_walk_legs ?? "[]")).toEqual([
      {
        band_from: 0,
        band_to: 2500,
        micros_per_unit: 30_000_000,
        band_units: 2500,
        band_payout_micros: 75_000_000_000,
      },
    ]);

    // The next row prices strictly POST the threshold: its units and its
    // percentage split both at the scaled 7% band.
    const scaledRow = await store.getFoodRecipeRoyaltyApplication(
      deliveryEventId("royalty", "DO-2026-03-0002"),
    );
    expect(scaledRow).toMatchObject({
      units_sold: 100,
      unit_payout_cents: 4_500,
      royalty_bps: 700,
      percentage_split_cents: 980,
      units_before: 2500,
      units_after: 2600,
    });

    // The cumulative monthly tracking of record — per location, per
    // month: Austin's March position is 2600, April's own position 2600
    // (a fresh month), Miami's 150, and May never opened a tracker (the
    // held row advances nothing).
    expect(
      (await store.getFoodLocationUnitMonth("GK-AUSTIN", "2026-03"))
        ?.cumulative_units,
    ).toBe(2600);
    expect(
      (await store.getFoodLocationUnitMonth("GK-AUSTIN", "2026-04"))
        ?.cumulative_units,
    ).toBe(2600);
    expect(
      (await store.getFoodLocationUnitMonth("GK-MIAMI", "2026-03"))
        ?.cumulative_units,
    ).toBe(150);
    expect(await store.getFoodLocationUnitMonth("GK-AUSTIN", "2026-05")).toBeUndefined();

    // A STRADDLING ROW — 2600 units on a fresh month split exactly at
    // the boundary: the first 2500 at the base band's rate, the last 100
    // at the scaled band's.
    const straddleRow = await store.getFoodRecipeRoyaltyApplication(
      deliveryEventId("royalty", "DO-2026-04-0001", "GK-AUSTIN", "2026-04"),
    );
    expect(straddleRow).toMatchObject({
      unit_payout_cents: 79_500,
      royalty_bps: 700,
      percentage_split_cents: 8_400,
      units_before: 0,
      units_after: 2600,
    });
    expect(JSON.parse(straddleRow?.unit_walk_legs ?? "[]")).toEqual([
      {
        band_from: 0,
        band_to: 2500,
        micros_per_unit: 30_000_000,
        band_units: 2500,
        band_payout_micros: 75_000_000_000,
      },
      {
        band_from: 2500,
        band_to: null,
        micros_per_unit: 45_000_000,
        band_units: 100,
        band_payout_micros: 4_500_000_000,
      },
    ]);

    // THE WEIGHTED CO-BRAND SPLIT — the row's royalty pot routes 70/30
    // per the recipe's weightings of record, conserving the pot exactly.
    const cobrand = await store.getFoodCobrandSplitApplication(
      deliveryEventId("cobrand", "DO-2026-03-0001"),
    );
    expect(cobrand).toMatchObject({
      royalty_pot_cents: 99_000,
      allocated_total_cents: 99_000,
    });
    const cobrandLegs = JSON.parse(cobrand?.weighting_legs ?? "[]") as {
      leg_id: string;
      payee_id: string;
      payee_role: string;
      weight_bps: number;
      allocated_cents: number;
    }[];
    expect(cobrandLegs).toEqual([
      {
        leg_id: "chef-leg",
        payee_id: CHEF,
        payee_role: "chef",
        weight_bps: 7000,
        allocated_cents: 69_300,
      },
      {
        leg_id: "brand-leg",
        payee_id: "brand-truffleco",
        payee_role: "ingredient_brand",
        weight_bps: 3000,
        allocated_cents: 29_700,
      },
    ]);

    // THE HOST KITCHEN OPERATOR SPLIT — the margin routes directly to
    // the local operator while the brand licensor's 15% holds back
    // (floored, exact): 612.34 → 9185 held, 52049 to the operator.
    const hostSplit = await store.getFoodHostOperatorSplitApplication(
      foodRowEventId("host", {
        sender: "pos_ticket",
        chefId: CHEF,
        recipeId: RECIPE,
        ghostKitchenLocationId: "GK-AUSTIN",
        period: "2026-03",
        senderRowId: "TICK-2026-03-0001",
      }),
    );
    expect(hostSplit).toMatchObject({
      platform: "toast",
      tickets: 40,
      physical_preparation_margin_cents: 61_234,
      brand_licensor_id: "brand-licensor-atx",
      brand_licensor_holdback_bps: 1500,
      brand_licensor_holdback_cents: 9_185,
      host_operator_cents: 52_049,
    });

    // THE COOK-CYCLE MICRO-ROYALTY — per-execution exact: 1200 executed
    // cycles × $0.0025 = $3.00 to the master chef of record.
    const cookCycle = await store.getFoodCookCycleRoyalty(
      foodRowEventId("cookcycle", {
        sender: "meal_kit_production",
        chefId: CHEF,
        recipeId: RECIPE,
        ghostKitchenLocationId: "GK-AUSTIN",
        period: "2026-03",
        senderRowId: "BATCH-2026-03-0001",
      }),
    );
    expect(cookCycle).toMatchObject({
      cook_cycles_executed: 1200,
      meal_kits_produced: 500,
      payee_id: CHEF,
      micros_per_cook_cycle: 250_000,
      royalty_micros: 300_000_000,
      royalty_cents: 300,
    });

    // THE GROCERY CPG ROYALTY — the schedule's 5% scanner rate prices
    // the hot honey's scans and the weighted split routes the pot.
    const cpgSplit = await store.getFoodCobrandSplitApplication(
      foodRowEventId("cobrand", {
        sender: "grocery_cpg_scan",
        chefId: "chef-aria",
        recipeId: "rec-hot-honey",
        ghostKitchenLocationId: "GK-AUSTIN",
        period: "2026-03",
        senderRowId: "SCAN-2026-03-0001",
      }),
    );
    expect(cpgSplit).toMatchObject({
      royalty_pot_cents: 120_000,
      allocated_total_cents: 120_000,
    });

    // THE SUPPLIER REBATE ROUTING — the Sysco volume kickback routes
    // proportionally through Austin's 60/40 operator waterfall,
    // conserving the rebate exactly.
    function rebateEventId(senderRowId: string, location: string): string {
      return foodRowEventId("rebate", {
        sender: "supplier_rebate",
        ghostKitchenLocationId: location,
        period: "2026-03",
        senderRowId,
      });
    }
    const rebate = await store.getFoodSupplierRebateApplication(
      rebateEventId("REB-2026-03-0001", "GK-AUSTIN"),
    );
    expect(rebate).toMatchObject({
      supplier: "sysco",
      ghost_kitchen_location_id: "GK-AUSTIN",
      rebate_basis_cents: 50_000_000,
      volume_rebate_cents: 480_000,
      routed_total_cents: 480_000,
    });
    const rebateLegs = JSON.parse(rebate?.routing_legs ?? "[]") as {
      operator_id: string;
      weight_bps: number;
      routed_cents: number;
    }[];
    expect(rebateLegs).toEqual([
      { operator_id: "op-north", weight_bps: 6000, routed_cents: 288_000 },
      { operator_id: "op-south", weight_bps: 4000, routed_cents: 192_000 },
    ]);

    // The dust case — a three-way waterfall's exact thirds floor to
    // 333/333/333 with one cent of dust, which routes to the largest
    // fractional remainder (the 3334 bps leg).
    const dustRebate = await store.getFoodSupplierRebateApplication(
      rebateEventId("REB-2026-03-0003", "GK-DUST"),
    );
    const dustLegs = JSON.parse(dustRebate?.routing_legs ?? "[]") as {
      operator_id: string;
      routed_cents: number;
    }[];
    expect(dustLegs.map((leg) => leg.routed_cents)).toEqual([333, 333, 334]);
    expect(dustRebate?.routed_total_cents).toBe(1_000);
  });

  it("replays the whole pass as counted no-ops", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);
    await walkFixtures(store);

    const counts = await walkFixtures(store);

    // Every application of record replays as a counted no-op — and the
    // fail-closed skips re-fire (they wrote nothing to replay against).
    expect(counts.realizationApplicationsWritten).toBe(0);
    expect(counts.realizationApplicationsReplayed).toBe(6);
    expect(counts.royaltyApplicationsWritten).toBe(0);
    expect(counts.royaltyApplicationsReplayed).toBe(5);
    expect(counts.cobrandSplitsWritten).toBe(0);
    expect(counts.cobrandSplitsReplayed).toBe(6);
    expect(counts.hostOperatorSplitsWritten).toBe(0);
    expect(counts.hostOperatorSplitsReplayed).toBe(2);
    expect(counts.cookCycleRoyaltiesWritten).toBe(0);
    expect(counts.cookCycleRoyaltiesReplayed).toBe(1);
    expect(counts.supplierRebatesWritten).toBe(0);
    expect(counts.supplierRebatesReplayed).toBe(3);
    expect(counts.cobrandSkippedNoWeightings).toBe(1);
    expect(counts.hostOperatorSkippedNoPolicy).toBe(1);
    expect(counts.cookCycleSkippedNoPolicy).toBe(1);
    expect(counts.supplierRebatesSkippedNoWaterfall).toBe(2);
    // The held realization's royalty walk still prices nothing (its
    // replay guard never fires — nothing was ever written).
    expect(counts.realizationHeldNegativeNet).toBe(0);
    // No money moves twice.
    expect(counts.netCulinaryIpPoolCents).toBe(0);
    expect(counts.unitPayoutCents).toBe(0);
    expect(counts.percentageSplitCents).toBe(0);
    expect(counts.cobrandAllocatedCents).toBe(0);
    expect(counts.hostOperatorCents).toBe(0);
    expect(counts.brandLicensorHoldbackCents).toBe(0);
    expect(counts.cookCycleRoyaltyCents).toBe(0);
    expect(counts.supplierRebateRoutedCents).toBe(0);
  });
});

describe("the food lane's pure founder math", () => {
  it("prices the Net Recipe Realization identity exact to the cent", () => {
    expect(
      netRecipeRealizationCents({
        grossMenuItemSalesCents: 1_000_000,
        approvedIngredientCogsCents: 250_000,
        deliveryPlatformEngineCutCents: 125_000,
        localFoodServiceTaxesCents: 25_000,
      }),
    ).toEqual({
      grossMenuItemSalesCents: 1_000_000,
      netCulinaryIpPoolCents: 600_000,
    });
    // A deduction set larger than the gross records its negative
    // honestly (the caller holds it).
    expect(
      netRecipeRealizationCents({
        grossMenuItemSalesCents: 10_000,
        approvedIngredientCogsCents: 6_000,
        deliveryPlatformEngineCutCents: 3_000,
        localFoodServiceTaxesCents: 2_000,
      }).netCulinaryIpPoolCents,
    ).toBe(-1_000);
    // Hostile legs never enter the calculator.
    expect(() =>
      netRecipeRealizationCents({
        grossMenuItemSalesCents: -1,
        approvedIngredientCogsCents: 0,
        deliveryPlatformEngineCutCents: 0,
        localFoodServiceTaxesCents: 0,
      }),
    ).toThrow();
  });

  it("holds the 2500-unit tier boundary with the cumulative position", () => {
    // Position 2500 is the base band's (the first 2500 units include
    // the 2500th); 2501 prices strictly POST the threshold.
    expect(royaltyBpsForPosition(2499, ROYALTY_BANDS)).toBe(400);
    expect(royaltyBpsForPosition(2500, ROYALTY_BANDS)).toBe(400);
    expect(royaltyBpsForPosition(2501, ROYALTY_BANDS)).toBe(700);
    expect(royaltyBpsForPosition(999_999, ROYALTY_BANDS)).toBe(700);

    // The per-dish walk splits a straddling row exactly at the boundary,
    // bigint-exact, and advances the cumulative position.
    const walk = unitTierWalk({
      units: 2600,
      cumulativeBefore: 0,
      bands: UNIT_BANDS,
    });
    expect(walk.payoutMicros).toBe(79_500_000_000n);
    expect(walk.cumulativeAfter).toBe(2600);
    expect(
      unitTierWalk({ units: 2500, cumulativeBefore: 0, bands: UNIT_BANDS })
        .payoutMicros,
    ).toBe(75_000_000_000n);
    expect(
      unitTierWalk({ units: 2501, cumulativeBefore: 0, bands: UNIT_BANDS })
        .payoutMicros,
    ).toBe(75_045_000_000n);
    expect(() =>
      unitTierWalk({ units: 0, cumulativeBefore: 0, bands: UNIT_BANDS }),
    ).toThrow();
  });

  it("splits the host operator margin with the brand licensor holdback", () => {
    // 15% of 612.34 floors to 9185; the operator routes the residual.
    expect(
      hostOperatorSplitCents({
        physicalPreparationMarginCents: 61_234,
        brandLicensorHoldbackBps: 1500,
      }),
    ).toEqual({ brandLicensorHoldbackCents: 9_185, hostOperatorCents: 52_049 });
    // The margin conserves exactly at every holdback, including the
    // degenerate 0 and 10000.
    for (const bps of [0, 1500, 5000, 10_000]) {
      const split = hostOperatorSplitCents({
        physicalPreparationMarginCents: 612_345,
        brandLicensorHoldbackBps: bps,
      });
      expect(split.brandLicensorHoldbackCents + split.hostOperatorCents).toBe(
        612_345,
      );
    }
  });

  it("prices the cook-cycle micro-fee per execution", () => {
    expect(
      cookCycleRoyaltyMicros({ cookCycles: 1, microsPerCookCycle: 250_000 })
        .royaltyMicros,
    ).toBe(250_000n);
    expect(
      cookCycleRoyaltyMicros({ cookCycles: 1200, microsPerCookCycle: 250_000 }).royaltyMicros,
    ).toBe(300_000_000n);
    expect(() =>
      cookCycleRoyaltyMicros({ cookCycles: 0, microsPerCookCycle: 250_000 }),
    ).toThrow();
  });

  it("routes the weighted co-brand and rebate splits largest-remainder exact", () => {
    const legs = [
      { leg_id: "chef-leg", payee_id: "chef", payee_role: "chef" as const, weight_bps: 7000 },
      {
        leg_id: "brand-leg",
        payee_id: "brand",
        payee_role: "ingredient_brand" as const,
        weight_bps: 3000,
      },
    ];
    const split = cobrandWeightedSplitCents({ royaltyPotCents: 99_000, legs });
    expect(split.legs.map((leg) => leg.allocated_cents)).toEqual([69_300, 29_700]);
    expect(split.allocatedTotalCents).toBe(99_000);

    // The dust distributes to the largest fractional remainder — the
    // exact-thirds waterfall floors to 333/333/333 and the extra cent
    // routes to the 3334 bps leg.
    const routing = rebateProportionalRoutingCents({
      volumeRebateCents: 1_000,
      legs: [
        { operator_id: "op-x", weight_bps: 3333 },
        { operator_id: "op-y", weight_bps: 3333 },
        { operator_id: "op-z", weight_bps: 3334 },
      ],
    });
    expect(routing.legs.map((leg) => leg.routed_cents)).toEqual([333, 333, 334]);
    expect(routing.routedTotalCents).toBe(1_000);

    // A one-leg waterfall routes everything.
    expect(
      rebateProportionalRoutingCents({
        volumeRebateCents: 7_777,
        legs: [{ operator_id: "solo", weight_bps: 10_000 }],
      }).routedTotalCents,
    ).toBe(7_777);

    // The shared core conserves any pot across the legs.
    const conserved = weightedSplitCents({
      potCents: 101,
      legs: [
        { key: "a", weightBps: 5000 },
        { key: "b", weightBps: 5000 },
      ],
    });
    expect(conserved.allocated.reduce((sum, cents) => sum + cents, 0)).toBe(101);
  });
});
