/**
 * Entity binding gates — the Covnant Control Board's store layer (founder
 * directive, 2026-09-20): every card for a sector covered by an SDK entity
 * class binds its typed entity from the store; sectors WITHOUT a class stay
 * on their telemetryMetric display (no force-fitting); the drop-5
 * transaction seed is the canonical Music record's execution telemetry; and
 * the module-load integrity gate fails LOUD when the binding drifts.
 */
import { describe, expect, it } from 'vitest';
import {
  ATOMIC_TEMPLATE_REGISTRY,
  MASTER_TEMPLATE_LIBRARY,
  ATOMIC_SECTOR_ORDER,
  bindAtomicEntity,
  bindFactoryEntity,
  executionTelemetryFor,
  resolveAtomicRegistry,
  validateServedEntity,
  type AtomicContractRecord,
  type ContractTemplateRecord,
} from '../masterStore';
import { ATOMIC_SECTOR_TO_VERTICAL, sectorsForVertical } from '../taxonomy';
import type {
  FilmEntity,
  LivePerformanceEntity,
  MusicEntity,
  PodcastEntity,
  PublishingEntity,
  TelevisionEntity,
} from '../CovnantAtomicDataSDK';

/** The sectors whose registry records carry an SDK entity class (canon). */
const ENTITY_BOUND_SECTORS = [
  'MUSIC',
  'FILM',
  'TV',
  'PODCASTING',
  'PUBLISHING',
  'BOOKS',
  'LITERATURE',
] as const;

const atomicById = (id: string): AtomicContractRecord => {
  const record = ATOMIC_TEMPLATE_REGISTRY.find((r) => r.templateId === id);
  expect(record, `atomic record ${id} missing`).toBeDefined();
  return record as AtomicContractRecord;
};

const factoryById = (id: string): ContractTemplateRecord => {
  const record = MASTER_TEMPLATE_LIBRARY.find((r) => r.templateId === id);
  expect(record, `factory template ${id} missing`).toBeDefined();
  return record as ContractTemplateRecord;
};

describe('atomic entity binding — sector-driven', () => {
  it('binds the canonical Music record with the EXACT drop-5 telemetry', () => {
    const entity = bindAtomicEntity(atomicById('TPL-MUS-001'));
    expect(entity).not.toBeNull();
    const music = entity as MusicEntity;
    expect(music.entityType).toBe('MASTER_RECORDING');
    expect(music.templateId).toBe('TPL-MUS-001');
    expect(music.isrcCode).toBe('US-S1Z-26-00001');
    expect(music.subSecondMicroRoyaltyRate).toBe(0.0035);
    expect(music.proTelemetryBinding).toBe('ASCAP');
    expect(music.targetSplit).toEqual({ ownership: 0.50, creative: 0.35, operations: 0.15 });
  });

  it('wires the drop-5 transaction seed as the Music record execution — CLEARED, $125,000.00', () => {
    const execution = executionTelemetryFor('TPL-MUS-001');
    expect(execution).not.toBeNull();
    expect(execution?.executionState).toBe('CLEARED');
    expect(execution?.grossVolumeCents).toBe(12_500_000); // $125,000.00 — engine-path cents
  });

  it('binds the atomic sector records for every entity class', () => {
    const film = bindAtomicEntity(atomicById('TPL-FLM-001')) as FilmEntity;
    expect(film.entityType).toBe('FEATURE_FILM');
    expect(film.isanCode).toBe('0003-1A2F-9C4B-0002-W');
    expect(film.theatricalGrossEscrowUSD).toBe(4_250_000);
    expect(film.studioOverlayActive).toBe(true);

    const tv = bindAtomicEntity(atomicById('TPL-TV-001')) as TelevisionEntity;
    expect(tv.entityType).toBe('LINEAR_TV');
    expect(tv.nielsenFlightMinutes).toBe(12_480);
    expect(tv.syndicationReversionLock).toBe(true);
    expect(tv.adInsertionMicroYieldUSD).toBe(86_400);

    const podcast = bindAtomicEntity(atomicById('TPL-PDC-001')) as PodcastEntity;
    expect(podcast.entityType).toBe('PODCAST_NETWORK');
    expect(podcast.downloadCountTelemetry).toBe(1_284_000);
    expect(podcast.feedIsolationActive).toBe(true);

    const publishing = bindAtomicEntity(atomicById('TPL-PUB-001')) as PublishingEntity;
    expect(publishing.entityType).toBe('LITERARY_WORK');
    expect(publishing.isbnNumber).toBe('978-1-4028-9462-6');
    // Sector-driven literary bindings: BOOKS and LITERATURE registry records.
    expect((bindAtomicEntity(atomicById('TPL-BOK-001')) as PublishingEntity).isbnNumber).toBe('978-3-16-148410-0');
    expect((bindAtomicEntity(atomicById('TPL-LTR-001')) as PublishingEntity).isbnNumber).toBe('979-8-88645-112-8');
  });

  it('keeps every sector WITHOUT an entity class on telemetryMetric — no force-fitting', () => {
    for (const sector of ATOMIC_SECTOR_ORDER) {
      if ((ENTITY_BOUND_SECTORS as readonly string[]).includes(sector)) continue;
      const records = ATOMIC_TEMPLATE_REGISTRY.filter((r) => r.atomicSector === sector);
      expect(records.length, `sector ${sector} lost its records`).toBeGreaterThanOrEqual(1);
      for (const record of records) {
        expect(bindAtomicEntity(record), `${record.templateId} must bind no entity`).toBeNull();
      }
    }
  });

  it('carries the full coverage manifest — which sectors bind entities, which stay metric-only', () => {
    const manifest = ATOMIC_SECTOR_ORDER.map((sector) => ({
      sector,
      vertical: ATOMIC_SECTOR_TO_VERTICAL[sector],
      entityBound: (ENTITY_BOUND_SECTORS as readonly string[]).includes(sector),
      records: ATOMIC_TEMPLATE_REGISTRY.filter((r) => r.atomicSector === sector).length,
      boundRecords: ATOMIC_TEMPLATE_REGISTRY.filter(
        (r) => r.atomicSector === sector && bindAtomicEntity(r) !== null,
      ).length,
    }));
    const bound = manifest.filter((m) => m.entityBound);
    // Set equality — the ORDER canon lives in ATOMIC_SECTOR_ORDER, not here.
    expect([...bound.map((m) => m.sector)].sort()).toEqual([...ENTITY_BOUND_SECTORS].sort());
    for (const entry of bound) {
      expect(entry.boundRecords, `${entry.sector} binds entities on every record`).toBe(entry.records);
    }
    for (const entry of manifest.filter((m) => !m.entityBound)) {
      expect(entry.boundRecords).toBe(0);
    }
  });
});

describe('factory entity binding — prefix-driven', () => {
  it('binds the six film factory templates', () => {
    const bound = MASTER_TEMPLATE_LIBRARY.filter(
      (r) => r.templateId.startsWith('TPL-FLM-') && bindFactoryEntity(r) !== null,
    );
    expect(bound).toHaveLength(6);
    const flm7 = bindFactoryEntity(factoryById('TPL-FLM-007')) as FilmEntity;
    expect(flm7.entityType).toBe('FEATURE_FILM');
    expect(flm7.theatricalGrossEscrowUSD).toBe(3_640_000);
  });

  it('binds the five live-performance factory templates', () => {
    const bound = MASTER_TEMPLATE_LIBRARY.filter(
      (r) => r.templateId.startsWith('TPL-LVE-') && bindFactoryEntity(r) !== null,
    );
    expect(bound).toHaveLength(5);
    const lve9 = bindFactoryEntity(factoryById('TPL-LVE-009')) as LivePerformanceEntity;
    expect(lve9.entityType).toBe('STAGE_PERFORMANCE');
    expect(lve9.ticketEscrowBalanceUSD).toBe(268_400);
    expect(lve9.promoterInstantAllocationUSD).toBe(93_940);
    expect(lve9.houseSeatClearanceLock).toBe(true);
  });

  it('binds the literary factory templates with ISBN telemetry', () => {
    const lit2 = bindFactoryEntity(factoryById('TPL-LIT-002')) as PublishingEntity;
    expect(lit2.entityType).toBe('LITERARY_WORK');
    expect(lit2.isbnNumber).toBe('978-0-67-001962-6');
    expect(lit2.printOnDemandYieldUSD).toBe(38_600);
    expect(lit2.citationTelemetryCount).toBe(421);
  });

  it('leaves factory templates without an entity class unbound — 17 bound of 31', () => {
    for (const templateId of ['TPL-AUD-001', 'TPL-INT-001', 'TPL-BRD-001']) {
      const record = MASTER_TEMPLATE_LIBRARY.find((r) => r.templateId === templateId);
      if (record === undefined) continue;
      expect(bindFactoryEntity(record), `${templateId} must bind no entity`).toBeNull();
    }
    const boundCount = MASTER_TEMPLATE_LIBRARY.filter((r) => bindFactoryEntity(r) !== null).length;
    expect(boundCount).toBe(17); // 6 film + 5 live + 6 literary
  });
});

describe('validateServedEntity — the fail-closed serving gate', () => {
  it('passes every bound entity in both registries', () => {
    for (const record of ATOMIC_TEMPLATE_REGISTRY) {
      const entity = bindAtomicEntity(record);
      if (entity !== null) expect(validateServedEntity(entity), record.templateId).toBe(true);
    }
    for (const record of MASTER_TEMPLATE_LIBRARY) {
      const entity = bindFactoryEntity(record);
      if (entity !== null) expect(validateServedEntity(entity), record.templateId).toBe(true);
    }
  });

  it('fails a guarded class whose prefix betrays it — never serves', () => {
    const impostor = {
      entityType: 'FEATURE_FILM',
      templateId: 'TPL-AUD-001',
      isanCode: '0000-0000-0000-0000-W',
      theatricalGrossEscrowUSD: 1,
      studioOverlayActive: false,
      targetSplit: { ownership: 0.50, creative: 0.35, operations: 0.15 },
    } as unknown as Parameters<typeof validateServedEntity>[0];
    expect(validateServedEntity(impostor)).toBe(false);
  });

  it('fails an entity whose target split drifted off the 50/35/15 canon', () => {
    const drifted = {
      entityType: 'MASTER_RECORDING',
      templateId: 'TPL-MUS-001',
      isrcCode: 'US-S1Z-26-00001',
      subSecondMicroRoyaltyRate: 0.0035,
      proTelemetryBinding: 'ASCAP',
      targetSplit: { ownership: 0.60, creative: 0.30, operations: 0.10 },
    } as unknown as Parameters<typeof validateServedEntity>[0];
    expect(validateServedEntity(drifted)).toBe(false);
  });
});

describe('the module-load integrity gate and per-tab fetch set', () => {
  it('holds at import time — the registries import clean with the binding live', async () => {
    const previous = process.env.DON_DEV_SEED;
    process.env.DON_DEV_SEED = '1';
    try {
      const { demo, records } = await resolveAtomicRegistry();
      expect(demo).toBe(true);
      expect(records).toEqual(ATOMIC_TEMPLATE_REGISTRY);
      expect(bindAtomicEntity(atomicById('TPL-MUS-001'))).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.DON_DEV_SEED;
      else process.env.DON_DEV_SEED = previous;
    }
  });

  it('maps every vertical onto its sector doors — six verticals partition 26 sectors', () => {
    const verticals = [
      'AUDIO_AND_RECORDED_SOUND',
      'FILM_AND_TELEVISION',
      'PUBLISHING_AND_LITERARY',
      'LIVE_PERFORMANCE_AND_COMEDY',
      'INTERACTIVE_AND_DIGITAL_MEDIA',
      'COMMERCIAL_AND_BRAND_LICENSING',
    ] as const;
    let total = 0;
    for (const vertical of verticals) {
      const sectors = sectorsForVertical(vertical);
      expect(sectors.length, `${vertical} must cover at least one sector`).toBeGreaterThanOrEqual(1);
      for (const sector of sectors) {
        expect(ATOMIC_SECTOR_TO_VERTICAL[sector]).toBe(vertical);
      }
      total += sectors.length;
    }
    expect(total).toBe(26);
  });
});
