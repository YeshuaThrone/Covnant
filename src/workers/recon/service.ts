/**
 * CVT recon worker — the service lane's pure engine (PR 42, the founder
 * service directive): the identity spaces, THE NET SERVICE REALIZATION
 * CALCULATOR, the franchise contract's three-way gross partition (master
 * franchisor royalty, technician service commission, house location
 * margin), the cross-location membership redemption split, the membership
 * breakage allocation, the per-treatment protocol micro-royalty, the
 * proportional distributor rebate routing, and the hybrid salon's
 * isolated booth-lease legs.
 *
 * Every function here is pure — no store, no I/O — and exact to the cent:
 * deductions and splits floor per leg (never round up — the house money
 * discipline), the calculators' identities hold on every input, and every
 * micro-royalty is bigint-exact statement micros floored into payable
 * cents. The queue writer consumes these; the profiles parse into them.
 */

import { createHash } from "node:crypto";

import type {
  ServiceBoothLeaseLegKind,
  ServiceRebateRoutingLeg,
  ServiceRebateWaterfallLeg,
} from "@/modules/service/records";

/** The service lane's statement senders — the six strict layouts'
 * families. */
export type ServiceSenderCode =
  | "pos_ticket"
  | "hotel_folio"
  | "membership_redemption"
  | "membership_breakage"
  | "vendor_rebate"
  | "booth_lease";

function serviceFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (ledger, sender, stylist, protocol,
 * location, period, sender row id). The sender's row id of record is the
 * identity core: a re-shipped sheet replays as a counted no-op, and two
 * senders' sheets for the same location stay distinct identities. The
 * ledger namespace rides the prefix — one source event can appear in
 * several ledgers (a service ticket walks the realization, franchise
 * split, and protocol ledgers) without colliding. The hotel folio's
 * hotelLocationId rides the fingerprint (optional field — two hotels'
 * folio systems can reuse a charge id); absent fields fingerprint as "".
 */
export function serviceRowEventId(
  ledger:
    | "realization"
    | "franchise"
    | "protocol"
    | "redemption"
    | "breakage"
    | "rebate"
    | "booth",
  detail: {
    sender: ServiceSenderCode;
    stylistId?: string;
    protocolId?: string;
    salonLocationId?: string;
    hotelLocationId?: string;
    memberId?: string;
    period: string;
    senderRowId: string;
  },
): string {
  return `service:${ledger}:${detail.sender}:${serviceFingerprint(
    detail.stylistId ?? "",
    detail.protocolId ?? "",
    detail.salonLocationId ?? "",
    detail.hotelLocationId ?? "",
    detail.memberId ?? "",
    detail.period,
    detail.senderRowId,
  )}`;
}

/** Floors micros to integer cents — the application ledgers' pricing pin
 * (cents = micros / 1,000,000, never rounded up). Accepts the micro
 * royalty's bigint natively. */
export function serviceMicrosToCents(micros: number | bigint): number {
  return Math.floor(Number(micros) / 1_000_000);
}

/** The reporting period's shape of record (YYYY-MM) — the tracking is
 * monthly. */
export function isServicePeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function serviceBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE NET SERVICE REALIZATION CALCULATOR (the founder directive's exact
 * identity, keyed on the row's stylist_id, protocol_id, and
 * salon_location_id columns — the identity legs ride the application):
 *
 *   Net Realized Service Pool =
 *     gross service ticket
 *     − backbar product COGS
 *     − credit card processing engine cut
 *     − local service and sales taxes
 *
 * Every leg is a recorded money amount (the ticket stream's own figures —
 * never a rate guess). The identity (COGS + cut + taxes + net === gross)
 * pins the math. A deduction set larger than the gross yields a negative
 * net — the CALLER holds that application (held_negative_net); this
 * function records the arithmetic honestly either way.
 */
export function netServiceRealizationCents(input: {
  grossServiceTicketCents: number;
  backbarProductCogsCents: number;
  cardProcessingEngineCutCents: number;
  serviceSalesTaxesCents: number;
}): {
  grossServiceTicketCents: number;
  netRealizedServicePoolCents: number;
} {
  const legs = [
    input.grossServiceTicketCents,
    input.backbarProductCogsCents,
    input.cardProcessingEngineCutCents,
    input.serviceSalesTaxesCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`service_realization_invalid_leg:${leg}`);
    }
  }
  const netRealizedServicePoolCents =
    input.grossServiceTicketCents -
    input.backbarProductCogsCents -
    input.cardProcessingEngineCutCents -
    input.serviceSalesTaxesCents;
  return {
    grossServiceTicketCents: input.grossServiceTicketCents,
    netRealizedServicePoolCents,
  };
}

/**
 * THE FRANCHISE SPLIT — the gross service ticket's three contractual
 * routes at the schedule of record, each percentage leg floored off the
 * gross and the HOUSE LOCATION MARGIN routing the residual (the founder's
 * example: 5% master franchisor royalty + 45% technician service
 * commission + 50% house location margin = the whole gross):
 *
 *   master franchisor royalty = floor(gross × royalty bps / 10000)
 *   technician commission     = floor(gross × commission bps / 10000)
 *   house location margin     = gross − royalty − commission
 *
 * The legs conserve the gross EXACTLY (the schedule of record validates
 * the three rates sum to 10000 bps — the split never guesses a rate). A
 * gross below zero is hostile upstream; this function never sees one.
 */
export function franchiseSplitCents(input: {
  grossServiceTicketCents: number;
  masterFranchisorRoyaltyBps: number;
  technicianCommissionBps: number;
  houseMarginBps: number;
}): {
  masterFranchisorRoyaltyCents: number;
  technicianCommissionCents: number;
  houseMarginCents: number;
} {
  const {
    grossServiceTicketCents,
    masterFranchisorRoyaltyBps,
    technicianCommissionBps,
    houseMarginBps,
  } = input;
  if (!Number.isInteger(grossServiceTicketCents) || grossServiceTicketCents < 0) {
    throw new Error(`service_franchise_split_invalid_gross:${grossServiceTicketCents}`);
  }
  if (
    !Number.isInteger(masterFranchisorRoyaltyBps) ||
    !Number.isInteger(technicianCommissionBps) ||
    !Number.isInteger(houseMarginBps) ||
    masterFranchisorRoyaltyBps < 0 ||
    technicianCommissionBps < 0 ||
    houseMarginBps < 0 ||
    masterFranchisorRoyaltyBps +
      technicianCommissionBps +
      houseMarginBps !==
      10_000
  ) {
    throw new Error(
      `service_franchise_split_invalid_bps:${masterFranchisorRoyaltyBps}:${technicianCommissionBps}:${houseMarginBps}`,
    );
  }
  const masterFranchisorRoyaltyCents = serviceBpsShareCents(
    grossServiceTicketCents,
    masterFranchisorRoyaltyBps,
  );
  const technicianCommissionCents = serviceBpsShareCents(
    grossServiceTicketCents,
    technicianCommissionBps,
  );
  return {
    masterFranchisorRoyaltyCents,
    technicianCommissionCents,
    houseMarginCents:
      grossServiceTicketCents - masterFranchisorRoyaltyCents - technicianCommissionCents,
  };
}

/**
 * THE CROSS-LOCATION REDEMPTION SPLIT — a member enrolled at Location A
 * redeeming a monthly service at Location B: the franchisor royalty and
 * the home-location administrative cut floor off the service allocation
 * fee, and the VISITING LOCATION routes the residual — the fee conserves
 * exactly:
 *
 *   visiting location cents = fee − royalty − home admin cut
 *
 * The brief's ordering is pinned: the service allocation fee routes
 * DIRECTLY to Location B; the franchisor royalty and home-location
 * administrative cut distribute. The policy of record validates the two
 * rates sum to AT MOST 10000 bps (the residual never goes negative). A
 * fee below zero is hostile upstream; this function never sees one.
 */
export function redemptionSplitCents(input: {
  serviceAllocationFeeCents: number;
  franchisorRoyaltyBps: number;
  homeAdminBps: number;
}): {
  franchisorRoyaltyCents: number;
  homeAdminCents: number;
  visitingLocationCents: number;
} {
  const { serviceAllocationFeeCents, franchisorRoyaltyBps, homeAdminBps } = input;
  if (!Number.isInteger(serviceAllocationFeeCents) || serviceAllocationFeeCents < 0) {
    throw new Error(`service_redemption_split_invalid_fee:${serviceAllocationFeeCents}`);
  }
  if (
    !Number.isInteger(franchisorRoyaltyBps) ||
    !Number.isInteger(homeAdminBps) ||
    franchisorRoyaltyBps < 0 ||
    homeAdminBps < 0 ||
    franchisorRoyaltyBps + homeAdminBps > 10_000
  ) {
    throw new Error(
      `service_redemption_split_invalid_bps:${franchisorRoyaltyBps}:${homeAdminBps}`,
    );
  }
  const franchisorRoyaltyCents = serviceBpsShareCents(
    serviceAllocationFeeCents,
    franchisorRoyaltyBps,
  );
  const homeAdminCents = serviceBpsShareCents(serviceAllocationFeeCents, homeAdminBps);
  return {
    franchisorRoyaltyCents,
    homeAdminCents,
    visitingLocationCents:
      serviceAllocationFeeCents - franchisorRoyaltyCents - homeAdminCents,
  };
}

/**
 * THE BREAKAGE SPLIT — the unredeemed monthly subscription funds
 * allocate per the contractual breakage rules: the franchisor's share
 * floors off the unredeemed amount and the FRANCHISEE (the home location)
 * routes the residual — the funds conserve exactly:
 *
 *   franchisee breakage cents = unredeemed − franchisor share
 *
 * The policy of record validates the two rates sum to EXACTLY 10000 bps
 * (the unredeemed funds allocate fully). An unredeemed amount below zero
 * is hostile upstream; this function never sees one.
 */
export function breakageSplitCents(input: {
  unredeemedAmountCents: number;
  franchisorBreakageBps: number;
  franchiseeBreakageBps: number;
}): {
  franchisorBreakageCents: number;
  franchiseeBreakageCents: number;
} {
  const { unredeemedAmountCents, franchisorBreakageBps, franchiseeBreakageBps } = input;
  if (!Number.isInteger(unredeemedAmountCents) || unredeemedAmountCents < 0) {
    throw new Error(`service_breakage_invalid_amount:${unredeemedAmountCents}`);
  }
  if (
    !Number.isInteger(franchisorBreakageBps) ||
    !Number.isInteger(franchiseeBreakageBps) ||
    franchisorBreakageBps < 0 ||
    franchiseeBreakageBps < 0 ||
    franchisorBreakageBps + franchiseeBreakageBps !== 10_000
  ) {
    throw new Error(
      `service_breakage_invalid_bps:${franchisorBreakageBps}:${franchiseeBreakageBps}`,
    );
  }
  const franchisorBreakageCents = serviceBpsShareCents(
    unredeemedAmountCents,
    franchisorBreakageBps,
  );
  return {
    franchisorBreakageCents,
    franchiseeBreakageCents: unredeemedAmountCents - franchisorBreakageCents,
  };
}

/**
 * THE WEIGHTED SPLIT (largest-remainder exact) — a pot divides across the
 * routing legs' bps shares: each leg floors pot × weight / 10000, then
 * the leftover dust distributes one cent at a time to the legs with the
 * largest fractional remainders (ties break by the legs' registration
 * order). The legs' allocated shares conserve the pot EXACTLY — the
 * identity the rebate application pins.
 */
export function weightedSplitCents(input: {
  potCents: number;
  legs: readonly { key: string; weightBps: number }[];
}): { keys: string[]; allocated: number[] } {
  const { potCents, legs } = input;
  if (!Number.isInteger(potCents) || potCents < 0) {
    throw new Error(`service_weighted_split_invalid_pot:${potCents}`);
  }
  if (legs.length === 0) {
    throw new Error("service_weighted_split_no_legs");
  }
  // Floor every leg, track its fractional remainder, then distribute the
  // dust largest-remainder-first (ties by registration order).
  const floored = legs.map((leg, index) => {
    const exact = (potCents * leg.weightBps) / 10_000;
    return { index, key: leg.key, allocated: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const dust = potCents - floored.reduce((sum, leg) => sum + leg.allocated, 0);
  const byRemainder = [...floored].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let index = 0; index < dust; index += 1) {
    const leg = byRemainder[index % byRemainder.length] as { allocated: number };
    leg.allocated += 1;
  }
  return {
    keys: floored.map((leg) => leg.key),
    allocated: floored.map((leg) => leg.allocated),
  };
}

/**
 * The distributor rebate's proportional routing — the purchasing
 * location's waterfall of record proportionates the volume kickback
 * (largest-remainder exact; the routing conserves the rebate exactly).
 */
export function rebateProportionalRoutingCents(input: {
  volumeRebateCents: number;
  legs: readonly ServiceRebateWaterfallLeg[];
}): { legs: ServiceRebateRoutingLeg[]; routedTotalCents: number } {
  const split = weightedSplitCents({
    potCents: input.volumeRebateCents,
    legs: input.legs.map((leg) => ({ key: leg.ledger_id, weightBps: leg.weight_bps })),
  });
  const routingLegs: ServiceRebateRoutingLeg[] = input.legs.map((leg, index) => ({
    ledger_id: leg.ledger_id,
    weight_bps: leg.weight_bps,
    routed_cents: split.allocated[index] ?? 0,
  }));
  const routedTotalCents = routingLegs.reduce((sum, leg) => sum + leg.routed_cents, 0);
  if (routedTotalCents !== input.volumeRebateCents) {
    throw new Error(
      `service_rebate_routing_not_conserving:${routedTotalCents} != ${input.volumeRebateCents}`,
    );
  }
  return { legs: routingLegs, routedTotalCents };
}

/**
 * THE BOOTH-LEASE SPLIT — the hybrid salon's two isolated legs: the
 * weekly flat chair rent routes EXACT to the studio owner (never
 * commissioned — the isolation the brief pins) and the retail product
 * sale routes its floored commission (never the flat rent):
 *
 *   chair_rent        → studio owner = the payment, exact
 *   retail_commission → studio owner = floor(sale × bps / 10000)
 *
 * A basis below zero is hostile upstream; this function never sees one.
 */
export function boothLeaseSplitCents(input: {
  legKind: ServiceBoothLeaseLegKind;
  grossCents: number;
  retailCommissionBps: number;
}): { studioOwnerCents: number } {
  const { legKind, grossCents, retailCommissionBps } = input;
  if (!Number.isInteger(grossCents) || grossCents < 0) {
    throw new Error(`service_booth_lease_invalid_gross:${grossCents}`);
  }
  if (
    !Number.isInteger(retailCommissionBps) ||
    retailCommissionBps < 0 ||
    retailCommissionBps > 10_000
  ) {
    throw new Error(`service_booth_lease_invalid_bps:${retailCommissionBps}`);
  }
  if (legKind === "chair_rent") {
    // THE ISOLATION — the flat rent routes exact; no commission math
    // ever touches it.
    return { studioOwnerCents: grossCents };
  }
  return { studioOwnerCents: serviceBpsShareCents(grossCents, retailCommissionBps) };
}
