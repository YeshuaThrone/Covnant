import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PREVIEW_DEMO_CREATOR_EMAIL,
  PREVIEW_DEMO_CREATOR_PASSWORD,
} from '@/lib/server/previewDemoAccess';

/**
 * GET /api/preview/demo-login — the preview-only auto-session door.
 *
 * The Supabase session client is mocked at the @supabase/ssr wrapper (the
 * same boundary every route suite mocks); these tests pin the CONTRACT:
 * inert outside preview (404 with the client never constructed and no
 * credential touched), the sign-in call carrying exactly the seeded demo
 * credentials in preview, the /dashboard redirect on success, and the
 * /signin?demo_login_failed=1 failure redirect (never back to /dashboard —
 * the page hook cannot loop).
 */

const ssrMock = vi.hoisted(() => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock('@/lib/server/supabaseSsr', () => ({
  createServerSupabaseClient: ssrMock.createServerSupabaseClient,
}));

const { GET } = await import('../route');

function demoClient(signIn: ReturnType<typeof vi.fn>) {
  return { auth: { signInWithPassword: signIn } };
}

afterEach(() => {
  delete process.env.VERCEL_ENV;
  vi.clearAllMocks();
});

describe('GET /api/preview/demo-login', () => {
  it('is inert in production: 404, client never constructed, no credentials touched', async () => {
    process.env.VERCEL_ENV = 'production';
    ssrMock.createServerSupabaseClient.mockResolvedValue(demoClient(vi.fn()));

    const response = await GET();

    expect(response.status).toBe(404);
    expect(ssrMock.createServerSupabaseClient).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('nova@example.com');
  });

  it('is inert when VERCEL_ENV is unset (non-Vercel production-style run)', async () => {
    delete process.env.VERCEL_ENV;
    ssrMock.createServerSupabaseClient.mockResolvedValue(demoClient(vi.fn()));

    const response = await GET();

    expect(response.status).toBe(404);
    expect(ssrMock.createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it('in preview, signs in the seeded demo creator and redirects to /dashboard', async () => {
    process.env.VERCEL_ENV = 'preview';
    const signIn = vi.fn().mockResolvedValue({ error: null });
    ssrMock.createServerSupabaseClient.mockResolvedValue(demoClient(signIn));

    const response = await GET();

    expect(signIn).toHaveBeenCalledWith({
      email: PREVIEW_DEMO_CREATOR_EMAIL,
      password: PREVIEW_DEMO_CREATOR_PASSWORD,
    });
    expect(response.status).toBe(307);
    // Relative Location (RFC 7231): resolved by the browser against the
    // requesting origin. An absolute Location built from `request.url`
    // leaks the deployment's internal origin (localhost behind the proxy)
    // and strands external users on their own machine.
    expect(response.headers.get('location')).toBe('/dashboard');
    expect(response.headers.get('location')).not.toMatch(/^https?:\/\//i);
    expect(response.headers.get('location')).not.toContain('localhost');
  });

  it('on sign-in failure redirects to /signin with the failed param — never to /dashboard', async () => {
    process.env.VERCEL_ENV = 'preview';
    const signIn = vi.fn().mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    ssrMock.createServerSupabaseClient.mockResolvedValue(demoClient(signIn));

    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/signin?demo_login_failed=1');
    expect(response.headers.get('location')).not.toMatch(/^https?:\/\//i);
    expect(response.headers.get('location')).not.toContain('localhost');
  });

  it('with no configured Supabase client redirects to /signin with the failed param', async () => {
    process.env.VERCEL_ENV = 'preview';
    ssrMock.createServerSupabaseClient.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/signin?demo_login_failed=1');
    expect(response.headers.get('location')).not.toMatch(/^https?:\/\//i);
    expect(response.headers.get('location')).not.toContain('localhost');
  });
});
