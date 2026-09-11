/**
 * GET /api/v1/dashboard — the session-bound Don dashboard aggregate.
 *
 * The API door to the SAME resolver the /dashboard page renders from
 * (loadSessionDashboard): the creator's sovereign vault buckets
 * (available_balance / pending_balance / reserve_balance, integer cents),
 * the recent holder-scoped GL journals with their entry_hash short form
 * carried on each display row for auditability, the payout states
 * attributed to their sandbox rail (RTP instant, ACH +3 business days),
 * and the readiness rows. Dashboard components consume the identical
 * aggregate — the route is the programmatic view of that surface.
 *
 * The identity is the SESSION and nothing else — the auth user comes from
 * supabase.auth.getUser() (the JWT validated against the auth server), the
 * profile row is read under the creator_profiles select-own RLS policy, and
 * the payee key is the registry holder's rightsHolderId matched strictly by
 * the SESSION email. No client-supplied payee_id exists on this route —
 * that is the security property the machine /api/v1 routes (which serve
 * keyed integrations) do not need.
 *
 * Response (200) — the aggregate:
 *   user          the greeting voice (stage name + initials)
 *   vault         the SovereignVaultRecord — the three account cards
 *   ledger        recent GlJournals + their balanced GlEntryRecord legs
 *   transactions  the display projection of `ledger` — each row carries
 *                 entry_hash_short (the journal's entry_hash, first 12
 *                 chars) shown on the audit line
 *   payouts       PayoutHoldRecord states attributed to rail + provider
 *   readiness     kyc/tin/w9/bank/provisioning states
 *
 * Errors use the Don named-code envelope: 401 no_session (no session — an
 * expired/invalid session is the signed-out state for a display surface),
 * 404 profile_not_found / holder_not_found, 502 profile_read_failed /
 * registry_read_failed / dashboard_read_failed (fail closed — a read error
 * is never surfaced as empty data), 503 supabase_not_configured.
 *
 * READ-ONLY: this route performs zero writes.
 */

import { NextRequest } from 'next/server';

import { displayTransactions, type DashboardResolution } from '@/lib/don/dashboardData';
import { clientIdentity } from '@/modules/don/http';
import { donJsonError } from '@/lib/server/http';
import { checkRateLimit, DON_API_RATE_LIMIT } from '@/lib/server/rateLimit';
import { isDevSeedMode } from '@/lib/server/devSeed';
import { loadSessionDashboard } from '@/lib/server/dashboardLive';
import { SessionCreatorReadError } from '@/lib/server/sessionCreator';
import { readSupabaseEnv } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const limit = checkRateLimit(clientIdentity(request), DON_API_RATE_LIMIT);
  if (!limit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`,
    );
  }

  // Fail-closed environment check — except in dev-seed mode, where the
  // aggregate reads the seeded in-memory store and no Supabase is needed.
  if (!isDevSeedMode() && !readSupabaseEnv()) {
    return donJsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  let resolution: DashboardResolution;
  try {
    resolution = await loadSessionDashboard();
  } catch (error) {
    if (error instanceof SessionCreatorReadError) {
      return donJsonError(502, error.code, error.message);
    }
    console.error('dashboard aggregate read failed:', error);
    return donJsonError(502, 'dashboard_read_failed', 'Failed to load the dashboard.');
  }

  switch (resolution.kind) {
    case 'anonymous':
      return donJsonError(401, 'no_session', 'No session — sign in to load the dashboard.');
    case 'demo':
      // Unreachable through THIS door: loadSessionDashboard never resolves
      // the demo kind — the demo door is the page-facing provider's
      // sessionless fallback. The API stays session-bound: fail closed, not
      // open (a demo aggregate is never served over the machine contract).
      return donJsonError(401, 'no_session', 'No session — sign in to load the dashboard.');
    case 'unregistered':
      return donJsonError(404, resolution.reason, 'No dashboard exists for this session yet.');
    case 'registered':
      return Response.json(
        {
          ...resolution.data,
          // The display projection — the entry_hash short form on every row
          // is the auditability marker this surface is asked to show.
          transactions: displayTransactions(resolution.data.ledger, resolution.data.vault.payee_id),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
  }
}
