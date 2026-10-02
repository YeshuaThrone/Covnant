// Merchandise COGS + the brand collaboration waterfall (PR 22, founder
// directive).
//
// Physical merchandise money reconciles through the COGS engine: a
// fulfillment event's gross converts to net realized profit through
// explicit, exact-integer deduction legs, and a collaboration settlement
// releases through a founder-ordered waterfall where the manufacturing
// party recovers 100% of production reality before any profit split
// exists. The four features, in the founder's mandated order:
//
//   1. THE COGS DEDUCTION HANDLER — DTC drops compute
//          gross − unit production COGS − shipping/fulfillment fees
//          − payment gateway fees = net realized profit
//      (integer cents, every leg itemized); POD subtracts the base item
//      printing cost from gross customer prices BEFORE split percentages
//      are computed — the splits price the after-printing remainder, the
//      hand-checkable 999-cent case pins the distinction in tests; and
//      dynamic FIFO COGS amortization keyed on sku_id AND cogs_per_unit
//      consumes production lots oldest-first as orders ship.
//   2. THE BRAND COLLABORATION WATERFALL — step one recoups 100% of raw
//      blank sourcing and screen-printing overhead to the manufacturing
//      party (after the FIFO production debt, which amortizes FIRST — the
//      PR 105 reservation-before-commission discipline applied to unit
//      production debt: the raw production debt pays off before artist
//      profit splits release); step two splits the remainder per contract
//      (e.g. 50% brand / 50% collaborating artist, basis points of the
//      post-recoupment remainder).
//   3. DESIGN IP ROYALTY TIERS — guest designers receive flat per-unit
//      royalties (e.g. $3.50 per garment) billed DIRECTLY to order
//      fulfillment events: one append-only billing row per (fulfillment
//      event, sku), priced from the tier of record at fulfillment
//      processing time, never retroactively.
//   4. RETAIL CONSIGNMENT SHRINKAGE OFFSETTING — wholesale consignment
//      payout reports reconcile exactly (gross − commission − shrinkage
//      allowance = net payout, the report's own arithmetic verified
//      before any record exists) and the shrinkage/loss allowance offsets
//      the net payout settlement.
//
// The money path is the canonical recon posting seam: every merch
// movement posts to UNCLAIMED_HOLDING through postToUnclaimedHolding (no
// new post kind — the seam IS the arrival path, journal-ref-guarded per
// content-derived source event, 409 on replay), and the verified release
// consumes one held credit through the same fail-closed gate family every
// payout uses — operator settlement approval, Plaid-backed KYC, and the
// merch vertical's compliance state (physical_fulfillment_confirmed,
// caller-stated: tracking delivered) — before the exact-amount routing
// and the balanced merch_collab_release journal.
//
// THE EXACT-AMOUNT RELEASE. The seam's own releaseUnclaimedHolding
// allocates bps-of-gross; this lane's legs are EXACT integer cents (the
// ipOption/translation-escrow release's discipline — plan first, then
// route exactly what the plan computed, dust swept defensively). The
// settlement CAS (settleUnclaimedHolding) flips the held row BEFORE any
// money moves — insert-as-lock, the payout-reversal precedent: a crash
// mid-release fails toward "nothing moved twice". The FIFO consumption
// rows commit before any split money moves — the ordering is the point.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import type {
  CompanyDustRecord,
  MerchCogsConsumptionRecord,
  MerchCogsLotRecord,
  MerchCollabAgreementRecord,
  MerchCollabPoolClass,
  MerchCollabRecoupmentApplicationRecord,
  MerchDesignerRoyaltyTierRecord,
  TaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { postToUnclaimedHolding } from "@/lib/server/unclaimedHolding";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";
import { postJournal } from "@/modules/ledger/engine";
import {
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";

/** House failure envelope — the webtoon cascade / unclaimed-holding shape. */
export type MerchCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// The COGS deduction handler — the pure DTC/POD planners.
// ---------------------------------------------------------------------------

/** One itemized deduction leg of the DTC net-realized-profit equation. */
export type DtcNetRealizedProfitPlan = {
  gross_cents: number;
  /** The FIFO-amortized unit production COGS — the lot-sourced deduction. */
  production_cogs_cents: number;
  shipping_fee_cents: number;
  fulfillment_fee_cents: number;
  gateway_fee_cents: number;
  /**
   * The guest designer's per-unit royalty billed to the fulfillment event —
   * deducted from the order's proceeds (the brand-side money), its own
   * holding credit posted alongside (conservation: the pair totals the
   * gross minus the third-party fees).
   */
  designer_royalty_cents: number;
  /** gross − COGS − shipping − fulfillment − gateway − royalty, exact. */
  net_realized_profit_cents: number;
};

export type DtcNetRealizedProfitPlanInput = {
  gross_cents: number;
  production_cogs_cents: number;
  shipping_fee_cents: number;
  fulfillment_fee_cents: number;
  gateway_fee_cents: number;
  designer_royalty_cents: number;
};

/**
 * The PURE DTC equation — gross minus unit production COGS minus shipping
 * and fulfillment fees minus payment gateway fees (minus the billed
 * designer royalty) equals net realized profit. Integer-exact, every leg
 * itemized; refuses (fail-closed) a negative or malformed leg and a
 * deduction total that exceeds the gross — a refund-shaped row is a
 * quarantine for the operator, never a negative settlement.
 */
export function buildDtcNetRealizedProfitPlan(
  input: DtcNetRealizedProfitPlanInput,
): { ok: true; value: DtcNetRealizedProfitPlan } | MerchCascadeFailure {
  const legs = [
    ["gross_cents", input.gross_cents],
    ["production_cogs_cents", input.production_cogs_cents],
    ["shipping_fee_cents", input.shipping_fee_cents],
    ["fulfillment_fee_cents", input.fulfillment_fee_cents],
    ["gateway_fee_cents", input.gateway_fee_cents],
    ["designer_royalty_cents", input.designer_royalty_cents],
  ] as const;
  for (const [name, value] of legs) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_dtc_leg",
        message: `The DTC net-realized-profit equation needs whole non-negative integer cents for ${name}.`,
      };
    }
  }
  const deductions =
    input.production_cogs_cents +
    input.shipping_fee_cents +
    input.fulfillment_fee_cents +
    input.gateway_fee_cents +
    input.designer_royalty_cents;
  const netRealizedProfitCents = input.gross_cents - deductions;
  if (netRealizedProfitCents < 0) {
    return {
      ok: false,
      status: 422,
      code: "deductions_exceed_gross",
      message: `DTC deductions (${deductions}c) exceed the gross (${input.gross_cents}c) — a loss-shaped row is an operator quarantine, never a negative settlement.`,
    };
  }
  return {
    ok: true,
    value: {
      gross_cents: input.gross_cents,
      production_cogs_cents: input.production_cogs_cents,
      shipping_fee_cents: input.shipping_fee_cents,
      fulfillment_fee_cents: input.fulfillment_fee_cents,
      gateway_fee_cents: input.gateway_fee_cents,
      designer_royalty_cents: input.designer_royalty_cents,
      net_realized_profit_cents: netRealizedProfitCents,
    },
  };
}

export type PodNetAfterPrintingPlan = {
  gross_customer_price_cents: number;
  /** The POD vendor's base item printing cost — off the top. */
  base_printing_cost_cents: number;
  /** The after-printing remainder — the base split percentages price. */
  net_after_printing_cents: number;
};

/**
 * The PURE POD deduction — the base item printing cost comes off the
 * gross customer price BEFORE split percentages exist. The result is the
 * base every split prices; a split computed from the gross instead is the
 * exact bug the 999-cent test pins (gross 999 − printing 1 → splits price
 * 998, not 999).
 */
export function buildPodNetAfterPrintingPlan(
  gross_customer_price_cents: number,
  base_printing_cost_cents: number,
): { ok: true; value: PodNetAfterPrintingPlan } | MerchCascadeFailure {
  if (!Number.isSafeInteger(gross_customer_price_cents) || gross_customer_price_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pod_gross",
      message: "A POD row prices whole non-negative integer cents of gross customer price.",
    };
  }
  if (!Number.isSafeInteger(base_printing_cost_cents) || base_printing_cost_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pod_printing_cost",
      message: "A POD row prices whole non-negative integer cents of base printing cost.",
    };
  }
  const netAfterPrinting = gross_customer_price_cents - base_printing_cost_cents;
  if (netAfterPrinting < 0) {
    return {
      ok: false,
      status: 422,
      code: "printing_cost_exceeds_gross",
      message: `The base printing cost (${base_printing_cost_cents}c) exceeds the gross customer price (${gross_customer_price_cents}c) — the row is an operator quarantine, never a negative settlement.`,
    };
  }
  return {
    ok: true,
    value: {
      gross_customer_price_cents,
      base_printing_cost_cents,
      net_after_printing_cents: netAfterPrinting,
    },
  };
}

export type PodSplitPlan = {
  /** The after-printing remainder the split prices — never the gross. */
  net_after_printing_cents: number;
  split_bps: number;
  /** floor(remainder × bps / 10000) — the collaborating party's share. */
  split_amount_cents: number;
  /** The complement — what survives for the counterparty. */
  residual_cents: number;
};

/**
 * The PURE POD split — basis points OF THE AFTER-PRINTING REMAINDER
 * (printing first, splits second — never of the gross). Floored leg, the
 * complement takes what survives; structurally dustless.
 */
export function buildPodSplitPlan(
  net_after_printing_cents: number,
  split_bps: number,
): { ok: true; value: PodSplitPlan } | MerchCascadeFailure {
  if (!Number.isSafeInteger(net_after_printing_cents) || net_after_printing_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pod_remainder",
      message: "A POD split prices whole non-negative integer cents of the after-printing remainder.",
    };
  }
  if (!Number.isSafeInteger(split_bps) || split_bps < 0 || split_bps > BPS_DENOMINATOR) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pod_split_bps",
      message: "The POD split is whole basis points between 0 and 10000 of the after-printing remainder.",
    };
  }
  const splitAmount = Math.floor((net_after_printing_cents * split_bps) / BPS_DENOMINATOR);
  return {
    ok: true,
    value: {
      net_after_printing_cents,
      split_bps,
      split_amount_cents: splitAmount,
      residual_cents: net_after_printing_cents - splitAmount,
    },
  };
}

// ---------------------------------------------------------------------------
// The FIFO amortization — the pure lot-consumption planner.
// ---------------------------------------------------------------------------

/** The lot state the planner walks — the lot plus its derived consumed units. */
export type MerchFifoLotState = {
  id: string;
  lot_ref: string;
  units_produced: number;
  cogs_per_unit_cents: number;
  /** Σ of the lot's existing consumption lines — the append-only truth. */
  consumed_units: number;
};

/** One per-lot FIFO consumption leg, oldest lot first. */
export type MerchFifoConsumptionLeg = {
  lot_id: string;
  lot_ref: string;
  /** The lot's consumed-units position this leg consumes from. */
  units_consumed_before: number;
  units_consumed: number;
  cogs_per_unit_cents: number;
  /** units_consumed × cogs_per_unit_cents — the exact amortization. */
  amortized_cents: number;
};

export type MerchFifoConsumptionPlan = {
  units_to_consume: number;
  /** The consumption legs in FIFO order (oldest lot first). */
  legs: MerchFifoConsumptionLeg[];
  /** Σ amortized — the raw production debt this settlement pays off. */
  amortized_total_cents: number;
};

/**
 * The PURE FIFO walk — consume the settlement's units from the sku's
 * production lots OLDEST FIRST (the caller passes lots already in FIFO
 * order: created_at ASC, lot_ref ASC), each lot priced at its OWN
 * cogs_per_unit_cents (the amortization is keyed on sku_id AND
 * cogs_per_unit). Never amortizes more than was produced: a lot consumes
 * only its remaining units, and a settlement the registered production
 * cannot cover refuses (fail-closed — the raw production debt cannot be
 * amortized out of thin air, so no split may release over it).
 */
export function buildMerchFifoConsumptionPlan(
  lots: readonly MerchFifoLotState[],
  units_to_consume: number,
): { ok: true; value: MerchFifoConsumptionPlan } | MerchCascadeFailure {
  if (!Number.isSafeInteger(units_to_consume) || units_to_consume < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_units_to_consume",
      message: "A FIFO amortization consumes a whole non-negative unit count.",
    };
  }
  const legs: MerchFifoConsumptionLeg[] = [];
  let remainingUnits = units_to_consume;
  let amortizedTotal = 0;
  for (const lot of lots) {
    if (remainingUnits === 0) break;
    const consumedBefore = lot.consumed_units;
    const lotRemaining = lot.units_produced - consumedBefore;
    if (lotRemaining <= 0) continue;
    const take = Math.min(lotRemaining, remainingUnits);
    legs.push({
      lot_id: lot.id,
      lot_ref: lot.lot_ref,
      units_consumed_before: consumedBefore,
      units_consumed: take,
      cogs_per_unit_cents: lot.cogs_per_unit_cents,
      amortized_cents: take * lot.cogs_per_unit_cents,
    });
    amortizedTotal += take * lot.cogs_per_unit_cents;
    remainingUnits -= take;
  }
  if (remainingUnits > 0) {
    return {
      ok: false,
      status: 422,
      code: "cogs_lots_exhausted",
      message: `The sku's registered production lots cannot cover ${units_to_consume} units (${remainingUnits} short) — register the production the settlement sold before releasing it; no split releases over unamortized production debt.`,
    };
  }
  return { ok: true, value: { units_to_consume, legs, amortized_total_cents: amortizedTotal } };
}

// ---------------------------------------------------------------------------
// The collab waterfall — the pure ordered allocator.
// ---------------------------------------------------------------------------

export type MerchWaterfallLeg = {
  step:
    | "cogs_recovery"
    | "blank_sourcing_recoupment"
    | "screen_printing_recoupment"
    | "artist_split"
    | "brand_residual";
  payee_id: string;
  payee_name: string;
  amount_cents: number;
};

export type MerchCollabWaterfallPlan = {
  /** The held settlement the waterfall splits — the plan's whole base. */
  settlement_cents: number;
  /** Step 0 — the FIFO production debt, recovered to the manufacturer FIRST. */
  cogs_recovery_cents: number;
  /** Step 1a — 100% of the open blank-sourcing pool, to the manufacturer. */
  blank_sourcing_applied_cents: number;
  /** Step 1b — 100% of the open screen-printing pool, to the manufacturer. */
  screen_printing_applied_cents: number;
  /** Step 2a — the artist's bps of the post-recoupment remainder, floored. */
  artist_split_cents: number;
  /** Step 2b — the brand's complement, LAST. */
  brand_residual_cents: number;
  legs: MerchWaterfallLeg[];
  /**
   * Structurally zero under the subtraction model — computed defensively
   * and swept to the platform variance account if it ever differs.
   */
  company_dust_cents: number;
};

export type MerchCollabWaterfallPlanInput = {
  settlement_cents: number;
  cogs_amortized_cents: number;
  /** The OPEN pool amounts (fronted overhead − prior applications). */
  blank_sourcing_open_cents: number;
  screen_printing_open_cents: number;
  artist_split_bps: number;
  manufacturer: { payee_id: string; payee_name: string };
  brand: { payee_id: string; payee_name: string };
  artist: { payee_id: string; payee_name: string };
};

/**
 * The PURE founder-ordered allocator — the test pin for the waterfall's
 * ordering. Sequential, each step computed from what the previous steps
 * left:
 *
 *   0. FIFO COGS recovery — the raw production debt pays off FIRST (the
 *      PR 105 reservation-before-commission discipline, applied to unit
 *      production debt),
 *   1. 100% recoupment of the fronted manufacturing overhead — blank
 *      sourcing, then screen printing — to the manufacturing party,
 *   2. the contracted profit split of what survives — the artist's basis
 *      points of the post-recoupment remainder (floored), the brand's
 *      complement LAST.
 *
 * Integer-exact throughout; refuses a malformed party, malformed pool
 * state, or an amortization larger than the settlement can carry.
 */
export function buildMerchCollabWaterfallPlan(
  input: MerchCollabWaterfallPlanInput,
): { ok: true; value: MerchCollabWaterfallPlan } | MerchCascadeFailure {
  const {
    settlement_cents,
    cogs_amortized_cents,
    blank_sourcing_open_cents,
    screen_printing_open_cents,
    artist_split_bps,
  } = input;
  if (!Number.isSafeInteger(settlement_cents) || settlement_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_settlement",
      message: "A collab settlement releases integer cents greater than zero.",
    };
  }
  if (!Number.isSafeInteger(cogs_amortized_cents) || cogs_amortized_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_cogs_amortized",
      message: "The FIFO amortization is whole non-negative integer cents.",
    };
  }
  for (const [name, value] of [
    ["blank_sourcing_open_cents", blank_sourcing_open_cents],
    ["screen_printing_open_cents", screen_printing_open_cents],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_pool_state",
        message: `The ${name} pool is whole non-negative integer cents.`,
      };
    }
  }
  if (
    !Number.isSafeInteger(artist_split_bps) ||
    artist_split_bps < 0 ||
    artist_split_bps > BPS_DENOMINATOR
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_artist_split_bps",
      message: "The artist split is whole basis points between 0 and 10000 of the post-recoupment remainder.",
    };
  }
  for (const [role, party] of [
    ["manufacturer", input.manufacturer],
    ["brand", input.brand],
    ["artist", input.artist],
  ] as const) {
    if (party.payee_id.trim() === "" || party.payee_name.trim() === "") {
      return {
        ok: false,
        status: 422,
        code: "invalid_party_identity",
        message: `A collab waterfall names the ${role} of record (id and name).`,
      };
    }
  }

  // Step 0 — the raw production debt pays off FIRST. Every later step
  // computes from what this left.
  if (cogs_amortized_cents > settlement_cents) {
    return {
      ok: false,
      status: 422,
      code: "cogs_exceeds_settlement",
      message: `The FIFO amortization (${cogs_amortized_cents}c) exceeds the settlement (${settlement_cents}c) — the production debt cannot be recovered out of money the settlement does not carry.`,
    };
  }
  const afterCogs = settlement_cents - cogs_amortized_cents;

  // Step 1 — 100% recoupment of the fronted overhead to the manufacturing
  // party: blank sourcing first, screen printing second, each bounded by
  // what the settlement still carries (a pool that outruns this
  // settlement recoups partially and stays open for the next one).
  const blankApplied = Math.min(blank_sourcing_open_cents, afterCogs);
  const afterBlank = afterCogs - blankApplied;
  const screenApplied = Math.min(screen_printing_open_cents, afterBlank);
  const afterRecoupment = afterBlank - screenApplied;

  // Step 2 — the contracted split of the post-recoupment remainder: the
  // artist's basis points (floored), the brand's complement LAST. This
  // line is the founder's recoup-then-split discipline, in arithmetic
  // form — the split prices what the manufacturing party's recovery LEFT.
  const artistSplit = Math.floor((afterRecoupment * artist_split_bps) / BPS_DENOMINATOR);
  const brandResidual = afterRecoupment - artistSplit;

  const legs: MerchWaterfallLeg[] = [];
  if (cogs_amortized_cents > 0) {
    legs.push({
      step: "cogs_recovery",
      payee_id: input.manufacturer.payee_id,
      payee_name: input.manufacturer.payee_name,
      amount_cents: cogs_amortized_cents,
    });
  }
  if (blankApplied > 0) {
    legs.push({
      step: "blank_sourcing_recoupment",
      payee_id: input.manufacturer.payee_id,
      payee_name: input.manufacturer.payee_name,
      amount_cents: blankApplied,
    });
  }
  if (screenApplied > 0) {
    legs.push({
      step: "screen_printing_recoupment",
      payee_id: input.manufacturer.payee_id,
      payee_name: input.manufacturer.payee_name,
      amount_cents: screenApplied,
    });
  }
  if (artistSplit > 0) {
    legs.push({
      step: "artist_split",
      payee_id: input.artist.payee_id,
      payee_name: input.artist.payee_name,
      amount_cents: artistSplit,
    });
  }
  if (brandResidual > 0) {
    legs.push({
      step: "brand_residual",
      payee_id: input.brand.payee_id,
      payee_name: input.brand.payee_name,
      amount_cents: brandResidual,
    });
  }

  const routedTotal = legs.reduce((total, leg) => total + leg.amount_cents, 0);
  const companyDust = settlement_cents - routedTotal;

  return {
    ok: true,
    value: {
      settlement_cents,
      cogs_recovery_cents: cogs_amortized_cents,
      blank_sourcing_applied_cents: blankApplied,
      screen_printing_applied_cents: screenApplied,
      artist_split_cents: artistSplit,
      brand_residual_cents: brandResidual,
      legs,
      company_dust_cents: companyDust,
    },
  };
}

// ---------------------------------------------------------------------------
// The royalty + consignment planners.
// ---------------------------------------------------------------------------

/**
 * The PURE per-unit royalty — units × the tier's flat per-unit royalty,
 * the exact integer product (e.g. 3 units × 350c = 1050c).
 */
export function buildDesignerRoyaltyBillingPlan(
  units_billed: number,
  royalty_per_unit_cents: number,
): { ok: true; value: { billed_cents: number } } | MerchCascadeFailure {
  if (!Number.isSafeInteger(units_billed) || units_billed <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_royalty_units",
      message: "A designer royalty bills a whole positive unit count.",
    };
  }
  if (!Number.isSafeInteger(royalty_per_unit_cents) || royalty_per_unit_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_royalty_tier",
      message: "A designer royalty tier prices a whole positive cent amount per unit.",
    };
  }
  return { ok: true, value: { billed_cents: units_billed * royalty_per_unit_cents } };
}

export type ConsignmentReconciliationPlan = {
  gross_cents: number;
  commission_cents: number;
  /** The shrinkage/loss allowance — the OFFSET against the payout. */
  shrinkage_allowance_cents: number;
  /** gross − commission − shrinkage — the settlement the partner owes. */
  net_payout_cents: number;
};

/**
 * The PURE consignment reconciliation — the wholesale partner's payout
 * report must reconcile EXACTLY: gross − commission − shrinkage allowance
 * = net payout. `reported_net_payout_cents` is the report's own figure; a
 * row that disagrees with its own arithmetic is hostile (the KENP
 * rate-consistency discipline) and refuses whole. A negative payout is a
 * clawback-shaped row, not a settlement — refuses.
 */
export function buildConsignmentSettlementReconciliationPlan(input: {
  gross_cents: number;
  commission_cents: number;
  shrinkage_allowance_cents: number;
  reported_net_payout_cents: number;
}): { ok: true; value: ConsignmentReconciliationPlan } | MerchCascadeFailure {
  for (const [name, value] of [
    ["gross_cents", input.gross_cents],
    ["commission_cents", input.commission_cents],
    ["shrinkage_allowance_cents", input.shrinkage_allowance_cents],
    ["reported_net_payout_cents", input.reported_net_payout_cents],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_consignment_leg",
        message: `A consignment payout prices whole non-negative integer cents for ${name}.`,
      };
    }
  }
  const netPayout =
    input.gross_cents - input.commission_cents - input.shrinkage_allowance_cents;
  if (netPayout < 0) {
    return {
      ok: false,
      status: 422,
      code: "payout_reconciliation_negative",
      message: `Commission + shrinkage (${input.commission_cents + input.shrinkage_allowance_cents}c) exceed the gross (${input.gross_cents}c) — a clawback-shaped row is an operator quarantine, never a negative settlement.`,
    };
  }
  if (netPayout !== input.reported_net_payout_cents) {
    return {
      ok: false,
      status: 422,
      code: "payout_reconciliation_mismatch",
      message: `The report's net payout (${input.reported_net_payout_cents}c) does not reconcile to gross − commission − shrinkage (${netPayout}c) — the row is rejected whole, never silently adjusted.`,
    };
  }
  return {
    ok: true,
    value: {
      gross_cents: input.gross_cents,
      commission_cents: input.commission_cents,
      shrinkage_allowance_cents: input.shrinkage_allowance_cents,
      net_payout_cents: netPayout,
    },
  };
}

// ---------------------------------------------------------------------------
// The registrations — the terms of record the release reads.
// ---------------------------------------------------------------------------

/**
 * Registers one production lot of record — the batch's unit count and
 * per-unit production cost. UNIQUE on (sku_id, lot_ref); a re-registered
 * lot surfaces the store's unique violation (the replay surface).
 */
export async function registerMerchCogsLot(
  store: Store,
  row: Omit<MerchCogsLotRecord, "id">,
): Promise<MerchCogsLotRecord> {
  return store.insertMerchCogsLot(row);
}

/**
 * Registers (or replaces) the collab agreement of record for one sku —
 * the manufacturer/brand/artist of record, the artist's basis-point split
 * of the post-recoupment remainder, and the fronted overhead amounts.
 */
export async function registerMerchCollabAgreement(
  store: Store,
  row: Omit<MerchCollabAgreementRecord, "id">,
): Promise<MerchCollabAgreementRecord> {
  return store.upsertMerchCollabAgreement(row);
}

/**
 * Registers (or replaces) the designer royalty tier of record for one
 * sku — the flat per-unit royalty the fulfillment billing prices from.
 */
export async function registerMerchDesignerRoyaltyTier(
  store: Store,
  row: Omit<MerchDesignerRoyaltyTierRecord, "id">,
): Promise<MerchDesignerRoyaltyTierRecord> {
  return store.upsertMerchDesignerRoyaltyTier(row);
}

// ---------------------------------------------------------------------------
// The arrivals — merch money posts to holding through the canonical seam.
// ---------------------------------------------------------------------------

export type MerchSeamPostSuccess = {
  ok: true;
  value: {
    /**
     * The posted holding credit — null on a replay (the seam's journal-ref
     * guard caught the re-post; the original row stands, nothing re-posts).
     */
    holding_credit: LedgerTransactionRecord | null;
    /** Empty on a replay — the original journal stands. */
    journal_id: string;
    source_event_id: string;
    /** True when the seam's replay guard caught a re-post (counted no-op). */
    replayed: boolean;
  };
};

/**
 * Posts one merch fulfillment event's net to UNCLAIMED_HOLDING through the
 * canonical recon seam — the order's gross minus the third-party fee legs
 * minus the billed designer royalty. Replay-idempotent per content-derived
 * source event (409 on replay → the counted no-op shape).
 */
export async function postMerchFulfillmentNetToHolding(
  store: Store,
  input: {
    source_event_id: string;
    amount_cents: number;
    currency: string;
  },
  now: Date = new Date(),
): Promise<MerchSeamPostSuccess | MerchCascadeFailure> {
  if (input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_merch_event_id",
      message: "A merch fulfillment post carries a content-derived event id.",
    };
  }
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    // Sub-cent and loss-shaped rows never post — the lane quarantines them
    // upstream; the seam refuses them here, fail-closed.
    return {
      ok: false,
      status: 422,
      code: "invalid_merch_amount",
      message: "A merch fulfillment post carries whole integer cents greater than zero.",
    };
  }
  const posted = await postToUnclaimedHolding(
    store,
    {
      amount_cents: input.amount_cents,
      currency: input.currency,
      source: { type: "recon_job", job_id: input.source_event_id },
    },
    now,
  );
  if (!posted.ok) {
    // The seam's journal-ref replay guard — a re-posted fulfillment event
    // surfaces as the counted no-op, not a failure. The original row and
    // journal stand; nothing is re-read or re-posted.
    if (posted.code === "unclaimed_holding_already_posted") {
      return {
        ok: true,
        value: {
          holding_credit: null,
          journal_id: "",
          source_event_id: input.source_event_id,
          replayed: true,
        },
      };
    }
    return posted;
  }
  return {
    ok: true,
    value: {
      holding_credit: posted.value.holding_credit,
      journal_id: posted.value.journal_id,
      source_event_id: input.source_event_id,
      replayed: false,
    },
  };
}

export type DesignerRoyaltyBillingSuccess = {
  ok: true;
  value: {
    billed_cents: number;
    units_billed: number;
    royalty_per_unit_cents: number;
    designer_payee_id: string;
    designer_payee_name: string;
    /** True when the billing row already existed (the replay no-op). */
    billing_replayed: boolean;
    /** True when the royalty's holding post hit the seam's replay guard. */
    royalty_post_replayed: boolean;
  };
};

/**
 * Bills the guest designer's flat per-unit royalty DIRECTLY to one order
 * fulfillment event: the append-only billing row (UNIQUE per (fulfillment
 * event, sku) — the replay guard) plus the royalty's own holding credit
 * through the canonical seam (content-derived event id — the replay
 * guard). Conservation: the royalty is deducted from the fulfillment
 * event's posted net (the caller's job) and posted here for the designer —
 * the pair totals the gross minus the third-party fees, exactly.
 *
 * Both writes are attempted on every pass and each is independently
 * replay-idempotent — a replayed fulfillment event hits both guards and
 * counts two no-ops, never a double billing and never a double post.
 * The tier is the state of record at fulfillment processing time; a
 * fulfillment event processed before any tier registration bills nothing
 * (never retroactively).
 */
export async function billDesignerRoyaltyForFulfillment(
  store: Store,
  input: {
    fulfillment_event_id: string;
    sku_id: string;
    units: number;
    currency: string;
  },
  now: Date = new Date(),
): Promise<DesignerRoyaltyBillingSuccess | MerchCascadeFailure> {
  if (input.fulfillment_event_id.trim() === "" || input.sku_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_royalty_identity",
      message: "A designer royalty billing names the fulfillment event and sku.",
    };
  }
  const tier: MerchDesignerRoyaltyTierRecord | undefined = await store.getMerchDesignerRoyaltyTier(
    input.sku_id,
  );
  if (tier === undefined) {
    // No tier of record — nothing bills. Not an error: the lane counts the
    // honest zero and moves on.
    return {
      ok: true,
      value: {
        billed_cents: 0,
        units_billed: 0,
        royalty_per_unit_cents: 0,
        designer_payee_id: "",
        designer_payee_name: "",
        billing_replayed: false,
        royalty_post_replayed: false,
      },
    };
  }
  const planned = buildDesignerRoyaltyBillingPlan(input.units, tier.royalty_per_unit_cents);
  if (!planned.ok) return planned;

  let billingReplayed = false;
  try {
    await store.insertMerchDesignerRoyaltyBilling({
      source_event_id: input.fulfillment_event_id,
      sku_id: input.sku_id,
      designer_payee_id: tier.designer_payee_id,
      designer_payee_name: tier.designer_payee_name,
      units_billed: input.units,
      royalty_per_unit_cents: tier.royalty_per_unit_cents,
      billed_cents: planned.value.billed_cents,
      created_at: now.toISOString(),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    billingReplayed = true;
  }

  // The royalty's own holding credit — posted for the designer, replay-
  // guarded by the seam's journal ref. Attempted even when the billing
  // row replayed: the two guards are independent, so a crash between the
  // billing insert and the post heals on the replay.
  const royaltyEventId = `merch_royalty_${input.fulfillment_event_id}`;
  const posted = await postToUnclaimedHolding(
    store,
    {
      amount_cents: planned.value.billed_cents,
      currency: input.currency,
      source: { type: "recon_job", job_id: royaltyEventId },
    },
    now,
  );
  let royaltyPostReplayed = false;
  if (!posted.ok) {
    if (posted.code !== "unclaimed_holding_already_posted") return posted;
    royaltyPostReplayed = true;
  }
  return {
    ok: true,
    value: {
      billed_cents: planned.value.billed_cents,
      units_billed: input.units,
      royalty_per_unit_cents: tier.royalty_per_unit_cents,
      designer_payee_id: tier.designer_payee_id,
      designer_payee_name: tier.designer_payee_name,
      billing_replayed: billingReplayed,
      royalty_post_replayed: royaltyPostReplayed,
    },
  };
}

export type ConsignmentSettlementSuccess = {
  ok: true;
  value: {
    net_payout_cents: number;
    shrinkage_allowance_cents: number;
    /** True when the settlement row already existed (the replay no-op). */
    settlement_replayed: boolean;
    /** True when the net payout's holding post hit the seam's replay guard. */
    post_replayed: boolean;
  };
};

/**
 * Records one wholesale consignment payout settlement — the durable
 * shrinkage reconciliation — and posts the net payout to holding through
 * the canonical seam. The report row's arithmetic must reconcile exactly
 * (gross − commission − shrinkage = the report's own net payout) before
 * either write exists; a row that disagrees with itself is rejected whole.
 * Both writes are attempted on every pass and independently
 * replay-idempotent (the UNIQUE event id and the seam's journal ref).
 */
export async function recordMerchConsignmentSettlement(
  store: Store,
  input: {
    event_id: string;
    period: string;
    location: string;
    sku_id: string;
    units_sold: number;
    gross_cents: number;
    commission_cents: number;
    shrinkage_allowance_cents: number;
    reported_net_payout_cents: number;
    currency: string;
  },
  now: Date = new Date(),
): Promise<ConsignmentSettlementSuccess | MerchCascadeFailure> {
  const reconciled = buildConsignmentSettlementReconciliationPlan({
    gross_cents: input.gross_cents,
    commission_cents: input.commission_cents,
    shrinkage_allowance_cents: input.shrinkage_allowance_cents,
    reported_net_payout_cents: input.reported_net_payout_cents,
  });
  if (!reconciled.ok) return reconciled;

  let settlementReplayed = false;
  try {
    await store.insertMerchConsignmentSettlement({
      event_id: input.event_id,
      period: input.period,
      location: input.location,
      sku_id: input.sku_id,
      units_sold: input.units_sold,
      gross_cents: reconciled.value.gross_cents,
      commission_cents: reconciled.value.commission_cents,
      shrinkage_allowance_cents: reconciled.value.shrinkage_allowance_cents,
      net_payout_cents: reconciled.value.net_payout_cents,
      currency: input.currency,
      created_at: now.toISOString(),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    settlementReplayed = true;
  }

  if (reconciled.value.net_payout_cents <= 0) {
    // The reconciliation recorded; nothing posts — a zero payout is an
    // honest settlement with no money in it.
    return {
      ok: true,
      value: {
        net_payout_cents: reconciled.value.net_payout_cents,
        shrinkage_allowance_cents: reconciled.value.shrinkage_allowance_cents,
        settlement_replayed: settlementReplayed,
        post_replayed: false,
      },
    };
  }

  const posted = await postToUnclaimedHolding(
    store,
    {
      amount_cents: reconciled.value.net_payout_cents,
      currency: input.currency,
      source: { type: "recon_job", job_id: input.event_id },
    },
    now,
  );
  let postReplayed = false;
  if (!posted.ok) {
    if (posted.code !== "unclaimed_holding_already_posted") return posted;
    postReplayed = true;
  }
  return {
    ok: true,
    value: {
      net_payout_cents: reconciled.value.net_payout_cents,
      shrinkage_allowance_cents: reconciled.value.shrinkage_allowance_cents,
      settlement_replayed: settlementReplayed,
      post_replayed: postReplayed,
    },
  };
}

// ---------------------------------------------------------------------------
// The verified release — the founder-ordered collab waterfall.
// ---------------------------------------------------------------------------

export interface MerchCollabReleaseInput {
  /** The held credit to release (the ledger row id). */
  holding_ledger_id: string;
  /** The merch sku — names the collab agreement of record. */
  sku_id: string;
  /**
   * The lot-produced unit count this settlement covers — the FIFO
   * amortization's input. A POD-settled sku (the vendor produced; no
   * fronted lots) passes 0.
   */
  units_shipped: number;
  /** The gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
  /**
   * The merch vertical's condition, stated EXPLICITLY by the caller —
   * tracking delivered. The gate still requires it, fail-closed.
   */
  physical_fulfillment_confirmed: boolean;
}

export type MerchCollabReleaseCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: MerchWaterfallLeg["step"];
};

export type MerchCollabReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'unclaimed_holding'. */
    holding_credit: LedgerTransactionRecord;
    fifo: MerchFifoConsumptionPlan;
    waterfall: MerchCollabWaterfallPlan;
    credits: MerchCollabReleaseCredit[];
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    withholding: TaxEscrowRecord[];
    journal_id: string;
  };
};

/**
 * Releases one held merch settlement through the founder-ordered
 * collaboration waterfall — ONLY through the standing gate family:
 *
 *   1. the row must be a HELD holding credit (404 / 422 / 409 otherwise —
 *      a replayed release reads the 409, never a double release),
 *   2. the collab agreement of record must exist for the sku (422 —
 *      the money terms come from the registry, never the caller),
 *   3. the FIFO amortization must plan over the sku's production lots
 *      (422 when the registered production cannot cover the settled
 *      units — the raw production debt cannot amortize out of thin air),
 *   4. the waterfall must plan over the held amount (the pure ordered
 *      allocator: FIFO COGS first, 100% overhead recoupment second, the
 *      contracted split of what survives last),
 *   5. EVERY credited payee must pass the SAME fail-closed payout
 *      compliance gate as a Lithic dispatch — operator settlement
 *      approval, Plaid-backed KYC, and the merch vertical's state
 *      (physical_fulfillment_confirmed, caller-stated),
 *   6. the settlement CAS must win BEFORE any money moves,
 *   7. then the exact-amount routing in the founder's mandated order —
 *      the FIFO consumption rows COMMIT before any split money moves
 *      (the ordering proof, write-time), the overhead recoupment
 *      applications commit per pool with their position locks, the
 *      artist split and brand residual ride the withholding escrow and
 *      recoupment-sweep discipline, dust swept to the platform, and the
 *      balanced merch_collab_release journal.
 */
export async function releaseMerchCollabSettlement(
  store: Store,
  input: MerchCollabReleaseInput,
  now: Date = new Date(),
): Promise<MerchCollabReleaseSuccess | MerchCascadeFailure> {
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
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only unclaimed holding credits release here.`,
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
      message: "A merch release names the sku it releases for.",
    };
  }

  // The collab agreement of record — the money terms' ONLY source. A
  // release against a sku with no registered collab deal refuses before
  // the CAS (nothing routes, nothing locks).
  const agreement: MerchCollabAgreementRecord | undefined =
    await store.getMerchCollabAgreement(input.sku_id);
  if (agreement === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_merch_collab_agreement",
      message: `No collaboration agreement of record exists for sku "${input.sku_id}" — register the collab deal before releasing its settlement.`,
    };
  }

  // The FIFO amortization — plan over the sku's production lots BEFORE
  // anything moves. The lots arrive in FIFO order (created_at, lot_ref);
  // each lot's consumed units derive from its append-only consumption
  // lines. A settlement the registered production cannot cover refuses
  // here, fail-closed: no split releases over unamortized production debt.
  const lots: MerchCogsLotRecord[] = await store.listMerchCogsLots(input.sku_id);
  const lotStates: MerchFifoLotState[] = [];
  for (const lot of lots) {
    const consumptions: MerchCogsConsumptionRecord[] =
      await store.listMerchCogsConsumptions(lot.id);
    lotStates.push({
      id: lot.id,
      lot_ref: lot.lot_ref,
      units_produced: lot.units_produced,
      cogs_per_unit_cents: lot.cogs_per_unit_cents,
      consumed_units: consumptions.reduce((total, line) => total + line.units_consumed, 0),
    });
  }
  const fifoPlanned = buildMerchFifoConsumptionPlan(lotStates, input.units_shipped);
  if (!fifoPlanned.ok) return fifoPlanned;
  const fifo = fifoPlanned.value;

  // The overhead pools' open amounts derive from the append-only
  // applications — never a second mutable counter.
  const poolOpen = async (poolClass: MerchCollabPoolClass, frontedCents: number) => {
    const applications: MerchCollabRecoupmentApplicationRecord[] =
      await store.listMerchCollabRecoupmentApplications(agreement.id, poolClass);
    const recouped = applications.reduce((total, line) => total + line.applied_cents, 0);
    return Math.max(0, frontedCents - recouped);
  };
  const blankOpen = await poolOpen("blank_sourcing", agreement.blank_sourcing_cents);
  const screenOpen = await poolOpen("screen_printing", agreement.screen_printing_cents);

  const planned = buildMerchCollabWaterfallPlan({
    settlement_cents: row.amount_cents,
    cogs_amortized_cents: fifo.amortized_total_cents,
    blank_sourcing_open_cents: blankOpen,
    screen_printing_open_cents: screenOpen,
    artist_split_bps: agreement.artist_split_bps,
    manufacturer: {
      payee_id: agreement.manufacturer_payee_id,
      payee_name: agreement.manufacturer_payee_name,
    },
    brand: {
      payee_id: agreement.brand_payee_id,
      payee_name: agreement.brand_payee_name,
    },
    artist: {
      payee_id: agreement.artist_payee_id,
      payee_name: agreement.artist_payee_name,
    },
  });
  if (!planned.ok) return planned;
  const waterfall = planned.value;

  // The clearance gate — every credited payee rides the SAME fail-closed
  // payout compliance gate as a Lithic dispatch, on the MERCH vertical:
  // operator settlement approval, verified KYC, and the vertical state
  // (physical_fulfillment_confirmed, caller-stated — nothing defaults
  // it). The platform house payee holds no KYC record by design and is
  // skipped. Runs before the CAS.
  const verticalStateSource = getVerticalComplianceStateSource();
  const gatedParties: Array<{ payee_id: string; payee_name: string }> = [];
  for (const leg of waterfall.legs) {
    if (leg.amount_cents > 0 && !gatedParties.some((p) => p.payee_id === leg.payee_id)) {
      gatedParties.push({ payee_id: leg.payee_id, payee_name: leg.payee_name });
    }
  }
  const gatedPayees = new Set(gatedParties.map((party) => party.payee_id));
  for (const payeeId of gatedPayees) {
    if (payeeId === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, payeeId);
    const verticalState = await verticalStateSource({
      payeeId,
      vertical: "merch",
    });
    const compliance = evaluatePayoutCompliance({
      operatorSettlementApproved: input.operator_settlement_approved,
      kycStatus,
      verticalState:
        verticalState === null
          ? null
          : {
              vertical: "merch",
              physical_fulfillment_confirmed: input.physical_fulfillment_confirmed,
            },
    });
    if (!compliance.ok) {
      return {
        ok: false,
        status: 403,
        code: compliance.code,
        message: `Merch release refused for payee "${payeeId}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets.
  const settled = await store.settleUnclaimedHolding(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent release won.`,
    };
  }

  // The exact-amount routing, in the founder's mandated order. Every
  // branch conserves its cents; every talent credit rides the esports
  // waterfall's discipline: the catalog-dispute freeze check, withholding
  // off the top, then the recoupment sweep — never a bare vault credit.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const credits: MerchCollabReleaseCredit[] = [];

  /**
   * Credits one payee exactly the way the ipOption cascade credits a
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

  // Step 0 — the FIFO consumption rows COMMIT before any split money
  // moves: the raw production debt pays off in write-order first, each
  // line position-locked (the insert-as-lock arbiter) and replay-guarded
  // per (lot, source event). The manufacturer's recovery credit rides
  // immediately after each lot's consumption line commits.
  const releaseEventId = `merch_release_${row.id}`;
  for (const leg of fifo.legs) {
    await store.insertMerchCogsConsumption({
      lot_id: leg.lot_id,
      source_event_id: releaseEventId,
      units_consumed_before: leg.units_consumed_before,
      units_consumed: leg.units_consumed,
      cogs_per_unit_cents: leg.cogs_per_unit_cents,
      amortized_cents: leg.amortized_cents,
      created_at: now.toISOString(),
    });
  }
  if (waterfall.cogs_recovery_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      agreement.manufacturer_payee_id,
      agreement.manufacturer_payee_name,
      waterfall.cogs_recovery_cents,
    );
    credits.push({
      payee_id: agreement.manufacturer_payee_id,
      payee_name: agreement.manufacturer_payee_name,
      gross_cents: waterfall.cogs_recovery_cents,
      net_cents: credited,
      step: "cogs_recovery",
    });
  }

  // Step 1 — 100% recoupment of the fronted overhead: the append-only
  // application ledger with its position locks (the 0024 pool discipline
  // at agreement scope). Blank sourcing first, screen printing second —
  // each application commits before the next leg routes.
  const applyRecoupment = async (
    poolClass: MerchCollabPoolClass,
    appliedCents: number,
    step: MerchWaterfallLeg["step"],
  ) => {
    if (appliedCents <= 0) return;
    const applications = await store.listMerchCollabRecoupmentApplications(
      agreement.id,
      poolClass,
    );
    const recoupedBefore = applications.reduce((total, line) => total + line.applied_cents, 0);
    await store.insertMerchCollabRecoupmentApplication({
      agreement_id: agreement.id,
      pool_class: poolClass,
      source_event_id: releaseEventId,
      recouped_before_cents: recoupedBefore,
      applied_cents: appliedCents,
      remaining_cents: recoupedBefore + appliedCents <= (poolClass === "blank_sourcing"
        ? agreement.blank_sourcing_cents
        : agreement.screen_printing_cents)
        ? (poolClass === "blank_sourcing"
          ? agreement.blank_sourcing_cents
          : agreement.screen_printing_cents) -
          recoupedBefore -
          appliedCents
        : 0,
      created_at: now.toISOString(),
    });
    const credited = await creditTaxedCascadePayee(
      agreement.manufacturer_payee_id,
      agreement.manufacturer_payee_name,
      appliedCents,
    );
    credits.push({
      payee_id: agreement.manufacturer_payee_id,
      payee_name: agreement.manufacturer_payee_name,
      gross_cents: appliedCents,
      net_cents: credited,
      step,
    });
  };
  await applyRecoupment("blank_sourcing", waterfall.blank_sourcing_applied_cents, "blank_sourcing_recoupment");
  await applyRecoupment("screen_printing", waterfall.screen_printing_applied_cents, "screen_printing_recoupment");

  // Step 2 — the contracted split of the post-recoupment remainder: the
  // artist's basis points, the brand's complement LAST. Only possible
  // because steps 0 and 1 committed first — the ordering is the point.
  if (waterfall.artist_split_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      agreement.artist_payee_id,
      agreement.artist_payee_name,
      waterfall.artist_split_cents,
    );
    credits.push({
      payee_id: agreement.artist_payee_id,
      payee_name: agreement.artist_payee_name,
      gross_cents: waterfall.artist_split_cents,
      net_cents: credited,
      step: "artist_split",
    });
  }
  if (waterfall.brand_residual_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      agreement.brand_payee_id,
      agreement.brand_payee_name,
      waterfall.brand_residual_cents,
    );
    credits.push({
      payee_id: agreement.brand_payee_id,
      payee_name: agreement.brand_payee_name,
      gross_cents: waterfall.brand_residual_cents,
      net_cents: credited,
      step: "brand_residual",
    });
  }

  // The integer-cent dust — structurally zero under the subtraction model;
  // swept to the platform variance account with its own ledger rows if it
  // ever differs (the house dust discipline, retained defensively).
  if (waterfall.company_dust_cents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: waterfall.company_dust_cents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      waterfall.company_dust_cents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", waterfall.company_dust_cents));
  }

  // The zero-balance tripwire: every waterfall leg + dust === the held
  // settlement, ALWAYS.
  const routedTotal = credits.reduce((total, credit) => total + credit.gross_cents, 0);
  if (
    !zeroBalanceHolds(
      row.amount_cents,
      credits.map((credit) => ({ amount_cents: credit.gross_cents })),
      waterfall.company_dust_cents,
    ) ||
    routedTotal + waterfall.company_dust_cents !== row.amount_cents
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "COGS recovery + overhead recoupment + artist split + brand residual + dust !== held settlement — release refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "merch_collab_release",
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
      fifo,
      waterfall,
      credits,
      company_dust_cents: waterfall.company_dust_cents,
      dust_ledger: dustLedger,
      withholding,
      journal_id: posted.journal.id,
    },
  };
}
