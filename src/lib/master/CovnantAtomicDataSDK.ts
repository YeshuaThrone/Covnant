/**
 * CovnantAtomicDataSDK — the isolated atomic entity classes: the founder's
 * six-canon drop (2026-09-20) plus the five generation-4 expansion classes
 * (approved build, 2026-09-22): ATHLETE_CONTRACT, TOURNAMENT_EVENT,
 * ESPORTS_STREAM, SOCIAL_CHANNEL, and SPONSORSHIP_DEAL — the entertainment
 * forms of sports, esports, social monetization, and brand sponsorship.
 * Each class carries its typed entity literal, its template-id prefix canon,
 * its domain telemetry, and the compiler-locked 50/35/15 target split.
 *
 * PURE CANON — this module imports nothing at RUNTIME and depends on no
 * store (the engine union import below is type-only). The
 * master store (src/lib/master/masterStore) holds the entity DATA and the
 * binding; components never inline entity literals (the honesty law). The
 * nine fail-closed guards enforce the canon binding rule: an entity's class
 * AND its template-id prefix must both match before the class is claimed.
 */

import type { SocialEntertainmentPlatform } from '@/engine/covenant-master-sdk';

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

// ─────────────────────────────────────────────────────────────────────────────
// GENERATION-4 EXPANSION CLASSES (approved build, 2026-09-22): five new forms
// of entertainment in the exact canon shape — typed interface, prefix-canon
// template id, domain telemetry from the video vocabulary, and the shared
// compiler-locked 50/35/15 split (ENTITY_TARGET_SPLIT stays the ONE split
// constant; no class carries its own split literal).
// ─────────────────────────────────────────────────────────────────────────────

/** Athlete contract entity — brand sponsorship and endorsement money. */
export interface AthleteContractEntity {
  readonly entityType: 'ATHLETE_CONTRACT';
  /** Template prefix canon: TPL-SPT-*. */
  readonly templateId: string;
  /** Video vocabulary: contract_id NK_404. */
  readonly contractId: string;
  /** Video vocabulary: sport: basketball. */
  readonly sport: string;
  readonly sponsorshipGuaranteeUSD: number;
  readonly endorsementExclusivityLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Tournament event entity — prize-purse escrow and placement settlement. */
export interface TournamentEventEntity {
  readonly entityType: 'TOURNAMENT_EVENT';
  /** Template prefix canon: TPL-TRN-*. */
  readonly templateId: string;
  /** Video vocabulary: event_id (PGA TOUR 2026). */
  readonly eventId: string;
  /** The sport or game the tournament is played in. */
  readonly discipline: string;
  /** Video vocabulary: prize purse. */
  readonly prizePurseEscrowUSD: number;
  readonly payoutReleaseLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Esports stream entity — Twitch/Epic-style stream monetization. */
export interface EsportsStreamEntity {
  readonly entityType: 'ESPORTS_STREAM';
  /** Template prefix canon: TPL-ESX-*. */
  readonly templateId: string;
  /** Video vocabulary: stream_id TW_888. */
  readonly streamId: string;
  /** Video vocabulary: game: Fortnite. */
  readonly game: string;
  readonly streamMonetizationYieldUSD: number;
  readonly clipLicensingLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Social channel entity — monetized platform channels and content matching. */
export interface SocialChannelEntity {
  readonly entityType: 'SOCIAL_CHANNEL';
  /** Template prefix canon: TPL-SOC-*. */
  readonly templateId: string;
  /** The canon SocialEntertainmentPlatform union (engine SDK, type-only). */
  readonly platform: SocialEntertainmentPlatform;
  readonly channelId: string;
  readonly contentMatchYieldUSD: number;
  readonly monetizationReviewLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Sponsorship deal entity — the cross-industry brand-deal connective form. */
export interface SponsorshipDealEntity {
  readonly entityType: 'SPONSORSHIP_DEAL';
  /** Template prefix canon: TPL-SPN-*. */
  readonly templateId: string;
  readonly brandPartner: string;
  readonly campaignId: string;
  readonly dealValueUSD: number;
  readonly activationWindowLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

// ─────────────────────────────────────────────────────────────────────────────
// INDUSTRY-COMPLETION EXPANSION CLASSES (2026-10-07): fifteen new forms of
// entertainment relationship completing the founder's 26-sector atomic
// registry — every previously telemetryMetric-only sector now binds a typed
// entity class. VIRTUAL_AVATARS class-maps onto the VTubing creator form
// (same rig-ownership canon); BOOKS and LITERATURE already ride the existing
// PUBLISHING class. Same canon shape as every class above: typed interface,
// prefix-canon template id, domain telemetry, and the shared compiler-locked
// 50/35/15 split (ENTITY_TARGET_SPLIT stays the ONE split constant; no class
// carries its own split literal).
// ─────────────────────────────────────────────────────────────────────────────

/** Motorsport circuit entity — telemetry track time and pit-lane media money. */
export interface MotorsportCircuitEntity {
  readonly entityType: 'MOTORSPORT_CIRCUIT';
  /** Template prefix canon: TPL-MTR-*. */
  readonly templateId: string;
  readonly telemetryLaneHours: number;
  readonly pitLaneAssetLock: boolean;
  readonly lapBroadcastMicroPayoutUSD: number;
  readonly targetSplit: EntityTargetSplit;
}

/** Arena operator entity — turnstile traffic and in-venue concessions yield. */
export interface ArenaOperatorEntity {
  readonly entityType: 'ARENA_OPERATOR';
  /** Template prefix canon: TPL-ARN-*. */
  readonly templateId: string;
  readonly turnstileTraffic: number;
  readonly concessionsYieldUSD: number;
  readonly gateClearanceLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Movie studio entity — the back-catalog circulation engine, library-tracked. */
export interface MovieStudioEntity {
  readonly entityType: 'MOVIE_STUDIO';
  /** Template prefix canon: TPL-MOV-*. */
  readonly templateId: string;
  readonly filmographyCount: number;
  readonly contractedLibraryTitles: number;
  readonly distributionTerritoryLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Video platform entity — watch-hour distribution and creator-fund micro routing. */
export interface VideoPlatformEntity {
  readonly entityType: 'VIDEO_PLATFORM';
  /** Template prefix canon: TPL-VID-*. */
  readonly templateId: string;
  readonly streamHours: number;
  readonly avrailLock: boolean;
  readonly avodMicroYieldUSD: number;
  readonly targetSplit: EntityTargetSplit;
}

/** Streaming service entity — the subscription-pool distribution form. */
export interface StreamingServiceEntity {
  readonly entityType: 'STREAMING_SERVICE';
  /** Template prefix canon: TPL-STR-*. */
  readonly templateId: string;
  readonly subscriberTierCount: number;
  readonly streamMicroYieldUSD: number;
  readonly feedIsolationActive: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Gaming studio entity — microtransaction distribution over player sessions. */
export interface GamingStudioEntity {
  readonly entityType: 'GAMING_STUDIO';
  /** Template prefix canon: TPL-GAM-*. */
  readonly templateId: string;
  readonly engineThreshold: number;
  readonly robloxDevExRate: number;
  readonly assetTreeDepthLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Interactive experience entity — participation licensing and session yield. */
export interface InteractiveExperienceEntity {
  readonly entityType: 'INTERACTIVE_EXPERIENCE';
  /** Seed id canon: TPL-IXP-* — the registry's Experience-Producer id prefix. */
  readonly templateId: string;
  readonly xrSessionHours: number;
  readonly immersionYieldUSD: number;
  readonly captureLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Software license entity — seat counts and license-key activation yield. */
export interface SoftwareLicenseEntity {
  readonly entityType: 'SOFTWARE_LICENSE';
  /** Template prefix canon: TPL-SFT-*. */
  readonly templateId: string;
  readonly seatLicenseCount: number;
  readonly apiInvocationMicroPayoutUSD: number;
  readonly escrowLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Digital asset vault entity — custody holds and asset-transfer micro routing. */
export interface DigitalAssetVaultEntity {
  readonly entityType: 'DIGITAL_ASSET_VAULT';
  /** Template prefix canon: TPL-DGA-*. */
  readonly templateId: string;
  readonly vaultHoldCount: number;
  readonly microTippingYieldUSD: number;
  readonly custodyLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Fashion house entity — physical garment production yield and inventory. */
export interface FashionHouseEntity {
  readonly entityType: 'FASHION_HOUSE';
  /** Template prefix canon: TPL-FSH-*. */
  readonly templateId: string;
  readonly cutSewUnitYieldUSD: number;
  readonly atelierLock: boolean;
  readonly wholesaleInventoryCount: number;
  readonly targetSplit: EntityTargetSplit;
}

/** Modeling agency entity — runway and campaign booking yield. */
export interface ModelingAgencyEntity {
  readonly entityType: 'MODELING_AGENCY';
  /** Template prefix canon: TPL-MDL-*. */
  readonly templateId: string;
  readonly campaignDayRate: number;
  readonly imageUsageMicroPayoutUSD: number;
  readonly likenessLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** CAD asset store entity — spatial polygon licensing and render-engine yield. */
export interface CadAssetStoreEntity {
  readonly entityType: 'CAD_ASSET_STORE';
  /** Template prefix canon: TPL-CAD-*. */
  readonly templateId: string;
  readonly meshDownloadCount: number;
  readonly apiInvocationMicroPayoutUSD: number;
  readonly polygonLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Visual arts studio entity — exhibition proceeds and print-edition yield. */
export interface VisualArtsStudioEntity {
  readonly entityType: 'VISUAL_ARTS_STUDIO';
  /** Template prefix canon: TPL-VIS-*. */
  readonly templateId: string;
  readonly editionCount: number;
  readonly galleryCommissionYieldUSD: number;
  readonly provenanceLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Design practice entity — portfolio licensing and derivative-deployment royalty. */
export interface DesignPracticeEntity {
  readonly entityType: 'DESIGN_PRACTICE';
  /** Template prefix canon: TPL-DES-*. */
  readonly templateId: string;
  readonly retainerCount: number;
  readonly royaltyOnApplicationUSD: number;
  readonly attributionLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** Virtual avatar creator entity — rig ownership and direct-fan tipping money; the VTUBING and VIRTUAL_AVATARS sectors ride this ONE class. */
export interface VirtualAvatarCreatorEntity {
  readonly entityType: 'VIRTUAL_AVATAR_CREATOR';
  /** Template prefix canon: TPL-VTB-*. */
  readonly templateId: string;
  readonly streamFrameRenderHours: number;
  readonly directFanMicroTippingUSD: number;
  readonly rigOwnershipLock: boolean;
  readonly targetSplit: EntityTargetSplit;
}

/** The isolated entity union — the six founder-canon classes plus the five expansion classes. */
export type SovereignAtomicEntity =
  | FilmEntity
  | TelevisionEntity
  | MusicEntity
  | PodcastEntity
  | LivePerformanceEntity
  | PublishingEntity
  | AthleteContractEntity
  | TournamentEventEntity
  | EsportsStreamEntity
  | SocialChannelEntity
  | SponsorshipDealEntity
  | MotorsportCircuitEntity
  | ArenaOperatorEntity
  | MovieStudioEntity
  | VideoPlatformEntity
  | StreamingServiceEntity
  | GamingStudioEntity
  | InteractiveExperienceEntity
  | SoftwareLicenseEntity
  | DigitalAssetVaultEntity
  | FashionHouseEntity
  | ModelingAgencyEntity
  | CadAssetStoreEntity
  | VisualArtsStudioEntity
  | DesignPracticeEntity
  | VirtualAvatarCreatorEntity;

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
  | 'PUBLISHING'
  | 'SPORTS'
  | 'ESPORTS'
  | 'SOCIAL'
  | 'SPONSORSHIP'
  // Industry-completion expansion (2026-10-07) — the fifteen new class tags
  // completing the 26-sector canon: one tag per new class, and
  // VIRTUAL_AVATARS rides the VTubing creator class the same way BOOKS and
  // LITERATURE ride PUBLISHING.
  | 'MOTORSPORT'
  | 'ARENA'
  | 'MOVIES'
  | 'VIDEO'
  | 'STREAMING'
  | 'GAMING'
  | 'INTERACTIVE'
  | 'SOFTWARE'
  | 'DIGITAL_ASSETS'
  | 'FASHION'
  | 'MODELING'
  | 'CAD'
  | 'VISUAL_ARTS'
  | 'DESIGN'
  | 'VTUBING';

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
    case 'ATHLETE_CONTRACT':
    case 'TOURNAMENT_EVENT':
      return 'SPORTS';
    case 'ESPORTS_STREAM':
      return 'ESPORTS';
    case 'SOCIAL_CHANNEL':
      return 'SOCIAL';
    case 'SPONSORSHIP_DEAL':
      return 'SPONSORSHIP';
    // Industry-completion expansion (2026-10-07) — one tag per class;
    // VIRTUAL_AVATARS rides the VTubing creator class like BOOKS and
    // LITERATURE ride PUBLISHING.
    case 'MOTORSPORT_CIRCUIT':
      return 'MOTORSPORT';
    case 'ARENA_OPERATOR':
      return 'ARENA';
    case 'MOVIE_STUDIO':
      return 'MOVIES';
    case 'VIDEO_PLATFORM':
      return 'VIDEO';
    case 'STREAMING_SERVICE':
      return 'STREAMING';
    case 'GAMING_STUDIO':
      return 'GAMING';
    case 'INTERACTIVE_EXPERIENCE':
      return 'INTERACTIVE';
    case 'SOFTWARE_LICENSE':
      return 'SOFTWARE';
    case 'DIGITAL_ASSET_VAULT':
      return 'DIGITAL_ASSETS';
    case 'FASHION_HOUSE':
      return 'FASHION';
    case 'MODELING_AGENCY':
      return 'MODELING';
    case 'CAD_ASSET_STORE':
      return 'CAD';
    case 'VISUAL_ARTS_STUDIO':
      return 'VISUAL_ARTS';
    case 'DESIGN_PRACTICE':
      return 'DESIGN';
    case 'VIRTUAL_AVATAR_CREATOR':
      return 'VTUBING';
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
  /** Generation-4 expansion prefixes (2026-09-22). */
  SPORTS: 'TPL-SPT-',
  TOURNAMENT: 'TPL-TRN-',
  ESPORTS: 'TPL-ESX-',
  SOCIAL: 'TPL-SOC-',
  SPONSORSHIP: 'TPL-SPN-',
  /** Industry-completion expansion prefixes (2026-10-07). */
  MOTORSPORT: 'TPL-MTR-',
  ARENA: 'TPL-ARN-',
  MOVIES: 'TPL-MOV-',
  VIDEO: 'TPL-VID-',
  STREAMING: 'TPL-STR-',
  GAMING: 'TPL-GAM-',
  /** Seed id canon: TPL-IXP-* — the sector's registry prefix (the SDK
   * interface's TPL-INT- comment describes the class canon's intent, but the
   * registry is the binding source of truth and the guard must bind it). */
  INTERACTIVE: 'TPL-IXP-',
  SOFTWARE: 'TPL-SFT-',
  DIGITAL_ASSETS: 'TPL-DGA-',
  FASHION: 'TPL-FSH-',
  MODELING: 'TPL-MDL-',
  CAD: 'TPL-CAD-',
  VISUAL_ARTS: 'TPL-VIS-',
  DESIGN: 'TPL-DES-',
  VTUBING: 'TPL-VTB-',
  /** The VIRTUAL_AVATARS sector's own ids; the class stays VirtualAvatarCreator. */
  VIRTUAL_AVATARS: 'TPL-VAV-',
  /** The ATHLETICS sector's own ids; the class stays AthleteContract. */
  ATHLETICS: 'TPL-ATH-',
} as const;

/**
 * The fail-closed guards — class AND prefix must both match. An entity
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

/** The entity class names — the guard registry's entityType binding keys. */
export type AtomicEntityTypeName = SovereignAtomicEntity['entityType'];

/**
 * The two drop-series guards the founder's registry left unguarded, completed
 * by the Universal Execution Lane expansion (2026-09-20): all six founder-canon
 * classes now carry the fail-closed class+prefix pairing invariant. The five
 * generation-4 expansion classes below (2026-09-22) ship with their guards the
 * same way — new classes come only from founder-approved canon.
 */
export function isPodcastEntity(entity: SovereignAtomicEntity): entity is PodcastEntity {
  return entity.entityType === 'PODCAST_NETWORK' && entity.templateId.startsWith(TEMPLATE_PREFIX.PODCAST);
}

export function isPublishingEntity(entity: SovereignAtomicEntity): entity is PublishingEntity {
  return (
    entity.entityType === 'LITERARY_WORK' &&
    [...TEMPLATE_PREFIX.PUBLISHING_FACTORY, ...TEMPLATE_PREFIX.PUBLISHING_SECTOR].some(
      (prefix) => entity.templateId.startsWith(prefix),
    )
  );
}

/**
 * The five generation-4 expansion guards (2026-09-22) — class AND prefix,
 * fail-closed, exactly like the six above. Required by the serving route: a
 * class without a guard cannot be served at all (the route 502s on a
 * guard-failed entity), so the guards ship WITH the classes.
 */
export function isAthleteContractEntity(entity: SovereignAtomicEntity): entity is AthleteContractEntity {
  return (
    entity.entityType === 'ATHLETE_CONTRACT' &&
    [TEMPLATE_PREFIX.SPORTS, TEMPLATE_PREFIX.ATHLETICS].some((prefix) =>
      entity.templateId.startsWith(prefix),
    )
  );
}

export function isTournamentEventEntity(entity: SovereignAtomicEntity): entity is TournamentEventEntity {
  return (
    entity.entityType === 'TOURNAMENT_EVENT' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.TOURNAMENT)
  );
}

export function isEsportsStreamEntity(entity: SovereignAtomicEntity): entity is EsportsStreamEntity {
  return (
    entity.entityType === 'ESPORTS_STREAM' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.ESPORTS)
  );
}

export function isSocialChannelEntity(entity: SovereignAtomicEntity): entity is SocialChannelEntity {
  return (
    entity.entityType === 'SOCIAL_CHANNEL' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.SOCIAL)
  );
}

export function isSponsorshipDealEntity(entity: SovereignAtomicEntity): entity is SponsorshipDealEntity {
  return (
    entity.entityType === 'SPONSORSHIP_DEAL' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.SPONSORSHIP)
  );
}

/**
 * The fifteen industry-completion expansion guards (2026-10-07) — class AND
 * prefix, fail-closed, exactly like every class above. Required by the
 * serving route: a class without a guard cannot be served at all (the route
 * 502s on a guard-failed entity), so the guards ship WITH the classes.
 */
export function isMotorsportCircuitEntity(entity: SovereignAtomicEntity): entity is MotorsportCircuitEntity {
  return (
    entity.entityType === 'MOTORSPORT_CIRCUIT' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.MOTORSPORT)
  );
}

export function isArenaOperatorEntity(entity: SovereignAtomicEntity): entity is ArenaOperatorEntity {
  return (
    entity.entityType === 'ARENA_OPERATOR' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.ARENA)
  );
}

export function isMovieStudioEntity(entity: SovereignAtomicEntity): entity is MovieStudioEntity {
  return (
    entity.entityType === 'MOVIE_STUDIO' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.MOVIES)
  );
}

export function isVideoPlatformEntity(entity: SovereignAtomicEntity): entity is VideoPlatformEntity {
  return (
    entity.entityType === 'VIDEO_PLATFORM' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.VIDEO)
  );
}

export function isStreamingServiceEntity(entity: SovereignAtomicEntity): entity is StreamingServiceEntity {
  return (
    entity.entityType === 'STREAMING_SERVICE' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.STREAMING)
  );
}

export function isGamingStudioEntity(entity: SovereignAtomicEntity): entity is GamingStudioEntity {
  return (
    entity.entityType === 'GAMING_STUDIO' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.GAMING)
  );
}

export function isInteractiveExperienceEntity(entity: SovereignAtomicEntity): entity is InteractiveExperienceEntity {
  return (
    entity.entityType === 'INTERACTIVE_EXPERIENCE' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.INTERACTIVE)
  );
}

export function isSoftwareLicenseEntity(entity: SovereignAtomicEntity): entity is SoftwareLicenseEntity {
  return (
    entity.entityType === 'SOFTWARE_LICENSE' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.SOFTWARE)
  );
}

export function isDigitalAssetVaultEntity(entity: SovereignAtomicEntity): entity is DigitalAssetVaultEntity {
  return (
    entity.entityType === 'DIGITAL_ASSET_VAULT' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.DIGITAL_ASSETS)
  );
}

export function isFashionHouseEntity(entity: SovereignAtomicEntity): entity is FashionHouseEntity {
  return (
    entity.entityType === 'FASHION_HOUSE' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.FASHION)
  );
}

export function isModelingAgencyEntity(entity: SovereignAtomicEntity): entity is ModelingAgencyEntity {
  return (
    entity.entityType === 'MODELING_AGENCY' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.MODELING)
  );
}

export function isCadAssetStoreEntity(entity: SovereignAtomicEntity): entity is CadAssetStoreEntity {
  return (
    entity.entityType === 'CAD_ASSET_STORE' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.CAD)
  );
}

export function isVisualArtsStudioEntity(entity: SovereignAtomicEntity): entity is VisualArtsStudioEntity {
  return (
    entity.entityType === 'VISUAL_ARTS_STUDIO' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.VISUAL_ARTS)
  );
}

export function isDesignPracticeEntity(entity: SovereignAtomicEntity): entity is DesignPracticeEntity {
  return (
    entity.entityType === 'DESIGN_PRACTICE' &&
    entity.templateId.startsWith(TEMPLATE_PREFIX.DESIGN)
  );
}

export function isVirtualAvatarCreatorEntity(entity: SovereignAtomicEntity): entity is VirtualAvatarCreatorEntity {
  return (
    entity.entityType === 'VIRTUAL_AVATAR_CREATOR' &&
    [TEMPLATE_PREFIX.VTUBING, TEMPLATE_PREFIX.VIRTUAL_AVATARS].some((prefix) =>
      entity.templateId.startsWith(prefix),
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD REGISTRY (Universal Execution Lane expansion, 2026-09-20): EVERY
// atomic sector — the founder's 26 plus the three generation-4 expansion
// sectors — and every factory vertical gets a guard binding
// entityType↔templateId. Sectors whose canon carries an SDK entity class bind
// that class; sectors without one bind `null` — the guard then requires the
// record to claim NO entity class (its telemetryMetric display is the canon,
// never a force-fitted class; new classes come only from founder drops).
//
// This module stays PURE CANON: the registry's sector keys are string
// literals here, and the master store's integrity gate asserts the registry
// covers the taxonomy's 29 sectors and 6 factory verticals exactly.
// ─────────────────────────────────────────────────────────────────────────────

/** One guard binding — a sector's template-id prefix canon and entity class. */
export interface SectorGuardBinding {
  readonly guardId: string;
  /** The AtomicSector name (asserted against the taxonomy by the master store). */
  readonly sector: string;
  /** Every template-id prefix the sector's records may carry. */
  readonly prefixes: readonly string[];
  /** The bound entity class; null when the sector is telemetryMetric-only. */
  readonly entityType: AtomicEntityTypeName | null;
}

/** The 29 atomic-sector guard bindings — one per sector, no sector left out. */
export const ATOMIC_SECTOR_GUARDS: readonly SectorGuardBinding[] = Object.freeze([
  { guardId: 'GUARD-SECTOR-MUSIC', sector: 'MUSIC', prefixes: ['TPL-MUS-'], entityType: 'MASTER_RECORDING' },
  { guardId: 'GUARD-SECTOR-GAMING', sector: 'GAMING', prefixes: ['TPL-GAM-'], entityType: 'GAMING_STUDIO' },
  { guardId: 'GUARD-SECTOR-ESPORTS', sector: 'ESPORTS', prefixes: ['TPL-ESX-'], entityType: 'ESPORTS_STREAM' },
  { guardId: 'GUARD-SECTOR-INTERACTIVE', sector: 'INTERACTIVE', prefixes: ['TPL-IXP-'], entityType: 'INTERACTIVE_EXPERIENCE' },
  { guardId: 'GUARD-SECTOR-PODCASTING', sector: 'PODCASTING', prefixes: ['TPL-PDC-'], entityType: 'PODCAST_NETWORK' },
  { guardId: 'GUARD-SECTOR-STREAMING', sector: 'STREAMING', prefixes: ['TPL-STR-'], entityType: 'STREAMING_SERVICE' },
  { guardId: 'GUARD-SECTOR-SOCIAL_MEDIA', sector: 'SOCIAL_MEDIA', prefixes: ['TPL-SOC-'], entityType: 'SOCIAL_CHANNEL' },
  { guardId: 'GUARD-SECTOR-PUBLISHING', sector: 'PUBLISHING', prefixes: ['TPL-PUB-'], entityType: 'LITERARY_WORK' },
  { guardId: 'GUARD-SECTOR-MOVIES', sector: 'MOVIES', prefixes: ['TPL-MOV-'], entityType: 'MOVIE_STUDIO' },
  { guardId: 'GUARD-SECTOR-FILM', sector: 'FILM', prefixes: ['TPL-FLM-'], entityType: 'FEATURE_FILM' },
  { guardId: 'GUARD-SECTOR-TV', sector: 'TV', prefixes: ['TPL-TV-'], entityType: 'LINEAR_TV' },
  { guardId: 'GUARD-SECTOR-VIDEO', sector: 'VIDEO', prefixes: ['TPL-VID-'], entityType: 'VIDEO_PLATFORM' },
  { guardId: 'GUARD-SECTOR-SPORTS', sector: 'SPORTS', prefixes: ['TPL-SPT-'], entityType: 'ATHLETE_CONTRACT' },
  { guardId: 'GUARD-SECTOR-MOTORSPORT', sector: 'MOTORSPORT', prefixes: ['TPL-MTR-'], entityType: 'MOTORSPORT_CIRCUIT' },
  { guardId: 'GUARD-SECTOR-ARENA', sector: 'ARENA', prefixes: ['TPL-ARN-'], entityType: 'ARENA_OPERATOR' },
  { guardId: 'GUARD-SECTOR-ATHLETICS', sector: 'ATHLETICS', prefixes: ['TPL-ATH-'], entityType: 'ATHLETE_CONTRACT' },
  {
    guardId: 'GUARD-SECTOR-SPORTS_AND_ATHLETICS',
    sector: 'SPORTS_AND_ATHLETICS',
    prefixes: ['TPL-TRN-'],
    entityType: 'TOURNAMENT_EVENT',
  },
  { guardId: 'GUARD-SECTOR-FASHION', sector: 'FASHION', prefixes: ['TPL-FSH-'], entityType: 'FASHION_HOUSE' },
  { guardId: 'GUARD-SECTOR-MODELING', sector: 'MODELING', prefixes: ['TPL-MDL-'], entityType: 'MODELING_AGENCY' },
  { guardId: 'GUARD-SECTOR-CAD', sector: 'CAD', prefixes: ['TPL-CAD-'], entityType: 'CAD_ASSET_STORE' },
  { guardId: 'GUARD-SECTOR-VISUAL_ARTS', sector: 'VISUAL_ARTS', prefixes: ['TPL-VIS-'], entityType: 'VISUAL_ARTS_STUDIO' },
  { guardId: 'GUARD-SECTOR-DESIGN', sector: 'DESIGN', prefixes: ['TPL-DES-'], entityType: 'DESIGN_PRACTICE' },
  {
    guardId: 'GUARD-SECTOR-SPONSORSHIP',
    sector: 'SPONSORSHIP',
    prefixes: ['TPL-SPN-'],
    entityType: 'SPONSORSHIP_DEAL',
  },
  { guardId: 'GUARD-SECTOR-BOOKS', sector: 'BOOKS', prefixes: ['TPL-BOK-'], entityType: 'LITERARY_WORK' },
  { guardId: 'GUARD-SECTOR-LITERATURE', sector: 'LITERATURE', prefixes: ['TPL-LTR-'], entityType: 'LITERARY_WORK' },
  { guardId: 'GUARD-SECTOR-DIGITAL_ASSETS', sector: 'DIGITAL_ASSETS', prefixes: ['TPL-DGA-'], entityType: 'DIGITAL_ASSET_VAULT' },
  { guardId: 'GUARD-SECTOR-SOFTWARE', sector: 'SOFTWARE', prefixes: ['TPL-SFT-'], entityType: 'SOFTWARE_LICENSE' },
  { guardId: 'GUARD-SECTOR-VTUBING', sector: 'VTUBING', prefixes: ['TPL-VTB-'], entityType: 'VIRTUAL_AVATAR_CREATOR' },
  { guardId: 'GUARD-SECTOR-VIRTUAL_AVATARS', sector: 'VIRTUAL_AVATARS', prefixes: ['TPL-VAV-'], entityType: 'VIRTUAL_AVATAR_CREATOR' },
]);

/** The 6 factory-vertical guard bindings — every factory template is covered. */
export const FACTORY_VERTICAL_GUARDS: readonly SectorGuardBinding[] = Object.freeze([
  { guardId: 'GUARD-FACTORY-AUDIO_SOUND', sector: 'AUDIO_SOUND', prefixes: ['TPL-AUD-'], entityType: null },
  { guardId: 'GUARD-FACTORY-FILM_TV', sector: 'FILM_TV', prefixes: ['TPL-FLM-'], entityType: 'FEATURE_FILM' },
  {
    guardId: 'GUARD-FACTORY-PUBLISHING',
    sector: 'PUBLISHING',
    // The factory PUBLISHING vertical's own ids (TPL-PUB- is the atomic
    // PUBLISHING sector's prefix, guarded by GUARD-SECTOR-PUBLISHING).
    prefixes: ['TPL-LIT-'],
    entityType: 'LITERARY_WORK',
  },
  { guardId: 'GUARD-FACTORY-LIVE_COMEDY', sector: 'LIVE_COMEDY', prefixes: ['TPL-LVE-'], entityType: 'STAGE_PERFORMANCE' },
  { guardId: 'GUARD-FACTORY-INTERACTIVE', sector: 'INTERACTIVE', prefixes: ['TPL-INT-'], entityType: null },
  { guardId: 'GUARD-FACTORY-BRAND_LICENSING', sector: 'BRAND_LICENSING', prefixes: ['TPL-BRD-'], entityType: null },
]);

/** One guard verdict — structured, so every verdict is VISIBLE in the payload. */
export interface GuardVerdict {
  readonly guardId: string;
  /** ENTITY_BINDING: the class↔prefix pairing. CROSS_DOMAIN: the sector pair. */
  readonly kind: 'ENTITY_BINDING' | 'CROSS_DOMAIN';
  /** One sector for entity bindings, a `SOURCE → TARGET` pair for cross-domain. */
  readonly sectorPair: string;
  readonly allowed: boolean;
  readonly reason: string;
}

/** The claim a record makes — its template id and (optionally) an entity class. */
export interface GuardClaimInput {
  readonly templateId: string;
  readonly entityType: AtomicEntityTypeName | null;
}

/**
 * Evaluate ONE binding: the template id must carry the binding's prefix canon
 * AND the claimed entity class must be exactly the bound class (a null bound
 * class demands a null claim — telemetryMetric-only sectors bind no entity).
 * Fail-closed: any mismatch blocks, and a blocked verdict never serves an
 * execution.
 */
export function evaluateGuardBinding(binding: SectorGuardBinding, claim: GuardClaimInput): GuardVerdict {
  const prefixMatch = binding.prefixes.some((prefix) => claim.templateId.startsWith(prefix));
  const entityMatch = claim.entityType === binding.entityType;
  if (prefixMatch && entityMatch) {
    return {
      guardId: binding.guardId,
      kind: 'ENTITY_BINDING',
      sectorPair: binding.sector,
      allowed: true,
      reason:
        binding.entityType === null
          ? `${binding.sector} record carries the ${binding.prefixes.join('/')} prefix and claims no entity class (telemetryMetric canon)`
          : `${binding.sector} record carries the ${binding.prefixes.join('/')} prefix and the bound ${binding.entityType} class`,
    };
  }
  const reason = !prefixMatch
    ? `Blocked: ${claim.templateId} carries none of the ${binding.sector} prefix canon (${binding.prefixes.join(', ')})`
    : `Blocked: ${claim.templateId} claims ${claim.entityType ?? 'no entity class'} but the ${binding.sector} binding requires ${binding.entityType ?? 'no entity class'}`;
  return { guardId: binding.guardId, kind: 'ENTITY_BINDING', sectorPair: binding.sector, allowed: false, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-DOMAIN BINDING — fail closed. A binding inside ONE sector is always
// allowed; a cross-sector pair is allowed ONLY through an entry in the
// founder-owned allowlist below. The registry ships EMPTY: the default
// posture is deny, and no pairing is granted by inference. The allowlist is
// FOUNDER-OWNED — entries land only on the founder's explicit direction, in
// the form { sourceSector, targetSector, note }.
// ─────────────────────────────────────────────────────────────────────────────

/** One founder-owned allowlist entry — an allowed cross-sector pair. */
export interface CrossDomainBindingPair {
  readonly sourceSector: string;
  readonly targetSector: string;
  /** The founder's note for the grant — who asked for it and when. */
  readonly note: string;
}

/** FOUNDER-OWNED — default empty: cross-sector bindings fail closed. */
export const CROSS_DOMAIN_BINDING_ALLOWLIST: readonly CrossDomainBindingPair[] = Object.freeze([]);

/**
 * The pure allowlist evaluator (the registry version below just supplies the
 * founder-owned list). A pair passes when the two sectors are the SAME, or
 * when the allowlist carries the pair in either direction.
 */
export function evaluateCrossDomainBindingWithAllowlist(
  allowlist: readonly CrossDomainBindingPair[],
  sourceSector: string,
  targetSector: string,
): GuardVerdict {
  const sectorPair = `${sourceSector} → ${targetSector}`;
  if (sourceSector === targetSector) {
    return {
      guardId: 'GUARD-CROSS-DOMAIN',
      kind: 'CROSS_DOMAIN',
      sectorPair,
      allowed: true,
      reason: `Same-sector binding (${sourceSector}) — always allowed`,
    };
  }
  const entry = allowlist.find(
    (pair) =>
      (pair.sourceSector === sourceSector && pair.targetSector === targetSector) ||
      (pair.sourceSector === targetSector && pair.targetSector === sourceSector),
  );
  if (entry) {
    return {
      guardId: 'GUARD-CROSS-DOMAIN',
      kind: 'CROSS_DOMAIN',
      sectorPair,
      allowed: true,
      reason: `Founder-owned allowlist entry grants this pair: ${entry.note}`,
    };
  }
  return {
    guardId: 'GUARD-CROSS-DOMAIN',
    kind: 'CROSS_DOMAIN',
    sectorPair,
    allowed: false,
    reason: 'Fail closed: cross-sector bindings are allowed only through the founder-owned CROSS_DOMAIN_BINDING_ALLOWLIST (default empty)',
  };
}

/** The registry path the lane and the execute route run. */
export function evaluateCrossDomainBinding(sourceSector: string, targetSector: string): GuardVerdict {
  return evaluateCrossDomainBindingWithAllowlist(CROSS_DOMAIN_BINDING_ALLOWLIST, sourceSector, targetSector);
}

/**
 * The Universal Execution Lane's canon pool buckets — the 50/35/15 structure
 * as integer BPS of the whole 10,000. The reconciler in executionLane.ts
 * enforces these weights engine-side (integer math, dust to the operations
 * yield per the Don dust canon); no payload can exist off this structure.
 */
export const LANE_POOL_ORDER = ['OWNERSHIP_RESERVE', 'CREATIVE_PAYOUT', 'OPERATIONS_YIELD'] as const;
export type LanePoolName = (typeof LANE_POOL_ORDER)[number];

export const LANE_POOL_BPS: Record<LanePoolName, number> = Object.freeze({
  OWNERSHIP_RESERVE: 5_000,
  CREATIVE_PAYOUT: 3_500,
  OPERATIONS_YIELD: 1_500,
});

export const LANE_POOL_LABELS: Record<LanePoolName, string> = Object.freeze({
  OWNERSHIP_RESERVE: 'Ownership Reserve',
  CREATIVE_PAYOUT: 'Creative Payout',
  OPERATIONS_YIELD: 'Operations Yield',
});

/** The 10,000-BPS denominator the lane reconciles every payload against. */
export const LANE_TOTAL_BPS = LANE_POOL_ORDER.reduce((sum, pool) => sum + LANE_POOL_BPS[pool], 0);
