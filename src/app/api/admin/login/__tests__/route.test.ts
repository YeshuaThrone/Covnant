import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';

/**
 * POST /api/admin/login contract tests. Fail closed FIRST: unset
 * ADMIN_DASHBOARD_PASSWORD → 503 admin_not_configured and no Set-Cookie —
 * the console must not even hint that it exists; wrong password → 401,
 * likewise cookieless. Success mints the signed httpOnly session cookie and
 * the minted token verifies through the same gate every /api/admin route
 * uses. The rate limiter is mocked (its bucket is module-global state) with
 * the real limiter's shape.
 */

const PASSWORD = 'test-admin-password-1234';

const rateMock = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/server/rateLimit', () => ({
  checkRateLimit: rateMock.checkRateLimit,
  ADMIN_LOGIN_RATE_LIMIT: { limit: 5, windowMs: 60_000 },
}));

function loginRequest(password: unknown): Request {
  return new Request('https://covnant.test/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

async function postJson(request: Request): Promise<{ status: number; body: Record<string, unknown>; setCookie: string | null }> {
  const res = await POST(request);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    setCookie: res.headers.get('set-cookie'),
  };
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  rateMock.checkRateLimit.mockReturnValue({ ok: true });
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  vi.clearAllMocks();
});

describe('POST /api/admin/login', () => {
  describe('fail closed — unset secret', () => {
    it('answers 503 admin_not_configured with NO cookie and no data', async () => {
      delete process.env.ADMIN_DASHBOARD_PASSWORD;
      const { status, body, setCookie } = await postJson(loginRequest(PASSWORD));
      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, reason: 'admin_not_configured', error: 'Admin dashboard is not configured.' });
      expect(setCookie).toBeNull();
      // The correct password gains nothing when the secret is unset.
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    });
  });

  describe('wrong password', () => {
    it('answers 401 admin_invalid_password with NO cookie and no data', async () => {
      const { status, body, setCookie } = await postJson(loginRequest('definitely-wrong'));
      expect(status).toBe(401);
      expect(body).toEqual({ ok: false, reason: 'admin_invalid_password', error: 'Incorrect password.' });
      expect(setCookie).toBeNull();
    });

    it('never echoes the configured secret in the failure', async () => {
      const { body } = await postJson(loginRequest('definitely-wrong'));
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    });
  });

  describe('validation before rate limiting', () => {
    it('answers 400 for a malformed body without burning the rate bucket', async () => {
      const request = new Request('https://covnant.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      });
      const { status, body } = await postJson(request);
      expect(status).toBe(400);
      expect(body.reason).toBe('malformed_body');
      expect(rateMock.checkRateLimit).not.toHaveBeenCalled();
    });

    it('answers 400 for a missing/empty password', async () => {
      expect((await postJson(loginRequest(undefined))).status).toBe(400);
      expect((await postJson(loginRequest(''))).status).toBe(400);
      expect(rateMock.checkRateLimit).not.toHaveBeenCalled();
    });
  });

  it('answers 429 when the rate limiter denies the attempt', async () => {
    rateMock.checkRateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 60 });
    const { status, body } = await postJson(loginRequest(PASSWORD));
    expect(status).toBe(429);
    expect(body.reason).toBe('rate_limited');
  });

  describe('success — the signed cookie session', () => {
    it('mints an httpOnly cookie whose token verifies through the admin gate', async () => {
      const { status, body, setCookie } = await postJson(loginRequest(PASSWORD));
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(setCookie).toContain(`${ADMIN_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
      // No cache — the session handoff must never be stored.
      expect(setCookie).toBeTruthy();

      const token = setCookie!.split(';')[0].split('=')[1];
      expect(verifyAdminSession(token)).toEqual({ ok: true });
      // The password itself is never stored in or recoverable from the token.
      expect(token).not.toContain(PASSWORD);
    });

    it('uses no-store so the authenticated handoff is never cached', async () => {
      const request = new Request('https://covnant.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const res = await POST(request);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});
