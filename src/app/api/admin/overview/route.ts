/**
 * GET /api/admin/overview — one gated summary for the console's landing
 * view: the UCT rights-holders registry (provisioning status ONLY — never
 * account or routing numbers), royalty-ledger totals via the ledger store's
 * existing read helpers, contracts, and platform allowlists.
 *
 * READS ONLY — every input comes from the existing store modules
 * (listAssets, listLedger, listContracts, listAllowlists); no write path
 * exists on this route and the money ledger is never written by the
 * console.
 *
 * GATED: the signed admin session cookie is verified before any data is
 * read — unset env → 503 admin_not_configured, absent/expired/invalid
 * cookie → 401; neither failure carries data.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { listAllowlists } from '@/lib/admin/allowlists';
import { allowlistsSummary, contractsSummary, ledgerSummary, registrySummary } from '@/lib/admin/overview';
import { listContracts } from '@/lib/contracts/store';
import { jsonError } from '@/lib/server/http';
import { listLedger } from '@/lib/ledger/store';
import { listAssets } from '@/lib/sdk';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const db = supabaseFromEnv();
  if (!db) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  const [assets, ledgerRows, contracts, allowlists] = await Promise.all([
    listAssets(),
    listLedger(),
    listContracts(),
    listAllowlists(db),
  ]);

  if (!allowlists.ok) return jsonError(allowlists.status, allowlists.code, allowlists.message);

  return Response.json(
    {
      ok: true,
      registry: registrySummary(assets),
      ledger: ledgerSummary(ledgerRows),
      contracts: contractsSummary(contracts),
      allowlists: { ...allowlistsSummary(allowlists.value), rows: allowlists.value },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
