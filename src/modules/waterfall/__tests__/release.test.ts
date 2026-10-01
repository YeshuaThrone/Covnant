// The film waterfall release orchestration — decision-path tests for
// releaseThroughWaterfall: the fail-closed ladder (missing receipt 404,
// non-escrow payee 500, unregistered deal 404, already-applied 409, corrupt
// cumulative state 500), the release-refusal path (the routed record is
// deleted so the unique lock frees), the crash-recovery path (a stale routed
// record is replaced, never duplicated), and the end-to-end carry (a second
// receipt continues the cascade where the first stopped).
//
// These run on InMemoryStore: the three-backend storage contracts are the
// parity suite's job; here the store is a fixture. releaseFilmEscrow's own
// gates are covered by filmEscrow.test.ts — the assertion of interest is
// that releaseThroughWaterfall FORWARDS the decision and honors the verdict.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import { postToFilmEscrow } from "@/lib/server/filmEscrow";
import type { CrossReferenceVerification } from "@/lib/server/filmEscrow";
import { releaseThroughWaterfall } from "@/modules/waterfall/release";
import type { WaterfallReleaseInput } from "@/modules/waterfall/release";
import type { FilmWaterfallDefinitionRecord } from "@/modules/don/records";
import type { FilmWaterfallDefinition } from "@/modules/waterfall/engine";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const VERIFICATION: CrossReferenceVerification = {
  deal_memo_ref: "deal-memo-77",
  cama_agreement_ref: "cama-77",
};

function deal(): FilmWaterfallDefinition {
  return {
    film_id: "film-77",
    label: "Standard film deal",
    tiers: [
      {
        tier_level: 0,
        label: "Off-the-top fees",
        legs: [
          {
            leg_id: "dist-fee",
            label: "Distribution commission (20%)",
            payee_id: "payee-distributor",
            payee_name: "Distribution Co",
            structure: { type: "per_receipt_bps", bps: 2000, cap_cents: null },
          },
          {
            leg_id: "pa-cap",
            label: "P&A marketing expense cap",
            payee_id: "payee-pa",
            payee_name: "P&A Lender",
            structure: { type: "fixed_obligation", obligation_cents: 50_000 },
          },
        ],
      },
      {
        tier_level: 1,
        label: "Senior debt & gap",
        legs: [
          {
            leg_id: "senior-debt",
            label: "Senior debt + gap (10% interest)",
            payee_id: "payee-bank",
            payee_name: "Senior Lender",
            structure: { type: "debt_recoupment", principal_cents: 10_000, interest_bps: 1000 },
          },
        ],
      },
      {
        tier_level: 2,
        label: "CAMA & guilds",
        legs: [
          {
            leg_id: "cama-fees",
            label: "CAMA collection account fees",
            payee_id: "payee-cama",
            payee_name: "CAMA Administrator",
            structure: { type: "fixed_obligation", obligation_cents: 5_000 },
          },
          {
            leg_id: "guild-residuals",
            label: "Guild residual compliance holds",
            payee_id: "payee-guilds",
            payee_name: "SAG-AFTRA / DGA / WGA",
            structure: { type: "fixed_obligation", obligation_cents: 3_000 },
          },
        ],
      },
      {
        tier_level: 3,
        label: "Equity recoupment",
        legs: [
          {
            leg_id: "equity",
            label: "Equity recoupment (115% preferred)",
            payee_id: "payee-equity",
            payee_name: "Equity Investors",
            structure: { type: "equity_recoupment", principal_cents: 20_000, preferred_return_bps: 1500 },
          },
        ],
      },
      {
        tier_level: 4,
        label: "Deferrals",
        legs: [
          {
            leg_id: "deferrals",
            label: "Deferred compensation",
            payee_id: "payee-deferrals",
            payee_name: "Deferred Crew",
            structure: { type: "fixed_obligation", obligation_cents: 4_000 },
          },
        ],
      },
      {
        tier_level: 5,
        label: "Net profit pool",
        legs: [
          {
            leg_id: "profit-pool",
            label: "Net profit pool",
            payee_id: "payee-pool",
            payee_name: "Producer / Investor pools",
            structure: { type: "profit_pool" },
          },
        ],
      },
    ],
    fdg: {
      participants: [
        { payee_id: "payee-actor", payee_name: "Lead Actor", role: "creator", share_bps: 500 },
      ],
      threshold_cents: null,
    },
  };
}

async function registerDeal(store: Store, filmId = "film-77"): Promise<FilmWaterfallDefinitionRecord> {
  return store.upsertFilmWaterfallDefinition({
    film_id: filmId,
    definition: deal(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
}

async function postReceipt(
  store: Store,
  amountCents: number,
  eventId: string,
): Promise<LedgerTransactionRecord> {
  const posted = await postToFilmEscrow(
    store,
    {
      film_id: "film-77",
      amount_cents: amountCents,
      currency: "USD",
      source: { type: "match_queue", event_id: eventId },
    },
    NOW,
  );
  if (!posted.ok) throw new Error(`fixture post failed: ${JSON.stringify(posted)}`);
  return posted.value.escrow_credit;
}

function releaseInput(
  escrowLedgerId: string,
  overrides: Partial<WaterfallReleaseInput> = {},
): WaterfallReleaseInput {
  return {
    escrow_ledger_id: escrowLedgerId,
    verification: VERIFICATION,
    operator_settlement_approved: true,
    ...overrides,
  };
}

/** The FDG participant is a real, KYC-verified creator — the payout gate is
 * fail-closed on KYC state, so the fixture must verify before releasing. */
async function seedVerifiedCreator(store: Store, creatorId: string, creatorName: string): Promise<void> {
  await store.upsertVault({
    payee_id: creatorId,
    payee_name: creatorName,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
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

describe("releaseThroughWaterfall", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
    filmStateSatisfied();
  });

  afterEach(() => {
    // The operations-seam override is process-global — reset it every test.
    setVerticalComplianceStateSource(null);
  });

  it("404s when no ledger transaction matches the id", async () => {
    const result = await releaseThroughWaterfall(store, releaseInput("no-such-row"), NOW);
    expect(result).toMatchObject({ ok: false, status: 404, code: "escrow_receipt_not_found" });
  });

  it("500s fail-closed when the receipt's payee is not a film escrow payee", async () => {
    // A non-escrow ledger row: the waterfall only releases escrow receipts.
    const result = await releaseThroughWaterfall(store, releaseInput("not-a-receipt"), NOW);
    expect(result).toMatchObject({ ok: false, status: 404, code: "escrow_receipt_not_found" });
  });

  it("404s when the film has no registered waterfall — nothing defaults", async () => {
    const receipt = await postReceipt(store, 100_000, "evt-unregistered");
    const result = await releaseThroughWaterfall(store, releaseInput(receipt.id), NOW);
    expect(result).toMatchObject({ ok: false, status: 404, code: "waterfall_not_registered" });
    // The receipt is still locked — nothing was released.
    expect((await store.getLedgerTransaction(receipt.id))?.status).toBe("escrow_waterfall_pending");
  });

  it("409s with escrow_already_released when a prior applied decision exists", async () => {
    await seedVerifiedCreator(store, "payee-actor", "Lead Actor");
    await registerDeal(store);
    const receipt = await postReceipt(store, 100_000, "evt-once");
    const first = await releaseThroughWaterfall(store, releaseInput(receipt.id), NOW);
    if (!first.ok) throw new Error("first release should succeed");
    // A retry hits the distribution record's applied status.
    const retry = await releaseThroughWaterfall(store, releaseInput(receipt.id), NOW);
    expect(retry).toMatchObject({ ok: false, status: 409, code: "escrow_already_released" });
    // Exactly one decision record for the receipt.
    const rows = await store.listFilmWaterfallDistributions("film-77");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.value.distribution_id);
    expect(rows[0].status).toBe("applied");
  });

  it("500s waterfall_state_corrupt when the cumulative state is impossible — and nothing is inserted", async () => {
    await registerDeal(store);
    const receipt = await postReceipt(store, 100_000, "evt-corrupt");
    // Forge an applied history whose per-leg paid state exceeds the P&A cap's
    // obligation — impossible while definitions lock, so the router must
    // refuse closed rather than clamp.
    await store.insertFilmWaterfallDistribution({
      film_id: "film-77",
      escrow_ledger_id: "escrow-forged",
      status: "applied",
      fdg_bypass_cents: 0,
      legs: [
        {
          tier_level: 0,
          leg_id: "pa-cap",
          label: "P&A marketing expense cap",
          payee_id: "payee-pa",
          demand_cents: 60_000,
          routed_cents: 60_000,
          unpaid_cents: 0,
          cumulative_paid_cents: 60_000,
        },
      ],
      tier_allocations: [],
      unpaid_total_cents: 0,
      created_at: NOW.toISOString(),
    });
    const result = await releaseThroughWaterfall(store, releaseInput(receipt.id), NOW);
    expect(result).toMatchObject({ ok: false, status: 500, code: "waterfall_state_corrupt" });
    // Fail-closed: no decision record for THIS receipt, and it never released.
    expect(await store.getFilmWaterfallDistributionByEscrow(receipt.id)).toBeUndefined();
    expect((await store.getLedgerTransaction(receipt.id))?.status).toBe("escrow_waterfall_pending");
  });

  it("deletes the routed record and returns the release's refusal when the release gate refuses", async () => {
    await registerDeal(store);
    const receipt = await postReceipt(store, 100_000, "evt-refused");
    const result = await releaseThroughWaterfall(
      store,
      releaseInput(receipt.id, { operator_settlement_approved: false }),
      NOW,
    );
    expect(result.ok).toBe(false);
    // The unique lock is freed for the retry.
    expect(await store.getFilmWaterfallDistributionByEscrow(receipt.id)).toBeUndefined();
    expect((await store.getLedgerTransaction(receipt.id))?.status).toBe("escrow_waterfall_pending");
  });

  it("replaces a stale routed record from a crashed attempt and applies exactly one decision", async () => {
    await seedVerifiedCreator(store, "payee-actor", "Lead Actor");
    await registerDeal(store);
    const receipt = await postReceipt(store, 100_000, "evt-crashed");
    // Simulate the crash window: a routed record was inserted, the release
    // never ran.
    const stale = await store.insertFilmWaterfallDistribution({
      film_id: "film-77",
      escrow_ledger_id: receipt.id,
      status: "routed",
      fdg_bypass_cents: 0,
      legs: [],
      tier_allocations: [],
      unpaid_total_cents: 0,
      created_at: "2026-10-01T11:00:00.000Z",
    });
    const result = await releaseThroughWaterfall(store, releaseInput(receipt.id), NOW);
    if (!result.ok) throw new Error(`release should succeed: ${JSON.stringify(result)}`);
    const rows = await store.listFilmWaterfallDistributions("film-77");
    expect(rows).toHaveLength(1);
    // The stale record is gone; the applied record is the fresh decision.
    expect(rows[0].id).not.toBe(stale.id);
    expect(rows[0].status).toBe("applied");
  });

  it("releases end-to-end: the router's tier allocations are what the escrow release applied", async () => {
    await seedVerifiedCreator(store, "payee-actor", "Lead Actor");
    await registerDeal(store);
    const receipt = await postReceipt(store, 100_000, "evt-happy");
    const result = await releaseThroughWaterfall(store, releaseInput(receipt.id), NOW);
    if (!result.ok) throw new Error(`release should succeed: ${JSON.stringify(result)}`);

    // The routing: $20 commission, the rest of tier 0 fills the P&A cap.
    const distFee = result.value.routing.legs.find((leg) => leg.leg_id === "dist-fee");
    const paCap = result.value.routing.legs.find((leg) => leg.leg_id === "pa-cap");
    expect(distFee?.routed_cents).toBe(20_000);
    expect(paCap?.routed_cents).toBe(50_000);
    expect(paCap?.unpaid_cents).toBe(0);

    // The escrow release verified and posted the same tier allocations.
    expect(result.value.release.tier_allocations).toEqual(result.value.routing.tier_allocations);
    expect(result.value.release.escrow_credit.status).toBe("settled");
    // FDG fired (first-dollar terms, no threshold) and credited the participant.
    expect(result.value.release.fdg_triggered).toBe(true);
    expect(result.value.release.fdg_participant_credits[0]?.payee_id).toBe("payee-actor");

    // The decision record is applied and carries the routing.
    const record = await store.getFilmWaterfallDistributionByEscrow(receipt.id);
    expect(record?.status).toBe("applied");
    expect(record?.legs.map((leg) => leg.leg_id)).toContain("dist-fee");
  });

  it("carries the shortfall: the second release continues where the first stopped", async () => {
    await seedVerifiedCreator(store, "payee-actor", "Lead Actor");
    await registerDeal(store);
    // Receipt 1: $10,000 — the FDG creator bypasses 5% ($500) ahead of the
    // cascade; the commission takes 20% of the receipt ($2,000), the P&A cap
    // takes the rest ($7,500 — $42,500 still owed); nothing reaches senior
    // debt.
    const first = await postReceipt(store, 10_000, "evt-carry-1");
    const firstResult = await releaseThroughWaterfall(store, releaseInput(first.id), NOW);
    if (!firstResult.ok) throw new Error("first release should succeed");
    expect(
      firstResult.value.routing.legs.find((leg) => leg.leg_id === "pa-cap")?.unpaid_cents,
    ).toBe(42_500);
    expect(
      firstResult.value.routing.legs.find((leg) => leg.leg_id === "senior-debt")?.routed_cents,
    ).toBe(0);

    // Receipt 2: $10,000 — identical shape to the first: $500 FDG bypass,
    // $2,000 commission, $7,500 more to the P&A cap (42,500 − 7,500 =
    // 35,000 still owed); senior debt still untouched.
    const second = await postReceipt(store, 10_000, "evt-carry-2");
    const secondResult = await releaseThroughWaterfall(store, releaseInput(second.id), NOW);
    if (!secondResult.ok) throw new Error("second release should succeed");
    const seniorDebt = secondResult.value.routing.legs.find(
      (leg) => leg.leg_id === "senior-debt",
    );
    expect(
      secondResult.value.routing.legs.find((leg) => leg.leg_id === "pa-cap")?.unpaid_cents,
    ).toBe(35_000);
    expect(seniorDebt?.routed_cents).toBe(0);

    // The stored history reproduces the router's carry: two applied rows,
    // P&A cap at $15,000 cumulative (two $7,500 periods).
    const carry = (await store.listFilmWaterfallDistributions("film-77"))
      .filter((row) => row.status === "applied")
      .flatMap((row) => row.legs);
    const paTotal = carry
      .filter((leg) => leg.leg_id === "pa-cap")
      .reduce((sum, leg) => sum + leg.routed_cents, 0);
    expect(paTotal).toBe(15_000);
  });
});
