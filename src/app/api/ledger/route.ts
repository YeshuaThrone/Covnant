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
 * GATED (hardening gen 12 — REVERSES the v1 locked public-dump decision,
 * founder approval recorded in plan generation 12): a full royalty-ledger
 * dump is no longer anonymous. The read requires a registered creator
 * session OR the signed admin cookie; anonymous callers get 401 no_session,
 * signed-in-but-unenrolled sessions get 403 not_registered. The response
 * shape is unchanged for authorized callers — the workspace asset page's
 * verification strip and the admin console degrade to their honest error
 * states only when unauthenticated.
 */

import { listLedger, totalsFrom } from '@/lib/ledger/store';
import { resolveDataSourceMode } from '@/lib/data-source';
import { requireRegisteredOrOperator } from '@/lib/server/apiAccess';
import { jsonError } from '@/lib/server/http';
import { checkSharedRateLimit, PUBLIC_READ_RATE_LIMIT } from '@/lib/server/rateLimit';
import { clientAddress } from '@/lib/server/clientAddress';


export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Shared limiter first (audit M5): the per-address window burns before the
  // session round-trips, so a flood never reaches Supabase Auth.
  const limit = await checkSharedRateLimit(
    `ledger:${clientAddress(request)}`,
    PUBLIC_READ_RATE_LIMIT,
  );
  if (!limit.ok) {
    return jsonError(429, 'rate_limited', `Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`);
  }

  const access = await requireRegisteredOrOperator(request);
  if (!access.ok) {
    return jsonError(access.status, access.code, access.message);
  }

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
