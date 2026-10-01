/**
 * Lazy node-redis v4 client for the identifier-engine surfaces (canon v22/v16).
 *
 * Conventions (mirrors src/lib/db.ts):
 * - The client is created lazily on first use, reading REDIS_URL at call
 *   time rather than import time — the module imports cleanly in CI (where
 *   the variable is absent) and every consumer mocks this module in tests.
 * - getRedisClient() returns null when REDIS_URL is unset OR the connection
 *   fails: callers fail open (canon v22 — a limiter/cache outage never takes
 *   the route down), so null is a normal, handled value, never an exception.
 */

import { createClient } from 'redis';

/** The concrete client type the factory returns — avoids the module-generic mismatch. */
type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let connecting: Promise<RedisClient | null> | null = null;

export async function getRedisClient(): Promise<RedisClient | null> {
  const url = process.env.REDIS_URL ?? null;
  if (!url) return null;
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      try {
        const created = createClient({ url });
        created.on('error', (err: Error) => {
          // Surface transient socket errors without crashing the isolate —
          // callers re-check liveness on every use via this module.
          console.error('Redis client error:', err);
        });
        await created.connect();
        client = created;
        return client;
      } catch (error) {
        console.error('Redis unavailable — engine surfaces fail open:', error);
        return null;
      } finally {
        connecting = null;
      }
    })();
  }
  return connecting;
}

/** Test-only: drop the cached client so a later use reconnects. */
export async function closeRedisClient(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
  connecting = null;
}
