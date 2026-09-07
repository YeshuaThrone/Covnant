/**
 * POST /api/covenant/accounts/provision — CovnantRoyaltyTrackingAPI
 * (Increase virtual account number provisioning).
 *
 * Purpose: give each rights holder a dedicated Increase Account Number that
 * distributors, PROs, and licensees can pay royalties into. Inbound ACH to
 * that number is ingested by the sibling webhook route
 * /api/covenant/webhooks/increase, which resolves the number back to the
 * holder and credits universal_royalty_ledger.
 *
 * Increase resource (field names pinned from the official API reference,
 * https://increase.com/documentation/api/account-numbers):
 * - POST /account_numbers with body { account_id, name, inbound_ach:
 *   { debit_status } } and Authorization: Bearer ${INCREASE_API_KEY} — the
 *   exact auth convention the banking route uses for Increase.
 * - The created Account Number object carries `id` (prefix
 *   account_number_), `account_number`, `routing_number`, `created_at` —
 *   the four values persisted here as the covenantVirtualAccount block.
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
 * numbers are stored on the entry's payoutRouting under a new
 * covenantVirtualAccount object: { accountNumberId, accountNumber,
 * routingNumber, provisionedAt }. The pre-existing payoutRouting.routingNumber
 * and payoutRouting.accountNumber (the external RTP destination consumed by
 * the banking route) are left untouched.
 *
 * Idempotency: SELECT ... FOR UPDATE serializes provisioning per asset row.
 * An already-provisioned holder short-circuits BEFORE the Increase call and
 * returns the stored numbers unchanged. Under a concurrent first-time race
 * both callers reach Increase, but the deterministic Idempotency-Key makes
 * Increase return the same Account Number to both; the loser re-reads the
 * winner's write under the lock and returns it without a second write.
 * If the holder vanishes between the two transactions, the already-created
 * number is logged for reconciliation and the retry re-runs against the
 * same Idempotency-Key (no second Increase object).
 *
 * Unlike the banking RTP route, this route's response DOES return the
 * account numbers: provisioning is the product surface that hands a rights
 * holder the routing coordinates to publish. (The RTP route still never
 * echoes stored numbers.)
 *
 * Caller authentication: none, consistent with the locked v1 server-side
 * posture of the PR #23 / banking routes.
 */

import { getDb, type Db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const INCREASE_ACCOUNT_NUMBERS_URL = 'https://api.increase.com/account_numbers';
const PROVISIONING_FAILED_MESSAGE = 'Increase account number provisioning failed.';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProvisionRequestBody {
  assetId?: unknown;
  rightsHolderId?: unknown;
}

interface JsonbHolderRow {
  holder: unknown;
}

/** The covenant virtual-account block persisted under payoutRouting. */
interface CovenantVirtualAccount {
  accountNumberId: string;
  accountNumber: string;
  routingNumber: string;
  provisionedAt: string;
}

/** Increase Account Number object — only the pinned fields this route consumes. */
interface IncreaseAccountNumber {
  id?: unknown;
  account_number?: unknown;
  routing_number?: unknown;
  created_at?: unknown;
}

/** Provisioning failure with an already-sanitized client message and status. */
class ProvisioningError extends Error {
  constructor(
    readonly sanitizedMessage: string,
    readonly status: number,
  ) {
    super(sanitizedMessage);
    this.name = 'ProvisioningError';
  }
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

type TxClient = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Reads the holder's stored covenant virtual account, if fully provisioned. */
function storedVirtualAccount(holder: unknown): CovenantVirtualAccount | null {
  if (typeof holder !== 'object' || holder === null) return null;
  const payoutRouting = (holder as { payoutRouting?: unknown }).payoutRouting;
  if (typeof payoutRouting !== 'object' || payoutRouting === null) return null;
  const account = (payoutRouting as { covenantVirtualAccount?: unknown }).covenantVirtualAccount;
  if (typeof account !== 'object' || account === null) return null;
  const candidate = account as Record<string, unknown>;
  if (
    isNonEmptyString(candidate.accountNumberId) &&
    isNonEmptyString(candidate.accountNumber) &&
    isNonEmptyString(candidate.routingNumber) &&
    isNonEmptyString(candidate.provisionedAt)
  ) {
    return {
      accountNumberId: candidate.accountNumberId,
      accountNumber: candidate.accountNumber,
      routingNumber: candidate.routingNumber,
      provisionedAt: candidate.provisionedAt,
    };
  }
  return null;
}

/**
 * Locks the asset row (the per-asset serialization point) and serves the
 * holder filter through the JSONB (the GIN index serves the element test).
 */
async function findHolderInTx(
  tx: TxClient,
  assetId: string,
  rightsHolderId: string,
): Promise<JsonbHolderRow | null> {
  const res = await tx.query<JsonbHolderRow>(
    `SELECT rh AS holder
       FROM cbt_assets, jsonb_array_elements(rights_holders) AS rh
      WHERE cbt_assets.id = $1
        AND rh->>'rightsHolderId' = $2
      FOR UPDATE`,
    [assetId, rightsHolderId],
  );
  return res.rows.length ? res.rows[0] : null;
}

/**
 * Swaps the matching rights_holders element for its merged version in one
 * UPDATE, leaving every sibling element byte-identical (jsonb_agg preserves
 * array order).
 */
async function writeProvisionedHolderInTx(
  tx: TxClient,
  assetId: string,
  rightsHolderId: string,
  updatedEntry: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `UPDATE cbt_assets
        SET rights_holders = (
          SELECT COALESCE(jsonb_agg(CASE WHEN rh->>'rightsHolderId' = $2 THEN $3::jsonb ELSE rh END), '[]'::jsonb)
            FROM jsonb_array_elements(rights_holders) AS rh
        )
      WHERE id = $1`,
    [assetId, rightsHolderId, JSON.stringify(updatedEntry)],
  );
}

interface ProvisionOutcome {
  alreadyProvisioned: boolean;
  virtualAccount: CovenantVirtualAccount;
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

  // Phase 1 — under the row lock: resolve the holder, short-circuit when
  // already provisioned (idempotent, NO Increase call), otherwise release
  // the lock so the external call never holds a database transaction open.
  const firstLookup = await db.transaction<ProvisionOutcome | null>(async (tx) => {
    const lookup = await findHolderInTx(tx, normalizedAssetId, normalizedHolderId);
    if (!lookup) return null;
    const existing = storedVirtualAccount(lookup.holder);
    if (existing) {
      return { alreadyProvisioned: true, virtualAccount: existing };
    }
    return { alreadyProvisioned: false, virtualAccount: null as unknown as CovenantVirtualAccount };
  });
  if (firstLookup === null) {
    return jsonError('Rights holder not found.', 404);
  }
  if (firstLookup.alreadyProvisioned) {
    return Response.json(
      { ok: true, ...firstLookup.virtualAccount, alreadyProvisioned: true },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  // Phase 2 — the Increase call, outside any database transaction. The
  // deterministic Idempotency-Key makes concurrent first-time provisions
  // converge on a single Account Number object at Increase.
  const idempotencyKey = `covenant-royalty-tracking:${encodeURIComponent(normalizedAssetId)}:${encodeURIComponent(normalizedHolderId)}`;
  let increaseRes: Response;
  try {
    increaseRes = await fetch(INCREASE_ACCOUNT_NUMBERS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${increaseApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        account_id: sourceAccountId,
        name: 'Covnant royalty payout',
        inbound_ach: { debit_status: 'blocked' },
      }),
    });
  } catch (error) {
    console.error('Increase account number request failed:', error);
    return jsonError(PROVISIONING_FAILED_MESSAGE, 502);
  }
  if (!increaseRes.ok) {
    console.error('Increase account number creation rejected:', increaseRes.status);
    return jsonError(PROVISIONING_FAILED_MESSAGE, 502);
  }
  let created: IncreaseAccountNumber;
  try {
    created = (await increaseRes.json()) as IncreaseAccountNumber;
  } catch (error) {
    console.error('Increase account number response was not parseable JSON:', error);
    return jsonError(PROVISIONING_FAILED_MESSAGE, 502);
  }
  const provisionedAt =
    isNonEmptyString(created.created_at) ? created.created_at : new Date().toISOString();
  if (
    !isNonEmptyString(created.id) ||
    !isNonEmptyString(created.account_number) ||
    !isNonEmptyString(created.routing_number)
  ) {
    console.error('Increase account number response is missing pinned fields (id/account_number/routing_number).');
    return jsonError(PROVISIONING_FAILED_MESSAGE, 502);
  }
  const virtualAccount: CovenantVirtualAccount = {
    accountNumberId: created.id,
    accountNumber: created.account_number,
    routingNumber: created.routing_number,
    provisionedAt,
  };

  // Phase 3 — under the row lock again: persist, or return the winner's
  // numbers when a concurrent provision wrote them first.
  try {
    const outcome = await db.transaction<ProvisionOutcome>(async (tx) => {
      const lookup = await findHolderInTx(tx, normalizedAssetId, normalizedHolderId);
      if (!lookup) {
        console.error(
          'Provisioned Increase account number could not be attached — holder vanished between transactions:',
          idempotencyKey,
        );
        throw new ProvisioningError('Rights holder not found.', 404);
      }
      const existing = storedVirtualAccount(lookup.holder);
      if (existing) {
        return { alreadyProvisioned: true, virtualAccount: existing };
      }
      if (typeof lookup.holder !== 'object' || lookup.holder === null) {
        throw new ProvisioningError('Rights holder entry is not provisionable.', 409);
      }
      const holder = lookup.holder as Record<string, unknown>;
      const payoutRouting =
        typeof holder.payoutRouting === 'object' && holder.payoutRouting !== null
          ? { ...(holder.payoutRouting as Record<string, unknown>) }
          : {};
      payoutRouting.covenantVirtualAccount = virtualAccount;
      await writeProvisionedHolderInTx(tx, normalizedAssetId, normalizedHolderId, {
        ...holder,
        payoutRouting,
      });
      return { alreadyProvisioned: false, virtualAccount };
    });
    return Response.json(
      { ok: true, ...outcome.virtualAccount, alreadyProvisioned: outcome.alreadyProvisioned },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ProvisioningError) {
      return jsonError(error.sanitizedMessage, error.status);
    }
    console.error('Provisioning persistence failed:', error);
    return jsonError('Failed to persist the provisioned account numbers.', 500);
  }
}
