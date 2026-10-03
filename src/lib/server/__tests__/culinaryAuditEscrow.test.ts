// The CULINARY_AUDIT_ESCROW bucket + the culinary payout gate states (PR 41) —
// the behavioral suite for the founder's culinary directive: 5–10% of
// culinary IP payouts routed automatically into the reserved bucket at
// routing, drawn down ONLY by customer refund allowances, food spoilage
// chargebacks, or quarterly ingredient supplier quality audits, and
// released ONLY with a verified reconciliation of record — every
// absent/unknown gate state failing closed (health_inspection_cleared and
// territorial_kitchen_exclusivity_verified read the durable states of
// record, migration 0045). A viral-menu pop-up scope's release is
// additionally gated on its post-campaign packaging write-off of record —
// the virtual-brand decommissioning audit. The Don invariants hold
// throughout: integer cents, allocations plus dust equals gross including
// the escrow bucket, idempotency (a replayed event moves nothing twice),
// and the CAS as the concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  CULINARY_AUDIT_ESCROW_MAX_RATE_BPS,
  CULINARY_AUDIT_ESCROW_MIN_RATE_BPS,
  culinaryAuditEscrowPayeeId,
  culinaryAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildCulinaryAuditEscrowSplitPlan,
  culinaryZeroBalanceHolds,
  culinaryAuditEscrowScopeKey,
  culinaryPopupScopeKey,
  drawDownCulinaryAuditEscrow,
  isCulinaryPopupScope,
  recordCulinaryPopupWriteoff,
  reconcileCulinaryAuditEscrow,
  registerCulinaryAuditEscrowPolicy,
  registerCulinaryPopupExperience,
  releaseCulinaryAuditEscrow,
  routeCulinaryAuditEscrowFromPayout,
} from "@/lib/server/culinaryAuditEscrow";
import { resolveCulinaryVerticalComplianceState } from "@/modules/compliance/payoutGate";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const CHEF_ID = "chef-marisol";
const CHEF_NAME = "Marisol Chef";
const KITCHEN = "GHOST-AUSTIN";
const SCOPE = culinaryAuditEscrowScopeKey(CHEF_ID, KITCHEN);
const HELD = 1_000_000; // the held culinary IP payout: $10,000

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

async function seedCulinaryGateState(
  store: Store,
  states: {
    health_inspection_state: "unknown" | "cleared";
    territorial_exclusivity_state: "unknown" | "verified";
  },
  payeeId = CHEF_ID,
  kitchenCode = KITCHEN,
): Promise<void> {
  await store.upsertCulinaryPayoutGateState({
    payee_id: payeeId,
    ghost_kitchen_location_code: kitchenCode,
    health_inspection_state: states.health_inspection_state,
    territorial_exclusivity_state: states.territorial_exclusivity_state,
    evidence_ref: "health-exclusivity-audit.pdf",
    verified_by: "compliance-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 700): Promise<void> {
  const registered = await registerCulinaryAuditEscrowPolicy(store, {
    chef_id: CHEF_ID,
    ghost_kitchen_location_code: KITCHEN,
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
    line_item_id: "culinary-payout-line-1",
    payee_id: CHEF_ID,
    payee_name: CHEF_NAME,
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
  await seedCulinaryGateState(store, {
    health_inspection_state: "cleared",
    territorial_exclusivity_state: "verified",
  });
  await seedVerifiedKyc(store, CHEF_ID);
  return seedHeldPayout(store, HELD);
}

async function seedEscrow(
  store: Store,
  amountCents = 70_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: culinaryAuditEscrowPayeeId(SCOPE),
    payee_name: culinaryAuditEscrowPayeeName(SCOPE),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "culinary_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "culinary_audit_escrow",
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

describe("registerCulinaryAuditEscrowPolicy — the founder band", () => {
  it("registers a rate inside the 500–1000 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: 700,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: 900,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(900);

    const readBack = await store.getCulinaryAuditEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(900);
  });

  it("accepts both band edges (500 and 1000 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: CULINARY_AUDIT_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);
    const maxEdge = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: CULINARY_AUDIT_ESCROW_MAX_RATE_BPS,
    });
    expect(maxEdge.ok).toBe(true);

    const tooLow = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: CULINARY_AUDIT_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(tooLow, "escrow_rate_out_of_band");
    const tooHigh = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: CULINARY_AUDIT_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(tooHigh, "escrow_rate_out_of_band");
  });
});

describe("buildCulinaryAuditEscrowSplitPlan — the escrow bucket arithmetic", () => {
  it("locks the founder-banded share exactly: remainder + escrow === amount, dust zero", () => {
    const planned = buildCulinaryAuditEscrowSplitPlan({
      amount_cents: HELD,
      reserve_rate_bps: 700,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(70_000);
    expect(planned.value.routed_cents).toBe(HELD - 70_000);
    expect(planned.value.company_dust_cents).toBe(0);
    expect(
      culinaryZeroBalanceHolds(HELD, [
        { amount_cents: planned.value.routed_cents },
        { amount_cents: planned.value.escrow_cents },
      ], planned.value.company_dust_cents),
    ).toBe(true);
  });

  it("floors the rate multiplication — the chef's share is the exact subtraction remainder", () => {
    const planned = buildCulinaryAuditEscrowSplitPlan({
      amount_cents: 999,
      reserve_rate_bps: 700,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // floor(999 × 700 / 10,000) = 69 — the chef keeps the 930 remainder.
    expect(planned.value.escrow_cents).toBe(69);
    expect(planned.value.routed_cents).toBe(930);
  });

  it("refuses a non-positive or non-integer amount and an out-of-band rate", () => {
    expectFailure(
      buildCulinaryAuditEscrowSplitPlan({ amount_cents: 0, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildCulinaryAuditEscrowSplitPlan({ amount_cents: -5, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildCulinaryAuditEscrowSplitPlan({ amount_cents: 10.5, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildCulinaryAuditEscrowSplitPlan({ amount_cents: 100, reserve_rate_bps: 499 }),
      "escrow_rate_out_of_band",
    );
    expectFailure(
      buildCulinaryAuditEscrowSplitPlan({ amount_cents: 100, reserve_rate_bps: 1001 }),
      "escrow_rate_out_of_band",
    );
  });
});

describe("culinaryZeroBalanceHolds — the house invariant", () => {
  it("holds on exact conservation and refuses drift, negatives, and non-integers", () => {
    expect(culinaryZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 300 }], 0)).toBe(true);
    expect(culinaryZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 299 }], 1)).toBe(true);
    expect(culinaryZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 299 }], 0)).toBe(false);
    expect(culinaryZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 301 }], 0)).toBe(false);
    expect(culinaryZeroBalanceHolds(1000, [{ amount_cents: -1 }, { amount_cents: 1001 }], 0)).toBe(false);
    expect(culinaryZeroBalanceHolds(10.5, [{ amount_cents: 10 }, { amount_cents: 0 }], 0)).toBe(false);
  });
});

describe("routeCulinaryAuditEscrowFromPayout — the automatic routing", () => {
  it("splits the held payout at the policy rate: the escrow locks at the sentinel payee, the chef rides the taxed cascade", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeCulinaryAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
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
    // status 'culinary_audit_escrow', the scope stamped in line_item_id.
    const escrowCredit = routed.value.escrow_credit;
    expect(escrowCredit).not.toBeNull();
    if (!escrowCredit) return;
    expect(escrowCredit.payee_id).toBe(culinaryAuditEscrowPayeeId(SCOPE));
    expect(escrowCredit.payee_name).toBe(culinaryAuditEscrowPayeeName(SCOPE));
    expect(escrowCredit.kind).toBe("culinary_audit_escrow");
    expect(escrowCredit.status).toBe("culinary_audit_escrow");
    expect(escrowCredit.amount_cents).toBe(70_000);
    expect(escrowCredit.line_item_id).toBe(SCOPE);

    // The held payout settled exactly once.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("settled");

    // The chef's credit rode the taxed cascade.
    expect(routed.value.credits).toHaveLength(1);
    expect(routed.value.credits[0]?.payee_id).toBe(CHEF_ID);
    expect(routed.value.credits[0]?.step).toBe("chef_net");
    expect(routed.value.credits[0]?.gross_cents).toBe(HELD - 70_000);
    expect(Number.isInteger(routed.value.credits[0]?.net_cents)).toBe(true);

    // One balanced GL journal rode the routing.
    expect(routed.value.journal_id).not.toBeNull();
  });

  it("locks no escrow row when the founder-banded share floors to zero on a sub-10-cent payout", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 500);
    const tiny = await seedHeldPayout(store, 19); // floor(19 × 500 / 10,000) = 0

    const routed = await routeCulinaryAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: tiny.id,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
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
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      operator_settlement_approved: true,
    };
    const first = await routeCulinaryAuditEscrowFromPayout(store, input, T0);
    expect(first.ok).toBe(true);

    const replayed = await routeCulinaryAuditEscrowFromPayout(store, input, T0);
    expectFailure(replayed, "payout_already_released");

  });

  it("refuses an unknown ledger row, a non-holding row, and an unapproved settlement", async () => {
    const store = makeStore();
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: "missing",
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "payout_credit_not_found",
    );

    await seedPolicy(store, 700);
    const settledRow = await seedHeldPayout(store, HELD);
    await store.settleUnclaimedHolding(settledRow.id, T0.toISOString());
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: settledRow.id,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "payout_already_released",
    );

    const held = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: held.id,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: false,
        },
        T0,
      ),
      "settlement_not_approved",
    );
  });

  it("refuses a scope with no registered policy — terms of record come from the registry, never the caller", async () => {
    const store = makeStore();
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, CHEF_ID);
    const held = await seedHeldPayout(store, HELD);

    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: held.id,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "missing_culinary_audit_escrow_policy",
    );
    // Nothing moved.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("unclaimed_holding");
  });
});

describe("the culinary payout gate — health_inspection_cleared + territorial_kitchen_exclusivity_verified, fail-closed", () => {
  it("resolves the durable states of record: absent record → null, unknown → false, cleared/verified → true", async () => {
    const store = makeStore();
    expect(await resolveCulinaryVerticalComplianceState(store, CHEF_ID, KITCHEN)).toBeNull();

    await seedCulinaryGateState(store, {
      health_inspection_state: "unknown",
      territorial_exclusivity_state: "unknown",
    });
    const unknown = await resolveCulinaryVerticalComplianceState(store, CHEF_ID, KITCHEN);
    expect(unknown).not.toBeNull();
    expect(unknown?.health_inspection_cleared).toBe(false);
    expect(unknown?.territorial_kitchen_exclusivity_verified).toBe(false);

    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    const cleared = await resolveCulinaryVerticalComplianceState(store, CHEF_ID, KITCHEN);
    expect(cleared?.health_inspection_cleared).toBe(true);
    expect(cleared?.territorial_kitchen_exclusivity_verified).toBe(true);

    // Half-cleared resolves half-true — each state stands alone.
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "unknown",
    });
    const half = await resolveCulinaryVerticalComplianceState(store, CHEF_ID, KITCHEN);
    expect(half?.health_inspection_cleared).toBe(true);
    expect(half?.territorial_kitchen_exclusivity_verified).toBe(false);
  });

  it("routing fails closed on an absent gate record, each individually-unknown state, and unverified KYC", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedVerifiedKyc(store, CHEF_ID);

    // Absent gate record entirely — the gate reads null and refuses.
    const absent = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: absent.id,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "vertical_state_unknown",
    );

    // An 'unknown' health inspection state — the specific condition refuses.
    await seedCulinaryGateState(store, {
      health_inspection_state: "unknown",
      territorial_exclusivity_state: "verified",
    });
    const unknownInspection = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unknownInspection.id,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "culinary_inspection_not_cleared",
    );

    // An unverified territorial exclusivity state — the other half refuses.
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "unknown",
    });
    const unknownExclusivity = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unknownExclusivity.id,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "culinary_exclusivity_unverified",
    );

    // A chef with no KYC record at all — the identity gate refuses on
    // the unknown state (a different chef, their own scope's terms).
    const NO_KYC = "chef-nokyc";
    const NO_KYC_SCOPE = culinaryAuditEscrowScopeKey(NO_KYC, KITCHEN);
    const noKycPolicy = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: NO_KYC,
      ghost_kitchen_location_code: KITCHEN,
      reserve_rate_bps: 700,
    });
    expect(noKycPolicy.ok).toBe(true);
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    }, NO_KYC);
    const unverifiedKyc = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: NO_KYC_SCOPE,
      payee_id: NO_KYC,
      payee_name: `Chef ${NO_KYC}`,
      role: "creator",
      share_bps: 0,
      amount_cents: HELD,
      currency: "USD",
      status: "unclaimed_holding",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "unclaimed_holding",
    });
    expectFailure(
      await routeCulinaryAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unverifiedKyc.id,
          chef_id: NO_KYC,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "kyc_state_unknown",
    );

    // Every refused payout is still exactly where it started.
    for (const id of [absent.id, unknownInspection.id, unknownExclusivity.id, unverifiedKyc.id]) {
      expect((await store.getLedgerTransaction(id))?.status).toBe("unclaimed_holding");
    }
  });

  it("routes through only when every gate condition is explicitly true", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 500);

    const routed = await routeCulinaryAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(50_000);
  });
});

describe("drawDownCulinaryAuditEscrow — the spend lane", () => {
  it("draws a customer refund allowance down position-locked", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const drawn = await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "refund_allowance",
        source_event_id: "refund-2026-10-03-001",
        drawn_cents: 25_000,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.drawdown.drawn_before_cents).toBe(70_000);
    expect(drawn.value.drawdown.drawn_cents).toBe(25_000);
    expect(drawn.value.drawdown.remaining_cents).toBe(45_000);
    expect(drawn.value.replayed).toBe(false);
    expect(drawn.value.journal_id).not.toBeNull();
    expect(drawn.value.drawdown.drawdown_class).toBe("refund_allowance");
  });

  it("draws a food spoilage chargeback, then a quarterly ingredient supplier quality audit — balances strictly decrease", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const spoilage = await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "spoilage_chargeback",
        source_event_id: "spoilage-lot-2026-40",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(spoilage.ok).toBe(true);
    if (!spoilage.ok) return;
    expect(spoilage.value.drawdown.remaining_cents).toBe(60_000);

    const supplierAudit = await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "supplier_quality_audit",
        source_event_id: "supplier-audit-q4-2026",
        drawn_cents: 5_000,
      },
      T0,
    );
    expect(supplierAudit.ok).toBe(true);
    if (!supplierAudit.ok) return;
    expect(supplierAudit.value.drawdown.drawn_before_cents).toBe(60_000);
    expect(supplierAudit.value.drawdown.remaining_cents).toBe(55_000);

    const lines = await store.listCulinaryAuditEscrowDrawdowns(escrow.id);
    expect(lines.map((line) => line.drawn_before_cents)).toEqual([70_000, 60_000]);
  });

  it("refuses an overdraw — refuse, never clip", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 50_000);

    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "refund_allowance",
          source_event_id: "refund-overdraw",
          drawn_cents: 50_001,
        },
        T0,
      ),
      "escrow_overdrawn",
    );
    expect(await store.listCulinaryAuditEscrowDrawdowns(escrow.id)).toHaveLength(0);
  });

  it("refuses a foreign drawdown class and a non-integer or non-positive amount", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "class_return_allowance", // the fitness lane's class
          source_event_id: "foreign-class",
          drawn_cents: 100,
        },
        T0,
      ),
      "invalid_drawdown_class",
    );
    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "refund_allowance",
          source_event_id: "fractional",
          drawn_cents: 10.5,
        },
        T0,
      ),
      "invalid_drawdown_amount",
    );
    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "refund_allowance",
          source_event_id: "zero",
          drawn_cents: 0,
        },
        T0,
      ),
      "invalid_drawdown_amount",
    );
  });

  it("replays a re-shipped source event as a counted no-op — never a second drawdown or journal", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    const input = {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "refund_allowance" as const,
      source_event_id: "refund-2026-10-03-001",
      drawn_cents: 25_000,
    };
    const first = await drawDownCulinaryAuditEscrow(store, input, T0);
    expect(first.ok).toBe(true);

    const replayed = await drawDownCulinaryAuditEscrow(store, input, T0);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.journal_id).toBeNull();

    const lines = await store.listCulinaryAuditEscrowDrawdowns(escrow.id);
    expect(lines).toHaveLength(1);
  });

  it("refuses a scope mismatch, an unknown bucket, and a draw from a settled escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: culinaryAuditEscrowScopeKey("chef-other", KITCHEN),
          drawdown_class: "refund_allowance",
          source_event_id: "scope-mismatch",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );
    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: "missing",
          scope_key: SCOPE,
          drawdown_class: "refund_allowance",
          source_event_id: "unknown-bucket",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_credit_not_found",
    );

    // A drawdown that consumes the LAST cent settles the escrow — and a
    // follow-up draw refuses: money never leaves a settled escrow.
    const drained = await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "spoilage_chargeback",
        source_event_id: "spoilage-full-drain",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(drained.ok).toBe(true);
    const afterDrain = await store.getLedgerTransaction(escrow.id);
    expect(afterDrain?.status).toBe("settled");
    expectFailure(
      await drawDownCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "refund_allowance",
          source_event_id: "post-settle-draw",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_already_settled",
    );
  });
});

describe("reconcileCulinaryAuditEscrow + releaseCulinaryAuditEscrow — the verified release", () => {
  it("records the reconciliation of record insert-as-lock — the first wins, a second throws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const recorded = await reconcileCulinaryAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "supplier-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(recorded.ok).toBe(true);

    let secondThrew: unknown;
    try {
      await store.insertCulinaryAuditEscrowReconciliation({
        reserve_ledger_id: escrow.id,
        evidence_ref: "supplier-audit-q4-2026-v2.pdf",
        reconciled_by: "compliance-desk",
      });
    } catch (error) {
      secondThrew = error;
    }
    expect(secondThrew).toBeInstanceOf(Error);
    expect(
      (await store.getCulinaryAuditEscrowReconciliation(escrow.id))?.evidence_ref,
    ).toBe("supplier-audit-q4-2026.pdf");
  });

  it("refuses a reconciliation with blank evidence or reconciler, and a scope mismatch", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await reconcileCulinaryAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "  ",
        reconciled_by: "compliance-desk",
      }),
      "invalid_reconciliation_evidence",
    );
    expectFailure(
      await reconcileCulinaryAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "supplier-audit.pdf",
        reconciled_by: "",
      }),
      "invalid_reconciliation_evidence",
    );
    expectFailure(
      await reconcileCulinaryAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: culinaryAuditEscrowScopeKey("chef-other", KITCHEN),
        evidence_ref: "supplier-audit.pdf",
        reconciled_by: "compliance-desk",
      }),
      "not_an_escrow_credit",
    );
  });

  it("refuses a release with no reconciliation of record — fail-closed, before the CAS", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, CHEF_ID);

    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "culinary_audit_escrow_reconciliation_missing",
    );
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("culinary_audit_escrow");
  });

  it("releases the remaining balance to the chef only against the verified reconciliation — the gate re-resolves fail-closed at release too", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedPolicy(store, 700);

    await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "refund_allowance",
        source_event_id: "refund-2026-10-03-001",
        drawn_cents: 20_000,
      },
      T0,
    );

    // The gate states fail the release while unresolved — even with a
    // reconciliation of record.
    const reconciled = await reconcileCulinaryAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "supplier-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(reconciled.ok).toBe(true);
    await seedVerifiedKyc(store, CHEF_ID);
    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "vertical_state_unknown",
    );

    // The cleared/verified gate opens the release — the remaining 50,000
    // rides the taxed cascade.
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    const released = await releaseCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(50_000);
    expect(released.value.escrow_credit.status).toBe("settled");
    expect(released.value.credits[0]?.gross_cents).toBe(50_000);
    expect(Number.isInteger(released.value.credits[0]?.net_cents)).toBe(true);
    expect(released.value.journal_id).not.toBeNull();

    // A replayed release refuses — the CAS.
    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_already_settled",
    );
  });

  it("refuses a release whose (chef, kitchen) pair does not re-derive the named scope, and a fully-drawn escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, CHEF_ID);
    await reconcileCulinaryAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "supplier-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });

    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          chef_id: "chef-someone-else",
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );

    // A base scope's release carries no pop-up ref.
    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          popup_ref: "popup-30day-lto",
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );

    // Fully drawn — nothing releases.
    const drained = await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "supplier_quality_audit",
        source_event_id: "supplier-audit-drain",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(drained.ok).toBe(true);
    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_already_settled", // the full drawdown settled the escrow first
    );
  });
});

describe("the pop-up decommissioning audit — the virtual-brand gate", () => {
  const POPUP_REF = "30day-lto-austin";
  const POPUP_SCOPE = culinaryPopupScopeKey(CHEF_ID, KITCHEN, POPUP_REF);

  /** The pop-up scope's terms: its own policy of record + cleared gates. */
  async function seedPopupScopeTerms(store: Store): Promise<void> {
    const registered = await registerCulinaryAuditEscrowPolicy(store, {
      chef_id: CHEF_ID,
      ghost_kitchen_location_code: KITCHEN,
      popup_ref: POPUP_REF,
      reserve_rate_bps: 700,
    });
    expect(registered.ok).toBe(true);
    await seedCulinaryGateState(store, {
      health_inspection_state: "cleared",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, CHEF_ID);
  }

  it("registers the campaign window of record insert-as-lock — the first wins, a re-shipped sheet throws", async () => {
    const store = makeStore();

    const registered = await registerCulinaryPopupExperience(
      store,
      {
        popup_ref: POPUP_REF,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        menu_theme: "viral men-u 30-day LTO",
        window_start_date: "2026-10-01",
        window_end_date: "2026-10-30",
      });
    expect(registered.ok).toBe(true);

    let reShippedThrew: unknown;
    try {
      await store.insertCulinaryPopupExperience({
        popup_ref: POPUP_REF,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        menu_theme: "a re-shipped sheet",
        window_start_date: "2026-10-01",
        window_end_date: "2026-10-30",
      });
    } catch (error) {
      reShippedThrew = error;
    }
    expect(reShippedThrew).toBeInstanceOf(Error);
    expect(
      (await store.getCulinaryPopupExperience(POPUP_REF))?.menu_theme,
    ).toBe("viral men-u 30-day LTO");

    // The window must run forward.
    expectFailure(
      await registerCulinaryPopupExperience(
        store,
        {
          popup_ref: "backwards-window",
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          menu_theme: "time travel LTO",
          window_start_date: "2026-10-30",
          window_end_date: "2026-10-01",
        }),
      "invalid_popup_window",
    );
  });

  it("records the post-campaign packaging write-off at the pinned price — unsold × unit, integer cents", async () => {
    const store = makeStore();
    await registerCulinaryPopupExperience(
      store,
      {
        popup_ref: POPUP_REF,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        menu_theme: "viral men-u 30-day LTO",
        window_start_date: "2026-10-01",
        window_end_date: "2026-10-30",
      });

    const recorded = await recordCulinaryPopupWriteoff(
      store,
      {
        popup_ref: POPUP_REF,
        source_event_id: "writeoff-sheet-2026-10-31",
        unsold_packages: 250,
        unit_cost_cents: 340,
        evidence_ref: "packaging-count-sheet.pdf",
        calculated_by: "ops-desk",
      });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.writeoff_cents).toBe(85_000);
    expect(recorded.value.unsold_packages).toBe(250);
    expect(recorded.value.unit_cost_cents).toBe(340);

    // The write-off rides its campaign — the listing reads by popup id.
    const popup = await store.getCulinaryPopupExperience(POPUP_REF);
    const lines = await store.listCulinaryPopupWriteoffs(popup?.id ?? "");
    expect(lines).toHaveLength(1);

    // The price pin refuses mis-shaped counts and costs.
    expectFailure(
      await recordCulinaryPopupWriteoff(
        store,
        {
          popup_ref: POPUP_REF,
          source_event_id: "writeoff-fractional",
          unsold_packages: 10.5,
          unit_cost_cents: 340,
          evidence_ref: "count-sheet.pdf",
          calculated_by: "ops-desk",
        }),
      "invalid_writeoff_count",
    );
    expectFailure(
      await recordCulinaryPopupWriteoff(
        store,
        {
          popup_ref: POPUP_REF,
          source_event_id: "writeoff-negative-cost",
          unsold_packages: 10,
          unit_cost_cents: -1,
          evidence_ref: "count-sheet.pdf",
          calculated_by: "ops-desk",
        }),
      "invalid_writeoff_unit_cost",
    );
    expectFailure(
      await recordCulinaryPopupWriteoff(
        store,
        {
          popup_ref: "popup-never-registered",
          source_event_id: "writeoff-orphan",
          unsold_packages: 10,
          unit_cost_cents: 340,
          evidence_ref: "count-sheet.pdf",
          calculated_by: "ops-desk",
        }),
      "popup_experience_not_found",
    );
  });

  it("gates the pop-up scope's release fail-closed on the packaging write-off — then clears the remaining escrow post-audit", async () => {
    const store = makeStore();
    await seedPopupScopeTerms(store);

    // The campaign window of record — the 30-day LTO itself.
    const campaign = await registerCulinaryPopupExperience(
      store,
      {
        popup_ref: POPUP_REF,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        menu_theme: "viral men-u 30-day LTO",
        window_start_date: "2026-10-01",
        window_end_date: "2026-10-30",
      });
    expect(campaign.ok).toBe(true);

    // Route a held payout into the POP-UP scope's escrow — the routing
    // derives the pop-up scope when the campaign ref rides the input.
    const held = await seedHeldPayout(store, HELD);
    const routed = await routeCulinaryAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        popup_ref: POPUP_REF,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(70_000);

    // The pop-up scope's escrow: draw a refund allowance, then attempt
    // the release WITHOUT the write-off — fail-closed.
    const escrowCredit = routed.value.escrow_credit;
    expect(escrowCredit).not.toBeNull();
    if (!escrowCredit) return;
    const popupEscrowId = escrowCredit.id;
    expect(escrowCredit.payee_id).toBe(culinaryAuditEscrowPayeeId(POPUP_SCOPE));
    expect(escrowCredit.line_item_id).toBe(POPUP_SCOPE);
    await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: popupEscrowId,
        scope_key: POPUP_SCOPE,
        drawdown_class: "refund_allowance",
        source_event_id: "popup-refund-001",
        drawn_cents: 10_000,
      },
      T0,
    );
    await reconcileCulinaryAuditEscrow(store, {
      reserve_ledger_id: popupEscrowId,
      scope_key: POPUP_SCOPE,
      evidence_ref: "supplier-audit-popup.pdf",
      reconciled_by: "compliance-desk",
    });

    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: popupEscrowId,
          scope_key: POPUP_SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          popup_ref: POPUP_REF,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "popup_writeoff_missing",
    );

    // The escrow held — the decommissioning audit has not run.
    expect((await store.getLedgerTransaction(popupEscrowId))?.status).toBe("culinary_audit_escrow");

    // The post-campaign packaging write-off of record lands — the gate
    // opens and the remaining escrow clears post-audit.
    const writtenOff = await recordCulinaryPopupWriteoff(
      store,
      {
        popup_ref: POPUP_REF,
        source_event_id: "writeoff-sheet-2026-10-31",
        unsold_packages: 120,
        unit_cost_cents: 250,
        evidence_ref: "packaging-count-sheet.pdf",
        calculated_by: "ops-desk",
      });
    expect(writtenOff.ok).toBe(true);

    const released = await releaseCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: popupEscrowId,
        scope_key: POPUP_SCOPE,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        popup_ref: POPUP_REF,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    // HELD at 700 bps → 70,000 locked; 10,000 drawn → 60,000 released.
    expect(released.value.released_cents).toBe(60_000);
    expect(released.value.escrow_credit.status).toBe("settled");
    expect(released.value.credits[0]?.gross_cents).toBe(60_000);

    // The pop-up scope detection is honest in both directions.
    expect(isCulinaryPopupScope(POPUP_SCOPE)).toBe(true);
    expect(isCulinaryPopupScope(SCOPE)).toBe(false);
  });

  it("refuses a pop-up release whose identity does not re-derive the named scope — the ref is part of the key", async () => {
    const store = makeStore();
    await seedPopupScopeTerms(store);
    const escrow = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: POPUP_SCOPE,
      payee_id: culinaryAuditEscrowPayeeId(POPUP_SCOPE),
      payee_name: culinaryAuditEscrowPayeeName(POPUP_SCOPE),
      role: "other",
      share_bps: 0,
      amount_cents: 70_000,
      currency: "USD",
      status: "culinary_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "culinary_audit_escrow",
    });
    await reconcileCulinaryAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: POPUP_SCOPE,
      evidence_ref: "supplier-audit-popup.pdf",
      reconciled_by: "compliance-desk",
    });

    // A different (never-registered) campaign ref re-derives a different
    // scope — the injective identity check refuses before any campaign
    // lookup, so a foreign campaign can never open this scope's gate.
    expectFailure(
      await releaseCulinaryAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: POPUP_SCOPE,
          chef_id: CHEF_ID,
          ghost_kitchen_location_code: KITCHEN,
          popup_ref: "never-registered-popup",
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );
  });
});

describe("the full culinary escrow lifecycle — allocations plus dust equals gross, ALWAYS", () => {
  it("routes, draws down, and releases with every bucket conserved at integer cents", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeCulinaryAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    // The routing conserved the gross exactly.
    expect(
      culinaryZeroBalanceHolds(
        HELD,
        [
          { amount_cents: routed.value.split.routed_cents },
          { amount_cents: routed.value.split.escrow_cents },
        ],
        routed.value.company_dust_cents,
      ),
    ).toBe(true);

    // The spend lane runs its three classes; the release pays the rest.
    const escrowId = routed.value.escrow_credit?.id ?? "";
    await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "refund_allowance",
        source_event_id: "lifecycle-refund",
        drawn_cents: 5_000,
      },
      T0,
    );
    await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "spoilage_chargeback",
        source_event_id: "lifecycle-spoilage",
        drawn_cents: 3_000,
      },
      T0,
    );
    await drawDownCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "supplier_quality_audit",
        source_event_id: "lifecycle-supplier",
        drawn_cents: 2_000,
      },
      T0,
    );
    await reconcileCulinaryAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: SCOPE,
      evidence_ref: "lifecycle-reconciliation.pdf",
      reconciled_by: "compliance-desk",
    });

    const released = await releaseCulinaryAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        chef_id: CHEF_ID,
        ghost_kitchen_location_code: KITCHEN,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // The WHOLE lifecycle conserved the locked escrow: the 10,000 drawn
    // plus the 60,000 released equal the 70,000 locked — integer cents,
    // dust zero, ALWAYS.
    expect(routed.value.split.escrow_cents).toBe(70_000);
    expect(released.value.released_cents).toBe(60_000);
    const lines = await store.listCulinaryAuditEscrowDrawdowns(escrowId);
    const totalDrawn = lines.reduce((total, line) => total + line.drawn_cents, 0);
    expect(totalDrawn + released.value.released_cents).toBe(routed.value.split.escrow_cents);
    expect(
      culinaryZeroBalanceHolds(
        routed.value.split.escrow_cents,
        [
          { amount_cents: totalDrawn },
          { amount_cents: released.value.released_cents },
        ],
        0,
      ),
    ).toBe(true);
  });
});
