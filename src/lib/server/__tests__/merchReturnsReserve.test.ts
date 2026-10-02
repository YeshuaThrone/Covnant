// Merchandise returns reserve + fulfillment confirmation (PR 23) — the
// behavioral suite for the dispatch, drawdown, and release lanes, mirroring
// the unclaimed-holding suite's discipline: the CAS arbitrates BEFORE money
// moves, the ledger invariants hold with the reserve bucket inside the
// allocation total, and every absent/unknown state fails closed.

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  MERCH_RETURNS_RESERVE_MAX_RATE_BPS,
  MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS,
  MERCH_RETURNS_RESERVE_MIN_RATE_BPS,
  MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS,
  merchReturnsReservePayeeId,
  merchReturnsReservePayeeName,
} from "@/modules/don/constants";
import {
  buildReserveDrawdownPlan,
  buildReserveSplitPlan,
  buildReserveWindowCheck,
  dispatchMerchPayoutWithReturnsReserve,
  drawDownMerchReturnsReserve,
  recordMerchFulfillmentTracking,
  registerMerchReturnReservePolicy,
  releaseMerchReturnsReserve,
  resolveMerchFulfillmentState,
} from "@/lib/server/merchReturnsReserve";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-30T12:00:00.000Z");
const SKU = "sku-tee-classic";
const BENEFICIARY = "creator_beneficiary";

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

async function seedPolicy(
  store: Store,
  overrides: Partial<{
    sku_id: string;
    reserve_rate_bps: number;
    reserve_window_days: number;
    beneficiary_payee_id: string;
  }> = {},
): Promise<void> {
  const registered = await registerMerchReturnReservePolicy(
    store,
    {
      sku_id: overrides.sku_id ?? SKU,
      reserve_rate_bps: overrides.reserve_rate_bps ?? 1_200,
      reserve_window_days: overrides.reserve_window_days ?? 30,
      beneficiary_payee_id: overrides.beneficiary_payee_id ?? BENEFICIARY,
      beneficiary_payee_name: "Beneficiary Creator",
    },
    T0,
  );
  expect(registered.ok).toBe(true);
}

async function seedHoldingCredit(
  store: Store,
  amountCents: number,
  createdAt: Date = T0,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "line-item-1",
    payee_id: "merch_unclaimed_holding",
    payee_name: "Merch Unclaimed Holding",
    role: "other",
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

async function seedReserveCredit(
  store: Store,
  amountCents: number,
  createdAt: Date,
  fulfillmentEventId: string,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: fulfillmentEventId,
    payee_id: merchReturnsReservePayeeId(SKU),
    payee_name: merchReturnsReservePayeeName(SKU),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "merch_returns_reserve",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt.toISOString(),
    settled_at: null,
    kind: "merch_returns_reserve",
  });
}

async function seedDeliveredTracking(store: Store, fulfillmentEventId: string): Promise<void> {
  const recorded = await recordMerchFulfillmentTracking(
    store,
    {
      fulfillment_event_id: fulfillmentEventId,
      tracking_number: "1Z999AA10123456784",
      tracking_state: "delivered",
      carrier: "UPS",
    },
    T0,
  );
  expect(recorded.ok).toBe(true);
}

/** The full working dispatch fixture: policy + KYC + delivered tracking + a held credit. */
async function seedDispatchFixture(
  store: Store,
  amountCents: number,
): Promise<LedgerTransactionRecord> {
  await seedPolicy(store);
  await seedVerifiedKyc(store, BENEFICIARY);
  await seedDeliveredTracking(store, "fulfillment-evt-1");
  return seedHoldingCredit(store, amountCents);
}

// ---------------------------------------------------------------------------
// The pure planners.
// ---------------------------------------------------------------------------

describe("buildReserveSplitPlan — the pure founder-banded split", () => {
  it("floors the reserve share and routes the exact subtraction remainder (dust structurally zero)", () => {
    // 12% of 100_000 lands exactly; 12% of 12345 floors to 1481 (1481.4).
    const exact = buildReserveSplitPlan({ allocation_cents: 100_000, reserve_rate_bps: 1_200 });
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.value).toEqual({
        allocation_cents: 100_000,
        reserve_cents: 12_000,
        dispatch_cents: 88_000,
        company_dust_cents: 0,
      });
    }
    const floored = buildReserveSplitPlan({ allocation_cents: 12_345, reserve_rate_bps: 1_200 });
    expect(floored.ok).toBe(true);
    if (floored.ok) {
      expect(floored.value.reserve_cents).toBe(1_481);
      expect(floored.value.dispatch_cents).toBe(10_864);
      expect(floored.value.company_dust_cents).toBe(0);
      expect(floored.value.dispatch_cents + floored.value.reserve_cents).toBe(12_345);
    }
  });

  it("honors the founder band edges (10% and 15%) and refuses outside it", () => {
    const min = buildReserveSplitPlan({
      allocation_cents: 10_000,
      reserve_rate_bps: MERCH_RETURNS_RESERVE_MIN_RATE_BPS,
    });
    expect(min.ok && min.value.reserve_cents === 1_000).toBe(true);
    const max = buildReserveSplitPlan({
      allocation_cents: 10_000,
      reserve_rate_bps: MERCH_RETURNS_RESERVE_MAX_RATE_BPS,
    });
    expect(max.ok && max.value.reserve_cents === 1_500).toBe(true);
    const under = buildReserveSplitPlan({
      allocation_cents: 10_000,
      reserve_rate_bps: MERCH_RETURNS_RESERVE_MIN_RATE_BPS - 1,
    });
    expect(!under.ok && under.code === "reserve_rate_out_of_band").toBe(true);
    const over = buildReserveSplitPlan({
      allocation_cents: 10_000,
      reserve_rate_bps: MERCH_RETURNS_RESERVE_MAX_RATE_BPS + 1,
    });
    expect(!over.ok && over.code === "reserve_rate_out_of_band").toBe(true);
  });

  it("refuses non-integer and non-positive allocations", () => {
    const fractional = buildReserveSplitPlan({ allocation_cents: 100.5, reserve_rate_bps: 1_200 });
    expect(!fractional.ok && fractional.code === "invalid_allocation_amount").toBe(true);
    const zero = buildReserveSplitPlan({ allocation_cents: 0, reserve_rate_bps: 1_200 });
    expect(!zero.ok && zero.code === "invalid_allocation_amount").toBe(true);
    const negative = buildReserveSplitPlan({ allocation_cents: -5, reserve_rate_bps: 1_200 });
    expect(!negative.ok && negative.code === "invalid_allocation_amount").toBe(true);
  });
});

describe("buildReserveWindowCheck — the pure window gate", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");

  it("refuses before the window elapses and releases at the boundary", () => {
    const day29 = buildReserveWindowCheck({
      created_at: created.toISOString(),
      window_days: 30,
      now: new Date(created.getTime() + 29 * 86_400_000),
    });
    expect(!day29.ok && day29.code === "reserve_window_not_elapsed").toBe(true);
    const at30 = buildReserveWindowCheck({
      created_at: created.toISOString(),
      window_days: 30,
      now: new Date(created.getTime() + 30 * 86_400_000),
    });
    expect(at30.ok).toBe(true);
  });

  it("refuses an out-of-band window and an unparseable created_at", () => {
    const short = buildReserveWindowCheck({
      created_at: created.toISOString(),
      window_days: MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS - 1,
      now: new Date(),
    });
    expect(!short.ok && short.code === "reserve_window_out_of_band").toBe(true);
    const long = buildReserveWindowCheck({
      created_at: created.toISOString(),
      window_days: MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS + 1,
      now: new Date(),
    });
    expect(!long.ok && long.code === "reserve_window_out_of_band").toBe(true);
    const garbage = buildReserveWindowCheck({
      created_at: "not-a-date",
      window_days: 30,
      now: new Date(),
    });
    expect(!garbage.ok && garbage.code === "invalid_reserve_created_at").toBe(true);
  });
});

describe("buildReserveDrawdownPlan — the pure drawdown math", () => {
  it("computes the position and the remaining balance", () => {
    const plan = buildReserveDrawdownPlan({
      drawdown_class: "customer_return",
      source_event_id: "return-1",
      drawn_before_cents: 2_000,
      drawn_cents: 500,
      remaining_cents: 10_000,
    });
    expect(plan.ok && plan.value.remaining_cents === 9_500).toBe(true);
  });

  it("refuses an overdraw, an unknown class, a bad amount, and a bad position", () => {
    const overdraw = buildReserveDrawdownPlan({
      drawdown_class: "chargeback",
      source_event_id: "cb-1",
      drawn_before_cents: 0,
      drawn_cents: 11_000,
      remaining_cents: 10_000,
    });
    expect(!overdraw.ok && overdraw.code === "drawdown_exceeds_reserve").toBe(true);
    const unknownClass = buildReserveDrawdownPlan({
      drawdown_class: "shrinkage",
      source_event_id: "x",
      drawn_before_cents: 0,
      drawn_cents: 1,
      remaining_cents: 10,
    });
    expect(!unknownClass.ok && unknownClass.code === "invalid_drawdown_class").toBe(true);
    const zero = buildReserveDrawdownPlan({
      drawdown_class: "customer_return",
      source_event_id: "x",
      drawn_before_cents: 0,
      drawn_cents: 0,
      remaining_cents: 10,
    });
    expect(!zero.ok && zero.code === "invalid_drawdown_amount").toBe(true);
    const negativePosition = buildReserveDrawdownPlan({
      drawdown_class: "customer_return",
      source_event_id: "x",
      drawn_before_cents: -1,
      drawn_cents: 1,
      remaining_cents: 10,
    });
    expect(!negativePosition.ok && negativePosition.code === "invalid_drawdown_position").toBe(true);
    const emptySource = buildReserveDrawdownPlan({
      drawdown_class: "customer_return",
      source_event_id: "  ",
      drawn_before_cents: 0,
      drawn_cents: 1,
      remaining_cents: 10,
    });
    expect(!emptySource.ok && emptySource.code === "invalid_drawdown_source").toBe(true);
  });
});

describe("resolveMerchFulfillmentState — the DERIVED gate state", () => {
  it("reads null when no tracking events exist, false while in flight, true on delivery", async () => {
    const store = makeStore();
    expect(await resolveMerchFulfillmentState(store, "fe-1")).toBeNull();

    await recordMerchFulfillmentTracking(
      store,
      { fulfillment_event_id: "fe-1", tracking_number: "T1", tracking_state: "assigned", carrier: "UPS" },
      T0,
    );
    const assigned = await resolveMerchFulfillmentState(store, "fe-1");
    expect(assigned).toEqual({ vertical: "merch", physical_fulfillment_confirmed: false });

    await recordMerchFulfillmentTracking(
      store,
      { fulfillment_event_id: "fe-1", tracking_number: "T1", tracking_state: "in_transit", carrier: "UPS" },
      T0,
    );
    const inTransit = await resolveMerchFulfillmentState(store, "fe-1");
    expect(inTransit?.physical_fulfillment_confirmed).toBe(false);

    await recordMerchFulfillmentTracking(
      store,
      { fulfillment_event_id: "fe-1", tracking_number: "T1", tracking_state: "delivered", carrier: "UPS" },
      T0,
    );
    const delivered = await resolveMerchFulfillmentState(store, "fe-1");
    expect(delivered?.physical_fulfillment_confirmed).toBe(true);
  });
});

describe("registration lanes", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("registers and replaces the policy of record, refusing hostile terms", async () => {
    const first = await registerMerchReturnReservePolicy(
      store,
      {
        sku_id: SKU,
        reserve_rate_bps: 1_200,
        reserve_window_days: 30,
        beneficiary_payee_id: BENEFICIARY,
        beneficiary_payee_name: "Beneficiary Creator",
      },
      T0,
    );
    expect(first.ok && first.value.reserve_rate_bps === 1_200).toBe(true);

    const replaced = await registerMerchReturnReservePolicy(
      store,
      {
        sku_id: SKU,
        reserve_rate_bps: 1_500,
        reserve_window_days: 60,
        beneficiary_payee_id: BENEFICIARY,
        beneficiary_payee_name: "Beneficiary Creator",
      },
      T0,
    );
    expect(replaced.ok && replaced.value.reserve_rate_bps === 1_500).toBe(true);
    const reread = await store.getMerchReturnReservePolicy(SKU);
    expect(reread?.reserve_window_days).toBe(60);

    const badRate = await registerMerchReturnReservePolicy(
      store,
      {
        sku_id: SKU,
        reserve_rate_bps: 5_000,
        reserve_window_days: 30,
        beneficiary_payee_id: BENEFICIARY,
        beneficiary_payee_name: "Beneficiary Creator",
      },
      T0,
    );
    expect(!badRate.ok && badRate.code === "reserve_rate_out_of_band").toBe(true);
    const badWindow = await registerMerchReturnReservePolicy(
      store,
      {
        sku_id: SKU,
        reserve_rate_bps: 1_200,
        reserve_window_days: 90,
        beneficiary_payee_id: BENEFICIARY,
        beneficiary_payee_name: "Beneficiary Creator",
      },
      T0,
    );
    expect(!badWindow.ok && badWindow.code === "reserve_window_out_of_band").toBe(true);
    const emptySku = await registerMerchReturnReservePolicy(
      store,
      {
        sku_id: " ",
        reserve_rate_bps: 1_200,
        reserve_window_days: 30,
        beneficiary_payee_id: BENEFICIARY,
        beneficiary_payee_name: "Beneficiary Creator",
      },
      T0,
    );
    expect(!emptySku.ok && emptySku.code === "invalid_sku_identity").toBe(true);
  });

  it("records tracking events replay-idempotently and stamps delivery instants", async () => {
    const first = await recordMerchFulfillmentTracking(
      store,
      {
        fulfillment_event_id: "fe-1",
        tracking_number: "T1",
        tracking_state: "delivered",
        carrier: "UPS",
        delivered_at: "2026-02-01T00:00:00.000Z",
      },
      T0,
    );
    expect(first.ok && first.value.replayed).toBe(false);
    expect(first.ok && first.value.tracking.delivered_at).toBe("2026-02-01T00:00:00.000Z");

    const replay = await recordMerchFulfillmentTracking(
      store,
      {
        fulfillment_event_id: "fe-1",
        tracking_number: "T1",
        tracking_state: "delivered",
        carrier: "UPS",
      },
      T0,
    );
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect((await store.listMerchFulfillmentTrackings("fe-1")).length).toBe(1);

    const inFlight = await recordMerchFulfillmentTracking(
      store,
      { fulfillment_event_id: "fe-1", tracking_number: "T1", tracking_state: "assigned", carrier: "UPS" },
      T0,
    );
    expect(inFlight.ok && inFlight.value.tracking.delivered_at).toBeNull();

    const badState = await recordMerchFulfillmentTracking(
      store,
      { fulfillment_event_id: "fe-1", tracking_number: "T2", tracking_state: "teleported", carrier: "UPS" },
      T0,
    );
    expect(!badState.ok && badState.code === "invalid_tracking_state").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The dispatch lane.
// ---------------------------------------------------------------------------

describe("dispatchMerchPayoutWithReturnsReserve", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("splits the held allocation: remainder to creator net through the cascade, holdback locks as the reserve", async () => {
    const holding = await seedDispatchFixture(store, 100_000);

    const dispatched = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: SKU,
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;

    // The split — 12% held, the remainder dispatched, dust structurally zero.
    expect(dispatched.value.split).toEqual({
      allocation_cents: 100_000,
      reserve_cents: 12_000,
      dispatch_cents: 88_000,
      company_dust_cents: 0,
    });
    // THE DON INVARIANT with the reserve bucket inside the allocation total.
    expect(
      dispatched.value.split.dispatch_cents +
        dispatched.value.split.reserve_cents +
        dispatched.value.company_dust_cents,
    ).toBe(100_000);

    // The reserve row: kind AND status 'merch_returns_reserve', the per-sku
    // sentinel payee, the fulfillment event stamped in line_item_id.
    expect(dispatched.value.reserve_credit.kind).toBe("merch_returns_reserve");
    expect(dispatched.value.reserve_credit.status).toBe("merch_returns_reserve");
    expect(dispatched.value.reserve_credit.payee_id).toBe(merchReturnsReservePayeeId(SKU));
    expect(dispatched.value.reserve_credit.amount_cents).toBe(12_000);
    expect(dispatched.value.reserve_credit.line_item_id).toBe("fulfillment-evt-1");

    // The held credit settled; the listing no longer shows it.
    expect(dispatched.value.holding_credit.status).toBe("settled");
    expect((await store.listUnclaimedHoldingCredits()).map((r) => r.id)).not.toContain(holding.id);

    // The reserve credit is discoverable through the held-reserve listing.
    expect(
      (await store.listMerchReturnsReserveCredits()).map((r) => r.id),
    ).toContain(dispatched.value.reserve_credit.id);

    // The routing landed in the beneficiary's vault. Conservation per the
    // sibling convention: the vault total alone equals the dispatch share —
    // net in pending, withheld cents in the payee's own reserve bucket, so
    // no outside term is added.
    const vault = await store.getVault(BENEFICIARY);
    expect(vault).toBeDefined();
    const totalCredited =
      (vault?.pending_balance ?? 0) +
      (vault?.available_balance ?? 0) +
      (vault?.reserve_balance ?? 0);
    expect(totalCredited).toBe(88_000);
    // A single beneficiary_net credit step of the gross dispatch share.
    expect(dispatched.value.credits).toEqual([
      {
        payee_id: BENEFICIARY,
        payee_name: "Beneficiary Creator",
        gross_cents: 88_000,
        net_cents: dispatched.value.credits[0]?.net_cents,
        step: "beneficiary_net",
      },
    ]);
    expect(dispatched.value.journal_id).toBeTruthy();
  });

  it("fails closed when tracking is absent or not delivered — nothing moves", async () => {
    await seedPolicy(store);
    await seedVerifiedKyc(store, BENEFICIARY);
    const holding = await seedHoldingCredit(store, 50_000);

    // NO tracking events at all: the unknown refuses.
    const unknown = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: SKU,
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(!unknown.ok && unknown.code === "vertical_state_unknown").toBe(true);

    // In-flight tracking (assigned + in_transit, nothing delivered): the
    // honest not-yet refuses too.
    await recordMerchFulfillmentTracking(
      store,
      { fulfillment_event_id: "fulfillment-evt-1", tracking_number: "T1", tracking_state: "in_transit", carrier: "UPS" },
      T0,
    );
    const inFlight = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: SKU,
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(!inFlight.ok && inFlight.code === "merch_fulfillment_unconfirmed").toBe(true);

    // NOTHING moved through either refusal: the credit is still held, no
    // reserve row exists, no vault opened.
    const reread = await store.getLedgerTransaction(holding.id);
    expect(reread?.status).toBe("unclaimed_holding");
    expect(await store.listMerchReturnsReserveCredits()).toEqual([]);
    expect(await store.getVault(BENEFICIARY)).toBeUndefined();
  });

  it("refuses without operator approval, unverified KYC, or a registered policy — before the CAS", async () => {
    const holding = await seedDispatchFixture(store, 50_000);

    const unapproved = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: SKU,
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: false,
      },
      T0,
    );
    expect(!unapproved.ok && unapproved.code === "settlement_not_approved").toBe(true);

    // A beneficiary with a PENDING KYC record refuses too.
    await store.insertKycVerification({
      creator_id: "creator_pending",
      plaid_link_token: null,
      plaid_public_token: null,
      status: "pending",
      identity_json: "{}",
      failure_reason: null,
      created_at: T0.toISOString(),
      verified_at: null,
    });
    await registerMerchReturnReservePolicy(
      store,
      {
        sku_id: "sku-unverified",
        reserve_rate_bps: 1_200,
        reserve_window_days: 30,
        beneficiary_payee_id: "creator_pending",
        beneficiary_payee_name: "Pending Creator",
      },
      T0,
    );
    const unverified = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: "sku-unverified",
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(!unverified.ok && unverified.code === "kyc_not_verified").toBe(true);

    const noPolicy = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: "sku-never-registered",
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(!noPolicy.ok && noPolicy.code === "missing_merch_return_reserve_policy").toBe(true);

    // Every refusal left the credit held and the reserve listing empty.
    expect((await store.getLedgerTransaction(holding.id))?.status).toBe("unclaimed_holding");
    expect(await store.listMerchReturnsReserveCredits()).toEqual([]);
  });

  it("replays as a 409 and arbitrates a concurrent dispatch through the CAS", async () => {
    const holding = await seedDispatchFixture(store, 50_000);
    const input = {
      holding_ledger_id: holding.id,
      sku_id: SKU,
      fulfillment_event_id: "fulfillment-evt-1",
      operator_settlement_approved: true,
    };
    const first = await dispatchMerchPayoutWithReturnsReserve(store, input, T0);
    expect(first.ok).toBe(true);

    const replay = await dispatchMerchPayoutWithReturnsReserve(store, input, T0);
    expect(!replay.ok && replay.code === "holding_already_released" && replay.status === 409).toBe(true);

    // A second held credit, settled externally between the read and the CAS
    // — the concurrent loser reads undefined and refuses the same way.
    const other = await seedHoldingCredit(store, 70_000);
    await store.settleUnclaimedHolding(other.id, T0.toISOString());
    const loser = await dispatchMerchPayoutWithReturnsReserve(store, { ...input, holding_ledger_id: other.id }, T0);
    expect(!loser.ok && loser.code === "holding_already_released").toBe(true);
  });

  it("refuses a non-holding or unknown ledger id", async () => {
    await seedDispatchFixture(store, 50_000);
    const unknown = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: "missing",
        sku_id: SKU,
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(!unknown.ok && unknown.code === "holding_credit_not_found").toBe(true);
  });

  it("locks no reserve row when the floor rounds the holdback to zero", async () => {
    // 9 cents at the band minimum (10%): floor(0.9) = 0 — no reserve row.
    await seedPolicy(store, { reserve_rate_bps: MERCH_RETURNS_RESERVE_MIN_RATE_BPS });
    await seedVerifiedKyc(store, BENEFICIARY);
    await seedDeliveredTracking(store, "fulfillment-evt-1");
    const holding = await seedHoldingCredit(store, 9);

    const dispatched = await dispatchMerchPayoutWithReturnsReserve(
      store,
      {
        holding_ledger_id: holding.id,
        sku_id: SKU,
        fulfillment_event_id: "fulfillment-evt-1",
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(dispatched.ok && dispatched.value.split.reserve_cents === 0).toBe(true);
    expect(
      dispatched.ok && dispatched.value.reserve_credit.id === holding.id,
    ).toBe(true);
    expect(await store.listMerchReturnsReserveCredits()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The drawdown lane.
// ---------------------------------------------------------------------------

describe("drawDownMerchReturnsReserve", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("draws a customer return down with a position-locked row and an FBO journal", async () => {
    await seedPolicy(store);
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");

    const drawn = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        drawdown_class: "customer_return",
        source_event_id: "return-1",
        drawn_cents: 4_500,
      },
      T0,
    );
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.drawdown.drawn_before_cents).toBe(0);
    expect(drawn.value.drawdown.remaining_cents).toBe(7_500);
    expect(drawn.value.replayed).toBe(false);
    expect(drawn.value.journal_id).toBeTruthy();
    // The reserve stays held — a partial drawdown does not settle it.
    expect((await store.getLedgerTransaction(reserve.id))?.status).toBe("merch_returns_reserve");

    // The second drawdown's position derives from the append-only truth.
    const second = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        drawdown_class: "chargeback",
        source_event_id: "cb-1",
        drawn_cents: 2_500,
      },
      T0,
    );
    expect(second.ok && second.value.drawdown.drawn_before_cents === 4_500).toBe(true);
    expect(second.ok && second.value.drawdown.remaining_cents === 5_000).toBe(true);
  });

  it("replays a re-shipped event as the counted no-op — never a second journal", async () => {
    await seedPolicy(store);
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");
    const input = {
      reserve_ledger_id: reserve.id,
      sku_id: SKU,
      drawdown_class: "customer_return" as const,
      source_event_id: "return-1",
      drawn_cents: 4_500,
    };
    const first = await drawDownMerchReturnsReserve(store, input, T0);
    expect(first.ok && first.value.replayed).toBe(false);
    const replay = await drawDownMerchReturnsReserve(store, input, T0);
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(replay.ok && replay.value.journal_id).toBeNull();
    expect((await store.listMerchReserveDrawdowns(reserve.id)).length).toBe(1);
  });

  it("refuses an overdraw without writing a row or posting a journal", async () => {
    await seedPolicy(store);
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");
    const overdraw = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        drawdown_class: "customer_return",
        source_event_id: "return-big",
        drawn_cents: 12_001,
      },
      T0,
    );
    expect(!overdraw.ok && overdraw.code === "drawdown_exceeds_reserve").toBe(true);
    expect(await store.listMerchReserveDrawdowns(reserve.id)).toEqual([]);
  });

  it("settles the reserve when the last cent draws down; the reserve is then untouchable", async () => {
    await seedPolicy(store);
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");

    const final = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        drawdown_class: "chargeback",
        source_event_id: "cb-final",
        drawn_cents: 12_000,
      },
      T0,
    );
    expect(final.ok && final.value.drawdown.remaining_cents === 0).toBe(true);
    expect((await store.getLedgerTransaction(reserve.id))?.status).toBe("settled");

    // A drawdown against the settled reserve refuses.
    const after = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        drawdown_class: "customer_return",
        source_event_id: "return-late",
        drawn_cents: 100,
      },
      T0,
    );
    expect(!after.ok && after.code === "reserve_already_settled").toBe(true);

    // And the release lane refuses a fully-drawn reserve: the drawdown
    // settled the row, so the release's row-status guard (409) is the
    // primary refusal — `reserve_fully_drawn` remains the deep defense for
    // a still-held row whose drawdowns total the full amount.
    await seedVerifiedKyc(store, BENEFICIARY);
    const release = await releaseMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        operator_settlement_approved: true,
      },
      new Date(T0.getTime() + 31 * 86_400_000),
    );
    expect(!release.ok && release.code === "reserve_already_settled").toBe(true);
  });

  it("cross-checks the sku and refuses unknown or non-reserve ledger ids", async () => {
    await seedPolicy(store);
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");

    const wrongSku = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: "sku-other",
        drawdown_class: "customer_return",
        source_event_id: "return-1",
        drawn_cents: 100,
      },
      T0,
    );
    expect(!wrongSku.ok && wrongSku.code === "reserve_sku_mismatch").toBe(true);

    const unknown = await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: "missing",
        sku_id: SKU,
        drawdown_class: "customer_return",
        source_event_id: "return-1",
        drawn_cents: 100,
      },
      T0,
    );
    expect(!unknown.ok && unknown.code === "reserve_credit_not_found").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The release lane.
// ---------------------------------------------------------------------------

describe("releaseMerchReturnsReserve", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("releases the remaining reserve to the beneficiary after the window — the verified release", async () => {
    await seedPolicy(store, { reserve_window_days: 30 });
    await seedVerifiedKyc(store, BENEFICIARY);
    await seedDeliveredTracking(store, "fulfillment-evt-1");
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");
    // A partial drawdown the release must respect.
    await drawDownMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        drawdown_class: "customer_return",
        source_event_id: "return-1",
        drawn_cents: 2_000,
      },
      T0,
    );

    // Day 29: still held.
    const early = await releaseMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        operator_settlement_approved: true,
      },
      new Date(T0.getTime() + 29 * 86_400_000),
    );
    expect(!early.ok && early.code === "reserve_window_not_elapsed").toBe(true);
    expect((await store.getLedgerTransaction(reserve.id))?.status).toBe("merch_returns_reserve");

    // Day 30: the verified release pays the 10_000 remaining.
    const released = await releaseMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        operator_settlement_approved: true,
      },
      new Date(T0.getTime() + 30 * 86_400_000),
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(10_000);
    expect(released.value.reserve_credit.status).toBe("settled");
    expect(
      (await store.listMerchReturnsReserveCredits()).map((r) => r.id),
    ).not.toContain(reserve.id);

    // The Don invariant over the reserve's LIFETIME: drawdowns + released
    // === the locked reserve.
    const totalDrawn = (await store.listMerchReserveDrawdowns(reserve.id)).reduce(
      (t, d) => t + d.drawn_cents,
      0,
    );
    expect(totalDrawn + released.value.released_cents).toBe(12_000);

    // The beneficiary's vault conserved the released gross across its
    // buckets (net after any withholding, withheld cents in the reserve
    // bucket) — the sibling convention asserts the vault total alone.
    const vault = await store.getVault(BENEFICIARY);
    const totalInVault =
      (vault?.pending_balance ?? 0) + (vault?.available_balance ?? 0) + (vault?.reserve_balance ?? 0);
    expect(totalInVault).toBe(10_000);
  });

  it("fails closed when the reserve's own fulfillment context lacks delivery", async () => {
    // A reserve whose stamped fulfillment event has NO tracking rows at all
    // (seeded directly — e.g. a reserve created before tracking data
    // existed): the release refuses with the unknown-vertical code, even
    // with the window long elapsed and every other gate green.
    await seedPolicy(store, { reserve_window_days: 30 });
    await seedVerifiedKyc(store, BENEFICIARY);
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-ghost");

    const released = await releaseMerchReturnsReserve(
      store,
      {
        reserve_ledger_id: reserve.id,
        sku_id: SKU,
        operator_settlement_approved: true,
      },
      new Date(T0.getTime() + 60 * 86_400_000),
    );
    expect(!released.ok && released.code === "vertical_state_unknown").toBe(true);
    expect((await store.getLedgerTransaction(reserve.id))?.status).toBe("merch_returns_reserve");
  });

  it("replays as a 409 and refuses a wrong sku or unknown id", async () => {
    await seedPolicy(store);
    await seedVerifiedKyc(store, BENEFICIARY);
    await seedDeliveredTracking(store, "fulfillment-evt-1");
    const reserve = await seedReserveCredit(store, 12_000, T0, "fulfillment-evt-1");
    const input = {
      reserve_ledger_id: reserve.id,
      sku_id: SKU,
      operator_settlement_approved: true,
    };
    const when = new Date(T0.getTime() + 30 * 86_400_000);

    const first = await releaseMerchReturnsReserve(store, input, when);
    expect(first.ok).toBe(true);
    const replay = await releaseMerchReturnsReserve(store, input, when);
    expect(!replay.ok && replay.code === "reserve_already_settled").toBe(true);

    const other = await seedReserveCredit(store, 5_000, T0, "fulfillment-evt-1");
    const wrongSku = await releaseMerchReturnsReserve(
      store,
      { ...input, reserve_ledger_id: other.id, sku_id: "sku-other" },
      when,
    );
    expect(!wrongSku.ok && wrongSku.code === "reserve_sku_mismatch").toBe(true);
    const unknown = await releaseMerchReturnsReserve(
      store,
      { ...input, reserve_ledger_id: "missing" },
      when,
    );
    expect(!unknown.ok && unknown.code === "reserve_credit_not_found").toBe(true);
  });
});
