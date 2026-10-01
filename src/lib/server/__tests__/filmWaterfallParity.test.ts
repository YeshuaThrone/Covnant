// The film waterfall engine (PR 8) — three-backend parity for the definition
// registry + per-receipt distribution records, mirroring the film-escrow
// parity pattern: the same scenario script runs on InMemoryStore,
// SqliteStore (:memory:), and SupabaseStore over a behavioral PostgREST fake.
//
// Under test: one definition per film asset (the upsert replaces atomically,
// full overwrite), full definition round-trip (SQLite carries the deal as
// JSON), per-receipt distribution records unique on escrow_ledger_id (a
// duplicate insert refuses on every backend — one routing decision per
// released receipt, ever), the status transition (routed → applied, unknown
// id → undefined), deletion (the retry path), and the oldest-first listing
// filtered by film with created_at ties broken by insertion order — the
// ordering the cumulative-paid fold depends on. The fold over the applied
// history reproduces the router's carry input (applied rows only).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { FilmWaterfallDefinitionRecord } from "@/modules/don/records";
import type { FilmWaterfallDefinition, WaterfallLegRouting } from "@/modules/waterfall/engine";
import { cumulativePaidFromDistributions } from "@/modules/waterfall/engine";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — eq filters, ordered select, guarded update returning,
// upsert-on-conflict, delete, and per-table unique constraints surfaced as
// PostgREST 23505 error envelopes.
// ---------------------------------------------------------------------------

/** Unique column sets the real schema enforces (migration 0016 + the ledger). */
const UNIQUE_COLUMNS: Record<string, string[]> = {
  film_waterfall_distributions: ["escrow_ledger_id"],
};

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniqueColumns: string[]) {}

  insert(row: Row): Row | null {
    for (const column of this.uniqueColumns) {
      const value = row[column];
      if (
        value !== undefined &&
        this.rows.some((existing) => existing[column] === value)
      ) {
        return null; // unique violation — surfaced as an error envelope
      }
    }
    // The generated insertion_order column the real table carries.
    const stored = {
      insertion_order: ++this.sequence,
      ...row,
    };
    this.rows.push(stored);
    return { ...stored };
  }

  upsert(row: Row, onConflict: string | undefined): Row {
    const conflictValue = onConflict === undefined ? undefined : row[onConflict];
    const index =
      conflictValue === undefined
        ? -1
        : this.rows.findIndex((existing) => existing[onConflict as string] === conflictValue);
    if (index >= 0) {
      // Postgres ON CONFLICT DO UPDATE: the row updates in place — its
      // insertion_order (physical position) survives.
      this.rows[index] = { ...this.rows[index], ...row };
      return { ...this.rows[index] };
    }
    return this.insert(row) ?? { ...row };
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

  deleteRows(filters: Array<[string, unknown]>): void {
    this.rows = this.rows.filter(
      (row) => !filters.every(([column, value]) => row[column] === value),
    );
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
  private operation:
    | { kind: "insert"; row: Row }
    | { kind: "upsert"; row: Row; onConflict?: string }
    | { kind: "update"; patch: Row }
    | { kind: "delete" }
    | { kind: "select" } = { kind: "select" };

  constructor(private readonly table: FakeTable) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
    return this;
  }

  upsert(row: Row, options?: { onConflict?: string }): this {
    this.operation = { kind: "upsert", row, onConflict: options?.onConflict };
    return this;
  }

  update(patch: Row): this {
    this.operation = { kind: "update", patch };
    return this;
  }

  delete(): this {
    this.operation = { kind: "delete" };
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
      const inserted = this.table.insert(op.row);
      if (inserted === null) {
        return {
          data: null,
          error: {
            message: 'duplicate key value violates unique constraint "escrow_ledger_id"',
            code: "23505",
          },
        };
      }
      return { data: inserted, error: null };
    }
    if (op.kind === "upsert") {
      return { data: this.table.upsert(op.row, op.onConflict), error: null };
    }
    if (op.kind === "update") {
      // PostgREST semantics: the WHERE clause picks the targets and is NOT
      // re-applied to the returning snapshot — an empty result means the
      // guarded transition matched nothing, surfacing as data:null.
      const updated = this.table.update(op.patch, this.filters);
      if (updated.length === 0) return { data: null, error: null };
      if (this.single) return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
    }
    if (op.kind === "delete") {
      this.table.deleteRows(this.filters);
      return { data: null, error: null };
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

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(UNIQUE_COLUMNS[table] ?? []);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-10-01T12:00:00.000Z";
const T1 = "2026-10-01T12:00:01.000Z";
const T2 = "2026-10-01T12:00:02.000Z";
const FILM = "film-77";
const OTHER_FILM = "film-other";

function deal(label: string): FilmWaterfallDefinition {
  return {
    film_id: FILM,
    label,
    tiers: [
      {
        tier_level: 0,
        label: "Off-the-top fees",
        legs: [
          {
            leg_id: "dist-fee",
            label: "Distribution commission (20%)",
            payee_id: "payee-distributor",
            payee_name: "Distribution Co",
            structure: { type: "per_receipt_bps", bps: 2000, cap_cents: null },
          },
          {
            leg_id: "pa-cap",
            label: "P&A marketing expense cap",
            payee_id: "payee-pa",
            payee_name: "P&A Lender",
            structure: { type: "fixed_obligation", obligation_cents: 50_000 },
          },
        ],
      },
      {
        tier_level: 1,
        label: "Senior debt & gap",
        legs: [
          {
            leg_id: "senior-debt",
            label: "Senior debt + gap (10% interest)",
            payee_id: "payee-bank",
            payee_name: "Senior Lender",
            structure: { type: "debt_recoupment", principal_cents: 10_000, interest_bps: 1000 },
          },
        ],
      },
      {
        tier_level: 2,
        label: "CAMA & guilds",
        legs: [
          {
            leg_id: "cama-fees",
            label: "CAMA collection account fees",
            payee_id: "payee-cama",
            payee_name: "CAMA Administrator",
            structure: { type: "fixed_obligation", obligation_cents: 5_000 },
          },
          {
            leg_id: "guild-residuals",
            label: "Guild residual compliance holds",
            payee_id: "payee-guilds",
            payee_name: "SAG-AFTRA / DGA / WGA",
            structure: { type: "fixed_obligation", obligation_cents: 3_000 },
          },
        ],
      },
      {
        tier_level: 3,
        label: "Equity recoupment",
        legs: [
          {
            leg_id: "equity",
            label: "Equity recoupment (115% preferred)",
            payee_id: "payee-equity",
            payee_name: "Equity Investors",
            structure: { type: "equity_recoupment", principal_cents: 20_000, preferred_return_bps: 1500 },
          },
        ],
      },
      {
        tier_level: 4,
        label: "Deferrals",
        legs: [
          {
            leg_id: "deferrals",
            label: "Deferred compensation",
            payee_id: "payee-deferrals",
            payee_name: "Deferred Crew",
            structure: { type: "fixed_obligation", obligation_cents: 4_000 },
          },
        ],
      },
      {
        tier_level: 5,
        label: "Net profit pool",
        legs: [
          {
            leg_id: "profit-pool",
            label: "Net profit pool",
            payee_id: "payee-pool",
            payee_name: "Producer / Investor pools",
            structure: { type: "profit_pool" },
          },
        ],
      },
    ],
    fdg: {
      participants: [
        { payee_id: "payee-actor", payee_name: "Lead Actor", role: "creator", share_bps: 500 },
      ],
      threshold_cents: null,
    },
  };
}

function definitionRow(
  filmId: string,
  at: string,
  label: string = "Standard film deal",
): FilmWaterfallDefinitionRecord {
  return { film_id: filmId, definition: { ...deal(label), film_id: filmId }, created_at: at, updated_at: at };
}

/** A period-1-shaped routing: the commission took $20, the P&A cap $75. */
function periodOneLegs(): WaterfallLegRouting[] {
  return [
    {
      tier_level: 0,
      leg_id: "dist-fee",
      label: "Distribution commission (20%)",
      payee_id: "payee-distributor",
      demand_cents: 2_000,
      routed_cents: 2_000,
      unpaid_cents: 0,
      cumulative_paid_cents: 0,
    },
    {
      tier_level: 0,
      leg_id: "pa-cap",
      label: "P&A marketing expense cap",
      payee_id: "payee-pa",
      demand_cents: 50_000,
      routed_cents: 7_500,
      unpaid_cents: 42_500,
      cumulative_paid_cents: 7_500,
    },
  ];
}

async function scenario(store: Store): Promise<void> {
  // --- Definitions: absent → registered → replaced → per-film isolation ---
  expect(await store.getFilmWaterfallDefinition(FILM)).toBeUndefined();

  const registered = await store.upsertFilmWaterfallDefinition(definitionRow(FILM, T0));
  expect(registered.film_id).toBe(FILM);
  expect(registered.definition.label).toBe("Standard film deal");
  // The full deal round-trips (SQLite carries it as JSON; the read must
  // reproduce the definition deep-equal).
  expect(await store.getFilmWaterfallDefinition(FILM)).toEqual(registered);

  // One definition per film asset — the upsert replaces atomically.
  const updated = await store.upsertFilmWaterfallDefinition(definitionRow(FILM, T1, "Revised deal"));
  expect(updated.definition.label).toBe("Revised deal");
  expect(await store.getFilmWaterfallDefinition(FILM)).toEqual(updated);
  expect((await store.getFilmWaterfallDefinition(FILM))?.definition.tiers).toHaveLength(6);

  // Another film's registration is independent.
  await store.upsertFilmWaterfallDefinition(definitionRow(OTHER_FILM, T0));
  expect((await store.getFilmWaterfallDefinition(FILM))?.definition.label).toBe("Revised deal");
  expect((await store.getFilmWaterfallDefinition(OTHER_FILM))?.definition.label).toBe(
    "Standard film deal",
  );

  // --- Distributions: insert, unique per escrow, transition, delete, list ---
  const first = await store.insertFilmWaterfallDistribution({
    film_id: FILM,
    escrow_ledger_id: "escrow-1",
    status: "routed",
    fdg_bypass_cents: 500,
    legs: periodOneLegs(),
    tier_allocations: [{ tier_level: 0, amount_cents: 9_500 }],
    unpaid_total_cents: 88_500,
    created_at: T1,
  });
  expect(first.id).toBeTruthy();
  expect(first.status).toBe("routed");

  const second = await store.insertFilmWaterfallDistribution({
    film_id: FILM,
    escrow_ledger_id: "escrow-2",
    status: "routed",
    fdg_bypass_cents: 500,
    legs: periodOneLegs(),
    tier_allocations: [{ tier_level: 0, amount_cents: 9_500 }],
    unpaid_total_cents: 81_000,
    created_at: T2,
  });

  // One routing decision per released receipt, ever — the UNIQUE contract
  // refuses the duplicate on every backend (the caller recovers by reading
  // the existing row through getFilmWaterfallDistributionByEscrow).
  await expect(
    store.insertFilmWaterfallDistribution({
      film_id: FILM,
      escrow_ledger_id: "escrow-1",
      status: "routed",
      fdg_bypass_cents: 500,
      legs: periodOneLegs(),
      tier_allocations: [],
      unpaid_total_cents: 88_500,
      created_at: T1,
    }),
  ).rejects.toThrow();

  // Lookup by escrow receipt: the released row is findable, unknown ids are
  // not.
  expect((await store.getFilmWaterfallDistributionByEscrow("escrow-2"))?.id).toBe(second.id);
  expect(await store.getFilmWaterfallDistributionByEscrow("escrow-never-routed")).toBeUndefined();

  // created_at ties break by insertion order — the fold's routing order.
  const tiedA = await store.insertFilmWaterfallDistribution({
    film_id: FILM,
    escrow_ledger_id: "escrow-3",
    status: "routed",
    fdg_bypass_cents: 0,
    legs: [],
    tier_allocations: [],
    unpaid_total_cents: 88_500,
    created_at: T0,
  });
  const tiedB = await store.insertFilmWaterfallDistribution({
    film_id: FILM,
    escrow_ledger_id: "escrow-4",
    status: "routed",
    fdg_bypass_cents: 0,
    legs: [],
    tier_allocations: [],
    unpaid_total_cents: 88_500,
    created_at: T0,
  });
  const otherFilmRow = await store.insertFilmWaterfallDistribution({
    film_id: OTHER_FILM,
    escrow_ledger_id: "escrow-5",
    status: "routed",
    fdg_bypass_cents: 0,
    legs: [],
    tier_allocations: [],
    unpaid_total_cents: 12_345,
    created_at: T0,
  });

  // Oldest first; another film's rows never appear.
  const listed = await store.listFilmWaterfallDistributions(FILM);
  expect(listed.map((row) => row.id)).toEqual([tiedA.id, tiedB.id, first.id, second.id]);
  expect(
    (await store.listFilmWaterfallDistributions(OTHER_FILM)).map((row) => row.id),
  ).toEqual([otherFilmRow.id]);

  // The transition routed → applied flips only the named row; unknown ids
  // read undefined.
  const applied = await store.updateFilmWaterfallDistributionStatus(first.id, "applied");
  expect(applied?.status).toBe("applied");
  expect(await store.updateFilmWaterfallDistributionStatus("missing", "applied")).toBeUndefined();

  // The router's carry input reproduces from the stored history: applied
  // rows only, per-leg routed sums. Only `first` is applied — the P&A cap
  // has recouped $75.00.
  const history = await store.listFilmWaterfallDistributions(FILM);
  const carry = cumulativePaidFromDistributions(history);
  expect(carry["pa-cap"]).toBe(7_500);
  expect(carry["dist-fee"]).toBe(2_000);

  // Flipping the second row moves the carry to two periods.
  await store.updateFilmWaterfallDistributionStatus(second.id, "applied");
  const carryAfterSecond = cumulativePaidFromDistributions(
    await store.listFilmWaterfallDistributions(FILM),
  );
  expect(carryAfterSecond["pa-cap"]).toBe(15_000);

  // Deletion — the retry path erases the unapplied decision.
  await store.deleteFilmWaterfallDistribution(tiedA.id);
  expect(await store.getFilmWaterfallDistributionByEscrow("escrow-3")).toBeUndefined();
  expect((await store.listFilmWaterfallDistributions(FILM)).map((row) => row.id)).toEqual([
    tiedB.id,
    first.id,
    second.id,
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
    // The fake implements the builder subset the waterfall methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("film waterfall engine — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("registers one definition per film, stores one routing decision per escrow receipt, transitions and lists applied-ordered rows, and reproduces the router's carry", async () => {
        await scenario(backend.make());
      });
    });
  }
});
