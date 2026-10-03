/**
 * CVT recon worker — the AGBOR box office lane's pure money engine (PR 30,
 * the founder live-theater/touring/comedy directive). The store-touching
 * passes live in theatricalQueue.ts / theatricalPosting.ts and the cascade
 * module (src/lib/server/theatricalBoxOfficeCascade.ts); this module is the
 * math and the identity spaces — no store, no clock, no IO — the same
 * discipline as the film, books, merch, webtoon, gaming, and art engines.
 *
 * House rules, restated as the module's contract:
 * - DETERMINISTIC BIGINT INTEGER MATH ONLY — the 1e-8 micros fixed-point
 *   discipline; a float anywhere in this file is a bug.
 * - SUB-CENT RESIDUE NEVER ROUNDS UP — every division floors; the ledger
 *   never invents money.
 * - FAIL-CLOSED — any row the lane cannot fully verify is a typed rejection
 *   at parse time (the profiles) or a refused post (the posting pass);
 *   nothing defaults to allowing.
 *
 * The money models the directive pins:
 *
 *   1. THE AGBOR CALCULATOR — a stop's Adjusted Gross Box Office Receipts is
 *      GBOR (gross box office receipts) minus four deduction legs: local
 *      sales taxes, credit card processing fees, facility maintenance and
 *      FF&E (furniture, fixtures & equipment) fees, and group sales
 *      discounts. AGBOR = GBOR − (taxes + card fees + facility/FF&E fees +
 *      group discounts), exact to the cent. The ledger math is whole cents
 *      (the Don ledger's contract); the statement legs ride the queue row in
 *      exact micros as provenance, and each leg floors into cents — a
 *      deduction never rounds up, so AGBOR never understates what the
 *      promoter keeps.
 *
 *   2. THE COMEDY TOUR GUARANTEE — the artist's payout for a stop is the
 *      GREATER OF the flat guarantee or the registered percentage of the net
 *      box office after venue expense recoupment (e.g. $10,000 flat vs 85%).
 *      Both legs compute exactly; the greater wins; ties prefer the
 *      percentage leg (the earned money) — a deterministic tiebreak, never a
 *      coin flip.
 *
 *   3. GRAND RIGHTS LICENSING DEDUCTIONS — the top-line deduction of 6–10%
 *      of AGBOR to the authors and composers of the underlying
 *      play/musical, paid via the theatrical publisher of record (Concord,
 *      MTI, Rodgers & Hammerstein). The rate validates inside the founder
 *      band at registration and again here. The deduction is taken BEFORE
 *      the production profit splits — the profit pool the investors and
 *      producers walk is AGBOR minus Grand Rights minus the recouped venue
 *      expenses.
 *
 *   4. THEATRICAL INVESTOR RECOUPMENT TIERS — investors receive 100% of net
 *      profits until the capitalization budget fully recoups; the split then
 *      shifts automatically to 50% producer / 50% investor. The switchover
 *      is exact: the clearing event's net splits at the recoupment boundary
 *      (the applied portion goes 100% to investors, the excess halves 50/50
 *      with the sub-cent dust swept to the accrual's dust_cents — nothing
 *      rounds up into a payee's credit).
 *
 *   5. MULTI-CITY VENUE RECONCILIATION — every settlement row is one stop's
 *      sheet keyed on (production_id, venue_id, show_date). City-specific
 *      facility fees ride the row as the facility leg; the stop's venue
 *      expenses recoup against the local promoter expense CAP — min(expense,
 *      cap) recoups before the net tour splits and the capped overage stays
 *      visible on the sheet as the promoter's own money.
 *
 * Event-id spaces, content-derived per row identity (the books/art
 * fingerprint discipline — identity, never money): `theatrical:axs:` per
 * (production, venue, show date, settlement id), and the same triple per
 * sender for ticketmaster, eventbrite, and venuepos. A re-shipped report
 * replays as counted no-ops through the queue's UNIQUE event_id.
 */

import { createHash } from "node:crypto";

import type { TheatricalLineDetail } from "./records";

/** House micro-dollar scale: 1 unit = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** Statement micros per whole ledger cent — the Don ledger's 1e6 sub-unit. */
export const MICROS_PER_CENT = 1_000_000n;

/** The Grand Rights founder band — top-line 6% to 10% of AGBOR (migration 0034). */
export const GRAND_RIGHTS_MIN_BPS = 600;
export const GRAND_RIGHTS_MAX_BPS = 1000;

/** The four venue settlement senders the directive names. */
export const THEATRICAL_SENDERS = ["axs", "ticketmaster", "eventbrite", "venuepos"] as const;
export type TheatricalSenderCode = (typeof THEATRICAL_SENDERS)[number];

export function isTheatricalSenderCode(value: string): value is TheatricalSenderCode {
  return (THEATRICAL_SENDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parse-time validators — every rejection is typed and row-scoped, the
// fail-closed posture (the art lane's validator block).
// ---------------------------------------------------------------------------

export function validateTheatricalGborMicros(
  micros: bigint,
  rowNumber: number,
): bigint {
  if (micros <= 0n) {
    throw new Error(
      `theatrical_row_${rowNumber}: gbor must be positive (got ${micros} micros)`,
    );
  }
  return micros;
}

export function validateTheatricalNonNegativeMicros(
  micros: bigint,
  what: string,
  rowNumber: number,
): bigint {
  if (micros < 0n) {
    throw new Error(
      `theatrical_row_${rowNumber}: ${what} must be non-negative (got ${micros} micros)`,
    );
  }
  return micros;
}

export function validateTheatricalShowDate(date: string, rowNumber: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `theatrical_row_${rowNumber}: show_date must be an ISO YYYY-MM-DD date (got "${date}")`,
    );
  }
  return date;
}

export function validateTheatricalCurrency(currency: string, rowNumber: number): string {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(
      `theatrical_row_${rowNumber}: currency must be an ISO alpha-3 code (got "${currency}")`,
    );
  }
  return currency;
}

/** The Grand Rights founder band — 6% (600 bps) to 10% (1000 bps) of AGBOR. */
export function validateGrandRightsBps(bps: number, rowNumber: number): number {
  if (!Number.isInteger(bps) || bps < GRAND_RIGHTS_MIN_BPS || bps > GRAND_RIGHTS_MAX_BPS) {
    throw new Error(
      `theatrical_row_${rowNumber}: grand rights rate must be inside the founder band ` +
        `${GRAND_RIGHTS_MIN_BPS}–${GRAND_RIGHTS_MAX_BPS} bps (got ${bps})`,
    );
  }
  return bps;
}

/** The comedy guarantee's percentage leg — bps of the post-recoupment net. */
export function validateGuaranteePercentageBps(bps: number, rowNumber: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(
      `theatrical_row_${rowNumber}: guarantee percentage must be 0–10000 bps (got ${bps})`,
    );
  }
  return bps;
}

// ---------------------------------------------------------------------------
// The AGBOR calculator — exact to the cent.
// ---------------------------------------------------------------------------

/** One stop's settlement legs in exact statement micros (queue-row provenance). */
export interface TheatricalStopLegsMicros {
  gborMicros: bigint;
  salesTaxMicros: bigint;
  cardProcessingMicros: bigint;
  facilityMaintenanceMicros: bigint;
  ffeMicros: bigint;
  groupDiscountMicros: bigint;
}

/**
 * Floors one deduction leg's micros into whole ledger cents — a deduction
 * never rounds up (the ledger never invents money for the deducting party).
 */
export function legMicrosToCents(micros: bigint): number {
  const cents = micros / MICROS_PER_CENT;
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`theatrical_leg_overflow: ${micros} micros exceeds the safe integer-cent range`);
  }
  return value;
}

/**
 * THE AGBOR CALCULATOR, exact to the cent: GBOR minus local sales taxes,
 * credit card processing fees, facility maintenance and FF&E fees, and group
 * sales discounts equals AGBOR. Each deduction leg floors from its exact
 * micros; the subtraction is integer cents. A negative result means the
 * deduction legs outran the gross — the caller quarantines the stop
 * (held_negative_net), never posting a negative settlement.
 */
export function agborCents(legs: TheatricalStopLegsMicros): {
  gborCents: number;
  salesTaxCents: number;
  cardFeesCents: number;
  facilityFeeCents: number;
  ffeFeeCents: number;
  groupDiscountCents: number;
  agborCents: number;
} {
  const gborCents = legMicrosToCents(legs.gborMicros);
  const salesTaxCents = legMicrosToCents(legs.salesTaxMicros);
  const cardFeesCents = legMicrosToCents(legs.cardProcessingMicros);
  const facilityFeeCents = legMicrosToCents(legs.facilityMaintenanceMicros);
  const ffeFeeCents = legMicrosToCents(legs.ffeMicros);
  const groupDiscountCents = legMicrosToCents(legs.groupDiscountMicros);
  return {
    gborCents,
    salesTaxCents,
    cardFeesCents,
    facilityFeeCents,
    ffeFeeCents,
    groupDiscountCents,
    agborCents:
      gborCents -
      salesTaxCents -
      cardFeesCents -
      facilityFeeCents -
      ffeFeeCents -
      groupDiscountCents,
  };
}

// ---------------------------------------------------------------------------
// Venue expense recoupment and the local promoter expense cap.
// ---------------------------------------------------------------------------

/**
 * THE LOCAL PROMOTER EXPENSE CAP: the stop's venue expenses recoup before
 * the net tour splits, but never beyond the registered cap — min(expense,
 * cap). The capped overage stays visible as its own leg (the promoter's own
 * money, never the tour's).
 */
export function venueExpenseRecoupment(
  venueExpenseCents: number,
  promoterExpenseCapCents: number,
): { venueExpenseRecoupedCents: number; venueExpenseCappedCents: number } {
  if (venueExpenseCents < 0 || promoterExpenseCapCents < 0) {
    throw new Error("theatrical_expense_cap: expense and cap must be non-negative");
  }
  const venueExpenseRecoupedCents = Math.min(venueExpenseCents, promoterExpenseCapCents);
  return {
    venueExpenseRecoupedCents,
    venueExpenseCappedCents: venueExpenseCents - venueExpenseRecoupedCents,
  };
}

// ---------------------------------------------------------------------------
// Grand Rights — the top-line licensing deduction before profit splits.
// ---------------------------------------------------------------------------

/**
 * THE GRAND RIGHTS DEDUCTION: floor(AGBOR × rate_bps / 10000) — the
 * top-line licensing deduction to the authors and composers via the
 * theatrical publisher, taken BEFORE the production profit splits. The rate
 * validates inside the 6–10% founder band. Floors: the publisher's take
 * never rounds up.
 */
export function grandRightsDeductionCents(agborCentsValue: number, rateBps: number): number {
  validateGrandRightsBps(rateBps, 0);
  if (agborCentsValue < 0) {
    throw new Error("theatrical_grand_rights: AGBOR must be non-negative");
  }
  return Math.floor((agborCentsValue * rateBps) / 10_000);
}

// ---------------------------------------------------------------------------
// The comedy tour guarantee — greater-of, both directions.
// ---------------------------------------------------------------------------

export interface ComedyGuaranteeOutcome {
  /** The flat guarantee leg, whole cents. */
  flatLegCents: number;
  /** The percentage leg — pct of the net box office after venue expense
   * recoupment, whole cents (floored). */
  percentageLegCents: number;
  /** The payout: whichever leg is greater (ties prefer the earned leg). */
  payoutCents: number;
  /** Which leg won — the settlement sheet's provenance. */
  winner: "flat" | "percentage";
}

/**
 * THE COMEDY TOUR GUARANTEE: the artist's stop payout is the greater of the
 * flat guarantee or the registered percentage of the net box office after
 * venue expense recoupment (e.g. $10,000 flat vs 85%). The percentage leg is
 * floor(basis × pct_bps / 10000) — sub-cent residue never rounds up.
 */
export function comedyGuaranteeSettlement(
  agborCentsValue: number,
  venueExpenseRecoupedCents: number,
  flatGuaranteeCents: number,
  guaranteePercentageBps: number,
): ComedyGuaranteeOutcome {
  validateGuaranteePercentageBps(guaranteePercentageBps, 0);
  if (flatGuaranteeCents < 0 || venueExpenseRecoupedCents < 0 || agborCentsValue < 0) {
    throw new Error("theatrical_guarantee: money legs must be non-negative");
  }
  const netAfterVenueRecoupment = agborCentsValue - venueExpenseRecoupedCents;
  const percentageLegCents = Math.floor(
    (netAfterVenueRecoupment * guaranteePercentageBps) / 10_000,
  );
  // The greater-of: ties prefer the percentage leg (the earned money).
  const winner: ComedyGuaranteeOutcome["winner"] =
    flatGuaranteeCents > percentageLegCents ? "flat" : "percentage";
  return {
    flatLegCents: flatGuaranteeCents,
    percentageLegCents,
    payoutCents: Math.max(flatGuaranteeCents, percentageLegCents),
    winner,
  };
}

// ---------------------------------------------------------------------------
// Theatrical investor recoupment tiers — 100% until recouped, then 50/50.
// ---------------------------------------------------------------------------

export interface TheatricalRecoupmentOutcome {
  /** The position this event's walk started from (the deal's running counter). */
  recoupedBeforeCents: number;
  /** The portion applied to the capitalization budget — 100% to investors. */
  appliedCents: number;
  /** The budget position after the application. */
  recoupedAfterCents: number;
  /** The budget still open after the application (0 when fully recouped). */
  remainingCents: number;
  /** True when THIS event crossed the budget — the switchover event. */
  switchover: boolean;
  /** The post-recoupment 50/50 designations (both zero before switchover). */
  producerShareCents: number;
  investorShareCents: number;
  /** The sub-cent residue of the half splits — swept to the accrual's dust. */
  dustCents: number;
}

/**
 * THE THEATRICAL INVESTOR RECOUPMENT TIERS: investors receive 100% of net
 * profits until the capitalization budget fully recoups, then the split
 * shifts automatically to 50% producer / 50% investor. The switchover is
 * exact — the clearing event's net splits at the budget boundary (the
 * applied portion recoups 100% to investors, the excess halves 50/50, the
 * sub-cent residue of the odd excess sweeps to dust). The recoupment walk is
 * the books/art advance discipline: position-derived, replay-guarded by the
 * caller's position lock, never re-cut.
 */
export function theatricalRecoupmentWalk(
  netProfitCents: number,
  capitalizationBudgetCents: number,
  recoupedToDateCents: number,
): TheatricalRecoupmentOutcome {
  if (netProfitCents < 0 || capitalizationBudgetCents <= 0 || recoupedToDateCents < 0) {
    throw new Error(
      "theatrical_recoupment: net must be non-negative, the budget positive, the position non-negative",
    );
  }
  if (recoupedToDateCents > capitalizationBudgetCents) {
    throw new Error(
      "theatrical_recoupment: the running position exceeds the budget — the deal of record is corrupt",
    );
  }
  const recoupedBeforeCents = recoupedToDateCents;
  const budgetRemaining = capitalizationBudgetCents - recoupedBeforeCents;
  if (budgetRemaining === 0) {
    // The budget is already closed — the permanent 50/50 tier.
    const producerShareCents = Math.floor(netProfitCents / 2);
    const investorShareCents = Math.floor(netProfitCents / 2);
    return {
      recoupedBeforeCents,
      appliedCents: 0,
      recoupedAfterCents: recoupedBeforeCents,
      remainingCents: 0,
      switchover: false,
      producerShareCents,
      investorShareCents,
      dustCents: netProfitCents - producerShareCents - investorShareCents,
    };
  }
  const appliedCents = Math.min(netProfitCents, budgetRemaining);
  const excessCents = netProfitCents - appliedCents;
  const producerShareCents = Math.floor(excessCents / 2);
  const investorShareCents = Math.floor(excessCents / 2);
  return {
    recoupedBeforeCents,
    appliedCents,
    recoupedAfterCents: recoupedBeforeCents + appliedCents,
    remainingCents: budgetRemaining - appliedCents,
    switchover: appliedCents === budgetRemaining && excessCents > 0,
    producerShareCents,
    investorShareCents,
    dustCents: excessCents - producerShareCents - investorShareCents,
  };
}

// ---------------------------------------------------------------------------
// Identity — the sha256 content fingerprints (identity fields only, never
// money), one event-id space per sender.
// ---------------------------------------------------------------------------

/** The sha256 identity fingerprint — identity fields only, never money. */
function theatricalFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The stop's event id — one per (sender, production, venue, show date,
 * settlement id). The reconciliation triple plus the sender's settlement id
 * of record: a re-shipped report replays as a counted no-op, and two
 * senders' sheets for the same stop stay distinct identities.
 */
export function theatricalStopEventId(detail: TheatricalLineDetail): string {
  return `theatrical:${detail.sender}:${theatricalFingerprint(
    detail.productionId,
    detail.venueId,
    detail.showDate,
    detail.settlementId,
  )}`;
}

/** The production scope key — the waterfall's deal-of-record lookup. */
export function productionScopeKey(productionId: string): string {
  return `production:${productionId}`;
}
