/**
 * CVT recon worker — deterministic delimited-text tokenizer.
 *
 * RFC 4180 quote discipline with a configurable delimiter (comma for the
 * CSV profiles, tab for TSV), generalized from the SDK CSV parser's
 * tokenizer (covnant-sdk/src/parsers/csv/csv-statement-parser.ts) — same
 * quoting rules, same whole-file rejection posture, extended to tabs and to
 * the adjustment (negative) money cells the SDK's canonical event forbids
 * but a distributor statement legitimately carries.
 */

import { decimalToMicros } from "../../../covnant-sdk/src/parsers/money";
import { StatementParseError } from "./records";

/** Parses one record's text into its field list (quote-aware). */
function parseRecord(text: string, delimiter: string): readonly string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let quotedCellClosed = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          // RFC 4180 escaped quote — "" inside a quoted field is one '"'.
          current += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        quotedCellClosed = true;
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (quotedCellClosed && char !== delimiter) {
      // Only a delimiter may follow a quoted cell's closing quote.
      throw new StatementParseError("invalid_quoting");
    }
    if (char === '"') {
      if (current === "") {
        inQuotes = true;
        index += 1;
        continue;
      }
      throw new StatementParseError("invalid_quoting");
    }
    if (char === delimiter) {
      fields.push(current);
      current = "";
      quotedCellClosed = false;
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (inQuotes) throw new StatementParseError("unterminated_quote");
  fields.push(current);
  return fields;
}

/**
 * Splits the file into records — trailing blank record dropped, empty files
 * a rejection (never a zero-line "success"). Records are located by a
 * scanner that shares parseRecord's escape discipline ("" never toggles),
 * then parsed BY parseRecord — one quote opinion for the whole file.
 */
export function parseDelimitedRows(
  content: string,
  delimiter: string,
): readonly (readonly string[])[] {
  if (content.trim() === "") {
    throw new StatementParseError("empty_statement_file");
  }
  const rows: string[][] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const end = findRecordEnd(content, cursor);
    rows.push([...parseRecord(content.slice(cursor, end), delimiter)]);
    cursor = end;
    if (content[cursor] === "\r") cursor += content[cursor + 1] === "\n" ? 2 : 1;
    else if (content[cursor] === "\n") cursor += 1;
  }
  const last = rows[rows.length - 1];
  if (last !== undefined && last.length === 1 && last[0] === "") rows.pop();
  return rows;
}

/** Trims the header row's cells and compares — one order, no extra columns. */
export function headerMatches(rows: readonly (readonly string[])[], header: readonly string[]): boolean {
  const first = rows[0];
  if (first === undefined || first.length !== header.length) return false;
  return header.every((column, index) => first[index] === column);
}

/**
 * Turns the file into header-keyed cell maps. The header must match the
 * profile exactly (order + columns) — a profile that flexes to sender
 * layouts is a profile nobody can trust.
 */
export function readStrictTable(
  content: string,
  delimiter: string,
  header: readonly string[],
): readonly ReadonlyMap<string, string>[] {
  const rows = parseDelimitedRows(content, delimiter);
  const first = rows[0];
  if (first === undefined || !headerMatches(rows, header)) {
    throw new StatementParseError("header_mismatch");
  }
  return rows.slice(1).map((row) => {
    const values = new Map<string, string>(
      header.map((column, index) => [column, row[index] ?? ""]),
    );
    // A short row silently maps missing trailing cells to "" — reject it so
    // a mangled file can never half-parse.
    if (row.length !== header.length) {
      throw new StatementParseError("column_count_mismatch");
    }
    return values;
  });
}

/**
 * Strips sender-side cosmetic formatting before the strict conversion: a
 * leading currency symbol and US/UK thousands grouping. The grouping strip
 * only fires when every group after the first is exactly 3 digits —
 * "1,234.56" → "1234.56", but a European decimal comma ("1,50") survives
 * and the strict converter REJECTS it rather than misparsing it as 150.
 * A sign before the symbol (a "-$5.00" cell) is likewise rejected —
 * ambiguous cells are never guessed into a magnitude.
 */
function normalizeStatementNumber(cell: string): string {
  const withoutSymbol = cell.trim().replace(/^[$€£¥]/, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(withoutSymbol)) {
    return withoutSymbol.replaceAll(",", "");
  }
  return withoutSymbol;
}

/**
 * Statement money: sender formatting (leading currency symbol, US/UK
 * thousands grouping) is normalized away, then the magnitude converts
 * through the SDK's decimalToMicros — still the single strict converter.
 * Negative amounts are real (refunds, store-fee clawbacks); the sign is
 * applied after conversion, so the fixed-point discipline holds.
 */
export function parseStatementMoney(cell: string): { micros: bigint; negative: boolean } {
  const normalized = normalizeStatementNumber(cell);
  const negative = normalized.startsWith("-");
  const magnitude = decimalToMicros(negative ? normalized.slice(1) : normalized);
  if (!magnitude.ok) {
    throw new StatementParseError(
      magnitude.reason === "negative" ? "negative_amount" : "invalid_amount",
    );
  }
  return { micros: negative ? -magnitude.micros : magnitude.micros, negative };
}

/** BPS rate cell — whole basis points (two decimals = 100 bps), bounded. */
export function parseBpsCell(cell: string): number {
  if (!/^\d{1,5}$/.test(cell)) {
    throw new StatementParseError("invalid_bps");
  }
  const bps = Number(cell);
  if (bps > 10000) {
    throw new StatementParseError("invalid_bps");
  }
  return bps;
}

/** Non-empty cell → trimmed string; empty → null. */
export function optionalCell(values: ReadonlyMap<string, string>, column: string): string | null {
  const cell = values.get(column) ?? "";
  const trimmed = cell.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Header-only probe for profile dispatch — parses just the first record
 * (quote-aware) and compares it against the profile's exact header. Never
 * throws: a mangled first row simply does not match.
 */
export function sniffHeaderMatches(
  content: string,
  delimiter: string,
  header: readonly string[],
): boolean {
  if (content.trim() === "") return false;
  const firstLineEnd = findRecordEnd(content, 0);
  try {
    const record = parseRecord(content.slice(0, firstLineEnd), delimiter);
    return (
      record.length === header.length &&
      header.every((column, index) => record[index] === column)
    );
  } catch {
    return false;
  }
}

/**
 * Finds the offset where the record starting at `start` ends — the first
 * newline outside quotes. Shares parseRecord's escape discipline ("" inside
 * quotes never toggles), so well-formed files split exactly where the
 * record parser would close its fields; a mangled record still locates a
 * boundary and lets parseRecord name the precise reason.
 */
function findRecordEnd(content: string, start: number): number {
  let inQuotes = false;
  let index = start;
  while (index < content.length) {
    const char = content[index];
    if (char === '"') {
      if (inQuotes && content[index + 1] === '"') {
        index += 2;
        continue;
      }
      inQuotes = !inQuotes;
      index += 1;
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      return index;
    }
    index += 1;
  }
  return index;
}

/** Required cell — empty is a row-scoped rejection, never a null guess. */
export function requiredCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = (values.get(column) ?? "").trim();
  if (cell === "") {
    throw new StatementParseError(`missing_column:${column}:row_${rowNumber}`);
  }
  return cell;
}
