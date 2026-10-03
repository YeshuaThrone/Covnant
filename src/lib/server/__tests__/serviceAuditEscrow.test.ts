// The SERVICE_AUDIT_ESCROW bucket + the services payout gate states (PR 43) —
// the behavioral suite for the founder's services directive: 5–10% of
// franchise service payouts routed automatically into the reserved bucket at
// routing, drawn down ONLY by client refund allowances, product return
// chargebacks, or quarterly backbar inventory audits, and released ONLY
// with a verified reconciliation of record — every absent/unknown gate
// state failing closed (health_board_license_verified and
// territorial_franchise_exclusivity_verified read the durable states of
// record, migration 0047). The Don invariants hold throughout: integer
// cents, allocations plus dust equals gross including the escrow bucket,
// idempotency (a replayed event moves nothing twice), and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  SERVICE_AUDIT_ESCROW_MAX_RATE_BPS,
  SERVICE_AUDIT_ESCROW_MIN_RATE_BPS,
  serviceAuditEscrowPayeeId,
  serviceAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildServiceAuditEscrowSplitPlan,
  serviceZeroBalanceHolds,
  serviceAuditEscrowScopeKey,
  drawDownServiceAuditEscrow,
  reconcileServiceAuditEscrow,
  registerServiceAuditEscrowPolicy,
  releaseServiceAuditEscrow,
  routeServiceAuditEscrowFromPayout,
} from "@/lib/server/serviceAuditEscrow";
import { resolveServicesVerticalComplianceState } from "@/modules/compliance/payoutGate";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const STYLIST_ID = "stylist-imani";
const STYLIST_NAME = "Imani Stylist";
const SALON = "SALON-AUSTIN-01";
const SCOPE = serviceAuditEscrowScopeKey(STYLIST_ID, SALON);
const HELD = 1_000_000; // the held franchise service payout: $10,000

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

async function seedServicesGateState(
  store: Store,
  states: {
    health_license_state: "unknown" | "verified";
    territorial_exclusivity_state: "unknown" | "verified";
  },
  payeeId = STYLIST_ID,
  salonLocationId = SALON,
): Promise<void> {
  await store.upsertServicesPayoutGateState({
    payee_id: payeeId,
    salon_location_id: salonLocationId,
    health_license_state: states.health_license_state,
    territorial_exclusivity_state: states.territorial_exclusivity_state,
    evidence_ref: "health-exclusivity-audit.pdf",
    verified_by: "compliance-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 700): Promise<void> {
  const registered = await registerServiceAuditEscrowPolicy(store, {
    stylist_id: STYLIST_ID,
    salon_location_id: SALON,
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
    line_item_id: "service-payout-line-1",
    payee_id: STYLIST_ID,
    payee_name: STYLIST_NAME,
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

/** The shared happy path: policy, verified gates, verified KYC, held payout. */
async function seedRoutingFixture(store: Store, rateBps = 700): Promise<LedgerTransactionRecord> {
  await seedPolicy(store, rateBps);
  await seedServicesGateState(store, {
    health_license_state: "verified",
    territorial_exclusivity_state: "verified",
  });
  await seedVerifiedKyc(store, STYLIST_ID);
  return seedHeldPayout(store, HELD);
}

async function seedEscrow(
  store: Store,
  amountCents = 70_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: serviceAuditEscrowPayeeId(SCOPE),
    payee_name: serviceAuditEscrowPayeeName(SCOPE),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "service_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "service_audit_escrow",
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

describe("registerServiceAuditEscrowPolicy — the founder band", () => {
  it("registers a rate inside the 500–1000 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      reserve_rate_bps: 700,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      reserve_rate_bps: 900,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(900);

    const readBack = await store.getServiceAuditEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(900);
  });

  it("accepts both band edges (500 and 1000 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      reserve_rate_bps: SERVICE_AUDIT_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);
    const maxEdge = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      reserve_rate_bps: SERVICE_AUDIT_ESCROW_MAX_RATE_BPS,
    });
    expect(maxEdge.ok).toBe(true);

    const tooLow = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      reserve_rate_bps: SERVICE_AUDIT_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(tooLow, "escrow_rate_out_of_band");
    const tooHigh = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      reserve_rate_bps: SERVICE_AUDIT_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(tooHigh, "escrow_rate_out_of_band");
  });

  it("refuses blank identity — a policy names the stylist and salon location it protects", async () => {
    const store = makeStore();
    expectFailure(
      await registerServiceAuditEscrowPolicy(store, {
        stylist_id: "  ",
        salon_location_id: SALON,
        reserve_rate_bps: 700,
      }),
      "invalid_scope_identity",
    );
    expectFailure(
      await registerServiceAuditEscrowPolicy(store, {
        stylist_id: STYLIST_ID,
        salon_location_id: "",
        reserve_rate_bps: 700,
      }),
      "invalid_scope_identity",
    );
  });
});

describe("buildServiceAuditEscrowSplitPlan — the escrow bucket arithmetic", () => {
  it("locks the founder-banded share exactly: remainder + escrow === amount, dust zero", () => {
    const planned = buildServiceAuditEscrowSplitPlan({
      amount_cents: HELD,
      reserve_rate_bps: 700,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(70_000);
    expect(planned.value.routed_cents).toBe(HELD - 70_000);
    expect(planned.value.company_dust_cents).toBe(0);
    expect(
      serviceZeroBalanceHolds(HELD, [
        { amount_cents: planned.value.routed_cents },
        { amount_cents: planned.value.escrow_cents },
      ], planned.value.company_dust_cents),
    ).toBe(true);
  });

  it("floors the rate multiplication — the stylist's share is the exact subtraction remainder", () => {
    const planned = buildServiceAuditEscrowSplitPlan({
      amount_cents: 999,
      reserve_rate_bps: 700,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // floor(999 × 700 / 10,000) = 69 — the stylist keeps the 930 remainder.
    expect(planned.value.escrow_cents).toBe(69);
    expect(planned.value.routed_cents).toBe(930);
  });

  it("refuses a non-positive or non-integer amount and an out-of-band rate", () => {
    expectFailure(
      buildServiceAuditEscrowSplitPlan({ amount_cents: 0, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildServiceAuditEscrowSplitPlan({ amount_cents: -5, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildServiceAuditEscrowSplitPlan({ amount_cents: 10.5, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildServiceAuditEscrowSplitPlan({ amount_cents: 100, reserve_rate_bps: 499 }),
      "escrow_rate_out_of_band",
    );
    expectFailure(
      buildServiceAuditEscrowSplitPlan({ amount_cents: 100, reserve_rate_bps: 1001 }),
      "escrow_rate_out_of_band",
    );
  });
});

describe("serviceZeroBalanceHolds — the house invariant", () => {
  it("holds on exact conservation and refuses drift, negatives, and non-integers", () => {
    expect(serviceZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 300 }], 0)).toBe(true);
    expect(serviceZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 299 }], 1)).toBe(true);
    expect(serviceZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 299 }], 0)).toBe(false);
    expect(serviceZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 301 }], 0)).toBe(false);
    expect(serviceZeroBalanceHolds(1000, [{ amount_cents: -1 }, { amount_cents: 1001 }], 0)).toBe(false);
    expect(serviceZeroBalanceHolds(10.5, [{ amount_cents: 10 }, { amount_cents: 0 }], 0)).toBe(false);
  });
});

describe("routeServiceAuditEscrowFromPayout — the automatic routing", () => {
  it("splits the held payout at the policy rate: the escrow locks at the sentinel payee, the stylist rides the taxed cascade", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeServiceAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        stylist_id: STYLIST_ID,
        salon_location_id: SALON,
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
    // status 'service_audit_escrow', the scope stamped in line_item_id.
    const escrowCredit = routed.value.escrow_credit;
    expect(escrowCredit).not.toBeNull();
    if (!escrowCredit) return;
    expect(escrowCredit.payee_id).toBe(serviceAuditEscrowPayeeId(SCOPE));
    expect(escrowCredit.payee_name).toBe(serviceAuditEscrowPayeeName(SCOPE));
    expect(escrowCredit.kind).toBe("service_audit_escrow");
    expect(escrowCredit.status).toBe("service_audit_escrow");
    expect(escrowCredit.amount_cents).toBe(70_000);
    expect(escrowCredit.line_item_id).toBe(SCOPE);

    // The held payout settled exactly once.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("settled");

    // The stylist's credit rode the taxed cascade.
    expect(routed.value.credits).toHaveLength(1);
    expect(routed.value.credits[0]?.payee_id).toBe(STYLIST_ID);
    expect(routed.value.credits[0]?.step).toBe("stylist_net");
    expect(routed.value.credits[0]?.gross_cents).toBe(HELD - 70_000);
    expect(Number.isInteger(routed.value.credits[0]?.net_cents)).toBe(true);

    // One balanced GL journal rode the routing.
    expect(routed.value.journal_id).not.toBeNull();
  });

  it("locks no escrow row when the founder-banded share floors to zero on a sub-10-cent payout", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 500);
    const tiny = await seedHeldPayout(store, 19); // floor(19 × 500 / 10,000) = 0

    const routed = await routeServiceAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: tiny.id,
        stylist_id: STYLIST_ID,
        salon_location_id: SALON,
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
      stylist_id: STYLIST_ID,
      salon_location_id: SALON,
      operator_settlement_approved: true,
    };
    const first = await routeServiceAuditEscrowFromPayout(store, input, T0);
    expect(first.ok).toBe(true);

    const replayed = await routeServiceAuditEscrowFromPayout(store, input, T0);
    expectFailure(replayed, "payout_already_released");
  });

  it("refuses an unknown ledger row, a non-holding row, and an unapproved settlement", async () => {
    const store = makeStore();
    expectFailure(
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: "missing",
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
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
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: settledRow.id,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "payout_already_released",
    );

    const held = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: held.id,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: false,
        },
        T0,
      ),
      "settlement_not_approved",
    );
  });

  it("refuses a scope with no registered policy — terms of record come from the registry, never the caller", async () => {
    const store = makeStore();
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, STYLIST_ID);
    const held = await seedHeldPayout(store, HELD);

    expectFailure(
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: held.id,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "missing_service_audit_escrow_policy",
    );
    // Nothing moved.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("unclaimed_holding");
  });
});

describe("the services payout gate — health_board_license_verified + territorial_franchise_exclusivity_verified, fail-closed", () => {
  it("resolves the durable states of record: absent record → null, unknown → false, verified → true", async () => {
    const store = makeStore();
    expect(await resolveServicesVerticalComplianceState(store, STYLIST_ID, SALON)).toBeNull();

    await seedServicesGateState(store, {
      health_license_state: "unknown",
      territorial_exclusivity_state: "unknown",
    });
    const unknown = await resolveServicesVerticalComplianceState(store, STYLIST_ID, SALON);
    expect(unknown).not.toBeNull();
    expect(unknown?.health_board_license_verified).toBe(false);
    expect(unknown?.territorial_franchise_exclusivity_verified).toBe(false);

    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "verified",
    });
    const verified = await resolveServicesVerticalComplianceState(store, STYLIST_ID, SALON);
    expect(verified?.health_board_license_verified).toBe(true);
    expect(verified?.territorial_franchise_exclusivity_verified).toBe(true);

    // Half-verified resolves half-true — each state stands alone.
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "unknown",
    });
    const half = await resolveServicesVerticalComplianceState(store, STYLIST_ID, SALON);
    expect(half?.health_board_license_verified).toBe(true);
    expect(half?.territorial_franchise_exclusivity_verified).toBe(false);
  });

  it("routing fails closed on an absent gate record, each individually-unknown state, and unverified KYC", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedVerifiedKyc(store, STYLIST_ID);

    // Absent gate record entirely — the gate reads null and refuses.
    const absent = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: absent.id,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "vertical_state_unknown",
    );

    // An 'unknown' health license state — the specific condition refuses.
    await seedServicesGateState(store, {
      health_license_state: "unknown",
      territorial_exclusivity_state: "verified",
    });
    const unknownLicense = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unknownLicense.id,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "services_license_not_verified",
    );

    // An unverified territorial franchise exclusivity state — the other
    // half refuses.
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "unknown",
    });
    const unknownExclusivity = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unknownExclusivity.id,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "services_exclusivity_unverified",
    );

    // A stylist with no KYC record at all — the identity gate refuses on
    // the unknown state (a different stylist, their own scope's terms).
    const NO_KYC = "stylist-nokyc";
    const NO_KYC_SCOPE = serviceAuditEscrowScopeKey(NO_KYC, SALON);
    const noKycPolicy = await registerServiceAuditEscrowPolicy(store, {
      stylist_id: NO_KYC,
      salon_location_id: SALON,
      reserve_rate_bps: 700,
    });
    expect(noKycPolicy.ok).toBe(true);
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "verified",
    }, NO_KYC);
    const unverifiedKyc = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: NO_KYC_SCOPE,
      payee_id: NO_KYC,
      payee_name: `Stylist ${NO_KYC}`,
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
      await routeServiceAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unverifiedKyc.id,
          stylist_id: NO_KYC,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "kyc_state_unknown",
    );

    // Every refused payout is still exactly where it started.
    for (const id of [absent.id, unknownLicense.id, unknownExclusivity.id, unverifiedKyc.id]) {
      expect((await store.getLedgerTransaction(id))?.status).toBe("unclaimed_holding");
    }
  });

  it("routes through only when every gate condition is explicitly true", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 500);

    const routed = await routeServiceAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        stylist_id: STYLIST_ID,
        salon_location_id: SALON,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(50_000);
  });
});

describe("drawDownServiceAuditEscrow — the spend lane", () => {
  it("draws a client refund allowance down position-locked", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const drawn = await drawDownServiceAuditEscrow(
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

  it("draws a product return chargeback, then a quarterly backbar inventory audit — balances strictly decrease", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const chargeback = await drawDownServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "product_return_chargeback",
        source_event_id: "returns-rma-2026-10-05",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(chargeback.ok).toBe(true);
    if (!chargeback.ok) return;
    expect(chargeback.value.drawdown.remaining_cents).toBe(60_000);

    const backbarAudit = await drawDownServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "backbar_inventory_audit",
        source_event_id: "backbar-audit-q4-2026",
        drawn_cents: 5_000,
      },
      T0,
    );
    expect(backbarAudit.ok).toBe(true);
    if (!backbarAudit.ok) return;
    expect(backbarAudit.value.drawdown.drawn_before_cents).toBe(60_000);
    expect(backbarAudit.value.drawdown.remaining_cents).toBe(55_000);

    const lines = await store.listServiceAuditEscrowDrawdowns(escrow.id);
    expect(lines.map((line) => line.drawn_before_cents)).toEqual([70_000, 60_000]);
  });

  it("refuses an overdraw — refuse, never clip", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 50_000);

    expectFailure(
      await drawDownServiceAuditEscrow(
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
    expect(await store.listServiceAuditEscrowDrawdowns(escrow.id)).toHaveLength(0);
  });

  it("refuses a foreign drawdown class and a non-integer or non-positive amount", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await drawDownServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "spoilage_chargeback", // the culinary lane's class
          source_event_id: "foreign-class",
          drawn_cents: 100,
        },
        T0,
      ),
      "invalid_drawdown_class",
    );
    expectFailure(
      await drawDownServiceAuditEscrow(
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
      await drawDownServiceAuditEscrow(
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
    const first = await drawDownServiceAuditEscrow(store, input, T0);
    expect(first.ok).toBe(true);

    const replayed = await drawDownServiceAuditEscrow(store, input, T0);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.journal_id).toBeNull();

    const lines = await store.listServiceAuditEscrowDrawdowns(escrow.id);
    expect(lines).toHaveLength(1);
  });

  it("refuses a scope mismatch, an unknown bucket, and a draw from a settled escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await drawDownServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: serviceAuditEscrowScopeKey("stylist-other", SALON),
          drawdown_class: "refund_allowance",
          source_event_id: "scope-mismatch",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );
    expectFailure(
      await drawDownServiceAuditEscrow(
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
    const drained = await drawDownServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "product_return_chargeback",
        source_event_id: "returns-full-drain",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(drained.ok).toBe(true);
    const afterDrain = await store.getLedgerTransaction(escrow.id);
    expect(afterDrain?.status).toBe("settled");
    expectFailure(
      await drawDownServiceAuditEscrow(
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

describe("reconcileServiceAuditEscrow + releaseServiceAuditEscrow — the verified release", () => {
  it("records the reconciliation of record insert-as-lock — the first wins, a second throws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const recorded = await reconcileServiceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "backbar-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(recorded.ok).toBe(true);

    let secondThrew: unknown;
    try {
      await store.insertServiceAuditEscrowReconciliation({
        reserve_ledger_id: escrow.id,
        evidence_ref: "backbar-audit-q4-2026-v2.pdf",
        reconciled_by: "compliance-desk",
      });
    } catch (error) {
      secondThrew = error;
    }
    expect(secondThrew).toBeInstanceOf(Error);
    expect(
      (await store.getServiceAuditEscrowReconciliation(escrow.id))?.evidence_ref,
    ).toBe("backbar-audit-q4-2026.pdf");
  });

  it("refuses a reconciliation with blank evidence or reconciler, and a scope mismatch", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await reconcileServiceAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "  ",
        reconciled_by: "compliance-desk",
      }),
      "invalid_reconciliation_evidence",
    );
    expectFailure(
      await reconcileServiceAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "backbar-audit.pdf",
        reconciled_by: "",
      }),
      "invalid_reconciliation_evidence",
    );
    expectFailure(
      await reconcileServiceAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: serviceAuditEscrowScopeKey("stylist-other", SALON),
        evidence_ref: "backbar-audit.pdf",
        reconciled_by: "compliance-desk",
      }),
      "not_an_escrow_credit",
    );
  });

  it("refuses a release with no reconciliation of record — fail-closed, before the CAS", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, STYLIST_ID);

    expectFailure(
      await releaseServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "service_audit_escrow_reconciliation_missing",
    );
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("service_audit_escrow");
  });

  it("releases the remaining balance to the stylist only against the verified reconciliation — the gate re-resolves fail-closed at release too", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedPolicy(store, 700);

    await drawDownServiceAuditEscrow(
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
    const reconciled = await reconcileServiceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "backbar-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(reconciled.ok).toBe(true);
    await seedVerifiedKyc(store, STYLIST_ID);
    expectFailure(
      await releaseServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "vertical_state_unknown",
    );

    // The verified gates open the release — the remaining 50,000 rides
    // the taxed cascade.
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "verified",
    });
    const released = await releaseServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        stylist_id: STYLIST_ID,
        salon_location_id: SALON,
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
      await releaseServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_already_settled",
    );
  });

  it("refuses a release whose (stylist, salon location) pair does not re-derive the named scope, and a fully-drawn escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedServicesGateState(store, {
      health_license_state: "verified",
      territorial_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(store, STYLIST_ID);
    await reconcileServiceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "backbar-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });

    expectFailure(
      await releaseServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          stylist_id: "stylist-someone-else",
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );

    // A different salon location re-derives a different scope — the
    // injective identity check refuses.
    expectFailure(
      await releaseServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          stylist_id: STYLIST_ID,
          salon_location_id: "SALON-DALLAS-02",
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );

    // Fully drawn — nothing releases.
    const drained = await drawDownServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "backbar_inventory_audit",
        source_event_id: "backbar-audit-drain",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(drained.ok).toBe(true);
    expectFailure(
      await releaseServiceAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          stylist_id: STYLIST_ID,
          salon_location_id: SALON,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_already_settled", // the full drawdown settled the escrow first
    );
  });
});

describe("the full service escrow lifecycle — allocations plus dust equals gross, ALWAYS", () => {
  it("routes, draws down, and releases with every bucket conserved at integer cents", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeServiceAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        stylist_id: STYLIST_ID,
        salon_location_id: SALON,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    // The routing conserved the gross exactly.
    expect(
      serviceZeroBalanceHolds(
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
    await drawDownServiceAuditEscrow(
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
    await drawDownServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "product_return_chargeback",
        source_event_id: "lifecycle-returns",
        drawn_cents: 3_000,
      },
      T0,
    );
    await drawDownServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "backbar_inventory_audit",
        source_event_id: "lifecycle-backbar",
        drawn_cents: 2_000,
      },
      T0,
    );
    await reconcileServiceAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: SCOPE,
      evidence_ref: "lifecycle-reconciliation.pdf",
      reconciled_by: "compliance-desk",
    });

    const released = await releaseServiceAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        stylist_id: STYLIST_ID,
        salon_location_id: SALON,
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
    const lines = await store.listServiceAuditEscrowDrawdowns(escrowId);
    const totalDrawn = lines.reduce((total, line) => total + line.drawn_cents, 0);
    expect(totalDrawn + released.value.released_cents).toBe(routed.value.split.escrow_cents);
    expect(
      serviceZeroBalanceHolds(
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
