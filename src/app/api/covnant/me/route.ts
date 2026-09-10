/**
 * GET /api/covnant/me — the session-scoped creator aggregate.
 *
 * The resolution logic lives in ONE shared server module —
 * src/lib/server/covnantMe.ts (resolveCovnantMe) — consumed verbatim by
 * this route AND by the (workspace) server surfaces, so the API and the
 * dashboard home can never disagree about a session's creator data. The
 * route owns ONLY the HTTP envelope: 200 with the aggregate (cache-control:
 * no-store), or the named-code error family (401 no_session /
 * session_invalid, 404 profile_not_found / holder_not_found, 502
 * profile_read_failed / registry_read_failed / escrow_read_failed, 503
 * supabase_not_configured) — fail closed, never empty data.
 *
 * Response (200) — the aggregate (see resolveCovnantMe for the resolution
 * discipline):
 *   profile       the creator_profiles row incl. the 0004 compliance columns
 *                 (kyc_status, tax_form_type, tax_verified, bank_account_linked)
 *   identity      the UCT + immutable issuance facts (uct, uctCreatedAt,
 *                 jurisdiction, engine?)
 *   role          the registry holder role (e.g. 'COMPOSER')
 *   provisioning  status ONLY via storedVirtualAccount() — PROVISIONED, or
 *                 PENDING + INCREASE_NOT_PROVISIONED (this read-only route
 *                 cannot know the mint-time cause the signup contract's
 *                 INCREASE_NOT_CONFIGURED / INCREASE_UNAVAILABLE name).
 *                 NEVER accountNumber, routingNumber, or accountNumberId —
 *                 the signup route's disclosure rule extends here
 *                 (asserted in the tests).
 *   settlements   per-holder escrow totals — BigInt smallest-unit strings
 *                 (1e-8 scale), never a float rollup.
 *   registeredAssets  creator-scoped count of registry rows holding this holder.
 *   settlementsByCurrency  per-currency settled gross/net — BigInt unit strings.
 *   recentSettlements  the bounded recent-royalty strip (max 10, newest
 *                 first) — READ-ONLY display rows, never account numbers.
 *
 * READ-ONLY: this route performs zero writes — no ledger, registry, or
 * profile mutation.
 */

import { resolveCovnantMe } from '@/lib/server/covnantMe';
import { jsonError } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const resolution = await resolveCovnantMe();
  if (resolution.ok) {
    return Response.json(resolution.data, { headers: { 'cache-control': 'no-store' } });
  }
  return jsonError(resolution.status, resolution.reason, resolution.message);
}
