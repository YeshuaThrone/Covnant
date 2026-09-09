import { afterEach, describe, expect, it } from 'vitest';
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

function withEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.ADMIN_DASHBOARD_PASSWORD;
  else process.env.ADMIN_DASHBOARD_PASSWORD = value;
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
