// Merchandise returns reserve (PR 23) — three-backend parity for the new
// store methods, mirroring the unclaimed-holding parity pattern: the same
// scenario script runs on InMemoryStore, SqliteStore (:memory:), and
// SupabaseStore over a behavioral PostgREST fake.
//
// Under test: the policy-of-record upsert/get, the fulfillment-tracking
// ledger with its replay-guard unique, the position-locked drawdown ledger
// with its two uniques (replay + position), the held-reserve credit listing
// (kind AND status = 'merch_returns_reserve' — settled rows, royalty rows,
// and unclaimed-holding rows never appear; newest first; limit), and the
// compare-and-set reserve settlement (one winner; the loser and unknown ids
// read undefined).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import { merchReturnsReservePayeeId, merchReturnsReservePayeeName } from "@/modules/don/constants";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — eq filters, ordered select, guarded update returning,
// upsert-on-conflict, and behavioral unique constraints (the 23505 shape).
// ---------------------------------------------------------------------------

type UniqueConstraint = {
  /** Human name, surfaced in the violation message. */
  name: string;
  /** The column tuple that must be unique across rows. */
  columns: string[];
};

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniques: UniqueConstraint[] = []) {}

  /**
   * Behavioral uniqueness: an insert violating any constraint returns the
   * Postgres unique_violation error shape instead of storing — the exact
   * 23505 surface the store's replay guards detect.
   */
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
    // The generated insertion_order column the real tables carry.
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
      // PostgREST semantics: the WHERE clause (id + status guard) picks the
      // targets and is NOT re-applied to the returning snapshot — an empty
      // result means the guarded transition matched nothing (the CAS lost),
      // surfacing as data:null.
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

// The unique constraints the real schema enforces — the fake reproduces
// their 23505 behavior so the replay guards exercise end to end.
const FAKE_UNIQUES = {
  merch_return_reserve_policies: [
    { name: "merch_return_reserve_policies_sku_id_key", columns: ["sku_id"] },
  ],
  merch_fulfillment_trackings: [
    {
      name: "merch_fulfillment_trackings_event_number_state_key",
      columns: ["fulfillment_event_id", "tracking_number", "tracking_state"],
    },
  ],
  merch_reserve_drawdowns: [
    {
      name: "merch_reserve_drawdowns_event_source_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "merch_reserve_drawdowns_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-09-30T12:00:00.000Z";
const T1 = "2026-09-30T12:00:01.000Z";
const T2 = "2026-09-30T12:00:02.000Z";
const SKU_A = "sku-alpha";
const SKU_B = "sku-beta";

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
  // --- The policy of record: upsert targets sku_id; a re-registration
  // replaces the row atomically; an unknown sku reads undefined. ---
  const policyA = await store.upsertMerchReturnReservePolicy({
    sku_id: SKU_A,
    reserve_rate_bps: 1_200,
    reserve_window_days: 30,
    beneficiary_payee_id: "creator_alpha",
    beneficiary_payee_name: "Creator Alpha",
    created_at: T0,
    updated_at: T0,
  });
  expect(policyA.reserve_rate_bps).toBe(1_200);
  expect((await store.getMerchReturnReservePolicy(SKU_A))?.reserve_window_days).toBe(30);
  expect(await store.getMerchReturnReservePolicy("sku-unknown")).toBeUndefined();

  const replaced = await store.upsertMerchReturnReservePolicy({
    sku_id: SKU_A,
    reserve_rate_bps: 1_500,
    reserve_window_days: 60,
    beneficiary_payee_id: "creator_alpha",
    beneficiary_payee_name: "Creator Alpha",
    created_at: T0,
    updated_at: T1,
  });
  expect(replaced.reserve_rate_bps).toBe(1_500);
  const reread = await store.getMerchReturnReservePolicy(SKU_A);
  expect(reread?.reserve_rate_bps).toBe(1_500);
  expect(reread?.reserve_window_days).toBe(60);
  // Exactly one policy row of record per sku.
  await store.upsertMerchReturnReservePolicy({
    sku_id: SKU_B,
    reserve_rate_bps: 1_000,
    reserve_window_days: 45,
    beneficiary_payee_id: "creator_beta",
    beneficiary_payee_name: "Creator Beta",
    created_at: T0,
    updated_at: T0,
  });
  expect((await store.getMerchReturnReservePolicy(SKU_B))?.reserve_rate_bps).toBe(1_000);

  // --- The fulfillment tracking ledger: lifecycle rows keyed on the
  // fulfillment event, oldest first; the replay guard rejects the
  // re-shipped event with the 23505 shape. ---
  await store.insertMerchFulfillmentTracking({
    fulfillment_event_id: "fe-1",
    tracking_number: "1Z999AA10123456784",
    tracking_state: "assigned",
    carrier: "UPS",
    delivered_at: null,
    created_at: T0,
  });
  await store.insertMerchFulfillmentTracking({
    fulfillment_event_id: "fe-1",
    tracking_number: "1Z999AA10123456784",
    tracking_state: "in_transit",
    carrier: "UPS",
    delivered_at: null,
    created_at: T1,
  });
  await store.insertMerchFulfillmentTracking({
    fulfillment_event_id: "fe-1",
    tracking_number: "1Z999AA10123456784",
    tracking_state: "delivered",
    carrier: "UPS",
    delivered_at: T2,
    created_at: T2,
  });
  const trackings = await store.listMerchFulfillmentTrackings("fe-1");
  expect(trackings.map((t) => t.tracking_state)).toEqual(["assigned", "in_transit", "delivered"]);
  expect(trackings[2]?.delivered_at).toBe(T2);
  // Other fulfillment events stay isolated.
  expect(await store.listMerchFulfillmentTrackings("fe-other")).toEqual([]);
  // The replay guard — a re-shipped tracking event is the unique violation.
  let trackingThrew: unknown;
  try {
    await store.insertMerchFulfillmentTracking({
      fulfillment_event_id: "fe-1",
      tracking_number: "1Z999AA10123456784",
      tracking_state: "delivered",
      carrier: "UPS",
      delivered_at: T2,
      created_at: T2,
    });
  } catch (error) {
    trackingThrew = error;
  }
  expectUniqueViolation(trackingThrew);
  expect((await store.listMerchFulfillmentTrackings("fe-1")).length).toBe(3);

  // --- The held-reserve credit listing: kind AND status filters (a settled
  // reserve, an ordinary royalty row, and an unclaimed-holding row never
  // appear), newest first, limit honored. ---
  const olderReserve = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "fe-1",
    payee_id: merchReturnsReservePayeeId(SKU_A),
    payee_name: merchReturnsReservePayeeName(SKU_A),
    role: "other",
    share_bps: 0,
    amount_cents: 12_000,
    currency: "USD",
    status: "merch_returns_reserve",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0,
    settled_at: null,
    kind: "merch_returns_reserve",
  });
  const newerReserve = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "fe-2",
    payee_id: merchReturnsReservePayeeId(SKU_B),
    payee_name: merchReturnsReservePayeeName(SKU_B),
    role: "other",
    share_bps: 0,
    amount_cents: 15_000,
    currency: "USD",
    status: "merch_returns_reserve",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "merch_returns_reserve",
  });
  const settledReserve = await store.insertLedgerTransaction({
    ...({
      split_run_id: "",
      line_item_id: "fe-3",
      payee_id: merchReturnsReservePayeeId(SKU_A),
      payee_name: merchReturnsReservePayeeName(SKU_A),
      role: "other",
      share_bps: 0,
      amount_cents: 9_999,
      currency: "USD",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0,
      settled_at: null,
    } as Omit<LedgerTransactionRecord, "id" | "status" | "kind">),
    status: "settled",
    kind: "merch_returns_reserve",
  });
  await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "line-decoy",
    payee_id: "creator_x",
    payee_name: "Creator X",
    role: "creator",
    share_bps: 10_000,
    amount_cents: 7_777,
    currency: "USD",
    status: "pending_settlement",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0,
    settled_at: null,
    kind: "royalty",
  });
  await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "line-decoy-2",
    payee_id: "merch_unclaimed_holding",
    payee_name: "Merch Unclaimed Holding",
    role: "other",
    share_bps: 0,
    amount_cents: 5_555,
    currency: "USD",
    status: "unclaimed_holding",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0,
    settled_at: null,
    kind: "unclaimed_holding",
  });

  expect((await store.listMerchReturnsReserveCredits()).map((r) => r.id)).toEqual([
    newerReserve.id,
    olderReserve.id,
  ]);
  expect((await store.listMerchReturnsReserveCredits(1)).map((r) => r.id)).toEqual([
    newerReserve.id,
  ]);
  expect((await store.listMerchReturnsReserveCredits()).map((r) => r.id)).not.toContain(
    settledReserve.id,
  );

  // --- The drawdown ledger: position-locked rows, ordered by position; the
  // replay guard AND the position arbiter both enforce 23505. ---
  const first = await store.insertMerchReserveDrawdown({
    reserve_ledger_id: olderReserve.id,
    drawdown_class: "customer_return",
    source_event_id: "return-1",
    drawn_before_cents: 0,
    drawn_cents: 4_500,
    remaining_cents: 7_500,
    created_at: T1,
  });
  expect(first.drawn_before_cents).toBe(0);
  const second = await store.insertMerchReserveDrawdown({
    reserve_ledger_id: olderReserve.id,
    drawdown_class: "chargeback",
    source_event_id: "cb-1",
    drawn_before_cents: 4_500,
    drawn_cents: 2_500,
    remaining_cents: 5_000,
    created_at: T2,
  });
  expect((await store.listMerchReserveDrawdowns(olderReserve.id)).map((d) => d.source_event_id)).toEqual([
    "return-1",
    "cb-1",
  ]);
  expect(second.remaining_cents).toBe(5_000);

  let replayThrew: unknown;
  try {
    await store.insertMerchReserveDrawdown({
      reserve_ledger_id: olderReserve.id,
      drawdown_class: "customer_return",
      source_event_id: "return-1",
      drawn_before_cents: 7_000,
      drawn_cents: 1_000,
      remaining_cents: 4_000,
      created_at: T2,
    });
  } catch (error) {
    replayThrew = error;
  }
  expectUniqueViolation(replayThrew);

  // The position arbiter: a SECOND draw claiming the same 4,500 position
  // under a fresh source event is the collision the position unique exists
  // to stop — the module's recompute-retry path catches the 23505.
  let positionThrew: unknown;
  try {
    await store.insertMerchReserveDrawdown({
      reserve_ledger_id: olderReserve.id,
      drawdown_class: "customer_return",
      source_event_id: "return-2",
      drawn_before_cents: 4_500,
      drawn_cents: 1_000,
      remaining_cents: 4_000,
      created_at: T2,
    });
  } catch (error) {
    positionThrew = error;
  }
  expectUniqueViolation(positionThrew);
  expect((await store.listMerchReserveDrawdowns(olderReserve.id)).length).toBe(2);

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleMerchReturnsReserve(olderReserve.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(settled?.kind).toBe("merch_returns_reserve");
  expect(await store.settleMerchReturnsReserve(olderReserve.id, T2)).toBeUndefined();
  expect(await store.settleMerchReturnsReserve("missing", T2)).toBeUndefined();

  // The settled reserve left the held listing; the untouched one remains.
  expect((await store.listMerchReturnsReserveCredits()).map((r) => r.id)).toEqual([
    newerReserve.id,
  ]);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the reserve methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("merch returns reserve — three-backend parity (verification row 5)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the policy upsert, tracking ledger, drawdown positions, held listing, and settle CAS identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
