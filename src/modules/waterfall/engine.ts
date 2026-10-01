// The film waterfall engine (PR 8, Deep Royalties) — tier definitions and the
// pure sequential recoupment router.
//
// The founder film directive's cascade. Funds route STRICTLY in tier order,
// never proportional:
//
//   tier 0  off-the-top fees — the distribution commission (a bps rate of every
//           receipt, 20-30% in practice) plus P&A marketing expense caps (fixed
//           obligations that recoup).
//   tier 1  senior debt and gap financing — principal plus interest.
//   tier 2  CAMA fees and guild residuals — SAG-AFTRA / DGA / WGA compliance
//           holds and collection-account fees, fixed obligations.
//   tier 3  equity investors — 100% principal recoupment plus the negotiated
//           preferred return (the founder's example range: 115-120% of
//           principal, i.e. a 1500-2000 bps premium over principal).
//   tier 4  deferred compensation and crew deferments — fixed obligations.
//   tier 5  the net profit pool — the residue; the release splits it into the
//           locked 50/50 producer/investor pools (TIER_5_PRODUCER_POOL_BPS).
//
// This module is PURE — no Store, no I/O, no clock. It consumes the tier_level
// canon migration 0011 ships (the recon profiles stamp film receipts at tier 0,
// the collection-account entry tier this allocator refines) and produces the
// per-tier `tier_allocations` shape the film escrow release (PR 9's
// releaseFilmEscrow) applies as GL legs. First Dollar Gross participant points
// bypass the tiers per contract — computed on the RECEIPT off the very top,
// exactly the release's own floor formula, before any tier sees a cent.
//
// Shortfall carry is HONEST, not derived: an obligation that a period's receipt
// cannot fully fund reports its remaining unpaid balance, and the caller's
// cumulative paid state (the applied film_waterfall_distributions rows — the
// routing-decision record) carries it into later periods. The GL's tier legs
// are per-TIER, so per-obligation paid state cannot be recovered from them when
// bps legs and fixed legs share a tier — the distributions record exists so the
// carry never guesses. Corrupt state (paid exceeding an obligation — impossible
// while definitions lock once distributed) throws; it never silently clamps.
//
// Integer cents and basis points throughout; every share is a floor, so
// allocations can never exceed the money being routed; the integer-cent dust
// the floors leave sweeps to the platform payee in the release, the PR 9
// precedent this module routes into.

import { BPS_DENOMINATOR } from "@/modules/don/constants";
import type { PayeeRole } from "@/lib/don/types";

/** The waterfall's tier levels — migration 0011's tier_level canon, 0 through 5. */
export type WaterfallTierLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const WATERFALL_TIER_LEVELS: readonly WaterfallTierLevel[] = [0, 1, 2, 3, 4, 5];

/**
 * One funding leg's structure.
 *
 *   per_receipt_bps     — a bps rate of the RECEIPT routed here on every
 *                         transaction, optionally capped by a cumulative
 *                         lifetime amount (cap_cents null = uncapped; the
 *                         tier-0 commission is the canonical case).
 *   fixed_obligation    — a fixed lifetime amount that recoups sequentially
 *                         (P&A caps, CAMA fees, guild residual holds, crew
 *                         deferments).
 *   debt_recoupment     — principal plus interest: the obligation is
 *                         principal_cents + floor(principal_cents ×
 *                         interest_bps / 10000).
 *   equity_recoupment   — principal plus the negotiated preferred return: the
 *                         obligation is principal_cents + floor(principal_cents
 *                         × preferred_return_bps / 10000). 0 bps = 100%
 *                         principal recoupment; 1500 bps = 115%; 2000 bps = 120%.
 *   profit_pool         — the tier-5 residue. Never a fixed demand: it receives
 *                         whatever survives the cascade.
 */
export type WaterfallLegStructure =
  | { type: "per_receipt_bps"; bps: number; cap_cents: number | null }
  | { type: "fixed_obligation"; obligation_cents: number }
  | { type: "debt_recoupment"; principal_cents: number; interest_bps: number }
  | { type: "equity_recoupment"; principal_cents: number; preferred_return_bps: number }
  | { type: "profit_pool" };

export interface WaterfallLeg {
  /** Stable identity the cumulative paid state keys on — unique per definition. */
  leg_id: string;
  label: string;
  /** Who the leg pays (informational at release time — tiers route per-tier GL accounts). */
  payee_id: string;
  payee_name: string;
  structure: WaterfallLegStructure;
}

export interface WaterfallTierSpec {
  tier_level: WaterfallTierLevel;
  label: string;
  /** Routed strictly in array order; one leg must complete before the next sees money. */
  legs: WaterfallLeg[];
}

/** One First Dollar Gross participant — gross points, in bps of the receipt. */
export interface WaterfallFdgParticipant {
  payee_id: string;
  payee_name: string;
  role: PayeeRole;
  share_bps: number;
}

/**
 * The deal's First Dollar Gross terms as registered. threshold_cents null =
 * first-dollar from the film's first receipt; a threshold fires once the
 * film's cumulative gross receipts have crossed it. Structurally identical to
 * filmEscrow's FdgDealTerms (the release input it feeds).
 */
export interface WaterfallFdgTerms {
  participants: WaterfallFdgParticipant[];
  threshold_cents: number | null;
}

/** One registered film waterfall — the deal as verified at the cross-reference. */
export interface FilmWaterfallDefinition {
  film_id: string;
  label: string;
  /** Exactly tiers 0 through 5, each present once. */
  tiers: WaterfallTierSpec[];
  /** The deal's gross-point terms; null = the deal defines no gross points. */
  fdg: WaterfallFdgTerms | null;
}

/**
 * One verified waterfall tier routing — structurally identical to filmEscrow's
 * WaterfallTierAllocation (the release input shape): one allocation per tier,
 * tier_level 0 through 5, positive integer cents.
 */
export interface WaterfallTierAllocation {
  tier_level: number;
  amount_cents: number;
}

/** Cumulative paid state per leg_id, from the film's APPLIED distribution rows. */
export type WaterfallPaidState = Readonly<Record<string, number>>;

/** One leg's routing outcome — the honest record of demand, payment, and carry. */
export interface WaterfallLegRouting {
  tier_level: WaterfallTierLevel;
  leg_id: string;
  label: string;
  payee_id: string;
  /**
   * What the leg demanded THIS period: the bps share of the receipt for
   * per_receipt_bps legs (before cap room), the remaining obligation against
   * available money for obligation legs, the surviving residue for the profit
   * pool. Zero once fully paid or out of money.
   */
  demand_cents: number;
  routed_cents: number;
  /** Remaining lifetime balance after this routing — 0 for flow-through legs. */
  unpaid_cents: number;
  /** Lifetime cumulative paid INCLUDING this routing. */
  cumulative_paid_cents: number;
}

/** One First Dollar Gross participant's computed bypass on a routing. */
export interface WaterfallFdgRouting {
  payee_id: string;
  payee_name: string;
  role: PayeeRole;
  share_bps: number;
  amount_cents: number;
}

export interface WaterfallRouting {
  /** Whether the deal's FDG trigger fired for this receipt. */
  fdg_triggered: boolean;
  /** Per-participant FDG bypass amounts (all zero when untriggered). */
  fdg_participants: WaterfallFdgRouting[];
  /** The FDG total taken off the top of the receipt, integer cents. */
  fdg_bypass_cents: number;
  /** Every defined leg in routing order, including legs that routed zero. */
  legs: WaterfallLegRouting[];
  /**
   * The positive per-tier totals — the release input. Zero tiers are omitted
   * (the release refuses non-positive allocations).
   */
  tier_allocations: WaterfallTierAllocation[];
  /** What reached the tier-5 profit pool, integer cents (0 when exhausted first). */
  profit_pool_cents: number;
  /** The honest carry: the total lifetime balance still owed after this routing. */
  unpaid_total_cents: number;
  /** True when money ran out before an obligation was fully funded. */
  exhausted: boolean;
  /** amount − fdg − tiers — the platform dust the release sweeps. */
  dust_cents: number;
}

export type WaterfallValidationFailure = {
  ok: false;
  code: string;
  message: string;
};

export type WaterfallValidationSuccess = {
  ok: true;
  definition: FilmWaterfallDefinition;
};

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBps(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= BPS_DENOMINATOR;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The lifetime obligation one leg's structure demands before it is fully paid —
 * null for flow-through legs (uncapped bps, the profit pool), which never
 * accrue an unpaid balance. Pure.
 */
export function waterfallLegObligationCents(structure: WaterfallLegStructure): number | null {
  switch (structure.type) {
    case "per_receipt_bps":
      return structure.cap_cents === null ? null : structure.cap_cents;
    case "fixed_obligation":
      return structure.obligation_cents;
    case "debt_recoupment":
      return structure.principal_cents +
        Math.floor((structure.principal_cents * structure.interest_bps) / BPS_DENOMINATOR);
    case "equity_recoupment":
      return structure.principal_cents +
        Math.floor((structure.principal_cents * structure.preferred_return_bps) / BPS_DENOMINATOR);
    case "profit_pool":
      return null;
  }
}

/**
 * Validates a film waterfall definition — the registration gate. Fail-closed:
 * every field is checked, tiers must be exactly 0 through 5 with structures the
 * tier's contract allows, and the FDG bypass plus the tier-0 commission can
 * never promise more than 100% of a receipt. Returns the typed definition on
 * success; a coded failure otherwise. Pure.
 */
export function validateFilmWaterfallDefinition(
  input: unknown,
): WaterfallValidationSuccess | WaterfallValidationFailure {
  if (typeof input !== "object" || input === null) {
    return { ok: false, code: "invalid_definition", message: "A waterfall definition is an object." };
  }
  const raw = input as Record<string, unknown>;
  if (!isNonEmptyString(raw.film_id)) {
    return { ok: false, code: "invalid_film_id", message: "A waterfall definition names its film." };
  }
  if (!isNonEmptyString(raw.label)) {
    return { ok: false, code: "invalid_label", message: "A waterfall definition carries a label." };
  }

  // The tiers: exactly 0 through 5, each present exactly once.
  if (!Array.isArray(raw.tiers) || raw.tiers.length !== WATERFALL_TIER_LEVELS.length) {
    return {
      ok: false,
      code: "invalid_tiers",
      message: `A waterfall definition defines exactly ${WATERFALL_TIER_LEVELS.length} tiers (0 through 5).`,
    };
  }
  const seenLevels = new Set<number>();
  const tiers: WaterfallTierSpec[] = [];
  for (const rawTier of raw.tiers) {
    if (typeof rawTier !== "object" || rawTier === null) {
      return { ok: false, code: "invalid_tier", message: "Each waterfall tier is an object." };
    }
    const tier = rawTier as Record<string, unknown>;
    if (
      typeof tier.tier_level !== "number" ||
      !Number.isSafeInteger(tier.tier_level) ||
      tier.tier_level < 0 ||
      tier.tier_level > 5
    ) {
      return { ok: false, code: "invalid_tier_level", message: "Waterfall tiers are 0 through 5." };
    }
    if (seenLevels.has(tier.tier_level)) {
      return {
        ok: false,
        code: "duplicate_tier",
        message: `Tier ${tier.tier_level} appears more than once — one spec per tier.`,
      };
    }
    if (!isNonEmptyString(tier.label)) {
      return { ok: false, code: "invalid_tier_label", message: "Each waterfall tier carries a label." };
    }
    if (!Array.isArray(tier.legs)) {
      return { ok: false, code: "invalid_tier_legs", message: "Each waterfall tier carries its legs." };
    }
    const legs: WaterfallLeg[] = [];
    for (const rawLeg of tier.legs) {
      if (typeof rawLeg !== "object" || rawLeg === null) {
        return { ok: false, code: "invalid_leg", message: "Each waterfall leg is an object." };
      }
      const leg = rawLeg as Record<string, unknown>;
      if (!isNonEmptyString(leg.leg_id)) {
        return { ok: false, code: "invalid_leg_id", message: "Each waterfall leg carries a leg_id." };
      }
      if (!isNonEmptyString(leg.label)) {
        return { ok: false, code: "invalid_leg_label", message: "Each waterfall leg carries a label." };
      }
      if (!isNonEmptyString(leg.payee_id) || !isNonEmptyString(leg.payee_name)) {
        return { ok: false, code: "invalid_leg_payee", message: "Each waterfall leg names its payee." };
      }
      const structure = leg.structure as Record<string, unknown> | undefined;
      if (typeof structure !== "object" || structure === null) {
        return { ok: false, code: "invalid_leg_structure", message: "Each waterfall leg carries a structure." };
      }
      const validated = validateLegStructure(tier.tier_level as WaterfallTierLevel, structure);
      if (!validated.ok) return validated;
      legs.push({
        leg_id: leg.leg_id,
        label: leg.label,
        payee_id: leg.payee_id,
        payee_name: leg.payee_name,
        structure: validated.structure,
      });
    }
    seenLevels.add(tier.tier_level);
    tiers.push({ tier_level: tier.tier_level as WaterfallTierLevel, label: tier.label, legs });
  }
  for (const level of WATERFALL_TIER_LEVELS) {
    if (!seenLevels.has(level)) {
      return {
        ok: false,
        code: "missing_tier",
        message: `A waterfall definition defines tier ${level} — the cascade is complete or it is nothing.`,
      };
    }
  }

  // Tier 5 is the profit pool: exactly one leg, and it IS the pool.
  const tier5 = tiers.find((tier) => tier.tier_level === 5)!;
  if (tier5.legs.length !== 1 || tier5.legs[0]!.structure.type !== "profit_pool") {
    return {
      ok: false,
      code: "invalid_profit_pool",
      message: "Tier 5 is the net profit pool — exactly one profit_pool leg.",
    };
  }

  // leg_ids are the cumulative-paid state's keys — unique across the definition.
  const legIds = new Set<string>();
  for (const tier of tiers) {
    for (const leg of tier.legs) {
      if (legIds.has(leg.leg_id)) {
        return {
          ok: false,
          code: "duplicate_leg_id",
          message: `Leg id "${leg.leg_id}" appears more than once — leg ids are unique.`,
        };
      }
      legIds.add(leg.leg_id);
    }
  }

  // The FDG terms, when the deal defines gross points.
  let fdg: WaterfallFdgTerms | null = null;
  if (raw.fdg !== null && raw.fdg !== undefined) {
    if (typeof raw.fdg !== "object") {
      return { ok: false, code: "invalid_fdg", message: "The FDG terms are an object or null." };
    }
    const rawFdg = raw.fdg as Record<string, unknown>;
    if (!Array.isArray(rawFdg.participants)) {
      return { ok: false, code: "invalid_fdg", message: "The FDG terms name their participants." };
    }
    const participants: WaterfallFdgParticipant[] = [];
    let totalBps = 0;
    for (const rawParticipant of rawFdg.participants) {
      if (typeof rawParticipant !== "object" || rawParticipant === null) {
        return { ok: false, code: "invalid_fdg", message: "Each FDG participant is an object." };
      }
      const participant = rawParticipant as Record<string, unknown>;
      if (!isNonEmptyString(participant.payee_id) || !isNonEmptyString(participant.payee_name)) {
        return { ok: false, code: "invalid_fdg", message: "Each FDG participant names its payee." };
      }
      if (!isBps(participant.share_bps)) {
        return {
          ok: false,
          code: "invalid_fdg",
          message: "FDG share is a non-negative integer bps of at most 10000.",
        };
      }
      participants.push({
        payee_id: participant.payee_id,
        payee_name: participant.payee_name,
        role: participant.role as PayeeRole,
        share_bps: participant.share_bps,
      });
      totalBps += participant.share_bps;
    }
    if (totalBps > BPS_DENOMINATOR) {
      return {
        ok: false,
        code: "fdg_shares_exceed_gross",
        message: `First Dollar Gross shares are bps of the receipt summing to at most 10000 (got ${totalBps}).`,
      };
    }
    let threshold: number | null = null;
    if (rawFdg.threshold_cents !== null && rawFdg.threshold_cents !== undefined) {
      if (!isSafeNonNegativeInteger(rawFdg.threshold_cents)) {
        return {
          ok: false,
          code: "invalid_fdg_threshold",
          message: "The FDG threshold is an integer-cent amount, or null for first-dollar.",
        };
      }
      threshold = rawFdg.threshold_cents;
    }
    fdg = { participants, threshold_cents: threshold };
  }

  // The bypass contract: FDG points plus the tier-0 commission are both bps of
  // the receipt — together they can never promise more than 100% of one.
  const tier0 = tiers.find((tier) => tier.tier_level === 0)!;
  const commissionBps = tier0.legs.reduce(
    (total, leg) => (leg.structure.type === "per_receipt_bps" ? total + leg.structure.bps : total),
    0,
  );
  const fdgBps = fdg?.participants.reduce((total, participant) => total + participant.share_bps, 0) ?? 0;
  if (fdgBps + commissionBps > BPS_DENOMINATOR) {
    return {
      ok: false,
      code: "bypass_exceeds_receipt",
      message: `FDG points (${fdgBps} bps) + the tier-0 commission (${commissionBps} bps) exceed 10000 bps of the receipt.`,
    };
  }

  return {
    ok: true,
    definition: {
      film_id: raw.film_id,
      label: raw.label,
      tiers,
      fdg,
    },
  };
}

function validateLegStructure(
  tierLevel: WaterfallTierLevel,
  structure: Record<string, unknown>,
): { ok: true; structure: WaterfallLegStructure } | WaterfallValidationFailure {
  switch (structure.type) {
    case "per_receipt_bps": {
      if (tierLevel !== 0) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: `per_receipt_bps legs ride tier 0 only (got tier ${tierLevel}).`,
        };
      }
      if (!isBps(structure.bps)) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "A per-receipt bps rate is a non-negative integer bps of at most 10000.",
        };
      }
      let cap: number | null = null;
      if (structure.cap_cents !== null && structure.cap_cents !== undefined) {
        if (!isSafeNonNegativeInteger(structure.cap_cents)) {
          return {
            ok: false,
            code: "invalid_leg_structure",
            message: "A per-receipt bps cap is an integer-cent amount, or null for uncapped.",
          };
        }
        cap = structure.cap_cents;
      }
      return { ok: true, structure: { type: "per_receipt_bps", bps: structure.bps, cap_cents: cap } };
    }
    case "fixed_obligation": {
      if (tierLevel === 5) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "Tier 5 is the profit pool — it carries no fixed obligations.",
        };
      }
      if (!isSafeNonNegativeInteger(structure.obligation_cents) || structure.obligation_cents === 0) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "A fixed obligation is integer cents greater than zero.",
        };
      }
      return { ok: true, structure: { type: "fixed_obligation", obligation_cents: structure.obligation_cents } };
    }
    case "debt_recoupment": {
      if (tierLevel !== 1) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: `debt_recoupment legs ride tier 1 only (got tier ${tierLevel}).`,
        };
      }
      if (!isSafeNonNegativeInteger(structure.principal_cents) || structure.principal_cents === 0) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "Debt principal is integer cents greater than zero.",
        };
      }
      if (!isBps(structure.interest_bps)) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "Debt interest is a non-negative integer bps of at most 10000.",
        };
      }
      return {
        ok: true,
        structure: {
          type: "debt_recoupment",
          principal_cents: structure.principal_cents,
          interest_bps: structure.interest_bps,
        },
      };
    }
    case "equity_recoupment": {
      if (tierLevel !== 3) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: `equity_recoupment legs ride tier 3 only (got tier ${tierLevel}).`,
        };
      }
      if (!isSafeNonNegativeInteger(structure.principal_cents) || structure.principal_cents === 0) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "Equity principal is integer cents greater than zero.",
        };
      }
      if (!isBps(structure.preferred_return_bps)) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: "The preferred return is a non-negative integer bps of at most 10000.",
        };
      }
      return {
        ok: true,
        structure: {
          type: "equity_recoupment",
          principal_cents: structure.principal_cents,
          preferred_return_bps: structure.preferred_return_bps,
        },
      };
    }
    case "profit_pool": {
      if (tierLevel !== 5) {
        return {
          ok: false,
          code: "invalid_leg_structure",
          message: `profit_pool legs ride tier 5 only (got tier ${tierLevel}).`,
        };
      }
      return { ok: true, structure: { type: "profit_pool" } };
    }
    default:
      return {
        ok: false,
        code: "invalid_leg_structure",
        message: "Leg structures are per_receipt_bps, fixed_obligation, debt_recoupment, equity_recoupment, or profit_pool.",
      };
  }
}

/**
 * Routes ONE transaction (a released escrow receipt) through the waterfall —
 * the pure sequential allocator. The cascade: First Dollar Gross points off the
 * top of the receipt per the deal's contract (the floors of the receipt the
 * release itself computes), then tiers 0 through 5 strictly in order, each
 * tier's legs in definition order, every share a floor of integer cents.
 *
 * per_receipt_bps legs measure against the RECEIPT (they are rates of gross
 * receipts), limited by the money still in the cascade and their cap room.
 * Obligation legs demand their remaining lifetime balance; the profit pool
 * receives whatever survives. Unpaid balances are honest: obligation − paid −
 * routed, carried by the caller's cumulative paid state into later periods.
 *
 * Throws RangeError on impossible inputs (negative paid state, paid exceeding
 * an obligation — corrupt cumulative state, never clamped away). Pure.
 */
export function routeWaterfallTransaction(
  definition: FilmWaterfallDefinition,
  amountCents: number,
  cumulativeGrossCents: number,
  paid: WaterfallPaidState = {},
): WaterfallRouting {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`Waterfall routing: ${amountCents} is not a safe non-negative integer.`);
  }
  if (!Number.isSafeInteger(cumulativeGrossCents) || cumulativeGrossCents < 0) {
    throw new RangeError(`Waterfall routing: cumulative gross ${cumulativeGrossCents} is not a safe non-negative integer.`);
  }
  for (const [legId, paidCents] of Object.entries(paid)) {
    if (!Number.isSafeInteger(paidCents) || paidCents < 0) {
      throw new RangeError(`Waterfall routing: paid state for "${legId}" (${paidCents}) is not a safe non-negative integer.`);
    }
  }

  // --- First Dollar Gross bypass, per contract: the participant floors come
  // off the top of the RECEIPT when the deal's cumulative-gross trigger fires.
  const fdg = definition.fdg;
  let fdgTriggered = false;
  if (fdg !== null && fdg.participants.length > 0) {
    fdgTriggered =
      fdg.threshold_cents === null || cumulativeGrossCents >= fdg.threshold_cents;
  }
  const fdgParticipants: WaterfallFdgRouting[] = fdgTriggered
    ? fdg!.participants.map((participant) => ({
        payee_id: participant.payee_id,
        payee_name: participant.payee_name,
        role: participant.role,
        share_bps: participant.share_bps,
        amount_cents: Math.floor((amountCents * participant.share_bps) / BPS_DENOMINATOR),
      }))
    : fdg !== null
      ? fdg.participants.map((participant) => ({
          payee_id: participant.payee_id,
          payee_name: participant.payee_name,
          role: participant.role,
          share_bps: participant.share_bps,
          amount_cents: 0,
        }))
      : [];
  const fdgBypassCents = fdgParticipants.reduce((total, participant) => total + participant.amount_cents, 0);

  // --- The sequential tier cascade on the post-FDG residue.
  const legRoutings: WaterfallLegRouting[] = [];
  const tierTotals = new Map<WaterfallTierLevel, number>();
  let remaining = amountCents - fdgBypassCents;
  if (remaining < 0) {
    // Unreachable while registration validation holds (FDG bps ≤ 10000 and the
    // floors sum to at most the receipt) — refuse rather than route negative.
    throw new RangeError(`Waterfall routing: FDG bypass (${fdgBypassCents}) exceeds the receipt (${amountCents}).`);
  }

  for (const tier of definition.tiers) {
    for (const leg of tier.legs) {
      const paidSoFar = paid[leg.leg_id] ?? 0;
      const obligation = waterfallLegObligationCents(leg.structure);
      let demand = 0;
      if (leg.structure.type === "per_receipt_bps") {
        // The commission: a bps rate of the RECEIPT, limited by the money the
        // cascade still holds and the leg's remaining cap room.
        const grossShare = Math.floor((amountCents * leg.structure.bps) / BPS_DENOMINATOR);
        const capRoom =
          leg.structure.cap_cents === null
            ? grossShare
            : Math.max(0, leg.structure.cap_cents - paidSoFar);
        demand = Math.min(grossShare, capRoom);
      } else if (obligation !== null) {
        if (paidSoFar > obligation) {
          throw new RangeError(
            `Waterfall routing: leg "${leg.leg_id}" paid ${paidSoFar} exceeds its obligation ${obligation} — cumulative state is corrupt.`,
          );
        }
        demand = Math.max(0, obligation - paidSoFar);
      } else {
        // The profit pool: it receives whatever survives the cascade.
        demand = remaining;
      }
      const routed = Math.min(demand, remaining);
      remaining -= routed;
      const cumulativePaid =
        leg.structure.type === "per_receipt_bps"
          ? // Flow-through bps legs with no cap carry no lifetime balance; a
            // capped one accrues toward its cap.
            leg.structure.cap_cents === null
            ? 0
            : paidSoFar + routed
          : obligation === null
            ? 0
            : paidSoFar + routed;
      const unpaid =
        obligation === null || (leg.structure.type === "per_receipt_bps" && leg.structure.cap_cents === null)
          ? 0
          : Math.max(0, obligation - cumulativePaid);
      legRoutings.push({
        tier_level: tier.tier_level,
        leg_id: leg.leg_id,
        label: leg.label,
        payee_id: leg.payee_id,
        demand_cents: demand,
        routed_cents: routed,
        unpaid_cents: unpaid,
        cumulative_paid_cents: cumulativePaid,
      });
      tierTotals.set(tier.tier_level, (tierTotals.get(tier.tier_level) ?? 0) + routed);
    }
  }

  const tierAllocations: WaterfallTierAllocation[] = [...tierTotals.entries()]
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => a - b)
    .map(([tierLevel, amount]) => ({ tier_level: tierLevel, amount_cents: amount }));

  const routedTotal = legRoutings.reduce((total, leg) => total + leg.routed_cents, 0);
  const unpaidTotal = legRoutings.reduce((total, leg) => total + leg.unpaid_cents, 0);
  const dust = amountCents - fdgBypassCents - routedTotal;
  if (dust < 0) {
    throw new RangeError(
      `Waterfall routing: allocations (${fdgBypassCents} + ${routedTotal}) exceed the receipt (${amountCents}).`,
    );
  }

  return {
    fdg_triggered: fdgTriggered,
    fdg_participants: fdgParticipants,
    fdg_bypass_cents: fdgBypassCents,
    legs: legRoutings,
    tier_allocations: tierAllocations,
    profit_pool_cents: tierTotals.get(5) ?? 0,
    unpaid_total_cents: unpaidTotal,
    exhausted: unpaidTotal > 0,
    dust_cents: dust,
  };
}

/**
 * Sums a film's cumulative paid state from its APPLIED distribution rows — the
 * routing-decision record. The caller passes each applied row's per-leg
 * routings; this folds them into the leg_id → cumulative-paid map the pure
 * router consumes. Pure.
 */
export function cumulativePaidFromDistributions(
  distributions: ReadonlyArray<{ status: string; legs: ReadonlyArray<WaterfallLegRouting> }>,
): Record<string, number> {
  const paid: Record<string, number> = {};
  for (const distribution of distributions) {
    if (distribution.status !== "applied") continue;
    for (const leg of distribution.legs) {
      paid[leg.leg_id] = (paid[leg.leg_id] ?? 0) + leg.routed_cents;
    }
  }
  return paid;
}
