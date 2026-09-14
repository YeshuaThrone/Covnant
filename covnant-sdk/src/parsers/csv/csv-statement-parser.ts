/**
 * CSV statement parser — the SDK's own documented CSV statement profile.
 *
 * Findings §D6: no industry CSV royalty standard exists; every sender ships
 * a different CSV layout. The SDK therefore defines ONE strict profile and
 * accepts only files that match it exactly — the alternative (a permissive
 * guesser) is exactly the silent-misparse behavior this package exists to
 * prevent. The profile:
 *
 * RFC 4180 encoding — comma separated, optional quoting with `""` escapes,
 * CRLF or LF record endings. Header row REQUIRED, exactly:
 *
 *     event_id,rights_pipeline,period,currency,gross_amount,territory,platform,isrc,iswc
 *
 * - extra, missing or reordered columns are rejections — a profile that
 *   flexes to sender layouts is a profile nobody can trust;
 * - `event_id`, `rights_pipeline`, `currency`, `gross_amount` are required
 *   per row; `period`, `territory`, `platform`, `isrc`, `iswc` are optional
 *   (empty → null);
 * - `rights_pipeline` must be one of the four canonical pipelines — the
 *   statement itself declares which rights pipeline its revenue belongs to,
 *   because no CSV standard exists to dictate one;
 * - `gross_amount` is a plain decimal string with at most 8 fractional
 *   digits, converted EXACTLY to 1e-8 micros (see ../money); negatives are
 *   rejected — gross adjustments are out of profile v1;
 * - `isrc`/`iswc` are canonicalised through the identifier registry; every
 *   row must carry at least one canonical identifier (the matcher's
 *   exact-match rule) or the file is rejected;
 * - `event_id` values must be unique within the file — duplicate rows would
 *   double-credit downstream, so they are a rejection;
 * - `raw` is the row's verbatim field list.
 *
 * All rejections are typed `SdkMalformedInputError` reasons, prefixed
 * `csv:` and row-scoped (`:row_N`, 1-based including the header).
 */

import { canonicalizeIdentifier } from '../../contracts/identifiers';
import { RIGHTS_PIPELINES } from '../../contracts/royalty-event';
import type { CanonicalRoyaltyEvent } from '../../contracts/royalty-event';
import type { StatementFile } from '../../nodes/collection-node';
import { SdkMalformedInputError } from '../../nodes/errors';
import { decimalToMicros } from '../money';

/** The profile's exact header — one order, no extra columns. */
const CSV_HEADER: readonly string[] = [
  'event_id',
  'rights_pipeline',
  'period',
  'currency',
  'gross_amount',
  'territory',
  'platform',
  'isrc',
  'iswc',
];

/** Columns required on every data row (empty cells → rejection). */
const REQUIRED_COLUMNS: readonly string[] = [
  'event_id',
  'rights_pipeline',
  'currency',
  'gross_amount',
];

/** Two-letter ISO 3166-1 alpha-2 territory, or empty for null. */
const TERRITORY_PATTERN = /^[A-Z]{2}$/;

/** Parses one RFC 4180 record's text into its field list. */
function parseCsvRecord(text: string): readonly string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          current += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      if (current === '') {
        inQuotes = true;
        index += 1;
        continue;
      }
      throw new SdkMalformedInputError('csv:invalid_quoting');
    }
    if (char === ',') {
      fields.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (inQuotes) throw new SdkMalformedInputError('csv:unterminated_quote');
  fields.push(current);
  return fields;
}

/** Parses the file into records (quote-aware line splitting). */
function parseCsvRows(content: string): readonly (readonly string[])[] {
  if (content === '') {
    throw new SdkMalformedInputError('csv:empty_statement_file');
  }
  const rows: Array<readonly string[]> = [];
  let current = '';
  let inQuotes = false;
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      index += 1;
      continue;
    }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      rows.push(parseCsvRecord(current));
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (inQuotes) throw new SdkMalformedInputError('csv:unterminated_quote');
  rows.push(parseCsvRecord(current));
  const last = rows[rows.length - 1];
  if (last !== undefined && last.length === 1 && last[0] === '') rows.pop();
  return rows;
}

/** Validates one data row and maps it onto a canonical event. */
function buildEvent(row: readonly string[], rowNumber: number): CanonicalRoyaltyEvent {
  const values = new Map<string, string>(
    CSV_HEADER.map((column, index) => [column, row[index] ?? '']),
  );

  for (const column of REQUIRED_COLUMNS) {
    if (values.get(column) === '') {
      throw new SdkMalformedInputError(`csv:missing_column:${column}:row_${rowNumber}`);
    }
  }

  const eventId = values.get('event_id') ?? '';
  if (eventId.length > 512) {
    throw new SdkMalformedInputError(`csv:event_id_too_long:row_${rowNumber}`);
  }

  const pipeline = values.get('rights_pipeline') ?? '';
  if (!RIGHTS_PIPELINES.includes(pipeline as CanonicalRoyaltyEvent['rightsPipeline'])) {
    throw new SdkMalformedInputError(
      `csv:invalid_rights_pipeline:${pipeline}:row_${rowNumber}`,
    );
  }

  const currency = values.get('currency') ?? '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new SdkMalformedInputError(`csv:invalid_currency:${currency}:row_${rowNumber}`);
  }

  const gross = decimalToMicros(values.get('gross_amount') ?? '');
  if (!gross.ok) {
    throw new SdkMalformedInputError(
      `csv:${gross.reason === 'negative' ? 'negative' : 'invalid'}_amount:row_${rowNumber}`,
    );
  }

  const identifiers: CanonicalRoyaltyEvent['identifiers'] = {};
  const isrc = values.get('isrc') ?? '';
  if (isrc !== '') {
    const canonical = canonicalizeIdentifier('ISRC', isrc);
    if (canonical === null) {
      throw new SdkMalformedInputError(`csv:invalid_isrc:row_${rowNumber}`);
    }
    identifiers.ISRC = canonical;
  }
  const iswc = values.get('iswc') ?? '';
  if (iswc !== '') {
    const canonical = canonicalizeIdentifier('ISWC', iswc);
    if (canonical === null) {
      throw new SdkMalformedInputError(`csv:invalid_iswc:row_${rowNumber}`);
    }
    identifiers.ISWC = canonical;
  }
  if (Object.keys(identifiers).length === 0) {
    throw new SdkMalformedInputError(`csv:no_canonical_identifier:row_${rowNumber}`);
  }

  const territory = values.get('territory') ?? '';
  const platform = values.get('platform') ?? '';
  const period = values.get('period') ?? '';
  if (platform.length > 128) {
    throw new SdkMalformedInputError(`csv:platform_too_long:row_${rowNumber}`);
  }

  return {
    eventId,
    rightsPipeline: pipeline as CanonicalRoyaltyEvent['rightsPipeline'],
    source: 'statement',
    statementFormat: 'csv',
    period: period === '' ? null : period,
    currency,
    grossMicros: gross.micros,
    identifiers,
    platform: platform === '' ? null : platform,
    territory:
      territory === '' ? null : TERRITORY_PATTERN.test(territory) ? territory : null,
    raw: [...row],
  };
}

/** Parses an SDK-profile CSV statement file into canonical events. */
export function parseCsvStatement(file: StatementFile): readonly CanonicalRoyaltyEvent[] {
  const rows = parseCsvRows(file.content);
  if (rows.length === 0) {
    throw new SdkMalformedInputError('csv:empty_statement_file');
  }
  const header = rows[0] ?? [];
  if (header.length !== CSV_HEADER.length || !CSV_HEADER.every((name, i) => name === header[i])) {
    throw new SdkMalformedInputError('csv:invalid_header');
  }
  if (rows.length === 1) {
    throw new SdkMalformedInputError('csv:empty_statement_rows');
  }

  const events: CanonicalRoyaltyEvent[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (row.length !== CSV_HEADER.length) {
      throw new SdkMalformedInputError(`csv:invalid_column_count:${row.length}:row_${i + 1}`);
    }
    const event = buildEvent(row, i + 1);
    if (seen.has(event.eventId)) {
      throw new SdkMalformedInputError(`csv:duplicate_event_id:${event.eventId}`);
    }
    seen.add(event.eventId);
    events.push(event);
  }
  return events;
}
