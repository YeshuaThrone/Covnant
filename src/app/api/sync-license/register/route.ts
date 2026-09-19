/**
 * POST /api/sync-license/register — the Sync License registration endpoint
 * (layout contract art_9tCxOhGO backend sections). A signed-in creator
 * submits one of THEIR OWN assets for sync licensing; the catalog lands it
 * PENDING PRE-CLEARANCE. Only a gated administrator action flips
 * is_pre_cleared — the submission can never clear itself.
 *
 * Splits are HARD-LOCKED 50/35/15: the request accepts no split input
 * (any split-shaped key is an unknown key) and the response echoes the
 * locked structure from the settlement lane's single source of truth.
 *
 * Fail-closed: no session → 401; malformed body → 400; unknown/invalid
 * keys → 422; asset sheet missing → 404; submitter not a rights holder →
 * 403; already cleared → 409 (admin owns cleared state).
 */

import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/server/http';
import { checkRateLimit, DON_API_RATE_LIMIT } from '@/lib/server/rateLimit';
import { clientIdentity } from '@/modules/don/http';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { getStore } from '@/lib/server/store';
import { getSdk } from '@/lib/sdk';
import { parseSyncRegistration } from '@/lib/sync/registration';
import { SYNC_TIER_WEIGHTS } from '@/lib/server/syncLicenseSettlement';

/** The locked Universal 50/35/15 structure, echoed in every 201 response. */
export const LOCKED_SYNC_SPLITS = {
  tier1OwnershipBps: Number(SYNC_TIER_WEIGHTS[0] ?? 0n),
  tier2CreativeBps: Number(SYNC_TIER_WEIGHTS[1] ?? 0n),
  tier3ProductionBps: Number(SYNC_TIER_WEIGHTS[2] ?? 0n),
} as const;

/**
 * The asset-sheet reader over the SDK engine. getOrHydrateAsset throws a
 * generic Error for BOTH "no such asset" and "storage read failed" — the
 * route must not misclassify an outage as a missing asset, so the two are
 * separated by the engine's resolution message and a read failure surfaces
 * as its own named state.
 */
type AssetSheetRead =
  | { found: true; asset: Awaited<ReturnType<ReturnType<typeof getSdk>['getOrHydrateAsset']>> }
  | { found: false }
  | { readFailed: true };

async function readAssetSheet(cbtCode: string): Promise<AssetSheetRead> {
  try {
    return { found: true, asset: await getSdk().getOrHydrateAsset(cbtCode) };
  } catch (error) {
    if (error instanceof Error && error.message.includes('could not be resolved from DB or Memory')) {
      return { found: false };
    }
    return { readFailed: true };
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const verdict = checkRateLimit(clientIdentity(request), DON_API_RATE_LIMIT);
  if (!verdict.ok) return jsonError(429, 'rate_limited', 'Too many requests — slow down.');

  const session = await resolveSessionCreator();
  if (session.kind !== 'registered') {
    return jsonError(401, 'no_session', 'Sign in as a registered creator to register assets.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }
  const parsed = parseSyncRegistration(body);
  if (!parsed.ok) return jsonError(422, parsed.code, parsed.message);

  const sheet = await readAssetSheet(parsed.value.cvtAssetTag);
  if ('readFailed' in sheet) {
    return jsonError(502, 'asset_sheet_read_failed', 'The asset catalog is unavailable — try again.');
  }
  if (!sheet.found) {
    return jsonError(
      404,
      'asset_not_found',
      `Asset sheet ${parsed.value.cvtAssetTag} not found — register the asset in the CBT catalog first.`,
    );
  }
  const asset = sheet.asset;
  const isHolder = asset.rightsHolders.some(
    (holder) => holder.id === session.creator.payee_id,
  );
  if (!isHolder) {
    return jsonError(403, 'not_asset_holder', 'Only a rights holder on the asset may submit it for sync licensing.');
  }

  const store = getStore();
  const existing = await store.getSyncCatalogItem(parsed.value.cvtAssetTag);
  if (existing !== undefined && existing.is_pre_cleared) {
    return jsonError(409, 'already_pre_cleared', 'Asset is already pre-cleared; a submission cannot change cleared state.');
  }

  // The pending pre-clearance submission — is_pre_cleared is ALWAYS false
  // here, never taken from input: only a gated administrator clears.
  const submission = await store.upsertSyncCatalogItem({
    cbt_code: parsed.value.cvtAssetTag,
    is_pre_cleared: false,
    sync_fee_cents: parsed.value.syncFeeCents,
    genre: parsed.value.genre,
    bpm: parsed.value.bpm,
  });

  return NextResponse.json(
    {
      ok: true,
      status: 'PENDING_PRE_CLEARANCE',
      submission,
      lockedSplits: LOCKED_SYNC_SPLITS,
    },
    { status: 201 },
  );
}
