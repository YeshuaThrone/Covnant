/**
 * /api/v1/admin/master-ledger/export contract tests — the master ledger's
 * gated sheet.
 *
 * The gate boundary is REAL (the minted session cookie verifies through
 * the production gate, including its fail-closed states) and the data is
 * REAL (resolveMasterLedger — the same derivation the /admin Master Data
 * tab renders). The assertions pin the three gate states (503 unset
 * secret, 401 anonymous, preview passwordless under the demo door) and
 * the sheet contract: parseable RFC-4180 CSV, scope disclosure, header +
 * rows equal to an INDEPENDENTLY reconstructed rendering of the
 * derivation (column order, labels, money voice), QUOTE_ALL + CRLF
 * throughout, and escaping of embedded commas/quotes/newlines in asset
 * titles. Content-Disposition carries the dated download filename.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { GET } from '../route';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { bootDevSeedStore } from '@/lib/server/devSeed';
import { resolveMasterLedger } from '@/lib/master/masterStore';
import { settleSovereignRecord } from '@/lib/master/sovereignLedger';
import { MASTER_CATEGORY_LABELS } from '@/lib/master/taxonomy';
import {
  buildMasterLedgerExportCsv,
  masterLedgerExportFilename,
} from '@/lib/master/exportCsv';
import { formatCents } from '@/lib/money/format';
import { parseCsv } from '@/lib/tax/exportCsv';

const PASSWORD = 'test-admin-password-1234';
const ROUTE = '/api/v1/admin/master-ledger/export';

let token: string | undefined;

function exportRequest(): Request {
  return new Request(`http://localhost${ROUTE}`, {
    headers: token ? { cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {},
  });
}

/**
 * parseCsv keeps the composer's blank block separator as an [''] row —
 * dropped here so the assertions read the semantic rows only.
 */
function semanticRows(csv: string): string[][] {
  return parseCsv(csv).filter((row) => row.length > 1 || (row.length === 1 && row[0] !== ''));
}

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
  await seedAdminDemoDataIfEmpty();
});

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  process.env.DON_DEV_SEED = '1';
  token = mintAdminSessionToken()!;
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
});

describe('the master ledger export gate', () => {
  it('answers 503 admin_not_configured when the secret is unset and the demo door is closed', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    delete process.env.DON_DEV_SEED;
    const res = await GET(exportRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      code: 'admin_not_configured',
      message: 'Admin dashboard is not configured.',
    });
  });

  it('answers 401 admin_not_authenticated for an anonymous request even with the demo door open', async () => {
    token = undefined;
    const res = await GET(exportRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      code: 'admin_not_authenticated',
      message: 'Admin sign-in required.',
    });
  });

  it('answers 401 for a present-but-invalid session cookie (never the data)', async () => {
    token = '9999999999999.deadbeef';
    const res = await GET(exportRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('serves the sheet passwordless under the J1 preview carve-out (demo door open, no secret)', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
  });
});

describe('the master ledger export sheet', () => {
  it('streams CSV with the download headers and a dated filename', async () => {
    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="covnant-master-ledger-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
  });

  it('carries the derivation verbatim — scope disclosure, stable columns, every record in derivation order', async () => {
    const { demo, records } = await resolveMasterLedger();
    expect(records.length).toBeGreaterThan(0);

    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    const csv = await res.text();
    const rows = semanticRows(csv);

    // Preamble: the sheet title, then the scope disclosure (the honesty
    // law — DEMO data says so, exactly as the tab does).
    expect(rows[0]).toEqual(['Covnant Master Ledger Export']);
    expect(rows[1]).toEqual(['Data scope', demo ? 'Demo data' : 'Settled ledger data']);

    // Header + data block: reconstructed INDEPENDENTLY from the records —
    // column order, canon vertical labels, the tab's money voice, and the
    // derivation's row order are all pinned, cell for cell.
    const expectedHeader = [
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
    const expectedRows = records.map((record) => [
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
    ]);
    expect(rows.slice(2)).toEqual([expectedHeader, ...expectedRows]);

    // QUOTE_ALL + CRLF: every line opens and closes with a quote.
    for (const line of csv.split('\r\n')) {
      if (line === '') continue;
      expect(line.startsWith('"'), `quoted start: ${line.slice(0, 40)}`).toBe(true);
      expect(line.endsWith('"'), `quoted end: ${line.slice(-40)}`).toBe(true);
    }
  });
});

describe('the master ledger export composer (RFC-4180 escaping)', () => {
  it('escapes embedded commas, doubled quotes, and newlines in an asset title', () => {
    const gnarlyTitle = 'Midnight Manuscript, "Annotated" Edition\nVol. II';
    const record = settleSovereignRecord({
      category: 'PUBLISHING_AND_LITERARY',
      subcategory: 'Print Books',
      assetTitle: gnarlyTitle,
      rightsHolderKey: 'holder-escaping-edge',
      grossVolumeCents: 12_345,
      clearinghouseStatus: 'ACTIVE_YIELD',
      settlementTimestamp: '2026-10-06T00:00:00.000Z',
      sequence: 9,
    });

    const csv = buildMasterLedgerExportCsv(false, [record]);

    // The doubled-quote escape is physically present, QUOTE_ALL holds.
    expect(csv).toContain('""Annotated""');
    for (const line of csv.split('\r\n')) {
      if (line === '') continue;
      expect(line.startsWith('"'), `quoted start: ${line.slice(0, 40)}`).toBe(true);
    }

    // Round-trip: the title's comma, quotes, and newline land INSIDE the
    // quoted field — the newline must not terminate the row, so the sheet
    // parses back to exactly title, scope, header, and ONE data row whose
    // title cell equals the original verbatim.
    const rows = semanticRows(csv);
    expect(rows).toEqual([
      ['Covnant Master Ledger Export'],
      ['Data scope', 'Settled ledger data'],
      [
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
      ],
      [
        record.ledgerId,
        'Publishing & Literary',
        'Print Books',
        gnarlyTitle,
        record.rightsHolderHash,
        '$123.45',
        '$61.72',
        '$43.20',
        '$18.51',
        'ACTIVE_YIELD',
        '2026-10-06T00:00:00.000Z',
      ],
    ]);
  });

  it('names the download file by UTC day', () => {
    expect(masterLedgerExportFilename(new Date('2026-10-06T00:00:00.000Z'))).toBe(
      'covnant-master-ledger-2026-10-06.csv',
    );
    expect(masterLedgerExportFilename(new Date('2026-01-01T23:30:00.000Z'))).toBe(
      'covnant-master-ledger-2026-01-01.csv',
    );
  });
});
