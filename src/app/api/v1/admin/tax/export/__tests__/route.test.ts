/**
 * /api/v1/admin/tax/export contract tests — the tax agent's gated sheet.
 *
 * The gate boundary is REAL (the minted session cookie verifies through
 * the production gate, including its fail-closed states) and the data
 * stores are REAL (the same dev-seeded demo ledger the console reads —
 * never a second data path). The assertions pin the three gate states
 * (503 unset secret, 401 anonymous, preview passwordless under the demo
 * door) and the sheet contract: parseable RFC-4180 CSV, both labeled
 * blocks, every creator and every USD settlement of record, QUOTE_ALL +
 * CRLF throughout.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { GET } from '../route';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { bootDevSeedStore } from '@/lib/server/devSeed';
import { parseCsv } from '@/lib/tax/exportCsv';
import { listLedger } from '@/lib/ledger/store';
import { buildTaxSection } from '@/lib/admin/sectionPayloads';
import { listAssets } from '@/lib/sdk';
import type { LedgerRow } from '@/lib/ledger/store';
import type { ContractRow, SectionData } from '@/components/admin/types';

const PASSWORD = 'test-admin-password-1234';
const ROUTE = '/api/v1/admin/tax/export';

let token: string | undefined;

function exportRequest(): Request {
  return new Request(`http://localhost${ROUTE}`, {
    headers: token ? { cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {},
  });
}

let rows: LedgerRow[];

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
  const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
  await seedAdminDemoDataIfEmpty();
  rows = await listLedger();
});

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  process.env.DON_DEV_SEED = '1';
  token = mintAdminSessionToken()!;
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
});

describe('the tax export gate', () => {
  it('answers 503 admin_not_configured when the secret is unset and the demo door is closed', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    delete process.env.DON_DEV_SEED;
    const res = await GET(exportRequest());
    expect(res.status).toBe(503);
  });

  it('answers 401 for an anonymous request even with the demo door open', async () => {
    token = undefined;
    const res = await GET(exportRequest());
    expect(res.status).toBe(401);
  });

  it('serves the sheet passwordless under the J1 preview carve-out (demo door open, no secret)', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
  });
});

describe('the tax export sheet', () => {
  it('streams RFC-4180 CSV with the download headers and the composed blocks', async () => {
    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const csv = await res.text();
    const parsed = parseCsv(csv);
    const flat = parsed.flat();

    // Both blocks present, in order.
    const annualAt = flat.indexOf('PER-PAYEE ANNUAL SUMMARY');
    const registerAt = flat.indexOf('PER-TRANSACTION REGISTER');
    expect(annualAt).toBeGreaterThanOrEqual(0);
    expect(registerAt).toBeGreaterThan(annualAt);

    // The sheet reflects the SAME composed section the Tax tab renders —
    // every creator and every USD settlement of record appears.
    const assets = await listAssets();
    const contracts: SectionData<ContractRow[]> = { kind: 'ready', value: [] };
    const tax = buildTaxSection(rows, assets, contracts);
    for (const payee of tax.payees) {
      expect(flat).toContain(payee.payeeName);
    }
    for (const row of tax.transactions) {
      expect(flat).toContain(row.transactionId);
      expect(flat).toContain(row.cbt);
    }

    // QUOTE_ALL + CRLF.
    for (const line of csv.split('\r\n')) {
      if (line === '') continue;
      expect(line.startsWith('"'), `quoted: ${line.slice(0, 40)}`).toBe(true);
      expect(line.endsWith('"'), `quoted end: ${line.slice(-40)}`).toBe(true);
    }
  });
});
