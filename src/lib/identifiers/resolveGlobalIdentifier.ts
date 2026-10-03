/**
 * Entity resolution cache — founder canon v16 (artifact Founder v16 Entity
 * Resolution Cache + CI Pipeline), the high-speed Redis lookup in front of
 * the 0012 universal_identity_map.
 *
 * Founder contract carried byte-compatible:
 *   - ResolvedEntity {entityId, verticalCategory, primaryCodeType,
 *     primaryCodeValue, source 'CACHE' | 'DATABASE'}
 *   - cache key `id_map:${codeType}:${codeValue}`, TTL 86400s (24h)
 *   - resolveGlobalIdentifier(dbPool, codeType, codeValue): Redis get →
 *     cache hit returns source CACHE; miss falls through to the database
 *     (SELECT entity_id, vertical_category, primary_code_type,
 *     primary_code_value FROM universal_identity_map WHERE
 *     primary_code_type = $1 AND primary_code_value = $2), null when
 *     unregistered, then an async setEx write-back.
 *
 * Gap corrections (founder-confirmation flags, carried in the PR body):
 *   - CONNECT: the founder draft never calls .connect() — the guarded,
 *     lazy connect lives in the house redisCache factory (getRedisClient),
 *     which the whole engine shares so one client serves limiter + cache
 *     per isolate. Fail-open semantics are preserved: when REDIS_URL is
 *     unset or the connection fails the factory returns null and every
 *     lookup takes the database path.
 *   - INVALIDATION: the v13 upsert can change vertical_category on
 *     conflict while a cached resolution lives up to 24h — the write path
 *     DELs the id_map key after COMMIT at the event seam
 *     (invalidateResolvedGlobalIdentifier), an orchestrator-added
 *     correction flagged for founder confirmation (TTL bounds staleness
 *     otherwise).
 */

import type { Pool } from 'pg';

import { getRedisClient } from '@/lib/server/redisCache';

import type { GlobalIdentifierType } from './globalIdentifiers';

export const RESOLUTION_TTL_SECONDS = 86400; // 24-Hour Cache Expiry

export interface ResolvedEntity {
  entityId: string;
  verticalCategory: string;
  primaryCodeType: GlobalIdentifierType;
  primaryCodeValue: string;
  source: 'CACHE' | 'DATABASE';
}

/** The canonical cache key for a primary code (canon v16). */
export function resolutionCacheKey(
  codeType: GlobalIdentifierType | string,
  codeValue: string,
): string {
  return `id_map:${codeType}:${codeValue}`;
}

/**
 * High-Speed Entity Resolution with Sub-Millisecond Redis Lookup.
 * Cache errors NEVER block resolution — every Redis failure fails open to
 * the database path (canon v16 convention, shared with the v22 limiter).
 */
export async function resolveGlobalIdentifier(
  dbPool: Pool,
  codeType: GlobalIdentifierType,
  codeValue: string,
): Promise<ResolvedEntity | null> {
  const cacheKey = resolutionCacheKey(codeType, codeValue);

  // Step 1: Redis Memory Lookup (Sub-Millisecond Path)
  try {
    const redis = await getRedisClient();
    if (redis) {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        const parsed = JSON.parse(cachedData) as Omit<ResolvedEntity, 'source'>;
        return { ...parsed, source: 'CACHE' };
      }
    }
  } catch (err) {
    console.warn('Redis lookup bypassed due to error:', err);
  }

  // Step 2: Database Fallback Path (On Cache Miss)
  const query = `SELECT entity_id, vertical_category, primary_code_type, primary_code_value
FROM universal_identity_map
WHERE primary_code_type = $1 AND primary_code_value = $2;`;
  const result = await dbPool.query(query, [codeType, codeValue]);

  if (result.rows.length === 0) {
    return null; // Identifier not registered
  }
  const row = result.rows[0];
  const resolved: ResolvedEntity = {
    entityId: row.entity_id,
    verticalCategory: row.vertical_category,
    primaryCodeType: row.primary_code_type,
    primaryCodeValue: row.primary_code_value,
    source: 'DATABASE',
  };

  // Step 3: Write Back to Redis Cache (Async non-blocking)
  try {
    const redis = await getRedisClient();
    await redis?.setEx(cacheKey, RESOLUTION_TTL_SECONDS, JSON.stringify(resolved));
  } catch (err) {
    console.error('Failed to write to Redis cache:', err);
  }

  return resolved;
}

/**
 * Post-commit invalidation on the write path (orchestrator-added gap
 * correction, flagged): the batch upsert may change vertical_category on
 * conflict, so a stale cached resolution must not outlive the commit.
 * Fail-open — a failed DEL only means the 24h TTL bounds staleness.
 */
export async function invalidateResolvedGlobalIdentifier(
  codeType: GlobalIdentifierType | string,
  codeValue: string,
): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis?.del(resolutionCacheKey(codeType, codeValue));
  } catch (err) {
    console.error('Redis cache invalidation failed (TTL bounds staleness):', err);
  }
}
