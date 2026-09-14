/**
 * Statement-parser framework — the single entry point that turns a statement
 * file into canonical royalty events, dispatched on the file's format tag.
 *
 * The SDK accepts statements in exactly the formats of the canonical contract:
 *
 * - `ddex-rdr` — a DDEX RDR-R RevenueReport (real published DDEX format);
 * - `cwr`      — a CISAC CWR 2.1 work-registration file (real published CISAC
 *   Common Works Registration format);
 * - `csv`      — the SDK's own documented CSV statement profile (no industry
 *   CSV standard exists — findings §D6 — so the profile lives in code and is
 *   tested against golden fixtures).
 *
 * Every parser is pure and fail-closed: well-formed input yields events, any
 * structural or value-level deviation yields `SdkMalformedInputError` and —
 * because the parsers write nothing — ZERO partial writes. Provenance is
 * recorded separately by the ingest wrapper (./ingest) through the Store's
 * statement_ingests methods.
 *
 * Events a parser constructs are re-validated through the canonical contract
 * (`parseCanonicalRoyaltyEvent`) before they leave the framework, so a
 * construction drift inside any parser surfaces as the contract's typed
 * error, not as a malformed event downstream.
 */

import {
  STATEMENT_FORMATS,
  parseCanonicalRoyaltyEvent,
  type CanonicalRoyaltyEvent,
  type StatementFormat,
} from '../contracts/royalty-event';
import type { StatementFile } from '../nodes/collection-node';
import { SdkMalformedInputError } from '../nodes/errors';
import { parseCwrStatement } from './cwr/cwr-parser';
import { parseCsvStatement } from './csv/csv-statement-parser';
import { parseDdexRdrStatement } from './ddex/ddex-rdr-parser';

/** A statement parser for one format: pure file → events. */
export type StatementParser = (file: StatementFile) => readonly CanonicalRoyaltyEvent[];

/** Statement formats accepted by the framework, one parser each. */
const PARSERS_BY_FORMAT: Readonly<Record<StatementFormat, StatementParser>> = {
  'ddex-rdr': parseDdexRdrStatement,
  cwr: parseCwrStatement,
  csv: parseCsvStatement,
};

/** The one statement-parser entry point: dispatch by format, fully validated. */
export function parseStatementFile(file: StatementFile): readonly CanonicalRoyaltyEvent[] {
  const parser = getStatementParser(file.format);
  const events = parser(file);
  for (const event of events) {
    const parsed = parseCanonicalRoyaltyEvent(event as unknown as Record<string, unknown>);
    if (!parsed.ok) {
      throw new SdkMalformedInputError(
        `internal_parser_contract_violation:${event.eventId}:${parsed.reason}`,
      );
    }
  }
  return events;
}

/**
 * Resolves the parser for a format tag. An unparseable tag (runtime input to
 * the typed surface) is a typed malformed-input rejection, not a TypeError.
 */
export function getStatementParser(format: string): StatementParser {
  if (!STATEMENT_FORMATS.includes(format as StatementFormat)) {
    throw new SdkMalformedInputError(`invalid_statement_file_format:${format}`);
  }
  return PARSERS_BY_FORMAT[format as StatementFormat];
}
