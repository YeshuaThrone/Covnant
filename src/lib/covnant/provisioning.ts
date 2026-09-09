/**
 * Shared Increase virtual-account provisioning core — CovnantRoyaltyTrackingAPI.
 *
 * CBT · Covnant Banking & Tracker (canonical tier definition, Generation 8):
 * "the primary outward-facing Covnant code attached to routing, banking, and
 * royalty tracking so external entities recognize it as Covnant clearing
 * infrastructure." Provisioning hands each rights holder the routing
 * surface the CBT tier governs — the Increase Account Number distributors
 * and PROs pay royalties into — while the ledger rows its credits produce
 * carry the tier's deterministic settlement codes (metadata.cbt, see
 * src/lib/ledger/cbt-settlement.ts).
 *
 * Extracted verbatim from POST /api/covnant/accounts/provision (PR #26) so
 * that route and the instant sign-up route (/api/covnant/auth/signup) run
 * the EXACT same provisioning flow. Callers own their own request validation
 * and environment checks; this module owns the three phases:
 *
 * Phase 1 — under a FOR UPDATE row lock on the holder's cbt_assets row, an
 * already-provisioned holder short-circuits BEFORE the Increase call
 * (idempotent), and the lock is released so the external call never holds a
 * database transaction open.
 *
 * Phase 2 — the Increase POST /account_numbers call happens outside any
 * transaction. The deterministic Idempotency-Key (ASCII ≤ 200 chars) makes
 * concurrent first-time provisions converge on a single Account Number
 * object at Increase.
 *
 * Phase 3 — under the row lock again: persist
 * payoutRouting.covenantVirtualAccount, or return the winner's stored
 * numbers when a concurrent provision wrote them first.
 *
 * Callers map the returned ProvisioningOutcome to their own HTTP contract:
 * the provision route echoes account numbers, while the pre-auth sign-up
 * route returns status fields only.
 */

import type { Db } from '@/lib/db';

export const INCREASE_ACCOUNT_NUMBERS_URL = 'https://api.increase.com/account_numbers';

/** The Covnant virtual-account block persisted under payoutRouting. */
export interface CovenantVirtualAccount {
  accountNumberId: string;
  accountNumber: string;
  routingNumber: string;
  provisionedAt: string;
}

/** Connection-scoped query surface handed to a db.transaction callback. */
export type TxClient = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ProvisioningInput {
  assetId: string;
  rightsHolderId: string;
  increaseApiKey: string;
  sourceAccountId: string;
}

/**
 * Terminal provisioning outcomes. Callers translate each status into their
 * own sanitized HTTP response (statuses, messages, and which fields are
 * safe to echo are caller concerns, not core concerns).
 */
export type ProvisioningOutcome =
  /** Phase 1 found no holder row for (assetId, rightsHolderId). */
  | { status: 'HOLDER_NOT_FOUND' }
  /**
   * The holder already carried a stored virtual account — either the phase 1
   * short-circuit or a concurrent provision that won the race (no second
   * Increase object, no second write).
   */
  | { status: 'ALREADY_PROVISIONED'; virtualAccount: CovenantVirtualAccount }
  /** This call freshly provisioned and persisted the virtual account. */
  | { status: 'PROVISIONED'; virtualAccount: CovenantVirtualAccount }
  /** The holder entry is not a JSON object and cannot carry payoutRouting. */
  | { status: 'HOLDER_NOT_PROVISIONABLE' }
  /** The holder vanished between phase 1 and phase 3; the created Increase number is logged for reconciliation. */
  | { status: 'HOLDER_VANISHED'; idempotencyKey: string }
  /** Increase was unreachable, rejected the call, or returned a malformed/incomplete object. */
  | { status: 'INCREASE_UNAVAILABLE' }
  /** Phase 3 persistence failed for a non-provisioning reason (transaction error). */
  | { status: 'PERSISTENCE_FAILED' };

/** Provisioning failure with an already-sanitized client message and status (internal). */
class ProvisioningError extends Error {
  constructor(
    readonly sanitizedMessage: string,
    readonly status: number,
  ) {
    super(sanitizedMessage);
    this.name = 'ProvisioningError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

interface JsonbHolderRow {
  holder: unknown;
}

/** Increase Account Number object — only the pinned fields this core consumes. */
interface IncreaseAccountNumber {
  id?: unknown;
  account_number?: unknown;
  routing_number?: unknown;
  created_at?: unknown;
}

/** Reads the holder's stored Covnant virtual account, if fully provisioned. */
export function storedVirtualAccount(holder: unknown): CovenantVirtualAccount | null {
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

/**
 * The pinned Increase POST /account_numbers call: Increase resource contract
 * (field names pinned from the official API reference,
 * https://increase.com/documentation/api/account-numbers) and the
 * deterministic idempotency key from the (assetId, rightsHolderId) pair.
 * Resolves null when the call did not yield a usable Account Number.
 */
async function createIncreaseAccountNumber(
  increaseApiKey: string,
  sourceAccountId: string,
  idempotencyKey: string,
): Promise<IncreaseAccountNumber | null> {
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
    return null;
  }
  if (!increaseRes.ok) {
    console.error('Increase account number creation rejected:', increaseRes.status);
    return null;
  }
  let created: IncreaseAccountNumber;
  try {
    created = (await increaseRes.json()) as IncreaseAccountNumber;
  } catch (error) {
    console.error('Increase account number response was not parseable JSON:', error);
    return null;
  }
  if (
    !isNonEmptyString(created.id) ||
    !isNonEmptyString(created.account_number) ||
    !isNonEmptyString(created.routing_number)
  ) {
    console.error('Increase account number response is missing pinned fields (id/account_number/routing_number).');
    return null;
  }
  return created;
}

/**
 * Runs the full three-phase provisioning flow for one rights holder.
 * Throws nothing — every failure mode is a ProvisioningOutcome status, so
 * callers cannot end up with an unhandled rejection on a product path.
 */
export async function provisionRightsHolderVirtualAccount(
  db: Db,
  input: ProvisioningInput,
): Promise<ProvisioningOutcome> {
  const { assetId, rightsHolderId, increaseApiKey, sourceAccountId } = input;

  // Phase 1 — under the row lock: resolve the holder, short-circuit when
  // already provisioned (idempotent, NO Increase call), otherwise release
  // the lock so the external call never holds a database transaction open.
  const firstLookup = await db.transaction<
    | { alreadyProvisioned: true; virtualAccount: CovenantVirtualAccount }
    | { alreadyProvisioned: false }
    | null
  >(async (tx) => {
    const lookup = await findHolderInTx(tx, assetId, rightsHolderId);
    if (!lookup) return null;
    const existing = storedVirtualAccount(lookup.holder);
    if (existing) {
      return { alreadyProvisioned: true, virtualAccount: existing };
    }
    return { alreadyProvisioned: false };
  });
  if (firstLookup === null) {
    return { status: 'HOLDER_NOT_FOUND' };
  }
  if (firstLookup.alreadyProvisioned) {
    return { status: 'ALREADY_PROVISIONED', virtualAccount: firstLookup.virtualAccount };
  }

  // Phase 2 — the Increase call, outside any database transaction. The
  // deterministic Idempotency-Key makes concurrent first-time provisions
  // converge on a single Account Number object at Increase.
  const idempotencyKey = `covenant-royalty-tracking:${encodeURIComponent(assetId)}:${encodeURIComponent(rightsHolderId)}`;
  const created = await createIncreaseAccountNumber(
    increaseApiKey,
    sourceAccountId,
    idempotencyKey,
  );
  if (!created) {
    return { status: 'INCREASE_UNAVAILABLE' };
  }
  const virtualAccount: CovenantVirtualAccount = {
    accountNumberId: created.id as string,
    accountNumber: created.account_number as string,
    routingNumber: created.routing_number as string,
    provisionedAt: isNonEmptyString(created.created_at)
      ? created.created_at
      : new Date().toISOString(),
  };

  // Phase 3 — under the row lock again: persist, or return the winner's
  // numbers when a concurrent provision wrote them first.
  try {
    const outcome = await db.transaction<
      | { alreadyProvisioned: true; virtualAccount: CovenantVirtualAccount }
      | { alreadyProvisioned: false; virtualAccount: CovenantVirtualAccount }
    >(async (tx) => {
      const lookup = await findHolderInTx(tx, assetId, rightsHolderId);
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
      await writeProvisionedHolderInTx(tx, assetId, rightsHolderId, {
        ...holder,
        payoutRouting,
      });
      return { alreadyProvisioned: false, virtualAccount };
    });
    return outcome.alreadyProvisioned
      ? { status: 'ALREADY_PROVISIONED', virtualAccount: outcome.virtualAccount }
      : { status: 'PROVISIONED', virtualAccount: outcome.virtualAccount };
  } catch (error) {
    if (error instanceof ProvisioningError) {
      return error.status === 404
        ? { status: 'HOLDER_VANISHED', idempotencyKey }
        : { status: 'HOLDER_NOT_PROVISIONABLE' };
    }
    console.error('Provisioning persistence failed:', error);
    return { status: 'PERSISTENCE_FAILED' };
  }
}
