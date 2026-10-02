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
} from '@/modules/don/records';
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
