/**
 * CVT recon worker — gaming ingestion profiles (PR 12).
 *
 * Five strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on any
 * violation. The profile is the contract, pinned by checked-in fixtures —
 * a permissive guesser is the silent-misparse behavior the recon engine
 * exists to prevent.
 *
 *   epic_games_sales_csv — an Epic publisher sales report covering both
 *     storefronts of the Epic family (Epic Games Store + Unreal Engine
 *     Marketplace): the Store cell discriminates the engine-royalty waiver
 *     (0% up to $1M gross annual per product, 3.5% once crossed, waived on
 *     EGS sales) and the Product ID scopes the per-product annual
 *     accumulator.
 *
 *   unity_asset_store_payout_csv — a Unity publisher payout report.
 *
 *   roblox_devex_csv — a Roblox DevEx conversion log: each row crystallizes
 *     earned Robux into fiat at the rate RECORDED on the row (the founder's
 *     rate-logging rule), the platform fee deducts, and the net posts.
 *
 *   steamworks_sales_csv — a Steamworks sales report (the 30% commission).
 *
 *   apple_vision_pro_payments_csv — an App Store Connect payments report
 *     for Vision Pro spatial titles (the 15-30% commission band).
 *
 * Rights separation: gaming lines are rights_type 'unknown' — a game or
 * asset sale is neither recording nor composition royalty, so the split-
 * quarantine rule keeps them out of music split math. tier_level is null
 * (never a waterfall line) and statement_source_type is 'game_platform'
 * (the gaming columns PR 1 shipped) — the revenue discriminator, the way
 * tier_level+statement_source_type are the film discriminator and
 * revenue_channel is the podcast discriminator. rights_pipeline rides
 * inert provenance, the film/podcast profiles' precedent.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the sale-type vocabulary, the per-platform commission band (Apple 15-30%,
 * Steam 30, EGS 12, Unity 30, Roblox 30 — outside is hostile), the
 * secondary-resale royalty band (5-10% on secondary lines, forbidden on
 * primary), the DevEx conversion operands (positive Robux and rate), and
 * the annual date every accumulator row needs.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import type {
  MatchQueueRightsType,
  MatchQueueSaleType,
  MatchQueueStatementSourceType,
} from "@/modules/sdk/records";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  devexGrossMicros,
  validateCommissionBps,
  validateResaleRoyaltyBps,
} from "./gaming";
import { StatementParseError } from "./records";
import type {
  GamingLineDetail,
  GamingPlatform,
  ParsedStatementLine,
  ReconIdentifiers,
  StatementProfile,
} from "./records";

const CSV = ",";

/** The gaming lane's rights family — neither recording nor composition. */
const GAMING_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The statement kind the gaming columns (PR 1) shipped for this lane. */
const GAMING_STATEMENT_SOURCE_TYPE: MatchQueueStatementSourceType =
  "game_platform";

/** Every sale type, for the row-level vocabulary check. */
const SALE_TYPES: readonly MatchQueueSaleType[] = [
  "primary",
  "secondary_resale",
];

/** The sale-type cell — the bounded primary/secondary vocabulary. */
function saleTypeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): MatchQueueSaleType {
  const cell = requiredCell(values, "Sale Type", rowNumber);
  if (!SALE_TYPES.includes(cell as MatchQueueSaleType)) {
    throw new StatementParseError(`invalid_sale_type:${cell}:row_${rowNumber}`);
  }
  return cell as MatchQueueSaleType;
}

/**
 * A percent cell with at most two decimals ("30", "12.5", "30.00"), parsed
 * into whole basis points with NO float (the fraction's digits ARE the bps
 * digits). Empty is allowed (the caller decides when the rate is required).
 */
function optionalPercentCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): number | null {
  const cell = (values.get(column) ?? "").trim();
  if (cell === "") return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(cell)) {
    throw new StatementParseError(`invalid_percent:${column}:${cell}:row_${rowNumber}`);
  }
  const [whole, fraction = ""] = cell.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
}

/** The commission cell — validated against the platform's band, row-scoped. */
function commissionCell(
  values: ReadonlyMap<string, string>,
  platform: GamingPlatform,
  rowNumber: number,
): number {
  const bps = optionalPercentCell(values, "Platform Commission %", rowNumber);
  if (bps === null) {
    throw new StatementParseError(`missing_commission:row_${rowNumber}`);
  }
  try {
    validateCommissionBps(platform, bps);
  } catch (error) {
    throw new StatementParseError(
      `${error instanceof RangeError ? error.message : "commission_invalid"}:row_${rowNumber}`,
    );
  }
  return bps;
}

/** The resale-royalty cell — the 5-10% band on secondary lines only. */
function resaleRoyaltyCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): number | null {
  const bps = optionalPercentCell(values, "Resale Royalty %", rowNumber);
  try {
    return validateResaleRoyaltyBps(saleTypeCell(values, rowNumber), bps);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new StatementParseError(`${error.message}:row_${rowNumber}`);
    }
    throw error;
  }
}

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
 * The annual date cell — an ISO calendar date; its UTC year is the
 * per-product annual accumulator's bucket. Never guessed.
 */
function annualDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): { date: Date; year: number } {
  const cell = requiredCell(values, column, rowNumber);
  const parsed = new Date(`${cell}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell) || Number.isNaN(parsed.getTime())) {
    throw new StatementParseError(`invalid_date:${cell}:row_${rowNumber}`);
  }
  return { date: parsed, year: parsed.getUTCFullYear() };
}

/** Canonicalizes the catalog DOI — the lane's vault lookup code. */
function catalogDoiCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): ReconIdentifiers {
  const trimmed = (values.get("Catalog DOI") ?? "").trim();
  if (trimmed === "") return {};
  const canonical = canonicalizeIdentifier("DOI", trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_doi:row_${rowNumber}`);
  }
  return { DOI: canonical };
}

/**
 * Assembles one gaming line. grossMicros is the line's gross FIAT revenue —
 * the raw cell on fiat-native platforms, the DevEx conversion (virtual ×
 * recorded rate) on Roblox rows.
 */
function gamingLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: GamingLineDetail,
  identifiers: ReconIdentifiers,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: GAMING_RIGHTS_TYPE,
    statementSourceType: GAMING_STATEMENT_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the film/podcast precedent; the column
    // only carries the four music/DSP pipelines and the split engines never
    // read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: null,
    currency,
    grossMicros,
    isAdjustment: grossMicros < 0n,
    identifiers,
    workTitle: detail.itemName,
    territory: null,
    platform: detail.platform,
    usageNote: `gaming ${detail.platform} — ${detail.saleType}${detail.virtualCurrencyCode === null ? "" : ` (${detail.virtualAmount} ${detail.virtualCurrencyCode})`}`,
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: detail,
    livestreamDetail: null,
    webtoonDetail: null,
  };
}

/** The shared row tail — item identity, sale type, DOI, currency. */
function commonRowFields(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): {
  saleType: MatchQueueSaleType;
  itemId: string;
  itemName: string | null;
  identifiers: ReconIdentifiers;
  currency: string;
} {
  return {
    saleType: saleTypeCell(values, rowNumber),
    itemId: requiredCell(values, "Item ID", rowNumber),
    itemName: (values.get("Item Name") ?? "").trim() || null,
    identifiers: catalogDoiCell(values, rowNumber),
    currency: requiredCell(values, "Currency", rowNumber).toUpperCase(),
  };
}

// ---------------------------------------------------------------------------
// Epic publisher sales report — the Epic family's two storefronts in one
// report. The Store cell discriminates the platform: epic_games_store sales
// are WAIVED (the 12% commission is the engine's take there);
// unreal_marketplace sales bear the engine royalty above the $1M annual
// per-product threshold. The Product ID scopes the accumulator.
// ---------------------------------------------------------------------------

const EPIC_HEADER = [
  "Sale Date",
  "Store",
  "Product ID",
  "Product Name",
  "Item ID",
  "Item Name",
  "Sale Type",
  "Gross",
  "Platform Commission %",
  "Resale Royalty %",
  "Catalog DOI",
  "Currency",
] as const;

function epicStoreCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): GamingPlatform {
  const cell = requiredCell(values, "Store", rowNumber);
  if (cell !== "epic_games_store" && cell !== "unreal_marketplace") {
    throw new StatementParseError(`invalid_store:${cell}:row_${rowNumber}`);
  }
  return cell;
}

const epicSalesProfile: StatementProfile = {
  kind: "epic_games_sales_csv",
  title: "Epic publisher sales report CSV (Epic Games Store + Unreal Marketplace)",
  laneRightsType: GAMING_RIGHTS_TYPE,
  statementSourceType: GAMING_STATEMENT_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, EPIC_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, EPIC_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const platform = epicStoreCell(values, rowNumber);
      const { saleType, itemId, itemName, identifiers, currency } =
        commonRowFields(values, rowNumber);
      const annual = annualDateCell(values, "Sale Date", rowNumber);
      const gross = moneyCell(values, "Gross", rowNumber);
      return gamingLine(
        "epic_games_sales_csv",
        rowNumber,
        currency,
        gross.micros,
        {
          platform,
          productId: requiredCell(values, "Product ID", rowNumber),
          productName: (values.get("Product Name") ?? "").trim() || null,
          itemId,
          itemName,
          saleType,
          commissionBps: commissionCell(values, platform, rowNumber),
          // The waiver IS the store discrimination: only Unreal Marketplace
          // sales bear the engine royalty.
          engineRoyaltySubject: platform === "unreal_marketplace",
          resaleRoyaltyBps: resaleRoyaltyCell(values, rowNumber),
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          annualYear: annual.year,
        },
        identifiers,
        EPIC_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Unity Asset Store payout report — the 30% commission, item-scoped.
// ---------------------------------------------------------------------------

const UNITY_HEADER = [
  "Payout Date",
  "Item ID",
  "Item Name",
  "Sale Type",
  "Gross",
  "Platform Commission %",
  "Resale Royalty %",
  "Catalog DOI",
  "Currency",
] as const;

const unityAssetStoreProfile: StatementProfile = {
  kind: "unity_asset_store_payout_csv",
  title: "Unity Asset Store publisher payout CSV",
  laneRightsType: GAMING_RIGHTS_TYPE,
  statementSourceType: GAMING_STATEMENT_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, UNITY_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, UNITY_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const { saleType, itemId, itemName, identifiers, currency } =
        commonRowFields(values, rowNumber);
      const annual = annualDateCell(values, "Payout Date", rowNumber);
      const gross = moneyCell(values, "Gross", rowNumber);
      return gamingLine(
        "unity_asset_store_payout_csv",
        rowNumber,
        currency,
        gross.micros,
        {
          platform: "unity_asset_store",
          productId: null,
          productName: null,
          itemId,
          itemName,
          saleType,
          commissionBps: commissionCell(values, "unity_asset_store", rowNumber),
          engineRoyaltySubject: false,
          resaleRoyaltyBps: resaleRoyaltyCell(values, rowNumber),
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          annualYear: annual.year,
        },
        identifiers,
        UNITY_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Roblox DevEx conversion log — each row converts earned Robux to fiat at
// the rate recorded ON the row, deducts the platform fee, and the net
// posts. The virtual cells (currency, amount, rate) ride the queue row
// verbatim so every conversion is auditable from the row alone.
// ---------------------------------------------------------------------------

const ROBLOX_HEADER = [
  "Conversion Date",
  "Item ID",
  "Item Name",
  "Sale Type",
  "Robux Amount",
  "Exchange Rate",
  "Platform Fee %",
  "Resale Royalty %",
  "Catalog DOI",
  "Currency",
] as const;

const robloxDevexProfile: StatementProfile = {
  kind: "roblox_devex_csv",
  title: "Roblox DevEx conversion log CSV",
  laneRightsType: GAMING_RIGHTS_TYPE,
  statementSourceType: GAMING_STATEMENT_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, ROBLOX_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, ROBLOX_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const { saleType, itemId, itemName, identifiers, currency } =
        commonRowFields(values, rowNumber);
      const annual = annualDateCell(values, "Conversion Date", rowNumber);

      // The conversion operands — a hostile row is one the converter cannot
      // verify: a non-positive Robux balance or a missing/zero rate (a
      // conversion at a zero rate invents money from nothing).
      const robux = moneyCell(values, "Robux Amount", rowNumber);
      if (robux.negative || robux.micros <= 0n) {
        throw new StatementParseError(
          `invalid_robux_amount:${values.get("Robux Amount") ?? ""}:row_${rowNumber}`,
        );
      }
      const rate = moneyCell(values, "Exchange Rate", rowNumber);
      if (rate.negative || rate.micros <= 0n) {
        throw new StatementParseError(
          `invalid_exchange_rate:${values.get("Exchange Rate") ?? ""}:row_${rowNumber}`,
        );
      }
      const grossMicros = devexGrossMicros(robux.micros, rate.micros);

      // The commission column is "Platform Fee %" on the DevEx log (the
      // same platform-band validation, the Roblox rate pinned).
      const feeBps = optionalPercentCell(values, "Platform Fee %", rowNumber);
      if (feeBps === null) {
        throw new StatementParseError(`missing_commission:row_${rowNumber}`);
      }
      try {
        validateCommissionBps("roblox", feeBps);
      } catch (error) {
        throw new StatementParseError(
          `${error instanceof RangeError ? error.message : "commission_invalid"}:row_${rowNumber}`,
        );
      }

      return gamingLine(
        "roblox_devex_csv",
        rowNumber,
        currency,
        grossMicros,
        {
          platform: "roblox",
          productId: null,
          productName: null,
          itemId,
          itemName,
          saleType,
          commissionBps: feeBps,
          engineRoyaltySubject: false,
          resaleRoyaltyBps: resaleRoyaltyCell(values, rowNumber),
          virtualCurrencyCode: "ROBUX",
          // The exact decimal texts, verbatim — the recorded conversion
          // log (the founder's rate-logging rule), never a recomputation.
          virtualAmount: (values.get("Robux Amount") ?? "").trim(),
          exchangeRate: (values.get("Exchange Rate") ?? "").trim(),
          annualYear: annual.year,
        },
        identifiers,
        ROBLOX_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Steamworks sales report — the 30% commission.
// ---------------------------------------------------------------------------

const STEAM_HEADER = [
  "Sale Date",
  "Product ID",
  "Product Name",
  "Item ID",
  "Item Name",
  "Sale Type",
  "Gross",
  "Platform Commission %",
  "Resale Royalty %",
  "Catalog DOI",
  "Currency",
] as const;

const steamworksProfile: StatementProfile = {
  kind: "steamworks_sales_csv",
  title: "Steamworks sales report CSV",
  laneRightsType: GAMING_RIGHTS_TYPE,
  statementSourceType: GAMING_STATEMENT_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, STEAM_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, STEAM_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const { saleType, itemId, itemName, identifiers, currency } =
        commonRowFields(values, rowNumber);
      const annual = annualDateCell(values, "Sale Date", rowNumber);
      const gross = moneyCell(values, "Gross", rowNumber);
      return gamingLine(
        "steamworks_sales_csv",
        rowNumber,
        currency,
        gross.micros,
        {
          platform: "steamworks",
          productId: requiredCell(values, "Product ID", rowNumber),
          productName: (values.get("Product Name") ?? "").trim() || null,
          itemId,
          itemName,
          saleType,
          commissionBps: commissionCell(values, "steamworks", rowNumber),
          engineRoyaltySubject: false,
          resaleRoyaltyBps: resaleRoyaltyCell(values, rowNumber),
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          annualYear: annual.year,
        },
        identifiers,
        STEAM_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// App Store Connect payments report for Vision Pro spatial titles — the
// Apple 15-30% commission band.
// ---------------------------------------------------------------------------

const APPLE_HEADER = [
  "Payment Date",
  "Product ID",
  "Product Name",
  "Item ID",
  "Item Name",
  "Sale Type",
  "Gross",
  "Platform Commission %",
  "Resale Royalty %",
  "Catalog DOI",
  "Currency",
] as const;

const appleVisionProProfile: StatementProfile = {
  kind: "apple_vision_pro_payments_csv",
  title: "App Store Connect Vision Pro payments CSV",
  laneRightsType: GAMING_RIGHTS_TYPE,
  statementSourceType: GAMING_STATEMENT_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, APPLE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, APPLE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const { saleType, itemId, itemName, identifiers, currency } =
        commonRowFields(values, rowNumber);
      const annual = annualDateCell(values, "Payment Date", rowNumber);
      const gross = moneyCell(values, "Gross", rowNumber);
      return gamingLine(
        "apple_vision_pro_payments_csv",
        rowNumber,
        currency,
        gross.micros,
        {
          platform: "apple_vision_pro",
          productId: requiredCell(values, "Product ID", rowNumber),
          productName: (values.get("Product Name") ?? "").trim() || null,
          itemId,
          itemName,
          saleType,
          commissionBps: commissionCell(values, "apple_vision_pro", rowNumber),
          engineRoyaltySubject: false,
          resaleRoyaltyBps: resaleRoyaltyCell(values, rowNumber),
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          annualYear: annual.year,
        },
        identifiers,
        APPLE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The gaming lane's profiles — dispatched through the shared dispatcher. */
export const GAMING_PROFILES: readonly StatementProfile[] = [
  epicSalesProfile,
  unityAssetStoreProfile,
  robloxDevexProfile,
  steamworksProfile,
  appleVisionProProfile,
];

/** True when a dispatched profile is the gaming lane's. */
export function isGamingProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "epic_games_sales_csv" ||
    kind === "unity_asset_store_payout_csv" ||
    kind === "roblox_devex_csv" ||
    kind === "steamworks_sales_csv" ||
    kind === "apple_vision_pro_payments_csv"
  );
}
