
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST } from '../route';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { supabaseFromEnv } from '@/lib/supabase';
import { fakeEscrowDb, type FakeEscrowDb } from '@/app/api/payouts/withdraw/__tests__/fakeEscrowDb';
import { signPlaidVerificationJwt } from '@/lib/escrow/plaidWebhookSignature';
import { escrowPayoutTransactionId } from '@/lib/escrow/intentReconciler';
import { fetchEscrowBalance } from '@/lib/escrow/balance';

/**
 * POST /api/payouts/webhooks/plaid contract tests. The live Plaid rail is
 * NEVER contacted — fetch is stubbed with a queue (verification-key fetch,
 * then /transfer/get), which is how the suite exercises the machinery under
 * the locked-rails policy: the endpoint itself still refuses explicitly
 * when the deployment has no verification credentials.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const mockSupabaseFromEnv = vi.mocked(supabaseFromEnv);

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const verificationJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

const HOLDER = 'rh_1';
const INTENT_ID = 'wi_webhook_target';
const TRANSFER_ID = 'tr_hook_1';

/** Ledger gross of 2.00 for rh_1 → 24% tax 0.48 → available 1.52 (152M units). */
const grossLedgerRows = [{ disbursements: [{ rightsHolderId: HOLDER, grossShare: 2.0 }] }];
const ONE_DOLLAR_UNITS = 100_000_000n;

function unverifiedUsProfile(): TaxProfile {
  return {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'test-identifier',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: false,
  };
}

function postedEvent(transferId: string = TRANSFER_ID) {
  return { webhook_type: 'TRANSFER', webhook_code: 'TRANSFER_POSTED', transfer_id: transferId };
}

function signBody(body: string, key = privateKey): string {
  return signPlaidVerificationJwt({
    header: { alg: 'ES256', kid: 'key-11', typ: 'JWT' },
    claims: {
      iat: Math.floor(Date.now() / 1000),
      request_body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    },
    signPayload: (input) =>
      cryptoSign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }),
  });
}

function webhookRequest(body: unknown, options: { header?: string | null } = {}): Request {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.header !== null) {
    headers['plaid-verification'] = options.header ?? signBody(raw);
  }
  return new Request('http://localhost/api/payouts/webhooks/plaid', { method: 'POST', headers, body: raw });
}

/** Queue of /transfer/get status answers served after the verification-key fetch. */
let transferStatusQueue: Array<{ ok: boolean; status?: string } | Error> = [];
let failKeyFetchWith: Error | null = null;
let keyFetchStatus = 200;

async function stubbedFetch(input: unknown): Promise<Response> {
  const url = String(input);
  if (url.includes('webhook_verification_key')) {
    if (failKeyFetchWith) throw failKeyFetchWith;
    if (keyFetchStatus !== 200) return new Response('no such key', { status: keyFetchStatus });
    return new Response(JSON.stringify({ key: verificationJwk }), { status: 200 });
  }
  const next = transferStatusQueue.shift();
  if (next instanceof Error) throw next;
  if (!next) throw new Error('unexpected extra fetch call');
  if (!next.ok) return new Response('plaid down', { status: 502 });
  return new Response(JSON.stringify({ transfer: { status: next.status } }), { status: 200 });
}

function seedPendingIntent(): FakeEscrowDb {
  return fakeEscrowDb({
    holderRow: { plaid_access_token: 'access-sandbox-token', plaid_account_id: 'acc_1', method: 'ACH' },
    assetRows: [],
    ledgerData: [...grossLedgerRows],
    taxProfile: unverifiedUsProfile(),
    rightsHolderId: HOLDER,
    seedIntents: [{ id: INTENT_ID, amount_units: ONE_DOLLAR_UNITS.toString(), plaid_transfer_id: TRANSFER_ID }],
  });
}

beforeEach(() => {
  vi.stubEnv('PLAID_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PLAID_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(stubbedFetch));
  transferStatusQueue = [];
  failKeyFetchWith = null;
  keyFetchStatus = 200;
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/payouts/webhooks/plaid — fail-closed gates', () => {
  it('refuses explicitly with a 503 when verification credentials are absent', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    vi.stubEnv('PLAID_CLIENT_ID', '');

    const response = await POST(webhookRequest(postedEvent()));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'Plaid webhook verification is not configured.' });
    // The refusal happens before ANY processing — nothing moved and Plaid
    // was never contacted.
    expect(fake.inserts).toHaveLength(0);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('answers 401 when the Plaid-Verification header is missing', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(webhookRequest(postedEvent(), { header: null }));
    expect(response.status).toBe(401);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('answers 403 when the signature does not verify', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    // A signature from a key that is not the one the key endpoint returns.
    const response = await POST(
      webhookRequest(postedEvent(), { header: signBody(JSON.stringify(postedEvent()), other.privateKey) }),
    );
    expect(response.status).toBe(403);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('answers 403 when the signed body hash does not match the raw body', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    // The JWT signs the POSTED event; the delivered body quietly says
    // SETTLED. The raw-body hash comparison must catch it.
    const signed = JSON.stringify(postedEvent());
    const delivered = signed.replace('TRANSFER_POSTED', 'TRANSFER_SETTLED');
    const response = await POST(webhookRequest(delivered, { header: signBody(signed) }));
    expect(response.status).toBe(403);
  });

  it('answers 403 on a stale signature (replay past the tolerance window)', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    const raw = JSON.stringify(postedEvent());
    const staleJwt = signPlaidVerificationJwt({
      header: { alg: 'ES256', kid: 'key-11' },
      claims: {
        iat: Math.floor(Date.now() / 1000) - 3600,
        request_body_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      },
      signPayload: (input) =>
        cryptoSign('sha256', Buffer.from(input, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }),
    });

    const response = await POST(webhookRequest(raw, { header: staleJwt }));
    expect(response.status).toBe(403);
  });

  it('answers 403 when the key endpoint rejects the kid (unknown key)', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    keyFetchStatus = 404;

    const response = await POST(webhookRequest(postedEvent()));
    expect(response.status).toBe(403);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('answers a retryable 503 when the key fetch transport fails', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    failKeyFetchWith = new Error('fetch failed: ECONNREFUSED');

    const response = await POST(webhookRequest(postedEvent()));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('retry pending');
  });

  it('answers 400 for a signed-but-unparseable body', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(webhookRequest('this is not json'));
    expect(response.status).toBe(400);
  });
});

describe('POST /api/payouts/webhooks/plaid — reconciliation', () => {
  it('settles the hold on TRANSFER_POSTED: completing the ledger debit once', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'posted' }];

    const response = await POST(webhookRequest(postedEvent()));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      resolved: true,
      alreadyResolved: false,
      ledger: 'debit_completed',
      status: 'posted',
    });
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
    expect(fake.inserts).toHaveLength(1);
    expect((fake.inserts[0] as { transaction_id: string }).transaction_id).toBe(
      escrowPayoutTransactionId(INTENT_ID),
    );
    // The hold→debit conversion is balance-neutral.
    const balance = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(balance.availableUnits).toBe(52_000_000n);
  });

  it('admits exactly one resolution when the same webhook is delivered twice', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'posted' }, { ok: true, status: 'posted' }];

    const first = await POST(webhookRequest(postedEvent()));
    const second = await POST(webhookRequest(postedEvent()));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toMatchObject({ resolved: false, alreadyResolved: true });
    // One settlement — one ledger debit, one intent flip.
    expect(fake.inserts).toHaveLength(1);
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
  });

  it('releases the hold on a failed transfer and restores available exactly', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'failed' }];

    const held = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(held.availableUnits).toBe(52_000_000n);

    const response = await POST(
      webhookRequest({ webhook_type: 'TRANSFER', webhook_code: 'TRANSFER_FAILED', transfer_id: TRANSFER_ID }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, resolved: true, outcome: 'release', ledger: 'none' });
    expect(fake.intents[0]).toMatchObject({ status: 'released' });
    // No compensating entries needed — no debit ever stood.
    expect(fake.inserts).toHaveLength(0);
    const restored = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(restored.availableUnits).toBe(152_000_000n);
    expect(restored.availableUnits - held.availableUnits).toBe(ONE_DOLLAR_UNITS);
  });

  it('holds a pending-status transfer with a 200 and no writes', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'pending' }];

    const response = await POST(webhookRequest(postedEvent()));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, held: true });
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('acknowledges non-TRANSFER webhook types as no-ops without contacting the rail', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(webhookRequest({ webhook_type: 'AUTH', webhook_code: 'WEBHOOK_UPDATE_ACK' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, ignored: true });
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('answers 400 for a TRANSFER webhook missing the transfer id', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(webhookRequest({ webhook_type: 'TRANSFER', webhook_code: 'TRANSFER_POSTED' }));
    expect(response.status).toBe(400);
  });

  it('acknowledges transfers that map to no intent with noted=true', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(webhookRequest(postedEvent('tr_someone_else')));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, noted: true });
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('answers a retryable 503 when the authoritative status query fails', async () => {
    const fake = seedPendingIntent();
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [new Error('fetch failed')];

    const response = await POST(webhookRequest(postedEvent()));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('retry pending');
    // Fail-closed: the hold stands.
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });
});
