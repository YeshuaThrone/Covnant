// The EVENT_CANCELLATION_ESCROW bucket + the sports payout gate states (PR
// 51, the founder sports directive) — the behavioral suite: 15–20% of net
// gate receipts routed automatically into the reserved bucket at payout
// (the founder's ELEVATED band, double the standard verticals' floor),
// drawn down ONLY by weather delays, athlete withdrawals, or mandatory
// ticket refund calls, and released ONLY with verified event completion
// telemetry of record AND 48 elapsed hours post-event — every absent or
// unknown gate state failing closed (event_completion_telemetry_verified,
// promoter_insurance_clearance, and the collegiate NIL waterfall's
// nil_compliance_audit_cleared all read the durable states of record,
// migration 0055). The Don invariants hold throughout: integer cents,
// allocations plus dust equals gross including the escrow bucket,
// idempotency (a replayed event moves nothing twice), and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS,
  EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS,
  eventCancellationEscrowPayeeId,
} from "@/modules/don/constants";
import { eventCancellationEscrowScopeKey } from "@/modules/sports/records";
import {
  buildEventCancellationEscrowSplitPlan,
  drawDownEventCancellationEscrow,
  eventZeroBalanceHolds,
  registerEventCancellationEscrowPolicy,
  releaseEventCancellationEscrow,
  routeEventCancellationEscrowFromGateReceipts,
} from "@/lib/server/eventCancellationEscrow";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const PROMOTER = "promoter-galaxies-fc";
const EVENT = "homecoming-2026";
const SCOPE = eventCancellationEscrowScopeKey(PROMOTER, EVENT);
const GATE = 1_000_000; // the held gate receipts: $10,000

function makeStore(): Store {
  return new InMemoryStore();
}

async function seedVerifiedKyc(store: Store, payeeId: string): Promise<void> {
  await store.insertKycVerification({
    creator_id: payeeId,
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
    event_completion_telemetry_state: "unknown" | "verified";
    promoter_insurance_state: "unknown" | "cleared";
    is_collegiate_nil_waterfall?: boolean;
    nil_compliance_audit_state?: "unknown" | "cleared";
  },
  completedAt: string | null = null,
  payeeId = PROMOTER,
  eventRef = EVENT,
): Promise<void> {
  await store.upsertSportsPayoutGateState({
    payee_id: payeeId,
    event_ref: eventRef,
    event_completion_telemetry_state: states.event_completion_telemetry_state,
    promoter_insurance_state: states.promoter_insurance_state,
    is_collegiate_nil_waterfall: states.is_collegiate_nil_waterfall ?? false,
    nil_compliance_audit_state: states.nil_compliance_audit_state ?? "unknown",
    event_completed_at: completedAt,
    evidence_ref: "event-completion-telemetry.json",
    verified_by: "sports-ops-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 1_500): Promise<void> {
  const registered = await registerEventCancellationEscrowPolicy(store, {
    promoter_payee_id: PROMOTER,
    event_ref: EVENT,
    reserve_rate_bps: rateBps,
  });
  expect(registered.ok).toBe(true);
}

async function seedHeldGateReceipts(
  store: Store,
  amountCents: number,
  createdAt: Date = T0,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "gate-receipts-line-1",
    payee_id: PROMOTER,
    payee_name: "Galaxies FC Promotions",
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

/** The shared happy path: policy, cleared gates, verified KYC, held receipts. */
async function seedRoutingFixture(
  store: Store,
  rateBps = 1_500,
): Promise<LedgerTransactionRecord> {
  await seedPolicy(store, rateBps);
  await seedVerifiedKyc(store, PROMOTER);
  return seedHeldGateReceipts(store, GATE);
}

async function seedEscrow(
  store: Store,
  amountCents = 200_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: eventCancellationEscrowPayeeId(SCOPE),
    payee_name: `EVENT_CANCELLATION_ESCROW — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "event_cancellation_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "event_cancellation_escrow",
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

/** A journal's legs must balance to the cent. */
async function expectJournalBalanced(
  store: Store,
  journalId: string,
): Promise<void> {
  const entries = await store.listGlEntriesByJournal(journalId);
  expect(entries.length).toBeGreaterThan(0);
  const debits = entries.reduce((total, entry) => total + entry.debit_cents, 0);
  const credits = entries.reduce((total, entry) => total + entry.credit_cents, 0);
  expect(debits).toBe(credits);
  expect(debits).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// The rate band — registration.
// ---------------------------------------------------------------------------

describe("registerEventCancellationEscrowPolicy — the founder band", () => {
  it("registers a rate inside the 1500–2000 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerEventCancellationEscrowPolicy(store, {
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      reserve_rate_bps: 1_750,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerEventCancellationEscrowPolicy(store, {
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      reserve_rate_bps: 2_000,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(2_000);

    const readBack = await store.getEventCancellationEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(2_000);
  });

  it("accepts both band edges (1500 and 2000 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerEventCancellationEscrowPolicy(store, {
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      reserve_rate_bps: EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);
    const maxEdge = await registerEventCancellationEscrowPolicy(store, {
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      reserve_rate_bps: EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS,
    });
    expect(maxEdge.ok).toBe(true);

    // A standard-vertical rate (500–1500) is BELOW the elevated band —
    // the sports escrow prices higher, by the founder's directive.
    const tooLow = await registerEventCancellationEscrowPolicy(store, {
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      reserve_rate_bps: EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(tooLow, "escrow_rate_out_of_band");

    const tooHigh = await registerEventCancellationEscrowPolicy(store, {
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      reserve_rate_bps: EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(tooHigh, "escrow_rate_out_of_band");
  });
});

// ---------------------------------------------------------------------------
// The split plan — exact integer cents at the elevated band.
// ---------------------------------------------------------------------------

describe("buildEventCancellationEscrowSplitPlan — the founder band's exact cents", () => {
  it("floors the escrow share and hands the promoter the exact remainder", () => {
    const planned = buildEventCancellationEscrowSplitPlan({
      amount_cents: 1_000_000,
      reserve_rate_bps: 1_500,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(150_000); // 15% exactly
    expect(planned.value.routed_cents).toBe(850_000);
    expect(planned.value.company_dust_cents).toBe(0);

    // A rate that doesn't divide evenly: floor, remainder to the promoter,
    // dust structurally zero.
    const odd = buildEventCancellationEscrowSplitPlan({
      amount_cents: 999,
      reserve_rate_bps: 1_733,
    });
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    expect(odd.value.escrow_cents).toBe(Math.floor((999 * 1_733) / 10_000));
    expect(odd.value.escrow_cents + odd.value.routed_cents).toBe(999);
    expect(odd.value.company_dust_cents).toBe(0);
  });

  it("preserves the zero-balance invariant: allocations plus dust equals gross", () => {
    for (const amount of [1, 7, 99, 1_000, 123_456, 1_000_000, 98_765_432]) {
      for (const rate of [1_500, 1_733, 1_999, 2_000]) {
        const planned = buildEventCancellationEscrowSplitPlan({
          amount_cents: amount,
          reserve_rate_bps: rate,
        });
        expect(planned.ok).toBe(true);
        if (!planned.ok) continue;
        expect(
          eventZeroBalanceHolds(
            amount,
            [
              { amount_cents: planned.value.escrow_cents },
              { amount_cents: planned.value.routed_cents },
            ],
            planned.value.company_dust_cents,
          ),
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Routing — the escrow bucket locks automatically at the founder band.
// ---------------------------------------------------------------------------

describe("routeEventCancellationEscrowFromGateReceipts — the automatic lock", () => {
  it("locks the escrow share at 15% and routes the remainder through the taxed cascade", async () => {
    const store = makeStore();
    const receipts = await seedRoutingFixture(store, 1_500);
    await seedGateState(store, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
    });

    const routed = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    // The escrow locked 150_000 of 1_000_000; the promoter's remainder
    // rode the cascade; the journal balanced.
    expect(routed.value.split).toEqual({
      amount_cents: 1_000_000,
      escrow_cents: 150_000,
      routed_cents: 850_000,
      company_dust_cents: 0,
    });
    expect(routed.value.escrow_credit?.kind).toBe("event_cancellation_escrow");
    expect(routed.value.escrow_credit?.status).toBe("event_cancellation_escrow");
    expect(routed.value.escrow_credit?.payee_id).toBe(
      eventCancellationEscrowPayeeId(SCOPE),
    );
    expect(routed.value.escrow_credit?.amount_cents).toBe(150_000);
    expect(routed.value.payout_credit.status).toBe("settled");
    await expectJournalBalanced(store, routed.value.journal_id);

    // The promoter's remainder landed as a settled credit through the
    // taxed cascade — gross minus the escrow lock, every withheld and
    // recouped portion accounted inside the house legs.
    const promoterNet = routed.value.credits.find(
      (credit) => credit.payee_id === PROMOTER,
    );
    expect(promoterNet?.gross_cents).toBe(850_000);
    expect(promoterNet?.net_cents).toBeGreaterThan(0);
    expect(promoterNet?.net_cents).toBeLessThanOrEqual(850_000);
  });

  it("locks the escrow share at 20% — the band's ceiling", async () => {
    const store = makeStore();
    const receipts = await seedRoutingFixture(store, 2_000);
    await seedGateState(store, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
    });

    const routed = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(200_000);
    expect(routed.value.split.routed_cents).toBe(800_000);
    await expectJournalBalanced(store, routed.value.journal_id);
  });

  it("refuses a routing with no registered policy — the terms' only source", async () => {
    const store = makeStore();
    const receipts = await seedHeldGateReceipts(store, GATE);
    await seedGateState(store, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
    });

    const routed = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "missing_event_cancellation_escrow_policy");
  });

  it("fails closed on an ABSENT gate record — no states of record, no routing", async () => {
    const store = makeStore();
    await seedRoutingFixture(store, 1_500);
    const receipts = await seedHeldGateReceipts(store, GATE);

    const routed = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "vertical_state_unknown");
  });

  it("fails closed on an 'unknown' insurance clearance — while telemetry-unknown still routes (the pre-event lock)", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedVerifiedKyc(store, PROMOTER);
    await seedGateState(store, {
      event_completion_telemetry_state: "verified",
      promoter_insurance_state: "unknown",
    });
    const receipts = await seedHeldGateReceipts(store, GATE);

    const refused = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(refused, "sports_insurance_not_cleared");

    // Telemetry-unknown is NOT a routing refusal by itself: the escrow
    // locks at payout time, before any completion telemetry can exist
    // (the lock is itself the protection). Only the absence of the whole
    // record — and the insurance/NIL conditions — refuses. This routing
    // must SUCCEED.
    const store2 = makeStore();
    await seedPolicy(store2, 1_500);
    await seedVerifiedKyc(store2, PROMOTER);
    await seedGateState(store2, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
    });
    const receipts2 = await seedHeldGateReceipts(store2, GATE);
    // Wait — telemetry-unknown is NOT a routing refusal by itself: the
    // escrow locks at payout time, before any completion exists. Only
    // the absence of the whole record (and insurance/NIL conditions)
    // refuses. This routing must SUCCEED.
    const routed2 = await routeEventCancellationEscrowFromGateReceipts(store2, {
      holding_ledger_id: receipts2.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expect(routed2.ok).toBe(true);
  });

  it("refuses the collegiate NIL waterfall while its compliance audit is uncleared", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedVerifiedKyc(store, PROMOTER);
    await seedGateState(store, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
      is_collegiate_nil_waterfall: true,
      nil_compliance_audit_state: "unknown",
    });
    const receipts = await seedHeldGateReceipts(store, GATE);

    const refused = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(refused, "sports_nil_audit_not_cleared");

    // Clearing the gender-equity + university-association disclosure
    // audit of record reopens the routing.
    const store2 = makeStore();
    await seedPolicy(store2, 1_500);
    await seedVerifiedKyc(store2, PROMOTER);
    await seedGateState(store2, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
      is_collegiate_nil_waterfall: true,
      nil_compliance_audit_state: "cleared",
    });
    const receipts2 = await seedHeldGateReceipts(store2, GATE);
    const routed = await routeEventCancellationEscrowFromGateReceipts(store2, {
      holding_ledger_id: receipts2.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
  });

  it("is idempotent BY HELD CREDIT — a replayed routing moves nothing twice", async () => {
    const store = makeStore();
    const receipts = await seedRoutingFixture(store, 1_500);
    await seedGateState(store, {
      event_completion_telemetry_state: "unknown",
      promoter_insurance_state: "cleared",
    });

    const first = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expect(first.ok).toBe(true);

    const journalsBefore = await store.listGlJournals();
    const escrowRowsBefore = (
      await store.listLedgerTransactionsByLineItem(SCOPE)
    ).filter((row) => row.kind === "event_cancellation_escrow").length;

    const replay = await routeEventCancellationEscrowFromGateReceipts(store, {
      holding_ledger_id: receipts.id,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(replay, "payout_already_released");

    const journalsAfter = await store.listGlJournals();
    const escrowRowsAfter = (
      await store.listLedgerTransactionsByLineItem(SCOPE)
    ).filter((row) => row.kind === "event_cancellation_escrow").length;
    expect(journalsAfter.length).toBe(journalsBefore.length);
    expect(escrowRowsAfter).toBe(escrowRowsBefore);
  });
});

// ---------------------------------------------------------------------------
// Drawdowns — weather delays, athlete withdrawals, and ticket refund calls
// spend the escrow.
// ---------------------------------------------------------------------------

describe("drawDownEventCancellationEscrow — weather, withdrawal, and refund-call spends", () => {
  it("draws each cancellation class with position-locked conservation", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 200_000);

    const weather = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "weather_delay",
      source_event_id: "weather-delay-week-1",
      drawn_cents: 80_000,
    });
    expect(weather.ok).toBe(true);
    if (weather.ok) {
      expect(weather.value.drawdown.drawn_before_cents).toBe(200_000);
      expect(weather.value.drawdown.remaining_cents).toBe(120_000);
      expect(weather.value.replayed).toBe(false);
    }

    const withdrawal = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "athlete_withdrawal",
      source_event_id: "headliner-withdrawal",
      drawn_cents: 30_000,
    });
    expect(withdrawal.ok).toBe(true);
    if (withdrawal.ok) {
      expect(withdrawal.value.drawdown.drawn_before_cents).toBe(120_000);
      expect(withdrawal.value.drawdown.remaining_cents).toBe(90_000);
    }

    const refundCall = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "mandatory-refund-order-1",
      drawn_cents: 10_000,
    });
    expect(refundCall.ok).toBe(true);
    if (refundCall.ok) {
      expect(refundCall.value.drawdown.drawn_before_cents).toBe(90_000);
      expect(refundCall.value.drawdown.remaining_cents).toBe(80_000);
    }

    // The append-only truth derives the balance — no mutable counter.
    const drawdowns = await store.listEventCancellationEscrowDrawdowns(escrow.id);
    const drawn = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
    expect(drawn).toBe(120_000);

    // Every spend journaled balanced.
    await expectJournalBalanced(store, weather.value.journal_id as string);
    await expectJournalBalanced(store, refundCall.value.journal_id as string);
  });

  it("replays a re-shipped cancellation event as a counted no-op", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 200_000);

    const first = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "mandatory-refund-order-1",
      drawn_cents: 10_000,
    });
    expect(first.ok).toBe(true);

    const replay = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "mandatory-refund-order-1",
      drawn_cents: 10_000,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.drawdown.drawn_cents).toBe(10_000);
    }

    const drawdowns = await store.listEventCancellationEscrowDrawdowns(escrow.id);
    expect(drawdowns.length).toBe(1);
  });

  it("refuses overdraws, invalid classes, scope mismatches, and zero draws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const overdrawn = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "weather_delay",
      source_event_id: "overdraw-attempt",
      drawn_cents: 100_001,
    });
    expectFailure(overdrawn, "escrow_overdrawn");

    // A resource-vertical class is not a sports cancellation class.
    const invalidClass = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "commodity_price_reconciliation",
      source_event_id: "wrong-lane-class",
      drawn_cents: 1_000,
    });
    expectFailure(invalidClass, "invalid_drawdown_class");

    const scopeMismatch = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: eventCancellationEscrowScopeKey("promoter-other", EVENT),
      drawdown_class: "weather_delay",
      source_event_id: "wrong-scope",
      drawn_cents: 1_000,
    });
    expectFailure(scopeMismatch, "escrow_scope_mismatch");

    const zeroAmount = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "weather_delay",
      source_event_id: "zero-draw",
      drawn_cents: 0,
    });
    expectFailure(zeroAmount, "invalid_drawdown_amount");
  });

  it("a drawdown that consumes the LAST cent settles the escrow — nothing releases after", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const finalDraw = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "full-drain",
      drawn_cents: 100_000,
    });
    expect(finalDraw.ok).toBe(true);

    const readBack = await store.getLedgerTransaction(escrow.id);
    expect(readBack?.status).toBe("settled");

    // The CAS holds after the full drain: a later drawdown refuses.
    const afterDrain = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "weather_delay",
      source_event_id: "post-drain",
      drawn_cents: 1,
    });
    expectFailure(afterDrain, "escrow_already_settled");
  });

  it("is NOT gated by the sports payout gate — the protective spend pays in exactly the scenarios the gate refuses", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 200_000);
    // NO gate state of record exists at all, and the telemetry could never
    // verify for a weather-postponed event — the drawdown still pays.
    const weather = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "weather_delay",
      source_event_id: "hurricane-postponement",
      drawn_cents: 50_000,
    });
    expect(weather.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Release — verified completion telemetry AND the elapsed 48-hour window.
// ---------------------------------------------------------------------------

describe("releaseEventCancellationEscrow — the timed, verified release", () => {
  const COMPLETED = new Date("2026-10-03T12:00:00.000Z");
  const BEFORE_48H = new Date(COMPLETED.getTime() + 47 * 60 * 60 * 1000);
  const AT_48H = new Date(COMPLETED.getTime() + 48 * 60 * 60 * 1000);

  it("refuses without ANY gate record — fail-closed", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    const escrow = await seedEscrow(store, 200_000);

    const released = await releaseEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(released, "event_completion_telemetry_unverified");
  });

  it("refuses an 'unknown' telemetry state — fail-closed", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedGateState(
      store,
      {
        event_completion_telemetry_state: "unknown",
        promoter_insurance_state: "cleared",
      },
      null,
    );
    const escrow = await seedEscrow(store, 200_000);

    const released = await releaseEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(released, "event_completion_telemetry_unverified");
  });

  it("refuses a verified telemetry whose completion clock never landed", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    // A verified telemetry state that carries no completion timestamp —
    // defense-in-depth beyond the 0055 CHECK (which forbids this row in
    // Postgres): the engine still refuses — the 48-hour window cannot be
    // established (refuse, never guess).
    await store.upsertSportsPayoutGateState({
      payee_id: PROMOTER,
      event_ref: EVENT,
      event_completion_telemetry_state: "verified",
      promoter_insurance_state: "cleared",
      is_collegiate_nil_waterfall: false,
      nil_compliance_audit_state: "unknown",
      event_completed_at: null,
      evidence_ref: "event-completion-telemetry.json",
      verified_by: "sports-ops-desk",
    });
    const escrow = await seedEscrow(store, 200_000);

    const released = await releaseEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      promoter_payee_id: PROMOTER,
      event_ref: EVENT,
      operator_settlement_approved: true,
    });
    expectFailure(released, "event_completion_time_unknown");
  });

  it("refuses inside the 48-hour post-event window and opens at exactly 48 hours", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedVerifiedKyc(store, PROMOTER);
    await seedGateState(
      store,
      {
        event_completion_telemetry_state: "verified",
        promoter_insurance_state: "cleared",
      },
      COMPLETED.toISOString(),
    );
    const escrow = await seedEscrow(store, 200_000);

    const tooEarly = await releaseEventCancellationEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        promoter_payee_id: PROMOTER,
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      BEFORE_48H,
    );
    expectFailure(tooEarly, "event_cancellation_release_window_open");

    // Exactly 48 hours later: the window opens.
    const released = await releaseEventCancellationEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        promoter_payee_id: PROMOTER,
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      AT_48H,
    );
    expect(released.ok).toBe(true);
  });

  it("releases the remaining balance after verified telemetry + 48 hours — drawdowns stay spent", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedVerifiedKyc(store, PROMOTER);
    await seedGateState(
      store,
      {
        event_completion_telemetry_state: "verified",
        promoter_insurance_state: "cleared",
      },
      COMPLETED.toISOString(),
    );
    const escrow = await seedEscrow(store, 200_000);

    // The mandatory refund call spends 70_000 first.
    await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "mandatory-refund-order-1",
      drawn_cents: 70_000,
    });

    const released = await releaseEventCancellationEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        promoter_payee_id: PROMOTER,
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      AT_48H,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // Only what the cancellation exposure protected releases:
    // 200_000 − 70_000.
    expect(released.value.released_cents).toBe(130_000);
    expect(released.value.escrow_credit.status).toBe("settled");
    await expectJournalBalanced(store, released.value.journal_id);

    // The promoter's net landed through the taxed cascade.
    const promoterNet = released.value.credits.find(
      (credit) => credit.payee_id === PROMOTER,
    );
    expect(promoterNet?.gross_cents).toBe(130_000);
    expect(promoterNet?.net_cents).toBeGreaterThan(0);

    // The escrow is settled — the CAS holds against a second release and
    // against any later drawdown.
    const replayed = await releaseEventCancellationEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        promoter_payee_id: PROMOTER,
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      AT_48H,
    );
    expectFailure(replayed, "escrow_already_settled");
    const lateDraw = await drawDownEventCancellationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "weather_delay",
      source_event_id: "post-release",
      drawn_cents: 1,
    });
    expectFailure(lateDraw, "escrow_already_settled");
  });

  it("fails closed at release on an unknown insurance clearance and on a collegiate NIL audit refusal", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedVerifiedKyc(store, PROMOTER);
    await seedGateState(
      store,
      {
        event_completion_telemetry_state: "verified",
        promoter_insurance_state: "unknown",
      },
      COMPLETED.toISOString(),
    );
    const escrow = await seedEscrow(store, 200_000);

    const refused = await releaseEventCancellationEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        promoter_payee_id: PROMOTER,
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      AT_48H,
    );
    expectFailure(refused, "sports_insurance_not_cleared");

    // The NIL refusal refuses the release independently.
    const store2 = makeStore();
    await seedPolicy(store2, 1_500);
    await seedVerifiedKyc(store2, PROMOTER);
    await seedGateState(
      store2,
      {
        event_completion_telemetry_state: "verified",
        promoter_insurance_state: "cleared",
        is_collegiate_nil_waterfall: true,
        nil_compliance_audit_state: "unknown",
      },
      COMPLETED.toISOString(),
    );
    const escrow2 = await seedEscrow(store2, 200_000);
    const refused2 = await releaseEventCancellationEscrow(
      store2,
      {
        reserve_ledger_id: escrow2.id,
        scope_key: SCOPE,
        promoter_payee_id: PROMOTER,
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      AT_48H,
    );
    expectFailure(refused2, "sports_nil_audit_not_cleared");
  });

  it("refuses a release whose identity does not re-derive the scope", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_500);
    await seedGateState(
      store,
      {
        event_completion_telemetry_state: "verified",
        promoter_insurance_state: "cleared",
      },
      COMPLETED.toISOString(),
    );
    const escrow = await seedEscrow(store, 200_000);

    const mismatched = await releaseEventCancellationEscrow(
      store,
      {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        promoter_payee_id: "promoter-other",
        event_ref: EVENT,
        operator_settlement_approved: true,
      },
      AT_48H,
    );
    expectFailure(mismatched, "escrow_scope_mismatch");
  });
});
