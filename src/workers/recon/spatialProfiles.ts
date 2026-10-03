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

import { readStrictTable, parseStatementMoney, requiredCell } from "./delimited";
import { isSpatialPeriod, spatialMicrosToCents, type SpatialSenderCode } from "./spatial";
import { type SpatialZoneRowClass } from "@/modules/spatial/records";

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

export type SpatialTurnstileDetail = {
  sender: "turnstile";
  senderRowId: string;
  venueId: string;
  zoneCode: string;
  spatialFootprintSqft: number;
  period: string;
  ticketRevenueCents: number;
  merchRevenueCents: number;
  occupancyTaxCents: number;
  infrastructureCogsCents: number;
  groupTourDiscountCents: number;
  tourDiscountApproved: boolean;
  turnstileEntries: number;
};

/** Parses the turnstile ticket-scan settlement sheet — the venue's
 * settlement of record: the calculator's gross and deduction legs, the
 * approved-tour-discount gate, and the turnstile entries the throughput
 * walk advances. */
export function parseSpatialTurnstileSheet(content: string): readonly SpatialTurnstileDetail[] {
  const rows = readStrictTable(content, ",", [...TURNSTILE_HEADER]);
  return rows.map((values, index) => {
    const rowNumber = index + 2;
    const period = requiredCell(values, "Reporting Period", rowNumber);
    if (!isSpatialPeriod(period)) {
      throw new Error(`invalid_period:${period}`);
    }
    const discountApproved = requiredCell(values, "Tour Discount Approved", rowNumber);
    if (!DISCOUNT_APPROVALS.has(discountApproved)) {
      throw new Error(`invalid_discount_approval:${discountApproved}`);
    }
    const detail: SpatialTurnstileDetail = {
      sender: "turnstile",
      senderRowId: requiredCell(values, "Settlement ID", rowNumber),
      venueId: requiredCell(values, "Venue ID", rowNumber),
      zoneCode: requiredCell(values, "Zone Code", rowNumber),
      spatialFootprintSqft: parseCountCell(
        requiredCell(values, "Spatial Footprint Sqft", rowNumber),
        "Spatial Footprint Sqft",
        rowNumber,
      ),
      period,
      ticketRevenueCents: parsePositiveCents(
        requiredCell(values, "Ticket Revenue", rowNumber),
        "Ticket Revenue",
        rowNumber,
      ),
      merchRevenueCents: parsePositiveCents(
        requiredCell(values, "Merch Revenue", rowNumber),
        "Merch Revenue",
        rowNumber,
      ),
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
      tourDiscountApproved: discountApproved === "approved",
      turnstileEntries: parseCountCell(
        requiredCell(values, "Turnstile Entries", rowNumber),
        "Turnstile Entries",
        rowNumber,
      ),
    };
    return detail;
  });
}

export type SpatialPassDetail = {
  sender: "pass";
  senderRowId: string;
  venueId: string;
  zoneCode: string;
  spatialFootprintSqft: number;
  period: string;
  passType: string;
  passRevenueCents: number;
  occupancyTaxCents: number;
  infrastructureCogsCents: number;
  groupTourDiscountCents: number;
  tourDiscountApproved: boolean;
};

/** Parses the attraction pass sales sheet — the calculator's legs on pass
 * revenue (no turnstile entries: the pass sale is not a gate crossing;
 * the wristband tap is). */
export function parseSpatialPassSheet(content: string): readonly SpatialPassDetail[] {
  const rows = readStrictTable(content, ",", [...PASS_HEADER]);
  return rows.map((values, index) => {
    const rowNumber = index + 2;
    const period = requiredCell(values, "Reporting Period", rowNumber);
    if (!isSpatialPeriod(period)) {
      throw new Error(`invalid_period:${period}`);
    }
    const passType = requiredCell(values, "Pass Type", rowNumber);
    if (!PASS_TYPES.has(passType)) {
      throw new Error(`invalid_pass_type:${passType}`);
    }
    const discountApproved = requiredCell(values, "Tour Discount Approved", rowNumber);
    if (!DISCOUNT_APPROVALS.has(discountApproved)) {
      throw new Error(`invalid_discount_approval:${discountApproved}`);
    }
    const detail: SpatialPassDetail = {
      sender: "pass",
      senderRowId: requiredCell(values, "Pass ID", rowNumber),
      venueId: requiredCell(values, "Venue ID", rowNumber),
      zoneCode: requiredCell(values, "Zone Code", rowNumber),
      spatialFootprintSqft: parseCountCell(
        requiredCell(values, "Spatial Footprint Sqft", rowNumber),
        "Spatial Footprint Sqft",
        rowNumber,
      ),
      period,
      passType,
      passRevenueCents: parsePositiveCents(
        requiredCell(values, "Pass Revenue", rowNumber),
        "Pass Revenue",
        rowNumber,
      ),
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
      tourDiscountApproved: discountApproved === "approved",
    };
    return detail;
  });
}

export type SpatialZoneSaleDetail = {
  sender: "fnb" | "retail";
  rowClass: SpatialZoneRowClass;
  senderRowId: string;
  venueId: string;
  zoneCode: string;
  period: string;
  grossCents: number;
  beaconId: string | null;
};

/** Parses the food and beverage register feed — zone-keyed register sales
 * routed through the zone assignment of record. */
export function parseSpatialFnBRegisterSheet(content: string): readonly SpatialZoneSaleDetail[] {
  const rows = readStrictTable(content, ",", [...FNB_HEADER]);
  return rows.map((values, index) => {
    const rowNumber = index + 2;
    const period = requiredCell(values, "Reporting Period", rowNumber);
    if (!isSpatialPeriod(period)) {
      throw new Error(`invalid_period:${period}`);
    }
    const detail: SpatialZoneSaleDetail = {
      sender: "fnb",
      rowClass: "fnb",
      senderRowId: requiredCell(values, "Register ID", rowNumber),
      venueId: requiredCell(values, "Venue ID", rowNumber),
      zoneCode: requiredCell(values, "Zone Code", rowNumber),
      period,
      grossCents: parsePositiveCents(
        requiredCell(values, "Sales Gross", rowNumber),
        "Sales Gross",
        rowNumber,
      ),
      beaconId: null,
    };
    return detail;
  });
}

/** Parses the location-tagged retail POS log — the Beacon ID is the
 * location sensor of record the zone routing cites. */
export function parseSpatialRetailPosSheet(content: string): readonly SpatialZoneSaleDetail[] {
  const rows = readStrictTable(content, ",", [...RETAIL_HEADER]);
  return rows.map((values, index) => {
    const rowNumber = index + 2;
    const period = requiredCell(values, "Reporting Period", rowNumber);
    if (!isSpatialPeriod(period)) {
      throw new Error(`invalid_period:${period}`);
    }
    const detail: SpatialZoneSaleDetail = {
      sender: "retail",
      rowClass: "retail",
      senderRowId: requiredCell(values, "POS Log ID", rowNumber),
      venueId: requiredCell(values, "Venue ID", rowNumber),
      zoneCode: requiredCell(values, "Zone Code", rowNumber),
      period,
      grossCents: parsePositiveCents(
        requiredCell(values, "Merch Gross", rowNumber),
        "Merch Gross",
        rowNumber,
      ),
      beaconId: requiredCell(values, "Beacon ID", rowNumber),
    };
    return detail;
  });
}

export type SpatialTelemetryDetail = {
  sender: "rfid";
  senderRowId: string;
  venueId: string;
  zoneCode: string;
  period: string;
  wristbandId: string;
  sensorId: string;
  scanTime: string;
  dwellMinutes: number;
  rideSessions: number;
};

/** Parses the RFID wristband telemetry feed — the dwell minutes and ride
 * session counts the micro-royalty policy of record prices. A row that
 * registers neither a dwell nor a session is hostile (nothing to price),
 * rejected at parse. */
export function parseSpatialTelemetrySheet(content: string): readonly SpatialTelemetryDetail[] {
  const rows = readStrictTable(content, ",", [...RFID_HEADER]);
  return rows.map((values, index) => {
    const rowNumber = index + 2;
    const period = requiredCell(values, "Reporting Period", rowNumber);
    if (!isSpatialPeriod(period)) {
      throw new Error(`invalid_period:${period}`);
    }
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
      zoneCode: requiredCell(values, "Zone Code", rowNumber),
      period,
      wristbandId: requiredCell(values, "Wristband ID", rowNumber),
      sensorId: requiredCell(values, "Sensor ID", rowNumber),
      scanTime: requiredCell(values, "Scan Time", rowNumber),
      dwellMinutes,
      rideSessions,
    };
    return detail;
  });
}

export type SpatialSender = {
  code: SpatialSenderCode;
  kind:
    | "spatial_turnstile_ticket_scans_csv"
    | "spatial_attraction_pass_sales_csv"
    | "spatial_fnb_register_csv"
    | "spatial_retail_pos_csv"
    | "spatial_rfid_wristband_telemetry_csv";
  header: readonly string[];
};

/** The lane's five profiles in dispatch order — the registration the
 * profiles module spreads into the dispatcher's list. */
export const SPATIAL_SENDERS: readonly SpatialSender[] = [
  { code: "turnstile", kind: "spatial_turnstile_ticket_scans_csv", header: TURNSTILE_HEADER },
  { code: "pass", kind: "spatial_attraction_pass_sales_csv", header: PASS_HEADER },
  { code: "fnb", kind: "spatial_fnb_register_csv", header: FNB_HEADER },
  { code: "retail", kind: "spatial_retail_pos_csv", header: RETAIL_HEADER },
  { code: "rfid", kind: "spatial_rfid_wristband_telemetry_csv", header: RFID_HEADER },
];
