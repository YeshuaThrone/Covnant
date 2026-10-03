/**
 * CVT recon worker — the brand-licensing lane's ingestion profiles (PR 32,
 * the founder Net Sales + tiered royalties + sub-license cascade directive).
 *
 * Four strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value vocabularies, whole-file rejection
 * on any violation. No industry CSV standard exists for brand-licensing
 * royalty statements — every licensee ships a different layout, so each
 * profile defines ONE strict layout and the profile is the contract, pinned
 * by tests (the books/webtoon/merch/art/theatrical precedent). A permissive
 * guesser is the silent-misparse behavior the recon engine exists to
 * prevent:
 *
 *   licensing_retail_sales_csv     — retail sales reports (the licensee's
 *                                    retail-channel sales statement).
 *   licensing_sellthrough_log_csv  — master licensee sell-through logs.
 *   licensing_ecommerce_pos_csv    — e-commerce POS feeds.
 *   licensing_wholesale_manifest_csv — wholesale distributor manifests (the
 *                                    sub-licensee attribution rides here).
 *
 * All four normalize onto the same Net Sales legs: gross revenue and the
 * four approved deduction legs (approved trade discounts, returned goods
 * allowances, standard shipping and freight deductions, value added
 * taxes), keyed on the addendum 12 triple (License ID, Category Code,
 * Territory ISO) with the sender's row id of record.
 *
 * Rights separation: licensing lines are rights_type 'unknown' — licensed
 * merchandise revenue is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math (the
 * film/books/art/theatrical precedent). tier_level is null and
 * statement_source_type is null (the art/theatrical precedent —
 * 'theatrical_box_office' is the FILM lane's source vocabulary, and brand
 * licensing must never confuse with it); the License ID / Category Code /
 * Territory ISO columns populate the addendum 12 columns the queue writer
 * writes.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * positive gross revenue, non-negative deduction legs, ISO alpha-2
 * territory of record, ISO alpha-3 currencies, YYYY-MM periods derived
 * from ISO report-date cells — and, on the wholesale manifest, THE
 * SELF-RECONCILIATION: gross − trade discounts − returned goods −
 * shipping/freight − VAT must equal the manifest's Reported Net exactly;
 * a manifest that disagrees with its own arithmetic is rejected whole
 * (the consignment-payout precedent), never silently adjusted.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isLicensingPeriod } from "./licensing";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  LicensingLineDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The licensing lane's rights family — neither recording nor composition. */
const LICENSING_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The licensing lane carries no statement_source_type — the profile and
 * the addendum 12 triple are the discriminator (the art/theatrical
 * precedent; 'theatrical_box_office' is the FILM lane's source vocabulary). */
const LICENSING_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

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
 * A non-negative money cell — deduction legs can be zero (a clean sale, no
 * VAT territory) but never negative; a negative cell in a royalty
 * statement is a hostile row in this lane.
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
  return money.micros;
}

/** A positive money cell — gross revenue is the sale's basis; zero is hostile. */
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
  return money.micros;
}

/** The reporting month's YYYY-MM bucket derived from an ISO date cell. */
function periodFromDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell)) {
    throw new StatementParseError(`invalid_date:${column}:${cell}:row_${rowNumber}`);
  }
  const period = cell.slice(0, 7);
  if (!isLicensingPeriod(period)) {
    throw new StatementParseError(`invalid_period:${column}:${period}:row_${rowNumber}`);
  }
  return period;
}

/** A required identifier cell (license/category/territory/row ids). */
function idCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number): string {
  return requiredCell(values, column, rowNumber);
}

/** The territory of record — ISO alpha-2 uppercase (the addendum 12 leg
 * the withholding engine keys on). */
function territoryCell(values: ReadonlyMap<string, string>, rowNumber: number): string {
  const territory = requiredCell(values, "Territory ISO", rowNumber).toUpperCase();
  if (!/^[A-Z]{2}$/.test(territory)) {
    throw new StatementParseError(`invalid_territory:${territory}:row_${rowNumber}`);
  }
  return territory;
}

/** Currency cell — ISO alpha-3, validated (the shared lane validator). */
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

/**
 * Assembles one licensing line. grossMicros is the row's gross revenue —
 * the Net Sales realization's starting leg; the deduction legs ride the
 * detail verbatim as exact micros text.
 */
function licensingLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossRevenueMicros: bigint,
  detail: LicensingLineDetail,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: LICENSING_RIGHTS_TYPE,
    statementSourceType: LICENSING_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the books/art precedent; the column only
    // carries the four music/DSP pipelines and the split engines never read
    // it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency,
    grossMicros: grossRevenueMicros,
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    // The territory of record rides the line — the addendum 12 leg.
    territory: detail.territoryIso,
    platform: detail.sender,
    usageNote: licensingUsageNote(detail),
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
    licensingDetail: detail,
  };
}

/** The usage note — provenance naming the sale and its row identity. */
function licensingUsageNote(detail: LicensingLineDetail): string {
  return (
    `net licensed sales — ${detail.sender} row ${detail.senderRowId}` +
    `, license ${detail.licenseId}, category ${detail.categoryCode}, territory ${detail.territoryIso}` +
    `${detail.subLicenseeId === null ? "" : `, sub-licensee ${detail.subLicenseeId}`}` +
    `, gross ${detail.grossRevenueMicros} micros`
  );
}

/** The shared Net Sales legs every sender's row parses into — the four
 * deduction columns are named identically across all four layouts. */
function parseNetSalesLegs(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): {
  grossRevenueMicros: bigint;
  tradeDiscountMicros: bigint;
  returnedGoodsMicros: bigint;
  shippingFreightMicros: bigint;
  vatMicros: bigint;
} {
  return {
    grossRevenueMicros: positiveMoneyCell(values, "Gross Revenue", rowNumber),
    tradeDiscountMicros: nonNegativeMoneyCell(values, "Trade Discounts", rowNumber),
    returnedGoodsMicros: nonNegativeMoneyCell(values, "Returned Goods Allowance", rowNumber),
    shippingFreightMicros: nonNegativeMoneyCell(values, "Shipping Freight Deductions", rowNumber),
    vatMicros: nonNegativeMoneyCell(values, "VAT", rowNumber),
  };
}

// ---------------------------------------------------------------------------
// Retail sales reports — the licensee's retail-channel sales statement.
// ---------------------------------------------------------------------------

const RETAIL_SALES_HEADER = [
  "Report ID",
  "Report Date",
  "License ID",
  "Category Code",
  "Territory ISO",
  "Retailer",
  "Gross Revenue",
  "Trade Discounts",
  "Returned Goods Allowance",
  "Shipping Freight Deductions",
  "VAT",
  "Currency",
  "Reporting Period",
] as const;

const retailSalesProfile: StatementProfile = {
  kind: "licensing_retail_sales_csv",
  title: "Retail sales report CSV (one row per licensed retail sale)",
  laneRightsType: LICENSING_RIGHTS_TYPE,
  statementSourceType: LICENSING_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, RETAIL_SALES_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, RETAIL_SALES_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const reportId = idCell(values, "Report ID", rowNumber);
      const period = periodFromDateCell(values, "Report Date", rowNumber);
      const legs = parseNetSalesLegs(values, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const detail: LicensingLineDetail = {
        sender: "retail",
        licenseId: idCell(values, "License ID", rowNumber),
        categoryCode: idCell(values, "Category Code", rowNumber),
        territoryIso: territoryCell(values, rowNumber),
        senderRowId: reportId,
        subLicenseeId: null,
        grossRevenueMicros: legs.grossRevenueMicros.toString(),
        tradeDiscountMicros: legs.tradeDiscountMicros.toString(),
        returnedGoodsMicros: legs.returnedGoodsMicros.toString(),
        shippingFreightMicros: legs.shippingFreightMicros.toString(),
        vatMicros: legs.vatMicros.toString(),
        reportedNetMicros: null,
        period,
      };
      void idCell(values, "Retailer", rowNumber);
      return licensingLine(
        "licensing_retail_sales_csv",
        rowNumber,
        currency,
        legs.grossRevenueMicros,
        detail,
        RETAIL_SALES_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Master licensee sell-through logs — the licensee's own sell-through of
// licensed product through its master channels.
// ---------------------------------------------------------------------------

const SELLTHROUGH_HEADER = [
  "Log ID",
  "Log Date",
  "License ID",
  "Category Code",
  "Territory ISO",
  "Master Licensee",
  "Gross Revenue",
  "Trade Discounts",
  "Returned Goods Allowance",
  "Shipping Freight Deductions",
  "VAT",
  "Currency",
  "Reporting Period",
] as const;

const sellthroughLogProfile: StatementProfile = {
  kind: "licensing_sellthrough_log_csv",
  title: "Master licensee sell-through log CSV (one row per sell-through)",
  laneRightsType: LICENSING_RIGHTS_TYPE,
  statementSourceType: LICENSING_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SELLTHROUGH_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, SELLTHROUGH_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const logId = idCell(values, "Log ID", rowNumber);
      const period = periodFromDateCell(values, "Log Date", rowNumber);
      const legs = parseNetSalesLegs(values, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const detail: LicensingLineDetail = {
        sender: "sellthrough",
        licenseId: idCell(values, "License ID", rowNumber),
        categoryCode: idCell(values, "Category Code", rowNumber),
        territoryIso: territoryCell(values, rowNumber),
        senderRowId: logId,
        subLicenseeId: null,
        grossRevenueMicros: legs.grossRevenueMicros.toString(),
        tradeDiscountMicros: legs.tradeDiscountMicros.toString(),
        returnedGoodsMicros: legs.returnedGoodsMicros.toString(),
        shippingFreightMicros: legs.shippingFreightMicros.toString(),
        vatMicros: legs.vatMicros.toString(),
        reportedNetMicros: null,
        period,
      };
      void idCell(values, "Master Licensee", rowNumber);
      return licensingLine(
        "licensing_sellthrough_log_csv",
        rowNumber,
        currency,
        legs.grossRevenueMicros,
        detail,
        SELLTHROUGH_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// E-commerce POS feeds — the licensee's direct-to-consumer point of sale.
// ---------------------------------------------------------------------------

const ECOMMERCE_POS_HEADER = [
  "Order ID",
  "Order Date",
  "License ID",
  "Category Code",
  "Territory ISO",
  "Units Sold",
  "Gross Revenue",
  "Trade Discounts",
  "Returned Goods Allowance",
  "Shipping Freight Deductions",
  "VAT",
  "Currency",
  "Reporting Period",
] as const;

const ecommercePosProfile: StatementProfile = {
  kind: "licensing_ecommerce_pos_csv",
  title: "E-commerce POS feed CSV (one row per order)",
  laneRightsType: LICENSING_RIGHTS_TYPE,
  statementSourceType: LICENSING_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, ECOMMERCE_POS_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, ECOMMERCE_POS_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const orderId = idCell(values, "Order ID", rowNumber);
      const period = periodFromDateCell(values, "Order Date", rowNumber);
      const legs = parseNetSalesLegs(values, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const unitsCell = requiredCell(values, "Units Sold", rowNumber);
      if (!/^\d+$/.test(unitsCell) || Number(unitsCell) < 1) {
        throw new StatementParseError(`invalid_units:${unitsCell}:row_${rowNumber}`);
      }
      const detail: LicensingLineDetail = {
        sender: "ecommerce",
        licenseId: idCell(values, "License ID", rowNumber),
        categoryCode: idCell(values, "Category Code", rowNumber),
        territoryIso: territoryCell(values, rowNumber),
        senderRowId: orderId,
        subLicenseeId: null,
        grossRevenueMicros: legs.grossRevenueMicros.toString(),
        tradeDiscountMicros: legs.tradeDiscountMicros.toString(),
        returnedGoodsMicros: legs.returnedGoodsMicros.toString(),
        shippingFreightMicros: legs.shippingFreightMicros.toString(),
        vatMicros: legs.vatMicros.toString(),
        reportedNetMicros: null,
        period,
      };
      return licensingLine(
        "licensing_ecommerce_pos_csv",
        rowNumber,
        currency,
        legs.grossRevenueMicros,
        detail,
        ECOMMERCE_POS_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Wholesale distributor manifests — the sub-licensee attribution rides
// here, and the manifest's own arithmetic must self-reconcile exactly
// (gross − trade discounts − returned goods − shipping/freight − VAT =
// Reported Net). A manifest that disagrees with itself is rejected whole —
// never silently adjusted (the consignment-payout precedent).
// ---------------------------------------------------------------------------

const WHOLESALE_MANIFEST_HEADER = [
  "Manifest ID",
  "Ship Date",
  "License ID",
  "Category Code",
  "Territory ISO",
  "Sub-Licensee ID",
  "Region Code",
  "Distributor",
  "Gross Revenue",
  "Trade Discounts",
  "Returned Goods Allowance",
  "Shipping Freight Deductions",
  "VAT",
  "Reported Net",
  "Currency",
  "Reporting Period",
] as const;

const wholesaleManifestProfile: StatementProfile = {
  kind: "licensing_wholesale_manifest_csv",
  title:
    "Wholesale distributor manifest CSV (sub-licensee attribution, gross, deduction legs, reported net)",
  laneRightsType: LICENSING_RIGHTS_TYPE,
  statementSourceType: LICENSING_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, WHOLESALE_MANIFEST_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, WHOLESALE_MANIFEST_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const manifestId = idCell(values, "Manifest ID", rowNumber);
      const period = periodFromDateCell(values, "Ship Date", rowNumber);
      const legs = parseNetSalesLegs(values, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const subLicenseeId = idCell(values, "Sub-Licensee ID", rowNumber);
      const regionCode = requiredCell(values, "Region Code", rowNumber).toUpperCase();
      if (!/^[A-Z]{2}$/.test(regionCode)) {
        throw new StatementParseError(`invalid_region:${regionCode}:row_${rowNumber}`);
      }

      // THE SELF-RECONCILIATION — the manifest's own arithmetic, exact:
      // gross − trade discounts − returned goods − shipping/freight − VAT
      // must equal the reported net. A manifest that disagrees with itself
      // is an operator quarantine — never silently adjusted.
      const reportedNetMicros = nonNegativeMoneyCell(values, "Reported Net", rowNumber);
      const derivedNetMicros =
        legs.grossRevenueMicros -
        legs.tradeDiscountMicros -
        legs.returnedGoodsMicros -
        legs.shippingFreightMicros -
        legs.vatMicros;
      if (derivedNetMicros < 0n) {
        throw new StatementParseError(
          `manifest_reconciliation_negative:${manifestId}:row_${rowNumber}`,
        );
      }
      if (derivedNetMicros !== reportedNetMicros) {
        throw new StatementParseError(
          `manifest_reconciliation_mismatch:${manifestId}:row_${rowNumber}`,
        );
      }

      const detail: LicensingLineDetail = {
        sender: "wholesale",
        licenseId: idCell(values, "License ID", rowNumber),
        categoryCode: idCell(values, "Category Code", rowNumber),
        territoryIso: territoryCell(values, rowNumber),
        senderRowId: manifestId,
        subLicenseeId,
        grossRevenueMicros: legs.grossRevenueMicros.toString(),
        tradeDiscountMicros: legs.tradeDiscountMicros.toString(),
        returnedGoodsMicros: legs.returnedGoodsMicros.toString(),
        shippingFreightMicros: legs.shippingFreightMicros.toString(),
        vatMicros: legs.vatMicros.toString(),
        reportedNetMicros: reportedNetMicros.toString(),
        period,
      };
      void idCell(values, "Distributor", rowNumber);
      return licensingLine(
        "licensing_wholesale_manifest_csv",
        rowNumber,
        currency,
        legs.grossRevenueMicros,
        detail,
        WHOLESALE_MANIFEST_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The licensing lane's profiles — dispatched through the shared dispatcher. */
export const LICENSING_PROFILES: readonly StatementProfile[] = [
  retailSalesProfile,
  sellthroughLogProfile,
  ecommercePosProfile,
  wholesaleManifestProfile,
];

/** True when a dispatched profile is the licensing lane's. */
export function isLicensingProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "licensing_retail_sales_csv" ||
    kind === "licensing_sellthrough_log_csv" ||
    kind === "licensing_ecommerce_pos_csv" ||
    kind === "licensing_wholesale_manifest_csv"
  );
}

/**
 * The licensing lane's Net Sales legs from a parsed line — the queue
 * writer's extraction. The line's gross is the gross revenue leg; the
 * deduction legs ride the detail as exact micros text.
 */
export function licensingLegsMicros(line: ParsedStatementLine): {
  grossRevenueMicros: bigint;
  tradeDiscountMicros: bigint;
  returnedGoodsMicros: bigint;
  shippingFreightMicros: bigint;
  vatMicros: bigint;
} {
  const detail = line.licensingDetail;
  if (detail === null || detail === undefined) {
    throw new StatementParseError("licensing_line_missing_detail");
  }
  return {
    grossRevenueMicros: BigInt(detail.grossRevenueMicros),
    tradeDiscountMicros: BigInt(detail.tradeDiscountMicros),
    returnedGoodsMicros: BigInt(detail.returnedGoodsMicros),
    shippingFreightMicros: BigInt(detail.shippingFreightMicros),
    vatMicros: BigInt(detail.vatMicros),
  };
}
