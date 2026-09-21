/**
 * GET /api/v1/admin/tax/export — the tax agent's CSV export (founder
 * directive, 2026-09-21: "the tax agents job is easier and we are in
 * compliance").
 *
 * GATED: the same admin gate as the /admin console — the signed session
 * cookie is verified before any data is touched (an unset
 * ADMIN_DASHBOARD_PASSWORD with DON_DEV_SEED=1 is the J1 passwordless
 * preview carve-out; a real deployment stays fail-closed, answering 503
 * admin_not_configured / 401 admin_not_authenticated with no data).
 *
 * The payload is the /admin Tax tab's composer verbatim —
 * buildTaxSection over the same store reads — so the sheet and the tab
 * can never disagree. The CSV is composed by src/lib/tax/exportCsv:
 * QUOTE_ALL fields, CRLF line endings, and two labeled blocks (the
 * per-payee annual summary for EVERY creator of record, then the
 * CBT-stamped per-transaction register with the founder engine's
 * resolution columns). Served as a download attachment.
 */

import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { checkAdminGate } from '@/lib/admin/gate';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { buildTaxSection } from '@/lib/admin/sectionPayloads';
import { listContracts } from '@/lib/contracts/store';
import { buildTaxExportCsv } from '@/lib/tax/exportCsv';
import type { ContractRow, SectionData } from '@/components/admin/types';

export const dynamic = 'force-dynamic';

/**
 * listContracts throws on a store read failure (its documented contract) —
 * the export degrades the template-binding join to the honest unavailable
 * state rather than failing the whole sheet, exactly like the console.
 */
async function safeContractRows(): Promise<SectionData<ContractRow[]>> {
  try {
    const rows = await listContracts();
    return {
      kind: 'ready',
      value: rows.map((contract) => ({
        id: contract.id,
        cbtCode: contract.cbtCode,
        templateId: contract.templateId,
        industry: contract.industry,
        status: contract.status,
        createdAt: new Date(contract.createdAt).toISOString(),
        updatedAt: new Date(contract.updatedAt).toISOString(),
      })),
    };
  } catch {
    return {
      kind: 'unavailable',
      code: 'contract_store_failed',
      message: 'Contract store read failed.',
    };
  }
}

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) {
    return Response.json(
      { ok: false, code: gate.code, message: gate.message },
      { status: gate.status },
    );
  }

  // The demo door — the same idempotent seed the console runs, so the sheet
  // carries the same settlements as the Tax tab (never a second data path).
  await seedAdminDemoDataIfEmpty();

  const [ledgerRows, assets, contracts] = await Promise.all([
    listLedger(),
    listAssets(),
    safeContractRows(),
  ]);
  const tax = buildTaxSection(ledgerRows, assets, contracts);
  const csv = buildTaxExportCsv(tax);

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="covnant-tax-sheet.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
