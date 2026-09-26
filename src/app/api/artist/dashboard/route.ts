/**
 * GET /api/artist/dashboard?rightsHolderId= — escrow balance + asset summary.
 *
 * Reads the service-role Supabase tables directly (universal_royalty_ledger
 * and cbt_assets) and computes every money field through the shared escrow
 * balance helper so the dashboard can never disagree with the payout
 * withdrawal route about what a holder may withdraw.
 *
 * All money values are strings of BigInt smallest ledger units (1e-8 scale,
 * matching the ledger's numeric(20,8) columns). Tax uses the vendored
 * engine's effective rate for the holder's tax profile on US territory.
 *
 * GATED (hardening gen 12 — this route was an unauthenticated IDOR: any
 * caller could read ANY holder's balances by naming their rightsHolderId).
 * The holder identity is now DERIVED from the verified creator session and
 * a client-supplied rightsHolderId is only a claim to verify — a signed-in
 * creator requesting another holder's data is refused 403 before any read
 * runs. Operators (the signed admin cookie) may still read any holder's
 * summary, and must name the holder explicitly.
 */

import { supabaseFromEnv } from '@/lib/supabase';
import { requireHolderAccess } from '@/lib/server/apiAccess';
import {
  EscrowLedgerReadError,
  fetchEscrowBalance,
  findRightsHolder,
  UNVERIFIED_FALLBACK_TAX_PROFILE,
} from '@/lib/escrow/balance';

export const dynamic = 'force-dynamic';

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  const access = await requireHolderAccess(
    request,
    new URL(request.url).searchParams.get('rightsHolderId'),
  );
  if (!access.ok) {
    return jsonError(access.message, access.status);
  }

  // A creator session implies its OWN holder; an operator must name one.
  const rightsHolderId =
    access.role === 'owner' ? access.holderId : new URL(request.url).searchParams.get('rightsHolderId')?.trim() ?? '';
  if (!rightsHolderId) {
    return jsonError('rightsHolderId query parameter is required.', 400);
  }

  const db = supabaseFromEnv();
  if (!db) {
    return jsonError('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).', 503);
  }

  // Assets where the holder appears in rights_holders JSONB; also the source
  // of the holder's tax profile for the engine's effective tax rate.
  const { data: assetRows, error: assetsError } = await db
    .from('cbt_assets')
    .select('cvt_code, cbt_code, title, medium, rights_holders');
  if (assetsError) {
    console.error('cbt_assets read failed:', assetsError.message);
    return jsonError('Failed to load artist dashboard.', 502);
  }

  const holder = findRightsHolder(assetRows ?? [], rightsHolderId);
  const taxProfile = holder?.taxProfile ?? UNVERIFIED_FALLBACK_TAX_PROFILE;

  // Shared math: gross = Σ settlement grossShare, tax = gross × engine rate,
  // payouts = Σ type-'DISBURSEMENT' escrow debits, available = gross − tax − payouts.
  // Fail closed: a ledger read error must never surface as a zero balance.
  try {
    const balance = await fetchEscrowBalance(db, rightsHolderId, taxProfile);

    const assets = (assetRows ?? [])
      .filter((row) => findRightsHolder([row], rightsHolderId) !== null)
      .map((row) => {
        const asset = row as {
          cvt_code?: string | null;
          cbt_code?: string | null;
          title?: string | null;
          medium?: string | null;
        };
        return {
          cvtCode: asset.cvt_code ?? null,
          cbtCode: asset.cbt_code ?? null,
          title: asset.title ?? null,
          medium: asset.medium ?? null,
        };
      });

    return Response.json(
      {
        rightsHolderId,
        grossEarnings: balance.grossUnits.toString(),
        taxWithheld: balance.taxWithheldUnits.toString(),
        availableEscrowBalance: balance.availableUnits.toString(),
        isTaxVerified: taxProfile.isVerified,
        assets,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof EscrowLedgerReadError) {
      console.error('escrow balance read failed:', error.message);
      return jsonError('Failed to load escrow balance.', 502);
    }
    throw error;
  }
}
