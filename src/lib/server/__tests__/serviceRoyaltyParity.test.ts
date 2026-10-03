// The service lane (PR 42) — three-backend parity for the new store
// methods, mirroring the food royalty parity pattern: the same scenario
// script runs on InMemoryStore, SqliteStore (:memory:), and SupabaseStore
// over a behavioral PostgREST fake.
//
// Under test: the schedule/policy/waterfall tables of record (upserts
// converge, never rotate the row identity) and the seven replay-guarded
// application ledgers — a re-walked event throws, never a double split.
// The vocabulary columns round-trip in the migration-0046 vocabularies —
// SQLite's real CHECK constraints are the regression guard that keeps
// the record vocabulary pinned to the schema's.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — identical to the food parity precedent: eq filters,
// ordered select, guarded update returning, upsert-on-conflict, and
// behavioral unique constraints (the 23505 shape).
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

// The unique constraints the real schema enforces (migration 0046) — the
// fake reproduces their 23505 behavior so the replay guards and the
// converging policy upserts exercise end to end.
const FAKE_UNIQUES = {
  service_franchise_schedules: [
    { name: "service_franchise_schedules_salon_location_id_key", columns: ["salon_location_id"] },
  ],
  service_protocol_policies: [
    { name: "service_protocol_policies_protocol_id_key", columns: ["protocol_id"] },
  ],
  service_redemption_policies: [
    { name: "service_redemption_policies_home_location_id_key", columns: ["home_location_id"] },
  ],
  service_breakage_policies: [
    { name: "service_breakage_policies_home_location_id_key", columns: ["home_location_id"] },
  ],
  service_rebate_waterfalls: [
    {
      name: "service_rebate_waterfalls_salon_location_ledger_key",
      columns: ["salon_location_id", "ledger_id"],
    },
  ],
  service_booth_lease_policies: [
    { name: "service_booth_lease_policies_salon_location_id_key", columns: ["salon_location_id"] },
  ],
  service_realization_applications: [
    { name: "service_realization_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
  service_franchise_split_applications: [
    {
      name: "service_franchise_split_applications_source_event_id_key",
      columns: ["source_event_id"],
    },
  ],
  service_protocol_micro_royalties: [
    { name: "service_protocol_micro_royalties_source_event_id_key", columns: ["source_event_id"] },
  ],
  service_redemption_split_applications: [
    {
      name: "service_redemption_split_applications_source_event_id_key",
      columns: ["source_event_id"],
    },
  ],
  service_breakage_allocations: [
    { name: "service_breakage_allocations_source_event_id_key", columns: ["source_event_id"] },
  ],
  service_rebate_applications: [
    { name: "service_rebate_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
  service_booth_lease_applications: [
    { name: "service_booth_lease_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const LOCATION = "LOC-PARITY-AUSTIN";
const STYLIST = "stylist-parity-ava";
const PROTOCOL = "proto-parity-glow";
const MEMBER = "member-parity-m1";
const MONTH = "2026-03";

function expectUniqueViolation(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  // Both backend surfaces the canonical helper detects: the Postgres 23505
  // code (SupabaseStore wraps it into the thrown message) and SQLite's
  // native constraint text.
  const message = (error as Error).message;
  expect(
    message.includes("23505") || message.includes("UNIQUE constraint failed"),
    message,
  ).toBe(true);
}

async function scenario(store: Store): Promise<void> {
  // --- The franchise schedule of record per location: upsert replaces;
  // an absent location reads undefined. ---
  await store.upsertServiceFranchiseSchedule({
    salon_location_id: LOCATION,
    master_franchisor_royalty_bps: 400,
    technician_commission_bps: 4600,
    house_margin_bps: 5000,
  });
  await store.upsertServiceFranchiseSchedule({
    salon_location_id: LOCATION,
    master_franchisor_royalty_bps: 500,
    technician_commission_bps: 4500,
    house_margin_bps: 5000,
  });
  const schedule = await store.getServiceFranchiseSchedule(LOCATION);
  expect(schedule?.master_franchisor_royalty_bps).toBe(500);
  expect(await store.getServiceFranchiseSchedule("LOC-PARITY-NOWHERE")).toBeUndefined();

  // --- The protocol policy of record per protocol — the payee identity
  // and the per-treatment micro-fee converge on re-register. ---
  await store.upsertServiceProtocolPolicy({
    protocol_id: PROTOCOL,
    payee_id: "esthetician-parity-mila",
    micros_per_treatment: 250_000,
  });
  await store.upsertServiceProtocolPolicy({
    protocol_id: PROTOCOL,
    payee_id: "esthetician-parity-mila",
    micros_per_treatment: 300_000,
  });
  expect(
    (await store.getServiceProtocolPolicy(PROTOCOL))?.micros_per_treatment,
  ).toBe(300_000);
  expect(await store.getServiceProtocolPolicy("proto-parity-nobody")).toBeUndefined();

  // --- The redemption and breakage policies of record per home
  // location. ---
  await store.upsertServiceRedemptionPolicy({
    home_location_id: LOCATION,
    franchisor_royalty_bps: 500,
    home_admin_bps: 1500,
  });
  expect(
    (await store.getServiceRedemptionPolicy(LOCATION))?.home_admin_bps,
  ).toBe(1500);
  expect(await store.getServiceRedemptionPolicy("LOC-PARITY-NOWHERE")).toBeUndefined();
  await store.upsertServiceBreakagePolicy({
    home_location_id: LOCATION,
    franchisor_breakage_bps: 2500,
    franchisee_breakage_bps: 7500,
  });
  expect(
    (await store.getServiceBreakagePolicy(LOCATION))?.franchisor_breakage_bps,
  ).toBe(2500);
  expect(await store.getServiceBreakagePolicy("LOC-PARITY-NOWHERE")).toBeUndefined();

  // --- The rebate waterfall legs of record: a re-registered leg
  // converges (no duplicate row). ---
  await store.upsertServiceRebateWaterfallLeg({
    salon_location_id: LOCATION,
    ledger_id: "ledger-parity-backbar",
    weight_bps: 3000,
  });
  await store.upsertServiceRebateWaterfallLeg({
    salon_location_id: LOCATION,
    ledger_id: "ledger-parity-backbar",
    weight_bps: 3500,
  });
  await store.upsertServiceRebateWaterfallLeg({
    salon_location_id: LOCATION,
    ledger_id: "ledger-parity-house",
    weight_bps: 6500,
  });
  const legs = await store.listServiceRebateWaterfallLegs(LOCATION);
  expect(legs).toHaveLength(2);
  expect(legs.map((leg) => leg.weight_bps).sort((a, b) => a - b)).toEqual([3500, 6500]);
  expect(await store.listServiceRebateWaterfallLegs("LOC-PARITY-NOWHERE")).toEqual([]);

  // --- The booth-lease policy of record per location. ---
  await store.upsertServiceBoothLeasePolicy({
    salon_location_id: LOCATION,
    chair_rent_payee_id: "studio-owner-parity",
    retail_commission_bps: 1500,
  });
  expect(
    (await store.getServiceBoothLeasePolicy(LOCATION))?.chair_rent_payee_id,
  ).toBe("studio-owner-parity");

  // --- The realization application ledger: the founder identity
  // appended once; a re-walk of the same source event throws (the
  // replay guard), never a double pool. ---
  const realizationRow = {
    source_event_id: "service:parity:realization:1",
    sender: "pos_ticket" as const,
    stylist_id: STYLIST,
    protocol_id: PROTOCOL,
    salon_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    gross_service_ticket_cents: 100_000,
    backbar_product_cogs_cents: 12_050,
    card_processing_engine_cut_cents: 2_940,
    service_sales_taxes_cents: 8_260,
    net_realized_service_pool_cents: 76_750,
    verdict: "paid" as const,
  };
  await store.insertServiceRealizationApplication(realizationRow);
  expect(
    (await store.getServiceRealizationApplication("service:parity:realization:1"))
      ?.net_realized_service_pool_cents,
  ).toBe(76_750);
  // CHECK-valid but distinct: the replay guard, not the identity CHECK,
  // must be the constraint that fires.
  const realizationReplayThrew = await store
    .insertServiceRealizationApplication({
      ...realizationRow,
      gross_service_ticket_cents: 90_000,
      backbar_product_cogs_cents: 9_050,
      service_sales_taxes_cents: 8_260,
      net_realized_service_pool_cents: 69_750,
    })
    .catch((error) => error);
  expectUniqueViolation(realizationReplayThrew);

  // --- The franchise split application ledger: the three legs conserved;
  // a re-walk throws. ---
  await store.insertServiceFranchiseSplitApplication({
    source_event_id: "service:parity:franchise:1",
    sender: "pos_ticket",
    stylist_id: STYLIST,
    protocol_id: PROTOCOL,
    salon_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    gross_service_ticket_cents: 100_000,
    schedule_ref: "sched-parity-1",
    master_franchisor_royalty_bps: 500,
    master_franchisor_royalty_cents: 5_000,
    technician_commission_bps: 4500,
    technician_commission_cents: 45_000,
    house_margin_bps: 5000,
    house_margin_cents: 50_000,
  });
  expect(
    (await store.getServiceFranchiseSplitApplication("service:parity:franchise:1"))
      ?.technician_commission_cents,
  ).toBe(45_000);
  const franchiseReplayThrew = await store
    .insertServiceFranchiseSplitApplication({
      source_event_id: "service:parity:franchise:1",
      sender: "pos_ticket",
      stylist_id: STYLIST,
      protocol_id: PROTOCOL,
      salon_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      gross_service_ticket_cents: 1,
      schedule_ref: "sched-parity-1",
      master_franchisor_royalty_bps: 500,
      master_franchisor_royalty_cents: 0,
      technician_commission_bps: 4500,
      technician_commission_cents: 0,
      house_margin_bps: 5000,
      house_margin_cents: 1,
    })
    .catch((error) => error);
  expectUniqueViolation(franchiseReplayThrew);

  // --- The protocol micro-royalty ledger: the vocabulary columns
  // round-trip (SQLite's CHECK is the drift guard); a re-walk throws. ---
  await store.insertServiceProtocolMicroRoyalty({
    source_event_id: "service:parity:protocol:1",
    sender: "hotel_folio",
    stylist_id: STYLIST,
    protocol_id: PROTOCOL,
    salon_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    payee_id: "esthetician-parity-mila",
    micros_per_treatment: 300_000,
    royalty_micros: 300_000,
    royalty_cents: 0,
  });
  expect(
    (await store.getServiceProtocolMicroRoyalty("service:parity:protocol:1"))?.sender,
  ).toBe("hotel_folio");
  const protocolReplayThrew = await store
    .insertServiceProtocolMicroRoyalty({
      source_event_id: "service:parity:protocol:1",
      sender: "hotel_folio",
      stylist_id: STYLIST,
      protocol_id: PROTOCOL,
      salon_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      payee_id: "esthetician-parity-mila",
      micros_per_treatment: 300_000,
      royalty_micros: 300_000,
      royalty_cents: 0,
    })
    .catch((error) => error);
  expectUniqueViolation(protocolReplayThrew);

  // --- The redemption split application ledger: the fee conserved;
  // a re-walk throws. ---
  await store.insertServiceRedemptionSplitApplication({
    source_event_id: "service:parity:redemption:1",
    member_id: MEMBER,
    home_location_id: LOCATION,
    visiting_location_id: "LOC-PARITY-DALLAS",
    period: MONTH,
    currency: "usd",
    service_allocation_fee_cents: 7_500,
    franchisor_royalty_bps: 500,
    franchisor_royalty_cents: 375,
    home_admin_bps: 1500,
    home_admin_cents: 1_125,
    visiting_location_cents: 6_000,
  });
  expect(
    (await store.getServiceRedemptionSplitApplication("service:parity:redemption:1"))
      ?.visiting_location_cents,
  ).toBe(6_000);
  const redemptionReplayThrew = await store
    .insertServiceRedemptionSplitApplication({
      source_event_id: "service:parity:redemption:1",
      member_id: MEMBER,
      home_location_id: LOCATION,
      visiting_location_id: "LOC-PARITY-DALLAS",
      period: MONTH,
      currency: "usd",
      service_allocation_fee_cents: 1,
      franchisor_royalty_bps: 500,
      franchisor_royalty_cents: 0,
      home_admin_bps: 1500,
      home_admin_cents: 0,
      visiting_location_cents: 1,
    })
    .catch((error) => error);
  expectUniqueViolation(redemptionReplayThrew);

  // --- The breakage allocation ledger: the unredeemed funds split once;
  // a re-walk throws. ---
  await store.insertServiceBreakageAllocation({
    source_event_id: "service:parity:breakage:1",
    member_id: MEMBER,
    home_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    unredeemed_amount_cents: 12_345,
    franchisor_breakage_bps: 2500,
    franchisor_breakage_cents: 3_086,
    franchisee_breakage_cents: 9_259,
  });
  expect(
    (await store.getServiceBreakageAllocation("service:parity:breakage:1"))
      ?.franchisor_breakage_cents,
  ).toBe(3_086);
  const breakageReplayThrew = await store
    .insertServiceBreakageAllocation({
      source_event_id: "service:parity:breakage:1",
      member_id: MEMBER,
      home_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      unredeemed_amount_cents: 1,
      franchisor_breakage_bps: 2500,
      franchisor_breakage_cents: 0,
      franchisee_breakage_cents: 1,
    })
    .catch((error) => error);
  expectUniqueViolation(breakageReplayThrew);

  // --- The rebate application ledger: the kickback routing conserved;
  // a re-walk throws. ---
  await store.insertServiceRebateApplication({
    source_event_id: "service:parity:rebate:1",
    distributor: "loreal",
    salon_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    rebate_basis_cents: 50_000_000,
    volume_rebate_cents: 75_000,
    routing_legs: JSON.stringify([
      { ledger_id: "ledger-parity-backbar", weight_bps: 3500, routed_cents: 26_250 },
      { ledger_id: "ledger-parity-house", weight_bps: 6500, routed_cents: 48_750 },
    ]),
    routed_total_cents: 75_000,
  });
  expect(
    (await store.getServiceRebateApplication("service:parity:rebate:1"))?.routed_total_cents,
  ).toBe(75_000);
  // CHECK-valid but distinct: routed_total = volume_rebate is pinned, so
  // a zero rebate with an empty leg set stays identity-legal while the
  // replay guard fires.
  const rebateReplayThrew = await store
    .insertServiceRebateApplication({
      source_event_id: "service:parity:rebate:1",
      distributor: "estee_lauder",
      salon_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      rebate_basis_cents: 1,
      volume_rebate_cents: 0,
      routing_legs: "[]",
      routed_total_cents: 0,
    })
    .catch((error) => error);
  expectUniqueViolation(rebateReplayThrew);

  // --- The booth-lease application ledger: the isolated legs committed
  // once; a re-walk throws. ---
  await store.insertServiceBoothLeaseApplication({
    source_event_id: "service:parity:booth:1",
    salon_location_id: LOCATION,
    period: MONTH,
    currency: "usd",
    leg_kind: "chair_rent",
    gross_cents: 20_000,
    retail_commission_bps: 0,
    studio_owner_cents: 20_000,
  });
  expect(
    (await store.getServiceBoothLeaseApplication("service:parity:booth:1"))?.leg_kind,
  ).toBe("chair_rent");
  const boothReplayThrew = await store
    .insertServiceBoothLeaseApplication({
      source_event_id: "service:parity:booth:1",
      salon_location_id: LOCATION,
      period: MONTH,
      currency: "usd",
      leg_kind: "chair_rent",
      gross_cents: 1,
      retail_commission_bps: 0,
      studio_owner_cents: 1,
    })
    .catch((error) => error);
  expectUniqueViolation(boothReplayThrew);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the service methods touch;
    // the real SupabaseClient surface is far larger than the store
    // touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("service POS parsers + membership splits + protocol micro-royalties — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the schedules, policies, waterfalls, and the seven replay-guarded ledgers identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
