/**
 * CVT recon worker — the spatial lane's store-touching pass (PR 36, the
 * founder spatial directive). The math and identity spaces live in
 * spatial.ts, the profiles in spatialProfiles.ts; THIS module is the only
 * place the lane touches the store — the same discipline as nilQueue.ts.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative net is a HELD verdict (visible, never dropped,
 *   never posted), and a venue-year without a schedule of record or an
 *   overhead policy of record, a zone without an assignment of record,
 *   and a zone without micro rates of record are counted skips — the
 *   walk never guesses a rate or invents a schedule.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (spatialRowEventId): a re-shipped sheet replays as a
 *   counted no-op; two senders' sheets for the same venue stay distinct
 *   identities, and a sale re-attributed to a different zone is a
 *   different event.
 * - OVERHEAD BEFORE ROYALTY — the shared facility overhead legs come off
 *   every distribution's basis before any royalty prices; the application
 *   rows pin the ordering identity (basis = net − overhead, or for zone
 *   allocations allocated_basis = gross − overhead) at the database.
 *
 * The five senders' walks:
 *
 *   1. VENUE TURNSTILE TICKET SCANS (sender 'turnstile') — the Adjusted
 *      Location Sales calculator on the settlement's legs, the approved-
 *      tour-discount gate, the shared overhead deduction, then the
 *      occupancy royalty tier walk on the venue's cumulative annual
 *      position — entries-bearing rows advance the throughput tracker.
 *   2. ATTRACTION PASS SALES (sender 'pass') — the same calculator legs
 *      on pass revenue (recorded as the ticket leg; a pass sale is not a
 *      gate crossing and advances no position) priced at the band holding
 *      the venue's CURRENT cumulative position.
 *   3. FOOD AND BEVERAGE REGISTERS (sender 'fnb') and 4. LOCATION-TAGGED
 *      RETAIL POS LOGS (sender 'retail') — the zone allocation: shared
 *      overhead off the gross FIRST, then the assigned IP owner's bps
 *      price the allocated remainder.
 *   5. RFID WRISTBAND TELEMETRY (sender 'rfid') — the dynamic micro-
 *      royalty: dwell minutes and ride session counts priced at the
 *      zone's unit rates of record, bigint-exact.
 *
 * Spatial rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import {
  validateSpatialTierSchedule,
  type SpatialTierBand,
} from "@/modules/spatial/records";
import type { ParsedStatementLine, SpatialLineDetail } from "./records";
import {
  adjustedLocationSalesCents,
  sharedOverheadCents,
  spatialMicroRoyaltyCents,
  spatialPositionRoyaltyCents,
  spatialRowEventId,
  spatialThroughputRoyaltyWalk,
  spatialYearFromPeriod,
  spatialZoneAllocationCents,
} from "./spatial";

/** The spatial lane's per-pass counters — the honest outcome summary. */
export interface SpatialWriteCounts {
  /** Occupancy royalty applications committed / counted replay no-ops. */
  occupancyApplicationsWritten: number;
  occupancyApplicationsReplayed: number;
  /** Fail-closed skips — no schedule / unverified schedule / no overhead
   * policy of record for the venue-year. */
  occupancySkippedNoSchedule: number;
  occupancySkippedUnverifiedSchedule: number;
  occupancySkippedNoOverhead: number;
  /** The negative-net holds (the money pauses, visible). */
  occupancyHeldNegativeNet: number;
  /** Zone allocations committed / counted replay no-ops / fail-closed
   * skips (no assignment of record, no overhead policy of record). */
  zoneAllocationsWritten: number;
  zoneAllocationsReplayed: number;
  zoneSkippedNoAssignment: number;
  zoneSkippedNoOverhead: number;
  /** Micro-royalties committed / counted replay no-ops / fail-closed
   * skips (no zone rates of record). */
  microRoyaltiesWritten: number;
  microRoyaltiesReplayed: number;
  microSkippedNoPolicy: number;
  /** The committed money, integer cents. */
  netSpatialLicensedRevenueCents: number;
  overheadTotalCents: number;
  occupancyRoyaltyCents: number;
  zoneRoyaltyCents: number;
  microRoyaltyCents: number;
}

/**
 * The spatial lane's one pass over a parsed statement's lines — the three
 * application ledgers (occupancy royalties, zone allocations, micro-
 * royalties) land in the store's spatial tables. Throws into the job's
 * fail-closed error path on any store failure.
 */
export async function writeSpatialRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<SpatialWriteCounts> {
  const counts: SpatialWriteCounts = {
    occupancyApplicationsWritten: 0,
    occupancyApplicationsReplayed: 0,
    occupancySkippedNoSchedule: 0,
    occupancySkippedUnverifiedSchedule: 0,
    occupancySkippedNoOverhead: 0,
    occupancyHeldNegativeNet: 0,
    zoneAllocationsWritten: 0,
    zoneAllocationsReplayed: 0,
    zoneSkippedNoAssignment: 0,
    zoneSkippedNoOverhead: 0,
    microRoyaltiesWritten: 0,
    microRoyaltiesReplayed: 0,
    microSkippedNoPolicy: 0,
    netSpatialLicensedRevenueCents: 0,
    overheadTotalCents: 0,
    occupancyRoyaltyCents: 0,
    zoneRoyaltyCents: 0,
    microRoyaltyCents: 0,
  };

  for (const line of lines) {
    const detail = line.spatialDetail;
    // The spatial profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`spatial_detail_missing: line ${line.lineNumber} has no spatial detail`);
    }

    switch (detail.sender) {
      case "fnb":
      case "retail":
        await walkZoneAllocation(store, detail, counts);
        continue;
      case "rfid":
        await walkMicroRoyalty(store, detail, counts);
        continue;
      default:
        await walkOccupancyRoyalty(store, detail, counts);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Senders 1 + 2 — the occupancy royalty walk (turnstile settlements and
// attraction pass sales): the Adjusted Location Sales calculator, the
// approved-tour-discount gate, the shared overhead deduction, the tier
// walk on the venue's cumulative annual position.
// ---------------------------------------------------------------------------

async function walkOccupancyRoyalty(
  store: Store,
  detail: Extract<SpatialLineDetail, { sender: "turnstile" | "pass" }>,
  counts: SpatialWriteCounts,
): Promise<void> {
  const sourceEventId = spatialRowEventId({
    sender: detail.sender,
    venueId: detail.venueId,
    zoneCode: detail.zoneCode,
    period: detail.period,
    senderRowId: detail.senderRowId,
  });

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getSpatialRoyaltyApplication(sourceEventId);
  if (existing !== undefined) {
    counts.occupancyApplicationsReplayed += 1;
    return;
  }

  const year = spatialYearFromPeriod(detail.period);

  // The venue-year's policies of record — no schedule, no royalty; no
  // overhead policy, no deduction and no royalty (the walk never guesses
  // a rate).
  const schedule = await store.getSpatialOccupancyTierSchedule(detail.venueId, year);
  if (schedule === undefined) {
    counts.occupancySkippedNoSchedule += 1;
    return;
  }
  const overheadPolicy = await store.getSpatialOverheadPolicy(detail.venueId, year);
  if (overheadPolicy === undefined) {
    counts.occupancySkippedNoOverhead += 1;
    return;
  }

  // THE ADJUSTED LOCATION SALES CALCULATOR — the settlement sheet's own
  // figures (never a rate guess). A pass sale records its revenue as the
  // ticket leg (the calculator's gross is ticket + merch; a pass row has
  // no merch leg). Only an APPROVED group tour discount deducts — a
  // pending discount's amount stays on the sheet, deducted never.
  const ticketRevenueCents = detail.sender === "pass" ? detail.passRevenueCents : detail.ticketRevenueCents;
  const merchRevenueCents = detail.sender === "pass" ? 0 : detail.merchRevenueCents;
  const approvedDiscountCents = detail.tourDiscountApproved ? detail.groupTourDiscountCents : 0;
  const adjusted = adjustedLocationSalesCents({
    ticketRevenueCents,
    merchRevenueCents,
    occupancyTaxCents: detail.occupancyTaxCents,
    venueInfrastructureCogsCents: detail.infrastructureCogsCents,
    approvedGroupTourDiscountCents: approvedDiscountCents,
  });

  // THE SHARED FACILITY OVERHEAD DEDUCTION — off the net, before any
  // royalty prices (the ordering the application row pins).
  const overhead = sharedOverheadCents({
    basisCents: adjusted.netSpatialLicensedRevenueCents,
    securityBps: overheadPolicy.security_bps,
    wristbandMaintenanceBps: overheadPolicy.wristband_maintenance_bps,
    ticketingPlatformBps: overheadPolicy.ticketing_platform_bps,
  });

  // A NEGATIVE NET — the deduction legs exceeded the gross. The math is
  // recorded visible (the held row's truth), the money legs zeroed, no
  // royalty posted: the hold IS the record; the next walk re-prices
  // after an operator heals the sheet.
  if (adjusted.netSpatialLicensedRevenueCents < 0) {
    await store.insertSpatialRoyaltyApplication({
      source_event_id: sourceEventId,
      sender: detail.sender,
      venue_id: detail.venueId,
      zone_code: detail.zoneCode,
      spatial_footprint_sqft: detail.spatialFootprintSqft,
      period: detail.period,
      ticket_revenue_cents: ticketRevenueCents,
      merch_revenue_cents: merchRevenueCents,
      gross_revenue_cents: adjusted.grossRevenueCents,
      occupancy_tax_cents: detail.occupancyTaxCents,
      infrastructure_cogs_cents: detail.infrastructureCogsCents,
      group_tour_discount_cents: approvedDiscountCents,
      net_spatial_licensed_revenue_cents: adjusted.netSpatialLicensedRevenueCents,
      overhead_security_cents: 0,
      overhead_wristband_cents: 0,
      overhead_ticketing_cents: 0,
      overhead_total_cents: 0,
      royalty_basis_cents: 0,
      tier_basis: schedule.basis,
      tier_schedule_ref: null,
      tier_legs: "[]",
      entries_count: detail.sender === "pass" ? 0 : detail.turnstileEntries,
      entries_before: null,
      entries_after: null,
      occupancy_royalty_cents: 0,
      verdict: "held_negative_net",
    });
    counts.occupancyApplicationsWritten += 1;
    counts.occupancyHeldNegativeNet += 1;
    counts.netSpatialLicensedRevenueCents += adjusted.netSpatialLicensedRevenueCents;
    return;
  }

  // The tier bands of record — re-validated at read (a hostile stored
  // schedule skips fail-closed; the walk never guesses a rate).
  const bands = JSON.parse(schedule.bands) as SpatialTierBand[];
  const validated = validateSpatialTierSchedule(bands);
  if (!validated.ok) {
    counts.occupancySkippedUnverifiedSchedule += 1;
    return;
  }

  const royaltyBasisCents = adjusted.netSpatialLicensedRevenueCents - overhead.overheadTotalCents;
  let tierLegs = "[]";
  let royaltyCents = 0;
  let entriesBefore: number | null = null;
  let entriesAfter: number | null = null;

  if (schedule.basis === "annual_throughput") {
    if (detail.sender === "turnstile" && detail.turnstileEntries > 0) {
      // The entries-bearing walk: the row's entries cross the venue's
      // cumulative annual position, and the royalty basis splits across
      // the bands the entries occupy.
      const throughput = await store.getSpatialThroughputYear(detail.venueId, year);
      const cumulativeBefore = throughput?.cumulative_entries ?? 0;
      const walk = spatialThroughputRoyaltyWalk({
        royaltyBasisCents,
        entries: detail.turnstileEntries,
        cumulativeBefore,
        bands,
      });
      const advanced = await store.advanceSpatialThroughputYear(
        detail.venueId,
        year,
        detail.turnstileEntries,
      );
      // The tracker's advance must agree with the walk's arithmetic — a
      // torn walk would poison every later row's position.
      if (advanced.cumulative_entries !== walk.cumulativeAfter) {
        throw new Error(
          `spatial_throughput_tracker_mismatch: walk ${walk.cumulativeAfter}` +
            ` store ${advanced.cumulative_entries}`,
        );
      }
      tierLegs = JSON.stringify(walk.legs);
      royaltyCents = walk.royaltyCents;
      entriesBefore = cumulativeBefore;
      entriesAfter = advanced.cumulative_entries;
    } else {
      // A pass sale (or a zero-entry settlement) prices at the band
      // holding the venue's CURRENT cumulative position — nothing
      // crossed a threshold, so nothing advances.
      const throughput = await store.getSpatialThroughputYear(detail.venueId, year);
      const positionRoyalty = spatialPositionRoyaltyCents({
        royaltyBasisCents,
        position: throughput?.cumulative_entries ?? 0,
        bands,
      });
      tierLegs = JSON.stringify(positionRoyalty.legs);
      royaltyCents = positionRoyalty.royaltyCents;
    }
  } else {
    // The footprint basis — the band holding the venue's footprint
    // allocation prices the row; no position advancement.
    const footprintRoyalty = spatialPositionRoyaltyCents({
      royaltyBasisCents,
      position: detail.spatialFootprintSqft,
      bands,
    });
    tierLegs = JSON.stringify(footprintRoyalty.legs);
    royaltyCents = footprintRoyalty.royaltyCents;
  }

  await store.insertSpatialRoyaltyApplication({
    source_event_id: sourceEventId,
    sender: detail.sender,
    venue_id: detail.venueId,
    zone_code: detail.zoneCode,
    spatial_footprint_sqft: detail.spatialFootprintSqft,
    period: detail.period,
    ticket_revenue_cents: ticketRevenueCents,
    merch_revenue_cents: merchRevenueCents,
    gross_revenue_cents: adjusted.grossRevenueCents,
    occupancy_tax_cents: detail.occupancyTaxCents,
    infrastructure_cogs_cents: detail.infrastructureCogsCents,
    group_tour_discount_cents: approvedDiscountCents,
    net_spatial_licensed_revenue_cents: adjusted.netSpatialLicensedRevenueCents,
    overhead_security_cents: overhead.securityCents,
    overhead_wristband_cents: overhead.wristbandMaintenanceCents,
    overhead_ticketing_cents: overhead.ticketingPlatformCents,
    overhead_total_cents: overhead.overheadTotalCents,
    royalty_basis_cents: royaltyBasisCents,
    tier_basis: schedule.basis,
    tier_schedule_ref: schedule.id,
    tier_legs: tierLegs,
    entries_count: detail.sender === "pass" ? 0 : detail.turnstileEntries,
    entries_before: entriesBefore,
    entries_after: entriesAfter,
    occupancy_royalty_cents: royaltyCents,
    verdict: "paid",
  });
  counts.occupancyApplicationsWritten += 1;
  counts.netSpatialLicensedRevenueCents += adjusted.netSpatialLicensedRevenueCents;
  counts.overheadTotalCents += overhead.overheadTotalCents;
  counts.occupancyRoyaltyCents += royaltyCents;
}

// ---------------------------------------------------------------------------
// Senders 3 + 4 — the zone allocation walk (F&B registers and location-
// tagged retail POS logs): shared overhead off the gross first, then the
// assigned IP owner's royalty waterfall prices the allocated remainder.
// ---------------------------------------------------------------------------

async function walkZoneAllocation(
  store: Store,
  detail: Extract<SpatialLineDetail, { sender: "fnb" | "retail" }>,
  counts: SpatialWriteCounts,
): Promise<void> {
  const sourceEventId = spatialRowEventId({
    sender: detail.sender,
    venueId: detail.venueId,
    zoneCode: detail.zoneCode,
    period: detail.period,
    senderRowId: detail.senderRowId,
  });

  const existing = await store.getSpatialZoneAllocation(sourceEventId);
  if (existing !== undefined) {
    counts.zoneAllocationsReplayed += 1;
    return;
  }

  // The zone's assignment of record — no assignment, no routing (the
  // walk never guesses the IP owner).
  const assignment = await store.getSpatialZoneAssignment(detail.venueId, detail.zoneCode);
  if (assignment === undefined) {
    counts.zoneSkippedNoAssignment += 1;
    return;
  }
  const year = spatialYearFromPeriod(detail.period);
  const overheadPolicy = await store.getSpatialOverheadPolicy(detail.venueId, year);
  if (overheadPolicy === undefined) {
    counts.zoneSkippedNoOverhead += 1;
    return;
  }

  const allocation = spatialZoneAllocationCents({
    grossCents: detail.grossCents,
    securityBps: overheadPolicy.security_bps,
    wristbandMaintenanceBps: overheadPolicy.wristband_maintenance_bps,
    ticketingPlatformBps: overheadPolicy.ticketing_platform_bps,
    zoneRoyaltyBps: assignment.royalty_bps,
  });

  await store.insertSpatialZoneAllocation({
    source_event_id: sourceEventId,
    row_class: detail.rowClass,
    venue_id: detail.venueId,
    zone_code: detail.zoneCode,
    period: detail.period,
    gross_cents: detail.grossCents,
    overhead_security_cents: allocation.overhead.securityCents,
    overhead_wristband_cents: allocation.overhead.wristbandMaintenanceCents,
    overhead_ticketing_cents: allocation.overhead.ticketingPlatformCents,
    overhead_total_cents: allocation.overhead.overheadTotalCents,
    allocated_basis_cents: allocation.allocatedBasisCents,
    assigned_ip_owner_id: assignment.assigned_ip_owner_id,
    royalty_bps: assignment.royalty_bps,
    royalty_cents: allocation.royaltyCents,
  });
  counts.zoneAllocationsWritten += 1;
  counts.overheadTotalCents += allocation.overhead.overheadTotalCents;
  counts.zoneRoyaltyCents += allocation.royaltyCents;
}

// ---------------------------------------------------------------------------
// Sender 5 — the micro-royalty walk (RFID wristband telemetry): the
// dwell/session legs priced at the zone's unit rates of record, bigint-
// exact, one ledger row per telemetry event.
// ---------------------------------------------------------------------------

async function walkMicroRoyalty(
  store: Store,
  detail: Extract<SpatialLineDetail, { sender: "rfid" }>,
  counts: SpatialWriteCounts,
): Promise<void> {
  const sourceEventId = spatialRowEventId({
    sender: detail.sender,
    venueId: detail.venueId,
    zoneCode: detail.zoneCode,
    period: detail.period,
    senderRowId: detail.senderRowId,
  });

  const existing = await store.getSpatialMicroRoyalty(sourceEventId);
  if (existing !== undefined) {
    counts.microRoyaltiesReplayed += 1;
    return;
  }

  // The zone's micro rates of record — no rates, no payout (the walk
  // never guesses a unit price).
  const policy = await store.getSpatialMicroPolicy(detail.venueId, detail.zoneCode);
  if (policy === undefined) {
    counts.microSkippedNoPolicy += 1;
    return;
  }

  const royalty = spatialMicroRoyaltyCents({
    dwellMinutes: detail.dwellMinutes,
    rideSessions: detail.rideSessions,
    microsPerDwellMinute: policy.micros_per_dwell_minute,
    microsPerRideSession: policy.micros_per_ride_session,
  });

  await store.insertSpatialMicroRoyalty({
    source_event_id: sourceEventId,
    venue_id: detail.venueId,
    zone_code: detail.zoneCode,
    wristband_id: detail.wristbandId,
    sensor_id: detail.sensorId,
    period: detail.period,
    dwell_minutes: detail.dwellMinutes,
    ride_sessions: detail.rideSessions,
    micros_per_dwell_minute: policy.micros_per_dwell_minute,
    micros_per_ride_session: policy.micros_per_ride_session,
    dwell_royalty_micros: Number(royalty.dwellRoyaltyMicros),
    session_royalty_micros: Number(royalty.sessionRoyaltyMicros),
    total_royalty_micros: Number(royalty.totalRoyaltyMicros),
    royalty_cents: royalty.royaltyCents,
  });
  counts.microRoyaltiesWritten += 1;
  counts.microRoyaltyCents += royalty.royaltyCents;
}
