/**
 * The Plaid API boundary behind the withdrawal-intent reconciler — the two
 * calls the webhook and the stale-hold sweep share:
 *
 *   - POST /webhook_verification_key/get — the ES256 JWK that verifies a
 *     webhook's Plaid-Verification JWT (Plaid's documented verification
 *     flow; the endpoint is credential-gated).
 *   - POST /transfer/get — the authoritative CURRENT status of a transfer.
 *     The webhook treats the notification as a verified BELL and takes the
 *     verdict from here (never from the notification body); the sweep
 *     re-queries here when no webhook ever arrived.
 *
 * The same fail-closed posture as the withdraw route: application-level
 * Plaid credentials (PLAID_CLIENT_ID / PLAID_SECRET) do not exist under the
 * locked rails policy, so every caller refuses with an explicit
 * not-configured error when they are absent — the live rail is never
 * faked-enabled. Tests exercise these transports through stubbed global
 * fetch (the house pattern), mirroring the sandbox rail.
 */

/** The withdraw route's host constant; Plaid environments are per-tenant. */
export const PLAID_API_HOST = 'https://production.plaid.com';

export interface PlaidCredentials {
  clientId: string;
  secret: string;
}

/**
 * The application-level Plaid credentials, or null when absent — the
 * reconciler surfaces' explicit not-configured refusal.
 */
export function plaidCredentialsFromEnv(): PlaidCredentials | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  return clientId && secret ? { clientId, secret } : null;
}

/** The JWK shape /webhook_verification_key/get returns (Plaid docs). */
export type PlaidWebhookJwk = {
  kty?: unknown;
  crv?: unknown;
  use?: unknown;
  x?: unknown;
  y?: unknown;
  kid?: unknown;
};

/**
 * Fetch the webhook verification key for a JWT's kid. Throws on transport
 * failure or a non-2xx/absent key — callers decide retryability (a fetch
 * outage is retryable; an unknown kid is a bad-signature refusal).
 */
export async function fetchWebhookVerificationKey(
  credentials: PlaidCredentials,
  kid: string,
): Promise<PlaidWebhookJwk> {
  const response = await fetch(`${PLAID_API_HOST}/webhook_verification_key/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PLAID-CLIENT-ID': credentials.clientId, 'PLAID-SECRET': credentials.secret },
    body: JSON.stringify({ client_id: credentials.clientId, secret: credentials.secret, key_id: kid }),
  });
  if (!response.ok) {
    throw new Error(`Plaid webhook_verification_key/get failed with status ${response.status}`);
  }
  const body = (await response.json()) as { key?: PlaidWebhookJwk };
  if (!body?.key || typeof body.key !== 'object') {
    throw new Error('Plaid webhook_verification_key/get returned no key.');
  }
  return body.key;
}

/** The transfer statuses Plaid's /transfer/get can report for a transfer. */
export type PlaidTransferStatus =
  | 'cancelled'
  | 'failed'
  | 'pending'
  | 'posted'
  | 'reversed'
  | 'settled';

/**
 * The authoritative current status of a transfer, straight from the rail.
 * Throws on transport failure or a non-2xx — a provider outage must surface
 * (the webhook answers retryable-503, the sweep skips and logs), never
 * silently become "still pending".
 */
export async function fetchTransferStatus(
  credentials: PlaidCredentials,
  transferId: string,
): Promise<PlaidTransferStatus> {
  const response = await fetch(`${PLAID_API_HOST}/transfer/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PLAID-CLIENT-ID': credentials.clientId, 'PLAID-SECRET': credentials.secret },
    body: JSON.stringify({ client_id: credentials.clientId, secret: credentials.secret, transfer_id: transferId }),
  });
  if (!response.ok) {
    throw new Error(`Plaid transfer/get failed with status ${response.status}`);
  }
  const body = (await response.json()) as { transfer?: { status?: unknown } };
  const status = body?.transfer?.status;
  if (typeof status !== 'string') {
    throw new Error('Plaid transfer/get returned no transfer status.');
  }
  return status as PlaidTransferStatus;
}

/**
 * The reconciler's verdict for a rail status — the fail-closed mapping from
 * Plaid's transfer lifecycle to the withdrawal-intent resolution:
 *
 *   posted | settled          → settle  (the money left escrow for real)
 *   failed | reversed |
 *   cancelled                 → release (provably no payout / money back)
 *   pending | unknown | null  → null    (stay held — never resolve on a guess)
 *
 * Unknown statuses are the fail-closed arm: a status this module has never
 * seen leaves the hold pending for the next sweep rather than guessing.
 */
export function outcomeForTransferStatus(status: string | null | undefined): 'settle' | 'release' | null {
  switch (status) {
    case 'posted':
    case 'settled':
      return 'settle';
    case 'failed':
    case 'reversed':
    case 'cancelled':
      return 'release';
    default:
      return null;
  }
}
