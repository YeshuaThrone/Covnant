// Patent litigation escrow + hardware payout gate states + cross-license
// net dispatches (PR 47) — three-backend parity for the new store methods,
// mirroring the culinary audit escrow parity pattern: the same scenario
// script runs on InMemoryStore, SqliteStore (:memory:), and SupabaseStore
// over a behavioral PostgREST fake.
//
// Under test: the hardware payout gate's states of record per (payee, SEP
// pool) — frand_determination_state and essentiality_audit_state
// upsert-converging, absent reads fail-closed — the founder-banded
// (1000–1500 bps) escrow policy per licensor+pool scope, the escrow
// drawdown ledger with its two uniques (replay + position), the
// reconciliation of record (insert-as-lock per escrow), the escrow
// settlement CAS (one winner), and the cross-license net dispatch of
// record (unique per (agreement_ref, period, net_before_cents,
// net_after_cents) — replay guard and concurrency arbiter).

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

// The unique constraints the real schema enforces (migration 0045) — the
// fake reproduces their 23505 behavior so the replay, position, and
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
// ---------------------------------------------------------------------------
// The shared scenario script — the PR 47 hardware tables.
// ---------------------------------------------------------------------------

const T1 = "2026-10-03T12:00:01.000Z";
const T2 = "2026-10-03T12:00:02.000Z";
const T3 = "2026-10-03T12:00:03.000Z";
const LICENSOR = "licensor-parity";
const POOL = "PARITY-POOL";
const SCOPE = `licensor:${LICENSOR}:pool:${POOL}`;

async function scenario(store: Store): Promise<void> {
  // --- The hardware payout gate's durable states of record per (payee,
  // SEP pool): upsert converges — a verification heals 'unknown'; an
  // absent record reads undefined (the gate's fail-closed null). ---
  await store.upsertHardwarePayoutGateState({
    payee_id: LICENSOR,
    sep_pool_code: POOL,
    frand_determination_state: "unknown",
    essentiality_audit_state: "unknown",
    evidence_ref: "frand-essentiality-audit.pdf",
    verified_by: "compliance-desk",
  });
  const unknownStates = await store.getHardwarePayoutGateState(LICENSOR, POOL);
  expect(unknownStates?.frand_determination_state).toBe("unknown");
  expect(unknownStates?.essentiality_audit_state).toBe("unknown");
  expect(await store.getHardwarePayoutGateState("licensor-other", POOL)).toBeUndefined();
  await store.upsertHardwarePayoutGateState({
    payee_id: LICENSOR,
    sep_pool_code: POOL,
    frand_determination_state: "cleared",
    essentiality_audit_state: "verified",
    evidence_ref: "frand-essentiality-audit-v2.pdf",
    verified_by: "compliance-desk",
  });
  const clearedStates = await store.getHardwarePayoutGateState(LICENSOR, POOL);
  expect(clearedStates?.frand_determination_state).toBe("cleared");
  expect(clearedStates?.essentiality_audit_state).toBe("verified");

  // --- The founder-banded escrow policy of record per scope: upsert
  // replaces; unknown scopes read undefined. ---
  await store.upsertPatentLitigationEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 1000,
  });
  expect((await store.getPatentLitigationEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(1000);
  expect(await store.getPatentLitigationEscrowPolicy("licensor:licensor-other:pool:PARITY-POOL")).toBeUndefined();
  await store.upsertPatentLitigationEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 1500,
  });
  expect((await store.getPatentLitigationEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(1500);

  // --- The escrow drawdown ledger: replay unique + position unique; the
  // listing reads position (drawn_before_cents) first. reserve_ledger_id
  // values are real ledger rows — the ledger-child discipline. ---
  const escrow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: `patent_litigation_escrow:${SCOPE}`,
    payee_name: `PATENT_LITIGATION_ESCROW — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: 150_000,
    currency: "USD",
    status: "patent_litigation_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "patent_litigation_escrow",
  });
  await store.insertPatentLitigationEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "global_court_rate_redetermination",
    source_event_id: "court-redetermination-parity-2026-10",
    drawn_before_cents: 150_000,
    drawn_cents: 60_000,
    remaining_cents: 90_000,
  });
  await store.insertPatentLitigationEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "anti_suit_injunction_penalty",
    source_event_id: "anti-suit-ruling-q4-2026",
    drawn_before_cents: 90_000,
    drawn_cents: 25_000,
    remaining_cents: 65_000,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertPatentLitigationEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "cross_border_patent_validity_challenge",
      source_event_id: "court-redetermination-parity-2026-10",
      drawn_before_cents: 40_000,
      drawn_cents: 100,
      remaining_cents: 39_900,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);
  let drawPositionThrew: unknown;
  try {
    await store.insertPatentLitigationEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "cross_border_patent_validity_challenge",
      source_event_id: "validity-challenge-parity",
      drawn_before_cents: 90_000,
      drawn_cents: 100,
      remaining_cents: 89_900,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listPatentLitigationEscrowDrawdowns(escrow.id);
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([150_000, 90_000]);

  // --- The reconciliation of record: unique per escrow — the verified
  // evidence lands once; a second insert throws; the getter reads the
  // winner. ---
  await store.insertPatentLitigationEscrowReconciliation({
    reserve_ledger_id: escrow.id,
    evidence_ref: "court-redetermination-report.pdf",
    reconciled_by: "finance-desk",
  });
  expect(
    (await store.getPatentLitigationEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("court-redetermination-report.pdf");
  expect(await store.getPatentLitigationEscrowReconciliation("missing")).toBeUndefined();
  let reconciliationReplayThrew: unknown;
  try {
    await store.insertPatentLitigationEscrowReconciliation({
      reserve_ledger_id: escrow.id,
      evidence_ref: "court-redetermination-report-late.pdf",
      reconciled_by: "finance-desk",
    });
  } catch (error) {
    reconciliationReplayThrew = error;
  }
  expectUniqueViolation(reconciliationReplayThrew);
  expect(
    (await store.getPatentLitigationEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("court-redetermination-report.pdf");

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settlePatentLitigationEscrow(escrow.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(await store.settlePatentLitigationEscrow(escrow.id, T3)).toBeUndefined();
  expect(await store.settlePatentLitigationEscrow("missing", T3)).toBeUndefined();

  // --- The cross-license net dispatch of record: unique per (agreement,
  // period, net_before, net_after) — the replay guard AND the
  // concurrency arbiter; the listing reads execution order. ---
  await store.insertHardwareCrossLicenseNetDispatch({
    agreement_ref: "clf-parity-5g-wifi7",
    company_a_id: "company-parity-a",
    company_b_id: "company-parity-b",
    period: "2026-10",
    currency: "USD",
    net_before_cents: 0,
    net_after_cents: 400_000,
    dispatched_delta_cents: 400_000,
    a_gross_cleared_cents: 1_200_000,
    b_gross_cleared_cents: 800_000,
    direction: "a_to_b",
    journal_id: null,
  });
  let dispatchReplayThrew: unknown;
  try {
    await store.insertHardwareCrossLicenseNetDispatch({
      agreement_ref: "clf-parity-5g-wifi7",
      company_a_id: "company-parity-a",
      company_b_id: "company-parity-b",
      period: "2026-10",
      currency: "USD",
      net_before_cents: 0,
      net_after_cents: 400_000,
      dispatched_delta_cents: 999_999,
      a_gross_cleared_cents: 1,
      b_gross_cleared_cents: 1,
      direction: "b_to_a",
      journal_id: null,
    });
  } catch (error) {
    dispatchReplayThrew = error;
  }
  expectUniqueViolation(dispatchReplayThrew);
  // A re-net that revisits an earlier net position does NOT collide:
  // net_before is in the key.
  await store.insertHardwareCrossLicenseNetDispatch({
    agreement_ref: "clf-parity-5g-wifi7",
    company_a_id: "company-parity-a",
    company_b_id: "company-parity-b",
    period: "2026-10",
    currency: "USD",
    net_before_cents: 400_000,
    net_after_cents: 100_000,
    dispatched_delta_cents: -300_000,
    a_gross_cleared_cents: 1_100_000,
    b_gross_cleared_cents: 1_000_000,
    direction: "b_to_a",
    journal_id: null,
  });
  const dispatches = await store.listHardwareCrossLicenseNetDispatches("clf-parity-5g-wifi7", "2026-10");
  expect(dispatches.map((r) => r.net_before_cents)).toEqual([0, 400_000]);
  expect(await store.listHardwareCrossLicenseNetDispatches("clf-other", "2026-10")).toEqual([]);
}

// ---------------------------------------------------------------------------
// The three-backend runner.
// ---------------------------------------------------------------------------

// The unique constraints the real schema enforces (migration 0051) — the
// fake reproduces their 23505 behavior so the replay, position, and
// insert-as-lock guards exercise end to end.
const FAKE_UNIQUES = {
  hardware_payout_gate_states: [
    {
      name: "hardware_payout_gate_states_payee_pool_key",
      columns: ["payee_id", "sep_pool_code"],
    },
  ],
  hardware_patent_litigation_escrow_policies: [
    { name: "hardware_patent_litigation_escrow_policies_scope_key_key", columns: ["scope_key"] },
  ],
  hardware_patent_litigation_escrow_drawdowns: [
    {
      name: "hardware_patent_litigation_escrow_drawdowns_reserve_event_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "hardware_patent_litigation_escrow_drawdowns_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
  hardware_patent_litigation_escrow_reconciliations: [
    {
      name: "hardware_patent_litigation_escrow_reconciliations_reserve_ledger_id_key",
      columns: ["reserve_ledger_id"],
    },
  ],
  hardware_cross_license_net_dispatches: [
    {
      name: "hardware_cross_license_net_dispatches_position_key",
      columns: ["agreement_ref", "period", "net_before_cents", "net_after_cents"],
    },
  ],
};

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the PR 47 methods touch; the
    // real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("patent litigation escrow + hardware payout gates + cross-license net dispatches — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the gate states, escrow policy, drawdowns, reconciliation, settle CAS, and net dispatches identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
