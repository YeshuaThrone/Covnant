/**
 * CVT recon worker — the AGBOR box office lane's ingestion profiles (PR 30,
 * the founder live-theater/touring/comedy directive).
 *
 * Four strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value vocabularies, whole-file rejection
 * on any violation. No industry CSV standard exists for venue settlement
 * reports — every ticketing platform ships a different layout, so each
 * profile defines ONE strict layout and the profile is the contract, pinned
 * by tests (the books/webtoon/merch/art precedent). A permissive guesser is
 * the silent-misparse behavior the recon engine exists to prevent:
 *
 *   theatrical_axs_settlement_csv          — AXS settlement sheets.
 *   theatrical_ticketmaster_settlement_csv — Ticketmaster settlement sheets.
 *   theatrical_eventbrite_payout_csv       — Eventbrite payout reports.
 *   theatrical_venuepos_settlement_csv     — VenuePOS settlement dumps.
 *
 * All four normalize onto the same stop legs: GBOR, the four AGBOR
 * deduction legs (local sales taxes, credit card processing fees, facility
 * maintenance and FF&E fees, group sales discounts), the venue expense and
 * the local promoter expense cap, keyed on the reconciliation triple
 * (Production ID, Venue ID, Show Date) with the sender's settlement id of
 * record. The city/market column is the stop's provenance (city-specific
 * facility fees ride the facility leg itself).
 *
 * Rights separation: theatrical lines are rights_type 'unknown' — box
 * office revenue is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math (the
 * film/books/art precedent). tier_level is null and statement_source_type
 * is null (the art lane's precedent — 'theatrical_box_office' is the FILM
 * lane's source vocabulary, and live-event settlement must never confuse
 * with it); the Production ID / Venue ID / Show Date columns populate the
 * addendum 11 columns the queue writer writes.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * positive GBOR, non-negative deduction/expense legs, ISO show dates,
 * ISO alpha-3 currencies, and the YYYY-MM period buckets derived from the
 * ISO settlement date cells.
 */

import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  validateTheatricalGborMicros,
  validateTheatricalNonNegativeMicros,
  validateTheatricalShowDate,
  validateTheatricalCurrency,
  type TheatricalStopLegsMicros,
  type TheatricalSenderCode,
} from "./theatrical";
import { StatementParseError } from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import type {
  ParsedStatementLine,
  StatementProfile,
  TheatricalLineDetail,
} from "./records";

const CSV = ",";

/** The theatrical lane's rights family — neither recording nor composition. */
const THEATRICAL_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The theatrical lane carries no statement_source_type — the profile and
 * the addendum 11 triple are the discriminator (the art lane's precedent;
 * the FILM lane owns 'theatrical_box_office'). */
const THEATRICAL_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** Money wrapper — attributes rejections to the column and row. */
function moneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): { micros: bigint; negative: boolean } {
  const cell = requiredCell(values, column, rowNumber);
  try {
    return parseStatementMoney(cell);
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw new StatementParseError(`${error.reason}:${column}:row_${rowNumber}`);
    }
    throw error;
  }
}

/**
 * A non-negative money cell — deduction legs, venue expenses, and expense
 * caps can be zero (a comped stop, no promoter cap) but never negative;
 * a negative cell in a settlement sheet is a hostile row in this lane.
 */
function nonNegativeMoneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): bigint {
  const money = moneyCell(values, column, rowNumber);
  if (money.negative) {
    throw new StatementParseError(
      `negative_money:${column}:${(values.get(column) ?? "").trim()}:row_${rowNumber}`,
    );
  }
  try {
    validateTheatricalNonNegativeMicros(money.micros, column, rowNumber);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new StatementParseError(`${error.message}`);
    }
    throw error;
  }
  return money.micros;
}

/** A positive money cell — GBOR is the stop's gross; zero is hostile. */
function positiveMoneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): bigint {
  const money = moneyCell(values, column, rowNumber);
  if (money.negative || money.micros <= 0n) {
    throw new StatementParseError(
      `invalid_money:${column}:${(values.get(column) ?? "").trim()}:row_${rowNumber}`,
    );
  }
  try {
    validateTheatricalGborMicros(money.micros, rowNumber);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new StatementParseError(`${error.message}`);
    }
    throw error;
  }
  return money.micros;
}

/** The settlement month's YYYY-MM bucket derived from an ISO date cell. */
function periodFromDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell)) {
    throw new StatementParseError(`invalid_date:${column}:${cell}:row_${rowNumber}`);
  }
  return cell.slice(0, 7);
}

/** A required identifier cell (production/venue/settlement ids). */
function idCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  return requiredCell(values, column, rowNumber);
}

/** Currency cell — ISO alpha-3, validated (the art lane's validator). */
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

/** The ISO show date cell — validated (the reconciliation triple's date leg). */
function showDateCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number): string {
  const cell = requiredCell(values, column, rowNumber).slice(0, 10);
  try {
    return validateTheatricalShowDate(cell, rowNumber);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new StatementParseError(`${error.message}`);
    }
    throw error;
  }
}

/**
 * Assembles one theatrical line. grossMicros is the stop's GBOR — the
 * row's reported gross box office receipts; the deduction legs ride the
 * detail verbatim as exact micros text.
 */
function theatricalLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  gborMicros: bigint,
  detail: TheatricalLineDetail,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: THEATRICAL_RIGHTS_TYPE,
    statementSourceType: THEATRICAL_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the books/art precedent; the column only
    // carries the four music/DSP pipelines and the split engines never read
    // it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency,
    grossMicros: gborMicros,
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    territory: null,
    platform: detail.sender,
    usageNote: theatricalUsageNote(detail),
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
    theatricalDetail: detail,
  };
}

/** The usage note — provenance naming the stop and its settlement identity. */
function theatricalUsageNote(detail: TheatricalLineDetail): string {
  return (
    `agbor box office settlement — ${detail.sender} settlement ${detail.settlementId}` +
    `, production ${detail.productionId}, venue ${detail.venueId}, show ${detail.showDate}` +
    `, city ${detail.city}, gbor ${detail.gborMicros} micros`
  );
}

/**
 * One sender's settlement row → the normalized stop legs + detail. The four
 * senders' columns map by name; the validation and the derived identity are
 * shared — one lane, four layouts.
 */
function parseSettlementRow(
  profile: StatementProfile["kind"],
  sender: TheatricalSenderCode,
  headers: readonly string[],
  columns: {
    settlementDate: string;
    settlementId: string;
    showDate: string;
    city: string;
    gbor: string;
    salesTax: string;
    cardFees: string;
    facilityFee: string;
    ffeFee: string;
    groupDiscount: string;
    venueExpense: string;
    promoterExpenseCap: string;
  },
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): ParsedStatementLine {
  const settlementId = idCell(values, columns.settlementId, rowNumber);
  const productionId = idCell(values, "Production ID", rowNumber);
  const venueId = idCell(values, "Venue ID", rowNumber);
  const showDate = showDateCell(values, columns.showDate, rowNumber);
  const city = idCell(values, columns.city, rowNumber);
  const gborMicros = positiveMoneyCell(values, columns.gbor, rowNumber);
  const salesTaxMicros = nonNegativeMoneyCell(values, columns.salesTax, rowNumber);
  const cardProcessingMicros = nonNegativeMoneyCell(values, columns.cardFees, rowNumber);
  const facilityMaintenanceMicros = nonNegativeMoneyCell(values, columns.facilityFee, rowNumber);
  const ffeMicros = nonNegativeMoneyCell(values, columns.ffeFee, rowNumber);
  const groupDiscountMicros = nonNegativeMoneyCell(values, columns.groupDiscount, rowNumber);
  const venueExpenseMicros = nonNegativeMoneyCell(values, columns.venueExpense, rowNumber);
  const promoterExpenseCapMicros = nonNegativeMoneyCell(
    values,
    columns.promoterExpenseCap,
    rowNumber,
  );
  const currency = currencyCell(values, rowNumber);
  const period = periodFromDateCell(values, columns.settlementDate, rowNumber);

  const detail: TheatricalLineDetail = {
    sender,
    productionId,
    venueId,
    showDate,
    settlementId,
    city,
    gborMicros: gborMicros.toString(),
    salesTaxMicros: salesTaxMicros.toString(),
    cardProcessingMicros: cardProcessingMicros.toString(),
    facilityMaintenanceMicros: facilityMaintenanceMicros.toString(),
    ffeMicros: ffeMicros.toString(),
    groupDiscountMicros: groupDiscountMicros.toString(),
    venueExpenseMicros: venueExpenseMicros.toString(),
    promoterExpenseCapMicros: promoterExpenseCapMicros.toString(),
    period,
  };

  return theatricalLine(
    profile,
    rowNumber,
    currency,
    gborMicros,
    detail,
    headers.map((column) => values.get(column) ?? ""),
  );
}

// ---------------------------------------------------------------------------
// AXS settlement sheets.
// ---------------------------------------------------------------------------

const AXS_SETTLEMENT_HEADER = [
  "Settlement Date",
  "Settlement ID",
  "Production ID",
  "Venue ID",
  "Show Date",
  "City",
  "Gross Box Office Receipts",
  "Local Sales Tax",
  "Card Processing Fees",
  "Facility Maintenance Fee",
  "FFE Fee",
  "Group Sales Discount",
  "Venue Expenses",
  "Promoter Expense Cap",
  "Currency",
] as const;

const axsSettlementProfile: StatementProfile = {
  kind: "theatrical_axs_settlement_csv",
  title: "AXS settlement sheet CSV (one row per stop's settlement)",
  laneRightsType: THEATRICAL_RIGHTS_TYPE,
  statementSourceType: THEATRICAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, AXS_SETTLEMENT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, AXS_SETTLEMENT_HEADER);
    return rows.map((values, index) =>
      parseSettlementRow(
        "theatrical_axs_settlement_csv",
        "axs",
        AXS_SETTLEMENT_HEADER,
        {
          settlementDate: "Settlement Date",
          settlementId: "Settlement ID",
          showDate: "Show Date",
          city: "City",
          gbor: "Gross Box Office Receipts",
          salesTax: "Local Sales Tax",
          cardFees: "Card Processing Fees",
          facilityFee: "Facility Maintenance Fee",
          ffeFee: "FFE Fee",
          groupDiscount: "Group Sales Discount",
          venueExpense: "Venue Expenses",
          promoterExpenseCap: "Promoter Expense Cap",
        },
        values,
        index + 1,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// Ticketmaster settlement sheets.
// ---------------------------------------------------------------------------

const TICKETMASTER_SETTLEMENT_HEADER = [
  "Settlement Date",
  "TM Settlement ID",
  "Production ID",
  "Venue ID",
  "Event Date",
  "Market",
  "GBOR",
  "Sales Tax",
  "CC Fees",
  "Facility Fee",
  "FFE Fee",
  "Group Discount",
  "Promoter Expenses",
  "Expense Cap",
  "Currency",
] as const;

const ticketmasterSettlementProfile: StatementProfile = {
  kind: "theatrical_ticketmaster_settlement_csv",
  title: "Ticketmaster settlement sheet CSV (one row per stop's settlement)",
  laneRightsType: THEATRICAL_RIGHTS_TYPE,
  statementSourceType: THEATRICAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, TICKETMASTER_SETTLEMENT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, TICKETMASTER_SETTLEMENT_HEADER);
    return rows.map((values, index) =>
      parseSettlementRow(
        "theatrical_ticketmaster_settlement_csv",
        "ticketmaster",
        TICKETMASTER_SETTLEMENT_HEADER,
        {
          settlementDate: "Settlement Date",
          settlementId: "TM Settlement ID",
          showDate: "Event Date",
          city: "Market",
          gbor: "GBOR",
          salesTax: "Sales Tax",
          cardFees: "CC Fees",
          facilityFee: "Facility Fee",
          ffeFee: "FFE Fee",
          groupDiscount: "Group Discount",
          venueExpense: "Promoter Expenses",
          promoterExpenseCap: "Expense Cap",
        },
        values,
        index + 1,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// Eventbrite payout reports.
// ---------------------------------------------------------------------------

const EVENTBRITE_PAYOUT_HEADER = [
  "Payout Date",
  "Payout ID",
  "Production ID",
  "Venue ID",
  "Show Date",
  "City",
  "Gross Sales",
  "Sales Tax",
  "Processing Fees",
  "Venue Fees",
  "FFE Fee",
  "Discounts",
  "Event Expenses",
  "Expense Cap",
  "Currency",
] as const;

const eventbritePayoutProfile: StatementProfile = {
  kind: "theatrical_eventbrite_payout_csv",
  title: "Eventbrite payout report CSV (one row per stop's settlement)",
  laneRightsType: THEATRICAL_RIGHTS_TYPE,
  statementSourceType: THEATRICAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, EVENTBRITE_PAYOUT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, EVENTBRITE_PAYOUT_HEADER);
    return rows.map((values, index) =>
      parseSettlementRow(
        "theatrical_eventbrite_payout_csv",
        "eventbrite",
        EVENTBRITE_PAYOUT_HEADER,
        {
          settlementDate: "Payout Date",
          settlementId: "Payout ID",
          showDate: "Show Date",
          city: "City",
          gbor: "Gross Sales",
          salesTax: "Sales Tax",
          cardFees: "Processing Fees",
          facilityFee: "Venue Fees",
          ffeFee: "FFE Fee",
          groupDiscount: "Discounts",
          venueExpense: "Event Expenses",
          promoterExpenseCap: "Expense Cap",
        },
        values,
        index + 1,
      ),
    );
  },
};

// ---------------------------------------------------------------------------
// VenuePOS settlement dumps.
// ---------------------------------------------------------------------------

const VENUEPOS_SETTLEMENT_HEADER = [
  "Report Date",
  "Report ID",
  "Production ID",
  "Venue ID",
  "Performance Date",
  "Location",
  "Total Gross",
  "Tax Total",
  "Card Fees",
  "Facility Maintenance",
  "FFE Fees",
  "Group Discount Total",
  "Settlement Expenses",
  "Expense Cap",
  "Currency",
] as const;

const venueposSettlementProfile: StatementProfile = {
  kind: "theatrical_venuepos_settlement_csv",
  title: "VenuePOS settlement dump CSV (one row per stop's settlement)",
  laneRightsType: THEATRICAL_RIGHTS_TYPE,
  statementSourceType: THEATRICAL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, VENUEPOS_SETTLEMENT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, VENUEPOS_SETTLEMENT_HEADER);
    return rows.map((values, index) =>
      parseSettlementRow(
        "theatrical_venuepos_settlement_csv",
        "venuepos",
        VENUEPOS_SETTLEMENT_HEADER,
        {
          settlementDate: "Report Date",
          settlementId: "Report ID",
          showDate: "Performance Date",
          city: "Location",
          gbor: "Total Gross",
          salesTax: "Tax Total",
          cardFees: "Card Fees",
          facilityFee: "Facility Maintenance",
          ffeFee: "FFE Fees",
          groupDiscount: "Group Discount Total",
          venueExpense: "Settlement Expenses",
          promoterExpenseCap: "Expense Cap",
        },
        values,
        index + 1,
      ),
    );
  },
};

/** The theatrical lane's profiles — dispatched through the shared dispatcher. */
export const THEATRICAL_PROFILES: readonly StatementProfile[] = [
  axsSettlementProfile,
  ticketmasterSettlementProfile,
  eventbritePayoutProfile,
  venueposSettlementProfile,
];

/** True when a dispatched profile is the theatrical lane's. */
export function isTheatricalProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "theatrical_axs_settlement_csv" ||
    kind === "theatrical_ticketmaster_settlement_csv" ||
    kind === "theatrical_eventbrite_payout_csv" ||
    kind === "theatrical_venuepos_settlement_csv"
  );
}

/**
 * The theatrical lane's legs from a parsed line — the queue writer's
 * extraction. The line's gross is GBOR; the deduction legs ride the detail
 * as exact micros text.
 */
export function theatricalLegsMicros(line: ParsedStatementLine): TheatricalStopLegsMicros {
  if (line.theatricalDetail === null || line.theatricalDetail === undefined) {
    throw new StatementParseError("theatrical_line_missing_detail");
  }
  const detail = line.theatricalDetail;
  return {
    gborMicros: BigInt(detail.gborMicros),
    salesTaxMicros: BigInt(detail.salesTaxMicros),
    cardProcessingMicros: BigInt(detail.cardProcessingMicros),
    facilityMaintenanceMicros: BigInt(detail.facilityMaintenanceMicros),
    ffeMicros: BigInt(detail.ffeMicros),
    groupDiscountMicros: BigInt(detail.groupDiscountMicros),
  };
}
