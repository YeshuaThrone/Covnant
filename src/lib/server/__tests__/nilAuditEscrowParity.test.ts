// NIL audit escrow + transfer portal clawback (PR 35) — three-backend parity
// for the new store methods, mirroring the book-returns reserve parity
// pattern: the same scenario script runs on InMemoryStore, SqliteStore
// (:memory:), and SupabaseStore over a behavioral PostgREST fake.
//
// Under test: the founder-banded escrow policy per (athlete, school) scope,
// the advance schedule of record per nil contract, the portal entry of
// record (insert-as-lock per (contract, athlete)), the clawback of record
// (unique per portal entry), the escrow drawdown ledger with its two
// uniques (replay + position), the reconciliation of record (unique per
// escrow), and the escrow settlement CAS (one winner).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";

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

// The unique constraints the real schema enforces (migration 0039) — the
// fake reproduces their 23505 behavior so the replay, position, and
// insert-as-lock guards exercise end to end.
const FAKE_UNIQUES = {
  nil_audit_escrow_policies: [
    { name: "nil_audit_escrow_policies_scope_key_key", columns: ["scope_key"] },
  ],
  nil_advance_schedules: [
    { name: "nil_advance_schedules_nil_contract_id_key", columns: ["nil_contract_id"] },
  ],
  nil_transfer_portal_entries: [
    {
      name: "nil_transfer_portal_entries_contract_athlete_key",
      columns: ["nil_contract_id", "athlete_id"],
    },
  ],
  nil_unearned_clawbacks: [
    { name: "nil_unearned_clawbacks_portal_entry_id_key", columns: ["portal_entry_id"] },
  ],
  nil_audit_escrow_drawdowns: [
    {
      name: "nil_audit_escrow_drawdowns_reserve_event_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "nil_audit_escrow_drawdowns_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
  nil_audit_escrow_reconciliations: [
    { name: "nil_audit_escrow_reconciliations_reserve_ledger_id_key", columns: ["reserve_ledger_id"] },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-09-30T12:00:00.000Z";
const T1 = "2026-09-30T12:00:01.000Z";
const T2 = "2026-09-30T12:00:02.000Z";
const T3 = "2026-09-30T12:00:03.000Z";
const ATHLETE = "athlete-parity";
const ATHLETE_NAME = "Parity Athlete";
const SCHOOL = "school-parity-u";
const SCOPE = `payee:${ATHLETE}:school:${SCHOOL}`;
const CONTRACT = "nil-contract-parity";

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
  // --- The founder-banded escrow policy of record per scope: upsert
  // replaces; unknown scopes read undefined. ---
  await store.upsertNilAuditEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 700,
  });
  expect((await store.getNilAuditEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(700);
  expect(await store.getNilAuditEscrowPolicy("payee:athlete-other:school:school-parity-u")).toBeUndefined();
  await store.upsertNilAuditEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 900,
  });
  expect((await store.getNilAuditEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(900);

  // --- The advance schedule of record per nil contract: upsert replaces;
  // unknown contracts read undefined. ---
  await store.upsertNilAdvanceSchedule({
    nil_contract_id: CONTRACT,
    athlete_id: ATHLETE,
    school_id: SCHOOL,
    advance_cents: 360_000,
    term_start_date: "2026-01-01",
    term_end_date: "2026-12-31",
  });
  expect((await store.getNilAdvanceSchedule(CONTRACT))?.advance_cents).toBe(360_000);
  expect(await store.getNilAdvanceSchedule("nil-contract-other")).toBeUndefined();
  await store.upsertNilAdvanceSchedule({
    nil_contract_id: CONTRACT,
    athlete_id: ATHLETE,
    school_id: SCHOOL,
    advance_cents: 480_000,
    term_start_date: "2026-02-01",
    term_end_date: "2027-01-31",
  });
  const schedule = await store.getNilAdvanceSchedule(CONTRACT);
  expect(schedule?.advance_cents).toBe(480_000);
  expect(schedule?.term_start_date).toBe("2026-02-01");

  // --- The portal entry of record: insert-as-lock per (contract,
  // athlete) — the FIRST entry wins, a re-shipped sheet throws (23505),
  // and the winner reads back through the getter. ---
  const entry = await store.insertNilTransferPortalEntry({
    nil_contract_id: CONTRACT,
    athlete_id: ATHLETE,
    school_id: SCHOOL,
    entry_date: "2026-07-02",
    contract_completion_date: "2026-12-31",
    entered_prior_to_completion: true,
  });
  expect(
    (await store.getNilTransferPortalEntry(CONTRACT, ATHLETE))?.entry_date,
  ).toBe("2026-07-02");
  expect(await store.getNilTransferPortalEntry(CONTRACT, "athlete-other")).toBeUndefined();
  let entryReplayThrew: unknown;
  try {
    await store.insertNilTransferPortalEntry({
      nil_contract_id: CONTRACT,
      athlete_id: ATHLETE,
      school_id: SCHOOL,
      entry_date: "2026-08-15",
      contract_completion_date: "2026-12-31",
      entered_prior_to_completion: true,
    });
  } catch (error) {
    entryReplayThrew = error;
  }
  expectUniqueViolation(entryReplayThrew);
  expect(
    (await store.getNilTransferPortalEntry(CONTRACT, ATHLETE))?.entry_date,
  ).toBe("2026-07-02");

  // --- The clawback of record: unique per portal entry — the calculation
  // and its debit hold land once; a concurrent second insert throws. The
  // hold ledger row is a real row (the ledger-child discipline). ---
  const hold = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: CONTRACT,
    payee_id: ATHLETE,
    payee_name: ATHLETE_NAME,
    role: "creator",
    share_bps: 0,
    amount_cents: 180_000,
    currency: "USD",
    status: "nil_unearned_clawback",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "nil_unearned_clawback",
  });
  await store.insertNilUnearnedClawback({
    nil_contract_id: CONTRACT,
    athlete_id: ATHLETE,
    school_id: SCHOOL,
    portal_entry_id: entry.id,
    advance_cents: 480_000,
    term_start_date: "2026-02-01",
    term_end_date: "2026-12-31",
    entry_date: "2026-07-02",
    total_term_days: 334,
    served_days: 152,
    unearned_cents: 261_797,
    clawback_ledger_id: hold.id,
  });
  const clawback = await store.getNilUnearnedClawback(entry.id);
  expect(clawback?.unearned_cents).toBe(261_797);
  expect(clawback?.clawback_ledger_id).toBe(hold.id);
  let clawbackReplayThrew: unknown;
  try {
    await store.insertNilUnearnedClawback({
      nil_contract_id: CONTRACT,
      athlete_id: ATHLETE,
      school_id: SCHOOL,
      portal_entry_id: entry.id,
      advance_cents: 480_000,
      term_start_date: "2026-02-01",
      term_end_date: "2026-12-31",
      entry_date: "2026-07-02",
      total_term_days: 334,
      served_days: 152,
      unearned_cents: 999,
      clawback_ledger_id: hold.id,
    });
  } catch (error) {
    clawbackReplayThrew = error;
  }
  expectUniqueViolation(clawbackReplayThrew);
  expect((await store.getNilUnearnedClawback(entry.id))?.unearned_cents).toBe(261_797);

  // --- The escrow drawdown ledger: replay unique + position unique; the
  // listing reads position (drawn_before_cents) first. reserve_ledger_id
  // values are real ledger rows — the ledger-child discipline. ---
  const escrow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: `nil_audit_escrow:${ATHLETE}:${SCHOOL}`,
    payee_name: `NIL audit escrow — ${ATHLETE} at ${SCHOOL}`,
    role: "other",
    share_bps: 0,
    amount_cents: 70_000,
    currency: "USD",
    status: "nil_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T2,
    settled_at: null,
    kind: "nil_audit_escrow",
  });
  await store.insertNilAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "transfer_portal_reconciliation",
    source_event_id: "portal-recon-2026",
    drawn_before_cents: 0,
    drawn_cents: 25_000,
    remaining_cents: 45_000,
  });
  await store.insertNilAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "tax_withholding",
    source_event_id: "withholding-q3",
    drawn_before_cents: 25_000,
    drawn_cents: 10_000,
    remaining_cents: 35_000,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertNilAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "tax_withholding",
      source_event_id: "portal-recon-2026",
      drawn_before_cents: 35_000,
      drawn_cents: 100,
      remaining_cents: 0,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);
  let drawPositionThrew: unknown;
  try {
    await store.insertNilAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "tax_withholding",
      source_event_id: "withholding-q4",
      drawn_before_cents: 25_000,
      drawn_cents: 100,
      remaining_cents: 0,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listNilAuditEscrowDrawdowns(escrow.id);
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([0, 25_000]);

  // --- The reconciliation of record: unique per escrow — the verified
  // evidence lands once; a second insert throws; the getter reads the
  // winner. ---
  await store.insertNilAuditEscrowReconciliation({
    reserve_ledger_id: escrow.id,
    evidence_ref: "portal-audit-2026.pdf",
    reconciled_by: "compliance-desk",
  });
  expect(
    (await store.getNilAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("portal-audit-2026.pdf");
  expect(await store.getNilAuditEscrowReconciliation("missing")).toBeUndefined();
  let reconciliationReplayThrew: unknown;
  try {
    await store.insertNilAuditEscrowReconciliation({
      reserve_ledger_id: escrow.id,
      evidence_ref: "portal-audit-2026-late.pdf",
      reconciled_by: "compliance-desk",
    });
  } catch (error) {
    reconciliationReplayThrew = error;
  }
  expectUniqueViolation(reconciliationReplayThrew);
  expect(
    (await store.getNilAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("portal-audit-2026.pdf");

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleNilAuditEscrow(escrow.id, T3);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T3);
  expect(await store.settleNilAuditEscrow(escrow.id, T3)).toBeUndefined();
  expect(await store.settleNilAuditEscrow("missing", T3)).toBeUndefined();
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the NIL escrow methods
    // touch; the real SupabaseClient surface is far larger than the store
    // touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("NIL audit escrow + transfer portal clawback — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the policy, advance schedule, portal entry, clawback, drawdowns, reconciliation, and settle CAS identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
