/**
 * CVT recon worker — the energy lane's four strict ingestion profiles
 * (PR 48, the founder resource directive): SCADA smart meter utility
 * logs (the gross energy and mineral sales the Net Resource Realization
 * prices from, keyed on the founder-specified parcel_id, well_meter_id,
 * and gpu_cluster_hash), GPU data center utilization metrics (the
 * compute-hour telemetry the dynamic grid split and the yield walk key
 * on), pipeline flow-meter volume feeds (the deduction legs the
 * realization subtracts), and carbon offset registry mints (the
 * satellite-verified tonnes the micro-royalties price). Same posture as
 * every lane's strict profile — the EXACT header (order and columns),
 * every cell required (no null guesses), bounded vocabularies,
 * whole-file rejection, and the sender's own row id carried through as
 * the event identity core. Money cells convert through the house strict
 * converter (sender formatting normalized, statement micros out) and
 * reject negatives — this lane's gross legs are positive sales and its
 * deduction legs are positive fees; a refund has no vocabulary here and
 * is never guessed into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isEnergyPeriod } from "./energy";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  EnergyCarbonOffsetMintDetail,
  EnergyGpuUtilizationDetail,
  EnergyLineDetail,
  EnergyPipelineFlowMeterDetail,
  EnergyScadaMeterSalesDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The energy lane's rights family — neither recording nor composition. */
const ENERGY_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The energy lane carries no statement_source_type — the profile and
 * the sender identity keys are the discriminator (the hardware
 * precedent). */
const ENERGY_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const SCADA_METER_SALES_HEADER = [
  "Meter Event ID",
  "Parcel ID",
  "Well Meter ID",
  "GPU Cluster Hash",
  "Gross Energy Sales",
  "Gross Mineral Sales",
  "Currency",
  "Reporting Period",
] as const;

const GPU_UTILIZATION_HEADER = [
  "Utilization Event ID",
  "GPU Cluster Hash",
  "Compute Hours",
  "Power Draw kW",
  "Compute Revenue",
  "Currency",
  "Reporting Period",
] as const;

const PIPELINE_FLOW_METER_HEADER = [
  "Flow Event ID",
  "Parcel ID",
  "Well Meter ID",
  "GPU Cluster Hash",
  "Transportation Pipeline Deductions",
  "Grid Transmission Fees",
  "Processing Refining Base Fees",
  "Currency",
  "Reporting Period",
] as const;

const CARBON_OFFSET_MINT_HEADER = [
  "Mint Event ID",
  "Parcel ID",
  "Registry Ref",
  "Verified Tonnes",
  "Currency",
  "Reporting Period",
] as const;

/** A non-negative money cell in exact cents — the recorded legs of
 * record. Rejects negatives row-scoped (a refund has no vocabulary
 * here). */
function nonNegativeCents(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  // 1 dollar = 1e8 statement micros; 1e6 micros per cent (the house
  // fixed-point discipline).
  return Number(parsed.micros / 1_000_000n);
}

/** A non-negative quantity cell in statement micros — the telemetry
 * legs of record (tonnes, hours, kilowatts). */
function nonNegativeMicros(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  return Number(parsed.micros);
}

/** The row's ISO currency of record — validated through the house
 * alpha-3 shape (the hardware precedent), rejections row-scoped. */
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
  if (!isEnergyPeriod(period)) {
    throw new Error(`invalid_period:${period}`);
  }
  return period;
}

/** An identity cell — present, trimmed. */
function identityCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  return requiredCell(values, column, rowNumber).trim();
}

/**
 * The parsed line constructor — one shape for the four senders, the
 * energy detail riding as the lane discriminator (the hardware
 * precedent). The line's gross is the row's money basis in statement
 * micros (meter sales rows = the gross sales' total; GPU utilization
 * rows = the compute revenue; the flow-meter and registry-mint rows are
 * usage-only and price a zero line gross — the hardware lane's
 * usage-only precedent — their money accrues from the policies of
 * record and the realization's post sums, never the line's).
 */
function energyLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: EnergyLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: ENERGY_RIGHTS_TYPE,
    statementSourceType: ENERGY_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the hardware precedent; the column
    // only carries the four music/DSP pipelines and the split engines
    // never read it for rights_type-'unknown' lines.
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
    usageNote: energyUsageNote(detail),
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
    developerDetail: null,
    hardwareDetail: null,
    energyDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's
 * identity keys. */
function energyUsageNote(detail: EnergyLineDetail): string {
  switch (detail.sender) {
    case "scada_meter_sales":
      return `energy royalties — scada_meter_sales row ${detail.senderRowId}, parcel ${detail.parcelId}, meter ${detail.wellMeterId}, cluster ${detail.gpuClusterHash}`;
    case "gpu_utilization":
      return `energy royalties — gpu_utilization row ${detail.senderRowId}, cluster ${detail.gpuClusterHash}`;
    case "pipeline_flow_meter":
      return `energy royalties — pipeline_flow_meter row ${detail.senderRowId}, parcel ${detail.parcelId}, meter ${detail.wellMeterId}, cluster ${detail.gpuClusterHash}`;
    case "carbon_offset_mint":
      return `energy royalties — carbon_offset_mint row ${detail.senderRowId}, parcel ${detail.parcelId}, registry ${detail.registryRef}`;
  }
}

// ---------------------------------------------------------------------------
// Profile 1 — SCADA smart meter utility logs. The directive's realizing
// sender: every row carries the founder-specified realization keys
// (Parcel ID, Well Meter ID, GPU Cluster Hash) and the two gross legs.
// ---------------------------------------------------------------------------

const scadaMeterSalesProfile: StatementProfile = {
  kind: "energy_scada_meter_sales_csv",
  title: "SCADA smart meter utility log CSV (one row per meter event)",
  laneRightsType: ENERGY_RIGHTS_TYPE,
  statementSourceType: ENERGY_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SCADA_METER_SALES_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...SCADA_METER_SALES_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const energy = nonNegativeCents(
        requiredCell(values, "Gross Energy Sales", rowNumber),
        "Gross Energy Sales",
        rowNumber,
      );
      const mineral = nonNegativeCents(
        requiredCell(values, "Gross Mineral Sales", rowNumber),
        "Gross Mineral Sales",
        rowNumber,
      );
      // A meter row reporting no sales prices nothing — a row-scoped
      // rejection (the developer gate's discipline).
      if (energy === 0 && mineral === 0) {
        throw new Error(`energy_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: EnergyScadaMeterSalesDetail = {
        sender: "scada_meter_sales",
        senderRowId: identityCell(values, "Meter Event ID", rowNumber),
        parcelId: identityCell(values, "Parcel ID", rowNumber),
        wellMeterId: identityCell(values, "Well Meter ID", rowNumber),
        gpuClusterHash: identityCell(values, "GPU Cluster Hash", rowNumber),
        period,
        currency,
        grossEnergySalesCents: energy,
        grossMineralSalesCents: mineral,
      };
      return energyLine(
        "energy_scada_meter_sales_csv",
        rowNumber,
        detail,
        energy + mineral,
        SCADA_METER_SALES_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — GPU data center utilization metrics. The compute walks'
// feed: one row per utilization event carries the cluster hash, the
// compute hours, the average power draw, and the compute revenue.
// ---------------------------------------------------------------------------

const gpuUtilizationProfile: StatementProfile = {
  kind: "energy_gpu_utilization_csv",
  title: "GPU data center utilization metrics CSV (one row per utilization event)",
  laneRightsType: ENERGY_RIGHTS_TYPE,
  statementSourceType: ENERGY_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, GPU_UTILIZATION_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...GPU_UTILIZATION_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const hoursMicros = nonNegativeMicros(
        requiredCell(values, "Compute Hours", rowNumber),
        "Compute Hours",
        rowNumber,
      );
      const powerMicros = nonNegativeMicros(
        requiredCell(values, "Power Draw kW", rowNumber),
        "Power Draw kW",
        rowNumber,
      );
      const revenue = nonNegativeCents(
        requiredCell(values, "Compute Revenue", rowNumber),
        "Compute Revenue",
        rowNumber,
      );
      // A utilization row reporting no hours, no draw, and no revenue
      // prices nothing — a row-scoped rejection.
      if (hoursMicros === 0 && powerMicros === 0 && revenue === 0) {
        throw new Error(`energy_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: EnergyGpuUtilizationDetail = {
        sender: "gpu_utilization",
        senderRowId: identityCell(values, "Utilization Event ID", rowNumber),
        gpuClusterHash: identityCell(values, "GPU Cluster Hash", rowNumber),
        period,
        currency,
        computeHoursMicros: hoursMicros,
        powerDrawKwMicros: powerMicros,
        computeRevenueCents: revenue,
      };
      return energyLine(
        "energy_gpu_utilization_csv",
        rowNumber,
        detail,
        revenue,
        GPU_UTILIZATION_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — pipeline flow-meter volume feeds. The realization's
// deduction input: one row per flow event carries the realization keys
// and the three deduction legs (transportation and pipeline deductions,
// grid transmission fees, processing and refining base fees).
// ---------------------------------------------------------------------------

const pipelineFlowMeterProfile: StatementProfile = {
  kind: "energy_pipeline_flow_meter_csv",
  title: "Pipeline flow-meter volume feed CSV (one row per flow event)",
  laneRightsType: ENERGY_RIGHTS_TYPE,
  statementSourceType: ENERGY_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, PIPELINE_FLOW_METER_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...PIPELINE_FLOW_METER_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const transportation = nonNegativeCents(
        requiredCell(values, "Transportation Pipeline Deductions", rowNumber),
        "Transportation Pipeline Deductions",
        rowNumber,
      );
      const gridFees = nonNegativeCents(
        requiredCell(values, "Grid Transmission Fees", rowNumber),
        "Grid Transmission Fees",
        rowNumber,
      );
      const processing = nonNegativeCents(
        requiredCell(values, "Processing Refining Base Fees", rowNumber),
        "Processing Refining Base Fees",
        rowNumber,
      );
      // A flow row reporting no deductions deducts nothing — a
      // row-scoped rejection.
      if (transportation === 0 && gridFees === 0 && processing === 0) {
        throw new Error(`energy_row_deducts_nothing:row_${rowNumber}`);
      }
      const detail: EnergyPipelineFlowMeterDetail = {
        sender: "pipeline_flow_meter",
        senderRowId: identityCell(values, "Flow Event ID", rowNumber),
        parcelId: identityCell(values, "Parcel ID", rowNumber),
        wellMeterId: identityCell(values, "Well Meter ID", rowNumber),
        gpuClusterHash: identityCell(values, "GPU Cluster Hash", rowNumber),
        period,
        currency,
        transportationPipelineDeductionsCents: transportation,
        gridTransmissionFeesCents: gridFees,
        processingRefiningBaseFeesCents: processing,
      };
      return energyLine(
        "energy_pipeline_flow_meter_csv",
        rowNumber,
        detail,
        0,
        PIPELINE_FLOW_METER_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — carbon offset registry mints. The micro-royalties' feed:
// one row per registry mint carries the parcel, the registry reference,
// and the satellite-verified tonnes. The payout is the per-tonne
// policy's own pricing — the row prices a zero line gross.
// ---------------------------------------------------------------------------

const carbonOffsetMintProfile: StatementProfile = {
  kind: "energy_carbon_offset_mints_csv",
  title: "Carbon offset registry mint CSV (one row per registry mint)",
  laneRightsType: ENERGY_RIGHTS_TYPE,
  statementSourceType: ENERGY_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, CARBON_OFFSET_MINT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...CARBON_OFFSET_MINT_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const tonnesMicros = nonNegativeMicros(
        requiredCell(values, "Verified Tonnes", rowNumber),
        "Verified Tonnes",
        rowNumber,
      );
      // A mint reporting zero tonnes pays nothing — a row-scoped
      // rejection.
      if (tonnesMicros === 0) {
        throw new Error(`energy_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: EnergyCarbonOffsetMintDetail = {
        sender: "carbon_offset_mint",
        senderRowId: identityCell(values, "Mint Event ID", rowNumber),
        parcelId: identityCell(values, "Parcel ID", rowNumber),
        registryRef: identityCell(values, "Registry Ref", rowNumber),
        period,
        currency,
        tonnesVerifiedMicros: tonnesMicros,
      };
      return energyLine(
        "energy_carbon_offset_mints_csv",
        rowNumber,
        detail,
        0,
        CARBON_OFFSET_MINT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The energy lane's profiles, in dispatch order. */
export const ENERGY_PROFILES: readonly StatementProfile[] = [
  scadaMeterSalesProfile,
  gpuUtilizationProfile,
  pipelineFlowMeterProfile,
  carbonOffsetMintProfile,
];

/** True when a dispatched profile is the energy lane's. */
export function isEnergyProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "energy_scada_meter_sales_csv" ||
    kind === "energy_gpu_utilization_csv" ||
    kind === "energy_pipeline_flow_meter_csv" ||
    kind === "energy_carbon_offset_mints_csv"
  );
}
