// Unclaimed royalty holding (PR 7) — three-backend parity for the holding
// read + CAS-settle store methods, mirroring the recon-queue parity pattern:
// the same scenario script runs on InMemoryStore, SqliteStore (:memory:),
// and SupabaseStore over a behavioral PostgREST fake.
//
// Under test: the held-credit listing filters (kind AND status =
// 'unclaimed_holding' — released rows and ordinary royalty rows never
// appear), newest-first ordering, the limit, and the compare-and-set settle
// (one winner; the loser and unknown ids read undefined).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  UNCLAIMED_HOLDING_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_NAME,
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

function holdingRow(
  eventId: string,
  amountCents: number,
  createdAt: string,
  status: "unclaimed_holding" | "settled" = "unclaimed_holding",
): Omit<LedgerTransactionRecord, "id"> {
  return {
    split_run_id: "",
    line_item_id: eventId,
    payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
    payee_name: UNCLAIMED_HOLDING_PAYEE_NAME,
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
    kind: "unclaimed_holding",
  };
}

async function scenario(store: Store): Promise<void> {
  const oldest = await store.insertLedgerTransaction(holdingRow("evt-a", 2_000, T0));
  const newest = await store.insertLedgerTransaction(holdingRow("evt-b", 3_500, T1));
  // Decoys: an already-released holding row and an ordinary royalty row —
  // neither may appear in the held listing.
  await store.insertLedgerTransaction(holdingRow("evt-c", 9_999, T0, "settled"));
  await store.insertLedgerTransaction({
    ...holdingRow("evt-d", 7_777, T0),
    payee_id: "creator_x",
    payee_name: "Creator X",
    role: "creator",
    share_bps: 10_000,
    status: "pending_settlement",
    kind: "royalty",
  });

  // Newest first, held rows only.
  expect((await store.listUnclaimedHoldingCredits()).map((r) => r.id)).toEqual([
    newest.id,
    oldest.id,
  ]);
  expect(
    (await store.listUnclaimedHoldingCredits(1)).map((r) => r.id),
  ).toEqual([newest.id]);

  // CAS settle: the winner reads the settled row; the loser and unknown
  // ids read undefined.
  const settled = await store.settleUnclaimedHolding(oldest.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(settled?.kind).toBe("unclaimed_holding");
  expect(await store.settleUnclaimedHolding(oldest.id, T2)).toBeUndefined();
  expect(await store.settleUnclaimedHolding("missing", T2)).toBeUndefined();

  // The settled row left the held listing; the newest remains.
  expect((await store.listUnclaimedHoldingCredits()).map((r) => r.id)).toEqual([
    newest.id,
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
    // The fake implements the builder subset the holding methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("unclaimed holding — three-backend parity (verification row 3)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("lists held credits (filters, newest-first, limit) and settles exactly once via the CAS", async () => {
        await scenario(backend.make());
      });
    });
  }
});
