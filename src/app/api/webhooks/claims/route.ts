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
 *
 * GATED (hardening gen 12 — before this, anyone who could name a POST body
 * could settle ledger rows): machine callers present the provisioning-time
 * shared secret in the `x-claims-webhook-secret` header, compared
 * timing-safely against CLAIMS_WEBHOOK_SECRET. The check fails CLOSED — an
 * unset secret refuses every request with 401 (the webhook is unavailable,
 * never open) — and the surface is rate limited per client address ahead of
 * any body parsing.
 */

import { processUniversalSocialWebhookAction } from '@/engine/covenant-master-sdk';
import type { GlobalMatchClaimPayload } from '@/engine/covenant-master-sdk';
import { resolveDataSourceMode } from '@/lib/data-source';
import { stampEngineLedgerRowsCbt } from '@/lib/ledger/engine-stamp';
import { rememberSettlement } from '@/lib/ledger/store';
import { checkRateLimit, DON_API_RATE_LIMIT } from '@/lib/server/rateLimit';
import { sharedSecretMatches } from '@/lib/server/sharedSecret';

function clientAddress(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

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
  // The limiter guards the secret check itself: a guessed header burns the
  // client address's window just like a malformed body would.
  const verdict = checkRateLimit(clientAddress(request), DON_API_RATE_LIMIT);
  if (!verdict.ok) {
    return Response.json(
      { ok: false, error: `Rate limit exceeded. Retry after ${verdict.retryAfterSeconds}s.` },
      { status: 429 },
    );
  }

  // Fail closed: unset CLAIMS_WEBHOOK_SECRET answers 401 for everyone.
  const presented = request.headers.get('x-claims-webhook-secret');
  if (!sharedSecretMatches(presented, process.env.CLAIMS_WEBHOOK_SECRET)) {
    return Response.json(
      { ok: false, error: 'Invalid or missing webhook secret.' },
      { status: 401 },
    );
  }

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
  } else {
    // DB mode: the engine action already upserted the ledger rows (the
    // vendored SDK is hash-locked and cannot stamp). The repo-side boundary
    // enriches each settled row's metadata.cbt by transaction_id — bounded,
    // metadata-only, money-never-blocks: any enrichment failure skips the
    // code while the settlement stands.
    await stampEngineLedgerRowsCbt((result.data ?? []).map((r) => r.transactionId));
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
