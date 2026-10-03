/**
 * CVT recon worker — the spatial lane's five strict ingestion profiles
 * (PR 36, the founder spatial directive): RFID wristband telemetry, venue
 * turnstile ticket scans, attraction pass sales, in-park food and beverage
 * register feeds, and location-tagged retail POS logs. Same posture as
 * every lane's strict profile — the EXACT header (order and columns),
 * every cell required (no null guesses), bounded vocabularies, whole-file
 * rejection, and the sender's own row id carried through as the event
 * identity core. Money cells convert through the house strict converter
 * (sender formatting normalized, statement micros out) and reject
 * negatives — this lane's legs are positive revenues and deductions; a
 * refund has no vocabulary here and is never guessed into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isSpatialPeriod, spatialMicrosToCents } from "./spatial";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  ParsedStatementLine,
  SpatialLineDetail,
  SpatialPassDetail,
  SpatialTelemetryDetail,
  SpatialTurnstileDetail,
  SpatialZoneSaleDetail,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The spatial lane's rights family — neither recording nor composition. */
const SPATIAL_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The spatial lane carries no statement_source_type — the profile and the
 * venue/zone keys are the discriminator (the licensing precedent). */
const SPATIAL_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const TURNSTILE_HEADER = [
  "Settlement ID",
  "Venue ID",
  "Zone Code",
  "Spatial Footprint Sqft",
  "Settlement Date",
  "Ticket Revenue",
  "Merch Revenue",
  "Occupancy Tax",
  "Infrastructure COGS",
  "Group Tour Discount",
  "Tour Discount Approved",
  "Turnstile Entries",
  "Currency",
  "Reporting Period",
] as const;

const PASS_HEADER = [
  "Pass ID",
  "Venue ID",
  "Zone Code",
  "Spatial Footprint Sqft",
  "Sale Date",
  "Pass Type",
  "Pass Revenue",
  "Occupancy Tax",
  "Infrastructure COGS",
  "Group Tour Discount",
  "Tour Discount Approved",
  "Currency",
  "Reporting Period",
] as const;

const FNB_HEADER = [
  "Register ID",
  "Venue ID",
  "Zone Code",
  "Register Date",
  "Sales Gross",
  "Currency",
  "Reporting Period",
] as const;

const RETAIL_HEADER = [
  "POS Log ID",
  "Venue ID",
  "Zone Code",
  "Sale Date",
  "Merch Gross",
  "Beacon ID",
  "Currency",
  "Reporting Period",
] as const;

const RFID_HEADER = [
  "Telemetry ID",
  "Venue ID",
  "Zone Code",
  "Wristband ID",
  "Sensor ID",
  "Scan Time",
  "Dwell Minutes",
  "Ride Sessions",
  "Currency",
  "Reporting Period",
] as const;

/** Bounded vocabularies — a cell outside its family is a row-scoped
 * rejection, never a guess. Pass types are the attraction passes of
 * record; the discount approval gate is approved-or-pending (only an
 * approved discount deducts). */
const PASS_TYPES = new Set(["single_ride", "day_pass", "season_pass", "vip_tour"]);
const DISCOUNT_APPROVALS = new Set(["approved", "pending"]);

function parsePositiveCents(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  return spatialMicrosToCents(parsed.micros);
}

function parseCountCell(cell: string, column: string, rowNumber: number): number {
  if (!/^\d+$/.test(cell)) {
    throw new Error(`invalid_count:${column}:row_${rowNumber}`);
  }
  return Number(cell);
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
  if (!isSpatialPeriod(period)) {
    throw new Error(`invalid_period:${period}`);
  }
  return period;
}

/** The tour-discount approval gate — only an approved discount deducts. */
function discountApprovalCell(values: ReadonlyMap<string, string>, rowNumber: number): boolean {
  const approval = requiredCell(values, "Tour Discount Approved", rowNumber);
  if (!DISCOUNT_APPROVALS.has(approval)) {
    throw new Error(`invalid_discount_approval:${approval}`);
  }
  return approval === "approved";
}

/**
 * The parsed line constructor — one shape for all five senders, the
 * spatial detail riding as the lane discriminator (the NIL precedent).
 * The line's gross is the row's money basis in statement micros
 * (turnstile settlement gross = ticket + merch revenue; pass sale =
 * pass revenue; zone sale = the register/POS gross; a telemetry row
 * prices no money itself — its micro-royalty is computed at walk time).
 */
function spatialLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: SpatialLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: SPATIAL_RIGHTS_TYPE,
    statementSourceType: SPATIAL_SOURCE_TYPE,
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
    usageNote: spatialUsageNote(detail),
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
    spatialDetail: detail,
  };
}

/** The usage note — provenance naming the row and its spatial keys. */
function spatialUsageNote(detail: SpatialLineDetail): string {
  return (
    `spatial revenue — ${detail.sender} row ${detail.senderRowId}` +
    `, venue ${detail.venueId}` +
    `, zone ${detail.zoneCode}`
  );
}

// ---------------------------------------------------------------------------
// Profile 1 — venue turnstile ticket scans. The settlement of record: the
// calculator's gross and deduction legs, the approved-tour-discount gate,
// and the turnstile entries the cumulative throughput walk advances.
// ---------------------------------------------------------------------------

const turnstileProfile: StatementProfile = {
  kind: "spatial_turnstile_ticket_scans_csv",
  title: "Venue turnstile ticket scan settlement CSV (one row per settlement)",
  laneRightsType: SPATIAL_RIGHTS_TYPE,
  statementSourceType: SPATIAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, TURNSTILE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...TURNSTILE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const senderRowId = requiredCell(values, "Settlement ID", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const tourDiscountApproved = discountApprovalCell(values, rowNumber);
      const ticketRevenueCents = parsePositiveCents(
        requiredCell(values, "Ticket Revenue", rowNumber),
        "Ticket Revenue",
        rowNumber,
      );
      const merchRevenueCents = parsePositiveCents(
        requiredCell(values, "Merch Revenue", rowNumber),
        "Merch Revenue",
        rowNumber,
      );
      const detail: SpatialTurnstileDetail = {
        sender: "turnstile",
        senderRowId,
        venueId: requiredCell(values, "Venue ID", rowNumber),
        currency,
        zoneCode: requiredCell(values, "Zone Code", rowNumber),
        spatialFootprintSqft: parseCountCell(
          requiredCell(values, "Spatial Footprint Sqft", rowNumber),
          "Spatial Footprint Sqft",
          rowNumber,
        ),
        period,
        ticketRevenueCents,
        merchRevenueCents,
        occupancyTaxCents: parsePositiveCents(
          requiredCell(values, "Occupancy Tax", rowNumber),
          "Occupancy Tax",
          rowNumber,
        ),
        infrastructureCogsCents: parsePositiveCents(
          requiredCell(values, "Infrastructure COGS", rowNumber),
          "Infrastructure COGS",
          rowNumber,
        ),
        groupTourDiscountCents: parsePositiveCents(
          requiredCell(values, "Group Tour Discount", rowNumber),
          "Group Tour Discount",
          rowNumber,
        ),
        tourDiscountApproved,
        turnstileEntries: parseCountCell(
          requiredCell(values, "Turnstile Entries", rowNumber),
          "Turnstile Entries",
          rowNumber,
        ),
      };
      return spatialLine(
        "spatial_turnstile_ticket_scans_csv",
        rowNumber,
        detail,
        ticketRevenueCents + merchRevenueCents,
        TURNSTILE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — attraction pass sales. The calculator's legs on pass revenue
// (no turnstile entries: the pass sale is not a gate crossing; the
// wristband tap is).
// ---------------------------------------------------------------------------

const passProfile: StatementProfile = {
  kind: "spatial_attraction_pass_sales_csv",
  title: "Attraction pass sales CSV (one row per pass sale)",
  laneRightsType: SPATIAL_RIGHTS_TYPE,
  statementSourceType: SPATIAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, PASS_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...PASS_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const passType = requiredCell(values, "Pass Type", rowNumber);
      if (!PASS_TYPES.has(passType)) {
        throw new Error(`invalid_pass_type:${passType}`);
      }
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const tourDiscountApproved = discountApprovalCell(values, rowNumber);
      const passRevenueCents = parsePositiveCents(
        requiredCell(values, "Pass Revenue", rowNumber),
        "Pass Revenue",
        rowNumber,
      );
      const detail: SpatialPassDetail = {
        sender: "pass",
        senderRowId: requiredCell(values, "Pass ID", rowNumber),
        venueId: requiredCell(values, "Venue ID", rowNumber),
        currency,
        zoneCode: requiredCell(values, "Zone Code", rowNumber),
        spatialFootprintSqft: parseCountCell(
          requiredCell(values, "Spatial Footprint Sqft", rowNumber),
          "Spatial Footprint Sqft",
          rowNumber,
        ),
        period,
        passType,
        passRevenueCents,
        occupancyTaxCents: parsePositiveCents(
          requiredCell(values, "Occupancy Tax", rowNumber),
          "Occupancy Tax",
          rowNumber,
        ),
        infrastructureCogsCents: parsePositiveCents(
          requiredCell(values, "Infrastructure COGS", rowNumber),
          "Infrastructure COGS",
          rowNumber,
        ),
        groupTourDiscountCents: parsePositiveCents(
          requiredCell(values, "Group Tour Discount", rowNumber),
          "Group Tour Discount",
          rowNumber,
        ),
        tourDiscountApproved,
      };
      return spatialLine(
        "spatial_attraction_pass_sales_csv",
        rowNumber,
        detail,
        passRevenueCents,
        PASS_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — in-park food and beverage register feeds. Zone-keyed register
// sales routed through the zone assignment of record (no beacon: the
// register id is the identity).
// ---------------------------------------------------------------------------

const fnbProfile: StatementProfile = {
  kind: "spatial_fnb_register_csv",
  title: "In-park food and beverage register feed CSV (one row per register)",
  laneRightsType: SPATIAL_RIGHTS_TYPE,
  statementSourceType: SPATIAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, FNB_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...FNB_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossCents = parsePositiveCents(
        requiredCell(values, "Sales Gross", rowNumber),
        "Sales Gross",
        rowNumber,
      );
      const detail: SpatialZoneSaleDetail = {
        sender: "fnb",
        rowClass: "fnb",
        senderRowId: requiredCell(values, "Register ID", rowNumber),
        venueId: requiredCell(values, "Venue ID", rowNumber),
        currency,
        zoneCode: requiredCell(values, "Zone Code", rowNumber),
        period,
        grossCents,
        beaconId: null,
      };
      return spatialLine(
        "spatial_fnb_register_csv",
        rowNumber,
        detail,
        grossCents,
        FNB_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — location-tagged retail POS logs. The Beacon ID is the location
// sensor of record the zone routing cites.
// ---------------------------------------------------------------------------

const retailProfile: StatementProfile = {
  kind: "spatial_retail_pos_csv",
  title: "Location-tagged retail POS log CSV (one row per POS log)",
  laneRightsType: SPATIAL_RIGHTS_TYPE,
  statementSourceType: SPATIAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, RETAIL_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...RETAIL_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossCents = parsePositiveCents(
        requiredCell(values, "Merch Gross", rowNumber),
        "Merch Gross",
        rowNumber,
      );
      const detail: SpatialZoneSaleDetail = {
        sender: "retail",
        rowClass: "retail",
        senderRowId: requiredCell(values, "POS Log ID", rowNumber),
        venueId: requiredCell(values, "Venue ID", rowNumber),
        currency,
        zoneCode: requiredCell(values, "Zone Code", rowNumber),
        period,
        grossCents,
        beaconId: requiredCell(values, "Beacon ID", rowNumber),
      };
      return spatialLine(
        "spatial_retail_pos_csv",
        rowNumber,
        detail,
        grossCents,
        RETAIL_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 5 — RFID wristband telemetry. The dwell minutes and ride session
// counts the micro-royalty policy of record prices. A row that registers
// neither a dwell nor a session is hostile (nothing to price), rejected at
// parse.
// ---------------------------------------------------------------------------

const rfidProfile: StatementProfile = {
  kind: "spatial_rfid_wristband_telemetry_csv",
  title: "RFID wristband telemetry feed CSV (one row per telemetry event)",
  laneRightsType: SPATIAL_RIGHTS_TYPE,
  statementSourceType: SPATIAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, RFID_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...RFID_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const dwellMinutes = parseCountCell(
        requiredCell(values, "Dwell Minutes", rowNumber),
        "Dwell Minutes",
        rowNumber,
      );
      const rideSessions = parseCountCell(
        requiredCell(values, "Ride Sessions", rowNumber),
        "Ride Sessions",
        rowNumber,
      );
      if (dwellMinutes === 0 && rideSessions === 0) {
        throw new Error(`telemetry_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: SpatialTelemetryDetail = {
        sender: "rfid",
        senderRowId: requiredCell(values, "Telemetry ID", rowNumber),
        venueId: requiredCell(values, "Venue ID", rowNumber),
        currency,
        zoneCode: requiredCell(values, "Zone Code", rowNumber),
        period,
        wristbandId: requiredCell(values, "Wristband ID", rowNumber),
        sensorId: requiredCell(values, "Sensor ID", rowNumber),
        scanTime: requiredCell(values, "Scan Time", rowNumber),
        dwellMinutes,
        rideSessions,
      };
      return spatialLine(
        "spatial_rfid_wristband_telemetry_csv",
        rowNumber,
        detail,
        0,
        RFID_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The spatial lane's profiles — dispatched through the shared dispatcher. */
export const SPATIAL_PROFILES: readonly StatementProfile[] = [
  turnstileProfile,
  passProfile,
  fnbProfile,
  retailProfile,
  rfidProfile,
];

/** True when a dispatched profile is the spatial lane's. */
export function isSpatialProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "spatial_turnstile_ticket_scans_csv" ||
    kind === "spatial_attraction_pass_sales_csv" ||
    kind === "spatial_fnb_register_csv" ||
    kind === "spatial_retail_pos_csv" ||
    kind === "spatial_rfid_wristband_telemetry_csv"
  );
}
