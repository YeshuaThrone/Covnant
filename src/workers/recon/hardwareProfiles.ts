/**
 * CVT recon worker — the hardware lane's four strict ingestion profiles
 * (PR 46, the founder hardware directive): cellular device activation
 * feeds (IMEI and EID identity — the founder's realizing sender, and the
 * OTA feature-unlock purchases' event stream), hardware MAC address logs
 * (the connected-unit SEP royalty events), factory production line
 * serial counts (the automotive OEM pool routing's feed), and smart grid
 * IoT telemetry (the clean-tech micro-payouts' feed). Same posture as
 * every lane's strict profile — the EXACT header (order and columns),
 * every cell required (no null guesses), bounded vocabularies, whole-file
 * rejection, and the sender's own row id carried through as the event
 * identity core. The realizing senders repeat the identity columns the
 * directive keys the Net Hardware Patent Realization on —
 * patent_family_id, sep_pool_code, and device_imei_mac. Money cells
 * convert through the house strict converter (sender formatting
 * normalized, statement micros out) and reject negatives — this lane's
 * legs are positive sales, fees, and usage counts; a refund has no
 * vocabulary here and is never guessed into one.
 */

import { optionalCell, parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isHardwarePeriod } from "./hardware";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  HardwareCellularActivationDetail,
  HardwareLineDetail,
  HardwareMacAddressLogDetail,
  HardwareProductionSerialDetail,
  HardwareSmartGridTelemetryDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The hardware lane's rights family — neither recording nor composition. */
const HARDWARE_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The hardware lane carries no statement_source_type — the profile and
 * the sender identity keys are the discriminator (the developer
 * precedent). */
const HARDWARE_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const CELLULAR_ACTIVATION_HEADER = [
  "Activation Event ID",
  "Activation Kind",
  "Device IMEI",
  "EID",
  "Patent Family ID",
  "SEP Pool Code",
  "Device Wholesale ASP",
  "Component COGS Base",
  "Non-Essential BOM",
  "Feature Code",
  "Currency",
  "Reporting Period",
] as const;

const MAC_ADDRESS_LOG_HEADER = [
  "Log Event ID",
  "Device MAC",
  "Licensee ID",
  "Patent Family ID",
  "SEP Pool Code",
  "Connected Units",
  "Royalty Basis",
  "Currency",
  "Reporting Period",
] as const;

const PRODUCTION_SERIAL_HEADER = [
  "Batch ID",
  "OEM ID",
  "Production Line ID",
  "Serials Produced",
  "Cellular License Fee Per Vehicle",
  "Navigation License Fee Per Vehicle",
  "Currency",
  "Reporting Period",
] as const;

const SMART_GRID_TELEMETRY_HEADER = [
  "Telemetry Event ID",
  "Device Serial",
  "Patent Family ID",
  "Kilowatt Hours Delivered",
  "Charge Cycles",
  "Currency",
  "Reporting Period",
] as const;

/** Bounded vocabularies — a cell outside its family is a row-scoped
 * rejection, never a guess. The activation kinds are the directive's two
 * event families (device activations and OTA feature-unlock purchases). */
const HARDWARE_ACTIVATION_KINDS = new Set(["device_activation", "ota_feature_unlock"]);

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

/** A positive integer count cell — a usage leg that counts nothing
 * carries no royalty (a row-scoped rejection). */
function positiveCountCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): number {
  const cell = requiredCell(values, column, rowNumber).trim();
  const count = Number(cell);
  if (!/^\d+$/.test(cell) || !Number.isInteger(count) || count <= 0) {
    throw new Error(`invalid_count:${column}:${cell}:row_${rowNumber}`);
  }
  return count;
}

/** A non-negative integer count cell. */
function countCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number): number {
  const cell = requiredCell(values, column, rowNumber).trim();
  const count = Number(cell);
  if (!/^\d+$/.test(cell) || !Number.isInteger(count) || count < 0) {
    throw new Error(`invalid_count:${column}:${cell}:row_${rowNumber}`);
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
  if (!isHardwarePeriod(period)) {
    throw new Error(`invalid_period:${period}`);
  }
  return period;
}

/** The bounded-vocabulary cells — never a truthy guess. */
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
 * The parsed line constructor — one shape for the four senders, the
 * hardware detail riding as the lane discriminator (the developer
 * precedent). The line's gross is the row's money basis in statement
 * micros (activation rows = the device wholesale ASP; production batch
 * rows = the routed per-vehicle fees' total; the MAC log and telemetry
 * rows are usage-only and price a zero line gross — the developer lane's
 * usage-only precedent — their money accrues bigint-exact inside their
 * own walks from the policies of record).
 */
function hardwareLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: HardwareLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: HARDWARE_RIGHTS_TYPE,
    statementSourceType: HARDWARE_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the developer precedent; the column
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
    usageNote: hardwareUsageNote(detail),
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
    hardwareDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's
 * identity keys. */
function hardwareUsageNote(detail: HardwareLineDetail): string {
  switch (detail.sender) {
    case "cellular_activation":
      return `hardware royalties — cellular_activation row ${detail.senderRowId}, kind ${detail.activationKind}, device ${detail.deviceImeiMac}, family ${detail.patentFamilyId}, pool ${detail.sepPoolCode}`;
    case "mac_address_log":
      return `hardware royalties — mac_address_log row ${detail.senderRowId}, device ${detail.deviceMac}, licensee ${detail.licenseeId}, family ${detail.patentFamilyId}, pool ${detail.sepPoolCode}`;
    case "production_serial":
      return `hardware royalties — production_serial row ${detail.senderRowId}, oem ${detail.oemId}, line ${detail.lineId}, serials ${detail.serialsProduced}`;
    case "smart_grid_telemetry":
      return `hardware royalties — smart_grid_telemetry row ${detail.senderRowId}, device ${detail.deviceSerial}, family ${detail.patentFamilyId}`;
  }
}

// ---------------------------------------------------------------------------
// Profile 1 — cellular device activation feeds. The directive's realizing
// sender: every row carries the founder-specified realization keys
// (Patent Family ID, SEP Pool Code, Device IMEI), the EID of the eSIM,
// and the three realization money legs. The OTA feature-unlock purchase
// rows are this feed's second kind — their money is the per-unlock
// policy's own pricing (the instant settlement), never the row's.
// ---------------------------------------------------------------------------

const cellularActivationProfile: StatementProfile = {
  kind: "hardware_cellular_activations_csv",
  title: "Cellular device activation feed CSV (one row per activation event)",
  laneRightsType: HARDWARE_RIGHTS_TYPE,
  statementSourceType: HARDWARE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, CELLULAR_ACTIVATION_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...CELLULAR_ACTIVATION_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const kind = vocabularyCell(values, "Activation Kind", HARDWARE_ACTIVATION_KINDS, rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const asp = nonNegativeCents(
        requiredCell(values, "Device Wholesale ASP", rowNumber),
        "Device Wholesale ASP",
        rowNumber,
      );
      const cogs = nonNegativeCents(
        requiredCell(values, "Component COGS Base", rowNumber),
        "Component COGS Base",
        rowNumber,
      );
      const bom = nonNegativeCents(
        requiredCell(values, "Non-Essential BOM", rowNumber),
        "Non-Essential BOM",
        rowNumber,
      );
      const featureCode = optionalCell(values, "Feature Code");
      if (kind === "device_activation") {
        // A device activation IS the realizing event — an activation
        // pricing a zero ASP carries no value base (a row-scoped
        // rejection, the developer gate's discipline), and a feature
        // code on a plain activation is a contradiction.
        if (asp === 0) {
          throw new Error(`hardware_row_prices_nothing:row_${rowNumber}`);
        }
        if (featureCode !== null) {
          throw new Error(`unexpected_feature_code:row_${rowNumber}`);
        }
      } else {
        // An OTA feature-unlock purchase prices NOTHING from the
        // statement (its money is the per-unlock policy's own pricing)
        // and names the feature it unlocks.
        if (asp !== 0 || cogs !== 0 || bom !== 0) {
          throw new Error(`ota_unlock_prices_nothing:row_${rowNumber}`);
        }
        if (featureCode === null) {
          throw new Error(`missing_column:Feature Code:row_${rowNumber}`);
        }
      }
      const detail: HardwareCellularActivationDetail = {
        sender: "cellular_activation",
        senderRowId: requiredCell(values, "Activation Event ID", rowNumber),
        activationKind: kind as HardwareCellularActivationDetail["activationKind"],
        deviceImeiMac: requiredCell(values, "Device IMEI", rowNumber),
        eid: optionalCell(values, "EID"),
        patentFamilyId: requiredCell(values, "Patent Family ID", rowNumber),
        sepPoolCode: requiredCell(values, "SEP Pool Code", rowNumber),
        period,
        currency,
        deviceWholesaleAspCents: asp,
        componentCogsBaseCents: cogs,
        nonEssentialBomCents: bom,
        featureCode,
      };
      return hardwareLine(
        "hardware_cellular_activations_csv",
        rowNumber,
        detail,
        asp,
        CELLULAR_ACTIVATION_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — hardware MAC address logs. The connected-unit royalty
// events: one row per log event carries the device MAC, the licensee
// (the device maker whose cumulative unit position the tier walk prices
// from), the founder's family and pool keys, the connected unit count,
// and the per-unit royalty basis of record.
// ---------------------------------------------------------------------------

const macAddressLogProfile: StatementProfile = {
  kind: "hardware_mac_address_logs_csv",
  title: "Hardware MAC address log CSV (one row per log event)",
  laneRightsType: HARDWARE_RIGHTS_TYPE,
  statementSourceType: HARDWARE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, MAC_ADDRESS_LOG_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...MAC_ADDRESS_LOG_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const connectedUnits = positiveCountCell(values, "Connected Units", rowNumber);
      const royaltyBasisCents = nonNegativeCents(
        requiredCell(values, "Royalty Basis", rowNumber),
        "Royalty Basis",
        rowNumber,
      );
      if (royaltyBasisCents === 0) {
        throw new Error(`hardware_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: HardwareMacAddressLogDetail = {
        sender: "mac_address_log",
        senderRowId: requiredCell(values, "Log Event ID", rowNumber),
        deviceMac: requiredCell(values, "Device MAC", rowNumber),
        licenseeId: requiredCell(values, "Licensee ID", rowNumber),
        patentFamilyId: requiredCell(values, "Patent Family ID", rowNumber),
        sepPoolCode: requiredCell(values, "SEP Pool Code", rowNumber),
        period,
        currency,
        connectedUnits,
        royaltyBasisCents,
      };
      return hardwareLine(
        "hardware_mac_address_logs_csv",
        rowNumber,
        detail,
        0,
        MAC_ADDRESS_LOG_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — factory production line serial counts. The automotive OEM
// routing's feed: one row per production batch carries the OEM, the
// line, the serials produced, and the per-vehicle cellular and
// navigation licensing fees the assignment of record routes to the
// pools.
// ---------------------------------------------------------------------------

const productionSerialProfile: StatementProfile = {
  kind: "hardware_production_serials_csv",
  title: "Factory production line serial count CSV (one row per production batch)",
  laneRightsType: HARDWARE_RIGHTS_TYPE,
  statementSourceType: HARDWARE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, PRODUCTION_SERIAL_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...PRODUCTION_SERIAL_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const serialsProduced = positiveCountCell(values, "Serials Produced", rowNumber);
      const cellularFee = nonNegativeCents(
        requiredCell(values, "Cellular License Fee Per Vehicle", rowNumber),
        "Cellular License Fee Per Vehicle",
        rowNumber,
      );
      const navigationFee = nonNegativeCents(
        requiredCell(values, "Navigation License Fee Per Vehicle", rowNumber),
        "Navigation License Fee Per Vehicle",
        rowNumber,
      );
      // A batch pricing neither fee routes nothing — a row-scoped
      // rejection (the developer gate's discipline).
      if (cellularFee === 0 && navigationFee === 0) {
        throw new Error(`hardware_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: HardwareProductionSerialDetail = {
        sender: "production_serial",
        senderRowId: requiredCell(values, "Batch ID", rowNumber),
        oemId: requiredCell(values, "OEM ID", rowNumber),
        lineId: requiredCell(values, "Production Line ID", rowNumber),
        period,
        currency,
        serialsProduced,
        cellularFeePerVehicleCents: cellularFee,
        navigationFeePerVehicleCents: navigationFee,
      };
      return hardwareLine(
        "hardware_production_serials_csv",
        rowNumber,
        detail,
        serialsProduced * (cellularFee + navigationFee),
        PRODUCTION_SERIAL_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — smart grid IoT telemetry. The clean-tech micro-payouts'
// feed: one row per telemetry event carries the metering device's
// serial, the clean-tech patent family of record, the delivered energy
// (kilowatt hours, exact decimal), and the completed charge cycles.
// ---------------------------------------------------------------------------

const smartGridTelemetryProfile: StatementProfile = {
  kind: "hardware_smart_grid_telemetry_csv",
  title: "Smart grid IoT telemetry CSV (one row per telemetry event)",
  laneRightsType: HARDWARE_RIGHTS_TYPE,
  statementSourceType: HARDWARE_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SMART_GRID_TELEMETRY_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...SMART_GRID_TELEMETRY_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const kwhCell = requiredCell(values, "Kilowatt Hours Delivered", rowNumber);
      const kwhParsed = parseStatementMoney(kwhCell);
      if (kwhParsed.negative) {
        throw new Error(`negative_money:Kilowatt Hours Delivered:row_${rowNumber}`);
      }
      const chargeCycles = countCell(values, "Charge Cycles", rowNumber);
      // A telemetry row reporting no energy and no cycles prices no
      // micro-payout — a row-scoped rejection.
      if (kwhParsed.micros === 0n && chargeCycles === 0) {
        throw new Error(`hardware_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: HardwareSmartGridTelemetryDetail = {
        sender: "smart_grid_telemetry",
        senderRowId: requiredCell(values, "Telemetry Event ID", rowNumber),
        deviceSerial: requiredCell(values, "Device Serial", rowNumber),
        patentFamilyId: requiredCell(values, "Patent Family ID", rowNumber),
        period,
        currency,
        kwhMicros: Number(kwhParsed.micros),
        chargeCycles,
      };
      return hardwareLine(
        "hardware_smart_grid_telemetry_csv",
        rowNumber,
        detail,
        0,
        SMART_GRID_TELEMETRY_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The hardware lane's profiles, in dispatch order. */
export const HARDWARE_PROFILES: readonly StatementProfile[] = [
  cellularActivationProfile,
  macAddressLogProfile,
  productionSerialProfile,
  smartGridTelemetryProfile,
];

/** True when a dispatched profile is the hardware lane's. */
export function isHardwareProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "hardware_cellular_activations_csv" ||
    kind === "hardware_mac_address_logs_csv" ||
    kind === "hardware_production_serials_csv" ||
    kind === "hardware_smart_grid_telemetry_csv"
  );
}
