/**
 * CISAC CWR 2.1 (Common Works Registration) parser.
 *
 * Maps a CWR 2.1 work-registration file onto CanonicalRoyaltyEvents. CWR is
 * a fixed-width, CRLF-delimited format; the field positions consumed here
 * are cross-checked between independent published sources retrieved this
 * session: the CWR-DataApi field-order config (work_title,
 * language_code, submitter_work_n, iswc, ...) and a generator transcribed
 * from the CISAC functional-specification pages (title (19,60), language
 * code (79,2), submitter work number (81,14), ISWC (95,11)). The published
 * blog example files are NOT byte-consistent with each other (one variant
 * drops the language/ISWC region; the site's own HTML collapses padding),
 * so the golden fixture is rebuilt along the verified table with value
 * substitutions only inside documented fields. Transaction records open
 * with a 19-character prefix: record type (3), transaction number (8),
 * record number within the transaction (8).
 *
 * One canonical event per work transaction (NWR = new work registration,
 * REV = revision):
 *
 * - `eventId`        — `<senderId>-<type>-<txNumber>-<submitterWorkN>`:
 *   re-delivery of the same file collapses (idempotent), while a revision
 *   in a later file is a distinct event;
 * - `grossMicros`    — 0n. CWR is a work-REGISTRATION format: it carries
 *   shares and identifiers, never money. The SDK does not invent amounts;
 * - `currency`       — 'XXX', the ISO 4217 code for "no currency involved"
 *   — the honest tag for an amount-less registration event;
 * - `period`         — null (CWR carries no usage period);
 * - `identifiers`    — the work's ISWC (NWR/REV field, wire form
 *   `T` + 10 digits, converted to the canonical dashed form) and the ISRC
 *   of any attached REC (first recording) record. At least one canonical
 *   identifier per work is required — a registration the exact matcher
 *   could never key on is rejected, not silently skipped;
 * - `rightsPipeline` — `composition_mechanical` (CWR feeds work-registration
 *   matching for mechanical collection — The MLC profile of this SDK);
 * - `raw`            — the transaction's verbatim lines joined with '\n'.
 *
 * Fail-closed rejections (typed reasons, prefixed `cwr:`): structural
 * violations (missing HDR/TRL, unknown record types, empty lines, group
 * count mismatches), unsupported group types (e.g. ACK files) and CWR
 * versions (v1 pins 2.1, version tag `02.10`), invalid header fields, and
 * invalid or missing identifiers. Detail records beyond REC are validated
 * as recognised record types only; their values stay in the raw payload.
 * v1 never touches share fields — split/dust math is never reimplemented
 * here (locked decision).
 */

import { canonicalizeIdentifier } from '../../contracts/identifiers';
import type { CanonicalRoyaltyEvent } from '../../contracts/royalty-event';
import type { StatementFile } from '../../nodes/collection-node';
import { SdkMalformedInputError } from '../../nodes/errors';
import { splitRecordLines } from '../record-lines';

/** CWR 2.1 record type (first 3 chars of every line). */
type CwrRecordType = string;

/** The transaction (work) record types v1 maps onto events. */
const WORK_RECORD_TYPES: readonly string[] = ['NWR', 'REV'];

/** Recognised detail-record types of CWR 2.1 (values left in raw). */
const DETAIL_RECORD_TYPES: readonly string[] = [
  'AGR', 'ALT', 'ARI', 'COM', 'EWT', 'EXC', 'MSG', 'OPU', 'OWR', 'ORN', 'PER',
  'PWR', 'REC', 'SPT', 'SPU', 'SWT', 'SWR',
];

/** Sender types of the CWR header record (PB/SO/AA/WR per the spec table). */
const SENDER_TYPES: readonly string[] = ['PB', 'SO', 'AA', 'WR'];

/** The work record's ISWC field: [start, length] in the line, 0-based. */
const ISWC_FIELD = [95, 11] as const;

/** The REC record's ISRC field: [start, length] in the line, 0-based. */
const REC_ISRC_FIELD = [251, 12] as const;

/** A work transaction: its opening record plus every detail record's line. */
interface WorkTransaction {
  readonly transactionType: string;
  readonly transactionNumber: string;
  readonly recordNumber: string;
  readonly submitterWorkN: string;
  readonly iswcCell: string;
  readonly recIsrcCell: string | null;
  readonly lines: readonly string[];
}

/** The parsed file: header plus one event-shaped transaction set per group. */
interface ParsedCwrFile {
  readonly senderId: string;
  readonly transactions: readonly WorkTransaction[];
  readonly groupCount: number;
  readonly transactionCount: number;
  readonly recordCount: number;
}

/** Extracts a fixed-width field; the line must be long enough to hold it. */
function field(line: string, start: number, length: number): string {
  if (line.length < start + length) {
    throw new SdkMalformedInputError(`cwr:short_line:${line.slice(0, 3)}`);
  }
  return line.slice(start, start + length);
}

/** Requires a field to be non-blank once its fixed-width padding is trimmed. */
function requireField(line: string, start: number, length: number, name: string): string {
  const value = field(line, start, length).trim();
  if (value === '') {
    throw new SdkMalformedInputError(`cwr:missing_field:${name}`);
  }
  return value;
}

/** Parses the HDR record (sender identity + EDI version 01.10). */
function parseHeader(line: string): { senderId: string; senderName: string } {
  if (field(line, 0, 3) !== 'HDR') {
    throw new SdkMalformedInputError('cwr:invalid_header_record');
  }
  const senderType = field(line, 3, 2);
  if (!SENDER_TYPES.includes(senderType)) {
    throw new SdkMalformedInputError(`cwr:invalid_sender_type:${senderType}`);
  }
  const senderId = field(line, 5, 9);
  if (!/^\d{9}$/.test(senderId)) {
    throw new SdkMalformedInputError(`cwr:invalid_sender_id:${senderId}`);
  }
  const ediVersion = field(line, 59, 5);
  if (ediVersion !== '01.10') {
    throw new SdkMalformedInputError(`cwr:invalid_edi_version:${ediVersion}`);
  }
  for (const [name, start, length] of [
    ['creation_date', 64, 8],
    ['creation_time', 72, 6],
    ['transmission_date', 78, 8],
  ] as const) {
    if (!/^\d+$/.test(field(line, start, length))) {
      throw new SdkMalformedInputError(`cwr:invalid_field:${name}`);
    }
  }
  return { senderId, senderName: requireField(line, 14, 45, 'sender_name') };
}

/** Parses a GRH group header: NWR/REV groups of CWR version 02.10 only. */
function parseGroupHeader(line: string): void {
  const transactionType = field(line, 3, 3);
  if (!WORK_RECORD_TYPES.includes(transactionType)) {
    throw new SdkMalformedInputError(`cwr:unsupported_group_type:${transactionType}`);
  }
  if (!/^\d{5}$/.test(field(line, 6, 5))) {
    throw new SdkMalformedInputError('cwr:invalid_field:group_id');
  }
  const version = field(line, 11, 5);
  if (version !== '02.10') {
    throw new SdkMalformedInputError(`cwr:unsupported_cwr_version:${version}`);
  }
}

/**
 * Parses a work (NWR/REV) record into the transaction accumulator. Layout
 * (CWR 2.1 work record): title (19,60), language code (79,2), submitter
 * work number (81,14), ISWC (95,11) — the two-character language code
 * between title and submitter is what shifts every later field.
 */
function parseWorkRecord(
  line: string,
  transactionType: string,
  transactionNumber: string,
  recordNumber: string,
): WorkTransaction {
  const submitterWorkN = requireField(line, 81, 14, 'submitter_work_n');
  return {
    transactionType,
    transactionNumber,
    recordNumber,
    submitterWorkN,
    iswcCell: field(line, ISWC_FIELD[0], ISWC_FIELD[1]).trim(),
    recIsrcCell: null,
    lines: [line],
  };
}

/** Validates one detail record; REC contributes its ISRC to the work. */
function parseDetailRecord(
  line: string,
  recordType: CwrRecordType,
  current: WorkTransaction,
): WorkTransaction {
  if (!DETAIL_RECORD_TYPES.includes(recordType)) {
    throw new SdkMalformedInputError(`cwr:unknown_record_type:${recordType}`);
  }
  if (recordType === 'REC') {
    const isrcCell = field(line, REC_ISRC_FIELD[0], REC_ISRC_FIELD[1]).trim();
    return { ...current, recIsrcCell: isrcCell === '' ? current.recIsrcCell : isrcCell, lines: [...current.lines, line] };
  }
  return { ...current, lines: [...current.lines, line] };
}

/**
 * The i-th record line, guarding noUncheckedIndexedAccess at the boundary —
 * a missing line inside a well-formed file is itself a typed rejection.
 */
function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new SdkMalformedInputError(`cwr:missing_record_line:${index + 1}`);
  }
  return line;
}

/** Validates group/trailer counts and assembles the parsed file. */
function parseGroupsAndCounts(lines: readonly string[]): ParsedCwrFile {
  if (lines.length === 0) {
    throw new SdkMalformedInputError('cwr:empty_statement_file');
  }
  const header = parseHeader(lineAt(lines, 0));
  const trailer = lineAt(lines, lines.length - 1);
  if (trailer.slice(0, 3) !== 'TRL') {
    throw new SdkMalformedInputError('cwr:missing_trailer_record');
  }

  const transactions: WorkTransaction[] = [];
  let current: WorkTransaction | null = null;
  let groupLines = 0;
  let groupCount = 0;
  let transactionsBeforeGroup = 0;

  for (let i = 1; i < lines.length - 1; i += 1) {
    const line = lineAt(lines, i);
    if (line === '') {
      throw new SdkMalformedInputError(`cwr:empty_record_line:${i + 1}`);
    }
    const recordType = field(line, 0, 3);

    if (recordType === 'GRH') {
      if (groupCount > 0) {
        throw new SdkMalformedInputError('cwr:multiple_groups_unsupported');
      }
      groupLines = 1;
      groupCount += 1;
      transactionsBeforeGroup = transactions.length + (current === null ? 0 : 1);
      parseGroupHeader(line);
      current = null;
    } else if (recordType === 'GRT') {
      groupLines += 1;
      if (current !== null) transactions.push(current);
      current = null;
      const groupId = field(line, 3, 5);
      if (!/^\d{5}$/.test(groupId)) {
        throw new SdkMalformedInputError('cwr:invalid_field:group_id');
      }
      const groupTransactions = transactions.length - transactionsBeforeGroup;
      if (groupTransactions !== Number(field(line, 8, 8))) {
        throw new SdkMalformedInputError('cwr:group_count_mismatch:transaction_count');
      }
      if (groupLines !== Number(field(line, 16, 8))) {
        throw new SdkMalformedInputError('cwr:group_count_mismatch:record_count');
      }
    } else if (WORK_RECORD_TYPES.includes(recordType)) {
      groupLines += 1;
      if (current !== null) transactions.push(current);
      current = parseWorkRecord(
        line,
        recordType,
        field(line, 3, 8),
        field(line, 11, 8),
      );
    } else {
      groupLines += 1;
      if (current === null) {
        throw new SdkMalformedInputError(`cwr:detail_record_without_work:${recordType}`);
      }
      current = parseDetailRecord(line, recordType, current);
    }
  }

  const expected: readonly [number, number, string][] = [
    [groupCount, Number(field(trailer, 3, 5)), 'group_count'],
    [transactions.length, Number(field(trailer, 8, 8)), 'transaction_count'],
    [lines.length, Number(field(trailer, 16, 8)), 'record_count'],
  ];
  for (const [actual, declared, name] of expected) {
    if (declared !== actual) {
      throw new SdkMalformedInputError(`cwr:trailer_count_mismatch:${name}`);
    }
  }

  return {
    senderId: header.senderId,
    transactions,
    groupCount,
    transactionCount: transactions.length,
    recordCount: lines.length,
  };
}

/** Converts a CWR wire ISWC (T + 10 digits) to the canonical dashed form. */
function cwrIswcToCanonical(wire: string): string | null {
  if (!/^T\d{10}$/.test(wire)) return null;
  return canonicalizeIdentifier('ISWC', `T-${wire.slice(1, 10)}-${wire.slice(10)}`);
}

/** Maps each work transaction onto its canonical event, fully validated. */
function buildEvents(parsed: ParsedCwrFile): readonly CanonicalRoyaltyEvent[] {
  if (parsed.transactions.length === 0) {
    throw new SdkMalformedInputError('cwr:no_work_transactions');
  }
  const events: CanonicalRoyaltyEvent[] = [];
  const seen = new Set<string>();
  for (const transaction of parsed.transactions) {
    const identifiers: CanonicalRoyaltyEvent['identifiers'] = {};
    const iswc = transaction.iswcCell === '' ? null : cwrIswcToCanonical(transaction.iswcCell);
    if (transaction.iswcCell !== '' && iswc === null) {
      throw new SdkMalformedInputError(
        `cwr:invalid_iswc:${transaction.transactionType}-${transaction.transactionNumber}-${transaction.submitterWorkN}`,
      );
    }
    if (iswc !== null) identifiers.ISWC = iswc;

    if (transaction.recIsrcCell !== null) {
      const isrc = canonicalizeIdentifier('ISRC', transaction.recIsrcCell);
      if (isrc === null) {
        throw new SdkMalformedInputError(
          `cwr:invalid_isrc:${transaction.transactionType}-${transaction.transactionNumber}-${transaction.submitterWorkN}`,
        );
      }
      identifiers.ISRC = isrc;
    }

    if (Object.keys(identifiers).length === 0) {
      throw new SdkMalformedInputError(
        `cwr:no_canonical_identifier:${transaction.transactionType}-${transaction.transactionNumber}-${transaction.submitterWorkN}`,
      );
    }

    const eventId = `${parsed.senderId}-${transaction.transactionType}-${transaction.transactionNumber}-${transaction.submitterWorkN}`;
    if (seen.has(eventId)) {
      throw new SdkMalformedInputError(`cwr:duplicate_transaction:${eventId}`);
    }
    seen.add(eventId);

    events.push({
      eventId,
      rightsPipeline: 'composition_mechanical',
      source: 'statement',
      statementFormat: 'cwr',
      period: null,
      currency: 'XXX',
      grossMicros: 0n,
      identifiers,
      platform: null,
      territory: null,
      raw: transaction.lines.join('\n'),
    });
  }
  return events;
}

/** Parses a CWR 2.1 work-registration file into canonical events. */
export function parseCwrStatement(file: StatementFile): readonly CanonicalRoyaltyEvent[] {
  return buildEvents(parseGroupsAndCounts(splitRecordLines(file.content)));
}
