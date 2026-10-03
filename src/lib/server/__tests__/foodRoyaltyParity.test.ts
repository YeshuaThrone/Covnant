// The food lane (PR 40) — three-backend parity for the new store methods,
// mirroring the spatial royalty parity pattern: the same scenario script
// runs on InMemoryStore, SqliteStore (:memory:), and SupabaseStore over a
// behavioral PostgREST fake.
//
// Under test: the schedule/policy/weighting/waterfall tables of record,
// the converged location-month unit tracker (an advance ADDS), and the
// replay-guarded application ledgers — a re-walked event throws, never a
// double royalty. The cobrand weighting's payee_role round-trips in the
// migration-0044 vocabulary ('chef' | 'brand' | 'operator' |
// 'supplier_partner') — SQLite's real CHECK constraint is the regression
// guard that keeps the record vocabulary pinned to the schema's.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — identical to the spatial parity precedent: eq
// filters, ordered select, guarded update returning, upsert-on-conflict,
// and behavioral unique constraints (the 23505 shape).
// ---------------------------------------------------------------------------

type UniqueConstraint = {
  name: string;
  columns: string[];
};

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniques: UniqueConstraint[] = []) {}

  insert(row: Row): { row: Row | null; error: { message: string; code: string } | null } {
    for (const unique of this.uniques) {
      const key = unique.columns.map((column) => row[column]);
      if (
        key.every((value) => value !== undefined) &&
        this.rows.some((existing) =>
          unique.columns.every((column) => existing[column] === row[column]),
        )
      ) {
        return {
          row: null,
          error: {
            message: `duplicate key value violates unique constraint ${unique.name}`,
            code: "23505",
          },
        };
      }
    }
    const stored = { insertion_order: ++this.sequence, ...row };
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }

  update(patch: Row, filters: Array<[string, unknown]>): Row[] {
    const updated: Row[] = [];
    for (const row of this.rows) {
      if (!filters.every(([column, value]) => row[column] === value)) continue;
      Object.assign(row, patch);
      updated.push({ ...row });
    }
    return updated;
  }

  select(
    filters: Array<[string, unknown]>,
    orders: Array<{ column: string; ascending: boolean }>,
    limit: number | null,
  ): Row[] {
    const matched = this.rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value),
    );
    const sorted = matched.sort((a, b) => {
      for (const spec of orders) {
        const av = a[spec.column] as string | number;
        const bv = b[spec.column] as string | number;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return spec.ascending ? cmp : -cmp;
      }
      return 0;
    });
    return limit === null ? sorted : sorted.slice(0, limit);
  }

  upsert(row: Row, onConflict: string | null): { row: Row; error: null } {
    if (onConflict !== null) {
      const conflictColumns = onConflict
        .split(",")
        .map((column) => column.trim())
        .filter((column) => column !== "");
      if (conflictColumns.length > 0) {
        const index = this.rows.findIndex((existing) =>
          conflictColumns.every((column) => existing[column] === row[column]),
        );
        if (index >= 0) {
          this.rows[index] = { ...this.rows[index], ...row };
          return { row: { ...this.rows[index] }, error: null };
        }
      }
    }
    const stored = { insertion_order: ++this.sequence, ...row };
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }
}

interface FakeResult {
  data: unknown;
  error: { message: string; code: string } | null;
}

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private single = false;
  private onConflict: string | null = null;
  private operation:
    | { kind: "insert"; row: Row }
    | { kind: "upsert"; row: Row }
    | { kind: "update"; patch: Row }
    | { kind: "select" } = { kind: "select" };

  constructor(private readonly table: FakeTable) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
    return this;
  }

  upsert(row: Row, options?: { onConflict?: string }): this {
    this.operation = { kind: "upsert", row };
    this.onConflict = options?.onConflict ?? null;
    return this;
  }

  update(patch: Row): this {
    this.operation = { kind: "update", patch };
    return this;
  }

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: (value: FakeResult) => TResult1,
    onRejected?: (reason: unknown) => TResult2,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private execute(): FakeResult {
    const op = this.operation;
    if (op.kind === "insert") {
      const { row, error } = this.table.insert(op.row);
      if (error !== null) return { data: null, error };
      return { data: row, error: null };
    }
    if (op.kind === "upsert") {
      const { row, error } = this.table.upsert(op.row, this.onConflict);
      if (error !== null) return { data: null, error };
      return { data: this.single ? row : [row], error: null };
    }
    if (op.kind === "update") {
      const updated = this.table.update(op.patch, this.filters);
      if (updated.length === 0) return { data: null, error: null };
      if (this.single) return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
    }
    const rows = this.table.select(this.filters, this.orders, this.limitCount);
    if (this.single) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();

  constructor(
    private readonly uniques: Record<string, UniqueConstraint[]> = {},
  ) {}

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(this.uniques[table] ?? []);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// The unique constraints the real schema enforces (migration 0044) — the
// fake reproduces their 23505 behavior so the replay guards and the
// converged unit tracker exercise end to end.
const FAKE_UNIQUES = {
  food_recipe_royalty_schedules: [
    { name: "food_recipe_royalty_schedules_chef_recipe_key", columns: ["chef_id", "recipe_id"] },
  ],
  food_location_unit_months: [
    {
      name: "food_location_unit_months_location_month_key",
      columns: ["ghost_kitchen_location_id", "month"],
    },
  ],
  food_host_operator_policies: [
    { name: "food_host_operator_policies_location_key", columns: ["ghost_kitchen_location_id"] },
  ],
  food_cook_cycle_policies: [
    { name: "food_cook_cycle_policies_chef_recipe_key", columns: ["chef_id", "recipe_id"] },
  ],
  food_cobrand_weightings: [
    { name: "food_cobrand_weightings_recipe_leg_key", columns: ["recipe_id", "leg_id"] },
  ],
  food_operator_waterfalls: [
    {
      name: "food_operator_waterfalls_location_operator_key",
      columns: ["ghost_kitchen_location_id", "operator_id"],
    },
  ],
  food_realization_applications: [
    { name: "food_realization_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
  food_recipe_royalty_applications: [
    { name: "food_recipe_royalty_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
  food_cobrand_split_applications: [
    { name: "food_cobrand_split_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
  food_host_operator_split_applications: [
    {
      name: "food_host_operator_split_applications_source_event_id_key",
      columns: ["source_event_id"],
    },
  ],
  food_cook_cycle_royalties: [
    { name: "food_cook_cycle_royalties_source_event_id_key", columns: ["source_event_id"] },
  ],
  food_supplier_rebate_applications: [
    { name: "food_supplier_rebate_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const CHEF = "chef-parity-massimo";
const RECIPE = "rec-parity-truffle-burger";
const LOCATION = "GK-PARITY-AUSTIN";
const MONTH = "2026-03";
const UNIT_BANDS = [
  { up_to: 2500, micros_per_unit: 30_000_000 },
  { up_to: null, micros_per_unit: 45_000_000 },
];
const ROYALTY_BANDS = [
  { up_to: 2500, royalty_bps: 400 },
  { up_to: null, royalty_bps: 700 },
];

function expectUniqueViolation(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  // Both backend surfaces the canonical helper detects: the Postgres 23505
  // code (SupabaseStore wraps it into the thrown message) and SQLite's
  // native constraint text.
  const message = (error as Error).message;
  expect(
    message.includes("23505") || message.includes("UNIQUE constraint failed"),
  ).toBe(true);
}

async function scenario(store: Store): Promise<void> {
  // --- The recipe royalty schedule of record per (chef, recipe): upsert
  // replaces; unknown pairs read undefined. ---
  await store.upsertFoodRecipeRoyaltySchedule({
    chef_id: CHEF,
    recipe_id: RECIPE,
    unit_micros_bands: JSON.stringify([{ up_to: null, micros_per_unit: 1_000_000 }]),
    royalty_bps_bands: JSON.stringify([{ up_to: null, royalty_bps: 100 }]),
    cpg_royalty_bps: 0,
  });
  expect(
    (await store.getFoodRecipeRoyaltySchedule(CHEF, RECIPE))?.cpg_royalty_bps,
  ).toBe(0);
  expect(await store.getFoodRecipeRoyaltySchedule("chef-nobody", RECIPE)).toBeUndefined();
  await store.upsertFoodRecipeRoyaltySchedule({
    chef_id: CHEF,
    recipe_id: RECIPE,
    unit_micros_bands: JSON.stringify(UNIT_BANDS),
    royalty_bps_bands: JSON.stringify(ROYALTY_BANDS),
    cpg_royalty_bps: 500,
  });
  const schedule = await store.getFoodRecipeRoyaltySchedule(CHEF, RECIPE);
  expect(schedule?.cpg_royalty_bps).toBe(500);
  expect(JSON.parse(schedule?.unit_micros_bands ?? "[]")).toHaveLength(2);
  expect(JSON.parse(schedule?.royalty_bps_bands ?? "[]")[0]).toMatchObject({
    royalty_bps: 400,
  });

  // --- The converged location-month unit tracker: an advance ADDS. ---
  await store.advanceFoodLocationUnitMonth(LOCATION, MONTH, 2500);
  await store.advanceFoodLocationUnitMonth(LOCATION, MONTH, 100);
  expect(
    (await store.getFoodLocationUnitMonth(LOCATION, MONTH))?.cumulative_units,
  ).toBe(2600);
  expect(await store.getFoodLocationUnitMonth("GK-PARITY-NOWHERE", MONTH)).toBeUndefined();

  // --- The host operator policy of record per location. ---
  await store.upsertFoodHostOperatorPolicy({
    ghost_kitchen_location_id: LOCATION,
    brand_licensor_id: "brand-licensor-parity",
    brand_licensor_holdback_bps: 1500,
  });
  expect(
    (await store.getFoodHostOperatorPolicy(LOCATION))?.brand_licensor_holdback_bps,
  ).toBe(1500);

  // --- The cook-cycle policy of record per (chef, recipe). ---
  await store.upsertFoodCookCyclePolicy({
    chef_id: CHEF,
    recipe_id: RECIPE,
    payee_id: CHEF,
    micros_per_cook_cycle: 250_000,
  });
  expect(
    (await store.getFoodCookCyclePolicy(CHEF, RECIPE))?.micros_per_cook_cycle,
  ).toBe(250_000);

  // --- The co-brand weightings of record: the payee role round-trips in
  // the migration-0044 vocabulary — SQLite's CHECK constraint is the
  // regression guard against record-vocabulary drift. ---
  await store.upsertFoodCobrandWeighting({
    recipe_id: RECIPE,
    leg_id: "chef-leg",
    payee_id: CHEF,
    payee_role: "chef",
    weight_bps: 7000,
  });
  await store.upsertFoodCobrandWeighting({
    recipe_id: RECIPE,
    leg_id: "brand-leg",
    payee_id: "brand-parity-scorchio",
    payee_role: "brand",
    weight_bps: 3000,
  });
  const weightings = await store.listFoodCobrandWeightings(RECIPE);
  expect(weightings).toHaveLength(2);
  expect(weightings.map((leg) => leg.payee_role).sort()).toEqual(["brand", "chef"]);
  expect(await store.listFoodCobrandWeightings("rec-parity-nobody")).toEqual([]);

  // --- The operator waterfall legs of record per location. ---
  await store.upsertFoodOperatorWaterfallLeg({
    ghost_kitchen_location_id: LOCATION,
    operator_id: "op-parity-north",
    weight_bps: 6000,
  });
  await store.upsertFoodOperatorWaterfallLeg({
    ghost_kitchen_location_id: LOCATION,
    operator_id: "op-parity-south",
    weight_bps: 4000,
  });
  expect(await store.listFoodOperatorWaterfallLegs(LOCATION)).toHaveLength(2);

  // --- The realization application ledger: the founder identity
  // appended once; a re-walk of the same source event throws (the
  // replay guard), never a double pool. ---
  await store.insertFoodRealizationApplication({
    source_event_id: "food:parity:realization:1",
    chef_id: CHEF,
    recipe_id: RECIPE,
    ghost_kitchen_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    gross_menu_item_sales_cents: 1_000_000,
    approved_ingredient_cogs_cents: 250_000,
    delivery_platform_engine_cut_cents: 125_000,
    local_food_service_taxes_cents: 25_000,
    net_culinary_ip_pool_cents: 600_000,
    verdict: "paid",
  });
  const realization = await store.getFoodRealizationApplication("food:parity:realization:1");
  expect(realization?.net_culinary_ip_pool_cents).toBe(600_000);
  const realizationReplayThrew = await store.insertFoodRealizationApplication({
      source_event_id: "food:parity:realization:1",
      chef_id: CHEF,
      recipe_id: RECIPE,
      ghost_kitchen_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      gross_menu_item_sales_cents: 1,
      approved_ingredient_cogs_cents: 0,
      delivery_platform_engine_cut_cents: 0,
      local_food_service_taxes_cents: 0,
      net_culinary_ip_pool_cents: 1,
      verdict: "paid",
    }).catch((error) => error);
  expectUniqueViolation(realizationReplayThrew);

  // --- The tiered recipe royalty application ledger: the committed walk
  // appended once; a re-walk throws. ---
  await store.insertFoodRecipeRoyaltyApplication({
    source_event_id: "food:parity:royalty:1",
    sender: "delivery_app_order",
    chef_id: CHEF,
    recipe_id: RECIPE,
    ghost_kitchen_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    platform: "doordash",
    units_sold: 2500,
    net_basis_cents: 600_000,
    schedule_ref: `${CHEF}:${RECIPE}`,
    unit_walk_legs: JSON.stringify([
      {
        band_from: 0,
        band_to: 2500,
        micros_per_unit: 30_000_000,
        band_units: 2500,
        band_payout_micros: 75_000_000_000,
      },
    ]),
    unit_payout_micros: 75_000_000_000,
    unit_payout_cents: 75_000,
    royalty_bps: 400,
    percentage_split_cents: 24_000,
    units_before: 0,
    units_after: 2500,
    verdict: "paid",
  });
  expect(
    (await store.getFoodRecipeRoyaltyApplication("food:parity:royalty:1"))
      ?.percentage_split_cents,
  ).toBe(24_000);
  const royaltyReplayThrew = await store.insertFoodRecipeRoyaltyApplication({
      source_event_id: "food:parity:royalty:1",
      sender: "delivery_app_order",
      chef_id: CHEF,
      recipe_id: RECIPE,
      ghost_kitchen_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      platform: "doordash",
      units_sold: 1,
      net_basis_cents: 1,
      schedule_ref: `${CHEF}:${RECIPE}`,
      unit_walk_legs: "[]",
      unit_payout_micros: 0,
      unit_payout_cents: 0,
      royalty_bps: 0,
      percentage_split_cents: 0,
      units_before: 0,
      units_after: 1,
      verdict: "paid",
    }).catch((error) => error);
  expectUniqueViolation(royaltyReplayThrew);

  // --- The co-brand split application ledger: the pot conserved;
  // a re-walk throws. ---
  await store.insertFoodCobrandSplitApplication({
    source_event_id: "food:parity:cobrand:1",
    chef_id: CHEF,
    recipe_id: RECIPE,
    ghost_kitchen_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    royalty_pot_cents: 99_000,
    weighting_legs: JSON.stringify([
      { leg_id: "chef-leg", payee_id: CHEF, payee_role: "chef", weight_bps: 7000, allocated_cents: 69_300 },
      {
        leg_id: "brand-leg",
        payee_id: "brand-parity-scorchio",
        payee_role: "brand",
        weight_bps: 3000,
        allocated_cents: 29_700,
      },
    ]),
    allocated_total_cents: 99_000,
  });
  expect(
    (await store.getFoodCobrandSplitApplication("food:parity:cobrand:1"))
      ?.allocated_total_cents,
  ).toBe(99_000);
  const cobrandReplayThrew = await store.insertFoodCobrandSplitApplication({
      source_event_id: "food:parity:cobrand:1",
      chef_id: CHEF,
      recipe_id: RECIPE,
      ghost_kitchen_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      royalty_pot_cents: 1,
      weighting_legs: "[]",
      allocated_total_cents: 1,
    }).catch((error) => error);
  expectUniqueViolation(cobrandReplayThrew);

  // --- The supplier rebate application ledger: the kickback conserved;
  // a re-walk throws. ---
  await store.insertFoodSupplierRebateApplication({
    source_event_id: "food:parity:rebate:1",
    supplier: "sysco",
    ghost_kitchen_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    rebate_basis_cents: 50_000_000,
    volume_rebate_cents: 480_000,
    routing_legs: JSON.stringify([
      { operator_id: "op-parity-north", weight_bps: 6000, routed_cents: 288_000 },
      { operator_id: "op-parity-south", weight_bps: 4000, routed_cents: 192_000 },
    ]),
    routed_total_cents: 480_000,
  });
  expect(
    (await store.getFoodSupplierRebateApplication("food:parity:rebate:1"))
      ?.routed_total_cents,
  ).toBe(480_000);
  const rebateReplayThrew = await store.insertFoodSupplierRebateApplication({
      source_event_id: "food:parity:rebate:1",
      supplier: "us_foods",
      ghost_kitchen_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      rebate_basis_cents: 1,
      volume_rebate_cents: 1,
      routing_legs: "[]",
      routed_total_cents: 1,
    }).catch((error) => error);
  expectUniqueViolation(rebateReplayThrew);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the food methods touch;
    // the real SupabaseClient surface is far larger than the store
    // touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("food POS parsers + recipe royalties + supplier rebates — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the schedules, policies, weightings, waterfalls, the unit tracker, and the four replay-guarded ledgers identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
