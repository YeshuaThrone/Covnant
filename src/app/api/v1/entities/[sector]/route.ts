/**
 * GET /api/v1/entities/[sector] — the per-sector atomic entity feed of the
 * Covnant Control Board (founder directive, 2026-09-20). Serves the atomic
 * registry records of ONE sector — with their bound CovnantAtomicDataSDK
 * entities and execution telemetry — plus the parent vertical's factory
 * templates, so a vertical tab hydrates its boards from per-sector doors.
 *
 * Fail-closed by construction:
 *   - an unknown sector param is a 404 (unknown_sector), never a empty 200;
 *   - a bound entity that fails its guard is a 502 (entity_guard_failed),
 *     never served;
 *   - a covered sector with no records is a 502 (sector_read_failed) — the
 *     store's integrity gates make it unreachable, and the UI never renders
 *     an empty state.
 *
 * AUTH: this route is the same data door the /templates page already
 * renders publicly from the same master-store engine — a read-only,
 * store-derived feed under the demo disclosure. It is not an /api/admin
 * surface, so the J1 preview carve-out (verifyAdminSession's
 * DON_DEV_SEED passwordless branch) is not involved; an unauthenticated
 * preview session reaches it exactly like the page itself, and production
 * behavior is unchanged (same public read as the page, no session logic).
 */

import { jsonError } from '@/lib/server/http';
import {
  ATOMIC_SECTOR_TO_VERTICAL,
  atomicRecordsForSector,
  bindAtomicEntity,
  bindFactoryEntity,
  executionTelemetryFor,
  masterTemplatesForCategory,
  resolveAtomicRegistry,
  resolveMasterTemplates,
  validateServedEntity,
} from '@/lib/master/masterStore';
import { atomicSectorFromParam } from '@/lib/master/taxonomy';
import type { EntityBoundAtomicRecord, EntityBoundFactoryTemplate, SectorEntitiesResponse } from '@/lib/master/controlBoard';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sector: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { sector } = await context.params;
  const canonical = atomicSectorFromParam(sector);
  if (canonical === null) {
    // Same envelope as the shared jsonError, plus the offending param echoed
    // — the shared helper stays byte-for-byte intact for its other callers.
    return Response.json(
      { ok: false, error: `Unknown atomic sector: ${sector}`, reason: 'unknown_sector', sector },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }
  const vertical = ATOMIC_SECTOR_TO_VERTICAL[canonical];

  const { demo, records: atomicRecords } = await resolveAtomicRegistry();
  const sectorRecords = atomicRecordsForSector(atomicRecords, canonical);
  if (sectorRecords.length === 0) {
    // Unreachable while the store's sector-integrity gate holds — fail
    // closed rather than serve an empty sector.
    return jsonError(502, 'sector_read_failed', `Atomic sector ${canonical} returned no records`);
  }

  const atomic: EntityBoundAtomicRecord[] = [];
  for (const record of sectorRecords) {
    const entity = bindAtomicEntity(record);
    if (entity !== null && !validateServedEntity(entity)) {
      return jsonError(502, 'entity_guard_failed', `Entity telemetry for ${record.templateId} failed its fail-closed guard`);
    }
    atomic.push({ record, entity, execution: executionTelemetryFor(record.templateId) });
  }

  const { demo: factoryDemo, records: factoryRecords } = await resolveMasterTemplates();
  const factory: EntityBoundFactoryTemplate[] = [];
  for (const record of masterTemplatesForCategory(factoryRecords, vertical)) {
    const entity = bindFactoryEntity(record);
    if (entity !== null && !validateServedEntity(entity)) {
      return jsonError(502, 'entity_guard_failed', `Entity telemetry for ${record.templateId} failed its fail-closed guard`);
    }
    factory.push({ record, entity, execution: executionTelemetryFor(record.templateId) });
  }

  const body: SectorEntitiesResponse = {
    ok: true,
    sector: canonical,
    vertical,
    demo: demo || factoryDemo,
    atomicRecords: [...atomic],
    factoryTemplates: [...factory],
  };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}
