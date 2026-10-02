// Book returns reserve + foreign-tax hold (PR 27) — three-backend parity for
// the new store methods, mirroring the merch reserve parity pattern: the same
// scenario script runs on InMemoryStore, SqliteStore (:memory:), and
// SupabaseStore over a behavioral PostgREST fake.
//
// Under test: the evidence-of-record upserts (withholding tax credit per
// (country_code, tax_year), ISBN rights per isbn), the founder-banded reserve
// policy per isbn, the foreign-tax freeze/thaw CAS sweeps over the holding
// ledger (status-only, scope-keyed), the book-returns-reserve credit listing
// (kind AND status — settled rows, foreign-tax-hold rows, and royalty rows
// never appear), the settlement CAS (one winner), the chargeback of record
// with its event replay guard, the drawdown ledger with its two uniques
// (replay + position), and the offset application ledger with its two
// uniques (replay per holding + position).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";

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
      // PostgREST semantics: the WHERE clause picks the targets and is NOT
      // re-applied to the returning snapshot — an empty result means the
      // conditional sweep matched nothing (the honest no-op), surfacing as
      // data:null for maybeSingle and [] for the array read.
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

// The unique constraints the real schema enforces (migration 0031) — the
// fake reproduces their 23505 behavior so the replay and position guards
// exercise end to end.
const FAKE_UNIQUES = {
  withholding_tax_credit_verifications: [
    { name: "withholding_tax_credit_verifications_country_year_key", columns: ["country_code", "tax_year"] },
  ],
  isbn_rights_verifications: [
    { name: "isbn_rights_verifications_isbn_key", columns: ["isbn"] },
  ],
  book_returns_reserve_policies: [
    { name: "book_returns_reserve_policies_isbn_key", columns: ["isbn"] },
  ],
  book_return_chargebacks: [
    { name: "book_return_chargebacks_event_id_key", columns: ["event_id"] },
  ],
  book_reserve_drawdowns: [
    {
      name: "book_reserve_drawdowns_reserve_event_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "book_reserve_drawdowns_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
  book_chargeback_offset_applications: [
    {
      name: "book_chargeback_offset_applications_replay_key",
      columns: ["chargeback_id", "holding_ledger_id"],
    },
    {
      name: "book_chargeback_offset_applications_position_key",
      columns: ["chargeback_id", "offset_before_cents"],
    },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-09-30T12:00:00.000Z";
const T1 = "2026-09-30T12:00:01.000Z";
const T2 = "2026-09-30T12:00:02.000Z";
const T3 = "2026-09-30T12:00:03.000Z";
const ISBN = "9780306406157";
const ISBN_B = "9780140449136";
const CREATOR = "creator-book";

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

/** A plain held unclaimed-holding leg under a caller-supplied scope. */
async function insertHoldingLeg(
  store: Store,
  splitRunId: string,
  status: "unclaimed_holding" | "foreign_tax_hold",
  amountCents: number,
  createdAt: string,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: splitRunId,
    line_item_id: "",
    payee_id: "unclaimed",
    payee_name: "Unclaimed Royalty Holding",
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status,
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "unclaimed_holding",
  });
}

/** A book-returns-reserve credit under an ISBN's lock linkage. */
async function insertBookReserveCredit(
  store: Store,
  isbn: string,
  amountCents: number,
  status: "book_returns_reserve" | "settled",
  createdAt: string,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "holding-1",
    line_item_id: "",
    payee_id: `book_returns_reserve:${isbn}`,
    payee_name: `Book returns reserve — ${isbn}`,
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status,
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "book_returns_reserve",
  });
}

async function scenario(store: Store): Promise<void> {
  // --- The withholding-tax-credit evidence of record: upsert per
  // (country_code, tax_year); a re-record replaces the row atomically
  // (the pending → verified evidence upgrade); an unknown scope reads
  // undefined. ---
  const pending = await store.upsertWithholdingTaxCreditVerification({
    country_code: "GB",
    tax_year: 2026,
    state: "pending",
    treaty_ref: null,
    evidence_ref: null,
    verified_by: null,
    verified_at: null,
    created_at: T0,
    updated_at: T0,
  });
  expect(pending.state).toBe("pending");
  expect(
    (await store.getWithholdingTaxCreditVerification("GB", 2026))?.state,
  ).toBe("pending");
  expect(await store.getWithholdingTaxCreditVerification("DE", 2026)).toBeUndefined();

  await store.upsertWithholdingTaxCreditVerification({
    country_code: "GB",
    tax_year: 2026,
    state: "verified",
    treaty_ref: "UK-US 2001 Art 13",
    evidence_ref: "hmrc-withholding-cert-2026",
    verified_by: "verifier_1",
    verified_at: T1,
    created_at: T0,
    updated_at: T1,
  });
  const verified = await store.getWithholdingTaxCreditVerification("GB", 2026);
  expect(verified?.state).toBe("verified");
  expect(verified?.treaty_ref).toBe("UK-US 2001 Art 13");

  // --- The ISBN rights verification of record: same replace-on-reverify
  // discipline per isbn; the payout gate reads only 'verified'. ---
  await store.upsertIsbnRightsVerification({
    isbn: ISBN,
    state: "pending",
    evidence_ref: null,
    verified_by: null,
    verified_at: null,
    created_at: T0,
    updated_at: T0,
  });
  expect((await store.getIsbnRightsVerification(ISBN))?.state).toBe("pending");
  expect(await store.getIsbnRightsVerification(ISBN_B)).toBeUndefined();
  await store.upsertIsbnRightsVerification({
    isbn: ISBN,
    state: "verified",
    evidence_ref: "rights-chain-file-2026",
    verified_by: "verifier_1",
    verified_at: T1,
    created_at: T0,
    updated_at: T1,
  });
  expect((await store.getIsbnRightsVerification(ISBN))?.state).toBe("verified");

  // --- The founder-banded reserve policy of record per isbn: upsert
  // replaces; unknown isbns read undefined. ---
  await store.upsertBookReturnsReservePolicy({
    isbn: ISBN,
    reserve_rate_bps: 1_500,
    reserve_window_days: 90,
    beneficiary_payee_id: CREATOR,
    beneficiary_payee_name: "Book Creator",
    created_at: T0,
    updated_at: T0,
  });
  expect((await store.getBookReturnsReservePolicy(ISBN))?.reserve_rate_bps).toBe(1_500);
  await store.upsertBookReturnsReservePolicy({
    isbn: ISBN,
    reserve_rate_bps: 2_000,
    reserve_window_days: 120,
    beneficiary_payee_id: CREATOR,
    beneficiary_payee_name: "Book Creator",
    created_at: T0,
    updated_at: T1,
  });
  const policy = await store.getBookReturnsReservePolicy(ISBN);
  expect(policy?.reserve_rate_bps).toBe(2_000);
  expect(policy?.reserve_window_days).toBe(120);
  expect(await store.getBookReturnsReservePolicy(ISBN_B)).toBeUndefined();

  // --- The foreign-tax freeze/thaw sweeps: conditional, scope-keyed,
  // honest no-ops on re-runs. ---
  const gb2026 = "foreign_tax:GB:2026";
  const first = await insertHoldingLeg(store, gb2026, "unclaimed_holding", 1_000, T0);
  const second = await insertHoldingLeg(store, gb2026, "unclaimed_holding", 2_000, T1);
  await insertHoldingLeg(store, "foreign_tax:DE:2026", "unclaimed_holding", 3_000, T2);

  expect(await store.freezeForeignTaxHolds(gb2026)).toBe(2);
  // A re-freeze matches nothing — the honest no-op.
  expect(await store.freezeForeignTaxHolds(gb2026)).toBe(0);
  // Only the scope's frozen legs surface, newest first.
  const held = await store.listForeignTaxHolds();
  expect(held.map((r) => r.id)).toEqual([second.id, first.id]);

  expect(await store.thawForeignTaxHolds(gb2026)).toBe(2);
  // The thawed legs left the work queue; the DE scope is untouched.
  expect(await store.listForeignTaxHolds().then((r) => r.length)).toBe(0);
  expect(await store.thawForeignTaxHolds(gb2026)).toBe(0);
  const thawedFirst = await store.getLedgerTransaction(first.id);
  expect(thawedFirst?.status).toBe("unclaimed_holding");

  // --- The book-returns-reserve credit listing: the ISBN's FULL reserve
  // history, oldest first — settled credits stay (the gate's window
  // derivation reads the earliest credit regardless of status); frozen
  // holding legs and other kinds never appear. ---
  const reserveOne = await insertBookReserveCredit(store, ISBN, 750, "book_returns_reserve", T1);
  const reserveTwo = await insertBookReserveCredit(store, ISBN, 500, "book_returns_reserve", T2);
  const settledRow = await insertBookReserveCredit(store, ISBN, 750, "settled", T0);
  const settledId = settledRow.id;
  await insertHoldingLeg(store, ISBN, "foreign_tax_hold", 900, T2);
  await insertBookReserveCredit(store, ISBN_B, 650, "book_returns_reserve", T2);
  const credits = await store.listBookReturnsReserveCreditsByIsbn(ISBN);
  expect(credits.map((r) => r.id)).toEqual([settledId, reserveOne.id, reserveTwo.id]);
  expect(
    (await store.listBookReturnsReserveCreditsByIsbn(ISBN_B)).map((r) => r.amount_cents),
  ).toEqual([650]);

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleBookReturnsReserve(reserveOne.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(settled?.kind).toBe("book_returns_reserve");
  expect(await store.settleBookReturnsReserve(reserveOne.id, T2)).toBeUndefined();
  expect(await store.settleBookReturnsReserve("missing", T2)).toBeUndefined();
  // The settled credit STAYS in the ISBN listing — the full history is the
  // gate's window source, so the listing is unchanged by settlement.
  expect((await store.listBookReturnsReserveCreditsByIsbn(ISBN)).map((r) => r.id)).toEqual([
    settledId,
    reserveOne.id,
    reserveTwo.id,
  ]);

  // --- The chargeback of record: event-id replay guard + the FIFO
  // listing. ---
  await store.insertBookReturnChargeback({
    event_id: "return-evt-1",
    isbn: ISBN,
    chargeback_class: "chargeback",
    chargeback_cents: 500,
    currency: "USD",
    created_at: T1,
  });
  const chargebackTwo = await store.insertBookReturnChargeback({
    event_id: "return-evt-2",
    isbn: ISBN,
    chargeback_class: "publisher_return",
    chargeback_cents: 300,
    currency: "USD",
    created_at: T2,
  });
  let replayThrew: unknown;
  try {
    await store.insertBookReturnChargeback({
      event_id: "return-evt-1",
      isbn: ISBN,
      chargeback_class: "chargeback",
      chargeback_cents: 500,
      currency: "USD",
      created_at: T1,
    });
  } catch (error) {
    replayThrew = error;
  }
  expectUniqueViolation(replayThrew);
  expect(
    (await store.listBookReturnChargebacksByIsbn(ISBN)).map((r) => r.event_id),
  ).toEqual(["return-evt-1", "return-evt-2"]);

  // --- The drawdown ledger: replay unique + position unique; the listing
  // reads position (drawn_before_cents) first. ---
  await store.insertBookReserveDrawdown({
    reserve_ledger_id: reserveTwo.id,
    drawdown_class: "chargeback",
    source_event_id: "return-evt-1",
    drawn_before_cents: 0,
    drawn_cents: 300,
    remaining_cents: 200,
    created_at: T2,
  });
  await store.insertBookReserveDrawdown({
    reserve_ledger_id: reserveTwo.id,
    drawdown_class: "chargeback",
    source_event_id: "return-evt-2",
    drawn_before_cents: 300,
    drawn_cents: 200,
    remaining_cents: 0,
    created_at: T3,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertBookReserveDrawdown({
      reserve_ledger_id: reserveTwo.id,
      drawdown_class: "chargeback",
      source_event_id: "return-evt-1",
      drawn_before_cents: 500,
      drawn_cents: 100,
      remaining_cents: 0,
      created_at: T3,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);
  let drawPositionThrew: unknown;
  try {
    await store.insertBookReserveDrawdown({
      reserve_ledger_id: reserveTwo.id,
      drawdown_class: "chargeback",
      source_event_id: "return-evt-3",
      drawn_before_cents: 300,
      drawn_cents: 100,
      remaining_cents: 0,
      created_at: T3,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listBookReserveDrawdowns(reserveTwo.id);
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([0, 300]);

  // --- The offset application ledger: replay unique per (chargeback,
  // holding) + position unique per (chargeback, offset_before); the
  // listing reads position first. holding_ledger_id values are real
  // ledger rows — the SQLite FK enforces the ledger-child discipline. ---
  await store.insertBookChargebackOffsetApplication({
    chargeback_id: chargebackTwo.id,
    holding_ledger_id: first.id,
    offset_before_cents: 0,
    applied_cents: 200,
    remaining_cents: 100,
    created_at: T2,
  });
  await store.insertBookChargebackOffsetApplication({
    chargeback_id: chargebackTwo.id,
    holding_ledger_id: second.id,
    offset_before_cents: 200,
    applied_cents: 100,
    remaining_cents: 0,
    created_at: T3,
  });
  let offsetReplayThrew: unknown;
  try {
    await store.insertBookChargebackOffsetApplication({
      chargeback_id: chargebackTwo.id,
      holding_ledger_id: first.id,
      offset_before_cents: 300,
      applied_cents: 100,
      remaining_cents: 0,
      created_at: T3,
    });
  } catch (error) {
    offsetReplayThrew = error;
  }
  expectUniqueViolation(offsetReplayThrew);
  let offsetPositionThrew: unknown;
  try {
    await store.insertBookChargebackOffsetApplication({
      chargeback_id: chargebackTwo.id,
      holding_ledger_id: reserveOne.id,
      offset_before_cents: 200,
      applied_cents: 100,
      remaining_cents: 0,
      created_at: T3,
    });
  } catch (error) {
    offsetPositionThrew = error;
  }
  expectUniqueViolation(offsetPositionThrew);
  const applications = await store.listBookChargebackOffsetApplications(chargebackTwo.id);
  expect(applications.map((r) => r.offset_before_cents)).toEqual([0, 200]);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the book-reserve methods
    // touch; the real SupabaseClient surface is far larger than the store
    // touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("book returns reserve + foreign tax hold — three-backend parity (verification row 6)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the evidence upserts, policy, freeze/thaw sweeps, listings, settle CAS, chargebacks, drawdowns, and offsets identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
