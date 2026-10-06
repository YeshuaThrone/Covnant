/**
 * RFC-4180 CSV composer for the admin master ledger's export sheet
 * (GET /api/v1/admin/master-ledger/export). Same posture as the tax
 * agent's sheet (src/lib/tax/exportCsv.ts): QUOTE_ALL fields, CRLF line
 * endings, a scope-disclosure preamble, then one row per sovereign
 * record in derivation order — the SAME records the /admin Master Data
 * tab renders (resolveMasterLedger, PR #155's vertical mapping included),
 * so the sheet and the tab can never disagree. Money renders through the
 * tab's own formatter (lib/money/format's formatCents); verticals carry
 * the canon labels (MASTER_CATEGORY_LABELS). Pure: no store, no clock,
 * no I/O.
 */

import { formatCents } from '@/lib/money/format';
import type { SovereignLedgerRecord } from './sovereignLedger';
import { MASTER_CATEGORY_LABELS } from './taxonomy';

/** One CSV field: always quoted, embedded quotes doubled (RFC-4180). */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** One CSV record: QUOTE_ALL fields joined by commas, closed with CRLF. */
function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

/** The data block's header row — the stable column order of the export. */
export const MASTER_CSV_HEADER: readonly string[] = [
  'Ledger ID',
  'Vertical',
  'Subcategory',
  'Asset title',
  'Rights holder',
  'Gross volume',
  'Ownership reserve (50%)',
  'Creative royalty (35%)',
  'Production operations (15%)',
  'Clearinghouse',
  'Settled',
];

/**
 * The dated download filename — covnant-master-ledger-YYYY-MM-DD.csv.
 * Pure in `now`; the route passes nothing for today (UTC).
 */
export function masterLedgerExportFilename(now: Date = new Date()): string {
  return `covnant-master-ledger-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * Compose the master ledger sheet: the scope disclosure first (the
 * honesty law — DEMO data says so), then the header row, then every
 * record in derivation order. QUOTE_ALL + CRLF throughout.
 */
export function buildMasterLedgerExportCsv(
  demo: boolean,
  records: readonly SovereignLedgerRecord[],
): string {
  const lines: string[] = [];
  lines.push(csvRow(['Covnant Master Ledger Export']));
  lines.push(csvRow(['Data scope', demo ? 'Demo data' : 'Settled ledger data']));
  lines.push('\r\n');
  lines.push(csvRow(MASTER_CSV_HEADER));
  for (const record of records) {
    lines.push(
      csvRow([
        record.ledgerId,
        MASTER_CATEGORY_LABELS[record.category],
        record.subcategory,
        record.assetTitle,
        record.rightsHolderHash,
        formatCents(record.grossVolumeCents),
        formatCents(record.allocations.ownershipReserveCents),
        formatCents(record.allocations.creativeRoyaltyCents),
        formatCents(record.allocations.productionOperationsCents),
        record.clearinghouseStatus,
        record.settlementTimestamp,
      ]),
    );
  }
  return lines.join('');
}
