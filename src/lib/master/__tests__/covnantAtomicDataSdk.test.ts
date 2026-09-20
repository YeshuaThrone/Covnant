/**
 * CovnantAtomicDataSDK canon gates — the six isolated entity classes
 * EXACTLY as dropped (founder directive, 2026-09-20): the entity shapes,
 * the compiler-locked 50/35/15 target split, the class tag vocabulary, and
 * the four fail-closed guards (class AND prefix must BOTH match).
 */
import { describe, expect, it } from 'vitest';
import {
  ENTITY_TARGET_SPLIT,
  entityClassTag,
  isFilmEntity,
  isLiveEntity,
  isMusicEntity,
  isTvEntity,
  type FilmEntity,
  type LivePerformanceEntity,
  type MusicEntity,
  type PodcastEntity,
  type PublishingEntity,
  type SovereignAtomicEntity,
  type TelevisionEntity,
} from '../CovnantAtomicDataSDK';

describe('the canon target split', () => {
  it('locks the 50/35/15 split as fractions — one value, frozen', () => {
    expect(ENTITY_TARGET_SPLIT).toEqual({ ownership: 0.50, creative: 0.35, operations: 0.15 });
    expect(Object.isFrozen(ENTITY_TARGET_SPLIT)).toBe(true);
  });
});

describe('the six isolated entity classes', () => {
  it('shapes the film entity — FEATURE_FILM on the TPL-FLM- prefix', () => {
    const film: FilmEntity = {
      entityType: 'FEATURE_FILM',
      templateId: 'TPL-FLM-001',
      isanCode: '0003-1A2F-9C4B-0002-W',
      theatricalGrossEscrowUSD: 4_250_000,
      studioOverlayActive: true,
      targetSplit: ENTITY_TARGET_SPLIT,
    };
    expect(film.entityType).toBe('FEATURE_FILM');
    expect(film.templateId.startsWith('TPL-FLM-')).toBe(true);
    expect(isFilmEntity(film)).toBe(true);
  });

  it('shapes the television entity — LINEAR_TV on the TPL-TV- prefix', () => {
    const tv: TelevisionEntity = {
      entityType: 'LINEAR_TV',
      templateId: 'TPL-TV-001',
      nielsenFlightMinutes: 12_480,
      syndicationReversionLock: true,
      adInsertionMicroYieldUSD: 86_400,
      targetSplit: ENTITY_TARGET_SPLIT,
    };
    expect(tv.entityType).toBe('LINEAR_TV');
    expect(isTvEntity(tv)).toBe(true);
  });

  it('shapes the music entity — MASTER_RECORDING, ISRC, sub-second micro royalties, PRO binding', () => {
    const music: MusicEntity = {
      entityType: 'MASTER_RECORDING',
      templateId: 'TPL-MUS-001',
      isrcCode: 'US-S1Z-26-00001',
      subSecondMicroRoyaltyRate: 0.0035,
      proTelemetryBinding: 'ASCAP',
      targetSplit: ENTITY_TARGET_SPLIT,
    };
    expect(music.entityType).toBe('MASTER_RECORDING');
    expect(music.isrcCode).toBe('US-S1Z-26-00001');
    expect(music.subSecondMicroRoyaltyRate).toBe(0.0035);
    expect(music.proTelemetryBinding).toBe('ASCAP');
    expect(isMusicEntity(music)).toBe(true);
  });

  it('shapes the podcast entity — PODCAST_NETWORK on the TPL-PDC- prefix', () => {
    const podcast: PodcastEntity = {
      entityType: 'PODCAST_NETWORK',
      templateId: 'TPL-PDC-001',
      downloadCountTelemetry: 1_284_000,
      dynamicAdInsertYieldUSD: 42_600,
      feedIsolationActive: true,
      targetSplit: ENTITY_TARGET_SPLIT,
    };
    expect(podcast.entityType).toBe('PODCAST_NETWORK');
    expect(podcast.feedIsolationActive).toBe(true);
  });

  it('shapes the live-performance entity — STAGE_PERFORMANCE on the TPL-LVE- prefix', () => {
    const live: LivePerformanceEntity = {
      entityType: 'STAGE_PERFORMANCE',
      templateId: 'TPL-LVE-009',
      ticketEscrowBalanceUSD: 268_400,
      promoterInstantAllocationUSD: 93_940,
      houseSeatClearanceLock: true,
      targetSplit: ENTITY_TARGET_SPLIT,
    };
    expect(live.entityType).toBe('STAGE_PERFORMANCE');
    expect(isLiveEntity(live)).toBe(true);
  });

  it('shapes the publishing entity — LITERARY_WORK on the TPL-PUB-/TPL-LIT- prefixes', () => {
    const publishing: PublishingEntity = {
      entityType: 'LITERARY_WORK',
      templateId: 'TPL-PUB-001',
      isbnNumber: '978-1-4028-9462-6',
      printOnDemandYieldUSD: 84_200,
      citationTelemetryCount: 1_260,
      targetSplit: ENTITY_TARGET_SPLIT,
    };
    expect(publishing.entityType).toBe('LITERARY_WORK');
    expect(publishing.isbnNumber).toBe('978-1-4028-9462-6');
  });
});

describe('the fail-closed guards — class AND prefix must both match', () => {
  const musicEntity: MusicEntity = {
    entityType: 'MASTER_RECORDING',
    templateId: 'TPL-MUS-001',
    isrcCode: 'US-S1Z-26-00001',
    subSecondMicroRoyaltyRate: 0.0035,
    proTelemetryBinding: 'ASCAP',
    targetSplit: ENTITY_TARGET_SPLIT,
  };

  it('rejects a film-class entity wearing a foreign template prefix', () => {
    const impostor = {
      ...musicEntity,
      entityType: 'FEATURE_FILM' as const,
      templateId: 'TPL-AUD-001',
      isanCode: '0000-0000-0000-0000-W',
      theatricalGrossEscrowUSD: 1,
      studioOverlayActive: false,
    } as unknown as SovereignAtomicEntity;
    expect(isFilmEntity(impostor)).toBe(false);
  });

  it('rejects a correct prefix when the class does not match', () => {
    expect(isFilmEntity(musicEntity)).toBe(false);
    expect(isTvEntity(musicEntity)).toBe(false);
    expect(isLiveEntity(musicEntity)).toBe(false);
  });

  it('rejects a class on a prefix owned by another class — both must hold, per guard', () => {
    const filmOnMusicPrefix = {
      ...musicEntity,
      entityType: 'FEATURE_FILM' as const,
    } as unknown as SovereignAtomicEntity;
    // TPL-MUS- is the MUSIC prefix — a film class fails the film guard on it.
    expect(isFilmEntity(filmOnMusicPrefix)).toBe(false);
    // The same shape under its own prefix passes.
    const filmOnFilmPrefix = { ...filmOnMusicPrefix, templateId: 'TPL-FLM-001' };
    expect(isFilmEntity(filmOnFilmPrefix)).toBe(true);
  });

  it('passes exactly one guard per correct entity', () => {
    const entities: readonly SovereignAtomicEntity[] = [
      { entityType: 'FEATURE_FILM', templateId: 'TPL-FLM-001', isanCode: 'X', theatricalGrossEscrowUSD: 1, studioOverlayActive: false, targetSplit: ENTITY_TARGET_SPLIT },
      { entityType: 'LINEAR_TV', templateId: 'TPL-TV-001', nielsenFlightMinutes: 1, syndicationReversionLock: false, adInsertionMicroYieldUSD: 1, targetSplit: ENTITY_TARGET_SPLIT },
      musicEntity,
      { entityType: 'STAGE_PERFORMANCE', templateId: 'TPL-LVE-001', ticketEscrowBalanceUSD: 1, promoterInstantAllocationUSD: 1, houseSeatClearanceLock: false, targetSplit: ENTITY_TARGET_SPLIT },
    ];
    for (const entity of entities) {
      const passes = [isFilmEntity(entity), isTvEntity(entity), isMusicEntity(entity), isLiveEntity(entity)];
      expect(passes.filter(Boolean)).toHaveLength(1);
    }
  });
});

describe('the class tag vocabulary — one isolated pill per class', () => {
  it('maps every entity class to its tag', () => {
    const film: SovereignAtomicEntity = { entityType: 'FEATURE_FILM', templateId: 'TPL-FLM-001', isanCode: 'X', theatricalGrossEscrowUSD: 1, studioOverlayActive: false, targetSplit: ENTITY_TARGET_SPLIT };
    const tv: SovereignAtomicEntity = { entityType: 'LINEAR_TV', templateId: 'TPL-TV-001', nielsenFlightMinutes: 1, syndicationReversionLock: false, adInsertionMicroYieldUSD: 1, targetSplit: ENTITY_TARGET_SPLIT };
    const podcast: SovereignAtomicEntity = { entityType: 'PODCAST_NETWORK', templateId: 'TPL-PDC-001', downloadCountTelemetry: 1, dynamicAdInsertYieldUSD: 1, feedIsolationActive: false, targetSplit: ENTITY_TARGET_SPLIT };
    const live: SovereignAtomicEntity = { entityType: 'STAGE_PERFORMANCE', templateId: 'TPL-LVE-001', ticketEscrowBalanceUSD: 1, promoterInstantAllocationUSD: 1, houseSeatClearanceLock: false, targetSplit: ENTITY_TARGET_SPLIT };
    const publishing: SovereignAtomicEntity = { entityType: 'LITERARY_WORK', templateId: 'TPL-PUB-001', isbnNumber: 'X', printOnDemandYieldUSD: 1, citationTelemetryCount: 1, targetSplit: ENTITY_TARGET_SPLIT };
    const music: SovereignAtomicEntity = { entityType: 'MASTER_RECORDING', templateId: 'TPL-MUS-001', isrcCode: 'US-S1Z-26-00001', subSecondMicroRoyaltyRate: 0.0035, proTelemetryBinding: 'ASCAP', targetSplit: ENTITY_TARGET_SPLIT };
    expect(entityClassTag(film)).toBe('FILM');
    expect(entityClassTag(tv)).toBe('TV');
    expect(entityClassTag(music)).toBe('MUSIC');
    expect(entityClassTag(podcast)).toBe('PODCASTING');
    expect(entityClassTag(live)).toBe('LIVE');
    expect(entityClassTag(publishing)).toBe('PUBLISHING');
  });
});
