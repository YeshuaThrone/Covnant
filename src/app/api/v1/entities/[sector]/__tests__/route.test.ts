/**
 * GET /api/v1/entities/[sector] — the per-sector entity route contract
 * (founder directive, 2026-09-20, dynamic entity routing): every one of the
 * 29 canonical sectors serves its entities from the master store engine
 * (atomic records bound to their SDK entities, the parent vertical's factory
 * templates bound by prefix, execution telemetry riding the store), unknown
 * sectors fail closed with a 404, an empty sector read fails closed with a
 * 502, and a served entity that betrays its guard fails closed — the UI
 * never renders an empty state, so failures are honest 5xx, not [].
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({
  emptySectors: false,
  guardFailure: false,
}));

vi.mock('@/lib/master/masterStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/master/masterStore')>();
  return {
    ...actual,
    resolveAtomicRegistry: async () => {
      if (storeState.emptySectors) return { demo: true, records: [] };
      return actual.resolveAtomicRegistry();
    },
    // Guard-failure injection: flip the serving gate itself, so the route's
    // fail-closed 502 branch runs without forging store shapes.
    validateServedEntity: (entity: Parameters<typeof actual.validateServedEntity>[0]) =>
      storeState.guardFailure ? false : actual.validateServedEntity(entity),
  };
});

import { ATOMIC_SECTOR_ORDER, ATOMIC_SECTOR_TO_VERTICAL } from '@/lib/master/taxonomy';
import { GET } from '../route';

function sectorRequest(sector: string): Request {
  return new Request(`http://localhost:3200/api/v1/entities/${sector}`);
}

const sectorContext = (sector: string) =>
  ({ params: Promise.resolve({ sector }) }) as unknown as {
    params: Promise<{ sector: string }>;
  };

beforeEach(() => {
  process.env.DON_DEV_SEED = '1';
  storeState.emptySectors = false;
  storeState.guardFailure = false;
});

afterEach(() => {
  const previous = process.env.DON_DEV_SEED;
  if (previous === undefined) delete process.env.DON_DEV_SEED;
  else process.env.DON_DEV_SEED = previous;
});

describe('GET /api/v1/entities/[sector]', () => {
  it('serves the canonical Music sector with bound entity and drop-5 execution telemetry', async () => {
    const response = await GET(sectorRequest('MUSIC'), sectorContext('MUSIC'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sector).toBe('MUSIC');
    expect(body.vertical).toBe('AUDIO_AND_RECORDED_SOUND');
    expect(body.demo).toBe(true);
    const atomic = body.atomicRecords as Array<Record<string, unknown>>;
    expect(atomic.length).toBeGreaterThanOrEqual(1);
    const canonical = atomic.find((r) => r.record && (r.record as Record<string, unknown>).templateId === 'TPL-MUS-001');
    expect(canonical).toBeDefined();
    const entity = canonical?.entity as Record<string, unknown>;
    expect(entity.entityType).toBe('MASTER_RECORDING');
    expect(entity.isrcCode).toBe('US-S1Z-26-00001');
    expect(entity.subSecondMicroRoyaltyRate).toBe(0.0035);
    expect(entity.proTelemetryBinding).toBe('ASCAP');
    expect(canonical?.execution).toEqual({ executionState: 'CLEARED', grossVolumeCents: 12_500_000 });
    // The parent vertical's factory templates ride along, entity-bound where covered.
    const factory = body.factoryTemplates as Array<Record<string, unknown>>;
    expect(factory.length).toBe(6);
  });

  it('serves the Sports & Athletics sector door with the bound tournament entity telemetry', async () => {
    // The generation-4 expansion sector rides the SAME dynamic door — no fork.
    const response = await GET(
      sectorRequest('SPORTS_AND_ATHLETICS'),
      sectorContext('SPORTS_AND_ATHLETICS'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sector).toBe('SPORTS_AND_ATHLETICS');
    expect(body.vertical).toBe('SPORTS_AND_ATHLETICS');
    expect(body.demo).toBe(true);
    const atomic = body.atomicRecords as Array<Record<string, unknown>>;
    expect(atomic.length).toBeGreaterThanOrEqual(1);
    const tournament = atomic.find((r) => (r.record as Record<string, unknown>).templateId === 'TPL-TRN-001');
    expect(tournament).toBeDefined();
    const entity = tournament?.entity as Record<string, unknown>;
    expect(entity.entityType).toBe('TOURNAMENT_EVENT');
    expect(entity.eventId).toBe('PGA-TOUR-2026-AUG');
    expect(entity.discipline).toBe('Golf');
    expect(entity.prizePurseEscrowUSD).toBe(12_500_000);
    expect(entity.payoutReleaseLock).toBe(true);
  });

  it('serves every one of the 29 canonical sectors — none empty, all with the right vertical', async () => {
    for (const sector of ATOMIC_SECTOR_ORDER) {
      const response = await GET(sectorRequest(sector), sectorContext(sector));
      expect(response.status, `sector ${sector}`).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.ok, `sector ${sector}`).toBe(true);
      expect(body.sector, `sector ${sector}`).toBe(sector);
      expect(body.vertical, `sector ${sector}`).toBe(ATOMIC_SECTOR_TO_VERTICAL[sector]);
      const atomic = body.atomicRecords as Array<Record<string, unknown>>;
      expect(atomic.length, `sector ${sector} must never be empty`).toBeGreaterThanOrEqual(1);
    }
  });

  it('fails closed with 404 on a sector outside the canonical 29 — echoing the offender', async () => {
    const response = await GET(sectorRequest('GALACTIC'), sectorContext('GALACTIC'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('unknown_sector');
    expect(body.sector).toBe('GALACTIC');
  });

  it('fails closed on a lowercase sector — the canon parameter is uppercase', async () => {
    const response = await GET(sectorRequest('music'), sectorContext('music'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.reason).toBe('unknown_sector');
  });

  it('fails closed with 502 when a sector read comes back empty — never a silent []', async () => {
    storeState.emptySectors = true;
    const response = await GET(sectorRequest('FILM'), sectorContext('FILM'));
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.reason).toBe('sector_read_failed');
  });

  it('fails closed with 502 when a bound entity betrays its guard before serving', async () => {
    storeState.guardFailure = true;
    const response = await GET(sectorRequest('MUSIC'), sectorContext('MUSIC'));
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    // The shared sanitized envelope — reason is the machine-readable code;
    // no sector echo on internal failures (the 404 is the param-echo path).
    expect(body.reason).toBe('entity_guard_failed');
  });
});
