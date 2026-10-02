/**
 * CVT recon worker — webtoon lane ingestion profiles (PR 19, founder
 * webtoon + serialized-publishing directive).
 *
 * Three strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on any
 * violation. No industry CSV royalty standard exists for webtoon or KDP
 * reports — every sender ships a different layout, so each profile defines
 * ONE strict layout and the profile is the contract, pinned by checked-in
 * fixtures. A permissive guesser is the silent-misparse behavior the recon
 * engine exists to prevent.
 *
 *   webtoon_coin_payout_csv — a per-reader pay-per-chapter coin payout
 *     report (Webtoon, Tapas, KakaoPage): Fast-Pass and paid coin unlocks
 *     in the platform's own denomination (Webtoon Coins / Tapas Ink),
 *     converted at the recorded exchange rate, with the layered shares —
 *     the pinned 30% Apple/Google App Store cut, then the platform's
 *     30-50% split — recorded per row. The Reader ID cell is required: it
 *     is one axis of the reading-event identity the deduplication needs.
 *     A monthly_pass row here is hostile (an all-access pass read is never
 *     pay-per-chapter coin money — that double-dip is exactly what the
 *     reader-log cross-reference exists to catch).
 *
 *   webtoon_reader_log_csv — a per-reader platform reading log: the
 *     consumption facts (which reader read which chapter, through which
 *     access). Zero-gross rows — a reader log reports reads, never money;
 *     the monthly-pass rows are the double-dip CLAIMS the coin payout
 *     writer cross-references.
 *
 *   kenp_page_read_pool_csv — an Amazon KDP Select Global Fund monthly
 *     report: pages read × the period's pool rate (e.g. $0.004 per page),
 *     keyed on format_type (KENP money exists for ebook reads and nothing
 *     else — any other format in a page-read pool report is hostile). The
 *     rate is RECORDED per row and must be consistent per (period,
 *     marketplace): a month's pool rate is one fact, and a report whose
 *     rows disagree is rejected whole.
 *
 * Rights separation: webtoon lines are rights_type 'unknown' — serialized
 * chapter revenue is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math (the
 * gaming/livestream precedent). tier_level is null and
 * statement_source_type is null — the platform, format, and
 * virtual-currency columns PR 1 shipped are this lane's discriminators.
 * rights_pipeline rides inert provenance, the film/podcast profiles'
 * precedent.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the bounded platform/denomination/access vocabularies, the pinned store
 * cut and the platform split band, positive coin amounts and rates, the
 * `YYYY-MM` period buckets, positive page counts, ebook-only KENP formats,
 * the per-(period, marketplace) rate consistency, and the Catalog DOI
 * every attributable row needs.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  coinGrossMicros,
  isWebtoonAccessType,
  isWebtoonPlatform,
  kenpPoolPayoutMicros,
  validatePlatformSplitBps,
  validateStoreCutBps,
  WEBTOON_COIN_DENOMINATIONS,
} from "./webtoon";
import { StatementParseError } from "./records";
import type {
  ParsedStatementLine,
  ReconIdentifiers,
  StatementProfile,
  WebtoonAccessType,
  WebtoonLanePlatform,
  WebtoonLineDetail,
} from "./records";

const CSV = ",";

/** The webtoon lane's rights family — neither recording nor composition. */
const WEBTOON_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The webtoon lane carries no statement_source_type — the platform and
 * format columns are the discriminator. */
const WEBTOON_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

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

/** A positive money cell — coin amounts and rates reject zero and negative. */
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
 * The report/read date cell — an ISO calendar date. Required provenance on
 * every webtoon row; the period bucket is the date's own `YYYY-MM` prefix.
 */
function reportDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber);
  const parsed = new Date(`${cell}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell) || Number.isNaN(parsed.getTime())) {
    throw new StatementParseError(`invalid_date:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The period bucket derived from a validated ISO date cell. */
function periodFromDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  return reportDateCell(values, column, rowNumber).slice(0, 7);
}

/**
 * The KENP `Period Month` cell — a strict `YYYY-MM` bucket with a real
 * month (the Global Fund reports monthly; a stray day or timezone would
 * silently bucket the pool into the wrong period).
 */
function kenpPeriodCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  const cell = requiredCell(values, "Period Month", rowNumber);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(cell)) {
    throw new StatementParseError(`invalid_period:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The currency cell — required, uppercased. */
function currencyCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  return requiredCell(values, "Currency", rowNumber).toUpperCase();
}

/**
 * The Catalog DOI — REQUIRED on every webtoon row: a chapter payout or a
 * pool receipt without the title's vault identity is unattributable money,
 * and the lane refuses to quarantine it silently (the gaming/livestream
 * lane's required-DOI posture).
 */
function catalogDoiCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): ReconIdentifiers {
  const trimmed = requiredCell(values, "Catalog DOI", rowNumber);
  const canonical = canonicalizeIdentifier("DOI", trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_doi:${trimmed}:row_${rowNumber}`);
  }
  return { DOI: canonical };
}

/** The platform cell — the bounded webtoon-family vocabulary (KDP's
 * reports never carry it; their rows are keyed by marketplace). */
function webtoonPlatformCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): WebtoonLanePlatform {
  const cell = requiredCell(values, "Platform", rowNumber);
  if (!isWebtoonPlatform(cell)) {
    throw new StatementParseError(`invalid_platform:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The access-type cell — the bounded three-type vocabulary. */
function accessTypeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): WebtoonAccessType {
  const cell = requiredCell(values, "Access Type", rowNumber);
  if (!isWebtoonAccessType(cell)) {
    throw new StatementParseError(`invalid_access_type:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/**
 * A percent cell with at most two decimals ("30", "47.5", "50.00"), parsed
 * into whole basis points with NO float (the fraction's digits ARE the bps
 * digits) — the livestream profiles' parser.
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

/** The coin denomination cell — the bounded two-product vocabulary. */
function coinDenominationCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  const cell = requiredCell(values, "Coin Denomination", rowNumber);
  if (!WEBTOON_COIN_DENOMINATIONS.includes(cell)) {
    throw new StatementParseError(`invalid_coin_denomination:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The pages-read cell — a positive whole count (a fractional page is a
 * hostile row; KENP pages and reader-log chapters are whole). */
function pagesReadCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): number {
  const cell = requiredCell(values, "Pages Read", rowNumber);
  if (!/^\d+$/.test(cell) || Number(cell) <= 0) {
    throw new StatementParseError(`invalid_pages_read:${cell}:row_${rowNumber}`);
  }
  return Number(cell);
}

/** The coin payout report's access type — pay-per-chapter products ONLY.
 * A monthly_pass row in a coin payout report is the double-dip itself
 * arriving as data: the platform reporting a pass read as coin revenue.
 * Fail closed — reject the row (whole file), never launder it through the
 * conversion. */
function payoutAccessTypeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): WebtoonAccessType {
  const cell = requiredCell(values, "Access Type", rowNumber);
  if (!isWebtoonAccessType(cell)) {
    throw new StatementParseError(`invalid_access_type:${cell}:row_${rowNumber}`);
  }
  if (cell === "monthly_pass") {
    throw new StatementParseError(
      `hostile_payout_access_type:${cell}:row_${rowNumber}`,
    );
  }
  return cell;
}

/**
 * Assembles one webtoon line. grossMicros is the line's gross FIAT
 * revenue — the coin conversion on payout rows, the pages × pool-rate
 * product on KENP rows, and exactly 0 on reader-log rows (a reading log
 * reports reads, never money).
 */
function webtoonLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: WebtoonLineDetail,
  identifiers: ReconIdentifiers,
  workTitle: string,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: WEBTOON_RIGHTS_TYPE,
    statementSourceType: WEBTOON_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the film/podcast precedent; the column
    // only carries the four music/DSP pipelines and the split engines never
    // read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    // The row's own period bucket — the reading-event fingerprint's period
    // component and the KENP pool period, recorded as provenance.
    period: detail.period,
    currency,
    grossMicros,
    isAdjustment: grossMicros < 0n,
    identifiers,
    workTitle,
    territory: null,
    // The free-text display platform.
    platform: detail.platform,
    usageNote: webtoonUsageNote(detail),
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: detail,
    merchDetail: null,
  };
}

/** The usage note — provenance naming the row's kind and its audit cells. */
function webtoonUsageNote(detail: WebtoonLineDetail): string {
  if (detail.kind === "coin_payout") {
    return (
      `webtoon coin payout — ${detail.platform} ${detail.accessType}` +
      ` ${detail.coinAmount ?? ""} ${detail.coinDenomination ?? ""}` +
      ` @ ${detail.exchangeRate ?? ""}` +
      ` (store ${detail.appStoreCutBps ?? 0} bps, platform ${detail.platformSplitBps ?? 0} bps)`
    );
  }
  if (detail.kind === "reader_log") {
    return (
      `webtoon reader log — ${detail.platform} ${detail.accessType}` +
      ` read ${detail.pagesRead ?? 0} pages`
    );
  }
  return (
    `kenp pool — ${detail.marketplace ?? ""} ${detail.period}` +
    ` ${detail.pagesRead ?? 0} pages @ ${detail.exchangeRate ?? ""}`
  );
}

// ---------------------------------------------------------------------------
// Webtoon per-reader pay-per-chapter coin payout report — Fast-Pass and paid
// coin unlocks in the platform's own denomination, converted at the recorded
// rate, shares layered per row.
// ---------------------------------------------------------------------------

const COIN_PAYOUT_HEADER = [
  "Payout Date",
  "Platform",
  "Series ID",
  "Series Title",
  "Chapter ID",
  "Reader ID",
  "Access Type",
  "Coin Denomination",
  "Coin Amount",
  "Exchange Rate (USD per Coin)",
  "App Store Share %",
  "Platform Share %",
  "Catalog DOI",
  "Currency",
] as const;

const coinPayoutProfile: StatementProfile = {
  kind: "webtoon_coin_payout_csv",
  title: "Webtoon coin payout report CSV (Fast-Pass and paid coin unlocks, per reader)",
  laneRightsType: WEBTOON_RIGHTS_TYPE,
  statementSourceType: WEBTOON_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, COIN_PAYOUT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, COIN_PAYOUT_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Payout Date", rowNumber);
      const platform = webtoonPlatformCell(values, rowNumber);
      const seriesId = requiredCell(values, "Series ID", rowNumber);
      const seriesTitle = requiredCell(values, "Series Title", rowNumber);
      const chapterId = requiredCell(values, "Chapter ID", rowNumber);
      const readerId = requiredCell(values, "Reader ID", rowNumber);
      const accessType = payoutAccessTypeCell(values, rowNumber);
      const coinDenomination = coinDenominationCell(values, rowNumber);
      const coinAmountMicros = positiveMoneyCell(values, "Coin Amount", rowNumber);
      const coinAmountText = requiredCell(values, "Coin Amount", rowNumber);
      const rateMicros = positiveMoneyCell(
        values,
        "Exchange Rate (USD per Coin)",
        rowNumber,
      );
      const rateText = requiredCell(values, "Exchange Rate (USD per Coin)", rowNumber);
      const identifiers = catalogDoiCell(values, rowNumber);
      const currency = currencyCell(values, rowNumber);

      // The layered shares — the pinned storefront cut and the platform's
      // band, both validated at parse so a hostile rate never reaches the
      // queue writer.
      const appStoreCutBps = percentCell(values, "App Store Share %", rowNumber);
      const platformSplitBps = percentCell(values, "Platform Share %", rowNumber);
      try {
        validateStoreCutBps(appStoreCutBps);
        validatePlatformSplitBps(platformSplitBps);
      } catch (error) {
        if (
          error instanceof RangeError &&
          (error.message.startsWith("store_cut_out_of_band") ||
            error.message.startsWith("platform_split_out_of_band"))
        ) {
          throw new StatementParseError(`${error.message}:row_${rowNumber}`);
        }
        throw error;
      }

      // The conversion — coins × the recorded rate, exact bigint math; the
      // rate and the coin amount ride the row verbatim (the founder's
      // rate-logging rule).
      const grossMicros = coinGrossMicros(coinAmountMicros, rateMicros);
      const detail: WebtoonLineDetail = {
        kind: "coin_payout",
        platform,
        seriesId,
        chapterId,
        readerId,
        accessType,
        coinDenomination,
        coinAmount: coinAmountText,
        exchangeRate: rateText,
        appStoreCutBps,
        platformSplitBps,
        pagesRead: null,
        period,
        marketplace: null,
      };

      return webtoonLine(
        "webtoon_coin_payout_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        seriesTitle,
        COIN_PAYOUT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Webtoon per-reader platform reading log — the consumption facts the coin
// payout writer cross-references. Zero-gross rows: a reading log reports
// reads, never money. The monthly-pass rows are the double-dip CLAIMS.
// ---------------------------------------------------------------------------

const READER_LOG_HEADER = [
  "Read Date",
  "Platform",
  "Series ID",
  "Series Title",
  "Chapter ID",
  "Reader ID",
  "Access Type",
  "Pages Read",
  "Catalog DOI",
  "Currency",
] as const;

const readerLogProfile: StatementProfile = {
  kind: "webtoon_reader_log_csv",
  title: "Webtoon reader log CSV (per-reader chapter reads by access type)",
  laneRightsType: WEBTOON_RIGHTS_TYPE,
  statementSourceType: WEBTOON_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, READER_LOG_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, READER_LOG_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Read Date", rowNumber);
      const platform = webtoonPlatformCell(values, rowNumber);
      const seriesId = requiredCell(values, "Series ID", rowNumber);
      const seriesTitle = requiredCell(values, "Series Title", rowNumber);
      const chapterId = requiredCell(values, "Chapter ID", rowNumber);
      const readerId = requiredCell(values, "Reader ID", rowNumber);
      const accessType = accessTypeCell(values, rowNumber);
      const pagesRead = pagesReadCell(values, rowNumber);
      const identifiers = catalogDoiCell(values, rowNumber);
      const currency = currencyCell(values, rowNumber);

      // Zero gross — consumption facts never carry money; the posting pass
      // skips them structurally.
      const detail: WebtoonLineDetail = {
        kind: "reader_log",
        platform,
        seriesId,
        chapterId,
        readerId,
        accessType,
        coinDenomination: null,
        coinAmount: null,
        exchangeRate: null,
        appStoreCutBps: null,
        platformSplitBps: null,
        pagesRead,
        period,
        marketplace: null,
      };

      return webtoonLine(
        "webtoon_reader_log_csv",
        rowNumber,
        currency,
        0n,
        detail,
        identifiers,
        seriesTitle,
        READER_LOG_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Amazon KDP Select Global Fund monthly report — the KENP page-read pool.
// Pages × the period's recorded pool rate, ebook rows only, one rate per
// (period, marketplace) enforced across the whole file.
// ---------------------------------------------------------------------------

const KENP_HEADER = [
  "Period Month",
  "Marketplace",
  "Title ID",
  "Title Name",
  "Format Type",
  "Pages Read",
  "Kenp Rate (USD per Page)",
  "Catalog DOI",
  "Currency",
] as const;

/** KENP money exists for ebook page reads — any other format in a
 * page-read pool report is a hostile row (paperbacks pay per unit sold,
 * not per page read). */
const KENP_ELIGIBLE_FORMAT = "ebook";

const kenpPoolProfile: StatementProfile = {
  kind: "kenp_page_read_pool_csv",
  title: "Amazon KDP Select Global Fund CSV (KENP page-read pool, per title)",
  laneRightsType: WEBTOON_RIGHTS_TYPE,
  statementSourceType: WEBTOON_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, KENP_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, KENP_HEADER);
    // One rate per (period, marketplace) — the Global Fund's monthly rate
    // update applies per period; a report whose rows disagree for the same
    // scope is internally inconsistent and rejected whole. Compared on the
    // parsed micros so "0.004" and "0.0040" are the same rate.
    const seenRates = new Map<string, bigint>();
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = kenpPeriodCell(values, rowNumber);
      const marketplace = requiredCell(values, "Marketplace", rowNumber);
      const titleId = requiredCell(values, "Title ID", rowNumber);
      const titleName = requiredCell(values, "Title Name", rowNumber);
      const formatType = requiredCell(values, "Format Type", rowNumber);
      if (formatType !== KENP_ELIGIBLE_FORMAT) {
        throw new StatementParseError(
          `hostile_kenp_format:${formatType}:row_${rowNumber}`,
        );
      }
      const pagesRead = pagesReadCell(values, rowNumber);
      const rateMicros = positiveMoneyCell(
        values,
        "Kenp Rate (USD per Page)",
        rowNumber,
      );
      const rateText = requiredCell(values, "Kenp Rate (USD per Page)", rowNumber);
      const identifiers = catalogDoiCell(values, rowNumber);
      const currency = currencyCell(values, rowNumber);

      const rateScope = `${period}:${marketplace}`;
      const priorRate = seenRates.get(rateScope);
      if (priorRate !== undefined && priorRate !== rateMicros) {
        throw new StatementParseError(
          `kenp_rate_conflict:${rateScope}:${rateText}:row_${rowNumber}`,
        );
      }
      seenRates.set(rateScope, rateMicros);

      // The pool payout — pages × the recorded rate, an exact integer
      // product; no platform shares (Amazon pays the pool net). The KDP
      // Title ID is the pool row's series identity (it keys the event id).
      const grossMicros = kenpPoolPayoutMicros(pagesRead, rateMicros);
      const detail: WebtoonLineDetail = {
        kind: "kenp_pool",
        platform: "amazon_kdp",
        seriesId: titleId,
        chapterId: null,
        readerId: null,
        accessType: null,
        coinDenomination: null,
        coinAmount: null,
        exchangeRate: rateText,
        appStoreCutBps: null,
        platformSplitBps: null,
        pagesRead,
        period,
        marketplace,
      };

      return webtoonLine(
        "kenp_page_read_pool_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        titleName,
        KENP_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The webtoon lane's profiles — dispatched through the shared dispatcher. */
export const WEBTOON_PROFILES: readonly StatementProfile[] = [
  coinPayoutProfile,
  readerLogProfile,
  kenpPoolProfile,
];

/** True when a dispatched profile is the webtoon lane's. */
export function isWebtoonProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "webtoon_coin_payout_csv" ||
    kind === "webtoon_reader_log_csv" ||
    kind === "kenp_page_read_pool_csv"
  );
}
