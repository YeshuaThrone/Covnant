import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSupabaseSessionCookies, readSupabasePublicEnv } from '../supabaseSsr';

/**
 * The @supabase/ssr wrapper module tests — environment resolution and the
 * cookie-presence gate. Client construction with a live config is exercised
 * indirectly through the route/middleware suites; here the boundary that
 * matters is fail-closed configuration (missing env → null) and session
 * detection (Supabase auth cookies, including chunked fragments).
 */

const cookiesMock = vi.hoisted(() => ({
  cookies: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: cookiesMock.cookies,
}));

function cookieStore(cookies: { name: string; value: string }[]): { getAll: () => { name: string; value: string }[] } {
  return { getAll: () => cookies };
}

beforeEach(() => {
  cookiesMock.cookies.mockReset();
});

describe('readSupabasePublicEnv', () => {
  // The repo augments ProcessEnv with a required NODE_ENV; these literals
  // isolate exactly the names the function reads.
  const asEnv = (env: Record<string, string>) => env as unknown as NodeJS.ProcessEnv;

  it('reads the standard SUPABASE_URL / SUPABASE_ANON_KEY names', () => {
    expect(
      readSupabasePublicEnv(
        asEnv({
          SUPABASE_URL: 'https://a.supabase.co',
          SUPABASE_ANON_KEY: 'key-a',
        }),
      ),
    ).toEqual({ url: 'https://a.supabase.co', anonKey: 'key-a' });
  });

  it('falls back to the NEXT_PUBLIC_ names', () => {
    expect(
      readSupabasePublicEnv(
        asEnv({
          NEXT_PUBLIC_SUPABASE_URL: 'https://b.supabase.co',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key-b',
        }),
      ),
    ).toEqual({ url: 'https://b.supabase.co', anonKey: 'key-b' });
  });

  it('returns null when neither naming scheme is fully present', () => {
    expect(readSupabasePublicEnv(asEnv({}))).toBeNull();
    expect(readSupabasePublicEnv(asEnv({ SUPABASE_URL: 'https://c.supabase.co' }))).toBeNull();
    expect(readSupabasePublicEnv(asEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key-d' }))).toBeNull();
  });
});

describe('hasSupabaseSessionCookies', () => {
  it('is true when a baseauth session cookie is present', async () => {
    cookiesMock.cookies.mockResolvedValue(
      cookieStore([{ name: 'sb-ref-baseauth-auth-token', value: 'token' }]),
    );
    await expect(hasSupabaseSessionCookies()).resolves.toBe(true);
  });

  it('is true when a chunked cookie fragment is present', async () => {
    cookiesMock.cookies.mockResolvedValue(
      cookieStore([{ name: 'sb-ref-auth-token.0', value: 'frag' }]),
    );
    await expect(hasSupabaseSessionCookies()).resolves.toBe(true);
  });

  it('is false when no auth cookies are present', async () => {
    cookiesMock.cookies.mockResolvedValue(
      cookieStore([{ name: 'other-cookie', value: 'x' }]),
    );
    await expect(hasSupabaseSessionCookies()).resolves.toBe(false);
  });
});
