/**
 * RFC-4180 CSV composer for the tax agent's sheet (founder directive,
 * 2026-09-21). Every field double-quoted (QUOTE_ALL), CRLF line endings,
 * and two labeled blocks in order: the per-payee annual summary (every
 * creator of record, every year), then the CBT-stamped per-transaction
 * register. The transaction block carries the founder engine's resolution
 * columns per transaction — withholding, state tax, net clearing payout,
 * effective rate, form triggered, and the tax-escrow lock state — beside
 * the ledger layer's own figures, so the agent files from one sheet with
 * both layers of record in view. Pure: no store, no clock, no I/O.
 */

import type { TaxSectionData } from '@/components/admin/types';

/** One CSV field: always quoted, embedded quotes doubled (RFC-4180). */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** One CSV record: QUOTE_ALL fields joined by commas, closed with CRLF. */
function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

/** Minor units → plain decimal string, no thousands grouping (ledger layer). */
export function minorToPlain(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** USD cents → plain decimal string, no thousands grouping (engine layer). */
export function centsToPlain(cents: bigint): string {
  return minorToPlain(cents, 2);
}

/** Combined effective rate as a percent string (the agent reads percentages). */
export function rateToPlain(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/** The per-payee annual summary block's header row. */
export const TAX_CSV_ANNUAL_HEADER: readonly string[] = [
  'Tax year',
  'UCT ID',
  'Payee',
  'ISNI',
  'IPI',
  'Jurisdiction',
  'TIN status',
  'Form',
  'Transactions',
  'Gross paid',
  'Withheld',
  'Net',
  'Engine withholding',
  'Engine state tax',
  'Engine net clearing payout',
  'Effective rate',
  'Lock state',
  'Lock reason',
];

/** The per-transaction register block's header row. */
export const TAX_CSV_TRANSACTION_HEADER: readonly string[] = [
  'Date',
  'Transaction',
  'CBT',
  'CVT',
  'Entity type',
  'Template',
  'Payees',
  'Gross',
  'Covenant fee',
  'Corner dust',
  'Ledger withholding',
  'Ledger net',
  'Engine withholding',
  'Engine state tax',
  'Engine net clearing payout',
  'Effective rate',
  'Form',
  'Lock state',
  'Lock reason',
];

/** Compose the tax agent's sheet: labeled blocks, QUOTE_ALL, CRLF throughout. */
export function buildTaxExportCsv(tax: TaxSectionData): string {
  const lines: string[] = [];
  lines.push(csvRow(['Covnant Tax Data Sheet']));
  lines.push(csvRow(['Data scope', tax.demo ? 'Demo data' : 'Settled ledger data']));
  lines.push('\r\n');

  lines.push(csvRow(['PER-PAYEE ANNUAL SUMMARY']));
  lines.push(csvRow(TAX_CSV_ANNUAL_HEADER));
  for (const row of tax.annual) {
    lines.push(
      csvRow([
        String(row.year),
        row.uctId ?? 'Not on file',
        row.payeeName,
        row.isni ?? 'Not on file',
        row.ipi ?? 'Not on file',
        row.jurisdiction ?? 'Not on file',
        row.tinStatus,
        row.forms.join(' | '),
        String(row.transactionCount),
        minorToPlain(row.grossMinor, 4),
        minorToPlain(row.withheldMinor, 4),
        minorToPlain(row.netMinor, 4),
        centsToPlain(row.engine.withheldCents),
        centsToPlain(row.engine.stateTaxCents),
        centsToPlain(row.engine.netCents),
        rateToPlain(row.effectiveRate),
        row.lockState,
        row.lockReason ?? '',
      ]),
    );
  }
  lines.push('\r\n');

  lines.push(csvRow(['PER-TRANSACTION REGISTER']));
  lines.push(csvRow(TAX_CSV_TRANSACTION_HEADER));
  for (const row of tax.transactions) {
    lines.push(
      csvRow([
        row.date.slice(0, 10),
        row.transactionId,
        row.cbt,
        row.cvt,
        row.entityType ?? row.cbt.split('-')[1] ?? row.cbt,
        row.template ?? 'Unbound',
        String(row.payeeCount),
        minorToPlain(row.grossMinor, 4),
        minorToPlain(row.feeMinor, 4),
        minorToPlain(row.dustMinor, 4),
        minorToPlain(row.withheldMinor, 4),
        minorToPlain(row.netMinor, 4),
        centsToPlain(row.engine.withheldCents),
        centsToPlain(row.engine.stateTaxCents),
        centsToPlain(row.engine.netCents),
        rateToPlain(row.effectiveRate),
        row.forms.join(' | '),
        row.lockState,
        row.lockReason ?? '',
      ]),
    );
  }
  return lines.join('');
}


/**
 * Parse an RFC-4180 CSV — the verification instrument for this module's
 * own output (the route tests and the export gate parse the sheet back
 * and compare). Handles quoted fields, doubled-quote escapes, CRLF and
 * LF terminators, and a trailing final terminator. Pure — no I/O.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  // A trailing terminator ends the last row inside the loop; a final
  // unterminated row (or empty last field) still lands.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
