/**
 * CVT recon worker — the spatial lane's pure engine (PR 36, the founder
 * spatial directive): the identity spaces, THE ADJUSTED LOCATION SALES
 * CALCULATOR, the shared facility overhead deduction, the sliding-scale
 * occupancy royalty tier walk on cumulative annual throughput (or the
 * venue's square-footage footprint allocation), the closing-position
 * pricing for zero-entry rows, and the dynamic micro-royalty unit math.
 *
 * Every function here is pure — no store, no I/O — and exact to the cent:
 * deductions floor per leg (never round up — the house money discipline),
 * the calculator's identity (taxes + COGS + discounts + net === gross)
 * holds on every input, the tier walk's band allocations conserve the
 * royalty basis exactly (largest-remainder), and the micro-royalty math is
 * bigint-exact statement micros floored into payable cents. The queue
 * writer consumes these; the profiles parse into them.
 */

import { createHash } from "node:crypto";

import type { SpatialTierBand, SpatialTierWalkLeg } from "@/modules/spatial/records";

/** The spatial lane's statement senders — the five strict layouts' families. */
export type SpatialSenderCode = "turnstile" | "pass" | "fnb" | "retail" | "rfid";

function spatialFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (sender, venue, zone, period, sender row
 * id). The sender's row id of record is the identity core: a re-shipped
 * sheet replays as a counted no-op, and two senders' sheets for the same
 * venue stay distinct identities. The zone rides the identity — a sale
 * re-attributed to a different zone is a different event.
 */
export function spatialRowEventId(detail: {
  sender: SpatialSenderCode;
  venueId: string;
  zoneCode: string;
  period: string;
  senderRowId: string;
}): string {
  return `spatial:${detail.sender}:${spatialFingerprint(
    detail.venueId,
    detail.zoneCode,
    detail.period,
    detail.senderRowId,
  )}`;
}

/** The reporting period's shape of record (YYYY-MM). */
export function isSpatialPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** The schedule year a period's walk reads (the YYYY prefix). */
export function spatialYearFromPeriod(period: string): string {
  return period.slice(0, 4);
}

/** Floor-divides exact micros into whole cents — the house conversion
 * (1 dollar = 1e8 statement micros, so 1e6 micros per cent). A negative
 * basis is hostile upstream; this helper never sees one. */
export function spatialMicrosToCents(micros: bigint): number {
  return Number(micros / 1_000_000n);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function spatialBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE ADJUSTED LOCATION SALES CALCULATOR (the founder directive's exact
 * identity, keyed on the row's venue_id, zone_code, and
 * spatial_footprint_sqft columns — the identity legs ride the application):
 *
 *   Net Spatial Licensed Revenue =
 *     gross venue ticket and merch revenue
 *     − local occupancy taxes
 *     − venue infrastructure COGS
 *     − approved group tour discounts
 *
 * The gross is the sum of the row's ticket and merch revenue legs; every
 * deduction leg is a recorded money amount (the settlement sheet's own
 * figures — never a rate guess). The identity (tax + cogs + discount +
 * net === gross) pins the math. A deduction set larger than the gross
 * yields a negative net — the CALLER holds that application
 * (held_negative_net); this function records the arithmetic honestly
 * either way.
 */
export function adjustedLocationSalesCents(input: {
  ticketRevenueCents: number;
  merchRevenueCents: number;
  occupancyTaxCents: number;
  venueInfrastructureCogsCents: number;
  approvedGroupTourDiscountCents: number;
}): {
  grossRevenueCents: number;
  netSpatialLicensedRevenueCents: number;
} {
  const legs = [
    input.ticketRevenueCents,
    input.merchRevenueCents,
    input.occupancyTaxCents,
    input.venueInfrastructureCogsCents,
    input.approvedGroupTourDiscountCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`spatial_calculator_invalid_leg:${leg}`);
    }
  }
  const grossRevenueCents = input.ticketRevenueCents + input.merchRevenueCents;
  const netSpatialLicensedRevenueCents =
    grossRevenueCents -
    input.occupancyTaxCents -
    input.venueInfrastructureCogsCents -
    input.approvedGroupTourDiscountCents;
  return { grossRevenueCents, netSpatialLicensedRevenueCents };
}

/**
 * THE SHARED FACILITY OVERHEAD DEDUCTION — park-wide security, wristband
 * maintenance, and the park-wide ticketing platform fee, each a bps leg of
 * the distribution's basis, floored per leg, deducted BEFORE any net IP
 * distribution prices (the ordering the application row pins:
 * legs + royalty basis === basis). No policy of record, no deduction —
 * the caller skips fail-closed; this function never guesses a rate.
 */
export function sharedOverheadCents(input: {
  basisCents: number;
  securityBps: number;
  wristbandMaintenanceBps: number;
  ticketingPlatformBps: number;
}): {
  securityCents: number;
  wristbandMaintenanceCents: number;
  ticketingPlatformCents: number;
  overheadTotalCents: number;
} {
  const securityCents = spatialBpsShareCents(input.basisCents, input.securityBps);
  const wristbandMaintenanceCents = spatialBpsShareCents(
    input.basisCents,
    input.wristbandMaintenanceBps,
  );
  const ticketingPlatformCents = spatialBpsShareCents(
    input.basisCents,
    input.ticketingPlatformBps,
  );
  const overheadTotalCents =
    securityCents + wristbandMaintenanceCents + ticketingPlatformCents;
  return { securityCents, wristbandMaintenanceCents, ticketingPlatformCents, overheadTotalCents };
}

/**
 * The band containing one basis position — the band whose (lower, upper]
 * window holds it (the first band's lower is 0; the open top band's upper
 * is infinite). Entry 500,000 prices in the first band ("the first 500000
 * annual turnstile entries" include the 500,000th); position 500,001
 * prices in the second; the founder's 8% applies strictly ABOVE 1,000,000.
 * Returns undefined when no band holds the position (an unvalidated
 * schedule — callers re-validate bands at read).
 */
export function spatialBandForPosition(
  position: number,
  bands: readonly SpatialTierBand[],
): { band: SpatialTierBand; lower: number } | undefined {
  let lower = 0;
  for (const band of bands) {
    const upper = band.up_to;
    if (upper === null || position <= upper) {
      return { band, lower };
    }
    lower = upper;
  }
  return undefined;
}

/**
 * THE SLIDING-SCALE OCCUPANCY ROYALTY WALK — the row's turnstile entries
 * cross the venue's cumulative annual position, and the royalty basis
 * splits across the bands the entries occupy, proportional to the entries
 * in each band (largest-remainder allocation, conserving the basis
 * exactly), each band's royalty floored off its allocated share:
 *
 *   band royalty = floor(band_basis × band_bps / 10000)
 *
 * A row entirely inside the first band (the founder's example: the first
 * 500,000 annual entries at 5%) prices wholly at that band's rate; a row
 * straddling the 500,000 or 1,000,000 boundary splits exactly — the
 * cumulative position tracks annual throughput across every row of the
 * year. Requires entries > 0 (zero-entry rows price at the closing
 * position through spatialPositionRoyaltyCents); the basis must be
 * non-negative.
 */
export function spatialThroughputRoyaltyWalk(input: {
  royaltyBasisCents: number;
  entries: number;
  cumulativeBefore: number;
  bands: readonly SpatialTierBand[];
}): {
  legs: SpatialTierWalkLeg[];
  royaltyCents: number;
  cumulativeAfter: number;
} {
  const { royaltyBasisCents, entries, cumulativeBefore, bands } = input;
  if (!Number.isInteger(royaltyBasisCents) || royaltyBasisCents < 0) {
    throw new Error(`spatial_walk_invalid_basis:${royaltyBasisCents}`);
  }
  if (!Number.isInteger(entries) || entries <= 0) {
    throw new Error(`spatial_walk_invalid_entries:${entries}`);
  }
  if (!Number.isInteger(cumulativeBefore) || cumulativeBefore < 0) {
    throw new Error(`spatial_walk_invalid_position:${cumulativeBefore}`);
  }
  const cumulativeAfter = cumulativeBefore + entries;

  // The entries each band holds: band window ∩ (before, after].
  type BandSlot = { band: SpatialTierBand; lower: number; entries: number };
  const slots: BandSlot[] = [];
  {
    let lower = 0;
    for (const band of bands) {
      const upper = band.up_to;
      const bandLow = Math.max(cumulativeBefore, lower);
      const bandHigh = upper === null ? cumulativeAfter : Math.min(cumulativeAfter, upper);
      slots.push({ band, lower, entries: Math.max(0, bandHigh - bandLow) });
      if (upper === null) break;
      lower = upper;
    }
  }

  // Largest-remainder money allocation: floor each band's proportional
  // share of the basis, then hand the leftover cents to the bands in
  // order of largest fractional remainder (ties break by band order).
  // BigInt numerators keep the proportions exact for any magnitude.
  const basisBig = BigInt(royaltyBasisCents);
  const totalEntries = BigInt(entries);
  const floors = slots.map((slot) => (basisBig * BigInt(slot.entries)) / totalEntries);
  const remainders = slots.map((slot, index) => ({
    index,
    remainder: (basisBig * BigInt(slot.entries)) % totalEntries,
  }));
  const leftoverCents =
    royaltyBasisCents - floors.reduce((sum, floor) => sum + Number(floor), 0);
  const remainderOrder = [...remainders].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });
  const bonusCents = new Array<number>(slots.length).fill(0);
  for (const slot of remainderOrder) {
    if (bonusCents.reduce((sum, bonus) => sum + bonus, 0) >= leftoverCents) break;
    bonusCents[slot.index] = 1;
  }

  const legs: SpatialTierWalkLeg[] = [];
  let royaltyCents = 0;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index] as BandSlot;
    const bandBasis = Number(floors[index]) + (bonusCents[index] ?? 0);
    const bandRoyalty = spatialBpsShareCents(bandBasis, slot.band.royalty_bps);
    if (slot.entries > 0) {
      legs.push({
        band_from: slot.lower,
        band_to: slot.band.up_to,
        band_rate_bps: slot.band.royalty_bps,
        band_basis_cents: bandBasis,
        band_entries: slot.entries,
        band_royalty_cents: bandRoyalty,
      });
    }
    royaltyCents += bandRoyalty;
  }

  return { legs, royaltyCents, cumulativeAfter };
}

/**
 * THE CLOSING-POSITION ROYALTY — a row carrying no turnstile entries of
 * its own (attraction pass sales) prices at the rate of the band holding
 * the venue's CURRENT cumulative annual position; a footprint-basis
 * schedule prices at the band holding the venue's footprint allocation.
 * One band, one floored royalty leg. No position advancement (nothing
 * crossed a threshold — the throughput tracker only moves on entries).
 */
export function spatialPositionRoyaltyCents(input: {
  royaltyBasisCents: number;
  position: number;
  bands: readonly SpatialTierBand[];
}): {
  legs: SpatialTierWalkLeg[];
  royaltyCents: number;
} {
  const { royaltyBasisCents, position, bands } = input;
  if (!Number.isInteger(royaltyBasisCents) || royaltyBasisCents < 0) {
    throw new Error(`spatial_position_invalid_basis:${royaltyBasisCents}`);
  }
  if (!Number.isInteger(position) || position < 0) {
    throw new Error(`spatial_position_invalid_position:${position}`);
  }
  const found = spatialBandForPosition(position, bands);
  if (found === undefined) {
    throw new Error(`spatial_position_no_band:${position}`);
  }
  const royaltyCents = spatialBpsShareCents(royaltyBasisCents, found.band.royalty_bps);
  return {
    legs: [
      {
        band_from: found.lower,
        band_to: found.band.up_to,
        band_rate_bps: found.band.royalty_bps,
        band_basis_cents: royaltyBasisCents,
        band_entries: 0,
        band_royalty_cents: royaltyCents,
      },
    ],
    royaltyCents,
  };
}

/**
 * THE DYNAMIC SPATIAL MICRO-ROYALTY — the real-time IP payout a wristband
 * telemetry row carries: dwell time through the venue sensors times the
 * zone's per-minute unit rate, plus ride session counts times the zone's
 * per-session unit rate. Both rates are statement micros per unit (1
 * dollar = 1e8 micros), so the multiplication is bigint-exact; the
 * payable cents floor at the conversion (never round up).
 */
export function spatialMicroRoyaltyCents(input: {
  dwellMinutes: number;
  rideSessions: number;
  microsPerDwellMinute: number;
  microsPerRideSession: number;
}): {
  dwellRoyaltyMicros: bigint;
  sessionRoyaltyMicros: bigint;
  totalRoyaltyMicros: bigint;
  royaltyCents: number;
} {
  const { dwellMinutes, rideSessions, microsPerDwellMinute, microsPerRideSession } = input;
  if (!Number.isInteger(dwellMinutes) || dwellMinutes < 0) {
    throw new Error(`spatial_micro_invalid_dwell:${dwellMinutes}`);
  }
  if (!Number.isInteger(rideSessions) || rideSessions < 0) {
    throw new Error(`spatial_micro_invalid_sessions:${rideSessions}`);
  }
  if (
    !Number.isInteger(microsPerDwellMinute) ||
    microsPerDwellMinute < 0 ||
    !Number.isInteger(microsPerRideSession) ||
    microsPerRideSession < 0
  ) {
    throw new Error(
      `spatial_micro_invalid_rates:${microsPerDwellMinute}:${microsPerRideSession}`,
    );
  }
  const dwellRoyaltyMicros = BigInt(dwellMinutes) * BigInt(microsPerDwellMinute);
  const sessionRoyaltyMicros = BigInt(rideSessions) * BigInt(microsPerRideSession);
  const totalRoyaltyMicros = dwellRoyaltyMicros + sessionRoyaltyMicros;
  return {
    dwellRoyaltyMicros,
    sessionRoyaltyMicros,
    totalRoyaltyMicros,
    royaltyCents: spatialMicrosToCents(totalRoyaltyMicros),
  };
}

/**
 * THE ZONE-BASED REVENUE ALLOCATION — the zone's sale routes to the
 * assigned IP owner's royalty waterfall: the shared facility overhead legs
 * come off the gross FIRST (the ordering discipline — never a royalty on
 * money the park's overhead already consumed), then the owner's bps
 * prices the allocated remainder. Identity pinned: overhead legs +
 * allocated basis === gross.
 */
export function spatialZoneAllocationCents(input: {
  grossCents: number;
  securityBps: number;
  wristbandMaintenanceBps: number;
  ticketingPlatformBps: number;
  zoneRoyaltyBps: number;
}): {
  overhead: ReturnType<typeof sharedOverheadCents>;
  allocatedBasisCents: number;
  royaltyCents: number;
} {
  if (!Number.isInteger(input.grossCents) || input.grossCents < 0) {
    throw new Error(`spatial_zone_invalid_gross:${input.grossCents}`);
  }
  const overhead = sharedOverheadCents({
    basisCents: input.grossCents,
    securityBps: input.securityBps,
    wristbandMaintenanceBps: input.wristbandMaintenanceBps,
    ticketingPlatformBps: input.ticketingPlatformBps,
  });
  const allocatedBasisCents = input.grossCents - overhead.overheadTotalCents;
  const royaltyCents = spatialBpsShareCents(allocatedBasisCents, input.zoneRoyaltyBps);
  return { overhead, allocatedBasisCents, royaltyCents };
}
