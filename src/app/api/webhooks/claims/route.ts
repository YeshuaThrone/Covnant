/**
 * POST /api/webhooks/claims — Universal Social & Entertainment claims webhook — PR 4.
 *
 * Accepts `{ claims: GlobalMatchClaimPayload[] }` and hands them to the engine's
 * `processUniversalSocialWebhookAction`, which settles each claim on the social
 * path (10% platform fee, allowlist creator incentives deducted first) and, when
 * Supabase is configured, upserts the ledger on `transaction_id`.
 *
 * In memory mode the engine action skips persistence; this route mirrors the
 * settled results into the ledger store so /ledger renders webhook settlements
 * in both data modes. DB mode upserts inside the engine action only — no double
 * write.
 */

import { processUniversalSocialWebhookAction } from '@/engine/covenant-master-sdk';
import type { GlobalMatchClaimPayload } from '@/engine/covenant-master-sdk';
import { resolveDataSourceMode } from '@/lib/data-source';
import { rememberSettlement } from '@/lib/ledger/store';

function isClaim(value: unknown): value is GlobalMatchClaimPayload {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim.platform === 'string' &&
    typeof claim.cbtCode === 'string' &&
    typeof claim.externalAssetId === 'string' &&
    typeof claim.mediaContentId === 'string' &&
    typeof claim.channelOrProfileId === 'string' &&
    typeof claim.grossAdRevenueOrRoyalty === 'number' &&
    Number.isFinite(claim.grossAdRevenueOrRoyalty) &&
    claim.grossAdRevenueOrRoyalty > 0 &&
    typeof claim.currency === 'string' &&
    typeof claim.territoryCountryCode === 'string' &&
    typeof claim.timestamp === 'number'
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const claims = (body as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(claims) || claims.length === 0 || !claims.every(isClaim)) {
    return Response.json(
      {
        ok: false,
        error:
          'Body must be { "claims": GlobalMatchClaimPayload[] } with platform, cbtCode, externalAssetId, mediaContentId, channelOrProfileId, grossAdRevenueOrRoyalty > 0, currency, territoryCountryCode, and timestamp.',
      },
      { status: 400 }
    );
  }

  const result = await processUniversalSocialWebhookAction(
    claims as GlobalMatchClaimPayload[]
  );

  if (!result.success) {
    return Response.json({ ok: false, error: result.error }, { status: 502 });
  }

  if (resolveDataSourceMode() === 'memory') {
    const settled = result.data ?? [];
    for (let i = 0; i < settled.length; i++) {
      await rememberSettlement(settled[i], claims[i].platform);
    }
  }

  return Response.json({
    ok: true,
    processedCount: result.processedCount ?? (result.data ?? []).length,
    results: (result.data ?? []).map((r) => ({
      transactionId: r.transactionId,
      cbtCode: r.cbtCode,
      totalSettled: r.totalSettled,
      platformFeeDeducted: r.platformFeeDeducted,
      cornerDustCollected: r.cornerDustCollected,
      currency: r.currency,
      reconciliationStatus: r.reconciliationStatus,
    })),
  });
}
