import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_SECONDS,
  adminPasswordMatches,
  adminSessionCookie,
  adminSessionTokenFromCookieHeader,
  checkAdminGate,
  mintAdminSessionToken,
  readAdminPassword,
  verifyAdminSession,
} from '../gate';

/**
 * Admin gate unit tests — the fail-closed contract. The shared-secret gate
 * must deny every request when the secret is unset (the console does not
 * exist), reject wrong passwords and forged/expired tokens, and mint a
 * signed, expiring, httpOnly session cookie on success. Env mutations are
 * restored after every test.
 */

const PASSWORD = 'test-admin-password-1234';

/**
 * The gate reads Supabase through the module's supabaseFromEnv seam (the
 * same seam sessionCreator.test.ts mocks): the real factory's createClient
 * builds a realtime client that throws in the node test environment (no
 * WebSocket constructor), and the gate's contract is only
 * undefined-vs-configured — never the client itself.
 */
const supabaseMock = vi.hoisted(() => ({
  supabaseFromEnv: vi.fn<() => SupabaseClient | undefined>(() => undefined),
}));

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: supabaseMock.supabaseFromEnv }));

function withEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.ADMIN_DASHBOARD_PASSWORD;
  else process.env.ADMIN_DASHBOARD_PASSWORD = value;
}

/**
 * The Supabase half of the carve-out's new precondition (audit F8): the
 * passwordless door opens only when no database is configured.
 */
function withSupabase(configured: boolean): void {
  supabaseMock.supabaseFromEnv.mockReturnValue(configured ? ({} as SupabaseClient) : undefined);
}

afterEach(() => {
  withEnv(undefined);
});

describe('readAdminPassword / adminPasswordMatches — fail closed when unset', () => {
  it('returns null and refuses every candidate when the env var is unset', () => {
    withEnv(undefined);
    expect(readAdminPassword()).toBeNull();
    expect(adminPasswordMatches('anything')).toBe(false);
    expect(adminPasswordMatches('')).toBe(false);
  });

  it('accepts the exact secret and rejects everything else when set', () => {
    withEnv(PASSWORD);
    expect(readAdminPassword()).toBe(PASSWORD);
    expect(adminPasswordMatches(PASSWORD)).toBe(true);
    expect(adminPasswordMatches('wrong-password')).toBe(false);
    expect(adminPasswordMatches(`${PASSWORD} `)).toBe(false);
    expect(adminPasswordMatches('')).toBe(false);
  });
});

describe('mintAdminSessionToken / verifyAdminSession — signed expiring sessions', () => {
  it('refuses to mint when the secret is unset (fail closed)', () => {
    withEnv(undefined);
    expect(mintAdminSessionToken()).toBeNull();
  });

  it('mints a token that verifies when the secret is set', () => {
    withEnv(PASSWORD);
    const token = mintAdminSessionToken();
    expect(typeof token).toBe('string');
    expect(verifyAdminSession(token)).toEqual({ ok: true });
  });

  it('rejects an absent token with 401 admin_not_authenticated', () => {
    withEnv(PASSWORD);
    const verdict = verifyAdminSession(null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(401);
      expect(verdict.code).toBe('admin_not_authenticated');
    }
  });

  it('rejects a garbage token with 401 (never a 5xx or a pass)', () => {
    withEnv(PASSWORD);
    for (const garbage of ['', 'not-a-token', 'a.b', '...']) {
      const verdict = verifyAdminSession(garbage);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(401);
    }
  });

  it('rejects a token minted under a DIFFERENT secret (signature mismatch)', () => {
    withEnv(PASSWORD);
    const token = mintAdminSessionToken();
    withEnv('a-completely-different-secret');
    const verdict = verifyAdminSession(token);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.status).toBe(401);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    withEnv(PASSWORD);
    const token = mintAdminSessionToken()!;
    const [payload, signature] = token.split('.');
    const forged = `${Number(payload) + 60_000}.${signature}`;
    const verdict = verifyAdminSession(forged);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.status).toBe(401);
  });

  it('rejects an expired token (TTL elapsed) with 401', () => {
    withEnv(PASSWORD);
    const token = mintAdminSessionToken();
    const afterTtl = new Date(Date.now() + (ADMIN_SESSION_TTL_SECONDS + 5) * 1000);
    const verdict = verifyAdminSession(token, process.env, afterTtl);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.status).toBe(401);
  });

  it('answers admin_not_configured (fail closed) when the secret disappears', () => {
    withEnv(undefined);
    const verdict = verifyAdminSession('1.2');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(503);
      expect(verdict.code).toBe('admin_not_configured');
    }
  });
});

describe('adminSessionTokenFromCookieHeader — cookie parsing', () => {
  it('extracts the admin token from a multi-cookie header', () => {
    expect(
      adminSessionTokenFromCookieHeader(`other=1; ${ADMIN_COOKIE_NAME}=tok-abc; more=2`),
    ).toBe('tok-abc');
  });

  it('tolerates missing spaces and returns null when absent', () => {
    expect(adminSessionTokenFromCookieHeader(`${ADMIN_COOKIE_NAME}=tok-abc`)).toBe('tok-abc');
    expect(adminSessionTokenFromCookieHeader('other=1')).toBeNull();
    expect(adminSessionTokenFromCookieHeader('')).toBeNull();
    expect(adminSessionTokenFromCookieHeader(null)).toBeNull();
    expect(adminSessionTokenFromCookieHeader(undefined)).toBeNull();
  });
});

describe('adminSessionCookie / checkAdminGate — the cookie the routes verify', () => {
  it('sets an httpOnly SameSite=Lax scoped cookie with the TTL', () => {
    withEnv(PASSWORD);
    const cookie = adminSessionCookie('tok-abc');
    expect(cookie).toContain(`${ADMIN_COOKIE_NAME}=tok-abc`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_SECONDS}`);
    expect(cookie).not.toContain('Secure');
  });

  it('round-trips through checkAdminGate: minted cookie passes, none fails', async () => {
    withEnv(PASSWORD);
    const token = mintAdminSessionToken()!;
    const ok = await checkAdminGate(new Request('https://covnant.test/api/admin/creators', {
      headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` },
    }));
    expect(ok).toEqual({ ok: true });

    const denied = await checkAdminGate(new Request('https://covnant.test/api/admin/creators'));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(401);
      expect(denied.code).toBe('admin_not_authenticated');
      expect(denied.message).not.toContain(PASSWORD);
    }
  });
});

describe('verifyAdminSession — the DON_DEV_SEED carve-out is deployment-aware (J1 preview)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    withEnv(undefined);
    withSupabase(false);
    delete process.env.DON_DEV_SEED;
    delete process.env.VERCEL_ENV;
  });

  it('opens without a password under DON_DEV_SEED=1 on a production-BUILD preview server (next start e2e)', () => {
    // The seeded preview runs `next build && next start`: NODE_ENV is
    // 'production' there, and the deployment tier (VERCEL_ENV) is unset.
    // The door opens only over NO database (audit F8) — Supabase unconfigured.
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DON_DEV_SEED = '1';
    withEnv(undefined);
    withSupabase(false);
    expect(verifyAdminSession(null)).toEqual({ ok: true });
  });

  it('opens on a Vercel preview deployment (VERCEL_ENV=preview) — also a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'preview');
    process.env.DON_DEV_SEED = '1';
    withEnv(undefined);
    withSupabase(false);
    expect(verifyAdminSession(null)).toEqual({ ok: true });
  });

  it('refuses the carve-out when Supabase IS configured — real data demands the operator secret (audit F8)', () => {
    // The F8 footgun: a staging deploy with real credentials and no
    // password must not expose a full operator console over real data,
    // seed flag or not — the demo door's rule, applied to the gate.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'preview');
    process.env.DON_DEV_SEED = '1';
    withEnv(undefined);
    withSupabase(true);
    const verdict = verifyAdminSession(null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(503);
      expect(verdict.code).toBe('admin_not_configured');
    }
  });

  it('refuses the carve-out on a passwordless next start with Supabase configured (the e2e-shaped deployment tier)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DON_DEV_SEED = '1';
    withEnv(undefined);
    withSupabase(true);
    const verdict = verifyAdminSession(null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(503);
      expect(verdict.code).toBe('admin_not_configured');
    }
  });

  it('NEVER opens a production DEPLOYMENT console on the seed flag — 503 admin_not_configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    process.env.DON_DEV_SEED = '1';
    withEnv(undefined);
    const verdict = verifyAdminSession(null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(503);
      expect(verdict.code).toBe('admin_not_configured');
    }
  });

  it('a configured password still requires the cookie even with the seed flag set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DON_DEV_SEED = '1';
    withEnv(PASSWORD);
    const verdict = verifyAdminSession(null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(401);
      expect(verdict.code).toBe('admin_not_authenticated');
    }
  });
});
