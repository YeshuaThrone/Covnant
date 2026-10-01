// Esports prize-pool escrow (PR 14) — the store-backed battery.
//
// Locked invariants under test, per the founder esports directive: a
// tournament organizer's prize-pool remittance LOCKS in a per-batch escrow
// (kind and status both 'esports_prize_pool_pending' — out of every vault,
// out of UNCLAIMED_HOLDING, out of the film escrow) with one FBO debit and
// one escrow-credit GL journal, replay-guarded per source; release runs the
// sequential recoupment waterfall ONLY after the roster contract validates,
// every credited party passes the fail-closed payout compliance gate, and
// the CAS flip has WON before any money moves; withholding applies to
// playing roles only; allocation dust sweeps to company variance; mandated
// expenses the pool cannot cover are REPORTED (unrecouped_cents), never
// hidden; a refused release moves NO money.

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  batchIdFromEscrowPayeeId,
  postToEsportsPoolEscrow,
  releaseEsportsPrizePool,
  type EsportsPoolReceiptSource,
} from "@/lib/server/esportsPoolEscrow";
import {
  esportsPoolEscrowGlAccount,
  esportsPoolEscrowPayeeId,
  esportsPoolEscrowPayeeName,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-10-01T12:00:00Z");
const BATCH = "founder-cup-2026-main";

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
  result: Success<V> | Failure | { ok: true },
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

async function seedVerifiedParty(
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
  await store.insertKycVerification({
    creator_id: payeeId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: payeeId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
}

/** The livestream vertical's compliance state, fully satisfied. */
function livestreamStateSatisfied(): void {
  setVerticalComplianceStateSource(async () => ({
    vertical: "livestream",
    stream_platform_payout_reconciled: true,
    tax_withholding_verified: true,
  }));
}

/** Two starters + one coach summing to exactly 10000 bps (no dust). */
function rosterNoDust() {
  return [
    { payeeId: "payee-starter-one", payeeName: "Starter One", role: "starter" as const, shareBps: 5000 },
    { payeeId: "payee-starter-two", payeeName: "Starter Two", role: "starter" as const, shareBps: 3000 },
    { payeeId: "payee-coach", payeeName: "Coach", role: "coach" as const, shareBps: 2000 },
  ];
}

async function seedFullyVerifiedScenario(store: Store): Promise<void> {
  livestreamStateSatisfied();
  await seedVerifiedParty(store, "payee-org", "Founder Org Esports");
  for (const member of rosterNoDust()) {
    await seedVerifiedParty(store, member.payeeId, member.payeeName);
  }
}

async function postPool(
  store: Store,
  amountCents: number,
  source: EsportsPoolReceiptSource = { type: "recon_job", job_id: "job-77" },
) {
  return postToEsportsPoolEscrow(
    store,
    { batch: BATCH, amount_cents: amountCents, currency: "USD", source },
    NOW,
  );
}

const POOL_CENTS = 100_000; // $1,000.00
// $1,000 pool − $500 venue = $500; org 1500bps = $75; roster pool $425
// split 50/30/20 = $212.50 + $127.50 + $85 — exact, zero dust.
const VENUE_CENTS = 50_000;

function releaseInput(
  escrowLedgerId: string,
  overrides: Partial<Parameters<typeof releaseEsportsPrizePool>[1]> = {},
): Parameters<typeof releaseEsportsPrizePool>[1] {
  return {
    escrow_ledger_id: escrowLedgerId,
    orgPayeeId: "payee-org",
    orgPayeeName: "Founder Org Esports",
    orgCutBps: 1500,
    venueExpenseCents: VENUE_CENTS,
    travelExpenseCents: 0,
    venueMandated: true,
    travelMandated: false,
    roster: rosterNoDust(),
    operator_settlement_approved: true,
    ...overrides,
  };
}

afterEach(() => {
  setVerticalComplianceStateSource(null);
});

// ---------------------------------------------------------------------------
// Posting — the lock.
// ---------------------------------------------------------------------------

describe("postToEsportsPoolEscrow — locking a remittance", () => {
  it("locks the receipt out of every vault with one FBO debit and one escrow credit", async () => {
    const store = new InMemoryStore();
    const posted = mustSucceed(await postPool(store, POOL_CENTS));

    const credit = posted.escrow_credit;
    expect(credit.kind).toBe("esports_prize_pool_pending");
    expect(credit.status).toBe("esports_prize_pool_pending");
    expect(credit.amount_cents).toBe(POOL_CENTS);
    expect(credit.payee_id).toBe(esportsPoolEscrowPayeeId(BATCH));
    expect(credit.payee_name).toBe(esportsPoolEscrowPayeeName(BATCH));
    expect(batchIdFromEscrowPayeeId(credit.payee_id)).toBe(BATCH);

    // The journal: FBO debit + the batch's escrow credit — nothing else.
    const legs = await store.listGlEntriesByJournal(posted.journal_id);
    expect(legs).toHaveLength(2);
    const fbo = legs.find((leg) => leg.account === "fbo_cash")!;
    expect(fbo.debit_cents).toBe(POOL_CENTS);
    expect(fbo.credit_cents).toBe(0);
    const escrow = legs.find(
      (leg) => leg.account === esportsPoolEscrowGlAccount(BATCH),
    )!;
    expect(escrow.credit_cents).toBe(POOL_CENTS);
    expect(escrow.debit_cents).toBe(0);

    // No vault was minted for the escrow payee.
    expect(await store.getVault(esportsPoolEscrowPayeeId(BATCH))).toBeUndefined();
  });

  it("stamps a match_queue-sourced receipt with the quarantined line's event id", async () => {
    const store = new InMemoryStore();
    const posted = mustSucceed(
      await postPool(store, POOL_CENTS, {
        type: "match_queue",
        event_id: "evt-quarantined-1",
      }),
    );
    expect(posted.escrow_credit.line_item_id).toBe("evt-quarantined-1");
  });

  it("refuses a replayed source — the remittance posts once", async () => {
    const store = new InMemoryStore();
    const source: EsportsPoolReceiptSource = { type: "recon_job", job_id: "job-77" };
    mustSucceed(await postPool(store, POOL_CENTS, source));
    mustFail(await postPool(store, POOL_CENTS, source), 409, "esports_pool_receipt_already_posted");
  });

  it("refuses an unnamed batch and a non-positive amount", async () => {
    const store = new InMemoryStore();
    mustFail(
      await postToEsportsPoolEscrow(
        store,
        { batch: "  ", amount_cents: POOL_CENTS, currency: "USD", source: { type: "manual", note: "x" } },
        NOW,
      ),
      422,
      "invalid_prize_pool_batch",
    );
    mustFail(await postPool(store, 0), 422, "invalid_amount");
    mustFail(await postPool(store, 1.5), 422, "invalid_amount");
  });
});

// ---------------------------------------------------------------------------
// Release — the waterfall behind the gates.
// ---------------------------------------------------------------------------

describe("releaseEsportsPrizePool — the gated waterfall", () => {
  it("releases through venue recoupment, the org cut, and the roster split with zero dust", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postPool(store, POOL_CENTS));

    const released = mustSucceed(
      await releaseEsportsPrizePool(store, releaseInput(posted.escrow_credit.id), NOW),
    );

    // Every step's integer-cent outcome.
    expect(released.plan.venuePaidCents).toBe(50_000);
    expect(released.plan.orgPaidCents).toBe(7_500);
    expect(released.plan.rosterPoolCents).toBe(42_500);
    expect(released.roster_credits.map((credit) => credit.net_cents)).toEqual([
      21_250, 12_750, 8_500,
    ]);
    expect(released.company_dust_cents).toBe(0);
    expect(released.unrecouped_cents).toBe(0);

    // The escrow row settled; the kind still names the pool.
    expect(released.escrow_credit.status).toBe("settled");
    expect(released.escrow_credit.kind).toBe("esports_prize_pool_pending");

    // Verified tax profiles → no withholding on any member.
    for (const credit of released.roster_credits) {
      expect(credit.net_cents).toBe(credit.gross_cents);
    }

    // The release journal exists and no dust row rode the release.
    expect(released.journal_id).not.toBe("");
    expect(released.dust_ledger).toHaveLength(0);
  });

  it("splits by role — substitutes and coaches take their contractual shares", async () => {
    const store = new InMemoryStore();
    livestreamStateSatisfied();
    await seedVerifiedParty(store, "payee-org", "Founder Org Esports");
    for (const member of [
      { payeeId: "payee-starter", payeeName: "Starter", role: "starter" as const, shareBps: 7000 },
      { payeeId: "payee-sub", payeeName: "Sub", role: "substitute" as const, shareBps: 1500 },
      { payeeId: "payee-analyst", payeeName: "Analyst", role: "analyst" as const, shareBps: 1500 },
    ]) {
      await seedVerifiedParty(store, member.payeeId, member.payeeName);
    }
    const posted = mustSucceed(await postPool(store, POOL_CENTS));
    const released = mustSucceed(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, {
          roster: [
            { payeeId: "payee-starter", payeeName: "Starter", role: "starter", shareBps: 7000 },
            { payeeId: "payee-sub", payeeName: "Sub", role: "substitute", shareBps: 1500 },
            { payeeId: "payee-analyst", payeeName: "Analyst", role: "analyst", shareBps: 1500 },
          ],
        }),
        NOW,
      ),
    );
    // Roster pool $425: 70% = $297.50, 15% = $63.75 ×2 (floor at the sub-cent).
    expect(released.roster_credits.map((credit) => credit.gross_cents)).toEqual([
      29_750, 6_375, 6_375,
    ]);
    // $297.50 + $63.75 + $63.75 = $425.00 exactly — the dust residue is zero.
    expect(released.company_dust_cents).toBe(0);
  });

  it("moves NO money when the operator has not approved settlement", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postPool(store, POOL_CENTS));

    mustFail(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, { operator_settlement_approved: false }),
        NOW,
      ),
      403,
      "settlement_not_approved",
    );

    // The receipt is still locked; no org or roster vault was credited.
    const row = await store.getLedgerTransaction(posted.escrow_credit.id);
    expect(row!.status).toBe("esports_prize_pool_pending");
    expect((await store.getVault("payee-org"))!.available_balance).toBe(0);
    expect((await store.getVault("payee-starter-one"))!.available_balance).toBe(0);
  });

  it("refuses a roster whose shares do not sum to 10000 bps before any money moves", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postPool(store, POOL_CENTS));

    mustFail(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, {
          roster: rosterNoDust().map((member) => ({ ...member, shareBps: 1000 })),
        }),
        NOW,
      ),
      422,
      "invalid_roster_share_sum",
    );
    expect((await store.getLedgerTransaction(posted.escrow_credit.id))!.status).toBe(
      "esports_prize_pool_pending",
    );
  });

  it("refuses an org cut outside the 15-30% band", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postPool(store, POOL_CENTS));

    mustFail(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, { orgCutBps: 1400 }),
        NOW,
      ),
      422,
      "invalid_org_cut_bps",
    );
    mustFail(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, { orgCutBps: 3100 }),
        NOW,
      ),
      422,
      "invalid_org_cut_bps",
    );
  });

  it("reports a mandated expense the pool cannot cover instead of hiding it", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    // A $2,000 pool cannot cover a $2,500 mandated venue fee.
    const posted = mustSucceed(
      await postPool(store, 200_000, { type: "recon_job", job_id: "job-91" }),
    );
    const released = mustSucceed(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, { venueExpenseCents: 250_000 }),
        NOW,
      ),
    );
    expect(released.unrecouped_cents).toBe(50_000);
    // Nothing downstream of the shortfall moved: no org cut, no roster pay.
    expect(released.plan.orgPaidCents).toBe(0);
    expect(released.roster_credits.every((credit) => credit.net_cents === 0)).toBe(true);
  });

  it("ignores an expense that is not contractually mandated", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postPool(store, POOL_CENTS));
    const released = mustSucceed(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, {
          venueExpenseCents: 0,
          venueMandated: false,
        }),
        NOW,
      ),
    );
    // The full pool flows past the venue step.
    expect(released.plan.venuePaidCents).toBe(0);
    expect(released.plan.orgPaidCents).toBe(15_000); // 1500bps of $1,000
    expect(released.plan.rosterPoolCents).toBe(85_000);
  });

  it("is fail-closed on an unverified roster member — the whole release refuses", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    // The coach exists but never verified KYC.
    await store.upsertVault({
      payee_id: "payee-ghost",
      payee_name: "Ghost",
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
      updated_at: NOW.toISOString(),
    });
    const posted = mustSucceed(await postPool(store, POOL_CENTS));

    mustFail(
      await releaseEsportsPrizePool(
        store,
        releaseInput(posted.escrow_credit.id, {
          roster: [
            ...rosterNoDust(),
            { payeeId: "payee-ghost", payeeName: "Ghost", role: "starter" as const, shareBps: 0 },
          ].map((member) =>
            member.payeeId === "payee-ghost"
              ? { ...member, shareBps: 1000 }
              : { ...member, shareBps: 3000 },
          ),
        }),
        NOW,
      ),
      403,
      "kyc_state_unknown",
    );
    expect((await store.getLedgerTransaction(posted.escrow_credit.id))!.status).toBe(
      "esports_prize_pool_pending",
    );
  });

  it("refuses a second release — the CAS guard keeps the receipt single-spent", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postPool(store, POOL_CENTS));
    mustSucceed(
      await releaseEsportsPrizePool(store, releaseInput(posted.escrow_credit.id), NOW),
    );
    mustFail(
      await releaseEsportsPrizePool(store, releaseInput(posted.escrow_credit.id), NOW),
      409,
      "escrow_already_released",
    );
  });

  it("refuses rows that are not locked pool receipts", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    mustFail(
      await releaseEsportsPrizePool(
        store,
        releaseInput("no-such-ledger-row"),
        NOW,
      ),
      404,
      "escrow_receipt_not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// The escrow row's lifecycle through the store's own seams.
// ---------------------------------------------------------------------------

describe("esports pool escrow — store seams", () => {
  it("lists locked receipts newest-first and leaves released ones off the list", async () => {
    const store = new InMemoryStore();
    livestreamStateSatisfied();
    await seedVerifiedParty(store, "payee-org", "Founder Org Esports");
    for (const member of rosterNoDust()) {
      await seedVerifiedParty(store, member.payeeId, member.payeeName);
    }
    const first = mustSucceed(
      await postPool(store, 50_000, { type: "recon_job", job_id: "job-81" }),
    );
    const second = mustSucceed(
      await postPool(store, 25_000, { type: "recon_job", job_id: "job-82" }),
    );

    const locked = await store.listEsportsPoolEscrowCredits();
    expect(locked.map((row: LedgerTransactionRecord) => row.id)).toEqual([
      second.escrow_credit.id,
      first.escrow_credit.id,
    ]);

    mustSucceed(
      await releaseEsportsPrizePool(store, releaseInput(first.escrow_credit.id), NOW),
    );
    const stillLocked = await store.listEsportsPoolEscrowCredits();
    expect(stillLocked.map((row: LedgerTransactionRecord) => row.id)).toEqual([
      second.escrow_credit.id,
    ]);
  });
});
