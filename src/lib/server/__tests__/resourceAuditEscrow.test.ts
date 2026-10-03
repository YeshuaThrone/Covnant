// The RESOURCE_AUDIT_ESCROW bucket + the resource payout gate states (PR 49,
// the founder resource directive) — the behavioral suite: 5–15% of resource
// payouts routed automatically into the reserved bucket at routing, drawn
// down ONLY by monthly commodity price reconciliations, pipeline variance
// audits, or environmental regulatory compliance checks, and released ONLY
// with a verified reconciliation of record — every absent/unknown gate
// state failing closed (environmental_compliance_cleared and
// title_ownership_verification_passed read the durable states of record,
// migration 0053). The Don invariants hold throughout: integer cents,
// allocations plus dust equals gross including the escrow bucket,
// idempotency (a replayed event moves nothing twice), and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  RESOURCE_AUDIT_ESCROW_MAX_RATE_BPS,
  RESOURCE_AUDIT_ESCROW_MIN_RATE_BPS,
  resourceAuditEscrowPayeeId,
} from "@/modules/don/constants";
import { resourceAuditEscrowScopeKey } from "@/modules/energy/records";
import {
  buildResourceAuditEscrowSplitPlan,
  drawDownResourceAuditEscrow,
  reconcileResourceAuditEscrow,
  registerResourceAuditEscrowPolicy,
  releaseResourceAuditEscrow,
  resourceZeroBalanceHolds,
  routeResourceAuditEscrowFromPayout,
} from "@/lib/server/resourceAuditEscrow";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const OWNER_ID = "rancher-whitacre";
const OWNER_NAME = "Whitacre Mineral Co";
const PARCEL = "TRACT-49-RESOURCE";
const SCOPE = resourceAuditEscrowScopeKey(OWNER_ID, PARCEL);
const HELD = 1_000_000; // the held resource payout: $10,000

function makeStore(): Store {
  return new InMemoryStore();
}

async function seedVerifiedKyc(store: Store, ownerId: string): Promise<void> {
  await store.insertKycVerification({
    creator_id: ownerId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: T0.toISOString(),
    verified_at: T0.toISOString(),
  });
}

async function seedResourceGateState(
  store: Store,
  states: {
    environmental_compliance_state: "unknown" | "cleared";
    title_ownership_state: "unknown" | "verified";
  },
  payeeId = OWNER_ID,
  parcelId = PARCEL,
): Promise<void> {
  await store.upsertResourcePayoutGateState({
    payee_id: payeeId,
    parcel_id: parcelId,
    environmental_compliance_state: states.environmental_compliance_state,
    title_ownership_state: states.title_ownership_state,
    evidence_ref: "environmental-title-audit.pdf",
    verified_by: "compliance-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 800): Promise<void> {
  const registered = await registerResourceAuditEscrowPolicy(store, {
    owner_payee_id: OWNER_ID,
    parcel_id: PARCEL,
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
    line_item_id: "resource-payout-line-1",
    payee_id: OWNER_ID,
    payee_name: OWNER_NAME,
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

/** The shared happy path: policy, cleared gates, verified KYC, held payout. */
async function seedRoutingFixture(
  store: Store,
  rateBps = 800,
): Promise<LedgerTransactionRecord> {
  await seedPolicy(store, rateBps);
  await seedResourceGateState(store, {
    environmental_compliance_state: "cleared",
    title_ownership_state: "verified",
  });
  await seedVerifiedKyc(store, OWNER_ID);
  return seedHeldPayout(store, HELD);
}

async function seedEscrow(
  store: Store,
  amountCents = 150_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: resourceAuditEscrowPayeeId(SCOPE),
    payee_name: `RESOURCE_AUDIT_ESCROW — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "resource_audit_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "resource_audit_escrow",
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

describe("registerResourceAuditEscrowPolicy — the founder band", () => {
  it("registers a rate inside the 500–1500 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerResourceAuditEscrowPolicy(store, {
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      reserve_rate_bps: 800,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerResourceAuditEscrowPolicy(store, {
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      reserve_rate_bps: 1_250,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(1_250);

    const readBack = await store.getResourceAuditEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(1_250);
  });

  it("accepts both band edges (500 and 1500 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerResourceAuditEscrowPolicy(store, {
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      reserve_rate_bps: RESOURCE_AUDIT_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);
    const maxEdge = await registerResourceAuditEscrowPolicy(store, {
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      reserve_rate_bps: RESOURCE_AUDIT_ESCROW_MAX_RATE_BPS,
    });
    expect(maxEdge.ok).toBe(true);

    const tooLow = await registerResourceAuditEscrowPolicy(store, {
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      reserve_rate_bps: RESOURCE_AUDIT_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(tooLow, "escrow_rate_out_of_band");

    const tooHigh = await registerResourceAuditEscrowPolicy(store, {
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      reserve_rate_bps: RESOURCE_AUDIT_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(tooHigh, "escrow_rate_out_of_band");
  });
});

// ---------------------------------------------------------------------------
// The split plan — exact integer cents at the founder band.
// ---------------------------------------------------------------------------

describe("buildResourceAuditEscrowSplitPlan — the founder band's exact cents", () => {
  it("floors the escrow share and hands the owner the exact remainder", () => {
    const planned = buildResourceAuditEscrowSplitPlan({
      amount_cents: 1_000_000,
      reserve_rate_bps: 1_500,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(150_000); // 15% exactly
    expect(planned.value.routed_cents).toBe(850_000);
    expect(planned.value.company_dust_cents).toBe(0);

    // A rate that doesn't divide evenly: floor, remainder to the owner,
    // dust structurally zero.
    const odd = buildResourceAuditEscrowSplitPlan({
      amount_cents: 999,
      reserve_rate_bps: 731,
    });
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    expect(odd.value.escrow_cents).toBe(Math.floor((999 * 731) / 10_000));
    expect(odd.value.escrow_cents + odd.value.routed_cents).toBe(999);
    expect(odd.value.company_dust_cents).toBe(0);
  });

  it("preserves the zero-balance invariant: allocations plus dust equals gross", () => {
    for (const amount of [1, 7, 99, 1_000, 123_456, 1_000_000, 98_765_432]) {
      for (const rate of [500, 731, 999, 1_200, 1_500]) {
        const planned = buildResourceAuditEscrowSplitPlan({
          amount_cents: amount,
          reserve_rate_bps: rate,
        });
        expect(planned.ok).toBe(true);
        if (!planned.ok) continue;
        expect(
          resourceZeroBalanceHolds(
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

describe("routeResourceAuditEscrowFromPayout — the automatic lock", () => {
  it("locks the escrow share at 15% and routes the remainder through the taxed cascade", async () => {
    const store = makeStore();
    const payout = await seedRoutingFixture(store, 1_500);

    const routed = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    // The escrow locked 150_000 of 1_000_000; the owner's remainder rode
    // the cascade; the journal balanced.
    expect(routed.value.split).toEqual({
      amount_cents: 1_000_000,
      escrow_cents: 150_000,
      routed_cents: 850_000,
      company_dust_cents: 0,
    });
    expect(routed.value.escrow_credit?.kind).toBe("resource_audit_escrow");
    expect(routed.value.escrow_credit?.status).toBe("resource_audit_escrow");
    expect(routed.value.escrow_credit?.amount_cents).toBe(150_000);
    expect(routed.value.payout_credit.status).toBe("settled");
    await expectJournalBalanced(store, routed.value.journal_id);

    // The owner's remainder landed as a settled credit through the taxed
    // cascade — gross minus the escrow lock, every withheld and recouped
    // portion accounted inside the house legs.
    const ownerNet = routed.value.credits.find(
      (credit) => credit.payee_id === OWNER_ID,
    );
    expect(ownerNet?.gross_cents).toBe(850_000);
    expect(ownerNet?.net_cents).toBeGreaterThan(0);
    expect(ownerNet?.net_cents).toBeLessThanOrEqual(850_000);
  });

  it("locks the escrow share at 5% — the band's floor", async () => {
    const store = makeStore();
    const payout = await seedRoutingFixture(store, 500);

    const routed = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(50_000);
    expect(routed.value.split.routed_cents).toBe(950_000);
    await expectJournalBalanced(store, routed.value.journal_id);
  });

  it("refuses a routing with no registered policy — the terms' only source", async () => {
    const store = makeStore();
    const payout = await seedHeldPayout(store, HELD);

    const routed = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "missing_resource_audit_escrow_policy");
  });

  it("fails closed on an ABSENT gate record — no states of record, no routing", async () => {
    const store = makeStore();
    await seedPolicy(store, 800);
    await seedVerifiedKyc(store, OWNER_ID);
    const payout = await seedHeldPayout(store, HELD);

    const routed = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "vertical_state_unknown");
  });

  it("fails closed on an 'unknown' environmental state and on an unverified title", async () => {
    const store = makeStore();
    await seedPolicy(store, 800);
    await seedVerifiedKyc(store, OWNER_ID);
    await seedResourceGateState(store, {
      environmental_compliance_state: "unknown",
      title_ownership_state: "verified",
    });
    const payout = await seedHeldPayout(store, HELD);

    const refused = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(refused, "resource_environmental_not_cleared");

    // Title fails closed independently.
    const store2 = makeStore();
    await seedPolicy(store2, 800);
    await seedVerifiedKyc(store2, OWNER_ID);
    await seedResourceGateState(store2, {
      environmental_compliance_state: "cleared",
      title_ownership_state: "unknown",
    });
    const payout2 = await seedHeldPayout(store2, HELD);
    const refused2 = await routeResourceAuditEscrowFromPayout(store2, {
      holding_ledger_id: payout2.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(refused2, "resource_title_unverified");
  });

  it("is idempotent BY HELD CREDIT — a replayed routing moves nothing twice", async () => {
    const store = makeStore();
    const payout = await seedRoutingFixture(store, 1_500);

    const first = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expect(first.ok).toBe(true);

    const journalsBefore = await store.listGlJournals();
    const escrowRowsBefore = (
      await store.listLedgerTransactionsByLineItem(SCOPE)
    ).filter((row) => row.kind === "resource_audit_escrow").length;

    const replay = await routeResourceAuditEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(replay, "payout_already_released");

    const journalsAfter = await store.listGlJournals();
    const escrowRowsAfter = (
      await store.listLedgerTransactionsByLineItem(SCOPE)
    ).filter((row) => row.kind === "resource_audit_escrow").length;
    expect(journalsAfter.length).toBe(journalsBefore.length);
    expect(escrowRowsAfter).toBe(escrowRowsBefore);
  });
});

// ---------------------------------------------------------------------------
// Drawdowns — the three audit classes spend the escrow.
// ---------------------------------------------------------------------------

describe("drawDownResourceAuditEscrow — commodity, pipeline-variance, and compliance spends", () => {
  it("draws each audit class with position-locked conservation", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const commodity = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "commodity_price_reconciliation",
      source_event_id: "commodity-recon-2026-10",
      drawn_cents: 60_000,
    });
    expect(commodity.ok).toBe(true);
    if (commodity.ok) {
      expect(commodity.value.drawdown.drawn_before_cents).toBe(150_000);
      expect(commodity.value.drawdown.remaining_cents).toBe(90_000);
      expect(commodity.value.replayed).toBe(false);
    }

    const pipeline = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "pipeline_variance_audit",
      source_event_id: "pipeline-variance-q4",
      drawn_cents: 25_000,
    });
    expect(pipeline.ok).toBe(true);
    if (pipeline.ok) {
      expect(pipeline.value.drawdown.drawn_before_cents).toBe(90_000);
      expect(pipeline.value.drawdown.remaining_cents).toBe(65_000);
    }

    const compliance = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "environmental_compliance_check",
      source_event_id: "environmental-check-q4",
      drawn_cents: 5_000,
    });
    expect(compliance.ok).toBe(true);
    if (compliance.ok) {
      expect(compliance.value.drawdown.drawn_before_cents).toBe(65_000);
      expect(compliance.value.drawdown.remaining_cents).toBe(60_000);
    }

    // The append-only truth derives the balance — no mutable counter.
    const drawdowns = await store.listResourceAuditEscrowDrawdowns(escrow.id);
    const drawn = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
    expect(drawn).toBe(90_000);
  });

  it("replays a re-shipped audit event as a counted no-op", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const first = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "commodity_price_reconciliation",
      source_event_id: "commodity-recon-2026-10",
      drawn_cents: 60_000,
    });
    expect(first.ok).toBe(true);

    const replay = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "commodity_price_reconciliation",
      source_event_id: "commodity-recon-2026-10",
      drawn_cents: 60_000,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.drawdown.drawn_cents).toBe(60_000);
    }

    const drawdowns = await store.listResourceAuditEscrowDrawdowns(escrow.id);
    expect(drawdowns.length).toBe(1);
  });

  it("refuses overdraws, invalid classes, scope mismatches, and zero draws", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const overdrawn = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "pipeline_variance_audit",
      source_event_id: "overdraw-attempt",
      drawn_cents: 100_001,
    });
    expectFailure(overdrawn, "escrow_overdrawn");

    const invalidClass = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "patent_litigation_redetermination",
      source_event_id: "wrong-lane-class",
      drawn_cents: 1_000,
    });
    expectFailure(invalidClass, "invalid_drawdown_class");

    const scopeMismatch = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: resourceAuditEscrowScopeKey("rancher-other", PARCEL),
      drawdown_class: "pipeline_variance_audit",
      source_event_id: "wrong-scope",
      drawn_cents: 1_000,
    });
    expectFailure(scopeMismatch, "escrow_scope_mismatch");

    const zeroAmount = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "pipeline_variance_audit",
      source_event_id: "zero-draw",
      drawn_cents: 0,
    });
    expectFailure(zeroAmount, "invalid_drawdown_amount");
  });

  it("a drawdown that consumes the LAST cent settles the escrow — nothing releases after", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const finalDraw = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "commodity_price_reconciliation",
      source_event_id: "full-drain",
      drawn_cents: 100_000,
    });
    expect(finalDraw.ok).toBe(true);

    const readBack = await store.getLedgerTransaction(escrow.id);
    expect(readBack?.status).toBe("settled");

    // The CAS holds after the full drain: a later drawdown refuses.
    const afterDrain = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "pipeline_variance_audit",
      source_event_id: "post-drain",
      drawn_cents: 1,
    });
    expectFailure(afterDrain, "escrow_already_settled");
  });
});

// ---------------------------------------------------------------------------
// Release — the verified reconciliation of record is the gate's key.
// ---------------------------------------------------------------------------

describe("releaseResourceAuditEscrow — the verified release", () => {
  it("refuses without a verified reconciliation — fail-closed", async () => {
    const store = makeStore();
    await seedPolicy(store, 800);
    await seedResourceGateState(store, {
      environmental_compliance_state: "cleared",
      title_ownership_state: "verified",
    });
    await seedVerifiedKyc(store, OWNER_ID);
    const escrow = await seedEscrow(store, 150_000);

    const released = await releaseResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(released, "resource_audit_escrow_reconciliation_missing");
  });

  it("releases the remaining balance through the taxed cascade after a verified reconciliation — drawdowns stay spent", async () => {
    const store = makeStore();
    await seedPolicy(store, 800);
    await seedResourceGateState(store, {
      environmental_compliance_state: "cleared",
      title_ownership_state: "verified",
    });
    await seedVerifiedKyc(store, OWNER_ID);
    const escrow = await seedEscrow(store, 150_000);

    // The commodity reconciliation spends 60_000 first.
    await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "commodity_price_reconciliation",
      source_event_id: "commodity-recon-2026-10",
      drawn_cents: 60_000,
    });

    // The verified reconciliation of record lands.
    const reconciled = await reconcileResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "commodity-recon-report.pdf",
      reconciled_by: "finance-desk",
    });
    expect(reconciled.ok).toBe(true);

    const released = await releaseResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // Only what the audit exposure protected releases: 150_000 − 60_000.
    expect(released.value.released_cents).toBe(90_000);
    expect(released.value.escrow_credit.status).toBe("settled");
    await expectJournalBalanced(store, released.value.journal_id);

    // The owner's net landed through the taxed cascade.
    const ownerNet = released.value.credits.find(
      (credit) => credit.payee_id === OWNER_ID,
    );
    expect(ownerNet?.gross_cents).toBe(90_000);
    expect(ownerNet?.net_cents).toBeGreaterThan(0);

    // The escrow is settled — the CAS holds against a second release and
    // against any later drawdown.
    const replayed = await releaseResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      owner_payee_id: OWNER_ID,
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(replayed, "escrow_already_settled");
    const lateDraw = await drawDownResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "pipeline_variance_audit",
      source_event_id: "post-release",
      drawn_cents: 1,
    });
    expectFailure(lateDraw, "escrow_already_settled");
  });

  it("refuses a release whose identity does not re-derive the scope", async () => {
    const store = makeStore();
    await seedPolicy(store, 800);
    const escrow = await seedEscrow(store, 150_000);
    await reconcileResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "commodity-recon-report.pdf",
      reconciled_by: "finance-desk",
    });

    const mismatched = await releaseResourceAuditEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      owner_payee_id: "rancher-other",
      parcel_id: PARCEL,
      operator_settlement_approved: true,
    });
    expectFailure(mismatched, "escrow_scope_mismatch");
  });
});
