import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '@/lib/db';
import { POST } from '../route';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { ADMIN_LOGIN_RATE_LIMIT, resetRateLimits } from '@/lib/server/rateLimit';

/**
 * POST /api/admin/login contract tests. Fail closed FIRST: unset
 * ADMIN_DASHBOARD_PASSWORD → 503 admin_not_configured and no Set-Cookie —
 * the console must not even hint that it exists; wrong password → 401,
 * likewise cookieless. Success mints the signed httpOnly session cookie and
 * the minted token verifies through the same gate every /api/admin route
 * uses.
 *
 * The REAL limiter runs (audit F9): the route must exercise the durable
 * shared limiter, so its BACKING is stubbed instead of the limiter itself —
 * getDb() returns null by default (the deterministic in-memory fallback,
 * whatever ambient DATABASE_URL the shell carries) or a fake store-backed
 * db for the shared-store contract, the same fake the shared limiter's own
 * tests pin.
 */

const PASSWORD = 'test-admin-password-1234';

const dbMock = vi.hoisted(() => ({ getDb: vi.fn<() => Db | null>(() => null) }));

vi.mock('@/lib/db', () => ({ getDb: dbMock.getDb }));

/** What the fake's store keeps per bucket key. */
type FakeBucket = { window_start_ms: number; hit_count: number };

function fakeResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows } as unknown as QueryResult<T>;
}

/** One store-backed "isolate": its own db client over the SHARED store Map. */
function makeFakeDb(store: Map<string, FakeBucket>): Db {
  const reject = (sql: string): never => {
    throw new Error(`Fake db received an unexpected statement: ${sql.slice(0, 140)}…`);
  };
  return {
    async query<T extends QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      if (sql.includes('CREATE TABLE IF NOT EXISTS rate_limit_buckets')) {
        return fakeResult([]) as unknown as QueryResult<T>;
      }
      if (sql.includes('INSERT INTO rate_limit_buckets')) {
        // The atomicity contract the shared limiter's tests pin: ONE
        // statement, conflict-targeted upsert, verdict from RETURNING —
        // never a read-then-write pair.
        if (!sql.includes('ON CONFLICT (bucket_key) DO UPDATE')) reject(sql);
        if (!sql.includes('RETURNING hit_count, window_start_ms')) reject(sql);
        const [key, nowMs, windowMs] = params as [string, number, number];
        const existing = store.get(key);
        // The same window-expiry CASE the SQL expresses: expired windows
        // reset to a fresh bucket, live windows increment in place.
        const row =
          existing === undefined || existing.window_start_ms + windowMs <= nowMs
            ? { window_start_ms: nowMs, hit_count: 1 }
            : { window_start_ms: existing.window_start_ms, hit_count: existing.hit_count + 1 };
        store.set(key, row);
        // BIGINT arrives as a string from real pg — return it as one.
        return fakeResult([
          { hit_count: row.hit_count, window_start_ms: String(row.window_start_ms) },
        ]) as unknown as QueryResult<T>;
      }
      if (sql.includes('DELETE FROM rate_limit_buckets')) {
        const [cutoff] = params as [number];
        for (const [key, bucket] of store) {
          if (bucket.window_start_ms < cutoff) store.delete(key);
        }
        return fakeResult([]) as QueryResult<T>;
      }
      return reject(sql);
    },
    async transaction() {
      throw new Error('The rate limiter never opens a transaction.');
    },
  } as Db;
}

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
  // Default: the in-memory fallback — deterministic regardless of any
  // DATABASE_URL the environment might carry.
  dbMock.getDb.mockReturnValue(null);
  resetRateLimits();
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
      // Behavioral: the bucket was never touched — the FULL budget is
      // still available to real attempts afterward.
      for (let i = 0; i < ADMIN_LOGIN_RATE_LIMIT.limit; i += 1) {
        expect((await postJson(loginRequest('definitely-wrong'))).status).toBe(401);
      }
    });

    it('answers 400 for a missing/empty password and preserves the full budget', async () => {
      expect((await postJson(loginRequest(undefined))).status).toBe(400);
      expect((await postJson(loginRequest(''))).status).toBe(400);
      for (let i = 0; i < ADMIN_LOGIN_RATE_LIMIT.limit; i += 1) {
        expect((await postJson(loginRequest('definitely-wrong'))).status).toBe(401);
      }
    });
  });

  it('answers 429 once attempts exceed the configured budget', async () => {
    for (let i = 0; i < ADMIN_LOGIN_RATE_LIMIT.limit; i += 1) {
      expect((await postJson(loginRequest('definitely-wrong'))).status).toBe(401);
    }
    // Over budget — and the CORRECT password is refused too: the budget
    // guards the secret's brute-force window before any password check.
    const over = await postJson(loginRequest(PASSWORD));
    expect(over.status).toBe(429);
    expect(over.body.reason).toBe('rate_limited');
  });

  describe('the durable shared limiter (audit F9)', () => {
    it('rejects beyond the budget even when every request lands on a DIFFERENT isolate', async () => {
      // One Postgres store, a FRESH db client per request — the exact shape
      // that defeats a per-isolate in-memory counter: every request's
      // limiter starts empty, yet the count survives because it lives in
      // the store, so the (limit+1)th attempt is still rejected.
      const store = new Map<string, FakeBucket>();
      dbMock.getDb.mockImplementation(() => makeFakeDb(store));

      for (let i = 0; i < ADMIN_LOGIN_RATE_LIMIT.limit; i += 1) {
        expect((await postJson(loginRequest('definitely-wrong'))).status).toBe(401);
      }
      const over = await postJson(loginRequest(PASSWORD));
      expect(over.status).toBe(429);
      expect(over.body.reason).toBe('rate_limited');
    });
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
