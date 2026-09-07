import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { getDb } from '@/lib/db';
import { buildUct, uctIssuanceYear, uctSerial } from '@/lib/covenant/uct';

/**
 * POST /api/covenant/auth/signup — UCT (creator-root identity) acceptance
 * tests: S1 mint+disclosure, S2 repeat-without-uct, S3 sanitized input
 * rejection, S5 race safety (distinct UCTs, bounded-retry collision
 * recovery), and the fail-closed UCT_MINT_FAILED 503. The shipped PR #27
 * contract ({ email }-only) is covered by route.test.ts, which stays
 * unmodified and green.
 *
 * Against the db fake the mint's serial-uniqueness check is evaluated
 * against the LIVE registry state, so a forced serial collision exercises
 * the real check-then-retry loop. The uct module is partially mocked so
 * tests can force serial draws while buildUct/checksum stay real.
 */

const uctModule = vi.hoisted(() => ({ realUctSerial: undefined as (() => string) | undefined }));
vi.mock('@/lib/covenant/uct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/covenant/uct')>();
  uctModule.realUctSerial = actual.uctSerial;
  return { ...actual, uctSerial: vi.fn(actual.uctSerial) };
});
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);
const mockUctSerial = vi.mocked(uctSerial);

const EMAIL = 'creator@example.com';
const REGISTRY_ASSET_ID = 'b2c3d4e5-0000-4000-8000-000000000002';

function signupHolderEntry(): Record<string, unknown> {
  return {
    rightsHolderId: 'rh_signup_existing',
    name: EMAIL,
    role: 'COMPOSER',
    email: EMAIL,
    payoutRouting: {},
  };
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * A stateful db fake modeling the registry row — same conventions as
 * route.test.ts, plus the mint's serial-uniqueness probe evaluated against
 * the LIVE registry (a serial taken by any holder collides) and the
 * atomic find-or-create semantics the advisory lock + UNIQUE(cbt_code)
 * give the real table (a concurrent creator sees the committed row).
 */
function fakeDb(options: { registry?: { id: string; rights_holders: unknown[] } } = {}) {
  let registry = options.registry
    ? { ...options.registry, rights_holders: [...options.registry.rights_holders] }
    : null;
  const txQueries: QueryCall[] = [];
  const txQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('rh @>')) {
      // The mint's uniqueness probe: rh @> '{"uct":"<candidate>"}'::jsonb
      const probe = JSON.parse(String(params?.[0])) as { uct?: unknown };
      const taken = (registry?.rights_holders ?? []).some(
        (holder) => (holder as { uct?: unknown }).uct === probe.uct,
      );
      return taken ? { rows: [{ uct: probe.uct }] } : { rows: [] };
    }
    if (sql.includes('jsonb_agg')) {
      const holderId = params?.[1];
      const updated = JSON.parse(String(params?.[2]));
      if (registry) {
        registry.rights_holders = registry.rights_holders.map((holder) =>
          (holder as { rightsHolderId?: unknown }).rightsHolderId === holderId ? updated : holder,
        );
      }
      return { rows: [] };
    }
    if (sql.includes('jsonb_array_elements')) {
      const holderId = params?.[1];
      const holder =
        registry?.rights_holders.find(
          (candidate) => (candidate as { rightsHolderId?: unknown }).rightsHolderId === holderId,
        ) ?? null;
      return holder ? { rows: [{ holder }] } : { rows: [] };
    }
    if (sql.includes('cbt_code = $1')) {
      return registry
        ? { rows: [{ id: registry.id, rights_holders: registry.rights_holders }] }
        : { rows: [] };
    }
    if (sql.includes('INSERT INTO cbt_assets')) {
      if (!registry) registry = { id: REGISTRY_ASSET_ID, rights_holders: [] };
      return { rows: [{ id: registry.id, rights_holders: registry.rights_holders }] };
    }
    if (sql.includes('|| $2::jsonb')) {
      registry?.rights_holders.push(JSON.parse(String(params?.[1])));
      return { rows: [] };
    }
    return { rows: [] };
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn(),
    transaction: vi.fn(
      async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, txQueries, getRegistry: () => registry };
}

function signupRequest(body: unknown): Request {
  return new Request('http://localhost/api/covenant/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // Default: real crypto-random serials. Individual tests force draws with
  // mockImplementationOnce queues on top of this.
  mockUctSerial.mockReset();
  mockUctSerial.mockImplementation(uctModule.realUctSerial!);
  vi.stubEnv('INCREASE_API_KEY', '');
  vi.stubEnv('INCREASE_SOURCE_ACCOUNT_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

interface SignupResponse {
  ok: boolean;
  created?: boolean;
  uct?: string;
  uctCreatedAt?: string;
  jurisdiction?: string;
  engine?: string;
  status?: string;
  reason?: string;
  alreadyRegistered?: boolean;
  rightsHolderId?: string;
  assetId?: string;
}

describe('S1 — creating signup mints and discloses the UCT', () => {
  it('returns 201 { created: true, uct, uctCreatedAt, jurisdiction, engine } with PENDING while Increase is unconfigured', async () => {
    const { db, getRegistry } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    const res = await POST(signupRequest({ email: EMAIL, engine: 'music_recording' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as SignupResponse;
    expect(body).toMatchObject({
      ok: true,
      created: true,
      status: 'PENDING',
      reason: 'INCREASE_NOT_CONFIGURED',
      alreadyRegistered: false,
      jurisdiction: 'US',
      engine: 'music_recording',
    });
    expect(body.uct).toMatch(/^UCT-[A-Z]{2}-\d{4}-[0-9A-F]{8}-[0-9A-Z]{2}$/);
    expect(Number.isNaN(Date.parse(body.uctCreatedAt ?? ''))).toBe(false);

    // Issuance facts persist on the holder JSONB.
    const holders = getRegistry()?.rights_holders ?? [];
    expect(holders).toHaveLength(1);
    const entry = holders[0] as Record<string, unknown>;
    expect(entry.uct).toBe(body.uct);
    expect(entry.uctCreatedAt).toBe(body.uctCreatedAt);
    expect(entry.uctJurisdiction).toBe('US');
    expect(entry.engine).toBe('music_recording');
  });

  it('honors an explicit jurisdiction and embeds it immutably in the minted code', async () => {
    const { db, getRegistry } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    const res = await POST(
      signupRequest({ email: EMAIL, engine: 'publishing', jurisdiction: 'gb' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as SignupResponse;
    expect(body.jurisdiction).toBe('GB'); // normalized 2-char ISO 3166
    expect(body.uct).toMatch(/^UCT-GB-\d{4}-/);
    const entry = (getRegistry()?.rights_holders ?? [])[0] as Record<string, unknown>;
    expect(entry.uctJurisdiction).toBe('GB');
    expect(entry.engine).toBe('publishing');
  });

  it('keeps the shipped { email }-only shape working with NO fabricated engine', async () => {
    const { db, getRegistry } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    const res = await POST(signupRequest({ email: EMAIL }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as SignupResponse;
    expect(body.created).toBe(true);
    expect(body.uct).toMatch(/^UCT-[A-Z]{2}-\d{4}-[0-9A-F]{8}-[0-9A-Z]{2}$/);
    expect('engine' in body).toBe(false); // never a fabricated vertical
    const entry = (getRegistry()?.rights_holders ?? [])[0] as Record<string, unknown>;
    expect('engine' in entry).toBe(false);
    expect(entry.uct).toBe(body.uct);
  });
});

describe('S2 — idempotent repeat is status-only (enumeration protection)', () => {
  it('returns 200 alreadyRegistered with NO uct key of any shape', async () => {
    const registry = { id: REGISTRY_ASSET_ID, rights_holders: [signupHolderEntry()] };
    const { db, getRegistry } = fakeDb({ registry });
    mockGetDb.mockReturnValue(db as never);
    const res = await POST(
      signupRequest({ email: `  ${EMAIL.toUpperCase()}  `, engine: 'music_recording' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignupResponse;
    expect(body).toMatchObject({
      ok: true,
      created: false,
      alreadyRegistered: true,
      status: 'PENDING',
    });
    // Key ABSENCE, asserted — not by convention. uctCreatedAt would leak just
    // the same; neither key may appear on the repeat path.
    expect('uct' in body).toBe(false);
    expect('uctCreatedAt' in body).toBe(false);
    expect('jurisdiction' in body).toBe(false);
    expect('engine' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('"uct"');
    // The pre-UCT holder is untouched — no re-mint, no backfill.
    expect(getRegistry()?.rights_holders).toHaveLength(1);
    expect('uct' in (getRegistry()?.rights_holders[0] as Record<string, unknown>)).toBe(false);
  });
});

describe('S3 — invalid engine/jurisdiction are sanitized 400s with no state change', () => {
  it.each([
    ['an unknown engine', { email: EMAIL, engine: 'film_licensing' }, 'film_licensing'],
    ['a non-string engine', { email: EMAIL, engine: 42 }, '42'],
    [
      'a 3-char jurisdiction',
      { email: EMAIL, engine: 'music_recording', jurisdiction: 'USA' },
      'USA',
    ],
    ['a 1-char jurisdiction', { email: EMAIL, jurisdiction: 'U' }, 'U'],
  ])('rejects %s without echoing the input', async (_label, requestBody, forbidden) => {
    const { db, getRegistry } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    const res = await POST(signupRequest(requestBody));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    const text = JSON.stringify(body);
    expect(text).not.toContain(forbidden); // no input echo
    expect(getRegistry()).toBeNull(); // no registry row, no holder — zero state change
  });

  it('accepts a lowercase-typed 2-letter jurisdiction by normalizing it', async () => {
    const { db } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    const res = await POST(
      signupRequest({ email: EMAIL, engine: 'music_recording', jurisdiction: 'de' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as SignupResponse;
    expect(body.jurisdiction).toBe('DE');
  });
});

describe('S5 — race safety: distinct UCTs, no uniqueness violation', () => {
  it('recovers a forced serial collision through the bounded retry and mints distinct UCTs', async () => {
    const { db, getRegistry } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    // Two registrations draw the SAME serial; the live-registry uniqueness
    // check (serialized by the advisory lock in production) forces the
    // second mint to redraw.
    mockUctSerial
      .mockImplementationOnce(() => 'AAAAAAAA')
      .mockImplementationOnce(() => 'AAAAAAAA')
      .mockImplementationOnce(() => 'BBBBBBBB');

    const first = await POST(signupRequest({ email: 'a@example.com', engine: 'music_recording' }));
    const second = await POST(signupRequest({ email: 'b@example.com', engine: 'music_recording' }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as SignupResponse;
    const secondBody = (await second.json()) as SignupResponse;
    expect(firstBody.uct).toMatch(/^UCT-[A-Z]{2}-\d{4}-AAAAAAAA-[0-9A-Z]{2}$/);
    expect(secondBody.uct).toMatch(/^UCT-[A-Z]{2}-\d{4}-BBBBBBBB-[0-9A-Z]{2}$/);
    expect(firstBody.uct).not.toBe(secondBody.uct);
    const holders = getRegistry()?.rights_holders ?? [];
    expect(holders).toHaveLength(2);
    const ucts = holders.map((h) => (h as { uct?: unknown }).uct);
    expect(new Set(ucts).size).toBe(2);
  });

  it('keeps concurrent signups on one registry row with distinct UCTs and no violation', async () => {
    const { db, getRegistry } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    mockUctSerial.mockImplementationOnce(() => '11111111').mockImplementationOnce(() => '22222222');

    const [first, second] = await Promise.all([
      POST(signupRequest({ email: 'a@example.com', engine: 'music_recording' })),
      POST(signupRequest({ email: 'b@example.com', engine: 'music_recording' })),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as SignupResponse;
    const secondBody = (await second.json()) as SignupResponse;
    expect(firstBody.created).toBe(true);
    expect(secondBody.created).toBe(true);
    expect(firstBody.uct).not.toBe(secondBody.uct);
    const holders = getRegistry()?.rights_holders ?? [];
    expect(holders).toHaveLength(2); // one registry row, two holders
    expect(getRegistry()?.id).toBe(REGISTRY_ASSET_ID);
  });
});

describe('fail-closed mint', () => {
  it('returns 503 UCT_MINT_FAILED and registers nothing when uniqueness is not achieved in bounds', async () => {
    const colliding = buildUct('US', uctIssuanceYear(), 'AAAAAAAA');
    const registry = {
      id: REGISTRY_ASSET_ID,
      rights_holders: [
        {
          ...signupHolderEntry(),
          email: 'seed@example.com',
          uct: colliding,
          uctCreatedAt: new Date().toISOString(),
          uctJurisdiction: 'US',
        },
      ],
    };
    const { db, getRegistry, txQueries } = fakeDb({ registry });
    mockGetDb.mockReturnValue(db as never);
    mockUctSerial.mockImplementation(() => 'AAAAAAAA'); // every draw collides

    const res = await POST(signupRequest({ email: 'new@example.com', engine: 'music_recording' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as SignupResponse;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('UCT_MINT_FAILED');
    expect(body.uct).toBeUndefined();
    // Fail-closed: no holder registered, no partial state.
    expect(getRegistry()?.rights_holders).toHaveLength(1);
    // Exactly the bounded number of uniqueness attempts ran.
    const mintProbes = txQueries.filter((q) => q.sql.includes('rh @>'));
    expect(mintProbes).toHaveLength(3);
  });
});

describe('schema hygiene for the UCT path', () => {
  it('issues no money-movement queries when minting', async () => {
    const { db, txQueries } = fakeDb();
    mockGetDb.mockReturnValue(db as never);
    await POST(signupRequest({ email: EMAIL, engine: 'music_recording' }));
    const allSql = txQueries.map((q) => q.sql).join('\n');
    expect(allSql).not.toContain('universal_royalty_ledger');
    expect(allSql).not.toContain('disbursements');
    expect(allSql).not.toContain('UPDATE cbt_assets SET mapped_identifiers'); // no asset mutation
  });
});
