/**
 * The session-bound identity resolver — the security-critical unit suite.
 * Pins the fail-closed posture: the identity resolves from the VERIFIED
 * session only (auth.getUser() — never a client-supplied id/email), the
 * profile row is selected under select-own RLS, the registry holder is
 * matched strictly by the SESSION email (normalized like the signup stores
 * it), the payee key is the holder's rightsHolderId, read FAILURES throw
 * (never silently degrade), and nothing beyond the greeting/readiness
 * facts is returned.
 *
 * The Supabase seams (supabaseSsr helpers + supabaseFromEnv) are module
 * mocks — the resolver's own logic is what's under test.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/server/supabaseSsr', () => ({
  readSupabasePublicEnv: vi.fn(),
  hasSupabaseSessionCookies: vi.fn(),
  createServerSupabaseClient: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: vi.fn(),
}));

import {
  readSupabasePublicEnv,
  hasSupabaseSessionCookies,
  createServerSupabaseClient,
} from '@/lib/server/supabaseSsr';
import { supabaseFromEnv } from '@/lib/supabase';
import { resolveSessionCreator, SessionCreatorReadError } from '@/lib/server/sessionCreator';

/** The session user the mock auth server validates. */
const SESSION_USER = { id: 'auth-user-1', email: '  NOVA@example.com ' };

/** A registry holder for the session's email — with a PROVISIONED account. */
const PROVISIONED_HOLDER = {
  rightsHolderId: 'rh_nova_reign_don',
  email: 'nova@example.com', // stored normalized (trim + lowercase)
  payoutRouting: {
    covenantVirtualAccount: {
      accountNumberId: 'an_1',
      accountNumber: '123456789',
      routingNumber: '021000021',
      provisionedAt: '2026-08-01T00:00:00.000Z',
    },
  },
};

/** A minimal creator_profiles row for the session user. */
const PROFILE_ROW = {
  id: 'auth-user-1',
  stage_name: 'Nova Reign',
  kyc_status: 'APPROVED',
  bank_account_linked: true,
};

/** Builds the mock session client: auth.getUser + the profile query chain. */
function mockSessionClient(options: {
  user?: typeof SESSION_USER | null;
  userError?: Error | null;
  profile?: Record<string, unknown> | null;
  profileError?: Error | null;
}): void {
  const { user = SESSION_USER, userError = null, profile = PROFILE_ROW, profileError = null } =
    options;
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user }, error: userError }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: profile, error: profileError }),
        }),
      }),
    }),
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
}

/** Mocks the registry (cbt_assets) read — service-role client. */
function mockRegistry(rows: Array<{ cbt_code: string; rights_holders: unknown }>): void {
  vi.mocked(supabaseFromEnv).mockReturnValue({
    from: () => ({
      select: async () => ({ data: rows, error: null }),
    }),
  } as unknown as ReturnType<typeof supabaseFromEnv>);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default posture: session env configured, cookies present, client live.
  vi.mocked(readSupabasePublicEnv).mockReturnValue({
    url: 'https://stub.supabase.co',
    anonKey: 'stub',
  });
  vi.mocked(hasSupabaseSessionCookies).mockResolvedValue(true);
  mockRegistry([{ cbt_code: 'CBT-SIGNUP-REGISTRY', rights_holders: [PROVISIONED_HOLDER] }]);
});

describe('resolveSessionCreator — the anonymous states', () => {
  it('resolves anonymous when Supabase is not configured', async () => {
    vi.mocked(readSupabasePublicEnv).mockReturnValue(null);

    await expect(resolveSessionCreator()).resolves.toEqual({ kind: 'anonymous' });
  });

  it('resolves anonymous with no session cookies', async () => {
    vi.mocked(hasSupabaseSessionCookies).mockResolvedValue(false);

    await expect(resolveSessionCreator()).resolves.toEqual({ kind: 'anonymous' });
  });

  it('resolves anonymous when the session client cannot be created', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(null);

    await expect(resolveSessionCreator()).resolves.toEqual({ kind: 'anonymous' });
  });

  it('resolves anonymous when the session is invalid or expired (getUser error)', async () => {
    mockSessionClient({ userError: new Error('invalid claim') });

    await expect(resolveSessionCreator()).resolves.toEqual({ kind: 'anonymous' });
  });
});

describe('resolveSessionCreator — the unregistered states', () => {
  it('resolves unregistered when the auth user has no creator_profiles row', async () => {
    mockSessionClient({ profile: null });

    await expect(resolveSessionCreator()).resolves.toEqual({
      kind: 'unregistered',
      reason: 'profile_not_found',
    });
  });

  it('resolves unregistered when no registry holder matches the session email', async () => {
    mockSessionClient({});
    mockRegistry([
      { cbt_code: 'CBT-SIGNUP-REGISTRY', rights_holders: [{ ...PROVISIONED_HOLDER, email: 'other@example.com' }] },
    ]);

    await expect(resolveSessionCreator()).resolves.toEqual({
      kind: 'unregistered',
      reason: 'holder_not_found',
    });
  });
});

describe('resolveSessionCreator — read failures fail closed (throw)', () => {
  it('throws profile_read_failed when the profile read errors', async () => {
    mockSessionClient({ profileError: new Error('RLS violation') });

    await expect(resolveSessionCreator()).rejects.toMatchObject({
      name: 'SessionCreatorReadError',
      code: 'profile_read_failed',
    });
  });

  it('throws registry_read_failed when the registry read errors', async () => {
    mockSessionClient({});
    vi.mocked(supabaseFromEnv).mockReturnValue({
      from: () => ({
        select: async () => ({ data: null, error: { message: 'permission denied' } }),
      }),
    } as unknown as ReturnType<typeof supabaseFromEnv>);

    await expect(resolveSessionCreator()).rejects.toBeInstanceOf(SessionCreatorReadError);
    await expect(resolveSessionCreator()).rejects.toMatchObject({ code: 'registry_read_failed' });
  });

  it('throws registry_read_failed when the matched holder has no rightsHolderId', async () => {
    mockSessionClient({});
    mockRegistry([
      // The key PRESENT but empty — a corrupted entry, not an absent one.
      { cbt_code: 'CBT-SIGNUP-REGISTRY', rights_holders: [{ rightsHolderId: '', email: 'nova@example.com' }] },
    ]);

    await expect(resolveSessionCreator()).rejects.toMatchObject({
      code: 'registry_read_failed',
    });
  });
});

describe('resolveSessionCreator — the registered identity', () => {
  it('binds the payee to the SESSION email holder, exposing readiness facts only', async () => {
    mockSessionClient({});

    const resolution = await resolveSessionCreator();
    expect(resolution.kind).toBe('registered');
    if (resolution.kind !== 'registered') return; // exhaustiveness guard

    expect(resolution.creator).toEqual({
      payee_id: 'rh_nova_reign_don',
      stage_name: 'Nova Reign',
      kyc_status: 'APPROVED',
      bank_account_linked: true,
      provisioning_status: 'PROVISIONED',
    });
    // The identity payload never carries identity documents or secrets.
    expect(JSON.stringify(resolution.creator)).not.toContain('123456789');
    expect(JSON.stringify(resolution.creator)).not.toContain('021000021');
    expect(JSON.stringify(resolution.creator)).not.toContain('UCT-');
  });

  it('marks an unprovisioned holder PENDING (no stored virtual account)', async () => {
    mockSessionClient({});
    mockRegistry([
      {
        cbt_code: 'CBT-SIGNUP-REGISTRY',
        rights_holders: [
          {
            rightsHolderId: 'rh_nova_reign_don',
            email: 'nova@example.com',
            // No payoutRouting.covenantVirtualAccount — PENDING.
          },
        ],
      },
    ]);

    const resolution = await resolveSessionCreator();
    expect(resolution.kind).toBe('registered');
    if (resolution.kind !== 'registered') return;

    expect(resolution.creator.provisioning_status).toBe('PENDING');
  });

  it('matches the holder despite session-email casing/whitespace (signup normalization)', async () => {
    mockSessionClient({ user: { id: 'auth-user-1', email: 'Nova@Example.com ' } });

    const resolution = await resolveSessionCreator();
    expect(resolution.kind).toBe('registered');
    if (resolution.kind !== 'registered') return;

    expect(resolution.creator.payee_id).toBe('rh_nova_reign_don');
  });
});
