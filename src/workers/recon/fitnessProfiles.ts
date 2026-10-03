/**
 * CVT recon worker — the fitness lane's five strict ingestion profiles
 * (PR 38, the founder fitness directive): digital stream starts, completed
 * workout logs, connected bike and treadmill telemetry, studio class
 * check-ins, and app subscription allocations. Same posture as every
 * lane's strict profile — the EXACT header (order and columns), every cell
 * required (no null guesses), bounded vocabularies, whole-file rejection,
 * and the sender's own row id carried through as the event identity core.
 * Every sender repeats the three identity columns the directive keys the
 * lane on — Trainer ID, Program ID, Studio Franchise Code — plus the
 * month period and the row currency. Money cells convert through the
 * house strict converter (sender formatting normalized, statement micros
 * out) and reject negatives — this lane's legs are positive revenues,
 * pools, and counts; a refund has no vocabulary here and is never guessed
 * into one.
 */

import { parseStatementMoney, readStrictTable, requiredCell, sniffHeaderMatches } from "./delimited";
import { fitnessMicrosToCents, isFitnessPeriod } from "./fitness";
import { validateTheatricalCurrency } from "./theatrical";
import { StatementParseError } from "./records";
import type {
  FitnessEquipmentTelemetryDetail,
  FitnessLineDetail,
  FitnessStudioCheckinDetail,
  FitnessStreamStartDetail,
  FitnessSubscriptionAllocationDetail,
  FitnessWorkoutCompleteDetail,
  ParsedStatementLine,
  StatementProfile,
} from "./records";
import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";

const CSV = ",";

/** The fitness lane's rights family — neither recording nor composition. */
const FITNESS_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The fitness lane carries no statement_source_type — the profile and
 * the trainer/program/franchise keys are the discriminator (the spatial
 * precedent). */
const FITNESS_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** The column layouts — exact order, exact names, whole-file rejection. */
const STREAM_START_HEADER = [
  "Stream Start ID",
  "Trainer ID",
  "Program ID",
  "Studio Franchise Code",
  "Stream Starts",
  "Live Broadcast",
  "Peak Simultaneous Viewers",
  "Live Event Revenue",
  "Currency",
  "Reporting Period",
] as const;

const WORKOUT_HEADER = [
  "Workout Log ID",
  "Trainer ID",
  "Program ID",
  "Studio Franchise Code",
  "Completed Workouts",
  "Subscriber Retained",
  "Class Revenue",
  "Currency",
  "Reporting Period",
] as const;

const EQUIPMENT_HEADER = [
  "Telemetry ID",
  "Trainer ID",
  "Program ID",
  "Studio Franchise Code",
  "Equipment Type",
  "Session Count",
  "Workout Minutes",
  "Wearable Active Users",
  "Currency",
  "Reporting Period",
] as const;

const CHECKIN_HEADER = [
  "Check-In ID",
  "Trainer ID",
  "Program ID",
  "Studio Franchise Code",
  "Class Check-Ins",
  "Class Revenue",
  "Certified Choreography Revenue",
  "Certified Audio Revenue",
  "Currency",
  "Reporting Period",
] as const;

const ALLOCATION_HEADER = [
  "Allocation ID",
  "Trainer ID",
  "Program ID",
  "Studio Franchise Code",
  "Gross Subscription Pool",
  "App Store Engine Cut",
  "Digital Infrastructure Overhead",
  "Currency",
  "Reporting Period",
] as const;

/** Bounded vocabularies — a cell outside its family is a row-scoped
 * rejection, never a guess. The broadcast gate is yes-or-no (a live
 * broadcast of record carries an audience of record); the retention gate
 * is yes-or-no; the equipment of record is the directive's bike or
 * treadmill. */
const YES_NO = new Set(["yes", "no"]);
const EQUIPMENT_TYPES = new Set(["connected_bike", "treadmill"]);

function parsePositiveCents(cell: string, column: string, rowNumber: number): number {
  const parsed = parseStatementMoney(cell);
  if (parsed.negative) {
    throw new Error(`negative_money:${column}:row_${rowNumber}`);
  }
  return fitnessMicrosToCents(parsed.micros);
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
  if (!isFitnessPeriod(period)) {
    throw new Error(`invalid_period:${period}`);
  }
  return period;
}

/** The yes/no gate cells — bounded vocabularies, never truthy guesses. */
function yesNoCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): boolean {
  const cell = requiredCell(values, column, rowNumber);
  if (!YES_NO.has(cell)) {
    throw new Error(`invalid_yes_no:${column}:${cell}`);
  }
  return cell === "yes";
}

/**
 * The parsed line constructor — one shape for all five senders, the
 * fitness detail riding as the lane discriminator (the spatial
 * precedent). The line's gross is the row's money basis in statement
 * micros (allocation = the gross subscription pool; check-in and workout
 * logs = the class revenue; a live stream start prices its live event
 * revenue; every other usage row prices no money itself — its royalty is
 * computed at walk time).
 */
function fitnessLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  detail: FitnessLineDetail,
  grossCents: number,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: FITNESS_RIGHTS_TYPE,
    statementSourceType: FITNESS_SOURCE_TYPE,
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
    usageNote: fitnessUsageNote(detail),
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
    fitnessDetail: detail,
  };
}

/** The usage note — provenance naming the row and the directive's three
 * identity keys. */
function fitnessUsageNote(detail: FitnessLineDetail): string {
  return (
    `fitness revenue — ${detail.sender} row ${detail.senderRowId}` +
    `, trainer ${detail.trainerId}` +
    `, program ${detail.programId}` +
    `, franchise ${detail.studioFranchiseCode}`
  );
}

// ---------------------------------------------------------------------------
// Profile 1 — digital stream starts. The stream usage of record: the
// completions the cumulative monthly walk advances, the live-broadcast
// gate, and the peak simultaneous viewers + live event revenue legs the
// live residual walk prices.
// ---------------------------------------------------------------------------

const streamStartProfile: StatementProfile = {
  kind: "fitness_stream_starts_csv",
  title: "Digital stream start log CSV (one row per stream batch)",
  laneRightsType: FITNESS_RIGHTS_TYPE,
  statementSourceType: FITNESS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, STREAM_START_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...STREAM_START_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const liveBroadcast = yesNoCell(values, "Live Broadcast", rowNumber);
      const streamStarts = parseCountCell(
        requiredCell(values, "Stream Starts", rowNumber),
        "Stream Starts",
        rowNumber,
      );
      const peakSimultaneousViewers = parseCountCell(
        requiredCell(values, "Peak Simultaneous Viewers", rowNumber),
        "Peak Simultaneous Viewers",
        rowNumber,
      );
      const liveEventRevenueCents = parsePositiveCents(
        requiredCell(values, "Live Event Revenue", rowNumber),
        "Live Event Revenue",
        rowNumber,
      );
      // A live broadcast of record carries an audience of record; a
      // non-live row carries neither viewers nor live revenue. Anything
      // else is a contradictory row, rejected at parse.
      if (liveBroadcast && peakSimultaneousViewers === 0) {
        throw new Error(`live_broadcast_without_viewers:row_${rowNumber}`);
      }
      if (!liveBroadcast && (peakSimultaneousViewers !== 0 || liveEventRevenueCents !== 0)) {
        throw new Error(`nonlive_row_carries_live_legs:row_${rowNumber}`);
      }
      if (streamStarts === 0) {
        throw new Error(`stream_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: FitnessStreamStartDetail = {
        sender: "stream_start",
        senderRowId: requiredCell(values, "Stream Start ID", rowNumber),
        trainerId: requiredCell(values, "Trainer ID", rowNumber),
        programId: requiredCell(values, "Program ID", rowNumber),
        studioFranchiseCode: requiredCell(values, "Studio Franchise Code", rowNumber),
        period,
        currency,
        streamStarts,
        liveBroadcast,
        peakSimultaneousViewers,
        liveEventRevenueCents,
      };
      return fitnessLine(
        "fitness_stream_starts_csv",
        rowNumber,
        detail,
        liveEventRevenueCents,
        STREAM_START_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — completed workout logs. The completion counts the royalty
// tier walk prices, the subscriber-retention gate, and the class revenue
// the sync music deductions come off before the trainer net share.
// ---------------------------------------------------------------------------

const workoutProfile: StatementProfile = {
  kind: "fitness_completed_workouts_csv",
  title: "Completed workout log CSV (one row per workout log batch)",
  laneRightsType: FITNESS_RIGHTS_TYPE,
  statementSourceType: FITNESS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, WORKOUT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...WORKOUT_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const completedWorkouts = parseCountCell(
        requiredCell(values, "Completed Workouts", rowNumber),
        "Completed Workouts",
        rowNumber,
      );
      if (completedWorkouts === 0) {
        throw new Error(`workout_row_prices_nothing:row_${rowNumber}`);
      }
      const classRevenueCents = parsePositiveCents(
        requiredCell(values, "Class Revenue", rowNumber),
        "Class Revenue",
        rowNumber,
      );
      const detail: FitnessWorkoutCompleteDetail = {
        sender: "workout_complete",
        senderRowId: requiredCell(values, "Workout Log ID", rowNumber),
        trainerId: requiredCell(values, "Trainer ID", rowNumber),
        programId: requiredCell(values, "Program ID", rowNumber),
        studioFranchiseCode: requiredCell(values, "Studio Franchise Code", rowNumber),
        period,
        currency,
        completedWorkouts,
        subscriberRetained: yesNoCell(values, "Subscriber Retained", rowNumber),
        classRevenueCents,
      };
      return fitnessLine(
        "fitness_completed_workouts_csv",
        rowNumber,
        detail,
        classRevenueCents,
        WORKOUT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — connected bike and treadmill telemetry. The session legs and
// the wearable active users the algorithm micro-royalty policy prices.
// A row that registers no session and no wearable usage prices nothing —
// hostile, rejected at parse (the RFID precedent).
// ---------------------------------------------------------------------------

const equipmentProfile: StatementProfile = {
  kind: "fitness_equipment_telemetry_csv",
  title: "Connected equipment telemetry CSV (one row per telemetry event)",
  laneRightsType: FITNESS_RIGHTS_TYPE,
  statementSourceType: FITNESS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, EQUIPMENT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...EQUIPMENT_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const equipmentType = requiredCell(values, "Equipment Type", rowNumber);
      if (!EQUIPMENT_TYPES.has(equipmentType)) {
        throw new Error(`invalid_equipment_type:${equipmentType}`);
      }
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const sessionCount = parseCountCell(
        requiredCell(values, "Session Count", rowNumber),
        "Session Count",
        rowNumber,
      );
      const workoutMinutes = parseCountCell(
        requiredCell(values, "Workout Minutes", rowNumber),
        "Workout Minutes",
        rowNumber,
      );
      const wearableActiveUsers = parseCountCell(
        requiredCell(values, "Wearable Active Users", rowNumber),
        "Wearable Active Users",
        rowNumber,
      );
      if (sessionCount === 0 && workoutMinutes === 0 && wearableActiveUsers === 0) {
        throw new Error(`telemetry_row_prices_nothing:row_${rowNumber}`);
      }
      const detail: FitnessEquipmentTelemetryDetail = {
        sender: "equipment_telemetry",
        senderRowId: requiredCell(values, "Telemetry ID", rowNumber),
        trainerId: requiredCell(values, "Trainer ID", rowNumber),
        programId: requiredCell(values, "Program ID", rowNumber),
        studioFranchiseCode: requiredCell(values, "Studio Franchise Code", rowNumber),
        period,
        currency,
        equipmentType: equipmentType as FitnessEquipmentTelemetryDetail["equipmentType"],
        sessionCount,
        workoutMinutes,
        wearableActiveUsers,
      };
      return fitnessLine(
        "fitness_equipment_telemetry_csv",
        rowNumber,
        detail,
        0,
        EQUIPMENT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — studio class check-ins. The physical franchise location's
// class counts (tracked) and the class revenue legs the franchise
// override, the network fee, and the co-brand split walk.
// ---------------------------------------------------------------------------

const checkinProfile: StatementProfile = {
  kind: "fitness_studio_checkins_csv",
  title: "Studio class check-in log CSV (one row per check-in batch)",
  laneRightsType: FITNESS_RIGHTS_TYPE,
  statementSourceType: FITNESS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, CHECKIN_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...CHECKIN_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const classCheckins = parseCountCell(
        requiredCell(values, "Class Check-Ins", rowNumber),
        "Class Check-Ins",
        rowNumber,
      );
      if (classCheckins === 0) {
        throw new Error(`checkin_row_prices_nothing:row_${rowNumber}`);
      }
      const classRevenueCents = parsePositiveCents(
        requiredCell(values, "Class Revenue", rowNumber),
        "Class Revenue",
        rowNumber,
      );
      const detail: FitnessStudioCheckinDetail = {
        sender: "studio_checkin",
        senderRowId: requiredCell(values, "Check-In ID", rowNumber),
        trainerId: requiredCell(values, "Trainer ID", rowNumber),
        programId: requiredCell(values, "Program ID", rowNumber),
        studioFranchiseCode: requiredCell(values, "Studio Franchise Code", rowNumber),
        period,
        currency,
        classCheckins,
        classRevenueCents,
        certifiedChoreographyRevenueCents: parsePositiveCents(
          requiredCell(values, "Certified Choreography Revenue", rowNumber),
          "Certified Choreography Revenue",
          rowNumber,
        ),
        certifiedAudioRevenueCents: parsePositiveCents(
          requiredCell(values, "Certified Audio Revenue", rowNumber),
          "Certified Audio Revenue",
          rowNumber,
        ),
      };
      return fitnessLine(
        "fitness_studio_checkins_csv",
        rowNumber,
        detail,
        classRevenueCents,
        CHECKIN_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Profile 5 — app subscription allocations. The Digital Stream Realization
// calculator's legs of record — the gross subscription pool, the app store
// engine cut, and the digital infrastructure overhead — keyed on the
// directive's three identity columns.
// ---------------------------------------------------------------------------

const allocationProfile: StatementProfile = {
  kind: "fitness_subscription_allocations_csv",
  title: "App subscription allocation CSV (one row per allocation)",
  laneRightsType: FITNESS_RIGHTS_TYPE,
  statementSourceType: FITNESS_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, ALLOCATION_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, [...ALLOCATION_HEADER]);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const currency = currencyCell(values, rowNumber);
      const period = periodCell(values, rowNumber);
      const grossSubscriptionPoolCents = parsePositiveCents(
        requiredCell(values, "Gross Subscription Pool", rowNumber),
        "Gross Subscription Pool",
        rowNumber,
      );
      const appStoreEngineCutCents = parsePositiveCents(
        requiredCell(values, "App Store Engine Cut", rowNumber),
        "App Store Engine Cut",
        rowNumber,
      );
      const digitalInfrastructureOverheadCents = parsePositiveCents(
        requiredCell(values, "Digital Infrastructure Overhead", rowNumber),
        "Digital Infrastructure Overhead",
        rowNumber,
      );
      const detail: FitnessSubscriptionAllocationDetail = {
        sender: "subscription_allocation",
        senderRowId: requiredCell(values, "Allocation ID", rowNumber),
        trainerId: requiredCell(values, "Trainer ID", rowNumber),
        programId: requiredCell(values, "Program ID", rowNumber),
        studioFranchiseCode: requiredCell(values, "Studio Franchise Code", rowNumber),
        period,
        currency,
        grossSubscriptionPoolCents,
        appStoreEngineCutCents,
        digitalInfrastructureOverheadCents,
      };
      return fitnessLine(
        "fitness_subscription_allocations_csv",
        rowNumber,
        detail,
        grossSubscriptionPoolCents,
        ALLOCATION_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The fitness lane's profiles — dispatched through the shared dispatcher. */
export const FITNESS_PROFILES: readonly StatementProfile[] = [
  streamStartProfile,
  workoutProfile,
  equipmentProfile,
  checkinProfile,
  allocationProfile,
];

/** True when a dispatched profile is the fitness lane's. */
export function isFitnessProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "fitness_stream_starts_csv" ||
    kind === "fitness_completed_workouts_csv" ||
    kind === "fitness_equipment_telemetry_csv" ||
    kind === "fitness_studio_checkins_csv" ||
    kind === "fitness_subscription_allocations_csv"
  );
}
