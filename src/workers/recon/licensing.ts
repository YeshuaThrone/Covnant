/**
 * CVT recon worker — the brand-licensing lane's pure money engine (PR 32,
 * the founder Net Sales + tiered royalties + sub-license cascade directive).
 * The store-touching passes live in licensingQueue.ts / licensingPosting.ts
 * and the cascade module (src/lib/server/licensingRoyaltyCascade.ts); this
 * module is the math and the identity spaces — no store, no clock, no IO —
 * the same discipline as the film, books, merch, gaming, art, and theatrical
 * engines.
 *
 * House rules, restated as the module's contract:
 * - DETERMINISTIC BIGINT INTEGER MATH ONLY — the 1e-8 micros fixed-point
 *   discipline; a float anywhere in this file is a bug.
 * - SUB-CENT RESIDUE NEVER ROUNDS UP — every division floors; the ledger
 *   never invents money.
 * - FAIL-CLOSED — any row the lane cannot fully verify is a typed rejection
 *   at parse time (the profiles) or a refused/held post (the cascade and
 *   posting passes); nothing defaults to allowing.
 *
 * The money models the directive pins:
 *
 *   1. THE NET SALES REALIZATION — a row's Net Licensed Sales is gross
 *      retail or wholesale revenue minus four approved deduction legs:
 *      trade discounts, returned goods allowances, standard shipping and
 *      freight deductions, and value added taxes. Net Licensed Sales =
 *      gross − (trade discounts + returned goods + shipping/freight + VAT),
 *      exact to the cent. The ledger math is whole cents (the Don ledger's
 *      contract); the statement legs ride the queue row in exact micros as
 *      provenance, and each leg floors into cents — a deduction never
 *      rounds up, so the licensee's net is never overstated. A negative
 *      result means the deduction legs outran the gross — the caller
 *      quarantines the row (held_negative_net), never posting it.
 *
 *   2. TIERED ROYALTY RATES ON CUMULATIVE VOLUME — the deal's schedule is
 *      a marginal tier table on CUMULATIVE net sales across reporting
 *      periods (e.g. 8% to $1M, 10% $1M–$5M, 12% above $5M). Each event's
 *      net sales walks the schedule from the deal's current cumulative
 *      position: the slice inside each tier's band earns that tier's rate,
 *      floored per slice; the cumulative position advances by the row's
 *      net sales (never the royalty) and is committed through the
 *      position-locked application row — the state that survives periods.
 *
 *   3. AGENCY COMMISSION ORDERING — the licensing agency's commission
 *      (the founder band, 1500–3500 bps) deducts from the event's earned
 *      GROSS royalty — the tier walk's output — BEFORE any licensor split
 *      or withholding is computed. The dual-IP split and the withholding
 *      legs therefore both price the post-agency remainder; the ordering
 *      is pinned by the application row's conservation identity.
 *
 *   4. CO-BRANDED DUAL-IP SPLITS — when the deal names a second IP
 *      licensor, the post-agency royalty divides EQUALLY (50-50) between
 *      both licensor ledgers: floor/floor with the odd-cent residue swept
 *      to dust_cents (never rounded into a payee's credit).
 *
 *   5. CROSS-BORDER TREATY WITHHOLDING — a row whose source territory
 *      differs from the licensor's residence country is an international
 *      distribution sale: the double-taxation treaty rate of record
 *      (e.g. US→GB 0%, US→JP 10%) applies per licensor leg BEFORE the
 *      royalty payout — each licensor's payout is its post-agency share
 *      minus the withheld leg. An uncovered pair falls to the deal's
 *      statutory default; with no default either the leg is HELD
 *      (recorded, never guessed). A domestic sale (territory = residence)
 *      carries no withholding.
 *
 *   6. THE SUB-LICENSE CASCADE — a wholesale manifest row attributing to
 *      a registered regional sub-licensee walks the MASTER ROYALTY
 *      OVERRIDE instead of the tier table: the master licensor's royalty
 *      is floor(net sales × override). The report of record is written
 *      with its own recorded legs (the rollup's audit trail), and the net
 *      proceeds release reads the report's audit state FAIL-CLOSED —
 *      'unknown' holds the proceeds, only 'reconciled' releases.
 *
 * Event-id spaces, content-derived per row identity (the books/art
 * fingerprint discipline — identity, never money): `licensing:<sender>:`
 * per (license, category, territory, period, sender row id, sub-licensee
 * when present). A re-shipped report replays as counted no-ops through the
 * queue's UNIQUE event_id, and two senders' sheets for the same sale stay
 * distinct identities.
 */

import { createHash } from "node:crypto";

/** House micro-dollar scale: 1 unit = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** Statement micros per whole ledger cent — the Don ledger's 1e6 sub-unit. */
export const MICROS_PER_CENT = 1_000_000n;

/** The four senders' codes — one ingestion profile each. */
export const LICENSING_SENDERS = ["retail", "sellthrough", "ecommerce", "wholesale"] as const;
export type LicensingSenderCode = (typeof LICENSING_SENDERS)[number];

export function isLicensingSenderCode(value: string): value is LicensingSenderCode {
  return (LICENSING_SENDERS as readonly string[]).includes(value);
}

/**
 * Floors one deduction leg's micros into whole ledger cents — a deduction
 * never rounds up (the ledger never invents money for the deducting party).
 */
export function licensingLegMicrosToCents(micros: bigint): number {
  const cents = micros / MICROS_PER_CENT;
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`licensing_leg_overflow: ${micros} micros exceeds the safe integer-cent range`);
  }
  return value;
}

export interface LicensingNetSalesLegsMicros {
  grossRevenueMicros: bigint;
  tradeDiscountMicros: bigint;
  returnedGoodsMicros: bigint;
  shippingFreightMicros: bigint;
  vatMicros: bigint;
}

/**
 * THE NET SALES REALIZATION, exact to the cent: gross retail or wholesale
 * revenue minus approved trade discounts, returned goods allowances,
 * standard shipping and freight deductions, and value added taxes equals
 * Net Licensed Sales. Each leg floors from its exact micros; the
 * subtraction is integer cents.
 */
export function netLicensedSalesCents(legs: LicensingNetSalesLegsMicros): {
  grossRevenueCents: number;
  tradeDiscountCents: number;
  returnedGoodsCents: number;
  shippingFreightCents: number;
  vatCents: number;
  netSalesCents: number;
} {
  const grossRevenueCents = licensingLegMicrosToCents(legs.grossRevenueMicros);
  const tradeDiscountCents = licensingLegMicrosToCents(legs.tradeDiscountMicros);
  const returnedGoodsCents = licensingLegMicrosToCents(legs.returnedGoodsMicros);
  const shippingFreightCents = licensingLegMicrosToCents(legs.shippingFreightMicros);
  const vatCents = licensingLegMicrosToCents(legs.vatMicros);
  return {
    grossRevenueCents,
    tradeDiscountCents,
    returnedGoodsCents,
    shippingFreightCents,
    vatCents,
    netSalesCents:
      grossRevenueCents -
      tradeDiscountCents -
      returnedGoodsCents -
      shippingFreightCents -
      vatCents,
  };
}

// ---------------------------------------------------------------------------
// The tiered royalty walk — marginal slices on the cumulative position.
// ---------------------------------------------------------------------------

/**
 * THE TIERED ROYALTY WALK, exact: the event's net sales walks the deal's
 * marginal tier schedule from the deal's cumulative position. Each slice
 * inside a tier's band earns that tier's rate, floored per slice — the
 * residue never rounds up. The walk returns the slices (the audit detail),
 * the gross royalty, and the advanced position; the caller commits it
 * through the position-locked application row.
 *
 * Example (the directive's schedule): 8% to $1M, 10% $1M–$5M, 12% above —
 * a row arriving at cumulative $999,999.99 with $1 net splits at the
 * boundary: the first cent earns 8%, the remainder 10%. A row arriving at
 * exactly $1M walks entirely in the second tier.
 */
export function tieredRoyaltyWalk(
  netSalesCents: number,
  cumulativeBeforeCents: number,
  tiers: readonly { upToCents: number | null; rateBps: number }[],
): {
  slices: { tierIndex: number; rateBps: number; sliceCents: number; royaltyCents: number }[];
  royaltyCents: number;
  cumulativeAfterCents: number;
} {
  if (!Number.isSafeInteger(netSalesCents) || netSalesCents < 0) {
    throw new Error(`licensing_walk_net_invalid: ${netSalesCents}`);
  }
  if (!Number.isSafeInteger(cumulativeBeforeCents) || cumulativeBeforeCents < 0) {
    throw new Error(`licensing_walk_position_invalid: ${cumulativeBeforeCents}`);
  }
  if (tiers.length === 0) {
    throw new Error("licensing_walk_schedule_empty");
  }
  // The schedule must be a valid marginal table — ascending finite bounds
  // and one trailing unbounded tier — before any money walks it.
  let previousBound = 0;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index]!;
    if (!Number.isInteger(tier.rateBps) || tier.rateBps < 0 || tier.rateBps > 10_000) {
      throw new Error(`licensing_walk_rate_invalid: tier ${index + 1}`);
    }
    if (tier.upToCents === null) {
      if (index !== tiers.length - 1) {
        throw new Error("licensing_walk_unbounded_not_final");
      }
      continue;
    }
    if (!Number.isSafeInteger(tier.upToCents) || tier.upToCents <= previousBound) {
      throw new Error(`licensing_walk_bound_invalid: tier ${index + 1}`);
    }
    previousBound = tier.upToCents;
  }

  const slices: { tierIndex: number; rateBps: number; sliceCents: number; royaltyCents: number }[] =
    [];
  let royaltyCents = 0;
  let position = cumulativeBeforeCents;
  let remaining = netSalesCents;
  for (let index = 0; index < tiers.length && remaining > 0; index += 1) {
    const tier = tiers[index]!;
    // The tier's open capacity from the current position: an unbounded
    // final tier absorbs everything left; a bounded tier takes min(
    // remaining, bound − position).
    const capacity =
      tier.upToCents === null ? remaining : Math.max(0, Math.min(remaining, tier.upToCents - position));
    if (capacity <= 0) {
      // The position already sits at or past this tier's bound — the walk
      // moves on to the next tier without earning anything here.
      if (tier.upToCents !== null && position >= tier.upToCents) continue;
      continue;
    }
    const sliceRoyalty = Math.floor((capacity * tier.rateBps) / 10_000);
    slices.push({ tierIndex: index, rateBps: tier.rateBps, sliceCents: capacity, royaltyCents: sliceRoyalty });
    royaltyCents += sliceRoyalty;
    position += capacity;
    remaining -= capacity;
  }
  return { slices, royaltyCents, cumulativeAfterCents: cumulativeBeforeCents + netSalesCents };
}

// ---------------------------------------------------------------------------
// Agency commission, dual-IP split, withholding, and the master override.
// ---------------------------------------------------------------------------

/** The agency commission — floor(gross royalty × bps / 10000), the founder
 * band's share of the event's earned GROSS royalty. */
export function agencyCommissionCents(grossRoyaltyCents: number, agencyBps: number): number {
  if (!Number.isSafeInteger(grossRoyaltyCents) || grossRoyaltyCents < 0) {
    throw new Error(`licensing_agency_royalty_invalid: ${grossRoyaltyCents}`);
  }
  if (!Number.isInteger(agencyBps) || agencyBps < 0 || agencyBps > 10_000) {
    throw new Error(`licensing_agency_rate_invalid: ${agencyBps}`);
  }
  return Math.floor((grossRoyaltyCents * agencyBps) / 10_000);
}

/**
 * THE CO-BRANDED DUAL-IP SPLIT — the post-agency royalty divides equally
 * between both IP licensor ledgers: floor/floor, the odd-cent residue
 * swept to dust (never rounded into a payee's credit). A single-licensor
 * deal keeps everything on licensor A with zero dust.
 */
export function dualIpSplitCents(netAfterAgencyCents: number): {
  licensorACents: number;
  licensorBCents: number;
  dustCents: number;
} {
  if (!Number.isSafeInteger(netAfterAgencyCents) || netAfterAgencyCents < 0) {
    throw new Error(`licensing_split_basis_invalid: ${netAfterAgencyCents}`);
  }
  const licensorACents = Math.floor(netAfterAgencyCents / 2);
  const licensorBCents = Math.floor(netAfterAgencyCents / 2);
  return {
    licensorACents,
    licensorBCents,
    dustCents: netAfterAgencyCents - licensorACents - licensorBCents,
  };
}

/** The treaty withholding on one licensor's payout leg —
 * floor(leg × rate / 10000), taken before the royalty payout. */
export function treatyWithholdingCents(payoutLegCents: number, rateBps: number): number {
  if (!Number.isSafeInteger(payoutLegCents) || payoutLegCents < 0) {
    throw new Error(`licensing_withholding_leg_invalid: ${payoutLegCents}`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error(`licensing_withholding_rate_invalid: ${rateBps}`);
  }
  return Math.floor((payoutLegCents * rateBps) / 10_000);
}

/** THE MASTER ROYALTY OVERRIDE — the sub-license cascade's flat rate:
 * floor(net sales × override / 10000), replacing the tier walk for the
 * sub-licensed region's money. */
export function masterOverrideRoyaltyCents(netSalesCents: number, overrideBps: number): number {
  if (!Number.isSafeInteger(netSalesCents) || netSalesCents < 0) {
    throw new Error(`licensing_override_net_invalid: ${netSalesCents}`);
  }
  if (!Number.isInteger(overrideBps) || overrideBps < 0 || overrideBps > 10_000) {
    throw new Error(`licensing_override_rate_invalid: ${overrideBps}`);
  }
  return Math.floor((netSalesCents * overrideBps) / 10_000);
}

// ---------------------------------------------------------------------------
// Identity spaces.
// ---------------------------------------------------------------------------

/** The sha256 identity fingerprint — identity fields only, never money. */
function licensingFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (sender, license, category, territory,
 * period, sender row id, sub-licensee when present). The addendum 12 triple
 * plus the sender's row id of record: a re-shipped report replays as a
 * counted no-op, and two senders' sheets for the same sale stay distinct
 * identities. The sub-licensee rides the identity — a wholesale manifest
 * row attributed to a different sub-licensee is a different event.
 */
export function licensingRowEventId(detail: {
  sender: LicensingSenderCode;
  licenseId: string;
  categoryCode: string;
  territoryIso: string;
  period: string;
  senderRowId: string;
  subLicenseeId?: string | null;
}): string {
  return `licensing:${detail.sender}:${licensingFingerprint(
    detail.licenseId,
    detail.categoryCode,
    detail.territoryIso,
    detail.period,
    detail.senderRowId,
    detail.subLicenseeId ?? "",
  )}`;
}

/** The license scope key — the deal-of-record lookup. */
export function licensingScopeKey(licenseId: string): string {
  return `license:${licenseId}`;
}

/** The reporting period's shape of record (YYYY-MM). */
export function isLicensingPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}
