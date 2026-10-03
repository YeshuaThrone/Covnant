/**
 * The Don Engine persistence seam — the one file the integration is allowed
 * to design (spec art_zxsnGP3A, "The one deviation"). Every engine file
 * (split math, withholding, vault arithmetic, GL chain, webhook ingestion)
 * is Cursor source copied verbatim; only this seam is ours.
 *
 * PROVENANCE. The contract below is Cursor's canonical store body
 * (src/lib/server/store.ts, FILE 3 — 72-method `Store`, SQLite SCHEMA,
 * `SqliteStore`, `getStore()`/`setStore()` singleton), reconciled on
 * arrival. Two deliberate deviations from the canonical file, both spec
 * decisions:
 *
 * 1. ASYNC METHODS. Canonical `Store` is synchronous because SqliteStore
 *    does synchronous file IO. Production persistence is Supabase
 *    (supabase-js is HTTP-bound and inherently async), so every method
 *    here is the canonical signature Promise-wrapped. Engine call sites
 *    are awaited at wiring time.
 * 2. NO SQLITE IN PRODUCTION. `SqliteStore` is not shipped: the canonical
 *    class (backed by better-sqlite3) remains the LOCAL-DEV alternative —
 *    bootable behind `setStore()` for scripts and self-hosted deployments
 *    if that reversal ever lands. Nothing imports better-sqlite3, so the
 *    native dependency is intentionally absent from package.json. The
 *    canonical SQLite SCHEMA it would use is translated to PostgreSQL by
 *    supabase/migrations/0006_don_engine.sql — the authoritative mapping
 *    for every table and column below.
 *
 * Method names, argument shapes, and defaults are canonical. The only
 * types not present in any drop are `ValidShowPayload` and
 * `ValidLivePingPayload` — the canonical file imports them from
 * `@/lib/validation`, whose legacy show/ping validators have not arrived
 * (the validation drop received is the Don validators, now at
 * src/lib/don/validation.ts). They are defined here from the canonical
 * SCHEMA's own columns and reconciled at wiring time.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { TerritorySettlementRecord } from '@/lib/server/territorySettlement';
import type {
  BaasTransferRecord,
  KycVerificationRecord,
  LedgerTransactionRecord,
  PlaidLinkTokenRecord,
  RoyaltyLineItemRecord,
  SplitRunRecord,
} from '@/lib/don/types';
import type {
  BaasWebhookEventRecord,
  CatalogDisputeRecord,
  CompanyDustRecord,
  CreatorTaxProfile,
  CreatorYtdEarnings,
  DspWebhookEventRecord,
  GlEntryRecord,
  GlJournalRecord,
  PayoutHoldRecord,
  PayoutReversalRecord,
  PlaidProcessorTokenRecord,
  RecoupmentAdvanceRecord,
  RecoupmentLedgerRecord,
  SovereignVaultRecord,
  SplitReversalRecord,
  TaxEscrowRecord,
  VaultDisputeRecord,
} from '@/modules/don/records';
import type {
  FilmWaterfallDefinitionRecord,
  FilmWaterfallDistributionRecord,
  FilmTerritoryWithholdingRecord,
  FilmTerritoryDistributionRecord,
  GamingDevexConversionLogRecord,
  GamingEngineRoyaltyEventRecord,
  GamingItemSplitScheduleRecord,
  GamingSplitPayoutRecord,
  GamingStudioKycRecord,
  PodcastEpisodeSplitAccrualRecord,
  PodcastEpisodeSplitScheduleRecord,
  PodcastGuestBonusAccrualRecord,
  PodcastGuestBonusDefinitionRecord,
  VtuberTaxWithholdingVerificationRecord,
  VtuberTechSetupAmortizationLineRecord,
  VtuberTechSetupAmortizationScheduleRecord,
  DerivativeRoyaltyEdgeRecord,
  SampleClearanceEdgeRecord,
  CompositionPublisherRecord,
  WebtoonStudioSplitRoleRecord,
  WebtoonLocalizationContractRecord,
  WebtoonLocalizationCostScheduleRecord,
  WebtoonLocalizationCostLineRecord,
  WebtoonRecoupmentPoolRecord,
  WebtoonRecoupmentPoolClass,
  WebtoonRecoupmentApplicationRecord,
  BookEditorialSplitScheduleRecord,
  BookRecoupmentPoolRecord,
  BookRecoupmentPoolClass,
  BookRecoupmentApplicationRecord,
  BookEditorialSplitAccrualRecord,
  ArtRecoupmentPoolRecord,
  ArtRecoupmentPoolClass,
  ArtRecoupmentApplicationRecord,
  ArtSplitScheduleRecord,
  ArtSplitAccrualRecord,
  ArtLicensingAgencyPolicyRecord,
  EstateSuccessionCertificateRecord,
  EstateHeirScheduleRecord,
  EstateSuccessionTransitionRecord,
  EstateSplitAccrualRecord,
  EstatePayoutGateStateRecord,
  TheatricalProductionDealRecord,
  TheatricalStopSettlementRecord,
  TheatricalRecoupmentApplicationRecord,
  TheatricalSplitAccrualRecord,
  PromoterSettlementAuditRecord,
  TheatricalPayoutGateStateRecord,
  VenueHallFeePolicyRecord,
  IpOptionAgreementRecord,
  IpOptionAuthorAllocationRecord,
  PublishingIpRightsVerificationRecord,
  MerchCogsLotRecord,
  MerchCogsConsumptionRecord,
  MerchCollabAgreementRecord,
  MerchCollabPoolClass,
  MerchCollabRecoupmentApplicationRecord,
  MerchDesignerRoyaltyTierRecord,
  MerchReturnReservePolicyRecord,
  MerchReserveDrawdownRecord,
  MerchFulfillmentTrackingRecord,
  MerchDesignerRoyaltyBillingRecord,
  MerchConsignmentSettlementRecord,
  WithholdingTaxCreditVerificationRecord,
  IsbnRightsVerificationRecord,
  BookReturnsReservePolicyRecord,
  BookReserveDrawdownRecord,
  BookReturnChargebackRecord,
  BookChargebackOffsetApplicationRecord,
  AiModelSplitTermsRecord,
  AiModelContributionRecord,
  AiTrainingDisputeRecord,
  AiTrainingDisputeStatus,
  AiPayoutGateStateRecord,
  AiDatasetDeprecationRecord,
  AiDatasetAllocationArchiveRecord,
} from '@/modules/don/records';
import type {
  LicensingAuditReserveDrawdownClass,
  LicensingAuditReserveDrawdownRecord,
  LicensingAuditReservePolicyRecord,
  LicensingAuditReserveReconciliationRecord,
  LicensingCategoryExclusivityGateState,
  LicensingMgCommitmentRecord,
  LicensingMgRecoupmentApplicationRecord,
  LicensingMgTermCloseRecord,
  LicensingPayoutGateStateRecord,
  LicensingRoyaltyDealRecord,
  LicensingRoyaltyApplicationRecord,
  LicensingTerritoryGateState,
  LicensingTreatyRateRecord,
  LicensingSubLicenseeRecord,
  LicensingSubLicenseReportRecord,
} from '@/modules/licensing/records';
import type {
  NilAuditEscrowDrawdownRecord,
  NilAuditEscrowPolicyRecord,
  NilAuditEscrowReconciliationRecord,
  NilAdvanceScheduleRecord,
  NilCapVerificationRecord,
  NilDealComplianceAuditRecord,
  NilGroupSplitRecord,
  NilPayoutApplicationRecord,
  NilPayoutGateStateRecord,
  NilPoolApplicationRecord,
  NilRevenueShareProgramRecord,
  NilRosterWaterfallRecord,
  NilSchoolCapRecord,
  NilStateRuleRecord,
  NilTransferPortalEntryRecord,
  NilUnearnedClawbackRecord,
} from '@/modules/nil/records';
import type {
  SpatialAuditEscrowDrawdownRecord,
  SpatialAuditEscrowPolicyRecord,
  SpatialAuditEscrowReconciliationRecord,
  SpatialCapexApplicationRecord,
  SpatialCapexCommitmentRecord,
  SpatialMicroPolicyRecord,
  SpatialMicroRoyaltyRecord,
  SpatialMsgCommitmentRecord,
  SpatialMsgTermCloseRecord,
  SpatialOccupancyTierScheduleRecord,
  SpatialOverheadPolicyRecord,
  SpatialPopupExperienceRecord,
  SpatialPopupRestorationReserveRecord,
  SpatialPopupWriteoffRecord,
  SpatialPayoutGateStateRecord,
  SpatialRoyaltyApplicationRecord,
  SpatialThroughputYearRecord,
  SpatialZoneAllocationRecord,
  SpatialZoneAssignmentRecord,
} from '@/modules/spatial/records';
import type {
  FitnessAlgorithmPolicyRecord,
  FitnessAlgorithmRoyaltyRecord,
  FitnessAuditEscrowDrawdownRecord,
  FitnessAuditEscrowPolicyRecord,
  FitnessAuditEscrowReconciliationRecord,
  FitnessCoBrandPartnershipRecord,
  FitnessCocreationModuleRecord,
  FitnessCocreationApplicationRecord,
  FitnessCompletionMonthRecord,
  FitnessFranchiseApplicationRecord,
  FitnessFranchiseClassMonthRecord,
  FitnessFranchisePolicyRecord,
  FitnessCobrandSplitApplicationRecord,
  FitnessLiveEventBonusPolicyRecord,
  FitnessLiveEventBonusRecord,
  FitnessLiveLoadPolicyRecord,
  FitnessLiveResidualApplicationRecord,
  FitnessPayoutGateStateRecord,
  FitnessRealizationApplicationRecord,
  FitnessSyncMusicPolicyRecord,
  FitnessTrainerRoyaltyApplicationRecord,
  FitnessTrainerTierScheduleRecord,
} from '@/modules/fitness/records';
import type {
  FoodCobrandSplitApplicationRecord,
  FoodCobrandWeightingRecord,
  FoodCookCyclePolicyRecord,
  FoodCookCycleRoyaltyRecord,
  FoodHostOperatorPolicyRecord,
  FoodHostOperatorSplitApplicationRecord,
  FoodLocationUnitMonthRecord,
  FoodOperatorWaterfallRecord,
  FoodRealizationApplicationRecord,
  FoodRecipeRoyaltyApplicationRecord,
  FoodRecipeRoyaltyScheduleRecord,
  FoodSupplierRebateApplicationRecord,
} from '@/modules/food/records';
import type {
  MatchQueueRecord,
  MatchQueueResolution,
  MulClearanceRecord,
  MulClearanceTransitionRecord,
  StatementIngestRecord,
  SyncCatalogItemRecord,
  SyncLicensePurchaseRecord,
} from '@/modules/sdk/records';
import type { AdminActionRecord } from '@/lib/admin/actionLog';
import type {
  ReconJobInput,
  ReconJobResult,
  RoyaltyReconJobRecord,
} from '@/modules/recon/records';
import type {
  DistributorConnectionInput,
  DistributorConnectionRecord,
  DistributorConnectionUpsert,
  DistributorTraversalOutcome,
} from '@/modules/vault/records';
import {
  createAdminClient as createSupabaseAdminClient,
  readSupabaseEnv,
} from '@/lib/server/supabase';
import { SupabaseStore } from '@/lib/server/supabaseStore';

// ---------------------------------------------------------------------------
// Legacy ATXLive surface types — ShowRecord/LivePingRecord/ArtistRecord/
// CheckoutPurchaseResult are verbatim from the canonical file.
// ---------------------------------------------------------------------------

/**
 * The validated show wire payload. Schema-derived (canonical SCHEMA `shows`
 * columns) — Cursor's legacy validator has not been dropped; reconcile when
 * it arrives.
 */
export type ValidShowPayload = {
  artist_id: string;
  artist_name: string;
  venue_name: string;
  district: string;
  set_time: string;
  created_at: string;
  ticketing_type?: string;
  ticket_url?: string;
  address?: string;
  council_district?: string;
  native_ticket_price?: number | null;
  native_ticket_capacity?: number | null;
  latitude?: number | null;
  longitude?: number | null;
};

/** The validated live-ping wire payload (canonical `live_pings` columns). */
export type ValidLivePingPayload = {
  artist_id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  status: string;
};

/** A stored show — the validated wire payload plus its generated id. */
export type ShowRecord = ValidShowPayload & { id: string };

/** A stored live ping — the validated wire payload plus its generated id. */
export type LivePingRecord = ValidLivePingPayload & { id: string };

/** A registered artist — the identity a Bearer API key resolves to. */
export type ArtistRecord = {
  id: string;
  name: string;
  created_at: string;
  /** SHA-256 hex digest of the artist's API key — never the raw key. */
  key_hash: string;
  /** Display prefix, e.g. `atxlive_abc12345` — safe to show in the UI. */
  key_prefix: string;
};

/** Cap for GET /api/shows — sane default, overridable per call. */
export const DEFAULT_LIST_SHOWS_LIMIT = 200;

/**
 * Recon claim concurrency constants (migration 0011, spec art_7M0snhxc —
 * the settlement concurrency canon from 0009). A processing claim older
 * than RECON_STALE_CLAIM_MS is stale — its worker crashed, and the job is
 * re-claimable. RECON_MAX_ATTEMPTS is the retry budget failReconJob
 * enforces; past the cap, failure is terminal and honest.
 */
export const RECON_STALE_CLAIM_MS = 30 * 60 * 1000;
export const RECON_MAX_ATTEMPTS = 3;

/**
 * Outcome of recording one completed checkout session. `recorded` is the
 * first confirmation — capacity was decremented; `already_recorded` is a
 * repeat confirm of the same session (poll-safe: the redirect may hit the
 * endpoint more than once) — capacity is left alone;
 * `insufficient_capacity` means payment succeeded but the show sold out
 * before confirmation.
 */
export type CheckoutPurchaseResult =
  | { outcome: 'recorded'; remaining: number }
  | { outcome: 'already_recorded'; remaining: number }
  | { outcome: 'insufficient_capacity'; remaining: number };

/**
 * The creator's root UCT + stored ISNI — the kernel's getCreatorUct
 * projection. creatorId is the Don store's payee key (the signup registry
 * holder's rightsHolderId); uctNumber is that holder entry's root UCT tag;
 * isni is creator_profiles.isni (0007), null when absent or malformed.
 * The kernel reuses this identity verbatim — it never mints.
 */
export interface CreatorUctRecord {
  creatorId: string;
  uctNumber: string;
  isni: string | null;
}

/**
 * A signed, integer-cents move over the three vault buckets. Deltas are
 * applied additively by the store (`balance = balance + delta`), never
 * overwritten.
 */
export type VaultBucketDelta = {
  available_balance: number;
  pending_balance: number;
  reserve_balance: number;
};

/** Input for Store.applyVaultDelta — the atomic vault mutation (0009). */
export type VaultDeltaInput = {
  payee_id: string;
  payee_name: string;
  delta: VaultBucketDelta;
  /**
   * Post-update floors per bucket; null/omitted = unguarded. A floor rejects
   * the whole move (nothing is written) — the sufficiency check lives in the
   * same statement that moves the money.
   */
  min_balances?: Partial<VaultBucketDelta>;
  /** Credits may mint the vault; debits and holds may not. */
  create_if_missing: boolean;
  updated_at: string;
};

/** Outcome of Store.applyVaultDelta — see the interface doc. */
export type ApplyVaultDeltaResult =
  | { outcome: 'applied'; vault: SovereignVaultRecord }
  | { outcome: 'guard_failed' }
  | { outcome: 'not_found' };

/**
 * The Don Engine persistence contract — Cursor's canonical 72-method
 * `Store`, Promise-wrapped (see header, deviation 1). Ordering guarantees
 * canonical to the SQLite store carry over: "newest first" is created_at
 * DESC with insertion order as tiebreak; per-run/creator lists are
 * created_at ASC with insertion order as tiebreak.
 */
export interface Store {
  // --- Legacy show / ping / artist surface ---
  insertShow(show: ValidShowPayload): Promise<ShowRecord>;
  /** Newest first (created_at DESC, insertion order as tiebreak). */
  listShows(limit?: number): Promise<ShowRecord[]>;
  getShow(id: string): Promise<ShowRecord | undefined>;
  /**
   * Idempotently records a completed checkout session and decrements the
   * show's remaining capacity by the purchased quantity. The
   * checkout_sessions table's primary key makes a repeated confirm a no-op
   * (poll-safe success-redirect handling). Returns null when the show
   * doesn't exist or isn't native ticketing.
   */
  recordCheckoutPurchase(
    sessionId: string,
    showId: string,
    quantity: number,
  ): Promise<CheckoutPurchaseResult | null>;
  insertLivePing(ping: ValidLivePingPayload): Promise<LivePingRecord>;
  /** Newest first (timestamp DESC, insertion order as tiebreak). */
  listLivePings(limit?: number): Promise<LivePingRecord[]>;
  insertArtist(
    name: string,
    keyHash: string,
    keyPrefix: string,
    createdAt?: string,
  ): Promise<ArtistRecord>;
  getArtist(id: string): Promise<ArtistRecord | undefined>;
  /** Resolves a presented API key's stored hash to its artist row. */
  getArtistByKeyHash(keyHash: string): Promise<ArtistRecord | undefined>;

  // --- Plaid link / KYC surface ---
  insertPlaidLinkToken(
    token: Omit<PlaidLinkTokenRecord, 'id' | 'created_at'>,
  ): Promise<PlaidLinkTokenRecord>;
  getPlaidLinkTokenByLinkToken(
    linkToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined>;
  getPlaidLinkTokenByPublicToken(
    publicToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined>;
  updatePlaidAccessToken(
    publicToken: string,
    accessToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined>;
  insertKycVerification(
    row: Omit<KycVerificationRecord, 'id'>,
  ): Promise<KycVerificationRecord>;
  listKycVerificationsByCreator(creatorId: string): Promise<KycVerificationRecord[]>;
  insertProcessorToken(
    row: Omit<PlaidProcessorTokenRecord, 'id'>,
  ): Promise<PlaidProcessorTokenRecord>;
  getProcessorToken(
    publicToken: string,
    processor: PlaidProcessorTokenRecord['processor'],
  ): Promise<PlaidProcessorTokenRecord | undefined>;

  // --- Split runs + line items ---
  insertSplitRun(
    row: Omit<SplitRunRecord, 'id' | 'status' | 'idempotency_key'> & {
      idempotency_key?: string | null;
    },
  ): Promise<SplitRunRecord>;
  getSplitRun(id: string): Promise<SplitRunRecord | undefined>;
  /** The saga replay lookup (migration 0009): split_runs.idempotency_key is unique when present. */
  getSplitRunByIdempotencyKey(key: string): Promise<SplitRunRecord | undefined>;
  updateSplitRunStatus(
    id: string,
    status: SplitRunRecord['status'],
  ): Promise<SplitRunRecord | undefined>;
  insertRoyaltyLineItem(
    row: Omit<RoyaltyLineItemRecord, 'id'>,
  ): Promise<RoyaltyLineItemRecord>;
  /** The royalty line items of ONE split run — the per-run read the analytics industry cut joins on. */
  listRoyaltyLineItemsByRun(splitRunId: string): Promise<RoyaltyLineItemRecord[]>;

  // --- Ledger transactions (UDR allocations + payout flows) ---
  insertLedgerTransaction(
    row: Omit<LedgerTransactionRecord, 'id' | 'kind'> & {
      kind?: LedgerTransactionRecord['kind'];
    },
  ): Promise<LedgerTransactionRecord>;
  getLedgerTransaction(id: string): Promise<LedgerTransactionRecord | undefined>;
  listLedgerTransactionsByRun(splitRunId: string): Promise<LedgerTransactionRecord[]>;
  listLedgerTransactionsByLineItem(
    lineItemId: string,
  ): Promise<LedgerTransactionRecord[]>;
  updateLedgerSettlement(
    id: string,
    patch: Pick<
      LedgerTransactionRecord,
      'status' | 'rail' | 'baas_provider' | 'baas_transfer_id' | 'settled_at'
    >,
  ): Promise<LedgerTransactionRecord | undefined>;

  // --- Unclaimed royalty holding (PR 7) ---
  // Held funds are ledger rows with kind 'unclaimed_holding' whose status is
  // 'unclaimed_holding' — money identified as unallocated (recon) that stays
  // OUT of every payee vault until identity and splits are fully verified.
  // No migration: ledger_transactions.status/kind are free text (0006 has no
  // check constraint on either), so this state extends the existing ledger
  // contract in place.

  /**
   * The held credits, newest first (created_at DESC, insertion order as
   * tiebreak), bounded by limit. Released credits (status 'settled') are
   * history, not holdings — they never appear here.
   */
  listUnclaimedHoldingCredits(limit?: number): Promise<LedgerTransactionRecord[]>;

  /**
   * The release CAS — the settlement concurrency canon (0009) applied to a
   * held credit: flips ONE row from status 'unclaimed_holding' to 'settled'
   * (settled_at = the passed instant) in a single conditional statement.
   * Returns the row only when THIS call won the transition; undefined when
   * the id is unknown OR the credit is no longer held — the concurrent
   * release loser reads exactly that and refuses. The flip happens BEFORE
   * any vault credit (insert-as-lock, the payout-reversal precedent), so a
   * crash mid-release fails toward "nothing moved twice": the settled row
   * with no unclaimed_holding_release journal is the visible alarm.
   */
  settleUnclaimedHolding(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  // --- Film waterfall escrow (PR 9) ---
  // Film distributor receipts lock as ledger rows with kind and status
  // 'escrow_waterfall_pending' — money received from a film distributor that
  // stays OUT of every payee vault and out of the waterfall tiers until the
  // statement line items are cross-referenced against the signed deal memo
  // and CAMA agreement. The escrow is per-film: the payee id is
  // `film_escrow:{filmId}` and the GL account is `film_waterfall_escrow:{filmId}`,
  // the way vault accounts carry the payee id. No migration: status/kind are
  // free text (0006 has no check constraint on either), so the state extends
  // the existing ledger contract in place.

  /**
   * The held escrow credits, newest first (created_at DESC, insertion order
   * as tiebreak), bounded by limit — across ALL films. Released credits
   * (status 'settled') are history, not holdings — they never appear here.
   */
  listFilmEscrowCredits(limit?: number): Promise<LedgerTransactionRecord[]>;

  /**
   * The verified-release CAS — the settlement concurrency canon (0009)
   * applied to a locked film receipt: flips ONE row from status
   * 'escrow_waterfall_pending' to 'settled' (settled_at = the passed
   * instant) in a single conditional statement. Returns the row only when
   * THIS call won the transition; undefined when the id is unknown OR the
   * receipt is no longer locked — the concurrent release loser reads
   * exactly that and refuses. The flip happens BEFORE any waterfall leg
   * (insert-as-lock, the payout-reversal precedent), so a crash mid-release
   * fails toward "nothing moved twice": the settled row with no
   * film_escrow_release journal is the visible alarm.
   */
  settleFilmEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * The film's cumulative gross receipts, integer cents: the sum over ALL
   * of the film's escrow receipt rows (kind 'escrow_waterfall_pending',
   * payee `film_escrow:{filmId}`) regardless of status — money counts as
   * RECEIVED when it locks, not when it releases, so the First Dollar Gross
   * trigger reads the film's true gross. The aggregate is exact (the store
   * computes it; callers never sum a truncated page). Zero for a film with
   * no receipts.
   */
  sumFilmGrossReceiptCents(filmId: string): Promise<number>;

  // --- Film waterfall engine (PR 8) ---
  // The registered deal (the waterfall definition) and the routing-decision
  // record (the distributions) — the state the pure sequential recoupment
  // router consumes. The definition is ONE row per film asset (jsonb, validated
  // by the waterfall module's registration gate); the distributions carry the
  // per-leg routing detail that makes shortfall carry honest — the GL's tier
  // legs are per-TIER, so per-obligation paid state is not recoverable from
  // them when bps legs and fixed legs share a tier. Migration 0016.

  /**
   * Registers (or replaces) a film's waterfall definition. The caller has
   * already run the waterfall module's registration gate and the definition
   * lock (a film with applied distributions refuses a changed definition —
   * the cumulative per-leg state must stay coherent); this is the write.
   */
  upsertFilmWaterfallDefinition(
    row: FilmWaterfallDefinitionRecord,
  ): Promise<FilmWaterfallDefinitionRecord>;

  /** The film's registered waterfall, or undefined when the film has none. */
  getFilmWaterfallDefinition(
    filmId: string,
  ): Promise<FilmWaterfallDefinitionRecord | undefined>;

  /**
   * Persists one routing decision. UNIQUE on escrow_ledger_id — one routing
   * decision per released receipt, ever; a duplicate insert throws (the
   * quarantine-once precedent) and the caller recovers by reading the
   * existing row through getFilmWaterfallDistributionByEscrow.
   */
  insertFilmWaterfallDistribution(
    row: Omit<FilmWaterfallDistributionRecord, 'id'>,
  ): Promise<FilmWaterfallDistributionRecord>;

  /**
   * The routing decision previously made for one released escrow receipt, or
   * undefined — the crash-repair read and the replay guard.
   */
  getFilmWaterfallDistributionByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmWaterfallDistributionRecord | undefined>;

  /**
   * Flips one routing decision's status ('routed' → 'applied' on release
   * success). Returns the row, or undefined when the id is unknown — the
   * caller deleted it (the release refused) or it never existed.
   */
  updateFilmWaterfallDistributionStatus(
    id: string,
    status: FilmWaterfallDistributionRecord['status'],
  ): Promise<FilmWaterfallDistributionRecord | undefined>;

  /**
   * Drops a routing decision whose money move was refused (retryable) — the
   * payout-reversal precedent. Cumulative paid sums never see it.
   */
  deleteFilmWaterfallDistribution(id: string): Promise<void>;

  /**
   * The film's routing decisions, oldest first (created_at ASC, insertion
   * order as tiebreak) — the cumulative paid state and the film's waterfall
   * history. Bounded by no limit: a film's distributions are its deal
   * lifetime, and the paid state must be exact (the store returns them all).
   */
  listFilmWaterfallDistributions(
    filmId: string,
  ): Promise<FilmWaterfallDistributionRecord[]>;

  // --- Film multi-territory withholding + cross-collateralization firewall (migration 0023, PR 18) ---

  /**
   * Writes one film line's foreign-withholding log. UNIQUE on event_id (the
   * content-derived match_queue event) — one withholding log per line, ever;
   * a duplicate insert throws the unique violation and the caller recovers
   * by reading the existing row (the replay surface).
   */
  insertFilmTerritoryWithholding(
    row: Omit<FilmTerritoryWithholdingRecord, 'id'>,
  ): Promise<FilmTerritoryWithholdingRecord>;

  /** One line's withholding log by its event id, or undefined — the replay recovery read. */
  getFilmTerritoryWithholdingByEventId(
    eventId: string,
  ): Promise<FilmTerritoryWithholdingRecord | undefined>;

  /** The film's withholding logs, oldest first (created_at ASC, insertion order as tiebreak). */
  listFilmTerritoryWithholdingsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryWithholdingRecord[]>;

  /**
   * Persists one territory envelope's routing decision on a released escrow
   * receipt. UNIQUE on (escrow_ledger_id, territory_code) — one routing
   * decision per receipt per territory, ever; a duplicate insert throws
   * (the quarantine-once precedent) and the caller recovers by reading the
   * existing rows through listFilmTerritoryDistributionsByEscrow.
   */
  insertFilmTerritoryDistribution(
    row: Omit<FilmTerritoryDistributionRecord, 'id'>,
  ): Promise<FilmTerritoryDistributionRecord>;

  /** One released escrow receipt's territory envelopes, territory_code ASC. */
  listFilmTerritoryDistributionsByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmTerritoryDistributionRecord[]>;

  /**
   * The film's territory envelopes, oldest first (created_at ASC, insertion
   * order as tiebreak) — the per-territory paid state and the film's
   * multi-territory routing history.
   */
  listFilmTerritoryDistributionsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryDistributionRecord[]>;

  /**
   * Flips one territory envelope's status ('routed' → 'applied' on release
   * success). Returns the row, or undefined when the id is unknown — the
   * caller deleted it (the release refused) or it never existed.
   */
  updateFilmTerritoryDistributionStatus(
    id: string,
    status: FilmTerritoryDistributionRecord['status'],
  ): Promise<FilmTerritoryDistributionRecord | undefined>;

  /**
   * Drops a territory envelope whose money move was refused (retryable) —
   * the parent routing decision's lifecycle. Per-territory paid sums
   * never see it.
   */
  deleteFilmTerritoryDistribution(id: string): Promise<void>;

  // --- Podcast episode splits + guest milestone bonuses (migration 0017, PR 11) ---

  /**
   * Writes one episode's validated split schedule (one row per episode —
   * a re-registration replaces the row; the engine bumps the version).
   */
  upsertPodcastEpisodeSplitSchedule(
    row: PodcastEpisodeSplitScheduleRecord,
  ): Promise<PodcastEpisodeSplitScheduleRecord>;

  getPodcastEpisodeSplitSchedule(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitScheduleRecord | undefined>;

  /**
   * Writes one per-holder split accrual. UNIQUE on source_event_id — one
   * accrual per funding event, ever; a duplicate insert throws the unique
   * violation (the caller counts the replay as a no-op).
   */
  insertPodcastEpisodeSplitAccrual(
    row: Omit<PodcastEpisodeSplitAccrualRecord, 'id'>,
  ): Promise<PodcastEpisodeSplitAccrualRecord>;

  getPodcastEpisodeSplitAccrualBySourceEvent(
    sourceEventId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord | undefined>;

  /** The episode's accruals, oldest first (routing order). */
  listPodcastEpisodeSplitAccruals(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord[]>;

  /** Registers one guest bonus definition (composite-unique per episode/guest/kind/threshold). */
  insertPodcastGuestBonusDefinition(
    row: PodcastGuestBonusDefinitionRecord,
  ): Promise<PodcastGuestBonusDefinitionRecord>;

  listPodcastGuestBonusDefinitions(
    episodeId: string,
  ): Promise<PodcastGuestBonusDefinitionRecord[]>;

  /**
   * Writes one crossed-milestone record. UNIQUE on event_id (the
   * content-derived `podcast:bonus:` id) — the once-only arbiter; a
   * duplicate insert throws the unique violation.
   */
  insertPodcastGuestBonusAccrual(
    row: Omit<PodcastGuestBonusAccrualRecord, 'id'>,
  ): Promise<PodcastGuestBonusAccrualRecord>;

  /** Flips an accrual 'accrued' → 'posted' once its holding credit landed. */
  markPodcastGuestBonusAccrualPosted(
    id: string,
    holdingLedgerId: string,
  ): Promise<PodcastGuestBonusAccrualRecord | undefined>;

  /**
   * Drops an accrual whose holding post was refused (retryable) — the film
   * routing decision's lifecycle. The milestone may fire again on retry.
   */
  deletePodcastGuestBonusAccrual(id: string): Promise<void>;

  listPodcastGuestBonusAccruals(
    episodeId: string,
  ): Promise<PodcastGuestBonusAccrualRecord[]>;

  /**
   * The episode's LIFETIME verified impression total over the queue's
   * `podcast:imp:`/`podcast:sub:` rows (the prefixes select the milestone
   * kind's audience definition). Rows whose payload does not name the
   * episode contribute nothing. A truncated scan under-counts — milestones
   * under-fire and money stays held (fail-closed), never over-pays.
   */
  sumVerifiedImpressionsByEpisode(
    episodeId: string,
    eventIdPrefixes: readonly string[],
  ): Promise<number>;

  // --- Gaming engine-royalty accumulator + item splits (migration 0018, PR 12) ---

  /**
   * Writes one Epic-family gross contribution. UNIQUE on event_id — one
   * contribution per queue event, ever; a duplicate insert throws the
   * unique violation (the caller counts the replay as a no-op).
   */
  insertGamingEngineRoyaltyEvent(
    row: Omit<GamingEngineRoyaltyEventRecord, 'id'>,
  ): Promise<GamingEngineRoyaltyEventRecord>;

  getGamingEngineRoyaltyEventByEventId(
    eventId: string,
  ): Promise<GamingEngineRoyaltyEventRecord | undefined>;

  /**
   * The accumulator's per-product annual state — the DERIVED sum of the
   * product's contribution rows for the year (never a mutable counter, so
   * replayed gross can never cross the $1M threshold twice). Micros as text.
   * `platforms` is the accumulating FAMILY (Epic Games Store + Unreal
   * Marketplace share one per-product line) — every platform in the list
   * contributes to the sum.
   */
  sumGamingEngineRoyaltyGross(
    platforms: readonly string[],
    productId: string,
    annualYear: number,
  ): Promise<string>;

  /**
   * Writes one item's validated split schedule (one row per item — a
   * re-registration replaces the row; the engine bumps the version).
   */
  upsertGamingItemSplitSchedule(
    row: GamingItemSplitScheduleRecord,
  ): Promise<GamingItemSplitScheduleRecord>;

  getGamingItemSplitSchedule(
    itemId: string,
  ): Promise<GamingItemSplitScheduleRecord | undefined>;

  /**
   * Writes one per-item split payout routing. UNIQUE on source_event_id —
   * one routing per funding event, ever; a duplicate insert throws the
   * unique violation (the caller counts the replay as a no-op).
   */
  insertGamingSplitPayout(
    row: Omit<GamingSplitPayoutRecord, 'id'>,
  ): Promise<GamingSplitPayoutRecord>;

  getGamingSplitPayoutBySourceEvent(
    sourceEventId: string,
  ): Promise<GamingSplitPayoutRecord | undefined>;

  /** The item's payout routings, oldest first (created_at ASC, id tiebreak). */
  listGamingSplitPayouts(itemId: string): Promise<GamingSplitPayoutRecord[]>;

  // --- Gaming cashout states: DevEx conversion logs + studio KYC (migration 0019, PR 13) ---

  /**
   * The held gaming cashout receipts — kind AND status
   * 'virtual_currency_cashout_pending', newest first. Released rows and
   * ordinary royalty rows never appear.
   */
  listVirtualCurrencyCashoutCredits(
    limit?: number,
  ): Promise<LedgerTransactionRecord[]>;

  /**
   * Compare-and-set release lock for one gaming cashout receipt: flips ONE
   * row from status 'virtual_currency_cashout_pending' to 'settled' and
   * returns it; reads undefined when the row is absent or no longer locked
   * (the concurrent release loser). The conditional read IS the CAS — the
   * unclaimed-holding/film-escrow precedent.
   */
  settleVirtualCurrencyCashout(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Writes one durable DevEx conversion log. UNIQUE on event_id (the
   * content-derived `gaming:devex:` id) — the once-only replay arbiter; a
   * duplicate insert throws the unique violation (the caller counts the
   * replay as a no-op).
   */
  insertGamingDevexConversionLog(
    row: Omit<GamingDevexConversionLogRecord, 'id'>,
  ): Promise<GamingDevexConversionLogRecord>;

  getGamingDevexConversionLogByEventId(
    eventId: string,
  ): Promise<GamingDevexConversionLogRecord | undefined>;

  /** The batch's conversion logs, oldest first (the release path's read). */
  listGamingDevexConversionLogsByBatch(
    batchRef: string,
  ): Promise<GamingDevexConversionLogRecord[]>;

  /**
   * Flips EVERY 'pending_fiat_settlement' log of one payout batch to
   * 'fiat_settled' (the platform's fiat settlement completed) and returns
   * the count flipped. The batch's already-settled logs are untouched.
   */
  settleGamingDevexConversionLogsByBatch(
    batchRef: string,
    settledAt: string,
  ): Promise<number>;

  /**
   * Upserts one model's nested derivative split contract terms (migration
   * 0028) — UNIQUE per ai_model_id; a re-registration replaces the row
   * (the newest contract governs the next ingest).
   */
  upsertAiModelSplitTerms(
    terms: Omit<AiModelSplitTermsRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiModelSplitTermsRecord>;

  /** One model's contract terms of record; null when the model is unregistered. */
  getAiModelSplitTerms(
    aiModelId: string,
  ): Promise<AiModelSplitTermsRecord | undefined>;

  /**
   * Upserts one contributor's registered dataset token weight on one model
   * (migration 0028) — UNIQUE per (ai_model_id, contributor_payee_id); a
   * re-shipped attribution log converges (the newest weight governs).
   */
  upsertAiModelContribution(
    contribution: Omit<
      AiModelContributionRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<AiModelContributionRecord>;

  /** One model's registered contributors (the registry fallback's pool inputs). */
  listAiModelContributions(
    aiModelId: string,
  ): Promise<AiModelContributionRecord[]>;

  // --- AI training dispute freeze + payout gate states + dataset
  // --- deprecations (migration 0029, PR 25)

  /**
   * Files one rights holder's IP attribution dispute against a model's
   * training dataset version. UNIQUE on
   * (ai_model_id, dataset_version, rights_holder_payee_id) — a re-filed
   * dispute throws the unique violation and the caller recovers by
   * reading the existing row (the quarantine-once precedent); the filing
   * is never a second freeze fact.
   */
  insertAiTrainingDispute(
    row: Omit<AiTrainingDisputeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiTrainingDisputeRecord>;

  /** One dispute by id, or undefined when the id is unknown. */
  getAiTrainingDispute(id: string): Promise<AiTrainingDisputeRecord | undefined>;

  /**
   * The disputes, newest first (created_at DESC, insertion order as
   * tiebreak), bounded like every other list seam. status filters when
   * present ('filed' = the active-freeze work queue, 'resolved' = the
   * resolution history); absent = all of them.
   */
  listAiTrainingDisputes(
    status?: AiTrainingDisputeStatus,
    limit?: number,
  ): Promise<AiTrainingDisputeRecord[]>;

  /**
   * THE VERIFIED RESOLUTION PATH's write — the CAS that ends a dispute:
   * flips ONE row from status 'filed' to 'resolved' (with the resolution
   * notes, the resolving operator, and resolved_at) in a single
   * conditional statement. Returns the resolved row only when THIS call
   * won the transition; undefined when the id is unknown OR the dispute
   * is already resolved — the concurrent resolution loser reads exactly
   * that. The only other writer allowed to thaw frozen legs reads this
   * CAS first: there is no path from 'unauthorized_training_hold' back
   * to a releasable state that does not run through a resolved dispute.
   */
  resolveAiTrainingDispute(
    id: string,
    resolution: {
      resolution_notes: string | null;
      resolved_by: string;
      resolved_at: string;
    },
  ): Promise<AiTrainingDisputeRecord | undefined>;

  /**
   * The FREEZE CAS sweep — flips EVERY held unclaimed-holding leg of one
   * model's ingest scope (split_run_id = the model scope) from status
   * 'unclaimed_holding' to 'unauthorized_training_hold' in one
   * conditional statement, and returns the count of legs this call
   * froze. The status predicate is the CAS: already-frozen, released,
   * and settled legs are untouched (a re-filed dispute's sweep is a
   * counted no-op), and legs outside the scope — another model's legs,
   * voice-licensing legs (never model-scoped) — never match.
   */
  freezeUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number>;

  /**
   * The THAW CAS sweep — the verified resolution's ledger leg: flips
   * EVERY leg of one model's ingest scope from status
   * 'unauthorized_training_hold' back to 'unclaimed_holding' in one
   * conditional statement, and returns the count of legs this call
   * thawed. Called ONLY after the dispute's resolution CAS won (the
   * training-dispute module is this method's only caller): a frozen leg
   * has exactly one exit.
   */
  thawUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number>;

  /**
   * The frozen-leg work queue: ledger rows with kind 'unclaimed_holding'
   * AND status 'unauthorized_training_hold' (a thawed leg leaves the
   * listing — its status returns to 'unclaimed_holding'), newest first,
   * bounded like every other list seam.
   */
  listUnauthorizedTrainingHolds(
    limit?: number,
  ): Promise<LedgerTransactionRecord[]>;

  /**
   * Upserts one payee's AI payout-gate states (migration 0029) — UNIQUE
   * per payee_id; a re-recording converges (the newest state governs the
   * next dispatch).
   */
  upsertAiPayoutGateState(
    row: Omit<AiPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiPayoutGateStateRecord>;

  /**
   * One payee's AI payout-gate states of record; undefined when the
   * payee has none — the fail-closed absent state (the gate refuses).
   */
  getAiPayoutGateState(
    payeeId: string,
  ): Promise<AiPayoutGateStateRecord | undefined>;

  /**
   * Writes one dataset version's deprecation of record. UNIQUE on
   * (ai_model_id, dataset_version) — a re-deprecation throws the unique
   * violation and the caller recovers by reading the existing row; the
   * archival sweep that follows re-runs idempotently.
   */
  insertAiDatasetDeprecation(
    row: Omit<
      AiDatasetDeprecationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<AiDatasetDeprecationRecord>;

  /** One (model, dataset version) deprecation of record; undefined when active. */
  getAiDatasetDeprecation(
    aiModelId: string,
    datasetVersion: string,
  ): Promise<AiDatasetDeprecationRecord | undefined>;

  /**
   * The model's deprecations of record, oldest first (created_at ASC,
   * insertion order as tiebreak) — the posting pass's halt set.
   */
  listAiDatasetDeprecationsByModel(
    aiModelId: string,
  ): Promise<AiDatasetDeprecationRecord[]>;

  /**
   * Archives one historical allocation of a deprecated dataset version.
   * UNIQUE on (deprecation_id, ledger_transaction_id) — a re-run
   * deprecation converges, never double-archives. The referenced ledger
   * row is NOT touched here or anywhere: the append-only trail stays
   * intact; this row is the retirement record.
   */
  insertAiDatasetAllocationArchive(
    row: Omit<AiDatasetAllocationArchiveRecord, 'id'>,
  ): Promise<AiDatasetAllocationArchiveRecord>;

  /** One deprecation's archived allocations, oldest first. */
  listAiDatasetAllocationArchives(
    deprecationId: string,
  ): Promise<AiDatasetAllocationArchiveRecord[]>;

  /**
   * Writes one studio's KYC verification state (one row per studio payee —
   * a re-verification replaces the row; the TypeScript validator is the
   * registration gate).
   */
  upsertGamingStudioKyc(
    row: GamingStudioKycRecord,
  ): Promise<GamingStudioKycRecord>;

  getGamingStudioKyc(
    studioPayeeId: string,
  ): Promise<GamingStudioKycRecord | undefined>;

  // --- Esports prize pool escrow (PR 14) ---

  /**
   * Compare-and-set release lock for one esports prize pool receipt: flips
   * ONE row from status 'esports_prize_pool_pending' to 'settled' and
   * returns it; reads undefined when the row is absent or no longer locked
   * (the concurrent release loser). The conditional read IS the CAS — the
   * film-escrow precedent. The flip happens BEFORE any waterfall leg
   * (insert-as-lock), so a crash mid-release fails toward "nothing moved
   * twice".
   */
  settleEsportsPoolEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * The locked prize-pool receipt work queue: ledger rows with kind AND
   * status 'esports_prize_pool_pending' (a released receipt leaves the
   * listing — its status is 'settled'), newest first, bounded like every
   * other list seam. Mirrors listVirtualCurrencyCashoutCredits.
   */
  listEsportsPoolEscrowCredits(limit?: number): Promise<LedgerTransactionRecord[]>;

  // --- VTuber agency licensing holdbacks + tax verification (migration 0020, PR 15) ---

  /**
   * The locked VTuber holdback receipts — ledger rows with kind AND status
   * 'avatar_ip_licensing_holdback' (a released receipt leaves the listing —
   * its status is 'settled'), newest first, bounded like every other list
   * seam. Mirrors listEsportsPoolEscrowCredits.
   */
  listAvatarIpHoldbackCredits(limit?: number): Promise<LedgerTransactionRecord[]>;

  /**
   * Compare-and-set release lock for one VTuber holdback receipt: flips ONE
   * row from status 'avatar_ip_licensing_holdback' to 'settled' and returns
   * it; reads undefined when the row is absent or no longer locked (the
   * concurrent release loser). The conditional read IS the CAS — the
   * film-escrow/gaming-cashout/esports precedent. The flip happens BEFORE
   * any deduction-stack routing (insert-as-lock), so a crash mid-release
   * fails toward "nothing moved twice".
   */
  settleAvatarIpHoldback(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Writes one payee's tax-withholding verification for one tax year —
   * UNIQUE on (payee_id, tax_year); a re-verification replaces the row
   * (the studio-KYC upsert precedent, at year scope).
   */
  upsertVtuberTaxWithholdingVerification(
    row: VtuberTaxWithholdingVerificationRecord,
  ): Promise<VtuberTaxWithholdingVerificationRecord>;

  getVtuberTaxWithholdingVerification(
    payeeId: string,
    taxYear: number,
  ): Promise<VtuberTaxWithholdingVerificationRecord | undefined>;

  /**
   * Writes one tech-setup amortization schedule (the immutable contract).
   * UNIQUE on schedule_ref — a duplicate insert throws the unique
   * violation.
   */
  insertVtuberTechSetupAmortizationSchedule(
    row: Omit<VtuberTechSetupAmortizationScheduleRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord>;

  getVtuberTechSetupAmortizationScheduleByRef(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord | undefined>;

  /**
   * Appends one consumed amortization line. UNIQUE on
   * (schedule_ref, line_index) — the insert-as-lock consume arbiter; a
   * concurrent consume of the same line throws the unique violation (the
   * caller re-derives the next line index and retries).
   */
  insertVtuberTechSetupAmortizationLine(
    row: Omit<VtuberTechSetupAmortizationLineRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationLineRecord>;

  /** The schedule's consumed lines, oldest first (line_index ASC). */
  listVtuberTechSetupAmortizationLines(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationLineRecord[]>;

  // --- Derivative asset royalty cascade (migration 0021, PR 16) ---

  /**
   * Registers one per-edge fractional royalty contract over the
   * parent_asset_id dependency tree. UNIQUE on
   * (asset_id, parent_asset_id, upstream_creator_payee_id) — a duplicate
   * registration throws the unique violation (the replay surface).
   */
  insertDerivativeRoyaltyEdge(
    row: Omit<DerivativeRoyaltyEdgeRecord, 'id'>,
  ): Promise<DerivativeRoyaltyEdgeRecord>;

  /**
   * One asset's outgoing edges — the depth-first walk's per-node lookup,
   * oldest first (created_at ASC, insertion_order ASC): the deterministic
   * reservation order. Distinct payees may hold distinct fractions on one
   * edge; each contract row reserves independently.
   */
  getDerivativeRoyaltyEdgesByAsset(assetId: string): Promise<DerivativeRoyaltyEdgeRecord[]>;

  /**
   * Register a clearance agreement of record (migration 0022): the work's
   * licensed use of an upstream composition on one side of the rights
   * separation. Duplicate (work, parent, payee, rights_type) throws the
   * unique violation.
   */
  insertSampleClearanceEdge(
    row: Omit<SampleClearanceEdgeRecord, 'id'>,
  ): Promise<SampleClearanceEdgeRecord>;

  /**
   * One work's outgoing clearance edges — the depth-first walk's per-node
   * lookup, oldest first (created_at ASC, insertion_order ASC): the
   * deterministic reservation order. Edges for BOTH sides of the rights
   * separation return here; the cascade planner filters by the line's
   * rights_type.
   */
  getSampleClearanceEdgesByWork(workId: string): Promise<SampleClearanceEdgeRecord[]>;

  /** Register a composition's publisher of record (migration 0022). */
  insertCompositionPublisher(
    row: Omit<CompositionPublisherRecord, 'id'>,
  ): Promise<CompositionPublisherRecord>;

  /**
   * One composition's publishers of record, oldest first (created_at ASC,
   * insertion_order ASC): the deterministic order the statutory mechanical
   * pool routes in.
   */
  listCompositionPublishers(compositionId: string): Promise<CompositionPublisherRecord[]>;

  // --- Webtoon studio splits + translation cascades (PR 20, migration 0024) ---

  /**
   * Register one studio split role of record: the series' production split
   * schedule, per (series, role_group, payee). A duplicate registration
   * throws the unique violation (the replay surface).
   */
  insertWebtoonStudioSplitRole(
    row: Omit<WebtoonStudioSplitRoleRecord, 'id'>,
  ): Promise<WebtoonStudioSplitRoleRecord>;

  /**
   * One series' studio split roles, oldest first (created_at ASC,
   * insertion_order ASC): the deterministic allocation order within each
   * role group.
   */
  listWebtoonStudioSplitRoles(seriesId: string): Promise<WebtoonStudioSplitRoleRecord[]>;

  /**
   * Register (or replace) the localization contract of record for one
   * (series, language) feed — upsert on the composite key: a re-registered
   * contract replaces the row atomically (the studio-KYC precedent).
   */
  upsertWebtoonLocalizationContract(
    row: Omit<WebtoonLocalizationContractRecord, 'id'>,
  ): Promise<WebtoonLocalizationContractRecord>;

  /** One (series, language) feed's localization contract of record. */
  getWebtoonLocalizationContract(
    seriesId: string,
    languageCode: string,
  ): Promise<WebtoonLocalizationContractRecord | undefined>;

  /** Register a localization cost amortization schedule (migration 0024). */
  insertWebtoonLocalizationCostSchedule(
    row: Omit<WebtoonLocalizationCostScheduleRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostScheduleRecord>;

  /** Resolve an amortization schedule by its business key. */
  getWebtoonLocalizationCostScheduleByRef(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostScheduleRecord | undefined>;

  /**
   * Append one consumed amortization line. UNIQUE per (schedule_ref,
   * line_index): a concurrent release consuming one period twice throws the
   * unique violation (the insert-as-lock guard).
   */
  insertWebtoonLocalizationCostLine(
    row: Omit<WebtoonLocalizationCostLineRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostLineRecord>;

  /** One schedule's consumed lines, line_index ASC — the consumed periods. */
  listWebtoonLocalizationCostLines(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostLineRecord[]>;

  /**
   * Register (or replace) one recoupment pool of record per (series, class)
   * — upsert on the composite key: re-registering an advance replaces the
   * row atomically.
   */
  upsertWebtoonRecoupmentPool(
    row: Omit<WebtoonRecoupmentPoolRecord, 'id'>,
  ): Promise<WebtoonRecoupmentPoolRecord>;

  /** One (series, class) pool of record — the isolation rule's subject. */
  getWebtoonRecoupmentPool(
    seriesId: string,
    poolClass: WebtoonRecoupmentPoolClass,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined>;

  /**
   * Append one recoupment application. UNIQUE per (pool_id,
   * source_event_id): a replayed application throws the unique violation,
   * never a double recovery.
   */
  insertWebtoonRecoupmentApplication(
    row: Omit<WebtoonRecoupmentApplicationRecord, 'id'>,
  ): Promise<WebtoonRecoupmentApplicationRecord>;

  /** One pool's applications, created_at ASC — the running recovery. */
  listWebtoonRecoupmentApplications(poolId: string): Promise<WebtoonRecoupmentApplicationRecord[]>;

  /**
   * THE pool CAS: advances a pool's running recovery and flips status when
   * the recovery completes — only from the 'active' state. Undefined = the
   * pool is absent or no longer active (the caller lost the race to the
   * completing application). The append-only application rows stay the
   * replay arbiter; this counter is the derived read.
   */
  updateWebtoonRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: WebtoonRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined>;

  /**
   * The book editorial split schedule of record per title_key (PR 26,
   * migration 0030) — upsert on the key: a re-registration keeps the row's
   * identity and increments its version (the cascade builds the row from
   * the existing record; the store replaces it atomically).
   */
  upsertBookEditorialSplitSchedule(
    row: BookEditorialSplitScheduleRecord,
  ): Promise<BookEditorialSplitScheduleRecord>;

  /** One schedule of record — the split pass's gate. */
  getBookEditorialSplitSchedule(
    titleKey: string,
  ): Promise<BookEditorialSplitScheduleRecord | undefined>;

  /**
   * Append one sequential recoupment pool. UNIQUE per (isbn, pool_class,
   * sequence_no): a re-registered sequence slot throws the unique
   * violation, never a silent duplicate.
   */
  insertBookRecoupmentPool(
    row: Omit<BookRecoupmentPoolRecord, 'id'>,
  ): Promise<BookRecoupmentPoolRecord>;

  /** One title+class pool sequence, sequence_no ASC — the recoupment order. */
  listBookRecoupmentPools(
    isbn: string,
    poolClass: BookRecoupmentPoolClass,
  ): Promise<BookRecoupmentPoolRecord[]>;

  /**
   * THE pool CAS: advances a pool's running recovery and flips status when
   * the recovery completes — only from the 'active' state. Undefined = the
   * pool is absent or no longer active (the caller lost the race to the
   * completing application). The append-only application rows stay the
   * replay arbiter; this counter is the derived read.
   */
  updateBookRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: BookRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<BookRecoupmentPoolRecord | undefined>;

  /**
   * Append one book recoupment application. UNIQUE per (pool_id,
   * source_event_id) — the replay guard; UNIQUE per (pool_id,
   * recouped_before_cents) — the position lock (the webtoon discipline).
   */
  insertBookRecoupmentApplication(
    row: Omit<BookRecoupmentApplicationRecord, 'id'>,
  ): Promise<BookRecoupmentApplicationRecord>;

  /** One pool's applications, created_at ASC — the running recovery. */
  listBookRecoupmentApplications(
    poolId: string,
  ): Promise<BookRecoupmentApplicationRecord[]>;

  /**
   * Append one executed editorial split. UNIQUE per source_event_id: a
   * replayed accrual throws the unique violation, never a double
   * designation.
   */
  insertBookEditorialSplitAccrual(
    row: Omit<BookEditorialSplitAccrualRecord, 'id'>,
  ): Promise<BookEditorialSplitAccrualRecord>;

  /**
   * The art split schedule of record per scope_key (PR 28, migration 0032)
   * — upsert on the key: a re-registration keeps the row's identity and
   * increments its version (the cascade builds the row from the existing
   * record; the store replaces it atomically).
   */
  upsertArtSplitSchedule(row: ArtSplitScheduleRecord): Promise<ArtSplitScheduleRecord>;

  /** One schedule of record — the waterfall pass's gate. */
  getArtSplitSchedule(scopeKey: string): Promise<ArtSplitScheduleRecord | undefined>;

  /**
   * Append one sequential fabrication recoupment pool. UNIQUE per
   * (scope_key, pool_class, sequence_no): a re-registered sequence slot
   * throws the unique violation, never a silent duplicate.
   */
  insertArtRecoupmentPool(
    row: Omit<ArtRecoupmentPoolRecord, 'id'>,
  ): Promise<ArtRecoupmentPoolRecord>;

  /**
   * One scope+class pool sequence, sequence_no ASC — the fabrication
   * recoupment order.
   */
  listArtRecoupmentPools(
    scopeKey: string,
    poolClass: ArtRecoupmentPoolClass,
  ): Promise<ArtRecoupmentPoolRecord[]>;

  /**
   * THE pool CAS: advances a pool's running recovery and flips status when
   * the recovery completes — only from the 'active' state. Undefined = the
   * pool is absent or no longer active (the caller lost the race to the
   * completing application). The append-only application rows stay the
   * replay arbiter; this counter is the derived read.
   */
  updateArtRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: ArtRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<ArtRecoupmentPoolRecord | undefined>;

  /**
   * Append one art recoupment application. UNIQUE per (pool_id,
   * source_event_id) — the replay guard; UNIQUE per (pool_id,
   * recouped_before_cents) — the position lock (the books discipline).
   */
  insertArtRecoupmentApplication(
    row: Omit<ArtRecoupmentApplicationRecord, 'id'>,
  ): Promise<ArtRecoupmentApplicationRecord>;

  /** One pool's applications, created_at ASC — the running recovery. */
  listArtRecoupmentApplications(poolId: string): Promise<ArtRecoupmentApplicationRecord[]>;

  /**
   * Append one executed art split. UNIQUE per source_event_id: a replayed
   * accrual throws the unique violation, never a double designation.
   */
  insertArtSplitAccrual(row: Omit<ArtSplitAccrualRecord, 'id'>): Promise<ArtSplitAccrualRecord>;

  /**
   * The copyright agency collection-fee policy of record per agency_code
   * (PR 28, migration 0032) — upsert on the key: a re-registration
   * replaces the row atomically (the founder band validates at
   * registration; the store stores the registered rate).
   */
  upsertArtLicensingAgencyPolicy(
    row: Omit<ArtLicensingAgencyPolicyRecord, 'id'>,
  ): Promise<ArtLicensingAgencyPolicyRecord>;

  /** One agency's policy of record — the licensing pass's configurable rate. */
  getArtLicensingAgencyPolicy(
    agencyCode: ArtLicensingAgencyPolicyRecord['agency_code'],
  ): Promise<ArtLicensingAgencyPolicyRecord | undefined>;

  // --- Estate succession + multi-heir splitting (PR 29, migration 0033) ---

  /**
   * Upserts the estate succession certificate of record (migration 0033) —
   * UNIQUE per (artist_payee_id, certificate_ref): a re-validation
   * converges on the row (the newest validation state governs the
   * transition gate).
   */
  upsertEstateSuccessionCertificate(
    row: Omit<EstateSuccessionCertificateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstateSuccessionCertificateRecord>;

  /**
   * One certificate of record per (artist, certificate_ref); undefined
   * when the artist has none — the fail-closed absent state.
   */
  getEstateSuccessionCertificate(
    artistPayeeId: string,
    certificateRef: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined>;

  /**
   * The artist's newest VERIFIED certificate of record; undefined when no
   * verified certificate exists — the receiving-entity transition's gate
   * (absent refuses, fail-closed).
   */
  getVerifiedEstateSuccessionCertificate(
    artistPayeeId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined>;

  /** One certificate of record by id — the schedule registration's anchor. */
  getEstateSuccessionCertificateById(
    certificateId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined>;

  /**
   * The multi-heir split schedule of record per certificate (migration
   * 0033) — upsert on the key: a re-registration (a probate amendment)
   * keeps the row's identity and increments its version (the art schedule
   * upsert discipline; the engine builds the row from the existing
   * record).
   */
  upsertEstateHeirSchedule(row: EstateHeirScheduleRecord): Promise<EstateHeirScheduleRecord>;

  /** One schedule of record — the accrual's verified probate percentages. */
  getEstateHeirSchedule(
    certificateId: string,
  ): Promise<EstateHeirScheduleRecord | undefined>;

  /**
   * Append one receiving-entity transition. UNIQUE per (certificate_id,
   * source_event_id): a replayed transition throws the unique violation,
   * never a double handoff. Append-only — nothing ever updates or deletes
   * a transition row.
   */
  insertEstateSuccessionTransition(
    row: Omit<EstateSuccessionTransitionRecord, 'id'>,
  ): Promise<EstateSuccessionTransitionRecord>;

  /** One certificate's transition history, created_at ASC — the audit trail. */
  listEstateSuccessionTransitions(
    certificateId: string,
  ): Promise<EstateSuccessionTransitionRecord[]>;

  /**
   * Append one executed estate split. UNIQUE per (certificate_id,
   * artwork_id, source_event_id): a replayed accrual throws the unique
   * violation, never a double designation — the provenance triple IS the
   * once-only key.
   */
  insertEstateSplitAccrual(
    row: Omit<EstateSplitAccrualRecord, 'id'>,
  ): Promise<EstateSplitAccrualRecord>;

  /** One certificate's executed splits, created_at ASC — the accrual ledger. */
  listEstateSplitAccruals(certificateId: string): Promise<EstateSplitAccrualRecord[]>;

  /**
   * Upserts one payee's estate payout-gate state (migration 0033) —
   * UNIQUE per payee_id; a re-recording converges (the newest state
   * governs the next dispatch).
   */
  upsertEstatePayoutGateState(
    row: Omit<EstatePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstatePayoutGateStateRecord>;

  /**
   * One payee's estate payout-gate state of record; undefined when the
   * payee has none — the fail-closed absent state (the gate refuses).
   */
  getEstatePayoutGateState(payeeId: string): Promise<EstatePayoutGateStateRecord | undefined>;

  // --- AGBOR box office + theatrical recoupment (PR 30, migration 0034) ---

  /**
   * Upserts the production's versioned box office deal of record
   * (migration 0034) — UNIQUE per scope_key: a re-registration replaces the
   * row atomically with its version incremented (the art schedule upsert
   * discipline; the caller builds the row from the existing record).
   */
  upsertTheatricalProductionDeal(
    row: TheatricalProductionDealRecord,
  ): Promise<TheatricalProductionDealRecord>;

  /** One production's deal of record; undefined when none — fail-closed. */
  getTheatricalProductionDeal(
    productionId: string,
  ): Promise<TheatricalProductionDealRecord | undefined>;

  /**
   * Append one per-stop settlement sheet. UNIQUE per source_event_id: a
   * replayed settlement row throws the unique violation, never a double
   * stop — the (production, venue, show date) triple plus the sender's
   * settlement id ride the row as provenance.
   */
  insertTheatricalStopSettlement(
    row: Omit<TheatricalStopSettlementRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalStopSettlementRecord>;

  /** One production's stop sheets, show_date then created_at — the tour book. */
  listTheatricalStopSettlements(productionId: string): Promise<TheatricalStopSettlementRecord[]>;

  /**
   * Advance a deal's running investor recoupment counter — only forward,
   * never past the capitalization budget. Undefined = the deal is absent or
   * the caller lost the race to a concurrent update (the pool CAS's
   * discipline; the append-only application rows stay the replay arbiter).
   */
  updateTheatricalDealRecoupment(
    id: string,
    recoupedCents: number,
    updatedAt: string,
  ): Promise<TheatricalProductionDealRecord | undefined>;

  /**
   * Append one investor recoupment application. UNIQUE per (deal_id,
   * source_event_id) — the replay guard; UNIQUE per (deal_id,
   * recouped_before_cents) — the position lock (the books/art discipline).
   */
  insertTheatricalRecoupmentApplication(
    row: Omit<TheatricalRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalRecoupmentApplicationRecord>;

  /** One deal's applications, created_at ASC — the running recovery. */
  listTheatricalRecoupmentApplications(
    dealId: string,
  ): Promise<TheatricalRecoupmentApplicationRecord[]>;

  /**
   * Append one executed box office split. UNIQUE per (deal_id,
   * source_event_id): a replayed accrual throws the unique violation,
   * never a double designation.
   */
  insertTheatricalSplitAccrual(
    row: Omit<TheatricalSplitAccrualRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalSplitAccrualRecord>;

  /** One deal's executed splits, created_at ASC — the accrual ledger. */
  listTheatricalSplitAccruals(dealId: string): Promise<TheatricalSplitAccrualRecord[]>;

  // --- Promoter settlement escrow + theater gates + comedy audio (PR 31,
  // --- migration 0035) ---

  /**
   * The held promoter settlement escrow credits (kind AND status
   * 'promoter_box_office_settlement_pending'), newest first — the audit-
   * close release path's discovery surface. Released credits (status
   * 'settled') are history, not holdings — they never appear here.
   */
  listPromoterSettlementEscrowCredits(
    limit?: number,
  ): Promise<LedgerTransactionRecord[]>;

  /**
   * The verified-release CAS — the settlement concurrency canon applied to
   * a locked stop's escrow: flips ONE row from status
   * 'promoter_box_office_settlement_pending' to 'settled' (settled_at = the
   * passed instant) in a single conditional statement. Returns the row only
   * when THIS call won the transition; undefined when the id is unknown OR
   * the receipt is no longer locked. The flip happens BEFORE any payout leg
   * (insert-as-lock): a crash mid-release fails toward "nothing moved
   * twice" — the settled row with no promoter_settlement_release journal
   * is the visible alarm.
   */
  settlePromoterSettlementEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Upserts the final night-of-show audit close of record for one stop
   * (migration 0035) — UNIQUE per (production_id, venue_id, show_date): a
   * re-recording converges (the newest close governs the next release).
   */
  upsertPromoterSettlementAudit(
    row: Omit<PromoterSettlementAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PromoterSettlementAuditRecord>;

  /** One stop's audit close of record; undefined when none — fail-closed. */
  getPromoterSettlementAudit(
    productionId: string,
    venueId: string,
    showDate: string,
  ): Promise<PromoterSettlementAuditRecord | undefined>;

  /**
   * Upserts the theater payout gate's states of record for one payee in
   * one production (migration 0035) — UNIQUE per (payee_id, production_id):
   * an upsert converges (the newest states govern the next dispatch).
   */
  upsertTheatricalPayoutGateState(
    row: Omit<TheatricalPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<TheatricalPayoutGateStateRecord>;

  /**
   * One payee × production's gate states of record; undefined when none —
   * the theater vertical's compliance state resolves fail-closed through
   * this (absent → null → the gate refuses with vertical_state_unknown).
   */
  getTheatricalPayoutGateState(
    payeeId: string,
    productionId: string,
  ): Promise<TheatricalPayoutGateStateRecord | undefined>;

  /**
   * Upserts the venue hall fee policy of record for one (tour, venue)
   * pairing (migration 0035) — the founder-banded 15–25% venue cut on tour
   * merchandise. UNIQUE per (tour_id, venue_id): an upsert converges.
   */
  upsertVenueHallFeePolicy(
    row: Omit<VenueHallFeePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<VenueHallFeePolicyRecord>;

  /** One (tour, venue) pairing's hall fee policy; undefined when none —
   * the merch hall-fee release refuses (fail-closed), never guesses. */
  getVenueHallFeePolicy(
    tourId: string,
    venueId: string,
  ): Promise<VenueHallFeePolicyRecord | undefined>;

  /**
   * The locked translation-localization escrow receipts (kind AND status
   * 'translation_localization_pending'), newest first — the release path's
   * discovery surface.
   */
  listTranslationLocalizationEscrowCredits(
    limit?: number,
  ): Promise<LedgerTransactionRecord[]>;

  /**
   * THE CAS settle: flips a locked translation-localization escrow receipt
   * to 'settled' only from the lock state. Undefined = the row is absent or
   * no longer locked — the caller lost the race (or replayed).
   */
  settleTranslationLocalizationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  // --- IP adaptation optioning (PR 21, migration 0025) ---

  /**
   * Registers (or replaces) the option agreement of record for one work —
   * upsert on work_id: a re-registered agreement replaces the row
   * atomically (the localization-contract precedent).
   */
  upsertIpOptionAgreement(
    row: Omit<IpOptionAgreementRecord, 'id'>,
  ): Promise<IpOptionAgreementRecord>;

  /** One work's option agreement of record. */
  getIpOptionAgreement(workId: string): Promise<IpOptionAgreementRecord | undefined>;

  /**
   * Registers one author-side IP allocation of record: the ring-fenced
   * share of the option fee reserved before any agency commission. UNIQUE
   * on (work_id, payee_id) — a duplicate registration throws the unique
   * violation (the replay surface).
   */
  insertIpOptionAuthorAllocation(
    row: Omit<IpOptionAuthorAllocationRecord, 'id'>,
  ): Promise<IpOptionAuthorAllocationRecord>;

  /**
   * One work's author IP allocations, oldest first (created_at ASC,
   * insertion_order ASC): the deterministic author-first reservation order.
   */
  listIpOptionAuthorAllocations(workId: string): Promise<IpOptionAuthorAllocationRecord[]>;

  /**
   * Writes one payee's IP-rights verification for one work — UNIQUE on
   * (payee_id, work_id); a re-verification replaces the row atomically
   * (the studio-KYC upsert precedent, at work scope). Only an explicit
   * 'cleared' state passes the publishing payout gate.
   */
  upsertPublishingIpRightsVerification(
    row: Omit<PublishingIpRightsVerificationRecord, 'id'>,
  ): Promise<PublishingIpRightsVerificationRecord>;

  /** One payee's IP-rights verification state for one work. */
  getPublishingIpRightsVerification(
    payeeId: string,
    workId: string,
  ): Promise<PublishingIpRightsVerificationRecord | undefined>;

  // --- Merch COGS + the brand collaboration waterfall (PR 22, migration 0026) ---

  /**
   * Registers one production lot of record: the batch's unit count and
   * per-unit production cost. UNIQUE on (sku_id, lot_ref) — a
   * re-registered lot throws the unique violation (the replay surface).
   */
  insertMerchCogsLot(row: Omit<MerchCogsLotRecord, 'id'>): Promise<MerchCogsLotRecord>;

  /**
   * One sku's production lots in FIFO order (created_at ASC, lot_ref
   * ASC): the consumption walk's source of truth.
   */
  listMerchCogsLots(skuId: string): Promise<MerchCogsLotRecord[]>;

  /**
   * Writes one FIFO consumption of record: the append-only amortization
   * truth. UNIQUE on (lot_id, source_event_id) — a replayed fulfillment
   * event throws the unique violation, never double-amortizes. UNIQUE on
   * (lot_id, units_consumed_before) — the insert-as-lock position
   * arbiter; a concurrent consumer that loses the position throws.
   */
  insertMerchCogsConsumption(
    row: Omit<MerchCogsConsumptionRecord, 'id'>,
  ): Promise<MerchCogsConsumptionRecord>;

  /**
   * One lot's consumption lines, oldest position first
   * (units_consumed_before ASC): the derived remaining-units truth.
   */
  listMerchCogsConsumptions(lotId: string): Promise<MerchCogsConsumptionRecord[]>;

  /**
   * Registers (or replaces) the collaboration agreement of record for one
   * sku — upsert on sku_id: a re-registered agreement replaces the row
   * atomically (the option-agreement precedent).
   */
  upsertMerchCollabAgreement(
    row: Omit<MerchCollabAgreementRecord, 'id'>,
  ): Promise<MerchCollabAgreementRecord>;

  /** One sku's collaboration agreement of record. */
  getMerchCollabAgreement(skuId: string): Promise<MerchCollabAgreementRecord | undefined>;

  /**
   * Writes one overhead-recoupment application of record: the append-only
   * recovery ledger over the agreement's two pools. UNIQUE on
   * (agreement_id, pool_class, source_event_id) — a replayed settlement
   * throws the unique violation, never double-recoups. UNIQUE on
   * (agreement_id, pool_class, recouped_before_cents) — the
   * insert-as-lock position arbiter.
   */
  insertMerchCollabRecoupmentApplication(
    row: Omit<MerchCollabRecoupmentApplicationRecord, 'id'>,
  ): Promise<MerchCollabRecoupmentApplicationRecord>;

  /**
   * One agreement's recoupment applications for one pool class, oldest
   * position first (recouped_before_cents ASC): the derived recovery
   * truth.
   */
  listMerchCollabRecoupmentApplications(
    agreementId: string,
    poolClass: MerchCollabPoolClass,
  ): Promise<MerchCollabRecoupmentApplicationRecord[]>;

  // --- Merch returns reserve + fulfillment confirmation (PR 23, migration 0027) ---
  // The 10–15% holdback of a merch payout allocation locks as a ledger row
  // with kind AND status 'merch_returns_reserve' — per-contract returns
  // protection that stays OUT of every payee vault until the window
  // elapses and the verified release pays it to creator net. The policy
  // (rate band, window, beneficiary of record), the drawdown truth, and
  // the tracking events live in migration 0027's tables; the reserve
  // itself is a ledger row, so no migration touches ledger_transactions
  // (status/kind stay free text, the 0006 precedent every holding state
  // shares).

  /**
   * Registers (or replaces) the returns-reserve policy of record for one
   * sku — upsert on sku_id: a re-registered policy replaces the row
   * atomically (the option-agreement precedent). The lane validates the
   * founder bands before this write; the schema's CHECKs enforce them
   * again at rest.
   */
  upsertMerchReturnReservePolicy(
    row: Omit<MerchReturnReservePolicyRecord, 'id'>,
  ): Promise<MerchReturnReservePolicyRecord>;

  /** One sku's returns-reserve policy of record. */
  getMerchReturnReservePolicy(skuId: string): Promise<MerchReturnReservePolicyRecord | undefined>;

  /**
   * Writes one reserve drawdown of record: the append-only truth a reserve
   * spends against. UNIQUE on (reserve_ledger_id, source_event_id) — a
   * re-shipped return/chargeback event throws the unique violation, never
   * double-draws. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
   * insert-as-lock position arbiter.
   */
  insertMerchReserveDrawdown(
    row: Omit<MerchReserveDrawdownRecord, 'id'>,
  ): Promise<MerchReserveDrawdownRecord>;

  /**
   * One reserve's drawdowns, oldest position first (drawn_before_cents
   * ASC): the derived spend truth.
   */
  listMerchReserveDrawdowns(reserveLedgerId: string): Promise<MerchReserveDrawdownRecord[]>;

  /**
   * Writes one fulfillment tracking event of record — the fulfillment data
   * the merch payout gate reads. UNIQUE on (fulfillment_event_id,
   * tracking_number, tracking_state) — a re-shipped tracking event throws
   * the unique violation (the replay surface).
   */
  insertMerchFulfillmentTracking(
    row: Omit<MerchFulfillmentTrackingRecord, 'id'>,
  ): Promise<MerchFulfillmentTrackingRecord>;

  /**
   * One fulfillment event's tracking events, oldest first (created_at ASC,
   * insertion order as tiebreak): the lifecycle the confirmation resolves
   * from.
   */
  listMerchFulfillmentTrackings(
    fulfillmentEventId: string,
  ): Promise<MerchFulfillmentTrackingRecord[]>;

  /**
   * The held reserve credits, newest first (created_at DESC, insertion
   * order as tiebreak), bounded by limit — across ALL skus. Released or
   * fully-drawn credits (status 'settled') are history, not holdings —
   * they never appear here.
   */
  listMerchReturnsReserveCredits(limit?: number): Promise<LedgerTransactionRecord[]>;

  /**
   * The release/drawdown CAS — the settlement concurrency canon (0009)
   * applied to a held reserve: flips ONE row from status
   * 'merch_returns_reserve' to 'settled' (settled_at = the passed
   * instant) in a single conditional statement. Returns the row only when
   * THIS call won the transition; undefined when the id is unknown OR the
   * reserve is no longer held — the concurrent release or full-drawdown
   * loser reads exactly that and refuses. The flip happens BEFORE any
   * money moves (insert-as-lock, the payout-reversal precedent), so a
   * crash mid-release fails toward "nothing moved twice": the settled row
   * with no merch_returns_reserve_release journal is the visible alarm.
   */
  settleMerchReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Registers (or replaces) the designer royalty tier of record for one
   * sku — upsert on sku_id (the option-agreement precedent). The tier is
   * the state of record at fulfillment processing time; billings price
   * from this row, never retroactively.
   */
  upsertMerchDesignerRoyaltyTier(
    row: Omit<MerchDesignerRoyaltyTierRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyTierRecord>;

  /** One sku's designer royalty tier of record. */
  getMerchDesignerRoyaltyTier(skuId: string): Promise<MerchDesignerRoyaltyTierRecord | undefined>;

  /**
   * Writes one designer royalty billing of record — the per-unit royalty
   * billed directly to one order fulfillment event. UNIQUE on
   * (source_event_id, sku_id) — a replayed fulfillment event throws the
   * unique violation, never double-bills.
   */
  insertMerchDesignerRoyaltyBilling(
    row: Omit<MerchDesignerRoyaltyBillingRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyBillingRecord>;

  /**
   * Writes one consignment settlement of record — the durable shrinkage
   * reconciliation. UNIQUE on event_id — a re-shipped report throws the
   * unique violation (the replay surface).
   */
  insertMerchConsignmentSettlement(
    row: Omit<MerchConsignmentSettlementRecord, 'id'>,
  ): Promise<MerchConsignmentSettlementRecord>;

  /** One consignment settlement by its content-derived event id. */
  getMerchConsignmentSettlementByEventId(
    eventId: string,
  ): Promise<MerchConsignmentSettlementRecord | undefined>;

  // --- Foreign tax hold + book returns reserve (PR 27, migration 0031) ---

  /**
   * The held FOREIGN_TAX_HOLD credits, newest first (created_at DESC,
   * insertion order as tiebreak), bounded by limit — across ALL countries
   * and tax years. Thawed (status back to 'unclaimed_holding') or released
   * credits never appear here — the work queue of the verified release.
   */
  listForeignTaxHolds(limit?: number): Promise<LedgerTransactionRecord[]>;

  /**
   * The verified-release THAW sweep — flips EVERY ledger row with kind
   * 'unclaimed_holding' AND status 'foreign_tax_hold' AND split_run_id =
   * the passed tax-hold scope ('foreign_tax:{country}:{year}') back to
   * status 'unclaimed_holding' in ONE conditional statement. Returns the
   * flipped count (0 is the honest no-op: an empty scope thaws nothing
   * and fails nothing).
   */
  thawForeignTaxHolds(taxHoldScope: string): Promise<number>;

  /**
   * The FREEZE CAS sweep — the foreign-tax-hold lane's ledger leg: flips
   * EVERY held unclaimed-holding leg of one country/tax-year's ingest
   * scope (split_run_id = the tax-hold scope) from status
   * 'unclaimed_holding' to 'foreign_tax_hold' in one conditional
   * statement, and returns the count of legs this call froze. The status
   * predicate is the CAS: already-frozen, released, and settled legs are
   * untouched (a re-applied hold's sweep is a counted no-op), and legs
   * outside the scope — domestic legs, another territory's legs, other
   * escrow legs — never match.
   */
  freezeForeignTaxHolds(taxHoldScope: string): Promise<number>;

  /**
   * Writes the withholding tax credit verification of record for one
   * (country_code, tax_year) — upsert: a re-recording (the evidence
   * upgrade pending → verified) replaces the row atomically. The lane
   * refuses a 'verified' state without its treaty/evidence/verifier
   * provenance before this write; the state at rest is the release gate's
   * only key.
   */
  upsertWithholdingTaxCreditVerification(
    row: Omit<WithholdingTaxCreditVerificationRecord, 'id'>,
  ): Promise<WithholdingTaxCreditVerificationRecord>;

  /** One (country_code, tax_year)'s withholding credit verification of record. */
  getWithholdingTaxCreditVerification(
    countryCode: string,
    taxYear: number,
  ): Promise<WithholdingTaxCreditVerificationRecord | undefined>;

  /**
   * Writes the ISBN rights verification of record for one ISBN — upsert on
   * isbn: a re-verification replaces the row atomically. The lane refuses
   * a 'verified' state without its evidence provenance before this write.
   */
  upsertIsbnRightsVerification(
    row: Omit<IsbnRightsVerificationRecord, 'id'>,
  ): Promise<IsbnRightsVerificationRecord>;

  /** One ISBN's rights verification of record. */
  getIsbnRightsVerification(isbn: string): Promise<IsbnRightsVerificationRecord | undefined>;

  /**
   * Registers (or replaces) the returns-reserve policy of record for one
   * ISBN — upsert on isbn (the option-agreement precedent). The lane
   * validates the founder bands before this write; the schema's CHECKs
   * enforce them again at rest.
   */
  upsertBookReturnsReservePolicy(
    row: Omit<BookReturnsReservePolicyRecord, 'id'>,
  ): Promise<BookReturnsReservePolicyRecord>;

  /** One ISBN's returns-reserve policy of record. */
  getBookReturnsReservePolicy(isbn: string): Promise<BookReturnsReservePolicyRecord | undefined>;

  /**
   * The held book reserve credits, newest first (created_at DESC,
   * insertion order as tiebreak), bounded by limit — across ALL ISBNs.
   * Settled (released or fully-drawn) reserves are history, not holdings —
   * they never appear here.
   */
  listBookReturnsReserveCredits(limit?: number): Promise<LedgerTransactionRecord[]>;

  /**
   * ONE ISBN's reserve credits in EVERY state, oldest first (created_at
   * ASC, insertion order as tiebreak) — the FIFO draw ordering AND the
   * publishing gate's return_reserve_period_elapsed derivation, which
   * reads history (a settled reserve still proves its period ran), not
   * just the held balance.
   */
  listBookReturnsReserveCreditsByIsbn(isbn: string): Promise<LedgerTransactionRecord[]>;
  /**
   * The release/drawdown CAS — the settlement concurrency canon (0009)
   * applied to a held book reserve: flips ONE row from status
   * 'book_returns_reserve' to 'settled' (settled_at = the passed instant)
   * in a single conditional statement. Returns the row only when THIS call
   * won the transition; undefined when the id is unknown OR the reserve is
   * no longer held — the concurrent release or full-drawdown loser reads
   * exactly that and refuses. The flip happens BEFORE any money moves
   * (insert-as-lock, the payout-reversal precedent), so a crash mid-release
   * fails toward "nothing moved twice": the settled row with no
   * book_returns_reserve_release journal is the visible alarm.
   */
  settleBookReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Writes one book reserve drawdown of record: the append-only truth a
   * reserve spends against. UNIQUE on (reserve_ledger_id, source_event_id)
   * — a re-shipped return/chargeback event throws the unique violation,
   * never double-draws. UNIQUE on (reserve_ledger_id, drawn_before_cents)
   * — the insert-as-lock position arbiter.
   */
  insertBookReserveDrawdown(
    row: Omit<BookReserveDrawdownRecord, 'id'>,
  ): Promise<BookReserveDrawdownRecord>;

  /**
   * One reserve's drawdowns, oldest position first (drawn_before_cents
   * ASC): the derived spend truth.
   */
  listBookReserveDrawdowns(reserveLedgerId: string): Promise<BookReserveDrawdownRecord[]>;

  /**
   * Writes one publisher return chargeback of record. UNIQUE on event_id —
   * a re-shipped chargeback event throws the unique violation (the replay
   * surface); the lane reads the stored row and answers the counted no-op.
   */
  insertBookReturnChargeback(
    row: Omit<BookReturnChargebackRecord, 'id'>,
  ): Promise<BookReturnChargebackRecord>;

  /**
   * One ISBN's chargebacks, oldest first (created_at ASC, insertion order
   * as tiebreak): the FIFO ordering the outstanding-offset recovery reads.
   */
  listBookReturnChargebacksByIsbn(isbn: string): Promise<BookReturnChargebackRecord[]>;

  /**
   * Writes one chargeback offset application of record — the publisher's
   * recovery taken out of ONE held print allocation before author payouts
   * release. UNIQUE on (chargeback_id, holding_ledger_id) — a replayed
   * release throws the unique violation, never double-offsets. UNIQUE on
   * (chargeback_id, offset_before_cents) — the insert-as-lock position
   * arbiter: exactly one release wins an offset's next running position.
   */
  insertBookChargebackOffsetApplication(
    row: Omit<BookChargebackOffsetApplicationRecord, 'id'>,
  ): Promise<BookChargebackOffsetApplicationRecord>;

  /**
   * One chargeback's offset applications, oldest position first
   * (offset_before_cents ASC): the derived recovery truth.
   */
  listBookChargebackOffsetApplications(
    chargebackId: string,
  ): Promise<BookChargebackOffsetApplicationRecord[]>;

  // --- BaaS transfers ---
  insertBaasTransfer(row: Omit<BaasTransferRecord, 'id'>): Promise<BaasTransferRecord>;
  getBaasTransfer(id: string): Promise<BaasTransferRecord | undefined>;
  listBaasTransfers(limit?: number): Promise<BaasTransferRecord[]>;
  updateBaasTransferStatus(
    id: string,
    status: BaasTransferRecord['status'],
  ): Promise<BaasTransferRecord | undefined>;

  // --- Company dust ---
  insertCompanyDust(row: Omit<CompanyDustRecord, 'id'>): Promise<CompanyDustRecord>;
  listCompanyDustByRun(splitRunId: string): Promise<CompanyDustRecord[]>;

  // --- Compliance: tax profile, YTD, escrow ---
  getCreatorTaxProfile(creatorId: string): Promise<CreatorTaxProfile | undefined>;
  upsertCreatorTaxProfile(row: CreatorTaxProfile): Promise<CreatorTaxProfile>;
  getCreatorYtd(
    creatorId: string,
    taxYear: number,
  ): Promise<CreatorYtdEarnings | undefined>;
  upsertCreatorYtd(row: CreatorYtdEarnings): Promise<CreatorYtdEarnings>;
  insertTaxEscrow(row: Omit<TaxEscrowRecord, 'id'>): Promise<TaxEscrowRecord>;
  listTaxEscrowByCreator(creatorId: string, taxYear: number): Promise<TaxEscrowRecord[]>;

  // --- Sovereign vaults + disputes ---
  getVault(payeeId: string): Promise<SovereignVaultRecord | undefined>;
  listVaults(): Promise<SovereignVaultRecord[]>;
  upsertVault(row: SovereignVaultRecord): Promise<SovereignVaultRecord>;
  /**
   * The atomic vault mutation (migration 0009, audit H1): applies signed
   * bucket deltas in ONE conditional statement, with per-bucket floors the
   * database enforces — the sufficiency check moves out of the
   * read-modify-write window, so concurrent mutations can never
   * last-write-wins over each other and an over-spend is refused by the DB.
   *
   *   - `applied`      — the move happened; `vault` is the row after it.
   *   - `guard_failed` — the vault exists and a floor rejected the move
   *     (insufficient funds for the requested direction). Nothing changed.
   *   - `not_found`    — no vault exists and `create_if_missing` is false
   *     (or minting is impossible for the requested delta). Nothing changed.
   *
   * `create_if_missing` is the credit path: it mints the vault from zero at
   * the delta values (credits only — negative deltas with no vault to debit
   * are `not_found`), and the on-conflict arm still floor-guards adds to an
   * existing vault.
   */
  applyVaultDelta(input: VaultDeltaInput): Promise<ApplyVaultDeltaResult>;
  getVaultDispute(payeeId: string): Promise<VaultDisputeRecord | undefined>;
  upsertVaultDispute(row: VaultDisputeRecord): Promise<VaultDisputeRecord>;
  getCatalogDispute(workId: string): Promise<CatalogDisputeRecord | undefined>;
  upsertCatalogDispute(row: CatalogDisputeRecord): Promise<CatalogDisputeRecord>;

  // --- Recoupment ---
  getRecoupmentAdvance(creatorId: string): Promise<RecoupmentAdvanceRecord | undefined>;
  upsertRecoupmentAdvance(row: RecoupmentAdvanceRecord): Promise<RecoupmentAdvanceRecord>;
  listRecoupmentAdvances(): Promise<RecoupmentAdvanceRecord[]>;
  insertRecoupmentLedger(
    row: Omit<RecoupmentLedgerRecord, 'id'>,
  ): Promise<RecoupmentLedgerRecord>;
  listRecoupmentLedgerByRun(splitRunId: string): Promise<RecoupmentLedgerRecord[]>;

  // --- Payout holds + reversals ---
  getPayoutHold(transferId: string): Promise<PayoutHoldRecord | undefined>;
  insertPayoutHold(row: PayoutHoldRecord): Promise<PayoutHoldRecord>;
  updatePayoutHoldStatus(
    transferId: string,
    status: PayoutHoldRecord['status'],
  ): Promise<PayoutHoldRecord | undefined>;
  sumInFlightPayoutHolds(payeeId: string): Promise<number>;
  insertPayoutReversal(
    row: Omit<PayoutReversalRecord, 'id'>,
  ): Promise<PayoutReversalRecord>;
  getPayoutReversalByTransfer(
    transferId: string,
  ): Promise<PayoutReversalRecord | undefined>;
  /**
   * Finalizes the reversal lock row (migration 0009, H4) with the posted
   * journal and ledger ids; undefined when the row is gone.
   */
  updatePayoutReversal(
    id: string,
    patch: Pick<PayoutReversalRecord, 'journal_id' | 'ledger_transaction_id'>,
  ): Promise<PayoutReversalRecord | undefined>;
  /** Drops a reversal lock row whose money move was refused (retryable). */
  deletePayoutReversal(id: string): Promise<void>;

  // --- Webhook event ledgers (idempotent by unique event_id) ---
  getWebhookEvent(eventId: string): Promise<BaasWebhookEventRecord | undefined>;
  insertWebhookEvent(
    row: Omit<BaasWebhookEventRecord, 'id'>,
  ): Promise<BaasWebhookEventRecord>;
  getDspWebhookEvent(eventId: string): Promise<DspWebhookEventRecord | undefined>;
  insertDspWebhookEvent(
    row: Omit<DspWebhookEventRecord, 'id'>,
  ): Promise<DspWebhookEventRecord>;

  // --- Append-only hash-chained GL ---
  /**
   * Persists one journal and returns the record. The engine (ledger/chain.ts
   * + postJournal) supplies the chain state; omitted fields take the
   * canonical defaults (sequence 0, prev/entry hash '', state 'posted').
   */
  insertGlJournal(
    row: Omit<GlJournalRecord, 'id' | 'sequence' | 'prev_hash' | 'entry_hash' | 'state'> & {
      sequence?: number;
      prev_hash?: string;
      entry_hash?: string;
      state?: GlJournalRecord['state'];
    },
  ): Promise<GlJournalRecord>;
  insertGlEntry(row: Omit<GlEntryRecord, 'id'>): Promise<GlEntryRecord>;
  listGlJournals(): Promise<GlJournalRecord[]>;
  getLatestGlJournal(): Promise<GlJournalRecord | undefined>;
  listGlJournalsByRef(refType: string, refId: string): Promise<GlJournalRecord[]>;
  listGlEntries(): Promise<GlEntryRecord[]>;
  listGlEntriesByJournal(journalId: string): Promise<GlEntryRecord[]>;

  // --- Split-run reversals ---
  insertSplitReversal(row: Omit<SplitReversalRecord, 'id'>): Promise<SplitReversalRecord>;
  getSplitReversalByRun(splitRunId: string): Promise<SplitReversalRecord | undefined>;

  // --- SDK collection surfaces (migration 0007, Generation 16) ---
  // PR 3 owns ALL new-table Store methods: SDK PRs 4+ (clearance, matcher,
  // parsers) consume this surface and never touch store files. Lists order
  // by created_at with the store's insertion-order tie-break; unique
  // violations throw (quarantine-once for match_queue.event_id).

  /** Writes the CURRENT clearance state for one asset — one row per asset. */
  upsertClearance(row: MulClearanceRecord): Promise<MulClearanceRecord>;
  getClearanceForAsset(assetCbtCode: string): Promise<MulClearanceRecord | undefined>;
  /** Appends one lifecycle transition; history is read oldest-first. */
  insertClearanceTransition(
    row: Omit<MulClearanceTransitionRecord, 'id'>,
  ): Promise<MulClearanceTransitionRecord>;
  listClearanceTransitions(assetCbtCode: string): Promise<MulClearanceTransitionRecord[]>;

  /** Quarantines one event verbatim; rejects on a replayed event_id. */
  insertMatchQueueEntry(row: Omit<MatchQueueRecord, 'id'>): Promise<MatchQueueRecord>;
  getMatchQueueEntry(id: string): Promise<MatchQueueRecord | undefined>;
  /** The queue row carrying one content-derived event id — the recon
   * lanes' dedup/double-dip cross-reference read. Unique by schema, so the
   * result is a single row or undefined. */
  getMatchQueueEntryByEventId(
    eventId: string,
  ): Promise<MatchQueueRecord | undefined>;
  /** Newest first; optional status filter; bounded by limit. */
  listMatchQueueEntries(
    status?: MatchQueueRecord['status'],
    limit?: number,
  ): Promise<MatchQueueRecord[]>;
  /** matched stamps the CBT code; discarded closes without one. */
  resolveMatchQueueEntry(
    id: string,
    resolution: MatchQueueResolution,
  ): Promise<MatchQueueRecord | undefined>;

  insertStatementIngest(row: Omit<StatementIngestRecord, 'id'>): Promise<StatementIngestRecord>;
  getStatementIngest(id: string): Promise<StatementIngestRecord | undefined>;

  // --- Clearinghouse kernel + Sync Library seams (spec art_ZIdWlYUX,
  //     SyncMarketplaceRegistry amendment, migration 0008) ---

  /**
   * The kernel's getCreatorUct identity read — READ-ONLY. The UCT is the
   * signup-registry holder entry's root tag (minted at signup by the signup
   * route's raw SQL); ISNI comes from creator_profiles (0007). Returns
   * undefined when the creator has no root UCT — the kernel's typed
   * identity error upstream, never a mint, never a silent new identity.
   */
  getCreatorUct(creatorId: string): Promise<CreatorUctRecord | undefined>;

  /**
   * Upserts the migration-0008 catalog columns for one asset. The asset
   * itself must already exist (identity stays in cbt_assets) — a fresh
   * Postgres insert of an unknown cbt_code fails on the parent columns.
   */
  upsertSyncCatalogItem(
    row: Omit<SyncCatalogItemRecord, 'updated_at'> & { updated_at?: string },
  ): Promise<SyncCatalogItemRecord>;
  getSyncCatalogItem(cbtCode: string): Promise<SyncCatalogItemRecord | undefined>;
  /** Stable catalog read: cbt_code ASC. */
  listSyncCatalogItems(): Promise<SyncCatalogItemRecord[]>;

  /**
   * The licensing lane's write-back record. cbt_settlement_stamp is UNIQUE
   * — the server-minted stamp is the replay key; a duplicate insert throws
   * (23505 / UNIQUE) and the lane recovers by re-reading the existing row
   * (the settlement wire's idempotency precedent).
   */
  insertSyncLicensePurchase(
    row: Omit<SyncLicensePurchaseRecord, 'id' | 'created_at'>,
  ): Promise<SyncLicensePurchaseRecord>;
  getSyncLicensePurchaseByStamp(stamp: string): Promise<SyncLicensePurchaseRecord | undefined>;

  // --- Territory settlement seam (spec art_qNu4T32F, Top Markets) ---

  /**
   * READ-ONLY over the tier-universe royalty ledger (universal_royalty_ledger)
   * — the one table that carries territory, stamped by the settlement wire's
   * metadata. Returns the SDK-settled credits ONLY
   * (transaction_type 'SDK_ROYALTY_SETTLEMENT'), each projected to its
   * metadata.sdk.territory / metadata.sdk.split_run_id join key, bigint
   * cents. Production credits are written exclusively by the wire
   * (covnant-sdk/src/engine/wire.ts settleEvent, raw SQL) — this contract
   * adds the read seam, never a write path. Oldest first
   * (created_at ASC, transaction_id ASC).
   */
  listTerritorySettlements(): Promise<TerritorySettlementRecord[]>;

  // --- Operations back-office seam (spec art_Eis55ifL, the Operations tab) ---

  /**
   * The statement-ingest provenance list — the read half of the
   * statement_ingests surface (migration 0007; the write/get pair above).
   * Each ingested file's row verbatim: format, source, file_name, content,
   * parsed|failed status, event_count, error. Newest first (created_at
   * DESC, insertion order as tiebreak), bounded by limit.
   */
  listStatementIngests(limit?: number): Promise<StatementIngestRecord[]>;

  /**
   * The operator audit trail — the append-only admin_action_log read
   * (migration 0005): who (actor), what (action + target), and the
   * field-level before/after (changes: { field: { from, to } }). The table
   * is RLS service-role-only, and this store's production client is the
   * service role. Newest first (created_at DESC); the table defines no
   * tiebreak key, so rows sharing a timestamp carry no guaranteed relative
   * order. Local mirrors have no such table — they read honestly empty,
   * never fabricated rows.
   */
  listAdminActions(limit?: number): Promise<AdminActionRecord[]>;

  // --- Royalty recon job queue (migration 0011, spec art_7M0snhxc) ---
  //
  // The Deep Royalties orchestration surface. A recon job is the UCT
  // layer's ONE write — the enqueue route inserts and returns 202; the
  // CVT worker (standalone process, never a Vercel function) resolves jobs
  // through claim/complete/fail. Parsed line items go to the EXISTING
  // match_queue (0007), never a parallel table.

  /**
   * Enqueues one recon job: status 'pending', attempts 0, engine null
   * (resolved at claim), all timestamps null but created_at/updated_at —
   * which the store mints (the enqueue route carries no clock).
   */
  createReconJob(input: ReconJobInput): Promise<RoyaltyReconJobRecord>;
  /** The enqueue route's status poll read (the v1 completion path). */
  getReconJob(id: string): Promise<RoyaltyReconJobRecord | undefined>;
  /**
   * The worker's claim — the settlement concurrency canon (0009): the
   * oldest pending job, or a processing job whose claim went stale more
   * than RECON_STALE_CLAIM_MS ago (crash recovery — no sweeper process),
   * moves to 'processing' with claimed_at = now, started_at kept on its
   * first value, attempts incremented, engine resolved (null =
   * deterministic parse only). `now` is injectable so tests drive the
   * staleness window without fake timers; production calls claim with no
   * arguments. undefined = the pool is empty. Production concurrency:
   * SupabaseStore claims through the migration-0011 RPC
   * (FOR UPDATE SKIP LOCKED); SqliteStore claims inside BEGIN IMMEDIATE;
   * the in-memory backend is single-threaded by construction.
   */
  claimReconJob(now?: Date, engine?: string | null): Promise<RoyaltyReconJobRecord | undefined>;
  /**
   * Completes a claimed job: status 'completed' with the result summary
   * and completed_at. A terminal job is left untouched (the callback's
   * replay no-op reads the returned record). undefined = no such job.
   */
  completeReconJob(id: string, result: ReconJobResult): Promise<RoyaltyReconJobRecord | undefined>;
  /**
   * Fails a claimed job honestly: back to 'pending' while the retry budget
   * holds (attempts < RECON_MAX_ATTEMPTS, claimed_at cleared for the next
   * claim), terminal 'failed' with the error past it. The error is
   * recorded either way — a pending job with an error text carries its
   * most recent failure reason. undefined = no such job.
   */
  failReconJob(id: string, error: string): Promise<RoyaltyReconJobRecord | undefined>;

  //
  // The UCT credential vault surface (migration 0013, PR 5). Every method
  // takes the holder id as its FIRST argument — holder scoping is the
  // method-signature contract, not a caller's afterthought — and the
  // records that flow through carry only ciphertext (the routes encrypt
  // app-side before the store boundary, the Plaid token precedent).

  /**
   * Creates the holder's ACTIVE connection for a distributor — or, when a
   * connected row already exists for (holder, distributor), rotates its
   * ciphertexts in place (reconnect = update; the migration's partial
   * unique index makes one-active-row a database invariant too, so a race
   * that slips past this read fails closed on the insert). The store mints
   * the id and stamps both timestamps; `created_at` survives rotation
   * (the connection's age is the holder's tenure, not the password's).
   * The result states WHICH outcome happened — rotation is the store's
   * knowledge, never a caller's timestamp inference.
   */
  createDistributorConnection(
    input: DistributorConnectionInput,
  ): Promise<DistributorConnectionUpsert>;
  /**
   * The holder's rows, newest first — the status route's only read. Rows
   * carry ciphertext; the route projects them through toConnectionStatus
   * before responding.
   */
  listDistributorConnections(holderId: string): Promise<DistributorConnectionRecord[]>;
  /**
   * One holder-scoped point lookup. undefined when the id is unknown OR
   * belongs to another holder — the two are indistinguishable by design.
   */
  getDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined>;
  /**
   * The holder's explicit disconnect: status 'disconnected', ciphertexts
   * KEPT (the holder's history is theirs; a reconnect starts a fresh row).
   * undefined (no such row, or a foreign holder's row) mutates nothing and
   * the route answers the same 404 either way — no existence disclosure.
   */
  disconnectDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined>;

  /**
   * The Astra worker lane's enumeration (PR 6): every ACTIVE connection
   * across ALL holders, oldest insertion first — a sweep traverses each
   * holder's dashboards in the order they were connected. Carries
   * ciphertexts (the traversal decrypts them in memory); the route layer
   * never touches this method.
   */
  listActiveDistributorConnections(): Promise<DistributorConnectionRecord[]>;

  /**
   * The traversal's provenance write (PR 6). A verified outcome stamps
   * last_verified_at and clears last_error; an error outcome records the
   * reason and leaves last_verified_at (only successful traversals verify).
   * Neither ever changes connection status — disconnect is the holder's
   * explicit act. undefined for an unknown id.
   */
  markDistributorTraversal(
    id: string,
    outcome: DistributorTraversalOutcome,
  ): Promise<DistributorConnectionRecord | undefined>;

  // --- Brand licensing: Net Sales + tiered royalties + sub-license cascade
  // --- (PR 32, migration 0036) ---

  /**
   * Registers (or replaces) the tiered-royalty deal of record for one
   * license scope (`license:<license_id>`, migration 0036) — upsert on
   * scope_key: a re-registration replaces the row atomically (the
   * option-agreement/agency-policy discipline). The tier schedule is JSON
   * (the table's jsonb column) validated by the records module before it
   * ever reaches this seam; the caller increments version and preserves
   * the cumulative counters — never this method.
   */
  upsertLicensingRoyaltyDeal(
    row: Omit<LicensingRoyaltyDealRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingRoyaltyDealRecord>;

  /** One license scope's deal of record; undefined when none — the
   * cascade refuses (fail-closed), never guesses a schedule. */
  getLicensingRoyaltyDeal(
    scopeKey: string,
  ): Promise<LicensingRoyaltyDealRecord | undefined>;

  /**
   * Appends one executed royalty application — a tier walk's immutable
   * commit (migration 0036). UNIQUE per (deal_id, source_event_id) is the
   * replay guard; UNIQUE per (deal_id, cumulative_before_cents) is the
   * POSITION LOCK — a replayed walk or a lost position race throws the
   * unique violation, never a double application; the caller retries at
   * the advanced position.
   */
  insertLicensingRoyaltyApplication(
    row: Omit<LicensingRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingRoyaltyApplicationRecord>;

  /** One deal's executed applications, created_at ASC — the cumulative
   * ledger the next period's tier walk reads. */
  listLicensingRoyaltyApplications(
    dealId: string,
  ): Promise<LicensingRoyaltyApplicationRecord[]>;

  /**
   * Registers (or replaces) the double-taxation treaty rate of record for
   * one (source_country, residence_country) pair (migration 0036) — upsert
   * on the pair: a re-registration converges (the newest rate governs the
   * next walk).
   */
  upsertLicensingTreatyRate(
    row: Omit<LicensingTreatyRateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingTreatyRateRecord>;

  /** One (source, residence) pair's treaty rate; undefined when no treaty
   * of record exists — the cascade refuses (fail-closed), never assumes
   * 0%: the deal's withholding_default_bps or a HOLD governs. */
  getLicensingTreatyRate(
    sourceCountry: string,
    residenceCountry: string,
  ): Promise<LicensingTreatyRateRecord | undefined>;

  /**
   * Registers (or replaces) a master-approved sub-licensee — upsert on
   * (scope_key, sub_licensee_id) (migration 0036): the master royalty
   * override of record the cascade applies to that regional party's
   * reports.
   */
  upsertLicensingSubLicensee(
    row: Omit<LicensingSubLicenseeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseeRecord>;

  /** One (scope, sub-licensee) registration; undefined when none — the
   * cascade refuses an unregistered sub-licensee's report (fail-closed). */
  getLicensingSubLicensee(
    scopeKey: string,
    subLicenseeId: string,
  ): Promise<LicensingSubLicenseeRecord | undefined>;

  /** Every sub-licensee registered under one master scope, created_at
   * ASC — the cascade's regional discovery surface. */
  listLicensingSubLicensees(
    scopeKey: string,
  ): Promise<LicensingSubLicenseeRecord[]>;

  /**
   * Records one regional sub-licensee gross report (migration 0036) —
   * upsert on source_event_id (the once-only key): a re-shipped manifest
   * converges, never a double report row.
   */
  upsertLicensingSubLicenseReport(
    row: Omit<LicensingSubLicenseReportRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseReportRecord>;

  /** One report of record by its source event id; undefined when none —
   * fail-closed. */
  getLicensingSubLicenseReport(
    sourceEventId: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined>;

  /** Every report filed under one master scope, created_at ASC — the
   * audit trail the release path replays. */
  listLicensingSubLicenseReports(
    scopeKey: string,
  ): Promise<LicensingSubLicenseReportRecord[]>;

  /**
   * The evidenced audit reconciliation CAS — flips ONE report row from
   * audit_state 'unknown' to 'reconciled' (evidence_ref = the reconciler's
   * citation, reconciled_by = the actor) in a single conditional statement
   * (migration 0036's fail-closed audit gate). Returns the row only when
   * THIS call won the transition; undefined when the id is unknown OR the
   * row is already reconciled — the caller lost the race (or replayed).
   * The flip happens BEFORE any proceeds release: a crash mid-release
   * fails toward "nothing moved twice" — the reconciled report with no
   * proceeds journal is the visible alarm.
   */
  reconcileLicensingSubLicenseReport(
    id: string,
    evidenceRef: string,
    reconciledBy: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined>;

  /**
   * Registers (or replaces) the advance / minimum-guarantee commitment of
   * record for one (scope_key, commitment_ref) (migration 0037) — upsert
   * converges: a re-registration replaces the row atomically (the
   * option-agreement/agency-policy discipline). The recouped_cents counter
   * is bookkeeping — the append-only applications are the truth.
   */
  upsertLicensingMgCommitment(
    row: Omit<LicensingMgCommitmentRecord, 'id' | 'created_at' | 'updated_at' | 'recouped_cents'> & {
      recouped_cents?: number;
    },
  ): Promise<LicensingMgCommitmentRecord>;

  /** One (scope, commitment ref)'s advance of record; undefined when none
   * — the recoupment and term-close lanes refuse (fail-closed). */
  getLicensingMgCommitment(
    scopeKey: string,
    commitmentRef: string,
  ): Promise<LicensingMgCommitmentRecord | undefined>;

  /** Every advance registered under one license scope, created_at ASC —
   * the recoupment pass's routing candidates. */
  listLicensingMgCommitments(scopeKey: string): Promise<LicensingMgCommitmentRecord[]>;

  /**
   * Appends one executed recoupment application — an event's earned
   * royalty offsetting one advance (migration 0037). UNIQUE per
   * (commitment_id, source_event_id) is the replay guard; UNIQUE per
   * (commitment_id, recouped_before_cents) is the POSITION LOCK — a
   * replayed event or a lost position race throws the unique violation,
   * never a double application; the caller retries at the advanced
   * position.
   */
  insertLicensingMgRecoupmentApplication(
    row: Omit<LicensingMgRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingMgRecoupmentApplicationRecord>;

  /** One advance's executed recoupment applications, created_at ASC —
   * the append-only truth the position derives from. */
  listLicensingMgRecoupmentApplications(
    commitmentId: string,
  ): Promise<LicensingMgRecoupmentApplicationRecord[]>;

  /**
   * Records the contract term close of record per (commitment_id, term)
   * (migration 0037) — upsert on the pair: the once-only close, a replay
   * converges on the recorded shortfall and invoice of record.
   */
  upsertLicensingMgTermClose(
    row: Omit<LicensingMgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingMgTermCloseRecord>;

  /** One (commitment, term)'s close of record; undefined when the term is
   * not closed — the shortfall invoice never guessed. */
  getLicensingMgTermClose(
    commitmentId: string,
    term: string,
  ): Promise<LicensingMgTermCloseRecord | undefined>;

  /** Every term close filed under one license scope, created_at ASC —
   * the audit trail of the guarantee's enforcement. */
  listLicensingMgTermCloses(scopeKey: string): Promise<LicensingMgTermCloseRecord[]>;

  /**
   * Registers (or replaces) the audit reserve escrow's policy of record
   * for one scope key (migration 0037) — upsert on scope_key: a
   * re-registration converges (the newest rate governs the next routing).
   */
  upsertLicensingAuditReservePolicy(
    row: Omit<LicensingAuditReservePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingAuditReservePolicyRecord>;

  /** One scope's reserve policy of record; undefined when none — the
   * routing lane routes nothing (fail-closed, never a guessed rate). */
  getLicensingAuditReservePolicy(
    scopeKey: string,
  ): Promise<LicensingAuditReservePolicyRecord | undefined>;

  /**
   * Records the verified reconciliation of record for one reserve —
   * insert-as-lock (UNIQUE per reserve_ledger_id): the FIRST reconciliation
   * wins, a concurrent second insert throws the unique violation. The
   * release reads this row FAIL-CLOSED — no reconciliation of record, no
   * release.
   */
  insertLicensingAuditReserveReconciliation(
    row: Omit<LicensingAuditReserveReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveReconciliationRecord>;

  /** One reserve's reconciliation of record; undefined when none — the
   * release refuses (fail-closed). */
  getLicensingAuditReserveReconciliation(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveReconciliationRecord | undefined>;

  /**
   * Appends one position-locked reserve drawdown — a quarterly audit
   * reconciliation or inventory write-off spending the escrow (migration
   * 0037). UNIQUE per (reserve_ledger_id, source_event_id) is the replay
   * guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
   * position lock — a replayed event or a lost race throws the unique
   * violation, never a double drawdown; the caller re-derives from the
   * append-only truth.
   */
  insertLicensingAuditReserveDrawdown(
    row: Omit<LicensingAuditReserveDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveDrawdownRecord>;

  /** One reserve's drawdowns, created_at ASC — the append-only truth the
   * remaining balance derives from. */
  listLicensingAuditReserveDrawdowns(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveDrawdownRecord[]>;

  /**
   * Upserts the licensing payout gate's states of record for one payee in
   * one license scope (migration 0037) — UNIQUE per (payee_id, scope_key):
   * an upsert converges (the newest states govern the next dispatch).
   */
  upsertLicensingPayoutGateState(
    row: Omit<
      LicensingPayoutGateStateRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<LicensingPayoutGateStateRecord>;

  /**
   * One payee × scope's gate states of record; undefined when none — the
   * licensing vertical's compliance state resolves fail-closed through
   * this (absent → null → the gate refuses with vertical_state_unknown).
   */
  getLicensingPayoutGateState(
    payeeId: string,
    scopeKey: string,
  ): Promise<LicensingPayoutGateStateRecord | undefined>;

  /**
   * Flips ONE audit-reserve escrow ledger row from status
   * 'audit_reserve_escrow' to 'settled' (settled_at = the passed instant)
   * in a single conditional statement. Returns the row only when THIS
   * call won the transition; undefined when the id is unknown OR the
   * reserve is no longer held — the concurrent release or full-drawdown
   * loser reads exactly that and refuses. The flip happens BEFORE any
   * money moves (insert-as-lock, the payout-reversal precedent), so a
   * crash mid-release fails toward "nothing moved twice".
   */
  settleLicensingAuditReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * One royalty application of record by (deal_id, source_event_id);
   * undefined when none — the recoupment pass reads the committed
   * application the cascade wrote (the earnings of record), never a
   * recomputation.
   */
  getLicensingRoyaltyApplication(
    dealId: string,
    sourceEventId: string,
  ): Promise<LicensingRoyaltyApplicationRecord | undefined>;

  // --- The NIL lane: the compliance parser + roster waterfall (PR 34,
  // --- migration 0038) ---

  /**
   * Registers (or replaces) the adjusted direct revenue-sharing program of
   * record for one scope (migration 0038) — upsert on scope_key: a
   * re-registration replaces the row atomically (the option-agreement
   * discipline). The newest rates govern the next pool walk.
   */
  upsertNilRevenueShareProgram(
    row: Omit<NilRevenueShareProgramRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRevenueShareProgramRecord>;

  /** One scope's program of record; undefined when none — the pool walk
   * refuses (fail-closed), never guesses rates. */
  getNilRevenueShareProgram(
    scopeKey: string,
  ): Promise<NilRevenueShareProgramRecord | undefined>;

  /**
   * Registers (or replaces) the tiered roster waterfall config of record
   * for one (scope, key) (migration 0038) — upsert converges: a
   * re-registration replaces the row atomically. The tier schedule is
   * JSON validated by the records module before it reaches this seam.
   */
  upsertNilRosterWaterfall(
    row: Omit<NilRosterWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRosterWaterfallRecord>;

  /** One (scope, key)'s waterfall of record; undefined when none — the
   * pool walk refuses (fail-closed), never invents a schedule. */
  getNilRosterWaterfall(
    scopeKey: string,
    waterfallKey: string,
  ): Promise<NilRosterWaterfallRecord | undefined>;

  /**
   * Registers (or replaces) the institutional cap allowance of record for
   * one (school, year) (migration 0038) — upsert converges.
   */
  upsertNilSchoolCap(
    row: Omit<NilSchoolCapRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilSchoolCapRecord>;

  /** One (school, year)'s cap of record; undefined when none — the
   * associated-entity holdback holds (fail-closed), never assumes a cap. */
  getNilSchoolCap(
    schoolId: string,
    capYear: string,
  ): Promise<NilSchoolCapRecord | undefined>;

  /**
   * Records the verified cap verification of record per (school, year) —
   * the associated-entity holdback's release key (migration 0038). UNIQUE
   * per (school_id, cap_year) is the INSERT-AS-LOCK: the FIRST
   * verification wins; a concurrent second insert throws the unique
   * violation, never a double verification.
   */
  insertNilCapVerification(
    row: Omit<NilCapVerificationRecord, 'id' | 'created_at'>,
  ): Promise<NilCapVerificationRecord>;

  /** One (school, year)'s verification of record; undefined when none —
   * the payout gate reads fail-closed: no verification, money holds. */
  getNilCapVerification(
    schoolId: string,
    capYear: string,
  ): Promise<NilCapVerificationRecord | undefined>;

  /**
   * Registers (or replaces) the valid business purpose audit of record
   * for one NIL contract (migration 0038) — upsert converges: the $600
   * flag ('flagged') heals to 'nil_cleared' when the mandatory metadata
   * matches; never the reverse through this table.
   */
  upsertNilDealComplianceAudit(
    row: Omit<NilDealComplianceAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilDealComplianceAuditRecord>;

  /** One contract's audit of record; undefined when none — the payout
   * gate reads fail-closed (an unflagged deal needs no audit row). */
  getNilDealComplianceAudit(
    nilContractId: string,
  ): Promise<NilDealComplianceAuditRecord | undefined>;

  /**
   * Appends one executed deal payout application (migration 0038). UNIQUE
   * per source_event_id is the replay guard — a re-walked event throws
   * the unique violation, never a double payout; the caller reads the
   * committed application through the getter.
   */
  insertNilPayoutApplication(
    row: Omit<NilPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPayoutApplicationRecord>;

  /** One payout application of record by its source event id; undefined
   * when none — the replay check's read. */
  getNilPayoutApplication(
    sourceEventId: string,
  ): Promise<NilPayoutApplicationRecord | undefined>;

  /**
   * Appends one executed pool application — the adjusted calculator's
   * pool math and the tiered roster walk's committed slices (migration
   * 0038). UNIQUE per source_event_id is the replay guard — a re-walked
   * pool event throws, never a double distribution.
   */
  insertNilPoolApplication(
    row: Omit<NilPoolApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPoolApplicationRecord>;

  /** One pool application of record by its source event id; undefined
   * when none — the replay check's read. */
  getNilPoolApplication(
    sourceEventId: string,
  ): Promise<NilPoolApplicationRecord | undefined>;

  /**
   * Appends one executed group NIL equal split (migration 0038). UNIQUE
   * per source_event_id is the replay guard — a re-shipped distribution
   * splits once, never twice.
   */
  insertNilGroupSplit(
    row: Omit<NilGroupSplitRecord, 'id' | 'created_at'>,
  ): Promise<NilGroupSplitRecord>;

  /** One group split of record by its source event id; undefined when
   * none — the replay check's read. */
  getNilGroupSplit(
    sourceEventId: string,
  ): Promise<NilGroupSplitRecord | undefined>;

  /**
   * Registers (or replaces) the state compliance matrix's rule of record
   * for one (state, rule_code) (migration 0038) — upsert converges: the
   * newest rule governs the next payout execution.
   */
  upsertNilStateRule(
    row: Omit<NilStateRuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilStateRuleRecord>;

  /** One (state, rule)'s enforcement of record; undefined when none —
   * the state matrix reads fail-closed for gated categories. */
  getNilStateRule(
    stateJurisdictionCode: string,
    ruleCode: string,
  ): Promise<NilStateRuleRecord | undefined>;

  /**
   * Upserts the NIL payout gate's states of record for one payee in one
   * school (migration 0038) — UNIQUE per (payee_id, school_id): an upsert
   * converges (a verification heals 'unknown'; states never regress
   * through this table).
   */
  upsertNilPayoutGateState(
    row: Omit<NilPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilPayoutGateStateRecord>;

  /**
   * One payee × school's gate states of record; undefined when none — the
   * NIL payout gate resolves fail-closed through this (absent → null →
   * the gate refuses).
   */
  getNilPayoutGateState(
    payeeId: string,
    schoolId: string,
  ): Promise<NilPayoutGateStateRecord | undefined>;

  /**
   * Registers (or replaces) the NIL audit escrow's founder-banded rate of
   * record for one scope (migration 0039) — upsert converges: the newest
   * rate governs the next routing.
   */
  upsertNilAuditEscrowPolicy(
    row: Omit<NilAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAuditEscrowPolicyRecord>;

  /** One scope's escrow rate of record; undefined when none — the routing
   * lane refuses fail-closed (no policy, no routing). */
  getNilAuditEscrowPolicy(scopeKey: string): Promise<NilAuditEscrowPolicyRecord | undefined>;

  /**
   * Appends one position-locked escrow drawdown (migration 0039) — UNIQUE
   * per (reserve_ledger_id, source_event_id) is the replay guard, UNIQUE
   * per (reserve_ledger_id, drawn_before_cents) is the position lock: a
   * replayed draw or a lost race throws here, never a double drawdown.
   */
  insertNilAuditEscrowDrawdown(
    row: Omit<NilAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowDrawdownRecord>;

  /** One escrow bucket's drawdowns in spend order — the append-only
   * truth the balance derives from. */
  listNilAuditEscrowDrawdowns(reserveLedgerId: string): Promise<NilAuditEscrowDrawdownRecord[]>;

  /**
   * Records the verified reconciliation of record for one escrow bucket
   * (migration 0039) — insert-as-lock, UNIQUE per reserve_ledger_id: the
   * FIRST reconciliation of record wins; a concurrent second insert
   * throws (the caller reads the winner through the getter).
   */
  insertNilAuditEscrowReconciliation(
    row: Omit<NilAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowReconciliationRecord>;

  /** One escrow bucket's reconciliation of record; undefined when none —
   * the release gate reads fail-closed through this. */
  getNilAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowReconciliationRecord | undefined>;

  /**
   * Settles one held `nil_audit_escrow` bucket row — the single-statement
   * CAS: the row flips only while it is still held; the caller that lost
   * the race (or replayed) reads undefined.
   */
  settleNilAuditEscrow(id: string, settledAt: string): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Registers (or replaces) the NIL advance of record for one contract
   * (migration 0039) — upsert converges: the newest terms govern the
   * next pro-rated clawback calculation.
   */
  upsertNilAdvanceSchedule(
    row: Omit<NilAdvanceScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAdvanceScheduleRecord>;

  /** One contract's advance terms of record; undefined when none — the
   * portal-entry lane computes nothing without them. */
  getNilAdvanceSchedule(nilContractId: string): Promise<NilAdvanceScheduleRecord | undefined>;

  /**
   * Records the transfer portal entry of record for one (contract,
   * athlete) (migration 0039) — insert-as-lock, UNIQUE per (contract,
   * athlete): the FIRST entry wins; a re-shipped sheet or a lost race
   * throws (the caller reads the winner through the getter).
   */
  insertNilTransferPortalEntry(
    row: Omit<NilTransferPortalEntryRecord, 'id' | 'created_at'>,
  ): Promise<NilTransferPortalEntryRecord>;

  /** One (contract, athlete)'s portal entry of record; undefined when
   * none — the replay guard's read. */
  getNilTransferPortalEntry(
    nilContractId: string,
    athleteId: string,
  ): Promise<NilTransferPortalEntryRecord | undefined>;

  /**
   * Records the pro-rated unearned-advance clawback of record for one
   * portal entry (migration 0039) — UNIQUE per portal_entry_id: the
   * calculation and its `nil_unearned_clawback` debit hold land once;
   * a concurrent second insert throws.
   */
  insertNilUnearnedClawback(
    row: Omit<NilUnearnedClawbackRecord, 'id' | 'created_at'>,
  ): Promise<NilUnearnedClawbackRecord>;

  /** One portal entry's clawback of record; undefined when none. */
  getNilUnearnedClawback(portalEntryId: string): Promise<NilUnearnedClawbackRecord | undefined>;

  // -------------------------------------------------------------------------
  // Spatial POS + occupancy royalties + zone allocation (PR 36, migration
  // 0040) — the founder spatial directive's durable facts: the schedules,
  // policies, assignments, and throughput tracker the walks read, and the
  // three append-only application ledgers the walks write.
  // -------------------------------------------------------------------------

  /**
   * Registers (or replaces) the occupancy royalty schedule of record for
   * one (venue, year) — UNIQUE per (venue_id, year): the newest schedule
   * governs the next walk.
   */
  upsertSpatialOccupancyTierSchedule(
    row: Omit<SpatialOccupancyTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOccupancyTierScheduleRecord>;

  /** One venue-year's schedule of record; undefined when none — the walk
   * refuses fail-closed (no schedule, no royalty). */
  getSpatialOccupancyTierSchedule(
    venueId: string,
    year: string,
  ): Promise<SpatialOccupancyTierScheduleRecord | undefined>;

  /**
   * Registers (or replaces) the shared facility overhead policy of record
   * for one (venue, year) — UNIQUE per (venue_id, year).
   */
  upsertSpatialOverheadPolicy(
    row: Omit<SpatialOverheadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOverheadPolicyRecord>;

  /** One venue-year's overhead policy of record; undefined when none —
   * every IP distribution refuses fail-closed (no policy, no deduction,
   * no royalty). */
  getSpatialOverheadPolicy(
    venueId: string,
    year: string,
  ): Promise<SpatialOverheadPolicyRecord | undefined>;

  /**
   * Registers (or replaces) the assigned IP owner of record for one
   * (venue, zone) — UNIQUE per (venue_id, zone_code): the newest
   * assignment governs the next zone walk.
   */
  upsertSpatialZoneAssignment(
    row: Omit<SpatialZoneAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialZoneAssignmentRecord>;

  /** One venue-zone's assignment of record; undefined when none — the
   * zone walk skips fail-closed (never guessed routing). */
  getSpatialZoneAssignment(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialZoneAssignmentRecord | undefined>;

  /**
   * Registers (or replaces) the micro-royalty rate of record for one
   * (venue, zone) — UNIQUE per (venue_id, zone_code).
   */
  upsertSpatialMicroPolicy(
    row: Omit<SpatialMicroPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMicroPolicyRecord>;

  /** One venue-zone's micro rates of record; undefined when none — the
   * telemetry walk skips fail-closed. */
  getSpatialMicroPolicy(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialMicroPolicyRecord | undefined>;

  /**
   * Advances the cumulative annual throughput of record for one (venue,
   * year) by the row's entries — UNIQUE per (venue_id, year): the tracker
   * converges (an upsert adds); the walk reads the position BEFORE this
   * advance through the getter.
   */
  advanceSpatialThroughputYear(
    venueId: string,
    year: string,
    entriesAdded: number,
  ): Promise<SpatialThroughputYearRecord>;

  /** One venue-year's cumulative throughput of record; undefined when no
   * row has advanced yet (the walk's position starts at zero). */
  getSpatialThroughputYear(
    venueId: string,
    year: string,
  ): Promise<SpatialThroughputYearRecord | undefined>;

  /**
   * Appends one executed occupancy royalty application — the Adjusted
   * Location Sales calculator's legs, the shared overhead deduction, and
   * the tier walk's committed bands (migration 0040). UNIQUE per
   * source_event_id is the replay guard — a re-walked event throws, never
   * a double royalty.
   */
  insertSpatialRoyaltyApplication(
    row: Omit<SpatialRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialRoyaltyApplicationRecord>;

  /** One royalty application of record by its source event id; undefined
   * when none — the replay check's read. */
  getSpatialRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SpatialRoyaltyApplicationRecord | undefined>;

  /**
   * Appends one executed zone allocation — the zone's sales routed to the
   * assigned IP owner's waterfall, overhead-first (migration 0040).
   * UNIQUE per source_event_id is the replay guard — a re-walked sale
   * throws, never a double allocation.
   */
  insertSpatialZoneAllocation(
    row: Omit<SpatialZoneAllocationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialZoneAllocationRecord>;

  /** One zone allocation of record by its source event id; undefined when
   * none — the replay check's read. */
  getSpatialZoneAllocation(
    sourceEventId: string,
  ): Promise<SpatialZoneAllocationRecord | undefined>;

  /**
   * Appends one executed micro-royalty — the dwell/session legs and the
   * exact unit-price math (migration 0040). UNIQUE per source_event_id is
   * the replay guard — a re-walked telemetry event throws, never a double
   * micro-payout.
   */
  insertSpatialMicroRoyalty(
    row: Omit<SpatialMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<SpatialMicroRoyaltyRecord>;

  /** One micro-royalty of record by its source event id; undefined when
   * none — the replay check's read. */
  getSpatialMicroRoyalty(
    sourceEventId: string,
  ): Promise<SpatialMicroRoyaltyRecord | undefined>;

  // -----------------------------------------------------------------
  // PR 37 — spatial commitments (migration 0041): the CapEx recoupment
  // offset ledger, the quarterly Minimum Spatial Guarantee, the
  // temporary pop-up decommissioning audit, the SPATIAL_AUDIT_ESCROW,
  // and the durable spatial payout-gate states.
  // -----------------------------------------------------------------

  /**
   * Registers (or replaces) the allowable CapEx commitment of record for
   * one (scope, capex_ref) (migration 0041) — upsert converges: the
   * newest registered cost governs the next offset walk.
   */
  upsertSpatialCapexCommitment(
    row: Omit<SpatialCapexCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialCapexCommitmentRecord>;

  /** One CapEx commitment of record; undefined when none — the offset
   * walk's scope read. */
  getSpatialCapexCommitment(
    scopeKey: string,
    capexRef: string,
  ): Promise<SpatialCapexCommitmentRecord | undefined>;

  /** One scope's CapEx commitments in registration order — the offset
   * walk's OLDEST-FIRST input. */
  listSpatialCapexCommitments(scopeKey: string): Promise<SpatialCapexCommitmentRecord[]>;

  /**
   * Appends one position-locked CapEx offset application (migration
   * 0041) — UNIQUE per (commitment_id, source_event_id) is the replay
   * guard, UNIQUE per (commitment_id, offset_before_cents) is the
   * position lock: a replayed royalty or a lost race throws here, never
   * a double offset.
   */
  insertSpatialCapexApplication(
    row: Omit<SpatialCapexApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialCapexApplicationRecord>;

  /** One commitment's offset applications in append order — the
   * amortization schedule of record. */
  listSpatialCapexApplications(commitmentId: string): Promise<SpatialCapexApplicationRecord[]>;

  /**
   * Registers (or replaces) the quarterly Minimum Spatial Guarantee of
   * record for one operator × venue (migration 0041) — upsert
   * converges: the newest priced terms govern the next close.
   */
  upsertSpatialMsgCommitment(
    row: Omit<SpatialMsgCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgCommitmentRecord>;

  /** One operator × venue guarantee of record; undefined when none —
   * the close lane refuses fail-closed without it. */
  getSpatialMsgCommitment(scopeKey: string): Promise<SpatialMsgCommitmentRecord | undefined>;

  /**
   * Records the quarter's MSG close of record (migration 0041) — UNIQUE
   * per (commitment_id, quarter): the once-only close; a replay
   * converges on the recorded shortfall and invoice of record.
   */
  upsertSpatialMsgTermClose(
    row: Omit<SpatialMsgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgTermCloseRecord>;

  /** One (commitment, quarter)'s close of record; undefined when the
   * quarter is not yet closed. */
  getSpatialMsgTermClose(
    commitmentId: string,
    quarter: string,
  ): Promise<SpatialMsgTermCloseRecord | undefined>;

  /** One venue's occupancy royalty applications — the MSG close's
   * earnings reads (period-filtered in the lane). */
  listSpatialRoyaltyApplicationsByVenue(venueId: string): Promise<SpatialRoyaltyApplicationRecord[]>;

  /** One venue's zone allocations — the MSG close's earnings reads. */
  listSpatialZoneAllocationsByVenue(venueId: string): Promise<SpatialZoneAllocationRecord[]>;

  /** One venue's micro-royalties — the MSG close's earnings reads. */
  listSpatialMicroRoyaltiesByVenue(venueId: string): Promise<SpatialMicroRoyaltyRecord[]>;

  /**
   * Records the temporary pop-up experience of record (migration 0041)
   * — insert-as-lock, UNIQUE per popup_ref: the FIRST registration
   * wins; a re-shipped sheet or a lost race throws (the caller reads
   * the winner through the getter).
   */
  insertSpatialPopupExperience(
    row: Omit<SpatialPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPopupExperienceRecord>;

  /** One pop-up experience of record; undefined when none — the
   * decommissioning gate's fail-closed read. */
  getSpatialPopupExperience(popupRef: string): Promise<SpatialPopupExperienceRecord | undefined>;

  /**
   * Records one post-event inventory write-off calculation of record
   * (migration 0041) — UNIQUE per (popup_experience_id,
   * source_event_id): a replayed calculation throws, never a
   * double-priced write-off.
   */
  insertSpatialPopupWriteoff(
    row: Omit<SpatialPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupWriteoffRecord>;

  /** One pop-up's write-off calculations in append order — the
   * decommissioning gate's enforcement read. */
  listSpatialPopupWriteoffs(popupExperienceId: string): Promise<SpatialPopupWriteoffRecord[]>;

  /**
   * Records the site restoration reserve of record for one pop-up
   * experience (migration 0041) — insert-as-lock, UNIQUE per
   * popup_experience_id: the FIRST reserve wins; a concurrent second
   * insert throws.
   */
  insertSpatialPopupRestorationReserve(
    row: Omit<SpatialPopupRestorationReserveRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupRestorationReserveRecord>;

  /** One pop-up's restoration reserve of record; undefined when none —
   * the decommissioning gate's fail-closed read. */
  getSpatialPopupRestorationReserve(
    popupExperienceId: string,
  ): Promise<SpatialPopupRestorationReserveRecord | undefined>;

  /**
   * Registers (or replaces) the SPATIAL_AUDIT_ESCROW's founder-banded
   * rate of record for one scope (migration 0041) — upsert converges:
   * the newest rate governs the next routing.
   */
  upsertSpatialAuditEscrowPolicy(
    row: Omit<SpatialAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialAuditEscrowPolicyRecord>;

  /** One scope's escrow rate of record; undefined when none — the
   * routing lane refuses fail-closed (no policy, no routing). */
  getSpatialAuditEscrowPolicy(scopeKey: string): Promise<SpatialAuditEscrowPolicyRecord | undefined>;

  /**
   * Appends one position-locked escrow drawdown (migration 0041) —
   * UNIQUE per (reserve_ledger_id, source_event_id) is the replay
   * guard, UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
   * position lock: a replayed draw or a lost race throws here, never a
   * double drawdown.
   */
  insertSpatialAuditEscrowDrawdown(
    row: Omit<SpatialAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowDrawdownRecord>;

  /** One escrow bucket's drawdowns in spend order — the append-only
   * truth the balance derives from. */
  listSpatialAuditEscrowDrawdowns(reserveLedgerId: string): Promise<SpatialAuditEscrowDrawdownRecord[]>;

  /**
   * Records the verified reconciliation of record for one escrow bucket
   * (migration 0041) — insert-as-lock, UNIQUE per reserve_ledger_id:
   * the FIRST reconciliation of record wins; a concurrent second insert
   * throws (the caller reads the winner through the getter).
   */
  insertSpatialAuditEscrowReconciliation(
    row: Omit<SpatialAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowReconciliationRecord>;

  /** One escrow bucket's reconciliation of record; undefined when none —
   * the release gate reads fail-closed through this. */
  getSpatialAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowReconciliationRecord | undefined>;

  /**
   * Settles one held `spatial_audit_escrow` bucket row — the
   * single-statement CAS: the row flips only while it is still held;
   * the caller that lost the race (or replayed) reads undefined.
   */
  settleSpatialAuditEscrow(id: string, settledAt: string): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Upserts the spatial payout gate's states of record for one payee in
   * one venue (migration 0041) — UNIQUE per (payee_id, venue_id): an
   * upsert converges (a verification heals 'unknown'; states never
   * regress through this table).
   */
  upsertSpatialPayoutGateState(
    row: Omit<SpatialPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPayoutGateStateRecord>;

  /**
   * One payee × venue's gate states of record; undefined when none —
   * the spatial payout gate resolves fail-closed through this (absent →
   * null → the gate refuses).
   */
  getSpatialPayoutGateState(
    payeeId: string,
    venueId: string,
  ): Promise<SpatialPayoutGateStateRecord | undefined>;

  // -------------------------------------------------------------------------
  // PR 38 — the fitness lane (migration 0042): the founder fitness
  // directive's durable facts of record — the tier schedules, rate
  // policies, partnerships, waterfalls, and trackers the walks read, and
  // the append-only application ledgers the walks write.
  // -------------------------------------------------------------------------

  /**
   * Registers (or replaces) the trainer royalty tier schedule of record
   * for one (trainer, program) — UNIQUE per (trainer_id, program_id): the
   * newest schedule governs the next walk.
   */
  upsertFitnessTrainerTierSchedule(
    row: Omit<FitnessTrainerTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessTrainerTierScheduleRecord>;

  /** One trainer-program's tier schedule of record; undefined when none —
   * the royalty walk refuses fail-closed (no schedule, no tier payout). */
  getFitnessTrainerTierSchedule(
    trainerId: string,
    programId: string,
  ): Promise<FitnessTrainerTierScheduleRecord | undefined>;

  /**
   * Registers (or replaces) the sync music policy of record for one
   * program — UNIQUE per program_id: the per-workout master and
   * publishing rates deducted BEFORE the trainer net share.
   */
  upsertFitnessSyncMusicPolicy(
    row: Omit<FitnessSyncMusicPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessSyncMusicPolicyRecord>;

  /** One program's sync music policy of record; undefined when none — a
   * class-revenue row skips fail-closed (the walk never guesses a music
   * rate). */
  getFitnessSyncMusicPolicy(
    programId: string,
  ): Promise<FitnessSyncMusicPolicyRecord | undefined>;

  /**
   * Registers (or replaces) the live-event server load policy of record
   * for one program — UNIQUE per program_id.
   */
  upsertFitnessLiveLoadPolicy(
    row: Omit<FitnessLiveLoadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveLoadPolicyRecord>;

  /** One program's live load policy of record; undefined when none — a
   * live broadcast row skips fail-closed. */
  getFitnessLiveLoadPolicy(
    programId: string,
  ): Promise<FitnessLiveLoadPolicyRecord | undefined>;

  /**
   * Registers (or replaces) the studio franchise policy of record for one
   * franchise code — UNIQUE per studio_franchise_code: the license
   * override on certified content and the network fee.
   */
  upsertFitnessFranchisePolicy(
    row: Omit<FitnessFranchisePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessFranchisePolicyRecord>;

  /** One franchise code's policy of record; undefined when none — a
   * check-in row skips fail-closed (never a guessed override). */
  getFitnessFranchisePolicy(
    studioFranchiseCode: string,
  ): Promise<FitnessFranchisePolicyRecord | undefined>;

  /**
   * Registers (or replaces) the studio-to-app partnership of record for
   * one franchise code — UNIQUE per studio_franchise_code: the two
   * payees and the shares splitting the net class stream earnings.
   */
  upsertFitnessCoBrandPartnership(
    row: Omit<FitnessCoBrandPartnershipRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCoBrandPartnershipRecord>;

  /** One franchise code's partnership of record; undefined when none —
   * the co-brand walk skips (a studio without a partnership splits
   * nothing). */
  getFitnessCoBrandPartnership(
    studioFranchiseCode: string,
  ): Promise<FitnessCoBrandPartnershipRecord | undefined>;

  /**
   * Registers (or replaces) the wearable / algorithm micro-royalty policy
   * of record for one program — UNIQUE per program_id.
   */
  upsertFitnessAlgorithmPolicy(
    row: Omit<FitnessAlgorithmPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAlgorithmPolicyRecord>;

  /** One program's algorithm policy of record; undefined when none — a
   * telemetry row skips fail-closed (never a guessed micro-fee). */
  getFitnessAlgorithmPolicy(
    programId: string,
  ): Promise<FitnessAlgorithmPolicyRecord | undefined>;

  /**
   * Registers one module of a program's co-creation waterfall of record —
   * UNIQUE per (program_id, module_id): a re-registration converges.
   */
  upsertFitnessCocreationModule(
    row: Omit<FitnessCocreationModuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCocreationModuleRecord>;

  /** One program's registered co-creation modules of record, in
   * registration order; empty when none registered. */
  listFitnessCocreationModules(
    programId: string,
  ): Promise<FitnessCocreationModuleRecord[]>;

  /**
   * Advances the cumulative monthly completion tracker of record for one
   * (trainer, program, month) by the row's completions — UNIQUE per
   * (trainer_id, program_id, month): the tracker converges (an upsert
   * adds); the walk reads the position BEFORE this advance through the
   * getter.
   */
  advanceFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
    completionsAdded: number,
  ): Promise<FitnessCompletionMonthRecord>;

  /** One trainer-program-month's cumulative completions of record;
   * undefined when no row has advanced yet (position starts at zero). */
  getFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
  ): Promise<FitnessCompletionMonthRecord | undefined>;

  /**
   * Advances the cumulative monthly class count tracker of record for one
   * (franchise code, month) by the row's check-ins — UNIQUE per
   * (studio_franchise_code, month).
   */
  advanceFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
    classesAdded: number,
  ): Promise<FitnessFranchiseClassMonthRecord>;

  /** One franchise-month's cumulative class count of record; undefined
   * when no row has advanced yet. */
  getFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
  ): Promise<FitnessFranchiseClassMonthRecord | undefined>;

  /**
   * Appends one executed Digital Stream Realization — the founder's exact
   * identity on the allocation event's legs (migration 0042). UNIQUE per
   * source_event_id is the replay guard — a re-walked allocation throws,
   * never a double application.
   */
  insertFitnessRealizationApplication(
    row: Omit<FitnessRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessRealizationApplicationRecord>;

  /** One realization application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessRealizationApplication(
    sourceEventId: string,
  ): Promise<FitnessRealizationApplicationRecord | undefined>;

  /**
   * Appends one executed trainer royalty application — the sync music
   * deductions before the trainer net, the committed tier walk, and the
   * retention bonus (migration 0042). UNIQUE per source_event_id is the
   * replay guard.
   */
  insertFitnessTrainerRoyaltyApplication(
    row: Omit<FitnessTrainerRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord>;

  /** One trainer royalty application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessTrainerRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord | undefined>;

  /**
   * Appends one executed live-event streaming residual — the server load
   * deduction priced at the band holding the broadcast's peak viewers
   * (migration 0042). UNIQUE per source_event_id is the replay guard.
   */
  insertFitnessLiveResidualApplication(
    row: Omit<FitnessLiveResidualApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveResidualApplicationRecord>;

  /** One live residual application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessLiveResidualApplication(
    sourceEventId: string,
  ): Promise<FitnessLiveResidualApplicationRecord | undefined>;

  /**
   * Appends one executed studio franchise class override — the tracked
   * class counts, the certified-content overrides, and the network fee
   * before the instructor disbursement (migration 0042). UNIQUE per
   * source_event_id is the replay guard.
   */
  insertFitnessFranchiseApplication(
    row: Omit<FitnessFranchiseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessFranchiseApplicationRecord>;

  /** One franchise application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessFranchiseApplication(
    sourceEventId: string,
  ): Promise<FitnessFranchiseApplicationRecord | undefined>;

  /**
   * Appends one executed co-branded franchise split — the net class
   * stream earnings split per the partnership of record (migration 0042).
   * UNIQUE per source_event_id is the replay guard.
   */
  insertFitnessCobrandSplitApplication(
    row: Omit<FitnessCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCobrandSplitApplicationRecord>;

  /** One co-brand split application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FitnessCobrandSplitApplicationRecord | undefined>;

  /**
   * Appends one executed wearable / algorithm micro-royalty — the daily
   * active feature usage priced at the policy's per-active-user micro-fee
   * (migration 0042). UNIQUE per source_event_id is the replay guard.
   */
  insertFitnessAlgorithmRoyalty(
    row: Omit<FitnessAlgorithmRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAlgorithmRoyaltyRecord>;

  /** One algorithm micro-royalty of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessAlgorithmRoyalty(
    sourceEventId: string,
  ): Promise<FitnessAlgorithmRoyaltyRecord | undefined>;

  /**
   * Appends one executed module-weighted co-creation split — the
   * program's enrollment revenue split across the registered module
   * weightings, conserved exactly (migration 0042). UNIQUE per
   * source_event_id is the replay guard.
   */
  insertFitnessCocreationApplication(
    row: Omit<FitnessCocreationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCocreationApplicationRecord>;

  /** One co-creation application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessCocreationApplication(
    sourceEventId: string,
  ): Promise<FitnessCocreationApplicationRecord | undefined>;

  /**
   * Registers (or replaces) the FITNESS_AUDIT_ESCROW's founder-banded
   * rate of record for one scope (migration 0043) — upsert converges:
   * the newest rate governs the next routing.
   */
  upsertFitnessAuditEscrowPolicy(
    row: Omit<FitnessAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAuditEscrowPolicyRecord>;

  /** One scope's escrow rate of record; undefined when none — the
   * routing lane refuses fail-closed (no policy, no routing). */
  getFitnessAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<FitnessAuditEscrowPolicyRecord | undefined>;

  /**
   * Appends one position-locked escrow drawdown (migration 0043) —
   * UNIQUE per (reserve_ledger_id, source_event_id) is the replay
   * guard, UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
   * position lock: a replayed draw or a lost race throws here, never a
   * double drawdown.
   */
  insertFitnessAuditEscrowDrawdown(
    row: Omit<FitnessAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowDrawdownRecord>;

  /** One escrow bucket's drawdowns in spend order — the append-only
   * truth the balance derives from. */
  listFitnessAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowDrawdownRecord[]>;

  /**
   * Records the verified reconciliation of record for one escrow bucket
   * (migration 0043) — insert-as-lock, UNIQUE per reserve_ledger_id:
   * the FIRST reconciliation of record wins; a concurrent second insert
   * throws (the caller reads the winner through the getter).
   */
  insertFitnessAuditEscrowReconciliation(
    row: Omit<FitnessAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowReconciliationRecord>;

  /** One escrow bucket's reconciliation of record; undefined when none —
   * the release gate reads fail-closed through this. */
  getFitnessAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowReconciliationRecord | undefined>;

  /**
   * Settles one held `fitness_audit_escrow` bucket row — the
   * single-statement CAS: the row flips only while it is still held;
   * the caller that lost the race (or replayed) reads undefined.
   */
  settleFitnessAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined>;

  /**
   * Upserts the fitness payout gate's states of record for one payee in
   * one studio franchise (migration 0043) — UNIQUE per
   * (payee_id, studio_franchise_code): an upsert converges (a
   * verification heals 'unknown'; states never regress through this
   * table).
   */
  upsertFitnessPayoutGateState(
    row: Omit<FitnessPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessPayoutGateStateRecord>;

  /**
   * One payee × studio franchise's gate states of record; undefined when
   * none — the fitness payout gate resolves fail-closed through this
   * (absent → null → the gate refuses).
   */
  getFitnessPayoutGateState(
    payeeId: string,
    studioFranchiseCode: string,
  ): Promise<FitnessPayoutGateStateRecord | undefined>;

  /**
   * Registers (or replaces) one program's instant live-event bonus rate
   * of record (migration 0043) — upsert converges: the newest rate
   * governs the next concluded event's posting.
   */
  upsertFitnessLiveEventBonusPolicy(
    row: Omit<FitnessLiveEventBonusPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveEventBonusPolicyRecord>;

  /** One program's live-event bonus rate of record; undefined when none
   * — the walk counts a fail-closed skip (never a guessed rate). */
  getFitnessLiveEventBonusPolicy(
    programId: string,
  ): Promise<FitnessLiveEventBonusPolicyRecord | undefined>;

  /**
   * Appends one concluded live event's instant performance bonus to the
   * lead trainer's ledger (migration 0043) — UNIQUE per source_event_id
   * is the replay guard: a replayed event row throws here, never a
   * double bonus.
   */
  insertFitnessLiveEventBonus(
    row: Omit<FitnessLiveEventBonusRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveEventBonusRecord>;

  /** One concluded event's bonus of record by its source event id;
   * undefined when none — the replay check's read. */
  getFitnessLiveEventBonus(sourceEventId: string): Promise<FitnessLiveEventBonusRecord | undefined>;

  // -------------------------------------------------------------------------
  // PR 40 — the food lane (migration 0044): the founder food directive's
  // durable facts of record — the recipe royalty schedules, the cumulative
  // location-month unit trackers, the host operator and cook-cycle
  // policies, the co-brand weightings and operator waterfalls the walks
  // read, and the append-only application ledgers the walks write.
  // -------------------------------------------------------------------------

  /**
   * Registers (or replaces) the recipe royalty schedule of record for one
   * (chef, recipe) — UNIQUE per (chef_id, recipe_id): the newest schedule
   * governs the next walk. The bands ride as JSON strings, re-validated
   * at every read.
   */
  upsertFoodRecipeRoyaltySchedule(
    row: Omit<FoodRecipeRoyaltyScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodRecipeRoyaltyScheduleRecord>;

  /** One chef-recipe's royalty schedule of record; undefined when none —
   * the royalty walk refuses fail-closed (no schedule, no royalty). */
  getFoodRecipeRoyaltySchedule(
    chefId: string,
    recipeId: string,
  ): Promise<FoodRecipeRoyaltyScheduleRecord | undefined>;

  /**
   * Advances the cumulative monthly unit tracker of record for one
   * (ghost kitchen location, month) by the row's units — UNIQUE per
   * (ghost_kitchen_location_id, month): the tracker converges (an upsert
   * adds); the walk reads the position BEFORE this advance through the
   * getter.
   */
  advanceFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
    unitsAdded: number,
  ): Promise<FoodLocationUnitMonthRecord>;

  /** One location-month's cumulative units of record; undefined when no
   * row has advanced yet (position starts at zero). */
  getFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
  ): Promise<FoodLocationUnitMonthRecord | undefined>;

  /**
   * Registers (or replaces) the host kitchen operator policy of record
   * for one ghost kitchen location — UNIQUE per
   * (ghost_kitchen_location_id): the brand licensor payee and the
   * percentage cut held back from the physical preparation margin.
   */
  upsertFoodHostOperatorPolicy(
    row: Omit<FoodHostOperatorPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodHostOperatorPolicyRecord>;

  /** One location's host operator policy of record; undefined when none
   * — a POS ticket row skips fail-closed (never a guessed holdback). */
  getFoodHostOperatorPolicy(
    ghostKitchenLocationId: string,
  ): Promise<FoodHostOperatorPolicyRecord | undefined>;

  /**
   * Registers (or replaces) the cook-cycle micro-fee policy of record
   * for one (chef, recipe) — UNIQUE per (chef_id, recipe_id): the payee
   * and the per-execution micro-fee.
   */
  upsertFoodCookCyclePolicy(
    row: Omit<FoodCookCyclePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCookCyclePolicyRecord>;

  /** One chef-recipe's cook-cycle policy of record; undefined when none
   * — a production row skips fail-closed (never a guessed micro-fee). */
  getFoodCookCyclePolicy(
    chefId: string,
    recipeId: string,
  ): Promise<FoodCookCyclePolicyRecord | undefined>;

  /**
   * Registers one weighting leg of a recipe's co-branded menu split of
   * record — UNIQUE per (recipe_id, leg_id): a re-registration converges.
   */
  upsertFoodCobrandWeighting(
    row: Omit<FoodCobrandWeightingRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCobrandWeightingRecord>;

  /** One recipe's registered co-brand weighting legs of record, in
   * registration order; empty when none registered. */
  listFoodCobrandWeightings(recipeId: string): Promise<FoodCobrandWeightingRecord[]>;

  /**
   * Registers one leg of a location's virtual franchise operator
   * waterfall of record — UNIQUE per
   * (ghost_kitchen_location_id, operator_id): a re-registration
   * converges.
   */
  upsertFoodOperatorWaterfallLeg(
    row: Omit<FoodOperatorWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodOperatorWaterfallRecord>;

  /** One location's registered operator waterfall legs of record, in
   * registration order; empty when none registered. */
  listFoodOperatorWaterfallLegs(
    ghostKitchenLocationId: string,
  ): Promise<FoodOperatorWaterfallRecord[]>;

  /**
   * Appends one executed Net Recipe Realization — the founder's exact
   * identity on the order event's legs (migration 0044). UNIQUE per
   * source_event_id is the replay guard — a re-walked order throws,
   * never a double application.
   */
  insertFoodRealizationApplication(
    row: Omit<FoodRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRealizationApplicationRecord>;

  /** One realization application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFoodRealizationApplication(
    sourceEventId: string,
  ): Promise<FoodRealizationApplicationRecord | undefined>;

  /**
   * Appends one executed tiered recipe royalty application — the
   * committed unit band walk and the percentage split on the location's
   * cumulative monthly units (migration 0044). UNIQUE per
   * source_event_id is the replay guard.
   */
  insertFoodRecipeRoyaltyApplication(
    row: Omit<FoodRecipeRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRecipeRoyaltyApplicationRecord>;

  /** One recipe royalty application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFoodRecipeRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FoodRecipeRoyaltyApplicationRecord | undefined>;

  /**
   * Appends one executed weighted co-branded menu split — the royalty
   * pot routed per the registered weightings, conserved exactly
   * (migration 0044). UNIQUE per source_event_id is the replay guard.
   */
  insertFoodCobrandSplitApplication(
    row: Omit<FoodCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodCobrandSplitApplicationRecord>;

  /** One co-brand split application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFoodCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FoodCobrandSplitApplicationRecord | undefined>;

  /**
   * Appends one executed host kitchen operator split — the physical
   * preparation margin's two routes (migration 0044). UNIQUE per
   * source_event_id is the replay guard.
   */
  insertFoodHostOperatorSplitApplication(
    row: Omit<FoodHostOperatorSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodHostOperatorSplitApplicationRecord>;

  /** One host operator split application of record by its source event
   * id; undefined when none — the replay check's read. */
  getFoodHostOperatorSplitApplication(
    sourceEventId: string,
  ): Promise<FoodHostOperatorSplitApplicationRecord | undefined>;

  /**
   * Appends one executed cook-cycle micro-royalty — the per-execution
   * fee at the policy of record (migration 0044). UNIQUE per
   * source_event_id is the replay guard.
   */
  insertFoodCookCycleRoyalty(
    row: Omit<FoodCookCycleRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FoodCookCycleRoyaltyRecord>;

  /** One cook-cycle royalty of record by its source event id; undefined
   * when none — the replay check's read. */
  getFoodCookCycleRoyalty(
    sourceEventId: string,
  ): Promise<FoodCookCycleRoyaltyRecord | undefined>;

  /**
   * Appends one executed supplier rebate routing — the volume kickback
   * routed proportionally to the location's operators, conserved exactly
   * (migration 0044). UNIQUE per source_event_id is the replay guard.
   */
  insertFoodSupplierRebateApplication(
    row: Omit<FoodSupplierRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodSupplierRebateApplicationRecord>;

  /** One supplier rebate application of record by its source event id;
   * undefined when none — the replay check's read. */
  getFoodSupplierRebateApplication(
    sourceEventId: string,
  ): Promise<FoodSupplierRebateApplicationRecord | undefined>;
}



// Re-export the record vocabulary engines import from the seam.
export type {
  BaasProvider,
  BaasTransferRecord,
  KycVerificationRecord,
  LedgerTransactionRecord,
  PlaidLinkTokenRecord,
  RoyaltyLineItemRecord,
  SplitRunRecord,
} from '@/lib/don/types';
export type {
  BaasWebhookEventRecord,
  CatalogDisputeRecord,
  CompanyDustRecord,
  CreatorTaxProfile,
  CreatorYtdEarnings,
  DspWebhookEventRecord,
  GlEntryRecord,
  GlJournalRecord,
  PayoutHoldRecord,
  PayoutReversalRecord,
  PlaidProcessorTokenRecord,
  RecoupmentAdvanceRecord,
  RecoupmentLedgerRecord,
  SovereignVaultRecord,
  SplitReversalRecord,
  TaxEscrowRecord,
  VaultDisputeRecord,
} from '@/modules/don/records';
export type {
  MatchQueueRecord,
  MatchQueueResolution,
  MulClearanceRecord,
  MulClearanceState,
  MulClearanceTransitionRecord,
  StatementIngestRecord,
  StatementFormat,
  StatementIngestStatus,
  StatementSource,
  SyncCatalogItemRecord,
  SyncLicensePurchaseRecord,
} from '@/modules/sdk/records';
export type {
  ReconJobInput,
  ReconJobResult,
  ReconJobSource,
  RoyaltyReconJobRecord,
  RoyaltyReconJobStatus,
} from '@/modules/recon/records';
export type {
  AstraVertical,
  ConnectionPublicStatus,
  DistributorConnectionInput,
  DistributorConnectionRecord,
  DistributorConnectionSource,
  DistributorConnectionState,
  DistributorConnectionUpsert,
  DistributorTraversalOutcome,
} from '@/modules/vault/records';
export { toConnectionStatus } from '@/modules/vault/records';

// ---------------------------------------------------------------------------
// Singleton — the spec's exact shape: getStore() boots the Supabase
// production store (lazy, so importing a route module during the Next build
// never opens a client); tests inject an in-memory store with setStore().
// ---------------------------------------------------------------------------

let storeInstance: Store | null = null;

export function getStore(): Store {
  if (storeInstance === null) {
    storeInstance = new SupabaseStore(createAdminClient()); // Vercel / Supabase production
  }
  return storeInstance;
}

export function setStore(store: Store | null): void {
  storeInstance = store; // tests (and a local-dev SqliteStore, if that reversal lands) inject here
}

/** Service-role client for the engine's store. Fails closed when unset. */
function createAdminClient(): SupabaseClient {
  const env = readSupabaseEnv();
  if (env === null) {
    throw new Error(
      'supabase_not_configured: the Don store needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return createSupabaseAdminClient(env);
}
