// Brand licensing MG recoupment + audit reserve + payout gate states (PR 33)
// — three-backend parity for the new store methods, mirroring the book
// returns reserve parity pattern: the same scenario script runs on
// InMemoryStore, SqliteStore (:memory:), and SupabaseStore over a
// behavioral PostgREST fake.
//
// Under test (migration 0037): the MG commitment upsert (convergent per
// (scope_key, commitment_ref)), the append-only MG recoupment applications
// with their replay + position uniques, the once-only annual term close,
// the founder-banded audit-reserve policy upsert, the position-locked
// reserve drawdowns, the reconciliation of record (insert-as-lock per
// reserve — the release gate's key), the licensing payout gate states
// (convergent per (payee_id, scope_key)), and the reserve settle CAS (one
// winner).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
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

  insert(row: Row): { row: Row | null; error: { message: string; code: string } | null } {
    for (const unique of this.uniques) {
      const key = unique.columns.map((column) => row[column]);
      if (
        key.every((value) => value !== undefined) &&
        this.rows.some((existing) =>
          unique.columns.every((column) => existing[column] === row[column]),
        )
      ) {
        return {
          row: null,
          error: {
            message: `duplicate key value violates unique constraint ${unique.name}`,
            code: "23505",
          },
        };
      }
    }
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
        (existing) =>
          conflictColumn !== undefined && existing[conflictColumn] === row[conflictColumn],
      );
      if (index >= 0) {
        // PostgREST's ON CONFLICT DO UPDATE SET covers only the transmitted
        // columns — untransmitted columns (id, created_at) keep their
        // stored values, so a re-registration never rotates the identity.
        this.rows[index] = { ...this.rows[index], ...row };
        return { row: { ...this.rows[index] }, error: null };
      }
    }
    // A fresh insert: the table defaults (gen_random_uuid(), now()) fill
    // id and created_at when the payload omits them; payload keys win when
    // it supplies them.
    const stored = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      insertion_order: ++this.sequence,
      ...row,
    };
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

  constructor(private readonly uniques: Record<string, UniqueConstraint[]> = {}) {}

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(this.uniques[table] ?? []);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// The unique constraints migration 0037 enforces — the fake reproduces
// their 23505 behavior so the replay, position, and insert-as-lock guards
// exercise end to end.
const FAKE_UNIQUES = {
  licensing_mg_commitments: [
    { name: "licensing_mg_commitments_scope_ref_key", columns: ["scope_key", "commitment_ref"] },
  ],
  licensing_mg_recoupment_applications: [
    {
      name: "licensing_mg_recoupment_applications_replay_key",
      columns: ["commitment_id", "source_event_id"],
    },
    {
      name: "licensing_mg_recoupment_applications_position_key",
      columns: ["commitment_id", "recouped_before_cents"],
    },
  ],
  licensing_mg_term_closes: [
    { name: "licensing_mg_term_closes_commitment_term_key", columns: ["commitment_id", "term"] },
  ],
  licensing_audit_reserve_policies: [
    { name: "licensing_audit_reserve_policies_scope_key_key", columns: ["scope_key"] },
  ],
  licensing_audit_reserve_drawdowns: [
    {
      name: "licensing_audit_reserve_drawdowns_replay_key",
      columns: ["reserve_ledger_id", "source_event_id"],
    },
    {
      name: "licensing_audit_reserve_drawdowns_position_key",
      columns: ["reserve_ledger_id", "drawn_before_cents"],
    },
  ],
  licensing_audit_reserve_reconciliations: [
    { name: "licensing_audit_reserve_reconciliations_reserve_key", columns: ["reserve_ledger_id"] },
  ],
  licensing_payout_gate_states: [
    { name: "licensing_payout_gate_states_payee_scope_key", columns: ["payee_id", "scope_key"] },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-09-30T12:00:00.000Z";
const T1 = "2026-09-30T12:00:01.000Z";
const T2 = "2026-09-30T12:00:02.000Z";
const T3 = "2026-09-30T12:00:03.000Z";
const SCOPE = "license:LIC-FOOTWEAR-001";
const SCOPE_B = "license:LIC-APPAREL-002";
const COMMITMENT_REF = "ADV-2026-001";
const LICENSEE = "licensee-northwind";

function expectUniqueViolation(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(
    message.includes("23505") || message.includes("UNIQUE constraint failed"),
  ).toBe(true);
}

async function scenario(store: Store): Promise<void> {
  // --- The MG commitment of record: upsert per (scope, ref), a
  // re-registration converges on the same row, unknown scopes read
  // undefined, the scope listing reads created_at ASC. ---
  const commitment = await store.upsertLicensingMgCommitment({
    scope_key: SCOPE,
    commitment_ref: COMMITMENT_REF,
    category_code: "footwear",
    collateralization: "category_isolated",
    mg_amount_cents: 25_000_000,
    currency: "USD",
    licensee_id: LICENSEE,
    licensee_name: "Northwind Footwear Co.",
  });
  expect(commitment.mg_amount_cents).toBe(25_000_000);
  expect(commitment.recouped_cents).toBe(0);

  const reread = await store.getLicensingMgCommitment(SCOPE, COMMITMENT_REF);
  expect(reread?.id).toBe(commitment.id);
  expect(await store.getLicensingMgCommitment(SCOPE_B, COMMITMENT_REF)).toBeUndefined();

  const apparel = await store.upsertLicensingMgCommitment({
    scope_key: SCOPE_B,
    commitment_ref: COMMITMENT_REF,
    category_code: "apparel",
    collateralization: "cross_collateralized",
    mg_amount_cents: 10_000_000,
    currency: "USD",
    licensee_id: LICENSEE,
    licensee_name: "Northwind Apparel Co.",
  });
  expect(
    (await store.listLicensingMgCommitments(SCOPE_B)).map((r) => r.id),
  ).toEqual([apparel.id]);

  // The convergent re-registration: same (scope, ref) key replaces the
  // terms atomically and keeps the row's identity.
  const reRegistered = await store.upsertLicensingMgCommitment({
    scope_key: SCOPE,
    commitment_ref: COMMITMENT_REF,
    category_code: "footwear",
    collateralization: "category_isolated",
    mg_amount_cents: 27_500_000,
    currency: "USD",
    licensee_id: LICENSEE,
    licensee_name: "Northwind Footwear Co.",
  });
  expect(reRegistered.id).toBe(commitment.id);
  expect(reRegistered.mg_amount_cents).toBe(27_500_000);
  expect((await store.listLicensingMgCommitments(SCOPE))).toHaveLength(1);

  // --- The append-only recoupment applications: replay per
  // (commitment, event) and position per (commitment, before) both throw
  // the unique violation; the listing reads created_at ASC. ---
  const first = await store.insertLicensingMgRecoupmentApplication({
    commitment_id: commitment.id,
    scope_key: SCOPE,
    category_code: "footwear",
    source_event_id: "royalty-evt-1",
    earned_royalty_cents: 500_000,
    recouped_before_cents: 0,
    recouped_cents: 500_000,
    recouped_after_cents: 500_000,
  });
  expect(first.recouped_after_cents).toBe(500_000);

  const second = await store.insertLicensingMgRecoupmentApplication({
    commitment_id: commitment.id,
    scope_key: SCOPE,
    category_code: "footwear",
    source_event_id: "royalty-evt-2",
    earned_royalty_cents: 300_000,
    recouped_before_cents: 500_000,
    recouped_cents: 300_000,
    recouped_after_cents: 800_000,
  });

  let eventReplayThrew: unknown;
  try {
    await store.insertLicensingMgRecoupmentApplication({
      commitment_id: commitment.id,
      scope_key: SCOPE,
      category_code: "footwear",
      source_event_id: "royalty-evt-1",
      earned_royalty_cents: 500_000,
      recouped_before_cents: 800_000,
      recouped_cents: 100_000,
      recouped_after_cents: 900_000,
    });
  } catch (error) {
    eventReplayThrew = error;
  }
  expectUniqueViolation(eventReplayThrew);

  let positionReplayThrew: unknown;
  try {
    await store.insertLicensingMgRecoupmentApplication({
      commitment_id: commitment.id,
      scope_key: SCOPE,
      category_code: "footwear",
      source_event_id: "royalty-evt-3",
      earned_royalty_cents: 100_000,
      recouped_before_cents: 0,
      recouped_cents: 50_000,
      recouped_after_cents: 50_000,
    });
  } catch (error) {
    positionReplayThrew = error;
  }
  expectUniqueViolation(positionReplayThrew);

  const applications = await store.listLicensingMgRecoupmentApplications(commitment.id);
  // The position lock forces recouped_before_cents to strictly increase
  // with insertion order, so this asserts the created_at ASC application
  // order without depending on same-millisecond tie behavior.
  expect(applications.map((r) => r.recouped_before_cents)).toEqual([0, 500_000]);
  expect(new Set(applications.map((r) => r.source_event_id))).toEqual(
    new Set(["royalty-evt-1", "royalty-evt-2"]),
  );

  // --- The once-only term close: upsert per (commitment, term), a replayed
  // close converges on the recorded shortfall and invoice of record, an
  // unclosed term reads undefined, the scope listing reads created_at ASC. ---
  await store.upsertLicensingMgTermClose({
    commitment_id: commitment.id,
    scope_key: SCOPE,
    term: "2026",
    mg_due_cents: 25_000_000,
    recouped_at_close_cents: 20_800_000,
    shortfall_cents: 4_200_000,
    invoice_ledger_id: "ledger-invoice-1",
    closed_by: "recon-worker",
  });
  const close = await store.getLicensingMgTermClose(commitment.id, "2026");
  expect(close?.shortfall_cents).toBe(4_200_000);
  expect(close?.invoice_ledger_id).toBe("ledger-invoice-1");
  expect(await store.getLicensingMgTermClose(commitment.id, "2027")).toBeUndefined();

  const replayedClose = await store.upsertLicensingMgTermClose({
    commitment_id: commitment.id,
    scope_key: SCOPE,
    term: "2026",
    mg_due_cents: 25_000_000,
    recouped_at_close_cents: 20_800_000,
    shortfall_cents: 4_200_000,
    invoice_ledger_id: "ledger-invoice-1",
    closed_by: "recon-worker",
  });
  expect(replayedClose.id).toBe(close?.id);
  expect((await store.listLicensingMgTermCloses(SCOPE)).map((r) => r.term)).toEqual(["2026"]);

  // --- The audit-reserve policy of record: upsert per scope converges (the
  // newest rate governs), unknown scopes read undefined. ---
  await store.upsertLicensingAuditReservePolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 700,
  });
  expect((await store.getLicensingAuditReservePolicy(SCOPE))?.reserve_rate_bps).toBe(700);
  await store.upsertLicensingAuditReservePolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 900,
  });
  const policy = await store.getLicensingAuditReservePolicy(SCOPE);
  if (policy === undefined) {
    throw new Error("the policy of record must read back after the re-registration");
  }
  expect(policy.reserve_rate_bps).toBe(900);
  // The second registration's updated_at reflects the latest write; the
  // original insert's created_at is preserved (never rotated forward).
  expect(policy.created_at <= policy.updated_at).toBe(true);
  expect(await store.getLicensingAuditReservePolicy(SCOPE_B)).toBeUndefined();

  // --- The reserve settle CAS: one winner — the row only when THIS call
  // flipped the status; the loser and unknown ids read undefined. ---
  const reserveRow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: `audit_reserve_escrow:${SCOPE}`,
    payee_name: `Audit reserve escrow — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: 70_000,
    currency: "USD",
    status: "audit_reserve_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0,
    settled_at: null,
    kind: "audit_reserve_escrow",
  });
  const settled = await store.settleLicensingAuditReserve(reserveRow.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(await store.settleLicensingAuditReserve(reserveRow.id, T3)).toBeUndefined();
  expect(await store.settleLicensingAuditReserve("missing", T3)).toBeUndefined();

  // --- The position-locked drawdowns: replay per (reserve, event) and
  // position per (reserve, before) both throw; the listing reads
  // created_at ASC. ---
  await store.insertLicensingAuditReserveDrawdown({
    reserve_ledger_id: reserveRow.id,
    scope_key: SCOPE,
    drawdown_class: "quarterly_audit_reconciliation",
    source_event_id: "audit-2026-Q3",
    drawn_before_cents: 70_000,
    drawn_cents: 21_000,
    remaining_cents: 49_000,
  });
  await store.insertLicensingAuditReserveDrawdown({
    reserve_ledger_id: reserveRow.id,
    scope_key: SCOPE,
    drawdown_class: "inventory_write_off",
    source_event_id: "wo-warehouse-7",
    drawn_before_cents: 49_000,
    drawn_cents: 5_000,
    remaining_cents: 44_000,
  });

  let drawReplayThrew: unknown;
  try {
    await store.insertLicensingAuditReserveDrawdown({
      reserve_ledger_id: reserveRow.id,
      scope_key: SCOPE,
      drawdown_class: "quarterly_audit_reconciliation",
      source_event_id: "audit-2026-Q3",
      drawn_before_cents: 44_000,
      drawn_cents: 1_000,
      remaining_cents: 43_000,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);

  let drawPositionThrew: unknown;
  try {
    await store.insertLicensingAuditReserveDrawdown({
      reserve_ledger_id: reserveRow.id,
      scope_key: SCOPE,
      drawdown_class: "inventory_write_off",
      source_event_id: "wo-warehouse-8",
      drawn_before_cents: 49_000,
      drawn_cents: 2_000,
      remaining_cents: 47_000,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);

  const drawdowns = await store.listLicensingAuditReserveDrawdowns(reserveRow.id);
  // The position lock forces drawn_before_cents to strictly increase with
  // insertion order, so this asserts the created_at ASC spend order without
  // depending on same-millisecond tie behavior.
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([70_000, 49_000]);
  expect(new Set(drawdowns.map((r) => r.source_event_id))).toEqual(
    new Set(["audit-2026-Q3", "wo-warehouse-7"]),
  );

  // --- The reconciliation of record: insert-as-lock per reserve — the
  // first insert wins and reads back; a second insert throws the unique
  // violation; an unreconciled reserve reads undefined. ---
  await store.insertLicensingAuditReserveReconciliation({
    reserve_ledger_id: reserveRow.id,
    evidence_ref: "audit-report-2026-Q3.pdf",
    reconciled_by: "external-audit-co",
  });
  const reconciliation = await store.getLicensingAuditReserveReconciliation(reserveRow.id);
  expect(reconciliation?.evidence_ref).toBe("audit-report-2026-Q3.pdf");
  expect(await store.getLicensingAuditReserveReconciliation("ledger-none")).toBeUndefined();

  let secondReconciliationThrew: unknown;
  try {
    await store.insertLicensingAuditReserveReconciliation({
      reserve_ledger_id: reserveRow.id,
      evidence_ref: "audit-report-2026-Q4.pdf",
      reconciled_by: "external-audit-co",
    });
  } catch (error) {
    secondReconciliationThrew = error;
  }
  expectUniqueViolation(secondReconciliationThrew);

  // --- The licensing payout gate states: upsert per (payee, scope)
  // converges, absent scopes read undefined. ---
  await store.upsertLicensingPayoutGateState({
    payee_id: "payee-founder",
    scope_key: SCOPE,
    territory_state: "unknown",
    category_exclusivity_state: "unknown",
    territory_evidence_ref: null,
    category_exclusivity_evidence_ref: null,
    verified_by: null,
  });
  const unknownGate = await store.getLicensingPayoutGateState("payee-founder", SCOPE);
  expect(unknownGate?.territory_state).toBe("unknown");

  // A verification heals the unknown states — the newest states govern.
  await store.upsertLicensingPayoutGateState({
    payee_id: "payee-founder",
    scope_key: SCOPE,
    territory_state: "cleared",
    category_exclusivity_state: "verified",
    territory_evidence_ref: "TR-001",
    category_exclusivity_evidence_ref: "CX-001",
    verified_by: "verifier_1",
  });
  const healedGate = await store.getLicensingPayoutGateState("payee-founder", SCOPE);
  expect(healedGate?.territory_state).toBe("cleared");
  expect(healedGate?.category_exclusivity_state).toBe("verified");
  expect(healedGate?.verified_by).toBe("verifier_1");
  expect(await store.getLicensingPayoutGateState("payee-founder", SCOPE_B)).toBeUndefined();
}

/** A held audit-reserve escrow credit under a caller-supplied status. */
async function insertReserveCredit(
  store: Store,
  scope: string,
  status: "audit_reserve_escrow" | "settled",
  createdAt: string,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: scope,
    payee_id: `audit_reserve_escrow:${scope}`,
    payee_name: `Audit reserve escrow — ${scope}`,
    role: "other",
    share_bps: 0,
    amount_cents: 70_000,
    currency: "USD",
    status,
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "audit_reserve_escrow",
  });
}

async function paritySecondScenario(store: Store): Promise<void> {
  // The reserve settle CAS across DISTINCT reserves — settling one never
  // touches another; a settled reserve cannot re-enter the queue.
  const one = await insertReserveCredit(store, SCOPE, "audit_reserve_escrow", T0);
  const two = await insertReserveCredit(store, SCOPE_B, "audit_reserve_escrow", T1);
  const alreadySettled = await insertReserveCredit(store, "license:LIC-003", "settled", T2);

  const winner = await store.settleLicensingAuditReserve(one.id, T2);
  expect(winner?.id).toBe(one.id);
  expect((await store.getLedgerTransaction(two.id))?.status).toBe("audit_reserve_escrow");
  expect((await store.getLedgerTransaction(alreadySettled.id))?.status).toBe("settled");
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the PR 33 methods touch; the
    // real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("licensing MG recoupment + audit reserve + gate states — three-backend parity (migration 0037)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the commitment upsert, recoupment applications, term closes, reserve policies, settle CAS, drawdowns, reconciliations, and gate states identically", async () => {
        await scenario(backend.make());
      });

      it("settles each reserve independently — the CAS never crosses reserves", async () => {
        await paritySecondScenario(backend.make());
      });
    });
  }
});
