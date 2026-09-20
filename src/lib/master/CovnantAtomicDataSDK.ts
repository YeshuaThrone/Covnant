/**
 * CovnantAtomicDataSDK — the six isolated atomic entity classes (founder
 * canon drop, 2026-09-20), EXACTLY as dropped: film, television, music,
 * podcast, live performance, and publishing — each with its typed entity
 * literal, its template-id prefix canon, its domain telemetry, and the
 * compiler-locked 50/35/15 target split (the canon structure as fractions).
 *
 * PURE CANON — this module imports nothing and depends on no store. The
 * master store (src/lib/master/masterStore) holds the entity DATA and the
 * binding; components never inline entity literals (the honesty law). The
 * four fail-closed guards enforce the canon binding rule: an entity's class
 * AND its template-id prefix must both match before the class is claimed.
 */

/** The canon target split — 0.50 ownership / 0.35 creative / 0.15 operations. */
export interface EntityTargetSplit {
  readonly ownership: 0.50;
  readonly creative: 0.35;
  readonly operations: 0.15;
}

/** The one canon split value — a constant, so no entity can drift. */
export const ENTITY_TARGET_SPLIT: EntityTargetSplit = Object.freeze({
  ownership: 0.50,
  creative: 0.35,
  operations: 0.15,
});

/** PRO telemetry bindings of the music canon. */
export type ProTelemetryBinding = 'ASCAP' | 'BMI' | 'SESAC' | 'DIRECT';

/** Feature film entity — theatrical distribution, ISAN-tracked. */
export interface FilmEntity {
  readonly entityType: 'FEATURE_FILM';
  /** Template prefix canon: TPL-FLM-*. */
  readonly templateId: string;
  readonly isanCode: string;
  readonly theatricalGrossEscrowUSD: number;
  readonly studioOverlayActive: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Linear television entity — Nielsen flights and syndication reversion. */
export interface TelevisionEntity {
  readonly entityType: 'LINEAR_TV';
  /** Template prefix canon: TPL-TV-*. */
  readonly templateId: string;
  readonly nielsenFlightMinutes: number;
  readonly syndicationReversionLock: boolean;
  readonly adInsertionMicroYieldUSD: number;
  readonly targetSplit: EntityTargetSplit;
}

/** Master recording entity — ISRC-tracked, sub-second micro royalties. */
export interface MusicEntity {
  readonly entityType: 'MASTER_RECORDING';
  /** Template prefix canon: TPL-MUS-*. */
  readonly templateId: string;
  readonly isrcCode: string;
  readonly subSecondMicroRoyaltyRate: number;
  readonly proTelemetryBinding: ProTelemetryBinding;
  readonly targetSplit: EntityTargetSplit;
}

/** Podcast network entity — download telemetry and dynamic ad insertion. */
export interface PodcastEntity {
  readonly entityType: 'PODCAST_NETWORK';
  /** Template prefix canon: TPL-PDC-*. */
  readonly templateId: string;
  readonly downloadCountTelemetry: number;
  readonly dynamicAdInsertYieldUSD: number;
  readonly feedIsolationActive: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Stage performance entity — ticket escrow and house seat clearance. */
export interface LivePerformanceEntity {
  readonly entityType: 'STAGE_PERFORMANCE';
  /** Template prefix canon: TPL-LVE-*. */
  readonly templateId: string;
  readonly ticketEscrowBalanceUSD: number;
  readonly promoterInstantAllocationUSD: number;
  readonly houseSeatClearanceLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Literary work entity — ISBN-tracked, print-on-demand yield. */
export interface PublishingEntity {
  readonly entityType: 'LITERARY_WORK';
  /** Template prefix canon: TPL-PUB-* | TPL-LIT-*. */
  readonly templateId: string;
  readonly isbnNumber: string;
  readonly printOnDemandYieldUSD: number;
  readonly citationTelemetryCount: number;
  readonly targetSplit: EntityTargetSplit;
}

/** The isolated entity union — one class per entity, never bundled. */
export type SovereignAtomicEntity =
  | FilmEntity
  | TelevisionEntity
  | MusicEntity
  | PodcastEntity
  | LivePerformanceEntity
  | PublishingEntity;

/**
 * The drop-2 execution canon: every entity execution reports exactly one of
 * the two clearing states. Transaction grosses ride beside the state as
 * integer cents (the engine-path money).
 */
export type AtomicExecutionState = 'CLEARED' | 'HELD_IN_ESCROW';

/** One entity execution's telemetry — state + engine-path gross. */
export interface AtomicExecutionTelemetry {
  readonly executionState: AtomicExecutionState;
  readonly grossVolumeCents: number;
}

/** The isolated class tags rendered as pill badges — one pill per class. */
export type AtomicEntityClassTag =
  | 'MUSIC'
  | 'FILM'
  | 'TV'
  | 'PODCASTING'
  | 'LIVE'
  | 'PUBLISHING';

/** The class tag of an entity — the pill-badge vocabulary, one per class. */
export function entityClassTag(entity: SovereignAtomicEntity): AtomicEntityClassTag {
  switch (entity.entityType) {
    case 'FEATURE_FILM':
      return 'FILM';
    case 'LINEAR_TV':
      return 'TV';
    case 'MASTER_RECORDING':
      return 'MUSIC';
    case 'PODCAST_NETWORK':
      return 'PODCASTING';
    case 'STAGE_PERFORMANCE':
      return 'LIVE';
    case 'LITERARY_WORK':
      return 'PUBLISHING';
  }
}

/** Template-id prefix canons — the fail-closed binding keys. */
export const TEMPLATE_PREFIX = {
  FILM: 'TPL-FLM-',
  TV: 'TPL-TV-',
  MUSIC: 'TPL-MUS-',
  PODCAST: 'TPL-PDC-',
  LIVE: 'TPL-LVE-',
  PUBLISHING_FACTORY: ['TPL-PUB-', 'TPL-LIT-'],
  /** Sector-driven literary bindings (BOOKS and LITERATURE registries). */
  PUBLISHING_SECTOR: ['TPL-BOK-', 'TPL-LTR-'],
} as const;

/**
 * The four fail-closed guards — class AND prefix must both match. An entity
 * claiming a class with a foreign template prefix fails its guard, and a
 * guard failure never serves (the route fails closed on it).
 */
export function isFilmEntity(entity: SovereignAtomicEntity): entity is FilmEntity {
  return entity.entityType === 'FEATURE_FILM' && entity.templateId.startsWith(TEMPLATE_PREFIX.FILM);
}

export function isMusicEntity(entity: SovereignAtomicEntity): entity is MusicEntity {
  return entity.entityType === 'MASTER_RECORDING' && entity.templateId.startsWith(TEMPLATE_PREFIX.MUSIC);
}

export function isTvEntity(entity: SovereignAtomicEntity): entity is TelevisionEntity {
  return entity.entityType === 'LINEAR_TV' && entity.templateId.startsWith(TEMPLATE_PREFIX.TV);
}

export function isLiveEntity(entity: SovereignAtomicEntity): entity is LivePerformanceEntity {
  return entity.entityType === 'STAGE_PERFORMANCE' && entity.templateId.startsWith(TEMPLATE_PREFIX.LIVE);
}
