/**
 * POST /api/payouts/withdraw — escrow payout via Plaid ACH transfer.
 *
 * Flow: validate → load the holder's connected payout account → compute the
 * balance through the shared escrow helper (same math as the dashboard, so
 * the two surfaces can never disagree; pending withdrawal intents already
 * subtracted) → withhold tax for unverified profiles → RESERVE the
 * withdrawal as a pending intent (migration 0058 — the atomic
 * conditional-debit RPC everything after it must get past) → authorize +
 * create the Plaid transfer → record the payout as a DISBURSEMENT ledger
 * row (transaction_id deterministic from the intent) → settle the intent.
 *
 * Intent-first ordering closes the two withdraw-path P1s from the tax audit
 * (note_c5ksDgVw): the pending hold is inserted BEFORE dispatch, so a
 * concurrent second withdrawal of the same funds serializes behind it and
 * refuses (#4, the TOCTOU double-spend), and a failed DISBURSEMENT insert
 * leaves the hold standing — the funds stay blocked until the intent is
 * settled or released, instead of opening a repeat-withdrawal window (#5).
 * An authoritative Plaid refusal (no transfer exists) releases the hold; an
 * outcome-UNKNOWN dispatch failure (network drop mid-call, unparseable 2xx
 * body) keeps it pending — never release funds that may have moved.
 * Settlement of a stuck intent from the recorded Plaid ids is a state flip
 * for the reconciliation/webhook path.
 *
 * `amount` is a string-formatted BigInt in smallest ledger units (1e-8
 * scale). Conversion to Plaid's decimal-string amount happens ONLY at the
 * Plaid boundary via smallestUnitsToPlaidAmount. Environment is read lazily
 * inside the handler (503 when unconfigured); Plaid failures return a
 * sanitized 502 that never echoes secrets or upstream payloads.
 *
 * GATED (hardening gen 12 — this route could move ANY holder's escrow to
 * ANY connected bank account before): the holder identity is DERIVED from
 * the verified creator session; a body rightsHolderId is only a claim to
 * verify — a signed-in creator requesting another holder's withdrawal is
 * refused 403 before any read runs. An operator (signed admin cookie) may
 * initiate a withdrawal for a named holder.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseFromEnv } from '@/lib/supabase';
import { requireHolderAccess } from '@/lib/server/apiAccess';
import { formatMicro } from '@/lib/fixed-point';
import { isMissingMetadataColumnError, METADATA_COLUMN_DDL_NOTE, stampSupabaseLedgerRow } from '@/lib/ledger/cbt-settlement';
import {
  fetchEscrowBalance,
  findRightsHolder,
  smallestUnitsToPlaidAmount,
  UNVERIFIED_FALLBACK_TAX_PROFILE,
  withholdingUnitsOn,
} from '@/lib/escrow/balance';
import {
  releaseEscrowWithdrawal,
  reserveEscrowWithdrawal,
  settleEscrowWithdrawal,
  type EscrowWithdrawalReservation,
} from '@/lib/escrow/withdrawalIntents';
import { checkSharedRateLimit, MONEY_INITIATION_RATE_LIMIT } from '@/lib/server/rateLimit';
import { clientAddress } from '@/lib/server/clientAddress';

export const dynamic = 'force-dynamic';

const PLAID_HOST = 'https://production.plaid.com';

interface WithdrawBody {
  rightsHolderId?: unknown;
  amount?: unknown;
  currency?: unknown;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Best-effort compensating release after an authoritative rail failure —
 * the transfer was refused, so no transfer exists and the hold must
 * unblock the funds. A failed release leaves the intent pending (funds
 * over-held, never over-paid) and is logged for reconciliation, mirroring
 * the banking route's DISBURSEMENT_REVERSAL posture.
 */
async function releaseBestEffort(db: SupabaseClient, intentId: string): Promise<void> {
  try {
    const released = await releaseEscrowWithdrawal(db, intentId);
    if (!released) {
      console.error(
        `Withdrawal intent ${intentId} was not pending at release — check escrow_withdrawal_intents.`,
      );
    }
  } catch (error) {
    console.error(
      `Withdrawal intent ${intentId} release failed — the hold remains pending and needs reconciliation:`,
      error,
    );
  }
}

/** Amount must be a plain positive BigInt string of smallest ledger units. */
function parseAmount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const units = BigInt(raw);
  return units > 0n ? units : null;
}

export async function POST(request: Request): Promise<Response> {
  // Shared limiter first (audit M5): the money-initiation window (5/min) burns
  // before the session round-trips, so a flood never reaches Supabase Auth.
  const limit = await checkSharedRateLimit(
    `payouts-withdraw:${clientAddress(request)}`,
    MONEY_INITIATION_RATE_LIMIT,
  );
  if (!limit.ok) {
    return jsonError(`Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`, 429);
  }

  let body: WithdrawBody;
  try {
    body = (await request.json()) as WithdrawBody;
  } catch {
    return jsonError('Request body must be valid JSON with rightsHolderId and amount.', 400);
  }
  const suppliedHolderId = typeof body.rightsHolderId === 'string' ? body.rightsHolderId : null;

  // Identity before any holder data is touched: the session (or operator
  // cookie) decides whose escrow may move; a mismatched client claim is
  // refused before the balance, the payout account, or Plaid is reached.
  const access = await requireHolderAccess(request, suppliedHolderId);
  if (!access.ok) {
    return jsonError(access.message, access.status);
  }
  const rightsHolderId = access.holderId;
  if (!rightsHolderId) {
    // Operator path with no holder named — a creator session always
    // implies its own holder, so this is unreachable for owners.
    return jsonError('rightsHolderId is required.', 400);
  }
  const amount = body.amount;
  const amountUnits = parseAmount(amount);
  if (amountUnits === null) {
    return jsonError('amount must be a positive BigInt string in smallest ledger units (e.g. "100000000").', 400);
  }
  const currency = body.currency ?? 'USD';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return jsonError('currency must be a 3-letter ISO code (e.g. "USD").', 400);
  }

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    return jsonError('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).', 503);
  }
  const db = supabaseFromEnv();
  if (!db) {
    return jsonError('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).', 503);
  }

  // Payout account must be connected first (exchange-token route).
  const { data: holderRow, error: holderError } = await db
    .from('rights_holders')
    .select('plaid_access_token, plaid_account_id, method')
    .eq('id', rightsHolderId)
    .maybeSingle();
  if (holderError) {
    console.error('rights_holders read failed:', holderError.message);
    return jsonError('Failed to load payout account.', 502);
  }
  const payoutAccount = holderRow as { plaid_access_token?: string | null; plaid_account_id?: string | null } | null;
  if (!payoutAccount?.plaid_access_token || !payoutAccount?.plaid_account_id) {
    return jsonError('Payout account is not connected for this rights holder.', 409);
  }

  // Tax profile from the holder's asset memberships; a holder on no asset
  // withholds at the conservative unverified-foreign rate.
  const { data: assetRows, error: assetsError } = await db.from('cbt_assets').select('rights_holders');
  if (assetsError) {
    console.error('cbt_assets read failed:', assetsError.message);
    return jsonError('Failed to load tax profile.', 502);
  }
  const holder = findRightsHolder(assetRows ?? [], rightsHolderId);
  const taxProfile = holder?.taxProfile ?? UNVERIFIED_FALLBACK_TAX_PROFILE;

  // Shared balance math — identical to the dashboard by construction.
  const balance = await fetchEscrowBalance(db, rightsHolderId, taxProfile);
  if (amountUnits > balance.availableUnits) {
    return jsonError('Withdrawal amount exceeds the available escrow balance.', 422);
  }

  // Verified profiles pay nothing now; unverified profiles withhold at the
  // engine's effective rate. Withheld tax stays in escrow for remittance.
  const withheldUnits = taxProfile.isVerified
    ? 0n
    : withholdingUnitsOn(amountUnits, balance.taxRate);
  const netPayableUnits = amountUnits - withheldUnits;
  const plaidAmount = smallestUnitsToPlaidAmount(netPayableUnits);
  const remainingUnits = balance.availableUnits - amountUnits;

  // Intent-first gate (audit note_c5ksDgVw #4/#5): the pending-debit hold is
  // what the Plaid call must get past. The RPC re-derives the balance
  // server-side under a per-holder advisory lock and inserts the intent row
  // only when the floor holds — a concurrent second withdrawal of the same
  // funds serializes behind the first and refuses. The TS pre-check above is
  // advisory UX; the database is the gate.
  const intentId = randomUUID();
  let reservation: EscrowWithdrawalReservation;
  try {
    reservation = await reserveEscrowWithdrawal(db, {
      intentId,
      rightsHolderId,
      amountUnits,
      taxRate: balance.taxRate,
    });
  } catch (error) {
    console.error('Escrow withdrawal reserve failed:', error);
    return jsonError('Failed to reserve the withdrawal.', 502);
  }
  if (!reservation.reserved) {
    return jsonError('Withdrawal amount exceeds the available escrow balance.', 422);
  }

  // Plaid boundary: authorize the transfer, then create it.
  let authorizationId: string | undefined;
  let plaidTransferId: string | undefined;
  // Flips once transfer/create is in flight: from that point the transfer
  // outcome can be UNKNOWN (network drop mid-call, unparseable 2xx body) —
  // the hold STAYS pending (never release funds that may have moved) and
  // reconciliation decides. Only failures that provably produced no
  // transfer release the hold.
  let plaidStage: 'authorize' | 'create' = 'authorize';
  try {
    const authRes = await fetch(`${PLAID_HOST}/transfer/authorization/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret },
      body: JSON.stringify({
        client_id: clientId,
        secret,
        access_token: payoutAccount.plaid_access_token,
        account_id: payoutAccount.plaid_account_id,
        amount: plaidAmount,
        network: 'ach',
        type: 'credit',
        ach_class: 'ppd',
        user: { legal_name: holder?.name ?? 'Covnant Rights Holder' },
      }),
    });
    if (!authRes.ok) {
      // Authoritative refusal with no create call attempted — no transfer
      // exists: release the hold (the compensating write restores the
      // available balance).
      console.error('Plaid transfer/authorization/create failed with status', authRes.status);
      await releaseBestEffort(db, intentId);
      return jsonError('Plaid transfer authorization failed.', 502);
    }
    // The authorization id sits at different positions across Plaid response
    // revisions; resolve defensively instead of trusting one shape.
    const auth = (await authRes.json()) as { id?: string; authorization_id?: string; authorization?: { id?: string } };
    authorizationId = auth.authorization?.id ?? auth.authorization_id ?? auth.id;
    if (!authorizationId) {
      // 2xx but unreadable authorization — no create call was attempted, so
      // the hold can be released safely.
      console.error('Plaid transfer/authorization/create returned no authorization id:', auth);
      await releaseBestEffort(db, intentId);
      return jsonError('Plaid transfer failed.', 502);
    }

    plaidStage = 'create';
    const transferRes = await fetch(`${PLAID_HOST}/transfer/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret },
      body: JSON.stringify({
        client_id: clientId,
        secret,
        access_token: payoutAccount.plaid_access_token,
        account_id: payoutAccount.plaid_account_id,
        authorization_id: authorizationId,
        amount: plaidAmount,
        description: 'Covnant escrow payout',
      }),
    });
    if (!transferRes.ok) {
      // Authoritative refusal — the transfer was NOT created: release the
      // hold.
      console.error('Plaid transfer/create failed with status', transferRes.status);
      await releaseBestEffort(db, intentId);
      return jsonError('Plaid transfer failed.', 502);
    }
    const transfer = (await transferRes.json()) as { id?: string; transfer?: { id?: string } };
    plaidTransferId = transfer.transfer?.id ?? transfer.id;
    if (!plaidTransferId) {
      // 2xx with an unparseable body: outcome unknown — the hold STAYS
      // pending and reconciliation decides.
      console.error('Plaid transfer/create returned no transfer id:', transfer);
      return jsonError('Plaid transfer failed.', 502);
    }
  } catch (error) {
    console.error('Plaid transfer request failed:', error);
    // Outcome unknown once create is in flight — keep the hold. An error at
    // the authorize stage (before any create call) means no transfer exists.
    if (plaidStage === 'authorize') await releaseBestEffort(db, intentId);
    return jsonError('Plaid transfer failed.', 502);
  }

  const timestamp = Date.now();
  // Deterministic from the intent: a reconciliation settle of a stuck
  // intent re-writes the SAME transaction_id and converges on the ledger's
  // UNIQUE(transaction_id) instead of double-recording (audit #5).
  const transactionId = `ESCROW-PAYOUT-${intentId}`;
  // The legacy DISBURSEMENT payload (transaction_id, transaction_type,
  // cbt_code, platform, gross_settled, currency, disbursements) is never
  // reshaped. Generation 9 adds ONLY the metadata.cbt stamp to the primary
  // attempt, deterministic from the row's own transaction_id. A live table
  // without the additive metadata column (42703/PGRST204) retries the row
  // WITHOUT the stamp so the payout — the money already moved — is still
  // recorded (the same money-never-blocks rule the raw-SQL paths follow).
  const ledgerRow = {
    transaction_id: transactionId,
    transaction_type: 'DISBURSEMENT',
    cbt_code: 'ESCROW-PAYOUT',
    platform: 'PLAID',
    gross_settled: formatMicro(amountUnits),
    currency,
    disbursements: [
      {
        type: 'DISBURSEMENT',
        rightsHolderId,
        payoutAmount: amountUnits.toString(),
        amountPaid: netPayableUnits.toString(),
        taxWithheld: withheldUnits.toString(),
        plaidAuthorizationId: authorizationId,
        plaidTransferId,
        timestamp,
        remainingNetBalance: remainingUnits.toString(),
      },
    ],
  };
  const { error: insertError } = await db
    .from('universal_royalty_ledger')
    .insert(stampSupabaseLedgerRow(ledgerRow, transactionId));
  if (insertError && isMissingMetadataColumnError(insertError)) {
    console.warn(
      `universal_royalty_ledger.metadata is missing — the payout is recorded WITHOUT the CBT stamp. ${METADATA_COLUMN_DDL_NOTE}`,
    );
    const { error: fallbackError } = await db
      .from('universal_royalty_ledger')
      .insert(ledgerRow);
    if (fallbackError) {
      console.error('universal_royalty_ledger insert failed:', fallbackError.message);
      return jsonError('Failed to record payout.', 502);
    }
  } else if (insertError) {
    console.error('universal_royalty_ledger insert failed:', insertError.message);
    return jsonError('Failed to record payout.', 502);
  }

  // The DISBURSEMENT row landed: settle the intent. Best-effort — a failed
  // flip leaves the hold pending (over-held, never over-paid) and is logged
  // for reconciliation; the payout itself is complete and recorded. The
  // ledger row already carries the intent id in its transaction_id, so a
  // reconciliation settle re-derives everything it needs.
  try {
    const settled = await settleEscrowWithdrawal(db, { intentId, plaidTransferId });
    if (!settled) {
      console.error(
        `Withdrawal intent ${intentId} was not pending at settle — check escrow_withdrawal_intents.`,
      );
    }
  } catch (error) {
    console.error(
      `Withdrawal intent ${intentId} settle failed — the hold remains pending and needs reconciliation:`,
      error,
    );
  }

  return Response.json(
    {
      ok: true,
      plaidTransferId,
      payoutAmount: amountUnits.toString(),
      taxWithheld: withheldUnits.toString(),
      remainingNetBalance: remainingUnits.toString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
