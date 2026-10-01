// Film multi-territory withholding + cross-collateralization firewall
// (migration 0023, PR 18) — three-backend parity for the withholding log and
// the territory envelopes, mirroring the film-waterfall parity pattern: the
// same scenario script runs on InMemoryStore, SqliteStore (:memory:), and
// SupabaseStore over a behavioral PostgREST fake.
//
// Under test: one withholding log per line (unique on the content-derived
// match_queue event — a replayed line refuses, the caller recovers by
// reading), the full source-micros + base-cents row round-trip (SQLite
// packs the flags as 0/1 integers and keeps the micros discipline as TEXT),
// per-film listing oldest first with created_at ties broken by insertion
// order; territory envelopes unique per (released receipt, territory) — a
// duplicate envelope refuses on every backend while a second territory on
// the same receipt stays open (the partition is per-territory, not per-
// receipt) — with the CAMA override flag and cross-applications JSON
// round-tripping intact, the routed → applied transition, deletion (the
// retry path), and the deterministic listings the per-territory paid fold
// and the per-receipt crash repair read.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type {
  FilmTerritoryDistributionRecord,
  FilmTerritoryWithholdingRecord,
} from "@/modules/don/records";
import type { WaterfallLegRouting } from "@/modules/waterfall/engine";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — eq filters, ordered select, guarded update returning,
// upsert-on-conflict, delete, and per-table unique COLUMN SETS surfaced as
// PostgREST 23505 error envelopes. A set is one constraint: every column in
// the set must match an existing row for the insert to refuse (the composite
// (escrow_ledger_id, territory_code) pair needs that — a single-column
// unique would wrongly refuse the second territory on the same receipt).
// ---------------------------------------------------------------------------

/** Unique column SETS the real schema enforces (migration 0023). */
const UNIQUE_COLUMN_SETS: Record<string, string[][]> = {
  film_territory_withholdings: [["event_id"]],
  film_territory_distributions: [["escrow_ledger_id", "territory_code"]],
};

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniqueColumnSets: string[][]) {}

  insert(row: Row): Row | null {
    for (const set of this.uniqueColumnSets) {
      const values = set.map((column) => row[column]);
      if (values.some((value) => value === undefined)) continue;
      const clash = this.rows.some((existing) =>
        set.every((column, index) => existing[column] === values[index]),
      );
      if (clash) return null; // unique violation — surfaced as an error envelope
    }
    // The generated insertion_order column the real table carries.
    const stored = {
      insertion_order: ++this.sequence,
      ...row,
    };
    this.rows.push(stored);
    return { ...stored };
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
    | { kind: "update"; patch: Row }
    | { kind: "delete" }
    | { kind: "select" } = { kind: "select" };

  constructor(private readonly table: FakeTable) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
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
            message: 'duplicate key value violates unique constraint "film_territory"',
            code: "23505",
          },
        };
      }
      return { data: inserted, error: null };
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
      t = new FakeTable(UNIQUE_COLUMN_SETS[table] ?? []);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// ---------------------------------------------------------------------------
// The shared scenario fixtures.
// ---------------------------------------------------------------------------

const T0 = "2026-10-01T12:00:00.000Z";
const T1 = "2026-10-01T12:00:01.000Z";
const T2 = "2026-10-01T12:00:02.000Z";
const FILM = "film-77";
const OTHER_FILM = "film-other";
const BASE = "USD";

/** A withheld line: €100.00 gross at a 25% treaty rate, €25.00 withheld. */
function withheldRow(eventId: string, filmId: string, at: string): Omit<FilmTerritoryWithholdingRecord, "id"> {
  return {
    event_id: eventId,
    film_id: filmId,
    territory_code: "FR",
    foreign_tax_withheld: true,
    withholding_rate_bps: 2500,
    rate_table_version: "treaty-2026-v1",
    source_currency: "EUR",
    gross_source_micros: "100000000",
    withheld_source_micros: "25000000",
    net_source_micros: "75000000",
    base_currency: BASE,
    fx_rate_micros: 1080000,
    gross_base_cents: 10_800,
    withheld_base_cents: 2_700,
    net_base_cents: 8_100,
    created_at: at,
  };
}

/** An unwithheld line: the same gross, zero withholding everywhere. */
function unwithheldRow(eventId: string, filmId: string, at: string): Omit<FilmTerritoryWithholdingRecord, "id"> {
  return {
    ...withheldRow(eventId, filmId, at),
    foreign_tax_withheld: false,
    withholding_rate_bps: 0,
    rate_table_version: null,
    withheld_source_micros: "0",
    withheld_base_cents: 0,
    net_source_micros: "100000000",
    net_base_cents: 10_800,
  };
}

/** A period-1-shaped per-territory routing: the commission took $20, the P&A cap $75. */
function territoryLegs(): WaterfallLegRouting[] {
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

function envelopeRow(
  escrowLedgerId: string,
  territory: string,
  at: string,
  overrides: Partial<Omit<FilmTerritoryDistributionRecord, "id">> = {},
): Omit<FilmTerritoryDistributionRecord, "id"> {
  return {
    film_id: FILM,
    escrow_ledger_id: escrowLedgerId,
    territory_code: territory,
    status: "routed",
    fdg_bypass_cents: 500,
    legs: territoryLegs(),
    tier_allocations: [{ tier_level: 0, amount_cents: 9_500 }],
    unpaid_total_cents: 88_500,
    cross_collateralization_permitted: false,
    cross_applications: null,
    created_at: at,
    ...overrides,
  };
}

async function scenario(store: Store): Promise<void> {
  // --- Withholding log: write, round-trip, unique per line, per-film list ---
  expect(await store.getFilmTerritoryWithholdingByEventId("evt-wh-1")).toBeUndefined();

  const wh = await store.insertFilmTerritoryWithholding(withheldRow("evt-wh-1", FILM, T1));
  expect(wh.id).toBeTruthy();
  // The full row round-trips — the foreign-tax-credit evidence is exact:
  // source micros as TEXT, the pinned rate and rate-table version, and all
  // three base-cents columns (the escrow posts only the net).
  expect(await store.getFilmTerritoryWithholdingByEventId("evt-wh-1")).toEqual(wh);

  // One withholding log per line, ever — the UNIQUE contract refuses the
  // replayed line on every backend (the caller recovers by reading).
  await expect(
    store.insertFilmTerritoryWithholding(withheldRow("evt-wh-1", FILM, T1)),
  ).rejects.toThrow();
  expect(await store.getFilmTerritoryWithholdingByEventId("evt-never-ingested")).toBeUndefined();

  // An unwithheld line logs too — zero rate, null version, zero withheld —
  // the audit row exists either way (the flag as carried, not inferred).
  const whUnwithheld = await store.insertFilmTerritoryWithholding(
    unwithheldRow("evt-wh-2", FILM, T2),
  );
  expect(whUnwithheld.foreign_tax_withheld).toBe(false);
  expect(whUnwithheld.withholding_rate_bps).toBe(0);
  expect(whUnwithheld.rate_table_version).toBeNull();

  // Another film's log lines never leak into this film's report.
  await store.insertFilmTerritoryWithholding(withheldRow("evt-wh-other", OTHER_FILM, T0));

  // created_at ties break by insertion order — the log's order.
  const tiedA = await store.insertFilmTerritoryWithholding(withheldRow("evt-wh-3", FILM, T0));
  const tiedB = await store.insertFilmTerritoryWithholding(unwithheldRow("evt-wh-4", FILM, T0));
  const listed = await store.listFilmTerritoryWithholdingsByFilm(FILM);
  expect(listed.map((row) => row.id)).toEqual([tiedA.id, tiedB.id, wh.id, whUnwithheld.id]);
  expect((await store.listFilmTerritoryWithholdingsByFilm(OTHER_FILM)).map((r) => r.event_id)).toEqual([
    "evt-wh-other",
  ]);

  // --- Territory envelopes: partition, unique pair, transition, delete ---
  const fr = await store.insertFilmTerritoryDistribution(
    envelopeRow("escrow-1", "FR", T1),
  );
  expect(fr.id).toBeTruthy();
  expect(fr.status).toBe("routed");

  const de = await store.insertFilmTerritoryDistribution(
    envelopeRow("escrow-1", "DE", T1),
  );
  // A second territory on the SAME receipt is a new envelope, not a
  // duplicate — the partition is per-territory.
  expect(de.id).not.toBe(fr.id);

  const second = await store.insertFilmTerritoryDistribution(
    envelopeRow("escrow-2", "FR", T2),
  );

  // One routing decision per released receipt per territory, ever — the
  // UNIQUE pair refuses the duplicate on every backend.
  await expect(
    store.insertFilmTerritoryDistribution(envelopeRow("escrow-1", "FR", T1)),
  ).rejects.toThrow();

  // Per-receipt lookup (crash repair / replay guard): territory_code ASC.
  const byEscrow = await store.listFilmTerritoryDistributionsByEscrow("escrow-1");
  expect(byEscrow.map((row) => row.territory_code)).toEqual(["DE", "FR"]);
  expect(await store.listFilmTerritoryDistributionsByEscrow("escrow-never-routed")).toEqual([]);

  // The CAMA override state round-trips: the default-deny shape (flag false,
  // applications null) and the explicit override with its audit array.
  const cama = await store.insertFilmTerritoryDistribution(
    envelopeRow("escrow-3", "DE", T2, {
      cross_collateralization_permitted: true,
      cross_applications: [
        {
          debtor_territory: "DE",
          creditor_territory: "FR",
          debtor_leg_id: "pa-cap",
          applied_cents: 1_500,
        },
      ],
      unpaid_total_cents: 87_000,
    }),
  );
  expect(cama.cross_collateralization_permitted).toBe(true);
  expect(cama.cross_applications).toHaveLength(1);
  expect(
    (await store.getFilmTerritoryWithholdingByEventId("evt-wh-1")) !== undefined,
  ).toBe(true);
  const camaReread = (
    await store.listFilmTerritoryDistributionsByEscrow("escrow-3")
  )[0];
  expect(camaReread).toEqual(cama);

  // created_at ties break by insertion order; another film's rows never
  // appear. tiedA/tiedB share T0 with fr/de (T1) after them.
  const tiedEnvA = await store.insertFilmTerritoryDistribution(
    envelopeRow("escrow-4", "FR", T0),
  );
  const tiedEnvB = await store.insertFilmTerritoryDistribution(
    envelopeRow("escrow-5", "DE", T0),
  );
  const otherFilmEnv = await store.insertFilmTerritoryDistribution({
    ...envelopeRow("escrow-6", "FR", T0),
    film_id: OTHER_FILM,
    unpaid_total_cents: 12_345,
  });

  const listedByFilm = await store.listFilmTerritoryDistributionsByFilm(FILM);
  expect(listedByFilm.map((row) => row.id)).toEqual([
    tiedEnvA.id,
    tiedEnvB.id,
    fr.id,
    de.id,
    second.id,
    cama.id,
  ]);
  expect((await store.listFilmTerritoryDistributionsByFilm(OTHER_FILM)).map((r) => r.id)).toEqual([
    otherFilmEnv.id,
  ]);

  // The transition routed → applied flips only the named row; unknown ids
  // read undefined.
  const applied = await store.updateFilmTerritoryDistributionStatus(fr.id, "applied");
  expect(applied?.status).toBe("applied");
  expect(await store.updateFilmTerritoryDistributionStatus("missing", "applied")).toBeUndefined();

  // Deletion — the retry path erases the unapplied envelope; the
  // per-territory paid sums never see it.
  await store.deleteFilmTerritoryDistribution(tiedEnvA.id);
  expect(await store.listFilmTerritoryDistributionsByEscrow("escrow-4")).toEqual([]);
  expect((await store.listFilmTerritoryDistributionsByFilm(FILM)).map((row) => row.id)).toEqual([
    tiedEnvB.id,
    fr.id,
    de.id,
    second.id,
    cama.id,
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
    // The fake implements the builder subset the territory methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("film territory withholding + firewall — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("logs one withholding per line, keeps one envelope per receipt per territory, transitions and lists applied-ordered rows, and round-trips the CAMA state", async () => {
        await scenario(backend.make());
      });
    });
  }
});
