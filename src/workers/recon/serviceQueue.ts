/**
 * CVT recon worker — the service lane's store-touching pass (PR 42, the
 * founder service directive). The math and identity spaces live in
 * service.ts, the profiles in serviceProfiles.ts; THIS module is the only
 * place the lane touches the store — the same discipline as foodQueue.ts,
 * fitnessQueue.ts, spatialQueue.ts, and nilQueue.ts.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative realization net is a HELD verdict (visible, never
 *   dropped, never posted), and a location without a franchise schedule
 *   of record, a protocol without a micro-royalty policy of record, a
 *   home location without a redemption or breakage policy of record, a
 *   location with no registered rebate waterfall, and a hybrid salon
 *   without a booth-lease policy of record are counted skips — the walk
 *   never guesses a rate or a weighting.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (serviceRowEventId, the ledger namespace riding the
 *   prefix): a re-shipped sheet replays as a counted no-op.
 * - THE GROSS PRICES THE CONTRACT SPLITS — the franchise split prices the
 *   row's gross service ticket (the founder's percentages are ON gross
 *   sales), independent of the realization verdict; the realization and
 *   the splits are separate ledgers of record.
 * - THE FEE CONSERVES — the redemption, breakage, and rebate walks route
 *   exact or largest-remainder shares whose sums pin to the basis at the
 *   database; the booth-lease walk isolates the flat chair rent from the
 *   retail commission before releasing net funds to the studio owner.
 *
 * The six senders' walks:
 *
 *   1. POS TICKET STREAMS (sender 'pos_ticket') — the Net Service
 *      Realization (gross service ticket − backbar product COGS − credit
 *      card processing engine cut − local service and sales taxes = the
 *      Net Realized Service Pool), then the franchise contract's three-way
 *      gross partition (master franchisor royalty, technician service
 *      commission, house location margin), then the per-treatment
 *      protocol micro-royalty to the protocol creator.
 *   2. HOTEL GUEST ROOM FOLIO CHARGES (sender 'hotel_folio') — the same
 *      three walks on the folio charge's own legs.
 *   3. MEMBERSHIP REDEMPTION LOGS (sender 'membership_redemption') — the
 *      cross-location split: the service allocation fee routes directly
 *      to the visiting location while the franchisor royalty and
 *      home-location administrative cut distribute.
 *   4. MEMBERSHIP BREAKAGE LOGS (sender 'membership_breakage') — the
 *      unredeemed funds allocate per the contractual franchisor and
 *      franchisee breakage rules.
 *   5. VENDOR REBATE STATEMENTS (sender 'vendor_rebate') — the volume
 *      kickback routes proportionally back to the location ledgers per
 *      the waterfall of record.
 *   6. BOOTH-LEASE LEDGERS (sender 'booth_lease') — the isolated legs:
 *      the weekly flat chair rent routes exact to the studio owner; the
 *      retail product sale routes its floored commission.
 *
 * Service rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import {
  validateServiceRebateWaterfall,
  type ServiceRebateWaterfallLeg,
} from "@/modules/service/records";
import type { ParsedStatementLine, ServiceLineDetail } from "./records";
import {
  boothLeaseSplitCents,
  breakageSplitCents,
  franchiseSplitCents,
  netServiceRealizationCents,
  rebateProportionalRoutingCents,
  redemptionSplitCents,
  serviceMicrosToCents,
  serviceRowEventId,
} from "./service";

/** The service lane's per-pass counters — the honest outcome summary. */
export interface ServiceWriteCounts {
  /** Realization applications committed / counted replay no-ops / the
   * negative-net holds (the money pauses, visible). */
  realizationWritten: number;
  realizationReplayed: number;
  realizationHeldNegativeNet: number;
  /** Franchise splits committed / counted replay no-ops / fail-closed
   * skips (no schedule of record for the location). */
  franchiseSplitsWritten: number;
  franchiseSplitsReplayed: number;
  franchiseSkippedNoSchedule: number;
  /** Protocol micro-royalties committed / counted replay no-ops /
   * fail-closed skips (no protocol policy of record). */
  protocolRoyaltiesWritten: number;
  protocolRoyaltiesReplayed: number;
  protocolSkippedNoPolicy: number;
  /** Redemption splits committed / counted replay no-ops / fail-closed
   * skips (no redemption policy of record for the home location). */
  redemptionSplitsWritten: number;
  redemptionSplitsReplayed: number;
  redemptionSkippedNoPolicy: number;
  /** Breakage allocations committed / counted replay no-ops / fail-closed
   * skips (no breakage policy of record for the home location). */
  breakageAllocationsWritten: number;
  breakageAllocationsReplayed: number;
  breakageSkippedNoPolicy: number;
  /** Rebate routings committed / counted replay no-ops / fail-closed
   * skips (no registered waterfall of record for the location). */
  rebateRoutingsWritten: number;
  rebateRoutingsReplayed: number;
  rebateSkippedNoWaterfall: number;
  /** Booth-lease splits committed / counted replay no-ops / fail-closed
   * skips (no booth-lease policy of record for the location). */
  boothLeaseSplitsWritten: number;
  boothLeaseSplitsReplayed: number;
  boothSkippedNoPolicy: number;
  /** The committed money, integer cents. */
  netRealizedServicePoolCents: number;
  franchisorRoyaltyCents: number;
  technicianCommissionCents: number;
  houseMarginCents: number;
  protocolRoyaltyCents: number;
  redemptionFranchisorRoyaltyCents: number;
  homeAdminCents: number;
  visitingLocationCents: number;
  breakageFranchisorCents: number;
  breakageFranchiseeCents: number;
  rebateRoutedCents: number;
  chairRentCents: number;
  retailCommissionCents: number;
}

/**
 * The service lane's one pass over a parsed statement's lines — the seven
 * application ledgers (realization, franchise splits, protocol
 * micro-royalties, redemption splits, breakage allocations, rebate
 * routings, and booth-lease splits) land in the store's service tables.
 * Throws into the job's fail-closed error path on any store failure.
 */
export async function writeServiceRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<ServiceWriteCounts> {
  const counts: ServiceWriteCounts = {
    realizationWritten: 0,
    realizationReplayed: 0,
    realizationHeldNegativeNet: 0,
    franchiseSplitsWritten: 0,
    franchiseSplitsReplayed: 0,
    franchiseSkippedNoSchedule: 0,
    protocolRoyaltiesWritten: 0,
    protocolRoyaltiesReplayed: 0,
    protocolSkippedNoPolicy: 0,
    redemptionSplitsWritten: 0,
    redemptionSplitsReplayed: 0,
    redemptionSkippedNoPolicy: 0,
    breakageAllocationsWritten: 0,
    breakageAllocationsReplayed: 0,
    breakageSkippedNoPolicy: 0,
    rebateRoutingsWritten: 0,
    rebateRoutingsReplayed: 0,
    rebateSkippedNoWaterfall: 0,
    boothLeaseSplitsWritten: 0,
    boothLeaseSplitsReplayed: 0,
    boothSkippedNoPolicy: 0,
    netRealizedServicePoolCents: 0,
    franchisorRoyaltyCents: 0,
    technicianCommissionCents: 0,
    houseMarginCents: 0,
    protocolRoyaltyCents: 0,
    redemptionFranchisorRoyaltyCents: 0,
    homeAdminCents: 0,
    visitingLocationCents: 0,
    breakageFranchisorCents: 0,
    breakageFranchiseeCents: 0,
    rebateRoutedCents: 0,
    chairRentCents: 0,
    retailCommissionCents: 0,
  };

  for (const line of lines) {
    const detail = line.serviceDetail;
    // The service profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`service_detail_missing: line ${line.lineNumber} has no service detail`);
    }

    switch (detail.sender) {
      case "pos_ticket":
      case "hotel_folio": {
        const legs = serviceRealizationLegs(detail);
        await walkServiceRealization(store, detail, legs.gross, counts, legs);
        await walkFranchiseSplit(store, detail, legs.gross, counts);
        await walkProtocolMicroRoyalty(store, detail, counts);
        continue;
      }
      case "membership_redemption":
        await walkRedemptionSplit(store, detail, counts);
        continue;
      case "membership_breakage":
        await walkBreakageAllocation(store, detail, counts);
        continue;
      case "vendor_rebate":
        await walkRebateRouting(store, detail, counts);
        continue;
      case "booth_lease":
        await walkBoothLeaseSplit(store, detail, counts);
        continue;
    }
  }

  return counts;
}

/** The realization's four legs of record — the POS ticket and hotel folio
 * senders carry the same shape under different column names. */
function serviceRealizationLegs(
  detail: Extract<ServiceLineDetail, { sender: "pos_ticket" | "hotel_folio" }>,
): {
  gross: number;
  backbar: number;
  cardCut: number;
  taxes: number;
} {
  if (detail.sender === "pos_ticket") {
    return {
      gross: detail.grossServiceTicketCents,
      backbar: detail.backbarProductCogsCents,
      cardCut: detail.cardProcessingEngineCutCents,
      taxes: detail.serviceSalesTaxesCents,
    };
  }
  return {
    gross: detail.grossServiceChargeCents,
    backbar: detail.backbarProductCogsCents,
    cardCut: detail.cardProcessingEngineCutCents,
    taxes: detail.serviceSalesTaxesCents,
  };
}

// ---------------------------------------------------------------------------
// Senders 1 and 2 — the Net Service Realization: the founder's exact
// identity on the ticket stream's or folio's own figures.
// ---------------------------------------------------------------------------

async function walkServiceRealization(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "pos_ticket" | "hotel_folio" }>,
  gross: number,
  counts: ServiceWriteCounts,
  legs: { backbar: number; cardCut: number; taxes: number },
): Promise<void> {
  const sourceEventId = serviceRowEventId("realization", detail);

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getServiceRealizationApplication(sourceEventId);
  if (existing !== undefined) {
    counts.realizationReplayed += 1;
    return;
  }

  // THE NET SERVICE REALIZATION — the sender's own figures (never a rate
  // guess); the identity (COGS + cut + taxes + net === gross) pins the
  // math at the database.
  const realization = netServiceRealizationCents({
    grossServiceTicketCents: gross,
    backbarProductCogsCents: legs.backbar,
    cardProcessingEngineCutCents: legs.cardCut,
    serviceSalesTaxesCents: legs.taxes,
  });

  // A NEGATIVE NET — the deduction legs exceeded the gross ticket.
  // Recorded visible (the held row's truth); the money pauses, never
  // drops, never guesses into a route.
  const held = realization.netRealizedServicePoolCents < 0;

  await store.insertServiceRealizationApplication({
    source_event_id: sourceEventId,
    sender: detail.sender,
    stylist_id: detail.stylistId,
    protocol_id: detail.protocolId,
    salon_location_id: detail.salonLocationId,
    period: detail.period,
    currency: detail.currency,
    gross_service_ticket_cents: realization.grossServiceTicketCents,
    backbar_product_cogs_cents: legs.backbar,
    card_processing_engine_cut_cents: legs.cardCut,
    service_sales_taxes_cents: legs.taxes,
    net_realized_service_pool_cents: realization.netRealizedServicePoolCents,
    verdict: held ? "held_negative_net" : "paid",
  });
  counts.realizationWritten += 1;
  // The pool of record includes the held row's negative net — the pass
  // summary shows the truth (the spatial lane's precedent).
  counts.netRealizedServicePoolCents += realization.netRealizedServicePoolCents;
  if (held) {
    counts.realizationHeldNegativeNet += 1;
  }
}

// ---------------------------------------------------------------------------
// Senders 1 and 2 — the franchise split: the gross's three contractual
// routes at the schedule of record (the founder's 5% / 45% / 50%
// example), configurable per franchise contract.
// ---------------------------------------------------------------------------

async function walkFranchiseSplit(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "pos_ticket" | "hotel_folio" }>,
  gross: number,
  counts: ServiceWriteCounts,
): Promise<void> {
  const sourceEventId = serviceRowEventId("franchise", detail);

  const existing = await store.getServiceFranchiseSplitApplication(sourceEventId);
  if (existing !== undefined) {
    counts.franchiseSplitsReplayed += 1;
    return;
  }

  // The franchise schedule of record — no schedule, no split (the walk
  // never guesses a rate).
  const schedule = await store.getServiceFranchiseSchedule(detail.salonLocationId);
  if (schedule === undefined) {
    counts.franchiseSkippedNoSchedule += 1;
    return;
  }

  // THE FRANCHISE SPLIT — the three legs conserve the gross exactly (the
  // house location margin routes the residual; the founder's percentages
  // are ON gross sales, priced independent of the realization verdict).
  const split = franchiseSplitCents({
    grossServiceTicketCents: gross,
    masterFranchisorRoyaltyBps: schedule.master_franchisor_royalty_bps,
    technicianCommissionBps: schedule.technician_commission_bps,
    houseMarginBps: schedule.house_margin_bps,
  });

  await store.insertServiceFranchiseSplitApplication({
    source_event_id: sourceEventId,
    sender: detail.sender,
    stylist_id: detail.stylistId,
    protocol_id: detail.protocolId,
    salon_location_id: detail.salonLocationId,
    period: detail.period,
    currency: detail.currency,
    gross_service_ticket_cents: gross,
    schedule_ref: schedule.id,
    master_franchisor_royalty_bps: schedule.master_franchisor_royalty_bps,
    master_franchisor_royalty_cents: split.masterFranchisorRoyaltyCents,
    technician_commission_bps: schedule.technician_commission_bps,
    technician_commission_cents: split.technicianCommissionCents,
    house_margin_bps: schedule.house_margin_bps,
    house_margin_cents: split.houseMarginCents,
  });
  counts.franchiseSplitsWritten += 1;
  counts.franchisorRoyaltyCents += split.masterFranchisorRoyaltyCents;
  counts.technicianCommissionCents += split.technicianCommissionCents;
  counts.houseMarginCents += split.houseMarginCents;
}

// ---------------------------------------------------------------------------
// Senders 1 and 2 — the protocol execution micro-royalty: the
// per-treatment license fee routes to the protocol creator every time a
// franchised location logs the branded treatment.
// ---------------------------------------------------------------------------

async function walkProtocolMicroRoyalty(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "pos_ticket" | "hotel_folio" }>,
  counts: ServiceWriteCounts,
): Promise<void> {
  const sourceEventId = serviceRowEventId("protocol", detail);

  const existing = await store.getServiceProtocolMicroRoyalty(sourceEventId);
  if (existing !== undefined) {
    counts.protocolRoyaltiesReplayed += 1;
    return;
  }

  // The protocol policy of record — no policy, no micro-royalty (the walk
  // never guesses a rate; the route to the master esthetician or
  // celebrity dermatologist is the policy's payee identity).
  const policy = await store.getServiceProtocolPolicy(detail.protocolId);
  if (policy === undefined) {
    counts.protocolSkippedNoPolicy += 1;
    return;
  }

  // THE PROTOCOL MICRO-ROYALTY — one treatment per logged row; the fee
  // is exact micros floored into payable cents.
  const royaltyMicros = policy.micros_per_treatment;
  const royaltyCents = serviceMicrosToCents(royaltyMicros);

  await store.insertServiceProtocolMicroRoyalty({
    source_event_id: sourceEventId,
    sender: detail.sender,
    stylist_id: detail.stylistId,
    protocol_id: detail.protocolId,
    salon_location_id: detail.salonLocationId,
    period: detail.period,
    currency: detail.currency,
    payee_id: policy.payee_id,
    micros_per_treatment: policy.micros_per_treatment,
    royalty_micros: royaltyMicros,
    royalty_cents: royaltyCents,
  });
  counts.protocolRoyaltiesWritten += 1;
  counts.protocolRoyaltyCents += royaltyCents;
}

// ---------------------------------------------------------------------------
// Sender 3 — the cross-location redemption split: the service allocation
// fee routes directly to the visiting location while the franchisor
// royalty and home-location administrative cut distribute.
// ---------------------------------------------------------------------------

async function walkRedemptionSplit(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "membership_redemption" }>,
  counts: ServiceWriteCounts,
): Promise<void> {
  const sourceEventId = serviceRowEventId("redemption", detail);

  const existing = await store.getServiceRedemptionSplitApplication(sourceEventId);
  if (existing !== undefined) {
    counts.redemptionSplitsReplayed += 1;
    return;
  }

  // The redemption policy of record at the HOME location — no policy, no
  // split (the walk never guesses a rate).
  const policy = await store.getServiceRedemptionPolicy(detail.homeLocationId);
  if (policy === undefined) {
    counts.redemptionSkippedNoPolicy += 1;
    return;
  }

  // THE REDEMPTION SPLIT — the fee conserves exactly (the ordering the
  // application row pins: the fee routes DIRECTLY to the visiting
  // location; the royalty and the home admin cut distribute).
  const split = redemptionSplitCents({
    serviceAllocationFeeCents: detail.serviceAllocationFeeCents,
    franchisorRoyaltyBps: policy.franchisor_royalty_bps,
    homeAdminBps: policy.home_admin_bps,
  });

  await store.insertServiceRedemptionSplitApplication({
    source_event_id: sourceEventId,
    member_id: detail.memberId,
    home_location_id: detail.homeLocationId,
    visiting_location_id: detail.visitingLocationId,
    period: detail.period,
    currency: detail.currency,
    service_allocation_fee_cents: detail.serviceAllocationFeeCents,
    franchisor_royalty_bps: policy.franchisor_royalty_bps,
    franchisor_royalty_cents: split.franchisorRoyaltyCents,
    home_admin_bps: policy.home_admin_bps,
    home_admin_cents: split.homeAdminCents,
    visiting_location_cents: split.visitingLocationCents,
  });
  counts.redemptionSplitsWritten += 1;
  counts.redemptionFranchisorRoyaltyCents += split.franchisorRoyaltyCents;
  counts.homeAdminCents += split.homeAdminCents;
  counts.visitingLocationCents += split.visitingLocationCents;
}

// ---------------------------------------------------------------------------
// Sender 4 — the breakage allocation: the unredeemed monthly subscription
// funds allocate per the contractual franchisor and franchisee rules.
// ---------------------------------------------------------------------------

async function walkBreakageAllocation(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "membership_breakage" }>,
  counts: ServiceWriteCounts,
): Promise<void> {
  const sourceEventId = serviceRowEventId("breakage", detail);

  const existing = await store.getServiceBreakageAllocation(sourceEventId);
  if (existing !== undefined) {
    counts.breakageAllocationsReplayed += 1;
    return;
  }

  // The breakage policy of record at the HOME location — no policy, no
  // allocation (the walk never guesses a rate).
  const policy = await store.getServiceBreakagePolicy(detail.homeLocationId);
  if (policy === undefined) {
    counts.breakageSkippedNoPolicy += 1;
    return;
  }

  // THE BREAKAGE SPLIT — the funds conserve exactly (the franchisee
  // routes the residual).
  const split = breakageSplitCents({
    unredeemedAmountCents: detail.unredeemedAmountCents,
    franchisorBreakageBps: policy.franchisor_breakage_bps,
    franchiseeBreakageBps: policy.franchisee_breakage_bps,
  });

  await store.insertServiceBreakageAllocation({
    source_event_id: sourceEventId,
    member_id: detail.memberId,
    home_location_id: detail.homeLocationId,
    period: detail.period,
    currency: detail.currency,
    unredeemed_amount_cents: detail.unredeemedAmountCents,
    franchisor_breakage_bps: policy.franchisor_breakage_bps,
    franchisor_breakage_cents: split.franchisorBreakageCents,
    franchisee_breakage_cents: split.franchiseeBreakageCents,
  });
  counts.breakageAllocationsWritten += 1;
  counts.breakageFranchisorCents += split.franchisorBreakageCents;
  counts.breakageFranchiseeCents += split.franchiseeBreakageCents;
}

// ---------------------------------------------------------------------------
// Sender 5 — the vendor rebate routing: the volume kickback routes
// proportionally back to the location ledgers per the waterfall of
// record.
// ---------------------------------------------------------------------------

async function walkRebateRouting(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "vendor_rebate" }>,
  counts: ServiceWriteCounts,
): Promise<void> {
  const sourceEventId = serviceRowEventId("rebate", detail);

  const existing = await store.getServiceRebateApplication(sourceEventId);
  if (existing !== undefined) {
    counts.rebateRoutingsReplayed += 1;
    return;
  }

  // The location's waterfall of record — no registered waterfall, no
  // routing (a location with no registered rebate split routes nothing).
  const waterfallRecords = await store.listServiceRebateWaterfallLegs(
    detail.salonLocationId,
  );
  if (waterfallRecords.length === 0) {
    counts.rebateSkippedNoWaterfall += 1;
    return;
  }
  const legs: ServiceRebateWaterfallLeg[] = waterfallRecords.map((record) => ({
    ledger_id: record.ledger_id,
    weight_bps: record.weight_bps,
  }));

  // The waterfall of record — re-validated at read (an unvalidated
  // waterfall skips fail-closed; the routing never guesses a share).
  const waterfall = validateServiceRebateWaterfall(legs);
  if (!waterfall.ok) {
    counts.rebateSkippedNoWaterfall += 1;
    return;
  }

  // THE PROPORTIONAL REBATE ROUTING — largest-remainder exact; the legs'
  // routed shares conserve the rebate exactly.
  const routing = rebateProportionalRoutingCents({
    volumeRebateCents: detail.volumeRebateCents,
    legs,
  });

  await store.insertServiceRebateApplication({
    source_event_id: sourceEventId,
    distributor: detail.distributor,
    salon_location_id: detail.salonLocationId,
    period: detail.period,
    currency: detail.currency,
    rebate_basis_cents: detail.rebateBasisCents,
    volume_rebate_cents: detail.volumeRebateCents,
    routing_legs: JSON.stringify(routing.legs),
    routed_total_cents: routing.routedTotalCents,
  });
  counts.rebateRoutingsWritten += 1;
  counts.rebateRoutedCents += routing.routedTotalCents;
}

// ---------------------------------------------------------------------------
// Sender 6 — the booth-lease split: the isolated legs — the weekly flat
// chair rent routes exact to the studio owner (never commissioned); the
// retail product sale routes its floored commission (never the flat
// rent).
// ---------------------------------------------------------------------------

async function walkBoothLeaseSplit(
  store: Store,
  detail: Extract<ServiceLineDetail, { sender: "booth_lease" }>,
  counts: ServiceWriteCounts,
): Promise<void> {
  const sourceEventId = serviceRowEventId("booth", detail);

  const existing = await store.getServiceBoothLeaseApplication(sourceEventId);
  if (existing !== undefined) {
    counts.boothLeaseSplitsReplayed += 1;
    return;
  }

  // The booth-lease policy of record — no policy, no split (the walk
  // never guesses a commission rate; the route to the studio owner is
  // the policy's payee identity).
  const policy = await store.getServiceBoothLeasePolicy(detail.salonLocationId);
  if (policy === undefined) {
    counts.boothSkippedNoPolicy += 1;
    return;
  }

  // THE ISOLATED LEG — the rent routes exact; the retail sale routes its
  // floored commission at the policy of record.
  const legKind = detail.entryKind === "chair_rent" ? "chair_rent" : "retail_commission";
  const split = boothLeaseSplitCents({
    legKind,
    grossCents: detail.amountCents,
    retailCommissionBps: policy.retail_commission_bps,
  });

  await store.insertServiceBoothLeaseApplication({
    source_event_id: sourceEventId,
    salon_location_id: detail.salonLocationId,
    period: detail.period,
    currency: detail.currency,
    leg_kind: legKind,
    gross_cents: detail.amountCents,
    retail_commission_bps: legKind === "chair_rent" ? 0 : policy.retail_commission_bps,
    studio_owner_cents: split.studioOwnerCents,
  });
  counts.boothLeaseSplitsWritten += 1;
  if (legKind === "chair_rent") {
    counts.chairRentCents += split.studioOwnerCents;
  } else {
    counts.retailCommissionCents += split.studioOwnerCents;
  }
}
