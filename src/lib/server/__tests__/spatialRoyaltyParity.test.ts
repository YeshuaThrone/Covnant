// Spatial POS + occupancy royalties + zone allocation (PR 36) —
// three-backend parity for the new store methods, mirroring the NIL audit
// escrow parity pattern: the same scenario script runs on InMemoryStore,
// SqliteStore (:memory:), and SupabaseStore over a behavioral PostgREST
// fake.
//
// Under test: the schedules/policies/assignments of record per (venue,
// year) and (venue, zone) scopes, the converged throughput tracker
// (an advance ADDS entries), and the three append-only application
// ledgers with their source_event_id replay guards — a re-walked event
// throws, never a double royalty.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — identical to the NIL escrow parity precedent: eq
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
      if (key.every((value) => value !== undefined) &&
          this.rows.some((existing) => unique.columns.every((column) => existing[column] === row[column]))) {
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
      const conflictColumn = onConflict.split(",")[0]?.trim();
      const index = this.rows.findIndex(
        (existing) => conflictColumn !== undefined && existing[conflictColumn] === row[conflictColumn],
      );
      if (index >= 0) {
        this.rows[index] = { ...this.rows[index], ...row };
        return { row: { ...this.rows[index] }, error: null };
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

// The unique constraints the real schema enforces (migration 0040) — the
// fake reproduces their 23505 behavior so the replay guards and the
// converged throughput tracker exercise end to end.
const FAKE_UNIQUES = {
  spatial_occupancy_tier_schedules: [
    { name: "spatial_occupancy_tier_schedules_venue_year_key", columns: ["venue_id", "year"] },
  ],
  spatial_overhead_policies: [
    { name: "spatial_overhead_policies_venue_year_key", columns: ["venue_id", "year"] },
  ],
  spatial_zone_assignments: [
    { name: "spatial_zone_assignments_venue_zone_key", columns: ["venue_id", "zone_code"] },
  ],
  spatial_micro_policies: [
    { name: "spatial_micro_policies_venue_zone_key", columns: ["venue_id", "zone_code"] },
  ],
  spatial_throughput_years: [
    { name: "spatial_throughput_years_venue_year_key", columns: ["venue_id", "year"] },
  ],
  spatial_royalty_applications: [
    { name: "spatial_royalty_applications_source_event_id_key", columns: ["source_event_id"] },
  ],
  spatial_zone_allocations: [
    { name: "spatial_zone_allocations_source_event_id_key", columns: ["source_event_id"] },
  ],
  spatial_micro_royalty_ledger: [
    { name: "spatial_micro_royalty_ledger_source_event_id_key", columns: ["source_event_id"] },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const YEAR = "2026";
const VENUE = "venue-parity-orbit";
const VENUE_B = "venue-parity-nova";
const ZONE = "ORBIT";
const OWNER = "ip-owner-parity";
const FOUNDER_BANDS = [
  { up_to: 500_000, royalty_bps: 500 },
  { up_to: 1_000_000, royalty_bps: 650 },
  { up_to: null, royalty_bps: 800 },
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
  // --- The occupancy tier schedule of record per (venue, year): upsert
  // replaces; unknown venues read undefined. ---
  await store.upsertSpatialOccupancyTierSchedule({
    venue_id: VENUE,
    year: YEAR,
    basis: "annual_throughput",
    bands: JSON.stringify(FOUNDER_BANDS),
  });
  expect(
    (await store.getSpatialOccupancyTierSchedule(VENUE, YEAR))?.basis,
  ).toBe("annual_throughput");
  expect(await store.getSpatialOccupancyTierSchedule(VENUE_B, YEAR)).toBeUndefined();
  await store.upsertSpatialOccupancyTierSchedule({
    venue_id: VENUE,
    year: YEAR,
    basis: "footprint_sqft",
    bands: JSON.stringify([{ up_to: 100_000, royalty_bps: 400 }, { up_to: null, royalty_bps: 700 }]),
  });
  const schedule = await store.getSpatialOccupancyTierSchedule(VENUE, YEAR);
  expect(schedule?.basis).toBe("footprint_sqft");
  expect(JSON.parse(schedule?.bands ?? "[]")).toHaveLength(2);

  // --- The shared facility overhead policy of record per (venue, year):
  // the three park-wide bps legs replace as one row. ---
  await store.upsertSpatialOverheadPolicy({
    venue_id: VENUE,
    year: YEAR,
    security_bps: 125,
    wristband_maintenance_bps: 75,
    ticketing_platform_bps: 50,
  });
  expect((await store.getSpatialOverheadPolicy(VENUE, YEAR))?.security_bps).toBe(125);
  expect(await store.getSpatialOverheadPolicy(VENUE_B, YEAR)).toBeUndefined();
  await store.upsertSpatialOverheadPolicy({
    venue_id: VENUE,
    year: YEAR,
    security_bps: 150,
    wristband_maintenance_bps: 80,
    ticketing_platform_bps: 60,
  });
  const overhead = await store.getSpatialOverheadPolicy(VENUE, YEAR);
  expect(overhead?.wristband_maintenance_bps).toBe(80);
  expect(overhead?.ticketing_platform_bps).toBe(60);

  // --- The assigned IP owner of record per (venue, zone): the newest
  // assignment governs the next walk. ---
  await store.upsertSpatialZoneAssignment({
    venue_id: VENUE,
    zone_code: ZONE,
    assigned_ip_owner_id: OWNER,
    royalty_bps: 300,
  });
  expect(
    (await store.getSpatialZoneAssignment(VENUE, ZONE))?.assigned_ip_owner_id,
  ).toBe(OWNER);
  expect(await store.getSpatialZoneAssignment(VENUE, "NOVA")).toBeUndefined();
  await store.upsertSpatialZoneAssignment({
    venue_id: VENUE,
    zone_code: ZONE,
    assigned_ip_owner_id: "ip-owner-parity-2",
    royalty_bps: 400,
  });
  const assignment = await store.getSpatialZoneAssignment(VENUE, ZONE);
  expect(assignment?.royalty_bps).toBe(400);
  expect(assignment?.assigned_ip_owner_id).toBe("ip-owner-parity-2");

  // --- The micro-royalty rate of record per (venue, zone): sub-cent unit
  // prices in statement micros. ---
  await store.upsertSpatialMicroPolicy({
    venue_id: VENUE,
    zone_code: ZONE,
    micros_per_dwell_minute: 1_400_000,
    micros_per_ride_session: 2_500_000,
  });
  expect((await store.getSpatialMicroPolicy(VENUE, ZONE))?.micros_per_dwell_minute).toBe(
    1_400_000,
  );
  expect(await store.getSpatialMicroPolicy(VENUE_B, ZONE)).toBeUndefined();
  await store.upsertSpatialMicroPolicy({
    venue_id: VENUE,
    zone_code: ZONE,
    micros_per_dwell_minute: 1_500_000,
    micros_per_ride_session: 2_600_000,
  });
  const microPolicy = await store.getSpatialMicroPolicy(VENUE, ZONE);
  expect(microPolicy?.micros_per_dwell_minute).toBe(1_500_000);
  expect(microPolicy?.micros_per_ride_session).toBe(2_600_000);

  // --- The cumulative annual throughput tracker: an advance ADDS
  // entries (converged upsert), the position reads before the walk, and
  // another venue's tracker stays at zero rows. ---
  await store.advanceSpatialThroughputYear(VENUE, YEAR, 400_000);
  expect(
    (await store.getSpatialThroughputYear(VENUE, YEAR))?.cumulative_entries,
  ).toBe(400_000);
  await store.advanceSpatialThroughputYear(VENUE, YEAR, 400_000);
  expect(
    (await store.getSpatialThroughputYear(VENUE, YEAR))?.cumulative_entries,
  ).toBe(800_000);
  expect(await store.getSpatialThroughputYear(VENUE_B, YEAR)).toBeUndefined();

  // --- The occupancy royalty application ledger: the founder-math paid
  // row (the TS-1 legs from the lane test), its replay guard, and the
  // negative-net hold with zeroed money legs. ---
  await store.insertSpatialRoyaltyApplication({
    source_event_id: "spatial:turnstile:venue-parity-orbit:ORBIT:2026-03:TS-PARITY-1",
    sender: "turnstile",
    venue_id: VENUE,
    zone_code: ZONE,
    spatial_footprint_sqft: 120_000,
    period: "2026-03",
    ticket_revenue_cents: 100_000_000,
    merch_revenue_cents: 50_000_000,
    gross_revenue_cents: 150_000_000,
    occupancy_tax_cents: 6_000_000,
    infrastructure_cogs_cents: 9_000_000,
    group_tour_discount_cents: 2_000_000,
    net_spatial_licensed_revenue_cents: 133_000_000,
    overhead_security_cents: 1_662_500,
    overhead_wristband_cents: 997_500,
    overhead_ticketing_cents: 665_000,
    overhead_total_cents: 3_325_000,
    royalty_basis_cents: 129_675_000,
    tier_basis: "annual_throughput",
    tier_schedule_ref: "schedule-of-record",
    tier_legs: JSON.stringify([
      { band_from: 0, band_to: 500_000, band_rate_bps: 500, band_basis_cents: 129_675_000, band_entries: 400_000, band_royalty_cents: 6_483_750 },
    ]),
    entries_count: 400_000,
    entries_before: 0,
    entries_after: 400_000,
    occupancy_royalty_cents: 6_483_750,
    verdict: "paid",
  });
  const application = await store.getSpatialRoyaltyApplication(
    "spatial:turnstile:venue-parity-orbit:ORBIT:2026-03:TS-PARITY-1",
  );
  expect(application?.net_spatial_licensed_revenue_cents).toBe(133_000_000);
  expect(application?.occupancy_royalty_cents).toBe(6_483_750);
  expect(await store.getSpatialRoyaltyApplication("spatial:missing")).toBeUndefined();
  let applicationReplayThrew: unknown;
  try {
    await store.insertSpatialRoyaltyApplication({
      source_event_id: "spatial:turnstile:venue-parity-orbit:ORBIT:2026-03:TS-PARITY-1",
      sender: "turnstile",
      venue_id: VENUE,
      zone_code: ZONE,
      spatial_footprint_sqft: 120_000,
      period: "2026-03",
      ticket_revenue_cents: 1,
      merch_revenue_cents: 1,
      gross_revenue_cents: 2,
      occupancy_tax_cents: 0,
      infrastructure_cogs_cents: 0,
      group_tour_discount_cents: 0,
      net_spatial_licensed_revenue_cents: 2,
      overhead_security_cents: 0,
      overhead_wristband_cents: 0,
      overhead_ticketing_cents: 0,
      overhead_total_cents: 0,
      royalty_basis_cents: 2,
      tier_basis: "annual_throughput",
      tier_schedule_ref: null,
      tier_legs: "[]",
      entries_count: 0,
      entries_before: null,
      entries_after: null,
      occupancy_royalty_cents: 0,
      verdict: "paid",
    });
  } catch (error) {
    applicationReplayThrew = error;
  }
  expectUniqueViolation(applicationReplayThrew);
  expect(
    (await store.getSpatialRoyaltyApplication(
      "spatial:turnstile:venue-parity-orbit:ORBIT:2026-03:TS-PARITY-1",
    ))?.net_spatial_licensed_revenue_cents,
  ).toBe(133_000_000);

  // The held row: the math recorded visible, the money legs zeroed, no
  // royalty — the hold IS the record.
  await store.insertSpatialRoyaltyApplication({
    source_event_id: "spatial:turnstile:venue-parity-orbit:ORBIT:2026-07:TS-PARITY-HOLD",
    sender: "turnstile",
    venue_id: VENUE,
    zone_code: ZONE,
    spatial_footprint_sqft: 120_000,
    period: "2026-07",
    ticket_revenue_cents: 10_000,
    merch_revenue_cents: 5_000,
    gross_revenue_cents: 15_000,
    occupancy_tax_cents: 6_000,
    infrastructure_cogs_cents: 9_000,
    group_tour_discount_cents: 2_000,
    net_spatial_licensed_revenue_cents: -2_000,
    overhead_security_cents: 0,
    overhead_wristband_cents: 0,
    overhead_ticketing_cents: 0,
    overhead_total_cents: 0,
    royalty_basis_cents: 0,
    tier_basis: "annual_throughput",
    tier_schedule_ref: null,
    tier_legs: "[]",
    entries_count: 5_000,
    entries_before: null,
    entries_after: null,
    occupancy_royalty_cents: 0,
    verdict: "held_negative_net",
  });
  const held = await store.getSpatialRoyaltyApplication(
    "spatial:turnstile:venue-parity-orbit:ORBIT:2026-07:TS-PARITY-HOLD",
  );
  expect(held?.verdict).toBe("held_negative_net");
  expect(held?.net_spatial_licensed_revenue_cents).toBe(-2_000);
  expect(held?.overhead_total_cents).toBe(0);
  expect(held?.occupancy_royalty_cents).toBe(0);

  // --- The zone allocation ledger: overhead-first routing to the
  // assigned IP owner, guarded by its event id. ---
  await store.insertSpatialZoneAllocation({
    source_event_id: "spatial:fnb:venue-parity-orbit:NOVA:2026-05:FB-PARITY-1",
    row_class: "fnb",
    venue_id: VENUE,
    zone_code: "NOVA",
    period: "2026-05",
    gross_cents: 800_000,
    overhead_security_cents: 100_000,
    overhead_wristband_cents: 60_000,
    overhead_ticketing_cents: 40_000,
    overhead_total_cents: 200_000,
    allocated_basis_cents: 600_000,
    assigned_ip_owner_id: OWNER,
    royalty_bps: 300,
    royalty_cents: 18_000,
  });
  const allocation = await store.getSpatialZoneAllocation(
    "spatial:fnb:venue-parity-orbit:NOVA:2026-05:FB-PARITY-1",
  );
  expect(allocation?.allocated_basis_cents).toBe(600_000);
  expect(allocation?.royalty_cents).toBe(18_000);
  expect(await store.getSpatialZoneAllocation("spatial:missing")).toBeUndefined();
  let allocationReplayThrew: unknown;
  try {
    await store.insertSpatialZoneAllocation({
      source_event_id: "spatial:fnb:venue-parity-orbit:NOVA:2026-05:FB-PARITY-1",
      row_class: "fnb",
      venue_id: VENUE,
      zone_code: "NOVA",
      period: "2026-05",
      gross_cents: 1,
      overhead_security_cents: 0,
      overhead_wristband_cents: 0,
      overhead_ticketing_cents: 0,
      overhead_total_cents: 0,
      allocated_basis_cents: 1,
      assigned_ip_owner_id: OWNER,
      royalty_bps: 300,
      royalty_cents: 0,
    });
  } catch (error) {
    allocationReplayThrew = error;
  }
  expectUniqueViolation(allocationReplayThrew);
  expect(
    (await store.getSpatialZoneAllocation(
      "spatial:fnb:venue-parity-orbit:NOVA:2026-05:FB-PARITY-1",
    ))?.royalty_cents,
  ).toBe(18_000);

  // --- The micro-royalty ledger: the dwell/session legs and the exact
  // unit-price math pinned, guarded by its event id. ---
  await store.insertSpatialMicroRoyalty({
    source_event_id: "spatial:rfid:venue-parity-orbit:NOVA:2026-05:WB-PARITY-1",
    venue_id: VENUE,
    zone_code: "NOVA",
    wristband_id: "wb-parity",
    sensor_id: "sensor-parity",
    period: "2026-05",
    dwell_minutes: 45,
    ride_sessions: 2,
    micros_per_dwell_minute: 1_400_000,
    micros_per_ride_session: 2_500_000,
    dwell_royalty_micros: 63_000_000,
    session_royalty_micros: 5_000_000,
    total_royalty_micros: 68_000_000,
    royalty_cents: 68,
  });
  const microRoyalty = await store.getSpatialMicroRoyalty(
    "spatial:rfid:venue-parity-orbit:NOVA:2026-05:WB-PARITY-1",
  );
  expect(microRoyalty?.total_royalty_micros).toBe(68_000_000);
  expect(microRoyalty?.royalty_cents).toBe(68);
  expect(await store.getSpatialMicroRoyalty("spatial:missing")).toBeUndefined();
  let microReplayThrew: unknown;
  try {
    await store.insertSpatialMicroRoyalty({
      source_event_id: "spatial:rfid:venue-parity-orbit:NOVA:2026-05:WB-PARITY-1",
      venue_id: VENUE,
      zone_code: "NOVA",
      wristband_id: "wb-parity",
      sensor_id: "sensor-parity",
      period: "2026-05",
      dwell_minutes: 1,
      ride_sessions: 0,
      micros_per_dwell_minute: 1_400_000,
      micros_per_ride_session: 2_500_000,
      dwell_royalty_micros: 1_400_000,
      session_royalty_micros: 0,
      total_royalty_micros: 1_400_000,
      royalty_cents: 1,
    });
  } catch (error) {
    microReplayThrew = error;
  }
  expectUniqueViolation(microReplayThrew);
  expect(
    (await store.getSpatialMicroRoyalty(
      "spatial:rfid:venue-parity-orbit:NOVA:2026-05:WB-PARITY-1",
    ))?.total_royalty_micros,
  ).toBe(68_000_000);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the spatial methods touch;
    // the real SupabaseClient surface is far larger than the store
    // touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("spatial POS + occupancy royalties + zone allocation — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the schedules, policies, assignments, throughput tracker, and the three replay-guarded ledgers identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
