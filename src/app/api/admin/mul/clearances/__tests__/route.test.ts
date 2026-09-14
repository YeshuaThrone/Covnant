import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { setStore } from '@/lib/server/store';
import { GET, POST } from '../route';

/**
 * POST/GET /api/admin/mul/clearances — the MUL admin surface (API-only in
 * v1 per spec open item #4). Contract: admin-gated (fail-closed 503 on unset
 * secret, 401 on absent/invalid cookie), rate limited after validation,
 * store_not_configured 503 before any query, and every SDK typed refusal
 * mapped to its wire status — illegal machine edges 409, invalid fields 422
 * with the SDK's stable code.
 *
 * The store is the REAL PR 3 InMemoryStore through the seam's setStore()
 * injection — these tests double as the proof that the machine's fifth
 * state ('revoked') round-trips through the Store seam's rows, whose TS
 * vocabulary predates it.
 */

const PASSWORD = 'test-admin-password-1234';
const ASSET = 'CBT-TRK-A1B2C3D4E5F6';

const rateMock = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/server/rateLimit', () => ({
  checkRateLimit: rateMock.checkRateLimit,
  ADMIN_API_RATE_LIMIT: { limit: 30, windowMs: 60_000 },
}));

function authedCookie(): string {
  const token = mintAdminSessionToken();
  // mintAdminSessionToken returns null only when the secret is unset; the
  // suite's beforeEach guarantees it is set.
  if (!token) throw new Error('session token mint failed — secret unset?');
  return `${ADMIN_COOKIE_NAME}=${token}`;
}

function postRequest(body: unknown, cookie?: string): Request {
  return new Request('https://covnant.test/api/admin/mul/clearances', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(query: string, cookie?: string): Request {
  return new Request(
    `https://covnant.test/api/admin/mul/clearances${query}`,
    cookie ? { headers: { cookie } } : undefined,
  );
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  setStore(new InMemoryStore());
  rateMock.checkRateLimit.mockReturnValue({ ok: true });
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  setStore(null);
  vi.resetAllMocks();
});

describe('POST /api/admin/mul/clearances — gating and wire shapes', () => {
  it('answers 503 admin_not_configured when the secret is unset', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const response = await POST(postRequest({ assetCbtCode: ASSET, to: 'draft' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'admin_not_configured' });
  });

  it('answers 401 without a valid session cookie', async () => {
    const response = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'draft' }, `${ADMIN_COOKIE_NAME}=forged`),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body).not.toHaveProperty('clearance');
  });

  it('answers 400 on a malformed body and on a missing asset code', async () => {
    const malformed = new Request('https://covnant.test/api/admin/mul/clearances', {
      method: 'POST',
      headers: { cookie: authedCookie() },
      body: 'not-json{',
    });
    expect((await POST(malformed)).status).toBe(400);
    expect((await POST(postRequest({ to: 'draft' }, authedCookie()))).status).toBe(400);
  });

  it('answers 422 invalid_state for a state the machine does not know', async () => {
    const response = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'granted' }, authedCookie()),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'invalid_state' });
  });

  it('answers 429 when rate limited — after validation', async () => {
    rateMock.checkRateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 7 });
    const response = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'draft' }, authedCookie()),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
  });

  it('answers 503 store_not_configured before any query runs', async () => {
    setStore(null); // the singleton's getStore() throws when unconfigured
    const response = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'draft' }, authedCookie()),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'store_not_configured' });
  });
});

describe('POST — the machine over the real PR 3 store', () => {
  it('walks draft → requested → cleared, persisting licensee, territory, and terms', async () => {
    const init = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'draft' }, authedCookie()),
    );
    expect(init.status).toBe(200);
    expect((await init.json()).clearance).toMatchObject({ assetCbtCode: ASSET, state: 'draft' });

    const requested = await POST(
      postRequest(
        {
          assetCbtCode: ASSET,
          to: 'requested',
          licensee: 'Merlin Events LLC',
          territory: 'US',
          termStart: '2026-09-01T00:00:00Z',
          termEnd: '2027-08-31T23:59:59.999Z',
          note: 'license request sent',
        },
        authedCookie(),
      ),
    );
    expect(requested.status).toBe(200);
    expect((await requested.json()).clearance).toMatchObject({
      state: 'requested',
      licensee: 'Merlin Events LLC',
      territory: 'US',
    });

    const cleared = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'cleared' }, authedCookie()),
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).clearance).toMatchObject({
      state: 'cleared',
      licensee: 'Merlin Events LLC',
      termStart: '2026-09-01T00:00:00.000Z',
      termEnd: '2027-08-31T23:59:59.999Z',
    });
  });

  it('reads 409 invalid_transition when the edge does not exist from the current state', async () => {
    // No draft first — the machine refuses to grant an unrequested license.
    const grant = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'cleared' }, authedCookie()),
    );
    expect(grant.status).toBe(409);
    expect(await grant.json()).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    });
  });

  it("maps the SDK's field refusals to 422 with the stable code", async () => {
    // The machine's entry edge is draft — initialize first, then request
    // with the bad territory, so the field validation is what fires.
    await POST(postRequest({ assetCbtCode: ASSET, to: 'draft' }, authedCookie()));
    const response = await POST(
      postRequest(
        { assetCbtCode: ASSET, to: 'requested', territory: 'usa' },
        authedCookie(),
      ),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'invalid_territory' });
  });

  it('revokes, then recovers — revoked round-trips the seam', async () => {
    const walk = ['draft', 'requested', 'cleared', 'revoked'] as const;
    for (const to of walk) {
      const response = await POST(postRequest({ assetCbtCode: ASSET, to }, authedCookie()));
      expect(response.status).toBe(200);
      expect((await response.json()).clearance.state).toBe(to);
    }
    // Recovery — a re-granted license returns the asset to cleared.
    const recovered = await POST(
      postRequest({ assetCbtCode: ASSET, to: 'cleared', note: 're-granted' }, authedCookie()),
    );
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).clearance.state).toBe('cleared');
  });
});

describe('GET /api/admin/mul/clearances — reads and audit history', () => {
  it('answers found:false for an asset with no clearance', async () => {
    const response = await GET(
      getRequest(`?asset_cbt_code=${ASSET}`, authedCookie()),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, found: false });
  });

  it('answers 400 when asset_cbt_code is missing', async () => {
    const response = await GET(getRequest('', authedCookie()));
    expect(response.status).toBe(400);
  });

  it('returns the current clearance plus the append-only history, oldest-first', async () => {
    for (const to of ['draft', 'requested', 'cleared', 'disputed'] as const) {
      await POST(postRequest({ assetCbtCode: ASSET, to }, authedCookie()));
    }

    const response = await GET(getRequest(`?asset_cbt_code=${ASSET}`, authedCookie()));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.found).toBe(true);
    expect(body.clearance).toMatchObject({ assetCbtCode: ASSET, state: 'disputed' });
    expect(body.transitions.map((row: { toState: string }) => row.toState)).toEqual([
      'draft',
      'requested',
      'cleared',
      'disputed',
    ]);
    expect(body.transitions[0]).toMatchObject({
      fromState: null,
      toState: 'draft',
      assetCbtCode: ASSET,
    });
  });

  it('enforces the admin gate on reads too', async () => {
    const response = await GET(getRequest(`?asset_cbt_code=${ASSET}`));
    expect(response.status).toBe(401);
  });
});
