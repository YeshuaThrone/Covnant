/**
 * POST /api/payouts/withdraw — escrow payout via Plaid ACH transfer.
 *
 * Flow: validate → load the holder's connected payout account → compute the
 * balance through the shared escrow helper (same math as the dashboard, so
 * the two surfaces can never disagree) → withhold tax for unverified
 * profiles → authorize + create the Plaid transfer → record the payout as a
 * DISBURSEMENT ledger row.
 *
 * `amount` is a string-formatted BigInt in smallest ledger units (1e-8
 * scale). Conversion to Plaid's decimal-string amount happens ONLY at the
 * Plaid boundary via smallestUnitsToPlaidAmount. Environment is read lazily
 * inside the handler (503 when unconfigured); Plaid failures return a
 * sanitized 502 that never echoes secrets or upstream payloads.
 */

import { randomUUID } from 'node:crypto';
import { supabaseFromEnv } from '@/lib/supabase';
import { formatMicro } from '@/lib/fixed-point';
import {
  fetchEscrowBalance,
  findRightsHolder,
  smallestUnitsToPlaidAmount,
  UNVERIFIED_FALLBACK_TAX_PROFILE,
  withholdingUnitsOn,
} from '@/lib/escrow/balance';

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

/** Amount must be a plain positive BigInt string of smallest ledger units. */
function parseAmount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const units = BigInt(raw);
  return units > 0n ? units : null;
}

export async function POST(request: Request): Promise<Response> {
  let body: WithdrawBody;
  try {
    body = (await request.json()) as WithdrawBody;
  } catch {
    return jsonError('Request body must be valid JSON with rightsHolderId and amount.', 400);
  }
  const { rightsHolderId, amount } = body;
  if (typeof rightsHolderId !== 'string' || rightsHolderId.trim() === '') {
    return jsonError('rightsHolderId is required.', 400);
  }
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

  // Plaid boundary: authorize the transfer, then create it.
  let authorizationId: string | undefined;
  let plaidTransferId: string | undefined;
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
      console.error('Plaid transfer/authorization/create failed with status', authRes.status);
      return jsonError('Plaid transfer authorization failed.', 502);
    }
    // The authorization id sits at different positions across Plaid response
    // revisions; resolve defensively instead of trusting one shape.
    const auth = (await authRes.json()) as { id?: string; authorization_id?: string; authorization?: { id?: string } };
    authorizationId = auth.authorization?.id ?? auth.authorization_id ?? auth.id;

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
      console.error('Plaid transfer/create failed with status', transferRes.status);
      return jsonError('Plaid transfer failed.', 502);
    }
    const transfer = (await transferRes.json()) as { id?: string; transfer?: { id?: string } };
    plaidTransferId = transfer.transfer?.id ?? transfer.id;
    if (!authorizationId || !plaidTransferId) {
      return jsonError('Plaid transfer failed.', 502);
    }
  } catch (error) {
    console.error('Plaid transfer request failed:', error);
    return jsonError('Plaid transfer failed.', 502);
  }

  const timestamp = Date.now();
  const transactionId = `ESCROW-PAYOUT-${timestamp}-${randomUUID()}`;
  const { error: insertError } = await db.from('universal_royalty_ledger').insert({
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
  });
  if (insertError) {
    console.error('universal_royalty_ledger insert failed:', insertError.message);
    return jsonError('Failed to record payout.', 502);
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
