/**
 * CVT recon worker — the esports prize-pool waterfall's allocation math
 * (PR 14, founder esports directive).
 *
 * Pure functions only — no store, no clock. The waterfall runs as
 * SEQUENTIAL integer-cent steps against the prize pool's remaining
 * balance, in the founder's mandated order:
 *
 *   1. venue recoupment — the org's advanced venue costs, ONLY when the
 *      contract mandates recoupment;
 *   2. travel recoupment — the advanced travel costs, same mandate rule;
 *   3. the org cut — 15–30% operational fee of what remains after
 *      recoupment (whole basis points, inside the band, floored);
 *   4. the roster split — the remaining 70–85% across starters, the
 *      substitute bench, and coaching/analytic staff at the contract's
 *      percentages (whole basis points summing to EXACTLY 10000 —
 *      100.0000% of the roster pool), floor shares, dust swept to the
 *      company variance account.
 *
 * Shortfall handling: a pool smaller than the mandated expenses recoups
 * what exists and reports the shortfall honestly (`unrecoupedCents`) —
 * the later steps receive zero, no step ever goes negative, and no cent
 * is invented. The plan either conserves the pool exactly or is refused.
 */

import {
  ESPORTS_ORG_CUT_MAX_BPS,
  ESPORTS_ORG_CUT_MIN_BPS,
} from "./livestream";

/** A roster member's contract role — the split's routing vocabulary. */
export type EsportsRosterRole = "starter" | "substitute" | "coach" | "analyst";

/** True when the role is playing talent (withholding applies at release). */
export function isPlayingRole(role: EsportsRosterRole): boolean {
  return role === "starter" || role === "substitute";
}

/** One roster member's contract routing — integer cents at release. */
export interface EsportsRosterMember {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly role: EsportsRosterRole;
  /** The member's share of the roster pool in whole basis points. */
  readonly shareBps: number;
}

/** The waterfall's contract inputs — validated before any money moves. */
export interface EsportsWaterfallInput {
  readonly poolCents: number;
  readonly orgPayeeId: string;
  readonly orgPayeeName: string;
  /** The org's operational fee, whole basis points — the 15–30% band. */
  readonly orgCutBps: number;
  /** Advanced expense recoupment — each step only when contractually mandated. */
  readonly venueExpenseCents: number;
  readonly travelExpenseCents: number;
  readonly venueMandated: boolean;
  readonly travelMandated: boolean;
  readonly roster: readonly EsportsRosterMember[];
}

/** One roster member's integer-cent allocation. */
export interface EsportsRosterAllocation {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly role: EsportsRosterRole;
  readonly shareBps: number;
  readonly amountCents: number;
}

/** The computed waterfall — every step's integer-cent outcome. */
export interface EsportsWaterfallPlan {
  readonly venuePaidCents: number;
  readonly travelPaidCents: number;
  readonly orgPaidCents: number;
  readonly rosterPoolCents: number;
  readonly rosterAllocations: readonly EsportsRosterAllocation[];
  /** The floor residue from the roster split — swept to company variance. */
  readonly companyDustCents: number;
  /** Mandated expenses the pool could not cover — reported, never hidden. */
  readonly unrecoupedCents: number;
}

export type EsportsWaterfallPlanFailure = {
  ok: false;
  code: string;
  message: string;
};

export type EsportsWaterfallPlanSuccess = {
  ok: true;
  plan: EsportsWaterfallPlan;
};

function fail(code: string, message: string): EsportsWaterfallPlanFailure {
  return { ok: false, code, message };
}

function isNonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates the contract inputs and computes the sequential waterfall —
 * every step's allocation in exact integer cents, the sum of all
 * allocations plus dust equal to the pool by construction. No money
 * moves here; the release handler credits the plan only after its
 * fail-closed gates pass.
 */
export function buildEsportsWaterfallPlan(
  input: EsportsWaterfallInput,
): EsportsWaterfallPlanFailure | EsportsWaterfallPlanSuccess {
  if (!isNonNegativeInt(input.poolCents) || input.poolCents <= 0) {
    return fail(
      "invalid_prize_pool",
      "The prize pool posts integer cents greater than zero.",
    );
  }
  if (input.orgPayeeId.trim() === "") {
    return fail(
      "invalid_org_payee",
      "The waterfall names the org payee the recoupment and cut route to.",
    );
  }
  if (
    !Number.isSafeInteger(input.orgCutBps) ||
    input.orgCutBps < ESPORTS_ORG_CUT_MIN_BPS ||
    input.orgCutBps > ESPORTS_ORG_CUT_MAX_BPS
  ) {
    return fail(
      "invalid_org_cut_bps",
      `The org cut must sit in the ${ESPORTS_ORG_CUT_MIN_BPS}-${ESPORTS_ORG_CUT_MAX_BPS} bps band (15–30%) — got ${input.orgCutBps}.`,
    );
  }
  if (
    !isNonNegativeInt(input.venueExpenseCents) ||
    !isNonNegativeInt(input.travelExpenseCents)
  ) {
    return fail(
      "invalid_recoupment_expense",
      "Recoupment expenses post non-negative integer cents.",
    );
  }
  if (input.roster.length === 0) {
    return fail(
      "invalid_roster_empty",
      "The roster split names at least one member — a pool with no roster is unrouteable.",
    );
  }
  const seenPayees = new Set<string>();
  let shareSum = 0;
  for (const member of input.roster) {
    if (member.payeeId.trim() === "") {
      return fail("invalid_roster_member", "Every roster member names its payee.");
    }
    if (seenPayees.has(member.payeeId)) {
      return fail(
        "invalid_roster_duplicate_payee",
        `Payee "${member.payeeId}" appears more than once on the roster — one share per payee.`,
      );
    }
    seenPayees.add(member.payeeId);
    if (!isNonNegativeInt(member.shareBps) || member.shareBps <= 0) {
      return fail(
        "invalid_roster_share",
        `Roster member "${member.payeeId}" carries share ${member.shareBps} bps — a listed member's share is a positive integer.`,
      );
    }
    shareSum += member.shareBps;
  }
  if (shareSum !== 10000) {
    return fail(
      "invalid_roster_share_sum",
      `Roster shares sum to ${shareSum} bps — they must sum to EXACTLY 10000 (100.0000%).`,
    );
  }

  // Step 1 — venue recoupment (mandated only; capped at what remains).
  const venuePaidCents = input.venueMandated
    ? Math.min(input.venueExpenseCents, input.poolCents)
    : 0;
  let remaining = input.poolCents - venuePaidCents;

  // Step 2 — travel recoupment (same mandate rule, same cap).
  const travelPaidCents = input.travelMandated
    ? Math.min(input.travelExpenseCents, remaining)
    : 0;
  remaining -= travelPaidCents;

  const mandatedTotal =
    (input.venueMandated ? input.venueExpenseCents : 0) +
    (input.travelMandated ? input.travelExpenseCents : 0);
  const unrecoupedCents = Math.max(0, mandatedTotal - (venuePaidCents + travelPaidCents));

  // Step 3 — the org cut: floor bps of the post-recoupment remainder.
  const orgPaidCents = Math.floor((remaining * input.orgCutBps) / 10000);
  remaining -= orgPaidCents;

  // Step 4 — the roster split: floor shares of the roster pool, the
  // sub-cent dust swept to the company variance account.
  const rosterPoolCents = remaining;
  const rosterAllocations = input.roster.map((member) => ({
    payeeId: member.payeeId,
    payeeName: member.payeeName,
    role: member.role,
    shareBps: member.shareBps,
    amountCents: Math.floor((rosterPoolCents * member.shareBps) / 10000),
  }));
  const allocated = rosterAllocations.reduce((total, a) => total + a.amountCents, 0);
  const companyDustCents = rosterPoolCents - allocated;

  return {
    ok: true,
    plan: {
      venuePaidCents,
      travelPaidCents,
      orgPaidCents,
      rosterPoolCents,
      rosterAllocations,
      companyDustCents,
      unrecoupedCents,
    },
  };
}
