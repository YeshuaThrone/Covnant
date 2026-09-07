/**
 * POST + PUT /api/banking — CovnantBankingAPI (Lithic cards + Increase RTP).
 *
 * POST — Lithic real-time card authorization webhook:
 *   HMAC-SHA256 over the raw body vs LITHIC_WEBHOOK_SECRET (length-guarded
 *   timingSafeEqual). Missing secret/signature → 401, bad signature → 403.
 *   Non-authorization events → 200 {result:'CONTINUE'}. For
 *   card_authorization.request the holder is resolved by lithic_card_token,
 *   the available escrow balance is DERIVED from the universal_royalty_ledger
 *   disbursements JSONB (shared escrow math — no stored balance column), and
 *   an approval records a CARD_AUTHORIZATION debit. Every internal error on
 *   the auth path returns 200 {result:'DECLINED', reason:'INTERNAL_ERROR'} —
 *   never a 5xx, because Lithic retries 5xx and would storm a failing
 *   endpoint. Failures are logged server-side instead.
 *
 * PUT — Increase RTP instant disbursement:
 *   Validate → withhold engine tax for unverified profiles (identical rates
 *   and verification logic as the withdraw route) → reserve the gross amount
 *   in-transaction as a PENDING_DISBURSEMENT hold → dispatch the NET payable
 *   to Increase over RTP (Idempotency-Key honored from the client, falling
 *   back to a fresh UUID) → on rejection record a compensating
 *   DISBURSEMENT_REVERSAL and fail with a sanitized error.
 *
 * Balance model: the ledger's disbursements JSONB is the single source of
 * truth. Banking debits are written with the same entry shape as the withdraw
 * route's DISBURSEMENT entries (type 'DISBURSEMENT', smallest-unit payoutAmount
 * strings), so the shared prior-payout math automatically subtracts them.
 * A reversal entry carries a negative payoutAmount — the exact compensating
 * credit under that same sum.
 *
 * Concurrency: there is no per-holder balance row to lock, so both handlers
 * take FOR UPDATE on the holder's rights_holders row first. Concurrent card
 * auths and RTP holds for the SAME holder serialize on that lock (the second
 * transaction reads the ledger aggregate only after the first commits), while
 * different holders never contend.
 *
 * Account numbers: rights_holders.account_number is the FULL destination
 * account number — a deliberate, user-accepted design requirement for Increase
 * RTP (masked numbers cannot drive RTP). It is consumed only by the outbound
 * Increase call and is NEVER returned from any API response or logged.
 *
 * Caller authentication: none, consistent with the locked v1 server-side
 * posture of the PR #23 routes.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb, type Db } from '@/lib/db';
import { formatMicro } from '@/lib/fixed-point';
import {
  escrowBalanceForHolder,
  findRightsHolder,
  UNVERIFIED_FALLBACK_TAX_PROFILE,
  withholdingUnitsOn,
} from '@/lib/escrow/balance';

export const dynamic = 'force-dynamic';

const INCREASE_RTP_URL = 'https://api.increase.com/real_time_payments_transfers';
const LITHIC_AUTH_EVENT = 'card_authorization.request';
const TRANSFER_FAILED_MESSAGE = 'Increase RTP transfer failed.';

/** Disbursements-JSONB audit entry for banking debits/holds/reversals — same core shape as the withdraw route's DISBURSEMENT entries, so the shared escrow math counts them identically. */
interface BankingLedgerEntry {
  type: 'DISBURSEMENT';
  rightsHolderId: string;
  /** Smallest-unit string. Positive = debit (card spend / RTP hold); negative = compensating credit (reversal). */
  payoutAmount: string;
  amountPaid: string;
  taxWithheld: string;
  /** Lithic transaction token (card auth) or the idempotency key (RTP). */
  referenceId?: string;
  idempotencyKey?: string;
  /** Set on reversals: the idempotency key of the failed hold. */
  reversalOf?: string;
  timestamp: number;
  remainingNetBalance: string;
}

interface RightsHolderCardRow {
  id: string;
}

interface RightsHolderBankingRow {
  id: string;
  routing_number: string | null;
  account_number: string | null;
}

interface LedgerDisbursementsRow {
  disbursements: unknown;
}

interface CbtAssetRow {
  rights_holders: unknown;
}

type CardAuthOutcome =
  | { approved: true }
  | { approved: false; reason: 'CARD_NOT_FOUND' | 'INSUFFICIENT_FUNDS' };

interface RtpReservation {
  routingNumber: string;
  accountNumber: string;
  withheldUnits: bigint;
  netPayableUnits: bigint;
  remainingUnits: bigint;
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

/** Positive amount in smallest ledger units: a digit string or an integer number. Floats, signs, and zero are rejected — BigInt boundaries stay exact. */
function parsePositiveUnits(raw: unknown): bigint | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? BigInt(raw) : null;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const units = BigInt(raw);
    return units > 0n ? units : null;
  }
  return null;
}

/** Tax profile from the holder's asset memberships; a holder on no asset withholds at the conservative unverified-foreign rate. */
function taxProfileForHolder(assetRows: CbtAssetRow[], rightsHolderId: string) {
  const holder = findRightsHolder(assetRows, rightsHolderId);
  return holder?.taxProfile ?? UNVERIFIED_FALLBACK_TAX_PROFILE;
}

/** Derived available balance for the holder, read inside an open transaction after the holder-row lock. Reads ONLY the disbursements column, so it works identically before and after any transaction_type DDL. */
async function derivedBalanceInTx(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  rightsHolderId: string,
  taxProfile: ReturnType<typeof taxProfileForHolder>,
) {
  const ledgerRes = await tx.query<LedgerDisbursementsRow>(
    'SELECT disbursements FROM universal_royalty_ledger',
  );
  return escrowBalanceForHolder({
    disbursementsByRow: ledgerRes.rows.map((row) =>
      Array.isArray(row.disbursements) ? row.disbursements : [],
    ),
    rightsHolderId,
    taxProfile,
  });
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
    const requestAmount = parsePositiveUnits(payload.amount);
    const cardToken = payload.card_token;
    if (requestAmount === null || typeof cardToken !== 'string') {
      console.error('Lithic webhook: malformed authorization payload (amount/card_token).');
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

    const outcome = await db.transaction<CardAuthOutcome>(async (tx) => {
      // Lock the holder row: the per-holder serialization point replacing the
      // user draft's FOR UPDATE on the (absent) net_balance_cents column.
      const holderRes = await tx.query<RightsHolderCardRow>(
        'SELECT id FROM rights_holders WHERE lithic_card_token = $1 FOR UPDATE',
        [cardToken],
      );
      if (!holderRes.rows.length) return { approved: false, reason: 'CARD_NOT_FOUND' };
      const rightsHolderId = holderRes.rows[0].id;

      const assetRes = await tx.query<CbtAssetRow>('SELECT rights_holders FROM cbt_assets');
      const taxProfile = taxProfileForHolder(assetRes.rows, rightsHolderId);
      const balance = await derivedBalanceInTx(tx, rightsHolderId, taxProfile);
      if (requestAmount > balance.availableUnits) {
        return { approved: false, reason: 'INSUFFICIENT_FUNDS' };
      }

      const timestamp = Date.now();
      const remainingUnits = balance.availableUnits - requestAmount;
      const entry: BankingLedgerEntry = {
        type: 'DISBURSEMENT',
        rightsHolderId,
        payoutAmount: requestAmount.toString(),
        amountPaid: requestAmount.toString(),
        taxWithheld: '0',
        referenceId: typeof payload.transaction_token === 'string' ? payload.transaction_token : undefined,
        timestamp,
        remainingNetBalance: remainingUnits.toString(),
      };
      await tx.query(
        `INSERT INTO universal_royalty_ledger
           (transaction_id, transaction_type, cbt_code, platform, gross_settled, currency, disbursements)
         VALUES ($1, 'CARD_AUTHORIZATION', 'BANKING-CARD-AUTH', 'LITHIC', $2, 'USD', $3)`,
        [`BANKING-CARD-${timestamp}-${randomUUID()}`, formatMicro(requestAmount), JSON.stringify([entry])],
      );
      return { approved: true };
    });

    if (!outcome.approved) {
      return Response.json(
        { result: 'DECLINED', reason: outcome.reason },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }
    return Response.json({ result: 'APPROVED' }, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // Internal errors on the auth path NEVER return 5xx — Lithic retries
    // those and would storm a failing endpoint. Decline fail-closed instead.
    console.error('Lithic card authorization failed:', error);
    return Response.json(
      { result: 'DECLINED', reason: 'INTERNAL_ERROR' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
}

/** Compensating DISBURSEMENT_REVERSAL after a rejected Increase dispatch. The negative payoutAmount unwinds the failed hold under the shared prior-payout sum. Best-effort: a failed reversal keeps the hold and is logged for manual reconciliation — never thrown, never leaked. */
async function recordDisbursementReversal(
  db: Db,
  params: { rightsHolderId: string; grossUnits: bigint; idempotencyKey: string; restoredUnits: bigint },
): Promise<void> {
  const timestamp = Date.now();
  try {
    const entry: BankingLedgerEntry = {
      type: 'DISBURSEMENT',
      rightsHolderId: params.rightsHolderId,
      payoutAmount: (-params.grossUnits).toString(),
      amountPaid: '0',
      taxWithheld: '0',
      idempotencyKey: params.idempotencyKey,
      reversalOf: params.idempotencyKey,
      timestamp,
      remainingNetBalance: params.restoredUnits.toString(),
    };
    await db.query(
      `INSERT INTO universal_royalty_ledger
         (transaction_id, transaction_type, cbt_code, platform, gross_settled, currency, disbursements)
       VALUES ($1, 'DISBURSEMENT_REVERSAL', 'BANKING-RTP', 'INCREASE', $2, 'USD', $3)`,
      [
        `BANKING-RTP-REVERSAL-${timestamp}-${randomUUID()}`,
        formatMicro(params.grossUnits),
        JSON.stringify([entry]),
      ],
    );
  } catch (error) {
    console.error(
      'DISBURSEMENT_REVERSAL insert failed — the PENDING_DISBURSEMENT hold remains and needs manual reconciliation:',
      error,
    );
  }
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
  const requestedPayout = parsePositiveUnits(body.amountInCents);
  // The ONLY Number conversion in this file is the integer amount inside
  // Increase's JSON body; refuse anything that would not survive it exactly.
  if (requestedPayout === null || requestedPayout > BigInt(Number.MAX_SAFE_INTEGER)) {
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
    reservation = await db.transaction<RtpReservation>(async (tx) => {
      // Lock the holder row first (per-holder serialization point), then
      // derive the balance under that lock.
      const holderRes = await tx.query<RightsHolderBankingRow>(
        'SELECT id, routing_number, account_number FROM rights_holders WHERE id = $1 FOR UPDATE',
        [rightsHolderId],
      );
      if (!holderRes.rows.length) {
        throw new PayoutReservationError('Rights holder not found.', 404);
      }
      const { routing_number: routingNumber, account_number: accountNumber } = holderRes.rows[0];

      const assetRes = await tx.query<CbtAssetRow>('SELECT rights_holders FROM cbt_assets');
      const taxProfile = taxProfileForHolder(assetRes.rows, rightsHolderId);
      const balance = await derivedBalanceInTx(tx, rightsHolderId, taxProfile);
      if (requestedPayout > balance.availableUnits) {
        throw new PayoutReservationError('Insufficient escrow balance for withdrawal.', 422);
      }
      if (!routingNumber || !accountNumber) {
        throw new PayoutReservationError('No verified banking destination found for Increase payout.', 409);
      }

      // Identical withholding treatment to the withdraw route: verified
      // profiles pay nothing now; unverified profiles withhold at the
      // engine's effective rate. Withheld tax stays in escrow for remittance.
      const withheldUnits = taxProfile.isVerified ? 0n : withholdingUnitsOn(requestedPayout, balance.taxRate);
      const netPayableUnits = requestedPayout - withheldUnits;
      const remainingUnits = balance.availableUnits - requestedPayout;
      const timestamp = Date.now();
      const entry: BankingLedgerEntry = {
        type: 'DISBURSEMENT',
        rightsHolderId,
        payoutAmount: requestedPayout.toString(),
        amountPaid: netPayableUnits.toString(),
        taxWithheld: withheldUnits.toString(),
        referenceId: idempotencyKey,
        idempotencyKey,
        timestamp,
        remainingNetBalance: remainingUnits.toString(),
      };
      await tx.query(
        `INSERT INTO universal_royalty_ledger
           (transaction_id, transaction_type, cbt_code, platform, gross_settled, currency, disbursements)
         VALUES ($1, 'PENDING_DISBURSEMENT', 'BANKING-RTP', 'INCREASE', $2, 'USD', $3)`,
        [`BANKING-RTP-${timestamp}-${randomUUID()}`, formatMicro(requestedPayout), JSON.stringify([entry])],
      );
      return { routingNumber, accountNumber, withheldUnits, netPayableUnits, remainingUnits, timestamp };
    });
  } catch (error) {
    if (error instanceof PayoutReservationError) {
      return jsonError(error.sanitizedMessage, error.status);
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
        amount: Number(reservation.netPayableUnits),
        destination_account_number: reservation.accountNumber,
        destination_routing_number: reservation.routingNumber,
        remittance_information: 'Covenant Royalty Escrow Disbursement',
      }),
    });
  } catch (error) {
    console.error('Increase RTP request failed:', error);
    await recordDisbursementReversal(db, {
      rightsHolderId,
      grossUnits: requestedPayout,
      idempotencyKey,
      restoredUnits: reservation.remainingUnits + requestedPayout,
    });
    return jsonError(TRANSFER_FAILED_MESSAGE, 502);
  }
  if (!increaseRes.ok) {
    console.error('Increase RTP transfer rejected:', increaseRes.status);
    await recordDisbursementReversal(db, {
      rightsHolderId,
      grossUnits: requestedPayout,
      idempotencyKey,
      restoredUnits: reservation.remainingUnits + requestedPayout,
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
      amountCents: requestedPayout.toString(),
      taxWithheld: reservation.withheldUnits.toString(),
      netAmountCents: reservation.netPayableUnits.toString(),
      status: increaseData.status ?? null,
      timestamp: reservation.timestamp,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
