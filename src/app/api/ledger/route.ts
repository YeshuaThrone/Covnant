/**
 * GET /api/ledger — Universal Royalty Ledger read endpoint.
 *
 * Strict-execution directive deliverable. Maps one-to-one onto the verified
 * schema in supabase/migrations/0001_covenant_init.sql via the ledger store:
 *
 *   - Supabase mode: reads go through `listLedger()` using the server-only
 *     service-role credential (NEXT_PUBLIC_SUPABASE_URL +
 *     SUPABASE_SERVICE_ROLE_KEY). RLS is enforced by Postgres itself —
 *     `universal_royalty_ledger` carries deny-all-to-anon policies (v1 ships
 *     without authentication), so no client-side caller can read this table
 *     with the anon key. This route performs the read server-side and never
 *     returns or exposes the service-role credential.
 *   - Memory mode: with no credentials configured the store serves its
 *     in-memory index; nothing is persisted or exposed externally.
 *
 * No request authentication exists in v1 by locked spec decision; when auth
 * lands in v2 the store's read should switch to the caller's
 * anon-key/authenticated client so RLS row policies scope every response.
 */

import { listLedger, totalsFrom } from '@/lib/ledger/store';
import { resolveDataSourceMode } from '@/lib/data-source';

export const dynamic = 'force-dynamic';

export async function GET() {
  const mode = resolveDataSourceMode();
  const rows = await listLedger();
  const totals = totalsFrom(rows);

  return Response.json(
    {
      ok: true,
      mode,
      rlsContract:
        mode === 'supabase'
          ? 'universal_royalty_ledger is RLS-protected (deny-all to anon per 0001_covenant_init.sql); this read is server-side via the service-role credential, which is never exposed to clients.'
          : 'in-memory fallback: no Supabase credentials configured; data is process-local only.',
      totals,
      settlements: rows,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
