import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

/**
 * Middleware contract tests — the session-refresh gate on navigation.
 * Pins: the ssr client is created from the wrapper's public env, getUser()
 * runs on every matched navigation (the refresh trigger), refreshed cookies
 * written through the adapter propagate onto the forwarded response, and an
 * unconfigured environment short-circuits to a plain passthrough without
 * constructing any client.
 */

const ssrPackageMock = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: ssrPackageMock.createServerClient,
}));

const envMock = vi.hoisted(() => ({
  readSupabasePublicEnv: vi.fn(),
}));

vi.mock('@/lib/server/supabaseSsr', () => ({
  readSupabasePublicEnv: envMock.readSupabasePublicEnv,
}));

const PUBLIC_ENV = { url: 'https://test-project.supabase.co', anonKey: 'test-anon-key' };

/**
 * A fake ssr createServerClient: captures the cookie adapter so a test can
 * simulate Supabase writing refreshed session cookies through setAll —
 * exactly what a token refresh does in production.
 */
function ssrPackageClientFake(options: { userError?: { message: string } | null; refreshedCookies?: { name: string; value: string }[] } = {}) {
  type CookieToSet = { name: string; value: string; options: Record<string, unknown> };
  const client: {
    auth: { getUser: ReturnType<typeof vi.fn> };
    lastAdapter?: { setAll: (cookies: CookieToSet[]) => void };
  } = {
    auth: {
      getUser: vi.fn(async () => {
        for (const cookie of options.refreshedCookies ?? []) {
          client.lastAdapter?.setAll([{
            name: cookie.name,
            value: cookie.value,
            options: { path: '/', httpOnly: true, sameSite: 'lax', secure: true },
          }]);
        }
        return options.userError
          ? { data: { user: null }, error: options.userError }
          : { data: { user: { id: 'auth_user_1' } }, error: null };
      }),
    },
  };
  ssrPackageMock.createServerClient.mockImplementation(
    (_url: string, _key: string, config: { cookies: unknown }) => {
      client.lastAdapter = config.cookies as { setAll: (cookies: CookieToSet[]) => void };
      return client;
    },
  );
  return client;
}

function requestFor(path: string): NextRequest {
  return new NextRequest(`https://covnant.example${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.readSupabasePublicEnv.mockReturnValue(PUBLIC_ENV);
  ssrPackageClientFake();
});

describe('middleware', () => {
  it('calls getUser on every matched navigation to trigger the token refresh', async () => {
    const client = ssrPackageClientFake();

    const response = await middleware(requestFor('/dashboard'));

    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.cookies.getAll()).toEqual([]);
  });

  it('propagates refreshed session cookies onto the forwarded response', async () => {
    ssrPackageClientFake({ refreshedCookies: [{ name: 'sb-ref-auth-token', value: 'refreshed-value' }] });

    const response = await middleware(requestFor('/dashboard'));

    expect(response.cookies.get('sb-ref-auth-token')?.value).toBe('refreshed-value');
  });

  it('does not redirect or gate unauthenticated navigations (sessions are enforced at the data layer)', async () => {
    ssrPackageClientFake({ userError: { message: 'Auth session missing' } });

    const response = await middleware(requestFor('/dashboard'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('passes through without constructing a client when the environment is unconfigured', async () => {
    envMock.readSupabasePublicEnv.mockReturnValue(null);

    const response = await middleware(requestFor('/dashboard'));

    expect(ssrPackageMock.createServerClient).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});
