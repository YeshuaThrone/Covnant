/**
 * Entity intelligence — the per-entity readout over the one clearing ledger
 * (2026-09-22 founder directive: "we need real analytics like the NFL would
 * have on their players"). Where `platformAnalyticsFlows` answers how money
 * flows through the PLATFORM (by industry, by flow kind, by transaction
 * type — brand-free), this module answers the questions a league, a label,
 * or an operator asks about ONE cleared atomic entity:
 *
 *   1. Performance profile — the class record's own telemetry, verbatim.
 *   2. Cleared-flow trend — the entity's journal holder credits grouped by
 *      their existing timestamps, newest point first.
 *   3. Cohort benchmark — the entity's cleared total ranked inside its
 *      atomic class (standard competition ranking: rank = 1 + the count of
 *      same-class entities with a strictly greater cleared total; ties
 *      share a rank; integer bigint end to end, never a float percentage).
 *   4. Valuation vs. production — the canon's promised value per class
 *      (athlete guarantee, sponsorship deal value, tournament purse, film
 *      theatrical escrow, stream monetization yield) beside what actually
 *      cleared through the 50/35/15 engine. A class with no promised-value
 *      field in canon (music's cleared volume is rate-driven; the TV,
 *      podcast, live, publishing, and social telemetry are per-unit rates
 *      and balances, not promised valuations) reads `null` — stated, never
 *      backfilled.
 *
 * Same derivation family as `analyticsFlows.ts` — the discipline is
 * mirrored, not shared: the journal scan, the holder-credit measure, and
 * the run resolution are re-implemented here privately so this module
 * stays a pure addition and the platform cuts' module is untouched. The
 * unanimous run resolution carries over EXACTLY: a journal's holder
 * credits count toward an entity only when the journal's split run
 * resolves, every line item binds, and every bound record is the SAME
 * entity — a mixed or unresolvable run is never force-fitted onto a
 * profile.
 *
 * Units, stated plainly: `promisedUSD` is whole USD — the canon telemetry
 * field's own unit, read as an exact bigint (every canon value is
 * integral). `cleared` and every trend credit are integer CENTS — the
 * ledger's own unit, the engine-path money. The Intelligence tab formats
 * both for display; nothing here converts between them (a cents-to-dollars
 * division would fabricate).
 *
 * Honesty law: an entity with no journals renders its profile, a zero
 * cleared total, and an empty trend (the honest zero-cleared line — the
 * component draws it; no point is invented at a fabricated timestamp); a
 * cohort of one reports rank 1 of 1; a store read that fails returns null
 * (the honest unavailable state, the same treatment as the platform cuts'
 * `unavailable`); a template id that binds no entity returns null. Nothing
 * invented, nothing averaged, no fabricated totals — and the counterparty
 * boundary holds: entity-level facts a class record legitimately carries
 * (a sponsorship deal's brandPartner) render HERE, on the entity profile;
 * the platform cuts stay brand-free (their pinned exclusion test is
 * untouched).
 */

import type { SocialEntertainmentPlatform } from '@/engine/covenant-master-sdk';
import type {
  ProTelemetryBinding,
  SovereignAtomicEntity,
} from '@/lib/master/CovnantAtomicDataSDK';
import { entityRecordForWorkRef } from '@/lib/master/masterStore';
import type { SplitRunRecord } from '@/lib/don/types';
import type { GlEntryRecord } from '@/modules/don/records';
import type { Store } from '@/lib/server/store';

// ─────────────────────────────────────────────────────────────────────────────
// The readout types — one arm per registered entity class, extended
// additively when the next entertainment form registers (the arm builder's
// exhaustiveness pin below makes a missing arm a build failure).
// ─────────────────────────────────────────────────────────────────────────────

/** The entity's cohort standing — integer bigint, standard competition ranking. */
export interface CohortRank {
  /** 1 + the count of same-class entities with a strictly greater cleared total. */
  readonly rank: bigint;
  /** The cohort size — every same-class entity the ledger ranks, the entity itself included. */
  readonly of: bigint;
}

/** One trend point — a journal timestamp of record and the credits grouped under it. */
export interface TrendPoint {
  readonly at: string;
  readonly credit: bigint;
}

export interface FilmIntelligence {
  readonly class: 'FEATURE_FILM';
  readonly templateId: string;
  readonly isanCode: string;
  readonly studioOverlayActive: boolean;
  /** The canon theatrical gross escrow — whole USD as bigint. */
  readonly promisedUSD: bigint;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface TelevisionIntelligence {
  readonly class: 'LINEAR_TV';
  readonly templateId: string;
  readonly nielsenFlightMinutes: number;
  readonly adInsertionMicroYieldUSD: number;
  readonly syndicationReversionLock: boolean;
  /** No promised-value field in canon — the honest null, stated. */
  readonly promisedUSD: null;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface MusicIntelligence {
  readonly class: 'MASTER_RECORDING';
  readonly templateId: string;
  readonly isrcCode: string;
  readonly subSecondMicroRoyaltyRate: number;
  readonly proTelemetryBinding: ProTelemetryBinding;
  /** No promised-value field in canon for cleared volume — the honest null, stated. */
  readonly promisedUSD: null;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface PodcastIntelligence {
  readonly class: 'PODCAST_NETWORK';
  readonly templateId: string;
  readonly downloadCountTelemetry: number;
  readonly dynamicAdInsertYieldUSD: number;
  readonly feedIsolationActive: boolean;
  /** No promised-value field in canon — the honest null, stated. */
  readonly promisedUSD: null;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface LivePerformanceIntelligence {
  readonly class: 'STAGE_PERFORMANCE';
  readonly templateId: string;
  readonly ticketEscrowBalanceUSD: number;
  readonly promoterInstantAllocationUSD: number;
  readonly houseSeatClearanceLock: boolean;
  /** No promised-value field in canon — the honest null, stated. */
  readonly promisedUSD: null;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface PublishingIntelligence {
  readonly class: 'LITERARY_WORK';
  readonly templateId: string;
  readonly isbnNumber: string;
  readonly printOnDemandYieldUSD: number;
  readonly citationTelemetryCount: number;
  /** No promised-value field in canon — the honest null, stated. */
  readonly promisedUSD: null;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface AthleteContractIntelligence {
  readonly class: 'ATHLETE_CONTRACT';
  readonly templateId: string;
  readonly contractId: string;
  readonly sport: string;
  readonly endorsementExclusivityLock: boolean;
  /** The canon sponsorship guarantee — whole USD as bigint. */
  readonly promisedUSD: bigint;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface TournamentEventIntelligence {
  readonly class: 'TOURNAMENT_EVENT';
  readonly templateId: string;
  readonly eventId: string;
  readonly discipline: string;
  readonly payoutReleaseLock: boolean;
  /** The canon prize purse escrow — whole USD as bigint. */
  readonly promisedUSD: bigint;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface EsportsStreamIntelligence {
  readonly class: 'ESPORTS_STREAM';
  readonly templateId: string;
  readonly streamId: string;
  readonly game: string;
  readonly clipLicensingLock: boolean;
  /** The canon stream monetization yield — whole USD as bigint. */
  readonly promisedUSD: bigint;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface SocialChannelIntelligence {
  readonly class: 'SOCIAL_CHANNEL';
  readonly templateId: string;
  readonly platform: SocialEntertainmentPlatform;
  readonly channelId: string;
  readonly contentMatchYieldUSD: number;
  readonly monetizationReviewLock: boolean;
  /** No promised-value field in canon — the honest null, stated. */
  readonly promisedUSD: null;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

export interface SponsorshipDealIntelligence {
  readonly class: 'SPONSORSHIP_DEAL';
  readonly templateId: string;
  /** Entity-level counterparty fact — belongs here, never in a platform cut. */
  readonly brandPartner: string;
  readonly campaignId: string;
  readonly activationWindowLock: boolean;
  /** The canon deal value — whole USD as bigint. */
  readonly promisedUSD: bigint;
  readonly cleared: bigint;
  readonly trend: readonly TrendPoint[];
  readonly cohort: CohortRank;
}

/**
 * The per-entity intelligence readout — the discriminated union over the
 * registered entity classes, one arm each. Every arm carries the four
 * reads: the class telemetry profile, the promised value (or the honest
 * null), the cleared holder-credit total, the timestamped trend, and the
 * cohort rank.
 */
export type EntityIntelligence =
  | FilmIntelligence
  | TelevisionIntelligence
  | MusicIntelligence
  | PodcastIntelligence
  | LivePerformanceIntelligence
  | PublishingIntelligence
  | AthleteContractIntelligence
  | TournamentEventIntelligence
  | EsportsStreamIntelligence
  | SocialChannelIntelligence
  | SponsorshipDealIntelligence;

// ─────────────────────────────────────────────────────────────────────────────
// The ledger scan — the analyticsFlows.ts treatment, mirrored privately.
// ─────────────────────────────────────────────────────────────────────────────

/** Any rights holder's vault account — `vault:<payeeId>:…` — except the platform's own dust vault. */
function isHolderVaultCredit(entry: GlEntryRecord): boolean {
  return (
    entry.account.startsWith('vault:') &&
    !entry.account.startsWith('vault:platform:') &&
    entry.credit_cents > 0
  );
}

/** The journal's holder-side vault-credit sum — the measure every read attributes. */
function holderCreditOf(entries: readonly GlEntryRecord[] | undefined): bigint {
  let holderCredit = 0n;
  for (const entry of entries ?? []) {
    if (isHolderVaultCredit(entry)) holderCredit += BigInt(entry.credit_cents);
  }
  return holderCredit;
}

/**
 * The run's bound atomic entity records — resolved when EVERY line item of
 * the run resolves (the settlement shape of record: one asset per run). A
 * run whose line items resolve to nothing contributes to no entity — its
 * money is never misattributed onto a profile.
 */
async function recordsOfRun(
  store: Store,
  run: SplitRunRecord,
): Promise<readonly SovereignAtomicEntity[] | null> {
  const lineItems = await store.listRoyaltyLineItemsByRun(run.id);
  if (lineItems.length === 0) return null;
  const records: SovereignAtomicEntity[] = [];
  for (const lineItem of lineItems) {
    const record = entityRecordForWorkRef(lineItem.work_id);
    if (record === null) return null;
    records.push(record);
  }
  return records;
}

/**
 * The run's unanimous bound entity identity — the shared template id when
 * every record IS the same entity, null when they disagree (a mixed run is
 * never force-fitted onto one profile).
 */
function unanimousEntityIdentity(records: readonly SovereignAtomicEntity[]): string | null {
  if (records.length === 0) return null;
  const identity = records[0].templateId;
  for (const record of records) {
    if (record.templateId !== identity) return null;
  }
  return identity;
}

/** The per-entity ledger scan: cleared totals and per-timestamp credits, keyed by template id. */
interface EntityCreditScan {
  readonly clearedByEntity: ReadonlyMap<string, bigint>;
  readonly creditAtByEntity: ReadonlyMap<string, ReadonlyMap<string, bigint>>;
}

async function scanEntityCredits(store: Store): Promise<EntityCreditScan> {
  const journals = (await store.listGlJournals()).filter(
    (journal) => journal.kind === 'royalty_ingest',
  );
  const entriesByJournal = new Map<string, GlEntryRecord[]>();
  for (const entry of await store.listGlEntries()) {
    const group = entriesByJournal.get(entry.journal_id);
    if (group !== undefined) group.push(entry);
    else entriesByJournal.set(entry.journal_id, [entry]);
  }
  const runOf = new Map<string, SplitRunRecord | undefined>();
  for (const journal of journals) {
    if (journal.ref_type !== 'split_run' || journal.ref_id === null) continue;
    runOf.set(journal.id, await store.getSplitRun(journal.ref_id));
  }

  const clearedByEntity = new Map<string, bigint>();
  const creditAtByEntity = new Map<string, Map<string, bigint>>();
  for (const journal of journals) {
    const run = runOf.get(journal.id);
    if (run === undefined) continue;
    const holderCredit = holderCreditOf(entriesByJournal.get(journal.id));
    if (holderCredit <= 0n) continue;
    const records = await recordsOfRun(store, run);
    if (records === null) continue;
    const identity = unanimousEntityIdentity(records);
    if (identity === null) continue;
    clearedByEntity.set(identity, (clearedByEntity.get(identity) ?? 0n) + holderCredit);
    const creditAt = creditAtByEntity.get(identity);
    if (creditAt === undefined) {
      creditAtByEntity.set(identity, new Map([[journal.created_at, holderCredit]]));
    } else {
      creditAt.set(journal.created_at, (creditAt.get(journal.created_at) ?? 0n) + holderCredit);
    }
  }
  return { clearedByEntity, creditAtByEntity };
}

/** The entity's trend — its journal credits grouped by their own timestamps, newest point first. */
function trendFrom(creditAt: ReadonlyMap<string, bigint> | undefined): readonly TrendPoint[] {
  if (creditAt === undefined) return [];
  return [...creditAt.entries()]
    .map(([at, credit]) => ({ at, credit }))
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// The arm builder — the compile-time exhaustiveness pin. A newly registered
// entity class without an arm fails the build here (the flowKinds.ts
// pattern family), and the throw beneath it is the runtime fail-closed twin.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canon USD telemetry fields are whole-dollar integers (every seed value
 * of record is integral) — the bigint read is exact. Nothing here touches
 * cents: the ledger's cleared credits stay in their own integer-cent unit.
 */
function promisedUSDFrom(usd: number): bigint {
  return BigInt(Math.round(usd));
}

function intelligenceArm(
  entity: SovereignAtomicEntity,
  cleared: bigint,
  trend: readonly TrendPoint[],
  cohort: CohortRank,
): EntityIntelligence {
  switch (entity.entityType) {
    case 'FEATURE_FILM':
      return {
        class: 'FEATURE_FILM',
        templateId: entity.templateId,
        isanCode: entity.isanCode,
        studioOverlayActive: entity.studioOverlayActive,
        promisedUSD: promisedUSDFrom(entity.theatricalGrossEscrowUSD),
        cleared,
        trend,
        cohort,
      };
    case 'LINEAR_TV':
      return {
        class: 'LINEAR_TV',
        templateId: entity.templateId,
        nielsenFlightMinutes: entity.nielsenFlightMinutes,
        adInsertionMicroYieldUSD: entity.adInsertionMicroYieldUSD,
        syndicationReversionLock: entity.syndicationReversionLock,
        promisedUSD: null,
        cleared,
        trend,
        cohort,
      };
    case 'MASTER_RECORDING':
      return {
        class: 'MASTER_RECORDING',
        templateId: entity.templateId,
        isrcCode: entity.isrcCode,
        subSecondMicroRoyaltyRate: entity.subSecondMicroRoyaltyRate,
        proTelemetryBinding: entity.proTelemetryBinding,
        promisedUSD: null,
        cleared,
        trend,
        cohort,
      };
    case 'PODCAST_NETWORK':
      return {
        class: 'PODCAST_NETWORK',
        templateId: entity.templateId,
        downloadCountTelemetry: entity.downloadCountTelemetry,
        dynamicAdInsertYieldUSD: entity.dynamicAdInsertYieldUSD,
        feedIsolationActive: entity.feedIsolationActive,
        promisedUSD: null,
        cleared,
        trend,
        cohort,
      };
    case 'STAGE_PERFORMANCE':
      return {
        class: 'STAGE_PERFORMANCE',
        templateId: entity.templateId,
        ticketEscrowBalanceUSD: entity.ticketEscrowBalanceUSD,
        promoterInstantAllocationUSD: entity.promoterInstantAllocationUSD,
        houseSeatClearanceLock: entity.houseSeatClearanceLock,
        promisedUSD: null,
        cleared,
        trend,
        cohort,
      };
    case 'LITERARY_WORK':
      return {
        class: 'LITERARY_WORK',
        templateId: entity.templateId,
        isbnNumber: entity.isbnNumber,
        printOnDemandYieldUSD: entity.printOnDemandYieldUSD,
        citationTelemetryCount: entity.citationTelemetryCount,
        promisedUSD: null,
        cleared,
        trend,
        cohort,
      };
    case 'ATHLETE_CONTRACT':
      return {
        class: 'ATHLETE_CONTRACT',
        templateId: entity.templateId,
        contractId: entity.contractId,
        sport: entity.sport,
        endorsementExclusivityLock: entity.endorsementExclusivityLock,
        promisedUSD: promisedUSDFrom(entity.sponsorshipGuaranteeUSD),
        cleared,
        trend,
        cohort,
      };
    case 'TOURNAMENT_EVENT':
      return {
        class: 'TOURNAMENT_EVENT',
        templateId: entity.templateId,
        eventId: entity.eventId,
        discipline: entity.discipline,
        payoutReleaseLock: entity.payoutReleaseLock,
        promisedUSD: promisedUSDFrom(entity.prizePurseEscrowUSD),
        cleared,
        trend,
        cohort,
      };
    case 'ESPORTS_STREAM':
      return {
        class: 'ESPORTS_STREAM',
        templateId: entity.templateId,
        streamId: entity.streamId,
        game: entity.game,
        clipLicensingLock: entity.clipLicensingLock,
        promisedUSD: promisedUSDFrom(entity.streamMonetizationYieldUSD),
        cleared,
        trend,
        cohort,
      };
    case 'SOCIAL_CHANNEL':
      return {
        class: 'SOCIAL_CHANNEL',
        templateId: entity.templateId,
        platform: entity.platform,
        channelId: entity.channelId,
        contentMatchYieldUSD: entity.contentMatchYieldUSD,
        monetizationReviewLock: entity.monetizationReviewLock,
        promisedUSD: null,
        cleared,
        trend,
        cohort,
      };
    case 'SPONSORSHIP_DEAL':
      return {
        class: 'SPONSORSHIP_DEAL',
        templateId: entity.templateId,
        brandPartner: entity.brandPartner,
        campaignId: entity.campaignId,
        activationWindowLock: entity.activationWindowLock,
        promisedUSD: promisedUSDFrom(entity.dealValueUSD),
        cleared,
        trend,
        cohort,
      };
    default: {
      // A newly registered class lands HERE at compile time — the build
      // fails until an arm exists. The throw is the runtime fail-closed
      // twin: never a silent blank.
      const unregistered: never = entity;
      throw new Error(`entityIntelligence: no intelligence arm for ${String(unregistered)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-entity intelligence readout — the four reads over one cleared
 * atomic entity. Never throws: a store failure degrades to the honest
 * `null` (the unavailable state), as does a template id that binds no
 * entity. An entity the ledger has never credited still renders — its
 * profile, a zero cleared total, an empty trend, and its honest cohort
 * rank (1 of 1 when it is alone in its class).
 */
export async function entityIntelligence(
  templateId: string,
  store: Store,
): Promise<EntityIntelligence | null> {
  const entity = entityRecordForWorkRef(templateId);
  if (entity === null) return null;

  let scan: EntityCreditScan;
  try {
    scan = await scanEntityCredits(store);
  } catch {
    return null;
  }

  const identity = entity.templateId;
  const cleared = scan.clearedByEntity.get(identity) ?? 0n;
  const trend = trendFrom(scan.creditAtByEntity.get(identity));

  // The cohort — the entity against its own atomic class: every same-class
  // entity the ledger credits, plus the entity itself (at its own total,
  // zero when the ledger never credited it). The SPORTS industry tag groups
  // two classes; the cohort does NOT — this athlete ranks against athletes,
  // never against the tournament form.
  const cohortTotals = new Map<string, bigint>();
  for (const [otherId, otherTotal] of scan.clearedByEntity) {
    const other = entityRecordForWorkRef(otherId);
    if (other === null || other.entityType !== entity.entityType) continue;
    cohortTotals.set(otherId, otherTotal);
  }
  cohortTotals.set(identity, cleared);
  let rank = 1n;
  for (const [otherId, otherTotal] of cohortTotals) {
    if (otherId !== identity && otherTotal > cleared) rank += 1n;
  }

  return intelligenceArm(entity, cleared, trend, { rank, of: BigInt(cohortTotals.size) });
}
