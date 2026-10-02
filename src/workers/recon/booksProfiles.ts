/**
 * CVT recon worker — the book/magazine lane's ingestion profiles (PR 26,
 * founder publishing directive: the book POD print parser + editorial split
 * ledger).
 *
 * Four strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on any
 * violation. No industry CSV royalty standard exists for book or magazine
 * reports — every sender ships a different layout, so each profile defines
 * ONE strict layout and the profile is the contract, pinned by checked-in
 * fixtures (the webtoon/merch precedent). A permissive guesser is the
 * silent-misparse behavior the recon engine exists to prevent. Senders
 * sharing one money model share one profile through a bounded Platform
 * column (the merch POD partners' precedent):
 *
 *   book_pod_print_csv        — physical print-on-demand sales from the two
 *     print distributors (Amazon KDP print, IngramSpark). Keyed on ISBN +
 *     format_type (paperback/hardcover); the deduction legs (base printing
 *     COGS per unit, distribution fee, channel discount 40–55%) ride the
 *     row verbatim and the net realized royalty is computed from them.
 *
 *   book_ebook_agency_csv     — e-book agency sales from the four agency
 *     senders (Amazon KDP ebook, Draft2Digital, Apple Books, Kobo). The
 *     recorded list price keys the 70/35 agency tier.
 *
 *   book_magazine_csv         — digital magazine money from the two
 *     magazine senders (Zinio, Substack): single-issue sales and
 *     subscription funding rows, the editorial cuts' two bases.
 *
 *   book_audiobook_sales_csv  — audiobook unit sales (Amazon KDP's
 *     audiobook rows) — the isolated audiobook recoupment pool's feed.
 *
 * KENP INTEGRATION, NOT REBUILD: Amazon KDP Select Global Fund page-read
 * money stays in the PR 19 lane's `kenp_page_read_pool_csv` profile — its
 * exact header still dispatches there untouched; this lane's profiles
 * carry different headers and never shadow it.
 *
 * Rights separation: book lines are rights_type 'unknown' — book and
 * magazine revenue is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math (the
 * webtoon/gaming/merch precedent). tier_level is null and
 * statement_source_type is null; the ISBN and platform columns are this
 * lane's discriminators, populating the addendum 9 isbn column.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the bounded platform/format/row-type vocabularies, the 40–55% channel
 * discount band, positive units and money cells, canonical ISBN-13s, and
 * the `YYYY-MM` period buckets derived from the ISO date cells.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  validateAgencyPriceMicros,
  validateBookUnits,
  validateChannelDiscountBps,
} from "./books";
import { StatementParseError } from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import type {
  BookLineDetail,
  ParsedStatementLine,
  ReconIdentifiers,
  StatementProfile,
} from "./records";

const CSV = ",";

/** The book lane's rights family — neither recording nor composition. */
const BOOK_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The book lane carries no statement_source_type — the ISBN/platform
 * columns are the discriminator. */
const BOOK_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

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
 * A positive money cell — sale rows carry revenue; zero and negative money
 * are hostile rows in this lane (an adjustment row has no model here — the
 * profiles reject it rather than guess one).
 */
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

/**
 * The report date cell — an ISO calendar date; the row's period bucket is
 * the date's own `YYYY-MM` prefix (the webtoon profiles' discipline).
 */
function periodFromDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber);
  const parsed = new Date(`${cell}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell) || Number.isNaN(parsed.getTime())) {
    throw new StatementParseError(`invalid_date:${cell}:row_${rowNumber}`);
  }
  return cell.slice(0, 7);
}

/** The currency cell — required, uppercased ISO alpha-3. */
function currencyCell(values: ReadonlyMap<string, string>, rowNumber: number): string {
  const currency = requiredCell(values, "Currency", rowNumber).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new StatementParseError(`invalid_currency:${currency}:row_${rowNumber}`);
  }
  return currency;
}

/**
 * The ISBN cell — REQUIRED on every ISBN-keyed row, canonicalized through
 * the singular registry (ISBN-13; ISBN-10 is rejected — converting it is
 * arithmetic the contract refuses). A sale without the title's ISBN is
 * unattributable money; the lane refuses to quarantine it silently.
 */
function isbnCell(values: ReadonlyMap<string, string>, rowNumber: number): ReconIdentifiers {
  const trimmed = requiredCell(values, "ISBN", rowNumber);
  const canonical = canonicalizeIdentifier("ISBN", trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_isbn:${trimmed}:row_${rowNumber}`);
  }
  return { ISBN: canonical };
}

/** The units cell — a positive whole count. */
function unitsCell(values: ReadonlyMap<string, string>, rowNumber: number): number {
  const cell = requiredCell(values, "Units", rowNumber);
  if (!/^\d+$/.test(cell)) {
    throw new StatementParseError(`invalid_units:${cell}:row_${rowNumber}`);
  }
  return validateBookUnits(Number(cell), rowNumber);
}

/**
 * A percent cell with at most two decimals ("40", "47.5", "55.00"), parsed
 * into whole basis points with NO float (the fraction's digits ARE the bps
 * digits) — the webtoon profiles' parser.
 */
function percentCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): number {
  const cell = requiredCell(values, column, rowNumber);
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(cell)) {
    throw new StatementParseError(`invalid_percent:${column}:${cell}:row_${rowNumber}`);
  }
  const [whole, fraction = ""] = cell.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
}

/**
 * Assembles one book line. grossMicros is the line's reported gross — the
 * print row's recorded gross retail, the ebook row's list × units, the
 * magazine/audiobook rows' recorded gross cells.
 */
function bookLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: BookLineDetail,
  identifiers: ReconIdentifiers,
  workTitle: string,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: BOOK_RIGHTS_TYPE,
    statementSourceType: BOOK_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the film/podcast/webtoon precedent; the
    // column only carries the four music/DSP pipelines and the split
    // engines never read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency,
    grossMicros,
    isAdjustment: false,
    identifiers,
    workTitle,
    territory: null,
    platform: detail.platform,
    usageNote: bookUsageNote(detail),
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
    bookDetail: detail,
  };
}

/** The usage note — provenance naming the row's kind and its audit cells. */
function bookUsageNote(detail: BookLineDetail): string {
  if (detail.kind === "print_sale") {
    return (
      `book pod print — ${detail.platform} ${detail.formatType}` +
      ` isbn ${detail.isbn}, gross retail ${detail.grossRetailMicros} micros` +
      `, printing ${detail.printingCostPerUnitMicros}/unit, distribution fee ${detail.distributionFeeMicros}` +
      `, channel discount ${detail.channelDiscountBps} bps`
    );
  }
  if (detail.kind === "ebook_sale") {
    return (
      `book ebook agency — ${detail.platform} isbn ${detail.isbn}` +
      ` list ${detail.listPriceMicros} micros`
    );
  }
  if (detail.kind === "audiobook_sale") {
    return (
      `book audiobook — ${detail.platform} isbn ${detail.isbn}` +
      ` royalty ${detail.royaltyPerUnitMicros}/unit`
    );
  }
  return (
    `book magazine ${detail.kind === "magazine_issue" ? "issue sale" : "subscription"}` +
    ` — ${detail.platform} magazine ${detail.magazineId} issue ${detail.issueId}`
  );
}

// ---------------------------------------------------------------------------
// Physical POD print sales — the print deduction equation's rows, keyed on
// ISBN + format_type, deduction legs recorded verbatim.
// ---------------------------------------------------------------------------

const POD_PRINT_HEADER = [
  "Statement Date",
  "Platform",
  "Order ID",
  "Title",
  "ISBN",
  "Format Type",
  "Units",
  "Gross Retail",
  "Printing Cost Per Unit",
  "Distribution Fee",
  "Channel Discount %",
  "Currency",
] as const;

function printPlatformCell(values: ReadonlyMap<string, string>, rowNumber: number): "amazon_kdp" | "ingram_spark" {
  const cell = requiredCell(values, "Platform", rowNumber);
  if (cell !== "amazon_kdp" && cell !== "ingram_spark") {
    throw new StatementParseError(`invalid_platform:${cell}:row_${rowNumber}`);
  }
  return cell;
}

const podPrintProfile: StatementProfile = {
  kind: "book_pod_print_csv",
  title: "Book POD print sales CSV (Amazon KDP print / IngramSpark, keyed on ISBN + format)",
  laneRightsType: BOOK_RIGHTS_TYPE,
  statementSourceType: BOOK_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, POD_PRINT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, POD_PRINT_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Statement Date", rowNumber);
      const platform = printPlatformCell(values, rowNumber);
      const orderId = requiredCell(values, "Order ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const identifiers = isbnCell(values, rowNumber);
      const formatType = requiredCell(values, "Format Type", rowNumber);
      if (formatType !== "paperback" && formatType !== "hardcover") {
        throw new StatementParseError(
          `hostile_print_format:${formatType}:row_${rowNumber}`,
        );
      }
      const units = unitsCell(values, rowNumber);
      const grossRetailMicros = positiveMoneyCell(values, "Gross Retail", rowNumber);
      const printingCostPerUnitMicros = positiveMoneyCell(
        values,
        "Printing Cost Per Unit",
        rowNumber,
      );
      const distributionFeeMicros = positiveMoneyCell(values, "Distribution Fee", rowNumber);
      const channelDiscountBps = percentCell(values, "Channel Discount %", rowNumber);
      try {
        validateChannelDiscountBps(channelDiscountBps, rowNumber);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new StatementParseError(`${error.message}`);
        }
        throw error;
      }
      const currency = currencyCell(values, rowNumber);

      const detail: BookLineDetail = {
        kind: "print_sale",
        platform,
        isbn: identifiers.ISBN ?? "",
        formatType,
        orderId,
        units,
        grossRetailMicros: grossRetailMicros.toString(),
        printingCostPerUnitMicros: printingCostPerUnitMicros.toString(),
        distributionFeeMicros: distributionFeeMicros.toString(),
        channelDiscountBps,
        period,
      };

      return bookLine(
        "book_pod_print_csv",
        rowNumber,
        currency,
        grossRetailMicros,
        detail,
        identifiers,
        title,
        POD_PRINT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// E-book agency sales — the 70/35 tier's rows, the recorded list price the
// tier's key.
// ---------------------------------------------------------------------------

const EBOOK_AGENCY_HEADER = [
  "Sale Date",
  "Platform",
  "Order ID",
  "Title",
  "ISBN",
  "Units",
  "List Price",
  "Currency",
] as const;

const EBOOK_PLATFORMS = ["amazon_kdp", "draft2digital", "apple_books", "kobo"] as const;

function ebookPlatformCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): (typeof EBOOK_PLATFORMS)[number] {
  const cell = requiredCell(values, "Platform", rowNumber);
  if (!(EBOOK_PLATFORMS as readonly string[]).includes(cell)) {
    throw new StatementParseError(`invalid_platform:${cell}:row_${rowNumber}`);
  }
  return cell as (typeof EBOOK_PLATFORMS)[number];
}

const ebookAgencyProfile: StatementProfile = {
  kind: "book_ebook_agency_csv",
  title:
    "Book e-book agency sales CSV (KDP ebook / Draft2Digital / Apple Books / Kobo, 70/35 tier)",
  laneRightsType: BOOK_RIGHTS_TYPE,
  statementSourceType: BOOK_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, EBOOK_AGENCY_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, EBOOK_AGENCY_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Sale Date", rowNumber);
      const platform = ebookPlatformCell(values, rowNumber);
      const orderId = requiredCell(values, "Order ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const identifiers = isbnCell(values, rowNumber);
      const units = unitsCell(values, rowNumber);
      const listPriceMicros = positiveMoneyCell(values, "List Price", rowNumber);
      try {
        validateAgencyPriceMicros(listPriceMicros, rowNumber);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new StatementParseError(`${error.message}`);
        }
        throw error;
      }
      const currency = currencyCell(values, rowNumber);

      const detail: BookLineDetail = {
        kind: "ebook_sale",
        platform,
        isbn: identifiers.ISBN ?? "",
        orderId,
        units,
        listPriceMicros: listPriceMicros.toString(),
        period,
      };
      // The row's gross is the customer money the agency model starts
      // from: list × units, exact bigint product (the 70/35 royalty is
      // computed at write time from the SAME recorded cells).
      const grossMicros = listPriceMicros * BigInt(units);

      return bookLine(
        "book_ebook_agency_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        title,
        EBOOK_AGENCY_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Digital magazine money — single-issue sales and subscription funding
// rows, the editorial cuts' two bases (flat per issue, percentage of
// subscription revenue).
// ---------------------------------------------------------------------------

const MAGAZINE_HEADER = [
  "Event Date",
  "Platform",
  "Row Type",
  "Event ID",
  "Magazine ID",
  "Issue ID",
  "Title",
  "Units",
  "Gross Amount",
  "Currency",
] as const;

const MAGAZINE_PLATFORMS = ["zinio", "substack"] as const;
const MAGAZINE_ROW_TYPES = ["issue_sale", "subscription"] as const;

function magazinePlatformCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): (typeof MAGAZINE_PLATFORMS)[number] {
  const cell = requiredCell(values, "Platform", rowNumber);
  if (!(MAGAZINE_PLATFORMS as readonly string[]).includes(cell)) {
    throw new StatementParseError(`invalid_platform:${cell}:row_${rowNumber}`);
  }
  return cell as (typeof MAGAZINE_PLATFORMS)[number];
}

function magazineRowTypeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): (typeof MAGAZINE_ROW_TYPES)[number] {
  const cell = requiredCell(values, "Row Type", rowNumber);
  if (!(MAGAZINE_ROW_TYPES as readonly string[]).includes(cell)) {
    throw new StatementParseError(`invalid_row_type:${cell}:row_${rowNumber}`);
  }
  return cell as (typeof MAGAZINE_ROW_TYPES)[number];
}

const magazineProfile: StatementProfile = {
  kind: "book_magazine_csv",
  title: "Digital magazine CSV (Zinio / Substack issue sales and subscription funding)",
  laneRightsType: BOOK_RIGHTS_TYPE,
  statementSourceType: BOOK_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, MAGAZINE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, MAGAZINE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Event Date", rowNumber);
      const platform = magazinePlatformCell(values, rowNumber);
      const rowType = magazineRowTypeCell(values, rowNumber);
      const eventId = requiredCell(values, "Event ID", rowNumber);
      const magazineId = requiredCell(values, "Magazine ID", rowNumber);
      const issueId = requiredCell(values, "Issue ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const units = unitsCell(values, rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Amount", rowNumber);
      const currency = currencyCell(values, rowNumber);

      const detail: BookLineDetail =
        rowType === "issue_sale"
          ? {
              kind: "magazine_issue",
              platform,
              magazineId,
              issueId,
              eventId,
              units,
              grossMicros: grossMicros.toString(),
              period,
            }
          : {
              kind: "magazine_subscription",
              platform,
              magazineId,
              issueId,
              eventId,
              units,
              grossMicros: grossMicros.toString(),
              period,
            };

      return bookLine(
        "book_magazine_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        {}, // magazine rows key on the issue identity, not an ISBN
        title,
        MAGAZINE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Audiobook unit sales — the isolated audiobook recoupment pool's feed;
// the per-unit royalty rate is recorded verbatim.
// ---------------------------------------------------------------------------

const AUDIOBOOK_HEADER = [
  "Sale Date",
  "Platform",
  "Order ID",
  "Title",
  "ISBN",
  "Units",
  "Royalty Per Unit",
  "Currency",
] as const;

function audiobookPlatformCell(values: ReadonlyMap<string, string>, rowNumber: number): "amazon_kdp" {
  const cell = requiredCell(values, "Platform", rowNumber);
  if (cell !== "amazon_kdp") {
    throw new StatementParseError(`invalid_platform:${cell}:row_${rowNumber}`);
  }
  return cell;
}

const audiobookProfile: StatementProfile = {
  kind: "book_audiobook_sales_csv",
  title: "Book audiobook sales CSV (Amazon KDP audiobook rows, per-unit royalty recorded)",
  laneRightsType: BOOK_RIGHTS_TYPE,
  statementSourceType: BOOK_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, AUDIOBOOK_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, AUDIOBOOK_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Sale Date", rowNumber);
      const platform = audiobookPlatformCell(values, rowNumber);
      const orderId = requiredCell(values, "Order ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const identifiers = isbnCell(values, rowNumber);
      const units = unitsCell(values, rowNumber);
      const royaltyPerUnitMicros = positiveMoneyCell(values, "Royalty Per Unit", rowNumber);
      const currency = currencyCell(values, rowNumber);

      // The audiobook row's money is units × the recorded per-unit
      // royalty — exact bigint product (the KENP pool math's discipline;
      // no agency tier applies to audiobook receipts).
      const grossMicros = royaltyPerUnitMicros * BigInt(units);
      const detail: BookLineDetail = {
        kind: "audiobook_sale",
        platform,
        isbn: identifiers.ISBN ?? "",
        orderId,
        units,
        royaltyPerUnitMicros: royaltyPerUnitMicros.toString(),
        grossMicros: grossMicros.toString(),
        period,
      };

      return bookLine(
        "book_audiobook_sales_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        title,
        AUDIOBOOK_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The book lane's profiles — dispatched through the shared dispatcher. */
export const BOOK_PROFILES: readonly StatementProfile[] = [
  podPrintProfile,
  ebookAgencyProfile,
  magazineProfile,
  audiobookProfile,
];

/** True when a dispatched profile is the book lane's. */
export function isBookProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "book_pod_print_csv" ||
    kind === "book_ebook_agency_csv" ||
    kind === "book_magazine_csv" ||
    kind === "book_audiobook_sales_csv"
  );
}
