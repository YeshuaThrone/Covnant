/**
 * CVT recon worker — the art-market lane's ingestion profiles (PR 28, the
 * founder art directive: the ARR resale calculator + gallery and fabrication
 * waterfalls).
 *
 * Five strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on any
 * violation. No industry CSV royalty standard exists for art-market
 * reports — every gallery, auction house, print shop, museum, and estate
 * ships a different layout, so each profile defines ONE strict layout and
 * the profile is the contract, pinned by tests (the books/webtoon/merch
 * precedent). A permissive guesser is the silent-misparse behavior the
 * recon engine exists to prevent:
 *
 *   art_gallery_invoice_csv       — primary gallery sales: sale price −
 *     gallery commission (40–50% founder band, validated) − production −
 *     framing − shipping COGS = net artist realized payout. The Piece Kind
 *     column routes sculpture sales to the sculpture fabrication waterfall
 *     (unique works carry no fabrication pools).
 *
 *   art_auction_resale_report_csv — auction house secondary resales: the
 *     statutory sliding scale keyed on the Jurisdiction Code column, EUR
 *     only, `secondary_resale` rows only (a primary sale in an auction
 *     report is hostile — a primary gallery sale is the invoice lane's).
 *
 *   art_print_shop_sales_csv      — print shop edition sales, keyed on
 *     Edition ID + Artwork ID — the print-edition fabrication waterfall's
 *     revenue feed.
 *
 *   art_museum_licensing_csv      — museum reproduction_license_fee rows
 *     with the copyright agency's collection fee (ARS/DACS, 15–20% founder
 *     band, validated) — the Don Ledger's isolated licensing feed.
 *
 *   art_foundation_estate_audit_csv — foundation/estate audit attestations:
 *     recorded facts of record, never posted, never recouped, never split.
 *
 * Rights separation: art lines are rights_type 'unknown' — art-market
 * revenue is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math (the
 * books/webtoon/gaming/merch precedent). tier_level is null and
 * statement_source_type is null; the Artwork ID column populates the
 * addendum 10 artwork_id column, resale rows populate jurisdiction_code,
 * and the gallery/auction/print-shop rows populate sale_type.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the bounded piece-kind/sale-type/agency/scope vocabularies, the 40–50%
 * gallery commission band, the 15–20% agency collection fee band, positive
 * money cells and units, a VAT leg below the hammer price, two-letter
 * jurisdiction codes, and the `YYYY-MM` period buckets derived from the
 * ISO date cells.
 */

import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  isArtAuditScope,
  isArtCopyrightAgency,
  isArtPieceKind,
  isJurisdictionCodeFormat,
  validateAgencyCollectionFeeBps,
  validateArtPositiveMicros,
  validateArtUnits,
  validateGalleryCommissionBps,
  validateResaleCurrency,
  type ArtAuditScope,
} from "./art";
import { StatementParseError } from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import type {
  ArtLineDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";

const CSV = ",";

/** The art lane's rights family — neither recording nor composition. */
const ART_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The art lane carries no statement_source_type — the profile/artwork
 * columns are the discriminator. */
const ART_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

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
 * A positive money cell — sale and fee rows carry revenue; zero and
 * negative money are hostile rows in this lane.
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
  try {
    validateArtPositiveMicros(money.micros, column, rowNumber);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new StatementParseError(`${error.message}`);
    }
    throw error;
  }
  return money.micros;
}

/**
 * A non-negative money cell — cost and tax legs (production, framing,
 * shipping COGS, VAT, duties, declared audit costs) can legitimately be
 * zero but never negative; a negative leg is a hostile row.
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

/**
 * The report date cell — an ISO calendar date; the row's period bucket is
 * the date's own `YYYY-MM` prefix (the books/webtoon profiles' discipline).
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

/** The units cell — a positive whole count. */
function unitsCell(values: ReadonlyMap<string, string>, rowNumber: number): number {
  const cell = requiredCell(values, "Units", rowNumber);
  if (!/^\d+$/.test(cell)) {
    throw new StatementParseError(`invalid_units:${cell}:row_${rowNumber}`);
  }
  return validateArtUnits(Number(cell), rowNumber);
}

/**
 * A percent cell with at most two decimals ("40", "47.5", "50.00"), parsed
 * into whole basis points with NO float (the fraction's digits ARE the bps
 * digits) — the books profiles' parser.
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

/** A required free-text identifier cell (gallery/shop/museum/lot/audit ids). */
function idCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  return requiredCell(values, column, rowNumber);
}

/**
 * An optional artwork id — the audit scope's rows can attest across a
 * holding (a whole edition or collection) without naming one piece.
 */
function optionalArtworkId(values: ReadonlyMap<string, string>): string | null {
  const cell = values.get("Artwork ID") ?? "";
  const trimmed = cell.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Assembles one art line. grossMicros is the line's reported gross — the
 * sale price, hammer price, gross sale, or license fee; audit rows carry
 * the declared license income as the gross (zero for cost-only audits).
 */
function artLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: ArtLineDetail,
  workTitle: string,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: ART_RIGHTS_TYPE,
    statementSourceType: ART_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the books/webtoon precedent; the column
    // only carries the four music/DSP pipelines and the split engines
    // never read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency,
    grossMicros,
    isAdjustment: false,
    identifiers: {},
    workTitle,
    territory: null,
    platform: artPlatformLabel(detail),
    usageNote: artUsageNote(detail),
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
    bookDetail: null,
    artDetail: detail,
  };
}

/** The platform column's value — the sender identity each row names. */
function artPlatformLabel(detail: ArtLineDetail): string {
  switch (detail.kind) {
    case "gallery_primary_sale":
      return detail.galleryId;
    case "auction_resale":
      return detail.auctionHouse;
    case "print_shop_sale":
      return detail.shopId;
    case "museum_licensing":
      return detail.museumId;
    case "foundation_estate_audit":
      return detail.auditEntityId;
  }
}

/** The usage note — provenance naming the row's kind and its audit cells. */
function artUsageNote(detail: ArtLineDetail): string {
  switch (detail.kind) {
    case "gallery_primary_sale":
      return (
        `art primary sale — gallery ${detail.galleryId} invoice ${detail.invoiceId}` +
        `, artwork ${detail.artworkId}, piece ${detail.pieceKind}` +
        `, price ${detail.salePriceMicros} micros, commission ${detail.galleryCommissionBps} bps`
      );
    case "auction_resale":
      return (
        `art secondary resale — ${detail.auctionHouse} lot ${detail.lotId}` +
        `, artwork ${detail.artworkId}, hammer ${detail.hammerPriceMicros} micros` +
        `, jurisdiction ${detail.jurisdictionCode}`
      );
    case "print_shop_sale":
      return (
        `art print shop sale — ${detail.shopId} order ${detail.orderId}` +
        `, edition ${detail.editionId}, artwork ${detail.artworkId}, units ${detail.units}`
      );
    case "museum_licensing":
      return (
        `art museum licensing — ${detail.museumId} license ${detail.licenseId}` +
        `, artwork ${detail.artworkId}, reproduction ${detail.reproductionType}` +
        `, agency ${detail.agencyCode} at ${detail.agencyCollectionFeeBps} bps`
      );
    case "foundation_estate_audit":
      return (
        `art audit — ${detail.auditEntityId} audit ${detail.auditId}` +
        `, scope ${detail.scope}${detail.artworkId === null ? "" : `, artwork ${detail.artworkId}`}`
      );
  }
}

// ---------------------------------------------------------------------------
// Primary gallery sales — the founder equation's rows, the deduction legs
// recorded verbatim; Piece Kind routes sculpture fabrications.
// ---------------------------------------------------------------------------

const GALLERY_INVOICE_HEADER = [
  "Invoice Date",
  "Gallery ID",
  "Invoice ID",
  "Artwork ID",
  "Title",
  "Piece Kind",
  "Sale Price",
  "Gallery Commission %",
  "Production COGS",
  "Framing COGS",
  "Shipping COGS",
  "Currency",
] as const;

const galleryInvoiceProfile: StatementProfile = {
  kind: "art_gallery_invoice_csv",
  title:
    "Art gallery primary sale invoice CSV (keyed on Artwork ID, 40-50% commission band)",
  laneRightsType: ART_RIGHTS_TYPE,
  statementSourceType: ART_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, GALLERY_INVOICE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, GALLERY_INVOICE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Invoice Date", rowNumber);
      const galleryId = idCell(values, "Gallery ID", rowNumber);
      const invoiceId = idCell(values, "Invoice ID", rowNumber);
      const artworkId = idCell(values, "Artwork ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const pieceKindCell = requiredCell(values, "Piece Kind", rowNumber);
      if (!isArtPieceKind(pieceKindCell)) {
        throw new StatementParseError(`invalid_piece_kind:${pieceKindCell}:row_${rowNumber}`);
      }
      const salePriceMicros = positiveMoneyCell(values, "Sale Price", rowNumber);
      const galleryCommissionBps = percentCell(
        values,
        "Gallery Commission %",
        rowNumber,
      );
      try {
        validateGalleryCommissionBps(galleryCommissionBps, rowNumber);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new StatementParseError(`${error.message}`);
        }
        throw error;
      }
      const productionCogsMicros = nonNegativeMoneyCell(values, "Production COGS", rowNumber);
      const framingCogsMicros = nonNegativeMoneyCell(values, "Framing COGS", rowNumber);
      const shippingCogsMicros = nonNegativeMoneyCell(values, "Shipping COGS", rowNumber);
      const currency = currencyCell(values, rowNumber);

      const detail: ArtLineDetail = {
        kind: "gallery_primary_sale",
        galleryId,
        invoiceId,
        artworkId,
        pieceKind: pieceKindCell,
        salePriceMicros: salePriceMicros.toString(),
        galleryCommissionBps,
        productionCogsMicros: productionCogsMicros.toString(),
        framingCogsMicros: framingCogsMicros.toString(),
        shippingCogsMicros: shippingCogsMicros.toString(),
        period,
      };

      return artLine(
        "art_gallery_invoice_csv",
        rowNumber,
        currency,
        salePriceMicros,
        detail,
        title,
        GALLERY_INVOICE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Auction house secondary resales — the statutory sliding scale's rows.
// `secondary_resale` rows only; EUR only (the scale is EUR-denominated —
// the lane never invents an FX opinion); the VAT leg must sit below the
// hammer price so the royalty basis stays positive.
// ---------------------------------------------------------------------------

const AUCTION_RESALE_HEADER = [
  "Sale Date",
  "Auction House",
  "Lot ID",
  "Artwork ID",
  "Title",
  "Sale Type",
  "Hammer Price",
  "Cross-Border VAT",
  "Import Export Duty",
  "Jurisdiction Code",
  "Currency",
] as const;

const auctionResaleProfile: StatementProfile = {
  kind: "art_auction_resale_report_csv",
  title:
    "Art auction house secondary resale report CSV (jurisdiction-keyed statutory scale, EUR)",
  laneRightsType: ART_RIGHTS_TYPE,
  statementSourceType: ART_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, AUCTION_RESALE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, AUCTION_RESALE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Sale Date", rowNumber);
      const auctionHouse = idCell(values, "Auction House", rowNumber);
      const lotId = idCell(values, "Lot ID", rowNumber);
      const artworkId = idCell(values, "Artwork ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const saleTypeCell = requiredCell(values, "Sale Type", rowNumber);
      if (saleTypeCell !== "secondary_resale") {
        // A primary sale in an auction report is hostile — primary money
        // is the gallery invoice lane's; the scale is secondary-only.
        throw new StatementParseError(`hostile_sale_type:${saleTypeCell}:row_${rowNumber}`);
      }
      const hammerPriceMicros = positiveMoneyCell(values, "Hammer Price", rowNumber);
      const crossBorderVatMicros = nonNegativeMoneyCell(values, "Cross-Border VAT", rowNumber);
      const importExportDutyMicros = nonNegativeMoneyCell(
        values,
        "Import Export Duty",
        rowNumber,
      );
      const jurisdictionCode = requiredCell(values, "Jurisdiction Code", rowNumber).toUpperCase();
      if (!isJurisdictionCodeFormat(jurisdictionCode)) {
        throw new StatementParseError(
          `invalid_jurisdiction_code:${jurisdictionCode}:row_${rowNumber}`,
        );
      }
      const currency = currencyCell(values, rowNumber);
      try {
        validateResaleCurrency(currency, rowNumber);
        // The basis must survive the VAT subtraction — checked at parse so
        // a VAT leg larger than the hammer price never reaches the queue.
        const basis = hammerPriceMicros - crossBorderVatMicros;
        if (basis <= 0n) {
          throw new RangeError(`vat_exceeds_hammer_price:${basis}:row_${rowNumber}`);
        }
      } catch (error) {
        if (error instanceof RangeError) {
          throw new StatementParseError(`${error.message}`);
        }
        throw error;
      }

      const detail: ArtLineDetail = {
        kind: "auction_resale",
        auctionHouse,
        lotId,
        artworkId,
        saleType: "secondary_resale",
        hammerPriceMicros: hammerPriceMicros.toString(),
        crossBorderVatMicros: crossBorderVatMicros.toString(),
        importExportDutyMicros: importExportDutyMicros.toString(),
        jurisdictionCode,
        period,
      };

      return artLine(
        "art_auction_resale_report_csv",
        rowNumber,
        currency,
        hammerPriceMicros,
        detail,
        title,
        AUCTION_RESALE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Print shop edition sales — the print-edition fabrication waterfall's
// revenue feed, keyed on Edition ID + Artwork ID.
// ---------------------------------------------------------------------------

const PRINT_SHOP_SALES_HEADER = [
  "Sale Date",
  "Shop ID",
  "Order ID",
  "Edition ID",
  "Artwork ID",
  "Title",
  "Units",
  "Gross Sale",
  "Currency",
] as const;

const printShopSalesProfile: StatementProfile = {
  kind: "art_print_shop_sales_csv",
  title: "Art print shop edition sales CSV (keyed on Edition ID + Artwork ID)",
  laneRightsType: ART_RIGHTS_TYPE,
  statementSourceType: ART_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, PRINT_SHOP_SALES_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, PRINT_SHOP_SALES_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Sale Date", rowNumber);
      const shopId = idCell(values, "Shop ID", rowNumber);
      const orderId = idCell(values, "Order ID", rowNumber);
      const editionId = idCell(values, "Edition ID", rowNumber);
      const artworkId = idCell(values, "Artwork ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const units = unitsCell(values, rowNumber);
      const grossSaleMicros = positiveMoneyCell(values, "Gross Sale", rowNumber);
      const currency = currencyCell(values, rowNumber);

      const detail: ArtLineDetail = {
        kind: "print_shop_sale",
        shopId,
        orderId,
        editionId,
        artworkId,
        units,
        grossSaleMicros: grossSaleMicros.toString(),
        period,
      };

      return artLine(
        "art_print_shop_sales_csv",
        rowNumber,
        currency,
        grossSaleMicros,
        detail,
        title,
        PRINT_SHOP_SALES_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Museum licensing — the reproduction_license_fee rows, the copyright
// agency's collection fee recorded and deducted. Structurally isolated
// from physical piece sales: its own profile, event space, and posting.
// ---------------------------------------------------------------------------

const MUSEUM_LICENSING_HEADER = [
  "License Date",
  "Museum ID",
  "License ID",
  "Artwork ID",
  "Title",
  "Reproduction Type",
  "License Fee",
  "Agency Code",
  "Agency Collection Fee %",
  "Currency",
] as const;

const MUSEUM_REPRODUCTION_TYPES = [
  "exhibition_catalog",
  "postcard",
  "poster",
  "educational_material",
  "digital_reproduction",
] as const;

function reproductionTypeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): (typeof MUSEUM_REPRODUCTION_TYPES)[number] {
  const cell = requiredCell(values, "Reproduction Type", rowNumber);
  if (!(MUSEUM_REPRODUCTION_TYPES as readonly string[]).includes(cell)) {
    throw new StatementParseError(`invalid_reproduction_type:${cell}:row_${rowNumber}`);
  }
  return cell as (typeof MUSEUM_REPRODUCTION_TYPES)[number];
}

const museumLicensingProfile: StatementProfile = {
  kind: "art_museum_licensing_csv",
  title:
    "Art museum licensing CSV (reproduction license fees, ARS/DACS 15-20% collection fee)",
  laneRightsType: ART_RIGHTS_TYPE,
  statementSourceType: ART_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, MUSEUM_LICENSING_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, MUSEUM_LICENSING_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "License Date", rowNumber);
      const museumId = idCell(values, "Museum ID", rowNumber);
      const licenseId = idCell(values, "License ID", rowNumber);
      const artworkId = idCell(values, "Artwork ID", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const reproductionType = reproductionTypeCell(values, rowNumber);
      const licenseFeeMicros = positiveMoneyCell(values, "License Fee", rowNumber);
      const agencyCodeCell = requiredCell(values, "Agency Code", rowNumber).toLowerCase();
      if (!isArtCopyrightAgency(agencyCodeCell)) {
        throw new StatementParseError(`invalid_agency_code:${agencyCodeCell}:row_${rowNumber}`);
      }
      const agencyCollectionFeeBps = percentCell(
        values,
        "Agency Collection Fee %",
        rowNumber,
      );
      try {
        validateAgencyCollectionFeeBps(agencyCollectionFeeBps, rowNumber);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new StatementParseError(`${error.message}`);
        }
        throw error;
      }
      const currency = currencyCell(values, rowNumber);

      const detail: ArtLineDetail = {
        kind: "museum_licensing",
        museumId,
        licenseId,
        artworkId,
        reproductionType,
        licenseFeeMicros: licenseFeeMicros.toString(),
        agencyCode: agencyCodeCell,
        agencyCollectionFeeBps,
        period,
      };

      return artLine(
        "art_museum_licensing_csv",
        rowNumber,
        currency,
        licenseFeeMicros,
        detail,
        title,
        MUSEUM_LICENSING_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Foundation/estate audits — attestation facts of record. Declared costs
// and income are non-negative (a zero-cost audit attests income only);
// the Artwork ID is optional (an audit can cover a whole holding). Rows
// record, never post.
// ---------------------------------------------------------------------------

const FOUNDATION_ESTATE_AUDIT_HEADER = [
  "Audit Date",
  "Audit Entity ID",
  "Audit ID",
  "Artwork ID",
  "Scope",
  "Declared Fabrication Cost",
  "Declared License Income",
  "Currency",
] as const;

function auditScopeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): ArtAuditScope {
  const cell = requiredCell(values, "Scope", rowNumber);
  if (!isArtAuditScope(cell)) {
    throw new StatementParseError(`invalid_audit_scope:${cell}:row_${rowNumber}`);
  }
  return cell;
}

const foundationEstateAuditProfile: StatementProfile = {
  kind: "art_foundation_estate_audit_csv",
  title:
    "Art foundation/estate audit CSV (attestation facts of record, never posted)",
  laneRightsType: ART_RIGHTS_TYPE,
  statementSourceType: ART_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, FOUNDATION_ESTATE_AUDIT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, FOUNDATION_ESTATE_AUDIT_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const period = periodFromDateCell(values, "Audit Date", rowNumber);
      const auditEntityId = idCell(values, "Audit Entity ID", rowNumber);
      const auditId = idCell(values, "Audit ID", rowNumber);
      const artworkId = optionalArtworkId(values);
      const scope = auditScopeCell(values, rowNumber);
      const declaredFabricationCostMicros = nonNegativeMoneyCell(
        values,
        "Declared Fabrication Cost",
        rowNumber,
      );
      const declaredLicenseIncomeMicros = nonNegativeMoneyCell(
        values,
        "Declared License Income",
        rowNumber,
      );
      const currency = currencyCell(values, rowNumber);

      const detail: ArtLineDetail = {
        kind: "foundation_estate_audit",
        auditEntityId,
        auditId,
        artworkId,
        scope,
        declaredFabricationCostMicros: declaredFabricationCostMicros.toString(),
        declaredLicenseIncomeMicros: declaredLicenseIncomeMicros.toString(),
        period,
      };

      // The audit's gross is its declared license income — an honest read
      // of the attestation (usually zero); the row never posts regardless.
      return artLine(
        "art_foundation_estate_audit_csv",
        rowNumber,
        currency,
        declaredLicenseIncomeMicros,
        detail,
        detail.artworkId === null ? "holding audit" : "artwork audit",
        FOUNDATION_ESTATE_AUDIT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The art lane's profiles — dispatched through the shared dispatcher. */
export const ART_PROFILES: readonly StatementProfile[] = [
  galleryInvoiceProfile,
  auctionResaleProfile,
  printShopSalesProfile,
  museumLicensingProfile,
  foundationEstateAuditProfile,
];

/** True when a dispatched profile is the art lane's. */
export function isArtProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "art_gallery_invoice_csv" ||
    kind === "art_auction_resale_report_csv" ||
    kind === "art_print_shop_sales_csv" ||
    kind === "art_museum_licensing_csv" ||
    kind === "art_foundation_estate_audit_csv"
  );
}
