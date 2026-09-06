import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * POST /api/plaid/exchange-token
 *
 * Exchanges a Plaid public token + account id for account/routing numbers and
 * stores the payout routing record on the standalone rights_holders table.
 *
 * - Native fetch to Plaid production; client credentials sent per request,
 *   never echoed into any response.
 * - Env vars are read lazily INSIDE the handler so absence yields a clean 503
 *   at runtime, never a build-time throw.
 * - Only a last-4 account mask is persisted; the raw account number is dropped.
 */

const PLAID_HOST = 'https://production.plaid.com';

interface ExchangeTokenBody {
  publicToken?: unknown;
  accountId?: unknown;
  rightsHolderId?: unknown;
}

const REQUIRED_EXCHANGE_FIELDS = ['publicToken', 'accountId', 'rightsHolderId'] as const;

function missingFields(body: ExchangeTokenBody): string[] {
  // Required keys must be present AND hold non-blank string values.
  return REQUIRED_EXCHANGE_FIELDS.filter((key) => {
    const value = body[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  let body: ExchangeTokenBody;
  try {
    body = (await request.json()) as ExchangeTokenBody;
  } catch {
    return jsonError('Request body must be valid JSON with publicToken, accountId, and rightsHolderId.', 400);
  }
  const missing = missingFields(body);
  if (missing.length > 0) {
    return jsonError(`Missing required field(s): ${missing.join(', ')}.`, 400);
  }
  const { publicToken, accountId, rightsHolderId } = body as {
    publicToken: string;
    accountId: string;
    rightsHolderId: string;
  };

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    return jsonError('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).', 503);
  }
  const db = supabaseFromEnv();
  if (!db) {
    return jsonError('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).', 503);
  }

  // Plaid boundary: exchange the public token, then read account numbers.
  let accessToken: string | undefined;
  let routingNumber: string | undefined;
  let accountNumberMask: string | undefined;
  try {
    // 1. Public token → item access token.
    const exchangeRes = await fetch(`${PLAID_HOST}/item/public_token/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
      body: JSON.stringify({ client_id: clientId, secret, public_token: publicToken }),
    });
    if (!exchangeRes.ok) {
      console.error('Plaid public_token/exchange failed:', exchangeRes.status, await exchangeRes.text());
      return jsonError('Plaid token exchange failed. Verify the public token and try again.', 502);
    }
    const exchange = (await exchangeRes.json()) as { access_token?: string };
    if (!exchange.access_token) {
      return jsonError('Plaid did not return an access token.', 502);
    }
    accessToken = exchange.access_token;

    // 2. Access token → ACH account + routing numbers for the chosen account.
    const authRes = await fetch(`${PLAID_HOST}/auth/get`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
      body: JSON.stringify({ client_id: clientId, secret, access_token: accessToken }),
    });
    if (!authRes.ok) {
      console.error('Plaid auth/get failed:', authRes.status, await authRes.text());
      return jsonError('Plaid account lookup failed. Verify the account and try again.', 502);
    }
    const auth = (await authRes.json()) as {
      accounts?: { account_id: string; mask?: string }[];
      numbers?: { ach?: { account_id: string; routing_number: string; account_number?: string }[] };
    };
    const account = auth.accounts?.find((entry) => entry.account_id === accountId);
    const ach = auth.numbers?.ach?.find((entry) => entry.account_id === accountId);
    if (!account || !ach?.routing_number || !ach.account_number) {
      return jsonError('Plaid returned no account numbers for the selected account.', 502);
    }
    routingNumber = ach.routing_number;
    // Persist only a last-4 mask — the raw number is never stored or echoed.
    accountNumberMask = ach.account_number.slice(-4);
  } catch (error) {
    console.error('Plaid exchange-token flow failed:', error);
    return jsonError('Plaid token exchange failed. Verify the public token and try again.', 502);
  }

  const updatedTimestamp = Date.now();
  const { error: upsertError } = await db.from('rights_holders').upsert({
    id: rightsHolderId,
    method: 'ACH',
    plaid_access_token: accessToken,
    plaid_account_id: accountId,
    routing_number: routingNumber,
    account_number_mask: accountNumberMask,
    is_verified: true,
    updated_timestamp: updatedTimestamp,
  });
  if (upsertError) {
    console.error('rights_holders upsert failed:', upsertError.message);
    return jsonError('Failed to save the payout routing record.', 502);
  }

  // User-locked success contract — exact shape, camelCase, no extra fields.
  return Response.json(
    {
      ok: true,
      rightsHolderId,
      payoutRouting: {
        method: 'ACH',
        plaidAccessToken: accessToken,
        plaidAccountId: accountId,
        routingNumber,
        accountNumberMask,
        isVerified: true,
        updatedTimestamp,
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
