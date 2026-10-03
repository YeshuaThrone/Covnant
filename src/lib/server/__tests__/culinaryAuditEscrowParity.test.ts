// Culinary audit escrow + kitchen payout gate states + pop-up
// decommissioning facts (PR 41) — three-backend parity for the new store
// methods, mirroring the fitness audit escrow parity pattern: the same
// scenario script runs on InMemoryStore, SqliteStore (:memory:), and
// SupabaseStore over a behavioral PostgREST fake.
//
// Under test: the founder-banded escrow policy per (chef, ghost kitchen)
// scope, the culinary payout gate's states of record per (payee, ghost
// kitchen) — health_inspection_state and territorial_exclusivity_state
// upsert-converging — the escrow drawdown ledger with its two uniques
// (replay + position), the reconciliation of record (insert-as-lock per
// escrow), the pop-up campaign window of record (insert-as-lock per
// popup_ref), the append-only packaging write-off of record (unique per
// source event), and the escrow settlement CAS (one winner).

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
// insert-as-lock guards exercise end to end.
const FAKE_UNIQUES = {
  culinary_audit_escrow_policies: [
    { name: "culinary_audit_escrow_policies_scope_key_key", columns: ["scope_key"] },
  ],
  culinary_audit_escrow_drawdowns: [
    {
      name: "culinary_audit_escrow_drawdowns_reserve_event_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "culinary_audit_escrow_drawdowns_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
  culinary_audit_escrow_reconciliations: [
    { name: "culinary_audit_escrow_reconciliations_reserve_ledger_id_key", columns: ["reserve_ledger_id"] },
  ],
  culinary_payout_gate_states: [
    {
      name: "culinary_payout_gate_states_payee_kitchen_key",
      columns: ["payee_id", "ghost_kitchen_location_code"],
    },
  ],
  culinary_popup_experiences: [
    { name: "culinary_popup_experiences_popup_ref_key", columns: ["popup_ref"] },
  ],
  culinary_popup_writeoffs: [
    {
      name: "culinary_popup_writeoffs_popup_event_key",
      columns: ["popup_experience_id", "source_event_id"],
    },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T1 = "2026-10-03T12:00:01.000Z";
const T2 = "2026-10-03T12:00:02.000Z";
const T3 = "2026-10-03T12:00:03.000Z";
const CHEF = "chef-parity";
const KITCHEN = "PARITY-GK";
const SCOPE = `chef:${CHEF}:kitchen:${KITCHEN}`;

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
  await store.upsertCulinaryAuditEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 700,
  });
  expect((await store.getCulinaryAuditEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(700);
  expect(await store.getCulinaryAuditEscrowPolicy("chef:chef-other:kitchen:PARITY-GK")).toBeUndefined();
  await store.upsertCulinaryAuditEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 900,
  });
  expect((await store.getCulinaryAuditEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(900);

  // --- The culinary payout gate's states of record per (payee, ghost
  // kitchen): upsert converges — a verification heals 'unknown'; an
  // absent record reads undefined (the gate's fail-closed null). ---
  await store.upsertCulinaryPayoutGateState({
    payee_id: CHEF,
    ghost_kitchen_location_code: KITCHEN,
    health_inspection_state: "unknown",
    territorial_exclusivity_state: "unknown",
    evidence_ref: "health-exclusivity-audit.pdf",
    verified_by: "compliance-desk",
  });
  const unknownStates = await store.getCulinaryPayoutGateState(CHEF, KITCHEN);
  expect(unknownStates?.health_inspection_state).toBe("unknown");
  expect(unknownStates?.territorial_exclusivity_state).toBe("unknown");
  expect(await store.getCulinaryPayoutGateState("chef-other", KITCHEN)).toBeUndefined();
  await store.upsertCulinaryPayoutGateState({
    payee_id: CHEF,
    ghost_kitchen_location_code: KITCHEN,
    health_inspection_state: "cleared",
    territorial_exclusivity_state: "verified",
    evidence_ref: "health-exclusivity-audit-v2.pdf",
    verified_by: "compliance-desk",
  });
  const clearedStates = await store.getCulinaryPayoutGateState(CHEF, KITCHEN);
  expect(clearedStates?.health_inspection_state).toBe("cleared");
  expect(clearedStates?.territorial_exclusivity_state).toBe("verified");

  // --- The escrow drawdown ledger: replay unique + position unique; the
  // listing reads position (drawn_before_cents) first. reserve_ledger_id
  // values are real ledger rows — the ledger-child discipline. ---
  const escrow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: `culinary_audit_escrow:${SCOPE}`,
    payee_name: `CULINARY_AUDIT_ESCROW — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: 70_000,
    currency: "USD",
    status: "culinary_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "culinary_audit_escrow",
  });
  await store.insertCulinaryAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "refund_allowance",
    source_event_id: "refund-parity-2026-10",
    drawn_before_cents: 70_000,
    drawn_cents: 25_000,
    remaining_cents: 45_000,
  });
  await store.insertCulinaryAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "supplier_quality_audit",
    source_event_id: "supplier-audit-q3-2026",
    drawn_before_cents: 45_000,
    drawn_cents: 10_000,
    remaining_cents: 35_000,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertCulinaryAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "spoilage_chargeback",
      source_event_id: "refund-parity-2026-10",
      drawn_before_cents: 20_000,
      drawn_cents: 100,
      remaining_cents: 19_900,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);
  let drawPositionThrew: unknown;
  try {
    await store.insertCulinaryAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "spoilage_chargeback",
      source_event_id: "spoilage-parity-lot",
      drawn_before_cents: 45_000,
      drawn_cents: 100,
      remaining_cents: 44_900,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listCulinaryAuditEscrowDrawdowns(escrow.id);
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([70_000, 45_000]);

  // --- The reconciliation of record: unique per escrow — the verified
  // evidence lands once; a second insert throws; the getter reads the
  // winner. ---
  await store.insertCulinaryAuditEscrowReconciliation({
    reserve_ledger_id: escrow.id,
    evidence_ref: "supplier-audit-q3-2026.pdf",
    reconciled_by: "compliance-desk",
  });
  expect(
    (await store.getCulinaryAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("supplier-audit-q3-2026.pdf");
  expect(await store.getCulinaryAuditEscrowReconciliation("missing")).toBeUndefined();
  let reconciliationReplayThrew: unknown;
  try {
    await store.insertCulinaryAuditEscrowReconciliation({
      reserve_ledger_id: escrow.id,
      evidence_ref: "supplier-audit-q3-2026-late.pdf",
      reconciled_by: "compliance-desk",
    });
  } catch (error) {
    reconciliationReplayThrew = error;
  }
  expectUniqueViolation(reconciliationReplayThrew);
  expect(
    (await store.getCulinaryAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("supplier-audit-q3-2026.pdf");

  // --- The pop-up campaign window of record: insert-as-lock per
  // popup_ref — the FIRST registration wins; a re-shipped sheet throws. ---
  await store.insertCulinaryPopupExperience({
    popup_ref: "popup-parity-lto-30",
    chef_id: CHEF,
    ghost_kitchen_location_code: KITCHEN,
    menu_theme: "viral men-u 30-day LTO",
    window_start_date: "2026-10-01",
    window_end_date: "2026-10-30",
  });
  const popup = await store.getCulinaryPopupExperience("popup-parity-lto-30");
  expect(popup?.chef_id).toBe(CHEF);
  expect(popup?.ghost_kitchen_location_code).toBe(KITCHEN);
  expect(await store.getCulinaryPopupExperience("popup-other")).toBeUndefined();
  let popupReplayThrew: unknown;
  try {
    await store.insertCulinaryPopupExperience({
      popup_ref: "popup-parity-lto-30",
      chef_id: CHEF,
      ghost_kitchen_location_code: KITCHEN,
      menu_theme: "a re-shipped sheet",
      window_start_date: "2026-10-01",
      window_end_date: "2026-10-30",
    });
  } catch (error) {
    popupReplayThrew = error;
  }
  expectUniqueViolation(popupReplayThrew);
  expect((await store.getCulinaryPopupExperience("popup-parity-lto-30"))?.menu_theme).toBe(
    "viral men-u 30-day LTO",
  );

  // --- The append-only packaging write-off of record: unique per
  // (popup_experience_id, source_event_id) — the replay guard; the
  // listing reads chronologically. ---
  const popupId = (await store.getCulinaryPopupExperience("popup-parity-lto-30"))?.id ?? "";
  await store.insertCulinaryPopupWriteoff({
    popup_experience_id: popupId,
    source_event_id: "writeoff-parity-sheet-1",
    unsold_packages: 250,
    unit_cost_cents: 340,
    writeoff_cents: 85_000,
    evidence_ref: "packaging-count-sheet.pdf",
    calculated_by: "ops-desk",
  });
  const writeoffs = await store.listCulinaryPopupWriteoffs(popupId);
  expect(writeoffs).toHaveLength(1);
  expect(writeoffs[0]?.writeoff_cents).toBe(85_000);
  let writeoffReplayThrew: unknown;
  try {
    await store.insertCulinaryPopupWriteoff({
      popup_experience_id: popupId,
      source_event_id: "writeoff-parity-sheet-1",
      unsold_packages: 250,
      unit_cost_cents: 340,
      writeoff_cents: 85_000,
      evidence_ref: "packaging-count-sheet.pdf",
      calculated_by: "ops-desk",
    });
  } catch (error) {
    writeoffReplayThrew = error;
  }
  expectUniqueViolation(writeoffReplayThrew);
  expect(await store.listCulinaryPopupWriteoffs(popupId)).toHaveLength(1);
  expect(await store.listCulinaryPopupWriteoffs("popup-other")).toEqual([]);

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleCulinaryAuditEscrow(escrow.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(await store.settleCulinaryAuditEscrow(escrow.id, T3)).toBeUndefined();
  expect(await store.settleCulinaryAuditEscrow("missing", T3)).toBeUndefined();
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the culinary escrow methods
    // touch; the real SupabaseClient surface is far larger than the store
    // touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("culinary audit escrow + kitchen payout gates + pop-up decommissioning — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the escrow policy, gate states, drawdowns, reconciliation, pop-up window, write-off of record, and settle CAS identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
