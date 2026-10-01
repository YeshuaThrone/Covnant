// Film waterfall escrow ledger states (PR 9) — three-backend parity for the
// escrow read + CAS-settle + gross-receipts store methods, mirroring the
// unclaimed-holding parity pattern: the same scenario script runs on
// InMemoryStore, SqliteStore (:memory:), and SupabaseStore over a behavioral
// PostgREST fake.
//
// Under test: the held-credit listing filters (payee prefix 'film_escrow:'
// AND kind AND status = 'escrow_waterfall_pending' — released rows, other
// films' rows, and ordinary royalty rows never appear), newest-first
// ordering, the limit, the compare-and-set settle (one winner; the loser and
// unknown ids read undefined), and the cumulative-gross sum counting every
// escrow receipt for the film — held AND settled — and never another film's.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  filmEscrowPayeeId,
  filmEscrowPayeeName,
} from "@/modules/don/constants";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — eq filters, ordered select, guarded update returning.
// ---------------------------------------------------------------------------

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  insert(row: Row): Row {
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
      return { data: this.table.insert(op.row), error: null };
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

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable();
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-09-30T12:00:00.000Z";
const T1 = "2026-09-30T12:00:01.000Z";
const T2 = "2026-09-30T12:00:02.000Z";
const FILM = "film-77";
const OTHER_FILM = "film-other";

function escrowRow(
  filmId: string,
  eventId: string,
  amountCents: number,
  createdAt: string,
  status: "escrow_waterfall_pending" | "settled" = "escrow_waterfall_pending",
): Omit<LedgerTransactionRecord, "id"> {
  return {
    split_run_id: "",
    line_item_id: eventId,
    payee_id: filmEscrowPayeeId(filmId),
    payee_name: filmEscrowPayeeName(filmId),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status,
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: status === "settled" ? T2 : null,
    kind: "escrow_waterfall_pending",
  };
}

async function scenario(store: Store): Promise<void> {
  const oldest = await store.insertLedgerTransaction(
    escrowRow(FILM, "evt-a", 2_000, T0),
  );
  const newest = await store.insertLedgerTransaction(
    escrowRow(FILM, "evt-b", 3_500, T1),
  );
  // Decoys: an already-released film escrow row and an ordinary royalty row
  // must never appear. Another film's LOCKED receipt legitimately appears —
  // the listing is the cross-film work queue of held receipts (each row's
  // film rides in its film_escrow:{filmId} payee id); per-film money math
  // goes through sumFilmGrossReceiptCents and release settles by row id.
  await store.insertLedgerTransaction(
    escrowRow(FILM, "evt-c", 9_999, T0, "settled"),
  );
  const otherFilmHeld = await store.insertLedgerTransaction(
    escrowRow(OTHER_FILM, "evt-d", 8_888, T0),
  );
  await store.insertLedgerTransaction({
    ...escrowRow(FILM, "evt-e", 7_777, T0),
    payee_id: "creator_x",
    payee_name: "Creator X",
    role: "creator",
    share_bps: 10_000,
    status: "pending_settlement",
    kind: "royalty",
  });

  // Newest first (evt-b's created_at is strictly the latest); the T0 ties
  // are the two held receipts in some tie-break order.
  const heldIds = (await store.listFilmEscrowCredits()).map((r) => r.id);
  expect(heldIds[0]).toBe(newest.id);
  expect(new Set(heldIds)).toEqual(
    new Set([oldest.id, newest.id, otherFilmHeld.id]),
  );
  expect(await store.listFilmEscrowCredits(1)).toEqual([newest]);

  // Cumulative gross: every escrow receipt for the film, held AND settled —
  // money is RECEIVED when it locks, not when it releases.
  expect(await store.sumFilmGrossReceiptCents(FILM)).toBe(2_000 + 3_500 + 9_999);
  expect(await store.sumFilmGrossReceiptCents(OTHER_FILM)).toBe(8_888);
  expect(await store.sumFilmGrossReceiptCents("film-never-seen")).toBe(0);

  // CAS settle: the winner reads the settled row; the loser and unknown
  // ids read undefined.
  const settled = await store.settleFilmEscrow(oldest.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(settled?.kind).toBe("escrow_waterfall_pending");
  expect(await store.settleFilmEscrow(oldest.id, T2)).toBeUndefined();
  expect(await store.settleFilmEscrow("missing", T2)).toBeUndefined();

  // The settled row left the held listing; the newest and the other film's
  // locked receipt remain.
  const remainingIds = (await store.listFilmEscrowCredits()).map((r) => r.id);
  expect(remainingIds[0]).toBe(newest.id);
  expect(remainingIds).toHaveLength(2);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the escrow methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("film escrow — three-backend parity (verification row 3)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("lists held escrow receipts (filters, newest-first, limit), sums cumulative gross, and settles exactly once via the CAS", async () => {
        await scenario(backend.make());
      });
    });
  }
});
