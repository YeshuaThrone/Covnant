/**
 * RegistryAdminDashboard server reads — canon v20 Section 2 wired to the
 * 0012 tables (universal_identity_map, global_identifier_cross_ref) and
 * the shared Redis helper for engine cache stats.
 *
 * Honesty law (house admin convention): every number comes from a real
 * read; a failed or unconfigured read renders an honest unavailable state
 * — never simulated metrics, never a guessed default. All SQL is
 * parameterized; the search term is bound, never interpolated.
 */

import { getDb } from '@/lib/db';
import { getRedisClient } from '@/lib/server/redisCache';

/** Canon v20 RegistryEntity — 1:1 with the 0012 tables. */
export interface RegistryEntity {
  entityId: string;
  vertical: string;
  codeType: string;
  codeValue: string;
  linkageTier: 'PRIMARY' | 'CROSS_REFERENCE';
  createdAt: string;
}

export interface RegistryVerticalRow {
  vertical: string;
  identities: number;
  crossReferences: number;
}

export interface RegistryMetrics {
  totalIdentities: number;
  totalCrossReferences: number;
  verticalCount: number;
}

export type RegistryDashboardData = {
  available: true;
  metrics: RegistryMetrics;
  verticals: RegistryVerticalRow[];
  /** Cross-Registry Linkage Audit Log — newest linkage events first. */
  auditLog: RegistryEntity[];
  /** Rows under the active search + vertical filter (the main table). */
  entities: RegistryEntity[];
  redis: { reachable: boolean };
  searched: string | null;
  verticalFilter: string;
};

export type RegistryDashboardUnavailable = {
  available: false;
  reason: 'DATABASE_UNCONFIGURED' | 'DATABASE_ERROR';
  message: string;
};

export type RegistryDashboardResult =
  | RegistryDashboardData
  | RegistryDashboardUnavailable;

/** Canon v20 Section 2 filter vocabulary (matches the v10 compact vocab). */
export const REGISTRY_VERTICAL_FILTERS = [
  'ALL',
  'PRO_SPORTS',
  'FINE_ART',
  'SUPPLY_CHAIN',
  'HARDWARE',
  'CORPORATE',
] as const;

export type RegistryVerticalFilter = (typeof REGISTRY_VERTICAL_FILTERS)[number];

export function verticalFilterFromParam(
  value: string | undefined,
): RegistryVerticalFilter {
  return (REGISTRY_VERTICAL_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as RegistryVerticalFilter)
    : 'ALL';
}

function toEntity(row: {
  entity_id: string;
  vertical_category: string;
  code_type: string;
  code_value: string;
  linkage_tier: string;
  created_at: Date | string;
}): RegistryEntity {
  return {
    entityId: row.entity_id,
    vertical: row.vertical_category,
    codeType: row.code_type,
    codeValue: row.code_value,
    linkageTier: row.linkage_tier === 'PRIMARY' ? 'PRIMARY' : 'CROSS_REFERENCE',
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

async function readRedisReachable(): Promise<boolean> {
  try {
    const client = await getRedisClient();
    if (!client) return false;
    await client.ping();
    return true;
  } catch {
    // Fail-open dashboard posture: an unreachable cache is a status line,
    // never a broken console.
    return false;
  }
}

const AUDIT_LOG_LIMIT = 25;
const ENTITY_TABLE_LIMIT = 50;

/**
 * The single read the registry page renders. `q` filters code_type or
 * code_value by case-insensitive substring; `vertical` is one of the
 * REGISTRY_VERTICAL_FILTERS values.
 */
export async function registryDashboardData(
  q: string | undefined,
  vertical: RegistryVerticalFilter,
): Promise<RegistryDashboardResult> {
  const db = getDb();
  if (!db) {
    return {
      available: false,
      reason: 'DATABASE_UNCONFIGURED',
      message:
        'The registry dashboard is not configured. Set DATABASE_URL to read the 0012 universal identity tables.',
    };
  }

  const searched = q?.trim() ? q.trim() : null;

  try {
    const metricsRows = await db.query<{
      total_identities: number;
      total_cross_references: number;
      vertical_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM universal_identity_map) AS total_identities,
         (SELECT count(*)::int FROM global_identifier_cross_ref) AS total_cross_references,
         (SELECT count(DISTINCT vertical_category)::int FROM universal_identity_map) AS vertical_count`,
    );
    const metricsRow = metricsRows.rows[0]!;

    const verticalRows = await db.query<{
      vertical_category: string;
      identities: number;
      cross_references: number;
    }>(
      `SELECT m.vertical_category,
              count(DISTINCT m.map_id)::int AS identities,
              count(r.linked_code_type)::int AS cross_references
         FROM universal_identity_map m
         LEFT JOIN global_identifier_cross_ref r ON r.map_id = m.map_id
        GROUP BY m.vertical_category
        ORDER BY identities DESC`,
    );

    // The main table: PRIMARY rows and CROSS_REFERENCE rows under the
    // active filter, newest first. Search binds to $1, vertical to $2.
    const entitiesResult = await db.query<{
      entity_id: string;
      vertical_category: string;
      code_type: string;
      code_value: string;
      linkage_tier: string;
      created_at: string | Date;
    }>(
      `SELECT m.entity_id,
              m.vertical_category,
              m.primary_code_type AS code_type,
              m.primary_code_value AS code_value,
              'PRIMARY' AS linkage_tier,
              m.created_at
         FROM universal_identity_map m
        WHERE ($1::text IS NULL
               OR m.primary_code_type ILIKE '%' || $1::text
               OR m.primary_code_value ILIKE '%' || $1::text)
          AND ($2::text IS NULL OR m.vertical_category = $2::text)
        UNION ALL
       SELECT m.entity_id,
              m.vertical_category,
              r.linked_code_type,
              r.linked_code_value,
              'CROSS_REFERENCE' AS linkage_tier,
              r.verified_at AS created_at
         FROM global_identifier_cross_ref r
         JOIN universal_identity_map m ON m.map_id = r.map_id
        WHERE ($1::text IS NULL
               OR r.linked_code_type ILIKE '%' || $1::text
               OR r.linked_code_value ILIKE '%' || $1::text)
          AND ($2::text IS NULL OR m.vertical_category = $2::text)
        ORDER BY created_at DESC
        LIMIT ${ENTITY_TABLE_LIMIT}`,
      [searched, vertical === 'ALL' ? null : vertical],
    );

    // Audit log: the newest cross-registry linkage events only.
    const auditResult = await db.query<{
      entity_id: string;
      vertical_category: string;
      code_type: string;
      code_value: string;
      linkage_tier: string;
      created_at: string | Date;
    }>(
      `SELECT m.entity_id,
              m.vertical_category,
              r.linked_code_type AS code_type,
              r.linked_code_value AS code_value,
              'CROSS_REFERENCE' AS linkage_tier,
              r.verified_at AS created_at
         FROM global_identifier_cross_ref r
         JOIN universal_identity_map m ON m.map_id = r.map_id
        ORDER BY r.verified_at DESC
        LIMIT ${AUDIT_LOG_LIMIT}`,
    );

    return {
      available: true,
      metrics: {
        totalIdentities: metricsRow.total_identities,
        totalCrossReferences: metricsRow.total_cross_references,
        verticalCount: metricsRow.vertical_count,
      },
      verticals: verticalRows.rows.map((row) => ({
        vertical: row.vertical_category,
        identities: row.identities,
        crossReferences: row.cross_references,
      })),
      auditLog: auditResult.rows.map(toEntity),
      entities: entitiesResult.rows.map(toEntity),
      redis: { reachable: await readRedisReachable() },
      searched,
      verticalFilter: vertical,
    };
  } catch (error) {
    return {
      available: false,
      reason: 'DATABASE_ERROR',
      message:
        'The registry read failed. The 0012 universal identity tables may not be migrated on this database yet: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
