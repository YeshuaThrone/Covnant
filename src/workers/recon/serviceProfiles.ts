/**
 * CVT recon worker — the service lane's six strict ingestion profiles (PR
 * 42, the founder service directive): salon and spa POS ticket streams
 * (Mindbody, Boulevard, Zenoti, Square), the membership billing logs'
 * redemption and breakage layouts, hotel guest room folio charges, bulk
 * backbar distributor rebate statements (L'Oréal, Estée Lauder), and the
 * hybrid salon's booth-lease ledger. Same posture as every lane's strict
 * profile — the EXACT header (order and columns), every cell required (no
 * null guesses), bounded vocabularies, whole-file rejection, and the
 * sender's own row id carried through as the event identity core. The
 * treatment senders repeat the identity columns the directive keys the
 * lane on — Stylist ID, Protocol ID, and Salon Location ID — the
 * membership rows key on the member and the home location, the hotel
 * folio rows add the hotel's own location id as provenance, and the
 * rebate statement routes by location, so it repeats Stylist/Protocol-free
 * (the food rebate precedent). Money cells convert through the house
 * strict converter (sender formatting normalized, statement micros out)
 * and reject negatives — this lane's legs are positive sales, fees,
 * deductions, and kickbacks; a refund has no vocabulary here and is never
 * guessed into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isServicePeriod } from "./service";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  ParsedStatementLine,
  ServiceBoothLeaseDetail,
  ServiceHotelFolioDetail,
  ServiceLineDetail,
  ServiceMembershipBreakageDetail,
  ServiceMembershipRedemptionDetail,
  ServicePosTicketDetail,
  ServiceVendorRebateDetail,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The service lane's rights family — neither recording nor composition. */
const SERVICE_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The service lane carries no statement_source_type — the profile and the
 * stylist/protocol/location keys are the discriminator (the fitness
 * precedent). */
const SERVICE_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const POS_TICKET_HEADER = [
  "Ticket ID",
  "Platform",
  "Stylist ID",
  "Protocol ID",
  "Salon Location ID",
  "Gross Service Ticket",
  "Backbar Product COGS",
  "Card Processing Engine Cut",
  "Service and Sales Taxes",
  "Currency",
  "Reporting Period",
] as const;

const REDEMPTION_HEADER = [
  "Redemption ID",
  "Member ID",
  "Home Location ID",
  "Visiting Location ID",
  "Service Allocation Fee",
  "Currency",
  "Reporting Period",
] as const;

const BREAKAGE_HEADER = [
  "Breakage ID",
  "Member ID",
  "Home Location ID",
  "Unredeemed Amount",
  "Currency",
  "Reporting Period",
] as const;

const HOTEL_FOLIO_HEADER = [
  "Folio Charge ID",
  "Hotel Location ID",
  "Stylist ID",
  "Protocol ID",
  "Salon Location ID",
  "Gross Service Charge",
  "Backbar Product COGS",
  "Card Processing Engine Cut",
  "Service and Sales Taxes",
  "Currency",
  "Reporting Period",
] as const;

const REBATE_HEADER = [
  "Rebate ID",
  "Distributor",
  "Salon Location ID",
  "Rebate Basis Purchases",
  "Volume Rebate Amount",
  "Currency",
  "Reporting Period",
] as const;

const BOOTH_LEASE_HEADER = [
  "Entry ID",
  "Salon Location ID",
  "Entry Kind",
  "Amount",
  "Currency",
  "Reporting Period",
] as const;

/** Bounded vocabularies — a cell outside its family is a row-scoped
 * rejection, never a guess. The POS platforms are the directive's four
 * salon/spa ticket streams; the bulk backbar distributors are the
 * directive's named rebate programs; the booth-lease entry kinds are the
 * hybrid salon's two isolated ledger rows. */
const SERVICE_POS_PLATFORMS = new Set(["mindbody", "boulevard", "zenoti", "square"]);
const SERVICE_DISTRIBUTORS = new Set(["loreal", "estee_lauder"]);
const SERVICE_BOOTH_ENTRY_KINDS = new Set(["chair_rent", "retail_sale"]);

function parsePositiveCents(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  // 1 dollar = 1e8 statement micros; 1e6 micros per cent (the house
  // fixed-point discipline).
  return Number(parsed.micros / 1_000_000n);
}

/** The row's ISO currency of record — validated through the house
 * alpha-3 shape (the NIL precedent), rejections row-scoped. */
function currencyCell(values: ReadonlyMap<string, string>, rowNumber: number): string {
  const currency = requiredCell(values, "Currency", rowNumber).toUpperCase();
  try {
    return validateTheatricalCurrency(currency, rowNumber);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new StatementParseError(`${error.message}`);
    }
    throw error;
  }
}

/** The reporting period cell — validated at parse (the walk re-checks). */
function periodCell(values: ReadonlyMap<string, string>, rowNumber: number): string {
  const period = requiredCell(values, "Reporting Period", rowNumber);
  if (!isServicePeriod(period)) {
    throw new Error(`invalid_period:${period}`);
  }
  return period;
}

/** The bounded-vocabulary gate cells — never a truthy guess. */
function vocabularyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  vocabulary: ReadonlySet<string>,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber).toLowerCase();
  if (!vocabulary.has(cell)) {
    throw new Error(`invalid_vocabulary:${column}:${cell}`);
  }
  return cell;
}

/**
 * The parsed line constructor — one shape for all six senders, the
 * service detail riding as the lane discriminator (the food precedent).
 * The line's gross is the row's money basis in statement micros (POS
 * tickets = the gross service ticket; hotel folios = the gross service
 * charge; redemptions = the service allocation fee; breakage rows = the
 * unredeemed amount; rebate rows = the volume kickback; booth-lease rows
 * = the rent payment or the retail sale).
 */
function serviceLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: ServiceLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: SERVICE_RIGHTS_TYPE,
    statementSourceType: SERVICE_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the licensing precedent; the column only
    // carries the four music/DSP pipelines and the split engines never read
    // it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency: detail.currency,
    // The house fixed-point discipline (records.ts): 1e-8 micros per
    // dollar — 1e6 micros per cent. Derived from the same cents the
    // detail carries so the line and its detail can never drift.
    grossMicros: BigInt(grossCents) * 1_000_000n,
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    territory: null,
    platform: detail.sender,
    usageNote: serviceUsageNote(detail),
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
    bookDetail: null,
    artDetail: null,
    theatricalDetail: null,
    licensingDetail: null,
    nilDetail: null,
    spatialDetail: null,
    fitnessDetail: null,
    foodDetail: null,
    serviceDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's
 * identity keys. */
function serviceUsageNote(detail: ServiceLineDetail): string {
  switch (detail.sender) {
    case "pos_ticket":
      return `service revenue — pos_ticket row ${detail.senderRowId}, platform ${detail.platform}, stylist ${detail.stylistId}, protocol ${detail.protocolId}, location ${detail.salonLocationId}`;
    case "hotel_folio":
      return `service revenue — hotel_folio row ${detail.senderRowId}, hotel ${detail.hotelLocationId}, stylist ${detail.stylistId}, protocol ${detail.protocolId}, location ${detail.salonLocationId}`;
    case "membership_redemption":
      return `service revenue — membership_redemption row ${detail.senderRowId}, member ${detail.memberId}, home ${detail.homeLocationId}, visiting ${detail.visitingLocationId}`;
    case "membership_breakage":
      return `service revenue — membership_breakage row ${detail.senderRowId}, member ${detail.memberId}, home ${detail.homeLocationId}`;
    case "vendor_rebate":
      return `service revenue — vendor_rebate row ${detail.senderRowId}, distributor ${detail.distributor}, location ${detail.salonLocationId}`;
    case "booth_lease":
      return `service revenue — booth_lease row ${detail.senderRowId}, location ${detail.salonLocationId}, entry ${detail.entryKind}`;
  }
}

// ---------------------------------------------------------------------------
// Profile 1 — salon and spa POS ticket streams (Mindbody, Boulevard,
// Zenoti, Square). The four money legs the Net Service Realization
// calculator consumes; the identity columns the directive keys the lane
// on.
// ---------------------------------------------------------------------------

const posTicketProfile: StatementProfile = {
  kind: "service_pos_tickets_csv",
  title: "Salon/spa POS ticket stream CSV (one row per service ticket)",
  laneRightsType: SERVICE_RIGHTS_TYPE,
  statementSourceType: SERVICE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, POS_TICKET_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...POS_TICKET_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const platform = vocabularyCell(values, "Platform", SERVICE_POS_PLATFORMS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossServiceTicketCents = parsePositiveCents(
        requiredCell(values, "Gross Service Ticket", rowNumber),
        "Gross Service Ticket",
        rowNumber,
      );
      if (grossServiceTicketCents === 0) {
        throw new Error(`service_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: ServicePosTicketDetail = {
        sender: "pos_ticket",
        senderRowId: requiredCell(values, "Ticket ID", rowNumber),
        platform: platform as ServicePosTicketDetail["platform"],
        stylistId: requiredCell(values, "Stylist ID", rowNumber),
        protocolId: requiredCell(values, "Protocol ID", rowNumber),
        salonLocationId: requiredCell(values, "Salon Location ID", rowNumber),
        period,
        currency,
        grossServiceTicketCents,
        backbarProductCogsCents: parsePositiveCents(
          requiredCell(values, "Backbar Product COGS", rowNumber),
          "Backbar Product COGS",
          rowNumber,
        ),
        cardProcessingEngineCutCents: parsePositiveCents(
          requiredCell(values, "Card Processing Engine Cut", rowNumber),
          "Card Processing Engine Cut",
          rowNumber,
        ),
        serviceSalesTaxesCents: parsePositiveCents(
          requiredCell(values, "Service and Sales Taxes", rowNumber),
          "Service and Sales Taxes",
          rowNumber,
        ),
      };
      return serviceLine(
        "service_pos_tickets_csv",
        rowNumber,
        detail,
        grossServiceTicketCents,
        POS_TICKET_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — the membership billing logs' redemption layout. The service
// allocation fee a member enrolled at one location spends redeeming a
// monthly service at another.
// ---------------------------------------------------------------------------

const redemptionProfile: StatementProfile = {
  kind: "service_membership_redemptions_csv",
  title: "Membership billing redemption log CSV (one row per cross-location redemption)",
  laneRightsType: SERVICE_RIGHTS_TYPE,
  statementSourceType: SERVICE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, REDEMPTION_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...REDEMPTION_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const homeLocationId = requiredCell(values, "Home Location ID", rowNumber);
      const visitingLocationId = requiredCell(values, "Visiting Location ID", rowNumber);
      if (homeLocationId === visitingLocationId) {
        // The cross-location split prices a visiting location's share; a
        // same-location redemption has no visiting leg — a row-scoped
        // rejection, never a guessed route.
        throw new Error(`redemption_location_collision:row_${rowNumber}`);
      }
      const serviceAllocationFeeCents = parsePositiveCents(
        requiredCell(values, "Service Allocation Fee", rowNumber),
        "Service Allocation Fee",
        rowNumber,
      );
      if (serviceAllocationFeeCents === 0) {
        throw new Error(`service_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: ServiceMembershipRedemptionDetail = {
        sender: "membership_redemption",
        senderRowId: requiredCell(values, "Redemption ID", rowNumber),
        memberId: requiredCell(values, "Member ID", rowNumber),
        homeLocationId,
        visitingLocationId,
        period,
        currency,
        serviceAllocationFeeCents,
      };
      return serviceLine(
        "service_membership_redemptions_csv",
        rowNumber,
        detail,
        serviceAllocationFeeCents,
        REDEMPTION_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — the membership billing logs' breakage layout. The unredeemed
// monthly subscription funds the contractual breakage rules allocate.
// ---------------------------------------------------------------------------

const breakageProfile: StatementProfile = {
  kind: "service_membership_breakage_csv",
  title: "Membership billing breakage log CSV (one row per unredeemed-funds event)",
  laneRightsType: SERVICE_RIGHTS_TYPE,
  statementSourceType: SERVICE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, BREAKAGE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...BREAKAGE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const unredeemedAmountCents = parsePositiveCents(
        requiredCell(values, "Unredeemed Amount", rowNumber),
        "Unredeemed Amount",
        rowNumber,
      );
      if (unredeemedAmountCents === 0) {
        // Nothing unredeemed allocates nothing — the row prices nothing,
        // a row-scoped rejection.
        throw new Error(`service_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: ServiceMembershipBreakageDetail = {
        sender: "membership_breakage",
        senderRowId: requiredCell(values, "Breakage ID", rowNumber),
        memberId: requiredCell(values, "Member ID", rowNumber),
        homeLocationId: requiredCell(values, "Home Location ID", rowNumber),
        period,
        currency,
        unredeemedAmountCents,
      };
      return serviceLine(
        "service_membership_breakage_csv",
        rowNumber,
        detail,
        unredeemedAmountCents,
        BREAKAGE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — hotel guest room folio charges. The hotel's own location id
// rides as provenance; the franchised salon/spa location inside the hotel
// is the walks' key.
// ---------------------------------------------------------------------------

const hotelFolioProfile: StatementProfile = {
  kind: "service_hotel_folio_charges_csv",
  title: "Hotel guest room folio charge CSV (one row per salon/spa folio charge)",
  laneRightsType: SERVICE_RIGHTS_TYPE,
  statementSourceType: SERVICE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, HOTEL_FOLIO_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...HOTEL_FOLIO_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossServiceChargeCents = parsePositiveCents(
        requiredCell(values, "Gross Service Charge", rowNumber),
        "Gross Service Charge",
        rowNumber,
      );
      if (grossServiceChargeCents === 0) {
        throw new Error(`service_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: ServiceHotelFolioDetail = {
        sender: "hotel_folio",
        senderRowId: requiredCell(values, "Folio Charge ID", rowNumber),
        hotelLocationId: requiredCell(values, "Hotel Location ID", rowNumber),
        stylistId: requiredCell(values, "Stylist ID", rowNumber),
        protocolId: requiredCell(values, "Protocol ID", rowNumber),
        salonLocationId: requiredCell(values, "Salon Location ID", rowNumber),
        period,
        currency,
        grossServiceChargeCents,
        backbarProductCogsCents: parsePositiveCents(
          requiredCell(values, "Backbar Product COGS", rowNumber),
          "Backbar Product COGS",
          rowNumber,
        ),
        cardProcessingEngineCutCents: parsePositiveCents(
          requiredCell(values, "Card Processing Engine Cut", rowNumber),
          "Card Processing Engine Cut",
          rowNumber,
        ),
        serviceSalesTaxesCents: parsePositiveCents(
          requiredCell(values, "Service and Sales Taxes", rowNumber),
          "Service and Sales Taxes",
          rowNumber,
        ),
      };
      return serviceLine(
        "service_hotel_folio_charges_csv",
        rowNumber,
        detail,
        grossServiceChargeCents,
        HOTEL_FOLIO_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 5 — bulk backbar distributor rebate statements (L'Oréal, Estée
// Lauder). The purchasing location is the routing key, so the row repeats
// Stylist/Protocol-free (the food rebate precedent).
// ---------------------------------------------------------------------------

const rebateProfile: StatementProfile = {
  kind: "service_vendor_rebates_csv",
  title: "Bulk backbar distributor rebate statement CSV (one row per volume rebate)",
  laneRightsType: SERVICE_RIGHTS_TYPE,
  statementSourceType: SERVICE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, REBATE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...REBATE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const distributor = vocabularyCell(values, "Distributor", SERVICE_DISTRIBUTORS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const rebateBasisCents = parsePositiveCents(
        requiredCell(values, "Rebate Basis Purchases", rowNumber),
        "Rebate Basis Purchases",
        rowNumber,
      );
      const volumeRebateCents = parsePositiveCents(
        requiredCell(values, "Volume Rebate Amount", rowNumber),
        "Volume Rebate Amount",
        rowNumber,
      );
      if (volumeRebateCents === 0) {
        throw new Error(`service_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: ServiceVendorRebateDetail = {
        sender: "vendor_rebate",
        senderRowId: requiredCell(values, "Rebate ID", rowNumber),
        distributor: distributor as ServiceVendorRebateDetail["distributor"],
        salonLocationId: requiredCell(values, "Salon Location ID", rowNumber),
        period,
        currency,
        rebateBasisCents,
        volumeRebateCents,
      };
      return serviceLine(
        "service_vendor_rebates_csv",
        rowNumber,
        detail,
        volumeRebateCents,
        REBATE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 6 — the hybrid salon's booth-lease ledger. The two isolated
// entry kinds: the weekly flat chair rent payment and the retail product
// sale (the retail commission computes at walk time from the policy of
// record).
// ---------------------------------------------------------------------------

const boothLeaseProfile: StatementProfile = {
  kind: "service_booth_lease_csv",
  title: "Booth-lease ledger CSV (one row per chair rent payment or retail sale)",
  laneRightsType: SERVICE_RIGHTS_TYPE,
  statementSourceType: SERVICE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, BOOTH_LEASE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...BOOTH_LEASE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const entryKind = vocabularyCell(values, "Entry Kind", SERVICE_BOOTH_ENTRY_KINDS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const amountCents = parsePositiveCents(
        requiredCell(values, "Amount", rowNumber),
        "Amount",
        rowNumber,
      );
      if (amountCents === 0) {
        throw new Error(`service_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: ServiceBoothLeaseDetail = {
        sender: "booth_lease",
        senderRowId: requiredCell(values, "Entry ID", rowNumber),
        salonLocationId: requiredCell(values, "Salon Location ID", rowNumber),
        entryKind: entryKind as ServiceBoothLeaseDetail["entryKind"],
        period,
        currency,
        amountCents,
      };
      return serviceLine(
        "service_booth_lease_csv",
        rowNumber,
        detail,
        amountCents,
        BOOTH_LEASE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The service lane's profiles — dispatched through the shared dispatcher. */
export const SERVICE_PROFILES: readonly StatementProfile[] = [
  posTicketProfile,
  redemptionProfile,
  breakageProfile,
  hotelFolioProfile,
  rebateProfile,
  boothLeaseProfile,
];

/** True when a dispatched profile is the service lane's. */
export function isServiceProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "service_pos_tickets_csv" ||
    kind === "service_membership_redemptions_csv" ||
    kind === "service_membership_breakage_csv" ||
    kind === "service_hotel_folio_charges_csv" ||
    kind === "service_vendor_rebates_csv" ||
    kind === "service_booth_lease_csv"
  );
}
