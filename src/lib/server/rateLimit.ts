/**
 * In-memory fixed-window rate limiter (the drop's in-memory limiter).
 *
 * SERVERLESS CAVEAT — read before trusting this in production: the counters
 * below live in module memory. On a serverless platform (Vercel functions)
 * memory is per-isolate: counters reset on every cold start and are NOT
 * shared across concurrently warm instances, so the limit is both
 * bypassable (requests spread across isolates) and self-defeating (a cold
 * start wipes the bucket). This is a dev-phase best-effort guard — the live
 * route header had deferred abuse-hardening by directive. Production
 * hardening needs an external store (Upstash Redis, or a Supabase counter
 * table behind the service role); the signup contract doc carries the same
 * caveat.
 */

import { getDb, type Db } from '@/lib/db';

export type RateLimitConfig = {
  /** Maximum requests allowed per window per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/** Signup registration: 5 requests per client address per minute. */
export const REGISTER_RATE_LIMIT: RateLimitConfig = { limit: 5, windowMs: 60_000 };

/** Admin console sign-in: 5 attempts per client address per minute (the shared secret's brute-force window). */
export const ADMIN_LOGIN_RATE_LIMIT: RateLimitConfig = { limit: 5, windowMs: 60_000 };

/**
 * Don Engine API surface (split calculate, BaaS payout routes): 30 requests
 * per client address per minute. Merged additively from the Cursor drop —
 * the drop's RateLimitRule alias and DEFAULT_RULE fallback stay unported
 * because its call sites always pass the rule explicitly, matching this
 * module's required-config signature.
 */
export const DON_API_RATE_LIMIT: RateLimitConfig = { limit: 30, windowMs: 60_000 };

/**
 * Admin API surface beyond sign-in (vault identifier attach/lookup): 30
 * requests per client address per minute — the Don surface's window, keyed
 * behind the admin gate so the limiter guards the data write, not the
 * secret.
 */
export const ADMIN_API_RATE_LIMIT: RateLimitConfig = { limit: 30, windowMs: 60_000 };

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();

/** Bound the map: drop expired buckets once the table grows past this size. */
const SWEEP_THRESHOLD = 10_000;

function sweepExpired(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(key: string, config: RateLimitConfig): RateLimitVerdict {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket === undefined || now - bucket.windowStart >= config.windowMs) {
    if (buckets.size >= SWEEP_THRESHOLD) {
      sweepExpired(now, config.windowMs);
    }
    buckets.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (bucket.count >= config.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStart + config.windowMs - now) / 1000),
    );
    return { ok: false, retryAfterSeconds };
  }
  bucket.count += 1;
  return { ok: true };
}

/** Test-only: clear every bucket (module state outlives individual tests). */
export function resetRateLimits(): void {
  buckets.clear();
  // The shared limiter's module state is test-visible too: a memoized DDL or
  // a swept timestamp leaking between tests would make its behavior
  // order-dependent.
  tableReady.clear();
  lastSweepAt = 0;
  sweepRetentionMs = SWEEP_INTERVAL_MS;
}

/**
 * ─── Shared (Postgres-backed) limiter ────────────────────────────────────
 *
 * The in-memory limiter above is per-isolate: on a serverless platform every
 * warm function instance keeps its own Map, so a flood spread across
 * instances multiplies the effective limit and a cold start wipes every
 * counter (audit M5). The limiter below moves the fixed-window counters into
 * ONE Postgres table through the shared db client (src/lib/db.ts), so every
 * isolate enforces the same window.
 *
 * checkSharedRateLimit is the call-site entry point:
 * - DATABASE_URL unset (pre-credentials, local dev, tests): getDb() is null
 *   and the call falls back to the in-memory limiter — the exact
 *   pre-existing behavior, so existing consumers keep working unchanged.
 * - DATABASE_URL set: counting happens in one atomic upsert — Postgres
 *   row-locks the conflicting key, so concurrent isolates serialize on the
 *   same counter and the window is genuinely shared.
 * - Store failure (connection blip, missing privileges): the request falls
 *   back to the in-memory window with the error logged — a limiter outage
 *   degrades to per-isolate counting, it never takes the route down.
 */

/** The one shared counters table (created idempotently on first use). */
export const RATE_LIMIT_BUCKETS_TABLE = 'rate_limit_buckets';

/**
 * Public beta data reads (session aggregate, dashboard, ledger, health
 * probes): 30 requests per client address per minute — the house read
 * window.
 */
export const PUBLIC_READ_RATE_LIMIT: RateLimitConfig = { limit: 30, windowMs: 60_000 };

/**
 * Money-initiation endpoints (withdrawal, Plaid token exchange, account
 * provisioning): 5 requests per client address per minute — the signup
 * rule's window, applied to the routes that move or disclose money.
 */
export const MONEY_INITIATION_RATE_LIMIT: RateLimitConfig = { limit: 5, windowMs: 60_000 };

/** Bound sweep cost: at most one expired-row DELETE per process per interval. */
const SWEEP_INTERVAL_MS = 60_000;

/** The sweep's retention — the widest window seen, so no live window is swept early. */
let sweepRetentionMs = SWEEP_INTERVAL_MS;
let lastSweepAt = 0;

/** CREATE TABLE IF NOT EXISTS is idempotent; memoize per table name. */
const tableReady = new Map<string, Promise<void>>();

/** Row shape RETURNED by the counter upsert (pg hands BIGINT back as string). */
type RateLimitCountRow = { hit_count: number; window_start_ms: string | number };

/**
 * One fixed-window counter family stored in Postgres. Instantiate freely —
 * every instance pointed at the same table shares the same windows, which
 * is exactly the property the in-memory limiter lacks.
 */
export class PostgresRateLimiter {
  private readonly db: Db;
  private readonly table: string;

  constructor(db: Db, table: string = RATE_LIMIT_BUCKETS_TABLE) {
    this.db = db;
    this.table = table;
  }

  /** A failed attempt clears the memo so the next request retries the DDL. */
  private ensureTable(): Promise<void> {
    let pending = tableReady.get(this.table);
    if (!pending) {
      pending = this.db
        .query(
          `CREATE TABLE IF NOT EXISTS ${this.table} (
             bucket_key       TEXT PRIMARY KEY,
             window_start_ms  BIGINT  NOT NULL,
             hit_count        INTEGER NOT NULL
           )`,
        )
        .then(() => undefined);
      tableReady.set(this.table, pending);
      pending.catch(() => tableReady.delete(this.table));
    }
    return pending;
  }

  /**
   * Atomic fixed-window check. One upsert makes the whole decision: the
   * window-expired branch resets the row to a fresh window, the otherwise
   * branch increments in place, and RETURNING hands back the post-write
   * count — the value concurrent isolates all serialized on.
   */
  async check(
    key: string,
    config: RateLimitConfig,
    nowMs: number = Date.now(),
  ): Promise<RateLimitVerdict> {
    await this.ensureTable();
    const result = await this.db.query<RateLimitCountRow>(
      `INSERT INTO ${this.table} (bucket_key, window_start_ms, hit_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (bucket_key) DO UPDATE SET
         hit_count = CASE
           WHEN ${this.table}.window_start_ms + $3 <= $2 THEN 1
           ELSE ${this.table}.hit_count + 1
         END,
         window_start_ms = CASE
           WHEN ${this.table}.window_start_ms + $3 <= $2 THEN $2
           ELSE ${this.table}.window_start_ms
         END
       RETURNING hit_count, window_start_ms`,
      [key, nowMs, config.windowMs],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Rate-limit upsert returned no row for key ${JSON.stringify(key)}.`);
    }
    const count = Number(row.hit_count);
    const windowStartMs = Number(row.window_start_ms);
    if (count > config.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStartMs + config.windowMs - nowMs) / 1000),
      );
      return { ok: false, retryAfterSeconds };
    }
    this.sweepExpired(config, nowMs).catch((error: unknown) => {
      console.error('Rate-limit expired-row sweep failed:', error);
    });
    return { ok: true };
  }

  /**
   * Cleanup path: expired rows are dead weight (one row per key ever seen),
   * so once per interval the limiter DELETEs rows whose window can no
   * longer be live. Retention tracks the widest window seen, so a shorter
   * window's sweep never evicts a longer window's live counter.
   */
  private async sweepExpired(config: RateLimitConfig, nowMs: number): Promise<void> {
    sweepRetentionMs = Math.max(sweepRetentionMs, config.windowMs);
    if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = nowMs;
    await this.db.query(`DELETE FROM ${this.table} WHERE window_start_ms < $1`, [
      nowMs - sweepRetentionMs,
    ]);
  }
}

/**
 * The shared limiter's call-site entry point — the same (key, config) shape
 * as checkRateLimit, with the counter moved into Postgres when DATABASE_URL
 * is configured and every failure mode degrading to the in-memory window.
 */
export async function checkSharedRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitVerdict> {
  const db = getDb();
  if (!db) return checkRateLimit(key, config);
  try {
    return await new PostgresRateLimiter(db).check(key, config);
  } catch (error) {
    console.error(
      'Shared rate-limit store unavailable — enforcing the in-memory window for this request:',
      error,
    );
    return checkRateLimit(key, config);
  }
}
