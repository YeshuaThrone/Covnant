import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { GET, POST } from '../route';

/**
 * POST/GET /api/admin/vault/identifiers — the vault adapter's first
 * production call sites. Contract: admin-gated (fail-closed 503 on unset
 * secret, 401 on absent/invalid cookie), rate limited after validation,
 * db_not_configured 503 before any query, and every adapter failure reason
 * mapped to its wire status. The idempotent replay reads 200
 * attached:false — never an error.
 *
 * The rate limiter is mocked (its bucket is module-global state) with the
 * real config's shape; the DB stub replays the vault adapter's row shape.
 */

const PASSWORD = 'test-admin-password-1234';

const rateMock = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/server/rateLimit', () => ({
  checkRateLimit: rateMock.checkRateLimit,
  ADMIN_API_RATE_LIMIT: { limit: 30, windowMs: 60_000 },
}));

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: dbMock.getDb,
}));

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    cvt_code: 'CVT-9F3A7C21-2026',
    cbt_code: 'CBT-TRK-1234567890AB',
    title: 'Test Song',
    medium: 'MUSIC_TRACK',
    mapped_identifiers: {},
    uct: 'UCT-US-2026-9F3A7C21-K4',
    ...overrides,
  };
}

function dbStub(row: Record<string, unknown> | null) {
  const txQueries: QueryCall[] = [];
  const poolQueries: QueryCall[] = [];
  const tx = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      txQueries.push({ sql, params });
      return Promise.resolve({ rows: row ? [row] : [] });
    }),
  };
  const db = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params });
      return Promise.resolve({ rows: row ? [row] : [] });
    }),
    transaction: vi.fn(
      async <T>(work: (tx: { query: QueryFn }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, txQueries, poolQueries };
}

function authedCookie(): string {
  const token = mintAdminSessionToken();
  // mintAdminSessionToken returns null only when the secret is unset; the
  // suite's beforeEach guarantees it is set.
  if (!token) throw new Error('session token mint failed — secret unset?');
  return `${ADMIN_COOKIE_NAME}=${token}`;
}

function attachRequest(body: unknown, cookie?: string): Request {
  return new Request('https://covnant.test/api/admin/vault/identifiers', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function lookupRequest(kind: string, value: string, cookie?: string): Request {
  return new Request(
    `https://covnant.test/api/admin/vault/identifiers?kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`,
    { headers: cookie ? { cookie } : {} },
  );
}

async function call(handler: (request: Request) => Promise<Response>, request: Request): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await handler(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  rateMock.checkRateLimit.mockReturnValue({ ok: true });
  dbMock.getDb.mockReturnValue(dbStub(assetRow()).db);
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  vi.clearAllMocks();
});

describe('POST /api/admin/vault/identifiers — authentication (fail closed FIRST)', () => {
  it('answers 503 admin_not_configured when the secret is unset — before the body is even read', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISRC', value: 'USX7U2600001' }),
    );
    expect(status).toBe(503);
    expect(body).toEqual({ ok: false, reason: 'admin_not_configured', error: 'Admin dashboard is not configured.' });
  });

  it('answers 401 admin_not_authenticated with no cookie', async () => {
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISRC', value: 'USX7U2600001' }),
    );
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, reason: 'admin_not_authenticated', error: 'Admin sign-in required.' });
  });

  it('answers 401 for a forged cookie (wrong signature)', async () => {
    const { status, body } = await call(
      POST,
      attachRequest(
        { assetRef: 'CVT-9F3A7C21-2026', kind: 'ISRC', value: 'USX7U2600001' },
        `${ADMIN_COOKIE_NAME}=1750000000000.deadbeef`,
      ),
    );
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, reason: 'admin_not_authenticated', error: 'Admin sign-in required.' });
  });
});

describe('POST /api/admin/vault/identifiers — validation', () => {
  it('answers 400 malformed_body for non-JSON bodies', async () => {
    const request = new Request('https://covnant.test/api/admin/vault/identifiers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authedCookie() },
      body: 'not-json',
    });
    const { status, body } = await call(POST, request);
    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, reason: 'malformed_body', error: 'Request body must be valid JSON.' });
  });

  it('answers 400 missing_asset_ref when the CVT handle is absent', async () => {
    const { status, body } = await call(POST, attachRequest({ kind: 'ISRC', value: 'USX7U2600001' }, authedCookie()));
    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, reason: 'missing_asset_ref', error: 'assetRef (the stored CVT code) is required.' });
  });

  it('answers 422 invalid_kind for kinds outside the vault union — including creator-party kinds', async () => {
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISNI', value: '0000000123456789' }, authedCookie()),
    );
    expect(status).toBe(422);
    expect(body).toEqual({
      ok: false,
      reason: 'invalid_kind',
      error: 'kind must be one of: ISRC, ISWC, ISAN, EIDR, DOI, UPC, EAN, ISMN, GRID, ISBN, ISSN, GTIN, MLC_WORK_ID, HFA_SONG_ID, TUNE_CODE, EPC_RFID.',
    });
  });

  it('answers 400 missing_value when the identifier value is absent', async () => {
    const request = attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISRC' }, authedCookie());
    const { status, body } = await call(POST, request);
    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, reason: 'missing_value', error: 'value is required.' });
  });
});

describe('POST /api/admin/vault/identifiers — fail-closed posture', () => {
  it('answers 429 rate_limited when the limiter refuses', async () => {
    rateMock.checkRateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 42 });
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISRC', value: 'USX7U2600001' }, authedCookie()),
    );
    expect(status).toBe(429);
    expect(body).toEqual({
      ok: false,
      reason: 'rate_limited',
      error: 'Too many vault requests. Try again in 42s.',
    });
  });

  it('answers 503 db_not_configured when DATABASE_URL is unset — before any query', async () => {
    dbMock.getDb.mockReturnValue(null);
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISRC', value: 'USX7U2600001' }, authedCookie()),
    );
    expect(status).toBe(503);
    expect(body).toEqual({
      ok: false,
      reason: 'db_not_configured',
      error: 'Database is not configured (DATABASE_URL).',
    });
  });

  it('maps the adapter INVALID_IDENTIFIER to 422 — the legacy ten-digit ISWC must not attach', async () => {
    const { db } = dbStub(assetRow());
    dbMock.getDb.mockReturnValue(db);
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-9F3A7C21-2026', kind: 'ISWC', value: 'T-1234567890-1' }, authedCookie()),
    );
    expect(status).toBe(422);
    expect(body).toEqual({
      ok: false,
      reason: 'invalid_identifier',
      error: 'value is not a valid code of the requested kind — canonicalization is strict, never a repair.',
    });
  });

  it('maps the adapter ASSET_NOT_FOUND to 404 — an unknown CVT handle never auto-creates', async () => {
    const { db } = dbStub(null);
    dbMock.getDb.mockReturnValue(db);
    const { status, body } = await call(
      POST,
      attachRequest({ assetRef: 'CVT-MISSING', kind: 'ISRC', value: 'USX7U2600001' }, authedCookie()),
    );
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, reason: 'asset_not_found', error: 'No vault asset carries that CVT code.' });
  });
});

describe('POST /api/admin/vault/identifiers — authenticated attach (the production call site)', () => {
  it('attaches through the vault adapter and answers 200 attached:true with both codes', async () => {
    const { db, txQueries } = dbStub(assetRow());
    dbMock.getDb.mockReturnValue(db);

    const { status, body } = await call(
      POST,
      attachRequest(
        { assetRef: ' CVT-9F3A7C21-2026 ', kind: 'ISWC', value: 'T-123456789-1' },
        authedCookie(),
      ),
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      attached: true,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    // The adapter ran: the asset row was read under FOR UPDATE inside the
    // transaction, then the additive JSONB merge wrote the canonical value.
    const updates = txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(['iswc', 'T-123456789-1', 'CVT-9F3A7C21-2026']);
  });

  it('a replayed attach is a 200 attached:false no-op — idempotent on the wire', async () => {
    const { db, txQueries } = dbStub(assetRow({ mapped_identifiers: { iswc: 'T-123456789-1' } }));
    dbMock.getDb.mockReturnValue(db);

    const { status, body } = await call(
      POST,
      attachRequest(
        { assetRef: 'CVT-9F3A7C21-2026', kind: 'ISWC', value: 'T-123456789-1' },
        authedCookie(),
      ),
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      attached: false,
      cvtCode: 'CVT-9F3A7C21-2026',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    expect(txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'))).toHaveLength(0);
  });

  it('accepts the widened kinds end to end (EIDR under the engine key)', async () => {
    const { db, txQueries } = dbStub(assetRow());
    dbMock.getDb.mockReturnValue(db);

    const { status, body } = await call(
      POST,
      attachRequest(
        { assetRef: 'CVT-9F3A7C21-2026', kind: 'EIDR', value: '10.5240/abcd-efgh-jklm-nopq-rstu-v' },
        authedCookie(),
      ),
    );

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, attached: true, cvtCode: 'CVT-9F3A7C21-2026', cbtCode: 'CBT-TRK-1234567890AB' });
    const updates = txQueries.filter((q) => q.sql.startsWith('UPDATE cbt_assets'));
    expect(updates[0]?.params).toEqual([
      'eidrCanonical',
      '10.5240/ABCD-EFGH-JKLM-NOPQ-RSTU-V',
      'CVT-9F3A7C21-2026',
    ]);
  });
});

describe('GET /api/admin/vault/identifiers — authenticated lookup (the second call site)', () => {
  it('resolves an identifier through findByIdentifier and returns the asset', async () => {
    const { db, poolQueries } = dbStub(assetRow({ mapped_identifiers: { isrc: 'USX7U2600001' } }));
    dbMock.getDb.mockReturnValue(db);

    const { status, body } = await call(GET, lookupRequest('ISRC', 'US-X7U-26-00001', authedCookie()));

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      found: true,
      asset: {
        cvtCode: 'CVT-9F3A7C21-2026',
        cbtCode: 'CBT-TRK-1234567890AB',
        title: 'Test Song',
        medium: 'MUSIC_TRACK',
        externalIdentifiers: { isrc: 'USX7U2600001' },
        holderUct: 'UCT-US-2026-9F3A7C21-K4',
      },
    });
    // Exact-match lookup with the SAME canonicalization as attach.
    expect(poolQueries[0]?.params).toEqual(['USX7U2600001']);
  });

  it('answers 200 found:false for an unknown identifier — not-found is a normal answer', async () => {
    const { db } = dbStub(null);
    dbMock.getDb.mockReturnValue(db);

    const { status, body } = await call(GET, lookupRequest('UPC', '999999999999', authedCookie()));

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, found: false });
  });

  it('is gated: no cookie → 401; unset secret → 503; unknown kind → 422', async () => {
    // Mint the cookie while the secret is still set — exercising the real
    // "token minted earlier, config removed later" case for the 503 branch.
    const cookie = authedCookie();

    const noCookie = await call(GET, lookupRequest('ISRC', 'USX7U2600001'));
    expect(noCookie.status).toBe(401);
    expect(noCookie.body).toEqual({ ok: false, reason: 'admin_not_authenticated', error: 'Admin sign-in required.' });

    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const unsetSecret = await call(GET, lookupRequest('ISRC', 'USX7U2600001', cookie));
    expect(unsetSecret.status).toBe(503);
    expect(unsetSecret.body).toEqual({ ok: false, reason: 'admin_not_configured', error: 'Admin dashboard is not configured.' });

    process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
    const badKind = await call(GET, lookupRequest('IPN', 'something', authedCookie()));
    expect(badKind.status).toBe(422);
    expect(badKind.body).toEqual({
      ok: false,
      reason: 'invalid_kind',
      error: 'kind must be one of: ISRC, ISWC, ISAN, EIDR, DOI, UPC, EAN, ISMN, GRID, ISBN, ISSN, GTIN, MLC_WORK_ID, HFA_SONG_ID, TUNE_CODE, EPC_RFID.',
    });
  });
});
