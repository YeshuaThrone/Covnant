import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';

/**
 * /auth/callback contract tests — the landing point for Supabase
 * email-confirmation links. Pins: PKCE code exchange, allow-listed
 * email-token (token_hash + type) verification, the /dashboard redirect on
 * success, the landing redirect on every failure mode, and the hard reject
 * of verification types outside the allow-list (no otp sent with a foreign
 * type).
 */

const ssrMock = vi.hoisted(() => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock('@/lib/server/supabaseSsr', () => ({
  createServerSupabaseClient: ssrMock.createServerSupabaseClient,
}));

const ORIGIN = 'https://covnant.example';

function callbackUrl(params: string): string {
  return `${ORIGIN}/auth/callback${params}`;
}

/** A fake ssr server client exposing the two auth exchange paths. */
function clientFake(options: { exchangeError?: { message: string } | null; otpError?: { message: string } | null } = {}) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async (code: string) => ({ data: { code }, error: options.exchangeError ?? null })),
      verifyOtp: vi.fn(async (params: { type: string; token_hash: string }) => ({ data: params, error: options.otpError ?? null })),
    },
  };
}

beforeEach(() => {
  ssrMock.createServerSupabaseClient.mockResolvedValue(clientFake());
});

describe('GET /auth/callback', () => {
  it('exchanges the PKCE code for a session and redirects to /dashboard', async () => {
    const client = clientFake();
    ssrMock.createServerSupabaseClient.mockResolvedValue(client);

    const res = await GET(new Request(callbackUrl('?code=auth-code-1')));

    expect(client.auth.exchangeCodeForSession).toHaveBeenCalledWith('auth-code-1');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/dashboard`);
  });

  it('redirects to the landing route when the code exchange fails', async () => {
    ssrMock.createServerSupabaseClient.mockResolvedValue(
      clientFake({ exchangeError: { message: 'invalid code verifier' } }),
    );

    const res = await GET(new Request(callbackUrl('?code=auth-code-1')));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('verifies an allow-listed email token_hash link and redirects to /dashboard', async () => {
    const client = clientFake();
    ssrMock.createServerSupabaseClient.mockResolvedValue(client);

    const res = await GET(new Request(callbackUrl('?token_hash=link-token&type=signup')));

    expect(client.auth.verifyOtp).toHaveBeenCalledWith({ type: 'signup', token_hash: 'link-token' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/dashboard`);
  });

  it('redirects to the landing route when token verification fails', async () => {
    ssrMock.createServerSupabaseClient.mockResolvedValue(
      clientFake({ otpError: { message: 'email link is invalid or has expired' } }),
    );

    const res = await GET(new Request(callbackUrl('?token_hash=link-token&type=signup')));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('never sends a verification token with a non-allow-listed type', async () => {
    const client = clientFake();
    ssrMock.createServerSupabaseClient.mockResolvedValue(client);

    const res = await GET(new Request(callbackUrl('?token_hash=link-token&type=sms')));

    expect(client.auth.verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('redirects to the landing route when neither a code nor a token_hash is present', async () => {
    const client = clientFake();
    ssrMock.createServerSupabaseClient.mockResolvedValue(client);

    const res = await GET(new Request(callbackUrl('')));

    expect(client.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(client.auth.verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('redirects to the landing route when the session client is unavailable (unconfigured env)', async () => {
    ssrMock.createServerSupabaseClient.mockResolvedValue(undefined);

    const res = await GET(new Request(callbackUrl('?code=auth-code-1')));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });
});
