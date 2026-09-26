/**
 * The route-level authz battery (hardening gen 12) — EVERY money/data route
 * from the audit's C1/B2 list, exercised through its real Next.js handler
 * with the REAL apiAccess verdicts. Only the Supabase session resolver is
 * mocked (its own suite covers the resolver); the admin gate runs its real
 * HMAC token crypto against a real minted operator cookie.
 *
 * Pinned per route:
 *   - an anonymous caller (no cookie, no session) gets 401;
 *   - cross-account access — caller A asking for holder B's data — is
 *     refused 403 holder_mismatch on every holder-scoped route, BEFORE any
 *     read runs (the deterministic next-step failure proves the gate, not
 *     the route, decided);
 *   - operator-only routes (release, payout, dispute locks, BaaS rails,
 *     split calculation/reversal/recoupment) refuse everyone but the signed
 *     operator cookie — including signed-in creators;
 *   - one derivation proof per family: the session's own holder id is used
 *     when the client names none, and a matching client id passes.
 *
 * Each request carries a unique rate-limit identity so the limiter never
 * contaminates an authz verdict; the limiter's own behavior is pinned in the
 * claims-webhook describe and the Don route battery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/server/sessionCreator', () => ({
  resolveSessionCreator: vi.fn(),
}));

// The claims engine builds a FRESH SDK per request whose asset registry is a
// private instance Map — in memory mode (no Supabase env in CI) a real settle
// is impossible for any unknown asset. The happy-path test mocks THIS seam so
// the webhook's own layers (secret check, rate limit, ledger mirror) run real.
vi.mock('@/engine/covenant-master-sdk', () => ({
  processUniversalSocialWebhookAction: vi.fn(),
}));

import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { processUniversalSocialWebhookAction } from '@/engine/covenant-master-sdk';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { setStore } from '@/lib/server/store';
import { seedVault } from '@/modules/don/__tests__/fixtures';

import { GET as vaultsGet, POST as vaultsPost } from '@/app/api/v1/vaults/route';
import { POST as payoutPost } from '@/app/api/v1/vaults/payout/route';
import { POST as lockPost } from '@/app/api/v1/vaults/dispute/lock/route';
import { POST as achPost } from '@/app/api/v1/baas/ach/route';
import { POST as rtpPost } from '@/app/api/v1/baas/rtp/route';
import { POST as calculatePost } from '@/app/api/v1/splits/calculate/route';
import { POST as reversePost } from '@/app/api/v1/splits/reverse/route';
import { POST as recoupmentPost, GET as recoupmentGet } from '@/app/api/v1/splits/recoupment/route';
import { GET as dashboardGet } from '@/app/api/artist/dashboard/route';
import { POST as withdrawPost } from '@/app/api/payouts/withdraw/route';
import { POST as exchangePost } from '@/app/api/plaid/exchange-token/route';
import { POST as provisionPost } from '@/app/api/covnant/accounts/provision/route';
import { GET as ledgerGet } from '@/app/api/ledger/route';
import { POST as claimsPost } from '@/app/api/webhooks/claims/route';

/** The mocked resolver answers the creator-session seam with these shapes. */
const CREATOR_A = {
  kind: 'registered' as const,
  creator: {
    payee_id: 'rh_A',
    stage_name: 'Creator A',
    kyc_status: 'APPROVED',
    bank_account_linked: true,
    provisioning_status: 'PROVISIONED' as const,
  },
};

const anonymous = (): void => {
  vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });
};
const creatorA = (): void => {
  vi.mocked(resolveSessionCreator).mockResolvedValue(CREATOR_A);
};
const unregistered = (): void => {
  vi.mocked(resolveSessionCreator).mockResolvedValue({
    kind: 'unregistered',
    reason: 'holder_not_found',
  });
};

/** Operator requests carry a REAL minted admin session cookie. */
function operatorHeaders(): Record<string, string> {
  const token = mintAdminSessionToken();
  if (!token) throw new Error('operator token mint failed — ADMIN_DASHBOARD_PASSWORD unset?');
  return { cookie: `${ADMIN_COOKIE_NAME}=${token}` };
}

/** Unique limiter identity per request — authz verdicts must never race the window. */
let ipCounter = 0;
const nextIp = (): string => `10.77.${Math.floor(ipCounter / 250) % 250}.${(ipCounter += 1) % 250}`;

function get(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { 'x-forwarded-for': nextIp(), ...headers },
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Valid bodies — any gate pass-through proceeds to the engine, never to a validation error. */
const royaltyPayload = {
  source: 'spotify',
  period: '2026-08',
  currency: 'USD',
  settle: false,
  rail: 'ach' as const,
  line_items: [
    {
      work_id: 'work_1',
      work_title: 'One Work',
      amount_cents: 10_000,
      splits: [
        { payee_id: 'creator_1', payee_name: 'Creator One', role: 'creator' as const, share_bps: 10_000 },
      ],
    },
  ],
};

const VALID_OPERATOR_BODIES: Record<string, unknown> = {
  '/api/v1/vaults': { action: 'release', payee_id: 'creator_1', amount_cents: 100 },
  '/api/v1/vaults/payout': { payee_id: 'creator_1', amount_cents: 100, rail: 'ach' },
  '/api/v1/vaults/dispute/lock': { payee_id: 'creator_1', locked: true },
  '/api/v1/baas/ach': { payee_id: 'creator_1', payee_name: 'Creator One', amount_cents: 100 },
  '/api/v1/baas/rtp': { payee_id: 'creator_1', payee_name: 'Creator One', amount_cents: 100 },
  '/api/v1/splits/calculate': royaltyPayload,
  '/api/v1/splits/reverse': { split_run_id: 'run_authz' },
  '/api/v1/splits/recoupment': {
    creator_id: 'creator_1',
    creator_name: 'Creator One',
    recoupment_target_cents: 100,
    recoupment_bps: 5_000,
  },
};

const ENV_KEYS = [
  'ADMIN_DASHBOARD_PASSWORD',
  'CLAIMS_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'INCREASE_API_KEY',
  'INCREASE_SOURCE_ACCOUNT_ID',
  'BAAS_MODE',
] as const;

let savedEnv: Record<string, string | undefined>;
let store: InMemoryStore;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The operator gate needs a configured secret to mint/verify cookies; the
  // Supabase/Plaid/Increase secrets stay UNSET so a gate pass-through lands
  // on the route's own deterministic not-configured 503.
  process.env.ADMIN_DASHBOARD_PASSWORD = 'test-admin-password-1234';
  store = new InMemoryStore();
  setStore(store);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setStore(null);
  vi.mocked(resolveSessionCreator).mockReset();
  vi.mocked(processUniversalSocialWebhookAction).mockReset();
});

/** Seeds the holders the battery's cross-account refusals need. */
async function seedHolders(): Promise<void> {
  await seedVault(store, 'rh_A', 5_000, 0, 0, 'Creator A');
  await seedVault(store, 'rh_B', 9_000, 0, 0, 'Creator B');
  await seedVault(store, 'creator_1', 0, 5_000, 0, 'Creator One');
}

describe('operator-only Don routes refuse non-operators', () => {
  const operatorOnlyHandlers: Array<[string, (r: NextRequest) => Promise<Response>]> = [
    ['/api/v1/vaults', (r) => vaultsPost(r)],
    ['/api/v1/vaults/payout', (r) => payoutPost(r)],
    ['/api/v1/vaults/dispute/lock', (r) => lockPost(r)],
    ['/api/v1/baas/ach', (r) => achPost(r)],
    ['/api/v1/baas/rtp', (r) => rtpPost(r)],
    ['/api/v1/splits/calculate', (r) => calculatePost(r)],
    ['/api/v1/splits/reverse', (r) => reversePost(r)],
    ['/api/v1/splits/recoupment', (r) => recoupmentPost(r)],
  ];

  for (const [path, handler] of operatorOnlyHandlers) {
    it(`${path} POST — anonymous caller gets 401`, async () => {
      await seedHolders();
      anonymous();
      const response = await handler(post(path, VALID_OPERATOR_BODIES[path]));
      expect(response.status).toBe(401);
      expect((await bodyOf(response)).code).toBe('admin_not_authenticated');
    });

    it(`${path} POST — a signed-in creator is still not an operator (401)`, async () => {
      await seedHolders();
      creatorA();
      const response = await handler(post(path, VALID_OPERATOR_BODIES[path]));
      expect(response.status).toBe(401);
      expect((await bodyOf(response)).code).toBe('admin_not_authenticated');
    });
  }

  it('GET /api/v1/splits/recoupment is operator-only too', async () => {
    await seedHolders();
    anonymous();
    const response = await recoupmentGet(get('/api/v1/splits/recoupment?creator_id=creator_1'));
    expect(response.status).toBe(401);
  });

  it('a real operator cookie releases a vault end to end (no module mocks)', async () => {
    await seedHolders();
    const response = await vaultsPost(
      post('/api/v1/vaults', VALID_OPERATOR_BODIES['/api/v1/vaults'], operatorHeaders()),
    );
    expect(response.ok).toBe(true);
    const creator = await store.getVault('creator_1');
    expect(creator?.available_balance).toBe(100);
    expect(creator?.pending_balance).toBe(4_900);
  });
});

describe('holder-scoped routes derive identity from the session', () => {
  it('GET /api/v1/vaults — anonymous caller gets 401 no_session', async () => {
    await seedHolders();
    anonymous();
    const response = await vaultsGet(get('/api/v1/vaults'));
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).code).toBe('no_session');
  });

  it('GET /api/v1/vaults — creator asking for ANOTHER holder is 403 holder_mismatch', async () => {
    await seedHolders();
    creatorA();
    const response = await vaultsGet(get('/api/v1/vaults?payee_id=rh_B'));
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe('holder_mismatch');
  });

  it('GET /api/v1/vaults — creator with no param reads ONLY their own vault (derived)', async () => {
    await seedHolders();
    creatorA();
    const response = await vaultsGet(get('/api/v1/vaults'));
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).payee_id).toBe('rh_A');
  });

  it('GET /api/v1/vaults — operator without a param lists every vault', async () => {
    await seedHolders();
    const response = await vaultsGet(get('/api/v1/vaults', operatorHeaders()));
    expect(response.status).toBe(200);
    const vaults = (await bodyOf(response)).vaults as Array<{ payee_id: string }>;
    expect(vaults.map((v) => v.payee_id).sort()).toEqual(['creator_1', 'rh_A', 'rh_B']);
  });

  it('GET /api/artist/dashboard — anonymous 401, cross-account 403, own passes to the 503 supabase wall', async () => {
    await seedHolders();

    anonymous();
    const anon = await dashboardGet(get('/api/artist/dashboard?rightsHolderId=rh_A'));
    expect(anon.status).toBe(401);
    expect((await bodyOf(anon)).error).toBe('Sign in to access holder data.');

    creatorA();
    const cross = await dashboardGet(get('/api/artist/dashboard?rightsHolderId=rh_B'));
    expect(cross.status).toBe(403);
    expect((await bodyOf(cross)).error).toBe('The requested holder does not belong to this session.');

    // The 503 proves the gate PASSED the owner and the route continued to
    // its own (unset-credentials) wall — not a validation or auth verdict.
    const own = await dashboardGet(get('/api/artist/dashboard?rightsHolderId=rh_A'));
    expect(own.status).toBe(503);
  });

  it('POST /api/payouts/withdraw — anonymous 401, cross-account 403, own derives past the gate', async () => {
    await seedHolders();
    const payload = { rightsHolderId: 'rh_A', amount: '100000000' };

    anonymous();
    const anon = await withdrawPost(post('/api/payouts/withdraw', payload));
    expect(anon.status).toBe(401);
    expect((await bodyOf(anon)).error).toBe('Sign in to access holder data.');

    creatorA();
    const cross = await withdrawPost(post('/api/payouts/withdraw', { ...payload, rightsHolderId: 'rh_B' }));
    expect(cross.status).toBe(403);
    expect((await bodyOf(cross)).error).toBe('The requested holder does not belong to this session.');

    // Derivation proof: NO body id at all — the session's own holder is used
    // (the request reaches the 503 supabase wall; it is never a 400).
    const derived = await withdrawPost(post('/api/payouts/withdraw', { amount: '100000000' }));
    expect(derived.status).toBe(503);

    // An operator may still initiate for a named holder.
    const operator = await withdrawPost(
      post('/api/payouts/withdraw', { rightsHolderId: 'rh_B', amount: '100000000' }, operatorHeaders()),
    );
    expect(operator.status).toBe(503);
  });

  it('POST /api/plaid/exchange-token — anonymous 401, cross-account 403, own reaches the 503 Plaid wall', async () => {
    await seedHolders();
    const payload = { publicToken: 'pt_authz', accountId: 'acct_authz', rightsHolderId: 'rh_A' };

    anonymous();
    const anon = await exchangePost(post('/api/plaid/exchange-token', payload));
    expect(anon.status).toBe(401);
    expect((await bodyOf(anon)).error).toBe('Sign in to access holder data.');

    creatorA();
    const cross = await exchangePost(post('/api/plaid/exchange-token', { ...payload, rightsHolderId: 'rh_B' }));
    expect(cross.status).toBe(403);
    expect((await bodyOf(cross)).error).toBe('The requested holder does not belong to this session.');

    const derived = await exchangePost(
      post('/api/plaid/exchange-token', { publicToken: 'pt_authz', accountId: 'acct_authz' }),
    );
    expect(derived.status).toBe(503);
  });

  it('POST /api/covnant/accounts/provision — anonymous 401, cross-account 403, own reaches the 503 Increase wall', async () => {
    await seedHolders();
    const assetId = '11111111-1111-1111-1111-111111111111';
    const payload = { assetId, rightsHolderId: 'rh_A' };

    anonymous();
    const anon = await provisionPost(post('/api/covnant/accounts/provision', payload));
    expect(anon.status).toBe(401);
    expect((await bodyOf(anon)).error).toBe('Sign in to access holder data.');

    creatorA();
    const cross = await provisionPost(post('/api/covnant/accounts/provision', { ...payload, rightsHolderId: 'rh_B' }));
    expect(cross.status).toBe(403);
    expect((await bodyOf(cross)).error).toBe('The requested holder does not belong to this session.');

    const derived = await provisionPost(post('/api/covnant/accounts/provision', { assetId }));
    expect(derived.status).toBe(503);
  });
});

describe('GET /api/ledger — registered creators or the operator, never anonymous', () => {
  it('anonymous caller gets 401 no_session', async () => {
    anonymous();
    const response = await ledgerGet(get('/api/ledger'));
    expect(response.status).toBe(401);
    // The shared jsonError envelope is pinned byte-for-byte by the admin
    // login/signup tests: the code rides in `reason`, never `code`.
    expect((await bodyOf(response)).reason).toBe('no_session');
  });

  it('a signed-in but unenrolled session gets 403 not_registered', async () => {
    unregistered();
    const response = await ledgerGet(get('/api/ledger'));
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).reason).toBe('not_registered');
  });

  it('a registered creator reads the ledger (memory mode)', async () => {
    creatorA();
    const response = await ledgerGet(get('/api/ledger'));
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).ok).toBe(true);
  });

  it('the operator reads the ledger', async () => {
    const response = await ledgerGet(get('/api/ledger', operatorHeaders()));
    expect(response.status).toBe(200);
  });
});

describe('POST /api/webhooks/claims — shared secret, fail closed', () => {
  const CLAIM = {
    platform: 'youtube',
    cbtCode: 'CBT-AUTHZ-1',
    externalAssetId: 'ext_authz_1',
    mediaContentId: 'mc_authz_1',
    channelOrProfileId: 'ch_authz_1',
    grossAdRevenueOrRoyalty: 100,
    currency: 'USD',
    territoryCountryCode: 'US',
    timestamp: 1_757_000_000_000,
  };
  const SECRET = 'whsec_authz_test';

  function claimsRequest(body: unknown, headers: Record<string, string> = {}, ip = nextIp()): Request {
    return new NextRequest('http://localhost/api/webhooks/claims', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    });
  }

  it('an UNSET secret refuses every caller — the webhook is unavailable, never open', async () => {
    const response = await claimsPost(claimsRequest({ claims: [CLAIM] }));
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).ok).toBe(false);
  });

  it('a presented-but-wrong secret is 401', async () => {
    process.env.CLAIMS_WEBHOOK_SECRET = SECRET;
    const response = await claimsPost(
      claimsRequest({ claims: [CLAIM] }, { 'x-claims-webhook-secret': 'whsec_wrong' }),
    );
    expect(response.status).toBe(401);
  });

  it('the correct secret settles the claim (engine seam mocked, mirror real)', async () => {
    process.env.CLAIMS_WEBHOOK_SECRET = SECRET;
    vi.mocked(processUniversalSocialWebhookAction).mockResolvedValue({
      success: true,
      processedCount: 1,
      data: [{
        transactionId: 'txn_authz_1',
        cbtCode: 'CBT-AUTHZ-1',
        totalSettled: 100,
        currency: 'USD',
        platformFeeDeducted: 10,
        cornerDustCollected: 1,
        disbursements: [],
        reconciliationStatus: 'PASS' as const,
      }],
    });
    const response = await claimsPost(
      claimsRequest({ claims: [CLAIM] }, { 'x-claims-webhook-secret': SECRET }),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.ok).toBe(true);
    expect(body.processedCount).toBe(1);
  });

  it('secret guessing burns the rate-limit window like any other flood', async () => {
    process.env.CLAIMS_WEBHOOK_SECRET = SECRET;
    const ip = nextIp();
    let last = 0;
    for (let index = 0; index < 31; index += 1) {
      const response = await claimsPost(
        claimsRequest(
          { claims: [CLAIM] },
          { 'x-claims-webhook-secret': index === 30 ? 'whsec_correct' : 'whsec_wrong' },
          ip,
        ),
      );
      last = response.status;
    }
    expect(last).toBe(429);
  });
});
