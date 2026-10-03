/**
 * CVT recon worker — the developer lane's eight strict ingestion profiles
 * (PR 44, the founder developer directive): API gateway usage logs (Kong,
 * AWS API Gateway, Cloudflare Workers), SDK initialization events,
 * usage-based billing tokens, app store marketplace sales feeds, the
 * co-authored packages' subscription and sponsorship revenue, SBOM scan
 * telemetry, white-label enterprise license logs, and autonomous agent
 * tool-call batches. Same posture as every lane's strict profile — the
 * EXACT header (order and columns), every cell required (no null
 * guesses), bounded vocabularies, whole-file rejection, and the sender's
 * own row id carried through as the event identity core. The realizing
 * senders repeat the identity columns the directive keys the Net API
 * Realization on — developer_id, api_endpoint_id, and sdk_package_hash —
 * the marketplace feed keys on the marketplace and the package, the SBOM
 * scans on the component, the white-label statements on the SDK package
 * and enterprise licensee, and the tool-call logs on the tool and the
 * calling agent. Money cells convert through the house strict converter
 * (sender formatting normalized, statement micros out) and reject
 * negatives — this lane's legs are positive sales, revenue, fees, and
 * usage counts; a refund has no vocabulary here and is never guessed
 * into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isDeveloperPeriod } from "./developer";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  DeveloperAgentToolCallDetail,
  DeveloperCopackageRevenueDetail,
  DeveloperGatewayUsageDetail,
  DeveloperLineDetail,
  DeveloperMarketplaceSaleDetail,
  DeveloperSbomScanDetail,
  DeveloperSdkInitializationDetail,
  DeveloperUsageBillingTokenDetail,
  DeveloperWhitelabelLicenseDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The developer lane's rights family — neither recording nor composition. */
const DEVELOPER_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The developer lane carries no statement_source_type — the profile and
 * the developer/endpoint/package keys are the discriminator (the service
 * precedent). */
const DEVELOPER_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const GATEWAY_USAGE_HEADER = [
  "Usage Event ID",
  "Gateway",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "API Calls",
  "Gross API Transaction Revenue",
  "Cloud Infrastructure Hosting Base",
  "Payment Processing Gate Cut",
  "Enterprise SLA Reserve",
  "Currency",
  "Reporting Period",
] as const;

const SDK_INITIALIZATION_HEADER = [
  "Init Event ID",
  "SDK Platform",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Gross API Transaction Revenue",
  "Cloud Infrastructure Hosting Base",
  "Payment Processing Gate Cut",
  "Enterprise SLA Reserve",
  "Currency",
  "Reporting Period",
] as const;

const USAGE_BILLING_TOKEN_HEADER = [
  "Token Event ID",
  "Token Kind",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Gross API Transaction Revenue",
  "Cloud Infrastructure Hosting Base",
  "Payment Processing Gate Cut",
  "Enterprise SLA Reserve",
  "Currency",
  "Reporting Period",
] as const;

const MARKETPLACE_SALE_HEADER = [
  "Sale ID",
  "Marketplace",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Gross Sale",
  "Currency",
  "Reporting Period",
] as const;

const COPACKAGE_REVENUE_HEADER = [
  "Revenue Event ID",
  "Package ID",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Revenue Kind",
  "Gross Revenue",
  "Currency",
  "Reporting Period",
] as const;

const SBOM_SCAN_HEADER = [
  "Scan Event ID",
  "Scan Context",
  "Developer ID",
  "Component ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Deploy Count",
  "Active Instances",
  "Currency",
  "Reporting Period",
] as const;

const WHITELABEL_LICENSE_HEADER = [
  "License Event ID",
  "Event Kind",
  "Licensor ID",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Quantity",
  "Currency",
  "Reporting Period",
] as const;

const AGENT_TOOL_CALL_HEADER = [
  "Batch ID",
  "Tool ID",
  "Agent ID",
  "Developer ID",
  "API Endpoint ID",
  "SDK Package Hash",
  "Call Count",
  "Currency",
  "Reporting Period",
] as const;

/** Bounded vocabularies — a cell outside its family is a row-scoped
 * rejection, never a guess. The gateways are the directive's three API
 * gateway usage streams; the SDK platforms, token kinds, marketplaces,
 * revenue kinds, scan contexts, license event kinds, and tools are the
 * directive's own families. */
const DEVELOPER_GATEWAYS = new Set(["kong", "aws_api_gateway", "cloudflare_workers"]);
const DEVELOPER_SDK_PLATFORMS = new Set(["ios", "android", "web", "server"]);
const DEVELOPER_TOKEN_KINDS = new Set([
  "compute_credit",
  "inference_token",
  "storage_gb_hour",
  "egress_gb",
]);
const DEVELOPER_MARKETPLACES = new Set([
  "apple_app_store",
  "google_play",
  "unity_asset_store",
  "vscode_marketplace",
]);
const DEVELOPER_REVENUE_KINDS = new Set(["subscription", "sponsorship"]);
const DEVELOPER_SCAN_CONTEXTS = new Set(["ci_deploy", "runtime_fleet"]);
const DEVELOPER_LICENSE_EVENT_KINDS = new Set(["seat", "deployment"]);
const DEVELOPER_AGENT_TOOLS = new Set(["web_search", "database_query", "payment_action"]);

function parsePositiveCents(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  // 1 dollar = 1e8 statement micros; 1e6 micros per cent (the house
  // fixed-point discipline).
  return Number(parsed.micros / 1_000_000n);
}

/** A non-negative integer count cell — the usage counts of record. */
function countCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number): number {
  const cell = requiredCell(values, column, rowNumber).trim();
  const count = Number(cell);
  if (!/^\d+$/.test(cell) || !Number.isInteger(count) || count < 0) {
    throw new Error(`invalid_count:${column}:${cell}:row_${rowNumber}`);
  }
  return count;
}

/** A strictly positive integer count cell — a usage event that prices
 * zero calls carries no royalty leg (a row-scoped rejection). */
function positiveCountCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): number {
  const count = countCell(values, column, rowNumber);
  if (count === 0) {
    throw new Error(`developer_row_counts_nothing:${column}:row_${rowNumber}`);
  }
  return count;
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
  if (!isDeveloperPeriod(period)) {
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
 * The parsed line constructor — one shape for all eight senders, the
 * developer detail riding as the lane discriminator (the service
 * precedent). The line's gross is the row's money basis in statement
 * micros (realizing rows = the gross API transaction revenue; marketplace
 * rows = the gross sale; co-package rows = the gross revenue; the SBOM,
 * white-label, and tool-call rows are usage-only and price a zero line
 * gross — the food lane's zero-gross precedent — their money accrues
 * bigint-exact inside their own walks).
 */
function developerLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: DeveloperLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: DEVELOPER_RIGHTS_TYPE,
    statementSourceType: DEVELOPER_SOURCE_TYPE,
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
    usageNote: developerUsageNote(detail),
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
    foodDetail: null,
    serviceDetail: null,
    developerDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's
 * identity keys. */
function developerUsageNote(detail: DeveloperLineDetail): string {
  switch (detail.sender) {
    case "gateway_usage":
      return `developer revenue — gateway_usage row ${detail.senderRowId}, gateway ${detail.gateway}, developer ${detail.developerId}, endpoint ${detail.apiEndpointId}, package ${detail.sdkPackageHash}`;
    case "sdk_initialization":
      return `developer revenue — sdk_initialization row ${detail.senderRowId}, platform ${detail.platform}, developer ${detail.developerId}, endpoint ${detail.apiEndpointId}, package ${detail.sdkPackageHash}`;
    case "usage_billing_token":
      return `developer revenue — usage_billing_token row ${detail.senderRowId}, token ${detail.tokenKind}, developer ${detail.developerId}, endpoint ${detail.apiEndpointId}, package ${detail.sdkPackageHash}`;
    case "marketplace_sale":
      return `developer revenue — marketplace_sale row ${detail.senderRowId}, marketplace ${detail.marketplace}, developer ${detail.developerId}, package ${detail.sdkPackageHash}`;
    case "copackage_revenue":
      return `developer revenue — copackage_revenue row ${detail.senderRowId}, package ${detail.packageId}, kind ${detail.revenueKind}, developer ${detail.developerId}`;
    case "sbom_scan":
      return `developer revenue — sbom_scan row ${detail.senderRowId}, context ${detail.scanContext}, developer ${detail.developerId}, component ${detail.componentId}`;
    case "whitelabel_license":
      return `developer revenue — whitelabel_license row ${detail.senderRowId}, kind ${detail.eventKind}, licensor ${detail.licensorId}, package ${detail.sdkPackageHash}`;
    case "agent_tool_call":
      return `developer revenue — agent_tool_call row ${detail.senderRowId}, tool ${detail.toolId}, agent ${detail.agentId}, developer ${detail.developerId}`;
  }
}

/** The realizing senders' shared money legs — exact same four columns on
 * the gateway usage, SDK initialization, and token redemption sheets. */
function realizingLegs(values: ReadonlyMap<string, string>, rowNumber: number): {
  gross: number;
  hosting: number;
  gateCut: number;
  slaReserve: number;
} {
  const gross = parsePositiveCents(
    requiredCell(values, "Gross API Transaction Revenue", rowNumber),
    "Gross API Transaction Revenue",
    rowNumber,
  );
  return {
    gross,
    hosting: parsePositiveCents(
      requiredCell(values, "Cloud Infrastructure Hosting Base", rowNumber),
      "Cloud Infrastructure Hosting Base",
      rowNumber,
    ),
    gateCut: parsePositiveCents(
      requiredCell(values, "Payment Processing Gate Cut", rowNumber),
      "Payment Processing Gate Cut",
      rowNumber,
    ),
    slaReserve: parsePositiveCents(
      requiredCell(values, "Enterprise SLA Reserve", rowNumber),
      "Enterprise SLA Reserve",
      rowNumber,
    ),
  };
}

// ---------------------------------------------------------------------------
// Profile 1 — API gateway usage logs (Kong, AWS API Gateway, Cloudflare
// Workers). The directive's three gateway streams; the call count and the
// four money legs the Net API Realization calculator and the per-call
// tier walk consume.
// ---------------------------------------------------------------------------

const gatewayUsageProfile: StatementProfile = {
  kind: "developer_api_gateway_usage_csv",
  title: "API gateway usage log CSV (one row per usage event)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, GATEWAY_USAGE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...GATEWAY_USAGE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const gateway = vocabularyCell(values, "Gateway", DEVELOPER_GATEWAYS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const apiCalls = positiveCountCell(values, "API Calls", rowNumber);
      const legs = realizingLegs(values, rowNumber);
      if (legs.gross === 0) {
        throw new Error(`developer_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: DeveloperGatewayUsageDetail = {
        sender: "gateway_usage",
        senderRowId: requiredCell(values, "Usage Event ID", rowNumber),
        gateway: gateway as DeveloperGatewayUsageDetail["gateway"],
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        apiCalls,
        grossApiTransactionRevenueCents: legs.gross,
        cloudInfrastructureHostingBaseCents: legs.hosting,
        paymentProcessingGateCutCents: legs.gateCut,
        enterpriseSlaReserveCents: legs.slaReserve,
      };
      return developerLine(
        "developer_api_gateway_usage_csv",
        rowNumber,
        detail,
        legs.gross,
        GATEWAY_USAGE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — SDK initialization events. An activation may carry no
// billable revenue (zero money legs read honestly; the realization walks
// the zeros), never a guessed amount.
// ---------------------------------------------------------------------------

const sdkInitializationProfile: StatementProfile = {
  kind: "developer_sdk_initializations_csv",
  title: "SDK initialization event CSV (one row per activation event)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SDK_INITIALIZATION_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...SDK_INITIALIZATION_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const platform = vocabularyCell(values, "SDK Platform", DEVELOPER_SDK_PLATFORMS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const legs = realizingLegs(values, rowNumber);
      const detail: DeveloperSdkInitializationDetail = {
        sender: "sdk_initialization",
        senderRowId: requiredCell(values, "Init Event ID", rowNumber),
        platform: platform as DeveloperSdkInitializationDetail["platform"],
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        grossApiTransactionRevenueCents: legs.gross,
        cloudInfrastructureHostingBaseCents: legs.hosting,
        paymentProcessingGateCutCents: legs.gateCut,
        enterpriseSlaReserveCents: legs.slaReserve,
      };
      return developerLine(
        "developer_sdk_initializations_csv",
        rowNumber,
        detail,
        legs.gross,
        SDK_INITIALIZATION_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — usage-based billing tokens. The compute-credit,
// inference-token, storage-gB-hour, and egress-gB redemptions carry the
// same four money legs.
// ---------------------------------------------------------------------------

const usageBillingTokenProfile: StatementProfile = {
  kind: "developer_usage_billing_tokens_csv",
  title: "Usage-based billing token CSV (one row per token redemption)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, USAGE_BILLING_TOKEN_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...USAGE_BILLING_TOKEN_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const tokenKind = vocabularyCell(values, "Token Kind", DEVELOPER_TOKEN_KINDS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const legs = realizingLegs(values, rowNumber);
      const detail: DeveloperUsageBillingTokenDetail = {
        sender: "usage_billing_token",
        senderRowId: requiredCell(values, "Token Event ID", rowNumber),
        tokenKind: tokenKind as DeveloperUsageBillingTokenDetail["tokenKind"],
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        grossApiTransactionRevenueCents: legs.gross,
        cloudInfrastructureHostingBaseCents: legs.hosting,
        paymentProcessingGateCutCents: legs.gateCut,
        enterpriseSlaReserveCents: legs.slaReserve,
      };
      return developerLine(
        "developer_usage_billing_tokens_csv",
        rowNumber,
        detail,
        legs.gross,
        USAGE_BILLING_TOKEN_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — app store marketplace sales feeds. The marketplace split
// prices off the gross sale; the endpoint leg of record may be empty
// (the feed does not always key one).
// ---------------------------------------------------------------------------

const marketplaceSaleProfile: StatementProfile = {
  kind: "developer_marketplace_sales_csv",
  title: "App store marketplace sales CSV (one row per sale)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, MARKETPLACE_SALE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...MARKETPLACE_SALE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const marketplace = vocabularyCell(values, "Marketplace", DEVELOPER_MARKETPLACES, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossSaleCents = parsePositiveCents(
        requiredCell(values, "Gross Sale", rowNumber),
        "Gross Sale",
        rowNumber,
      );
      if (grossSaleCents === 0) {
        throw new Error(`developer_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: DeveloperMarketplaceSaleDetail = {
        sender: "marketplace_sale",
        senderRowId: requiredCell(values, "Sale ID", rowNumber),
        marketplace: marketplace as DeveloperMarketplaceSaleDetail["marketplace"],
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        grossSaleCents,
      };
      return developerLine(
        "developer_marketplace_sales_csv",
        rowNumber,
        detail,
        grossSaleCents,
        MARKETPLACE_SALE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 5 — co-authored package revenue. The subscription and
// sponsorship events are the split's pot; the contribution weightings of
// record route it.
// ---------------------------------------------------------------------------

const copackageRevenueProfile: StatementProfile = {
  kind: "developer_copackage_revenue_csv",
  title: "Co-authored package revenue CSV (one row per revenue event)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, COPACKAGE_REVENUE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...COPACKAGE_REVENUE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const revenueKind = vocabularyCell(
        values,
        "Revenue Kind",
        DEVELOPER_REVENUE_KINDS,
        rowNumber,
      );
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossRevenueCents = parsePositiveCents(
        requiredCell(values, "Gross Revenue", rowNumber),
        "Gross Revenue",
        rowNumber,
      );
      if (grossRevenueCents === 0) {
        throw new Error(`developer_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: DeveloperCopackageRevenueDetail = {
        sender: "copackage_revenue",
        senderRowId: requiredCell(values, "Revenue Event ID", rowNumber),
        packageId: requiredCell(values, "Package ID", rowNumber),
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        revenueKind: revenueKind as DeveloperCopackageRevenueDetail["revenueKind"],
        grossRevenueCents,
      };
      return developerLine(
        "developer_copackage_revenue_csv",
        rowNumber,
        detail,
        grossRevenueCents,
        COPACKAGE_REVENUE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 6 — SBOM scans. The per-deploy and per-active-instance counts
// are the micro-fees' usage legs; a scan that counts nothing is a
// row-scoped rejection.
// ---------------------------------------------------------------------------

const sbomScanProfile: StatementProfile = {
  kind: "developer_sbom_scans_csv",
  title: "SBOM scan CSV (one row per scan event)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SBOM_SCAN_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...SBOM_SCAN_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const scanContext = vocabularyCell(values, "Scan Context", DEVELOPER_SCAN_CONTEXTS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const deployCount = countCell(values, "Deploy Count", rowNumber);
      const activeInstances = countCell(values, "Active Instances", rowNumber);
      if (deployCount === 0 && activeInstances === 0) {
        throw new Error(`developer_row_counts_nothing:row_${rowNumber}`);
      }
      const detail: DeveloperSbomScanDetail = {
        sender: "sbom_scan",
        senderRowId: requiredCell(values, "Scan Event ID", rowNumber),
        scanContext: scanContext as DeveloperSbomScanDetail["scanContext"],
        developerId: requiredCell(values, "Developer ID", rowNumber),
        componentId: requiredCell(values, "Component ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        deployCount,
        activeInstances,
      };
      return developerLine(
        "developer_sbom_scans_csv",
        rowNumber,
        detail,
        0,
        SBOM_SCAN_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 7 — white-label license events. The enterprise seat and
// deployment logs carry the event kind and the quantity; the deal of
// record prices the usage and the MMG recoupment walks the month.
// ---------------------------------------------------------------------------

const whitelabelLicenseProfile: StatementProfile = {
  kind: "developer_whitelabel_licenses_csv",
  title: "White-label SDK license CSV (one row per license event)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, WHITELABEL_LICENSE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...WHITELABEL_LICENSE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const eventKind = vocabularyCell(
        values,
        "Event Kind",
        DEVELOPER_LICENSE_EVENT_KINDS,
        rowNumber,
      );
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const quantity = positiveCountCell(values, "Quantity", rowNumber);
      const detail: DeveloperWhitelabelLicenseDetail = {
        sender: "whitelabel_license",
        senderRowId: requiredCell(values, "License Event ID", rowNumber),
        eventKind: eventKind as DeveloperWhitelabelLicenseDetail["eventKind"],
        licensorId: requiredCell(values, "Licensor ID", rowNumber),
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        quantity,
      };
      return developerLine(
        "developer_whitelabel_licenses_csv",
        rowNumber,
        detail,
        0,
        WHITELABEL_LICENSE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 8 — agent tool-call batches. The paid third-party tool and the
// calling agent ride the batch; the settlement policy prices per call.
// ---------------------------------------------------------------------------

const agentToolCallProfile: StatementProfile = {
  kind: "developer_agent_tool_calls_csv",
  title: "Agent tool-call CSV (one row per tool-call batch)",
  laneRightsType: DEVELOPER_RIGHTS_TYPE,
  statementSourceType: DEVELOPER_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, AGENT_TOOL_CALL_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...AGENT_TOOL_CALL_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const toolId = vocabularyCell(values, "Tool ID", DEVELOPER_AGENT_TOOLS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const callCount = positiveCountCell(values, "Call Count", rowNumber);
      const detail: DeveloperAgentToolCallDetail = {
        sender: "agent_tool_call",
        senderRowId: requiredCell(values, "Batch ID", rowNumber),
        toolId: toolId as DeveloperAgentToolCallDetail["toolId"],
        agentId: requiredCell(values, "Agent ID", rowNumber),
        developerId: requiredCell(values, "Developer ID", rowNumber),
        apiEndpointId: requiredCell(values, "API Endpoint ID", rowNumber),
        sdkPackageHash: requiredCell(values, "SDK Package Hash", rowNumber),
        period,
        currency,
        callCount,
      };
      return developerLine(
        "developer_agent_tool_calls_csv",
        rowNumber,
        detail,
        0,
        AGENT_TOOL_CALL_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The developer lane's profiles — dispatched through the shared dispatcher. */
export const DEVELOPER_PROFILES: readonly StatementProfile[] = [
  gatewayUsageProfile,
  sdkInitializationProfile,
  usageBillingTokenProfile,
  marketplaceSaleProfile,
  copackageRevenueProfile,
  sbomScanProfile,
  whitelabelLicenseProfile,
  agentToolCallProfile,
];

/** True when a dispatched profile is the developer lane's. */
export function isDeveloperProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "developer_api_gateway_usage_csv" ||
    kind === "developer_sdk_initializations_csv" ||
    kind === "developer_usage_billing_tokens_csv" ||
    kind === "developer_marketplace_sales_csv" ||
    kind === "developer_copackage_revenue_csv" ||
    kind === "developer_sbom_scans_csv" ||
    kind === "developer_whitelabel_licenses_csv" ||
    kind === "developer_agent_tool_calls_csv"
  );
}
