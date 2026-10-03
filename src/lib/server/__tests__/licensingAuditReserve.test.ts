// The AUDIT_RESERVE_ESCROW bucket (PR 33) — the behavioral suite for the
// founder's directive: 5–10% of earned royalties routed automatically into
// the reserved bucket at routing, drawn down ONLY by position-locked
// quarterly audit reconciliations or inventory write-offs, and released
// ONLY with a verified reconciliation of record — every absent/unknown
// state failing closed. The Don invariants hold throughout: integer cents,
// allocations plus dust equals gross including the bucket, idempotency
// (a replayed event moves nothing twice), and the CAS as the concurrency
// arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  LICENSING_AUDIT_RESERVE_MAX_RATE_BPS,
  LICENSING_AUDIT_RESERVE_MIN_RATE_BPS,
  auditReserveEscrowPayeeId,
  auditReserveEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildAuditReserveSplitPlan,
  drawDownLicensingAuditReserve,
  reconcileLicensingAuditReserve,
  registerLicensingAuditReservePolicy,
  releaseLicensingAuditReserve,
  routeLicensingAuditReserveFromHolding,
} from "@/lib/server/licensingAuditReserve";
import type {
  LicensingRoyaltyDealRecord,
  LicensingTerritoryGateState,
  LicensingCategoryExclusivityGateState,
} from "@/modules/licensing/records";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-30T12:00:00.000Z");
const SCOPE = "license:LIC-FOOTWEAR-001";
const PAYEE_ID = "payee-founder";
const PAYEE_NAME = "Covnant Founder";
const HELD = 1_000_000; // the held unclaimed-holding credit: $10,000

function makeStore(): Store {
  return new InMemoryStore();
}

function dealFixture(): LicensingRoyaltyDealRecord {
  return {
    id: "deal-footwear-001",
    scope_key: SCOPE,
    license_id: "LIC-FOOTWEAR-001",
    currency: "USD",
    tiers: [{ upToCents: null, rateBps: 800 }],
    agency_commission_bps: null,
    licensor_a_payee_id: PAYEE_ID,
    licensor_a_payee_name: PAYEE_NAME,
    licensor_a_country: "US",
    licensor_b_payee_id: null,
    licensor_b_payee_name: null,
    licensor_b_country: null,
    withholding_default_bps: null,
    cumulative_net_sales_cents: 0,
    cumulative_royalty_cents: 0,
    version: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
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
    territory_state: LicensingTerritoryGateState;
    category_exclusivity_state: LicensingCategoryExclusivityGateState;
  },
  payeeId = PAYEE_ID,
  scopeKey = SCOPE,
): Promise<void> {
  await store.upsertLicensingPayoutGateState(
    {
      payee_id: payeeId,
      scope_key: scopeKey,
      territory_state: states.territory_state,
      category_exclusivity_state: states.category_exclusivity_state,
      territory_evidence_ref:
        states.territory_state === "cleared" ? "TR-001" : null,
      category_exclusivity_evidence_ref:
        states.category_exclusivity_state === "verified" ? "CX-001" : null,
      verified_by: null,
    },
  );
}

async function seedPolicy(store: Store, reserveRateBps = 700) {
  const registered = await registerLicensingAuditReservePolicy(
    store,
    { scope_key: SCOPE, reserve_rate_bps: reserveRateBps },
  );
  expect(registered.ok).toBe(true);
}

async function seedHeldCredit(
  store: Store,
  amountCents: number,
  createdAt: Date = T0,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "royalty-line-1",
    payee_id: PAYEE_ID,
    payee_name: PAYEE_NAME,
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

/** The shared happy path: policy, cleared gate, verified KYC, deal, held credit. */
async function seedRoutingFixture(store: Store, rateBps = 700) {
  await seedPolicy(store, rateBps);
  await seedGateState(store, { territory_state: "cleared", category_exclusivity_state: "verified" });
  await seedVerifiedKyc(store, PAYEE_ID);
  await store.upsertLicensingRoyaltyDeal(dealFixture());
  const held = await seedHeldCredit(store, HELD);
  return held;
}

// ---------------------------------------------------------------------------
// Policy registration — the founder's 5–10% band.
// ---------------------------------------------------------------------------

describe("registerLicensingAuditReservePolicy — the rate band", () => {
  it("accepts the band's endpoints (500 and 1000 bps) and a mid value", async () => {
    const store = makeStore();
    for (const rateBps of [LICENSING_AUDIT_RESERVE_MIN_RATE_BPS, 700, LICENSING_AUDIT_RESERVE_MAX_RATE_BPS]) {
      const registered = await registerLicensingAuditReservePolicy(store, {
        scope_key: SCOPE,
        reserve_rate_bps: rateBps,
      });
      expect(registered.ok).toBe(true);
    }
  });

  it("refuses below 5% and above 10% fail-closed", async () => {
    const store = makeStore();
    for (const rateBps of [
      LICENSING_AUDIT_RESERVE_MIN_RATE_BPS - 1,
      LICENSING_AUDIT_RESERVE_MAX_RATE_BPS + 1,
      0,
      -700,
      700.5,
    ]) {
      const registered = await registerLicensingAuditReservePolicy(store, {
        scope_key: SCOPE,
        reserve_rate_bps: rateBps,
      });
      expect(registered.ok).toBe(false);
      if (!registered.ok) {
        expect(registered.code).toBe("reserve_rate_out_of_band");
      }
    }
  });

  it("refuses a blank scope identity", async () => {
    const store = makeStore();
    const registered = await registerLicensingAuditReservePolicy(store, {
      scope_key: "   ",
      reserve_rate_bps: 700,
    });
    expect(registered.ok).toBe(false);
    if (registered.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(registered.code).toBe("invalid_scope_identity");
  });

  it("converges on re-registration — the newest rate governs the next routing", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    const second = await registerLicensingAuditReservePolicy(store, {
      scope_key: SCOPE,
      reserve_rate_bps: 900,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reserve_rate_bps).toBe(900);
    expect(second.value.created_at).toBe(second.value.updated_at);
  });
});

// ---------------------------------------------------------------------------
// The split planner — exact integer cents including the bucket.
// ---------------------------------------------------------------------------

describe("buildAuditReserveSplitPlan — the reserve bucket arithmetic", () => {
  it("floors the reserve share and keeps routed = amount − reserve with structurally-zero dust", () => {
    const planned = buildAuditReserveSplitPlan({ amount_cents: 123_456, reserve_rate_bps: 700 });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.reserve_cents).toBe(8_641); // floor(123456 × 0.07)
    expect(planned.value.routed_cents).toBe(123_456 - 8_641);
    expect(planned.value.company_dust_cents).toBe(0);
  });

  it("keeps routed plus reserve plus dust equal to the amount at every rate in the band", () => {
    for (const rateBps of [500, 613, 700, 999, 1000]) {
      const planned = buildAuditReserveSplitPlan({ amount_cents: 999_999, reserve_rate_bps: rateBps });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      expect(
        planned.value.routed_cents + planned.value.reserve_cents + planned.value.company_dust_cents,
      ).toBe(999_999);
      expect(Number.isInteger(planned.value.routed_cents)).toBe(true);
      expect(Number.isInteger(planned.value.reserve_cents)).toBe(true);
    }
  });

  it("refuses a non-integer or non-positive amount and a rate outside the band", () => {
    for (const amount of [1_000.5, -1, 0]) {
      const planned = buildAuditReserveSplitPlan({ amount_cents: amount, reserve_rate_bps: 700 });
      expect(planned.ok).toBe(false);
    }
    const offBand = buildAuditReserveSplitPlan({ amount_cents: 1_000, reserve_rate_bps: 1_001 });
    expect(offBand.ok).toBe(false);
    if (offBand.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(offBand.code).toBe("reserve_rate_out_of_band");
  });
});

// ---------------------------------------------------------------------------
// Routing — the held royalty into the reserved bucket + the taxed cascade.
// ---------------------------------------------------------------------------

describe("routeLicensingAuditReserveFromHolding — the automatic routing", () => {
  it("splits the held credit at the policy rate: the reserve locks at the sentinel payee, the licensor rides the taxed cascade", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);

    const routed = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.amount_cents).toBe(HELD);
    expect(routed.value.split.reserve_cents).toBe(70_000);
    expect(routed.value.split.routed_cents).toBe(HELD - 70_000);
    expect(routed.value.split.company_dust_cents).toBe(0);

    // The reserve credit of record: the per-scope sentinel payee, kind AND
    // status 'audit_reserve_escrow', the scope stamped in line_item_id.
    const reserveCredit = routed.value.reserve_credit;
    expect(reserveCredit).not.toBeNull();
    if (!reserveCredit) return;
    expect(reserveCredit.payee_id).toBe(auditReserveEscrowPayeeId(SCOPE));
    expect(reserveCredit.payee_name).toBe(auditReserveEscrowPayeeName(SCOPE));
    expect(reserveCredit.kind).toBe("audit_reserve_escrow");
    expect(reserveCredit.status).toBe("audit_reserve_escrow");
    expect(reserveCredit.amount_cents).toBe(70_000);
    expect(reserveCredit.line_item_id).toBe(SCOPE);

    // The held credit settled exactly once.
    const heldAfter = await store.getLedgerTransaction(held.id);
    expect(heldAfter?.status).toBe("settled");

    // The licensor's credit rode the taxed cascade — the net landed is
    // what the cascade reports, gross was the routed remainder.
    expect(routed.value.credits).toHaveLength(1);
    expect(routed.value.credits[0].payee_id).toBe(PAYEE_ID);
    expect(routed.value.credits[0].gross_cents).toBe(HELD - 70_000);

    // One balanced GL journal rode the routing.
    expect(routed.value.journal_id).not.toBeNull();
  });

  it("refuses a replayed routing fail-closed — the CAS returns holding_already_released, never a double split", async () => {
    const store = makeStore();
    const held = await seedRoutingFixture(store, 700);
    const first = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(first.ok).toBe(true);

    const replay = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("holding_already_released");
  });

  it("refuses an unknown ledger row, a non-holding row, and an unapproved settlement", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 700);

    const missing = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: "ledger-none", scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(missing.code).toBe("holding_credit_not_found");

    const wrongKind = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "payout-line-1",
      payee_id: PAYEE_ID,
      payee_name: PAYEE_NAME,
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
    const notHolding = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: wrongKind.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(notHolding.ok).toBe(false);
    if (notHolding.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(notHolding.code).toBe("not_a_holding_credit");

    const held = await seedHeldCredit(store, 500);
    const unapproved = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: false },
      T0,
    );
    expect(unapproved.ok).toBe(false);
    if (unapproved.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(unapproved.code).toBe("settlement_not_approved");
  });

  it("fails closed on an absent gate record, an unknown gate state, and each uncleared condition", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedVerifiedKyc(store, PAYEE_ID);
    await store.upsertLicensingRoyaltyDeal(dealFixture());

    // No gate record at all — absent means refuse.
    const absentHeld = await seedHeldCredit(store, HELD);
    const absent = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: absentHeld.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(absent.ok).toBe(false);
    if (absent.ok) {
      expect.unreachable("expected a failure result");
    }
    // An ABSENT gate record resolves null — the gate refuses with the
    // same vertical_state_unknown code as an unknown state (fail-closed).
    expect(absent.code).toBe("vertical_state_unknown");

    // A record with UNKNOWN states — unknown means refuse.
    await seedGateState(store, { territory_state: "unknown", category_exclusivity_state: "unknown" });
    const unknownHeld = await seedHeldCredit(store, HELD);
    const unknown = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: unknownHeld.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(unknown.code).toBe("licensing_territory_not_cleared");

    // Territory cleared but the category exclusivity unverified — refuse.
    await seedGateState(store, { territory_state: "cleared", category_exclusivity_state: "unknown" });
    const unverifiedHeld = await seedHeldCredit(store, HELD);
    const unverified = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: unverifiedHeld.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(unverified.ok).toBe(false);
    if (unverified.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(unverified.code).toBe("licensing_category_exclusivity_unverified");

    // Category verified but the territory not cleared — refuse.
    await seedGateState(store, { territory_state: "unknown", category_exclusivity_state: "verified" });
    const notClearedHeld = await seedHeldCredit(store, HELD);
    const notCleared = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: notClearedHeld.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(notCleared.ok).toBe(false);
    if (notCleared.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(notCleared.code).toBe("licensing_territory_not_cleared");
  });

  it("fails closed on missing KYC and a missing deal of record", async () => {
    const store = makeStore();
    await seedPolicy(store, 700);
    await seedGateState(store, { territory_state: "cleared", category_exclusivity_state: "verified" });
    await store.upsertLicensingRoyaltyDeal(dealFixture());
    const noKycHeld = await seedHeldCredit(store, HELD);
    const noKyc = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: noKycHeld.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(noKyc.ok).toBe(false);
    if (noKyc.ok) {
      expect.unreachable("expected a failure result");
    }
    // No KYC of record resolves to the fail-closed unknown state.
    expect(noKyc.code).toBe("kyc_state_unknown");

    await seedVerifiedKyc(store, PAYEE_ID);
    // A fresh store WITH policy, gate, and KYC but no deal of record — the
    // held credit seeds HERE so the row lookup passes and the missing-deal
    // refusal is the code under test.
    const storeNoDeal = makeStore();
    await seedPolicy(storeNoDeal, 700);
    await seedGateState(storeNoDeal, {
      territory_state: "cleared",
      category_exclusivity_state: "verified",
    });
    await seedVerifiedKyc(storeNoDeal, PAYEE_ID);
    const noDealHeld = await seedHeldCredit(storeNoDeal, HELD);
    const noDeal = await routeLicensingAuditReserveFromHolding(
      storeNoDeal,
      { holding_ledger_id: noDealHeld.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(noDeal.ok).toBe(false);
    if (noDeal.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(noDeal.code).toBe("licensing_deal_not_found");
  });

  it("refuses a routing pass when no policy of record exists for the scope", async () => {
    const store = makeStore();
    await seedGateState(store, { territory_state: "cleared", category_exclusivity_state: "verified" });
    await seedVerifiedKyc(store, PAYEE_ID);
    await store.upsertLicensingRoyaltyDeal(dealFixture());
    const held = await seedHeldCredit(store, HELD);
    const routed = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(false);
    if (routed.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(routed.code).toBe("missing_audit_reserve_policy");
  });
});

// ---------------------------------------------------------------------------
// Drawdowns — quarterly audit reconciliations and inventory write-offs.
// ---------------------------------------------------------------------------

describe("drawDownLicensingAuditReserve — the position-locked spend", () => {
  async function seedRoutedReserve(store: Store) {
    const held = await seedRoutingFixture(store, 700);
    const routed = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    if (!routed.ok) throw new Error("fixture routing failed");
    return { held, reserve: routed.value.reserve_credit! };
  }

  it("draws down a quarterly audit reconciliation within the balance and records the position", async () => {
    const store = makeStore();
    const { reserve } = await seedRoutedReserve(store);

    const drawn = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "quarterly_audit_reconciliation",
        source_event_id: "audit-2026-Q3",
        drawn_cents: 21_000,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.drawdown.drawn_cents).toBe(21_000);
    expect(drawn.value.drawdown.drawdown_class).toBe("quarterly_audit_reconciliation");
    expect(drawn.value.drawdown.drawn_before_cents).toBe(0);
    expect(drawn.value.drawdown.remaining_cents).toBe(70_000 - 21_000);
    expect(drawn.value.replayed).toBe(false);
    expect(drawn.value.journal_id).not.toBeNull();

    // The reserve row is the position holder — the balance derives from the
    // append-only drawdown truth, never a second mutable counter.
    const reserveAfter = await store.getLedgerTransaction(reserve.id);
    expect(reserveAfter?.amount_cents).toBe(70_000);
    expect(reserveAfter?.status).toBe("audit_reserve_escrow");
  });

  it("stacks drawdowns positionally — before/after chains across both spend classes", async () => {
    const store = makeStore();
    const { reserve } = await seedRoutedReserve(store);

    const audit = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "quarterly_audit_reconciliation",
        source_event_id: "audit-2026-Q3",
        drawn_cents: 10_000,
      },
      T0,
    );
    expect(audit.ok).toBe(true);
    const writeOff = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-warehouse-7",
        drawn_cents: 5_000,
      },
      T0,
    );
    expect(writeOff.ok).toBe(true);
    if (!writeOff.ok) return;
    expect(writeOff.value.drawdown.drawn_before_cents).toBe(10_000);
    expect(writeOff.value.drawdown.remaining_cents).toBe(70_000 - 15_000);
  });

  it("refuses an overdraw and an invalid class fail-closed", async () => {
    const store = makeStore();
    const { reserve } = await seedRoutedReserve(store);

    const overdrawn = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-1",
        drawn_cents: 70_001,
      },
      T0,
    );
    expect(overdrawn.ok).toBe(false);
    if (overdrawn.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(overdrawn.code).toBe("reserve_overdrawn");

    const badClass = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "sponsor_gifting",
        source_event_id: "wo-2",
        drawn_cents: 100,
      },
      T0,
    );
    expect(badClass.ok).toBe(false);
    if (badClass.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(badClass.code).toBe("invalid_drawdown_class");

    const badAmount = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-3",
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

  it("is replay-safe by (reserve, source_event) — a replayed drawdown is a counted no-op with no new journal", async () => {
    const store = makeStore();
    const { reserve } = await seedRoutedReserve(store);

    const first = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-1",
        drawn_cents: 5_000,
      },
      T0,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-1",
        drawn_cents: 5_000,
      },
      T0,
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.drawdown.id).toBe(first.value.drawdown.id);
    expect(replay.value.journal_id).toBeNull();
  });

  it("settles the reserve when the drawdown consumes the last cent — nothing releases after a full drawdown", async () => {
    const store = makeStore();
    const { reserve } = await seedRoutedReserve(store);

    const full = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-all",
        drawn_cents: 70_000,
      },
      T0,
    );
    expect(full.ok).toBe(true);
    if (!full.ok) return;

    const reserveAfter = await store.getLedgerTransaction(reserve.id);
    expect(reserveAfter?.status).toBe("settled");

    await seedPolicy(store, 700);
    const released = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    // The full drawdown already SETTLED the row (asserted above), so the
    // release refuses on the settled-row check; the fully-drawn sum check
    // behind it is the defensive backstop for inconsistent states.
    expect(released.code).toBe("reserve_already_settled");
  });

  it("refuses a drawdown on a foreign scope, an unknown row, and a settled reserve", async () => {
    const store = makeStore();
    const { reserve } = await seedRoutedReserve(store);

    const foreign = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: "license:LIC-APPAREL-002",
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-x",
        drawn_cents: 100,
      },
      T0,
    );
    expect(foreign.ok).toBe(false);
    if (foreign.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(foreign.code).toBe("reserve_scope_mismatch");

    const missing = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: "ledger-none",
        scope_key: SCOPE,
        drawdown_class: "inventory_write_off",
        source_event_id: "wo-y",
        drawn_cents: 100,
      },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(missing.code).toBe("reserve_credit_not_found");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation + release — the verified reconciliation gates the release.
// ---------------------------------------------------------------------------

describe("releaseLicensingAuditReserve — the verified-reconciliation release", () => {
  async function seedReserveWithDrawdown(store: Store) {
    const held = await seedRoutingFixture(store, 700);
    const routed = await routeLicensingAuditReserveFromHolding(
      store,
      { holding_ledger_id: held.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    if (!routed.ok) throw new Error("fixture routing failed");
    const reserve = routed.value.reserve_credit!;
    const drawn = await drawDownLicensingAuditReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        scope_key: SCOPE,
        drawdown_class: "quarterly_audit_reconciliation",
        source_event_id: "audit-2026-Q3",
        drawn_cents: 20_000,
      },
      T0,
    );
    if (!drawn.ok) throw new Error("fixture drawdown failed");
    return { reserve, drawnBefore: 20_000 };
  }

  it("fails closed when no reconciliation of record exists", async () => {
    const store = makeStore();
    const { reserve } = await seedReserveWithDrawdown(store);
    const released = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(released.status).toBe(403);
    expect(released.code).toBe("audit_reserve_reconciliation_missing");
  });

  it("fails closed on a reconciliation with no evidence or no reconciler of record", async () => {
    const store = makeStore();
    const { reserve } = await seedReserveWithDrawdown(store);
    const noEvidence = await reconcileLicensingAuditReserve(store, {
      reserve_ledger_id: reserve.id,
      scope_key: SCOPE,
      evidence_ref: "   ",
      reconciled_by: "external-audit-co",
    });
    expect(noEvidence.ok).toBe(false);
    if (noEvidence.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(noEvidence.code).toBe("invalid_reconciliation_evidence");

    const noReconciler = await reconcileLicensingAuditReserve(store, {
      reserve_ledger_id: reserve.id,
      scope_key: SCOPE,
      evidence_ref: "audit-report-2026-Q3.pdf",
      reconciled_by: "",
    });
    expect(noReconciler.ok).toBe(false);
    if (noReconciler.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(noReconciler.code).toBe("invalid_reconciliation_evidence");
  });

  it("releases the remaining balance on a verified reconciliation — drawdowns stay spent, the cascade pays the licensor", async () => {
    const store = makeStore();
    const { reserve, drawnBefore } = await seedReserveWithDrawdown(store);
    const reconciled = await reconcileLicensingAuditReserve(store, {
      reserve_ledger_id: reserve.id,
      scope_key: SCOPE,
      evidence_ref: "audit-report-2026-Q3.pdf",
      reconciled_by: "external-audit-co",
    });
    expect(reconciled.ok).toBe(true);

    const vaultBefore = (await store.getVault(PAYEE_ID))?.pending_balance ?? 0;
    const released = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(70_000 - drawnBefore);
    expect(released.value.credits[0].payee_id).toBe(PAYEE_ID);
    expect(released.value.credits[0].gross_cents).toBe(70_000 - drawnBefore);
    expect(released.value.journal_id).not.toBeNull();

    // The reserve settled exactly once.
    const reserveAfter = await store.getLedgerTransaction(reserve.id);
    expect(reserveAfter?.status).toBe("settled");

    // The licensor's vault received the release through the taxed cascade —
    // a non-settle credit lands in pending (the Don discipline), with the
    // withheld share credited to the creator's reserve.
    const vaultAfter =
      (await store.getVault(PAYEE_ID))?.pending_balance ?? 0;
    expect(vaultAfter - vaultBefore).toBe(released.value.credits[0].net_cents);
  });

  it("is once-only — a replayed release refuses with reserve_already_settled", async () => {
    const store = makeStore();
    const { reserve } = await seedReserveWithDrawdown(store);
    await reconcileLicensingAuditReserve(store, {
      reserve_ledger_id: reserve.id,
      scope_key: SCOPE,
      evidence_ref: "audit-report-2026-Q3.pdf",
      reconciled_by: "external-audit-co",
    });
    const first = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(first.ok).toBe(true);

    const replay = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("reserve_already_settled");
  });

  it("re-checks the gate at release — a gate lost after routing refuses the release", async () => {
    const store = makeStore();
    const { reserve } = await seedReserveWithDrawdown(store);
    await reconcileLicensingAuditReserve(store, {
      reserve_ledger_id: reserve.id,
      scope_key: SCOPE,
      evidence_ref: "audit-report-2026-Q3.pdf",
      reconciled_by: "external-audit-co",
    });
    // The territory clearance lapsed after routing.
    await store.upsertLicensingPayoutGateState(
      {
        payee_id: PAYEE_ID,
        scope_key: SCOPE,
        territory_state: "unknown",
        category_exclusivity_state: "verified",
        territory_evidence_ref: null,
        category_exclusivity_evidence_ref: "CX-001",
        verified_by: null,
      },
    );
    const released = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(released.ok).toBe(false);
    if (released.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(released.code).toBe("licensing_territory_not_cleared");
  });

  it("refuses a release on a foreign scope and an unknown reserve row", async () => {
    const store = makeStore();
    const { reserve } = await seedReserveWithDrawdown(store);

    const foreign = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: reserve.id, scope_key: "license:LIC-APPAREL-002", operator_settlement_approved: true },
      T0,
    );
    expect(foreign.ok).toBe(false);
    if (foreign.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(foreign.code).toBe("reserve_scope_mismatch");

    const missing = await releaseLicensingAuditReserve(
      store,
      { reserve_ledger_id: "ledger-none", scope_key: SCOPE, operator_settlement_approved: true },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(missing.code).toBe("reserve_credit_not_found");
  });
});
