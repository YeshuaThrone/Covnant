/**
 * POST + PUT /api/banking — CovnantBankingAPI (Lithic cards + Increase RTP).
 *
 * CBT · Covnant Banking & Tracker (canonical tier definition, Generation 8):
 * "the primary outward-facing Covnant code attached to routing, banking, and
 * royalty tracking so external entities recognize it as Covnant clearing
 * infrastructure." Every ledger row this route writes carries
 * metadata.cbt.settlementCode — the deterministic CBT-SETTLE tracker code
 * derived from the row's own reference_id (same id ⇒ same code, forever).
 *
 * Persistence model (authoritative live Supabase schema):
 * - Rights holders live in the GIN-indexed cbt_assets.rights_holders JSONB
 *   array; each entry carries rightsHolderId and payoutRouting{
 *   lithicCardToken, routingNumber, accountNumber }. There is no standalone
 *   rights_holders table in scope for these routes — every holder lookup
 *   flows through the JSONB, and the matching asset row is locked FOR UPDATE
 *   so concurrent card auths and RTP holds for the same holder serialize.
 * - universal_royalty_ledger is flat: rights_holder_id, amount_cents (BIGINT
 *   integer cents, negative = debit), transaction_type, reference_id (UNIQUE
 *   + indexed), created_at. A holder's available balance is
 *   COALESCE(SUM(amount_cents), 0) over their rows — there is no stored
 *   balance column.
 *
 * POST — Lithic real-time card authorization webhook:
 *   HMAC-SHA256 over the raw body vs LITHIC_WEBHOOK_SECRET (length-guarded
 *   timingSafeEqual). Missing secret/signature → 401, bad signature → 403.
 *   Non-authorization events → 200 {result:'CONTINUE'}. For
 *   card_authorization.request the holder is resolved through the JSONB by
 *   payoutRouting.lithicCardToken, the balance is the locked SUM over the
 *   holder's ledger rows, and an approval records a CARD_AUTHORIZATION debit
 *   (amount_cents = −amount, reference_id = transaction_token). A 23505
 *   unique-violation on reference_id is a webhook replay: the exact event was
 *   already recorded, so it returns 200 APPROVED without a second debit.
 *   Every internal error on the auth path returns 200 {result:'DECLINED',
 *   reason:'INTERNAL_ERROR'} — never a 5xx, because Lithic retries 5xx and
 *   would storm a failing endpoint. Failures are logged server-side instead.
 *
 * PUT — Increase RTP instant disbursement:
 *   Validate integer cents (MAX_SAFE_INTEGER guarded) → withhold engine tax
 *   for unverified profiles (identical rates and verification logic as the
 *   withdraw route: cents convert to engine smallest units ×10⁶, and the net
 *   converts back through an exact whole-cent division — a sub-cent remainder
 *   fails closed with a sanitized 500 rather than rounding escrow dust) →
 *   reserve the net in-transaction as a PENDING_DISBURSEMENT hold
 *   (amount_cents = −net, reference_id = idempotency key; a 23505 there means
 *   a duplicate submission and returns 409 — never a second hold) → dispatch
 *   the net to Increase over RTP with the client's Idempotency-Key (UUID
 *   fallback) → on rejection record a compensating DISBURSEMENT_REVERSAL
 *   (amount_cents = +net, reference_id = 'reversal-' + key) and fail with a
 *   sanitized error.
 *
 * Account numbers: payoutRouting.accountNumber is the FULL destination
 * account number — a deliberate, user-accepted design requirement for
 * Increase RTP (masked numbers cannot drive RTP). It is consumed only by the
 * outbound Increase call and is NEVER returned from any API response or
 * logged.
 *
 * Caller authentication: none, consistent with the locked v1 server-side
 * posture of the PR #23 routes.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb, type Db } from '@/lib/db';
import {
  UNVERIFIED_FALLBACK_TAX_PROFILE,
  taxRateForProfile,
  withholdingUnitsOn,
} from '@/lib/escrow/balance';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { centsToEngineUnits, engineUnitsToCents, SubUnitRemainderError } from './denomination';
import { cbtSettlementMetadataSql } from '@/lib/ledger/cbt-settlement';

export const dynamic = 'force-dynamic';

const INCREASE_RTP_URL = 'https://api.increase.com/real_time_payments_transfers';
const LITHIC_AUTH_EVENT = 'card_authorization.request';
const TRANSFER_FAILED_MESSAGE = 'Increase RTP transfer failed.';
const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_UNDEFINED_COLUMN = '42703';

interface LedgerAvailableRow {
  /** pg BIGINT/NUMERIC arrive as strings — BigInt(str) only, never Number. */
  available_cents: string;
}

interface CardHolderRow {
  rights_holder_id: string;
}

interface JsonbHolderRow {
  holder: unknown;
}

interface ParsedHolder {
  routingNumber: unknown;
  accountNumber: unknown;
  taxProfile: TaxProfile | null;
}

type CardAuthOutcome =
  | { approved: true }
  | { approved: false; reason: 'CARD_NOT_FOUND' | 'INSUFFICIENT_FUNDS' };

interface RtpReservation {
  routingNumber: string;
  accountNumber: string;
  withheldCents: bigint;
  netCents: bigint;
  timestamp: number;
}

/** Reservation failure with an already-sanitized client message and status. */
class PayoutReservationError extends Error {
  constructor(
    readonly sanitizedMessage: string,
    readonly status: number,
  ) {
    super(sanitizedMessage);
    this.name = 'PayoutReservationError';
  }
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

/** Postgres unique-violation probe (e.g. the ledger's UNIQUE reference_id). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  );
}

/** Postgres undefined-column probe (universal_royalty_ledger.metadata not yet added). */
function isUndefinedColumn(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === POSTGRES_UNDEFINED_COLUMN
  );
}

/** Positive integer cents: a digit string or an integer number. Floats, signs, and zero are rejected — BigInt boundaries stay exact. */
function parsePositiveCents(raw: unknown): bigint | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? BigInt(raw) : null;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const cents = BigInt(raw);
    return cents > 0n ? cents : null;
  }
  return null;
}

/** Holder entry as stored in cbt_assets.rights_holders JSONB — untrusted data, fields validated before use. */
function parseHolderEntry(raw: unknown): ParsedHolder | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as { payoutRouting?: unknown; taxProfile?: unknown };
  const routing =
    typeof entry.payoutRouting === 'object' && entry.payoutRouting !== null
      ? (entry.payoutRouting as { routingNumber?: unknown; accountNumber?: unknown })
      : null;
  return {
    routingNumber: routing?.routingNumber,
    accountNumber: routing?.accountNumber,
    taxProfile: (entry.taxProfile ?? null) as TaxProfile | null,
  };
}

/** The per-holder available balance: the flat ledger SUM, read inside an open transaction after the holder lock. */
async function availableCentsInTx(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  rightsHolderId: string,
): Promise<bigint> {
  const balanceRes = await tx.query<LedgerAvailableRow>(
    'SELECT COALESCE(SUM(amount_cents), 0) AS available_cents FROM universal_royalty_ledger WHERE rights_holder_id = $1',
    [rightsHolderId],
  );
  return BigInt(balanceRes.rows[0].available_cents);
}

/**
 * The card-authorization transaction: lock the holder through the JSONB,
 * derive the balance under the lock, and record the CARD_AUTHORIZATION debit.
 * `withMetadata` selects the INSERT variant — carrying the deterministic CBT
 * settlement code, or bare for the 42703 fallback retry. The parameter list
 * stays exactly three values in both variants (frozen contract).
 */
async function authorizeCardInTx(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  params: {
    cardToken: string;
    requestAmountCents: bigint;
    transactionToken: string;
    withMetadata: boolean;
  },
): Promise<CardAuthOutcome> {
  // Lock the matching asset row through the JSONB (the GIN index serves
  // the filter): the per-holder serialization point for card auths and
  // RTP holds alike.
  const holderRes = await tx.query<CardHolderRow>(
    `SELECT rh->>'rightsHolderId' AS rights_holder_id
       FROM cbt_assets, jsonb_array_elements(rights_holders) AS rh
      WHERE rh->'payoutRouting'->>'lithicCardToken' = $1
      FOR UPDATE`,
    [params.cardToken],
  );
  if (!holderRes.rows.length) return { approved: false, reason: 'CARD_NOT_FOUND' };
  const rightsHolderId = holderRes.rows[0].rights_holder_id;

  const availableCents = await availableCentsInTx(tx, rightsHolderId);
  if (params.requestAmountCents > availableCents) {
    return { approved: false, reason: 'INSUFFICIENT_FUNDS' };
  }

  await tx.query(
    params.withMetadata
      ? `INSERT INTO universal_royalty_ledger
           (rights_holder_id, amount_cents, transaction_type, reference_id, created_at, metadata)
         VALUES ($1, $2, 'CARD_AUTHORIZATION', $3, NOW(), ${cbtSettlementMetadataSql(params.transactionToken)})`
      : `INSERT INTO universal_royalty_ledger
           (rights_holder_id, amount_cents, transaction_type, reference_id, created_at)
         VALUES ($1, $2, 'CARD_AUTHORIZATION', $3, NOW())`,
    [rightsHolderId, (-params.requestAmountCents).toString(), params.transactionToken],
  );
  return { approved: true };
}

interface LithicWebhookPayload {
  event_type?: unknown;
  card_token?: unknown;
  amount?: unknown;
  transaction_token?: unknown;
}

// 1. LITHIC REAL-TIME AUTHORIZATION WEBHOOK
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature =
    request.headers.get('lithic-signature') ?? request.headers.get('x-lithic-signature');
  const webhookSecret = process.env.LITHIC_WEBHOOK_SECRET;
  if (!webhookSecret || !signature) {
    return Response.json(
      { error: 'Unauthorized: signature missing' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }
  const expectedDigest = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedDigest);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return Response.json(
      { error: 'Invalid HMAC signature' },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const parsed: unknown = JSON.parse(rawBody);
    const payload = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as LithicWebhookPayload;
    if (payload.event_type !== LITHIC_AUTH_EVENT) {
      return Response.json({ result: 'CONTINUE' }, { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    const requestAmountCents = parsePositiveCents(payload.amount);
    const cardToken = payload.card_token;
    const transactionToken = payload.transaction_token;
    if (
      requestAmountCents === null ||
      typeof cardToken !== 'string' ||
      typeof transactionToken !== 'string'
    ) {
      console.error('Lithic webhook: malformed authorization payload (amount/card_token/transaction_token).');
      return Response.json(
        { result: 'DECLINED', reason: 'INTERNAL_ERROR' },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }
    const db = getDb();
    if (!db) {
      console.error('Lithic webhook: DATABASE_URL is not configured; declining fail-closed.');
      return Response.json(
        { result: 'DECLINED', reason: 'INTERNAL_ERROR' },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    const outcome = await db.transaction<CardAuthOutcome>((tx) =>
      authorizeCardInTx(tx, {
        cardToken,
        requestAmountCents,
        transactionToken,
        withMetadata: true,
      }),
    ).catch(async (error) => {
      if (!isUndefinedColumn(error)) throw error;
      // 42703: the additive metadata column is absent — re-run the whole
      // reservation in a FRESH transaction without the settlement code. The
      // failed transaction rolled back (nothing written; the ledger stays
      // append-only), so the money still moves — the PR #26 fallback
      // guarantee at transaction granularity.
      return db.transaction<CardAuthOutcome>((tx) =>
        authorizeCardInTx(tx, {
          cardToken,
          requestAmountCents,
          transactionToken,
          withMetadata: false,
        }),
      );
    });

    if (!outcome.approved) {
      return Response.json(
        { result: 'DECLINED', reason: outcome.reason },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }
    return Response.json({ result: 'APPROVED' }, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // UNIQUE (reference_id) rejected the debit: this transaction_token was
      // already recorded — a webhook replay. Approve without a second debit.
      return Response.json({ result: 'APPROVED' }, { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    // Internal errors on the auth path NEVER return 5xx — Lithic retries
    // those and would storm a failing endpoint. Decline fail-closed instead.
    console.error('Lithic card authorization failed:', error);
    return Response.json(
      { result: 'DECLINED', reason: 'INTERNAL_ERROR' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
}

/**
 * Compensating DISBURSEMENT_REVERSAL after a rejected Increase dispatch: +net
 * cents unwinds the failed hold under the flat SUM. Carries the deterministic
 * CBT settlement code like every ledger write; on 42703 (the additive
 * metadata column absent) the retry drops the code — an autocommit statement
 * aborts only itself, so the unwind still lands. Best-effort: a failed
 * reversal keeps the hold and is logged for manual reconciliation — never
 * thrown, never leaked.
 */
async function recordDisbursementReversal(
  db: Db,
  params: { rightsHolderId: string; netCents: bigint; idempotencyKey: string },
): Promise<void> {
  const referenceId = `reversal-${params.idempotencyKey}`;
  try {
    await db.query(
      `INSERT INTO universal_royalty_ledger
         (rights_holder_id, amount_cents, transaction_type, reference_id, created_at, metadata)
       VALUES ($1, $2, 'DISBURSEMENT_REVERSAL', $3, NOW(), ${cbtSettlementMetadataSql(referenceId)})`,
      [params.rightsHolderId, params.netCents.toString(), referenceId],
    );
  } catch (error) {
    if (!isUndefinedColumn(error)) {
      console.error(
        'DISBURSEMENT_REVERSAL insert failed — the PENDING_DISBURSEMENT hold remains and needs manual reconciliation:',
        error,
      );
      return;
    }
    try {
      await db.query(
        `INSERT INTO universal_royalty_ledger
           (rights_holder_id, amount_cents, transaction_type, reference_id, created_at)
         VALUES ($1, $2, 'DISBURSEMENT_REVERSAL', $3, NOW())`,
        [params.rightsHolderId, params.netCents.toString(), referenceId],
      );
    } catch (retryError) {
      console.error(
        'DISBURSEMENT_REVERSAL insert failed — the PENDING_DISBURSEMENT hold remains and needs manual reconciliation:',
        retryError,
      );
    }
  }
}

/**
 * The RTP reservation transaction: lock the holder, derive the balance and
 * engine tax under the lock, and record the PENDING_DISBURSEMENT hold.
 * `withMetadata` selects the INSERT variant — carrying the deterministic CBT
 * settlement code, or bare for the 42703 fallback retry. The parameter list
 * stays exactly three values in both variants (frozen contract).
 */
async function reserveDisbursementInTx(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  params: {
    rightsHolderId: string;
    requestedPayoutCents: bigint;
    idempotencyKey: string;
    withMetadata: boolean;
  },
): Promise<RtpReservation> {
  // Lock the matching asset row first (per-holder serialization point),
  // then derive the balance under that lock.
  const holderRes = await tx.query<JsonbHolderRow>(
    `SELECT rh AS holder
       FROM cbt_assets, jsonb_array_elements(rights_holders) AS rh
      WHERE rh->>'rightsHolderId' = $1
      FOR UPDATE`,
    [params.rightsHolderId],
  );
  if (!holderRes.rows.length) {
    throw new PayoutReservationError('Rights holder not found.', 404);
  }
  const holder = parseHolderEntry(holderRes.rows[0].holder);

  const availableCents = await availableCentsInTx(tx, params.rightsHolderId);
  if (params.requestedPayoutCents > availableCents) {
    throw new PayoutReservationError('Insufficient escrow balance for withdrawal.', 422);
  }
  const routingNumber = holder?.routingNumber;
  const accountNumber = holder?.accountNumber;
  if (
    typeof routingNumber !== 'string' ||
    routingNumber === '' ||
    typeof accountNumber !== 'string' ||
    accountNumber === ''
  ) {
    throw new PayoutReservationError('No verified banking destination found for Increase payout.', 409);
  }

  // Identical withholding treatment to the withdraw route: verified
  // profiles pay nothing now; unverified profiles withhold at the
  // engine's effective rate. Cents convert to engine smallest units
  // (×10⁶), the rate applies in exact BigInt, and the net converts back
  // with a whole-cent exactness assertion — a sub-cent remainder fails
  // closed instead of rounding escrow dust. Withheld tax never leaves
  // escrow: only the net is debited.
  const taxProfile = holder?.taxProfile ?? UNVERIFIED_FALLBACK_TAX_PROFILE;
  const requestedUnits = centsToEngineUnits(params.requestedPayoutCents);
  const withheldUnits = taxProfile.isVerified
    ? 0n
    : withholdingUnitsOn(requestedUnits, taxRateForProfile(taxProfile));
  const netCents = engineUnitsToCents(requestedUnits - withheldUnits);

  await tx.query(
    params.withMetadata
      ? `INSERT INTO universal_royalty_ledger
           (rights_holder_id, amount_cents, transaction_type, reference_id, created_at, metadata)
         VALUES ($1, $2, 'PENDING_DISBURSEMENT', $3, NOW(), ${cbtSettlementMetadataSql(params.idempotencyKey)})`
      : `INSERT INTO universal_royalty_ledger
           (rights_holder_id, amount_cents, transaction_type, reference_id, created_at)
         VALUES ($1, $2, 'PENDING_DISBURSEMENT', $3, NOW())`,
    [params.rightsHolderId, (-netCents).toString(), params.idempotencyKey],
  );
  return {
    routingNumber,
    accountNumber,
    withheldCents: params.requestedPayoutCents - netCents,
    netCents,
    timestamp: Date.now(),
  };
}

interface IncreasePayoutBody {
  rightsHolderId?: unknown;
  amountInCents?: unknown;
  idempotencyKey?: unknown;
}

// 2. INCREASE INSTANT RTP DISBURSEMENT
export async function PUT(request: Request): Promise<Response> {
  let body: IncreasePayoutBody;
  try {
    body = (await request.json()) as IncreasePayoutBody;
  } catch {
    return jsonError('Request body must be valid JSON with rightsHolderId and amountInCents.', 400);
  }
  const rightsHolderId = body.rightsHolderId;

  if (typeof rightsHolderId !== 'string' || rightsHolderId.trim() === '') {
    return jsonError('Invalid payout parameters', 400);
  }
  const requestedPayoutCents = parsePositiveCents(body.amountInCents);
  // The ONLY Number conversion in this file is the integer amount inside
  // Increase's JSON body; refuse anything that would not survive it exactly.
  if (requestedPayoutCents === null || requestedPayoutCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    return jsonError('Invalid payout parameters', 400);
  }

  // Idempotency: honor the client's key when supplied (header or body) — a
  // fresh UUID per attempt would not protect client retries.
  const headerKey = request.headers.get('idempotency-key')?.trim();
  const bodyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const idempotencyKey = headerKey || bodyKey || randomUUID();

  const increaseApiKey = process.env.INCREASE_API_KEY;
  const sourceAccountId = process.env.INCREASE_SOURCE_ACCOUNT_ID;
  if (!increaseApiKey || !sourceAccountId) {
    return jsonError('Increase is not configured (INCREASE_API_KEY / INCREASE_SOURCE_ACCOUNT_ID).', 503);
  }
  const db = getDb();
  if (!db) {
    return jsonError('Database is not configured (DATABASE_URL).', 503);
  }

  let reservation: RtpReservation;
  try {
    reservation = await db.transaction<RtpReservation>((tx) =>
      reserveDisbursementInTx(tx, {
        rightsHolderId,
        requestedPayoutCents,
        idempotencyKey,
        withMetadata: true,
      }),
    ).catch(async (error) => {
      if (!isUndefinedColumn(error)) throw error;
      // 42703: the additive metadata column is absent — re-reserve in a
      // FRESH transaction without the settlement code. The failed
      // transaction rolled back (nothing written; the ledger stays
      // append-only), so the money still moves — the PR #26 fallback
      // guarantee at transaction granularity.
      return db.transaction<RtpReservation>((tx) =>
        reserveDisbursementInTx(tx, {
          rightsHolderId,
          requestedPayoutCents,
          idempotencyKey,
          withMetadata: false,
        }),
      );
    });
  } catch (error) {
    if (error instanceof PayoutReservationError) {
      return jsonError(error.sanitizedMessage, error.status);
    }
    if (error instanceof SubUnitRemainderError) {
      console.error('Increase RTP payout is not representable in whole cents:', error);
      return jsonError('Payout cannot be represented in whole cents.', 500);
    }
    if (isUniqueViolation(error)) {
      // UNIQUE (reference_id) rejected the hold: this idempotency key has
      // already reserved a disbursement. Never hold twice for one key.
      return jsonError('disbursement already in progress for this idempotency key', 409);
    }
    console.error('Increase RTP reservation failed:', error);
    return jsonError('Failed to reserve the disbursement.', 502);
  }

  // account_number only ever crosses this boundary into the outbound
  // Increase call — never into a response, a log line, or a ledger entry.
  let increaseRes: Response;
  try {
    increaseRes = await fetch(INCREASE_RTP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${increaseApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        source_account_id: sourceAccountId,
        amount: Number(reservation.netCents),
        destination_account_number: reservation.accountNumber,
        destination_routing_number: reservation.routingNumber,
        remittance_information: 'Covenant Royalty Escrow Disbursement',
      }),
    });
  } catch (error) {
    console.error('Increase RTP request failed:', error);
    await recordDisbursementReversal(db, {
      rightsHolderId,
      netCents: reservation.netCents,
      idempotencyKey,
    });
    return jsonError(TRANSFER_FAILED_MESSAGE, 502);
  }
  if (!increaseRes.ok) {
    console.error('Increase RTP transfer rejected:', increaseRes.status);
    await recordDisbursementReversal(db, {
      rightsHolderId,
      netCents: reservation.netCents,
      idempotencyKey,
    });
    return jsonError(TRANSFER_FAILED_MESSAGE, 502);
  }
  let increaseData: { id?: string; status?: string };
  try {
    increaseData = (await increaseRes.json()) as { id?: string; status?: string };
  } catch (error) {
    // 2xx with an unparseable body: the transfer outcome is unknown — keep
    // the hold (conservative: never release funds that may have moved).
    console.error('Increase RTP response was not parseable JSON:', error);
    return jsonError(TRANSFER_FAILED_MESSAGE, 502);
  }

  return Response.json(
    {
      ok: true,
      disbursementId: increaseData.id ?? null,
      amountCents: requestedPayoutCents.toString(),
      taxWithheld: reservation.withheldCents.toString(),
      netAmountCents: reservation.netCents.toString(),
      status: increaseData.status ?? null,
      timestamp: reservation.timestamp,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
