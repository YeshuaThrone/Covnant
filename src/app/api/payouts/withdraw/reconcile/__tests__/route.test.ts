
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST } from '../route';
import { POST as webhookPOST } from '@/app/api/payouts/webhooks/plaid/route';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { requireOperator } from '@/lib/server/apiAccess';
import { supabaseFromEnv } from '@/lib/supabase';
import { fakeEscrowDb, type FakeEscrowDb, type FakeIntentSeed } from '../../__tests__/fakeEscrowDb';
import { signPlaidVerificationJwt } from '@/lib/escrow/plaidWebhookSignature';
import { escrowPayoutTransactionId } from '@/lib/escrow/intentReconciler';
import { fetchEscrowBalance } from '@/lib/escrow/balance';

/**
 * POST /api/payouts/withdraw/reconcile contract tests — the operator-gated
 * bounded stale-hold sweep, driven against the shared stateful escrow fake
 * with the Plaid rail stubbed (never contacted for real). The webhook route
 * joins the race test so both resolvers run against ONE shared fake.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));
vi.mock('@/lib/server/apiAccess', () => ({ requireOperator: vi.fn() }));

const mockSupabaseFromEnv = vi.mocked(supabaseFromEnv);
const mockRequireOperator = vi.mocked(requireOperator);

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const verificationJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

const HOLDER = 'rh_1';
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

/** One hour ago — comfortably past the sweep's 30-minute staleness floor. */
const staleIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function sweepRequest(): Request {
  return new Request('http://localhost/api/payouts/withdraw/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

function signedWebhookRequest(transferId: string): Request {
  const raw = JSON.stringify({ webhook_type: 'TRANSFER', webhook_code: 'TRANSFER_POSTED', transfer_id: transferId });
  const jwt = signPlaidVerificationJwt({
    header: { alg: 'ES256', kid: 'key-11', typ: 'JWT' },
    claims: {
      iat: Math.floor(Date.now() / 1000),
      request_body_sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    },
    signPayload: (input) =>
      cryptoSign('sha256', Buffer.from(input, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  });
  return new Request('http://localhost/api/payouts/webhooks/plaid', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'plaid-verification': jwt },
    body: raw,
  });
}

/** Queue of /transfer/get answers; the key fetch always succeeds. */
let transferStatusQueue: Array<{ ok: boolean; status?: string } | Error> = [];

async function stubbedFetch(input: unknown): Promise<Response> {
  const url = String(input);
  if (url.includes('webhook_verification_key')) {
    return new Response(JSON.stringify({ key: verificationJwk }), { status: 200 });
  }
  if (!url.includes('transfer/get')) {
    throw new Error(`unexpected fetch: ${url}`);
  }
  const next = transferStatusQueue.shift();
  if (next instanceof Error) throw next;
  if (!next) throw new Error('unexpected extra transfer/get call');
  if (!next.ok) return new Response('plaid down', { status: 502 });
  return new Response(JSON.stringify({ transfer: { status: next.status } }), { status: 200 });
}

function makeDb(seedIntents: FakeIntentSeed[]): FakeEscrowDb {
  return fakeEscrowDb({
    holderRow: { plaid_access_token: 'access-sandbox-token', plaid_account_id: 'acc_1', method: 'ACH' },
    assetRows: [],
    ledgerData: [...grossLedgerRows],
    taxProfile: unverifiedUsProfile(),
    rightsHolderId: HOLDER,
    seedIntents,
  });
}

beforeEach(() => {
  vi.stubEnv('PLAID_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PLAID_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(stubbedFetch));
  mockRequireOperator.mockReturnValue({ ok: true as const, role: 'operator' as const });
  transferStatusQueue = [];
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/payouts/withdraw/reconcile — gates and bounds', () => {
  it('refuses the gate first: 401 when the operator requirement fails', async () => {
    const fake = makeDb([{ id: 'wi_stale', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: staleIso() }]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    mockRequireOperator.mockReturnValueOnce({
      ok: false as const,
      status: 401,
      message: 'Unauthorized',
      code: 'no_session',
    });

    const response = await POST(sweepRequest());
    expect(response.status).toBe(401);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('refuses explicitly with a 503 when Plaid credentials are absent', async () => {
    const fake = makeDb([{ id: 'wi_stale', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: staleIso() }]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    vi.stubEnv('PLAID_CLIENT_ID', '');

    const response = await POST(sweepRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'Plaid reconciliation is not configured.' });
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('answers 503 when the database is not configured', async () => {
    mockSupabaseFromEnv.mockReturnValue(null as never);

    const response = await POST(sweepRequest());
    expect(response.status).toBe(503);
  });

  it('bounds the pass at the batch limit', async () => {
    const seeded = Array.from({ length: 30 }, (_, i) => ({
      id: `wi_batch_${i}`,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      created_at: staleIso(),
      plaid_transfer_id: `tr_batch_${i}`,
    }));
    const fake = makeDb(seeded);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    // Enough posted answers for a full batch; every extra intent stays
    // pending for the next pass — the bound, not the queue, decides.
    transferStatusQueue = Array.from({ length: 40 }, () => ({ ok: true, status: 'posted' }));

    const response = await POST(sweepRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { swept: number; batchLimit: number };
    expect(body.swept).toBe(25);
    expect(body.batchLimit).toBe(25);
    const settled = fake.intents.filter((i) => i.status === 'settled').length;
    expect(settled).toBe(25);
  });
});

describe('POST /api/payouts/withdraw/reconcile — resolution', () => {
  it('settles a stale intent whose transfer has posted, completing the ledger debit', async () => {
    const fake = makeDb([
      {
        id: 'wi_stale',
        amount_units: ONE_DOLLAR_UNITS.toString(),
        created_at: staleIso(),
        plaid_transfer_id: 'tr_stale_1',
      },
    ]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'posted' }];

    const response = await POST(sweepRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resolved: Array<Record<string, unknown>>; unresolved: unknown[] };
    expect(body.unresolved).toEqual([]);
    expect(body.resolved).toHaveLength(1);
    expect(body.resolved[0]).toMatchObject({
      intentId: 'wi_stale',
      outcome: 'settle',
      resolved: true,
      ledger: 'debit_completed',
      status: 'posted',
    });
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
    expect(fake.inserts).toHaveLength(1);
    expect((fake.inserts[0] as { transaction_id: string }).transaction_id).toBe(
      escrowPayoutTransactionId('wi_stale'),
    );
  });

  it('leaves fresh (non-stale) intents untouched', async () => {
    const fake = makeDb([
      { id: 'wi_fresh', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: new Date().toISOString(), plaid_transfer_id: 'tr_fresh' },
    ]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(sweepRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { swept: number; resolved: unknown[]; unresolved: unknown[] };
    expect(body.swept).toBe(0);
    expect(body.resolved).toEqual([]);
    expect(body.unresolved).toEqual([]);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('reports an intent with no recoverable transfer id as unresolved and keeps it pending', async () => {
    const fake = makeDb([{ id: 'wi_orphan', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: staleIso() }]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const response = await POST(sweepRequest());

    const body = (await response.json()) as { unresolved: Array<Record<string, unknown>> };
    expect(body.unresolved).toEqual([{ intentId: 'wi_orphan', reason: 'no_transfer_id' }]);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('reports a failed status query as unresolved and keeps the hold pending', async () => {
    const fake = makeDb([
      { id: 'wi_outage', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: staleIso(), plaid_transfer_id: 'tr_outage' },
    ]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [new Error('fetch failed')];

    const response = await POST(sweepRequest());

    const body = (await response.json()) as { unresolved: Array<Record<string, unknown>> };
    expect(body.unresolved).toEqual([{ intentId: 'wi_outage', reason: 'status_query_failed' }]);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('keeps holds pending on still-pending rail statuses', async () => {
    const fake = makeDb([
      { id: 'wi_slow', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: staleIso(), plaid_transfer_id: 'tr_slow' },
    ]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'pending' }];

    const response = await POST(sweepRequest());

    const body = (await response.json()) as { unresolved: Array<Record<string, unknown>> };
    expect(body.unresolved).toEqual([{ intentId: 'wi_slow', status: 'pending', reason: 'still_pending' }]);
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });

  it('releases a stale intent whose transfer failed, restoring available exactly', async () => {
    const fake = makeDb([
      { id: 'wi_dead', amount_units: ONE_DOLLAR_UNITS.toString(), created_at: staleIso(), plaid_transfer_id: 'tr_dead' },
    ]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    transferStatusQueue = [{ ok: true, status: 'failed' }];

    const held = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(held.availableUnits).toBe(52_000_000n);

    const response = await POST(sweepRequest());

    const body = (await response.json()) as { resolved: Array<Record<string, unknown>> };
    expect(body.resolved[0]).toMatchObject({ intentId: 'wi_dead', outcome: 'release', resolved: true, ledger: 'none' });
    expect(fake.intents[0]).toMatchObject({ status: 'released' });
    expect(fake.inserts).toHaveLength(0);
    const restored = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(restored.availableUnits).toBe(152_000_000n);
    expect(restored.availableUnits - held.availableUnits).toBe(ONE_DOLLAR_UNITS);
  });
});

describe('POST /api/payouts/withdraw/reconcile — racing a live webhook', () => {
  it('admits exactly one resolution when the sweep and the webhook fire together', async () => {
    const fake = makeDb([
      {
        id: 'wi_race',
        amount_units: ONE_DOLLAR_UNITS.toString(),
        created_at: staleIso(),
        plaid_transfer_id: 'tr_race',
      },
    ]);
    mockSupabaseFromEnv.mockReturnValue(fake.db);
    // Both resolvers ask the rail; both hear "posted".
    transferStatusQueue = [{ ok: true, status: 'posted' }, { ok: true, status: 'posted' }];

    const [webhookResponse, sweepResponse] = await Promise.all([
      webhookPOST(signedWebhookRequest('tr_race')),
      POST(sweepRequest()),
    ]);

    expect(webhookResponse.status).toBe(200);
    expect(sweepResponse.status).toBe(200);
    const webhookBody = (await webhookResponse.json()) as Record<string, unknown>;
    const sweepBody = (await sweepResponse.json()) as { resolved: Array<Record<string, unknown>> };
    const webhookWon = webhookBody.resolved === true;
    const sweepWon = sweepBody.resolved.length === 1 && sweepBody.resolved[0].resolved === true;
    // Exactly one winner — the guard-first status update decides; the
    // loser reports the resolution as already done.
    expect([webhookWon, sweepWon].filter(Boolean)).toHaveLength(1);
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
    // One committed debit row for the intent — replay-safe by the
    // deterministic id.
    expect(
      fake.inserts.filter((row) => (row as { transaction_id?: string }).transaction_id === escrowPayoutTransactionId('wi_race')).length,
    ).toBeLessThanOrEqual(1);
  });
});
