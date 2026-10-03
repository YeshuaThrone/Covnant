
/**
 * CVT recon worker — the sports lane's eight strict ingestion profiles
 * (PR 50, the founder sports directive): the three primary ticketers'
 * settlement sheets (Ticketmaster, AXS, SeatGeek — one shared settlement
 * anatomy, one layout per sender so the exact-header dispatch stays
 * deterministic), the two secondary marketplaces' resale sheets (StubHub,
 * Vivid Seats), venue turnstile telemetry (the scan counts the gate
 * reconciliation prices against the gross ticket receipts), league
 * broadcasting and group-licensing contracts, and biometric performance
 * tracking feeds. Same posture as every lane's strict profile — the
 * EXACT header (order and columns), every cell required (no null
 * guesses), bounded vocabularies, whole-file rejection, and the sender's
 * own row id carried through as the event identity core. Money cells
 * convert through the house strict converter (sender formatting
 * normalized, statement micros out) and reject negatives — this lane's
 * gross legs are positive sales and its fee legs are positive cuts; a
 * refund has no vocabulary here and is never guessed into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import {
  isSportsPeriod,
  SPORTS_BPS_POT,
  SPORTS_CONTRACT_CLASSES,
  SPORTS_GROUP_LICENSE_CLASSES,
  SPORTS_LICENSEE_CLASSES,
  SPORTS_TRACKING_MODALITIES,
} from "../../modules/sports/records";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  ParsedStatementLine,
  StatementProfile,
  SportsBiometricTrackingDetail,
  SportsLeagueContractDetail,
  SportsLineDetail,
  SportsResaleSaleDetail,
  SportsTicketSaleDetail,
  SportsTurnstileScanDetail,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The sports lane's rights family — neither recording nor composition. */
const SPORTS_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The sports lane carries no statement_source_type — the profile and
 * the sender identity keys are the discriminator (the energy
 * precedent). */
const SPORTS_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection.
 * One settlement anatomy per sender: the three primary ticketers key
 * the same founder columns under their own sheets' names, so no two
 * profiles' headers collide. */
const TICKETMASTER_SALES_HEADER = [
  "Ticket Event ID",
  "Nil Contract ID",
  "Athlete GLAN",
  "Venue GLN",
  "League Rights Code",
  "Turnstile Scan Hash",
  "Gross Ticket Revenue",
  "Facility Surcharges",
  "Municipal Taxes",
  "Insurance Reserves",
  "Payment Processor Fee Cuts",
  "Tickets Sold",
  "Currency",
  "Reporting Period",
] as const;

const AXS_SALES_HEADER = [
  "Ticket Event ID",
  "Nil Contract ID",
  "Athlete GLAN",
  "Venue GLN",
  "League Rights Code",
  "Turnstile Scan Hash",
  "Gross Ticket Sales",
  "Facility Fees",
  "Local Taxes",
  "Insurance Withheld",
  "Processing Fees",
  "Tickets Sold",
  "Currency",
  "Reporting Period",
] as const;

const SEATGEEK_SALES_HEADER = [
  "Ticket Event ID",
  "Nil Contract ID",
  "Athlete GLAN",
  "Venue GLN",
  "League Rights Code",
  "Turnstile Scan Hash",
  "Gross Ticket Proceeds",
  "Venue Facility Charges",
  "Municipal Tax Withheld",
  "Insurance Reserve Withheld",
  "Processor Deductions",
  "Tickets Sold",
  "Currency",
  "Reporting Period",
] as const;

const STUBHUB_RESALE_HEADER = [
  "Resale Order ID",
  "Venue GLN",
  "League Rights Code",
  "Resale Gross",
  "Currency",
  "Reporting Period",
] as const;

const VIVIDSEATS_RESALE_HEADER = [
  "Resale Order ID",
  "League Rights Code",
  "Venue GLN",
  "Resale Gross Amount",
  "Currency",
  "Reporting Period",
] as const;

const TURNSTILE_TELEMETRY_HEADER = [
  "Scan Batch ID",
  "Venue GLN",
  "Turnstile Scan Hash",
  "Scan Count",
  "Currency",
  "Reporting Period",
] as const;

const LEAGUE_CONTRACTS_HEADER = [
  "Contract Ref",
  "League Rights Code",
  "Contract Class",
  "Contract Gross",
  "Royalty Pool",
  "Union Code",
  "Union Share Bps",
  "Athlete Roster",
  "Currency",
  "Reporting Period",
] as const;

const BIOMETRIC_TRACKING_HEADER = [
  "Telemetry Event ID",
  "Athlete GLAN",
  "League Rights Code",
  "Tracking Modality",
  "Licensee Class",
  "Licensed Quantity",
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
 * legs of record (licensed quantities). */
function nonNegativeMicros(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  return Number(parsed.micros);
}

/** A non-negative whole-number cell (ticket and scan counts). */
function nonNegativeCount(cell: string, column: string, rowNumber: number): number {
  const value = nonNegativeMicros(cell, column, rowNumber);
  if (value % 100_000_000 !== 0) {
    throw new Error(`non_integer_count:${column}:row_${rowNumber}`);
  }
  return value / 100_000_000;
}

/** A raw non-negative integer cell — licensed data quantities arrive
 * as whole micro-units, never money-scaled. */
function nonNegativeIntegerCell(
  cell: string,
  column: string,
  rowNumber: number,
): number {
  const value = cell.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`non_integer_count:${column}:row_${rowNumber}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed === 0) {
    throw new Error(`non_integer_count:${column}:row_${rowNumber}`);
  }
  return parsed;
}

/** A non-negative bps cell — bounded 0..10000. */
function bpsCell(cell: string, column: string, rowNumber: number): number {
  const value = nonNegativeCount(cell, column, rowNumber);
  if (value > SPORTS_BPS_POT) {
    throw new Error(`bps_out_of_band:${column}:row_${rowNumber}`);
  }
  return value;
}

/** The row's ISO currency of record — validated through the house
 * alpha-3 shape (the energy precedent), rejections row-scoped. */
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
  if (!isSportsPeriod(period)) {
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

/** A bounded vocabulary cell — the sender's own vocabulary, exact. */
function vocabularyCell<T extends string>(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
  vocabulary: readonly T[],
): T {
  const cell = identityCell(values, column, rowNumber);
  if (!(vocabulary as readonly string[]).includes(cell)) {
    throw new Error(`invalid_vocabulary:${column}:row_${rowNumber}`);
  }
  return cell as T;
}

/**
 * The parsed line constructor — one shape for the eight senders, the
 * sports detail riding as the lane discriminator (the energy
 * precedent). The line's gross is the row's money basis in statement
 * micros (ticket and resale rows = their gross legs; turnstile rows are
 * usage-only and price a zero line gross — their reconciliation rides
 * the scan counts; contract rows = the contract gross; biometric rows
 * are usage-only — their payouts price from the policies of record).
 */
function sportsLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: SportsLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: SPORTS_RIGHTS_TYPE,
    statementSourceType: SPORTS_SOURCE_TYPE,
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
    usageNote: sportsUsageNote(detail),
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
    energyDetail: null,
    sportsDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's
 * identity keys. */
function sportsUsageNote(detail: SportsLineDetail): string {
  switch (detail.sender) {
    case "ticketmaster":
    case "axs":
    case "seatgeek":
      return `sports royalties — ${detail.sender} settlement row ${detail.senderRowId}, venue ${detail.venueGln}, league ${detail.leagueRightsCode}, nil contract ${detail.nilContractId || "none"}, athlete ${detail.athleteGlan || "none"}`;
    case "stubhub":
    case "vivid_seats":
      return `sports royalties — ${detail.sender} resale row ${detail.senderRowId}, venue ${detail.venueGln}, league ${detail.leagueRightsCode}`;
    case "turnstile_telemetry":
      return `sports royalties — turnstile_telemetry batch ${detail.senderRowId}, venue ${detail.venueGln}, hash ${detail.turnstileScanHash}`;
    case "league_contracts":
      return `sports royalties — league_contracts row ${detail.senderRowId}, league ${detail.leagueRightsCode}, class ${detail.contractClass}`;
    case "biometric_tracking":
      return `sports royalties — biometric_tracking row ${detail.senderRowId}, athlete ${detail.athleteGlan}, league ${detail.leagueRightsCode}, ${detail.trackingModality}/${detail.licenseeClass}`;
  }
}

/** The ticketer settlement row parser — one shared anatomy, the
 * sender's own column names and money vocabulary. */
interface TicketerColumnNames {
  readonly gross: string;
  readonly facility: string;
  readonly taxes: string;
  readonly insurance: string;
  readonly processor: string;
}

function parseTicketerRow(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
  columns: TicketerColumnNames,
): Omit<SportsTicketSaleDetail, "sender"> {
  const currency = currencyCell(values, rowNumber);
  const period = periodCell(values, rowNumber);
  const gross = nonNegativeCents(
    requiredCell(values, columns.gross, rowNumber),
    columns.gross,
    rowNumber,
  );
  const facility = nonNegativeCents(
    requiredCell(values, columns.facility, rowNumber),
    columns.facility,
    rowNumber,
  );
  const taxes = nonNegativeCents(
    requiredCell(values, columns.taxes, rowNumber),
    columns.taxes,
    rowNumber,
  );
  const insurance = nonNegativeCents(
    requiredCell(values, columns.insurance, rowNumber),
    columns.insurance,
    rowNumber,
  );
  const processor = nonNegativeCents(
    requiredCell(values, columns.processor, rowNumber),
    columns.processor,
    rowNumber,
  );
  const ticketCount = nonNegativeCount(
    requiredCell(values, "Tickets Sold", rowNumber),
    "Tickets Sold",
    rowNumber,
  );
  // A settlement row reporting no gross and no tickets prices nothing —
  // a row-scoped rejection (the developer gate's discipline).
  if (gross === 0 && ticketCount === 0) {
    throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
  }
  return {
    senderRowId: identityCell(values, "Ticket Event ID", rowNumber),
    nilContractId: identityCell(values, "Nil Contract ID", rowNumber),
    athleteGlan: identityCell(values, "Athlete GLAN", rowNumber),
    venueGln: identityCell(values, "Venue GLN", rowNumber),
    leagueRightsCode: identityCell(values, "League Rights Code", rowNumber),
    turnstileScanHash: identityCell(values, "Turnstile Scan Hash", rowNumber),
    period,
    currency,
    grossTicketRevenueCents: gross,
    facilitySurchargesCents: facility,
    municipalTaxesCents: taxes,
    insuranceReservesCents: insurance,
    processorFeeCutsCents: processor,
    ticketCount,
  };
}

// ---------------------------------------------------------------------------
// Profiles 1–3 — the primary ticketers. The directive's realizing
// senders: every row carries the founder-specified realization keys
// (Nil Contract ID, Athlete GLAN, Venue GLN, League Rights Code,
// Turnstile Scan Hash) and the five money legs.
// ---------------------------------------------------------------------------

const ticketmasterSalesProfile: StatementProfile = {
  kind: "sports_ticketmaster_sales_csv",
  title: "Ticketmaster settlement CSV (one row per ticket event)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, TICKETMASTER_SALES_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...TICKETMASTER_SALES_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const detail: SportsTicketSaleDetail = {
        sender: "ticketmaster",
        ...parseTicketerRow(values, rowNumber, {
          gross: "Gross Ticket Revenue",
          facility: "Facility Surcharges",
          taxes: "Municipal Taxes",
          insurance: "Insurance Reserves",
          processor: "Payment Processor Fee Cuts",
        }),
      };
      return sportsLine(
        "sports_ticketmaster_sales_csv",
        rowNumber,
        detail,
        detail.grossTicketRevenueCents,
        TICKETMASTER_SALES_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

const axsSalesProfile: StatementProfile = {
  kind: "sports_axs_sales_csv",
  title: "AXS settlement CSV (one row per ticket event)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, AXS_SALES_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...AXS_SALES_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const detail: SportsTicketSaleDetail = {
        sender: "axs",
        ...parseTicketerRow(values, rowNumber, {
          gross: "Gross Ticket Sales",
          facility: "Facility Fees",
          taxes: "Local Taxes",
          insurance: "Insurance Withheld",
          processor: "Processing Fees",
        }),
      };
      return sportsLine(
        "sports_axs_sales_csv",
        rowNumber,
        detail,
        detail.grossTicketRevenueCents,
        AXS_SALES_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

const seatgeekSalesProfile: StatementProfile = {
  kind: "sports_seatgeek_sales_csv",
  title: "SeatGeek settlement CSV (one row per ticket event)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SEATGEEK_SALES_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...SEATGEEK_SALES_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const detail: SportsTicketSaleDetail = {
        sender: "seatgeek",
        ...parseTicketerRow(values, rowNumber, {
          gross: "Gross Ticket Proceeds",
          facility: "Venue Facility Charges",
          taxes: "Municipal Tax Withheld",
          insurance: "Insurance Reserve Withheld",
          processor: "Processor Deductions",
        }),
      };
      return sportsLine(
        "sports_seatgeek_sales_csv",
        rowNumber,
        detail,
        detail.grossTicketRevenueCents,
        SEATGEEK_SALES_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profiles 4–5 — the secondary marketplaces. The perpetual royalty's
// senders: every row carries the policy scope (venue, league) and the
// resale gross the 5–10% cut prices.
// ---------------------------------------------------------------------------

const stubhubResaleProfile: StatementProfile = {
  kind: "sports_stubhub_resale_csv",
  title: "StubHub resale CSV (one row per resale order)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, STUBHUB_RESALE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...STUBHUB_RESALE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const gross = nonNegativeCents(
        requiredCell(values, "Resale Gross", rowNumber),
        "Resale Gross",
        rowNumber,
      );
      if (gross === 0) {
        throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: SportsResaleSaleDetail = {
        sender: "stubhub",
        senderRowId: identityCell(values, "Resale Order ID", rowNumber),
        venueGln: identityCell(values, "Venue GLN", rowNumber),
        leagueRightsCode: identityCell(values, "League Rights Code", rowNumber),
        period: periodCell(values, rowNumber),
        currency: currencyCell(values, rowNumber),
        resaleGrossCents: gross,
      };
      return sportsLine(
        "sports_stubhub_resale_csv",
        rowNumber,
        detail,
        gross,
        STUBHUB_RESALE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

const vividseatsResaleProfile: StatementProfile = {
  kind: "sports_vividseats_resale_csv",
  title: "Vivid Seats resale CSV (one row per resale order)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, VIVIDSEATS_RESALE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...VIVIDSEATS_RESALE_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const gross = nonNegativeCents(
        requiredCell(values, "Resale Gross Amount", rowNumber),
        "Resale Gross Amount",
        rowNumber,
      );
      if (gross === 0) {
        throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: SportsResaleSaleDetail = {
        sender: "vivid_seats",
        senderRowId: identityCell(values, "Resale Order ID", rowNumber),
        venueGln: identityCell(values, "Venue GLN", rowNumber),
        leagueRightsCode: identityCell(values, "League Rights Code", rowNumber),
        period: periodCell(values, rowNumber),
        currency: currencyCell(values, rowNumber),
        resaleGrossCents: gross,
      };
      return sportsLine(
        "sports_vividseats_resale_csv",
        rowNumber,
        detail,
        gross,
        VIVIDSEATS_RESALE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 6 — venue turnstile telemetry. The reconciliation's telemetry
// side: every batch carries the venue, the scan hash, and the count the
// gate reconciliation prices against the gross ticket receipts.
// ---------------------------------------------------------------------------

const turnstileTelemetryProfile: StatementProfile = {
  kind: "sports_turnstile_telemetry_csv",
  title: "Venue turnstile telemetry CSV (one row per scan batch)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, TURNSTILE_TELEMETRY_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...TURNSTILE_TELEMETRY_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const scanCount = nonNegativeCount(
        requiredCell(values, "Scan Count", rowNumber),
        "Scan Count",
        rowNumber,
      );
      // A batch of zero scans prices nothing — a row-scoped rejection.
      if (scanCount === 0) {
        throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: SportsTurnstileScanDetail = {
        sender: "turnstile_telemetry",
        senderRowId: identityCell(values, "Scan Batch ID", rowNumber),
        venueGln: identityCell(values, "Venue GLN", rowNumber),
        turnstileScanHash: identityCell(values, "Turnstile Scan Hash", rowNumber),
        period: periodCell(values, rowNumber),
        currency: currencyCell(values, rowNumber),
        scanCount,
      };
      return sportsLine(
        "sports_turnstile_telemetry_csv",
        rowNumber,
        detail,
        0,
        TURNSTILE_TELEMETRY_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 7 — league broadcasting and group-licensing contracts. The
// pool waterfall's and the group licensing engine's feed: national and
// international broadcasting contracts, the collective merchandise
// pool, and the three group licensing streams (union code, share, and
// roster riding the group classes).
// ---------------------------------------------------------------------------

/** The roster cell — semicolon-joined athlete GLANs for the group
 * classes, empty for the league pool classes; normalized to the JSON
 * array the record stores. */
function rosterCell(
  values: ReadonlyMap<string, string>,
  contractClass: SportsLeagueContractDetail["contractClass"],
  rowNumber: number,
): string {
  // Optional read — pool-class rows legitimately carry no roster; the
  // class branches below enforce emptiness and presence strictly.
  const cell = (values.get("Athlete Roster") ?? "").trim();
  if (
    contractClass === "group_licensing_video_games" ||
    contractClass === "group_licensing_trading_cards" ||
    contractClass === "group_licensing_apparel"
  ) {
    if (cell === "") {
      throw new Error(`group_licensing_roster_empty:row_${rowNumber}`);
    }
    const roster = cell
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (roster.length === 0) {
      throw new Error(`group_licensing_roster_empty:row_${rowNumber}`);
    }
    return JSON.stringify(roster);
  }
  if (cell !== "") {
    throw new Error(`league_pool_roster_present:row_${rowNumber}`);
  }
  return "[]";
}

const leagueContractsProfile: StatementProfile = {
  kind: "sports_league_contracts_csv",
  title: "League contracts CSV (one row per broadcasting or licensing contract)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, LEAGUE_CONTRACTS_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...LEAGUE_CONTRACTS_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const contractClass = vocabularyCell(
        values,
        "Contract Class",
        rowNumber,
        SPORTS_CONTRACT_CLASSES,
      );
      const isGroupClass = (
        SPORTS_GROUP_LICENSE_CLASSES as readonly string[]
      ).includes(contractClass);
      const unionCode = vocabularyCell(values, "Union Code", rowNumber, [
        "NFLPA",
        "NBAPA",
        "none",
      ] as const);
      const unionShareBps = bpsCell(
        requiredCell(values, "Union Share Bps", rowNumber),
        "Union Share Bps",
        rowNumber,
      );
      const contractGross = nonNegativeCents(
        requiredCell(values, "Contract Gross", rowNumber),
        "Contract Gross",
        rowNumber,
      );
      const royaltyPool = nonNegativeCents(
        requiredCell(values, "Royalty Pool", rowNumber),
        "Royalty Pool",
        rowNumber,
      );
      // A league pool contract reporting no gross, and a group
      // licensing contract routing to no union ledger or no athlete
      // pool, each price nothing — row-scoped rejections.
      if (
        (contractClass === "broadcasting_national" ||
          contractClass === "broadcasting_international" ||
          contractClass === "merchandise_pool") &&
        contractGross === 0
      ) {
        throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
      }
      if (
        isGroupClass &&
        (royaltyPool === 0 ||
          unionCode === "none" ||
          unionShareBps === 0 ||
          unionShareBps === SPORTS_BPS_POT)
      ) {
        throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
      }
      if (!isGroupClass && (unionCode !== "none" || unionShareBps !== 0)) {
        throw new Error(`league_pool_union_present:row_${rowNumber}`);
      }
      const detail: SportsLeagueContractDetail = {
        sender: "league_contracts",
        senderRowId: identityCell(values, "Contract Ref", rowNumber),
        leagueRightsCode: identityCell(values, "League Rights Code", rowNumber),
        contractClass,
        contractGrossCents: contractGross,
        royaltyPoolCents: royaltyPool,
        unionCode,
        unionShareBps,
        athleteRosterJson: rosterCell(values, contractClass, rowNumber),
        period: periodCell(values, rowNumber),
        currency: currencyCell(values, rowNumber),
      };
      return sportsLine(
        "sports_league_contracts_csv",
        rowNumber,
        detail,
        contractGross,
        LEAGUE_CONTRACTS_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 8 — biometric performance tracking feeds. The micro-royalty
// trigger's feed: wearable and optical player tracking licensed to the
// directive's three licensee classes, the licensed quantity the payout
// policy of record prices.
// ---------------------------------------------------------------------------

const biometricTrackingProfile: StatementProfile = {
  kind: "sports_biometric_tracking_csv",
  title: "Biometric tracking CSV (one row per telemetry event)",
  laneRightsType: SPORTS_RIGHTS_TYPE,
  statementSourceType: SPORTS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, BIOMETRIC_TRACKING_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...BIOMETRIC_TRACKING_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const licensedQuantityMicros = nonNegativeIntegerCell(
        requiredCell(values, "Licensed Quantity", rowNumber),
        "Licensed Quantity",
        rowNumber,
      );
      // A telemetry row licensing nothing prices nothing — a
      // row-scoped rejection.
      if (licensedQuantityMicros === 0) {
        throw new Error(`sports_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: SportsBiometricTrackingDetail = {
        sender: "biometric_tracking",
        senderRowId: identityCell(values, "Telemetry Event ID", rowNumber),
        athleteGlan: identityCell(values, "Athlete GLAN", rowNumber),
        leagueRightsCode: identityCell(values, "League Rights Code", rowNumber),
        trackingModality: vocabularyCell(
          values,
          "Tracking Modality",
          rowNumber,
          SPORTS_TRACKING_MODALITIES,
        ),
        licenseeClass: vocabularyCell(
          values,
          "Licensee Class",
          rowNumber,
          SPORTS_LICENSEE_CLASSES,
        ),
        licensedQuantityMicros,
        period: periodCell(values, rowNumber),
        currency: currencyCell(values, rowNumber),
      };
      return sportsLine(
        "sports_biometric_tracking_csv",
        rowNumber,
        detail,
        0,
        BIOMETRIC_TRACKING_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The sports lane's eight strict profiles, in directive order. */
export const SPORTS_PROFILES: StatementProfile[] = [
  ticketmasterSalesProfile,
  axsSalesProfile,
  seatgeekSalesProfile,
  stubhubResaleProfile,
  vividseatsResaleProfile,
  turnstileTelemetryProfile,
  leagueContractsProfile,
  biometricTrackingProfile,
];

/** True when a dispatched profile is the sports lane's. */
export function isSportsProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "sports_ticketmaster_sales_csv" ||
    kind === "sports_axs_sales_csv" ||
    kind === "sports_seatgeek_sales_csv" ||
    kind === "sports_stubhub_resale_csv" ||
    kind === "sports_vividseats_resale_csv" ||
    kind === "sports_turnstile_telemetry_csv" ||
    kind === "sports_league_contracts_csv" ||
    kind === "sports_biometric_tracking_csv"
  );
}
