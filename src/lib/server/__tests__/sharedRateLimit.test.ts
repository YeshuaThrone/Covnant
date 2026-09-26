import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '@/lib/db';
import {
  DON_API_RATE_LIMIT,
  MONEY_INITIATION_RATE_LIMIT,
  PUBLIC_READ_RATE_LIMIT,
  PostgresRateLimiter,
  checkSharedRateLimit,
  resetRateLimits,
} from '../rateLimit';

/**
 * The shared (Postgres-backed) limiter — hardening gen 12, audit M5.
 *
 * The in-memory limiter's per-isolate counters are the finding: warm
 * serverless instances each keep their own Map, so the effective limit is
 * multiplied across isolates and wiped on cold start. These tests pin the
 * replacement's two contracts:
 *
 * 1. In Postgres mode the counter lives in the STORE, not in the limiter
 *    instance — two instances pointed at one store enforce one window.
 * 2. DATABASE_URL-unset environments (and a failed store) transparently
 *    fall back to the in-memory limiter — the exact pre-credentials
 *    behavior every existing route test relies on.
 *
 * CI has no live Postgres, so Postgres mode runs against a fake Db that
 * accepts ONLY the statements the limiter is allowed to send: the
 * idempotent DDL, the SINGLE-statement conflict-targeted upsert whose
 * RETURNING hands back the count, and the sweep DELETE. A refactor that
 * abandons single-statement atomicity (a read-then-write race across
 * isolates) no longer matches the accepted contract and fails here.
 */

/** What the fake's store keeps per bucket key. */
type FakeBucket = { window_start_ms: number; hit_count: number };

function fakeResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows } as unknown as QueryResult<T>;
}

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
        // The atomicity contract: ONE statement, conflict-targeted upsert,
        // verdict derived from RETURNING — never a read-then-write pair.
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
        // BIGINT arrives as a string from real pg — return it as one so the
        // limiter's coercion is exercised.
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

describe('shared limiter rules', () => {
  it('keeps the public-read and money-initiation windows at house values', () => {
    expect(PUBLIC_READ_RATE_LIMIT).toEqual({ limit: 30, windowMs: 60_000 });
    expect(MONEY_INITIATION_RATE_LIMIT).toEqual({ limit: 5, windowMs: 60_000 });
  });
});

describe('PostgresRateLimiter (store-backed mode)', () => {
  let store: Map<string, FakeBucket>;

  beforeEach(() => {
    resetRateLimits();
    store = new Map();
  });

  it('shares one window across two limiter instances — the property the in-memory limiter lacks', async () => {
    // Two instances over ONE store model two warm serverless isolates over
    // one Postgres: separate objects end to end, so any shared count can
    // only have flowed through the store.
    const isolateA = new PostgresRateLimiter(makeFakeDb(store));
    const isolateB = new PostgresRateLimiter(makeFakeDb(store));

    for (let i = 0; i < PUBLIC_READ_RATE_LIMIT.limit; i += 1) {
      expect((await isolateA.check('covnant-me:1.2.3.4', PUBLIC_READ_RATE_LIMIT, 1_000_000)).ok).toBe(true);
    }
    // The 31st hit lands on the OTHER instance, as if another isolate took it.
    const blocked = await isolateB.check('covnant-me:1.2.3.4', PUBLIC_READ_RATE_LIMIT, 1_000_000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBe(60);
    }
  });

  it('does NOT share windows across different stores (the store, not the class, is the counter)', async () => {
    const storeA = new Map<string, FakeBucket>();
    const storeB = new Map<string, FakeBucket>();
    const isolateA = new PostgresRateLimiter(makeFakeDb(storeA));
    const isolateB = new PostgresRateLimiter(makeFakeDb(storeB));

    for (let i = 0; i < PUBLIC_READ_RATE_LIMIT.limit; i += 1) {
      await isolateA.check('ledger:5.6.7.8', PUBLIC_READ_RATE_LIMIT, 1_000_000);
    }
    // A different store (different database) starts from zero.
    expect((await isolateB.check('ledger:5.6.7.8', PUBLIC_READ_RATE_LIMIT, 1_000_000)).ok).toBe(true);
  });

  it('blocks past the limit and resets the window once it expires (fixed-window semantics)', async () => {
    const limiter = new PostgresRateLimiter(makeFakeDb(store));
    const key = 'health-db:9.9.9.9';

    for (let i = 0; i < MONEY_INITIATION_RATE_LIMIT.limit; i += 1) {
      expect((await limiter.check(key, MONEY_INITIATION_RATE_LIMIT, 1_000_000)).ok).toBe(true);
    }
    const blocked = await limiter.check(key, MONEY_INITIATION_RATE_LIMIT, 1_000_000);
    expect(blocked.ok).toBe(false);

    // The window closes 60s after it opened; the next check opens a fresh one.
    const afterExpiry = await limiter.check(key, MONEY_INITIATION_RATE_LIMIT, 1_000_000 + 60_000);
    expect(afterExpiry.ok).toBe(true);
  });

  it('keys windows independently per bucket key', async () => {
    const limiter = new PostgresRateLimiter(makeFakeDb(store));

    for (let i = 0; i < MONEY_INITIATION_RATE_LIMIT.limit; i += 1) {
      await limiter.check('payouts-withdraw:1.1.1.1', MONEY_INITIATION_RATE_LIMIT, 1_000_000);
    }
    expect((await limiter.check('payouts-withdraw:1.1.1.1', MONEY_INITIATION_RATE_LIMIT, 1_000_000)).ok).toBe(false);
    // A different address (or route bucket) is untouched.
    expect((await limiter.check('payouts-withdraw:2.2.2.2', MONEY_INITIATION_RATE_LIMIT, 1_000_000)).ok).toBe(true);
  });

  it('sweeps expired rows and keeps live ones (the cleanup path)', async () => {
    const limiter = new PostgresRateLimiter(makeFakeDb(store));

    await limiter.check('fresh:1.1.1.1', PUBLIC_READ_RATE_LIMIT, 1_000_000);
    // Manually age a row past any live window.
    store.set('stale:3.3.3.3', { window_start_ms: 1_000_000 - 100_000, hit_count: 3 });

    // Within the sweep interval the stale row survives (throttled cleanup).
    await limiter.check('middle:2.2.2.2', PUBLIC_READ_RATE_LIMIT, 1_010_000);
    expect(store.has('stale:3.3.3.3')).toBe(true);

    // Past the interval the sweep deletes every expired bucket (fresh,
    // middle, and stale all predate the cutoff; only later survives).
    await limiter.check('later:4.4.4.4', PUBLIC_READ_RATE_LIMIT, 1_080_000);
    expect([...store.keys()]).toEqual(['later:4.4.4.4']);
  });
});

/**
 * The checkSharedRateLimit entry point's fallback behavior. The db module is
 * mocked so tests can inject a store or force the DATABASE_URL-unset path;
 * with no override the REAL getDb runs — DATABASE_URL deleted means it
 * returns null exactly as it does pre-credentials and in CI.
 */
const dbState = vi.hoisted(() => ({ override: null as Db | null }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getDb: () => dbState.override ?? actual.getDb(),
  };
});

describe('checkSharedRateLimit fallback behavior', () => {
  const DATABASE_URL_BACKUP = process.env.DATABASE_URL;

  beforeEach(() => {
    resetRateLimits();
    dbState.override = null;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    dbState.override = null;
    if (DATABASE_URL_BACKUP === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = DATABASE_URL_BACKUP;
    }
  });

  it('DATABASE_URL-unset environments transparently fall back to the in-memory limiter', async () => {
    // The real getDb() runs (override null) with DATABASE_URL deleted: the
    // same null every pre-credentials deploy sees.
    for (let i = 0; i < DON_API_RATE_LIMIT.limit; i += 1) {
      expect((await checkSharedRateLimit('claims-fallback:7.7.7.7', DON_API_RATE_LIMIT)).ok).toBe(true);
    }
    const blocked = await checkSharedRateLimit('claims-fallback:7.7.7.7', DON_API_RATE_LIMIT);
    expect(blocked.ok).toBe(false);

    // And the in-memory reset the route tests already use still governs it.
    resetRateLimits();
    expect((await checkSharedRateLimit('claims-fallback:7.7.7.7', DON_API_RATE_LIMIT)).ok).toBe(true);
  });

  it('degrades to the in-memory window when the store fails — logged, never thrown', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbState.override = {
      async query<T extends QueryResultRow>(): Promise<QueryResult<T>> {
        throw new Error('connection refused');
      },
      async transaction(): Promise<never> {
        throw new Error('connection refused');
      },
    } as unknown as Db;

    // The store (even the DDL) failing never takes the route down: the
    // verdict still comes back, enforced by the in-memory window.
    for (let i = 0; i < MONEY_INITIATION_RATE_LIMIT.limit; i += 1) {
      expect((await checkSharedRateLimit('provision:8.8.8.8', MONEY_INITIATION_RATE_LIMIT)).ok).toBe(true);
    }
    const blocked = await checkSharedRateLimit('provision:8.8.8.8', MONEY_INITIATION_RATE_LIMIT);
    expect(blocked.ok).toBe(false);

    // The failure is surfaced, not swallowed.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
