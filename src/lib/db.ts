/**
 * Thin node-postgres pool wrapper over DATABASE_URL (the Supabase transaction
 * pooler connection string). No ORM — raw parameterized SQL only.
 *
 * Conventions:
 * - The pool is created lazily on first use, reading DATABASE_URL at call
 *   time rather than import time — the module imports cleanly in CI, where
 *   the variable is absent, and all consumers mock this module in tests.
 * - getDb() returns null when DATABASE_URL is unset, so routes fail closed
 *   with a sanitized error instead of crashing.
 * - db.transaction wraps BEGIN/COMMIT/ROLLBACK around the callback. A throw
 *   rolls back and rethrows the ORIGINAL error (a failing ROLLBACK is logged,
 *   never swapped in), and the pool client is always released.
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** Connection-scoped query surface handed to a transaction callback. */
export interface DbClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T>;
}

let pool: Pool | null = null;

function getPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL ?? null;
  if (!connectionString) return null;
  if (!pool) {
    // Supabase pooler URLs carry sslmode=require; pg applies it from the
    // connection string. Keep the pool small — the pooler port multiplexes.
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

/** Db handle, or null when DATABASE_URL is unconfigured (fail closed). */
export function getDb(): Db | null {
  if (!getPool()) return null;
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      const activePool = getPool();
      if (!activePool) throw new Error('DATABASE_URL is not configured.');
      return activePool.query<T>(sql, params);
    },
    async transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
      const activePool = getPool();
      if (!activePool) throw new Error('DATABASE_URL is not configured.');
      const client: PoolClient = await activePool.connect();
      try {
        await client.query('BEGIN');
        const tx: DbClient = {
          query: <U extends QueryResultRow = QueryResultRow>(
            sql: string,
            params?: unknown[],
          ): Promise<QueryResult<U>> => client.query<U>(sql, params),
        };
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('ROLLBACK failed after a transaction error:', rollbackError);
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
