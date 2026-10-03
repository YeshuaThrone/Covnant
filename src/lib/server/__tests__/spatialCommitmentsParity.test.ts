// The spatial commitments lane (PR 37) — three-backend parity for the new
// store methods, mirroring the NIL audit escrow parity pattern: the same
// scenario script runs on InMemoryStore, SqliteStore (:memory:), and
// SupabaseStore over a behavioral PostgREST fake.
//
// Under test: the CapEx commitment of record per (scope, capex_ref) with
// its recouped convergence counter, the append-only CapEx application
// ledger with its two uniques (replay + position), the quarterly MSG
// commitment of record per scope, the once-only MSG term close per
// (commitment, quarter), the pop-up experience of record (insert-as-lock
// per popup_ref), the post-event write-off calculation (replay guard per
// (experience, event)), the site restoration reserve (insert-as-lock per
// experience), the founder-banded escrow policy per scope, the escrow
// drawdown ledger with its two uniques, the reconciliation of record
// (unique per escrow), the escrow settlement CAS (one winner), and the
// per (payee, venue) payout gate states the spatial gate reads
// fail-closed.

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
    // The real database synthesizes the columns the store's hardened
    // upserts omit (id rotates from gen_random_uuid(); timestamps come
    // from their defaults) — the fake must too, or readers of the
    // returned row see undefined ids and downstream uniques misfire.
    const defaults: Row = {
      id: row.id ?? crypto.randomUUID(),
      created_at: row.created_at ?? new Date().toISOString(),
      updated_at: row.updated_at ?? new Date().toISOString(),
    };
    if (onConflict !== null) {
      const conflictColumn = onConflict.split(",")[0]?.trim();
      const index = this.rows.findIndex(
        (existing) => conflictColumn !== undefined && existing[conflictColumn] === row[conflictColumn],
      );
      if (index >= 0) {
        this.rows[index] = { ...this.rows[index], ...defaults, ...row };
        return { row: { ...this.rows[index] }, error: null };
      }
    }
    const stored = { ...defaults, insertion_order: ++this.sequence, ...row };
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

// The unique constraints the real schema enforces (migration 0041) — the
// fake reproduces their 23505 behavior so the replay, position, and
// insert-as-lock guards exercise end to end.
const FAKE_UNIQUES = {
  spatial_capex_commitments: [
    { name: "spatial_capex_commitments_scope_capex_ref_key", columns: ["scope_key", "capex_ref"] },
  ],
  spatial_capex_applications: [
    {
      name: "spatial_capex_applications_commitment_event_key",
      columns: ["commitment_id", "source_event_id"],
    },
    {
      name: "spatial_capex_applications_commitment_position_key",
      columns: ["commitment_id", "offset_before_cents"],
    },
  ],
  spatial_msg_commitments: [
    { name: "spatial_msg_commitments_scope_key_key", columns: ["scope_key"] },
  ],
  spatial_msg_term_closes: [
    {
      name: "spatial_msg_term_closes_commitment_quarter_key",
      columns: ["commitment_id", "quarter"],
    },
  ],
  spatial_popup_experiences: [
    { name: "spatial_popup_experiences_popup_ref_key", columns: ["popup_ref"] },
  ],
  spatial_popup_writeoffs: [
    {
      name: "spatial_popup_writeoffs_experience_event_key",
      columns: ["popup_experience_id", "source_event_id"],
    },
  ],
  spatial_popup_restoration_reserves: [
    {
      name: "spatial_popup_restoration_reserves_popup_experience_id_key",
      columns: ["popup_experience_id"],
    },
  ],
  spatial_audit_escrow_policies: [
    { name: "spatial_audit_escrow_policies_scope_key_key", columns: ["scope_key"] },
  ],
  spatial_audit_escrow_drawdowns: [
    {
      name: "spatial_audit_escrow_drawdowns_reserve_event_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "spatial_audit_escrow_drawdowns_reserve_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
  spatial_audit_escrow_reconciliations: [
    {
      name: "spatial_audit_escrow_reconciliations_reserve_ledger_id_key",
      columns: ["reserve_ledger_id"],
    },
  ],
  spatial_payout_gate_states: [
    {
      name: "spatial_payout_gate_states_payee_venue_key",
      columns: ["payee_id", "venue_id"],
    },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-10-03T12:00:00.000Z";
const T1 = "2026-10-03T12:00:01.000Z";
const T2 = "2026-10-03T12:00:02.000Z";
const VENUE = "venue-parity-park";
const OTHER_VENUE = "venue-parity-other";
const VENUE_SCOPE = `venue:${VENUE}`;
const OPERATOR = "operator-parity";
const OPERATOR_NAME = "Parity Operator Co";
const MSG_SCOPE = `operator:${OPERATOR}:venue:${VENUE}`;
const PAYEE = "payee-parity";
const ESCROW_SCOPE = `venue:${VENUE}`;
const POPUP_REF = "halloween-parity-90d";

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
  // --- The CapEx commitment of record per (scope, capex_ref): upsert
  // converges — the newest registered cost governs the next walk; unknown
  // refs read undefined; the scope listing reads them back. ---
  await store.upsertSpatialCapexCommitment({
    scope_key: VENUE_SCOPE,
    capex_ref: "ride-coaster-01",
    operator_id: OPERATOR,
    capex_category: "ride_construction",
    capex_amount_cents: 100_000,
    recouped_cents: 0,
    currency: "USD",
  });
  expect(
    (await store.getSpatialCapexCommitment(VENUE_SCOPE, "ride-coaster-01"))
      ?.capex_amount_cents,
  ).toBe(100_000);
  expect(
    await store.getSpatialCapexCommitment(VENUE_SCOPE, "ride-ghost"),
  ).toBeUndefined();
  await store.upsertSpatialCapexCommitment({
    scope_key: VENUE_SCOPE,
    capex_ref: "ride-coaster-01",
    operator_id: OPERATOR,
    capex_category: "ride_construction",
    capex_amount_cents: 125_000,
    recouped_cents: 0,
    currency: "USD",
  });
  expect(
    (await store.getSpatialCapexCommitment(VENUE_SCOPE, "ride-coaster-01"))
      ?.capex_amount_cents,
  ).toBe(125_000);
  // A second scope keeps its own commitment of record.
  await store.upsertSpatialCapexCommitment({
    scope_key: `venue:${OTHER_VENUE}`,
    capex_ref: "buildout-plaza",
    operator_id: OPERATOR,
    capex_category: "venue_buildout",
    capex_amount_cents: 40_000,
    recouped_cents: 0,
    currency: "USD",
  });
  expect(await store.listSpatialCapexCommitments(VENUE_SCOPE)).toHaveLength(1);
  expect(await store.listSpatialCapexCommitments(`venue:${OTHER_VENUE}`)).toHaveLength(1);
  expect(await store.listSpatialCapexCommitments("venue:ghost")).toEqual([]);

  // --- The append-only CapEx application ledger: UNIQUE per
  // (commitment, event) is the replay guard — a re-walked royalty throws,
  // never a double offset; UNIQUE per (commitment, before) is the
  // position lock — a lost race throws. The listing reads position
  // (offset_before_cents) first. ---
  const commitment = await store.getSpatialCapexCommitment(VENUE_SCOPE, "ride-coaster-01");
  expect(commitment).toBeDefined();
  if (!commitment) return;
  await store.insertSpatialCapexApplication({
    commitment_id: commitment.id,
    scope_key: VENUE_SCOPE,
    capex_category: "ride_construction",
    source_event_id: "evt-roy-1",
    royalty_stream: "occupancy",
    royalty_cents: 12_000,
    offset_before_cents: 0,
    offset_cents: 12_000,
    offset_after_cents: 12_000,
  });
  let capexReplayThrew: unknown;
  try {
    await store.insertSpatialCapexApplication({
      commitment_id: commitment.id,
      scope_key: VENUE_SCOPE,
      capex_category: "ride_construction",
      source_event_id: "evt-roy-1",
      royalty_stream: "occupancy",
      royalty_cents: 12_000,
      offset_before_cents: 12_000,
      offset_cents: 1,
      offset_after_cents: 12_001,
    });
  } catch (error) {
    capexReplayThrew = error;
  }
  expectUniqueViolation(capexReplayThrew);
  let capexPositionThrew: unknown;
  try {
    await store.insertSpatialCapexApplication({
      commitment_id: commitment.id,
      scope_key: VENUE_SCOPE,
      capex_category: "ride_construction",
      source_event_id: "evt-roy-2",
      royalty_stream: "zone",
      royalty_cents: 300,
      offset_before_cents: 0,
      offset_cents: 300,
      offset_after_cents: 300,
    });
  } catch (error) {
    capexPositionThrew = error;
  }
  expectUniqueViolation(capexPositionThrew);
  expect(
    (await store.listSpatialCapexApplications(commitment.id)).map((a) => a.offset_before_cents),
  ).toEqual([0]);

  // --- The MSG commitment of record per scope: upsert converges — the
  // newest priced terms govern the next quarterly close. ---
  await store.upsertSpatialMsgCommitment({
    scope_key: MSG_SCOPE,
    operator_id: OPERATOR,
    operator_name: OPERATOR_NAME,
    venue_id: VENUE,
    reserved_footprint_sqft: 10_000,
    quarterly_rate_micros_per_sqft: 250_000,
    currency: "USD",
  });
  expect((await store.getSpatialMsgCommitment(MSG_SCOPE))?.reserved_footprint_sqft).toBe(10_000);
  expect(await store.getSpatialMsgCommitment("operator:ghost:venue:ghost")).toBeUndefined();
  await store.upsertSpatialMsgCommitment({
    scope_key: MSG_SCOPE,
    operator_id: OPERATOR,
    operator_name: OPERATOR_NAME,
    venue_id: VENUE,
    reserved_footprint_sqft: 12_000,
    quarterly_rate_micros_per_sqft: 250_000,
    currency: "USD",
  });
  expect((await store.getSpatialMsgCommitment(MSG_SCOPE))?.reserved_footprint_sqft).toBe(12_000);

  // --- The once-only quarterly close per (commitment, quarter): the
  // recorded close reads back through the getter; an unknown quarter
  // reads undefined. ---
  await store.upsertSpatialMsgTermClose({
    commitment_id: commitment.id,
    scope_key: MSG_SCOPE,
    quarter: "2026-Q1",
    msg_due_cents: 3_000,
    earned_at_close_cents: 1_500,
    shortfall_cents: 1_500,
    invoice_ledger_id: null,
    closed_by: "spatial-desk",
  });
  const close = await store.getSpatialMsgTermClose(commitment.id, "2026-Q1");
  expect(close?.shortfall_cents).toBe(1_500);
  expect(close?.msg_due_cents).toBe(3_000);
  expect(await store.getSpatialMsgTermClose(commitment.id, "2026-Q3")).toBeUndefined();

  // --- The pop-up experience of record: insert-as-lock per popup_ref —
  // the FIRST registration wins; a re-shipped sheet throws (23505); the
  // winner reads back through the getter. ---
  const experience = await store.insertSpatialPopupExperience({
    popup_ref: POPUP_REF,
    venue_id: VENUE,
    zone_code: "ZONE-H",
    operator_id: OPERATOR,
    experience_kind: "halloween",
    window_start_date: "2026-10-01",
    window_end_date: "2026-12-30",
  });
  expect((await store.getSpatialPopupExperience(POPUP_REF))?.zone_code).toBe("ZONE-H");
  expect(await store.getSpatialPopupExperience("popup-ghost")).toBeUndefined();
  let experienceReplayThrew: unknown;
  try {
    await store.insertSpatialPopupExperience({
      popup_ref: POPUP_REF,
      venue_id: VENUE,
      zone_code: "ZONE-H",
      operator_id: OPERATOR,
      experience_kind: "halloween",
      window_start_date: "2026-10-02",
      window_end_date: "2026-12-31",
    });
  } catch (error) {
    experienceReplayThrew = error;
  }
  expectUniqueViolation(experienceReplayThrew);
  expect((await store.getSpatialPopupExperience(POPUP_REF))?.window_start_date).toBe("2026-10-01");

  // --- The post-event inventory write-off calculation: UNIQUE per
  // (experience, event) is the replay guard — a replayed calculation
  // throws, never a double-priced write-off. The listing reads the
  // events in ship order. ---
  await store.insertSpatialPopupWriteoff({
    popup_experience_id: experience.id,
    popup_ref: POPUP_REF,
    source_event_id: "writeoff-final",
    unsold_units: 40,
    unit_cost_cents: 250,
    writeoff_cents: 10_000,
    evidence_ref: "inventory-count.pdf",
    calculated_by: "pop-up-ops",
  });
  let writeoffReplayThrew: unknown;
  try {
    await store.insertSpatialPopupWriteoff({
      popup_experience_id: experience.id,
      popup_ref: POPUP_REF,
      source_event_id: "writeoff-final",
      unsold_units: 50,
      unit_cost_cents: 250,
      writeoff_cents: 12_500,
      evidence_ref: "inventory-count-late.pdf",
      calculated_by: "pop-up-ops",
    });
  } catch (error) {
    writeoffReplayThrew = error;
  }
  expectUniqueViolation(writeoffReplayThrew);
  await store.insertSpatialPopupWriteoff({
    popup_experience_id: experience.id,
    popup_ref: POPUP_REF,
    source_event_id: "writeoff-restock",
    unsold_units: 5,
    unit_cost_cents: 200,
    writeoff_cents: 1_000,
    evidence_ref: "inventory-count-2.pdf",
    calculated_by: "pop-up-ops",
  });
  const writeoffs = await store.listSpatialPopupWriteoffs(experience.id);
  expect(writeoffs.map((w) => w.source_event_id)).toEqual(["writeoff-final", "writeoff-restock"]);
  expect(await store.listSpatialPopupWriteoffs("popup-ghost")).toEqual([]);

  // --- The site restoration reserve of record: insert-as-lock per
  // pop-up experience — the FIRST reserve wins; a concurrent second
  // insert throws; the getter reads the winner. ---
  await store.insertSpatialPopupRestorationReserve({
    popup_experience_id: experience.id,
    popup_ref: POPUP_REF,
    reserve_cents: 15_000,
    evidence_ref: "restoration-quote.pdf",
    funded_by: OPERATOR,
  });
  expect((await store.getSpatialPopupRestorationReserve(experience.id))?.reserve_cents).toBe(15_000);
  expect(await store.getSpatialPopupRestorationReserve("popup-ghost")).toBeUndefined();
  let reserveReplayThrew: unknown;
  try {
    await store.insertSpatialPopupRestorationReserve({
      popup_experience_id: experience.id,
      popup_ref: POPUP_REF,
      reserve_cents: 99_000,
      evidence_ref: "restoration-quote-late.pdf",
      funded_by: OPERATOR,
    });
  } catch (error) {
    reserveReplayThrew = error;
  }
  expectUniqueViolation(reserveReplayThrew);
  expect((await store.getSpatialPopupRestorationReserve(experience.id))?.reserve_cents).toBe(15_000);

  // --- The founder-banded escrow policy of record per scope: upsert
  // replaces; unknown scopes read undefined. ---
  await store.upsertSpatialAuditEscrowPolicy({
    scope_key: ESCROW_SCOPE,
    reserve_rate_bps: 700,
  });
  expect((await store.getSpatialAuditEscrowPolicy(ESCROW_SCOPE))?.reserve_rate_bps).toBe(700);
  expect(await store.getSpatialAuditEscrowPolicy("venue:ghost")).toBeUndefined();
  await store.upsertSpatialAuditEscrowPolicy({
    scope_key: ESCROW_SCOPE,
    reserve_rate_bps: 1_200,
  });
  expect((await store.getSpatialAuditEscrowPolicy(ESCROW_SCOPE))?.reserve_rate_bps).toBe(1_200);

  // --- The escrow drawdown ledger: replay unique + position unique; the
  // listing reads position (drawn_before_cents) first. reserve_ledger_id
  // values are real ledger rows — the ledger-child discipline. ---
  const escrow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: ESCROW_SCOPE,
    payee_id: `spatial_audit_escrow:${VENUE}`,
    payee_name: `Spatial audit escrow — ${VENUE}`,
    role: "other",
    share_bps: 0,
    amount_cents: 70_000,
    currency: "USD",
    status: "spatial_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "spatial_audit_escrow",
  });
  // Balance semantics per the migration's pinned arithmetic: drawn_before
  // is the escrow balance before the draw, remaining is the balance after
  // (remaining = before − drawn); the first draw starts at the escrow
  // amount.
  await store.insertSpatialAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: ESCROW_SCOPE,
    drawdown_class: "entertainment_sales_tax",
    source_event_id: "tax-2026-q4",
    drawn_before_cents: 70_000,
    drawn_cents: 30_000,
    remaining_cents: 40_000,
  });
  await store.insertSpatialAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: ESCROW_SCOPE,
    drawdown_class: "safety_compliance_holdback",
    source_event_id: "safety-2026-q4",
    drawn_before_cents: 40_000,
    drawn_cents: 5_000,
    remaining_cents: 35_000,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertSpatialAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-2026-q4",
      drawn_before_cents: 40_000,
      drawn_cents: 1_000,
      remaining_cents: 39_000,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);
  let drawPositionThrew: unknown;
  try {
    await store.insertSpatialAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "safety_compliance_holdback",
      source_event_id: "safety-2026-q5",
      drawn_before_cents: 70_000,
      drawn_cents: 1_000,
      remaining_cents: 69_000,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listSpatialAuditEscrowDrawdowns(escrow.id);
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([70_000, 40_000]);

  // --- The reconciliation of record: unique per escrow — the verified
  // evidence lands once; a second insert throws; the getter reads the
  // winner. ---
  await store.insertSpatialAuditEscrowReconciliation({
    reserve_ledger_id: escrow.id,
    evidence_ref: "concession-audit-2026.pdf",
    reconciled_by: "compliance-desk",
  });
  expect(
    (await store.getSpatialAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("concession-audit-2026.pdf");
  expect(await store.getSpatialAuditEscrowReconciliation("missing")).toBeUndefined();
  let reconciliationReplayThrew: unknown;
  try {
    await store.insertSpatialAuditEscrowReconciliation({
      reserve_ledger_id: escrow.id,
      evidence_ref: "concession-audit-2026-late.pdf",
      reconciled_by: "compliance-desk",
    });
  } catch (error) {
    reconciliationReplayThrew = error;
  }
  expectUniqueViolation(reconciliationReplayThrew);
  expect(
    (await store.getSpatialAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("concession-audit-2026.pdf");

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleSpatialAuditEscrow(escrow.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(await store.settleSpatialAuditEscrow(escrow.id, T2)).toBeUndefined();
  expect(await store.settleSpatialAuditEscrow("missing", T2)).toBeUndefined();

  // --- The spatial payout gate states per (payee, venue): upsert
  // converges — a verification heals 'unknown'; states never regress
  // through this table; unknown pairs read undefined (the gate resolves
  // fail-closed through this). ---
  await store.upsertSpatialPayoutGateState({
    payee_id: PAYEE,
    venue_id: VENUE,
    territorial_zoning_state: "unknown",
    spatial_audit_state: "unknown",
    evidence_ref: "gate-evidence.pdf",
    verified_by: "compliance-desk",
  });
  const gateState = await store.getSpatialPayoutGateState(PAYEE, VENUE);
  expect(gateState?.territorial_zoning_state).toBe("unknown");
  expect(await store.getSpatialPayoutGateState(PAYEE, "venue-ghost")).toBeUndefined();
  await store.upsertSpatialPayoutGateState({
    payee_id: PAYEE,
    venue_id: VENUE,
    territorial_zoning_state: "cleared",
    spatial_audit_state: "verified",
    evidence_ref: "gate-evidence.pdf",
    verified_by: "compliance-desk",
  });
  const healed = await store.getSpatialPayoutGateState(PAYEE, VENUE);
  expect(healed?.territorial_zoning_state).toBe("cleared");
  expect(healed?.spatial_audit_state).toBe("verified");
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the spatial commitment
    // methods touch; the real SupabaseClient surface is far larger than
    // the store touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe.each(BACKENDS)("$name — the spatial commitments store contract", ({ make }) => {
  it("runs the whole spatial commitments scenario — commitments, applications, MSG closes, pop-ups, escrow, and gate states hold across all three backends", async () => {
    await scenario(make());
  });
});
