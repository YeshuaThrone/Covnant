import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';
import { buildUct } from '@/lib/covnant/uct';

/**
 * GET /api/covnant/me contract tests — the session-scoped creator aggregate.
 *
 * The auth boundary is mocked at the @supabase/ssr wrapper (the session
 * client) and the service-role factory; the escrow helpers run FOR REAL
 * against faked table reads so the money math is the production math. The
 * suite pins: the 200 aggregate (0004 defaults surfaced, per-holder escrow
 * totals as BigInt unit strings), the 401s (no session / invalid session),
 * strict session-email holder resolution (no cross-tenant UCT leak), the
 * STATUS-ONLY provisioning disclosure (expectNoAccountNumbers discipline),
 * and fail-closed reads (a read error is never empty data).
 */

const ssrMock = vi.hoisted(() => ({
  readSupabasePublicEnv: vi.fn(),
  hasSupabaseSessionCookies: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createBrowserSupabaseClient: vi.fn(),
}));

vi.mock('@/lib/server/supabaseSsr', () => ({
  readSupabasePublicEnv: ssrMock.readSupabasePublicEnv,
  hasSupabaseSessionCookies: ssrMock.hasSupabaseSessionCookies,
  createServerSupabaseClient: ssrMock.createServerSupabaseClient,
  createBrowserSupabaseClient: ssrMock.createBrowserSupabaseClient,
}));

const serviceMock = vi.hoisted(() => ({
  supabaseFromEnv: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: serviceMock.supabaseFromEnv,
}));

const EMAIL = 'creator@example.com';
const OTHER_EMAIL = 'someoneelse@example.com';
const USER_ID = 'auth_user_1';
const SESSION_UCT = buildUct('US', 2026, '9F3A7C21');
const OTHER_UCT = buildUct('US', 2026, 'DEADBEEF');
const PUBLIC_ENV = { url: 'https://test-project.supabase.co', anonKey: 'test-anon-key' };

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    stage_name: 'Nova Reign',
    legal_name: 'Jordan A. Reyes',
    email: EMAIL,
    phone: '+15125550123',
    phone_verified_at: null,
    core_industry: 'Music — Recording',
    title: 'Recording Artist',
    udr_terms_accepted_at: '2026-09-09T00:00:00.000Z',
    // Migration 0004 columns, at their backfilled defaults.
    kyc_status: 'PENDING_INITIALIZATION',
    tax_form_type: 'W9',
    tax_verified: false,
    bank_account_linked: false,
    created_at: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

/** The EXACT signup-registry holder entry shape (PR #26 + issuance facts). */
function holderEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rightsHolderId: 'rh_session',
    name: EMAIL,
    role: 'COMPOSER',
    email: EMAIL,
    payoutRouting: {},
    uct: SESSION_UCT,
    uctCreatedAt: '2026-09-09T00:00:00.000Z',
    uctJurisdiction: 'US',
    engine: 'music_recording',
    ...overrides,
  };
}

function otherHolderEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return holderEntry({
    rightsHolderId: 'rh_other',
    name: OTHER_EMAIL,
    email: OTHER_EMAIL,
    uct: OTHER_UCT,
    ...overrides,
  });
}

interface SsrFakeOptions {
  user?: Record<string, unknown> | null;
  userError?: { message: string } | null;
  profile?: unknown;
  profileError?: { message: string } | null;
}

/**
 * A fake @supabase/ssr server client: auth.getUser + the creator_profiles
 * select().eq().maybeSingle() chain, with every call recorded so the tests
 * can assert the profile is read by the SERVER-derived auth user id.
 */
function ssrClient(options: SsrFakeOptions = {}) {
  const calls: { table: string; columns?: string; eq?: unknown[] }[] = [];
  const client = {
    calls,
    auth: {
      getUser: vi.fn(async () =>
        options.userError
          ? { data: { user: null }, error: options.userError }
          : { data: { user: options.user ?? null }, error: null },
      ),
    },
    from: vi.fn((table: string) => {
      const entry: { table: string; columns?: string; eq?: unknown[] } = { table };
      calls.push(entry);
      return {
        select: (columns: string) => {
          entry.columns = columns;
          return {
            eq: (...eqArgs: unknown[]) => {
              entry.eq = eqArgs;
              return {
                maybeSingle: vi.fn(async () => ({
                  data: options.profile ?? null,
                  error: options.profileError ?? null,
                })),
              };
            },
          };
        },
      };
    }),
  };
  return client;
}

interface ServiceFakeOptions {
  assetRows?: unknown[];
  assetsError?: { message: string } | null;
  ledgerRows?: unknown[];
  ledgerError?: { message: string } | null;
}

/** A fake service-role client: cbt_assets + universal_royalty_ledger reads. */
function serviceDb(options: ServiceFakeOptions = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'universal_royalty_ledger') {
        return {
          select: vi.fn(async () => ({ data: options.ledgerRows ?? [], error: options.ledgerError ?? null })),
        };
      }
      return {
        select: vi.fn(async () => ({ data: options.assetRows ?? [], error: options.assetsError ?? null })),
      };
    }),
  };
}

function registryAssetRows(holders: unknown[]): unknown[] {
  // One designated registry row whose rights_holders array carries every
  // holder entry — the production shape (a single CBT-SIGNUP-REGISTRY row).
  return [{ cbt_code: 'CBT-SIGNUP-REGISTRY', rights_holders: holders }];
}

/** The expectNoAccountNumbers discipline, extended from the signup route tests. */
function expectNoAccountNumbers(bodyJson: unknown): void {
  const text = JSON.stringify(bodyJson);
  expect(text).not.toContain('accountNumber');
  expect(text).not.toContain('routingNumber');
  expect(text).not.toContain('987654321');
  expect(text).not.toContain('101050001');
  expect(text).not.toContain('account_number_');
}

/** A settlement (engine) disbursement entry — no type field, numeric grossShare. */
function settlement(rightsHolderId: string, grossShare: number): Record<string, unknown> {
  return { rightsHolderId, grossShare };
}

/** A payout (type-DISBURSEMENT) escrow debit entry. */
function payout(rightsHolderId: string, payoutAmount: string): Record<string, unknown> {
  return {
    type: 'DISBURSEMENT',
    rightsHolderId,
    payoutAmount,
    amountPaid: payoutAmount,
    taxWithheld: '0',
    timestamp: 1,
    remainingNetBalance: '0',
  };
}

beforeEach(() => {
  ssrMock.readSupabasePublicEnv.mockReturnValue(PUBLIC_ENV);
  ssrMock.hasSupabaseSessionCookies.mockResolvedValue(true);
  ssrMock.createServerSupabaseClient.mockResolvedValue(ssrClient({ user: null }));
  serviceMock.supabaseFromEnv.mockReturnValue(serviceDb() as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function getJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('GET /api/covnant/me', () => {
  describe('200 — the aggregate for a valid session', () => {
    it('composes profile (0004 defaults surfaced), identity, role, provisioning status, and escrow totals', async () => {
      const client = ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() });
      ssrMock.createServerSupabaseClient.mockResolvedValue(client);
      const db = serviceDb({
        assetRows: registryAssetRows([holderEntry(), otherHolderEntry()]),
        ledgerRows: [
          { disbursements: [settlement('rh_session', 1.5)] },
          { disbursements: [settlement('rh_other', 99), settlement('rh_session', 0.25)] },
          { disbursements: [payout('rh_session', '25000000')] },
        ],
      });
      serviceMock.supabaseFromEnv.mockReturnValue(db as never);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await getJson(res);

      // (a) The full creator_profiles row — 0004 defaults surfaced, snake_case.
      expect(body.profile).toEqual(profileRow());

      // (b) The session email's holder entry — identity + role + provisioning.
      expect(body.identity).toEqual({
        uct: SESSION_UCT,
        uctCreatedAt: '2026-09-09T00:00:00.000Z',
        jurisdiction: 'US',
        engine: 'music_recording',
      });
      expect(body.role).toBe('COMPOSER');
      expect(body.provisioning).toEqual({ status: 'PENDING', reason: 'INCREASE_NOT_PROVISIONED' });

      // (c) Escrow totals: gross 1.75 (150000000 + 25000000 units), 30%
      // fallback withholding (52500000), prior payout (25000000) — BigInt
      // unit strings, exact, no float rollup.
      expect(body.settlements).toEqual({
        grossEarnings: '175000000',
        taxWithheld: '52500000',
        availableEscrowBalance: '97500000',
        isTaxVerified: false,
      });

      expectNoAccountNumbers(body);

      // The profile read is keyed to the SERVER-derived auth user id, under
      // the select that carries the 0004 columns.
      const profileEntry = client.calls.find((call) => call.table === 'creator_profiles');
      expect(profileEntry?.columns).toContain('kyc_status');
      expect(profileEntry?.columns).toContain('tax_verified');
      expect(profileEntry?.columns).toContain('bank_account_linked');
      expect(profileEntry?.eq).toEqual(['id', USER_ID]);
      // The service-role reads hit exactly the two documented tables.
      expect(db.from.mock.calls).toEqual([['cbt_assets'], ['universal_royalty_ledger']]);
    });

    it('reports PROVISIONED with no reason key when the holder stores a virtual account', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({
          assetRows: registryAssetRows([
            holderEntry({
              payoutRouting: {
                covenantVirtualAccount: {
                  accountNumberId: 'account_number_existing',
                  accountNumber: '987654321',
                  routingNumber: '101050001',
                  provisionedAt: '2026-01-01T00:00:00Z',
                },
              },
            }),
          ]),
        }) as never,
      );

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await getJson(res);
      expect(body.provisioning).toEqual({ status: 'PROVISIONED' });
      expect('reason' in (body.provisioning as Record<string, unknown>)).toBe(false);
      // Status ONLY — the stored numbers never ride the response.
      expectNoAccountNumbers(body);
    });

    it('omits the engine key when the holder entry carries none (never a fabricated vertical)', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetRows: registryAssetRows([holderEntry({ engine: undefined })]) }) as never,
      );

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await getJson(res);
      expect('engine' in (body.identity as Record<string, unknown>)).toBe(false);
    });
  });

  describe('401 — absent or invalid session', () => {
    it('returns 401 no_session without touching any client when no auth cookie is present', async () => {
      ssrMock.hasSupabaseSessionCookies.mockResolvedValue(false);
      const res = await GET();
      expect(res.status).toBe(401);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'no_session' });
      expect(ssrMock.createServerSupabaseClient).not.toHaveBeenCalled();
      expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
    });

    it('returns 401 session_invalid when getUser rejects the token', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: null, userError: { message: 'invalid claim: jwt is expired' } }),
      );
      const res = await GET();
      expect(res.status).toBe(401);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'session_invalid' });
      expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
    });
  });

  describe('UCT resolution — strictly by session email', () => {
    it('resolves the session holder and never leaks another holder’s UCT', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetRows: registryAssetRows([holderEntry(), otherHolderEntry()]) }) as never,
      );

      const body = await getJson(await GET());
      expect((body.identity as Record<string, unknown>).uct).toBe(SESSION_UCT);
      const text = JSON.stringify(body);
      expect(text).not.toContain(OTHER_UCT);
      expect(text).not.toContain(OTHER_EMAIL);
    });

    it('resolves holder B when the session belongs to B (per-tenant, not first-entry)', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({
          user: { id: 'auth_user_2', email: OTHER_EMAIL },
          profile: profileRow({ id: 'auth_user_2', email: OTHER_EMAIL }),
        }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetRows: registryAssetRows([holderEntry(), otherHolderEntry()]) }) as never,
      );

      const body = await getJson(await GET());
      expect((body.identity as Record<string, unknown>).uct).toBe(OTHER_UCT);
      const text = JSON.stringify(body);
      expect(text).not.toContain(SESSION_UCT);
    });

    it('matches the signup normalization (trim + lowercase) of the session email', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: `  ${EMAIL.toUpperCase()}  ` }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetRows: registryAssetRows([holderEntry()]) }) as never,
      );

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await getJson(res);
      expect((body.identity as Record<string, unknown>).uct).toBe(SESSION_UCT);
    });

    it('returns 404 holder_not_found when the session email holds no registry entry', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: 'stranger@example.com' }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetRows: registryAssetRows([holderEntry(), otherHolderEntry()]) }) as never,
      );

      const res = await GET();
      expect(res.status).toBe(404);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'holder_not_found' });
      const text = JSON.stringify(body);
      expect(text).not.toContain(SESSION_UCT);
      expect(text).not.toContain(OTHER_UCT);
    });

    it('returns 404 holder_not_found when the registry row does not exist yet', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(serviceDb({ assetRows: [] }) as never);

      const res = await GET();
      expect(res.status).toBe(404);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'holder_not_found' });
    });
  });

  describe('fail-closed reads and configuration', () => {
    it('returns 503 supabase_not_configured before any session check when unconfigured', async () => {
      ssrMock.readSupabasePublicEnv.mockReturnValue(null);
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'supabase_not_configured' });
      expect(ssrMock.hasSupabaseSessionCookies).not.toHaveBeenCalled();
    });

    it('returns 503 when the service-role client is unavailable', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(undefined as never);
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'supabase_not_configured' });
    });

    it('returns 502 profile_read_failed when the profile read errors (never empty data)', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profileError: { message: 'RLS violation' } }),
      );
      const res = await GET();
      expect(res.status).toBe(502);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'profile_read_failed' });
    });

    it('returns 404 profile_not_found when no profile row exists for the auth user', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: null }),
      );
      const res = await GET();
      expect(res.status).toBe(404);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'profile_not_found' });
      expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
    });

    it('returns 502 registry_read_failed when the cbt_assets read errors', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetsError: { message: 'relation missing' } }) as never,
      );
      const res = await GET();
      expect(res.status).toBe(502);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'registry_read_failed' });
    });

    it('returns 502 escrow_read_failed when the ledger read errors (fail closed, never a zero balance)', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({
          assetRows: registryAssetRows([holderEntry()]),
          ledgerError: { message: 'ledger unavailable' },
        }) as never,
      );
      const res = await GET();
      expect(res.status).toBe(502);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'escrow_read_failed' });
      const text = JSON.stringify(body);
      expect(text).not.toContain('ledger unavailable');
    });

    it('returns 502 registry_read_failed when the matched holder entry is corrupt (missing rightsHolderId)', async () => {
      ssrMock.createServerSupabaseClient.mockResolvedValue(
        ssrClient({ user: { id: USER_ID, email: EMAIL }, profile: profileRow() }),
      );
      serviceMock.supabaseFromEnv.mockReturnValue(
        serviceDb({ assetRows: registryAssetRows([holderEntry({ rightsHolderId: undefined })]) }) as never,
      );
      const res = await GET();
      expect(res.status).toBe(502);
      const body = await getJson(res);
      expect(body).toMatchObject({ ok: false, reason: 'registry_read_failed' });
      expect(JSON.stringify(body)).not.toContain(SESSION_UCT);
    });
  });
});
