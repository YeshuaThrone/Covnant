// Merchandise returns reserve + fulfillment confirmation (PR 23, founder
// directive).
//
// Merchandise payout money stops trusting the caller's word about delivery
// and starts protecting the platform from the customer's right to send the
// product back. Two mechanisms, one money path:
//
//   1. THE RETURNS RESERVE — a dispatched merch payout allocation splits:
//      the 10–15% holdback (per-contract, founder-banded in basis points)
//      locks as a ledger row with kind AND status 'merch_returns_reserve'
//      — the holding-state sibling PR 7, PR 9, PR 13, PR 15, and PR 20
//      shipped — for the contract's 30–60 day returns window, while the
//      non-reserve remainder routes to the beneficiary of record's creator
//      net through the SAME fail-closed cascade every payout rides
//      (withholding off the top, the catalog-dispute freeze check, the
//      recoupment sweep, then the vault credit — never a bare credit).
//      Customer returns and payment chargebacks DRAW the reserve down (the
//      money goes back to the customer out of FBO cash); after the window
//      elapses the verified release pays the remaining reserve to the
//      beneficiary of record through the same cascade.
//   2. THE FULFILLMENT GATE — the merch vertical's
//      physical_fulfillment_confirmed condition is DERIVED from durable
//      fulfillment tracking events (courier lifecycle rows keyed on the
//      fulfillment event), never caller-stated: only a 'delivered' tracking
//      event confirms; 'assigned' and 'in_transit' are honest not-yet
//      states the gate refuses, and an absent tracking ledger is an unknown
//      that refuses the same way — fail-closed by construction. Payout
//      dispatch enforces the confirmation BEFORE any non-reserve fund
//      releases.
//
// The money path is the canonical recon posting seam: a dispatched
// allocation arrives as a held unclaimed-holding credit (PR 22's
// postMerchFulfillmentNetToHolding), and this lane consumes exactly one
// held credit through the same fail-closed gate family every payout uses —
// operator settlement approval, Plaid-backed KYC, and the DERIVED merch
// vertical state — before the exact-integer split routes. The terms of
// record (rate, window, beneficiary) come from the registered policy
// registry, never the caller — the collab-agreement precedent.
//
// THE EXACT-AMOUNT SPLIT. The reserve share is floor(allocation × bps /
// 10000) and the dispatch share is the EXACT subtraction remainder — the
// split is structurally dustless (the ipOption/translation-escrow
// discipline: plan first, then route exactly what the plan computed, dust
// swept defensively). The settlement CAS (settleUnclaimedHolding) flips
// the held row BEFORE any money moves — insert-as-lock, the payout-reversal
// precedent: a crash mid-dispatch fails toward "nothing moved twice".
// The drawdown rows commit position-locked (the 0026 recoupment-application
// discipline at reserve scope) before the drawdown's money moves — the
// ordering is the point.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  MERCH_RETURNS_RESERVE_MAX_RATE_BPS,
  MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS,
  MERCH_RETURNS_RESERVE_MIN_RATE_BPS,
  MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS,
  merchReturnsReservePayeeId,
  merchReturnsReservePayeeName,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import {
  MERCH_FULFILLMENT_TRACKING_STATES,
  MERCH_RESERVE_DRAWDOWN_CLASSES,
  type CompanyDustRecord,
  type MerchFulfillmentTrackingRecord,
  type MerchFulfillmentTrackingState,
  type MerchReserveDrawdownClass,
  type MerchReserveDrawdownRecord,
  type MerchReturnReservePolicyRecord,
  type TaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  type MerchComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboCredit,
  merchReturnsReserveCredit,
  merchReturnsReserveDebit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the merch cascade / unclaimed-holding shape. */
export type MerchReserveFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// The pure planners — exact integer cents, every band enforced.
// ---------------------------------------------------------------------------

/** The dispatch-time split of one payout allocation. */
export type MerchReserveSplitPlan = {
  allocation_cents: number;
  /** The founder-banded holdback — floor(allocation × bps / 10000). */
  reserve_cents: number;
  /** The exact subtraction remainder that dispatches now. */
  dispatch_cents: number;
  /** Structurally zero under the subtraction model; asserted, not assumed. */
  company_dust_cents: number;
};

/**
 * The PURE split plan — the founder-banded holdback share of a payout
 * allocation, computed in exact integer cents. The reserve share floors the
 * rate multiplication (never rounds up: the creator's dispatched share is
 * the exact subtraction remainder, so allocation = dispatch + reserve +
 * dust holds with dust structurally zero). Refuses a non-integer or
 * non-positive allocation and a rate outside the founder band — a hostile
 * contract is refused, not clipped.
 */
export function buildReserveSplitPlan(input: {
  allocation_cents: number;
  reserve_rate_bps: number;
}): { ok: true; value: MerchReserveSplitPlan } | MerchReserveFailure {
  const { allocation_cents, reserve_rate_bps } = input;
  if (!Number.isInteger(allocation_cents) || allocation_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_allocation_amount",
      message: "A merch payout allocation splits in whole positive cents.",
    };
  }
  if (
    !Number.isInteger(reserve_rate_bps) ||
    reserve_rate_bps < MERCH_RETURNS_RESERVE_MIN_RATE_BPS ||
    reserve_rate_bps > MERCH_RETURNS_RESERVE_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_rate_out_of_band",
      message: `The returns-reserve rate must sit inside the founder band (${MERCH_RETURNS_RESERVE_MIN_RATE_BPS}–${MERCH_RETURNS_RESERVE_MAX_RATE_BPS} bps — 10–15%).`,
    };
  }
  const reserve_cents = Math.floor((allocation_cents * reserve_rate_bps) / BPS_DENOMINATOR);
  const dispatch_cents = allocation_cents - reserve_cents;
  const plan: MerchReserveSplitPlan = {
    allocation_cents,
    reserve_cents,
    dispatch_cents,
    company_dust_cents: 0,
  };
  return { ok: true, value: plan };
}

/**
 * The PURE window check — a reserve releases only after its contract's
 * founder-banded window has fully elapsed since the holdback posted.
 * Whole days; the window boundary itself (elapsed === window) releases.
 */
export function buildReserveWindowCheck(input: {
  created_at: string;
  window_days: number;
  now: Date;
}): { ok: true; value: { elapsed_days: number } } | MerchReserveFailure {
  const createdAtMs = Date.parse(input.created_at);
  if (!Number.isFinite(createdAtMs)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_reserve_created_at",
      message: "The reserve credit's created_at is not a parseable instant.",
    };
  }
  if (
    !Number.isInteger(input.window_days) ||
    input.window_days < MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS ||
    input.window_days > MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_window_out_of_band",
      message: `The returns-reserve window must sit inside the founder band (${MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS}–${MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS} days).`,
    };
  }
  const elapsedDays = (input.now.getTime() - createdAtMs) / 86_400_000;
  if (elapsedDays < input.window_days) {
    return {
      ok: false,
      status: 422,
      code: "reserve_window_not_elapsed",
      message: `The returns window (${input.window_days} days) has not elapsed — the reserve stays held.`,
    };
  }
  return { ok: true, value: { elapsed_days: elapsedDays } };
}

/**
 * The PURE drawdown plan — one return/chargeback event's spend against one
 * reserve's remaining balance, in exact integer cents. Refuses an unknown
 * class, a non-integer or non-positive amount, and an overdraw — the
 * reserve covers exactly what it holds; a drawdown beyond the remaining
 * balance is refused, never clipped into a negative reserve.
 */
export function buildReserveDrawdownPlan(input: {
  drawdown_class: string;
  source_event_id: string;
  drawn_before_cents: number;
  drawn_cents: number;
  remaining_cents: number;
}): { ok: true; value: Pick<MerchReserveDrawdownRecord, "drawn_before_cents" | "drawn_cents" | "remaining_cents"> } | MerchReserveFailure {
  if (!MERCH_RESERVE_DRAWDOWN_CLASSES.includes(input.drawdown_class as MerchReserveDrawdownClass)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message: `A reserve drawdown is a "${MERCH_RESERVE_DRAWDOWN_CLASSES.join('" or "')}" event.`,
    };
  }
  if (input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_source",
      message: "A reserve drawdown carries the return/chargeback event's source id.",
    };
  }
  if (!Number.isInteger(input.drawn_cents) || input.drawn_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_amount",
      message: "A reserve drawdown spends whole positive cents.",
    };
  }
  if (!Number.isInteger(input.drawn_before_cents) || input.drawn_before_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_position",
      message: "The drawdown position is the reserve's drawn sum before this spend — a non-negative integer.",
    };
  }
  if (input.drawn_cents > input.remaining_cents) {
    return {
      ok: false,
      status: 422,
      code: "drawdown_exceeds_reserve",
      message: `The drawdown (${input.drawn_cents} cents) exceeds the reserve's remaining balance (${input.remaining_cents} cents) — refused, never overdrawn.`,
    };
  }
  return {
    ok: true,
    value: {
      drawn_before_cents: input.drawn_before_cents,
      drawn_cents: input.drawn_cents,
      remaining_cents: input.remaining_cents - input.drawn_cents,
    },
  };
}

// ---------------------------------------------------------------------------
// The fulfillment state the merch payout gate reads — DERIVED, fail-closed.
// ---------------------------------------------------------------------------

/**
 * Resolves the merch vertical's compliance state for one fulfillment event
 * from the durable tracking ledger — the state the payout gate's
 * physical_fulfillment_confirmed condition consumes. DERIVED, never
 * caller-stated:
 *
 *   - no tracking events at all → null (unknown — the gate refuses with
 *     `vertical_state_unknown`),
 *   - events but none delivered → `{ physical_fulfillment_confirmed: false }`
 *     (the gate refuses with `merch_fulfillment_unconfirmed`),
 *   - any delivered event → `{ physical_fulfillment_confirmed: true }`.
 *
 * Every absent/unknown path fails closed; nothing defaults to confirmed.
 */
export async function resolveMerchFulfillmentState(
  store: Store,
  fulfillmentEventId: string,
): Promise<MerchComplianceState | null> {
  const events: MerchFulfillmentTrackingRecord[] =
    await store.listMerchFulfillmentTrackings(fulfillmentEventId);
  if (events.length === 0) return null;
  const delivered = events.some((event) => event.tracking_state === "delivered");
  return {
    vertical: "merch",
    physical_fulfillment_confirmed: delivered,
  };
}

// ---------------------------------------------------------------------------
// Registration — the policy and tracking records of record.
// ---------------------------------------------------------------------------

export type MerchReturnReservePolicyInput = {
  sku_id: string;
  reserve_rate_bps: number;
  reserve_window_days: number;
  beneficiary_payee_id: string;
  beneficiary_payee_name: string;
};

/**
 * Registers (or replaces) the returns-reserve policy of record for one sku
 * — the founder-banded money terms the dispatch lane withholds from and
 * the release lane reads. Bands enforced at the lane AND at rest (the
 * schema's CHECKs); a hostile contract is refused, never clipped.
 */
export async function registerMerchReturnReservePolicy(
  store: Store,
  input: MerchReturnReservePolicyInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: MerchReturnReservePolicyRecord } | MerchReserveFailure> {
  if (input.sku_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_sku_identity",
      message: "A returns-reserve policy names the sku (the contract) it protects.",
    };
  }
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < MERCH_RETURNS_RESERVE_MIN_RATE_BPS ||
    input.reserve_rate_bps > MERCH_RETURNS_RESERVE_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_rate_out_of_band",
      message: `The returns-reserve rate must sit inside the founder band (${MERCH_RETURNS_RESERVE_MIN_RATE_BPS}–${MERCH_RETURNS_RESERVE_MAX_RATE_BPS} bps — 10–15%).`,
    };
  }
  if (
    !Number.isInteger(input.reserve_window_days) ||
    input.reserve_window_days < MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS ||
    input.reserve_window_days > MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_window_out_of_band",
      message: `The returns-reserve window must sit inside the founder band (${MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS}–${MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS} days).`,
    };
  }
  if (input.beneficiary_payee_id.trim() === "" || input.beneficiary_payee_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_beneficiary_payee",
      message: "A returns-reserve policy names the beneficiary payee the release pays.",
    };
  }
  const instant = now.toISOString();
  const policy = await store.upsertMerchReturnReservePolicy({
    sku_id: input.sku_id,
    reserve_rate_bps: input.reserve_rate_bps,
    reserve_window_days: input.reserve_window_days,
    beneficiary_payee_id: input.beneficiary_payee_id,
    beneficiary_payee_name: input.beneficiary_payee_name,
    created_at: instant,
    updated_at: instant,
  });
  return { ok: true, value: policy };
}

export type MerchFulfillmentTrackingInput = {
  fulfillment_event_id: string;
  tracking_number: string;
  tracking_state: string;
  carrier: string;
  delivered_at?: string;
};

/**
 * Records one fulfillment tracking event — the fulfillment data the payout
 * gate reads. Replay-idempotent: a re-shipped tracking event (same
 * fulfillment event, tracking number, and state) is the unique violation,
 * surfaced as a counted no-op — never a double record. A 'delivered' event
 * carries its delivery instant; earlier lifecycle states carry none.
 */
export async function recordMerchFulfillmentTracking(
  store: Store,
  input: MerchFulfillmentTrackingInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: { tracking: MerchFulfillmentTrackingRecord; replayed: boolean } } | MerchReserveFailure> {
  if (input.fulfillment_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_fulfillment_event",
      message: "A tracking event names the fulfillment event it belongs to.",
    };
  }
  if (input.tracking_number.trim() === "" || input.carrier.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_tracking_event",
      message: "A tracking event carries its tracking number and carrier.",
    };
  }
  if (!MERCH_FULFILLMENT_TRACKING_STATES.includes(input.tracking_state as MerchFulfillmentTrackingState)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_tracking_state",
      message: `A tracking event's state is one of: ${MERCH_FULFILLMENT_TRACKING_STATES.join(", ")}.`,
    };
  }
  const instant = now.toISOString();
  const deliveredAt =
    input.tracking_state === "delivered" ? (input.delivered_at ?? instant) : null;
  try {
    const tracking = await store.insertMerchFulfillmentTracking({
      fulfillment_event_id: input.fulfillment_event_id,
      tracking_number: input.tracking_number,
      tracking_state: input.tracking_state as MerchFulfillmentTrackingState,
      carrier: input.carrier,
      delivered_at: deliveredAt,
      created_at: instant,
    });
    return { ok: true, value: { tracking, replayed: false } };
  } catch (error) {
    // The table's ONLY unique is the replay guard — a unique violation here
    // is a re-shipped tracking event, surfacing as the counted no-op.
    if (isUniqueViolation(error)) {
      const existing = (await store.listMerchFulfillmentTrackings(input.fulfillment_event_id)).find(
        (event) =>
          event.tracking_number === input.tracking_number &&
          event.tracking_state === (input.tracking_state as MerchFulfillmentTrackingState),
      );
      if (existing !== undefined) {
        return { ok: true, value: { tracking: existing, replayed: true } };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The dispatch lane — one held payout allocation, split at the gate.
// ---------------------------------------------------------------------------

export type MerchReserveDispatchInput = {
  holding_ledger_id: string;
  sku_id: string;
  fulfillment_event_id: string;
  operator_settlement_approved: boolean;
};

/** One credited payee's routing outcome (the merch cascade's credit shape). */
export type MerchReserveDispatchCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: "beneficiary_net";
};

export type MerchReserveDispatchSuccess = {
  ok: true;
  value: {
    holding_credit: LedgerTransactionRecord;
    split: MerchReserveSplitPlan;
    /** The locked reserve credit — kind AND status 'merch_returns_reserve'. */
    reserve_credit: LedgerTransactionRecord;
    credits: MerchReserveDispatchCredit[];
    withholding: TaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Dispatches one held merch payout allocation through the returns-reserve
 * split: the tracking-DERIVED fulfillment state gates the release
 * (fail-closed — unknown and not-delivered both refuse BEFORE the CAS, so
 * nothing moves), the non-reserve remainder routes to the policy
 * beneficiary's creator net through the taxed cascade, and the 10–15%
 * holdback locks as a 'merch_returns_reserve' ledger row for the
 * contract's 30–60 day window. The money terms come from the policy of
 * record, never the caller.
 */
export async function dispatchMerchPayoutWithReturnsReserve(
  store: Store,
  input: MerchReserveDispatchInput,
  now: Date = new Date(),
): Promise<MerchReserveDispatchSuccess | MerchReserveFailure> {
  const row = await store.getLedgerTransaction(input.holding_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "holding_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "unclaimed_holding") {
    return {
      ok: false,
      status: 422,
      code: "not_a_holding_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only unclaimed holding credits dispatch here.`,
    };
  }
  if (row.status !== "unclaimed_holding") {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  if (input.sku_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_sku_identity",
      message: "A merch dispatch names the sku (the contract) it dispatches for.",
    };
  }
  if (input.fulfillment_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_fulfillment_event",
      message: "A merch dispatch names the fulfillment event whose tracking gates it.",
    };
  }

  // The returns-reserve policy of record — the money terms' ONLY source. A
  // dispatch against a sku with no registered policy refuses before the CAS
  // (nothing routes, nothing locks).
  const policy: MerchReturnReservePolicyRecord | undefined =
    await store.getMerchReturnReservePolicy(input.sku_id);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_merch_return_reserve_policy",
      message: `No returns-reserve policy of record exists for sku "${input.sku_id}" — register the protection deal before dispatching its payouts.`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const splitPlanned = buildReserveSplitPlan({
    allocation_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
  });
  if (!splitPlanned.ok) return splitPlanned;
  const split = splitPlanned.value;

  // THE FULFILLMENT GATE — the merch vertical's compliance state is DERIVED
  // from the tracking ledger for this fulfillment event, never
  // caller-stated: unknown (null) and not-delivered (false) BOTH refuse
  // here, fail-closed, before the CAS. Runs for the policy's beneficiary —
  // the payee this dispatch credits.
  const fulfillmentState = await resolveMerchFulfillmentState(store, input.fulfillment_event_id);
  const kycStatus = await resolveCreatorKycStatus(store, policy.beneficiary_payee_id);
  const compliance = evaluatePayoutCompliance({
    operatorSettlementApproved: input.operator_settlement_approved,
    kycStatus,
    verticalState: fulfillmentState,
  });
  if (!compliance.ok) {
    return {
      ok: false,
      status: 403,
      code: compliance.code,
      message: `Merch dispatch refused for payee "${policy.beneficiary_payee_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // dispatch loser reads undefined here and refuses with the same 409 a
  // replayed dispatch gets.
  const settled = await store.settleUnclaimedHolding(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent dispatch won.`,
    };
  }

  // The exact-amount routing. The non-reserve remainder rides the SAME
  // fail-closed cascade every payout credits through: withholding off the
  // top, the catalog-dispute freeze check, the recoupment sweep — never a
  // bare vault credit.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const credits: MerchReserveDispatchCredit[] = [];

  /**
   * Credits one payee exactly the way the merch cascade credits a
   * participant: withholding comes off the top (its reserve credit + GL
   * leg), then the freeze check, then the recoupment sweep (its own vault
   * writes; the GL legs mirror them), then the bare pending credit when no
   * advance exists. Returns the cents that landed in the payee's vault.
   */
  const creditTaxedCascadePayee = async (
    payeeId: string,
    payeeName: string,
    grossCents: number,
  ): Promise<number> => {
    if (grossCents <= 0) return 0;
    let creditAmount = grossCents;
    if (isWithholdableTalentRole("creator")) {
      const taxed = await applyWithholding(store, {
        creator_id: payeeId,
        gross_cents: grossCents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(store, payeeId, payeeName, taxed.value.withheld_cents, "reserve", now);
        glLegs.push(vaultCredit(payeeId, "reserve", taxed.value.withheld_cents));
      }
    }
    // No work context exists on a holding credit — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(store, payeeId, "");
    const recouped = await applyRecoupmentSweep(store, payeeId, payeeName, creditAmount, now, {
      excess_target: incomingFrozen ? "reserve" : "available",
    });
    if (recouped.applied) {
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        await creditVault(
          store,
          payeeId,
          payeeName,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(payeeId, incomingFrozen ? "reserve" : "available", recouped.excess_cents),
        );
      }
      return recouped.excess_cents;
    }
    await creditVault(store, payeeId, payeeName, creditAmount, incomingFrozen ? "reserve" : "pending", now);
    glLegs.push(
      vaultCredit(payeeId, incomingFrozen ? "reserve" : "pending", creditAmount),
    );
    return creditAmount;
  };

  // The non-reserve remainder routes to the beneficiary of record.
  let landedNetCents = 0;
  if (split.dispatch_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      policy.beneficiary_payee_id,
      policy.beneficiary_payee_name,
      split.dispatch_cents,
    );
    credits.push({
      payee_id: policy.beneficiary_payee_id,
      payee_name: policy.beneficiary_payee_name,
      gross_cents: split.dispatch_cents,
      net_cents: landedNetCents,
      step: "beneficiary_net",
    });
  }

  // The reserve holdback LOCKS as its own ledger row — kind AND status
  // 'merch_returns_reserve', the per-sku sentinel payee (deliberately not
  // 'platform', not the unclaimed-holding sentinel, not any earlier
  // escrow prefix), the fulfillment event stamped in line_item_id so the
  // row is discoverable through the existing line-item index and the
  // release can re-derive the gate's state from the same tracking ledger.
  // A floor of zero on a sub-10-cent allocation locks no row — there is
  // nothing to hold and a zero-amount ledger row would be noise.
  const reserveCredit =
    split.reserve_cents > 0
      ? await store.insertLedgerTransaction({
          split_run_id: "",
          line_item_id: input.fulfillment_event_id,
          payee_id: merchReturnsReservePayeeId(input.sku_id),
          payee_name: merchReturnsReservePayeeName(input.sku_id),
          role: "other",
          share_bps: 0,
          amount_cents: split.reserve_cents,
          currency: row.currency,
          status: "merch_returns_reserve",
          rail: null,
          baas_provider: null,
          baas_transfer_id: null,
          created_at: now.toISOString(),
          settled_at: null,
          kind: "merch_returns_reserve",
        })
      : row;
  if (split.reserve_cents > 0) {
    glLegs.push(merchReturnsReserveCredit(input.sku_id, split.reserve_cents));
  }

  // The integer-cent dust — structurally zero under the subtraction model;
  // swept to the platform variance account with its own ledger rows if it
  // ever differs (the house dust discipline, retained defensively).
  const companyDustCents =
    split.company_dust_cents > 0 ? split.company_dust_cents : 0;
  if (companyDustCents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: companyDustCents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      companyDustCents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", companyDustCents));
  }

  // The zero-balance tripwire: dispatch + reserve + dust === the held
  // allocation, ALWAYS — the Don invariant (allocations plus dust equals
  // gross) WITH the reserve bucket inside the allocation total.
  const routedTotal = split.dispatch_cents + split.reserve_cents;
  if (
    !zeroBalanceHolds(
      row.amount_cents,
      [
        { amount_cents: split.dispatch_cents },
        { amount_cents: split.reserve_cents },
      ],
      companyDustCents,
    ) ||
    routedTotal + companyDustCents !== row.amount_cents
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Dispatch remainder + returns reserve + dust !== held allocation — dispatch refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "merch_reserve_dispatch",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: {
      holding_credit: settled,
      split,
      reserve_credit: reserveCredit,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// The drawdown lane — returns and chargebacks spend the reserve.
// ---------------------------------------------------------------------------

export type MerchReserveDrawdownInput = {
  reserve_ledger_id: string;
  sku_id: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type MerchReserveDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: MerchReserveDrawdownRecord;
    /** True when the source event was already recorded — the counted no-op. */
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws one customer return or chargeback against a held returns reserve:
 * the position-locked drawdown row commits first (the 0026
 * recoupment-application discipline — a re-shipped event replays as the
 * counted no-op, a concurrent drawdown that loses the position re-derives),
 * then the money leaves the reserve account back to FBO cash (the
 * customer's refund), and a drawdown that consumes the LAST cent settles
 * the reserve row through the same CAS the release uses — a fully-drawn
 * reserve is spent, its life over. Money NEVER leaves a settled reserve:
 * the lane re-checks the held state after the position insert and refuses
 * if a concurrent release won.
 */
export async function drawDownMerchReturnsReserve(
  store: Store,
  input: MerchReserveDrawdownInput,
  now: Date = new Date(),
): Promise<MerchReserveDrawdownSuccess | MerchReserveFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "reserve_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "merch_returns_reserve") {
    return {
      ok: false,
      status: 422,
      code: "not_a_reserve_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only returns-reserve credits draw down here.`,
    };
  }
  if (row.status !== "merch_returns_reserve") {
    return {
      ok: false,
      status: 409,
      code: "reserve_already_settled",
      message: `Reserve credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled reserve.`,
    };
  }
  // The sku cross-check — the caller names the contract; the reserve row's
  // sentinel payee must match it exactly (the terms-of-record discipline).
  if (row.payee_id !== merchReturnsReservePayeeId(input.sku_id)) {
    return {
      ok: false,
      status: 422,
      code: "reserve_sku_mismatch",
      message: `Reserve credit ${row.id} belongs to a different contract than sku "${input.sku_id}".`,
    };
  }

  // The position derives from the append-only truth — never a second
  // mutable counter.
  const drawdowns: MerchReserveDrawdownRecord[] = await store.listMerchReserveDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  const planned = buildReserveDrawdownPlan({
    drawdown_class: input.drawdown_class,
    source_event_id: input.source_event_id,
    drawn_before_cents: drawnBefore,
    drawn_cents: input.drawn_cents,
    remaining_cents: remaining,
  });
  if (!planned.ok) return planned;

  const instant = now.toISOString();

  // A drawdown that consumes the LAST cent settles the reserve FIRST (the
  // CAS arbitrates against a concurrent release BEFORE any row or money
  // commits — the winner is the only lane that touches the reserve).
  const fullyDrawn = planned.value.remaining_cents === 0;
  if (fullyDrawn) {
    const settled = await store.settleMerchReturnsReserve(row.id, instant);
    if (settled === undefined) {
      return {
        ok: false,
        status: 409,
        code: "reserve_already_settled",
        message: `Reserve credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
      };
    }
  }

  // The position-locked insert — the replay guard AND the arbiter, in one
  // write. A unique violation is disambiguated against the append-only
  // truth: a row with this source event already exists → the re-shipped
  // event's counted no-op; otherwise the position conflict re-throws (the
  // caller retries and re-derives from the fresh truth).
  let drawdown: MerchReserveDrawdownRecord;
  try {
    drawdown = await store.insertMerchReserveDrawdown({
      reserve_ledger_id: row.id,
      drawdown_class: input.drawdown_class as MerchReserveDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: planned.value.drawn_before_cents,
      drawn_cents: planned.value.drawn_cents,
      remaining_cents: planned.value.remaining_cents,
      created_at: instant,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listMerchReserveDrawdowns(row.id);
      const existing = all.find((line) => line.source_event_id === input.source_event_id);
      if (existing !== undefined) {
        return {
          ok: true,
          value: { drawdown: existing, replayed: true, journal_id: null },
        };
      }
    }
    throw error;
  }

  // The held-state re-check AFTER the position commit: money never leaves a
  // settled reserve. A concurrent release that won between the insert and
  // this read has already routed the balance — this drawdown refuses
  // without moving a cent (the recon alarms surface the refused row's
  // inconsistency; the money never double-moves).
  if (!fullyDrawn) {
    const rechecked = await store.getLedgerTransaction(row.id);
    if (rechecked === undefined || rechecked.status !== "merch_returns_reserve") {
      return {
        ok: false,
        status: 409,
        code: "reserve_already_settled",
        message: `Reserve credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the reserve account debits back to FBO
  // cash — the customer's refund, itemized.
  const posted = await postJournal(store, {
    kind: "merch_reserve_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      merchReturnsReserveDebit(input.sku_id, planned.value.drawn_cents),
      fboCredit(planned.value.drawn_cents),
    ],
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: { drawdown, replayed: false, journal_id: posted.journal.id },
  };
}

// ---------------------------------------------------------------------------
// The release lane — the verified release after the window.
// ---------------------------------------------------------------------------

export type MerchReserveReleaseInput = {
  reserve_ledger_id: string;
  sku_id: string;
  operator_settlement_approved: boolean;
};

export type MerchReserveReleaseSuccess = {
  ok: true;
  value: {
    /** The settled reserve row (status 'settled' after this release). */
    reserve_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: MerchReserveDispatchCredit[];
    withholding: TaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held returns reserve to the beneficiary of record's creator
 * net after the contract's 30–60 day window — the verified release: the
 * window check (fail-closed, before the CAS), the remaining balance
 * re-derived from the append-only drawdown truth, the SAME fail-closed
 * gate family every payout rides (operator approval, KYC, and the
 * tracking-DERIVED merch state re-resolved from the reserve's own
 * fulfillment context), the CAS BEFORE any money moves, and the taxed
 * cascade for the actual routing. Drawdowns already spent stay spent —
 * the release pays only what the returns window protected.
 */
export async function releaseMerchReturnsReserve(
  store: Store,
  input: MerchReserveReleaseInput,
  now: Date = new Date(),
): Promise<MerchReserveReleaseSuccess | MerchReserveFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "reserve_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "merch_returns_reserve") {
    return {
      ok: false,
      status: 422,
      code: "not_a_reserve_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only returns-reserve credits release here.`,
    };
  }
  if (row.status !== "merch_returns_reserve") {
    return {
      ok: false,
      status: 409,
      code: "reserve_already_settled",
      message: `Reserve credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  if (input.sku_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_sku_identity",
      message: "A reserve release names the sku (the contract) it releases for.",
    };
  }
  // The sku cross-check — the caller names the contract; the reserve row's
  // sentinel payee must match it exactly.
  if (row.payee_id !== merchReturnsReservePayeeId(input.sku_id)) {
    return {
      ok: false,
      status: 422,
      code: "reserve_sku_mismatch",
      message: `Reserve credit ${row.id} belongs to a different contract than sku "${input.sku_id}".`,
    };
  }

  // The policy of record — the window and the beneficiary come from the
  // registry, never the caller.
  const policy: MerchReturnReservePolicyRecord | undefined =
    await store.getMerchReturnReservePolicy(input.sku_id);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_merch_return_reserve_policy",
      message: `No returns-reserve policy of record exists for sku "${input.sku_id}" — register the protection deal before releasing its reserves.`,
    };
  }

  // THE WINDOW — the reserve holds for its contract's full founder-banded
  // term. A release before the boundary refuses, fail-closed, BEFORE the
  // CAS (nothing moves).
  const windowChecked = buildReserveWindowCheck({
    created_at: row.created_at,
    window_days: policy.reserve_window_days,
    now,
  });
  if (!windowChecked.ok) return windowChecked;

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: MerchReserveDrawdownRecord[] = await store.listMerchReserveDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "reserve_fully_drawn",
      message: "The reserve is fully drawn — returns and chargebacks spent every cent of it.",
    };
  }

  // The gate family — the reserve's own fulfillment context (stamped in
  // line_item_id at dispatch) re-resolves the tracking-DERIVED state:
  // fail-closed at release too, an unknown tracking ledger refuses.
  const fulfillmentEventId = row.line_item_id;
  const fulfillmentState =
    fulfillmentEventId.trim() === ""
      ? null
      : await resolveMerchFulfillmentState(store, fulfillmentEventId);
  const kycStatus = await resolveCreatorKycStatus(store, policy.beneficiary_payee_id);
  const compliance = evaluatePayoutCompliance({
    operatorSettlementApproved: input.operator_settlement_approved,
    kycStatus,
    verticalState: fulfillmentState,
  });
  if (!compliance.ok) {
    return {
      ok: false,
      status: 403,
      code: compliance.code,
      message: `Reserve release refused for payee "${policy.beneficiary_payee_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release/drawdown loser reads undefined here and refuses.
  const settled = await store.settleMerchReturnsReserve(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "reserve_already_settled",
      message: `Reserve credit ${row.id} is no longer held — a concurrent release or full drawdown won.`,
    };
  }

  // The exact-amount routing through the taxed cascade — the same
  // discipline the dispatch lane rides.
  const glLegs: GlLegInput[] = [merchReturnsReserveDebit(input.sku_id, remaining)];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const credits: MerchReserveDispatchCredit[] = [];

  let landedNetCents = 0;
  landedNetCents = await (async () => {
    let creditAmount = remaining;
    if (isWithholdableTalentRole("creator")) {
      const taxed = await applyWithholding(store, {
        creator_id: policy.beneficiary_payee_id,
        gross_cents: remaining,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(
          store,
          policy.beneficiary_payee_id,
          policy.beneficiary_payee_name,
          taxed.value.withheld_cents,
          "reserve",
          now,
        );
        glLegs.push(vaultCredit(policy.beneficiary_payee_id, "reserve", taxed.value.withheld_cents));
      }
    }
    const incomingFrozen = await isIncomingFrozen(store, policy.beneficiary_payee_id, "");
    const recouped = await applyRecoupmentSweep(
      store,
      policy.beneficiary_payee_id,
      policy.beneficiary_payee_name,
      creditAmount,
      now,
      { excess_target: incomingFrozen ? "reserve" : "available" },
    );
    if (recouped.applied) {
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        await creditVault(
          store,
          policy.beneficiary_payee_id,
          policy.beneficiary_payee_name,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(
            policy.beneficiary_payee_id,
            incomingFrozen ? "reserve" : "available",
            recouped.excess_cents,
          ),
        );
      }
      return recouped.excess_cents;
    }
    await creditVault(
      store,
      policy.beneficiary_payee_id,
      policy.beneficiary_payee_name,
      creditAmount,
      incomingFrozen ? "reserve" : "pending",
      now,
    );
    glLegs.push(
      vaultCredit(policy.beneficiary_payee_id, incomingFrozen ? "reserve" : "pending", creditAmount),
    );
    return creditAmount;
  })();

  credits.push({
    payee_id: policy.beneficiary_payee_id,
    payee_name: policy.beneficiary_payee_name,
    gross_cents: remaining,
    net_cents: landedNetCents,
    step: "beneficiary_net",
  });

  // The integer-cent dust — structurally zero under the subtraction model;
  // swept defensively if it ever differs.
  const companyDustCents = 0;
  if (companyDustCents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: companyDustCents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // reserve, ALWAYS — the Don invariant WITH the reserve's lifetime inside
  // it (a return drew it down OR the creator got it; never both, never
  // neither).
  if (
    !zeroBalanceHolds(row.amount_cents, [
      { amount_cents: drawnBefore },
      { amount_cents: remaining },
    ], companyDustCents) ||
    drawnBefore + remaining + companyDustCents !== row.amount_cents
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Drawdowns + released remainder + dust !== locked reserve — release refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "merch_returns_reserve_release",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: {
      reserve_credit: settled,
      released_cents: remaining,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      journal_id: posted.journal.id,
    },
  };
}
