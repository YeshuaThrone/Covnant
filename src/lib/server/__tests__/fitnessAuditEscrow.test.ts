// The FITNESS_AUDIT_ESCROW bucket + the fitness payout gate states (PR 39) —
// the behavioral suite for the founder's fitness directive: 5–10% of
// fitness IP payouts routed automatically into the reserved bucket at
// routing, drawn down ONLY by member chargeback reserves, class return
// allowances, or quarterly sync music licensing audits, and released ONLY
// with a verified reconciliation of record — every absent/unknown gate
// state failing closed (hipaa_gdpr_privacy_cleared and
// territorial_studio_exclusivity_verified read the durable states of
// record, migration 0043). The Don invariants hold throughout: integer
// cents, allocations plus dust equals gross including the escrow bucket,
// idempotency (a replayed event moves nothing twice), and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  FITNESS_AUDIT_ESCROW_MAX_RATE_BPS,
  FITNESS_AUDIT_ESCROW_MIN_RATE_BPS,
  fitnessAuditEscrowPayeeId,
  fitnessAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildFitnessAuditEscrowSplitPlan,
  drawDownFitnessAuditEscrow,
  fitnessZeroBalanceHolds,
  fitnessAuditEscrowScopeKey,
  reconcileFitnessAuditEscrow,
  registerFitnessAuditEscrowPolicy,
  releaseFitnessAuditEscrow,
  routeFitnessAuditEscrowFromPayout,
} from "@/lib/server/fitnessAuditEscrow";
import { resolveFitnessVerticalComplianceState } from "@/modules/compliance/payoutGate";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const TRAINER_ID = "trainer-kai";
const TRAINER_NAME = "Kai Trainer";
const FRANCHISE = "BOUTIQUE-BOS";
const SCOPE = fitnessAuditEscrowScopeKey(TRAINER_ID, FRANCHISE);
const HELD = 1_000_000; // the held fitness IP payout: $10,000

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

async function seedFitnessGateState(
  store: Store,
  states: {
    hipaa_gdpr_privacy_state: "unknown" | "cleared";
    territorial_exclusivity_state: "unknown" | "verified";
  },
  payeeId = TRAINER_ID,
  franchiseCode = FRANCHISE,
): Promise<void> {
  await store.upsertFitnessPayoutGateState({
    payee_id: payeeId,
    studio_franchise_code: franchiseCode,
    hipaa_gdpr_privacy_state: states.hipaa_gdpr_privacy_state,
    territorial_exclusivity_state: states.territorial_exclusivity_state,
    evidence_ref: "hipaa-gdpr-exclusivity-audit.pdf",
    verified_by: "compliance-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 700): Promise<void> {
  const registered = await registerFitnessAuditEscrowPolicy(store, {
    trainer_id: TRAINER_ID,
    studio_franchise_code: FRANCHISE,
    reserve_rate_bps: rateBps,
  });
  expect(registered.ok).toBe(true);
}

async function seedHeldPayout(
  store: Store,
  amountCents: number,
  createdAt: Date = T0,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "fitness-payout-line-1",
    payee_id: TRAINER_ID,
    payee_name: TRAINER_NAME,
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

/** The shared happy path: policy, cleared gate, verified KYC, held payout. */
async function seedRoutingFixture(store: Store, rateBps = 700): Promise<LedgerTransactionRecord> {
  await seedPolicy(store, rateBps);
  await seedFitnessGateState(store, {
    hipaa_gdpr_privacy_state: "cleared",
    territorial_exclusivity_state: "verified",
  });
  await seedVerifiedKyc(store, TRAINER_ID);
  return seedHeldPayout(store, HELD);
}

async function seedEscrow(
  store: Store,
  amountCents = 70_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: fitnessAuditEscrowPayeeId(SCOPE),
    payee_name: fitnessAuditEscrowPayeeName(SCOPE),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "fitness_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "fitness_audit_escrow",
  });
}

function expectFailure(
  result: { ok: false; code: string } | { ok: true },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    expect.unreachable("expected a failure result");
  }
  expect(result.code).toBe(code);
}

// ---------------------------------------------------------------------------
// The rate band — registration.
// ---------------------------------------------------------------------------

describe("registerFitnessAuditEscrowPolicy — the founder band", () => {
  it("registers a rate inside the 500–1000 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: 700,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: 900,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(900);

    const readBack = await store.getFitnessAuditEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(900);
  });

  it("accepts both band edges (500 and 1000 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: FITNESS_AUDIT_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);

    const overMax = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: FITNESS_AUDIT_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(overMax, "escrow_rate_out_of_band");

    const underMin = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: FITNESS_AUDIT_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(underMin, "escrow_rate_out_of_band");

    const nonInteger = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: 700.5,
    });
    expectFailure(nonInteger, "escrow_rate_out_of_band");

    const blankIdentity = await registerFitnessAuditEscrowPolicy(store, {
      trainer_id: "  ",
      studio_franchise_code: FRANCHISE,
      reserve_rate_bps: 700,
    });
    expectFailure(blankIdentity, "invalid_scope_identity");
  });
});

// ---------------------------------------------------------------------------
// The pure split arithmetic.
// ---------------------------------------------------------------------------

describe("buildFitnessAuditEscrowSplitPlan — the escrow bucket arithmetic", () => {
  it("locks the founder-banded share exactly: remainder + escrow === amount, dust zero", () => {
    const plan = buildFitnessAuditEscrowSplitPlan({ amount_cents: HELD, reserve_rate_bps: 700 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.escrow_cents).toBe(70_000);
    expect(plan.value.routed_cents).toBe(930_000);
    expect(plan.value.company_dust_cents).toBe(0);
    expect(plan.value.routed_cents + plan.value.escrow_cents).toBe(HELD);
  });

  it("floors the rate multiplication — the trainer's share is the exact subtraction remainder", () => {
    // 333 cents at 500 bps: floor(333 × 500 / 10,000) = 16 escrow, 317 ride.
    const plan = buildFitnessAuditEscrowSplitPlan({ amount_cents: 333, reserve_rate_bps: 500 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.escrow_cents).toBe(16);
    expect(plan.value.routed_cents).toBe(317);
    expect(plan.value.company_dust_cents).toBe(0);
    expect(fitnessZeroBalanceHolds(333, [{ amount_cents: 317 }, { amount_cents: 16 }], 0)).toBe(true);
  });

  it("refuses a non-positive or non-integer amount and an out-of-band rate", () => {
    expect(buildFitnessAuditEscrowSplitPlan({ amount_cents: 0, reserve_rate_bps: 700 }).ok).toBe(false);
    expect(buildFitnessAuditEscrowSplitPlan({ amount_cents: -5, reserve_rate_bps: 700 }).ok).toBe(false);
    expect(buildFitnessAuditEscrowSplitPlan({ amount_cents: 100.5, reserve_rate_bps: 700 }).ok).toBe(false);
    expect(buildFitnessAuditEscrowSplitPlan({ amount_cents: HELD, reserve_rate_bps: 499 }).ok).toBe(false);
    expect(buildFitnessAuditEscrowSplitPlan({ amount_cents: HELD, reserve_rate_bps: 1001 }).ok).toBe(false);
  });
});

describe("fitnessZeroBalanceHolds — the house invariant", () => {
  it("holds on exact conservation and refuses drift, negatives, and non-integers", () => {
    expect(fitnessZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 300 }], 0)).toBe(true);
    expect(fitnessZeroBalanceHolds(1000, [{ amount_cents: 700 }], 300)).toBe(true);
    expect(fitnessZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 300 }], 1)).toBe(false);
    expect(fitnessZeroBalanceHolds(1000, [{ amount_cents: 700.5 }, { amount_cents: 299.5 }], 0)).toBe(false);
    expect(fitnessZeroBalanceHolds(1000, [{ amount_cents: -1 }, { amount_cents: 1001 }], 0)).toBe(false);
    expect(fitnessZeroBalanceHolds(1000.5, [{ amount_cents: 1000 }], 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The automatic routing.
// ---------------------------------------------------------------------------

describe("routeFitnessAuditEscrowFromPayout — the automatic routing", () => {
  it("splits the held payout at the policy rate: the escrow locks at the sentinel payee, the trainer rides the taxed cascade", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
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
    // status 'fitness_audit_escrow', the scope stamped in line_item_id.
    const escrowCredit = routed.value.escrow_credit;
    expect(escrowCredit).not.toBeNull();
    if (!escrowCredit) return;
    expect(escrowCredit.payee_id).toBe(fitnessAuditEscrowPayeeId(SCOPE));
    expect(escrowCredit.payee_name).toBe(fitnessAuditEscrowPayeeName(SCOPE));
    expect(escrowCredit.kind).toBe("fitness_audit_escrow");
    expect(escrowCredit.status).toBe("fitness_audit_escrow");
    expect(escrowCredit.amount_cents).toBe(70_000);
    expect(escrowCredit.line_item_id).toBe(SCOPE);

    // The held payout settled exactly once.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("settled");

    // The trainer's credit rode the taxed cascade.
    expect(routed.value.credits).toHaveLength(1);
    expect(routed.value.credits[0].payee_id).toBe(TRAINER_ID);
    expect(routed.value.credits[0].step).toBe("trainer_net");
    expect(routed.value.credits[0].gross_cents).toBe(HELD - 70_000);
    expect(Number.isInteger(routed.value.credits[0].net_cents)).toBe(true);

    // One balanced GL journal rode the routing.
    expect(routed.value.journal_id).not.toBeNull();
  });

  it("locks no escrow row when the founder-banded share floors to zero on a sub-10-cent payout", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 500);
    const tiny = await seedHeldPayout(store, 19); // floor(19 × 500 / 10,000) = 0

    const routed = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: tiny.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(0);
    expect(routed.value.escrow_credit).toBeNull();
    expect(routed.value.split.routed_cents).toBe(19);
  });

  it("refuses a replayed routing fail-closed — the CAS returns payout_already_released, never a second split", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);
    const input = {
      holding_ledger_id: held.id,
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      operator_settlement_approved: true,
    };
    const first = await routeFitnessAuditEscrowFromPayout(store, input, T0);
    expect(first.ok).toBe(true);

    const replay = await routeFitnessAuditEscrowFromPayout(store, input, T0);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("payout_already_released");
  });

  it("refuses an unknown ledger row, a non-holding row, and an unapproved settlement", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 700);

    const missing = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: "ledger-none",
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(missing, "payout_credit_not_found");

    const wrongKind = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "payout-line-1",
      payee_id: TRAINER_ID,
      payee_name: TRAINER_NAME,
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
    const notHolding = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: wrongKind.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(notHolding, "not_a_holding_credit");

    const held = await seedHeldPayout(store, 500);
    const unapproved = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: false,
      },
      T0,
    );
    expectFailure(unapproved, "settlement_not_approved");
  });

  it("refuses a scope with no registered policy — terms of record come from the registry, never the caller", async () => {
    const store = makeStore();
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, TRAINER_ID);
    const held = await seedHeldPayout(store, HELD);

    const noPolicy = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(noPolicy, "missing_fitness_audit_escrow_policy");

    // Nothing moved — the held payout is still held.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("unclaimed_holding");
  });
});

// ---------------------------------------------------------------------------
// The fitness payout gate — fail-closed on absent and unknown, at routing
// and at release.
// ---------------------------------------------------------------------------

describe("the fitness payout gate — hipaa_gdpr_privacy_cleared + territorial_studio_exclusivity_verified, fail-closed", () => {
  it("resolves the durable states of record: absent record → null, unknown → false, cleared/verified → true", async () => {
    const store = makeStore();

    // ABSENT record resolves null — the gate refuses with
    // vertical_state_unknown (fail-closed).
    expect(
      await resolveFitnessVerticalComplianceState(store, TRAINER_ID, FRANCHISE),
    ).toBeNull();

    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "unknown",
      territorial_exclusivity_state: "unknown",
    });
    const unknown = await resolveFitnessVerticalComplianceState(store, TRAINER_ID, FRANCHISE);
    expect(unknown).not.toBeNull();
    if (unknown === null) return;
    expect(unknown.vertical).toBe("fitness");
    expect(unknown.hipaa_gdpr_privacy_cleared).toBe(false);
    expect(unknown.territorial_studio_exclusivity_verified).toBe(false);

    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    const cleared = await resolveFitnessVerticalComplianceState(store, TRAINER_ID, FRANCHISE);
    if (cleared === null) return;
    expect(cleared.hipaa_gdpr_privacy_cleared).toBe(true);
    expect(cleared.territorial_studio_exclusivity_verified).toBe(true);

    // One cleared condition never carries the other.
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "unknown",
    });
    const half = await resolveFitnessVerticalComplianceState(store, TRAINER_ID, FRANCHISE);
    if (half === null) return;
    expect(half.hipaa_gdpr_privacy_cleared).toBe(true);
    expect(half.territorial_studio_exclusivity_verified).toBe(false);
  });

  it("routing fails closed on an absent gate record, each individually-unknown state, and unverified KYC", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);

    const absentHeld = await seedHeldPayout(store, HELD);
    const absentInput = {
      holding_ledger_id: absentHeld.id,
      trainer_id: TRAINER_ID,
      studio_franchise_code: FRANCHISE,
      operator_settlement_approved: true,
    };
    // The compliance evaluator checks KYC before the vertical — with
    // NEITHER of record, the KYC state refuses first (fail-closed).
    const absent = await routeFitnessAuditEscrowFromPayout(store, absentInput, T0);
    expectFailure(absent, "kyc_state_unknown");

    // KYC of record but an ABSENT gate-state record (the resolver reads
    // null) — the vertical itself refuses with vertical_state_unknown.
    await seedVerifiedKyc(store, TRAINER_ID);
    const absentVertical = await routeFitnessAuditEscrowFromPayout(store, absentInput, T0);
    expectFailure(absentVertical, "vertical_state_unknown");

    // Unknown HIPAA/GDPR privacy state — the specific condition refuses.
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "unknown",
      territorial_exclusivity_state: "verified",
    });
    const privacyHeld = await seedHeldPayout(store, HELD);
    const privacy = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: privacyHeld.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(privacy, "fitness_privacy_not_cleared");

    // Unknown territorial exclusivity — the specific condition refuses.
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "unknown",
    });
    const exclusivityHeld = await seedHeldPayout(store, HELD);
    const exclusivity = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: exclusivityHeld.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(exclusivity, "fitness_exclusivity_unverified");

    // A cleared vertical cannot carry an absent KYC record — the KYC
    // state is unknown, and the gate refuses before the vertical even
    // resolves. (A fresh store: this test verified the trainer's KYC in
    // its earlier step, and the record of verification persists.)
    const kycStore = makeStore();
    await seedPolicy(kycStore, 700);
    await seedFitnessGateState(kycStore, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    const kycHeld = await seedHeldPayout(kycStore, HELD);
    const kycUnknown = await routeFitnessAuditEscrowFromPayout(
      kycStore,
      {
        holding_ledger_id: kycHeld.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(kycUnknown, "kyc_state_unknown");
  });

  it("routes through only when every gate condition is explicitly true", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);
    const routed = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The spend lane — chargeback reserves, class return allowances, quarterly
// sync music licensing audits.
// ---------------------------------------------------------------------------

describe("drawDownFitnessAuditEscrow — the spend lane", () => {
  it("draws a member chargeback reserve down position-locked", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const drawn = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "chargeback-mb-2026-10",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.replayed).toBe(false);
    expect(drawn.value.drawdown.drawn_before_cents).toBe(70_000);
    expect(drawn.value.drawdown.drawn_cents).toBe(25_000);
    expect(drawn.value.drawdown.remaining_cents).toBe(45_000);
    expect(drawn.value.drawdown.drawdown_class).toBe("chargeback_reserve");
    expect(drawn.value.journal_id).not.toBeNull();

    // The escrow is still held — the drawdown did not consume the last
    // cent.
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("fitness_audit_escrow");
  });

  it("draws a class return allowance, then a quarterly sync music licensing audit — balances strictly decrease", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const first = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "chargeback-mb-2026-10",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(first.ok).toBe(true);

    const second = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "class_return_allowance",
        source_event_id: "returns-october-cohort",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.drawdown.drawn_before_cents).toBe(45_000);
    expect(second.value.drawdown.drawdown_class).toBe("class_return_allowance");
    expect(second.value.drawdown.remaining_cents).toBe(35_000);

    const third = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "sync_music_licensing_audit",
        source_event_id: "sync-audit-q3-2026",
        drawn_cents: 15_000,
      },
      T0,
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.drawdown.drawn_before_cents).toBe(35_000);
    expect(third.value.drawdown.drawdown_class).toBe("sync_music_licensing_audit");
    expect(third.value.drawdown.remaining_cents).toBe(20_000);
  });

  it("refuses an overdraw — refuse, never clip", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 10_000);

    const overdrawn = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "sync_music_licensing_audit",
        source_event_id: "sync-audit-q3-2026",
        drawn_cents: 10_001,
      },
      T0,
    );
    expectFailure(overdrawn, "escrow_overdrawn");
  });

  it("refuses a foreign drawdown class and a non-integer or non-positive amount", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const badClass = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "tax_withholding", // the NIL vocabulary — not this lane's
        source_event_id: "evt-1",
        drawn_cents: 100,
      },
      T0,
    );
    expectFailure(badClass, "invalid_drawdown_class");

    for (const drawnCents of [0, -100, 100.5]) {
      const badAmount = await drawDownFitnessAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "chargeback_reserve",
          source_event_id: "evt-2",
          drawn_cents: drawnCents,
        },
        T0,
      );
      expectFailure(badAmount, "invalid_drawdown_amount");
    }
  });

  it("replays a re-shipped source event as a counted no-op — never a second drawdown or journal", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const first = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "chargeback-mb-2026-10",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(first.ok).toBe(true);

    const replay = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "chargeback-mb-2026-10",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.journal_id).toBeNull();
    expect(replay.value.drawdown.drawn_cents).toBe(25_000);

    // The ledger of record moved exactly once.
    const all = await store.listFitnessAuditEscrowDrawdowns(escrow.id);
    expect(all).toHaveLength(1);
  });

  it("refuses a scope mismatch, an unknown bucket, and a draw from a settled escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const mismatch = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: fitnessAuditEscrowScopeKey("trainer-other", FRANCHISE),
        drawdown_class: "chargeback_reserve",
        source_event_id: "evt-3",
        drawn_cents: 100,
      },
      T0,
    );
    expectFailure(mismatch, "escrow_scope_mismatch");

    const unknown = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: "ledger-none",
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "evt-4",
        drawn_cents: 100,
      },
      T0,
    );
    expectFailure(unknown, "escrow_credit_not_found");

    // Fully drawing the escrow settles it — nothing draws from a settled
    // escrow afterwards.
    const fullyDrawn = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "class_return_allowance",
        source_event_id: "returns-everything",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(fullyDrawn.ok).toBe(true);
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("settled");

    const afterSettle = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "evt-5",
        drawn_cents: 1,
      },
      T0,
    );
    expectFailure(afterSettle, "escrow_already_settled");
  });
});

// ---------------------------------------------------------------------------
// The verified release.
// ---------------------------------------------------------------------------

describe("reconcileFitnessAuditEscrow + releaseFitnessAuditEscrow — the verified release", () => {
  it("records the reconciliation of record insert-as-lock — the first wins, a second throws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const reconciled = await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "sync-audit-q3-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(reconciled.ok).toBe(true);

    let secondThrew: unknown;
    try {
      await reconcileFitnessAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "sync-audit-q3-2026-late.pdf",
        reconciled_by: "compliance-desk",
      });
    } catch (error) {
      secondThrew = error;
    }
    expect(secondThrew).toBeInstanceOf(Error);

    const readBack = await store.getFitnessAuditEscrowReconciliation(escrow.id);
    expect(readBack?.evidence_ref).toBe("sync-audit-q3-2026.pdf");
  });

  it("refuses a reconciliation with blank evidence or reconciler, and a scope mismatch", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const blankEvidence = await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "  ",
      reconciled_by: "compliance-desk",
    });
    expectFailure(blankEvidence, "invalid_reconciliation_evidence");

    const mismatch = await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: fitnessAuditEscrowScopeKey("trainer-other", FRANCHISE),
      evidence_ref: "sync-audit-q3-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expectFailure(mismatch, "not_an_escrow_credit");
  });

  it("refuses a release with no reconciliation of record — fail-closed, before the CAS", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 70_000);
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, TRAINER_ID);

    const released = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(released.status).toBe(403);
    expect(released.code).toBe("fitness_audit_escrow_reconciliation_missing");

    // Nothing moved — the escrow is still held.
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("fitness_audit_escrow");
  });

  it("releases the remaining balance to the trainer only against the verified reconciliation — the gate re-resolves fail-closed at release too", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 70_000);
    await seedPolicy(store);

    // A drawdown spent part of the escrow first.
    const drawn = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "chargeback-mb-2026-10",
        drawn_cents: 20_000,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);

    await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "sync-audit-q3-2026.pdf",
      reconciled_by: "compliance-desk",
    });

    // The gate states of record are ABSENT at release — the release
    // refuses (fail-closed), reconciliation alone does not carry it.
    await seedVerifiedKyc(store, TRAINER_ID);
    const absentGate = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(absentGate.ok).toBe(false);
    if (absentGate.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(absentGate.code).toBe("vertical_state_unknown");

    // A merely-UNKNOWN privacy state refuses with the specific condition.
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "unknown",
      territorial_exclusivity_state: "verified",
    });
    const unknownPrivacy = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(unknownPrivacy, "fitness_privacy_not_cleared");

    // The cleared release pays the remaining 50,000 to the trainer.
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    const released = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(50_000);
    expect(released.value.credits[0].payee_id).toBe(TRAINER_ID);
    expect(released.value.credits[0].gross_cents).toBe(50_000);
    expect(released.value.journal_id).not.toBeNull();

    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("settled");

    // A replayed release refuses — the CAS holds.
    const replay = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(replay, "escrow_already_settled");
  });

  it("refuses a release whose (trainer, franchise) pair does not re-derive the named scope, and a fully-drawn escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 70_000);
    await seedPolicy(store);

    await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "sync-audit-q3-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    await seedFitnessGateState(store, {
      hipaa_gdpr_privacy_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, TRAINER_ID);

    const pairMismatch = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: "trainer-other",
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(pairMismatch, "escrow_scope_mismatch");

    // Fully drawn — the release refuses with escrow_fully_drawn (the
    // drawdowns spent every cent of the exposure).
    const fullyDrawn = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "sync_music_licensing_audit",
        source_event_id: "sync-audit-q3-2026",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(fullyDrawn.ok).toBe(true);

    const released = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    // The final drawdown settled the escrow row itself (a zero-balance
    // escrow IS a settled escrow) — the release's truthful refusal is
    // escrow_already_settled.
    expectFailure(released, "escrow_already_settled");

    // The escrow_fully_drawn guard still stands: a HELD row drained by a
    // store-level drawdown record (bypassing the engine's
    // settle-on-last-cent) refuses with the specific condition.
    const guardEscrow = await seedEscrow(store, 30_000);
    await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: guardEscrow.id,
      scope_key: SCOPE,
      evidence_ref: "guard-drain-recon.pdf",
      reconciled_by: "compliance-desk",
    });
    await store.insertFitnessAuditEscrowDrawdown({
      reserve_ledger_id: guardEscrow.id,
      scope_key: SCOPE,
      drawdown_class: "chargeback_reserve",
      source_event_id: "guard-drain-all",
      drawn_before_cents: 30_000,
      drawn_cents: 30_000,
      remaining_cents: 0,
    });
    const guardReleased = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: guardEscrow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expectFailure(guardReleased, "escrow_fully_drawn");
  });
});

// ---------------------------------------------------------------------------
// The full lifecycle — allocations plus dust equals gross, ALWAYS.
// ---------------------------------------------------------------------------

describe("the full fitness escrow lifecycle — allocations plus dust equals gross, ALWAYS", () => {
  it("routes, draws down, and releases with every bucket conserved at integer cents", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700); // 70,000 escrow, 930,000 routed

    // 1. The routing: trainer remainder + escrow === the held payout.
    const routed = await routeFitnessAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.routed_cents + routed.value.split.escrow_cents).toBe(HELD);
    const escrowRow = routed.value.escrow_credit;
    if (!escrowRow) return;

    // 2. The drawdowns: a chargeback reserve and a quarterly sync audit
    // spend 30,000 of the 70,000.
    const drawnA = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowRow.id,
        scope_key: SCOPE,
        drawdown_class: "chargeback_reserve",
        source_event_id: "chargeback-mb-2026-10",
        drawn_cents: 18_000,
      },
      T0,
    );
    expect(drawnA.ok).toBe(true);
    const drawnB = await drawDownFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowRow.id,
        scope_key: SCOPE,
        drawdown_class: "sync_music_licensing_audit",
        source_event_id: "sync-audit-q3-2026",
        drawn_cents: 12_000,
      },
      T0,
    );
    expect(drawnB.ok).toBe(true);

    // 3. The verified release pays the remaining 40,000.
    await reconcileFitnessAuditEscrow(store, {
      reserve_ledger_id: escrowRow.id,
      scope_key: SCOPE,
      evidence_ref: "sync-audit-q3-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    const released = await releaseFitnessAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowRow.id,
        scope_key: SCOPE,
        trainer_id: TRAINER_ID,
        studio_franchise_code: FRANCHISE,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // THE INVARIANTS: trainer remainder + escrow === the held payout, AND
    // drawdowns + released + dust === the locked escrow.
    expect(
      fitnessZeroBalanceHolds(
        routed.value.split.amount_cents,
        [{ amount_cents: routed.value.split.routed_cents }, { amount_cents: routed.value.split.escrow_cents }],
        0,
      ),
    ).toBe(true);
    expect(
      fitnessZeroBalanceHolds(
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
});
