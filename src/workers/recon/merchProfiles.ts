/**
 * CVT recon worker — merch lane ingestion profiles (PR 22, founder
 * merchandise directive).
 *
 * Four strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on any
 * violation. No industry CSV standard exists for merch transaction dumps —
 * every sender ships a different layout, so each profile defines ONE strict
 * layout and the profile is the contract, pinned by checked-in fixtures. A
 * permissive guesser is the silent-misparse behavior the recon engine
 * exists to prevent.
 *
 *   shopify_dtc_dump_csv — a Shopify direct-to-consumer order-fulfillment
 *     dump: per (order, sku) row with the customer's gross price and the
 *     fulfillment cost legs (unit production COGS, shipping, fulfillment,
 *     gateway, the storefront's deducted guest-designer royalty). The net
 *     realized profit equation is computed at write time from these legs.
 *
 *   pod_fulfillment_dump_csv — a print-on-demand fulfillment dump shared by
 *     the two named print partners (Printful, Gelato) via a bounded
 *     Platform column (the webtoon coin-payout precedent: one layout, a
 *     bounded sender vocabulary). The printing cost deducts BEFORE split
 *     percentages — the split prices the after-printing remainder.
 *
 *   wholesale_consignment_payout_csv — a wholesale consignment payout
 *     report: gross, commission, and the shrinkage/loss allowance must
 *     reconcile exactly against the reported net payout; a row that
 *     disagrees with its own arithmetic rejects the file whole.
 *
 *   square_pos_dump_csv — a Square POS retail sale dump: the net (gross −
 *     processing fee) posts to holding.
 *
 * Rights separation: merch lines are rights_type 'unknown' — physical
 * product revenue is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math (the
 * gaming/livestream/webtoon precedent). tier_level and
 * statement_source_type are null. rights_pipeline rides inert provenance,
 * the film/podcast profiles' precedent.
 *
 * Attribution: every row carries the product's UPC — the one vault
 * cross-reference kind a physical product has (a barcode). Unattributable
 * money (no vault asset behind the UPC) is quarantined unmatched, never
 * posted — the webtoon DOI posture.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the bounded platform vocabularies, positive unit counts and grosses,
 * non-negative cost legs, the 0-100 split-share percent, the `YYYY-MM`
 * payout periods, canonical UPC barcodes, and the consignment rows' exact
 * self-reconciliation.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import { isMerchPodPlatform, validateMerchSplitShareBps, validateMerchUnits } from "./merch";
import { StatementParseError } from "./records";
import type {
  MerchDtcPlatform,
  MerchLineDetail,
  ParsedStatementLine,
  ReconIdentifiers,
  StatementProfile,
} from "./records";

const CSV = ",";

/** The merch lane's rights family — neither recording nor composition. */
const MERCH_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The merch lane carries no statement_source_type — the profile kind and
 * the merchDetail presence are the discriminator. */
const MERCH_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The merch lane's fixed DTC platform — the storefront dump's only sender. */
const MERCH_DTC_PLATFORM: MerchDtcPlatform = "shopify";

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

/** A non-negative money cell — cost legs and payout legs reject negative. */
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

/** A strictly positive money cell — grosses reject zero and negative. */
function positiveMoneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): bigint {
  const micros = nonNegativeMoneyCell(values, column, rowNumber);
  if (micros <= 0n) {
    throw new StatementParseError(
      `invalid_money:${column}:${(values.get(column) ?? "").trim()}:row_${rowNumber}`,
    );
  }
  return micros;
}

/**
 * The report/sale/fulfillment date cell — an ISO calendar date. Required
 * provenance on every merch row; the period bucket is the date's own
 * `YYYY-MM` prefix.
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
 * The consignment `Payout Period` cell — a strict `YYYY-MM` bucket with a
 * real month (consignment partners settle monthly; a stray day or timezone
 * would silently bucket the payout into the wrong period).
 */
function consignmentPeriodCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  const cell = requiredCell(values, "Payout Period", rowNumber);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(cell)) {
    throw new StatementParseError(`invalid_period:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The currency cell — required, uppercased. */
function currencyCell(values: ReadonlyMap<string, string>, rowNumber: number): string {
  return requiredCell(values, "Currency", rowNumber).toUpperCase();
}

/**
 * The UPC barcode — REQUIRED on every merch row: a physical product's
 * vault identity is its barcode, and a sale without one is unattributable
 * money the lane refuses to quarantine silently.
 */
function productUpcCell(values: ReadonlyMap<string, string>, rowNumber: number): ReconIdentifiers {
  const trimmed = requiredCell(values, "UPC", rowNumber);
  const canonical = canonicalizeIdentifier("UPC", trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_upc:${trimmed}:row_${rowNumber}`);
  }
  return { UPC: canonical };
}

/** The units cell — a positive whole count (physical goods, never fractions). */
function unitsCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number): number {
  const cell = requiredCell(values, column, rowNumber);
  if (!/^\d+$/.test(cell)) {
    throw new StatementParseError(`invalid_units:${column}:${cell}:row_${rowNumber}`);
  }
  const units = Number(cell);
  try {
    return validateMerchUnits(units, rowNumber);
  } catch (error) {
    if (error instanceof RangeError && error.message.startsWith("invalid_merch_units")) {
      throw new StatementParseError(`${error.message}`);
    }
    throw error;
  }
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

/** The POD platform cell — the bounded two-partner vocabulary. */
function podPlatformCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): "printful" | "gelato" {
  const cell = requiredCell(values, "Platform", rowNumber);
  if (!isMerchPodPlatform(cell)) {
    throw new StatementParseError(`invalid_pod_platform:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/**
 * Assembles one merch line. grossMicros is the row's gross customer price
 * (the consignment and POS rows' gross sales) — the net legs ride the
 * detail and the posting pass computes the credit.
 */
function merchLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: MerchLineDetail,
  identifiers: ReconIdentifiers,
  workTitle: string,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: MERCH_RIGHTS_TYPE,
    statementSourceType: MERCH_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the film/podcast precedent; the column
    // only carries the four music/DSP pipelines and the split engines never
    // read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency,
    grossMicros,
    isAdjustment: grossMicros < 0n,
    identifiers,
    workTitle,
    territory: null,
    // The free-text display platform — the dump sender.
    platform: detail.platform,
    usageNote: merchUsageNote(detail),
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: detail,
    aiDetail: null,
  };
}

/** The usage note — provenance naming the row's kind and its audit cells. */
function merchUsageNote(detail: MerchLineDetail): string {
  if (detail.kind === "dtc_order") {
    return (
      `merch dtc order — ${detail.orderId} ${detail.skuId} ×${detail.units}` +
      ` (cogs ${detail.unitProductionCogsMicros}/u, ship ${detail.shippingFeeMicros},` +
      ` fulfill ${detail.fulfillmentFeeMicros}, gateway ${detail.gatewayFeeMicros},` +
      ` royalty ${detail.designerRoyaltyMicros})`
    );
  }
  if (detail.kind === "pod_fulfillment") {
    return (
      `merch pod fulfillment — ${detail.platform} ${detail.orderId}` +
      ` ${detail.skuId} ×${detail.units} (printing ${detail.printingCostPerUnitMicros}/u,` +
      ` split ${detail.splitShareBps} bps of the after-printing remainder)`
    );
  }
  if (detail.kind === "consignment_payout") {
    return (
      `merch consignment payout — ${detail.payoutId} ${detail.period}` +
      ` ${detail.skuId} ×${detail.unitsSold} (commission ${detail.commissionMicros},` +
      ` shrinkage ${detail.shrinkageAllowanceMicros})`
    );
  }
  return (
    `merch pos sale — ${detail.saleId} ${detail.skuId} ×${detail.units}` +
    ` (fee ${detail.processingFeeMicros})`
  );
}

// ---------------------------------------------------------------------------
// Shopify DTC order-fulfillment dump — the net-realized-profit equation's
// rows: gross − COGS×units − shipping − fulfillment − gateway − royalty.
// ---------------------------------------------------------------------------

const DTC_HEADER = [
  "Order Date",
  "Order ID",
  "UPC",
  "SKU",
  "Units",
  "Gross Customer Price",
  "Unit Production COGS",
  "Shipping Fee",
  "Fulfillment Fee",
  "Gateway Fee",
  "Designer Royalty",
  "Currency",
] as const;

const dtcDumpProfile: StatementProfile = {
  kind: "shopify_dtc_dump_csv",
  title: "Shopify DTC order-fulfillment dump CSV (per order line, with cost legs)",
  laneRightsType: MERCH_RIGHTS_TYPE,
  statementSourceType: MERCH_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, DTC_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, DTC_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Order Date", rowNumber);
      const orderId = requiredCell(values, "Order ID", rowNumber);
      const identifiers = productUpcCell(values, rowNumber);
      const skuId = requiredCell(values, "SKU", rowNumber);
      const units = unitsCell(values, "Units", rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Customer Price", rowNumber);
      const unitProductionCogsMicros = nonNegativeMoneyCell(
        values,
        "Unit Production COGS",
        rowNumber,
      );
      const shippingFeeMicros = nonNegativeMoneyCell(values, "Shipping Fee", rowNumber);
      const fulfillmentFeeMicros = nonNegativeMoneyCell(values, "Fulfillment Fee", rowNumber);
      const gatewayFeeMicros = nonNegativeMoneyCell(values, "Gateway Fee", rowNumber);
      const designerRoyaltyMicros = nonNegativeMoneyCell(values, "Designer Royalty", rowNumber);
      const currency = currencyCell(values, rowNumber);

      const detail: MerchLineDetail = {
        kind: "dtc_order",
        platform: MERCH_DTC_PLATFORM,
        orderId,
        skuId,
        units,
        unitProductionCogsMicros: unitProductionCogsMicros.toString(),
        shippingFeeMicros: shippingFeeMicros.toString(),
        fulfillmentFeeMicros: fulfillmentFeeMicros.toString(),
        gatewayFeeMicros: gatewayFeeMicros.toString(),
        designerRoyaltyMicros: designerRoyaltyMicros.toString(),
        period,
      };

      return merchLine(
        "shopify_dtc_dump_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        `${skuId} — order ${orderId}`,
        DTC_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Printful / Gelato POD fulfillment dump — printing costs deduct BEFORE the
// split percentages; the split prices the after-printing remainder.
// ---------------------------------------------------------------------------

const POD_HEADER = [
  "Fulfillment Date",
  "Order ID",
  "Platform",
  "UPC",
  "SKU",
  "Units",
  "Gross Customer Price",
  "Printing Cost Per Unit",
  "Split Share %",
  "Currency",
] as const;

const podDumpProfile: StatementProfile = {
  kind: "pod_fulfillment_dump_csv",
  title: "Printful/Gelato POD fulfillment dump CSV (per order line, printing before split)",
  laneRightsType: MERCH_RIGHTS_TYPE,
  statementSourceType: MERCH_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, POD_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, POD_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Fulfillment Date", rowNumber);
      const orderId = requiredCell(values, "Order ID", rowNumber);
      const platform = podPlatformCell(values, rowNumber);
      const identifiers = productUpcCell(values, rowNumber);
      const skuId = requiredCell(values, "SKU", rowNumber);
      const units = unitsCell(values, "Units", rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Customer Price", rowNumber);
      const printingCostPerUnitMicros = nonNegativeMoneyCell(
        values,
        "Printing Cost Per Unit",
        rowNumber,
      );
      const splitShareBps = percentCell(values, "Split Share %", rowNumber);
      try {
        validateMerchSplitShareBps(splitShareBps, rowNumber);
      } catch (error) {
        if (error instanceof RangeError && error.message.startsWith("invalid_split_share_bps")) {
          throw new StatementParseError(`${error.message}`);
        }
        throw error;
      }
      const currency = currencyCell(values, rowNumber);

      const detail: MerchLineDetail = {
        kind: "pod_fulfillment",
        platform,
        orderId,
        skuId,
        units,
        printingCostPerUnitMicros: printingCostPerUnitMicros.toString(),
        splitShareBps,
        period,
      };

      return merchLine(
        "pod_fulfillment_dump_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        `${skuId} — POD order ${orderId}`,
        POD_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Wholesale consignment payout report — the row's own arithmetic must
// reconcile exactly (gross − commission − shrinkage = reported net); the
// shrinkage allowance is the offset against the net payout.
// ---------------------------------------------------------------------------

const CONSIGNMENT_HEADER = [
  "Payout Period",
  "Location",
  "Payout ID",
  "UPC",
  "SKU",
  "Units Sold",
  "Gross Sales",
  "Commission",
  "Shrinkage Allowance",
  "Reported Net Payout",
  "Currency",
] as const;

const consignmentProfile: StatementProfile = {
  kind: "wholesale_consignment_payout_csv",
  title: "Wholesale consignment payout report CSV (gross, commission, shrinkage, net)",
  laneRightsType: MERCH_RIGHTS_TYPE,
  statementSourceType: MERCH_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, CONSIGNMENT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, CONSIGNMENT_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = consignmentPeriodCell(values, rowNumber);
      const locationCell = values.get("Location") ?? "";
      const location = locationCell.trim() === "" ? null : locationCell.trim();
      const payoutId = requiredCell(values, "Payout ID", rowNumber);
      const identifiers = productUpcCell(values, rowNumber);
      const skuId = requiredCell(values, "SKU", rowNumber);
      const unitsSold = unitsCell(values, "Units Sold", rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Sales", rowNumber);
      const commissionMicros = nonNegativeMoneyCell(values, "Commission", rowNumber);
      const shrinkageAllowanceMicros = nonNegativeMoneyCell(
        values,
        "Shrinkage Allowance",
        rowNumber,
      );
      const reportedNetPayoutMicros = nonNegativeMoneyCell(
        values,
        "Reported Net Payout",
        rowNumber,
      );
      const currency = currencyCell(values, rowNumber);

      // THE RECONCILIATION — the row's own arithmetic, exact: gross −
      // commission − shrinkage allowance must equal the reported net payout.
      // A clawback-shaped row (commission + shrinkage over the gross) has a
      // negative net and refuses. A report that disagrees with itself is an
      // operator quarantine — never silently adjusted.
      const derivedNet = grossMicros - commissionMicros - shrinkageAllowanceMicros;
      if (derivedNet < 0n) {
        throw new StatementParseError(
          `payout_reconciliation_negative:${payoutId}:row_${rowNumber}`,
        );
      }
      if (derivedNet !== reportedNetPayoutMicros) {
        throw new StatementParseError(
          `payout_reconciliation_mismatch:${payoutId}:row_${rowNumber}`,
        );
      }

      const detail: MerchLineDetail = {
        kind: "consignment_payout",
        platform: "wholesale_consignment",
        payoutId,
        skuId,
        unitsSold,
        commissionMicros: commissionMicros.toString(),
        shrinkageAllowanceMicros: shrinkageAllowanceMicros.toString(),
        reportedNetPayoutMicros: reportedNetPayoutMicros.toString(),
        period,
        location,
      };

      return merchLine(
        "wholesale_consignment_payout_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        `${skuId} — consignment ${payoutId}`,
        CONSIGNMENT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Square POS retail sale dump — the net (gross − processing fee) posts.
// ---------------------------------------------------------------------------

const POS_HEADER = [
  "Sale Date",
  "Sale ID",
  "UPC",
  "SKU",
  "Units",
  "Gross Sales",
  "Processing Fee",
  "Currency",
] as const;

const posDumpProfile: StatementProfile = {
  kind: "square_pos_dump_csv",
  title: "Square POS retail sale dump CSV (per sale, gross and processing fee)",
  laneRightsType: MERCH_RIGHTS_TYPE,
  statementSourceType: MERCH_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, POS_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, POS_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Sale Date", rowNumber);
      const saleId = requiredCell(values, "Sale ID", rowNumber);
      const identifiers = productUpcCell(values, rowNumber);
      const skuId = requiredCell(values, "SKU", rowNumber);
      const units = unitsCell(values, "Units", rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Sales", rowNumber);
      const processingFeeMicros = nonNegativeMoneyCell(values, "Processing Fee", rowNumber);
      const currency = currencyCell(values, rowNumber);

      const detail: MerchLineDetail = {
        kind: "pos_sale",
        platform: "square_pos",
        saleId,
        skuId,
        units,
        processingFeeMicros: processingFeeMicros.toString(),
        period,
      };

      return merchLine(
        "square_pos_dump_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        `${skuId} — POS sale ${saleId}`,
        POS_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The merch lane's profiles — dispatched through the shared dispatcher. */
export const MERCH_PROFILES: readonly StatementProfile[] = [
  dtcDumpProfile,
  podDumpProfile,
  consignmentProfile,
  posDumpProfile,
];

/** True when a dispatched profile is the merch lane's. */
export function isMerchProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "shopify_dtc_dump_csv" ||
    kind === "pod_fulfillment_dump_csv" ||
    kind === "wholesale_consignment_payout_csv" ||
    kind === "square_pos_dump_csv"
  );
}
