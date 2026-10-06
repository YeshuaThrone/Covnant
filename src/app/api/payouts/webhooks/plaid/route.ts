/**
 * POST /api/payouts/webhooks/plaid — the transfer-webhook bell for
 * escrow_withdrawal_intents reconciliation (the follow-up migration 0058's
 * comment reserved for this task).
 *
 * Why this endpoint exists: the withdraw route (src/app/api/payouts/withdraw)
 * dispatches intent-first — the pending hold is inserted before the Plaid
 * transfer/create call, and when the outcome is UNKNOWN (network drop
 * mid-call, unparseable 2xx body) or the DISBURSEMENT ledger insert fails,
 * the hold stays pending BY DESIGN — funds over-held, never over-paid.
 * Nothing in that route settles or releases it afterward. This webhook is
 * one of the two resolvers (the other: the operator-gated stale-hold sweep
 * at src/app/api/payouts/withdraw/reconcile) that give every hold a path to
 * settled or released.
 *
 * Signature verification (fail-closed, pinned from Plaid's docs): every
 * webhook delivery carries an ES256-signed JWT in the `Plaid-Verification`
 * header, signed by a Plaid key identified by the JWT's `kid` and fetched
 * fresh from /webhook_verification_key/get. The JWT's `iat` must be within
 * PLAID_SIGNATURE_TOLERANCE_SECONDS of now (replay blunting) and its
 * `request_body_sha256` claim must equal the SHA-256 of the EXACT raw body —
 * which is why the body is read as text before anything else and never
 * re-serialized. Missing verification credentials on THIS deployment → 503
 * with an explicit not-configured error (the locked-rails policy:
 * application-level Plaid credentials do not exist yet; the endpoint never
 * accepts unverified traffic and the live rail is never fake-enabled — the
 * test suite exercises the machinery through a stubbed transport). Missing
 * header → 401; failed verification (bad signature, stale/future iat, body
 * mismatch, unknown kid, wrong algorithm) → 403; verification-key transport
 * outage → 503 (Plaid retries). No signature failure can produce a 5xx.
 *
 * Notification semantics: a signed webhook is a BELL, not a verdict — the
 * delivery's own content (webhook_code) is never trusted for money
 * movement. The route maps the intent by transfer_id, then asks Plaid's
 * /transfer/get for the AUTHORITATIVE current status through the shared
 * transport (src/lib/escrow/plaidApi.ts) and resolves through the shared
 * reconciler core (src/lib/escrow/intentReconciler.ts):
 *
 *   posted | settled           → settle  (pending → settled, completing the
 *                                          deterministic ESCROW-PAYOUT-<id>
 *                                          ledger debit when the route's
 *                                          insert failed)
 *   failed | reversed |
 *   cancelled                  → release (pending → available, compensating
 *                                          entries through the same ledger
 *                                          code path when a debit stands)
 *   pending | unknown          → 200 held (the sweep re-checks later)
 *
 * Idempotency: both resolvers converge on the SAME atomic guard-first
 * status UPDATE (UPDATE … WHERE status='pending', rowcount gate) — a
 * replayed delivery admits exactly one resolution; the ledger side is
 * replay-safe by the deterministic transaction ids (UNIQUE convergence).
 *
 * Unknown webhook types/codes are graceful 200 no-ops per Plaid's
 * documented addition handling; a transfer_id that maps to no intent
 * answers 200 with noted=true (logged) — Plaid stops retrying a delivery
 * we have no stake in, while the event stays on the server log for audit.
 * Unresolved database/rail states answer retryable 503s, never a silent
 * 200 — money must not vanish quietly.
 */

import { supabaseFromEnv } from '@/lib/supabase';
import { clientAddress } from '@/lib/server/clientAddress';
import { checkSharedRateLimit, PAYOUTS_WEBHOOK_RATE_LIMIT } from '@/lib/server/rateLimit';
import {
  fetchTransferStatus,
  fetchWebhookVerificationKey,
  outcomeForTransferStatus,
  plaidCredentialsFromEnv,
} from '@/lib/escrow/plaidApi';
import { verifyPlaidWebhookSignature } from '@/lib/escrow/plaidWebhookSignature';
import { findIntentByTransferId, reconcileTransferOutcome } from '@/lib/escrow/intentReconciler';

export const dynamic = 'force-dynamic';

/** Plaid's signed-verification JWT header (pinned from the docs). */
const PLAID_VERIFICATION_HEADER = 'plaid-verification';

/** The only webhook type this endpoint reconciles; everything else no-ops. */
const PLAID_TRANSFER_WEBHOOK_TYPE = 'TRANSFER';

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

function jsonOk(body: Record<string, unknown> = {}): Response {
  return Response.json({ ok: true, ...body }, { headers: { 'cache-control': 'no-store' } });
}

/** Extracts the verification JWT's kid — the key-fetch argument. A JWT whose header segment is unreadable yields null (a bad-signature refusal downstream). */
function kidFromVerificationJwt(verificationJwt: string): string | null {
  const [headSegment] = verificationJwt.split('.');
  if (!headSegment) return null;
  try {
    const header = JSON.parse(Buffer.from(headSegment, 'base64url').toString('utf8')) as {
      kid?: unknown;
    };
    return typeof header?.kid === 'string' && header.kid !== '' ? header.kid : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  // Gate order — rate limit, signature verification, parse, validate,
  // resolve. The raw body is read exactly once, as text: the signature
  // covers these exact bytes.
  const rawBody = await request.text();

  const verdict = await checkSharedRateLimit(
    `payouts-webhook:${clientAddress(request)}`,
    PAYOUTS_WEBHOOK_RATE_LIMIT,
  );
  if (!verdict.ok) {
    return jsonError('Rate limit exceeded.', 429);
  }

  const credentials = plaidCredentialsFromEnv();
  if (!credentials) {
    // Fail-closed under the locked-rails policy: without application-level
    // Plaid credentials there is no key fetch and no authoritative verdict —
    // the endpoint refuses EXPLICITLY rather than processing unverified
    // bodies. A 503 (not a 404) keeps the surface honest for operators and
    // tells Plaid to retry once credentials ship.
    console.error('Plaid webhook: verification credentials are not configured.');
    return jsonError('Plaid webhook verification is not configured.', 503);
  }

  const verificationJwt = request.headers.get(PLAID_VERIFICATION_HEADER);
  if (!verificationJwt) {
    return jsonError('Unauthorized: webhook signature missing', 401);
  }

  const kid = kidFromVerificationJwt(verificationJwt);
  if (!kid) {
    return jsonError('Invalid webhook signature', 403);
  }

  let verificationKey;
  try {
    verificationKey = await fetchWebhookVerificationKey(credentials, kid);
  } catch (error) {
    // An unknown kid surfaces as a 4xx from Plaid — a bad-signature refusal,
    // not an outage. Transport failures stay retryable 503s.
    console.error('Plaid webhook verification key fetch failed:', error);
    if (error instanceof Error && /status 4\d\d/.test(error.message)) {
      return jsonError('Invalid webhook signature', 403);
    }
    return jsonError('Verification key could not be resolved; retry pending.', 503);
  }

  const verification = verifyPlaidWebhookSignature({
    rawBody,
    verificationJwt,
    verificationKey,
  });
  if (!verification.ok) {
    console.error('Plaid webhook signature verification failed:', verification.reason);
    return jsonError('Invalid webhook signature', 403);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable: reject the delivery (Plaid retries, then
    // drops it) — never guess at money movement.
    return jsonError('Webhook body must be a JSON object.', 400);
  }
  const event = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as {
    webhook_type?: unknown;
    webhook_code?: unknown;
    transfer_id?: unknown;
    environment?: unknown;
  };

  if (event.webhook_type !== PLAID_TRANSFER_WEBHOOK_TYPE) {
    // Documented addition handling: Plaid adds types; uninteresting ones
    // are graceful no-ops.
    return jsonOk({ ignored: true });
  }
  if (typeof event.transfer_id !== 'string' || event.transfer_id === '') {
    console.error('Plaid transfer webhook is missing transfer_id:', event.webhook_code);
    return jsonError('Webhook is missing the transfer id.', 400);
  }
  const transferId = event.transfer_id;

  const db = supabaseFromEnv();
  if (!db) {
    console.error('Plaid webhook: database is not configured; retry pending.');
    return jsonError('Database is not configured.', 503);
  }

  const intent = await findIntentByTransferId(db, transferId);
  if (!intent) {
    // A transfer we never stamped (pre-reconciler hold, or another
    // environment's transfer). Nothing to reconcile; log for audit and
    // answer 200 so Plaid stops retrying.
    console.error(`Plaid transfer webhook for unmapped transfer id ${transferId}`);
    return jsonOk({ noted: true });
  }

  // The bell rang — ask the rail for the authoritative verdict. A transport
  // failure here throws: the catch below answers a retryable 503.
  let status: string;
  try {
    status = await fetchTransferStatus(credentials, transferId);
  } catch (error) {
    console.error(`Plaid transfer/get failed for ${transferId}:`, error);
    return jsonError('Transfer status could not be resolved; retry pending.', 503);
  }

  const outcome = outcomeForTransferStatus(status);
  if (!outcome) {
    // pending or an unknown status: fail-closed — keep the hold; the sweep
    // re-checks later.
    return jsonOk({ held: true, status });
  }

  try {
    const resolution = await reconcileTransferOutcome(db, { intentId: intent.id, plaidTransferId: transferId, outcome });
    return jsonOk({
      intentId: resolution.intentId,
      outcome: resolution.outcome,
      resolved: resolution.resolved,
      alreadyResolved: resolution.alreadyResolved,
      ledger: resolution.ledger,
      status,
    });
  } catch (error) {
    // The ledger/intent write failed AFTER a verified outcome: the hold
    // stays pending (fail-closed) and this delivery answers retryable.
    console.error(`Reconciliation failed for intent ${intent.id}:`, error);
    return jsonError('Reconciliation failed; retry pending.', 503);
  }
}
