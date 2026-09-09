/**
 * POST /api/covnant/accounts/provision — CovnantRoyaltyTrackingAPI
 * (Increase virtual account number provisioning).
 *
 * Purpose: give each rights holder a dedicated Increase Account Number that
 * distributors, PROs, and licensees can pay royalties into. Inbound ACH to
 * that number is ingested by the sibling webhook route
 * /api/covnant/webhooks/increase, which resolves the number back to the
 * holder and credits universal_royalty_ledger.
 *
 * Increase resource (field names pinned from the official API reference,
 * https://increase.com/documentation/api/account-numbers):
 * - POST /account_numbers with body { account_id, name, inbound_ach:
 *   { debit_status } } and Authorization: Bearer ${INCREASE_API_KEY} — the
 *   exact auth convention the banking route uses for Increase.
 * - The created Account Number object carries `id` (prefix
 *   account_number_), `account_number`, `routing_number`, `created_at` —
 *   the four values persisted as the covenantVirtualAccount block.
 * - `account_id` is the Increase Account the number belongs to; the
 *   existing INCREASE_SOURCE_ACCOUNT_ID (the same Covnant entity account
 *   the banking route originates RTP from) is reused — no new env vars.
 * - `inbound_ach.debit_status` is set to "blocked": a royalty destination
 *   is credit-only, so outbound ACH debits against the published number
 *   are refused at the bank. Returns of already-settled inbound credits
 *   are unaffected.
 * - Idempotency-Key (ASCII, ≤ 200 chars —
 *   https://increase.com/documentation/idempotency-keys) is derived
 *   deterministically from the (assetId, rightsHolderId) pair, so a race
 *   between two first-time provisions cannot mint two numbers: Increase
 *   returns the same object to both callers.
 *
 * Persistence model (authoritative live Supabase schema, identical to the
 * banking route's): the holder lives in the GIN-indexed
 * cbt_assets.rights_holders JSONB array keyed by rightsHolderId — the
 * request's natural key, with assetId scoping the asset row. Provisioned
 * numbers are stored on the entry's payoutRouting under
 * covenantVirtualAccount: { accountNumberId, accountNumber,
 * routingNumber, provisionedAt }. The pre-existing payoutRouting.routingNumber
 * and payoutRouting.accountNumber (the external RTP destination consumed by
 * the banking route) are left untouched.
 *
 * The three-phase provisioning flow (FOR UPDATE serialization, external
 * call outside any transaction, deterministic idempotency key, sibling-
 * preserving JSONB rewrite) lives in src/lib/covnant/provisioning.ts and
 * is shared verbatim with the instant sign-up route
 * (/api/covnant/auth/signup). This route keeps only request validation,
 * environment fail-closed checks, and the HTTP mapping of the returned
 * ProvisioningOutcome — including echoing the account numbers: provisioning
 * is the product surface that hands a rights holder the routing
 * coordinates to publish (unlike the pre-auth sign-up route, which returns
 * status fields only).
 *
 * Caller authentication: none, consistent with the locked v1 server-side
 * posture of the PR #23 / banking routes.
 */

import { getDb } from '@/lib/db';
import {
  provisionRightsHolderVirtualAccount,
  type ProvisioningOutcome,
} from '@/lib/covnant/provisioning';

export const dynamic = 'force-dynamic';

const PROVISIONING_FAILED_MESSAGE = 'Increase account number provisioning failed.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProvisionRequestBody {
  assetId?: unknown;
  rightsHolderId?: unknown;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Maps a terminal provisioning outcome to this route's HTTP contract. */
function provisionResponse(outcome: ProvisioningOutcome): Response {
  switch (outcome.status) {
    case 'HOLDER_NOT_FOUND':
    case 'HOLDER_VANISHED':
      return jsonError('Rights holder not found.', 404);
    case 'ALREADY_PROVISIONED':
      return Response.json(
        { ok: true, ...outcome.virtualAccount, alreadyProvisioned: true },
        { headers: { 'cache-control': 'no-store' } },
      );
    case 'PROVISIONED':
      return Response.json(
        { ok: true, ...outcome.virtualAccount, alreadyProvisioned: false },
        { headers: { 'cache-control': 'no-store' } },
      );
    case 'HOLDER_NOT_PROVISIONABLE':
      return jsonError('Rights holder entry is not provisionable.', 409);
    case 'INCREASE_UNAVAILABLE':
      return jsonError(PROVISIONING_FAILED_MESSAGE, 502);
    case 'PERSISTENCE_FAILED':
      return jsonError('Failed to persist the provisioned account numbers.', 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: ProvisionRequestBody;
  try {
    body = (await request.json()) as ProvisionRequestBody;
  } catch {
    return jsonError('Request body must be valid JSON with assetId and rightsHolderId.', 400);
  }
  const assetId = body.assetId;
  const rightsHolderId = body.rightsHolderId;
  if (!isNonEmptyString(assetId) || !UUID_PATTERN.test(assetId.trim())) {
    return jsonError('Invalid provisioning request: assetId must be a UUID.', 400);
  }
  if (!isNonEmptyString(rightsHolderId) || rightsHolderId.trim().length > 200) {
    return jsonError('Invalid provisioning request: rightsHolderId is required.', 400);
  }
  const normalizedAssetId = assetId.trim();
  const normalizedHolderId = rightsHolderId.trim();

  const increaseApiKey = process.env.INCREASE_API_KEY;
  const sourceAccountId = process.env.INCREASE_SOURCE_ACCOUNT_ID;
  if (!increaseApiKey || !sourceAccountId) {
    return jsonError('Increase is not configured (INCREASE_API_KEY / INCREASE_SOURCE_ACCOUNT_ID).', 503);
  }
  const db = getDb();
  if (!db) {
    return jsonError('Database is not configured (DATABASE_URL).', 503);
  }

  const outcome = await provisionRightsHolderVirtualAccount(db, {
    assetId: normalizedAssetId,
    rightsHolderId: normalizedHolderId,
    increaseApiKey,
    sourceAccountId,
  });
  return provisionResponse(outcome);
}
