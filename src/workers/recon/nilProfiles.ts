/**
 * CVT recon worker — the NIL lane's ingestion profiles (PR 34, the founder
 * NIL compliance + roster waterfall directive).
 *
 * Four strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value vocabularies, whole-file
 * rejection on any violation. No industry CSV standard exists for NIL deal
 * disclosures or school revenue-share statements — every sender ships a
 * different layout, so each profile defines ONE strict layout and the
 * profile is the contract, pinned by tests (the licensing/art/theatrical
 * precedent). A permissive guesser is the silent-misparse behavior the
 * recon engine exists to prevent:
 *
 *   nil_brand_endorsement_csv      — third-party brand endorsement deals.
 *   nil_collective_disclosure_csv  — collective/booster deal disclosures
 *                                    (the associated-entity funding source
 *                                    rides here).
 *   nil_school_rev_share_pool_csv  — school direct revenue-share
 *                                    distribution pools (media or ticket).
 *   nil_media_rights_distribution_csv — team-wide media rights revenue
 *                                    distributions (the group NIL equal
 *                                    split's participant roster rides
 *                                    here).
 *
 * Rights separation: NIL lines are rights_type 'unknown' — athlete
 * endorsement and school revenue-share money is neither recording nor
 * composition royalty, so the split-quarantine rule keeps them out of
 * music split math (the film/books/art/theatrical/licensing precedent).
 * tier_level is null and statement_source_type is null. The addendum 13
 * columns (athlete_id, school_id, state_jurisdiction_code) populate the
 * queue columns the NIL cascade keys on; nil_contract_id carries the
 * sender's deal id of record.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * positive deal/pool values, non-negative participant counts, ISO alpha-2
 * state jurisdiction codes, ISO alpha-3 currencies, YYYY-MM periods
 * derived from ISO date cells, agency fee modes inside the founder's
 * bands, and the collective disclosure's self-identity (a disclosure
 * naming a collective or booster funding source IS an associated-entity
 * deal — the holdback discriminator).
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { isNilPeriod } from "./nil";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  NilLineDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import type { NilAgencyMode, NilFundingSource, NilGroupRightsStream, NilPoolType } from "@/modules/nil/records";
import { isValidNilAgencyFee } from "@/modules/nil/records";

const CSV = ",";

/** The NIL lane's rights family — neither recording nor composition. */
const NIL_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The NIL lane carries no statement_source_type — the profile and the
 * addendum 13 identifiers are the discriminator (the licensing precedent). */
const NIL_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

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

/** A positive money cell — a deal or pool value is the money's basis;
 * zero is hostile in this lane. */
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

/** A required identifier cell (deal/athlete/school/collective ids). */
function idCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number): string {
  return requiredCell(values, column, rowNumber);
}

/** The reporting month's YYYY-MM bucket derived from an ISO date cell. */
function periodFromDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell)) {
    throw new StatementParseError(`invalid_date:${column}:${cell}:row_${rowNumber}`);
  }
  const period = cell.slice(0, 7);
  if (!isNilPeriod(period)) {
    throw new StatementParseError(`invalid_period:${column}:${period}:row_${rowNumber}`);
  }
  return period;
}

/** The state jurisdiction of record — ISO alpha-2 uppercase (the addendum
 * 13 leg the state matrix keys on). */
function stateJurisdictionCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  const state = requiredCell(values, "State Jurisdiction Code", rowNumber).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new StatementParseError(`invalid_state_jurisdiction:${state}:row_${rowNumber}`);
  }
  return state;
}

/** Currency cell — ISO alpha-3, validated (the shared lane validator). */
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

/** The agency fee pair — the mode vocabulary plus the founder's bands.
 * 'none' requires exactly 0 bps; an out-of-band rate is a hostile row. */
function agencyFeeCells(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): { mode: NilAgencyMode; bps: number } {
  const modeCell = requiredCell(values, "Agency Fee Mode", rowNumber).toLowerCase();
  if (modeCell !== "marketing" && modeCell !== "direct_rev_share" && modeCell !== "none") {
    throw new StatementParseError(`invalid_agency_mode:${modeCell}:row_${rowNumber}`);
  }
  const bpsCell = requiredCell(values, "Agency Commission BPS", rowNumber);
  if (!/^\d+$/.test(bpsCell)) {
    throw new StatementParseError(`invalid_agency_bps:${bpsCell}:row_${rowNumber}`);
  }
  const bps = Number(bpsCell);
  if (!isValidNilAgencyFee(modeCell, bps)) {
    throw new StatementParseError(
      `agency_fee_out_of_band:${modeCell}:${bpsCell}:row_${rowNumber}`,
    );
  }
  return { mode: modeCell, bps };
}

/** The deal category vocabulary — the state matrix's rule scope. */
function dealCategoryCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  const category = requiredCell(values, "Deal Category", rowNumber).toLowerCase();
  if (
    category !== "private_brand" &&
    category !== "team_apparel" &&
    category !== "school_gear" &&
    category !== "collective" &&
    category !== "school_rev_share" &&
    category !== "media_rights"
  ) {
    throw new StatementParseError(`invalid_deal_category:${category}:row_${rowNumber}`);
  }
  return category;
}

/** The funding source vocabulary — the associated-entity discriminator. */
function fundingSourceCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): NilFundingSource {
  const source = requiredCell(values, "Funding Source", rowNumber).toLowerCase();
  if (source !== "collective" && source !== "booster" && source !== "direct") {
    throw new StatementParseError(`invalid_funding_source:${source}:row_${rowNumber}`);
  }
  return source;
}

/** The school pool's type of record. */
function poolTypeCell(values: ReadonlyMap<string, string>, rowNumber: number): NilPoolType {
  const poolType = requiredCell(values, "Pool Type", rowNumber).toLowerCase();
  if (poolType !== "media_rights" && poolType !== "ticket_distribution") {
    throw new StatementParseError(`invalid_pool_type:${poolType}:row_${rowNumber}`);
  }
  return poolType;
}

/** The group split's rights stream of record. */
function rightsStreamCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): NilGroupRightsStream {
  const stream = requiredCell(values, "Rights Stream", rowNumber).toLowerCase();
  if (stream !== "video_game" && stream !== "apparel" && stream !== "media") {
    throw new StatementParseError(`invalid_rights_stream:${stream}:row_${rowNumber}`);
  }
  return stream;
}

/**
 * The participant roster of record — semicolon-delimited athlete ids, at
 * least one. A group distribution with no participants is a hostile row:
 * the equal split has nobody to divide across. The count column must
 * match the id list exactly — a roster that disagrees with itself is
 * rejected (the manifest self-reconciliation discipline).
 */
function participantCells(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): readonly string[] {
  const cell = requiredCell(values, "Participant IDs", rowNumber);
  const participants = cell
    .split(";")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (participants.length === 0) {
    throw new StatementParseError(`no_participants:row_${rowNumber}`);
  }
  const countCell = requiredCell(values, "Participant Count", rowNumber);
  if (!/^\d+$/.test(countCell) || Number(countCell) !== participants.length) {
    throw new StatementParseError(
      `participant_count_mismatch:${countCell}:${participants.length}:row_${rowNumber}`,
    );
  }
  return participants;
}

/** Assembles one NIL line. grossMicros is the row's money basis — the
 * deal value, pool, or distribution total; the identity legs ride the
 * detail. */
function nilLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: NilLineDetail,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: NIL_RIGHTS_TYPE,
    statementSourceType: NIL_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the licensing precedent; the column only
    // carries the four music/DSP pipelines and the split engines never read
    // it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: detail.period,
    currency,
    grossMicros,
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    // The state jurisdiction of record rides the line — the addendum 13 leg.
    territory: detail.stateJurisdictionCode,
    platform: detail.sender,
    usageNote: nilUsageNote(detail),
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
    nilDetail: detail,
  };
}

/** The usage note — provenance naming the row and its identity. */
function nilUsageNote(detail: NilLineDetail): string {
  return (
    `nil revenue — ${detail.sender} row ${detail.senderRowId}` +
    `, athlete ${detail.athleteId ?? "none"}` +
    `, school ${detail.schoolId ?? "none"}` +
    `, state ${detail.stateJurisdictionCode ?? "none"}` +
    `, gross ${detail.grossMicros} micros`
  );
}

// ---------------------------------------------------------------------------
// Profile 1 — third-party brand endorsement deals. The athlete-keyed deal
// rows: the $600 valid business purpose audit, the agency commission, and
// the state matrix all key off this row's money and identity.
// ---------------------------------------------------------------------------

const BRAND_ENDORSEMENT_HEADER = [
  "Deal ID",
  "Contract Date",
  "Athlete ID",
  "School ID",
  "State Jurisdiction Code",
  "Deal Category",
  "Brand",
  "Deal Value",
  "Agency Fee Mode",
  "Agency Commission BPS",
  "Currency",
  "Reporting Period",
] as const;

const brandEndorsementProfile: StatementProfile = {
  kind: "nil_brand_endorsement_csv",
  title: "Third-party brand endorsement deal CSV (one row per deal)",
  laneRightsType: NIL_RIGHTS_TYPE,
  statementSourceType: NIL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, BRAND_ENDORSEMENT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, BRAND_ENDORSEMENT_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const dealId = idCell(values, "Deal ID", rowNumber);
      const period = periodFromDateCell(values, "Contract Date", rowNumber);
      const dealValueMicros = positiveMoneyCell(values, "Deal Value", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const agency = agencyFeeCells(values, rowNumber);
      const detail: NilLineDetail = {
        sender: "brand",
        senderRowId: dealId,
        nilContractId: dealId,
        athleteId: idCell(values, "Athlete ID", rowNumber),
        schoolId: idCell(values, "School ID", rowNumber),
        stateJurisdictionCode: stateJurisdictionCell(values, rowNumber),
        dealCategory: dealCategoryCell(values, rowNumber),
        fundingSource: null,
        collectiveId: null,
        poolType: null,
        rightsStream: null,
        participantIds: null,
        agencyMode: agency.mode,
        agencyBps: agency.bps,
        grossMicros: dealValueMicros.toString(),
        period,
      };
      void idCell(values, "Brand", rowNumber);
      return nilLine(
        "nil_brand_endorsement_csv",
        rowNumber,
        currency,
        dealValueMicros,
        detail,
        BRAND_ENDORSEMENT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — collective deal disclosures. The associated-entity funding
// source rides here: 'collective' and 'booster' rows trip the holdback;
// 'direct' rows pay through the deal path.
// ---------------------------------------------------------------------------

const COLLECTIVE_DISCLOSURE_HEADER = [
  "Disclosure ID",
  "Disclosure Date",
  "Athlete ID",
  "School ID",
  "State Jurisdiction Code",
  "Collective ID",
  "Funding Source",
  "Deal Value",
  "Agency Fee Mode",
  "Agency Commission BPS",
  "Currency",
  "Reporting Period",
] as const;

const collectiveDisclosureProfile: StatementProfile = {
  kind: "nil_collective_disclosure_csv",
  title: "Collective deal disclosure CSV (one row per disclosed deal)",
  laneRightsType: NIL_RIGHTS_TYPE,
  statementSourceType: NIL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, COLLECTIVE_DISCLOSURE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, COLLECTIVE_DISCLOSURE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const disclosureId = idCell(values, "Disclosure ID", rowNumber);
      const period = periodFromDateCell(values, "Disclosure Date", rowNumber);
      const dealValueMicros = positiveMoneyCell(values, "Deal Value", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const fundingSource = fundingSourceCell(values, rowNumber);
      const agency = agencyFeeCells(values, rowNumber);
      const detail: NilLineDetail = {
        sender: "collective",
        senderRowId: disclosureId,
        nilContractId: disclosureId,
        athleteId: idCell(values, "Athlete ID", rowNumber),
        schoolId: idCell(values, "School ID", rowNumber),
        stateJurisdictionCode: stateJurisdictionCell(values, rowNumber),
        dealCategory: "collective",
        fundingSource,
        collectiveId: idCell(values, "Collective ID", rowNumber),
        poolType: null,
        rightsStream: null,
        participantIds: null,
        agencyMode: agency.mode,
        agencyBps: agency.bps,
        grossMicros: dealValueMicros.toString(),
        period,
      };
      return nilLine(
        "nil_collective_disclosure_csv",
        rowNumber,
        currency,
        dealValueMicros,
        detail,
        COLLECTIVE_DISCLOSURE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — school direct revenue-share distribution pools. The pool rows
// the adjusted calculator nets: the Title IX reserve and admin fee rates
// come from the school's program of record at cascade time (the pool row
// carries the gross and its identity only).
// ---------------------------------------------------------------------------

const SCHOOL_POOL_HEADER = [
  "Pool ID",
  "Pool Date",
  "School ID",
  "Pool Type",
  "Gross Pool",
  "Currency",
  "Reporting Period",
] as const;

const schoolPoolProfile: StatementProfile = {
  kind: "nil_school_rev_share_pool_csv",
  title: "School direct revenue-share pool CSV (one row per distribution pool)",
  laneRightsType: NIL_RIGHTS_TYPE,
  statementSourceType: NIL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SCHOOL_POOL_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, SCHOOL_POOL_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const poolId = idCell(values, "Pool ID", rowNumber);
      const period = periodFromDateCell(values, "Pool Date", rowNumber);
      const grossPoolMicros = positiveMoneyCell(values, "Gross Pool", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const schoolId = idCell(values, "School ID", rowNumber);
      const detail: NilLineDetail = {
        sender: "school",
        senderRowId: poolId,
        nilContractId: poolId,
        athleteId: null,
        schoolId,
        stateJurisdictionCode: null,
        dealCategory: "school_rev_share",
        fundingSource: null,
        collectiveId: null,
        poolType: poolTypeCell(values, rowNumber),
        rightsStream: null,
        participantIds: null,
        agencyMode: "none",
        agencyBps: 0,
        grossMicros: grossPoolMicros.toString(),
        period,
      };
      return nilLine(
        "nil_school_rev_share_pool_csv",
        rowNumber,
        currency,
        grossPoolMicros,
        detail,
        SCHOOL_POOL_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — media rights revenue distributions. The group NIL equal
// split's rows: the team-wide video game / apparel / media license
// revenue and the participating roster it divides across.
// ---------------------------------------------------------------------------

const MEDIA_RIGHTS_HEADER = [
  "Distribution ID",
  "Distribution Date",
  "School ID",
  "Rights Stream",
  "Gross Distribution",
  "Participant IDs",
  "Participant Count",
  "Currency",
  "Reporting Period",
] as const;

const mediaRightsProfile: StatementProfile = {
  kind: "nil_media_rights_distribution_csv",
  title:
    "Media rights revenue distribution CSV (group NIL equal split, one row per distribution)",
  laneRightsType: NIL_RIGHTS_TYPE,
  statementSourceType: NIL_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, MEDIA_RIGHTS_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, MEDIA_RIGHTS_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const distributionId = idCell(values, "Distribution ID", rowNumber);
      const period = periodFromDateCell(values, "Distribution Date", rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Distribution", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const participants = participantCells(values, rowNumber);
      const schoolId = idCell(values, "School ID", rowNumber);
      const detail: NilLineDetail = {
        sender: "media",
        senderRowId: distributionId,
        nilContractId: distributionId,
        athleteId: null,
        schoolId,
        stateJurisdictionCode: null,
        dealCategory: "media_rights",
        fundingSource: null,
        collectiveId: null,
        poolType: null,
        rightsStream: rightsStreamCell(values, rowNumber),
        participantIds: participants.join(";"),
        agencyMode: "none",
        agencyBps: 0,
        grossMicros: grossMicros.toString(),
        period,
      };
      return nilLine(
        "nil_media_rights_distribution_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        MEDIA_RIGHTS_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The NIL lane's profiles — dispatched through the shared dispatcher. */
export const NIL_PROFILES: readonly StatementProfile[] = [
  brandEndorsementProfile,
  collectiveDisclosureProfile,
  schoolPoolProfile,
  mediaRightsProfile,
];

/** True when a dispatched profile is the NIL lane's. */
export function isNilProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "nil_brand_endorsement_csv" ||
    kind === "nil_collective_disclosure_csv" ||
    kind === "nil_school_rev_share_pool_csv" ||
    kind === "nil_media_rights_distribution_csv"
  );
}

/**
 * The NIL lane's money legs from a parsed line — the queue writer's
 * extraction. The line's gross is the row's money basis (deal value,
 * pool, or distribution total); the identity legs ride the detail.
 */
export function nilLegsMicros(line: ParsedStatementLine): {
  grossMicros: bigint;
} {
  return { grossMicros: line.grossMicros };
}
