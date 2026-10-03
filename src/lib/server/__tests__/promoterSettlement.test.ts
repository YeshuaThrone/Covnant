// Promoter box office settlement escrow + venue hall fees + comedy audio
// rights isolation + Grand Rights routing (PR 31) — the in-memory battery.
//
// Locked invariants under test, per the founder touring/comedy
// settlement-protection directive: money received for a tour stop's box
// office net LOCKS in PROMOTER_BOX_OFFICE_SETTLEMENT_PENDING (out of every
// payee vault, out of the stop's payout designations, out of the unclaimed
// holding bucket) until the FINAL night-of-show audit closes and the close
// of record verifies; the release reads the SAME fail-closed payout
// compliance gate as a Lithic dispatch on the THEATER vertical —
// grand_rights_cleared AND venue_settlement_reconciled, fail-closed when
// absent or unknown; the 15–25% venue hall fee deducts from gross merch
// sales BEFORE the artist's apparel net releases, and an unregistered
// policy never guesses a rate; a comedy special's AUDIO royalty posts under
// its own rights stream — SiriusXM/Spotify money isolated in payee, GL
// account, and ledger kind from the physical live ticket sales streams;
// Grand Rights route STRICTLY through the specialized theatrical
// publishers, never through standard PRO small-rights pools (ASCAP, BMI);
// allocations + dust equals gross INCLUDING the escrow bucket; integer
// cents throughout; per-source post idempotency; the settle CAS guards
// concurrency.

import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  computeVenueHallFeeSplit,
  grandRightsRoute,
  lockPromoterBoxOfficeSettlement,
  parsePromoterSettlementPayeeId,
  postComedyAudioRightsRoyalty,
  recordPromoterSettlementAuditClose,
  registerVenueHallFeePolicy,
  releasePromoterBoxOfficeSettlement,
  resolveMerchHallFeeSplit,
} from "@/lib/server/promoterSettlement";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  COMEDY_AUDIO_SENDERS,
  comedyAudioRightsGlAccount,
  comedyAudioRightsPayeeId,
  comedyAudioRightsPayeeName,
  promoterSettlementGlAccount,
  promoterSettlementPayeeId,
  promoterSettlementPayeeName,
  promoterSettlementScope,
  VENUE_HALL_FEE_MAX_BPS,
  VENUE_HALL_FEE_MIN_BPS,
} from "@/modules/don/constants";
import { THEATRICAL_PUBLISHERS } from "@/modules/don/records";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-09-30T12:00:00Z");
const LATER = new Date("2026-09-30T12:01:00Z");
const PRODUCTION = "prod-tour-2026";
const VENUE = "venue-keg";
const SHOW_DATE = "2026-10-15";
const SPECIAL = "special-midnight-set";

type Failure = { ok: false; status: number; code: string; message: string };
type Success<V> = { ok: true; value: V };

function mustSucceed<V>(result: Success<V> | Failure): V {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.status} ${result.code}: ${result.message}`,
    );
  }
  return result.value;
}

function mustFail<V>(
  result: Success<V> | Failure,
  status: number,
  code: string,
): Failure {
  if (result.ok) {
    throw new Error(`expected ${status} ${code} but the call succeeded`);
  }
  expect(result.status).toBe(status);
  expect(result.code).toBe(code);
  return result;
}

async function seedVault(
  store: Store,
  payeeId: string,
  payeeName: string,
): Promise<void> {
  await store.upsertVault({
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
}

/** A KYC-verified creator with a verified tax profile — no withholding. */
async function seedVerifiedCreator(
  store: Store,
  creatorId: string,
  creatorName: string,
): Promise<void> {
  await seedVault(store, creatorId, creatorName);
  await store.insertKycVerification({
    creator_id: creatorId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: creatorId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
}

/**
 * The theater vertical's gate states of record for one payee × production —
 * the durable facts the release's fallback resolver reads (migration 0035).
 */
async function seedTheatricalGateStates(
  store: Store,
  payeeId: string,
  grandRightsState: "unknown" | "cleared",
  venueSettlementState: "unknown" | "reconciled",
): Promise<void> {
  await store.upsertTheatricalPayoutGateState({
    payee_id: payeeId,
    production_id: PRODUCTION,
    grand_rights_state: grandRightsState,
    venue_settlement_state: venueSettlementState,
    grand_rights_evidence_ref:
      grandRightsState === "cleared" ? "gr-evidence-001" : null,
    venue_settlement_evidence_ref:
      venueSettlementState === "reconciled" ? "vs-evidence-001" : null,
    verified_by: "operator-founder",
  });
}

/** Locks a verified-closed stop's receipt: audit close recorded. */
async function seedReleasableStop(
  store: Store,
  amountCents: number,
  eventId: string,
): Promise<LedgerTransactionRecord> {
  const credit = mustSucceed(
    await lockPromoterBoxOfficeSettlement(
      store,
      {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        amount_cents: amountCents,
        currency: "USD",
        source: { type: "match_queue", event_id: eventId },
      },
      NOW,
    ),
  ).escrow_credit;
  mustSucceed(
    await recordPromoterSettlementAuditClose(store, {
      production_id: PRODUCTION,
      venue_id: VENUE,
      show_date: SHOW_DATE,
      audit_state: "closed",
      evidence_ref: "night-of-show-audit-2026-10-15",
      closed_by: "operator-founder",
    }),
  );
  return credit;
}

describe("lockPromoterBoxOfficeSettlement", () => {
  it("locks the money: per-stop escrow payee, escrow kind and status, no vault minted", async () => {
    const store = new InMemoryStore();
    const result = await lockPromoterBoxOfficeSettlement(
      store,
      {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        amount_cents: 4_500_000,
        currency: "USD",
        source: { type: "match_queue", event_id: "evt-stop-1" },
      },
      NOW,
    );
    const { escrow_credit: credit, journal_id: journalId } = mustSucceed(result);
    expect(credit.kind).toBe("promoter_box_office_settlement_pending");
    expect(credit.status).toBe("promoter_box_office_settlement_pending");
    expect(credit.payee_id).toBe(
      promoterSettlementPayeeId(PRODUCTION, VENUE, SHOW_DATE),
    );
    expect(credit.payee_name).toBe(
      promoterSettlementPayeeName(PRODUCTION, VENUE, SHOW_DATE),
    );
    expect(credit.line_item_id).toBe("evt-stop-1");
    expect(credit.rail).toBeNull();
    expect(credit.settled_at).toBeNull();
    // No vault exists for the escrow sentinel — locked escrow is not a balance.
    expect(
      await store.getVault(promoterSettlementPayeeId(PRODUCTION, VENUE, SHOW_DATE)),
    ).toBeUndefined();
    expect(await store.getVault(COMPANY_VARIANCE_PAYEE_ID)).toBeUndefined();
    // The held credit is discoverable through the existing line-item index.
    expect(
      (await store.listLedgerTransactionsByLineItem("evt-stop-1")).map((r) => r.id),
    ).toEqual([credit.id]);
    // The escrow work queue lists it.
    expect((await store.listPromoterSettlementEscrowCredits()).map((r) => r.id)).toEqual([
      credit.id,
    ]);
    void journalId;
  });

  it("posts a balanced journal: FBO debit against the stop's escrow account", async () => {
    const store = new InMemoryStore();
    const { journal_id: journalId } = mustSucceed(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 4_500_000,
          currency: "USD",
          source: { type: "manual", note: "operator posted remittance" },
        },
        NOW,
      ),
    );
    const entries = await store.listGlEntriesByJournal(journalId);
    expect(entries.map((e) => e.account).sort()).toEqual([
      "fbo_cash",
      promoterSettlementGlAccount(PRODUCTION, VENUE, SHOW_DATE),
    ]);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(4_500_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(4_500_000);
  });

  it("refuses a replayed post for the same source id (409) and writes nothing twice", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 4_500_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-stop-1" },
        },
        NOW,
      ),
    );
    const replay = mustFail(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 4_500_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-stop-1" },
        },
        LATER,
      ),
      409,
      "promoter_settlement_already_posted",
    );
    expect(replay.message).toContain("evt-stop-1");
    expect(await store.listLedgerTransactionsByLineItem("evt-stop-1")).toHaveLength(1);
  });

  it("refuses float, zero, and negative amounts (422) — integer cents, never rounding", async () => {
    const store = new InMemoryStore();
    for (const amount of [10.5, 0, -1]) {
      mustFail(
        await lockPromoterBoxOfficeSettlement(
          store,
          {
            production_id: PRODUCTION,
            venue_id: VENUE,
            show_date: SHOW_DATE,
            amount_cents: amount,
            currency: "USD",
            source: { type: "manual", note: "" },
          },
          NOW,
        ),
        422,
        "invalid_amount",
      );
    }
    expect(await store.listPromoterSettlementEscrowCredits()).toEqual([]);
  });

  it("refuses a blank stop scope (422) — the addendum-11 triple is required", async () => {
    const store = new InMemoryStore();
    mustFail(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: " ",
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 1_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
      422,
      "invalid_stop_scope",
    );
  });

  it("recovers the stop triple from the per-stop payee id", () => {
    const payeeId = promoterSettlementPayeeId(PRODUCTION, VENUE, SHOW_DATE);
    expect(parsePromoterSettlementPayeeId(payeeId)).toEqual({
      production_id: PRODUCTION,
      venue_id: VENUE,
      show_date: SHOW_DATE,
    });
    expect(parsePromoterSettlementPayeeId("creator_x")).toBeUndefined();
    expect(
      parsePromoterSettlementPayeeId("promoter_settlement:only-two:parts"),
    ).toBeUndefined();
  });
});

describe("recordPromoterSettlementAuditClose", () => {
  it("refuses a 'closed' close without evidence and operator provenance (422)", async () => {
    const store = new InMemoryStore();
    mustFail(
      await recordPromoterSettlementAuditClose(store, {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        audit_state: "closed",
        evidence_ref: null,
        closed_by: null,
      }),
      422,
      "audit_close_provenance_required",
    );
    mustFail(
      await recordPromoterSettlementAuditClose(store, {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        audit_state: "closed",
        evidence_ref: "audit-ref",
        closed_by: "  ",
      }),
      422,
      "audit_close_provenance_required",
    );
  });

  it("records the close of record; a re-recording converges and governs the next release", async () => {
    const store = new InMemoryStore();
    const first = mustSucceed(
      await recordPromoterSettlementAuditClose(store, {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        audit_state: "unknown",
        evidence_ref: null,
        closed_by: null,
      }),
    );
    expect(first.audit_state).toBe("unknown");
    const second = mustSucceed(
      await recordPromoterSettlementAuditClose(store, {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        audit_state: "closed",
        evidence_ref: "night-of-show-audit-2026-10-15",
        closed_by: "operator-founder",
      }),
    );
    // The same stop row converged — the newest close governs.
    expect(second.id).toBe(first.id);
    expect(second.audit_state).toBe("closed");
    const read = await store.getPromoterSettlementAudit(PRODUCTION, VENUE, SHOW_DATE);
    expect(read?.audit_state).toBe("closed");
  });
});

describe("releasePromoterBoxOfficeSettlement — refusal before full verification", () => {
  it("refuses an unknown ledger id (404)", async () => {
    const store = new InMemoryStore();
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: "missing",
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      404,
      "escrow_receipt_not_found",
    );
  });

  it("refuses a non-escrow ledger row (422)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const royalty = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "",
      payee_id: "creator_1",
      payee_name: "Creator One",
      role: "creator",
      share_bps: 10_000,
      amount_cents: 5_000,
      currency: "USD",
      status: "pending_settlement",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: NOW.toISOString(),
      settled_at: null,
      kind: "royalty",
    });
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: royalty.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      422,
      "not_a_promoter_settlement_receipt",
    );
  });

  it("refuses an already-released escrow row (409)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 10_000, "evt-release-once");
    mustSucceed(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      409,
      "escrow_already_released",
    );
  });

  it("refuses when the stop's audit close of record is ABSENT (403) — nothing defaults to allowing", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = mustSucceed(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-no-audit" },
        },
        NOW,
      ),
    ).escrow_credit;
    const refusal = mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "audit_close_not_verified",
    );
    expect(refusal.message).toContain("absent (never recorded)");
    // The seeded vault is untouched — no money moved.
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
    expect(await store.listPromoterSettlementEscrowCredits()).toHaveLength(1);
  });

  it("refuses when the stop's audit close of record is explicitly 'unknown' (403)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = mustSucceed(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    mustSucceed(
      await recordPromoterSettlementAuditClose(store, {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        audit_state: "unknown",
        evidence_ref: null,
        closed_by: null,
      }),
    );
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "audit_close_not_verified",
    );
  });

  it("refuses without operator settlement approval (403) and moves no money", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 10_000, "evt-no-approval");
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: false,
        },
        NOW,
      ),
      403,
      "settlement_not_approved",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
  });

  it("refuses a designated payee with no KYC record (403 kyc_state_unknown)", async () => {
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", "Creator One");
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 10_000, "evt-no-kyc");
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "kyc_state_unknown",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
  });

  it("refuses when the theater vertical's gate states are ABSENT (403 vertical_state_unknown) — the store-backed fallback fails closed", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    // No theatrical payout-gate state of record exists for the payee.
    const credit = await seedReleasableStop(store, 10_000, "evt-no-gate-state");
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "vertical_state_unknown",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
  });

  it("refuses grand rights not cleared and venue settlement unreconciled (403) — the gate's two theater conditions", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const credit = await seedReleasableStop(store, 10_000, "evt-gates-1");
    await seedTheatricalGateStates(store, "creator_1", "unknown", "reconciled");
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "theater_grand_rights_not_cleared",
    );
    await seedTheatricalGateStates(store, "creator_1", "cleared", "unknown");
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "theater_venue_settlement_unreconciled",
    );
    // Both states verified → the SAME receipt releases (the verified-release
    // suite covers that); here it stays locked.
    expect(await store.listPromoterSettlementEscrowCredits()).toHaveLength(1);
  });

  it("refuses empty, duplicate, malformed, and over-subscribed payout designations (422)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVerifiedCreator(store, "creator_2", "Creator Two");
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    await seedTheatricalGateStates(store, "creator_2", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 10_000, "evt-designations");
    const base = { escrow_ledger_id: credit.id, operator_settlement_approved: true };
    mustFail(
      await releasePromoterBoxOfficeSettlement(store, { ...base, payouts: [] }, NOW),
      422,
      "no_payout_designations",
    );
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          ...base,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 5_000 },
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 5_000 },
          ],
        },
        NOW,
      ),
      422,
      "duplicate_payout_payee",
    );
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          ...base,
          payouts: [{ payee_id: "creator_1", payee_name: "Creator One", share_bps: 0 }],
        },
        NOW,
      ),
      422,
      "invalid_payout_share",
    );
    mustFail(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          ...base,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 6_000 },
            { payee_id: "creator_2", payee_name: "Creator Two", share_bps: 6_000 },
          ],
        },
        NOW,
      ),
      422,
      "payouts_exceed_receipt",
    );
    expect(await store.listPromoterSettlementEscrowCredits()).toHaveLength(1);
  });
});

describe("releasePromoterBoxOfficeSettlement — the verified release", () => {
  it("pays the designated shares, sweeps the dust to the platform payee, and conserves every cent", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVerifiedCreator(store, "creator_2", "Creator Two");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    await seedTheatricalGateStates(store, "creator_2", "cleared", "reconciled");
    // A 10,001-cent receipt at 5,000/5,000 bps floors to 5,000 + 5,000;
    // the 1-cent residue is dust to the platform payee.
    const credit = await seedReleasableStop(store, 10_001, "evt-release-ok");

    const release = mustSucceed(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 5_000 },
            { payee_id: "creator_2", payee_name: "Creator Two", share_bps: 5_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );

    // The row: settled, kind retained, settled_at stamped.
    expect(release.escrow_credit.status).toBe("settled");
    expect(release.escrow_credit.kind).toBe("promoter_box_office_settlement_pending");
    expect(release.escrow_credit.settled_at).toBe(LATER.toISOString());
    // The release verified THIS close of record.
    expect(release.audit_close.audit_state).toBe("closed");

    // The designated shares landed withholding-free (verified tax profiles)
    // in the pending bucket — dispatch stays downstream of the operator.
    expect(release.payout_credits).toEqual([
      { payee_id: "creator_1", payee_name: "Creator One", gross_cents: 5_000, net_cents: 5_000 },
      { payee_id: "creator_2", payee_name: "Creator Two", gross_cents: 5_000, net_cents: 5_000 },
    ]);
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(5_000);
    expect((await store.getVault("creator_2"))?.pending_balance).toBe(5_000);

    // The dust: 1 cent to the platform payee's pending bucket, on the dust
    // ledger with the receipt's linkage.
    expect(release.company_dust_cents).toBe(1);
    expect(release.dust_ledger).toHaveLength(1);
    expect(release.dust_ledger[0].amount_cents).toBe(1);
    expect((await store.getVault(COMPANY_VARIANCE_PAYEE_ID))?.pending_balance).toBe(1);

    // The journal balances: the escrow debit covers the shares + dust.
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    expect(
      entries.some(
        (e) =>
          e.account === promoterSettlementGlAccount(PRODUCTION, VENUE, SHOW_DATE) &&
          e.debit_cents === 10_001,
      ),
    ).toBe(true);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(10_001);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(10_001);

    // The escrow is empty — the stop's money has fully released.
    expect(await store.listPromoterSettlementEscrowCredits()).toEqual([]);
  });

  it("runs the normal withholding sequence on an unverified tax profile and conserves every cent", async () => {
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", "Creator One");
    await store.insertKycVerification({
      creator_id: "creator_1",
      plaid_link_token: "link-token",
      plaid_public_token: "public-token",
      status: "verified",
      identity_json: "{}",
      failure_reason: null,
      created_at: NOW.toISOString(),
      verified_at: NOW.toISOString(),
    });
    // NO tax profile — the W-2-shaped withholding applies.
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 100_000, "evt-withholding");
    const release = mustSucceed(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );
    // Withholding came off the top into the creator's reserve; only the net
    // released to the pending bucket.
    expect(release.withholding).toHaveLength(1);
    const withheld = release.withholding[0].withheld_cents;
    const gross = release.payout_credits[0].gross_cents;
    const net = release.payout_credits[0].net_cents;
    expect(gross).toBe(100_000);
    expect(gross - withheld).toBe(net);
    // Conservation across every leg the release actually routed.
    expect(withheld + net + release.company_dust_cents).toBe(100_000);
    const vault = await store.getVault("creator_1");
    expect(vault?.reserve_balance).toBe(withheld);
    expect(vault?.pending_balance).toBe(net);
  });

  it("a concurrent release loser reads 409, never a double release", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 10_000, "evt-cas");
    const releaseInput = {
      escrow_ledger_id: credit.id,
      payouts: [
        { payee_id: "creator_1", payee_name: "Creator One", share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
    };
    mustSucceed(await releasePromoterBoxOfficeSettlement(store, releaseInput, NOW));
    mustFail(
      await releasePromoterBoxOfficeSettlement(store, releaseInput, LATER),
      409,
      "escrow_already_released",
    );
    // The loser moved nothing twice.
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(10_000);
  });

  it("the settle CAS refuses the loser and never settles an unknown id", async () => {
    const store = new InMemoryStore();
    const credit = await seedReleasableStop(store, 7_500, "evt-cas-store");
    const settled = await store.settlePromoterSettlementEscrow(credit.id, LATER.toISOString());
    expect(settled?.status).toBe("settled");
    expect(settled?.settled_at).toBe(LATER.toISOString());
    expect(settled?.kind).toBe("promoter_box_office_settlement_pending");
    expect(await store.settlePromoterSettlementEscrow(credit.id, LATER.toISOString())).toBeUndefined();
    expect(await store.settlePromoterSettlementEscrow("missing", LATER.toISOString())).toBeUndefined();
  });
});

describe("postComedyAudioRightsRoyalty — the audio isolation", () => {
  it("posts the audio royalty under the special's own payee, kind, and GL account", async () => {
    const store = new InMemoryStore();
    const result = await postComedyAudioRightsRoyalty(
      store,
      {
        special_id: SPECIAL,
        sender: "siriusxm",
        amount_cents: 125_000,
        currency: "USD",
        source: { type: "match_queue", event_id: "evt-audio-1" },
      },
      NOW,
    );
    const { audio_credit: credit, journal_id: journalId } = mustSucceed(result);
    expect(credit.kind).toBe("comedy_audio_rights_pending");
    expect(credit.status).toBe("comedy_audio_rights_pending");
    expect(credit.payee_id).toBe(comedyAudioRightsPayeeId(SPECIAL));
    expect(credit.payee_name).toBe(comedyAudioRightsPayeeName(SPECIAL));
    expect(credit.line_item_id).toBe("evt-audio-1");
    // The audio journal is balanced against the AUDIO account — never a box
    // office account.
    const entries = await store.listGlEntriesByJournal(journalId);
    expect(entries.map((e) => e.account).sort()).toEqual([
      comedyAudioRightsGlAccount(SPECIAL),
      "fbo_cash",
    ]);
    expect(
      entries.some(
        (e) => e.account === promoterSettlementGlAccount(PRODUCTION, VENUE, SHOW_DATE),
      ),
    ).toBe(false);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(125_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(125_000);
  });

  it("accepts exactly the directive's audio senders (siriusxm, spotify)", async () => {
    const store = new InMemoryStore();
    for (const sender of COMEDY_AUDIO_SENDERS) {
      mustSucceed(
        await postComedyAudioRightsRoyalty(
          store,
          {
            special_id: SPECIAL,
            sender,
            amount_cents: 1_000,
            currency: "USD",
            source: { type: "manual", note: "" },
          },
          NOW,
        ),
      );
    }
  });

  it("refuses a theatrical box office sender (422) — ticket money never routes into the audio stream", async () => {
    const store = new InMemoryStore();
    for (const sender of ["axs", "ticketmaster", "eventbrite", "venuepos", "ascap", ""]) {
      const refusal = mustFail(
        await postComedyAudioRightsRoyalty(
          store,
          {
            special_id: SPECIAL,
            sender,
            amount_cents: 1_000,
            currency: "USD",
            source: { type: "manual", note: "" },
          },
          NOW,
        ),
        422,
        "invalid_audio_sender",
      );
      expect(refusal.message).toContain("never route here");
    }
  });

  it("refuses float, zero, negative amounts (422) and a blank special id (422)", async () => {
    const store = new InMemoryStore();
    for (const amount of [1.25, 0, -5]) {
      mustFail(
        await postComedyAudioRightsRoyalty(
          store,
          {
            special_id: SPECIAL,
            sender: "spotify",
            amount_cents: amount,
            currency: "USD",
            source: { type: "manual", note: "" },
          },
          NOW,
        ),
        422,
        "invalid_amount",
      );
    }
    mustFail(
      await postComedyAudioRightsRoyalty(
        store,
        {
          special_id: " ",
          sender: "spotify",
          amount_cents: 1_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
      422,
      "invalid_special_id",
    );
  });

  it("refuses a replayed post for the same source id (409)", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postComedyAudioRightsRoyalty(
        store,
        {
          special_id: SPECIAL,
          sender: "spotify",
          amount_cents: 88_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-audio-replay" },
        },
        NOW,
      ),
    );
    mustFail(
      await postComedyAudioRightsRoyalty(
        store,
        {
          special_id: SPECIAL,
          sender: "spotify",
          amount_cents: 88_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-audio-replay" },
        },
        LATER,
      ),
      409,
      "comedy_audio_royalty_already_posted",
    );
  });

  it("keeps the streams apart: audio rows never appear in the box office escrow queue, box office rows never ride the audio payee", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postComedyAudioRightsRoyalty(
        store,
        {
          special_id: SPECIAL,
          sender: "spotify",
          amount_cents: 88_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    );
    mustSucceed(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 400_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    );
    // The box office escrow queue lists ONLY the settlement receipt.
    const escrowQueue = await store.listPromoterSettlementEscrowCredits();
    expect(escrowQueue).toHaveLength(1);
    expect(escrowQueue[0].kind).toBe("promoter_box_office_settlement_pending");
    expect(escrowQueue[0].payee_id).toBe(
      promoterSettlementPayeeId(PRODUCTION, VENUE, SHOW_DATE),
    );
    // The audio royalty is a DIFFERENT kind, a DIFFERENT payee — no query
    // over one stream can fold in the other.
    const allRows = await store.listLedgerTransactionsByLineItem("evt-none");
    expect(allRows).toEqual([]);
    const escrowRow = escrowQueue[0];
    expect(escrowRow.kind).not.toBe("comedy_audio_rights_pending");
    expect(escrowRow.payee_id).not.toBe(comedyAudioRightsPayeeId(SPECIAL));
  });
});

describe("venue hall fees — the 15–25% band and the fail-closed split", () => {
  it("refuses out-of-band rates (422) — below 15% and above 25%", async () => {
    const store = new InMemoryStore();
    for (const bps of [VENUE_HALL_FEE_MIN_BPS - 1, VENUE_HALL_FEE_MAX_BPS + 1, 0, -1_500]) {
      mustFail(
        await registerVenueHallFeePolicy(store, {
          tour_id: "tour-2026",
          venue_id: VENUE,
          hall_fee_rate_bps: bps,
          venue_payee_id: "venue-llc",
          venue_payee_name: "Venue LLC",
        }),
        422,
        "hall_fee_rate_out_of_band",
      );
    }
  });

  it("registers the band's edges (1500, 2500) and converges re-registrations", async () => {
    const store = new InMemoryStore();
    const low = mustSucceed(
      await registerVenueHallFeePolicy(store, {
        tour_id: "tour-2026",
        venue_id: VENUE,
        hall_fee_rate_bps: VENUE_HALL_FEE_MIN_BPS,
        venue_payee_id: "venue-llc",
        venue_payee_name: "Venue LLC",
      }),
    );
    expect(low.hall_fee_rate_bps).toBe(1_500);
    const updated = mustSucceed(
      await registerVenueHallFeePolicy(store, {
        tour_id: "tour-2026",
        venue_id: VENUE,
        hall_fee_rate_bps: VENUE_HALL_FEE_MAX_BPS,
        venue_payee_id: "venue-llc",
        venue_payee_name: "Venue LLC",
      }),
    );
    expect(updated.id).toBe(low.id);
    expect(updated.hall_fee_rate_bps).toBe(2_500);
    const read = await store.getVenueHallFeePolicy("tour-2026", VENUE);
    expect(read?.hall_fee_rate_bps).toBe(2_500);
  });

  it("refuses a split for an unregistered pairing (403) — the deduction never guesses a rate", async () => {
    const store = new InMemoryStore();
    const refusal = mustFail(
      await resolveMerchHallFeeSplit(store, {
        tour_id: "tour-never-registered",
        venue_id: VENUE,
        gross_merch_cents: 50_000,
      }),
      403,
      "hall_fee_policy_unregistered",
    );
    expect(refusal.message).toContain("never guesses");
  });

  it("deducts the venue's cut from gross merch BEFORE the artist's apparel net — exact conservation", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await registerVenueHallFeePolicy(store, {
        tour_id: "tour-2026",
        venue_id: VENUE,
        hall_fee_rate_bps: 2_000,
        venue_payee_id: "venue-llc",
        venue_payee_name: "Venue LLC",
      }),
    );
    // 20% of 50,001 floors to 10,000; the artist's apparel net is the
    // remainder — venue_cut + artist_net === gross, exact, always.
    const split = mustSucceed(
      await resolveMerchHallFeeSplit(store, {
        tour_id: "tour-2026",
        venue_id: VENUE,
        gross_merch_cents: 50_001,
      }),
    );
    expect(split.venue_cut_cents).toBe(10_000);
    expect(split.artist_net_cents).toBe(40_001);
    expect(split.venue_cut_cents + split.artist_net_cents).toBe(50_001);
    expect(split.policy.venue_payee_id).toBe("venue-llc");
  });

  it("computes the pure split with exact conservation at the band's edges and on zero", () => {
    expect(computeVenueHallFeeSplit(10_000, VENUE_HALL_FEE_MIN_BPS)).toEqual({
      venue_cut_cents: 1_500,
      artist_net_cents: 8_500,
    });
    expect(computeVenueHallFeeSplit(10_001, VENUE_HALL_FEE_MAX_BPS)).toEqual({
      venue_cut_cents: 2_500,
      artist_net_cents: 7_501,
    });
    expect(computeVenueHallFeeSplit(0, 2_000)).toEqual({
      venue_cut_cents: 0,
      artist_net_cents: 0,
    });
  });
});

describe("grandRightsRoute — the Grand Rights / small rights decoupling", () => {
  it("refuses every standard PRO small-rights pool destination", () => {
    for (const pool of ["ascap", "bmi"]) {
      const refusal = grandRightsRoute("mti", pool);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) {
        expect(refusal.code).toBe("grand_rights_never_route_through_pro_pools");
        expect(refusal.message).toContain(pool);
        expect(refusal.message).toContain("never route there");
      }
    }
  });

  it("refuses a non-publisher route code — only the specialized theatrical publishers hold the lane", () => {
    const refusal = grandRightsRoute("some_random_agency", "direct_deposit");
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.code).toBe("grand_rights_never_route_through_pro_pools");
      expect(refusal.message).toContain("theatrical publisher of record");
    }
  });

  it("routes through the production's specialized theatrical publisher of record", () => {
    for (const publisher of THEATRICAL_PUBLISHERS) {
      const route = grandRightsRoute(publisher, "specialized_theatrical_publisher");
      expect(route.ok).toBe(true);
      if (route.ok) {
        expect(route.lane).toBe("theatrical_publisher");
        expect(route.payee_id).toBe(`theatrical_publisher:${publisher}`);
        expect(route.destination).not.toBe("ascap");
        expect(route.destination).not.toBe("bmi");
      }
    }
  });
});

describe("locked ledger invariants (PR 31)", () => {
  it("allocations + dust equals gross INCLUDING the escrow bucket — held money is on the ledger", async () => {
    const store = new InMemoryStore();
    const held = mustSucceed(
      await lockPromoterBoxOfficeSettlement(
        store,
        {
          production_id: PRODUCTION,
          venue_id: VENUE,
          show_date: SHOW_DATE,
          amount_cents: 250_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    // The escrow receipt is a ledger row: the held bucket is IN the gross.
    expect(held.amount_cents).toBe(250_000);
    // The release's own math holds the identity: shares + dust === receipt.
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    mustSucceed(
      await recordPromoterSettlementAuditClose(store, {
        production_id: PRODUCTION,
        venue_id: VENUE,
        show_date: SHOW_DATE,
        audit_state: "closed",
        evidence_ref: "audit-ref",
        closed_by: "operator-founder",
      }),
    );
    // 250_000 at 9_999 bps floors to 249_975; the 25-cent residue is dust.
    const release = mustSucceed(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: held.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 9_999 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );
    const shares = release.payout_credits.reduce((t, c) => t + c.net_cents, 0);
    expect(shares).toBe(249_975);
    expect(shares + release.company_dust_cents).toBe(250_000);
  });

  it("integer cents throughout: every posted journal entry carries whole cents", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    await seedTheatricalGateStates(store, "creator_1", "cleared", "reconciled");
    const credit = await seedReleasableStop(store, 9_999, "evt-integers");
    const release = mustSucceed(
      await releasePromoterBoxOfficeSettlement(
        store,
        {
          escrow_ledger_id: credit.id,
          payouts: [
            { payee_id: "creator_1", payee_name: "Creator One", share_bps: 3_333 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );
    // 3_333 bps of 9_999 floors to 3_332; 6_667 cents stay behind as dust.
    expect(release.payout_credits[0].net_cents).toBe(3_332);
    expect(release.company_dust_cents).toBe(6_667);
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    for (const entry of entries) {
      expect(Number.isSafeInteger(entry.debit_cents)).toBe(true);
      expect(Number.isSafeInteger(entry.credit_cents)).toBe(true);
    }
    // The stop's scope stamp rides the payee id end-to-end.
    expect(release.escrow_credit.payee_id).toBe(
      promoterSettlementPayeeId(PRODUCTION, VENUE, SHOW_DATE),
    );
    expect(promoterSettlementScope(PRODUCTION, VENUE, SHOW_DATE)).toContain(SHOW_DATE);
  });
});
