// The foreign-tax hold and book returns-reserve lanes (PR 27) — the
// in-memory battery.
//
// Locked invariants under test, per the founder directive: a FOREIGN print
// royalty freezes on arrival (foreign_tax_hold) and only VERIFIED
// withholding-tax-credit evidence of record thaws it (absent, pending, and
// failed all refuse — fail-closed); the book returns reserve reuses PR 23's
// configurable mechanics inside the founder bands (15–20% rate, 90–120 day
// window — refused, never clipped); publisher returns and chargebacks draw
// held reserves FIFO first, and only the still-outstanding remainder
// offsets against the incoming POD net BEFORE an author payout releases;
// the publishing payout gate's states (return_reserve_period_elapsed,
// isbn_rights_verified) are DERIVED from durable sources and refuse on
// every absent path; and the Don invariants hold throughout — integer
// cents, every journal balanced, allocations + dust + recovery = the held
// amount, replay-guarded and concurrency-guarded transitions.

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  drawDownBookReturnChargeback,
  lockBookReturnsReserve,
  postForeignPrintRoyaltyToHold,
  recordWithholdingTaxCreditVerification,
  registerBookReturnsReservePolicy,
  releaseBookPrintNet,
  releaseForeignTaxHolds,
  resolvePublishingGateState,
} from "@/lib/server/bookReturnsReserve";
import { postToUnclaimedHolding, releaseUnclaimedHolding } from "@/lib/server/unclaimedHolding";
import { verifyPublishingIpRights } from "@/modules/compliance/publishingIpRights";
import {
  BOOK_RETURNS_RESERVE_MIN_RATE_BPS,
  UNCLAIMED_HOLDING_PAYEE_ID,
  bookReturnsReservePayeeId,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-09-30T12:00:00Z");
const LATER = new Date("2026-09-30T12:01:00Z");
/** One day past a 90-day window measured from NOW. */
const AGED = new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000);

const ISBN = "9780321573516";
const CREATOR = "creator_x";
const CREATOR_NAME = "Creator X";

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
  creatorId: string = CREATOR,
  creatorName: string = CREATOR_NAME,
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

async function seedBookPolicy(
  store: Store,
  rateBps: number = 1_500,
  windowDays: number = 90,
): Promise<void> {
  mustSucceed(
    await registerBookReturnsReservePolicy(
      store,
      {
        isbn: ISBN,
        reserve_rate_bps: rateBps,
        reserve_window_days: windowDays,
        beneficiary_payee_id: CREATOR,
        beneficiary_payee_name: CREATOR_NAME,
      },
      NOW,
    ),
  );
}

/** The verified rights chain of record for the ISBN. */
async function seedIsbnRights(
  store: Store,
  state: "failed" | "pending" | "verified" = "verified",
): Promise<void> {
  await store.upsertIsbnRightsVerification({
    isbn: ISBN,
    state,
    evidence_ref: "rights-chain-ref-1",
    verified_by: "rights-desk",
    verified_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
}

/** The option agreement of record the IP clearance verifies against. */
async function seedOptionAgreement(store: Store): Promise<void> {
  await store.upsertIpOptionAgreement({
    work_id: ISBN,
    author_payee_id: CREATOR,
    author_payee_name: CREATOR_NAME,
    agency_payee_id: "agency_a",
    agency_payee_name: "Agency A",
    agency_commission_bps: 1_500,
    option_deal_ref: "option-deal-1",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
}

async function clearCreatorIpRights(
  store: Store,
  payeeId: string,
  payeeName: string,
): Promise<void> {
  const verified = await verifyPublishingIpRights(
    store,
    {
      payee_id: payeeId,
      work_id: ISBN,
      state: "cleared",
      evidence_ref: `ip-clearance-${payeeId}`,
    },
    NOW.toISOString(),
  );
  if (!verified.ok) {
    throw new Error(`seed failed: ${JSON.stringify(verified)}`);
  }
  void payeeName;
}

/**
 * The PR 26 seam: matched book print nets park in unclaimed holding
 * through postToUnclaimedHolding — the lanes under test consume that
 * credit. Match-queue sources carry the line-item linkage the lock's
 * crash-replay re-derivation needs (production nets always have one).
 */
let heldNetSeq = 0;
async function seedHeldPrintNet(
  store: Store,
  amountCents: number,
  at: Date = NOW,
): Promise<{ id: string }> {
  heldNetSeq += 1;
  const posted = mustSucceed(
    await postToUnclaimedHolding(
      store,
      {
        amount_cents: amountCents,
        currency: "USD",
        source: { type: "match_queue", event_id: `pod-net-${heldNetSeq}` },
      },
      at,
    ),
  );
  return { id: posted.holding_credit.id };
}

/** The complete happy-path setup: everything the release gates read. */
async function seedGatedTitle(store: Store): Promise<void> {
  await seedVerifiedCreator(store);
  await seedOptionAgreement(store);
  await clearCreatorIpRights(store, CREATOR, CREATOR_NAME);
  await seedIsbnRights(store);
  await seedBookPolicy(store);
}

function fullCreatorSplits(): [
  { payee_id: string; payee_name: string; role: "creator"; share_bps: number },
] {
  return [{ payee_id: CREATOR, payee_name: CREATOR_NAME, role: "creator", share_bps: 10_000 }];
}

/** The frozen credits in one country/tax-year scope. */
async function heldInScope(store: Store, scope: string) {
  return (await store.listForeignTaxHolds()).filter(
    (row) => row.split_run_id === scope,
  );
}

/** Locks one held net and returns the lock result (re-parked credit inside). */
async function lockHeldNet(store: Store, heldId: string, at: Date = NOW) {
  return mustSucceed(
    await lockBookReturnsReserve(store, { holding_ledger_id: heldId, isbn: ISBN }, at),
  );
}

afterEach(() => {
  // The operations-seam override is process-global — reset it every test.
  setVerticalComplianceStateSource(null);
});

// ---------------------------------------------------------------------------
// Lanes 1–3: the foreign-tax hold and its verified-credit-only exit.
// ---------------------------------------------------------------------------

describe("postForeignPrintRoyaltyToHold", () => {
  it("freezes the royalty on arrival: foreign_tax_hold status, holding kind, scoped linkage, balanced journal", async () => {
    const store = new InMemoryStore();
    const result = mustSucceed(
      await postForeignPrintRoyaltyToHold(
        store,
        {
          amount_cents: 3_000,
          currency: "GBP",
          country_code: "gb",
          tax_year: 2026,
          source: { type: "match_queue", event_id: "evt-gb-1" },
        },
        NOW,
      ),
    );
    expect(result.scope).toBe("foreign_tax:GB:2026");
    const credit = result.holding_credit;
    expect(credit.kind).toBe("unclaimed_holding");
    expect(credit.status).toBe("foreign_tax_hold");
    expect(credit.split_run_id).toBe("foreign_tax:GB:2026");
    expect(credit.amount_cents).toBe(3_000);
    expect(credit.settled_at).toBeNull();
    // Holding is not a balance — no vault minted for the sentinel.
    expect(await store.getVault(UNCLAIMED_HOLDING_PAYEE_ID)).toBeUndefined();

    // The distinct journal kind is the audit trail; the GL legs are the
    // same FBO debit / holding credit a plain post rides.
    const entries = await store.listGlEntriesByJournal(result.journal_id);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(3_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(3_000);
  });

  it("refuses a malformed scope or amount before anything moves", async () => {
    const store = new InMemoryStore();
    mustFail(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "USD",
        country_code: "USA",
        tax_year: 2026,
        source: { type: "manual", note: "x" },
      }, NOW),
      422,
      "invalid_country_code",
    );
    mustFail(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "USD",
        country_code: "GB",
        tax_year: 1999,
        source: { type: "manual", note: "x" },
      }, NOW),
      422,
      "invalid_tax_year",
    );
    mustFail(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 0,
        currency: "USD",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "manual", note: "x" },
      }, NOW),
      422,
      "invalid_amount",
    );
    // Nothing froze on any refusal.
    expect((await heldInScope(store, "foreign_tax:GB:2026")).length).toBe(0);
  });

  it("refuses a replayed post for the same source id (409)", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "GBP",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "match_queue", event_id: "evt-gb-1" },
      }, NOW),
    );
    mustFail(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "GBP",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "match_queue", event_id: "evt-gb-1" },
      }, LATER),
      409,
      "foreign_tax_hold_already_posted",
    );
  });
});

describe("releaseForeignTaxHolds", () => {
  it("refuses with no verification of record — the freeze holds (fail-closed)", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "GBP",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "manual", note: "x" },
      }, NOW),
    );
    mustFail(
      await releaseForeignTaxHolds(store, { country_code: "GB", tax_year: 2026 }),
      403,
      "withholding_credit_not_verified",
    );
    // The credit is still frozen.
    const frozen = await heldInScope(store, "foreign_tax:GB:2026");
    expect(frozen.length).toBe(1);
    expect(frozen[0]?.status).toBe("foreign_tax_hold");
  });

  it("refuses on pending and failed evidence — only verified thaws", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "GBP",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "manual", note: "x" },
      }, NOW),
    );
    mustSucceed(
      await recordWithholdingTaxCreditVerification(store, {
        country_code: "GB",
        tax_year: 2026,
        state: "pending",
      }, NOW),
    );
    mustFail(
      await releaseForeignTaxHolds(store, { country_code: "GB", tax_year: 2026 }),
      403,
      "withholding_credit_not_verified",
    );
    mustSucceed(
      await recordWithholdingTaxCreditVerification(store, {
        country_code: "GB",
        tax_year: 2026,
        state: "failed",
      }, LATER),
    );
    mustFail(
      await releaseForeignTaxHolds(store, { country_code: "GB", tax_year: 2026 }),
      403,
      "withholding_credit_not_verified",
    );
  });

  it("thaws ONLY the exact scope on verified evidence (US-UK treaty example) and re-runs as an honest no-op", async () => {
    const store = new InMemoryStore();
    const gb2026 = mustSucceed(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "GBP",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "manual", note: "UK print net" },
      }, NOW),
    );
    // Neighbor scopes stay frozen — different country, different year.
    await postForeignPrintRoyaltyToHold(store, {
      amount_cents: 1_000,
      currency: "EUR",
      country_code: "DE",
      tax_year: 2026,
      source: { type: "manual", note: "DE print net" },
    }, NOW);
    await postForeignPrintRoyaltyToHold(store, {
      amount_cents: 500,
      currency: "GBP",
      country_code: "GB",
      tax_year: 2025,
      source: { type: "manual", note: "UK prior year" },
    }, NOW);

    // The evidence upsert requires the provenance triple for 'verified'.
    mustFail(
      await recordWithholdingTaxCreditVerification(store, {
        country_code: "GB",
        tax_year: 2026,
        state: "verified",
      }, NOW),
      422,
      "withholding_credit_verification_incomplete",
    );
    mustSucceed(
      await recordWithholdingTaxCreditVerification(store, {
        country_code: "GB",
        tax_year: 2026,
        state: "verified",
        treaty_ref: "US-UK treaty art. 12",
        evidence_ref: "hmrc-credit-note-2026",
        verified_by: "tax-desk",
      }, LATER),
    );

    const released = mustSucceed(
      await releaseForeignTaxHolds(store, { country_code: "gb", tax_year: 2026 }),
    );
    expect(released.thawed).toBe(1);
    // Exactly the GB/2026 leg returned to holding.
    const thawed = await store.getLedgerTransaction(gb2026.holding_credit.id);
    expect(thawed?.status).toBe("unclaimed_holding");
    expect(
      (await heldInScope(store, "foreign_tax:DE:2026")).length,
    ).toBe(1);
    expect(
      (await heldInScope(store, "foreign_tax:GB:2025")).length,
    ).toBe(1);
    // A re-run is an honest no-op — nothing left in that scope to thaw.
    const rerun = mustSucceed(
      await releaseForeignTaxHolds(store, { country_code: "GB", tax_year: 2026 }),
    );
    expect(rerun.thawed).toBe(0);
  });

  it("a release attempt NEVER unfreezes: every consuming lane refuses frozen credits; the verified thaw is the only exit", async () => {
    const store = new InMemoryStore();
    const posted = mustSucceed(
      await postForeignPrintRoyaltyToHold(store, {
        amount_cents: 3_000,
        currency: "GBP",
        country_code: "GB",
        tax_year: 2026,
        source: { type: "manual", note: "x" },
      }, NOW),
    );
    await seedVerifiedCreator(store);
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: posted.holding_credit.id,
          splits: fullCreatorSplits(),
          operator_settlement_approved: true,
          vertical: "publishing",
        },
        LATER,
      ),
      403,
      "foreign_tax_hold",
    );
    // The reserve-lock lane refuses frozen credits too.
    mustFail(
      await lockBookReturnsReserve(
        store,
        { holding_ledger_id: posted.holding_credit.id, isbn: ISBN },
        LATER,
      ),
      403,
      "foreign_tax_hold",
    );
    // The book release lane refuses frozen credits as well.
    mustFail(
      await releaseBookPrintNet(
        store,
        {
          holding_ledger_id: posted.holding_credit.id,
          isbn: ISBN,
          splits: [],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      403,
      "foreign_tax_hold",
    );
    // Still frozen after every attempt.
    expect(
      (await heldInScope(store, "foreign_tax:GB:2026")).length,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lane 4: the returns-reserve policy of record — the founder bands.
// ---------------------------------------------------------------------------

describe("registerBookReturnsReservePolicy", () => {
  it("refuses rates and windows outside the founder bands — refused, never clipped", async () => {
    const store = new InMemoryStore();
    for (const rate of [BOOK_RETURNS_RESERVE_MIN_RATE_BPS - 1, 2_001]) {
      mustFail(
        await registerBookReturnsReservePolicy(store, {
          isbn: ISBN,
          reserve_rate_bps: rate,
          reserve_window_days: 90,
          beneficiary_payee_id: CREATOR,
          beneficiary_payee_name: CREATOR_NAME,
        }, NOW),
        422,
        "reserve_rate_out_of_band",
      );
    }
    for (const window of [89, 121]) {
      mustFail(
        await registerBookReturnsReservePolicy(store, {
          isbn: ISBN,
          reserve_rate_bps: 1_500,
          reserve_window_days: window,
          beneficiary_payee_id: CREATOR,
          beneficiary_payee_name: CREATOR_NAME,
        }, NOW),
        422,
        "reserve_window_out_of_band",
      );
    }
  });

  it("accepts the band edges and replaces the terms of record on re-registration", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await registerBookReturnsReservePolicy(store, {
        isbn: ISBN,
        reserve_rate_bps: 1_500,
        reserve_window_days: 120,
        beneficiary_payee_id: CREATOR,
        beneficiary_payee_name: CREATOR_NAME,
      }, NOW),
    );
    mustSucceed(
      await registerBookReturnsReservePolicy(store, {
        isbn: ISBN,
        reserve_rate_bps: 2_000,
        reserve_window_days: 90,
        beneficiary_payee_id: CREATOR,
        beneficiary_payee_name: CREATOR_NAME,
      }, LATER),
    );
    const policy = await store.getBookReturnsReservePolicy(ISBN);
    expect(policy?.reserve_rate_bps).toBe(2_000);
    expect(policy?.reserve_window_days).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Lane 5: the reserve lock — split, linkage, replay, concurrency.
// ---------------------------------------------------------------------------

describe("lockBookReturnsReserve", () => {
  it("refuses without a policy of record — the rate never comes from the caller", async () => {
    const store = new InMemoryStore();
    const held = await seedHeldPrintNet(store, 5_000);
    mustFail(
      await lockBookReturnsReserve(store, { holding_ledger_id: held.id, isbn: ISBN }, LATER),
      422,
      "missing_book_returns_reserve_policy",
    );
  });

  it("splits the held net inside the band: reserve credit under the ISBN sentinel, remainder re-parked with the lock linkage", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    const result = await lockHeldNet(store, held.id, LATER);
    expect(result.replayed).toBe(false);

    // The reserve share: 15% of 5,000.
    const reserve = result.reserve_credit;
    expect(reserve.kind).toBe("book_returns_reserve");
    expect(reserve.status).toBe("book_returns_reserve");
    expect(reserve.amount_cents).toBe(750);
    expect(reserve.payee_id).toBe(bookReturnsReservePayeeId(ISBN));
    expect(reserve.split_run_id).toBe(held.id);

    // The remainder re-parks in holding, findable by its scope linkage.
    const reparked = result.reparked_credit;
    expect(reparked).toBeDefined();
    expect(reparked?.kind).toBe("unclaimed_holding");
    expect(reparked?.status).toBe("unclaimed_holding");
    expect(reparked?.amount_cents).toBe(4_250);
    expect(reparked?.split_run_id).toBe(`book_reserve_lock:${ISBN}:${held.id}`);

    // The Don invariant: allocation = reserve + remainder, dust zero.
    expect(reserve.amount_cents + (reparked?.amount_cents ?? 0)).toBe(5_000);

    // The dispatch journal balances.
    expect(result.journal_id).toBeDefined();
    const entries = await store.listGlEntriesByJournal(result.journal_id as string);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(5_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(5_000);
  });

  it("keeps integer cents on non-round nets — the remainder takes the floor's dust", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 9_999);
    const result = await lockHeldNet(store, held.id, LATER);
    expect(Number.isInteger(result.reserve_credit.amount_cents)).toBe(true);
    expect(Number.isInteger(result.reparked_credit?.amount_cents ?? 0)).toBe(true);
    // 15% of 9,999 floors to 1,499; the re-parked remainder carries the rest.
    expect(result.reserve_credit.amount_cents).toBe(1_499);
    expect(result.reserve_credit.amount_cents + (result.reparked_credit?.amount_cents ?? 0)).toBe(9_999);
  });

  it("replays as the counted no-op — the same reserve credit, no new money", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    const first = await lockHeldNet(store, held.id, LATER);
    const second = await lockHeldNet(store, held.id, LATER);
    expect(second.replayed).toBe(true);
    expect(second.reserve_credit.id).toBe(first.reserve_credit.id);
    expect(second.reparked_credit?.id).toBe(first.reparked_credit?.id);
    expect(second.journal_id).toBeUndefined();
  });

  it("refuses the concurrent lock after another lane consumed the credit (409)", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    // The CAS loses to a settle that never left children.
    await store.settleUnclaimedHolding(held.id, LATER.toISOString());
    mustFail(
      await lockBookReturnsReserve(store, { holding_ledger_id: held.id, isbn: ISBN }, LATER),
      409,
      "holding_already_released",
    );
  });
});

// ---------------------------------------------------------------------------
// Lane 6: chargeback drawdowns — FIFO reserves first, offset remainder later.
// ---------------------------------------------------------------------------

describe("drawDownBookReturnChargeback", () => {
  it("recovers from held reserves FIFO, oldest first, one balanced journal per draw", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    // Two vintages: 750 reserved at NOW, 750 reserved at LATER.
    const heldA = await seedHeldPrintNet(store, 5_000, NOW);
    await lockHeldNet(store, heldA.id, NOW);
    const heldB = await seedHeldPrintNet(store, 5_000, LATER);
    await lockHeldNet(store, heldB.id, LATER);

    const drawn = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-1",
        drawdown_class: "publisher_return",
        chargeback_cents: 1_000,
        currency: "USD",
      }, LATER),
    );
    expect(drawn.replayed).toBe(false);
    expect(drawn.drawn_cents).toBe(1_000);
    expect(drawn.outstanding_cents).toBe(0);
    // FIFO: 750 from the OLDEST reserve, then the 250 remainder from the
    // next.
    expect(drawn.outcomes.length).toBe(2);
    expect(drawn.outcomes[0]?.drawdown.drawn_cents).toBe(750);
    expect(drawn.outcomes[1]?.drawdown.drawn_cents).toBe(250);
    // The fully-drawn first reserve settled; the second stays held.
    const reserveA = await store.getLedgerTransaction(drawn.outcomes[0]?.reserve_ledger_id ?? "");
    expect(reserveA?.status).toBe("settled");
    const reserveB = await store.getLedgerTransaction(drawn.outcomes[1]?.reserve_ledger_id ?? "");
    expect(reserveB?.status).toBe("book_returns_reserve");
    // The drawdown ledger carries the derived truth; the reserve rows
    // never mutate their principal.
    expect(reserveA?.amount_cents).toBe(750);
    expect(reserveB?.amount_cents).toBe(750);
  });

  it("settles a fully-drawn reserve and leaves later events on the offset path", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);

    const full = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-2",
        drawdown_class: "publisher_return",
        chargeback_cents: 750,
        currency: "USD",
      }, LATER),
    );
    expect(full.drawn_cents).toBe(750);
    expect(full.outstanding_cents).toBe(0);
    const settled = await store.getLedgerTransaction(full.outcomes[0]?.reserve_ledger_id ?? "");
    expect(settled?.status).toBe("settled");

    // A later event finds no held capacity — the obligation survives for
    // the POD-net offset.
    const next = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-3",
        drawdown_class: "chargeback",
        chargeback_cents: 100,
        currency: "USD",
      }, LATER),
    );
    expect(next.drawn_cents).toBe(0);
    expect(next.outstanding_cents).toBe(100);
  });

  it("replays a re-shipped event as the counted no-op with the outstanding re-derived", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const first = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-4",
        drawdown_class: "publisher_return",
        chargeback_cents: 300,
        currency: "USD",
      }, NOW),
    );
    expect(first.drawn_cents).toBe(300);
    const replay = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-4",
        drawdown_class: "publisher_return",
        chargeback_cents: 300,
        currency: "USD",
      }, LATER),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.drawn_cents).toBe(0);
    expect(replay.outcomes).toEqual([]);
    expect(replay.outstanding_cents).toBe(0);
  });

  it("reports the uncovered remainder as outstanding — the POD-net offset's input", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 2_000);
    await lockHeldNet(store, held.id, NOW);
    const drawn = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-5",
        drawdown_class: "chargeback",
        chargeback_cents: 1_000,
        currency: "USD",
      }, LATER),
    );
    // Reserve = 300 (15% of 2,000); the chargeback takes it all, 700 stays
    // outstanding for the release-time offset.
    expect(drawn.drawn_cents).toBe(300);
    expect(drawn.outstanding_cents).toBe(700);
  });

  it("refuses malformed identities, classes, and amounts", async () => {
    const store = new InMemoryStore();
    mustFail(
      await drawDownBookReturnChargeback(store, {
        isbn: " ",
        event_id: "evt",
        drawdown_class: "publisher_return",
        chargeback_cents: 100,
        currency: "USD",
      }, NOW),
      422,
      "invalid_chargeback_identity",
    );
    mustFail(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "evt",
        drawdown_class: "stolen_stock" as never,
        chargeback_cents: 100,
        currency: "USD",
      }, NOW),
      422,
      "invalid_drawdown_class",
    );
    mustFail(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "evt",
        drawdown_class: "publisher_return",
        chargeback_cents: 0,
        currency: "USD",
      }, NOW),
      422,
      "invalid_chargeback_amount",
    );
  });
});

// ---------------------------------------------------------------------------
// The publishing payout gate — derived, fail-closed states.
// ---------------------------------------------------------------------------

describe("resolvePublishingGateState", () => {
  it("stays all-false without a policy of record", async () => {
    const store = new InMemoryStore();
    const gate = await resolvePublishingGateState(store, { isbn: ISBN, now: AGED });
    expect(gate).toEqual({
      policy_present: false,
      return_reserve_period_elapsed: false,
      isbn_rights_verified: false,
      earliest_reserve_created_at: null,
      window_days: null,
    });
  });

  it("derives the window from the EARLIEST reserve credit and the policy's window", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store, 1_500, 90);
    const held = await seedHeldPrintNet(store, 5_000, NOW);
    await lockHeldNet(store, held.id, NOW);

    // One minute after the lock: a 90-day window has not run.
    const young = await resolvePublishingGateState(store, { isbn: ISBN, now: LATER });
    expect(young.return_reserve_period_elapsed).toBe(false);
    const aged = await resolvePublishingGateState(store, { isbn: ISBN, now: AGED });
    expect(aged.return_reserve_period_elapsed).toBe(true);
    expect(aged.earliest_reserve_created_at).toBe(NOW.toISOString());
    expect(aged.window_days).toBe(90);
  });

  it("reads the ISBN rights chain of record — absent and pending refuse", async () => {
    const store = new InMemoryStore();
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    await store.upsertIsbnRightsVerification({
      isbn: ISBN,
      state: "pending",
      evidence_ref: null,
      verified_by: null,
      verified_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const pending = await resolvePublishingGateState(store, { isbn: ISBN, now: AGED });
    expect(pending.isbn_rights_verified).toBe(false);
    await seedIsbnRights(store);
    const verified = await resolvePublishingGateState(store, { isbn: ISBN, now: AGED });
    expect(verified.isbn_rights_verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lane 8: the author payout release — gates, offsets first, taxed cascade.
// ---------------------------------------------------------------------------

describe("releaseBookPrintNet", () => {
  it("refuses unknown rows before anything moves", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: "missing",
        isbn: ISBN,
        splits: [],
        operator_settlement_approved: true,
      }, AGED),
      404,
      "holding_credit_not_found",
    );
  });

  it("refuses an unlinked holding credit — locked book nets only", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const unlinked = await seedHeldPrintNet(store, 5_000);
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: unlinked.id,
        isbn: ISBN,
        splits: [],
        operator_settlement_approved: true,
      }, AGED),
      422,
      "not_a_locked_book_net",
    );
  });

  it("refuses a locked credit presented under a different ISBN", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    const lock = await lockHeldNet(store, held.id, NOW);
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: "9780000000000",
        splits: [],
        operator_settlement_approved: true,
      }, AGED),
      422,
      "isbn_linkage_mismatch",
    );
  });

  it("refuses every unmet gate state before anything moves", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);
    const reparkedId = lock.reparked_credit?.id ?? "";

    // The window has not run at LATER.
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparkedId,
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, LATER),
      403,
      "return_reserve_period_not_elapsed",
    );

    // Unverified ISBN rights refuse at AGED.
    await store.upsertIsbnRightsVerification({
      isbn: ISBN,
      state: "pending",
      evidence_ref: null,
      verified_by: null,
      verified_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparkedId,
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
      403,
      "isbn_rights_not_verified",
    );
    await seedIsbnRights(store);

    // Operator settlement approval is fail-closed.
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparkedId,
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: false,
      }, AGED),
      403,
      "settlement_not_approved",
    );

    // A creator with no KYC record refuses (state unknown).
    await seedVault(store, "creator_nokyc", "Creator NoKyc");
    await seedOptionAgreement(store);
    await clearCreatorIpRights(store, "creator_nokyc", "Creator NoKyc");
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparkedId,
        isbn: ISBN,
        splits: [
          { payee_id: "creator_nokyc", payee_name: "Creator NoKyc", role: "creator", share_bps: 10_000 },
        ],
        operator_settlement_approved: true,
      }, AGED),
      403,
      "kyc_state_unknown",
    );

    // Nothing moved on any refusal — the credit is still held.
    const still = await store.getLedgerTransaction(reparkedId);
    expect(still?.status).toBe("unclaimed_holding");
  });

  it("refuses an uncleared publishing IP right per credited payee", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store);
    await seedOptionAgreement(store);
    await seedIsbnRights(store);
    await seedBookPolicy(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
      403,
      "publishing_ip_rights_not_cleared",
    );
    const still = await store.getLedgerTransaction(lock.reparked_credit?.id ?? "");
    expect(still?.status).toBe("unclaimed_holding");
  });

  it("refuses malformed splits BEFORE the CAS — shape validation is pre-motion", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);
    const reparkedId = lock.reparked_credit?.id ?? "";
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparkedId,
        isbn: ISBN,
        splits: [
          { payee_id: CREATOR, payee_name: CREATOR_NAME, role: "creator", share_bps: 6_000 },
        ],
        operator_settlement_approved: true,
      }, AGED),
      422,
      "splits_do_not_balance",
    );
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparkedId,
        isbn: ISBN,
        splits: [
          {
            payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
            payee_name: "Unclaimed Royalty Holding",
            role: "other",
            share_bps: 10_000,
          },
        ],
        operator_settlement_approved: true,
      }, AGED),
      // The per-payee compliance gate runs BEFORE the split-shape check and
      // the holding sentinel holds no KYC of record — the gate refuses it
      // first. Either way the sentinel never receives a payout.
      403,
      "kyc_state_unknown",
    );
    const still = await store.getLedgerTransaction(reparkedId);
    expect(still?.status).toBe("unclaimed_holding");
  });

  it("releases the post-offset remainder through the taxed cascade under one balanced journal", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);
    const reparked = lock.reparked_credit;

    const released = mustSucceed(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparked?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
    );
    expect(released.offset_cents).toBe(0);
    expect(released.party_credits.length).toBe(1);
    expect(released.party_credits[0]?.gross_cents).toBe(4_250);
    expect(released.company_dust_cents).toBe(0);
    // Verified tax profile — the escrow record of the cascade zeroes out.
    expect(released.withholding.length).toBe(1);
    expect(released.withholding[0]?.withheld_cents).toBe(0);
    expect(released.withholding[0]?.net_cents).toBe(4_250);

    // The vault was credited pending and the journal balances.
    const vault = await store.getVault(CREATOR);
    expect(vault?.pending_balance).toBe(4_250);
    const entries = await store.listGlEntriesByJournal(released.journal_id);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(4_250);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(4_250);

    // The credit is consumed — a second release refuses (409).
    mustFail(
      await releaseBookPrintNet(store, {
        holding_ledger_id: reparked?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
      409,
      "holding_already_released",
    );
  });

  it("applies the outstanding chargeback offset FIRST — the recovery returns to FBO, only the remainder pays out", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);

    // A 500-cent chargeback the 750 reserve covers fully.
    const drawn = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-6",
        drawdown_class: "publisher_return",
        chargeback_cents: 500,
        currency: "USD",
      }, NOW),
    );
    expect(drawn.drawn_cents).toBe(500);
    expect(drawn.outstanding_cents).toBe(0);

    // A second chargeback lands after the first — the remaining 250 of
    // reserve covers part of it; the 250 remainder is outstanding, the
    // POD-net offset's input.
    const second = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-7",
        drawdown_class: "chargeback",
        chargeback_cents: 500,
        currency: "USD",
      }, LATER),
    );
    expect(second.drawn_cents).toBe(250);
    expect(second.outstanding_cents).toBe(250);

    const released = mustSucceed(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
    );
    // The offset took the outstanding 250 back to FBO first.
    expect(released.offset_cents).toBe(250);
    expect(released.offset_chargeback_ids).toEqual([second.chargeback.id]);
    expect(released.party_credits[0]?.gross_cents).toBe(4_000);
    // The Don invariant with the offset inside it.
    expect(
      released.offset_cents + released.party_credits[0]!.gross_cents + released.company_dust_cents,
    ).toBe(4_250);
    // The chargeback of record carries the offset application.
    const applications = await store.listBookChargebackOffsetApplications(second.chargeback.id);
    expect(applications.length).toBe(1);
    expect(applications[0]?.applied_cents).toBe(250);
    expect(applications[0]?.holding_ledger_id).toBe(lock.reparked_credit?.id);
  });

  it("caps the offset at the held amount when the obligation exceeds it — everything recovers to FBO", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);
    // A 5,000-cent chargeback: reserves cover 750, 4,250 outstanding — the
    // offset consumes the ENTIRE reparked net; nothing pays out.
    const drawn = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-8",
        drawdown_class: "chargeback",
        chargeback_cents: 5_000,
        currency: "USD",
      }, LATER),
    );
    expect(drawn.outstanding_cents).toBe(4_250);

    const released = mustSucceed(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
    );
    expect(released.offset_cents).toBe(4_250);
    expect(released.party_credits).toEqual([]);
    const vault = await store.getVault(CREATOR);
    expect(vault?.pending_balance ?? 0).toBe(0);
  });

  it("routes sub-cent dust to the platform variance payee and keeps the journal balanced", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    await seedVerifiedCreator(store, "creator_y", "Creator Y");
    await seedOptionAgreement(store);
    await clearCreatorIpRights(store, "creator_y", "Creator Y");
    // A 1,501 bps rate on 9,999 floors the reserve to 1,500 — the
    // re-parked 8,499 splits 50/50 into 4,249 + 4,249 with 1 cent of dust.
    await seedBookPolicy(store, 1_501, 90);
    const held = await seedHeldPrintNet(store, 9_999);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);
    expect(lock.reserve_credit.amount_cents).toBe(1_500);
    expect(lock.reparked_credit?.amount_cents).toBe(8_499);

    const released = mustSucceed(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: ISBN,
        splits: [
          { payee_id: CREATOR, payee_name: CREATOR_NAME, role: "creator", share_bps: 5_000 },
          { payee_id: "creator_y", payee_name: "Creator Y", role: "creator", share_bps: 5_000 },
        ],
        operator_settlement_approved: true,
      }, AGED),
    );
    expect(released.party_credits[0]?.gross_cents).toBe(4_249);
    expect(released.party_credits[1]?.gross_cents).toBe(4_249);
    expect(released.company_dust_cents).toBe(1);
    expect(
      released.offset_cents +
        released.party_credits.reduce((t, c) => t + c.gross_cents, 0) +
        released.company_dust_cents,
    ).toBe(8_499);
  });
});

// ---------------------------------------------------------------------------
// The ledger invariant suite — the whole story's money discipline.
// ---------------------------------------------------------------------------

describe("book returns reserve — ledger invariants", () => {
  it("conserves every cent across the full lifecycle: post → lock → drawdown → offset → release", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const GROSS = 10_000;
    const held = await seedHeldPrintNet(store, GROSS);
    await lockHeldNet(store, held.id, NOW);
    const lock = await lockHeldNet(store, held.id, NOW);

    // Reserve 1,500 covers the 400 fully.
    const drawn = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-9",
        drawdown_class: "publisher_return",
        chargeback_cents: 400,
        currency: "USD",
      }, LATER),
    );
    expect(drawn.drawn_cents).toBe(400);

    // A second chargeback exceeds the remaining reserve (1,100): 1,100
    // drawn, 200 outstanding for the offset.
    const second = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-10",
        drawdown_class: "chargeback",
        chargeback_cents: 1_300,
        currency: "USD",
      }, LATER),
    );
    expect(second.drawn_cents).toBe(1_100);
    expect(second.outstanding_cents).toBe(200);

    const released = mustSucceed(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
    );

    // The conservation identity across the lifecycle:
    //   gross = reserve draws (to FBO) + offsets (to FBO) + author payout.
    // 10,000 = 400 + 1,100 + 200 (offset) + 8,300 (payout).
    expect(drawn.drawn_cents).toBe(400);
    expect(second.drawn_cents).toBe(1_100);
    expect(released.offset_cents).toBe(200);
    expect(released.party_credits[0]?.gross_cents).toBe(8_300);
    expect(
      GROSS ===
        drawn.drawn_cents +
          second.drawn_cents +
          released.offset_cents +
          released.party_credits[0]!.gross_cents +
          released.company_dust_cents,
    ).toBe(true);
  });

  it("every journal in the story balances — post, lock, drawdowns, release", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    const post = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 5_000, currency: "USD", source: { type: "manual", note: "x" } },
        NOW,
      ),
    );
    const lock = await lockHeldNet(store, held.id, NOW);
    const drawn = mustSucceed(
      await drawDownBookReturnChargeback(store, {
        isbn: ISBN,
        event_id: "return-evt-11",
        drawdown_class: "publisher_return",
        chargeback_cents: 100,
        currency: "USD",
      }, LATER),
    );
    expect(drawn.drawn_cents).toBe(100);
    const released = mustSucceed(
      await releaseBookPrintNet(store, {
        holding_ledger_id: lock.reparked_credit?.id ?? "",
        isbn: ISBN,
        splits: fullCreatorSplits(),
        operator_settlement_approved: true,
      }, AGED),
    );
    for (const journalId of [post.journal_id, lock.journal_id as string, released.journal_id]) {
      const entries = await store.listGlEntriesByJournal(journalId);
      expect(
        entries.reduce((s, e) => s + e.debit_cents, 0),
      ).toBe(entries.reduce((s, e) => s + e.credit_cents, 0));
    }
  });

  it("the reserve sentinel and the variance payee hold no vault balances from the lock", async () => {
    const store = new InMemoryStore();
    await seedGatedTitle(store);
    const held = await seedHeldPrintNet(store, 5_000);
    await lockHeldNet(store, held.id, NOW);
    expect(await store.getVault(bookReturnsReservePayeeId(ISBN))).toBeUndefined();
  });
});
