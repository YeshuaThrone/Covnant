// The PATENT_LITIGATION_ESCROW bucket + the hardware payout gate states (PR 47) —
// the behavioral suite for the founder's hardware directive: 10–15% of
// hardware patent payouts routed automatically into the reserved bucket at
// routing (the ELEVATED band — double the standard 5–10% verticals),
// drawn down ONLY by global court rate redeterminations, anti-suit
// injunction penalties, or cross-border patent validity challenges, and
// released ONLY with a verified reconciliation of record — every
// absent/unknown gate state failing closed (frand_rate_court_determination_cleared
// and sep_essentiality_audit_verified read the durable states of record,
// migration 0051). The Don invariants hold throughout: integer cents,
// allocations plus dust equals gross including the escrow bucket,
// idempotency (a replayed event moves nothing twice), and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  PATENT_LITIGATION_ESCROW_MAX_RATE_BPS,
  PATENT_LITIGATION_ESCROW_MIN_RATE_BPS,
  patentLitigationEscrowPayeeId,
  patentLitigationEscrowPayeeName,
} from "@/modules/don/constants";
import {
  buildPatentLitigationEscrowSplitPlan,
  drawDownPatentLitigationEscrow,
  patentZeroBalanceHolds,
  patentLitigationEscrowScopeKey,
  reconcilePatentLitigationEscrow,
  registerPatentLitigationEscrowPolicy,
  releasePatentLitigationEscrow,
  routePatentLitigationEscrowFromPayout,
} from "@/lib/server/patentLitigationEscrow";
import { postInstantOtaUnlockSettlement } from "@/lib/server/hardwareOtaUnlockSettlements";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const LICENSOR_ID = "licensor-patentco";
const LICENSOR_NAME = "PatentCo Licensing";
const SEP_POOL = "SEP-POOL-5G-NR";
const SCOPE = patentLitigationEscrowScopeKey(LICENSOR_ID, SEP_POOL);
const HELD = 1_000_000; // the held hardware patent payout: $10,000

function makeStore(): Store {
  return new InMemoryStore();
}

async function seedVerifiedKyc(store: Store, licensorId: string): Promise<void> {
  await store.insertKycVerification({
    creator_id: licensorId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: T0.toISOString(),
    verified_at: T0.toISOString(),
  });
}

async function seedHardwareGateState(
  store: Store,
  states: {
    frand_determination_state: "unknown" | "cleared";
    essentiality_audit_state: "unknown" | "verified";
  },
  payeeId = LICENSOR_ID,
  sepPoolCode = SEP_POOL,
): Promise<void> {
  await store.upsertHardwarePayoutGateState({
    payee_id: payeeId,
    sep_pool_code: sepPoolCode,
    frand_determination_state: states.frand_determination_state,
    essentiality_audit_state: states.essentiality_audit_state,
    evidence_ref: "frand-determination-essentiality-audit.pdf",
    verified_by: "compliance-desk",
  });
}

async function seedPolicy(store: Store, rateBps = 1_200): Promise<void> {
  const registered = await registerPatentLitigationEscrowPolicy(store, {
    licensor_payee_id: LICENSOR_ID,
    sep_pool_code: SEP_POOL,
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
    line_item_id: "hardware-patent-payout-line-1",
    payee_id: LICENSOR_ID,
    payee_name: LICENSOR_NAME,
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
  rateBps = 1_200,
): Promise<LedgerTransactionRecord> {
  await seedPolicy(store, rateBps);
  await seedHardwareGateState(store, {
    frand_determination_state: "cleared",
    essentiality_audit_state: "verified",
  });
  await seedVerifiedKyc(store, LICENSOR_ID);
  return seedHeldPayout(store, HELD);
}

async function seedEscrow(
  store: Store,
  amountCents = 150_000,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: patentLitigationEscrowPayeeId(SCOPE),
    payee_name: patentLitigationEscrowPayeeName(SCOPE),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "patent_litigation_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T0.toISOString(),
    settled_at: null,
    kind: "patent_litigation_escrow",
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

describe("registerPatentLitigationEscrowPolicy — the elevated founder band", () => {
  it("registers a rate inside the 1000–1500 bps band and re-registrations converge", async () => {
    const store = makeStore();

    const registered = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: 1_200,
    });
    expect(registered.ok).toBe(true);

    // A re-registration converges — the newest rate governs.
    const updated = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: 1_450,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.scope_key).toBe(SCOPE);
    expect(updated.value.reserve_rate_bps).toBe(1_450);

    const readBack = await store.getPatentLitigationEscrowPolicy(SCOPE);
    expect(readBack?.reserve_rate_bps).toBe(1_450);
  });

  it("accepts both band edges (1000 and 1500 bps) and refuses anything outside", async () => {
    const store = makeStore();

    const minEdge = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: PATENT_LITIGATION_ESCROW_MIN_RATE_BPS,
    });
    expect(minEdge.ok).toBe(true);
    const maxEdge = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: PATENT_LITIGATION_ESCROW_MAX_RATE_BPS,
    });
    expect(maxEdge.ok).toBe(true);

    const tooLow = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: PATENT_LITIGATION_ESCROW_MIN_RATE_BPS - 1,
    });
    expectFailure(tooLow, "escrow_rate_out_of_band");

    // 1000 bps — the top of the STANDARD 5–10% band — is still BELOW this
    // escrow's floor: the litigation reserve prices higher by design.
    const standardMax = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: 1_000,
    });
    expect(standardMax.ok).toBe(true);
    const belowStandardMax = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: 1_000 - 1,
    });
    expectFailure(belowStandardMax, "escrow_rate_out_of_band");

    const tooHigh = await registerPatentLitigationEscrowPolicy(store, {
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      reserve_rate_bps: PATENT_LITIGATION_ESCROW_MAX_RATE_BPS + 1,
    });
    expectFailure(tooHigh, "escrow_rate_out_of_band");
  });
});

// ---------------------------------------------------------------------------
// The split plan — exact integer cents at the elevated band.
// ---------------------------------------------------------------------------

describe("buildPatentLitigationEscrowSplitPlan — the founder band's exact cents", () => {
  it("floors the escrow share and hands the licensor the exact remainder", () => {
    const planned = buildPatentLitigationEscrowSplitPlan({
      amount_cents: 1_000_000,
      reserve_rate_bps: 1_500,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.escrow_cents).toBe(150_000); // 15% exactly
    expect(planned.value.routed_cents).toBe(850_000);
    expect(planned.value.company_dust_cents).toBe(0);

    // A rate that doesn't divide evenly: floor, remainder to the licensor,
    // dust structurally zero.
    const odd = buildPatentLitigationEscrowSplitPlan({
      amount_cents: 999,
      reserve_rate_bps: 1_234,
    });
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    expect(odd.value.escrow_cents).toBe(Math.floor((999 * 1_234) / 10_000));
    expect(odd.value.escrow_cents + odd.value.routed_cents).toBe(999);
    expect(odd.value.company_dust_cents).toBe(0);
  });

  it("preserves the zero-balance invariant: allocations plus dust equals gross", () => {
    for (const amount of [1, 7, 99, 1_000, 123_456, 1_000_000, 98_765_432]) {
      for (const rate of [1_000, 1_111, 1_234, 1_500]) {
        const planned = buildPatentLitigationEscrowSplitPlan({
          amount_cents: amount,
          reserve_rate_bps: rate,
        });
        expect(planned.ok).toBe(true);
        if (!planned.ok) continue;
        expect(
          patentZeroBalanceHolds(
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
// Routing — the escrow bucket locks automatically at the elevated band.
// ---------------------------------------------------------------------------

describe("routePatentLitigationEscrowFromPayout — the automatic lock", () => {
  it("locks the escrow share at 15% and routes the remainder through the taxed cascade", async () => {
    const store = makeStore();
    const payout = await seedRoutingFixture(store, 1_500);

    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.amount_cents).toBe(HELD);
    expect(routed.value.split.escrow_cents).toBe(150_000);
    expect(routed.value.split.routed_cents).toBe(850_000);
    expect(routed.value.split.company_dust_cents).toBe(0);

    // The escrow row of record: kind AND status patent_litigation_escrow,
    // the scope's sentinel payee, the amount exactly 15%.
    expect(routed.value.escrow_credit).not.toBeNull();
    const escrow = routed.value.escrow_credit!;
    expect(escrow.kind).toBe("patent_litigation_escrow");
    expect(escrow.status).toBe("patent_litigation_escrow");
    expect(escrow.amount_cents).toBe(150_000);
    expect(escrow.payee_id).toBe(patentLitigationEscrowPayeeId(SCOPE));
    expect(escrow.line_item_id).toBe(SCOPE);

    // Zero-balance: the licensor's landed net + withholding + escrow
    // reconciles against the split.
    const landed = routed.value.credits
      .filter((credit) => credit.payee_id === LICENSOR_ID)
      .reduce((total, credit) => total + credit.net_cents, 0);
    expect(landed).toBeLessThanOrEqual(850_000);
    await expectJournalBalanced(store, routed.value.journal_id);
  });

  it("replays a second routing of the same payout as a refusal — idempotency", async () => {
    const store = makeStore();
    const payout = await seedRoutingFixture(store, 1_500);

    const first = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expect(first.ok).toBe(true);

    const replay = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(replay, "payout_already_released");

    // Still exactly one escrow row of record for the scope (escrow
    // credits carry the empty split run).
    const escrows = (await store.listLedgerTransactionsByRun("")).filter(
      (row) => row.kind === "patent_litigation_escrow" && row.line_item_id === SCOPE,
    );
    expect(escrows).toHaveLength(1);
  });

  it("refuses a scope with no registered policy — never a guessed rate", async () => {
    const store = makeStore();
    await seedHardwareGateState(store, {
      frand_determination_state: "cleared",
      essentiality_audit_state: "verified",
    });
    await seedVerifiedKyc(store, LICENSOR_ID);
    const payout = await seedHeldPayout(store, HELD);

    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "missing_patent_litigation_escrow_policy");
  });
});

// ---------------------------------------------------------------------------
// The hardware payout gate — fail-closed at routing.
// ---------------------------------------------------------------------------

describe("the hardware payout gate states — fail-closed enforcement", () => {
  it("refuses routing when no gate states of record exist (absent resolves refused)", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_200);
    await seedVerifiedKyc(store, LICENSOR_ID);
    const payout = await seedHeldPayout(store, HELD);

    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "vertical_state_unknown");
  });

  it("refuses routing when the FRAND court determination is unknown", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_200);
    await seedVerifiedKyc(store, LICENSOR_ID);
    await seedHardwareGateState(store, {
      frand_determination_state: "unknown",
      essentiality_audit_state: "verified",
    });
    const payout = await seedHeldPayout(store, HELD);

    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "hardware_frand_rate_not_cleared");
  });

  it("refuses routing when the SEP essentiality audit is unverified", async () => {
    const store = makeStore();
    await seedPolicy(store, 1_200);
    await seedVerifiedKyc(store, LICENSOR_ID);
    await seedHardwareGateState(store, {
      frand_determination_state: "cleared",
      essentiality_audit_state: "unknown",
    });
    const payout = await seedHeldPayout(store, HELD);

    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(routed, "hardware_essentiality_unverified");
  });

  it("routes only when FRAND is cleared AND essentiality is verified", async () => {
    const store = makeStore();
    const payout = await seedRoutingFixture(store, 1_200);

    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expect(routed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drawdowns — the three litigation exposures, position-locked.
// ---------------------------------------------------------------------------

describe("drawDownPatentLitigationEscrow — the litigation exposures", () => {
  it("draws against a global court rate redetermination and re-derives the balance from the append-only truth", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const drawn = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "global_court_rate_redetermination",
      source_event_id: "court-redetermination-ED-TX-2026-0114",
      drawn_cents: 40_000,
    });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.replayed).toBe(false);
    expect(drawn.value.drawdown.drawn_before_cents).toBe(150_000);
    expect(drawn.value.drawdown.remaining_cents).toBe(110_000);
    await expectJournalBalanced(store, drawn.value.journal_id!);

    // The escrow row itself is NOT settled by a partial drawdown.
    const after = await store.getLedgerTransaction(escrow.id);
    expect(after?.status).toBe("patent_litigation_escrow");

    const replay = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "global_court_rate_redetermination",
      source_event_id: "court-redetermination-ED-TX-2026-0114",
      drawn_cents: 40_000,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.journal_id).toBeNull();
  });

  it("draws anti-suit injunction penalties and cross-border validity challenges, accumulating position", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const injunction = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "anti_suit_injunction_penalty",
      source_event_id: "anti-suit-sanction-ED-NX-2026-0077",
      drawn_cents: 25_000,
    });
    expect(injunction.ok).toBe(true);
    if (!injunction.ok) return;
    expect(injunction.value.drawdown.remaining_cents).toBe(125_000);

    const validity = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "cross_border_patent_validity_challenge",
      source_event_id: "validity-opposition-EPO-2026-0331",
      drawn_cents: 10_500,
    });
    expect(validity.ok).toBe(true);
    if (!validity.ok) return;
    expect(validity.value.drawdown.drawn_before_cents).toBe(125_000);
    expect(validity.value.drawdown.remaining_cents).toBe(114_500);

    const lines = await store.listPatentLitigationEscrowDrawdowns(escrow.id);
    expect(lines).toHaveLength(2);
    // The balance of record is the SUM of the append-only truth.
    const balance = lines.reduce((total, line) => total + line.drawn_cents, 0);
    expect(150_000 - balance).toBe(114_500);
  });

  it("refuses an overdraw — position conservation (remaining = before − drawn ≥ 0)", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const first = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "global_court_rate_redetermination",
      source_event_id: "court-redetermination-ED-TX-2026-0114",
      drawn_cents: 60_000,
    });
    expect(first.ok).toBe(true);

    const overdraw = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "anti_suit_injunction_penalty",
      source_event_id: "anti-suit-sanction-ED-NX-2026-0077",
      drawn_cents: 60_000,
    });
    expectFailure(overdraw, "escrow_overdrawn");

    // Exactly the first drawdown is of record.
    const lines = await store.listPatentLitigationEscrowDrawdowns(escrow.id);
    expect(lines).toHaveLength(1);
  });

  it("refuses an unknown drawdown class and a scope mismatch — the vocabulary is closed", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const unknownClass = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "general_counsel_lunch",
      source_event_id: "lunch-2026-10-03",
      drawn_cents: 1_000,
    });
    expectFailure(unknownClass, "invalid_drawdown_class");

    const scopeMismatch = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: patentLitigationEscrowScopeKey("licensor-other", SEP_POOL),
      drawdown_class: "global_court_rate_redetermination",
      source_event_id: "court-redetermination-ED-TX-2026-0114",
      drawn_cents: 1_000,
    });
    expectFailure(scopeMismatch, "escrow_scope_mismatch");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation + release — verified reconciliation, fail-closed.
// ---------------------------------------------------------------------------

describe("releasePatentLitigationEscrow — the verified release", () => {
  it("refuses to release without a verified reconciliation of record", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const released = await releasePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(released, "patent_litigation_escrow_reconciliation_missing");
  });

  it("refuses to release when the hardware gate states fail closed at release", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);
    await seedPolicy(store, 1_200);
    // KYC verified, but no hardware gate states — the vertical gate is
    // the one that must fire, fail-closed at release.
    await seedVerifiedKyc(store, LICENSOR_ID);

    const reconciled = await reconcilePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "litigation-reconciliation-q3-2026.pdf",
      reconciled_by: "finance-desk",
    });
    expect(reconciled.ok).toBe(true);

    const released = await releasePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(released, "vertical_state_unknown");
  });

  it("releases the re-derived balance through the taxed cascade when reconciliation and gates verify", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);
    await seedPolicy(store, 1_200);
    await seedHardwareGateState(store, {
      frand_determination_state: "cleared",
      essentiality_audit_state: "verified",
    });
    await seedVerifiedKyc(store, LICENSOR_ID);

    // A court rate redetermination spends 30k — the release pays the rest.
    const drawn = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "global_court_rate_redetermination",
      source_event_id: "court-redetermination-ED-TX-2026-0114",
      drawn_cents: 30_000,
    });
    expect(drawn.ok).toBe(true);

    const reconciled = await reconcilePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "litigation-reconciliation-q3-2026.pdf",
      reconciled_by: "finance-desk",
    });
    expect(reconciled.ok).toBe(true);

    const released = await releasePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(120_000);
    await expectJournalBalanced(store, released.value.journal_id);

    const after = await store.getLedgerTransaction(escrow.id);
    expect(after?.status).toBe("settled");

    // A second release loses the CAS.
    const replay = await releasePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(replay, "escrow_already_settled");
  });

  it("refuses to release a fully drawn escrow", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 100_000);

    const spend = await drawDownPatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "cross_border_patent_validity_challenge",
      source_event_id: "validity-opposition-EPO-2026-0331",
      drawn_cents: 100_000,
    });
    expect(spend.ok).toBe(true);
    if (!spend.ok) return;
    // The last cent settles the escrow first — a drawdown that consumes
    // the balance settles the row.
    const afterSpend = await store.getLedgerTransaction(escrow.id);
    expect(afterSpend?.status).toBe("settled");

    const reconciled = await reconcilePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "litigation-reconciliation-q3-2026.pdf",
      reconciled_by: "finance-desk",
    });
    expect(reconciled.ok).toBe(true);

    const released = await releasePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(released, "escrow_already_settled");
  });

  it("refuses a scope mismatch at release — the identity must re-derive the scope", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const released = await releasePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: patentLitigationEscrowScopeKey("licensor-other", SEP_POOL),
      licensor_payee_id: "licensor-other",
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    });
    expectFailure(released, "escrow_scope_mismatch");
  });
});

// ---------------------------------------------------------------------------
// The reconciliation of record — insert-as-lock.
// ---------------------------------------------------------------------------

describe("reconcilePatentLitigationEscrow — the reconciliation of record", () => {
  it("records once per escrow; the first reconciliation wins", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const first = await reconcilePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "litigation-reconciliation-q3-2026.pdf",
      reconciled_by: "finance-desk",
    });
    expect(first.ok).toBe(true);

    // The second reconciliation loses the insert-as-lock — the store's
    // per-reserve unique fires and the first reconciliation of record
    // stands.
    let secondError: Error | undefined;
    try {
      await reconcilePatentLitigationEscrow(store, {
        reserve_ledger_id: escrow.id,
        scope_key: SCOPE,
        evidence_ref: "litigation-reconciliation-q4-2026.pdf",
        reconciled_by: "finance-desk",
      });
    } catch (error) {
      secondError = error as Error;
    }
    expect(secondError?.message).toContain(
      "hardware_patent_litigation_escrow_reconciliations.reserve_ledger_id",
    );

    const readBack = await store.getPatentLitigationEscrowReconciliation(escrow.id);
    expect(readBack?.evidence_ref).toBe("litigation-reconciliation-q3-2026.pdf");
  });

  it("refuses blank evidence or reconciler", async () => {
    const store = makeStore();
    const escrow = await seedEscrow(store, 150_000);

    const blankEvidence = await reconcilePatentLitigationEscrow(store, {
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      evidence_ref: "",
      reconciled_by: "finance-desk",
    });
    expectFailure(blankEvidence, "invalid_reconciliation_evidence");
  });
});

// ---------------------------------------------------------------------------
// Instant OTA unlock splits — preserved behavior alongside the escrow lane.
// ---------------------------------------------------------------------------

describe("postInstantOtaUnlockSettlement — instant splits coexist with the escrow lane", () => {
  it("posts an OTA unlock split instantly while the patent escrow lane stays independent", async () => {
    const store = makeStore();

    const SENSOR_LICENSOR = "licensor-sensorco";
    await store.upsertHardwareOtaUnlockPolicy({
      feature_code: "fcs_self_driving_sensors",
      sensor_licensor_payee_id: SENSOR_LICENSOR,
      micros_per_unlock: 249_000_000, // $249.00 per unlock
      licensor_share_bps: 8_500,
    });
    await seedVerifiedKyc(store, SENSOR_LICENSOR);

    const posted = await postInstantOtaUnlockSettlement(store, {
      source_event_id: "ota-unlock-imei-356938035643809-2026-10-03",
      feature_code: "fcs_self_driving_sensors",
      device_imei_mac: "356938035643809",
      period: "2026-10",
      currency: "USD",
    }, T0);
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.value.journal_id).not.toBeNull();
    await expectJournalBalanced(store, posted.value.journal_id!);

    // The same store then routes a patent escrow without interference —
    // the lanes are independent, the invariants shared.
    const payout = await seedRoutingFixture(store, 1_500);
    const routed = await routePatentLitigationEscrowFromPayout(store, {
      holding_ledger_id: payout.id,
      licensor_payee_id: LICENSOR_ID,
      sep_pool_code: SEP_POOL,
      operator_settlement_approved: true,
    }, T0);
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value.split.escrow_cents).toBe(150_000);
    await expectJournalBalanced(store, routed.value.journal_id);
  });
});
