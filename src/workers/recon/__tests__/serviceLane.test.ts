/**
 * The service lane's worker-path test (PR 42, the founder service
 * directive) — the full pass over the six senders' sheets through the
 * real dispatch (profiles) and the real store walk (serviceQueue) on the
 * in-memory backend: the exact founder math (the Net Service Realization
 * identity, the 5% / 45% / 50% franchise partition, the per-treatment
 * protocol micro-fees, the cross-location redemption routing, the
 * breakage split accounting, the largest-remainder rebate waterfalls,
 * and the booth-lease isolation), the replay no-ops, and the fail-closed
 * skips.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dispatchStatementProfile } from "../profiles";
import {
  boothLeaseSplitCents,
  breakageSplitCents,
  franchiseSplitCents,
  netServiceRealizationCents,
  rebateProportionalRoutingCents,
  redemptionSplitCents,
  serviceMicrosToCents,
  serviceRowEventId,
} from "../service";
import { writeServiceRowsToStore } from "../serviceQueue";
import type { ServiceSenderCode } from "../service";
import type { ParsedStatementLine } from "../records";
import { loadFixture } from "./fixtures";

/** Dispatches and parses one raw CSV through the pinned registry (the
 * worker's own two-step). */
function parseCsv(content: string): readonly ParsedStatementLine[] {
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error("content matched no profile");
  return profile.parse(content);
}

const AUSTIN = "LOC-AUSTIN";

/** Registers every policy of record the lane's walks read. */
function registerPolicies(store: InMemoryStore): void {
  // The founder's example three-way split — 5% master franchisor
  // royalty, 45% technician service commission, 50% house location
  // margin. Dallas has no schedule (fail-closed exercise).
  store.upsertServiceFranchiseSchedule({
    salon_location_id: AUSTIN,
    master_franchisor_royalty_bps: 500,
    technician_commission_bps: 4500,
    house_margin_bps: 5000,
  });
  // The protocol creators' policies of record — the master
  // esthetician's $0.0025 facial fee and the celebrity dermatologist's
  // $1 keratin formula fee (statement micros: $1 = 1e8).
  store.upsertServiceProtocolPolicy({
    protocol_id: "proto-glow-facial",
    payee_id: "esthetician-mila",
    micros_per_treatment: 250_000,
  });
  store.upsertServiceProtocolPolicy({
    protocol_id: "proto-silk-keratin",
    payee_id: "derm-santiago",
    micros_per_treatment: 100_000_000,
  });
  // The redemption policy of record at the home location — 5% franchisor
  // royalty + 15% home admin; the visiting location routes the residual.
  store.upsertServiceRedemptionPolicy({
    home_location_id: AUSTIN,
    franchisor_royalty_bps: 500,
    home_admin_bps: 1500,
  });
  // The breakage split of record — 25% franchisor / 75% franchisee.
  store.upsertServiceBreakagePolicy({
    home_location_id: AUSTIN,
    franchisor_breakage_bps: 2500,
    franchisee_breakage_bps: 7500,
  });
  // Austin's rebate waterfall: backbar / frontbar / house 30/20/50.
  for (const leg of [
    { ledger_id: "ledger-backbar", weight_bps: 3000 },
    { ledger_id: "ledger-frontbar", weight_bps: 2000 },
    { ledger_id: "ledger-house", weight_bps: 5000 },
  ]) {
    store.upsertServiceRebateWaterfallLeg({ salon_location_id: AUSTIN, ...leg });
  }
  // An unvalidated waterfall (weights sum to 11000) — the walk must
  // refuse it fail-closed, never guess a share.
  for (const leg of [
    { ledger_id: "ledger-x", weight_bps: 5000 },
    { ledger_id: "ledger-y", weight_bps: 6000 },
  ]) {
    store.upsertServiceRebateWaterfallLeg({ salon_location_id: "LOC-BADWATER", ...leg });
  }
  // The hybrid salon's booth-lease policy — the studio owner's payee
  // identity and the 15% retail commission (the flat rent routes
  // around it).
  store.upsertServiceBoothLeasePolicy({
    salon_location_id: AUSTIN,
    chair_rent_payee_id: "studio-owner-solo",
    retail_commission_bps: 1500,
  });
}

/** Parses the six senders' checked-in fixtures and walks the lane. */
async function walkFixtures(store: InMemoryStore) {
  const lines = [
    "service_pos_tickets.csv",
    "service_hotel_folios.csv",
    "service_membership_redemptions.csv",
    "service_membership_breakage.csv",
    "service_vendor_rebates.csv",
    "service_booth_leases.csv",
  ].flatMap((name) => parseCsv(loadFixture(name)));
  return writeServiceRowsToStore(store, lines);
}

/** The event id for a ticket row (the replay guard's identity,
 * namespaced per ledger). */
function ticketEventId(
  ledger: "realization" | "franchise" | "protocol",
  senderRowId: string,
  stylistId: string,
  protocolId: string,
  salonLocationId = AUSTIN,
): string {
  return serviceRowEventId(ledger, {
    sender: "pos_ticket",
    stylistId,
    protocolId,
    salonLocationId,
    period: "2026-03",
    senderRowId,
  });
}

/** The event id for a folio row — the hotel location and the salon
 * location ride the identity. */
function folioEventId(
  ledger: "realization" | "franchise" | "protocol",
  senderRowId: string,
  hotelLocationId: string,
  stylistId: string,
  salonLocationId: string,
): string {
  return serviceRowEventId(ledger, {
    sender: "hotel_folio",
    stylistId,
    protocolId: "proto-glow-facial",
    salonLocationId,
    hotelLocationId,
    period: "2026-03",
    senderRowId,
  });
}

/** The event id for a membership sender's row. */
function memberEventId(
  ledger: "redemption" | "breakage",
  sender: ServiceSenderCode,
  memberId: string,
  senderRowId: string,
): string {
  return serviceRowEventId(ledger, {
    sender,
    memberId,
    period: "2026-03",
    senderRowId,
  });
}

/** The event id for a location-keyed sender's row. */
function locationEventId(
  ledger: "rebate" | "booth",
  sender: ServiceSenderCode,
  senderRowId: string,
  salonLocationId = AUSTIN,
): string {
  return serviceRowEventId(ledger, {
    sender,
    salonLocationId,
    period: "2026-03",
    senderRowId,
  });
}

describe("the service lane's full pass over the six senders", () => {
  it("commits every ledger with the exact founder math and advances the walks", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    const counts = await walkFixtures(store);

    // 5 POS tickets + 3 folios: 8 realizations (1 held negative),
    // 6 franchise splits (2 no-schedule skips), 7 protocol royalties
    // (1 no-policy skip). 3 redemptions: 2 splits, 1 no-policy skip.
    // 3 breakage rows: 2 allocations, 1 no-policy skip. 4 rebates:
    // 2 routings (2 no-waterfall skips). 3 booth rows: 2 splits, 1
    // no-policy skip. Nothing replayed.
    expect(counts.realizationWritten).toBe(8);
    expect(counts.realizationReplayed).toBe(0);
    expect(counts.realizationHeldNegativeNet).toBe(1);
    expect(counts.franchiseSplitsWritten).toBe(6);
    expect(counts.franchiseSplitsReplayed).toBe(0);
    expect(counts.franchiseSkippedNoSchedule).toBe(2);
    expect(counts.protocolRoyaltiesWritten).toBe(7);
    expect(counts.protocolRoyaltiesReplayed).toBe(0);
    expect(counts.protocolSkippedNoPolicy).toBe(1);
    expect(counts.redemptionSplitsWritten).toBe(2);
    expect(counts.redemptionSplitsReplayed).toBe(0);
    expect(counts.redemptionSkippedNoPolicy).toBe(1);
    expect(counts.breakageAllocationsWritten).toBe(2);
    expect(counts.breakageAllocationsReplayed).toBe(0);
    expect(counts.breakageSkippedNoPolicy).toBe(1);
    expect(counts.rebateRoutingsWritten).toBe(2);
    expect(counts.rebateRoutingsReplayed).toBe(0);
    expect(counts.rebateSkippedNoWaterfall).toBe(2);
    expect(counts.boothLeaseSplitsWritten).toBe(2);
    expect(counts.boothLeaseSplitsReplayed).toBe(0);
    expect(counts.boothSkippedNoPolicy).toBe(1);

    // The pass's money of record, exact to the cent:
    // pools 76750 + 18250 + 6100 − 700 (held) + 8500 + 32500 + 11050
    //   + 7190;
    // franchise legs 9800 + 88200 + 98000 (the two no-schedule rows'
    //   17000 gross split nowhere — no schedule, no split);
    // protocol micro-fees 0 + 100 + 0 + 0 + 0 + 100 + 0 (the $0.0025
    //   facial fee prices sub-cent — exact micros, floored cents);
    // redemption legs 541 + 1624 + 8668; breakage 3110 + 9334;
    // rebates 75000 + 33333; booth legs 20000 + 7500.
    expect(counts.netRealizedServicePoolCents).toBe(159_640);
    expect(counts.franchisorRoyaltyCents).toBe(9_800);
    expect(counts.technicianCommissionCents).toBe(88_200);
    expect(counts.houseMarginCents).toBe(98_000);
    expect(counts.protocolRoyaltyCents).toBe(200);
    expect(counts.redemptionFranchisorRoyaltyCents).toBe(541);
    expect(counts.homeAdminCents).toBe(1_624);
    expect(counts.visitingLocationCents).toBe(8_668);
    expect(counts.breakageFranchisorCents).toBe(3_110);
    expect(counts.breakageFranchiseeCents).toBe(9_334);
    expect(counts.rebateRoutedCents).toBe(108_333);
    expect(counts.chairRentCents).toBe(20_000);
    expect(counts.retailCommissionCents).toBe(7_500);

    // THE NET SERVICE REALIZATION — exact to the cent on the ticket's
    // own figures: 1000.00 − 120.50 − 29.40 − 82.60 = 767.50.
    const realization = await store.getServiceRealizationApplication(
      ticketEventId("realization", "TICK-2026-03-0001", "stylist-ava", "proto-glow-facial"),
    );
    expect(realization).toMatchObject({
      sender: "pos_ticket",
      stylist_id: "stylist-ava",
      protocol_id: "proto-glow-facial",
      salon_location_id: AUSTIN,
      period: "2026-03",
      gross_service_ticket_cents: 100_000,
      backbar_product_cogs_cents: 12_050,
      card_processing_engine_cut_cents: 2_940,
      service_sales_taxes_cents: 8_260,
      net_realized_service_pool_cents: 76_750,
      verdict: "paid",
    });

    // A NEGATIVE POOL — the deduction legs exceeded the gross: recorded
    // visible and held; the franchise legs still price on the gross (the
    // founder's percentages are ON gross sales, independent of the
    // realization verdict).
    const held = await store.getServiceRealizationApplication(
      ticketEventId("realization", "TICK-2026-03-0004", "stylist-chiara", "proto-glow-facial"),
    );
    expect(held).toMatchObject({
      net_realized_service_pool_cents: -700,
      verdict: "held_negative_net",
    });
    const heldSplit = await store.getServiceFranchiseSplitApplication(
      ticketEventId("franchise", "TICK-2026-03-0004", "stylist-chiara", "proto-glow-facial"),
    );
    expect(heldSplit).toMatchObject({
      master_franchisor_royalty_cents: 300,
      technician_commission_cents: 2_700,
      house_margin_cents: 3_000,
    });

    // THE FRANCHISE SPLIT — the founder's example: 5% / 45% / 50% of the
    // $1000.00 ticket, the house margin routing the residual.
    const franchise = await store.getServiceFranchiseSplitApplication(
      ticketEventId("franchise", "TICK-2026-03-0001", "stylist-ava", "proto-glow-facial"),
    );
    expect(franchise).toMatchObject({
      master_franchisor_royalty_bps: 500,
      master_franchisor_royalty_cents: 5_000,
      technician_commission_bps: 4500,
      technician_commission_cents: 45_000,
      house_margin_bps: 5000,
      house_margin_cents: 50_000,
    });

    // THE PROTOCOL MICRO-ROYALTY — the dermatologist's $1.00 per
    // treatment every time a location logs the keratin formula.
    const micro = await store.getServiceProtocolMicroRoyalty(
      ticketEventId("protocol", "TICK-2026-03-0002", "stylist-bruno", "proto-silk-keratin"),
    );
    expect(micro).toMatchObject({
      payee_id: "derm-santiago",
      micros_per_treatment: 100_000_000,
      royalty_micros: 100_000_000,
      royalty_cents: 100,
    });

    // THE CROSS-LOCATION REDEMPTION — the fee conserves exactly: the
    // franchisor royalty and home admin cut distribute, the visiting
    // location routes the residual DIRECTLY (75.00 → 3.75 + 11.25 +
    // 60.00).
    const redemption = await store.getServiceRedemptionSplitApplication(
      memberEventId("redemption", "membership_redemption", "member-m1", "RED-2026-03-0001"),
    );
    expect(redemption).toMatchObject({
      member_id: "member-m1",
      home_location_id: AUSTIN,
      visiting_location_id: "LOC-DALLAS",
      service_allocation_fee_cents: 7_500,
      franchisor_royalty_bps: 500,
      franchisor_royalty_cents: 375,
      home_admin_bps: 1500,
      home_admin_cents: 1_125,
      visiting_location_cents: 6_000,
    });

    // THE BREAKAGE SPLIT — 25% franchisor / 75% franchisee of the
    // unredeemed $123.45, exact to the cent.
    const breakage = await store.getServiceBreakageAllocation(
      memberEventId("breakage", "membership_breakage", "member-m1", "BRK-2026-03-0001"),
    );
    expect(breakage).toMatchObject({
      unredeemed_amount_cents: 12_345,
      franchisor_breakage_bps: 2500,
      franchisor_breakage_cents: 3_086,
      franchisee_breakage_cents: 9_259,
    });

    // THE REBATE ROUTING — the 333.33 Estee Lauder kickback routes
    // largest-remainder exact: 9999.9 / 6666.6 / 16666.5 floored leaves
    // 2 dust cents on the highest remainders (backbar, frontbar).
    const rebate = await store.getServiceRebateApplication(
      locationEventId("rebate", "vendor_rebate", "REB-2026-03-0002"),
    );
    expect(rebate).toMatchObject({
      distributor: "estee_lauder",
      volume_rebate_cents: 33_333,
    });
    expect(JSON.parse(rebate?.routing_legs ?? "[]")).toEqual([
      { ledger_id: "ledger-backbar", weight_bps: 3000, routed_cents: 10_000 },
      { ledger_id: "ledger-frontbar", weight_bps: 2000, routed_cents: 6_667 },
      { ledger_id: "ledger-house", weight_bps: 5000, routed_cents: 16_666 },
    ]);

    // THE BOOTH-LEASE ISOLATION — the flat chair rent routes exact to
    // the studio owner (no commission ever touches it) and the retail
    // sale routes its 15% floored commission (the rent is never
    // commissioned).
    const chair = await store.getServiceBoothLeaseApplication(
      locationEventId("booth", "booth_lease", "CHAIR-2026-03-0001"),
    );
    expect(chair).toMatchObject({
      leg_kind: "chair_rent",
      gross_cents: 20_000,
      retail_commission_bps: 0,
      studio_owner_cents: 20_000,
    });
    const retail = await store.getServiceBoothLeaseApplication(
      locationEventId("booth", "booth_lease", "RET-2026-03-0002"),
    );
    expect(retail).toMatchObject({
      leg_kind: "retail_commission",
      gross_cents: 50_000,
      retail_commission_bps: 1500,
      studio_owner_cents: 7_500,
    });

    // THE HOTEL FOLIO'S PROVENANCE — the same charge id at two
    // different hotels names two distinct events: both committed.
    const folioWest = await store.getServiceRealizationApplication(
      folioEventId("realization", "FOLIO-2026-03-0001", "HOTEL-W", "stylist-ava", AUSTIN),
    );
    const folioEast = await store.getServiceRealizationApplication(
      folioEventId("realization", "FOLIO-2026-03-0001", "HOTEL-E", "stylist-dana", "LOC-DALLAS"),
    );
    expect(folioWest).toMatchObject({
      sender: "hotel_folio",
      net_realized_service_pool_cents: 32_500,
    });
    expect(folioEast).toMatchObject({
      sender: "hotel_folio",
      net_realized_service_pool_cents: 7_190,
    });
  });

  it("replays the whole pass as counted no-ops", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    await walkFixtures(store);
    const replay = await walkFixtures(store);

    // A re-shipped sheet is a counted no-op everywhere — no ledger
    // double-writes, no money moves twice.
    expect(replay.realizationWritten).toBe(0);
    expect(replay.realizationReplayed).toBe(8);
    expect(replay.realizationHeldNegativeNet).toBe(0);
    expect(replay.franchiseSplitsWritten).toBe(0);
    expect(replay.franchiseSplitsReplayed).toBe(6);
    expect(replay.protocolRoyaltiesWritten).toBe(0);
    expect(replay.protocolRoyaltiesReplayed).toBe(7);
    expect(replay.redemptionSplitsWritten).toBe(0);
    expect(replay.redemptionSplitsReplayed).toBe(2);
    expect(replay.breakageAllocationsWritten).toBe(0);
    expect(replay.breakageAllocationsReplayed).toBe(2);
    expect(replay.rebateRoutingsWritten).toBe(0);
    expect(replay.rebateRoutingsReplayed).toBe(2);
    expect(replay.boothLeaseSplitsWritten).toBe(0);
    expect(replay.boothLeaseSplitsReplayed).toBe(2);
    expect(replay.netRealizedServicePoolCents).toBe(0);
    expect(replay.franchisorRoyaltyCents).toBe(0);
    expect(replay.protocolRoyaltyCents).toBe(0);
    expect(replay.rebateRoutedCents).toBe(0);
  });
});

describe("the service lane's pure founder math", () => {
  it("prices the Net Service Realization identity exact to the cent", () => {
    // The founder's identity: gross − COGS − cut − taxes = the pool.
    const paid = netServiceRealizationCents({
      grossServiceTicketCents: 100_000,
      backbarProductCogsCents: 12_050,
      cardProcessingEngineCutCents: 2_940,
      serviceSalesTaxesCents: 8_260,
    });
    expect(paid.netRealizedServicePoolCents).toBe(76_750);

    // A negative pool is not an error — the walk's verdict holds it.
    const held = netServiceRealizationCents({
      grossServiceTicketCents: 6_000,
      backbarProductCogsCents: 5_000,
      cardProcessingEngineCutCents: 800,
      serviceSalesTaxesCents: 900,
    });
    expect(held.netRealizedServicePoolCents).toBe(-700);

    // Hostile legs never reach the ledger.
    expect(() =>
      netServiceRealizationCents({
        grossServiceTicketCents: -1,
        backbarProductCogsCents: 0,
        cardProcessingEngineCutCents: 0,
        serviceSalesTaxesCents: 0,
      }),
    ).toThrow(/service_realization_invalid_leg/);
  });

  it("splits the gross with the founder's 5/45/50 franchise partition exact", () => {
    const split = franchiseSplitCents({
      grossServiceTicketCents: 100_000,
      masterFranchisorRoyaltyBps: 500,
      technicianCommissionBps: 4500,
      houseMarginBps: 5000,
    });
    expect(split).toEqual({
      masterFranchisorRoyaltyCents: 5_000,
      technicianCommissionCents: 45_000,
      houseMarginCents: 50_000,
    });

    // An odd gross floors the two rate legs; the house margin routes
    // the residual — the legs conserve the gross EXACTLY.
    const odd = franchiseSplitCents({
      grossServiceTicketCents: 3_333,
      masterFranchisorRoyaltyBps: 500,
      technicianCommissionBps: 4500,
      houseMarginBps: 5000,
    });
    expect(odd).toEqual({
      masterFranchisorRoyaltyCents: 166,
      technicianCommissionCents: 1_499,
      houseMarginCents: 1_668,
    });
    expect(
      odd.masterFranchisorRoyaltyCents +
        odd.technicianCommissionCents +
        odd.houseMarginCents,
    ).toBe(3_333);
  });

  it("routes the cross-location redemption fee directly to the visiting location", () => {
    // The clean fee: 5% royalty + 15% admin, 80% to the visiting
    // location.
    const clean = redemptionSplitCents({
      serviceAllocationFeeCents: 7_500,
      franchisorRoyaltyBps: 500,
      homeAdminBps: 1500,
    });
    expect(clean).toEqual({
      franchisorRoyaltyCents: 375,
      homeAdminCents: 1_125,
      visitingLocationCents: 6_000,
    });

    // The dust fee: the floored legs leave the visiting location the
    // residual — the fee conserves exactly.
    const dust = redemptionSplitCents({
      serviceAllocationFeeCents: 3_333,
      franchisorRoyaltyBps: 500,
      homeAdminBps: 1500,
    });
    expect(dust).toEqual({
      franchisorRoyaltyCents: 166,
      homeAdminCents: 499,
      visitingLocationCents: 2_668,
    });
    expect(
      dust.franchisorRoyaltyCents + dust.homeAdminCents + dust.visitingLocationCents,
    ).toBe(3_333);
  });

  it("accounts the breakage split exact to the cent", () => {
    const split = breakageSplitCents({
      unredeemedAmountCents: 12_345,
      franchisorBreakageBps: 2500,
      franchiseeBreakageBps: 7500,
    });
    expect(split).toEqual({ franchisorBreakageCents: 3_086, franchiseeBreakageCents: 9_259 });

    // The dust case: 99 cents at 25% floors to 24, the franchisee
    // routes the residual 75.
    const dust = breakageSplitCents({
      unredeemedAmountCents: 99,
      franchisorBreakageBps: 2500,
      franchiseeBreakageBps: 7500,
    });
    expect(dust).toEqual({ franchisorBreakageCents: 24, franchiseeBreakageCents: 75 });
  });

  it("routes the vendor rebate proportional distribution largest-remainder exact", () => {
    // A clean pot: every leg exact, no dust.
    const clean = rebateProportionalRoutingCents({
      volumeRebateCents: 75_000,
      legs: [
        { ledger_id: "ledger-backbar", weight_bps: 3000 },
        { ledger_id: "ledger-frontbar", weight_bps: 2000 },
        { ledger_id: "ledger-house", weight_bps: 5000 },
      ],
    });
    expect(
      clean.legs.map((leg) => ({ ledger_id: leg.ledger_id, routed_cents: leg.routed_cents })),
    ).toEqual([
      { ledger_id: "ledger-backbar", routed_cents: 22_500 },
      { ledger_id: "ledger-frontbar", routed_cents: 15_000 },
      { ledger_id: "ledger-house", routed_cents: 37_500 },
    ]);
    expect(clean.routedTotalCents).toBe(75_000);

    // The dust pot: 2 leftover cents on the highest fractional
    // remainders — the routing conserves the rebate EXACTLY.
    const dusty = rebateProportionalRoutingCents({
      volumeRebateCents: 33_333,
      legs: [
        { ledger_id: "ledger-backbar", weight_bps: 3000 },
        { ledger_id: "ledger-frontbar", weight_bps: 2000 },
        { ledger_id: "ledger-house", weight_bps: 5000 },
      ],
    });
    expect(dusty.legs.map((leg) => leg.routed_cents)).toEqual([10_000, 6_667, 16_666]);
    expect(dusty.routedTotalCents).toBe(33_333);
  });

  it("isolates the chair rent from the retail commission", () => {
    // THE ISOLATION — the flat rent routes exact; no commission math
    // ever touches it.
    const rent = boothLeaseSplitCents({
      legKind: "chair_rent",
      grossCents: 20_000,
      retailCommissionBps: 1500,
    });
    expect(rent.studioOwnerCents).toBe(20_000);

    // The retail sale routes its floored commission — never the flat
    // rent.
    const sale = boothLeaseSplitCents({
      legKind: "retail_commission",
      grossCents: 50_000,
      retailCommissionBps: 1500,
    });
    expect(sale.studioOwnerCents).toBe(7_500);
  });

  it("prices the protocol micro-fee per treatment in statement micros", () => {
    // The master esthetician's $0.0025 facial fee floors to a sub-cent
    // payable (the micros stay exact on the record).
    expect(serviceMicrosToCents(250_000)).toBe(0);
    // The dermatologist's $1.00 keratin fee.
    expect(serviceMicrosToCents(100_000_000)).toBe(100);
    // Two and a half cents floors down from 2.5.
    expect(serviceMicrosToCents(2_500_000)).toBe(2);
  });
});

describe("the service lane's fail-closed profile rejections", () => {
  it("refuses a same-location redemption — no visiting leg, no guessed route", () => {
    const content = [
      "Redemption ID,Member ID,Home Location ID,Visiting Location ID,Service Allocation Fee,Currency,Reporting Period",
      "RED-X,member-m9,LOC-AUSTIN,LOC-AUSTIN,50.00,USD,2026-03",
    ].join("\n");
    expect(() => parseCsv(content)).toThrow(/redemption_location_collision/);
  });

  it("refuses negative money on any priced cell", () => {
    const content = [
      "Ticket ID,Platform,Stylist ID,Protocol ID,Salon Location ID,Gross Service Ticket,Backbar Product COGS,Card Processing Engine Cut,Service and Sales Taxes,Currency,Reporting Period",
      "TICK-X,mindbody,stylist-ava,proto-glow-facial,LOC-AUSTIN,100.00,-5.00,3.00,7.00,USD,2026-03",
    ].join("\n");
    expect(() => parseCsv(content)).toThrow(/negative_money/);
  });

  it("refuses an unknown platform vocabulary cell", () => {
    const content = [
      "Ticket ID,Platform,Stylist ID,Protocol ID,Salon Location ID,Gross Service Ticket,Backbar Product COGS,Card Processing Engine Cut,Service and Sales Taxes,Currency,Reporting Period",
      "TICK-X,visa,stylist-ava,proto-glow-facial,LOC-AUSTIN,100.00,5.00,3.00,7.00,USD,2026-03",
    ].join("\n");
    expect(() => parseCsv(content)).toThrow(/invalid_vocabulary:Platform:visa/);
  });

  it("refuses a row that prices nothing", () => {
    const content = [
      "Ticket ID,Platform,Stylist ID,Protocol ID,Salon Location ID,Gross Service Ticket,Backbar Product COGS,Card Processing Engine Cut,Service and Sales Taxes,Currency,Reporting Period",
      "TICK-X,mindbody,stylist-ava,proto-glow-facial,LOC-AUSTIN,0.00,0.00,0.00,0.00,USD,2026-03",
    ].join("\n");
    expect(() => parseCsv(content)).toThrow(/service_row_prices_nothing/);
  });

  it("matches no profile when the header is not the service lane's", () => {
    expect(dispatchStatementProfile("Ticket ID,Wat\n1,2\n")).toBeNull();
  });
});
