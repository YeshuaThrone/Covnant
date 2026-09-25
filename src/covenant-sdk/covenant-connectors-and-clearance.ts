import type {
  MatchingResult,
  RoyaltyChannelSource,
  UnclaimedRoyaltyRecord,
} from "./universal-blackbox-sweeper";
import type { UniversalWorkManifest } from "./types";

export type RawCWRRecordType =
  | "HDR"
  | "NWR"
  | "REV"
  | "ACK"
  | "SPU"
  | "SWR"
  | "REC";

export type RawCWRRecord = {
  recordType: RawCWRRecordType | string;
  rawLine: string;
};

export type RawDDEXDSRLine = {
  recordType: string;
  fields: string[];
};

export const UNMATCHED_CWR_ACK_STATUSES = ["NP", "RJ", "UN"] as const;
export type UnmatchedCwrAckStatus = (typeof UNMATCHED_CWR_ACK_STATUSES)[number];

export const DSR_UNMATCHED_STATUSES = [
  "UNMATCHED_HOLD",
  "MISSING_PUBLISHER",
  "ORPHANED",
] as const;

export const CLEARANCE_ACTIONS = [
  "CWR_RE_REGISTRATION_GENERATED",
  "DIRECT_DSP_CLAIM_SUBMITTED",
  "MICRO_SYNC_INVOICE_ISSUED",
] as const;
export type ClearanceAction = (typeof CLEARANCE_ACTIONS)[number];

export type MULClearanceNotice = {
  clearanceId: string;
  matchedWorkId: string;
  targetChannel: RoyaltyChannelSource;
  actionTaken: ClearanceAction;
  claimedAmountCents: number;
  currency: string;
  cwrRevisionPayload?: string;
  clearanceTimestamp: string;
};

/** CWR 2.1 NWR/REV: prefix 19, title 60. Official ISWC at 95-106; compact feeds at 79-90. */
const CWR_TITLE = { start: 19, end: 79 } as const;
const CWR_ISWC = { start: 95, end: 106 } as const;
const CWR_ISWC_COMPACT = { start: 79, end: 90 } as const;
/** CWR 2.1 REC ISRC at 231-243; compact feeds at 15-27. */
const CWR_REC_ISRC = { start: 231, end: 243 } as const;
const CWR_REC_ISRC_COMPACT = { start: 15, end: 27 } as const;
/** ACK status: compact 36-38, then official 38-40 / 40-42. */
const CWR_ACK_STATUS_COMPACT = { start: 36, end: 38 } as const;
const CWR_ACK_STATUS = { start: 38, end: 40 } as const;
const CWR_ACK_STATUS_FALLBACK = { start: 40, end: 42 } as const;
/** Fixed-width sandbox REV body (prefix + title + ISWC + space pad). Terminator is CRLF. */
export const CWR_REV_LINE_LENGTH = 197;
export const CWR_REV_TERMINATOR = "\r\n";

const UNMATCHED_ACK = new Set<string>(UNMATCHED_CWR_ACK_STATUSES);
const UNMATCHED_DSR = new Set<string>(DSR_UNMATCHED_STATUSES);

type CwrTransaction = {
  seq: string;
  ackStatus?: string;
  title?: string;
  iswc?: string;
  isrc?: string;
};

export type ConnectorClock = () => Date;

function defaultClock(): Date {
  return new Date();
}

function sliceField(line: string, start: number, end: number): string {
  if (line.length <= start) {
    return "";
  }
  return line.substring(start, end).trim();
}

function optionalField(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function cwrRecordType(line: string): string {
  return line.substring(0, 3);
}

function cwrTransactionSeq(line: string): string {
  return line.substring(3, 11);
}

function isUnmatchedAckStatus(status: string): status is UnmatchedCwrAckStatus {
  return UNMATCHED_ACK.has(status);
}

function looksLikeIsrc(value: string): boolean {
  const compact = value.replace(/[^A-Za-z0-9]/g, "");
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(compact);
}

function looksLikeIswc(value: string): boolean {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return /^T\d{9,10}$/.test(compact);
}

/** Short sandbox ACK lines park NP/RJ/UN in the last two characters. */
function ackStatusOf(line: string): string {
  const compact = sliceField(
    line,
    CWR_ACK_STATUS_COMPACT.start,
    CWR_ACK_STATUS_COMPACT.end,
  );
  if (isUnmatchedAckStatus(compact)) {
    return compact;
  }
  const primary = sliceField(line, CWR_ACK_STATUS.start, CWR_ACK_STATUS.end);
  if (isUnmatchedAckStatus(primary)) {
    return primary;
  }
  const fallback = sliceField(
    line,
    CWR_ACK_STATUS_FALLBACK.start,
    CWR_ACK_STATUS_FALLBACK.end,
  );
  if (isUnmatchedAckStatus(fallback)) {
    return fallback;
  }
  if (line.length < CWR_ISWC.start) {
    const tail = line.trim().slice(-2);
    if (isUnmatchedAckStatus(tail)) {
      return tail;
    }
  }
  return compact || primary;
}

function recIsrc(line: string): string | undefined {
  const compact = optionalField(
    sliceField(line, CWR_REC_ISRC_COMPACT.start, CWR_REC_ISRC_COMPACT.end),
  );
  if (compact && looksLikeIsrc(compact)) {
    return compact;
  }
  const official = optionalField(
    sliceField(line, CWR_REC_ISRC.start, CWR_REC_ISRC.end),
  );
  if (official && looksLikeIsrc(official)) {
    return official;
  }
  const match = line.match(/\b([A-Z]{2}[A-Z0-9]{3}\d{7})\b/);
  return match?.[1];
}

function nwrIswc(line: string): string | undefined {
  const official = optionalField(sliceField(line, CWR_ISWC.start, CWR_ISWC.end));
  if (official && looksLikeIswc(official)) {
    return official;
  }
  const compact = optionalField(
    sliceField(line, CWR_ISWC_COMPACT.start, CWR_ISWC_COMPACT.end),
  );
  if (compact && looksLikeIswc(compact)) {
    return compact;
  }
  if (line.length < CWR_ISWC.start) {
    const match = line.match(/\b(T\d{10})\b/i);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  return official ?? compact;
}

function nwrTitle(line: string): string | undefined {
  if (line.length < CWR_ISWC.start) {
    const iswcMatch = line.match(/T\d{10}\s*$/i);
    if (
      iswcMatch &&
      iswcMatch.index !== undefined &&
      iswcMatch.index > CWR_TITLE.start
    ) {
      return optionalField(line.slice(CWR_TITLE.start, iswcMatch.index).trim());
    }
  }
  return optionalField(sliceField(line, CWR_TITLE.start, CWR_TITLE.end));
}

function addUtcYears(from: Date, years: number): Date {
  const next = new Date(from.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function slugIdPart(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug === "" ? "NA" : slug.slice(0, 40);
}

/**
 * Parse a decimal dollar string ("12.34") into integer cents without float remainder.
 * Rejects negatives and malformed values.
 */
export function parseDecimalDollarsToCents(raw: string): number | undefined {
  const trimmed = raw.trim().replace(/,/g, "");
  const match = trimmed.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    return undefined;
  }
  const whole = Number(match[1]);
  const frac = (match[2] ?? "").padEnd(2, "0");
  const cents = whole * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) {
    return undefined;
  }
  return cents;
}

/**
 * Sandbox CWR / DDEX DSR parsers. Do not submit files to societies or DSPs.
 */
export class CovenantIngestionEngine {
  private readonly clock: ConnectorClock;

  constructor(options: { clock?: ConnectorClock } = {}) {
    this.clock = options.clock ?? defaultClock;
  }

  public parseCWRUnmatchedFeed(
    cwrFileContent: string,
    sourceSociety: string,
  ): UnclaimedRoyaltyRecord[] {
    const transactions = new Map<string, CwrTransaction>();
    const lines = cwrFileContent.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.replace(/\n$/, "");
      if (line.trim() === "") {
        continue;
      }
      const recordType = cwrRecordType(line);
      const seq = cwrTransactionSeq(line) || "00000000";
      const current = transactions.get(seq) ?? { seq };

      if (recordType === "NWR" || recordType === "REV") {
        current.title = nwrTitle(line);
        current.iswc = nwrIswc(line);
      } else if (recordType === "REC") {
        current.isrc = recIsrc(line) ?? current.isrc;
      } else if (recordType === "ACK") {
        current.ackStatus = ackStatusOf(line);
      }

      transactions.set(seq, current);
    }

    const holdingPeriodEnd = addUtcYears(this.clock(), 3).toISOString();
    const records: UnclaimedRoyaltyRecord[] = [];

    for (const tx of transactions.values()) {
      if (!tx.ackStatus || !isUnmatchedAckStatus(tx.ackStatus)) {
        continue;
      }
      const identifiers = {
        ...(tx.iswc ? { iswc: tx.iswc } : {}),
        ...(tx.isrc ? { isrc: tx.isrc } : {}),
      };
      if (!tx.title && Object.keys(identifiers).length === 0) {
        continue;
      }
      records.push({
        recordId: `CWR_ACK_${slugIdPart(sourceSociety)}_${tx.seq}`,
        sourceChannel: "PRO_CMO_UNMATCHED",
        sourceEntityName: sourceSociety,
        unallocatedAmountCents: 0,
        currency: "USD",
        territory: "US",
        rawMetadata: {
          title: tx.title,
          identifiers,
          confidenceScore: 0.85,
        },
        holdingPeriodEnd,
      });
    }

    return records;
  }

  /**
   * Sandbox DDEX DSR TSV dialect with stateful AS01/AS02/MW01 blocks.
   * SU02 sales lines resolve identifiers from the block map, then fall back
   * to in-line columns: 3=title, 4=ISRC, 5=ISWC, 8=territory, 9=currency,
   * 10=net dollars, 12=status.
   */
  public parseDDEXDSRFeed(
    dsrFileContent: string,
    dspName: string,
  ): UnclaimedRoyaltyRecord[] {
    const holdingPeriodEnd = addUtcYears(this.clock(), 2).toISOString();
    const records: UnclaimedRoyaltyRecord[] = [];
    const resourceMap = new Map<
      string,
      { title?: string; isrc?: string; iswc?: string }
    >();
    const lines = dsrFileContent.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      const fields = line.split("\t");
      const recordType = fields[0] ?? "";

      if (recordType === "AS01" || recordType === "AS02" || recordType === "MW01") {
        const blockId = (fields[1] ?? "").trim();
        if (blockId !== "") {
          resourceMap.set(blockId, {
            title: optionalField((fields[2] ?? fields[3] ?? "").trim()),
            isrc: optionalField((fields[4] ?? "").trim()),
            iswc: optionalField((fields[5] ?? "").trim()),
          });
        }
      }

      const isSalesLine = recordType === "SU02";
      const unmatchedBlock =
        recordType === "MW01" &&
        UNMATCHED_DSR.has((fields[12] ?? "").trim());
      if (!isSalesLine && !unmatchedBlock) {
        continue;
      }

      const status = (fields[12] ?? "").trim();
      if (!UNMATCHED_DSR.has(status)) {
        continue;
      }
      const netAmountCents = parseDecimalDollarsToCents(fields[10] ?? "");
      if (netAmountCents === undefined) {
        continue;
      }
      const blockRef = (fields[1] ?? "").trim();
      const mapped = blockRef === "" ? undefined : resourceMap.get(blockRef);
      const title =
        mapped?.title ?? optionalField((fields[3] ?? "").trim());
      const isrc = mapped?.isrc ?? optionalField((fields[4] ?? "").trim());
      const iswc = mapped?.iswc ?? optionalField((fields[5] ?? "").trim());
      records.push({
        recordId: `DSR_${slugIdPart(dspName)}_${index}_${slugIdPart(isrc ?? title ?? "line")}`,
        sourceChannel: "DSP_DIRECT_DISTRIBUTION",
        sourceEntityName: dspName,
        unallocatedAmountCents: netAmountCents,
        currency: optionalField((fields[9] ?? "").trim()) ?? "USD",
        territory: optionalField((fields[8] ?? "").trim()) ?? "WW",
        rawMetadata: {
          title,
          identifiers: {
            ...(isrc ? { isrc } : {}),
            ...(iswc ? { iswc } : {}),
          },
          confidenceScore: 0.9,
        },
        holdingPeriodEnd,
      });
    }

    return records;
  }
}

/**
 * Sandbox MUL claim notices. Generates CWR REV strings locally.
 * Does not POST to societies, DSPs, or Covenant HTTP.
 */
export class CovenantClearanceDispatchNode {
  private readonly clock: ConnectorClock;

  constructor(options: { clock?: ConnectorClock } = {}) {
    this.clock = options.clock ?? defaultClock;
  }

  public async dispatchClearance(
    matches: MatchingResult[],
    works: UniversalWorkManifest[] = [],
  ): Promise<MULClearanceNotice[]> {
    const clearanceTimestamp = this.clock().toISOString();
    const notices: MULClearanceNotice[] = [];
    const worksById = new Map(works.map((work) => [work.workId, work]));

    for (const match of matches) {
      let actionTaken: ClearanceAction = "DIRECT_DSP_CLAIM_SUBMITTED";
      let cwrRevisionPayload: string | undefined;
      const work = worksById.get(match.matchedWorkId);

      if (match.sourceChannel === "PRO_CMO_UNMATCHED") {
        actionTaken = "CWR_RE_REGISTRATION_GENERATED";
        cwrRevisionPayload = this.generateCWRRevisionRecord(
          work?.title ?? match.matchedWorkId,
          work?.identifiers.iswc ?? "",
        );
      } else if (
        match.sourceChannel === "SYNC_CUE_SHEETS" ||
        match.sourceChannel === "GAMING_INTERACTIVE"
      ) {
        actionTaken = "MICRO_SYNC_INVOICE_ISSUED";
      }

      notices.push({
        clearanceId: `CLR_${match.recordId}_${match.matchedWorkId}`,
        matchedWorkId: match.matchedWorkId,
        targetChannel: match.sourceChannel,
        actionTaken,
        claimedAmountCents: match.recoveredAmountCents,
        currency: match.currency,
        cwrRevisionPayload,
        clearanceTimestamp,
      });
    }

    return notices;
  }

  /**
   * Strictly formats a 197-character CWR REV body with a CRLF terminator.
   */
  private generateCWRRevisionRecord(workTitle: string, iswc: string): string {
    const transactionNum = "00000001";
    const recordSeq = "00000000";
    const revHeader = `REV${transactionNum}${recordSeq}`;
    const titlePadded = workTitle.toUpperCase().padEnd(60, " ").slice(0, 60);
    const iswcPadded = iswc
      .replace(/[^A-Z0-9]/gi, "")
      .toUpperCase()
      .padEnd(11, " ")
      .slice(0, 11);

    return (
      `${revHeader}${titlePadded}${iswcPadded}`.padEnd(CWR_REV_LINE_LENGTH, " ") +
      CWR_REV_TERMINATOR
    );
  }
}
