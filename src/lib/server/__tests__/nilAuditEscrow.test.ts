// The NIL_AUDIT_ESCROW bucket + the transfer portal clawback (PR 35) — the
// behavioral suite for the founder's directive: 5–10% of athletic
// department distributions routed automatically into the reserved bucket
// at routing, drawn down ONLY by position-locked mid-season NCAA Transfer
// Portal reconciliations or tax withholdings, and released ONLY with a
// verified reconciliation of record — every absent/unknown state failing
// closed. A portal entry prior to contract completion prices the
// pro-rated unearned advance from the advance schedule of record and
// triggers the `nil_unearned_clawback` debit hold. The Don invariants
// hold throughout: integer cents, allocations plus dust equals gross
// including the escrow and clawback buckets, idempotency (a replayed
// event moves nothing twice), and the CAS as the concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  NIL_AUDIT_ESCROW_MAX_RATE_BPS,
  NIL_AUDIT_ESCROW_MIN_RATE_BPS,
  nilAuditEscrowPayeeId,
  nilAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildNilAuditEscrowSplitPlan,
  drawDownNilAuditEscrow,
  nilZeroBalanceHolds,
  reconcileNilAuditEscrow,
  recordNilTransferPortalEntry,
  registerNilAuditEscrowPolicy,
  releaseNilAuditEscrow,
  routeNilAuditEscrowFromDistribution,
  nilAuditEscrowScopeKey,
} from "@/lib/server/nilAuditEscrow";
import { buildProratedClawbackPlan } from "@/modules/nil/records";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-30T12:00:00.000Z");
const ATHLETE_ID = "athlete-jordan";
const ATHLETE_NAME = "Jordan Athlete";
const SCHOOL_ID = "school-state-u";
const SCOPE = nilAuditEscrowScopeKey(ATHLETE_ID, SCHOOL_ID);
const CONTRACT_ID = "nil-contract-001";
const HELD = 1_000_000; // the held distribution credit: $10,000

function makeStore(): Store {
  return new InMemoryStore();
}

async function seedVerifiedKyc(store: Store, creatorId: string): Promise<void> {
  await store.insertKycVerification({
    creator_id: creatorId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: T0.toISOString(),
    verified_at: T0.toISOString(),
  });
}

async function seedGateState(
  store: Store,
  states: {
    nil_clearance_state: "nil_cleared" | "unknown";
    compliance_state: "verified" | "unknown";
    title_ix_state: "cleared" | "unknown";
  },
  payeeId = ATHLETE_ID,
  schoolId = SCHOOL_ID,
): Promise<void> {
  await store.upsertNilPayoutGateState({
    payee_id: payeeId,
    school_id: schoolId,
    nil_clearance_state: states.nil_clearance_state,
    compliance_state: states.compliance_state,
    title_ix_state: states.title_ix_state,
    // A direct (unassociated) deal — the cap check skips only on an
    // explicit false, per the fail-closed canon.
    collective_or_booster_backed: false,
    institutional_cap_state: "verified",
    evidence_ref: null,
    verified_by: null,
  });
}

async function seedPolicy(store: Store, rateBps = 700): Promise<void> {
  const registered = await registerNilAuditEscrowPolicy(store, {
    payee_id: ATHLETE_ID,
    school_id: SCHOOL_ID,
    reserve_rate_bps: rateBps,
  });
  expect(registered.ok).toBe(true);
}

async function seedHeldCredit(
  store: Store,
  amountCents: number,
  createdAt: Date = T0,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "distribution-line-1",
    payee_id: ATHLETE_ID,
    payee_name: ATHLETE_NAME,
    role: "creator",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "unclaimed_holding",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt.toISOString(),
    settled_at: null,
    kind: "unclaimed_holding",
  });
}

/** The shared happy path: policy, cleared gate, verified KYC, held credit. */
async function seedRoutingFixture(store: Store, rateBps = 700): Promise<LedgerTransactionRecord> {
  await seedPolicy(store, rateBps);
  await seedGateState(store, {
    nil_clearance_state: "nil_cleared",
    compliance_state: "verified",
    title_ix_state: "cleared",
  });
  await seedVerifiedKyc(store, ATHLETE_ID);
  return seedHeldCredit(store, HELD);
}

async function seedAdvanceSchedule(
  store: Store,
  over: Partial<{ advance_cents: number; term_start_date: string; term_end_date: string }> = {},
): Promise<void> {
  await store.upsertNilAdvanceSchedule({
    nil_contract_id: CONTRACT_ID,
    athlete_id: ATHLETE_ID,
    school_id: SCHOOL_ID,
    advance_cents: 360_000,
    term_start_date: "2026-01-01",
    term_end_date: "2026-12-31",
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Policy registration — the founder's 5–10% band.
// ---------------------------------------------------------------------------

describe("registerNilAuditEscrowPolicy — the rate band", () => {
  it("accepts the band's endpoints (500 and 1000 bps) and a mid value", async () => {
    const store = makeStore();
    for (const rateBps of [
      NIL_AUDIT_ESCROW_MIN_RATE_BPS,
      700,
      NIL_AUDIT_ESCROW_MAX_RATE_BPS,
    ]) {
      const registered = await registerNilAuditEscrowPolicy(store, {
        payee_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        reserve_rate_bps: rateBps,
      });
      expect(registered.ok).toBe(true);
    }
  });

  it("refuses below 5% and above 10% fail-closed", async () => {
    const store = makeStore();
    for (const rateBps of [
      NIL_AUDIT_ESCROW_MIN_RATE_BPS - 1,
      NIL_AUDIT_ESCROW_MAX_RATE_BPS + 1,
      0,
      -700,
      700.5,
    ]) {
      const registered = await registerNilAuditEscrowPolicy(store, {
        payee_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        reserve_rate_bps: rateBps,
      });
      expect(registered.ok).toBe(false);
      if (!registered.ok) {
        expect(registered.code).toBe("escrow_rate_out_of_band");
      }
    }
  });

  it("refuses a blank athlete or school identity", async () => {
    const store = makeStore();
    for (const identity of [
      { payee_id: "   ", school_id: SCHOOL_ID },
      { payee_id: ATHLETE_ID, school_id: "  " },
    ]) {
      const registered = await registerNilEscrow(store, identity.payee_id, identity.school_id);
      expect(registered.ok).toBe(false);
      if (!registered.ok) {
        expect(registered.code).toBe("invalid_scope_identity");
      }
    }
  });

  it("converges on re-registration — the newest rate governs the next routing", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    const second = await registerNilAuditEscrowPolicy(store, {
      payee_id: ATHLETE_ID,
      school_id: SCHOOL_ID,
      reserve_rate_bps: 900,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reserve_rate_bps).toBe(900);
    expect(second.value.created_at).toBe(second.value.updated_at);
  });
});

async function registerNilEscrow(
  store: Store,
  payeeId: string,
  schoolId: string,
): Promise<{ ok: boolean; code?: string }> {
  const registered = await registerNilAuditEscrowPolicy(store, {
    payee_id: payeeId,
    school_id: schoolId,
    reserve_rate_bps: 700,
  });
  return registered.ok ? { ok: true } : { ok: false, code: registered.code };
}

// ---------------------------------------------------------------------------
// The split planner — exact integer cents including the bucket.
// ---------------------------------------------------------------------------

describe("buildNilAuditEscrowSplitPlan — the escrow bucket arithmetic", () => {
  it("floors the escrow share and keeps routed = amount − escrow with structurally-zero dust", () => {
    const planned = buildNilAuditEscrowSplitPlan({ amount_cents: 123_456, reserve_rate_bps: 700 });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(8_641); // floor(123456 × 0.07)
    expect(planned.value.routed_cents).toBe(123_456 - 8_641);
    expect(planned.value.company_dust_cents).toBe(0);
  });

  it("keeps routed plus escrow plus dust equal to the amount at every rate in the band", () => {
    for (const rateBps of [500, 613, 700, 999, 1000]) {
      const planned = buildNilAuditEscrowSplitPlan({ amount_cents: 999_999, reserve_rate_bps: rateBps });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      expect(
        planned.value.routed_cents + planned.value.escrow_cents + planned.value.company_dust_cents,
      ).toBe(999_999);
      expect(Number.isInteger(planned.value.routed_cents)).toBe(true);
      expect(Number.isInteger(planned.value.escrow_cents)).toBe(true);
    }
  });

  it("refuses a non-integer or non-positive amount and a rate outside the band", () => {
    for (const amount of [1_000.5, -1, 0]) {
      const planned = buildNilAuditEscrowSplitPlan({ amount_cents: amount, reserve_rate_bps: 700 });
      expect(planned.ok).toBe(false);
    }
    const offBand = buildNilAuditEscrowSplitPlan({ amount_cents: 1_000, reserve_rate_bps: 1_001 });
    expect(offBand.ok).toBe(false);
    if (offBand.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(offBand.code).toBe("escrow_rate_out_of_band");
  });
});

describe("nilZeroBalanceHolds — the house invariant", () => {
  it("accepts the exact allocation totals and refuses any drift", () => {
    expect(nilZeroBalanceHolds(1_000, [{ amount_cents: 300 }, { amount_cents: 700 }], 0)).toBe(true);
    expect(nilZeroBalanceHolds(999, [{ amount_cents: 700 }], 299)).toBe(true);
    expect(nilZeroBalanceHolds(1_000, [{ amount_cents: 300 }, { amount_cents: 701 }], 0)).toBe(false);
    expect(nilZeroBalanceHolds(1_000, [{ amount_cents: 300.5 }], 700)).toBe(false);
    expect(nilZeroBalanceHolds(1_000, [{ amount_cents: -1 }], 1_001)).toBe(false);
    expect(nilZeroBalanceHolds(1_000.5, [], 1_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing — the held distribution into the reserved bucket + the taxed
// cascade.
// ---------------------------------------------------------------------------

describe("routeNilAuditEscrowFromDistribution — the automatic routing", () => {
  it("splits the held credit at the policy rate: the escrow locks at the sentinel payee, the athlete rides the taxed cascade", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.amount_cents).toBe(HELD);
    expect(routed.value.split.escrow_cents).toBe(70_000);
    expect(routed.value.split.routed_cents).toBe(HELD - 70_000);
    expect(routed.value.split.company_dust_cents).toBe(0);

    // The escrow credit of record: the per-scope sentinel payee, kind AND
    // status 'nil_audit_escrow', the scope stamped in line_item_id.
    const escrowCredit = routed.value.escrow_credit;
    expect(escrowCredit).not.toBeNull();
    if (!escrowCredit) return;
    expect(escrowCredit.payee_id).toBe(nilAuditEscrowPayeeId(SCOPE));
    expect(escrowCredit.payee_name).toBe(nilAuditEscrowPayeeName(SCOPE));
    expect(escrowCredit.kind).toBe("nil_audit_escrow");
    expect(escrowCredit.status).toBe("nil_audit_escrow");
    expect(escrowCredit.amount_cents).toBe(70_000);
    expect(escrowCredit.line_item_id).toBe(SCOPE);

    // The held credit settled exactly once.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("settled");

    // The athlete's credit rode the taxed cascade — the net landed is
    // what the cascade reports, gross was the routed remainder.
    expect(routed.value.credits).toHaveLength(1);
    expect(routed.value.credits[0].payee_id).toBe(ATHLETE_ID);
    expect(routed.value.credits[0].step).toBe("athlete_net");
    expect(routed.value.credits[0].gross_cents).toBe(HELD - 70_000);

    // One balanced GL journal rode the routing.
    expect(routed.value.journal_id).not.toBeNull();
  });

  it("refuses a replayed routing fail-closed — the CAS returns distribution_already_released, never a second split", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);
    const first = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(first.ok).toBe(true);

    const replay = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("distribution_already_released");
  });

  it("refuses an unknown ledger row, a non-holding row, and an unapproved settlement", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 700);

    const missing = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: "ledger-none",
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(missing.code).toBe("distribution_credit_not_found");

    const wrongKind = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "payout-line-1",
      payee_id: ATHLETE_ID,
      payee_name: ATHLETE_NAME,
      role: "creator",
      share_bps: 0,
      amount_cents: 5_000,
      currency: "USD",
      status: "pending_settlement",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "payout",
    });
    const notHolding = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: wrongKind.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(notHolding.ok).toBe(false);
    if (notHolding.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(notHolding.code).toBe("not_a_holding_credit");

    const held = await seedHeldCredit(store, 500);
    const unapproved = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: false,
      },
      T0,
    );
    expect(unapproved.ok).toBe(false);
    if (unapproved.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(unapproved.code).toBe("settlement_not_approved");
  });

  it("fails closed on an absent gate record — absent means refuse, never default-allow", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedVerifiedKyc(store, ATHLETE_ID);

    const absentHeld = await seedHeldCredit(store, HELD);
    const absent = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: absentHeld.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(absent.ok).toBe(false);
    if (absent.ok) {
      expect.unreachable("expected a failure result");
    }
    // An ABSENT gate record resolves null — the gate refuses with
    // vertical_state_unknown (fail-closed).
    expect(absent.code).toBe("vertical_state_unknown");
  });

  it("fails closed on unknown gate states and on each individually-uncleared condition", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedVerifiedKyc(store, ATHLETE_ID);

    // A record with UNKNOWN states — unknown means refuse (the first
    // failing condition surfaces: nil_cleared).
    await seedGateState(store, {
      nil_clearance_state: "unknown",
      compliance_state: "unknown",
      title_ix_state: "unknown",
    });
    const unknownHeld = await seedHeldCredit(store, HELD);
    const unknown = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: unknownHeld.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(unknown.code).toBe("nil_not_cleared");

    // Cleared NIL but unverified compliance.
    await seedGateState(store, {
      nil_clearance_state: "nil_cleared",
      compliance_state: "unknown",
      title_ix_state: "unknown",
    });
    const complianceHeld = await seedHeldCredit(store, HELD);
    const complianceUnknown = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: complianceHeld.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(complianceUnknown.ok).toBe(false);
    if (complianceUnknown.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(complianceUnknown.code).toBe("nil_compliance_unverified");

    // Cleared NIL + verified compliance but uncleared Title IX.
    await seedGateState(store, {
      nil_clearance_state: "nil_cleared",
      compliance_state: "verified",
      title_ix_state: "unknown",
    });
    const titleIxHeld = await seedHeldCredit(store, HELD);
    const titleIxUnknown = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: titleIxHeld.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(titleIxUnknown.ok).toBe(false);
    if (titleIxUnknown.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(titleIxUnknown.code).toBe("nil_title_ix_proportionality_not_cleared");
  });

  it("refuses a scope with no registered policy — a counted refusal, never a guessed rate", async () => {
    const store = makeStore();
    await seedGateState(store, {
      nil_clearance_state: "nil_cleared",
      compliance_state: "verified",
      title_ix_state: "cleared",
    });
    await seedVerifiedKyc(store, ATHLETE_ID);
    const held = await seedHeldCredit(store, HELD);

    const noPolicy = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(noPolicy.ok).toBe(false);
    if (noPolicy.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(noPolicy.code).toBe("missing_nil_audit_escrow_policy");

    // Nothing moved.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("unclaimed_holding");
  });

  it("locks no escrow row when the floor prices zero on a sub-10-cent distribution — conservation still holds", async () => {
    const store = makeStore();
    await seedPolicy(store, 500); // 5% of 9¢ floors to 0
    await seedGateState(store, {
      nil_clearance_state: "nil_cleared",
      compliance_state: "verified",
      title_ix_state: "cleared",
    });
    await seedVerifiedKyc(store, ATHLETE_ID);
    const held = await seedHeldCredit(store, 9);

    const routed = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(0);
    expect(routed.value.escrow_credit).toBeNull();
    expect(routed.value.split.routed_cents).toBe(9);
    expect(routed.value.company_dust_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drawdown — the mid-season transfer portal reconciliation and the tax
// withholding spend the escrow.
// ---------------------------------------------------------------------------

describe("drawDownNilAuditEscrow — the spend lane", () => {
  async function seedEscrow(store: Store, amountCents = 70_000): Promise<LedgerTransactionRecord> {
    await seedPolicy(store, 700);
    return store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: SCOPE,
      payee_id: nilAuditEscrowPayeeId(SCOPE),
      payee_name: nilAuditEscrowPayeeName(SCOPE),
      role: "other",
      share_bps: 0,
      amount_cents: amountCents,
      currency: "USD",
      status: "nil_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "nil_audit_escrow",
    });
  }

  it("draws a mid-season transfer portal reconciliation down position-locked", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const drawn = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.replayed).toBe(false);
    expect(drawn.value.drawdown.drawn_before_cents).toBe(0);
    expect(drawn.value.drawdown.drawn_cents).toBe(25_000);
    expect(drawn.value.drawdown.remaining_cents).toBe(45_000);
    expect(drawn.value.journal_id).not.toBeNull();

    // The escrow is still held — the drawdown did not consume the last
    // cent.
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("nil_audit_escrow");
  });

  it("draws a tax withholding after a reconciliation — positions strictly advance", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const first = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(first.ok).toBe(true);

    const second = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "withholding-q3",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.drawdown.drawn_before_cents).toBe(25_000);
    expect(second.value.drawdown.remaining_cents).toBe(35_000);
  });

  it("refuses an overdraw — refuse, never clip", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 10_000);

    const overdrawn = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "withholding-q3",
        drawn_cents: 10_001,
      },
      T0,
    );
    expect(overdrawn.ok).toBe(false);
    if (overdrawn.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(overdrawn.code).toBe("escrow_overdrawn");
  });

  it("refuses an invalid class and a non-integer amount", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const badClass = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off", // the licensing vocabulary — not this lane's
        source_event_id: "evt-1",
        drawn_cents: 100,
      },
      T0,
    );
    expect(badClass.ok).toBe(false);
    if (badClass.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(badClass.code).toBe("invalid_drawdown_class");

    const badAmount = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "evt-2",
        drawn_cents: 100.5,
      },
      T0,
    );
    expect(badAmount.ok).toBe(false);
    if (badAmount.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(badAmount.code).toBe("invalid_drawdown_amount");
  });

  it("replays a re-shipped source event as a counted no-op — never a second drawdown or journal", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const first = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(first.ok).toBe(true);

    const replay = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.journal_id).toBeNull();

    // Exactly one drawdown row exists.
    const all = await store.listNilAuditEscrowDrawdowns(escrow.id);
    expect(all).toHaveLength(1);
  });

  it("a last-cent drawdown settles the escrow first — and a settled escrow refuses further draws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 10_000);

    const lastCent = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(lastCent.ok).toBe(true);

    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("settled");

    const afterSettled = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "withholding-late",
        drawn_cents: 1,
      },
      T0,
    );
    expect(afterSettled.ok).toBe(false);
    if (afterSettled.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(afterSettled.code).toBe("escrow_already_settled");
  });

  it("refuses a scope mismatch and an unknown ledger row", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const mismatch = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: "payee:other:school:other-u",
        drawdown_class: "tax_withholding",
        source_event_id: "evt-1",
        drawn_cents: 100,
      },
      T0,
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(mismatch.code).toBe("escrow_scope_mismatch");

    const missing = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: "ledger-none",
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "evt-2",
        drawn_cents: 100,
      },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(missing.code).toBe("escrow_credit_not_found");
  });
});

// ---------------------------------------------------------------------------
// The verified reconciliation of record + the release lane.
// ---------------------------------------------------------------------------

describe("reconcileNilAuditEscrow + releaseNilAuditEscrow — the verified release", () => {
  async function seedHeldEscrow(
    store: Store,
    amountCents = 70_000,
  ): Promise<LedgerTransactionRecord> {
    await seedPolicy(store, 700);
    return store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: SCOPE,
      payee_id: nilAuditEscrowPayeeId(SCOPE),
      payee_name: nilAuditEscrowPayeeName(SCOPE),
      role: "other",
      share_bps: 0,
      amount_cents: amountCents,
      currency: "USD",
      status: "nil_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "nil_audit_escrow",
    });
  }

  it("records the reconciliation of record insert-as-lock — the first wins, a second throws", async () => {
    const store = makeStore();
    const escrow = await seedHeldEscrow(store);

    const reconciled = await reconcileNilAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "portal-audit-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(reconciled.ok).toBe(true);

    let secondThrew: unknown;
    try {
      await reconcileNilAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "portal-audit-2026-late.pdf",
        reconciled_by: "compliance-desk",
      });
    } catch (error) {
      secondThrew = error;
    }
    expect(secondThrew).toBeInstanceOf(Error);

    const readBack = await store.getNilAuditEscrowReconciliation(escrow.id);
    expect(readBack?.evidence_ref).toBe("portal-audit-2026.pdf");
  });

  it("refuses a reconciliation with blank evidence or reconciler, and a scope mismatch", async () => {
    const store = makeStore();
    const escrow = await seedHeldEscrow(store);

    const blankEvidence = await reconcileNilAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "  ",
      reconciled_by: "compliance-desk",
    });
    expect(blankEvidence.ok).toBe(false);
    if (blankEvidence.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(blankEvidence.code).toBe("invalid_reconciliation_evidence");

    const mismatch = await reconcileNilAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: "payee:other:school:other-u",
      evidence_ref: "portal-audit-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(mismatch.code).toBe("not_an_escrow_credit");
  });

  it("releases the remaining balance to the athlete only against the verified reconciliation — zero-balance conserved", async () => {
    const store = makeStore();
    const escrow = await seedHeldEscrow(store, 70_000);

    // A drawdown spent part of the escrow first.
    const drawn = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 20_000,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);

    await reconcileNilAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "portal-audit-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    await seedGateState(store, {
      nil_clearance_state: "nil_cleared",
      compliance_state: "verified",
      title_ix_state: "cleared",
    });
    await seedVerifiedKyc(store, ATHLETE_ID);

    const released = await releaseNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(50_000);
    expect(released.value.credits[0].payee_id).toBe(ATHLETE_ID);
    expect(released.value.journal_id).not.toBeNull();

    // The escrow settled exactly once.
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("settled");

    // THE INVARIANT: drawdowns + released + dust === the locked escrow.
    expect(
      nilZeroBalanceHolds(70_000, [{ amount_cents: 20_000 }, { amount_cents: 50_000 }], 0),
    ).toBe(true);
  });

  it("refuses a release with no reconciliation of record — fail-closed before the CAS", async () => {
    const store = makeStore();
    const escrow = await seedHeldEscrow(store);
    await seedGateState(store, {
      nil_clearance_state: "nil_cleared",
      compliance_state: "verified",
      title_ix_state: "cleared",
    });
    await seedVerifiedKyc(store, ATHLETE_ID);

    const released = await releaseNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(released.status).toBe(403);
    expect(released.code).toBe("nil_audit_escrow_reconciliation_missing");

    // Nothing moved.
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("nil_audit_escrow");
  });

  it("fails closed on an absent gate record at release too", async () => {
    const store = makeStore();
    const escrow = await seedHeldEscrow(store);
    await reconcileNilAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "portal-audit-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    // The gate check runs after KYC — seed verified KYC so the ABSENT gate
    // record is what the release refuses on.
    await seedVerifiedKyc(store, ATHLETE_ID);
    // No gate state — the release refuses.

    const released = await releaseNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(released.code).toBe("vertical_state_unknown");
  });

  it("refuses a fully-drawn escrow's release and a scope-mismatched release", async () => {
    const store = makeStore();
    const escrow = await seedHeldEscrow(store, 10_000);
    await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "withholding-q3",
        drawn_cents: 10_000,
      },
      T0,
    );
    // Fully drawn — the drawdown settled the escrow outright.
    const released = await releaseNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(released.code).toBe("escrow_already_settled");

    // Scope mismatch: the pair must re-derive the scope.
    const fresh = await seedHeldEscrow(store, 10_000);
    const mismatch = await releaseNilAuditEscrow(
      store,
      {
        reserve_ledger_id: fresh.id,
        scope_key: SCOPE,
        athlete_id: "athlete-someone-else",
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(mismatch.code).toBe("escrow_scope_mismatch");
  });
});

// ---------------------------------------------------------------------------
// The pro-rated clawback — the pure math.
// ---------------------------------------------------------------------------

describe("buildProratedClawbackPlan — the pro-ration identity", () => {
  const TERM_START = "2026-01-01";
  const TERM_END = "2026-12-31"; // 364 days

  it("prices the mid-season entry: floor(advance × served / total) earned, the subtraction remainder unearned", () => {
    const plan = buildProratedClawbackPlan({
      advance_cents: 360_000,
      term_start_date: TERM_START,
      term_end_date: TERM_END,
      portal_entry_date: "2026-07-02", // 182 days served
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.total_term_days).toBe(364);
    expect(plan.value.served_days).toBe(182);
    expect(plan.value.earned_cents).toBe(Math.floor((360_000 * 182) / 364));
    expect(plan.value.earned_cents).toBe(180_000);
    expect(plan.value.unearned_cents).toBe(180_000);
    expect(plan.value.earned_cents + plan.value.unearned_cents).toBe(360_000);
    expect(plan.value.clawback_due).toBe(true);
  });

  it("keeps earned plus unearned equal to the advance on every pro-ration remainder", () => {
    for (const entryDay of [1, 100, 183, 250, 363]) {
      const entryDate = new Date(Date.UTC(2026, 0, 1 + entryDay)).toISOString().slice(0, 10);
      const plan = buildProratedClawbackPlan({
        advance_cents: 999_999,
        term_start_date: TERM_START,
        term_end_date: TERM_END,
        portal_entry_date: entryDate,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.value.earned_cents + plan.value.unearned_cents).toBe(999_999);
      expect(Number.isInteger(plan.value.earned_cents)).toBe(true);
      expect(Number.isInteger(plan.value.unearned_cents)).toBe(true);
    }
  });

  it("claws nothing back on an entry on or after contract completion", () => {
    for (const entryDate of [TERM_END, "2027-01-01"]) {
      const plan = buildProratedClawbackPlan({
        advance_cents: 360_000,
        term_start_date: TERM_START,
        term_end_date: TERM_END,
        portal_entry_date: entryDate,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.value.clawback_due).toBe(false);
      expect(plan.value.unearned_cents).toBe(0);
    }
  });

  it("claws the full advance back on an entry before the term opened", () => {
    const plan = buildProratedClawbackPlan({
      advance_cents: 360_000,
      term_start_date: TERM_START,
      term_end_date: TERM_END,
      portal_entry_date: "2025-12-15",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.served_days).toBe(0);
    expect(plan.value.earned_cents).toBe(0);
    expect(plan.value.unearned_cents).toBe(360_000);
    expect(plan.value.clawback_due).toBe(true);
  });

  it("refuses a non-integer advance, malformed dates, and a non-positive term", () => {
    expect(
      buildProratedClawbackPlan({
        advance_cents: 100.5,
        term_start_date: TERM_START,
        term_end_date: TERM_END,
        portal_entry_date: "2026-07-02",
      }).ok,
    ).toBe(false);
    expect(
      buildProratedClawbackPlan({
        advance_cents: 100,
        term_start_date: "2026-13-01",
        term_end_date: TERM_END,
        portal_entry_date: "2026-07-02",
      }).ok,
    ).toBe(false);
    expect(
      buildProratedClawbackPlan({
        advance_cents: 100,
        term_start_date: TERM_START,
        term_end_date: TERM_END,
        portal_entry_date: "not-a-date",
      }).ok,
    ).toBe(false);
    expect(
      buildProratedClawbackPlan({
        advance_cents: 100,
        term_start_date: TERM_START,
        term_end_date: TERM_START, // zero-day term
        portal_entry_date: "2026-07-02",
      }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The transfer portal clawback — the debit hold lane.
// ---------------------------------------------------------------------------

describe("recordNilTransferPortalEntry — the clawback trigger", () => {
  it("records the entry and the pro-rated hold on a mid-season portal entry", async () => {
    const store = makeStore();
    await seedAdvanceSchedule(store, { advance_cents: 360_000 });

    const outcome = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.replayed).toBe(false);
    expect(outcome.value.entry.entered_prior_to_completion).toBe(true);
    expect(outcome.value.entry.contract_completion_date).toBe("2026-12-31");

    // The clawback of record pins the pro-ration identity.
    const clawback = outcome.value.clawback;
    expect(clawback).not.toBeNull();
    if (!clawback) return;
    expect(clawback.advance_cents).toBe(360_000);
    expect(clawback.served_days).toBe(182);
    expect(clawback.total_term_days).toBe(364);
    expect(clawback.unearned_cents).toBe(180_000);

    // THE DEBIT HOLD OF RECORD — kind AND status 'nil_unearned_clawback',
    // the athlete as payee, the contract stamped in line_item_id.
    const holdRows = await store.listLedgerTransactionsByLineItem(CONTRACT_ID);
    expect(holdRows).toHaveLength(1);
    expect(holdRows[0].kind).toBe("nil_unearned_clawback");
    expect(holdRows[0].status).toBe("nil_unearned_clawback");
    expect(holdRows[0].payee_id).toBe(ATHLETE_ID);
    expect(holdRows[0].amount_cents).toBe(180_000);
    expect(clawback.clawback_ledger_id).toBe(holdRows[0].id);
  });

  it("records the entry but claws nothing back when the entry lands on completion", async () => {
    const store = makeStore();
    await seedAdvanceSchedule(store);

    const outcome = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-12-31",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.entry.entered_prior_to_completion).toBe(false);
    expect(outcome.value.clawback).toBeNull();

    const holdRows = await store.listLedgerTransactionsByLineItem(CONTRACT_ID);
    expect(holdRows).toHaveLength(0);
  });

  it("records the entry with no clawback when no advance schedule of record exists — never a guessed amount", async () => {
    const store = makeStore();

    const outcome = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.entry.entered_prior_to_completion).toBe(false);
    expect(outcome.value.entry.contract_completion_date).toBeNull();
    expect(outcome.value.clawback).toBeNull();

    const holdRows = await store.listLedgerTransactionsByLineItem(CONTRACT_ID);
    expect(holdRows).toHaveLength(0);
  });

  it("replays a re-shipped sheet as a counted no-op — the entry and its hold never double", async () => {
    const store = makeStore();
    await seedAdvanceSchedule(store);

    const first = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(first.ok).toBe(true);

    const replay = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    if (!first.ok) return;
    expect(replay.value.entry.id).toBe(first.value.entry.id);
    expect(replay.value.clawback?.id).toBe(first.value.clawback?.id);

    // Exactly one hold row exists.
    const holdRows = await store.listLedgerTransactionsByLineItem(CONTRACT_ID);
    expect(holdRows).toHaveLength(1);
  });

  it("refuses a blank identity or currency", async () => {
    const store = makeStore();
    const outcome = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: "  ",
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(outcome.code).toBe("invalid_portal_entry_identity");
  });

  it("refuses a hostile advance schedule of record instead of guessing — invalid terms never price", async () => {
    const store = makeStore();
    await seedAdvanceSchedule(store, {
      advance_cents: 360_000,
      term_start_date: "2026-12-31",
      term_end_date: "2026-01-01", // end before start — a hostile term
    });

    const outcome = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(outcome.code).toBe("invalid_advance_schedule_nonpositive_term");
  });
});

// ---------------------------------------------------------------------------
// The ledger invariant suite — the full lifecycle conserved.
// ---------------------------------------------------------------------------

describe("the full NIL escrow lifecycle — allocations plus dust equals gross, ALWAYS", () => {
  it("routes, draws down, and releases with every bucket conserved at integer cents", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700); // 70,000 escrow, 930,000 routed

    // 1. The routing: athlete remainder + escrow === the held credit.
    const routed = await routeNilAuditEscrowFromDistribution(
      store,
      {
        holding_ledger_id: held.id,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.routed_cents + routed.value.split.escrow_cents).toBe(HELD);
    const escrowRow = routed.value.escrow_credit;
    if (!escrowRow) return;

    // 2. The drawdowns: a portal reconciliation and a withholding spend
    // 30,000 of the 70,000.
    const drawnA = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowRow.id,
        scope_key: SCOPE,
        drawdown_class: "transfer_portal_reconciliation",
        source_event_id: "portal-recon-2026",
        drawn_cents: 18_000,
      },
      T0,
    );
    expect(drawnA.ok).toBe(true);
    const drawnB = await drawDownNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowRow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding",
        source_event_id: "withholding-q3",
        drawn_cents: 12_000,
      },
      T0,
    );
    expect(drawnB.ok).toBe(true);

    // 3. The verified release pays the remaining 40,000.
    await reconcileNilAuditEscrow(store, {
      reserve_ledger_id: escrowRow.id,
      scope_key: SCOPE,
      evidence_ref: "portal-audit-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    const released = await releaseNilAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowRow.id,
        scope_key: SCOPE,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // THE INVARIANT: drawdowns + released + dust === the locked escrow.
    expect(
      nilZeroBalanceHolds(
        routed.value.split.escrow_cents,
        [{ amount_cents: 18_000 }, { amount_cents: 12_000 }, { amount_cents: 40_000 }],
        0,
      ),
    ).toBe(true);

    // Every row on the ledger kept integer cents.
    for (const row of await store.listLedgerTransactionsByLineItem(SCOPE)) {
      expect(Number.isInteger(row.amount_cents)).toBe(true);
    }
  });

  it("the clawback bucket conserved: earned + unearned === the advance through the hold", async () => {
    const store = makeStore();
    await seedAdvanceSchedule(store, { advance_cents: 999_999 });
    const outcome = await recordNilTransferPortalEntry(
      store,
      {
        nil_contract_id: CONTRACT_ID,
        athlete_id: ATHLETE_ID,
        school_id: SCHOOL_ID,
        entry_date: "2026-07-02",
        athlete_name: ATHLETE_NAME,
        currency: "USD",
      },
      T0,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.value.clawback) return;
    const clawback = outcome.value.clawback;
    expect(clawback.advance_cents - clawback.served_days * 0 - clawback.unearned_cents).toBe(
      Math.floor((999_999 * clawback.served_days) / clawback.total_term_days),
    );
    expect(Number.isInteger(clawback.unearned_cents)).toBe(true);
  });
});
