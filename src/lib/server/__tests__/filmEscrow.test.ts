// Film waterfall escrow ledger states (PR 9) — the in-memory battery.
//
// Locked invariants under test, per the founder film directive: money
// received from a film distributor LOCKS in ESCROW_WATERFALL_PENDING (out of
// every vault, tier, and the holding bucket) until the statement line items
// are cross-referenced against the signed deal memo AND CAMA agreement; the
// verified release rides the normal clearance-gated settlement path and moves
// NO money on any refusal; First Dollar Gross participant points pay off the
// top of the releasing receipt when the deal's cumulative-gross trigger fires
// (bypassing the lower waterfall tiers); the tier-5 leg splits into the
// locked 50/50 producer/investor pools; backend talent net points draw
// STRICTLY from the producer pool, never the investor pool, never gross;
// allocations + dust equals gross INCLUDING the escrow bucket; integer cents
// throughout; per-source post idempotency; the settle CAS guards
// concurrency.

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  allocateNetPointShares,
  postFilmNetPoints,
  postToFilmEscrow,
  releaseFilmEscrow,
  splitTier5Pools,
} from "@/lib/server/filmEscrow";
import type { FdgDealTerms, WaterfallTierAllocation } from "@/lib/server/filmEscrow";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  filmEscrowGlAccount,
  filmEscrowPayeeId,
  filmEscrowPayeeName,
  tier5InvestorPoolGlAccount,
  tier5ProducerPoolGlAccount,
  waterfallTierGlAccount,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-09-30T12:00:00Z");
const LATER = new Date("2026-09-30T12:01:00Z");
const FILM = "film-77";

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

/** The film vertical's compliance state, fully satisfied. */
function filmStateSatisfied(): void {
  setVerticalComplianceStateSource(async () => ({
    vertical: "film",
    cama_escrow_released: true,
    guild_residual_holdback_satisfied: true,
  }));
}

function filmEscrowRow(
  amountCents: number,
  createdAt: string,
): Omit<LedgerTransactionRecord, "id"> {
  return {
    split_run_id: "",
    line_item_id: "",
    payee_id: filmEscrowPayeeId(FILM),
    payee_name: filmEscrowPayeeName(FILM),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "escrow_waterfall_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "escrow_waterfall_pending",
  };
}

const VERIFICATION = {
  deal_memo_ref: "deal-memo-2026-014",
  cama_agreement_ref: "cama-2026-014",
};

afterEach(() => {
  // The operations-seam override is process-global — reset it every test.
  setVerticalComplianceStateSource(null);
});

describe("postToFilmEscrow", () => {
  it("locks the money: per-film escrow payee, escrow kind and status, no vault minted", async () => {
    const store = new InMemoryStore();
    const result = await postToFilmEscrow(
      store,
      {
        film_id: FILM,
        amount_cents: 25_000_000,
        currency: "USD",
        source: { type: "match_queue", event_id: "evt-film-1" },
      },
      NOW,
    );
    const { escrow_credit: credit, journal_id: journalId } = mustSucceed(result);
    expect(credit.kind).toBe("escrow_waterfall_pending");
    expect(credit.status).toBe("escrow_waterfall_pending");
    expect(credit.payee_id).toBe(filmEscrowPayeeId(FILM));
    expect(credit.payee_name).toBe(filmEscrowPayeeName(FILM));
    expect(credit.line_item_id).toBe("evt-film-1");
    expect(credit.rail).toBeNull();
    expect(credit.settled_at).toBeNull();
    // No vault exists for the escrow sentinel — locked escrow is not a balance.
    expect(await store.getVault(filmEscrowPayeeId(FILM))).toBeUndefined();
    expect(await store.getVault(COMPANY_VARIANCE_PAYEE_ID)).toBeUndefined();
    // The held credit is discoverable through the existing line-item index.
    expect(
      (await store.listLedgerTransactionsByLineItem("evt-film-1")).map((r) => r.id),
    ).toEqual([credit.id]);
    void journalId;
  });

  it("posts a balanced journal: FBO debit against the film's escrow account", async () => {
    const store = new InMemoryStore();
    const { journal_id: journalId } = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 25_000_000,
          currency: "USD",
          source: { type: "manual", note: "operator posted remittance" },
        },
        NOW,
      ),
    );
    const entries = await store.listGlEntriesByJournal(journalId);
    expect(entries.map((e) => e.account).sort()).toEqual([
      "fbo_cash",
      filmEscrowGlAccount(FILM),
    ]);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(25_000_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(25_000_000);
  });

  it("refuses a replayed post for the same source id (409) and writes nothing twice", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 25_000_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-film-1" },
        },
        NOW,
      ),
    );
    const replay = mustFail(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 25_000_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-film-1" },
        },
        LATER,
      ),
      409,
      "film_receipt_already_posted",
    );
    expect(replay.message).toContain("evt-film-1");
    expect(await store.listLedgerTransactionsByLineItem("evt-film-1")).toHaveLength(1);
  });

  it("refuses float, zero, and negative amounts (422) — integer cents, never rounding", async () => {
    const store = new InMemoryStore();
    for (const amount of [100.5, 0, -5]) {
      mustFail(
        await postToFilmEscrow(
          store,
          {
            film_id: FILM,
            amount_cents: amount,
            currency: "USD",
            source: { type: "manual", note: "bad" },
          },
          NOW,
        ),
        422,
        "invalid_amount",
      );
    }
  });

  it("refuses a blank film id (422)", async () => {
    const store = new InMemoryStore();
    mustFail(
      await postToFilmEscrow(
        store,
        {
          film_id: "  ",
          amount_cents: 100,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
      422,
      "invalid_film_id",
    );
  });

  it("cumulative gross counts every receipt for the film, held or released", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 1_000_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-gross-1" },
        },
        NOW,
      ),
    );
    mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 500_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-gross-2" },
        },
        NOW,
      ),
    );
    // A different film's receipt does not enter this film's gross.
    mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: "film-other",
          amount_cents: 700_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-gross-3" },
        },
        NOW,
      ),
    );
    expect(await store.sumFilmGrossReceiptCents(FILM)).toBe(1_500_000);
    expect(await store.sumFilmGrossReceiptCents("film-other")).toBe(700_000);
  });
});

describe("releaseFilmEscrow — refusal before full verification", () => {
  it("refuses an unknown ledger id (404)", async () => {
    const store = new InMemoryStore();
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: "missing",
          verification: VERIFICATION,
          fdg: null,
          tier_allocations: [],
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
    const royalty = await store.insertLedgerTransaction({
      ...filmEscrowRow(1_000, NOW.toISOString()),
      payee_id: "creator_x",
      payee_name: "Creator X",
      role: "creator",
      share_bps: 10_000,
      status: "pending_settlement",
      kind: "royalty",
    });
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: royalty.id,
          verification: VERIFICATION,
          fdg: null,
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      422,
      "not_an_escrow_receipt",
    );
  });

  it("refuses an already-released escrow row (409)", async () => {
    const store = new InMemoryStore();
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 1_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: null,
          tier_allocations: [
            { tier_level: 0, amount_cents: 1_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: null,
          tier_allocations: [{ tier_level: 0, amount_cents: 1_000 }],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      409,
      "escrow_already_released",
    );
  });

  it("refuses before the cross-reference verification — missing deal memo ref, missing CAMA ref, blank refs (422)", async () => {
    const store = new InMemoryStore();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 1_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    for (const verification of [
      { deal_memo_ref: "", cama_agreement_ref: "cama-2026-014" },
      { deal_memo_ref: "deal-memo-2026-014", cama_agreement_ref: "" },
      { deal_memo_ref: "   ", cama_agreement_ref: "cama-2026-014" },
      { deal_memo_ref: "deal-memo-2026-014", cama_agreement_ref: "  " },
    ]) {
      mustFail(
        await releaseFilmEscrow(
          store,
          {
            escrow_ledger_id: credit.id,
            verification,
            fdg: null,
            tier_allocations: [{ tier_level: 0, amount_cents: 1_000 }],
            operator_settlement_approved: true,
          },
          NOW,
        ),
        422,
        "cross_reference_verification_required",
      );
    }
    // The escrow stayed locked — nothing moved anywhere.
    expect((await store.listFilmEscrowCredits()).map((r) => r.id)).toEqual([credit.id]);
    expect(await store.getVault(COMPANY_VARIANCE_PAYEE_ID)).toBeUndefined();
  });

  it("refuses without operator settlement approval (403) and moves no money", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [],
          operator_settlement_approved: false,
        },
        NOW,
      ),
      403,
      "settlement_not_approved",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
    expect((await store.listFilmEscrowCredits()).map((r) => r.id)).toEqual([credit.id]);
  });

  it("refuses an unknown FDG participant (403 kyc_state_unknown) and moves no money", async () => {
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", "Creator One");
    filmStateSatisfied();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "kyc_state_unknown",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
    expect((await store.listFilmEscrowCredits()).map((r) => r.id)).toEqual([credit.id]);
  });

  it("refuses when the film vertical's compliance state is unknown (403) — the default source fails closed", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    // No override: the default state source returns null → unknown refuses.
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "vertical_state_unknown",
    );
  });

  it("refuses when the CAMA escrow has not been released or the guild residual holdback is unsatisfied (403)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    setVerticalComplianceStateSource(async () => ({
      vertical: "film",
      cama_escrow_released: false,
      guild_residual_holdback_satisfied: true,
    }));
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "film_cama_escrow_not_released",
    );
    setVerticalComplianceStateSource(async () => ({
      vertical: "film",
      cama_escrow_released: true,
      guild_residual_holdback_satisfied: false,
    }));
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "film_guild_residual_holdback_not_satisfied",
    );
    expect((await store.listFilmEscrowCredits()).map((r) => r.id)).toEqual([credit.id]);
  });

  it("refuses FDG shares exceeding gross (422), duplicate tiers (422), and out-of-range tiers (422)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVerifiedCreator(store, "creator_2", "Creator Two");
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    const baseInput = {
      escrow_ledger_id: credit.id,
      verification: VERIFICATION,
      fdg: null as FdgDealTerms | null,
      tier_allocations: [] as WaterfallTierAllocation[],
      operator_settlement_approved: true,
    };
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          ...baseInput,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 6_000 },
              { payee_id: "creator_2", payee_name: "Creator Two", role: "creator", share_bps: 5_000 },
            ],
            threshold_cents: null,
          },
        },
        NOW,
      ),
      422,
      "fdg_shares_exceed_gross",
    );
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          ...baseInput,
          tier_allocations: [
            { tier_level: 2, amount_cents: 100 },
            { tier_level: 2, amount_cents: 100 },
          ],
        },
        NOW,
      ),
      422,
      "duplicate_tier_allocation",
    );
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          ...baseInput,
          tier_allocations: [{ tier_level: 6, amount_cents: 100 }],
        },
        NOW,
      ),
      422,
      "invalid_tier_level",
    );
  });

  it("refuses routing that exceeds the locked receipt (422)", async () => {
    const store = new InMemoryStore();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 1_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    mustFail(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: null,
          tier_allocations: [
            { tier_level: 0, amount_cents: 800 },
            { tier_level: 1, amount_cents: 300 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      422,
      "allocations_exceed_receipt",
    );
    expect((await store.listFilmEscrowCredits()).map((r) => r.id)).toEqual([credit.id]);
  });
});

describe("releaseFilmEscrow — the verified release", () => {
  it("pays FDG points off the top, routes the tiers, splits the tier-5 leg into the locked pools, and sweeps dust", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    // A 10,001-cent receipt: FDG at 5,000 bps floors to 5,000; the residue
    // routes exactly — tier 0 takes 5,000, tier 5 takes the 1-cent remainder.
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_001,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-release-1" },
        },
        NOW,
      ),
    ).escrow_credit;

    const release = mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 5_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [
            { tier_level: 0, amount_cents: 5_000 },
            { tier_level: 5, amount_cents: 1 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );

    // The row: settled, kind retained, settled_at stamped.
    expect(release.escrow_credit.status).toBe("settled");
    expect(release.escrow_credit.kind).toBe("escrow_waterfall_pending");
    expect(release.escrow_credit.settled_at).toBe(LATER.toISOString());
    expect(release.fdg_triggered).toBe(true);

    // The FDG participant's point: creator-role, verified tax profile →
    // no withholding, pending bucket (dispatch stays downstream of the
    // operator).
    expect(release.fdg_participant_credits).toEqual([
      { payee_id: "creator_1", payee_name: "Creator One", role: "creator", gross_cents: 5_000, net_cents: 5_000 },
    ]);
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(5_000);

    // The tier-5 leg split into the locked pools: 1 cent → producer floors
    // to 0 (the zero leg is skipped), the odd cent rides the investor pool.
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    expect(
      entries.find((e) => e.account === tier5ProducerPoolGlAccount(FILM)),
    ).toBeUndefined();
    expect(
      entries.find((e) => e.account === tier5InvestorPoolGlAccount(FILM))?.credit_cents,
    ).toBe(1);
    expect(
      entries.find((e) => e.account === waterfallTierGlAccount(FILM, 0))?.credit_cents,
    ).toBe(5_000);

    // The journal balances: the escrow debit covers FDG + tiers + dust.
    expect(entries.some((e) => e.account === filmEscrowGlAccount(FILM) && e.debit_cents === 10_001)).toBe(true);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(10_001);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(10_001);

    // The escrow is empty.
    expect(await store.listFilmEscrowCredits()).toEqual([]);
  });

  it("holds FDG points when the deal's cumulative-gross threshold has not been crossed", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    // First receipt: 100,000 cents. The deal's threshold is 500,000.
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 100_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-threshold-1" },
        },
        NOW,
      ),
    ).escrow_credit;
    const release = mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: 500_000,
          },
          tier_allocations: [{ tier_level: 0, amount_cents: 100_000 }],
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );
    // The trigger did NOT fire: no FDG credits, the full receipt routed to
    // tier 0, no dust.
    expect(release.fdg_triggered).toBe(false);
    expect(release.fdg_participant_credits).toEqual([]);
    expect(release.company_dust_cents).toBe(0);
    expect((await store.getVault("creator_1"))?.pending_balance ?? 0).toBe(0);
  });

  it("fires the FDG trigger once the film's cumulative gross receipts cross the threshold — held receipts count", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    // Receipt 1 (100,000) posts and releases while the film's cumulative
    // gross (100,000) sits below the 500,000 threshold. Receipt 2 (400,000)
    // then LOCKS but is never released — cumulative gross hits 500,000 — so
    // receipt 3's release fires the trigger: held receipts count toward
    // gross the moment they lock, not when they release.
    const receipt1 = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 100_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-cum-1" },
        },
        NOW,
      ),
    );
    const belowThreshold = mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: receipt1.escrow_credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: 500_000,
          },
          tier_allocations: [{ tier_level: 0, amount_cents: 100_000 }],
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );
    // The trigger did NOT fire on receipt 1: no FDG credits, the full
    // receipt routed to tier 0, no dust.
    expect(belowThreshold.fdg_triggered).toBe(false);
    expect(belowThreshold.fdg_participant_credits).toEqual([]);
    expect(belowThreshold.company_dust_cents).toBe(0);
    expect((await store.getVault("creator_1"))?.pending_balance ?? 0).toBe(0);

    // Receipt 2 locks (cumulative gross → 500,000, the threshold) and
    // receipt 3 locks on top; neither releases before the final act.
    for (const [eventId, amount] of [
      ["evt-cum-2", 400_000],
      ["evt-cum-3", 1_000],
    ] as const) {
      mustSucceed(
        await postToFilmEscrow(
          store,
          {
            film_id: FILM,
            amount_cents: amount,
            currency: "USD",
            source: { type: "match_queue", event_id: eventId },
          },
          NOW,
        ),
      );
    }
    const lockedThird = (await store.listFilmEscrowCredits()).find(
      (row) => row.line_item_id === "evt-cum-3",
    );
    if (lockedThird === undefined) throw new Error("evt-cum-3 not locked");
    const release = mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: lockedThird.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: 500_000,
          },
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );
    expect(release.fdg_triggered).toBe(true);
    expect(release.fdg_participant_credits).toEqual([
      { payee_id: "creator_1", payee_name: "Creator One", role: "creator", gross_cents: 1_000, net_cents: 1_000 },
    ]);
  });

  it("runs the normal withholding sequence on an unverified tax profile and conserves every cent", async () => {
    const store = new InMemoryStore();
    // KYC verified (the gate passes) but no tax profile → backup withholding.
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
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;

    const release = mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [],
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );

    expect(release.fdg_participant_credits).toHaveLength(1);
    const creditRow = release.fdg_participant_credits[0];
    expect(creditRow.gross_cents).toBe(10_000);
    expect(creditRow.net_cents).toBeLessThan(10_000);
    // Conservation: reserve + pending == gross, every cent accounted for.
    const vault = await store.getVault("creator_1");
    expect((vault?.reserve_balance ?? 0) + (vault?.pending_balance ?? 0)).toBe(10_000);
    expect(vault?.reserve_balance).toBeGreaterThan(0);
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(10_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(10_000);
  });

  it("a concurrent release loser reads 409, never a double release", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    const releaseInput = {
      escrow_ledger_id: credit.id,
      verification: VERIFICATION,
      fdg: {
        participants: [
          { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, share_bps: 10_000 },
        ],
        threshold_cents: null,
      },
      tier_allocations: [] as WaterfallTierAllocation[],
      operator_settlement_approved: true,
    };
    mustSucceed(await releaseFilmEscrow(store, releaseInput, NOW));
    mustFail(
      await releaseFilmEscrow(store, releaseInput, LATER),
      409,
      "escrow_already_released",
    );
    // The loser moved nothing twice.
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(10_000);
  });
});

describe("postFilmNetPoints — the sourcing rule", () => {
  it("sources shares STRICTLY from the producer pool: the journal debits only the producer pool account", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVerifiedCreator(store, "creator_2", "Creator Two");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    // Tier 5 paid 10,003: producer pool floors to 5,001, investor keeps 5,002.
    const result = mustSucceed(
      await postFilmNetPoints(
        store,
        {
          film_id: FILM,
          distribution_ref: "dist-2026-10-01",
          tier5_distribution_cents: 10_003,
          holders: [
            { payee_id: "creator_1", payee_name: "Creator One", net_points_bps: 5_000 },
            { payee_id: "creator_2", payee_name: "Creator Two", net_points_bps: 5_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );
    expect(result.producer_pool_cents).toBe(5_001);
    expect(result.investor_pool_cents).toBe(5_002);
    // Shares floor out of the PRODUCER pool: 5,001 × 50% = 2,500.5 → 2,500 each.
    expect(result.holder_credits).toEqual([
      { payee_id: "creator_1", payee_name: "Creator One", amount_cents: 2_500 },
      { payee_id: "creator_2", payee_name: "Creator Two", amount_cents: 2_500 },
    ]);
    expect(result.company_dust_cents).toBe(1);
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(2_500);
    expect((await store.getVault("creator_2"))?.pending_balance).toBe(2_500);

    // The journal debits ONLY the producer pool account — the investor pool
    // account is never touched by net points.
    const entries = await store.listGlEntriesByJournal(result.journal_id);
    expect(
      entries.filter((e) => e.account === tier5InvestorPoolGlAccount(FILM)),
    ).toEqual([]);
    expect(
      entries.find((e) => e.account === tier5ProducerPoolGlAccount(FILM) && e.debit_cents === 5_001),
    ).toBeTruthy();
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(5_001);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(5_001);
  });

  it("refuses a replayed distribution for the same ref (409)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();
    const input = {
      film_id: FILM,
      distribution_ref: "dist-2026-10-01",
      tier5_distribution_cents: 2_000,
      holders: [
        { payee_id: "creator_1", payee_name: "Creator One", net_points_bps: 10_000 },
      ],
      operator_settlement_approved: true,
    };
    mustSucceed(await postFilmNetPoints(store, input, NOW));
    const replay = mustFail(
      await postFilmNetPoints(store, input, LATER),
      409,
      "net_points_already_distributed",
    );
    expect(replay.message).toContain("dist-2026-10-01");
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(1_000);
  });

  it("refuses an unverified holder through the same fail-closed gate (403) and pays no one", async () => {
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", "Creator One");
    filmStateSatisfied();
    mustFail(
      await postFilmNetPoints(
        store,
        {
          film_id: FILM,
          distribution_ref: "dist-2026-10-02",
          tier5_distribution_cents: 2_000,
          holders: [
            { payee_id: "creator_1", payee_name: "Creator One", net_points_bps: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        NOW,
      ),
      403,
      "kyc_state_unknown",
    );
    expect((await store.getVault("creator_1"))?.pending_balance ?? 0).toBe(0);
  });

  it("refuses no-holders, bps sums over 10000, and non-positive distributions (422)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const base = {
      film_id: FILM,
      distribution_ref: "dist-2026-10-03",
      holders: [
        { payee_id: "creator_1", payee_name: "Creator One", net_points_bps: 10_000 },
      ],
      operator_settlement_approved: true,
    };
    mustFail(
      await postFilmNetPoints(store, { ...base, tier5_distribution_cents: 0 }, NOW),
      422,
      "invalid_amount",
    );
    mustFail(
      await postFilmNetPoints(
        store,
        {
          ...base,
          tier5_distribution_cents: 1_000,
          holders: [
            { payee_id: "creator_1", payee_name: "Creator One", net_points_bps: 10_001 },
          ],
        },
        NOW,
      ),
      422,
      "net_points_exceed_producer_pool",
    );
    mustFail(
      await postFilmNetPoints(
        store,
        { ...base, tier5_distribution_cents: 1_000, holders: [] },
        NOW,
      ),
      422,
      "no_net_point_holders",
    );
  });
});

describe("locked tier-5 pool math (pure functions)", () => {
  it("splitTier5Pools floors the producer half — the odd cent stays on the investor side", () => {
    expect(splitTier5Pools(10_000)).toEqual({
      producer_pool_cents: 5_000,
      investor_pool_cents: 5_000,
    });
    expect(splitTier5Pools(10_003)).toEqual({
      producer_pool_cents: 5_001,
      investor_pool_cents: 5_002,
    });
    expect(splitTier5Pools(1)).toEqual({
      producer_pool_cents: 0,
      investor_pool_cents: 1,
    });
    expect(splitTier5Pools(0)).toEqual({
      producer_pool_cents: 0,
      investor_pool_cents: 0,
    });
  });

  it("allocateNetPointShares floors every share out of the producer pool — sum(shares) ≤ pool always", () => {
    // Three holders at 3,333 bps of 5,001: 1,666.83... → 1,666 each, 3 dust.
    const allocation = allocateNetPointShares(5_001, [
      { payee_id: "a", payee_name: "A", net_points_bps: 3_333 },
      { payee_id: "b", payee_name: "B", net_points_bps: 3_333 },
      { payee_id: "c", payee_name: "C", net_points_bps: 3_333 },
    ]);
    expect(allocation.shares.map((s) => s.amount_cents)).toEqual([1_666, 1_666, 1_666]);
    expect(allocation.dust_cents).toBe(3);
    // A 10,000 bps holder can draw the whole producer pool, never a cent more.
    const whole = allocateNetPointShares(5_001, [
      { payee_id: "a", payee_name: "A", net_points_bps: 10_000 },
    ]);
    expect(whole.shares[0].amount_cents).toBe(5_001);
    expect(whole.dust_cents).toBe(0);
  });
});

describe("locked ledger invariants", () => {
  it("allocations + dust equals gross INCLUDING the escrow bucket", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    filmStateSatisfied();

    // A royalty run allocates 5,000 to the creator.
    const runLedger = await store.insertLedgerTransaction({
      split_run_id: "run-1",
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
    void runLedger;

    // A film receipt locks 10,000 in escrow; another 2,000 posts to the
    // unclaimed holding bucket (PR 7's seam).
    mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-inv-1" },
        },
        NOW,
      ),
    );
    await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "evt-inv-2",
      payee_id: "platform:unclaimed_holding",
      payee_name: "Unclaimed Royalty Holding",
      role: "other",
      share_bps: 0,
      amount_cents: 2_000,
      currency: "USD",
      status: "unclaimed_holding",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: NOW.toISOString(),
      settled_at: null,
      kind: "unclaimed_holding",
    });

    // Release the escrow: FDG 5,000 bps → 5,000 (creator), tier 0 → 4,999,
    // 1 cent of dust to the platform payee.
    const credit = (await store.listFilmEscrowCredits())[0];
    const release = mustSucceed(
      await releaseFilmEscrow(
        store,
        {
          escrow_ledger_id: credit.id,
          verification: VERIFICATION,
          fdg: {
            participants: [
              { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 5_000 },
            ],
            threshold_cents: null,
          },
          tier_allocations: [{ tier_level: 0, amount_cents: 4_999 }],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );

    const creatorAllocated = 5_000; // the royalty run
    const fdgPaid = release.fdg_participant_credits.reduce(
      (s, c) => s + c.net_cents,
      0,
    );
    const tiersRouted = release.tier_allocations.reduce(
      (s, t) => s + t.amount_cents,
      0,
    );
    const dust = release.company_dust_cents;
    const heldFilmEscrow = (await store.listFilmEscrowCredits()).reduce(
      (s, r) => s + r.amount_cents,
      0,
    );
    for (const component of [creatorAllocated, fdgPaid, tiersRouted, dust, heldFilmEscrow]) {
      expect(Number.isInteger(component)).toBe(true);
    }
    // 5,000 royalty + 5,000 FDG + 4,999 tiers + 1 dust = 15,000 — every
    // identified cent; the escrow bucket is empty after the release.
    expect(creatorAllocated + fdgPaid + tiersRouted + dust + heldFilmEscrow).toBe(15_000);
    expect(heldFilmEscrow).toBe(0);
    expect(dust).toBe(1);
  });

  it("the settle CAS refuses the loser and never settles an unknown id", async () => {
    const store = new InMemoryStore();
    const credit = mustSucceed(
      await postToFilmEscrow(
        store,
        {
          film_id: FILM,
          amount_cents: 1_000,
          currency: "USD",
          source: { type: "manual", note: "" },
        },
        NOW,
      ),
    ).escrow_credit;
    const winner = await store.settleFilmEscrow(credit.id, NOW.toISOString());
    expect(winner?.status).toBe("settled");
    expect(winner?.kind).toBe("escrow_waterfall_pending");
    expect(await store.settleFilmEscrow(credit.id, LATER.toISOString())).toBeUndefined();
    expect(await store.settleFilmEscrow("missing", LATER.toISOString())).toBeUndefined();
  });
});
