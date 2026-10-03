// Resource audit escrow + resource payout gate states (PR 49, the founder
// resource directive) — three-backend parity for the new store methods,
// mirroring the patent litigation escrow parity pattern: the same scenario
// script runs on InMemoryStore, SqliteStore (:memory:), and SupabaseStore
// over a behavioral PostgREST fake.
//
// Under test: the resource payout gate's states of record per (payee,
// parcel) — environmental_compliance_state and title_ownership_state
// upsert-converging, absent reads fail-closed — the founder-banded
// (500–1500 bps) escrow policy per owner+parcel scope, the escrow
// drawdown ledger with its two uniques (replay + position), the
// reconciliation of record (insert-as-lock per escrow), the escrow
// settlement CAS (one winner), and the staged GPU grid-split
// application's journal stamp (the instant cascade's CAS — journal_id
// null → stamped exactly once).

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { makeFakeSupabaseStore } from "@/workers/recon/__tests__/fakeSupabase";
import { resourceAuditEscrowScopeKey } from "@/modules/energy/records";
import { resourceAuditEscrowPayeeId } from "@/modules/don/constants";

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
];

/** Both backend surfaces the canonical helper detects: the Postgres 23505
 * code (SupabaseStore wraps it into the thrown message) and SQLite's
 * native constraint text. */
function expectUniqueViolation(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(
    message.includes("23505") || message.includes("UNIQUE constraint failed"),
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// The shared scenario script — the PR 49 resource tables.
// ---------------------------------------------------------------------------

const T1 = "2026-10-03T12:00:01.000Z";
const T2 = "2026-10-03T12:00:02.000Z";
const T3 = "2026-10-03T12:00:03.000Z";
const OWNER = "rancher-parity";
const PARCEL = "PARCEL-PARITY-1";
const SCOPE = resourceAuditEscrowScopeKey(OWNER, PARCEL);

async function scenario(store: Store): Promise<void> {
  // --- The resource payout gate's durable states of record per (payee,
  // parcel): upsert converges — a verification heals 'unknown'; an
  // absent record reads undefined (the gate's fail-closed null). ---
  await store.upsertResourcePayoutGateState({
    payee_id: OWNER,
    parcel_id: PARCEL,
    environmental_compliance_state: "unknown",
    title_ownership_state: "unknown",
    evidence_ref: "environmental-title-audit.pdf",
    verified_by: "compliance-desk",
  });
  const unknownStates = await store.getResourcePayoutGateState(OWNER, PARCEL);
  expect(unknownStates?.environmental_compliance_state).toBe("unknown");
  expect(unknownStates?.title_ownership_state).toBe("unknown");
  expect(
    await store.getResourcePayoutGateState("rancher-other", PARCEL),
  ).toBeUndefined();
  await store.upsertResourcePayoutGateState({
    payee_id: OWNER,
    parcel_id: PARCEL,
    environmental_compliance_state: "cleared",
    title_ownership_state: "verified",
    evidence_ref: "environmental-title-audit-v2.pdf",
    verified_by: "compliance-desk",
  });
  const clearedStates = await store.getResourcePayoutGateState(OWNER, PARCEL);
  expect(clearedStates?.environmental_compliance_state).toBe("cleared");
  expect(clearedStates?.title_ownership_state).toBe("verified");

  // --- The founder-banded escrow policy of record per scope: upsert
  // replaces; unknown scopes read undefined. ---
  await store.upsertResourceAuditEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 500,
  });
  expect((await store.getResourceAuditEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(500);
  expect(
    await store.getResourceAuditEscrowPolicy(
      resourceAuditEscrowScopeKey("rancher-other", PARCEL),
    ),
  ).toBeUndefined();
  await store.upsertResourceAuditEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 1500,
  });
  expect((await store.getResourceAuditEscrowPolicy(SCOPE))?.reserve_rate_bps).toBe(1500);

  // --- The escrow drawdown ledger: replay unique + position unique; the
  // listing reads position (drawn_before_cents) first. reserve_ledger_id
  // values are real ledger rows — the ledger-child discipline. ---
  const escrow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: resourceAuditEscrowPayeeId(SCOPE),
    payee_name: `RESOURCE_AUDIT_ESCROW — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: 150_000,
    currency: "USD",
    status: "resource_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "resource_audit_escrow",
  });
  await store.insertResourceAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "commodity_price_reconciliation",
    source_event_id: "commodity-recon-parity-2026-10",
    drawn_before_cents: 150_000,
    drawn_cents: 60_000,
    remaining_cents: 90_000,
  });
  await store.insertResourceAuditEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "pipeline_variance_audit",
    source_event_id: "pipeline-variance-parity-q4",
    drawn_before_cents: 90_000,
    drawn_cents: 25_000,
    remaining_cents: 65_000,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertResourceAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "environmental_compliance_check",
      source_event_id: "commodity-recon-parity-2026-10",
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
    await store.insertResourceAuditEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "environmental_compliance_check",
      source_event_id: "compliance-check-parity",
      drawn_before_cents: 90_000,
      drawn_cents: 100,
      remaining_cents: 89_900,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listResourceAuditEscrowDrawdowns(escrow.id);
  expect(drawdowns.map((r) => r.drawn_before_cents)).toEqual([150_000, 90_000]);

  // --- The reconciliation of record: unique per escrow — the verified
  // evidence lands once; a second insert throws; the getter reads the
  // winner. ---
  await store.insertResourceAuditEscrowReconciliation({
    reserve_ledger_id: escrow.id,
    evidence_ref: "commodity-recon-report.pdf",
    reconciled_by: "finance-desk",
  });
  expect(
    (await store.getResourceAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("commodity-recon-report.pdf");
  expect(await store.getResourceAuditEscrowReconciliation("missing")).toBeUndefined();
  let reconciliationReplayThrew: unknown;
  try {
    await store.insertResourceAuditEscrowReconciliation({
      reserve_ledger_id: escrow.id,
      evidence_ref: "commodity-recon-report-late.pdf",
      reconciled_by: "finance-desk",
    });
  } catch (error) {
    reconciliationReplayThrew = error;
  }
  expectUniqueViolation(reconciliationReplayThrew);
  expect(
    (await store.getResourceAuditEscrowReconciliation(escrow.id))?.evidence_ref,
  ).toBe("commodity-recon-report.pdf");

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleResourceAuditEscrow(escrow.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(await store.settleResourceAuditEscrow(escrow.id, T3)).toBeUndefined();
  expect(await store.settleResourceAuditEscrow("missing", T3)).toBeUndefined();

  // --- The staged GPU grid-split application's journal stamp — the
  // instant cascade's CAS: journal_id null stamps exactly once; a
  // second stamp, and an unknown id, read undefined (the loser of the
  // stamp race refuses; the replay reads the stamped journal). ---
  const staged = await store.insertEnergyComputeGridSplitApplication({
    source_event_id: "grid_split:PARITY-1:2026-10:USD",
    gpu_cluster_hash: "parity-cluster-hash",
    period: "2026-10",
    currency: "USD",
    compute_revenue_cents: 50_000,
    split_legs: JSON.stringify([
      {
        payee_id: "silicon-lessor-parity",
        participant_class: "gpu_hardware_owner",
        allocated_cents: 27_273,
      },
      {
        payee_id: "power-provider-parity",
        participant_class: "power_plant_operator",
        allocated_cents: 18_182,
      },
      {
        payee_id: "hosting-facility-parity",
        participant_class: "colocation_manager",
        allocated_cents: 4_545,
      },
    ]),
    allocated_total_cents: 50_000,
    journal_id: null,
  });
  expect(staged.journal_id).toBeNull();
  const stamped = await store.setEnergyComputeGridSplitJournal(
    "grid_split:PARITY-1:2026-10:USD",
    "journal-parity-1",
  );
  expect(stamped?.journal_id).toBe("journal-parity-1");
  expect(
    await store.setEnergyComputeGridSplitJournal(
      "grid_split:PARITY-1:2026-10:USD",
      "journal-parity-2",
    ),
  ).toBeUndefined();
  expect(
    await store.setEnergyComputeGridSplitJournal("grid_split:missing", "j"),
  ).toBeUndefined();
  const reread = await store.getEnergyComputeGridSplitApplication(
    "grid_split:PARITY-1:2026-10:USD",
  );
  expect(reread?.journal_id).toBe("journal-parity-1");
}

describe("resource audit escrow + resource payout gate states + staged grid-split journal stamps — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the gate states, escrow policy, drawdowns, reconciliation, settle CAS, and journal stamps identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
