/**
 * Industry-completion wave tests — the 15 new SDK entity classes and
 * their store seeds (2026-10-07). Each class carries: an interface with
 * domain telemetry digits, an entityType union tag, and a fail-closed
 * guard validating the entityType tag plus its registry template-id
 * prefix — class AND prefix must BOTH hold, the canon rule since the
 * drop-5. Additive only: nothing existing is modified or removed.
 */
import { describe, expect, it } from 'vitest';
import {
  entityClassTag,
  isArenaOperatorEntity,
  isCadAssetStoreEntity,
  isDesignPracticeEntity,
  isDigitalAssetVaultEntity,
  isFashionHouseEntity,
  isGamingStudioEntity,
  isInteractiveExperienceEntity,
  isModelingAgencyEntity,
  isMotorsportCircuitEntity,
  isMovieStudioEntity,
  isSoftwareLicenseEntity,
  isStreamingServiceEntity,
  isVideoPlatformEntity,
  isVirtualAvatarCreatorEntity,
  isVisualArtsStudioEntity,
  type SovereignAtomicEntity,
} from '../CovnantAtomicDataSDK';
import {
  ATOMIC_SECTOR_ORDER,
  ATOMIC_TEMPLATE_REGISTRY,
  bindAtomicEntity,
  validateServedEntity,
  type AtomicContractRecord,
} from '../masterStore';

/** The canonical music prefix — every new-class guard must reject it
 *  (a class on a foreign prefix fails its guard, the drop-5 rule). */
const FOREIGN_PREFIX_ID = 'TPL-MUS-001';

const registryRecord = (templateId: string): AtomicContractRecord => {
  const record = ATOMIC_TEMPLATE_REGISTRY.find((r) => r.templateId === templateId);
  expect(record, `atomic record ${templateId} missing`).toBeDefined();
  return record as AtomicContractRecord;
};

/** The typed entity seed behind a registry record — honest fixtures only. */
const seedEntity = (templateId: string): SovereignAtomicEntity => {
  const entity = bindAtomicEntity(registryRecord(templateId));
  expect(entity, `${templateId} binds no entity`).not.toBeNull();
  return entity as SovereignAtomicEntity;
};

/**
 * The 15 new-class guard cases — each honest seed id, its guard, and a
 * foreign class tag from another wave class to reject. The honest seeds
 * come from the STORE (never hand-built), so the test also proves the
 * seeds hydrate through the same binding path the Control Board uses.
 */
const NEW_CLASS_CASES: ReadonlyArray<{
  readonly label: string;
  readonly seedId: string;
  readonly guard: (entity: SovereignAtomicEntity) => boolean;
  readonly foreignClass: 'ARENA_OPERATOR' | 'GAMING_STUDIO' | 'VIDEO_PLATFORM' | 'MOVIE_STUDIO' | 'INTERACTIVE_EXPERIENCE' | 'SOFTWARE_LICENSE' | 'DIGITAL_ASSET_VAULT' | 'FASHION_HOUSE' | 'MODELING_AGENCY' | 'CAD_ASSET_STORE' | 'VISUAL_ARTS_STUDIO' | 'DESIGN_PRACTICE' | 'VIRTUAL_AVATAR_CREATOR' | 'MOTORSPORT_CIRCUIT' | 'STREAMING_SERVICE';
}> = [
  { label: 'Motorsport Circuit', seedId: 'TPL-MTR-001', guard: isMotorsportCircuitEntity, foreignClass: 'ARENA_OPERATOR' },
  { label: 'Arena Operator', seedId: 'TPL-ARN-001', guard: isArenaOperatorEntity, foreignClass: 'GAMING_STUDIO' },
  { label: 'Movie Studio', seedId: 'TPL-MOV-001', guard: isMovieStudioEntity, foreignClass: 'VIDEO_PLATFORM' },
  { label: 'Video Platform', seedId: 'TPL-VID-001', guard: isVideoPlatformEntity, foreignClass: 'MOVIE_STUDIO' },
  { label: 'Streaming Service', seedId: 'TPL-STR-001', guard: isStreamingServiceEntity, foreignClass: 'INTERACTIVE_EXPERIENCE' },
  { label: 'Gaming Studio', seedId: 'TPL-GAM-001', guard: isGamingStudioEntity, foreignClass: 'SOFTWARE_LICENSE' },
  { label: 'Interactive Experience', seedId: 'TPL-IXP-001', guard: isInteractiveExperienceEntity, foreignClass: 'DIGITAL_ASSET_VAULT' },
  { label: 'Software License', seedId: 'TPL-SFT-001', guard: isSoftwareLicenseEntity, foreignClass: 'FASHION_HOUSE' },
  { label: 'Digital Asset Vault', seedId: 'TPL-DGA-001', guard: isDigitalAssetVaultEntity, foreignClass: 'MODELING_AGENCY' },
  { label: 'Fashion House', seedId: 'TPL-FSH-001', guard: isFashionHouseEntity, foreignClass: 'CAD_ASSET_STORE' },
  { label: 'Modeling Agency', seedId: 'TPL-MDL-001', guard: isModelingAgencyEntity, foreignClass: 'VISUAL_ARTS_STUDIO' },
  { label: 'CAD Asset Store', seedId: 'TPL-CAD-001', guard: isCadAssetStoreEntity, foreignClass: 'DESIGN_PRACTICE' },
  { label: 'Visual Arts Studio', seedId: 'TPL-VIS-001', guard: isVisualArtsStudioEntity, foreignClass: 'VIRTUAL_AVATAR_CREATOR' },
  { label: 'Design Practice', seedId: 'TPL-DES-001', guard: isDesignPracticeEntity, foreignClass: 'MOTORSPORT_CIRCUIT' },
  { label: 'Virtual Avatar Creator (VTubing)', seedId: 'TPL-VTB-001', guard: isVirtualAvatarCreatorEntity, foreignClass: 'STREAMING_SERVICE' },
];

describe('industry completion — the 15 new entity classes, seeded and guarded', () => {
  it('binds every new-class seed through the store with its typed fields', () => {
    for (const [seedId, field] of [
      ['TPL-MTR-001', 'telemetryLaneHours'],
      ['TPL-ARN-001', 'turnstileTraffic'],
      ['TPL-MOV-001', 'filmographyCount'],
      ['TPL-VID-001', 'streamHours'],
      ['TPL-STR-001', 'subscriberTierCount'],
      ['TPL-GAM-001', 'engineThreshold'],
      ['TPL-IXP-001', 'xrSessionHours'],
      ['TPL-SFT-001', 'seatLicenseCount'],
      ['TPL-DGA-001', 'vaultHoldCount'],
      ['TPL-FSH-001', 'cutSewUnitYieldUSD'],
      ['TPL-MDL-001', 'campaignDayRate'],
      ['TPL-CAD-001', 'meshDownloadCount'],
      ['TPL-VIS-001', 'editionCount'],
      ['TPL-DES-001', 'retainerCount'],
      ['TPL-VTB-001', 'streamFrameRenderHours'],
      ['TPL-VAV-001', 'directFanMicroTippingUSD'],
    ] as const) {
      const entity = seedEntity(seedId) as unknown as Record<string, unknown>;
      expect(typeof entity[field], `${seedId}.${field} missing`).toBe('number');
      expect(validateServedEntity(seedEntity(seedId)), `${seedId} fails its fail-closed guard`).toBe(true);
    }
  });

  it('passes the honest guard and fails the wrong class on its own prefix — per new class', () => {
    for (const { seedId, guard, foreignClass } of NEW_CLASS_CASES) {
      const honest = seedEntity(seedId);
      expect(guard(honest), `${seedId} fails its own guard`).toBe(true);
      const impostor = { ...honest, entityType: foreignClass } as unknown as SovereignAtomicEntity;
      expect(guard(impostor), `${foreignClass} on ${seedId} must fail closed`).toBe(false);
    }
  });

  it('fails every new-class guard on its own class wearing the foreign MUSIC prefix', () => {
    for (const { seedId, guard } of NEW_CLASS_CASES) {
      const honest = seedEntity(seedId) as unknown as Record<string, unknown>;
      const foreignPrefix = { ...honest, templateId: FOREIGN_PREFIX_ID } as unknown as SovereignAtomicEntity;
      expect(guard(foreignPrefix), `${seedId} class on ${FOREIGN_PREFIX_ID} must fail closed`).toBe(false);
    }
  });

  it('carries the pill tag of each bound class through entityClassTag', () => {
    for (const [seedId, pill] of [
      ['TPL-MTR-001', 'MOTORSPORT'],
      ['TPL-ARN-001', 'ARENA'],
      ['TPL-MOV-001', 'MOVIES'],
      ['TPL-VID-001', 'VIDEO'],
      ['TPL-STR-001', 'STREAMING'],
      ['TPL-GAM-001', 'GAMING'],
      ['TPL-IXP-001', 'INTERACTIVE'],
      ['TPL-SFT-001', 'SOFTWARE'],
      ['TPL-DGA-001', 'DIGITAL_ASSETS'],
      ['TPL-FSH-001', 'FASHION'],
      ['TPL-MDL-001', 'MODELING'],
      ['TPL-CAD-001', 'CAD'],
      ['TPL-VIS-001', 'VISUAL_ARTS'],
      ['TPL-DES-001', 'DESIGN'],
      ['TPL-VTB-001', 'VTUBING'],
      ['TPL-VAV-001', 'VTUBING'],
    ] as const) {
      expect(entityClassTag(seedEntity(seedId)), seedId).toBe(pill);
    }
  });

  it('binds a typed entity for every atomic sector of the canon — 29 of 29', () => {
    for (const sector of ATOMIC_SECTOR_ORDER) {
      const records = ATOMIC_TEMPLATE_REGISTRY.filter((r) => r.atomicSector === sector);
      expect(records.length, `sector ${sector} lost its records`).toBeGreaterThanOrEqual(1);
      for (const record of records) {
        expect(bindAtomicEntity(record), `${record.templateId} (${sector}) must bind a typed entity`).not.toBeNull();
      }
    }
  });
});