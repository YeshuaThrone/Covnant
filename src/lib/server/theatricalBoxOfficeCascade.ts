/**
 * CVT recon worker seam — the AGBOR box office + theatrical recoupment
 * cascade (PR 30, the founder live-theater/touring/comedy directive). The
 * store-touching waterfall behind the recon lane's queue rows — the
 * art-market cascade's sibling, walking the FILM waterfall engine's
 * versioned-tier, sequential-advance patterns against box office money.
 *
 * Two entry points:
 *
 *   registerTheatricalProductionDeal — the versioned deal of record per
 *   production scope (`production:<id>`): the comedy class pins the
 *   greater-of terms (flat guarantee vs percentage of the net box office
 *   after venue expense recoupment); the theatrical class pins the
 *   capitalization budget the investor recoupment tiers walk and the
 *   post-recoupment 50/50 pair. The Grand Rights rate is optional on both —
 *   present only when the production licenses the underlying play/musical,
 *   validated inside the 6–10% founder band and paired non-null with the
 *   publisher identity. A re-registration increments the version; accrued
 *   designations keep their version's history, never re-cut.
 *
 *   applyTheatricalStopOutcome — one stop's settlement sheet through the
 *   waterfall, in the fail-closed order:
 *
 *     1. THE DEAL GATE — the production's deal of record must exist
 *        (fail-closed absent) and the stop's currency must match it (the
 *        art cascade's currency firewall; a mismatched stop is visible,
 *        never pooled).
 *     2. THE GRAND RIGHTS DEDUCTION — top-line, BEFORE the production
 *        profit splits: floor(AGBOR × rate / 10000) to the authors' and
 *        composers' publisher of record.
 *     3. THE VENUE EXPENSE RECOUPMENT — min(expense, local promoter cap)
 *        recoups before the net tour splits; the capped overage stays
 *        visible on the sheet as the promoter's own money.
 *     4. THE CLASS WALK — comedy: the artist's payout is the greater of the
 *        flat guarantee and the registered percentage of the net after
 *        recoupment (the guarantee is a floor obligation — it can exceed
 *        the stop's own net; the sheet records the stop's money honestly
 *        and the tour's cross-stop reconciliation is the tour book's job).
 *        Theatrical: investors receive 100% of net profits until the
 *        capitalization budget fully recoups, then the split shifts
 *        automatically to 50% producer / 50% investor — the clearing
 *        event's net splits exactly at the budget boundary.
 *     5. THE MONEY WRITES — append-only, once-only per source event id:
 *        the recoupment application (position-locked, the books/art
 *        insert-as-lock arbiter), the deal's recoupment CAS advance, the
 *        split accrual (the once-only designation). A replay is a counted
 *        no-op, never a double designation.
 *     6. THE SETTLEMENT SHEET — the stop's fact row, written last (a torn
 *        earlier write heals on retry; the sheet replays as a no-op).
 *
 * Every disposition is visible: nothing silently drops, nothing rounds up
 * into a payee's credit, nothing double-designates.
 */

import { randomUUID } from "node:crypto";

import type { Store } from "@/lib/server/store";
import {
  THEATRICAL_PUBLISHERS,
  THEATRICAL_DEAL_CLASSES,
  type TheatricalAllocationRole,
  type TheatricalDealClass,
  type TheatricalProductionDealRecord,
  type TheatricalPublisherCode,
  type TheatricalSplitAccrualRecord,
} from "@/modules/don/records";
import { isUniqueViolation } from "@/workers/recon/matchQueue";
import type { TheatricalLineOutcome } from "@/workers/recon/theatricalQueue";
import {
  agborCents,
  comedyGuaranteeSettlement,
  grandRightsDeductionCents,
  legMicrosToCents,
  productionScopeKey,
  theatricalRecoupmentWalk,
  venueExpenseRecoupment,
  validateGrandRightsBps,
  validateGuaranteePercentageBps,
  type TheatricalStopLegsMicros,
} from "@/workers/recon/theatrical";

/** The cascade's typed refusal — the art cascade's failure shape. */
export type TheatricalCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/** The cascade's typed success payload — the sheet plus the walk's proof. */
export type TheatricalStopApplySuccess = {
  ok: true;
  /** The stop's AGBOR and its legs, whole cents (the sheet's math). */
  sheet: {
    gborCents: number;
    salesTaxCents: number;
    cardFeesCents: number;
    facilityFeeCents: number;
    ffeFeeCents: number;
    groupDiscountCents: number;
    agborCents: number;
    grandRightsCents: number;
    venueExpenseCents: number;
    promoterExpenseCapCents: number;
    venueExpenseRecoupedCents: number;
    venueExpenseCappedCents: number;
    dealPayoutCents: number;
  };
  /** The comedy walk's proof (null on theatrical deals). */
  guarantee: {
    flatLegCents: number;
    percentageLegCents: number;
    winner: "flat" | "percentage";
  } | null;
  /** The recoupment walk's proof (null on comedy deals). */
  recoupment: {
    recoupedBeforeCents: number;
    appliedCents: number;
    recoupedAfterCents: number;
    remainingCents: number;
    switchover: boolean;
  } | null;
  /** The designated payouts — allocations + dust = basis, exact. */
  accrual: TheatricalSplitAccrualRecord | null;
  /** True when this event had already been applied (the replay no-op). */
  alreadyRecorded: boolean;
};

// ---------------------------------------------------------------------------
// Deal registration — the versioned tier table of record.
// ---------------------------------------------------------------------------

/** A deal registration's input — the founder-facing terms. */
export interface TheatricalDealRegistration {
  productionId: string;
  dealClass: TheatricalDealClass;
  currency: string;
  /** Grand Rights licensing — the (rate, publisher) pair or neither. */
  grandRightsRateBps?: number;
  publisherCode?: TheatricalPublisherCode;
  publisherPayeeId?: string;
  publisherPayeeName?: string;
  /** Comedy: the guarantee's recipient. */
  artistPayeeId?: string;
  artistPayeeName?: string;
  /** Theatrical: the post-recoupment 50/50 pair. */
  producerPayeeId?: string;
  producerPayeeName?: string;
  investorPayeeId?: string;
  investorPayeeName?: string;
  /** Comedy: the flat guarantee floor, whole cents. */
  flatGuaranteeCents?: number;
  /** Comedy: the percentage leg, bps of the post-recoupment net. */
  guaranteePercentageBps?: number;
  /** Theatrical: the capitalization budget, whole cents. */
  capitalizationBudgetCents?: number;
}

function failure(
  status: number,
  code: string,
  message: string,
): TheatricalCascadeFailure {
  return { ok: false, status, code, message };
}

/** Validates one deal registration's terms — null when coherent, the reason otherwise. */
function validateDealTerms(input: TheatricalDealRegistration): string | null {
  if (input.productionId.trim() === "") {
    return "A deal names its production of record.";
  }
  if (!/^[A-Za-z]{3}$/.test(input.currency)) {
    return "A deal's currency is its three-letter alpha code.";
  }
  if (!(THEATRICAL_DEAL_CLASSES as readonly string[]).includes(input.dealClass)) {
    return `Unknown deal class "${input.dealClass}".`;
  }
  // Grand Rights: either the full (rate, publisher, payee) triple or none
  // of it — a half-registered license refuses.
  const hasRate = input.grandRightsRateBps !== undefined;
  const hasPublisher =
    input.publisherCode !== undefined ||
    input.publisherPayeeId !== undefined ||
    input.publisherPayeeName !== undefined;
  if (hasRate !== hasPublisher) {
    return "A Grand Rights license registers its rate AND its publisher of record together.";
  }
  if (hasRate) {
    try {
      validateGrandRightsBps(input.grandRightsRateBps ?? 0, 0);
    } catch {
      return "The Grand Rights rate must sit inside the founder band (600–1000 bps of AGBOR).";
    }
    if (!(THEATRICAL_PUBLISHERS as readonly string[]).includes(input.publisherCode ?? "")) {
      return "A Grand Rights license names the theatrical publisher of record.";
    }
    if (input.publisherPayeeId?.trim() === "" || input.publisherPayeeName?.trim() === "") {
      return "A Grand Rights license names its publisher payee of record.";
    }
  }
  if (input.dealClass === "comedy_guarantee") {
    if (input.artistPayeeId?.trim() === "" || input.artistPayeeName?.trim() === "") {
      return "A comedy guarantee names the artist payee of record.";
    }
    if (
      !Number.isSafeInteger(input.flatGuaranteeCents ?? 0) ||
      (input.flatGuaranteeCents ?? 0) <= 0
    ) {
      return "A comedy guarantee's flat leg is integer cents greater than zero.";
    }
    try {
      validateGuaranteePercentageBps(input.guaranteePercentageBps ?? -1, 0);
    } catch {
      return "A comedy guarantee's percentage leg is 0–10000 whole basis points.";
    }
    if (input.capitalizationBudgetCents !== undefined) {
      return "A comedy guarantee carries no capitalization budget — that is the theatrical class's term.";
    }
    if (input.producerPayeeId !== undefined || input.investorPayeeId !== undefined) {
      return "A comedy guarantee pays the artist — the producer/investor pair is the theatrical class's.";
    }
  } else {
    if (input.producerPayeeId?.trim() === "" || input.producerPayeeName?.trim() === "") {
      return "A theatrical recoupment deal names the producer payee of record.";
    }
    if (input.investorPayeeId?.trim() === "" || input.investorPayeeName?.trim() === "") {
      return "A theatrical recoupment deal names the investor payee of record.";
    }
    if (
      !Number.isSafeInteger(input.capitalizationBudgetCents ?? 0) ||
      (input.capitalizationBudgetCents ?? 0) <= 0
    ) {
      return "A theatrical recoupment deal's capitalization budget is integer cents greater than zero.";
    }
    if (
      input.flatGuaranteeCents !== undefined ||
      input.guaranteePercentageBps !== undefined
    ) {
      return "A theatrical recoupment deal carries no guarantee terms — that is the comedy class's.";
    }
  }
  return null;
}

/**
 * Registers (or re-registers) the production's versioned box office deal of
 * record. A re-registration preserves the row's identity and increments its
 * version (the art schedule upsert discipline); accrued designations keep
 * their version's history.
 */
export async function registerTheatricalProductionDeal(
  store: Store,
  input: TheatricalDealRegistration,
  now: Date = new Date(),
): Promise<TheatricalProductionDealRecord | TheatricalCascadeFailure> {
  const termsError = validateDealTerms(input);
  if (termsError !== null) {
    return failure(422, "invalid_deal_input", termsError);
  }
  const scopeKey = productionScopeKey(input.productionId.trim());
  const existing = await store.getTheatricalProductionDeal(input.productionId.trim());
  if (existing !== undefined && existing.deal_class !== input.dealClass) {
    return failure(
      409,
      "deal_class_conflict",
      `Production "${input.productionId.trim()}" already carries a ${existing.deal_class} deal of record — a re-registration cannot change the class.`,
    );
  }
  if (existing !== undefined && existing.currency !== input.currency.toUpperCase()) {
    return failure(
      409,
      "deal_currency_conflict",
      `Production "${input.productionId.trim()}" deal of record settles in ${existing.currency}; the re-registration names ${input.currency.toUpperCase()}.`,
    );
  }
  const record: TheatricalProductionDealRecord = {
    id: existing?.id ?? randomUUID(),
    scope_key: scopeKey,
    deal_class: input.dealClass,
    grand_rights_rate_bps: input.grandRightsRateBps ?? null,
    publisher_code: input.publisherCode ?? null,
    publisher_payee_id: input.publisherPayeeId?.trim() || null,
    publisher_payee_name: input.publisherPayeeName?.trim() || null,
    artist_payee_id: input.artistPayeeId?.trim() || null,
    artist_payee_name: input.artistPayeeName?.trim() || null,
    producer_payee_id: input.producerPayeeId?.trim() || null,
    producer_payee_name: input.producerPayeeName?.trim() || null,
    investor_payee_id: input.investorPayeeId?.trim() || null,
    investor_payee_name: input.investorPayeeName?.trim() || null,
    flat_guarantee_cents: input.flatGuaranteeCents ?? null,
    guarantee_percentage_bps: input.guaranteePercentageBps ?? null,
    capitalization_budget_cents: input.capitalizationBudgetCents ?? null,
    // The running recoupment counter NEVER resets on re-registration —
    // the investors' position is capital of record.
    recouped_cents: existing?.recouped_cents ?? 0,
    currency: input.currency.toUpperCase(),
    version: (existing?.version ?? 0) + 1,
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  return store.upsertTheatricalProductionDeal(record);
}

// ---------------------------------------------------------------------------
// The per-stop waterfall — one settlement sheet through the deal.
// ---------------------------------------------------------------------------

/** One stop's apply input — the legs in exact statement micros. */
export interface TheatricalStopApplyInput {
  productionId: string;
  venueId: string;
  showDate: string;
  /** The funding queue row's event id — the once-only key. */
  sourceEventId: string;
  /** The sender's settlement id of record (provenance). */
  settlementId: string;
  senderCode: "axs" | "ticketmaster" | "eventbrite" | "venuepos";
  city: string;
  currency: string;
  /** The stop's legs in exact statement micros (the queue row's provenance). */
  legs: TheatricalStopLegsMicros;
  venueExpenseMicros: bigint;
  promoterExpenseCapMicros: bigint;
}

/** The per-stop walk's intermediate — the sheet's exact-cent legs. */
interface StopSheetLegs {
  gborCents: number;
  salesTaxCents: number;
  cardFeesCents: number;
  facilityFeeCents: number;
  ffeFeeCents: number;
  groupDiscountCents: number;
  agborCents: number;
  venueExpenseCents: number;
  promoterExpenseCapCents: number;
}

/** Floors the stop's micros legs into the sheet's exact-cent legs. */
function sheetLegs(input: TheatricalStopApplyInput): StopSheetLegs {
  const legs = agborCents(input.legs);
  return {
    ...legs,
    venueExpenseCents: legMicrosToCents(input.venueExpenseMicros),
    promoterExpenseCapCents: legMicrosToCents(input.promoterExpenseCapMicros),
  };
}

/** The deal's payee for a role — the allocation builder's identity source. */
function dealPayee(
  deal: TheatricalProductionDealRecord,
  role: TheatricalAllocationRole,
): { payee_id: string; payee_name: string } | null {
  switch (role) {
    case "theatrical_publisher":
      return deal.publisher_payee_id !== null && deal.publisher_payee_name !== null
        ? { payee_id: deal.publisher_payee_id, payee_name: deal.publisher_payee_name }
        : null;
    case "artist":
      return deal.artist_payee_id !== null && deal.artist_payee_name !== null
        ? { payee_id: deal.artist_payee_id, payee_name: deal.artist_payee_name }
        : null;
    case "producer":
      return deal.producer_payee_id !== null && deal.producer_payee_name !== null
        ? { payee_id: deal.producer_payee_id, payee_name: deal.producer_payee_name }
        : null;
    case "investor":
      return deal.investor_payee_id !== null && deal.investor_payee_name !== null
        ? { payee_id: deal.investor_payee_id, payee_name: deal.investor_payee_name }
        : null;
  }
}

/**
 * Applies one stop's settlement through the production's deal of record.
 * The position-locked recoupment walk re-derives from the deal of record on
 * a lost race (the art cascade's bounded spin — the budget is finite, so
 * the loop terminates); every money write is once-only per source event id.
 */
export async function applyTheatricalStopOutcome(
  store: Store,
  input: TheatricalStopApplyInput,
  now: Date = new Date(),
): Promise<TheatricalStopApplySuccess | TheatricalCascadeFailure> {
  if (input.productionId.trim() === "" || input.sourceEventId.trim() === "") {
    return failure(
      422,
      "invalid_stop_input",
      "A stop settlement names its production of record and its source event.",
    );
  }
  if (!/^[A-Za-z]{3}$/.test(input.currency)) {
    return failure(422, "invalid_stop_input", "A stop's currency is its three-letter alpha code.");
  }

  for (;;) {
    const deal = await store.getTheatricalProductionDeal(input.productionId.trim());
    if (deal === undefined) {
      return failure(
        404,
        "theatrical_deal_not_registered",
        `No box office deal of record is registered for production "${input.productionId.trim()}" — register the deal before applying stops.`,
      );
    }
    // The currency firewall — the art cascade's discipline: a stop settles
    // in its deal's currency only; a mismatched stop is visible, never pooled.
    if (deal.currency !== input.currency.toUpperCase()) {
      return failure(
        409,
        "stop_currency_mismatch",
        `Stop "${input.settlementId}" settles in ${input.currency.toUpperCase()}; the production's deal of record settles in ${deal.currency}.`,
      );
    }

    // Replay guard FIRST (cheap, before any position math) — the art
    // cascade's discipline: the same event already applied is the counted
    // no-op. Without it a replayed event spins forever — the once-only
    // insert guard fires, the counter never re-advances, and the walk
    // re-derives the same recouped_before slot on every pass.
    const eventAlreadyApplied = (
      await store.listTheatricalRecoupmentApplications(deal.id)
    ).some((application) => application.source_event_id === input.sourceEventId);

    const legs = sheetLegs(input);

    // THE GRAND RIGHTS DEDUCTION — top-line, before the production profit
    // splits. Floors: the publisher's take never rounds up.
    const grandRightsCents =
      deal.grand_rights_rate_bps !== null
        ? grandRightsDeductionCents(legs.agborCents, deal.grand_rights_rate_bps)
        : 0;
    const afterGrandRights = legs.agborCents - grandRightsCents;

    // THE VENUE EXPENSE RECOUPMENT — min(expense, cap) before the net tour
    // splits; the overage stays visible as the promoter's own money.
    const expense = venueExpenseRecoupment(legs.venueExpenseCents, legs.promoterExpenseCapCents);
    const netProfitCents = afterGrandRights - expense.venueExpenseRecoupedCents;

    let accrual: TheatricalSplitAccrualRecord | null = null;
    let recoupmentProof: TheatricalStopApplySuccess["recoupment"] = null;
    let guaranteeProof: TheatricalStopApplySuccess["guarantee"] = null;
    let lostPosition = false;

    if (deal.deal_class === "comedy_guarantee") {
      // THE COMEDY TOUR GUARANTEE — greater-of. The percentage's basis is
      // the net box office after the Grand Rights deduction and the venue
      // expense recoupment; the flat leg is the floor obligation (it can
      // exceed the stop's own net — the tour book reconciles cross-stop).
      const guarantee = comedyGuaranteeSettlement(
        afterGrandRights,
        expense.venueExpenseRecoupedCents,
        deal.flat_guarantee_cents ?? 0,
        deal.guarantee_percentage_bps ?? 0,
      );
      guaranteeProof = {
        flatLegCents: guarantee.flatLegCents,
        percentageLegCents: guarantee.percentageLegCents,
        winner: guarantee.winner,
      };
      const artist = dealPayee(deal, "artist");
      if (artist === null) {
        return failure(
          500,
          "theatrical_deal_corrupt",
          `Comedy deal of record for production "${input.productionId.trim()}" names no artist payee.`,
        );
      }
      try {
        accrual = await store.insertTheatricalSplitAccrual({
          deal_id: deal.id,
          scope_key: deal.scope_key,
          deal_class: deal.deal_class,
          source_event_id: input.sourceEventId,
          basis_cents: guarantee.payoutCents,
          allocations: [
            {
              payee_id: artist.payee_id,
              payee_name: artist.payee_name,
              role: "artist",
              share_cents: guarantee.payoutCents,
            },
          ],
          dust_cents: 0,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A replayed designation — the counted no-op; the sheet write below
        // still runs (it heals a torn fact row from a partial apply).
      }
    } else {
      // THE THEATRICAL INVESTOR RECOUPMENT TIERS — 100% to investors until
      // the budget fully recoups, then the automatic 50/50 switchover.
      const walk = theatricalRecoupmentWalk(
        netProfitCents,
        deal.capitalization_budget_cents ?? 0,
        deal.recouped_cents,
      );
      recoupmentProof = eventAlreadyApplied
        ? null // the replayed event's proof landed on the first apply
        : {
            recoupedBeforeCents: walk.recoupedBeforeCents,
            appliedCents: walk.appliedCents,
            recoupedAfterCents: walk.recoupedAfterCents,
            remainingCents: walk.remainingCents,
            switchover: walk.switchover,
          };
      const investor = dealPayee(deal, "investor");
      const producer = dealPayee(deal, "producer");
      if (investor === null || producer === null) {
        return failure(
          500,
          "theatrical_deal_corrupt",
          `Theatrical deal of record for production "${input.productionId.trim()}" is missing its producer/investor payee pair.`,
        );
      }
      const allocations: TheatricalSplitAccrualRecord["allocations"] = [];
      if (walk.appliedCents > 0 && !eventAlreadyApplied) {
        allocations.push({
          payee_id: investor.payee_id,
          payee_name: investor.payee_name,
          role: "investor",
          share_cents: walk.appliedCents,
        });
        try {
          await store.insertTheatricalRecoupmentApplication({
            deal_id: deal.id,
            scope_key: deal.scope_key,
            source_event_id: input.sourceEventId,
            recouped_before_cents: walk.recoupedBeforeCents,
            applied_cents: walk.appliedCents,
            remaining_cents: walk.remainingCents,
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Either a replayed event (the once-only guard) or a lost
          // position (a concurrent application took the same
          // recouped_before slot) — re-derive from the deal of record and
          // retry; the budget is finite, so the spin terminates.
          lostPosition = true;
        }
        if (!lostPosition) {
          // Won the position — the deal's derived counter tracks it
          // (bookkeeping; the append-only row is the commit).
          const advanced = await store.updateTheatricalDealRecoupment(
            deal.id,
            walk.recoupedAfterCents,
            now.toISOString(),
          );
          if (advanced === undefined) lostPosition = true;
        }
      }
      if (lostPosition) continue;

      if (walk.producerShareCents > 0 || walk.investorShareCents > 0) {
        allocations.push(
          {
            payee_id: producer.payee_id,
            payee_name: producer.payee_name,
            role: "producer",
            share_cents: walk.producerShareCents,
          },
          {
            payee_id: investor.payee_id,
            payee_name: investor.payee_name,
            role: "investor",
            share_cents: walk.investorShareCents,
          },
        );
      }
      if (
        !eventAlreadyApplied &&
        walk.appliedCents + walk.producerShareCents + walk.investorShareCents > 0
      ) {
        try {
          accrual = await store.insertTheatricalSplitAccrual({
            deal_id: deal.id,
            scope_key: deal.scope_key,
            deal_class: deal.deal_class,
            source_event_id: input.sourceEventId,
            basis_cents: walk.appliedCents + walk.producerShareCents + walk.investorShareCents,
            allocations,
            dust_cents: walk.dustCents,
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // A replayed designation — the counted no-op.
        }
      }
    }

    // THE SETTLEMENT SHEET — the stop's fact row, written last. A torn
    // earlier write heals on retry; a replayed sheet is the counted no-op.
    const dealPayoutCents = accrual === null ? 0 : accrual.basis_cents;
    try {
      await store.insertTheatricalStopSettlement({
        production_id: input.productionId.trim(),
        venue_id: input.venueId,
        show_date: input.showDate,
        source_event_id: input.sourceEventId,
        settlement_id: input.settlementId,
        sender_code: input.senderCode,
        city: input.city,
        gbor_cents: legs.gborCents,
        sales_tax_cents: legs.salesTaxCents,
        card_fees_cents: legs.cardFeesCents,
        facility_fee_cents: legs.facilityFeeCents,
        ffe_fee_cents: legs.ffeFeeCents,
        group_discount_cents: legs.groupDiscountCents,
        agbor_cents: legs.agborCents,
        grand_rights_cents: grandRightsCents,
        venue_expense_cents: legs.venueExpenseCents,
        promoter_expense_cap_cents: legs.promoterExpenseCapCents,
        venue_expense_recouped_cents: expense.venueExpenseRecoupedCents,
        venue_expense_capped_cents: expense.venueExpenseCappedCents,
        deal_payout_cents: dealPayoutCents,
        currency: deal.currency,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return {
        ok: true,
        sheet: {
          gborCents: legs.gborCents,
          salesTaxCents: legs.salesTaxCents,
          cardFeesCents: legs.cardFeesCents,
          facilityFeeCents: legs.facilityFeeCents,
          ffeFeeCents: legs.ffeFeeCents,
          groupDiscountCents: legs.groupDiscountCents,
          agborCents: legs.agborCents,
          grandRightsCents,
          venueExpenseCents: legs.venueExpenseCents,
          promoterExpenseCapCents: legs.promoterExpenseCapCents,
          venueExpenseRecoupedCents: expense.venueExpenseRecoupedCents,
          venueExpenseCappedCents: expense.venueExpenseCappedCents,
          dealPayoutCents,
        },
        guarantee: guaranteeProof,
        recoupment: recoupmentProof,
        accrual: null,
        alreadyRecorded: true,
      };
    }

    return {
      ok: true,
      sheet: {
        gborCents: legs.gborCents,
        salesTaxCents: legs.salesTaxCents,
        cardFeesCents: legs.cardFeesCents,
        facilityFeeCents: legs.facilityFeeCents,
        ffeFeeCents: legs.ffeFeeCents,
        groupDiscountCents: legs.groupDiscountCents,
        agborCents: legs.agborCents,
        grandRightsCents,
        venueExpenseCents: legs.venueExpenseCents,
        promoterExpenseCapCents: legs.promoterExpenseCapCents,
        venueExpenseRecoupedCents: expense.venueExpenseRecoupedCents,
        venueExpenseCappedCents: expense.venueExpenseCappedCents,
        dealPayoutCents,
      },
      guarantee: guaranteeProof,
      recoupment: recoupmentProof,
      accrual,
      alreadyRecorded: false,
    };
  }
}

// ---------------------------------------------------------------------------
// The worker pass — the write outcomes through the cascade, counted.
// ---------------------------------------------------------------------------

/** Waterfall pass counts — the honest completion report's inputs. */
export interface TheatricalWaterfallPassCounts {
  /** Stops applied through their deal of record. */
  applied: number;
  /** Stops already recorded (the replay no-ops). */
  alreadyRecorded: number;
  /** The Grand Rights deductions recorded across stops, whole cents. */
  grandRightsCents: number;
  /** The venue expenses recouped across stops, whole cents. */
  venueExpenseRecoupedCents: number;
  /** The capped overage across stops — the promoter's own money. */
  venueExpenseCappedCents: number;
  /** The designated payouts across stops, whole cents. */
  dealPayoutCents: number;
  /** The switchover events — stops that crossed the budget. */
  switchovers: number;
}

/** Applies one ingest's money-disposition stop outcomes through the cascade. */
export async function runTheatricalWaterfallPass(
  store: Store,
  lineOutcomes: readonly TheatricalLineOutcome[],
  now: Date = new Date(),
): Promise<TheatricalWaterfallPassCounts> {
  const counts: TheatricalWaterfallPassCounts = {
    applied: 0,
    alreadyRecorded: 0,
    grandRightsCents: 0,
    venueExpenseRecoupedCents: 0,
    venueExpenseCappedCents: 0,
    dealPayoutCents: 0,
    switchovers: 0,
  };
  for (const outcome of lineOutcomes) {
    // The write pass's quarantined dispositions never reach the waterfall —
    // held negative nets and sub-cent zeros are recorded, never designated.
    if (outcome.disposition !== "money") continue;
    const detail = outcome.detail;
    const applied = await applyTheatricalStopOutcome(
      store,
      {
        productionId: detail.productionId,
        venueId: detail.venueId,
        showDate: detail.showDate,
        sourceEventId: outcome.eventId,
        settlementId: detail.settlementId,
        senderCode: detail.sender,
        city: detail.city,
        currency: outcome.line.currency,
        legs: {
          gborMicros: BigInt(detail.gborMicros),
          salesTaxMicros: BigInt(detail.salesTaxMicros),
          cardProcessingMicros: BigInt(detail.cardProcessingMicros),
          facilityMaintenanceMicros: BigInt(detail.facilityMaintenanceMicros),
          ffeMicros: BigInt(detail.ffeMicros),
          groupDiscountMicros: BigInt(detail.groupDiscountMicros),
        },
        venueExpenseMicros: BigInt(detail.venueExpenseMicros),
        promoterExpenseCapMicros: BigInt(detail.promoterExpenseCapMicros),
      },
      now,
    );
    if (!applied.ok) {
      // The stop's math already passed the queue's validation — a cascade
      // refusal here is a real state change (deal unregistered, currency
      // conflict) the job must surface, never swallow.
      throw new Error(`theatrical_waterfall_refused:${applied.code}:${applied.message}`);
    }
    if (applied.alreadyRecorded) {
      counts.alreadyRecorded += 1;
      continue;
    }
    counts.applied += 1;
    counts.grandRightsCents += applied.sheet.grandRightsCents;
    counts.venueExpenseRecoupedCents += applied.sheet.venueExpenseRecoupedCents;
    counts.venueExpenseCappedCents += applied.sheet.venueExpenseCappedCents;
    counts.dealPayoutCents += applied.sheet.dealPayoutCents;
    if (applied.recoupment?.switchover === true) counts.switchovers += 1;
  }
  return counts;
}
