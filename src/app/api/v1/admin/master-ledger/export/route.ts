/**
 * GET /api/v1/admin/master-ledger/export — the admin master ledger's CSV
 * sheet (data audit #7: the ledger data behind every master admin surface
 * could only be eyeballed in the console).
 *
 * GATED: the same admin gate as the /admin console — the signed session
 * cookie is verified before any data is touched (fail-closed: 503
 * admin_not_configured with an unset ADMIN_DASHBOARD_PASSWORD, 401
 * admin_not_authenticated without a valid session; neither failure
 * carries data). READ-ONLY: the route CONSUMES resolveMasterLedger() —
 * the exact derivation the /admin Master Data tab renders, PR #155's
 * real-mode vertical mapping included — and modifies nothing.
 *
 * The sheet is composed by src/lib/master/exportCsv: QUOTE_ALL fields,
 * CRLF line endings, a scope-disclosure preamble (the honesty law), and
 * one row per sovereign record in derivation order, rendered through the
 * tab's own money formatter and the canon vertical labels. Served as a
 * download attachment with a dated filename.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { resolveMasterLedger } from '@/lib/master/masterStore';
import {
  buildMasterLedgerExportCsv,
  masterLedgerExportFilename,
} from '@/lib/master/exportCsv';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) {
    return Response.json(
      { ok: false, code: gate.code, message: gate.message },
      { status: gate.status },
    );
  }

  // The demo door — the same idempotent seed the console runs before its
  // reads, so the sheet carries the same ledger as the Master Data tab
  // (never a second data path).
  await seedAdminDemoDataIfEmpty();

  const { demo, records } = await resolveMasterLedger();
  const csv = buildMasterLedgerExportCsv(demo, records);

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${masterLedgerExportFilename()}"`,
      'Cache-Control': 'no-store',
    },
  });
}
