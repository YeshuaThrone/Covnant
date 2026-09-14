/**
 * DDEX RDR-R (Recording Data and Rights — Revenue Report) parser.
 *
 * Maps the published DDEX RDR-R RevenueReport tab-separated format onto
 * CanonicalRoyaltyEvents. The record layouts, cell meanings and mandatory
 * flags consumed here come from the published DDEX standard, RDR-R 1.1
 * ("6.3.4.1 — RHEA.01", "6.3.4.4 — RS01.01", "6.3.4.6 — RS02.01",
 * "6.3.4.9 — RD01.01", "6.3.4.22 — RFOO", retrieved from support.ddex.net
 * during this implementation; the golden fixtures use that document's own
 * example cell values).
 *
 * One canonical event per RD01.01 (sound-recording revenue details) record:
 *
 * - `eventId`          — `<MessageId>-<SoundRecordingRevenueDetailsRecordId>`
 *   (RDR-R 6.4.13: record ids are unique within a message);
 * - `grossMicros`      — RD01.01 cell 35, PayingMlcGrossAmount — the
 *   MANDATORY money cell on the record, converted exactly via ../money;
 *   deduction/commission cells are left in the verbatim raw payload;
 * - `currency`         — the RS01.01 CurrencyOfAccounting the details are
 *   reported in (RDR-R: details are expressed "in the CurrencyOfAccounting
 *   (as communicated in the relevant RS01.01 Record)");
 * - `period`           — the record's own UsageStartDate/UsageEndDate
 *   (cells 23/24), as the ISO 8601 interval `<start>/<end>`;
 * - `identifiers`      — the record's ISRC (cell 5), canonicalised; an event
 *   without one cannot be matched exactly, so such a file is rejected — the
 *   standard makes cell 6 (ProprietaryResourceId) the alternative, but the
 *   contract has no canonical kind for it and the SDK never invents one;
 * - `rightsPipeline`   — `master_digital_performance` (RDR-R reports are
 *   recording-side MLC revenue);
 * - `raw`              — the verbatim record line.
 *
 * Fail-closed rejections (typed `SdkMalformedInputError` reasons, prefixed
 * `ddex:`): structure violations (header/footer placement, unknown record
 * types), dangling cross-record references (6.4.13), footer count
 * mismatches, invalid dates/currencies/amounts, and missing/invalid ISRCs.
 * RD02.01/RD03.01 (AV and other revenue details) are recognised RDR records
 * this parser version does not map — they are rejected rather than dropped,
 * so no reported revenue can be silently skipped.
 */

import { canonicalizeIdentifier } from '../../contracts/identifiers';
import type { CanonicalRoyaltyEvent } from '../../contracts/royalty-event';
import type { StatementFile } from '../../nodes/collection-node';
import { SdkMalformedInputError } from '../../nodes/errors';
import { splitRecordLines } from '../record-lines';
import { decimalToMicros } from '../money';

/** RD01.01 carries 55 cells; the last mandatory one (PayingMlcGrossAmount) is 35. */
const RD01_MIN_CELLS = 35;

/** RS02.01 carries 36 cells; the last mandatory one (NetAmount) is 35. */
const RS02_MIN_CELLS = 35;

/** ISO 8601 calendar date with optional month and day — RDR-R date cells. */
const RDR_DATE_PATTERN = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** RFC 3339-ish timestamp — RDR-R MessageCreatedDateTime. */
const RDR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

/** Header record RHEA.01 — the cells this parser consumes or validates. */
interface RevenueHeader {
  readonly messageId: string;
  readonly createdDateTime: string;
}

/** Revenue summary record (RS01.01): carries the currency of accounting. */
interface RevenueSummary {
  readonly recordId: string;
  readonly currency: string;
}

/** Allocated-party summary record (RS02.01). */
interface AllocatedPartySummary {
  readonly statementSummaryRecordId: string;
  readonly allocatedPartySummaryRecordId: string;
}

/** Sound-recording revenue detail record (RD01.01) — one canonical event. */
interface RevenueDetail {
  readonly recordId: string;
  readonly allocatedPartySummaryRecordId: string;
  readonly isrcCell: string;
  readonly territoryCell: string;
  readonly usageStartDate: string;
  readonly usageEndDate: string;
  readonly payingMlcGrossAmount: string;
  readonly line: string;
}

/** Footprint of one parsed message before event construction. */
interface ParsedRevenueReport {
  readonly header: RevenueHeader;
  readonly summaries: readonly RevenueSummary[];
  readonly parties: readonly AllocatedPartySummary[];
  readonly details: readonly RevenueDetail[];
}

/** Fails with a typed rejection when a mandatory cell is absent. */
function requireCell(lineNumber: number, record: string, cell: string | undefined, name: string): string {
  if (cell === undefined || cell === '') {
    throw new SdkMalformedInputError(`ddex:missing_cell:${record}.${name}:line_${lineNumber}`);
  }
  return cell;
}

/** Validates an RDR date cell (YYYY or YYYY-MM or YYYY-MM-DD). */
function requireDate(lineNumber: number, record: string, cell: string | undefined, name: string): string {
  if (cell === undefined || !RDR_DATE_PATTERN.test(cell)) {
    throw new SdkMalformedInputError(`ddex:invalid_date:${record}.${name}:line_${lineNumber}`);
  }
  return cell;
}

/** Parses the RHEA.01 header record (mandatory cells 1-13). */
function parseHeader(line: string, lineNumber: number): RevenueHeader {
  const cells = line.split('\t');
  if (cells.length < 13) {
    throw new SdkMalformedInputError(`ddex:truncated_header:line_${lineNumber}`);
  }
  if (cells[1] !== '11') {
    throw new SdkMalformedInputError(`ddex:invalid_message_version:${cells[1]}`);
  }
  return {
    messageId: requireCell(lineNumber, 'RHEA.01', cells[3], 'MessageId'),
    createdDateTime: requireCell(lineNumber, 'RHEA.01', cells[4], 'MessageCreatedDateTime'),
  };
}

/** Parses one RS01.01 revenue summary record (mandatory cells 1-5). */
function parseRevenueSummary(line: string, lineNumber: number): RevenueSummary {
  const cells = line.split('\t');
  if (cells.length < 5) {
    throw new SdkMalformedInputError(`ddex:truncated_summary:line_${lineNumber}`);
  }
  const currency = cells[3] ?? '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new SdkMalformedInputError(`ddex:invalid_currency:${currency}:line_${lineNumber}`);
  }
  const netRevenue = decimalToMicros(cells[4] ?? '');
  if (!netRevenue.ok) {
    throw new SdkMalformedInputError(
      `ddex:invalid_amount:RS01.01.NetRevenueInCurrencyOfAccounting:line_${lineNumber}`,
    );
  }
  return {
    recordId: requireCell(lineNumber, 'RS01.01', cells[1], 'RevenueSummaryRecordId'),
    currency,
  };
}

/** Parses one RS02.01 allocated-party summary record (mandatory cells 1-35). */
function parseAllocatedPartySummary(line: string, lineNumber: number): AllocatedPartySummary {
  const cells = line.split('\t');
  if (cells.length < RS02_MIN_CELLS) {
    throw new SdkMalformedInputError(`ddex:truncated_allocated_party:line_${lineNumber}`);
  }
  return {
    statementSummaryRecordId: requireCell(
      lineNumber,
      'RS02.01',
      cells[1],
      'StatementSummaryRecordId',
    ),
    allocatedPartySummaryRecordId: requireCell(
      lineNumber,
      'RS02.01',
      cells[2],
      'AllocatedPartySummaryRecordId',
    ),
  };
}

/** Parses one RD01.01 sound-recording revenue detail record (mandatory cells 1-35). */
function parseRevenueDetail(line: string, lineNumber: number): RevenueDetail {
  const cells = line.split('\t');
  if (cells.length < RD01_MIN_CELLS) {
    throw new SdkMalformedInputError(`ddex:truncated_revenue_detail:line_${lineNumber}`);
  }
  return {
    recordId: requireCell(lineNumber, 'RD01.01', cells[1], 'SoundRecordingRevenueDetailsRecordId'),
    allocatedPartySummaryRecordId: requireCell(
      lineNumber,
      'RD01.01',
      cells[2],
      'AllocatedPartySummaryRecordId',
    ),
    isrcCell: cells[4] ?? '',
    territoryCell: requireCell(lineNumber, 'RD01.01', cells[15], 'TerritoryOfRevenueGeneration'),
    usageStartDate: requireDate(lineNumber, 'RD01.01', cells[22], 'UsageStartDate'),
    usageEndDate: requireDate(lineNumber, 'RD01.01', cells[23], 'UsageEndDate'),
    payingMlcGrossAmount: requireCell(lineNumber, 'RD01.01', cells[34], 'PayingMlcGrossAmount'),
    line,
  };
}

/** Walks the message's records, validating structure and cross-references. */
function parseRecords(lines: readonly string[]): ParsedRevenueReport {
  const headerLine = lines[0] ?? '';
  if (!headerLine.startsWith('RHEA.01\t')) {
    throw new SdkMalformedInputError('ddex:invalid_header_record');
  }
  const header = parseHeader(headerLine, 1);

  if (!(lines[lines.length - 1] ?? '').startsWith('RFOO\t')) {
    throw new SdkMalformedInputError('ddex:missing_footer_record');
  }

  const summaries: RevenueSummary[] = [];
  const parties: AllocatedPartySummary[] = [];
  const details: RevenueDetail[] = [];

  for (let i = 1; i < lines.length - 1; i += 1) {
    const line = lines[i] ?? '';
    const lineNumber = i + 1;
    if (line === '') {
      throw new SdkMalformedInputError(`ddex:empty_record_line:${lineNumber}`);
    }
    const recordType = line.slice(0, line.indexOf('\t'));
    if (recordType === 'RS01.01') {
      summaries.push(parseRevenueSummary(line, lineNumber));
    } else if (recordType === 'RS02.01') {
      parties.push(parseAllocatedPartySummary(line, lineNumber));
    } else if (recordType === 'RD01.01') {
      details.push(parseRevenueDetail(line, lineNumber));
    } else if (recordType === 'RD02.01' || recordType === 'RD03.01') {
      throw new SdkMalformedInputError(`ddex:unsupported_revenue_details_record:${recordType}`);
    } else {
      throw new SdkMalformedInputError(`ddex:unknown_record_type:${recordType || 'EMPTY'}`);
    }
  }

  const message: ParsedRevenueReport = { header, summaries, parties, details };
  validateReferencesAndCounts(lines, message);
  return message;
}

/** Enforces referential integrity (RDR-R 6.4.13) and the RFOO count cells. */
function validateReferencesAndCounts(
  lines: readonly string[],
  message: ParsedRevenueReport,
): void {
  if (message.summaries.length === 0) {
    throw new SdkMalformedInputError('ddex:no_revenue_summary_record');
  }
  const currencies = new Set(message.summaries.map((summary) => summary.currency));
  if (currencies.size !== 1) {
    throw new SdkMalformedInputError('ddex:conflicting_currencies');
  }
  if (message.parties.length === 0) {
    throw new SdkMalformedInputError('ddex:no_allocated_party_summary_record');
  }
  if (message.details.length === 0) {
    throw new SdkMalformedInputError('ddex:no_revenue_details');
  }

  const summaryIds = new Set(message.summaries.map((summary) => summary.recordId));
  const partyIds = new Set(message.parties.map((party) => party.allocatedPartySummaryRecordId));
  for (const party of message.parties) {
    if (!summaryIds.has(party.statementSummaryRecordId)) {
      throw new SdkMalformedInputError(
        `ddex:dangling_reference:RS02.01-${party.statementSummaryRecordId}`,
      );
    }
  }
  for (const detail of message.details) {
    if (!partyIds.has(detail.allocatedPartySummaryRecordId)) {
      throw new SdkMalformedInputError(
        `ddex:dangling_reference:RD01.01-${detail.allocatedPartySummaryRecordId}`,
      );
    }
  }

  const footerCells = (lines[lines.length - 1] ?? '').split('\t');
  if (footerCells.length < 4) {
    throw new SdkMalformedInputError('ddex:truncated_footer');
  }
  const expectedCounts: readonly [number, number, string][] = [
    [message.parties.length, Number(footerCells[1] ?? ''), 'NumberOfAllocatedPartySummaryRecords'],
    [message.details.length, Number(footerCells[2] ?? ''), 'NumberOfRevenueDetailsRecords'],
    [lines.length, Number(footerCells[3] ?? ''), 'NumberOfLines'],
  ];
  for (const [actual, declared, cell] of expectedCounts) {
    if (!Number.isInteger(declared) || declared !== actual) {
      throw new SdkMalformedInputError(`ddex:footer_count_mismatch:${cell}`);
    }
  }
}

/** Maps the parsed message onto canonical events, rejecting unmatched rows. */
function buildEvents(message: ParsedRevenueReport): readonly CanonicalRoyaltyEvent[] {
  const firstSummary = message.summaries[0];
  if (firstSummary === undefined) {
    throw new SdkMalformedInputError('ddex:no_revenue_summary_record');
  }
  const currency = firstSummary.currency;
  const events: CanonicalRoyaltyEvent[] = [];
  const seenRecordIds = new Set<string>();

  if (!RDR_TIMESTAMP_PATTERN.test(message.header.createdDateTime)) {
    throw new SdkMalformedInputError(
      `ddex:invalid_timestamp:RHEA.01.MessageCreatedDateTime:${message.header.createdDateTime}`,
    );
  }

  for (const detail of message.details) {
    if (seenRecordIds.has(detail.recordId)) {
      throw new SdkMalformedInputError(`ddex:duplicate_record_id:${detail.recordId}`);
    }
    seenRecordIds.add(detail.recordId);

    const isrc = canonicalizeIdentifier('ISRC', detail.isrcCell);
    if (isrc === null) {
      throw new SdkMalformedInputError(
        detail.isrcCell === ''
          ? `ddex:no_canonical_identifier:${detail.recordId}`
          : `ddex:invalid_isrc:${detail.recordId}`,
      );
    }

    const gross = decimalToMicros(detail.payingMlcGrossAmount);
    if (!gross.ok) {
      throw new SdkMalformedInputError(
        `ddex:${gross.reason === 'negative' ? 'negative' : 'invalid'}_amount:${detail.recordId}`,
      );
    }

    events.push({
      eventId: `${message.header.messageId}-${detail.recordId}`,
      rightsPipeline: 'master_digital_performance',
      source: 'statement',
      statementFormat: 'ddex-rdr',
      period: `${detail.usageStartDate}/${detail.usageEndDate}`,
      currency,
      grossMicros: gross.micros,
      identifiers: { ISRC: isrc },
      platform: null,
      territory: /^[A-Z]{2}$/.test(detail.territoryCell) ? detail.territoryCell : null,
      raw: detail.line,
    });
  }
  return events;
}

/** Parses a DDEX RDR-R RevenueReport statement file into canonical events. */
export function parseDdexRdrStatement(file: StatementFile): readonly CanonicalRoyaltyEvent[] {
  return buildEvents(parseRecords(splitRecordLines(file.content)));
}
