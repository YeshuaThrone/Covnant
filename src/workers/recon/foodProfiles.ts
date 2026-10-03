/**
 * CVT recon worker — the food lane's five strict ingestion profiles (PR 40,
 * the founder food directive): third-party delivery app order feeds
 * (DoorDash, UberEats, Grubhub), restaurant POS ticket streams (Toast,
 * Square), meal-kit production volume, grocery CPG scanner logs, and bulk
 * food supplier rebate statements (Sysco, US Foods). Same posture as every
 * lane's strict profile — the EXACT header (order and columns), every cell
 * required (no null guesses), bounded vocabularies, whole-file rejection,
 * and the sender's own row id carried through as the event identity core.
 * Every sender repeats the three identity columns the directive keys the
 * lane on — Chef ID, Recipe ID, and Ghost Kitchen Location ID (the rebate
 * statement routes by location, so it repeats Chef/Recipe-free — the
 * location is its routing key) — plus the month period and the row
 * currency. Money cells convert through the house strict converter (sender
 * formatting normalized, statement micros out) and reject negatives — this
 * lane's legs are positive sales, margins, deductions, and kickbacks; a
 * refund has no vocabulary here and is never guessed into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isFoodPeriod } from "./food";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  FoodCobrandScanDetail,
  FoodDeliveryOrderDetail,
  FoodLineDetail,
  FoodMealKitDetail,
  FoodPosTicketDetail,
  FoodRebateDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The food lane's rights family — neither recording nor composition. */
const FOOD_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The food lane carries no statement_source_type — the profile and the
 * chef/recipe/location keys are the discriminator (the fitness precedent). */
const FOOD_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const DELIVERY_ORDER_HEADER = [
  "Order ID",
  "Platform",
  "Chef ID",
  "Recipe ID",
  "Ghost Kitchen Location ID",
  "Units Sold",
  "Gross Menu Item Sales",
  "Approved Ingredient COGS",
  "Delivery Platform Engine Cut",
  "Local Food Service Taxes",
  "Currency",
  "Reporting Period",
] as const;

const POS_TICKET_HEADER = [
  "Ticket ID",
  "Platform",
  "Chef ID",
  "Recipe ID",
  "Ghost Kitchen Location ID",
  "Tickets",
  "Physical Preparation Margin",
  "Currency",
  "Reporting Period",
] as const;

const MEAL_KIT_HEADER = [
  "Production Batch ID",
  "Chef ID",
  "Recipe ID",
  "Ghost Kitchen Location ID",
  "Meal Kits Produced",
  "Cook Cycles Executed",
  "Currency",
  "Reporting Period",
] as const;

const CPG_SCAN_HEADER = [
  "Scan ID",
  "Chef ID",
  "Recipe ID",
  "Ghost Kitchen Location ID",
  "Units Scanned",
  "Gross Scanner Sales",
  "Currency",
  "Reporting Period",
] as const;

const REBATE_HEADER = [
  "Rebate ID",
  "Supplier",
  "Ghost Kitchen Location ID",
  "Rebate Basis Purchases",
  "Volume Rebate Amount",
  "Currency",
  "Reporting Period",
] as const;

/** Bounded vocabularies — a cell outside its family is a row-scoped
 * rejection, never a guess. The delivery platforms are the directive's
 * three third-party feeds; the POS platforms are the directive's two
 * ticket streams; the bulk food suppliers are the directive's named
 * rebate programs. */
const DELIVERY_PLATFORMS = new Set(["doordash", "ubereats", "grubhub"]);
const POS_PLATFORMS = new Set(["toast", "square"]);
const SUPPLIERS = new Set(["sysco", "us_foods"]);

function parsePositiveCents(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  // 1 dollar = 1e8 statement micros; 1e6 micros per cent (the house
  // fixed-point discipline).
  return Number(parsed.micros / 1_000_000n);
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
  if (!isFoodPeriod(period)) {
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
 * The parsed line constructor — one shape for all five senders, the food
 * detail riding as the lane discriminator (the fitness precedent). The
 * line's gross is the row's money basis in statement micros (delivery
 * orders = the gross menu item sales; POS tickets = the physical
 * preparation margin; CPG scans = the gross scanner sales; rebate rows =
 * the volume kickback; meal-kit batches price no money themselves — their
 * micro-royalty is computed at walk time).
 */
function foodLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: FoodLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: FOOD_RIGHTS_TYPE,
    statementSourceType: FOOD_SOURCE_TYPE,
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
    usageNote: foodUsageNote(detail),
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
    foodDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's three
 * identity keys. */
function foodUsageNote(detail: FoodLineDetail): string {
  const identity =
    "chefId" in detail
      ? `, chef ${detail.chefId}, recipe ${detail.recipeId}, location ${detail.ghostKitchenLocationId}`
      : `, location ${detail.ghostKitchenLocationId}`;
  return `food revenue — ${detail.sender} row ${detail.senderRowId}${identity}`;
}

// ---------------------------------------------------------------------------
// Profile 1 — third-party delivery app order feeds (DoorDash, UberEats,
// Grubhub). The order legs of record: the units the tier walk advances and
// the four money legs the Net Recipe Realization calculator consumes.
// ---------------------------------------------------------------------------

const deliveryOrderProfile: StatementProfile = {
  kind: "food_delivery_orders_csv",
  title: "Third-party delivery app order feed CSV (one row per order batch)",
  laneRightsType: FOOD_RIGHTS_TYPE,
  statementSourceType: FOOD_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, DELIVERY_ORDER_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...DELIVERY_ORDER_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const platform = vocabularyCell(values, "Platform", DELIVERY_PLATFORMS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const unitsSold = parseCountCell(
        requiredCell(values, "Units Sold", rowNumber),
        "Units Sold",
        rowNumber,
      );
      if (unitsSold === 0) {
        throw new Error(`delivery_row_prices_nothing:row_${rowNumber}`);
      }
      const grossMenuItemSalesCents = parsePositiveCents(
        requiredCell(values, "Gross Menu Item Sales", rowNumber),
        "Gross Menu Item Sales",
        rowNumber,
      );
      const detail: FoodDeliveryOrderDetail = {
        sender: "delivery_app_order",
        senderRowId: requiredCell(values, "Order ID", rowNumber),
        platform: platform as FoodDeliveryOrderDetail["platform"],
        chefId: requiredCell(values, "Chef ID", rowNumber),
        recipeId: requiredCell(values, "Recipe ID", rowNumber),
        ghostKitchenLocationId: requiredCell(values, "Ghost Kitchen Location ID", rowNumber),
        period,
        currency,
        unitsSold,
        grossMenuItemSalesCents,
        approvedIngredientCogsCents: parsePositiveCents(
          requiredCell(values, "Approved Ingredient COGS", rowNumber),
          "Approved Ingredient COGS",
          rowNumber,
        ),
        deliveryPlatformEngineCutCents: parsePositiveCents(
          requiredCell(values, "Delivery Platform Engine Cut", rowNumber),
          "Delivery Platform Engine Cut",
          rowNumber,
        ),
        localFoodServiceTaxesCents: parsePositiveCents(
          requiredCell(values, "Local Food Service Taxes", rowNumber),
          "Local Food Service Taxes",
          rowNumber,
        ),
      };
      return foodLine(
        "food_delivery_orders_csv",
        rowNumber,
        detail,
        grossMenuItemSalesCents,
        DELIVERY_ORDER_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — restaurant POS ticket streams (Toast, Square). The physical
// preparation margin the host kitchen operator split routes.
// ---------------------------------------------------------------------------

const posTicketProfile: StatementProfile = {
  kind: "food_pos_tickets_csv",
  title: "Restaurant POS ticket stream CSV (one row per ticket batch)",
  laneRightsType: FOOD_RIGHTS_TYPE,
  statementSourceType: FOOD_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, POS_TICKET_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...POS_TICKET_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const platform = vocabularyCell(values, "Platform", POS_PLATFORMS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const tickets = parseCountCell(
        requiredCell(values, "Tickets", rowNumber),
        "Tickets",
        rowNumber,
      );
      if (tickets === 0) {
        throw new Error(`pos_row_prices_nothing:row_${rowNumber}`);
      }
      const physicalPreparationMarginCents = parsePositiveCents(
        requiredCell(values, "Physical Preparation Margin", rowNumber),
        "Physical Preparation Margin",
        rowNumber,
      );
      if (physicalPreparationMarginCents === 0) {
        throw new Error(`pos_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: FoodPosTicketDetail = {
        sender: "pos_ticket",
        senderRowId: requiredCell(values, "Ticket ID", rowNumber),
        platform: platform as FoodPosTicketDetail["platform"],
        chefId: requiredCell(values, "Chef ID", rowNumber),
        recipeId: requiredCell(values, "Recipe ID", rowNumber),
        ghostKitchenLocationId: requiredCell(values, "Ghost Kitchen Location ID", rowNumber),
        period,
        currency,
        tickets,
        physicalPreparationMarginCents,
      };
      return foodLine(
        "food_pos_tickets_csv",
        rowNumber,
        detail,
        physicalPreparationMarginCents,
        POS_TICKET_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — meal-kit production volume. The batch's cook-cycle executions
// the per-execution micro-fee policy prices.
// ---------------------------------------------------------------------------

const mealKitProfile: StatementProfile = {
  kind: "food_meal_kit_production_csv",
  title: "Meal-kit production volume CSV (one row per production batch)",
  laneRightsType: FOOD_RIGHTS_TYPE,
  statementSourceType: FOOD_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, MEAL_KIT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...MEAL_KIT_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const mealKitsProduced = parseCountCell(
        requiredCell(values, "Meal Kits Produced", rowNumber),
        "Meal Kits Produced",
        rowNumber,
      );
      const cookCyclesExecuted = parseCountCell(
        requiredCell(values, "Cook Cycles Executed", rowNumber),
        "Cook Cycles Executed",
        rowNumber,
      );
      if (cookCyclesExecuted === 0) {
        throw new Error(`mealkit_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: FoodMealKitDetail = {
        sender: "meal_kit_production",
        senderRowId: requiredCell(values, "Production Batch ID", rowNumber),
        chefId: requiredCell(values, "Chef ID", rowNumber),
        recipeId: requiredCell(values, "Recipe ID", rowNumber),
        ghostKitchenLocationId: requiredCell(values, "Ghost Kitchen Location ID", rowNumber),
        period,
        currency,
        mealKitsProduced,
        cookCyclesExecuted,
      };
      return foodLine(
        "food_meal_kit_production_csv",
        rowNumber,
        detail,
        0,
        MEAL_KIT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — grocery CPG scanner logs. The co-branded product's retail
// scans: the scanner sales the recipe schedule's CPG royalty rate prices
// before the weighted routing.
// ---------------------------------------------------------------------------

const cpgScanProfile: StatementProfile = {
  kind: "food_grocery_cpg_scans_csv",
  title: "Grocery CPG scanner log CSV (one row per scan batch)",
  laneRightsType: FOOD_RIGHTS_TYPE,
  statementSourceType: FOOD_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, CPG_SCAN_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...CPG_SCAN_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const unitsScanned = parseCountCell(
        requiredCell(values, "Units Scanned", rowNumber),
        "Units Scanned",
        rowNumber,
      );
      if (unitsScanned === 0) {
        throw new Error(`cpg_row_prices_nothing:row_${rowNumber}`);
      }
      const grossScannerSalesCents = parsePositiveCents(
        requiredCell(values, "Gross Scanner Sales", rowNumber),
        "Gross Scanner Sales",
        rowNumber,
      );
      if (grossScannerSalesCents === 0) {
        throw new Error(`cpg_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: FoodCobrandScanDetail = {
        sender: "grocery_cpg_scan",
        senderRowId: requiredCell(values, "Scan ID", rowNumber),
        chefId: requiredCell(values, "Chef ID", rowNumber),
        recipeId: requiredCell(values, "Recipe ID", rowNumber),
        ghostKitchenLocationId: requiredCell(values, "Ghost Kitchen Location ID", rowNumber),
        period,
        currency,
        unitsScanned,
        grossScannerSalesCents,
      };
      return foodLine(
        "food_grocery_cpg_scans_csv",
        rowNumber,
        detail,
        grossScannerSalesCents,
        CPG_SCAN_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 5 — bulk food supplier rebate statements (Sysco, US Foods). The
// volume kickback of record the operator waterfall routes proportionally.
// ---------------------------------------------------------------------------

const rebateProfile: StatementProfile = {
  kind: "food_supplier_rebates_csv",
  title: "Bulk food supplier rebate statement CSV (one row per rebate)",
  laneRightsType: FOOD_RIGHTS_TYPE,
  statementSourceType: FOOD_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, REBATE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...REBATE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const supplier = vocabularyCell(values, "Supplier", SUPPLIERS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const volumeRebateCents = parsePositiveCents(
        requiredCell(values, "Volume Rebate Amount", rowNumber),
        "Volume Rebate Amount",
        rowNumber,
      );
      if (volumeRebateCents === 0) {
        throw new Error(`rebate_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: FoodRebateDetail = {
        sender: "supplier_rebate",
        senderRowId: requiredCell(values, "Rebate ID", rowNumber),
        supplier: supplier as FoodRebateDetail["supplier"],
        ghostKitchenLocationId: requiredCell(values, "Ghost Kitchen Location ID", rowNumber),
        period,
        currency,
        rebateBasisCents: parsePositiveCents(
          requiredCell(values, "Rebate Basis Purchases", rowNumber),
          "Rebate Basis Purchases",
          rowNumber,
        ),
        volumeRebateCents,
      };
      return foodLine(
        "food_supplier_rebates_csv",
        rowNumber,
        detail,
        volumeRebateCents,
        REBATE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The food lane's profiles — dispatched through the shared dispatcher. */
export const FOOD_PROFILES: readonly StatementProfile[] = [
  deliveryOrderProfile,
  posTicketProfile,
  mealKitProfile,
  cpgScanProfile,
  rebateProfile,
];

/** True when a dispatched profile is the food lane's. */
export function isFoodProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "food_delivery_orders_csv" ||
    kind === "food_pos_tickets_csv" ||
    kind === "food_meal_kit_production_csv" ||
    kind === "food_grocery_cpg_scans_csv" ||
    kind === "food_supplier_rebates_csv"
  );
}
