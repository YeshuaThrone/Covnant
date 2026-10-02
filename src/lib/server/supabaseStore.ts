/**
 * SupabaseStore — the production Store implementation (spec art_zxsnGP3A:
 * getStore() boots this over the service-role client). One method per
 * canonical Store method; every table and column maps to
 * supabase/migrations/0006_don_engine.sql, the PostgreSQL translation of
 * Cursor's canonical SQLite schema.
 *
 * Boundary notes:
 *  - PostgREST surfaces timestamptz as ISO strings and int8/integer flags as
 *    JSON numbers, exactly matching the record types — rows map 1:1. The only
 *    projection is dropping the store-internal `insertion_order` column
 *    (the rowid substitute) in toRecord.
 *  - recordCheckoutPurchase keeps the canonical single-transaction semantics
 *    via the migration's record_checkout_purchase function: one RPC does the
 *    idempotent session insert plus the guarded capacity decrement.
 *  - Unique violations surface as thrown Errors (the same failure mode the
 *    canonical SQLite store and InMemoryStore exhibit) rather than silent
 *    nulls.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DEFAULT_LIST_SHOWS_LIMIT,
  RECON_MAX_ATTEMPTS,
  type ApplyVaultDeltaResult,
  type ArtistRecord,
  type CheckoutPurchaseResult,
  type CreatorUctRecord,
  type LivePingRecord,
  type ReconJobInput,
  type ReconJobResult,
  type RoyaltyReconJobRecord,
  type ShowRecord,
  type Store,
  type ValidLivePingPayload,
  type ValidShowPayload,
  type VaultDeltaInput,
} from '@/lib/server/store';
import { isTerminalReconJob } from '@/modules/recon/records';
import type {
  DistributorConnectionInput,
  DistributorConnectionRecord,
  DistributorConnectionUpsert,
  DistributorTraversalOutcome,
} from '@/modules/vault/records';
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
import {
  SDK_SETTLEMENT_TRANSACTION_TYPE,
  territorySettlementOfRow,
  type TerritorySettlementRecord,
  type UniversalRoyaltyLedgerRow,
} from '@/lib/server/territorySettlement';
import { podcastEpisodeIdOfQueueRow } from '@/modules/podcastSplits/engine';

/** Drops the store-internal ordering column; the DB row is otherwise the record. */
function toRecord<T>(row: Record<string, unknown>): T {
  const record = { ...row };
  delete record.insertion_order;
  return record as T;
}

/** DB tables (migration 0006). Kept local — table names are not API surface. */
const TABLES = {
  shows: 'shows',
  livePings: 'live_pings',
  artists: 'artists',
  plaidLinkTokens: 'plaid_link_tokens',
  kycVerifications: 'kyc_verifications',
  splitRuns: 'split_runs',
  royaltyLineItems: 'royalty_line_items',
  ledgerTransactions: 'ledger_transactions',
  baasTransfers: 'baas_transfers',
  companyDust: 'company_dust_ledger',
  taxProfiles: 'creator_tax_profiles',
  creatorYtd: 'creator_ytd_earnings',
  taxEscrow: 'tax_escrow_ledger',
  vaults: 'sovereign_vaults',
  processorTokens: 'plaid_processor_tokens',
  recoupmentAdvances: 'recoupment_advances',
  vaultDisputes: 'vault_disputes',
  payoutHolds: 'payout_holds',
  baasWebhookEvents: 'baas_webhook_events',
  payoutReversals: 'payout_reversals',
  glJournals: 'gl_journals',
  glEntries: 'gl_entries',
  recoupmentLedger: 'recoupment_ledger',
  catalogDisputes: 'catalog_disputes',
  dspWebhookEvents: 'dsp_webhook_events',
  splitReversals: 'split_reversals',
  mulClearances: 'mul_clearances',
  mulClearanceTransitions: 'mul_clearance_transitions',
  matchQueue: 'match_queue',
  statementIngests: 'statement_ingests',
  // Migration 0011 — the Deep Royalties orchestration queue. Parsed line
  // items live in match_queue; this table moves the job, never the rows.
  reconJobs: 'royalty_recon_jobs',
  // Migration 0013 — the UCT credential vault. Ciphertext columns only:
  // the routes encrypt app-side before this store ever sees a credential.
  distributorConnections: 'distributor_connections',
  universalRoyaltyLedger: 'universal_royalty_ledger',
  // Migration 0005 — the append-only operator audit trail. RLS grants no
  // anon/authenticated access: the service-role client this store holds is
  // the only reader, which is exactly what the audit read requires.
  adminActionLog: 'admin_action_log',
  // Migration 0008 — the SyncMarketplaceRegistry amendment. The sync
  // catalog columns live ON cbt_assets (no new catalog table); purchases
  // get the lane's own write-back table.
  assets: 'cbt_assets',
  creatorProfiles: 'creator_profiles',
  syncLicensePurchases: 'sync_license_purchases',
  // Migration 0016 — the film waterfall engine (PR 8). The definition is ONE
  // validated deal per film asset (jsonb); the distributions are the
  // routing-decision record (the honest shortfall carry).
  filmWaterfallDefinitions: 'film_waterfall_definitions',
  filmWaterfallDistributions: 'film_waterfall_distributions',
  // Migration 0017 — the podcast episode split ledger + guest milestone
  // bonuses (PR 11). The schedule is ONE validated routing per episode;
  // accruals are unique per funding event and bonus accruals per
  // content-derived event id — the once-only replay guards.
  podcastEpisodeSplitSchedules: 'podcast_episode_split_schedules',
  podcastEpisodeSplitAccruals: 'podcast_episode_split_accruals',
  podcastGuestBonusDefinitions: 'podcast_guest_bonus_definitions',
  podcastGuestBonusAccruals: 'podcast_guest_bonus_accruals',
  // Migration 0018 — the gaming engine-royalty accumulator + item splits
  // (PR 12). The contribution log IS the accumulator (its state is the
  // derived SUM, so replayed gross can never cross the $1M threshold
  // twice); schedules are one validated routing per item; payout routings
  // are unique per funding event — the once-only replay guards.
  gamingEngineRoyaltyEvents: 'gaming_engine_royalty_events',
  gamingItemSplitSchedules: 'gaming_item_split_schedules',
  gamingSplitPayouts: 'gaming_split_payouts',
  // Migration 0019 — the gaming cashout states (PR 13). The durable DevEx
  // conversion logs hold until the platform's fiat settlement completes
  // (the release path reads a batch's logs and refuses while any is
  // pending); one KYC verification state per studio payee backs the gaming
  // payout gate's studio/team read.
  gamingDevexConversionLogs: 'gaming_devex_conversion_logs',
  gamingStudioKycVerifications: 'gaming_studio_kyc_verifications',
  // Migration 0020 — the VTuber agency holdback states (PR 15). The durable
  // tax-withholding verification state behind the livestream gate's
  // tax_withholding_verified read (one row per payee + tax year), and the
  // tech setup amortization contracts — the schedule row is the immutable
  // contract, the consumed LINES are append-only and unique per
  // (schedule_ref, line_index) — the PR 12 accumulator's insert-as-lock
  // discipline.
  vtuberTaxWithholdingVerifications: 'vtuber_tax_withholding_verifications',
  vtuberTechSetupAmortizationSchedules: 'vtuber_tech_setup_amortization_schedules',
  vtuberTechSetupAmortizationLines: 'vtuber_tech_setup_amortization_lines',
  // Migration 0021 — the derivative cascade's per-edge fractional royalty
  // contracts over the parent_asset_id dependency tree (PR 16).
  derivativeRoyaltyEdges: 'derivative_royalty_edges',
  sampleClearanceEdges: 'sample_clearance_edges',
  compositionPublishers: 'composition_publishers',
  // Migration 0023 — the film multi-territory withholding log + territory
  // envelopes (PR 18). The withholding log is the per-line, pre-conversion
  // foreign-tax evidence; the envelopes are the per-territory routing
  // decisions behind the cross-collateralization firewall.
  filmTerritoryWithholdings: 'film_territory_withholdings',
  filmTerritoryDistributions: 'film_territory_distributions',
} as const;

/**
 * How far a verified-count scan reaches into the queue (PR 11). A truncated
 * scan under-counts an episode — a milestone then under-fires and the money
 * stays held (the fail-closed direction: never over-pays, never guesses).
 */
const VERIFIED_COUNT_SCAN_LIMIT = 10_000;

/** The designated self-serve identity registry row (signup route header). */
const SIGNUP_REGISTRY_CBT_CODE = 'CBT-SIGNUP-REGISTRY';

/** The registry holder entry fields getCreatorUct reads (0008 identity projection). */
interface RegistryHolderUctEntry {
  rightsHolderId?: unknown;
  email?: unknown;
  uct?: unknown;
}

function isRegistryHolderUctEntry(value: unknown): value is RegistryHolderUctEntry {
  return typeof value === 'object' && value !== null && 'rightsHolderId' in value;
}

type DbResult = PromiseLike<{
  data: unknown;
  error: { message: string; code: string } | null;
}>;

/** The apply_vault_delta() outcome envelope (migration 0009, H1 guard). */
type VaultDeltaRpcEnvelope =
  | { outcome: 'applied'; vault: unknown }
  | { outcome: 'guard_failed' }
  | { outcome: 'not_found' };

export class SupabaseStore implements Store {
  constructor(private readonly client: SupabaseClient) {}

  /** Single-row read: throws on transport/DB error, undefined when absent. */
  private async one<T>(result: DbResult, context: string): Promise<T | undefined> {
    const { data, error } = await result;
    if (error !== null) {
      throw new Error(`${context}: ${error.message} (code ${error.code})`);
    }
    if (data === null || data === undefined) return undefined;
    return toRecord<T>(data as Record<string, unknown>);
  }

  /** Multi-row read: throws on transport/DB error, empty array when none. */
  private async many<T>(result: DbResult, context: string): Promise<T[]> {
    const { data, error } = await result;
    if (error !== null) {
      throw new Error(`${context}: ${error.message} (code ${error.code})`);
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    return rows.map((row) => toRecord<T>(row));
  }

  /** Insert/upsert read: throws when the DB returns no row. */
  private async oneStrict<T>(result: DbResult, context: string): Promise<T> {
    const row = await this.one<T>(result, context);
    if (row === undefined) {
      throw new Error(`${context}: expected exactly one row back, got none.`);
    }
    return row;
  }

  // --- Legacy show / ping / artist surface ---

  async insertShow(show: ValidShowPayload): Promise<ShowRecord> {
    const row = { ...show, id: crypto.randomUUID() };
    return this.oneStrict<ShowRecord>(
      this.client.from(TABLES.shows).insert(row).select().maybeSingle(),
      'insertShow',
    );
  }

  async listShows(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<ShowRecord[]> {
    return this.many<ShowRecord>(
      this.client
        .from(TABLES.shows)
        .select()
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listShows',
    );
  }

  async getShow(id: string): Promise<ShowRecord | undefined> {
    return this.one<ShowRecord>(
      this.client.from(TABLES.shows).select().eq('id', id).maybeSingle(),
      'getShow',
    );
  }

  async recordCheckoutPurchase(
    sessionId: string,
    showId: string,
    quantity: number,
  ): Promise<CheckoutPurchaseResult | null> {
    const result = await this.one<CheckoutPurchaseResult>(
      this.client.rpc('record_checkout_purchase', {
        p_session_id: sessionId,
        p_show_id: showId,
        p_quantity: quantity,
      }),
      'recordCheckoutPurchase',
    );
    // The RPC yields JSON null when the show is missing, non-native, or the
    // purchase is not recordable — null is part of the canonical contract.
    return result ?? null;
  }

  async insertLivePing(ping: ValidLivePingPayload): Promise<LivePingRecord> {
    const row = { ...ping, id: crypto.randomUUID() };
    return this.oneStrict<LivePingRecord>(
      this.client.from(TABLES.livePings).insert(row).select().maybeSingle(),
      'insertLivePing',
    );
  }

  async listLivePings(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<LivePingRecord[]> {
    return this.many<LivePingRecord>(
      this.client
        .from(TABLES.livePings)
        .select()
        .order('timestamp', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listLivePings',
    );
  }

  async insertArtist(
    name: string,
    keyHash: string,
    keyPrefix: string,
    createdAt: string = new Date().toISOString(),
  ): Promise<ArtistRecord> {
    const row = {
      id: crypto.randomUUID(),
      name: name.trim(),
      created_at: createdAt,
      key_hash: keyHash,
      key_prefix: keyPrefix,
    };
    return this.oneStrict<ArtistRecord>(
      this.client.from(TABLES.artists).insert(row).select().maybeSingle(),
      'insertArtist',
    );
  }

  async getArtist(id: string): Promise<ArtistRecord | undefined> {
    return this.one<ArtistRecord>(
      this.client.from(TABLES.artists).select().eq('id', id).maybeSingle(),
      'getArtist',
    );
  }

  async getArtistByKeyHash(keyHash: string): Promise<ArtistRecord | undefined> {
    return this.one<ArtistRecord>(
      this.client.from(TABLES.artists).select().eq('key_hash', keyHash).maybeSingle(),
      'getArtistByKeyHash',
    );
  }

  // --- Plaid link / KYC surface ---

  async insertPlaidLinkToken(
    token: Omit<PlaidLinkTokenRecord, 'id' | 'created_at'>,
  ): Promise<PlaidLinkTokenRecord> {
    const row = {
      ...token,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    return this.oneStrict<PlaidLinkTokenRecord>(
      this.client.from(TABLES.plaidLinkTokens).insert(row).select().maybeSingle(),
      'insertPlaidLinkToken',
    );
  }

  async getPlaidLinkTokenByLinkToken(
    linkToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    return this.one<PlaidLinkTokenRecord>(
      this.client
        .from(TABLES.plaidLinkTokens)
        .select()
        .eq('link_token', linkToken)
        .maybeSingle(),
      'getPlaidLinkTokenByLinkToken',
    );
  }

  async getPlaidLinkTokenByPublicToken(
    publicToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    return this.one<PlaidLinkTokenRecord>(
      this.client
        .from(TABLES.plaidLinkTokens)
        .select()
        .eq('public_token', publicToken)
        .maybeSingle(),
      'getPlaidLinkTokenByPublicToken',
    );
  }

  async updatePlaidAccessToken(
    publicToken: string,
    accessToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    return this.one<PlaidLinkTokenRecord>(
      this.client
        .from(TABLES.plaidLinkTokens)
        .update({ access_token: accessToken })
        .eq('public_token', publicToken)
        .select()
        .maybeSingle(),
      'updatePlaidAccessToken',
    );
  }

  async insertKycVerification(
    row: Omit<KycVerificationRecord, 'id'>,
  ): Promise<KycVerificationRecord> {
    return this.oneStrict<KycVerificationRecord>(
      this.client
        .from(TABLES.kycVerifications)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertKycVerification',
    );
  }

  async listKycVerificationsByCreator(creatorId: string): Promise<KycVerificationRecord[]> {
    return this.many<KycVerificationRecord>(
      this.client
        .from(TABLES.kycVerifications)
        .select()
        .eq('creator_id', creatorId)
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false }),
      'listKycVerificationsByCreator',
    );
  }

  async insertProcessorToken(
    row: Omit<PlaidProcessorTokenRecord, 'id'>,
  ): Promise<PlaidProcessorTokenRecord> {
    return this.oneStrict<PlaidProcessorTokenRecord>(
      this.client
        .from(TABLES.processorTokens)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertProcessorToken',
    );
  }

  async getProcessorToken(
    publicToken: string,
    processor: PlaidProcessorTokenRecord['processor'],
  ): Promise<PlaidProcessorTokenRecord | undefined> {
    return this.one<PlaidProcessorTokenRecord>(
      this.client
        .from(TABLES.processorTokens)
        .select()
        .eq('public_token', publicToken)
        .eq('processor', processor)
        .maybeSingle(),
      'getProcessorToken',
    );
  }

  // --- Split runs + line items ---

  async insertSplitRun(
    row: Omit<SplitRunRecord, 'id' | 'status' | 'idempotency_key'> & {
      status?: SplitRunRecord['status'];
      idempotency_key?: string | null;
    },
  ): Promise<SplitRunRecord> {
    return this.oneStrict<SplitRunRecord>(
      this.client
        .from(TABLES.splitRuns)
        .insert({
          ...row,
          status: row.status ?? 'posted',
          idempotency_key: row.idempotency_key ?? null,
          id: crypto.randomUUID(),
        })
        .select()
        .maybeSingle(),
      'insertSplitRun',
    );
  }

  async getSplitRun(id: string): Promise<SplitRunRecord | undefined> {
    return this.one<SplitRunRecord>(
      this.client.from(TABLES.splitRuns).select().eq('id', id).maybeSingle(),
      'getSplitRun',
    );
  }

  async getSplitRunByIdempotencyKey(key: string): Promise<SplitRunRecord | undefined> {
    return this.one<SplitRunRecord>(
      this.client
        .from(TABLES.splitRuns)
        .select()
        .eq('idempotency_key', key)
        .maybeSingle(),
      'getSplitRunByIdempotencyKey',
    );
  }

  async updateSplitRunStatus(
    id: string,
    status: SplitRunRecord['status'],
  ): Promise<SplitRunRecord | undefined> {
    return this.one<SplitRunRecord>(
      this.client
        .from(TABLES.splitRuns)
        .update({ status })
        .eq('id', id)
        .select()
        .maybeSingle(),
      'updateSplitRunStatus',
    );
  }

  async insertRoyaltyLineItem(
    row: Omit<RoyaltyLineItemRecord, 'id'>,
  ): Promise<RoyaltyLineItemRecord> {
    return this.oneStrict<RoyaltyLineItemRecord>(
      this.client
        .from(TABLES.royaltyLineItems)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertRoyaltyLineItem',
    );
  }

  async listRoyaltyLineItemsByRun(splitRunId: string): Promise<RoyaltyLineItemRecord[]> {
    return this.many<RoyaltyLineItemRecord>(
      this.client
        .from(TABLES.royaltyLineItems)
        .select()
        .eq('split_run_id', splitRunId)
        .order('created_at', { ascending: true }),
      'listRoyaltyLineItemsByRun',
    );
  }

  // --- Ledger transactions ---

  async insertLedgerTransaction(
    row: Omit<LedgerTransactionRecord, 'id' | 'kind'> & {
      kind?: LedgerTransactionRecord['kind'];
    },
  ): Promise<LedgerTransactionRecord> {
    return this.oneStrict<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .insert({ ...row, kind: row.kind ?? 'royalty', id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertLedgerTransaction',
    );
  }

  async getLedgerTransaction(id: string): Promise<LedgerTransactionRecord | undefined> {
    return this.one<LedgerTransactionRecord>(
      this.client.from(TABLES.ledgerTransactions).select().eq('id', id).maybeSingle(),
      'getLedgerTransaction',
    );
  }

  async listLedgerTransactionsByRun(splitRunId: string): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('split_run_id', splitRunId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listLedgerTransactionsByRun',
    );
  }

  async listLedgerTransactionsByLineItem(
    lineItemId: string,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('line_item_id', lineItemId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listLedgerTransactionsByLineItem',
    );
  }

  async updateLedgerSettlement(
    id: string,
    patch: Pick<
      LedgerTransactionRecord,
      'status' | 'rail' | 'baas_provider' | 'baas_transfer_id' | 'settled_at'
    >,
  ): Promise<LedgerTransactionRecord | undefined> {
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update(patch)
        .eq('id', id)
        .select()
        .maybeSingle(),
      'updateLedgerSettlement',
    );
  }

  // --- Unclaimed royalty holding (PR 7) ---

  async listUnclaimedHoldingCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'unclaimed_holding')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listUnclaimedHoldingCredits',
    );
  }

  async settleUnclaimedHolding(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The status predicate in the UPDATE's WHERE is the CAS: PostgREST
    // matches the row only while it is still held, so the concurrent release
    // loser gets zero rows back (maybeSingle → undefined).
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'unclaimed_holding')
        .select()
        .maybeSingle(),
      'settleUnclaimedHolding',
    );
  }

  // --- Film waterfall escrow (PR 9) ---

  async listFilmEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'escrow_waterfall_pending')
        .eq('status', 'escrow_waterfall_pending')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listFilmEscrowCredits',
    );
  }

  async settleFilmEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The status predicate in the UPDATE's WHERE is the CAS: PostgREST
    // matches the row only while it is still locked, so the concurrent
    // release loser gets zero rows back (maybeSingle → undefined).
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'escrow_waterfall_pending')
        .select()
        .maybeSingle(),
      'settleFilmEscrow',
    );
  }

  async sumFilmGrossReceiptCents(filmId: string): Promise<number> {
    // Gross receipts count EVERY escrow receipt row for the film, held or
    // released — money is received when it locks, not when it releases. The
    // per-film payee id (film_escrow:{filmId}) is the grouping key; the
    // amount column is fetched alone and summed exactly (never a page of
    // full rows).
    const rows = await this.many<{ amount_cents: number }>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select('amount_cents')
        .eq('kind', 'escrow_waterfall_pending')
        .eq('payee_id', `film_escrow:${filmId}`),
      'sumFilmGrossReceiptCents',
    );
    return rows.reduce((total, row) => total + row.amount_cents, 0);
  }

  // --- Film waterfall engine (migration 0016, PR 8) ---

  async upsertFilmWaterfallDefinition(
    row: FilmWaterfallDefinitionRecord,
  ): Promise<FilmWaterfallDefinitionRecord> {
    // One definition per film asset — the upsert targets the film_id key, so
    // a re-registration after the lock check replaces the row atomically.
    return this.oneStrict<FilmWaterfallDefinitionRecord>(
      this.client
        .from(TABLES.filmWaterfallDefinitions)
        .upsert(row, { onConflict: 'film_id' })
        .select()
        .maybeSingle(),
      'upsertFilmWaterfallDefinition',
    );
  }

  async getFilmWaterfallDefinition(
    filmId: string,
  ): Promise<FilmWaterfallDefinitionRecord | undefined> {
    return this.one<FilmWaterfallDefinitionRecord>(
      this.client
        .from(TABLES.filmWaterfallDefinitions)
        .select()
        .eq('film_id', filmId)
        .maybeSingle(),
      'getFilmWaterfallDefinition',
    );
  }

  async insertFilmWaterfallDistribution(
    row: Omit<FilmWaterfallDistributionRecord, 'id'>,
  ): Promise<FilmWaterfallDistributionRecord> {
    // UNIQUE on escrow_ledger_id: a duplicate insert throws here (the same
    // failure mode the canonical store exhibits) and the caller recovers by
    // reading the existing row — one routing decision per released receipt.
    return this.oneStrict<FilmWaterfallDistributionRecord>(
      this.client
        .from(TABLES.filmWaterfallDistributions)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertFilmWaterfallDistribution',
    );
  }

  async getFilmWaterfallDistributionByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmWaterfallDistributionRecord | undefined> {
    return this.one<FilmWaterfallDistributionRecord>(
      this.client
        .from(TABLES.filmWaterfallDistributions)
        .select()
        .eq('escrow_ledger_id', escrowLedgerId)
        .maybeSingle(),
      'getFilmWaterfallDistributionByEscrow',
    );
  }

  async updateFilmWaterfallDistributionStatus(
    id: string,
    status: FilmWaterfallDistributionRecord['status'],
  ): Promise<FilmWaterfallDistributionRecord | undefined> {
    return this.one<FilmWaterfallDistributionRecord>(
      this.client
        .from(TABLES.filmWaterfallDistributions)
        .update({ status })
        .eq('id', id)
        .select()
        .maybeSingle(),
      'updateFilmWaterfallDistributionStatus',
    );
  }

  async deleteFilmWaterfallDistribution(id: string): Promise<void> {
    const { error } = await this.client
      .from(TABLES.filmWaterfallDistributions)
      .delete()
      .eq('id', id);
    if (error) {
      throw new Error(`deleteFilmWaterfallDistribution: ${error.message} (code ${error.code})`);
    }
  }

  async listFilmWaterfallDistributions(
    filmId: string,
  ): Promise<FilmWaterfallDistributionRecord[]> {
    // Oldest first — the cumulative paid state folds in routing order
    // (insertion_order ASC is the strict tiebreak when created_at ties).
    return this.many<FilmWaterfallDistributionRecord>(
      this.client
        .from(TABLES.filmWaterfallDistributions)
        .select()
        .eq('film_id', filmId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listFilmWaterfallDistributions',
    );
  }

  // --- Film multi-territory withholding + cross-collateralization firewall (migration 0023, PR 18) ---

  async insertFilmTerritoryWithholding(
    row: Omit<FilmTerritoryWithholdingRecord, 'id'>,
  ): Promise<FilmTerritoryWithholdingRecord> {
    // UNIQUE on event_id (the content-derived match_queue event): a duplicate
    // insert throws here (the same failure mode the canonical store
    // exhibits) and the caller recovers by reading the existing row — one
    // withholding log per line, ever.
    return this.oneStrict<FilmTerritoryWithholdingRecord>(
      this.client
        .from(TABLES.filmTerritoryWithholdings)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertFilmTerritoryWithholding',
    );
  }

  async getFilmTerritoryWithholdingByEventId(
    eventId: string,
  ): Promise<FilmTerritoryWithholdingRecord | undefined> {
    return this.one<FilmTerritoryWithholdingRecord>(
      this.client
        .from(TABLES.filmTerritoryWithholdings)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getFilmTerritoryWithholdingByEventId',
    );
  }

  async listFilmTerritoryWithholdingsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryWithholdingRecord[]> {
    // Oldest first (created_at ASC, insertion_order ASC) — the film's
    // withholding history in log order.
    return this.many<FilmTerritoryWithholdingRecord>(
      this.client
        .from(TABLES.filmTerritoryWithholdings)
        .select()
        .eq('film_id', filmId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listFilmTerritoryWithholdingsByFilm',
    );
  }

  async insertFilmTerritoryDistribution(
    row: Omit<FilmTerritoryDistributionRecord, 'id'>,
  ): Promise<FilmTerritoryDistributionRecord> {
    // UNIQUE on (escrow_ledger_id, territory_code): a duplicate insert
    // throws here (the same failure mode the canonical store exhibits) and
    // the caller recovers by reading the existing rows — one routing
    // decision per released receipt per territory, ever.
    return this.oneStrict<FilmTerritoryDistributionRecord>(
      this.client
        .from(TABLES.filmTerritoryDistributions)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertFilmTerritoryDistribution',
    );
  }

  async listFilmTerritoryDistributionsByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmTerritoryDistributionRecord[]> {
    // One receipt's territory envelopes, territory_code ASC (deterministic).
    return this.many<FilmTerritoryDistributionRecord>(
      this.client
        .from(TABLES.filmTerritoryDistributions)
        .select()
        .eq('escrow_ledger_id', escrowLedgerId)
        .order('territory_code', { ascending: true }),
      'listFilmTerritoryDistributionsByEscrow',
    );
  }

  async listFilmTerritoryDistributionsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryDistributionRecord[]> {
    // Oldest first — the per-territory paid state folds in routing order
    // (insertion_order ASC is the strict tiebreak when created_at ties).
    return this.many<FilmTerritoryDistributionRecord>(
      this.client
        .from(TABLES.filmTerritoryDistributions)
        .select()
        .eq('film_id', filmId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listFilmTerritoryDistributionsByFilm',
    );
  }

  async updateFilmTerritoryDistributionStatus(
    id: string,
    status: FilmTerritoryDistributionRecord['status'],
  ): Promise<FilmTerritoryDistributionRecord | undefined> {
    return this.one<FilmTerritoryDistributionRecord>(
      this.client
        .from(TABLES.filmTerritoryDistributions)
        .update({ status })
        .eq('id', id)
        .select()
        .maybeSingle(),
      'updateFilmTerritoryDistributionStatus',
    );
  }

  async deleteFilmTerritoryDistribution(id: string): Promise<void> {
    const { error } = await this.client
      .from(TABLES.filmTerritoryDistributions)
      .delete()
      .eq('id', id);
    if (error) {
      throw new Error(`deleteFilmTerritoryDistribution: ${error.message} (code ${error.code})`);
    }
  }

  // --- Podcast episode splits + guest milestone bonuses (migration 0017, PR 11) ---

  async upsertPodcastEpisodeSplitSchedule(
    row: PodcastEpisodeSplitScheduleRecord,
  ): Promise<PodcastEpisodeSplitScheduleRecord> {
    // One schedule per episode — the upsert targets the episode_id key, so
    // a re-registration after the lock check replaces the row atomically.
    return this.oneStrict<PodcastEpisodeSplitScheduleRecord>(
      this.client
        .from(TABLES.podcastEpisodeSplitSchedules)
        .upsert(row, { onConflict: 'episode_id' })
        .select()
        .maybeSingle(),
      'upsertPodcastEpisodeSplitSchedule',
    );
  }

  async getPodcastEpisodeSplitSchedule(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitScheduleRecord | undefined> {
    return this.one<PodcastEpisodeSplitScheduleRecord>(
      this.client
        .from(TABLES.podcastEpisodeSplitSchedules)
        .select()
        .eq('episode_id', episodeId)
        .maybeSingle(),
      'getPodcastEpisodeSplitSchedule',
    );
  }

  async insertPodcastEpisodeSplitAccrual(
    row: Omit<PodcastEpisodeSplitAccrualRecord, 'id'>,
  ): Promise<PodcastEpisodeSplitAccrualRecord> {
    // UNIQUE on source_event_id: a duplicate insert throws here (the same
    // failure mode the canonical store exhibits) and the caller counts the
    // replay as a no-op — one accrual per funding event, ever.
    return this.oneStrict<PodcastEpisodeSplitAccrualRecord>(
      this.client
        .from(TABLES.podcastEpisodeSplitAccruals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertPodcastEpisodeSplitAccrual',
    );
  }

  async getPodcastEpisodeSplitAccrualBySourceEvent(
    sourceEventId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord | undefined> {
    return this.one<PodcastEpisodeSplitAccrualRecord>(
      this.client
        .from(TABLES.podcastEpisodeSplitAccruals)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getPodcastEpisodeSplitAccrualBySourceEvent',
    );
  }

  async listPodcastEpisodeSplitAccruals(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord[]> {
    // Oldest first — routing order (insertion_order ASC is the strict
    // tiebreak when created_at ties).
    return this.many<PodcastEpisodeSplitAccrualRecord>(
      this.client
        .from(TABLES.podcastEpisodeSplitAccruals)
        .select()
        .eq('episode_id', episodeId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listPodcastEpisodeSplitAccruals',
    );
  }

  async insertPodcastGuestBonusDefinition(
    row: PodcastGuestBonusDefinitionRecord,
  ): Promise<PodcastGuestBonusDefinitionRecord> {
    // Composite UNIQUE (episode, guest, kind, threshold) — one contract per
    // milestone; a duplicate insert throws (the caller surfaces it raw).
    return this.oneStrict<PodcastGuestBonusDefinitionRecord>(
      this.client
        .from(TABLES.podcastGuestBonusDefinitions)
        .insert(row)
        .select()
        .maybeSingle(),
      'insertPodcastGuestBonusDefinition',
    );
  }

  async listPodcastGuestBonusDefinitions(
    episodeId: string,
  ): Promise<PodcastGuestBonusDefinitionRecord[]> {
    // Oldest first — definition registration order (insertion_order ASC is
    // the strict tiebreak when created_at ties).
    return this.many<PodcastGuestBonusDefinitionRecord>(
      this.client
        .from(TABLES.podcastGuestBonusDefinitions)
        .select()
        .eq('episode_id', episodeId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listPodcastGuestBonusDefinitions',
    );
  }

  async insertPodcastGuestBonusAccrual(
    row: Omit<PodcastGuestBonusAccrualRecord, 'id'>,
  ): Promise<PodcastGuestBonusAccrualRecord> {
    // UNIQUE on event_id (the content-derived `podcast:bonus:` id) — the
    // once-only milestone arbiter; a duplicate insert throws.
    return this.oneStrict<PodcastGuestBonusAccrualRecord>(
      this.client
        .from(TABLES.podcastGuestBonusAccruals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertPodcastGuestBonusAccrual',
    );
  }

  async markPodcastGuestBonusAccrualPosted(
    id: string,
    holdingLedgerId: string,
  ): Promise<PodcastGuestBonusAccrualRecord | undefined> {
    return this.one<PodcastGuestBonusAccrualRecord>(
      this.client
        .from(TABLES.podcastGuestBonusAccruals)
        .update({ status: 'posted', holding_ledger_id: holdingLedgerId })
        .eq('id', id)
        .select()
        .maybeSingle(),
      'markPodcastGuestBonusAccrualPosted',
    );
  }

  async deletePodcastGuestBonusAccrual(id: string): Promise<void> {
    const { error } = await this.client
      .from(TABLES.podcastGuestBonusAccruals)
      .delete()
      .eq('id', id);
    if (error) {
      throw new Error(
        `deletePodcastGuestBonusAccrual: ${error.message} (code ${error.code})`,
      );
    }
  }

  async listPodcastGuestBonusAccruals(
    episodeId: string,
  ): Promise<PodcastGuestBonusAccrualRecord[]> {
    // Oldest first — accrual order (insertion_order ASC is the strict
    // tiebreak when created_at ties).
    return this.many<PodcastGuestBonusAccrualRecord>(
      this.client
        .from(TABLES.podcastGuestBonusAccruals)
        .select()
        .eq('episode_id', episodeId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listPodcastGuestBonusAccruals',
    );
  }

  async sumVerifiedImpressionsByEpisode(
    episodeId: string,
    eventIdPrefixes: readonly string[],
  ): Promise<number> {
    // The raw payload is the source of truth — parse it like every other
    // recovery path. Only rows whose event_id matches a milestone-kind
    // prefix count (downloads ignores subscription rows), and only VERIFIED
    // impressions count: held rows carry `podcast:held:` ids and unverified
    // rows never wrote a `podcast:imp:` row at all. The bound keeps the
    // scan honest — a truncated scan under-counts (fail-closed), never
    // over-pays.
    const rows = await this.many<{
      event_id: string;
      verified_impressions: number | null;
      raw_payload: string;
    }>(
      this.client
        .from(TABLES.matchQueue)
        .select('event_id,verified_impressions,raw_payload')
        .limit(VERIFIED_COUNT_SCAN_LIMIT),
      'sumVerifiedImpressionsByEpisode',
    );
    let total = 0;
    for (const row of rows) {
      if (!eventIdPrefixes.some((prefix) => row.event_id.startsWith(prefix))) {
        continue;
      }
      if (podcastEpisodeIdOfQueueRow(row.raw_payload) !== episodeId) continue;
      total += row.verified_impressions ?? 0;
    }
    return total;
  }

  // --- Gaming engine-royalty accumulator + item splits (migration 0018, PR 12) ---

  async insertGamingEngineRoyaltyEvent(
    row: Omit<GamingEngineRoyaltyEventRecord, 'id'>,
  ): Promise<GamingEngineRoyaltyEventRecord> {
    // UNIQUE on event_id: a duplicate insert throws here (the same failure
    // mode the canonical store exhibits) and the caller counts the replay
    // as a no-op — one contribution per queue event, ever.
    return this.oneStrict<GamingEngineRoyaltyEventRecord>(
      this.client
        .from(TABLES.gamingEngineRoyaltyEvents)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertGamingEngineRoyaltyEvent',
    );
  }

  async getGamingEngineRoyaltyEventByEventId(
    eventId: string,
  ): Promise<GamingEngineRoyaltyEventRecord | undefined> {
    return this.one<GamingEngineRoyaltyEventRecord>(
      this.client
        .from(TABLES.gamingEngineRoyaltyEvents)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getGamingEngineRoyaltyEventByEventId',
    );
  }

  async sumGamingEngineRoyaltyGross(
    platforms: readonly string[],
    productId: string,
    annualYear: number,
  ): Promise<string> {
    // The accumulator's state is the DERIVED sum of the contribution rows —
    // never a mutable counter (replayed gross can never cross the $1M
    // threshold twice). The family's platforms share one per-product line.
    // BigInt addition over the text micros, exact.
    const rows = await this.many<{ gross_micros: string }>(
      this.client
        .from(TABLES.gamingEngineRoyaltyEvents)
        .select('gross_micros')
        .in('platform', [...platforms])
        .eq('product_id', productId)
        .eq('annual_year', annualYear),
      'sumGamingEngineRoyaltyGross',
    );
    let total = 0n;
    for (const row of rows) {
      total += BigInt(row.gross_micros);
    }
    return total.toString();
  }

  async upsertGamingItemSplitSchedule(
    row: GamingItemSplitScheduleRecord,
  ): Promise<GamingItemSplitScheduleRecord> {
    // One schedule per item — the upsert targets the item_id key, so a
    // re-registration after the lock check replaces the row atomically.
    return this.oneStrict<GamingItemSplitScheduleRecord>(
      this.client
        .from(TABLES.gamingItemSplitSchedules)
        .upsert(row, { onConflict: 'item_id' })
        .select()
        .maybeSingle(),
      'upsertGamingItemSplitSchedule',
    );
  }

  async getGamingItemSplitSchedule(
    itemId: string,
  ): Promise<GamingItemSplitScheduleRecord | undefined> {
    return this.one<GamingItemSplitScheduleRecord>(
      this.client
        .from(TABLES.gamingItemSplitSchedules)
        .select()
        .eq('item_id', itemId)
        .maybeSingle(),
      'getGamingItemSplitSchedule',
    );
  }

  async insertGamingSplitPayout(
    row: Omit<GamingSplitPayoutRecord, 'id'>,
  ): Promise<GamingSplitPayoutRecord> {
    // UNIQUE on source_event_id: a duplicate insert throws here (the same
    // failure mode the canonical store exhibits) and the caller counts the
    // replay as a no-op — one routing per funding event, ever.
    return this.oneStrict<GamingSplitPayoutRecord>(
      this.client
        .from(TABLES.gamingSplitPayouts)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertGamingSplitPayout',
    );
  }

  async getGamingSplitPayoutBySourceEvent(
    sourceEventId: string,
  ): Promise<GamingSplitPayoutRecord | undefined> {
    return this.one<GamingSplitPayoutRecord>(
      this.client
        .from(TABLES.gamingSplitPayouts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getGamingSplitPayoutBySourceEvent',
    );
  }

  async listGamingSplitPayouts(itemId: string): Promise<GamingSplitPayoutRecord[]> {
    // Oldest first — routing order (insertion_order ASC is the strict
    // tiebreak when created_at ties).
    return this.many<GamingSplitPayoutRecord>(
      this.client
        .from(TABLES.gamingSplitPayouts)
        .select()
        .eq('item_id', itemId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listGamingSplitPayouts',
    );
 }

  // --- Gaming cashout states: DevEx conversion logs + studio KYC (migration 0019, PR 13) ---

  async listVirtualCurrencyCashoutCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'virtual_currency_cashout_pending')
        .eq('status', 'virtual_currency_cashout_pending')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listVirtualCurrencyCashoutCredits',
    );
  }

  async settleVirtualCurrencyCashout(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The status predicate in the UPDATE's WHERE is the CAS: PostgREST
    // matches the row only while it is still locked, so the concurrent
    // release loser gets zero rows back (maybeSingle → undefined).
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'virtual_currency_cashout_pending')
        .select()
        .maybeSingle(),
      'settleVirtualCurrencyCashout',
    );
  }

  async listEsportsPoolEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'esports_prize_pool_pending')
        .eq('status', 'esports_prize_pool_pending')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listEsportsPoolEscrowCredits',
    );
  }

  async settleEsportsPoolEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The same CAS as the film-escrow and gaming-cashout settles, scoped
    // to the esports lock state only.
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'esports_prize_pool_pending')
        .select()
        .maybeSingle(),
      'settleEsportsPoolEscrow',
    );
  }

  async insertGamingDevexConversionLog(
    row: Omit<GamingDevexConversionLogRecord, 'id'>,
  ): Promise<GamingDevexConversionLogRecord> {
    // UNIQUE on event_id: a duplicate insert throws here (the same failure
    // mode the canonical store exhibits) and the caller counts the replay
    // as a no-op — one conversion log per funding line, ever.
    return this.oneStrict<GamingDevexConversionLogRecord>(
      this.client
        .from(TABLES.gamingDevexConversionLogs)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertGamingDevexConversionLog',
    );
  }

  async getGamingDevexConversionLogByEventId(
    eventId: string,
  ): Promise<GamingDevexConversionLogRecord | undefined> {
    return this.one<GamingDevexConversionLogRecord>(
      this.client
        .from(TABLES.gamingDevexConversionLogs)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getGamingDevexConversionLogByEventId',
    );
  }

  async listGamingDevexConversionLogsByBatch(
    batchRef: string,
  ): Promise<GamingDevexConversionLogRecord[]> {
    // Oldest first — write order (insertion_order ASC is the strict
    // tiebreak when created_at ties).
    return this.many<GamingDevexConversionLogRecord>(
      this.client
        .from(TABLES.gamingDevexConversionLogs)
        .select()
        .eq('settlement_batch_ref', batchRef)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listGamingDevexConversionLogsByBatch',
    );
  }

  async settleGamingDevexConversionLogsByBatch(
    batchRef: string,
    settledAt: string,
  ): Promise<number> {
    // The status predicate in the UPDATE's WHERE is the batch-scope CAS:
    // only PENDING rows flip, already-settled rows are untouched, and the
    // returned row count is the honest report of what this call settled.
    const settled = await this.many<GamingDevexConversionLogRecord>(
      this.client
        .from(TABLES.gamingDevexConversionLogs)
        .update({ status: 'fiat_settled', settled_at: settledAt })
        .eq('settlement_batch_ref', batchRef)
        .eq('status', 'pending_fiat_settlement')
        .select(),
      'settleGamingDevexConversionLogsByBatch',
    );
    return settled.length;
  }

  async upsertGamingStudioKyc(
    row: GamingStudioKycRecord,
  ): Promise<GamingStudioKycRecord> {
    // One verification state per studio payee — the upsert targets the
    // studio_payee_id key, so a re-verification replaces the row atomically.
    return this.oneStrict<GamingStudioKycRecord>(
      this.client
        .from(TABLES.gamingStudioKycVerifications)
        .upsert(row, { onConflict: 'studio_payee_id' })
        .select()
        .maybeSingle(),
      'upsertGamingStudioKyc',
    );
  }

  async getGamingStudioKyc(
    studioPayeeId: string,
  ): Promise<GamingStudioKycRecord | undefined> {
    return this.one<GamingStudioKycRecord>(
      this.client
        .from(TABLES.gamingStudioKycVerifications)
        .select()
        .eq('studio_payee_id', studioPayeeId)
        .maybeSingle(),
      'getGamingStudioKyc',
    );
  }

  // --- VTuber agency licensing holdbacks + tax verification (0020, PR 15) ---

  async listAvatarIpHoldbackCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'avatar_ip_licensing_holdback')
        .eq('status', 'avatar_ip_licensing_holdback')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listAvatarIpHoldbackCredits',
    );
  }

  async settleAvatarIpHoldback(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The same CAS as the film-escrow/gaming-cashout/esports settles,
    // scoped to the holdback lock state only.
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'avatar_ip_licensing_holdback')
        .select()
        .maybeSingle(),
      'settleAvatarIpHoldback',
    );
  }

  async upsertVtuberTaxWithholdingVerification(
    row: VtuberTaxWithholdingVerificationRecord,
  ): Promise<VtuberTaxWithholdingVerificationRecord> {
    // One verification state per payee + tax year — the upsert targets the
    // composite key, so a re-verification replaces the row atomically.
    return this.oneStrict<VtuberTaxWithholdingVerificationRecord>(
      this.client
        .from(TABLES.vtuberTaxWithholdingVerifications)
        .upsert(row, { onConflict: 'payee_id,tax_year' })
        .select()
        .maybeSingle(),
      'upsertVtuberTaxWithholdingVerification',
    );
  }

  async getVtuberTaxWithholdingVerification(
    payeeId: string,
    taxYear: number,
  ): Promise<VtuberTaxWithholdingVerificationRecord | undefined> {
    return this.one<VtuberTaxWithholdingVerificationRecord>(
      this.client
        .from(TABLES.vtuberTaxWithholdingVerifications)
        .select()
        .eq('payee_id', payeeId)
        .eq('tax_year', taxYear)
        .maybeSingle(),
      'getVtuberTaxWithholdingVerification',
    );
  }

  async insertVtuberTechSetupAmortizationSchedule(
    row: Omit<VtuberTechSetupAmortizationScheduleRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord> {
    // UNIQUE on schedule_ref: a duplicate insert throws here (the same
    // failure mode the canonical store exhibits).
    return this.oneStrict<VtuberTechSetupAmortizationScheduleRecord>(
      this.client
        .from(TABLES.vtuberTechSetupAmortizationSchedules)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertVtuberTechSetupAmortizationSchedule',
    );
  }

  async getVtuberTechSetupAmortizationScheduleByRef(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord | undefined> {
    return this.one<VtuberTechSetupAmortizationScheduleRecord>(
      this.client
        .from(TABLES.vtuberTechSetupAmortizationSchedules)
        .select()
        .eq('schedule_ref', scheduleRef)
        .maybeSingle(),
      'getVtuberTechSetupAmortizationScheduleByRef',
    );
  }

  async insertVtuberTechSetupAmortizationLine(
    row: Omit<VtuberTechSetupAmortizationLineRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationLineRecord> {
    // UNIQUE on (schedule_ref, line_index): a concurrent consume of the
    // same line throws — the insert-as-lock consume arbiter (the PR 12
    // accumulator discipline) — and the caller re-derives the next line.
    return this.oneStrict<VtuberTechSetupAmortizationLineRecord>(
      this.client
        .from(TABLES.vtuberTechSetupAmortizationLines)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertVtuberTechSetupAmortizationLine',
    );
  }

  async listVtuberTechSetupAmortizationLines(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationLineRecord[]> {
    // Line index order — the deterministic consumption order
    // (insertion_order ASC is the strict tiebreak, though the unique
    // constraint precludes ties).
    return this.many<VtuberTechSetupAmortizationLineRecord>(
      this.client
        .from(TABLES.vtuberTechSetupAmortizationLines)
        .select()
        .eq('schedule_ref', scheduleRef)
        .order('line_index', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listVtuberTechSetupAmortizationLines',
    );
  }

  // --- Derivative asset royalty cascade (migration 0021, PR 16) ---

  async insertDerivativeRoyaltyEdge(
    row: Omit<DerivativeRoyaltyEdgeRecord, 'id'>,
  ): Promise<DerivativeRoyaltyEdgeRecord> {
    // UNIQUE on (asset_id, parent_asset_id, upstream_creator_payee_id): a
    // duplicate registration throws here (the same failure mode the
    // canonical store exhibits).
    return this.oneStrict<DerivativeRoyaltyEdgeRecord>(
      this.client
        .from(TABLES.derivativeRoyaltyEdges)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertDerivativeRoyaltyEdge',
    );
  }

  async getDerivativeRoyaltyEdgesByAsset(assetId: string): Promise<DerivativeRoyaltyEdgeRecord[]> {
    // created_at ASC with the insertion-order tiebreak — the deterministic
    // reservation order (the walk's per-node lookup).
    return this.many<DerivativeRoyaltyEdgeRecord>(
      this.client
        .from(TABLES.derivativeRoyaltyEdges)
        .select()
        .eq('asset_id', assetId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'getDerivativeRoyaltyEdgesByAsset',
    );
  }

  async insertSampleClearanceEdge(
    row: Omit<SampleClearanceEdgeRecord, 'id'>,
  ): Promise<SampleClearanceEdgeRecord> {
    // UNIQUE on (work_id, parent_composition_id, rights_holder_payee_id,
    // rights_type): a duplicate registration throws here (the same failure
    // mode the canonical store exhibits). The same (work, parent) pair on
    // BOTH sides of the rights separation is two distinct contracts, not a
    // duplicate.
    return this.oneStrict<SampleClearanceEdgeRecord>(
      this.client
        .from(TABLES.sampleClearanceEdges)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertSampleClearanceEdge',
    );
  }

  async getSampleClearanceEdgesByWork(workId: string): Promise<SampleClearanceEdgeRecord[]> {
    // created_at ASC with the insertion-order tiebreak — the deterministic
    // reservation order (the walk's per-node lookup). Edges for BOTH sides
    // of the rights separation return; the cascade planner filters by the
    // line's rights_type.
    return this.many<SampleClearanceEdgeRecord>(
      this.client
        .from(TABLES.sampleClearanceEdges)
        .select()
        .eq('work_id', workId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'getSampleClearanceEdgesByWork',
    );
  }

  async insertCompositionPublisher(
    row: Omit<CompositionPublisherRecord, 'id'>,
  ): Promise<CompositionPublisherRecord> {
    // UNIQUE on (composition_id, publisher_payee_id): a duplicate
    // registration throws here (the same failure mode the canonical store
    // exhibits).
    return this.oneStrict<CompositionPublisherRecord>(
      this.client
        .from(TABLES.compositionPublishers)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertCompositionPublisher',
    );
  }

  async listCompositionPublishers(compositionId: string): Promise<CompositionPublisherRecord[]> {
    // created_at ASC with the insertion-order tiebreak — the deterministic
    // order the statutory mechanical pool routes in.
    return this.many<CompositionPublisherRecord>(
      this.client
        .from(TABLES.compositionPublishers)
        .select()
        .eq('composition_id', compositionId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listCompositionPublishers',
    );
  }

  // --- BaaS transfers ---

  async insertBaasTransfer(row: Omit<BaasTransferRecord, 'id'>): Promise<BaasTransferRecord> {
    return this.oneStrict<BaasTransferRecord>(
      this.client
        .from(TABLES.baasTransfers)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBaasTransfer',
    );
  }

  async getBaasTransfer(id: string): Promise<BaasTransferRecord | undefined> {
    return this.one<BaasTransferRecord>(
      this.client.from(TABLES.baasTransfers).select().eq('id', id).maybeSingle(),
      'getBaasTransfer',
    );
  }

  async listBaasTransfers(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<BaasTransferRecord[]> {
    return this.many<BaasTransferRecord>(
      this.client
        .from(TABLES.baasTransfers)
        .select()
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listBaasTransfers',
    );
  }

  async updateBaasTransferStatus(
    id: string,
    status: BaasTransferRecord['status'],
  ): Promise<BaasTransferRecord | undefined> {
    return this.one<BaasTransferRecord>(
      this.client
        .from(TABLES.baasTransfers)
        .update({ status })
        .eq('id', id)
        .select()
        .maybeSingle(),
      'updateBaasTransferStatus',
    );
  }

  // --- Company dust ---

  async insertCompanyDust(row: Omit<CompanyDustRecord, 'id'>): Promise<CompanyDustRecord> {
    return this.oneStrict<CompanyDustRecord>(
      this.client
        .from(TABLES.companyDust)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertCompanyDust',
    );
  }

  async listCompanyDustByRun(splitRunId: string): Promise<CompanyDustRecord[]> {
    return this.many<CompanyDustRecord>(
      this.client
        .from(TABLES.companyDust)
        .select()
        .eq('split_run_id', splitRunId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listCompanyDustByRun',
    );
  }

  // --- Compliance ---

  async getCreatorTaxProfile(creatorId: string): Promise<CreatorTaxProfile | undefined> {
    return this.one<CreatorTaxProfile>(
      this.client
        .from(TABLES.taxProfiles)
        .select()
        .eq('creator_id', creatorId)
        .maybeSingle(),
      'getCreatorTaxProfile',
    );
  }

  async upsertCreatorTaxProfile(row: CreatorTaxProfile): Promise<CreatorTaxProfile> {
    return this.oneStrict<CreatorTaxProfile>(
      this.client
        .from(TABLES.taxProfiles)
        .upsert(row, { onConflict: 'creator_id' })
        .select()
        .maybeSingle(),
      'upsertCreatorTaxProfile',
    );
  }

  async getCreatorYtd(
    creatorId: string,
    taxYear: number,
  ): Promise<CreatorYtdEarnings | undefined> {
    return this.one<CreatorYtdEarnings>(
      this.client
        .from(TABLES.creatorYtd)
        .select()
        .eq('creator_id', creatorId)
        .eq('tax_year', taxYear)
        .maybeSingle(),
      'getCreatorYtd',
    );
  }

  async upsertCreatorYtd(row: CreatorYtdEarnings): Promise<CreatorYtdEarnings> {
    return this.oneStrict<CreatorYtdEarnings>(
      this.client
        .from(TABLES.creatorYtd)
        .upsert(row, { onConflict: 'creator_id,tax_year' })
        .select()
        .maybeSingle(),
      'upsertCreatorYtd',
    );
  }

  async insertTaxEscrow(row: Omit<TaxEscrowRecord, 'id'>): Promise<TaxEscrowRecord> {
    return this.oneStrict<TaxEscrowRecord>(
      this.client
        .from(TABLES.taxEscrow)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertTaxEscrow',
    );
  }

  async listTaxEscrowByCreator(
    creatorId: string,
    taxYear: number,
  ): Promise<TaxEscrowRecord[]> {
    return this.many<TaxEscrowRecord>(
      this.client
        .from(TABLES.taxEscrow)
        .select()
        .eq('creator_id', creatorId)
        .eq('tax_year', taxYear)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listTaxEscrowByCreator',
    );
  }

  // --- Vaults + disputes ---

  async getVault(payeeId: string): Promise<SovereignVaultRecord | undefined> {
    return this.one<SovereignVaultRecord>(
      this.client.from(TABLES.vaults).select().eq('payee_id', payeeId).maybeSingle(),
      'getVault',
    );
  }

  async listVaults(): Promise<SovereignVaultRecord[]> {
    return this.many<SovereignVaultRecord>(
      this.client.from(TABLES.vaults).select().order('payee_id', { ascending: true }),
      'listVaults',
    );
  }

  async upsertVault(row: SovereignVaultRecord): Promise<SovereignVaultRecord> {
    return this.oneStrict<SovereignVaultRecord>(
      this.client
        .from(TABLES.vaults)
        .upsert(row, { onConflict: 'payee_id' })
        .select()
        .maybeSingle(),
      'upsertVault',
    );
  }

  async applyVaultDelta(input: VaultDeltaInput): Promise<ApplyVaultDeltaResult> {
    const min = input.min_balances ?? {};
    const result = await this.one<VaultDeltaRpcEnvelope>(
      this.client.rpc('apply_vault_delta', {
        p_payee_id: input.payee_id,
        p_payee_name: input.payee_name,
        p_available_delta: input.delta.available_balance,
        p_pending_delta: input.delta.pending_balance,
        p_reserve_delta: input.delta.reserve_balance,
        p_min_available: min.available_balance ?? null,
        p_min_pending: min.pending_balance ?? null,
        p_min_reserve: min.reserve_balance ?? null,
        p_create_if_missing: input.create_if_missing,
        p_updated_at: input.updated_at,
      }),
      'applyVaultDelta',
    );
    if (result === undefined) {
      // The function's contract is to always return an outcome envelope;
      // jsonb null would be a broken function deployment, not a legal result.
      throw new Error('applyVaultDelta: expected an outcome envelope from apply_vault_delta, got none.');
    }
    if (result.outcome !== 'applied') {
      return { outcome: result.outcome };
    }
    return {
      outcome: 'applied',
      // sovereign_vaults carries no insertion_order column (0006), so the
      // jsonb row is the record verbatim; toRecord is a no-op projection.
      vault: toRecord<SovereignVaultRecord>(
        result.vault as Record<string, unknown>,
      ),
    };
  }

  async getVaultDispute(payeeId: string): Promise<VaultDisputeRecord | undefined> {
    return this.one<VaultDisputeRecord>(
      this.client
        .from(TABLES.vaultDisputes)
        .select()
        .eq('payee_id', payeeId)
        .maybeSingle(),
      'getVaultDispute',
    );
  }

  async upsertVaultDispute(row: VaultDisputeRecord): Promise<VaultDisputeRecord> {
    return this.oneStrict<VaultDisputeRecord>(
      this.client
        .from(TABLES.vaultDisputes)
        .upsert(row, { onConflict: 'payee_id' })
        .select()
        .maybeSingle(),
      'upsertVaultDispute',
    );
  }

  async getCatalogDispute(workId: string): Promise<CatalogDisputeRecord | undefined> {
    return this.one<CatalogDisputeRecord>(
      this.client
        .from(TABLES.catalogDisputes)
        .select()
        .eq('work_id', workId)
        .maybeSingle(),
      'getCatalogDispute',
    );
  }

  async upsertCatalogDispute(row: CatalogDisputeRecord): Promise<CatalogDisputeRecord> {
    return this.oneStrict<CatalogDisputeRecord>(
      this.client
        .from(TABLES.catalogDisputes)
        .upsert(row, { onConflict: 'work_id' })
        .select()
        .maybeSingle(),
      'upsertCatalogDispute',
    );
  }

  // --- Recoupment ---

  async getRecoupmentAdvance(
    creatorId: string,
  ): Promise<RecoupmentAdvanceRecord | undefined> {
    return this.one<RecoupmentAdvanceRecord>(
      this.client
        .from(TABLES.recoupmentAdvances)
        .select()
        .eq('creator_id', creatorId)
        .maybeSingle(),
      'getRecoupmentAdvance',
    );
  }

  async upsertRecoupmentAdvance(row: RecoupmentAdvanceRecord): Promise<RecoupmentAdvanceRecord> {
    return this.oneStrict<RecoupmentAdvanceRecord>(
      this.client
        .from(TABLES.recoupmentAdvances)
        .upsert(row, { onConflict: 'creator_id' })
        .select()
        .maybeSingle(),
      'upsertRecoupmentAdvance',
    );
  }

  async listRecoupmentAdvances(): Promise<RecoupmentAdvanceRecord[]> {
    return this.many<RecoupmentAdvanceRecord>(
      this.client
        .from(TABLES.recoupmentAdvances)
        .select()
        .order('creator_id', { ascending: true }),
      'listRecoupmentAdvances',
    );
  }

  async insertRecoupmentLedger(
    row: Omit<RecoupmentLedgerRecord, 'id'>,
  ): Promise<RecoupmentLedgerRecord> {
    return this.oneStrict<RecoupmentLedgerRecord>(
      this.client
        .from(TABLES.recoupmentLedger)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertRecoupmentLedger',
    );
  }

  async listRecoupmentLedgerByRun(splitRunId: string): Promise<RecoupmentLedgerRecord[]> {
    return this.many<RecoupmentLedgerRecord>(
      this.client
        .from(TABLES.recoupmentLedger)
        .select()
        .eq('split_run_id', splitRunId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listRecoupmentLedgerByRun',
    );
  }

  // --- Payout holds + reversals ---

  async getPayoutHold(transferId: string): Promise<PayoutHoldRecord | undefined> {
    return this.one<PayoutHoldRecord>(
      this.client
        .from(TABLES.payoutHolds)
        .select()
        .eq('transfer_id', transferId)
        .maybeSingle(),
      'getPayoutHold',
    );
  }

  async insertPayoutHold(row: PayoutHoldRecord): Promise<PayoutHoldRecord> {
    return this.oneStrict<PayoutHoldRecord>(
      this.client.from(TABLES.payoutHolds).insert(row).select().maybeSingle(),
      'insertPayoutHold',
    );
  }

  async updatePayoutHoldStatus(
    transferId: string,
    status: PayoutHoldRecord['status'],
  ): Promise<PayoutHoldRecord | undefined> {
    return this.one<PayoutHoldRecord>(
      this.client
        .from(TABLES.payoutHolds)
        .update({ status })
        .eq('transfer_id', transferId)
        .select()
        .maybeSingle(),
      'updatePayoutHoldStatus',
    );
  }

  async sumInFlightPayoutHolds(payeeId: string): Promise<number> {
    const holds = await this.many<PayoutHoldRecord>(
      this.client
        .from(TABLES.payoutHolds)
        .select('amount_cents')
        .eq('payee_id', payeeId)
        .eq('status', 'in_flight'),
      'sumInFlightPayoutHolds',
    );
    return holds.reduce((total, hold) => total + hold.amount_cents, 0);
  }

  async insertPayoutReversal(
    row: Omit<PayoutReversalRecord, 'id'>,
  ): Promise<PayoutReversalRecord> {
    return this.oneStrict<PayoutReversalRecord>(
      this.client
        .from(TABLES.payoutReversals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertPayoutReversal',
    );
  }

  async getPayoutReversalByTransfer(
    transferId: string,
  ): Promise<PayoutReversalRecord | undefined> {
    return this.one<PayoutReversalRecord>(
      this.client
        .from(TABLES.payoutReversals)
        .select()
        .eq('transfer_id', transferId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'getPayoutReversalByTransfer',
    );
  }

  async updatePayoutReversal(
    id: string,
    patch: Pick<PayoutReversalRecord, 'journal_id' | 'ledger_transaction_id'>,
  ): Promise<PayoutReversalRecord | undefined> {
    return this.one<PayoutReversalRecord>(
      this.client
        .from(TABLES.payoutReversals)
        .update(patch)
        .eq('id', id)
        .select()
        .maybeSingle(),
      'updatePayoutReversal',
    );
  }

  async deletePayoutReversal(id: string): Promise<void> {
    const { error } = await this.client
      .from(TABLES.payoutReversals)
      .delete()
      .eq('id', id);
    if (error) {
      throw new Error(`deletePayoutReversal: ${error.message} (code ${error.code})`);
    }
  }

  // --- Webhook event ledgers ---

  async getWebhookEvent(eventId: string): Promise<BaasWebhookEventRecord | undefined> {
    return this.one<BaasWebhookEventRecord>(
      this.client
        .from(TABLES.baasWebhookEvents)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getWebhookEvent',
    );
  }

  async insertWebhookEvent(
    row: Omit<BaasWebhookEventRecord, 'id'>,
  ): Promise<BaasWebhookEventRecord> {
    return this.oneStrict<BaasWebhookEventRecord>(
      this.client
        .from(TABLES.baasWebhookEvents)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertWebhookEvent',
    );
  }

  async getDspWebhookEvent(eventId: string): Promise<DspWebhookEventRecord | undefined> {
    return this.one<DspWebhookEventRecord>(
      this.client
        .from(TABLES.dspWebhookEvents)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getDspWebhookEvent',
    );
  }

  async insertDspWebhookEvent(
    row: Omit<DspWebhookEventRecord, 'id'>,
  ): Promise<DspWebhookEventRecord> {
    return this.oneStrict<DspWebhookEventRecord>(
      this.client
        .from(TABLES.dspWebhookEvents)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertDspWebhookEvent',
    );
  }

  // --- GL ---

  async insertGlJournal(
    row: Omit<GlJournalRecord, 'id' | 'sequence' | 'prev_hash' | 'entry_hash' | 'state'> & {
      sequence?: number;
      prev_hash?: string;
      entry_hash?: string;
      state?: GlJournalRecord['state'];
    },
  ): Promise<GlJournalRecord> {
    return this.oneStrict<GlJournalRecord>(
      this.client
        .from(TABLES.glJournals)
        .insert({
          ...row,
          sequence: row.sequence ?? 0,
          prev_hash: row.prev_hash ?? '',
          entry_hash: row.entry_hash ?? '',
          state: row.state ?? 'posted',
          id: crypto.randomUUID(),
        })
        .select()
        .maybeSingle(),
      'insertGlJournal',
    );
  }

  async insertGlEntry(row: Omit<GlEntryRecord, 'id'>): Promise<GlEntryRecord> {
    return this.oneStrict<GlEntryRecord>(
      this.client
        .from(TABLES.glEntries)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertGlEntry',
    );
  }

  async listGlJournals(): Promise<GlJournalRecord[]> {
    return this.many<GlJournalRecord>(
      this.client
        .from(TABLES.glJournals)
        .select()
        .order('sequence', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listGlJournals',
    );
  }

  async getLatestGlJournal(): Promise<GlJournalRecord | undefined> {
    return this.one<GlJournalRecord>(
      this.client
        .from(TABLES.glJournals)
        .select()
        .order('sequence', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'getLatestGlJournal',
    );
  }

  async listGlJournalsByRef(refType: string, refId: string): Promise<GlJournalRecord[]> {
    return this.many<GlJournalRecord>(
      this.client
        .from(TABLES.glJournals)
        .select()
        .eq('ref_type', refType)
        .eq('ref_id', refId)
        .order('sequence', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listGlJournalsByRef',
    );
  }

  async listGlEntries(): Promise<GlEntryRecord[]> {
    return this.many<GlEntryRecord>(
      this.client
        .from(TABLES.glEntries)
        .select()
        .order('insertion_order', { ascending: true }),
      'listGlEntries',
    );
  }

  async listGlEntriesByJournal(journalId: string): Promise<GlEntryRecord[]> {
    return this.many<GlEntryRecord>(
      this.client
        .from(TABLES.glEntries)
        .select()
        .eq('journal_id', journalId)
        .order('insertion_order', { ascending: true }),
      'listGlEntriesByJournal',
    );
  }

  // --- Split-run reversals ---

  async insertSplitReversal(row: Omit<SplitReversalRecord, 'id'>): Promise<SplitReversalRecord> {
    return this.oneStrict<SplitReversalRecord>(
      this.client
        .from(TABLES.splitReversals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertSplitReversal',
    );
  }

  async getSplitReversalByRun(splitRunId: string): Promise<SplitReversalRecord | undefined> {
    return this.one<SplitReversalRecord>(
      this.client
        .from(TABLES.splitReversals)
        .select()
        .eq('split_run_id', splitRunId)
        .maybeSingle(),
      'getSplitReversalByRun',
    );
  }

  // --- SDK collection surfaces (migration 0007) ---

  async upsertClearance(row: MulClearanceRecord): Promise<MulClearanceRecord> {
    return this.oneStrict<MulClearanceRecord>(
      this.client
        .from(TABLES.mulClearances)
        .upsert(row, { onConflict: 'asset_cbt_code' })
        .select()
        .maybeSingle(),
      'upsertClearance',
    );
  }

  async getClearanceForAsset(assetCbtCode: string): Promise<MulClearanceRecord | undefined> {
    return this.one<MulClearanceRecord>(
      this.client
        .from(TABLES.mulClearances)
        .select()
        .eq('asset_cbt_code', assetCbtCode)
        .maybeSingle(),
      'getClearanceForAsset',
    );
  }

  async insertClearanceTransition(
    row: Omit<MulClearanceTransitionRecord, 'id'>,
  ): Promise<MulClearanceTransitionRecord> {
    return this.oneStrict<MulClearanceTransitionRecord>(
      this.client
        .from(TABLES.mulClearanceTransitions)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertClearanceTransition',
    );
  }

  async listClearanceTransitions(
    assetCbtCode: string,
  ): Promise<MulClearanceTransitionRecord[]> {
    return this.many<MulClearanceTransitionRecord>(
      this.client
        .from(TABLES.mulClearanceTransitions)
        .select()
        .eq('asset_cbt_code', assetCbtCode)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listClearanceTransitions',
    );
  }

  async insertMatchQueueEntry(row: Omit<MatchQueueRecord, 'id'>): Promise<MatchQueueRecord> {
    return this.oneStrict<MatchQueueRecord>(
      this.client
        .from(TABLES.matchQueue)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMatchQueueEntry',
    );
  }

  async getMatchQueueEntry(id: string): Promise<MatchQueueRecord | undefined> {
    return this.one<MatchQueueRecord>(
      this.client.from(TABLES.matchQueue).select().eq('id', id).maybeSingle(),
      'getMatchQueueEntry',
    );
  }

  async getMatchQueueEntryByEventId(
    eventId: string,
  ): Promise<MatchQueueRecord | undefined> {
    return this.one<MatchQueueRecord>(
      this.client
        .from(TABLES.matchQueue)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getMatchQueueEntryByEventId',
    );
  }

  async listMatchQueueEntries(
    status?: MatchQueueRecord['status'],
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<MatchQueueRecord[]> {
    let query = this.client.from(TABLES.matchQueue).select();
    if (status !== undefined) {
      query = query.eq('status', status);
    }
    return this.many<MatchQueueRecord>(
      query
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listMatchQueueEntries',
    );
  }

  async resolveMatchQueueEntry(
    id: string,
    resolution: MatchQueueResolution,
  ): Promise<MatchQueueRecord | undefined> {
    const patch =
      resolution.status === 'matched'
        ? {
            status: 'matched' as const,
            matched_cbt_code: resolution.cbtCode,
            resolved_at: new Date().toISOString(),
          }
        : {
            status: 'discarded' as const,
            matched_cbt_code: null,
            resolved_at: new Date().toISOString(),
          };
    return this.one<MatchQueueRecord>(
      this.client
        .from(TABLES.matchQueue)
        .update(patch)
        .eq('id', id)
        .select()
        .maybeSingle(),
      'resolveMatchQueueEntry',
    );
  }

  async insertStatementIngest(
    row: Omit<StatementIngestRecord, 'id'>,
  ): Promise<StatementIngestRecord> {
    return this.oneStrict<StatementIngestRecord>(
      this.client
        .from(TABLES.statementIngests)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertStatementIngest',
    );
  }

  async getStatementIngest(id: string): Promise<StatementIngestRecord | undefined> {
    return this.one<StatementIngestRecord>(
      this.client.from(TABLES.statementIngests).select().eq('id', id).maybeSingle(),
      'getStatementIngest',
    );
  }

  // --- Royalty recon job queue (migration 0011, spec art_7M0snhxc) ---

  async createReconJob(input: ReconJobInput): Promise<RoyaltyReconJobRecord> {
    const now = new Date().toISOString();
    const record: RoyaltyReconJobRecord = {
      id: crypto.randomUUID(),
      status: 'pending',
      source: input.source,
      ingest_id: input.ingest_id ?? null,
      requested_by: input.requested_by ?? null,
      engine: null, // resolved at claim — deterministic parse only by default
      attempts: 0,
      error: null,
      result: null,
      claimed_at: null,
      started_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    return this.oneStrict<RoyaltyReconJobRecord>(
      this.client
        .from(TABLES.reconJobs)
        .insert(record)
        .select()
        .maybeSingle(),
      'createReconJob',
    );
  }

  async getReconJob(id: string): Promise<RoyaltyReconJobRecord | undefined> {
    return this.one<RoyaltyReconJobRecord>(
      this.client.from(TABLES.reconJobs).select().eq('id', id).maybeSingle(),
      'getReconJob',
    );
  }

  async claimReconJob(
    now: Date = new Date(),
    engine: string | null = null,
  ): Promise<RoyaltyReconJobRecord | undefined> {
    // The migration-0011 claim RPC — one atomic statement with FOR UPDATE
    // SKIP LOCKED, stale-claim recovery, and the attempts increment. jsonb
    // null back means the pool was empty (a legal result, not an error).
    return this.one<RoyaltyReconJobRecord>(
      this.client.rpc('claim_royalty_recon_job', {
        p_now: now.toISOString(),
        p_engine: engine,
      }),
      'claimReconJob',
    );
  }

  async completeReconJob(
    id: string,
    result: ReconJobResult,
  ): Promise<RoyaltyReconJobRecord | undefined> {
    const job = await this.getReconJob(id);
    if (job === undefined) return undefined;
    if (isTerminalReconJob(job)) return job; // replay — leave the row untouched
    if (job.status !== 'pending' && job.status !== 'processing') return job;
    const now = new Date().toISOString();
    // The status .in() guard makes the transition safe against a concurrent
    // claim the read couldn't see — an unlucky race finishes as a no-op read.
    return this.one<RoyaltyReconJobRecord>(
      this.client
        .from(TABLES.reconJobs)
        .update({
          status: 'completed',
          result,
          error: null,
          completed_at: now,
          updated_at: now,
        })
        .eq('id', id)
        .in('status', ['pending', 'processing'])
        .select()
        .maybeSingle(),
      'completeReconJob',
    );
  }

  async failReconJob(id: string, error: string): Promise<RoyaltyReconJobRecord | undefined> {
    const job = await this.getReconJob(id);
    if (job === undefined) return undefined;
    if (isTerminalReconJob(job)) return job; // replay — leave the row untouched
    if (job.status !== 'pending' && job.status !== 'processing') return job;
    const now = new Date().toISOString();
    const patch =
      job.attempts >= RECON_MAX_ATTEMPTS
        ? {
            status: 'failed',
            error,
            completed_at: now,
            updated_at: now,
          }
        : {
            status: 'pending', // back to the pool for the next claim
            error,
            claimed_at: null, // nobody holds it while it waits
            updated_at: now,
          };
    return this.one<RoyaltyReconJobRecord>(
      this.client
        .from(TABLES.reconJobs)
        .update(patch)
        .eq('id', id)
        .in('status', ['pending', 'processing'])
        .select()
        .maybeSingle(),
      'failReconJob',
    );
  }

  // --- The UCT credential vault (migration 0013, PR 5) — every query is
  // holder-scoped: a foreign (holder, id) pair matches no row, which the
  // routes surface as the same 404 an unknown id gets.

  async createDistributorConnection(
    input: DistributorConnectionInput,
  ): Promise<DistributorConnectionUpsert> {
    const now = new Date().toISOString();
    // Reconnect = rotate: one ACTIVE row per (holder, distributor) — this
    // read-then-write is the store seam's enforcement of the migration's
    // partial unique index. A race that slips between the two statements
    // fails closed: Postgres rejects the second insert (uq_distributor_connections_active)
    // and the thrown store error propagates — the route never half-writes.
    const active = await this.one<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .select()
        .eq('holder_id', input.holder_id)
        .eq('distributor', input.distributor)
        .eq('status', 'connected')
        .maybeSingle(),
      'createDistributorConnection',
    );
    if (active !== undefined) {
      return this.oneStrict<DistributorConnectionRecord>(
        this.client
          .from(TABLES.distributorConnections)
          .update({
            username_encrypted: input.username_encrypted,
            password_encrypted: input.password_encrypted,
            updated_at: now,
          })
          .eq('id', active.id)
          .eq('holder_id', input.holder_id)
          .select()
          .maybeSingle(),
        'createDistributorConnection',
      ).then((connection) => ({ connection, rotated: true }));
    }
    const record = {
      id: crypto.randomUUID(),
      holder_id: input.holder_id,
      distributor: input.distributor,
      status: 'connected' as const,
      username_encrypted: input.username_encrypted,
      password_encrypted: input.password_encrypted,
      last_verified_at: null, // the Astra agent writes traversal provenance (PR 6)
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    return this.oneStrict<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .insert(record)
        .select()
        .maybeSingle(),
      'createDistributorConnection',
    ).then((connection) => ({ connection, rotated: false }));
  }

  async listDistributorConnections(holderId: string): Promise<DistributorConnectionRecord[]> {
    // Newest first — insertion_order DESC is the strict tiebreak when
    // created_at strings tie.
    return this.many<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .select()
        .eq('holder_id', holderId)
        .order('insertion_order', { ascending: false }),
      'listDistributorConnections',
    );
  }

  async getDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined> {
    return this.one<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .select()
        .eq('id', id)
        .eq('holder_id', holderId)
        .maybeSingle(),
      'getDistributorConnection',
    );
  }

  async disconnectDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined> {
    // The replay no-op: an already-disconnected connection returns untouched —
    // no second write, no fresh updated_at (SQLite + in-memory parity).
    const existing = await this.getDistributorConnection(holderId, id);
    if (existing === undefined || existing.status === 'disconnected') return existing;

    const now = new Date().toISOString();
    // PostgREST update+select returns the rows the filter matched — the
    // holder_id eq makes a foreign id match nothing, i.e. undefined.
    return this.one<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .update({ status: 'disconnected', updated_at: now })
        .eq('id', id)
        .eq('holder_id', holderId)
        .select()
        .maybeSingle(),
      'disconnectDistributorConnection',
    );
  }

  async listActiveDistributorConnections(): Promise<DistributorConnectionRecord[]> {
    // Oldest insertion first — the sweep traverses in connect order
    // (insertion_order ASC is the strict tiebreak when created_at ties).
    return this.many<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .select()
        .eq('status', 'connected')
        .order('insertion_order', { ascending: true }),
      'listActiveDistributorConnections',
    );
  }

  async markDistributorTraversal(
    id: string,
    outcome: DistributorTraversalOutcome,
  ): Promise<DistributorConnectionRecord | undefined> {
    const now = new Date().toISOString();
    // Success verifies (and clears the stale error); failure records the
    // honest reason and never touches last_verified_at. Neither ever flips
    // status — disconnect is the holder's explicit act.
    const patch =
      'verifiedAt' in outcome
        ? { last_verified_at: outcome.verifiedAt, last_error: null, updated_at: now }
        : { last_error: outcome.error, updated_at: now };
    return this.one<DistributorConnectionRecord>(
      this.client
        .from(TABLES.distributorConnections)
        .update(patch)
        .eq('id', id)
        .select()
        .maybeSingle(),
      'markDistributorTraversal',
    );
  }

  // --- Clearinghouse kernel + Sync Library seams (migration 0008) ---

  async getCreatorUct(creatorId: string): Promise<CreatorUctRecord | undefined> {
    // (a) The signup registry's holder entry for this rightsHolderId — the
    // root UCT lives there, minted at signup. The registry JSONB has no
    // authenticated-role grant, which is why the seam reads it through the
    // service-role client this store holds.
    const registry = await this.one<{ rights_holders: unknown }>(
      this.client
        .from(TABLES.assets)
        .select('rights_holders')
        .eq('cbt_code', SIGNUP_REGISTRY_CBT_CODE)
        .maybeSingle(),
      'getCreatorUct',
    );
    const holders = Array.isArray(registry?.rights_holders) ? registry.rights_holders : [];
    const entries = holders
      .map((holder) => (isRegistryHolderUctEntry(holder) ? holder : null))
      .filter((holder): holder is Exclude<typeof holder, null> => holder !== null);
    const entry = entries.find(
      (holder) =>
        holder.rightsHolderId === creatorId &&
        typeof holder.uct === 'string' &&
        holder.uct.trim() !== '',
    );
    if (entry === undefined) return undefined; // no root UCT — the typed identity error upstream

    // (b) The creator_profiles ISNI (0007) — keyed by the holder's
    // normalized email when present; a profile row is optional for the UCT.
    let isni: string | null = null;
    if (typeof entry.email === 'string' && entry.email.trim() !== '') {
      const profile = await this.one<{ isni: string | null }>(
        this.client
          .from(TABLES.creatorProfiles)
          .select('isni')
          .eq('email', entry.email.trim().toLowerCase())
          .maybeSingle(),
        'getCreatorUct',
      );
      isni = profile?.isni ?? null;
    }

    return { creatorId, uctNumber: entry.uct as string, isni };
  }

  async upsertSyncCatalogItem(
    row: Omit<SyncCatalogItemRecord, 'updated_at'> & { updated_at?: string },
  ): Promise<SyncCatalogItemRecord> {
    const record: SyncCatalogItemRecord = {
      ...row,
      updated_at: row.updated_at ?? new Date().toISOString(),
    };
    // The 0008 columns live ON cbt_assets — the upsert targets the parent
    // asset row keyed by its UNIQUE cbt_code. An unknown asset's insert
    // violates the parent's NOT NULL identity columns and fails closed.
    return this.oneStrict<SyncCatalogItemRecord>(
      this.client
        .from(TABLES.assets)
        .upsert(
          {
            cbt_code: record.cbt_code,
            is_pre_cleared: record.is_pre_cleared,
            sync_fee_cents: record.sync_fee_cents,
            genre: record.genre,
            bpm: record.bpm,
            updated_at: record.updated_at,
          },
          { onConflict: 'cbt_code' },
        )
        .select('cbt_code, is_pre_cleared, sync_fee_cents, genre, bpm, updated_at')
        .maybeSingle(),
      'upsertSyncCatalogItem',
    );
  }

  async getSyncCatalogItem(cbtCode: string): Promise<SyncCatalogItemRecord | undefined> {
    return this.one<SyncCatalogItemRecord>(
      this.client
        .from(TABLES.assets)
        .select('cbt_code, is_pre_cleared, sync_fee_cents, genre, bpm, updated_at')
        .eq('cbt_code', cbtCode)
        .maybeSingle(),
      'getSyncCatalogItem',
    );
  }

  async listSyncCatalogItems(): Promise<SyncCatalogItemRecord[]> {
    return this.many<SyncCatalogItemRecord>(
      this.client
        .from(TABLES.assets)
        .select('cbt_code, is_pre_cleared, sync_fee_cents, genre, bpm, updated_at')
        .order('cbt_code', { ascending: true }),
      'listSyncCatalogItems',
    );
  }

  async insertSyncLicensePurchase(
    row: Omit<SyncLicensePurchaseRecord, 'id' | 'created_at'>,
  ): Promise<SyncLicensePurchaseRecord> {
    return this.oneStrict<SyncLicensePurchaseRecord>(
      this.client
        .from(TABLES.syncLicensePurchases)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSyncLicensePurchase',
    );
  }

  async getSyncLicensePurchaseByStamp(
    stamp: string,
  ): Promise<SyncLicensePurchaseRecord | undefined> {
    return this.one<SyncLicensePurchaseRecord>(
      this.client
        .from(TABLES.syncLicensePurchases)
        .select()
        .eq('cbt_settlement_stamp', stamp)
        .maybeSingle(),
      'getSyncLicensePurchaseByStamp',
    );
  }

  // --- Territory settlement seam (spec art_qNu4T32F) ---

  /**
   * The SDK-settled tier credits' territory projection — SDK-settled ONLY
   * (the transaction_type gate is in the query itself), oldest first.
   * Degrades to the honest empty read when the tier ledger predates the
   * wire's additive columns (PGRST204, the supabase-js face of the wire's
   * 42703 discipline: no stamp columns → no stamps exist → no territory);
   * every other failure propagates.
   */
  async listTerritorySettlements(): Promise<TerritorySettlementRecord[]> {
    const { data, error } = await this.client
      .from(TABLES.universalRoyaltyLedger)
      .select(
        'transaction_id, rights_holder_id, amount_cents, transaction_type, metadata, created_at',
      )
      .eq('transaction_type', SDK_SETTLEMENT_TRANSACTION_TYPE)
      .order('created_at', { ascending: true })
      .order('transaction_id', { ascending: true });
    if (error !== null) {
      if (error.code === 'PGRST204') return [];
      throw new Error(`listTerritorySettlements: ${error.message} (code ${error.code})`);
    }
    return ((data ?? []) as Record<string, unknown>[]).map((row) =>
      territorySettlementOfRow(row as unknown as UniversalRoyaltyLedgerRow),
    );
  }

  // --- Operations back-office seam (spec art_Eis55ifL) ---

  /**
   * The statement-ingest provenance list — newest first with the
   * insertion-order tiebreak (the match-queue list's exact discipline),
   * bounded by limit.
   */
  async listStatementIngests(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<StatementIngestRecord[]> {
    return this.many<StatementIngestRecord>(
      this.client
        .from(TABLES.statementIngests)
        .select()
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listStatementIngests',
    );
  }

  /**
   * The operator audit trail — the append-only admin_action_log read
   * (migration 0005). The service-role client is the only reader the
   * table's RLS admits. Rows return newest first; the table defines no
   * tiebreak key, so rows sharing a timestamp carry no guaranteed relative
   * order. `changes` arrives as the jsonb the client already decoded into
   * the write path's { field: { from, to } } shape.
   */
  async listAdminActions(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<AdminActionRecord[]> {
    return this.many<AdminActionRecord>(
      this.client
        .from(TABLES.adminActionLog)
        .select()
        .order('created_at', { ascending: false })
        .limit(limit),
      'listAdminActions',
    );
  }
}
