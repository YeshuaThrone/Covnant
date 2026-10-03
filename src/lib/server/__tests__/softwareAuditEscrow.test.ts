// The SOFTWARE_AUDIT_ESCROW bucket + the software payout gate states (PR 45) —
// the behavioral suite for the founder's software directive: 5–10% of
// developer IP payouts routed automatically into the reserved bucket at
// routing, drawn down ONLY by uptime outage penalty refunds, API rate-limit
// breach credits, or quarterly security compliance audits, and released ONLY
// with a verified reconciliation of record — every absent/unknown gate
// state failing closed (api_uptime_sla_verified and
// software_security_audit_cleared read the durable states of record,
// migration 0049). The Don invariants hold throughout: integer cents,
// allocations plus dust equals gross including the escrow bucket,
// idempotency (a replayed event moves nothing twice), and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS,
  SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS,
  softwareAuditEscrowPayeeId,
  softwareAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildSoftwareAuditEscrowSplitPlan,
  softwareZeroBalanceHolds,
  softwareAuditEscrowScopeKey,
  drawDownSoftwareAuditEscrow,
  reconcileSoftwareAuditEscrow,
  registerSoftwareAuditEscrowPolicy,
  releaseSoftwareAuditEscrow,
  routeSoftwareAuditEscrowFromPayout,
} from "@/lib/server/softwareAuditEscrow";
import { resolveSoftwareVerticalComplianceState } from "@/modules/compliance/payoutGate";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const DEVELOPER_ID = "developer-ada";
const DEVELOPER_NAME = "Ada Developer";
const ENDPOINT = "ENDPOINT-GLM-API";
const SCOPE = softwareAuditEscrowScopeKey(DEVELOPER_ID, ENDPOINT);
const HELD = 1_000_000; // the held developer IP payout: $10,000

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

async function seedSoftwareGateState(
  store: Store,
  states: {
    api_uptime_sla_state: "unknown" | "verified";
    security_audit_state: "unknown" | "verified";
  },
  payeeId = DEVELOPER_ID,
  apiEndpointId = ENDPOINT,
): Promise<void> {
  await store.upsertSoftwarePayoutGateState({
    payee_id: payeeId,
    api_endpoint_id: apiEndpointId,
    api_uptime_sla_state: states.api_uptime_sla_state,
    security_audit_state: states.security_audit_state,
    evidence_ref: "uptime-sla-security-audit.pdf",
    verified_by: "compliance-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 700): Promise<void> {
  const registered = await registerSoftwareAuditEscrowPolicy(store, {
    developer_id: DEVELOPER_ID,
    api_endpoint_id: ENDPOINT,
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
    line_item_id: "software-payout-line-1",
    payee_id: DEVELOPER_ID,
    payee_name: DEVELOPER_NAME,
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
  await seedSoftwareGateState(store, {
    api_uptime_sla_state: "verified",
    security_audit_state: "verified",
  });
  await seedVerifiedKyc(store, DEVELOPER_ID);
  return seedHeldPayout(store, HELD);
}

async function seedEscrow(
  store: Store,
  amountCents = 70_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: softwareAuditEscrowPayeeId(SCOPE),
    payee_name: softwareAuditEscrowPayeeName(SCOPE),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "software_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "software_audit_escrow",
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

describe("registerSoftwareAuditEscrowPolicy — the founder band", () => {
  it("registers a rate inside the 500–1000 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: 700,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: 900,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(900);

    const readBack = await store.getSoftwareAuditEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(900);
  });

  it("accepts both band edges (500 and 1000 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);
    const maxEdge = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS,
    });
    expect(maxEdge.ok).toBe(true);

    const tooLow = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(tooLow, "escrow_rate_out_of_band");
    const tooHigh = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(tooHigh, "escrow_rate_out_of_band");
  });

  it("refuses blank identity — a policy names the developer and API endpoint it protects", async () => {
    const store = makeStore();
    expectFailure(
      await registerSoftwareAuditEscrowPolicy(store, {
        developer_id: "  ",
        api_endpoint_id: ENDPOINT,
        reserve_rate_bps: 700,
      }),
      "invalid_scope_identity",
    );
    expectFailure(
      await registerSoftwareAuditEscrowPolicy(store, {
        developer_id: DEVELOPER_ID,
        api_endpoint_id: "",
        reserve_rate_bps: 700,
      }),
      "invalid_scope_identity",
    );
  });
});

describe("buildSoftwareAuditEscrowSplitPlan — the escrow bucket arithmetic", () => {
  it("locks the founder-banded share exactly: remainder + escrow === amount, dust zero", () => {
    const planned = buildSoftwareAuditEscrowSplitPlan({
      amount_cents: HELD,
      reserve_rate_bps: 700,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(70_000);
    expect(planned.value.routed_cents).toBe(HELD - 70_000);
    expect(planned.value.company_dust_cents).toBe(0);
    expect(
      softwareZeroBalanceHolds(HELD, [
        { amount_cents: planned.value.routed_cents },
        { amount_cents: planned.value.escrow_cents },
      ], planned.value.company_dust_cents),
    ).toBe(true);
  });

  it("floors the rate multiplication — the developer's share is the exact subtraction remainder", () => {
    const planned = buildSoftwareAuditEscrowSplitPlan({
      amount_cents: 999,
      reserve_rate_bps: 700,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // floor(999 × 700 / 10,000) = 69 — the developer keeps the 930 remainder.
    expect(planned.value.escrow_cents).toBe(69);
    expect(planned.value.routed_cents).toBe(930);
  });

  it("refuses a non-positive or non-integer amount and an out-of-band rate", () => {
    expectFailure(
      buildSoftwareAuditEscrowSplitPlan({ amount_cents: 0, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildSoftwareAuditEscrowSplitPlan({ amount_cents: -5, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildSoftwareAuditEscrowSplitPlan({ amount_cents: 10.5, reserve_rate_bps: 700 }),
      "invalid_allocation_amount",
    );
    expectFailure(
      buildSoftwareAuditEscrowSplitPlan({ amount_cents: 100, reserve_rate_bps: 499 }),
      "escrow_rate_out_of_band",
    );
    expectFailure(
      buildSoftwareAuditEscrowSplitPlan({ amount_cents: 100, reserve_rate_bps: 1001 }),
      "escrow_rate_out_of_band",
    );
  });
});

describe("softwareZeroBalanceHolds — the house invariant", () => {
  it("holds on exact conservation and refuses drift, negatives, and non-integers", () => {
    expect(softwareZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 300 }], 0)).toBe(true);
    expect(softwareZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 299 }], 1)).toBe(true);
    expect(softwareZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 299 }], 0)).toBe(false);
    expect(softwareZeroBalanceHolds(1000, [{ amount_cents: 700 }, { amount_cents: 301 }], 0)).toBe(false);
    expect(softwareZeroBalanceHolds(1000, [{ amount_cents: -1 }, { amount_cents: 1001 }], 0)).toBe(false);
    expect(softwareZeroBalanceHolds(10.5, [{ amount_cents: 10 }, { amount_cents: 0 }], 0)).toBe(false);
  });
});

describe("routeSoftwareAuditEscrowFromPayout — the automatic routing", () => {
  it("splits the held payout at the policy rate: the escrow locks at the sentinel payee, the developer rides the taxed cascade", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeSoftwareAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        developer_id: DEVELOPER_ID,
        api_endpoint_id: ENDPOINT,
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
    // status 'software_audit_escrow', the scope stamped in line_item_id.
    const escrowCredit = routed.value.escrow_credit;
    expect(escrowCredit).not.toBeNull();
    if (!escrowCredit) return;
    expect(escrowCredit.payee_id).toBe(softwareAuditEscrowPayeeId(SCOPE));
    expect(escrowCredit.payee_name).toBe(softwareAuditEscrowPayeeName(SCOPE));
    expect(escrowCredit.kind).toBe("software_audit_escrow");
    expect(escrowCredit.status).toBe("software_audit_escrow");
    expect(escrowCredit.amount_cents).toBe(70_000);
    expect(escrowCredit.line_item_id).toBe(SCOPE);

    // The held payout settled exactly once.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("settled");

    // The developer's credit rode the taxed cascade.
    expect(routed.value.credits).toHaveLength(1);
    expect(routed.value.credits[0]?.payee_id).toBe(DEVELOPER_ID);
    expect(routed.value.credits[0]?.step).toBe("developer_net");
    expect(routed.value.credits[0]?.gross_cents).toBe(HELD - 70_000);
    expect(Number.isInteger(routed.value.credits[0]?.net_cents)).toBe(true);

    // One balanced GL journal rode the routing.
    expect(routed.value.journal_id).not.toBeNull();
  });

  it("locks no escrow row when the founder-banded share floors to zero on a sub-10-cent payout", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 500);
    const tiny = await seedHeldPayout(store, 19); // floor(19 × 500 / 10,000) = 0

    const routed = await routeSoftwareAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: tiny.id,
        developer_id: DEVELOPER_ID,
        api_endpoint_id: ENDPOINT,
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
      developer_id: DEVELOPER_ID,
      api_endpoint_id: ENDPOINT,
      operator_settlement_approved: true,
    };
    const first = await routeSoftwareAuditEscrowFromPayout(store, input, T0);
    expect(first.ok).toBe(true);

    const replayed = await routeSoftwareAuditEscrowFromPayout(store, input, T0);
    expectFailure(replayed, "payout_already_released");
  });

  it("refuses an unknown ledger row, a non-holding row, and an unapproved settlement", async () => {
    const store = makeStore();
    expectFailure(
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: "missing",
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
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
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: settledRow.id,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "payout_already_released",
    );

    const held = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: held.id,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: false,
        },
        T0,
      ),
      "settlement_not_approved",
    );
  });

  it("refuses a scope with no registered policy — terms of record come from the registry, never the caller", async () => {
    const store = makeStore();
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "verified",
    });
    await seedVerifiedKyc(store, DEVELOPER_ID);
    const held = await seedHeldPayout(store, HELD);

    expectFailure(
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: held.id,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "missing_software_audit_escrow_policy",
    );
    // Nothing moved.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("unclaimed_holding");
  });
});

describe("the software payout gate — api_uptime_sla_verified + software_security_audit_cleared, fail-closed", () => {
  it("resolves the durable states of record: absent record → null, unknown → false, verified → true", async () => {
    const store = makeStore();
    expect(await resolveSoftwareVerticalComplianceState(store, DEVELOPER_ID, ENDPOINT)).toBeNull();

    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "unknown",
      security_audit_state: "unknown",
    });
    const unknown = await resolveSoftwareVerticalComplianceState(store, DEVELOPER_ID, ENDPOINT);
    expect(unknown).not.toBeNull();
    expect(unknown?.api_uptime_sla_verified).toBe(false);
    expect(unknown?.software_security_audit_cleared).toBe(false);

    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "verified",
    });
    const verified = await resolveSoftwareVerticalComplianceState(store, DEVELOPER_ID, ENDPOINT);
    expect(verified?.api_uptime_sla_verified).toBe(true);
    expect(verified?.software_security_audit_cleared).toBe(true);

    // Half-verified resolves half-true — each state stands alone.
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "unknown",
    });
    const half = await resolveSoftwareVerticalComplianceState(store, DEVELOPER_ID, ENDPOINT);
    expect(half?.api_uptime_sla_verified).toBe(true);
    expect(half?.software_security_audit_cleared).toBe(false);
  });

  it("routing fails closed on an absent gate record, each individually-unknown state, and unverified KYC", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedVerifiedKyc(store, DEVELOPER_ID);

    // Absent gate record entirely — the gate reads null and refuses.
    const absent = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: absent.id,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "vertical_state_unknown",
    );

    // An 'unknown' uptime SLA state — the specific condition refuses.
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "unknown",
      security_audit_state: "verified",
    });
    const unknownSla = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unknownSla.id,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "software_uptime_sla_unverified",
    );

    // An uncleared security audit state — the other half refuses.
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "unknown",
    });
    const unknownAudit = await seedHeldPayout(store, HELD);
    expectFailure(
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unknownAudit.id,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "software_security_audit_not_cleared",
    );

    // A developer with no KYC record at all — the identity gate refuses on
    // the unknown state (a different developer, their own scope's terms).
    const NO_KYC = "developer-nokyc";
    const NO_KYC_SCOPE = softwareAuditEscrowScopeKey(NO_KYC, ENDPOINT);
    const noKycPolicy = await registerSoftwareAuditEscrowPolicy(store, {
      developer_id: NO_KYC,
      api_endpoint_id: ENDPOINT,
      reserve_rate_bps: 700,
    });
    expect(noKycPolicy.ok).toBe(true);
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "verified",
    }, NO_KYC);
    const unverifiedKyc = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: NO_KYC_SCOPE,
      payee_id: NO_KYC,
      payee_name: `Developer ${NO_KYC}`,
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
      await routeSoftwareAuditEscrowFromPayout(
        store,
        {
          holding_ledger_id: unverifiedKyc.id,
          developer_id: NO_KYC,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "kyc_state_unknown",
    );

    // Every refused payout is still exactly where it started.
    for (const id of [absent.id, unknownSla.id, unknownAudit.id, unverifiedKyc.id]) {
      expect((await store.getLedgerTransaction(id))?.status).toBe("unclaimed_holding");
    }
  });

  it("routes through only when every gate condition is explicitly true", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 500);

    const routed = await routeSoftwareAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        developer_id: DEVELOPER_ID,
        api_endpoint_id: ENDPOINT,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(50_000);
  });
});

describe("drawDownSoftwareAuditEscrow — the spend lane", () => {
  it("draws an uptime outage penalty refund down position-locked", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const drawn = await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "uptime_outage_penalty_refund",
        source_event_id: "outage-2026-10-03-001",
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
    expect(drawn.value.drawdown.drawdown_class).toBe("uptime_outage_penalty_refund");
  });

  it("draws an API rate-limit breach credit, then a quarterly security compliance audit — balances strictly decrease", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const breachCredit = await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "api_rate_limit_breach_credit",
        source_event_id: "ratelimit-credits-2026-10-05",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(breachCredit.ok).toBe(true);
    if (!breachCredit.ok) return;
    expect(breachCredit.value.drawdown.remaining_cents).toBe(60_000);

    const securityAudit = await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "quarterly_security_compliance_audit",
        source_event_id: "security-audit-q4-2026",
        drawn_cents: 5_000,
      },
      T0,
    );
    expect(securityAudit.ok).toBe(true);
    if (!securityAudit.ok) return;
    expect(securityAudit.value.drawdown.drawn_before_cents).toBe(60_000);
    expect(securityAudit.value.drawdown.remaining_cents).toBe(55_000);

    const lines = await store.listSoftwareAuditEscrowDrawdowns(escrow.id);
    expect(lines.map((line) => line.drawn_before_cents)).toEqual([70_000, 60_000]);
  });

  it("refuses an overdraw — refuse, never clip", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 50_000);

    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "uptime_outage_penalty_refund",
          source_event_id: "outage-overdraw",
          drawn_cents: 50_001,
        },
        T0,
      ),
      "escrow_overdrawn",
    );
    expect(await store.listSoftwareAuditEscrowDrawdowns(escrow.id)).toHaveLength(0);
  });

  it("refuses a foreign drawdown class and a non-integer or non-positive amount", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "refund_allowance", // the service lane's class
          source_event_id: "foreign-class",
          drawn_cents: 100,
        },
        T0,
      ),
      "invalid_drawdown_class",
    );
    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "uptime_outage_penalty_refund",
          source_event_id: "fractional",
          drawn_cents: 10.5,
        },
        T0,
      ),
      "invalid_drawdown_amount",
    );
    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "uptime_outage_penalty_refund",
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
      drawdown_class: "uptime_outage_penalty_refund" as const,
      source_event_id: "outage-2026-10-03-001",
      drawn_cents: 25_000,
    };
    const first = await drawDownSoftwareAuditEscrow(store, input, T0);
    expect(first.ok).toBe(true);

    const replayed = await drawDownSoftwareAuditEscrow(store, input, T0);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.journal_id).toBeNull();

    const lines = await store.listSoftwareAuditEscrowDrawdowns(escrow.id);
    expect(lines).toHaveLength(1);
  });

  it("refuses a scope mismatch, an unknown bucket, and a draw from a settled escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: softwareAuditEscrowScopeKey("developer-other", ENDPOINT),
          drawdown_class: "uptime_outage_penalty_refund",
          source_event_id: "scope-mismatch",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );
    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: "missing",
          scope_key: SCOPE,
          drawdown_class: "uptime_outage_penalty_refund",
          source_event_id: "unknown-bucket",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_credit_not_found",
    );

    // A drawdown that consumes the LAST cent settles the escrow — and a
    // follow-up draw refuses: money never leaves a settled escrow.
    const drained = await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "api_rate_limit_breach_credit",
        source_event_id: "ratelimit-full-drain",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(drained.ok).toBe(true);
    const afterDrain = await store.getLedgerTransaction(escrow.id);
    expect(afterDrain?.status).toBe("settled");
    expectFailure(
      await drawDownSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          drawdown_class: "uptime_outage_penalty_refund",
          source_event_id: "post-settle-draw",
          drawn_cents: 100,
        },
        T0,
      ),
      "escrow_already_settled",
    );
  });
});

describe("reconcileSoftwareAuditEscrow + releaseSoftwareAuditEscrow — the verified release", () => {
  it("records the reconciliation of record insert-as-lock — the first wins, a second throws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    const recorded = await reconcileSoftwareAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "security-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(recorded.ok).toBe(true);

    let secondThrew: unknown;
    try {
      await store.insertSoftwareAuditEscrowReconciliation({
        reserve_ledger_id: escrow.id,
        evidence_ref: "security-audit-q4-2026-v2.pdf",
        reconciled_by: "compliance-desk",
      });
    } catch (error) {
      secondThrew = error;
    }
    expect(secondThrew).toBeInstanceOf(Error);
    expect(
      (await store.getSoftwareAuditEscrowReconciliation(escrow.id))?.evidence_ref,
    ).toBe("security-audit-q4-2026.pdf");
  });

  it("refuses a reconciliation with blank evidence or reconciler, and a scope mismatch", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);

    expectFailure(
      await reconcileSoftwareAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "  ",
        reconciled_by: "compliance-desk",
      }),
      "invalid_reconciliation_evidence",
    );
    expectFailure(
      await reconcileSoftwareAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "security-audit.pdf",
        reconciled_by: "",
      }),
      "invalid_reconciliation_evidence",
    );
    expectFailure(
      await reconcileSoftwareAuditEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: softwareAuditEscrowScopeKey("developer-other", ENDPOINT),
        evidence_ref: "security-audit.pdf",
        reconciled_by: "compliance-desk",
      }),
      "not_an_escrow_credit",
    );
  });

  it("refuses a release with no reconciliation of record — fail-closed, before the CAS", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "verified",
    });
    await seedVerifiedKyc(store, DEVELOPER_ID);

    expectFailure(
      await releaseSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "software_audit_escrow_reconciliation_missing",
    );
    const escrowAfter = await store.getLedgerTransaction(escrow.id);
    expect(escrowAfter?.status).toBe("software_audit_escrow");
  });

  it("releases the remaining balance to the developer only against the verified reconciliation — the gate re-resolves fail-closed at release too", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedPolicy(store, 700);

    await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "uptime_outage_penalty_refund",
        source_event_id: "outage-2026-10-03-001",
        drawn_cents: 20_000,
      },
      T0,
    );

    // The gate states fail the release while unresolved — even with a
    // reconciliation of record.
    const reconciled = await reconcileSoftwareAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "security-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(reconciled.ok).toBe(true);
    await seedVerifiedKyc(store, DEVELOPER_ID);
    expectFailure(
      await releaseSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "vertical_state_unknown",
    );

    // The verified gates open the release — the remaining 50,000 rides
    // the taxed cascade.
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "verified",
    });
    const released = await releaseSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        developer_id: DEVELOPER_ID,
        api_endpoint_id: ENDPOINT,
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
      await releaseSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_already_settled",
    );
  });

  it("refuses a release whose (developer, API endpoint) pair does not re-derive the named scope, and a fully-drawn escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store);
    await seedSoftwareGateState(store, {
      api_uptime_sla_state: "verified",
      security_audit_state: "verified",
    });
    await seedVerifiedKyc(store, DEVELOPER_ID);
    await reconcileSoftwareAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "security-audit-q4-2026.pdf",
      reconciled_by: "compliance-desk",
    });

    expectFailure(
      await releaseSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          developer_id: "developer-someone-else",
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );

    // A different API endpoint re-derives a different scope — the
    // injective identity check refuses.
    expectFailure(
      await releaseSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: "ENDPOINT-OTHER-SERVICE",
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_scope_mismatch",
    );

    // Fully drawn — nothing releases.
    const drained = await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        drawdown_class: "quarterly_security_compliance_audit",
        source_event_id: "security-audit-drain",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(drained.ok).toBe(true);
    expectFailure(
      await releaseSoftwareAuditEscrow(
        store,
        {
          reserve_ledger_id: escrow.id,
          scope_key: SCOPE,
          developer_id: DEVELOPER_ID,
          api_endpoint_id: ENDPOINT,
          operator_settlement_approved: true,
        },
        T0,
      ),
      "escrow_already_settled", // the full drawdown settled the escrow first
    );
  });
});

describe("the full software escrow lifecycle — allocations plus dust equals gross, ALWAYS", () => {
  it("routes, draws down, and releases with every bucket conserved at integer cents", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeSoftwareAuditEscrowFromPayout(
      store,
      {
        holding_ledger_id: held.id,
        developer_id: DEVELOPER_ID,
        api_endpoint_id: ENDPOINT,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    // The routing conserved the gross exactly.
    expect(
      softwareZeroBalanceHolds(
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
    await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "uptime_outage_penalty_refund",
        source_event_id: "lifecycle-outage",
        drawn_cents: 5_000,
      },
      T0,
    );
    await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "api_rate_limit_breach_credit",
        source_event_id: "lifecycle-ratelimit",
        drawn_cents: 3_000,
      },
      T0,
    );
    await drawDownSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        drawdown_class: "quarterly_security_compliance_audit",
        source_event_id: "lifecycle-security-audit",
        drawn_cents: 2_000,
      },
      T0,
    );
    await reconcileSoftwareAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: SCOPE,
      evidence_ref: "lifecycle-reconciliation.pdf",
      reconciled_by: "compliance-desk",
    });

    const released = await releaseSoftwareAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: SCOPE,
        developer_id: DEVELOPER_ID,
        api_endpoint_id: ENDPOINT,
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
    const lines = await store.listSoftwareAuditEscrowDrawdowns(escrowId);
    const totalDrawn = lines.reduce((total, line) => total + line.drawn_cents, 0);
    expect(totalDrawn + released.value.released_cents).toBe(routed.value.split.escrow_cents);
    expect(
      softwareZeroBalanceHolds(
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
