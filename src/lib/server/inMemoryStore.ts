/**
 * In-memory Store — the engine test double. Implements the exact canonical
 * contract from src/lib/server/store.ts with Map/array state, preserving the
 * SqliteStore semantics the contract encodes:
 *
 *  - store-generated ids (randomUUID) and created_at where the interface
 *    omits them;
 *  - canonical defaults (split-run status 'posted', ledger kind 'royalty',
 *    GL journal sequence 0 / prev_hash '' / entry_hash '' / state 'posted',
 *    artist name trimming);
 *  - list orderings: newest-first lists are created_at DESC with insertion
 *    order as tiebreak, per-run/creator lists are created_at ASC (same
 *    tiebreak) — the rowid discipline SQLite used;
 *  - unique constraints (link_token, public_token, (public_token,
 *    processor), webhook event_id, split_reversals.split_run_id) throw on
 *    duplicates — the same failure the database enforces;
 *  - recordCheckoutPurchase keeps the single-transaction semantics:
 *    idempotent session insert, guarded capacity decrement, and the
 *    session row stays recorded even when capacity runs out.
 *
 * All methods are async to satisfy the Promise-wrapped Store interface.
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_LIST_SHOWS_LIMIT,
  RECON_MAX_ATTEMPTS,
  RECON_STALE_CLAIM_MS,
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
  WebtoonStudioSplitRoleRecord,
  WebtoonLocalizationContractRecord,
  WebtoonLocalizationCostScheduleRecord,
  WebtoonLocalizationCostLineRecord,
  WebtoonRecoupmentPoolRecord,
  WebtoonRecoupmentPoolClass,
  WebtoonRecoupmentApplicationRecord,
  IpOptionAgreementRecord,
  IpOptionAuthorAllocationRecord,
  PublishingIpRightsVerificationRecord,
  MerchCogsLotRecord,
  MerchCogsConsumptionRecord,
  MerchCollabAgreementRecord,
  MerchCollabPoolClass,
  MerchCollabRecoupmentApplicationRecord,
  MerchDesignerRoyaltyTierRecord,
  MerchDesignerRoyaltyBillingRecord,
  MerchConsignmentSettlementRecord,
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
  isSdkSettlementTransactionType,
  territorySettlementOfRow,
  type TerritorySettlementRecord,
  type UniversalRoyaltyLedgerRow,
} from '@/lib/server/territorySettlement';
import { podcastEpisodeIdOfQueueRow } from '@/modules/podcastSplits/engine';

/**
 * Index-stable time sort. Ties keep insertion order in the list's own
 * direction — newest-first lists surface the latest insertion first,
 * oldest-first lists the earliest — matching SupabaseStore's
 * (created_at, insertion_order) ORDER BY pair.
 */
function sortByTime<T>(rows: T[], pick: (row: T) => string, direction: 'asc' | 'desc'): T[] {
  const signed = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ta = Date.parse(pick(a.row));
      const tb = Date.parse(pick(b.row));
      return signed * (ta - tb) || signed * (a.index - b.index);
    })
    .map((entry) => entry.row);
}

function uniqueViolation(constraint: string): never {
  throw new Error(`UNIQUE constraint failed: ${constraint}`);
}

/** One verification state per payee per tax year — the Map key IS the composite. */
function vtuberVerificationKey(payeeId: string, taxYear: number): string {
  return `${payeeId}::${taxYear}`;
}

export class InMemoryStore implements Store {
  private shows = new Map<string, ShowRecord>();
  private livePings: LivePingRecord[] = [];
  private artists = new Map<string, ArtistRecord>();
  private checkoutSessions = new Set<string>();
  private plaidLinkTokens = new Map<string, PlaidLinkTokenRecord>();
  private kycVerifications: KycVerificationRecord[] = [];
  private splitRuns = new Map<string, SplitRunRecord>();
  private royaltyLineItems: RoyaltyLineItemRecord[] = [];
  private ledgerTransactions: LedgerTransactionRecord[] = [];
  private baasTransfers = new Map<string, BaasTransferRecord>();
  private companyDust: CompanyDustRecord[] = [];
  private taxProfiles = new Map<string, CreatorTaxProfile>();
  private creatorYtd = new Map<string, CreatorYtdEarnings>();
  private taxEscrow: TaxEscrowRecord[] = [];
  private vaults = new Map<string, SovereignVaultRecord>();
  private processorTokens: PlaidProcessorTokenRecord[] = [];
  private recoupmentAdvances = new Map<string, RecoupmentAdvanceRecord>();
  private vaultDisputes = new Map<string, VaultDisputeRecord>();
  private payoutHolds = new Map<string, PayoutHoldRecord>();
  private baasWebhookEvents = new Map<string, BaasWebhookEventRecord>();
  private payoutReversals = new Map<string, PayoutReversalRecord>();
  private glJournals: GlJournalRecord[] = [];
  private glEntries: GlEntryRecord[] = [];
  private recoupmentLedger: RecoupmentLedgerRecord[] = [];
  private catalogDisputes = new Map<string, CatalogDisputeRecord>();
  private podcastEpisodeSplitSchedules = new Map<
    string,
    PodcastEpisodeSplitScheduleRecord
  >();
  private podcastEpisodeSplitAccruals: PodcastEpisodeSplitAccrualRecord[] = [];
  private podcastGuestBonusDefinitions: PodcastGuestBonusDefinitionRecord[] = [];
  private podcastGuestBonusAccruals: PodcastGuestBonusAccrualRecord[] = [];
  // Gaming engine-royalty accumulator + item splits (migration 0018, PR 12).
  private gamingEngineRoyaltyEvents: GamingEngineRoyaltyEventRecord[] = [];
  private gamingItemSplitSchedules = new Map<string, GamingItemSplitScheduleRecord>();
  private gamingSplitPayouts: GamingSplitPayoutRecord[] = [];
  // Gaming cashout states (migration 0019, PR 13): the durable DevEx
  // conversion logs (push order IS insertion_order for ties) and one KYC
  // verification state per studio payee.
  private gamingDevexConversionLogs: GamingDevexConversionLogRecord[] = [];
  private gamingStudioKycVerifications = new Map<string, GamingStudioKycRecord>();
  // --- VTuber agency licensing holdbacks + tax verification (0020, PR 15) ---
  private vtuberTaxWithholdingVerifications = new Map<
    string,
    VtuberTaxWithholdingVerificationRecord
  >();
  private vtuberTechSetupAmortizationSchedules: VtuberTechSetupAmortizationScheduleRecord[] =
    [];
  private vtuberTechSetupAmortizationLines: VtuberTechSetupAmortizationLineRecord[] = [];
  // Insertion-ordered — the cascade walk's reservation order (0021).
  private derivativeRoyaltyEdges: DerivativeRoyaltyEdgeRecord[] = [];
  private sampleClearanceEdges: SampleClearanceEdgeRecord[] = [];
  private compositionPublishers: CompositionPublisherRecord[] = [];
  // Migration 0024 — the webtoon studio split + translation cascade state.
  private webtoonStudioSplitRoles: WebtoonStudioSplitRoleRecord[] = [];
  private webtoonLocalizationContracts: WebtoonLocalizationContractRecord[] = [];
  private webtoonLocalizationCostSchedules: WebtoonLocalizationCostScheduleRecord[] = [];
  private webtoonLocalizationCostLines: WebtoonLocalizationCostLineRecord[] = [];
  private webtoonRecoupmentPools: WebtoonRecoupmentPoolRecord[] = [];
  private webtoonRecoupmentApplications: WebtoonRecoupmentApplicationRecord[] = [];
  // Migration 0025 — the IP option contract + author-first cascade state.
  private ipOptionAgreements: IpOptionAgreementRecord[] = [];
  private ipOptionAuthorAllocations: IpOptionAuthorAllocationRecord[] = [];
  private publishingIpRightsVerifications: PublishingIpRightsVerificationRecord[] = [];
  private merchCogsLots: MerchCogsLotRecord[] = [];
  private merchCogsConsumptions: MerchCogsConsumptionRecord[] = [];
  private merchCollabAgreements: MerchCollabAgreementRecord[] = [];
  private merchCollabRecoupmentApplications: MerchCollabRecoupmentApplicationRecord[] = [];
  private merchDesignerRoyaltyTiers: MerchDesignerRoyaltyTierRecord[] = [];
  private merchDesignerRoyaltyBillings: MerchDesignerRoyaltyBillingRecord[] = [];
  private merchConsignmentSettlements: MerchConsignmentSettlementRecord[] = [];
  // Film multi-territory withholding log + territory envelopes (0023, PR 18).
  private filmTerritoryWithholdings: FilmTerritoryWithholdingRecord[] = [];
  private filmTerritoryDistributions: FilmTerritoryDistributionRecord[] = [];
  private dspWebhookEvents = new Map<string, DspWebhookEventRecord>();
  private splitReversals: SplitReversalRecord[] = [];
  private mulClearances = new Map<string, MulClearanceRecord>();
  private clearanceTransitions: MulClearanceTransitionRecord[] = [];
  private matchQueue: MatchQueueRecord[] = [];
  private statementIngests = new Map<string, StatementIngestRecord>();
  // Insertion-ordered — the claim's created_at/insertion tiebreak (0011).
  private reconJobs: RoyaltyReconJobRecord[] = [];
  // --- The UCT credential vault (migration 0013) ---
  // Array push = the database's insertion_order — the status read's
  // newest-first tiebreak for rows sharing a created_at.
  private distributorConnections: DistributorConnectionRecord[] = [];
  // --- Clearinghouse kernel + Sync Library seams (migration 0008) ---
  private creatorUcts = new Map<string, CreatorUctRecord>();
  private syncCatalog = new Map<string, SyncCatalogItemRecord>();
  private syncPurchases = new Map<string, SyncLicensePurchaseRecord>();
  // --- The film waterfall engine (migration 0016, PR 8) ---
  // One registered deal per film asset (the Map key), and the insertion-ordered
  // distribution array — the routing-decision record. UNIQUE on escrow_ledger_id
  // is enforced on insert, matching the database backends.
  private filmWaterfallDefinitions = new Map<string, FilmWaterfallDefinitionRecord>();
  private filmWaterfallDistributions: FilmWaterfallDistributionRecord[] = [];

  /**
   * The tier-universe royalty ledger (universal_royalty_ledger) — read-side
   * seam only (spec art_qNu4T32F). Production credits are written exclusively
   * by the settlement wire; rows reach this stand-in through the fixture
   * affordance below, never through the Store contract.
   */
  private universalRoyaltyLedger: UniversalRoyaltyLedgerRow[] = [];

  // --- Legacy show / ping / artist surface ---

  async insertShow(show: ValidShowPayload): Promise<ShowRecord> {
    const record: ShowRecord = { ...show, id: randomUUID() };
    this.shows.set(record.id, record);
    return record;
  }

  async listShows(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<ShowRecord[]> {
    return sortByTime([...this.shows.values()], (row) => row.created_at, 'desc').slice(0, limit);
  }

  async getShow(id: string): Promise<ShowRecord | undefined> {
    return this.shows.get(id);
  }

  async recordCheckoutPurchase(
    sessionId: string,
    showId: string,
    quantity: number,
  ): Promise<CheckoutPurchaseResult | null> {
    const show = this.shows.get(showId);
    if (
      show === undefined ||
      show.ticketing_type !== 'native' ||
      show.native_ticket_capacity === null ||
      show.native_ticket_capacity === undefined
    ) {
      return null;
    }
    const remainingAfter = (): number => this.shows.get(showId)?.native_ticket_capacity ?? 0;
    if (this.checkoutSessions.has(sessionId)) {
      return { outcome: 'already_recorded', remaining: remainingAfter() };
    }
    if (show.native_ticket_capacity < quantity) {
      // The session row is recorded even when sold out — retries stay no-ops.
      this.checkoutSessions.add(sessionId);
      return { outcome: 'insufficient_capacity', remaining: remainingAfter() };
    }
    this.checkoutSessions.add(sessionId);
    show.native_ticket_capacity -= quantity;
    return { outcome: 'recorded', remaining: remainingAfter() };
  }

  async insertLivePing(ping: ValidLivePingPayload): Promise<LivePingRecord> {
    const record: LivePingRecord = { ...ping, id: randomUUID() };
    this.livePings.push(record);
    return record;
  }

  async listLivePings(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<LivePingRecord[]> {
    return sortByTime(this.livePings, (row) => row.timestamp, 'desc').slice(0, limit);
  }

  async insertArtist(
    name: string,
    keyHash: string,
    keyPrefix: string,
    createdAt: string = new Date().toISOString(),
  ): Promise<ArtistRecord> {
    const record: ArtistRecord = {
      id: randomUUID(),
      name: name.trim(),
      created_at: createdAt,
      key_hash: keyHash,
      key_prefix: keyPrefix,
    };
    this.artists.set(record.id, record);
    return record;
  }

  async getArtist(id: string): Promise<ArtistRecord | undefined> {
    return this.artists.get(id);
  }

  async getArtistByKeyHash(keyHash: string): Promise<ArtistRecord | undefined> {
    for (const artist of this.artists.values()) {
      if (artist.key_hash === keyHash) return artist;
    }
    return undefined;
  }

  // --- Plaid link / KYC surface ---

  async insertPlaidLinkToken(
    token: Omit<PlaidLinkTokenRecord, 'id' | 'created_at'>,
  ): Promise<PlaidLinkTokenRecord> {
    for (const row of this.plaidLinkTokens.values()) {
      if (row.link_token === token.link_token) uniqueViolation('plaid_link_tokens.link_token');
      if (row.public_token === token.public_token) uniqueViolation('plaid_link_tokens.public_token');
    }
    const record: PlaidLinkTokenRecord = {
      ...token,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.plaidLinkTokens.set(record.id, record);
    return record;
  }

  async getPlaidLinkTokenByLinkToken(
    linkToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    for (const row of this.plaidLinkTokens.values()) {
      if (row.link_token === linkToken) return row;
    }
    return undefined;
  }

  async getPlaidLinkTokenByPublicToken(
    publicToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    for (const row of this.plaidLinkTokens.values()) {
      if (row.public_token === publicToken) return row;
    }
    return undefined;
  }

  async updatePlaidAccessToken(
    publicToken: string,
    accessToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    const row = await this.getPlaidLinkTokenByPublicToken(publicToken);
    if (row === undefined) return undefined;
    row.access_token = accessToken;
    return row;
  }

  async insertKycVerification(
    row: Omit<KycVerificationRecord, 'id'>,
  ): Promise<KycVerificationRecord> {
    const record: KycVerificationRecord = { ...row, id: randomUUID() };
    this.kycVerifications.push(record);
    return record;
  }

  async listKycVerificationsByCreator(creatorId: string): Promise<KycVerificationRecord[]> {
    return sortByTime(
      this.kycVerifications.filter((row) => row.creator_id === creatorId),
      (row) => row.created_at,
      'desc',
    );
  }

  async insertProcessorToken(
    row: Omit<PlaidProcessorTokenRecord, 'id'>,
  ): Promise<PlaidProcessorTokenRecord> {
    for (const existing of this.processorTokens) {
      if (existing.public_token === row.public_token && existing.processor === row.processor) {
        uniqueViolation('plaid_processor_tokens.public_token, plaid_processor_tokens.processor');
      }
    }
    const record: PlaidProcessorTokenRecord = { ...row, id: randomUUID() };
    this.processorTokens.push(record);
    return record;
  }

  async getProcessorToken(
    publicToken: string,
    processor: PlaidProcessorTokenRecord['processor'],
  ): Promise<PlaidProcessorTokenRecord | undefined> {
    return (
      this.processorTokens.find(
        (row) => row.public_token === publicToken && row.processor === processor,
      ) ?? undefined
    );
  }

  // --- Split runs + line items ---

  async insertSplitRun(
    row: Omit<SplitRunRecord, 'id' | 'status' | 'idempotency_key'> & {
      status?: SplitRunRecord['status'];
      idempotency_key?: string | null;
    },
  ): Promise<SplitRunRecord> {
    const idempotencyKey = row.idempotency_key ?? null;
    // Migration 0009: split_runs.idempotency_key is unique when present —
    // the saga replay lock. NULL keys never conflict.
    if (
      idempotencyKey !== null &&
      [...this.splitRuns.values()].some((run) => run.idempotency_key === idempotencyKey)
    ) {
      uniqueViolation('split_runs.idempotency_key');
    }
    const record: SplitRunRecord = {
      ...row,
      status: row.status ?? 'posted',
      idempotency_key: idempotencyKey,
      id: randomUUID(),
    };
    this.splitRuns.set(record.id, record);
    return record;
  }

  async getSplitRun(id: string): Promise<SplitRunRecord | undefined> {
    return this.splitRuns.get(id);
  }

  async getSplitRunByIdempotencyKey(key: string): Promise<SplitRunRecord | undefined> {
    return [...this.splitRuns.values()].find((run) => run.idempotency_key === key);
  }

  async updateSplitRunStatus(
    id: string,
    status: SplitRunRecord['status'],
  ): Promise<SplitRunRecord | undefined> {
    const row = this.splitRuns.get(id);
    if (row === undefined) return undefined;
    row.status = status;
    return row;
  }

  async insertRoyaltyLineItem(
    row: Omit<RoyaltyLineItemRecord, 'id'>,
  ): Promise<RoyaltyLineItemRecord> {
    const record: RoyaltyLineItemRecord = { ...row, id: randomUUID() };
    this.royaltyLineItems.push(record);
    return record;
  }

  async listRoyaltyLineItemsByRun(splitRunId: string): Promise<RoyaltyLineItemRecord[]> {
    return sortByTime(
      this.royaltyLineItems.filter((row) => row.split_run_id === splitRunId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Ledger transactions ---

  async insertLedgerTransaction(
    row: Omit<LedgerTransactionRecord, 'id' | 'kind'> & {
      kind?: LedgerTransactionRecord['kind'];
    },
  ): Promise<LedgerTransactionRecord> {
    const record: LedgerTransactionRecord = {
      ...row,
      kind: row.kind ?? 'royalty',
      id: randomUUID(),
    };
    this.ledgerTransactions.push(record);
    return record;
  }

  async getLedgerTransaction(id: string): Promise<LedgerTransactionRecord | undefined> {
    return this.ledgerTransactions.find((row) => row.id === id);
  }

  async listLedgerTransactionsByRun(splitRunId: string): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter((row) => row.split_run_id === splitRunId),
      (row) => row.created_at,
      'asc',
    );
  }

  async listLedgerTransactionsByLineItem(
    lineItemId: string,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter((row) => row.line_item_id === lineItemId),
      (row) => row.created_at,
      'asc',
    );
  }

  async updateLedgerSettlement(
    id: string,
    patch: Pick<
      LedgerTransactionRecord,
      'status' | 'rail' | 'baas_provider' | 'baas_transfer_id' | 'settled_at'
    >,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = await this.getLedgerTransaction(id);
    if (row === undefined) return undefined;
    Object.assign(row, patch);
    return row;
  }

  // --- Unclaimed royalty holding (PR 7) ---

  async listUnclaimedHoldingCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'unclaimed_holding' && row.status === 'unclaimed_holding',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleUnclaimedHolding(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'unclaimed_holding') return undefined;
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  // --- Film waterfall escrow (PR 9) ---

  async listFilmEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'escrow_waterfall_pending' &&
          row.status === 'escrow_waterfall_pending',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleFilmEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'escrow_waterfall_pending') return undefined;
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async sumFilmGrossReceiptCents(filmId: string): Promise<number> {
    // Gross receipts count EVERY escrow receipt row for the film, held or
    // released — money is received when it locks, not when it releases. The
    // per-film payee id (film_escrow:{filmId}) is the grouping key.
    const payeeId = `film_escrow:${filmId}`;
    return this.ledgerTransactions.reduce(
      (total, row) =>
        row.kind === 'escrow_waterfall_pending' && row.payee_id === payeeId
          ? total + row.amount_cents
          : total,
      0,
    );
  }

  // --- Film waterfall engine (migration 0016, PR 8) ---

  async upsertFilmWaterfallDefinition(
    row: FilmWaterfallDefinitionRecord,
  ): Promise<FilmWaterfallDefinitionRecord> {
    // One definition per film asset — the Map key IS film_id, so a
    // re-registration after the lock check replaces the row.
    this.filmWaterfallDefinitions.set(row.film_id, row);
    return row;
  }

  async getFilmWaterfallDefinition(
    filmId: string,
  ): Promise<FilmWaterfallDefinitionRecord | undefined> {
    return this.filmWaterfallDefinitions.get(filmId);
  }

  async insertFilmWaterfallDistribution(
    row: Omit<FilmWaterfallDistributionRecord, 'id'>,
  ): Promise<FilmWaterfallDistributionRecord> {
    // UNIQUE on escrow_ledger_id — one routing decision per released receipt,
    // the same failure mode the database enforces.
    if (
      this.filmWaterfallDistributions.some(
        (existing) => existing.escrow_ledger_id === row.escrow_ledger_id,
      )
    ) {
      uniqueViolation('film_waterfall_distributions.escrow_ledger_id');
    }
    const record: FilmWaterfallDistributionRecord = { ...row, id: randomUUID() };
    // Array push = the database's insertion_order — the cumulative-paid
    // fold's routing order for rows sharing a created_at.
    this.filmWaterfallDistributions.push(record);
    return record;
  }

  async getFilmWaterfallDistributionByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmWaterfallDistributionRecord | undefined> {
    return this.filmWaterfallDistributions.find(
      (row) => row.escrow_ledger_id === escrowLedgerId,
    );
  }

  async updateFilmWaterfallDistributionStatus(
    id: string,
    status: FilmWaterfallDistributionRecord['status'],
  ): Promise<FilmWaterfallDistributionRecord | undefined> {
    const row = this.filmWaterfallDistributions.find((candidate) => candidate.id === id);
    if (row === undefined) return undefined;
    row.status = status;
    return row;
  }

  async deleteFilmWaterfallDistribution(id: string): Promise<void> {
    this.filmWaterfallDistributions = this.filmWaterfallDistributions.filter(
      (row) => row.id !== id,
    );
  }

  async listFilmWaterfallDistributions(
    filmId: string,
  ): Promise<FilmWaterfallDistributionRecord[]> {
    // Oldest first — the cumulative paid state folds in routing order
    // (the array's push order IS insertion_order for created_at ties).
    return sortByTime(
      this.filmWaterfallDistributions.filter((row) => row.film_id === filmId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Film multi-territory withholding + cross-collateralization firewall (migration 0023, PR 18) ---

  async insertFilmTerritoryWithholding(
    row: Omit<FilmTerritoryWithholdingRecord, 'id'>,
  ): Promise<FilmTerritoryWithholdingRecord> {
    // UNIQUE on event_id (the content-derived match_queue event) — one
    // withholding log per line, ever; a duplicate insert throws the same
    // failure mode the database enforces (the replay surface).
    if (this.filmTerritoryWithholdings.some((existing) => existing.event_id === row.event_id)) {
      uniqueViolation('film_territory_withholdings.event_id');
    }
    const record: FilmTerritoryWithholdingRecord = { ...row, id: randomUUID() };
    this.filmTerritoryWithholdings.push(record);
    return record;
  }

  async getFilmTerritoryWithholdingByEventId(
    eventId: string,
  ): Promise<FilmTerritoryWithholdingRecord | undefined> {
    return this.filmTerritoryWithholdings.find((row) => row.event_id === eventId);
  }

  async listFilmTerritoryWithholdingsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryWithholdingRecord[]> {
    return sortByTime(
      this.filmTerritoryWithholdings.filter((row) => row.film_id === filmId),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertFilmTerritoryDistribution(
    row: Omit<FilmTerritoryDistributionRecord, 'id'>,
  ): Promise<FilmTerritoryDistributionRecord> {
    // UNIQUE on (escrow_ledger_id, territory_code) — one routing decision
    // per released receipt per territory, ever (the same failure mode the
    // database enforces).
    if (
      this.filmTerritoryDistributions.some(
        (existing) =>
          existing.escrow_ledger_id === row.escrow_ledger_id &&
          existing.territory_code === row.territory_code,
      )
    ) {
      uniqueViolation('film_territory_distributions.escrow_ledger_id,territory_code');
    }
    const record: FilmTerritoryDistributionRecord = { ...row, id: randomUUID() };
    // Array push = the database's insertion_order — the per-territory paid
    // fold's routing order for rows sharing a created_at.
    this.filmTerritoryDistributions.push(record);
    return record;
  }

  async listFilmTerritoryDistributionsByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmTerritoryDistributionRecord[]> {
    return this.filmTerritoryDistributions
      .filter((row) => row.escrow_ledger_id === escrowLedgerId)
      .sort((a, b) => a.territory_code.localeCompare(b.territory_code));
  }

  async listFilmTerritoryDistributionsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryDistributionRecord[]> {
    return sortByTime(
      this.filmTerritoryDistributions.filter((row) => row.film_id === filmId),
      (row) => row.created_at,
      'asc',
    );
  }

  async updateFilmTerritoryDistributionStatus(
    id: string,
    status: FilmTerritoryDistributionRecord['status'],
  ): Promise<FilmTerritoryDistributionRecord | undefined> {
    const row = this.filmTerritoryDistributions.find((candidate) => candidate.id === id);
    if (row === undefined) return undefined;
    row.status = status;
    return row;
  }

  async deleteFilmTerritoryDistribution(id: string): Promise<void> {
    this.filmTerritoryDistributions = this.filmTerritoryDistributions.filter(
      (row) => row.id !== id,
    );
  }

  // --- Podcast episode splits + guest milestone bonuses (migration 0017, PR 11) ---

  async upsertPodcastEpisodeSplitSchedule(
    row: PodcastEpisodeSplitScheduleRecord,
  ): Promise<PodcastEpisodeSplitScheduleRecord> {
    // One schedule per episode — the map's key IS the episode id, so an
    // upsert replaces the row atomically (the engine bumps the version).
    this.podcastEpisodeSplitSchedules.set(row.episode_id, row);
    return row;
  }

  async getPodcastEpisodeSplitSchedule(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitScheduleRecord | undefined> {
    return this.podcastEpisodeSplitSchedules.get(episodeId);
  }

  async insertPodcastEpisodeSplitAccrual(
    row: Omit<PodcastEpisodeSplitAccrualRecord, 'id'>,
  ): Promise<PodcastEpisodeSplitAccrualRecord> {
    // UNIQUE on source_event_id — a duplicate insert throws the unique
    // violation (the caller counts the replay as a no-op).
    if (
      this.podcastEpisodeSplitAccruals.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('podcast_episode_split_accruals.source_event_id');
    }
    const record: PodcastEpisodeSplitAccrualRecord = { ...row, id: randomUUID() };
    this.podcastEpisodeSplitAccruals.push(record);
    return record;
  }

  async getPodcastEpisodeSplitAccrualBySourceEvent(
    sourceEventId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord | undefined> {
    return this.podcastEpisodeSplitAccruals.find(
      (row) => row.source_event_id === sourceEventId,
    );
  }

  async listPodcastEpisodeSplitAccruals(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord[]> {
    // Oldest first — routing order (push order IS insertion_order for ties).
    return sortByTime(
      this.podcastEpisodeSplitAccruals.filter((row) => row.episode_id === episodeId),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertPodcastGuestBonusDefinition(
    row: PodcastGuestBonusDefinitionRecord,
  ): Promise<PodcastGuestBonusDefinitionRecord> {
    // Composite UNIQUE (episode, guest, kind, threshold) — one contract per
    // milestone; a duplicate insert throws the unique violation.
    const duplicate = this.podcastGuestBonusDefinitions.some(
      (existing) =>
        existing.episode_id === row.episode_id &&
        existing.guest_payee_id === row.guest_payee_id &&
        existing.milestone_kind === row.milestone_kind &&
        existing.threshold === row.threshold,
    );
    if (duplicate) {
      uniqueViolation(
        'podcast_guest_bonus_definitions.episode_id_guest_payee_id_milestone_kind_threshold',
      );
    }
    this.podcastGuestBonusDefinitions.push(row);
    return row;
  }

  async listPodcastGuestBonusDefinitions(
    episodeId: string,
  ): Promise<PodcastGuestBonusDefinitionRecord[]> {
    // Oldest first — definition registration order (push order IS
    // insertion_order for created_at ties).
    return sortByTime(
      this.podcastGuestBonusDefinitions.filter((row) => row.episode_id === episodeId),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertPodcastGuestBonusAccrual(
    row: Omit<PodcastGuestBonusAccrualRecord, 'id'>,
  ): Promise<PodcastGuestBonusAccrualRecord> {
    // UNIQUE on event_id (the content-derived `podcast:bonus:` id) — the
    // once-only milestone arbiter; a duplicate insert throws.
    if (
      this.podcastGuestBonusAccruals.some((existing) => existing.event_id === row.event_id)
    ) {
      uniqueViolation('podcast_guest_bonus_accruals.event_id');
    }
    const record: PodcastGuestBonusAccrualRecord = { ...row, id: randomUUID() };
    this.podcastGuestBonusAccruals.push(record);
    return record;
  }

  async markPodcastGuestBonusAccrualPosted(
    id: string,
    holdingLedgerId: string,
  ): Promise<PodcastGuestBonusAccrualRecord | undefined> {
    const row = this.podcastGuestBonusAccruals.find((existing) => existing.id === id);
    if (row === undefined) return undefined;
    row.status = 'posted';
    row.holding_ledger_id = holdingLedgerId;
    return row;
  }

  async deletePodcastGuestBonusAccrual(id: string): Promise<void> {
    this.podcastGuestBonusAccruals = this.podcastGuestBonusAccruals.filter(
      (row) => row.id !== id,
    );
  }

  async listPodcastGuestBonusAccruals(
    episodeId: string,
  ): Promise<PodcastGuestBonusAccrualRecord[]> {
    // Oldest first — accrual order (push order IS insertion_order for ties).
    return sortByTime(
      this.podcastGuestBonusAccruals.filter((row) => row.episode_id === episodeId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Gaming engine-royalty accumulator + item splits (migration 0018, PR 12) ---

  async insertGamingEngineRoyaltyEvent(
    row: Omit<GamingEngineRoyaltyEventRecord, 'id'>,
  ): Promise<GamingEngineRoyaltyEventRecord> {
    // UNIQUE on event_id — one contribution per queue event, ever; a
    // duplicate insert throws the unique violation (the replay no-op).
    if (this.gamingEngineRoyaltyEvents.some((existing) => existing.event_id === row.event_id)) {
      uniqueViolation('gaming_engine_royalty_events.event_id');
    }
    const record: GamingEngineRoyaltyEventRecord = { ...row, id: randomUUID() };
    this.gamingEngineRoyaltyEvents.push(record);
    return record;
  }

  async getGamingEngineRoyaltyEventByEventId(
    eventId: string,
  ): Promise<GamingEngineRoyaltyEventRecord | undefined> {
    return this.gamingEngineRoyaltyEvents.find((row) => row.event_id === eventId);
  }

  async sumGamingEngineRoyaltyGross(
    platforms: readonly string[],
    productId: string,
    annualYear: number,
  ): Promise<string> {
    // The accumulator's state is the DERIVED sum of the contribution rows —
    // never a mutable counter (replayed gross can never cross the $1M
    // threshold twice). The family's platforms share one per-product line.
    // BigInt addition, exact.
    let total = 0n;
    for (const row of this.gamingEngineRoyaltyEvents) {
      if (
        platforms.includes(row.platform) &&
        row.product_id === productId &&
        row.annual_year === annualYear
      ) {
        total += BigInt(row.gross_micros);
      }
    }
    return total.toString();
  }

  async upsertGamingItemSplitSchedule(
    row: GamingItemSplitScheduleRecord,
  ): Promise<GamingItemSplitScheduleRecord> {
    // One schedule per item — the map's key IS the item id, so an upsert
    // replaces the row atomically (the engine bumps the version).
    this.gamingItemSplitSchedules.set(row.item_id, row);
    return row;
  }

  async getGamingItemSplitSchedule(
    itemId: string,
  ): Promise<GamingItemSplitScheduleRecord | undefined> {
    return this.gamingItemSplitSchedules.get(itemId);
  }

  async insertGamingSplitPayout(
    row: Omit<GamingSplitPayoutRecord, 'id'>,
  ): Promise<GamingSplitPayoutRecord> {
    // UNIQUE on source_event_id — one routing per funding event, ever; a
    // duplicate insert throws the unique violation (the replay no-op).
    if (
      this.gamingSplitPayouts.some((existing) => existing.source_event_id === row.source_event_id)
    ) {
      uniqueViolation('gaming_split_payouts.source_event_id');
    }
    const record: GamingSplitPayoutRecord = { ...row, id: randomUUID() };
    this.gamingSplitPayouts.push(record);
    return record;
  }

  async getGamingSplitPayoutBySourceEvent(
    sourceEventId: string,
  ): Promise<GamingSplitPayoutRecord | undefined> {
    return this.gamingSplitPayouts.find((row) => row.source_event_id === sourceEventId);
  }

  async listGamingSplitPayouts(itemId: string): Promise<GamingSplitPayoutRecord[]> {
    // Oldest first — routing order (push order IS insertion_order for ties).
    return sortByTime(
      this.gamingSplitPayouts.filter((row) => row.item_id === itemId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Gaming cashout states: DevEx conversion logs + studio KYC (migration 0019, PR 13) ---

  async listVirtualCurrencyCashoutCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'virtual_currency_cashout_pending' &&
          row.status === 'virtual_currency_cashout_pending',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleVirtualCurrencyCashout(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'virtual_currency_cashout_pending') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async listEsportsPoolEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'esports_prize_pool_pending' &&
          row.status === 'esports_prize_pool_pending',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleEsportsPoolEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The same CAS as the film-escrow and gaming-cashout settles — the
    // esports status is its own lock state, never folded into another
    // account's.
    if (row === undefined || row.status !== 'esports_prize_pool_pending') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async insertGamingDevexConversionLog(
    row: Omit<GamingDevexConversionLogRecord, 'id'>,
  ): Promise<GamingDevexConversionLogRecord> {
    // UNIQUE on event_id — one conversion log per funding line, ever; a
    // duplicate insert throws the unique violation (the replay no-op).
    if (this.gamingDevexConversionLogs.some((existing) => existing.event_id === row.event_id)) {
      uniqueViolation('gaming_devex_conversion_logs.event_id');
    }
    const record: GamingDevexConversionLogRecord = { ...row, id: randomUUID() };
    this.gamingDevexConversionLogs.push(record);
    return record;
  }

  async getGamingDevexConversionLogByEventId(
    eventId: string,
  ): Promise<GamingDevexConversionLogRecord | undefined> {
    return this.gamingDevexConversionLogs.find((row) => row.event_id === eventId);
  }

  async listGamingDevexConversionLogsByBatch(
    batchRef: string,
  ): Promise<GamingDevexConversionLogRecord[]> {
    // Oldest first — write order (push order IS insertion_order for ties).
    return sortByTime(
      this.gamingDevexConversionLogs.filter((row) => row.settlement_batch_ref === batchRef),
      (row) => row.created_at,
      'asc',
    );
  }

  async settleGamingDevexConversionLogsByBatch(
    batchRef: string,
    settledAt: string,
  ): Promise<number> {
    // The status predicate is the CAS at batch scope: only PENDING rows
    // flip, already-settled rows are untouched, and the count is the honest
    // report of what this call settled.
    let settled = 0;
    for (const row of this.gamingDevexConversionLogs) {
      if (
        row.settlement_batch_ref === batchRef &&
        row.status === 'pending_fiat_settlement'
      ) {
        row.status = 'fiat_settled';
        row.settled_at = settledAt;
        settled += 1;
      }
    }
    return settled;
  }

  async upsertGamingStudioKyc(
    row: GamingStudioKycRecord,
  ): Promise<GamingStudioKycRecord> {
    // One verification state per studio payee — the Map key IS the payee
    // id, so a re-verification replaces the row.
    this.gamingStudioKycVerifications.set(row.studio_payee_id, row);
    return row;
  }

  async getGamingStudioKyc(
    studioPayeeId: string,
  ): Promise<GamingStudioKycRecord | undefined> {
    return this.gamingStudioKycVerifications.get(studioPayeeId);
  }

  // --- VTuber agency licensing holdbacks + tax verification (migration 0020, PR 15) ---

  async listAvatarIpHoldbackCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'avatar_ip_licensing_holdback' &&
          row.status === 'avatar_ip_licensing_holdback',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleAvatarIpHoldback(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — the same single-threaded-by-
    // construction atomicity the film-escrow/gaming-cashout settles ride.
    if (row === undefined || row.status !== 'avatar_ip_licensing_holdback') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async upsertVtuberTaxWithholdingVerification(
    row: VtuberTaxWithholdingVerificationRecord,
  ): Promise<VtuberTaxWithholdingVerificationRecord> {
    // One verification state per payee + tax year — the Map key IS the
    // composite, so a re-verification replaces the row.
    this.vtuberTaxWithholdingVerifications.set(
      vtuberVerificationKey(row.payee_id, row.tax_year),
      row,
    );
    return row;
  }

  async getVtuberTaxWithholdingVerification(
    payeeId: string,
    taxYear: number,
  ): Promise<VtuberTaxWithholdingVerificationRecord | undefined> {
    return this.vtuberTaxWithholdingVerifications.get(
      vtuberVerificationKey(payeeId, taxYear),
    );
  }

  async insertVtuberTechSetupAmortizationSchedule(
    row: Omit<VtuberTechSetupAmortizationScheduleRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord> {
    // UNIQUE on schedule_ref — one schedule per contract reference, ever; a
    // duplicate insert throws the unique violation.
    if (
      this.vtuberTechSetupAmortizationSchedules.some(
        (existing) => existing.schedule_ref === row.schedule_ref,
      )
    ) {
      uniqueViolation('vtuber_tech_setup_amortization_schedules.schedule_ref');
    }
    const record: VtuberTechSetupAmortizationScheduleRecord = { ...row, id: randomUUID() };
    this.vtuberTechSetupAmortizationSchedules.push(record);
    return record;
  }

  async getVtuberTechSetupAmortizationScheduleByRef(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord | undefined> {
    return this.vtuberTechSetupAmortizationSchedules.find(
      (row) => row.schedule_ref === scheduleRef,
    );
  }

  async insertVtuberTechSetupAmortizationLine(
    row: Omit<VtuberTechSetupAmortizationLineRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationLineRecord> {
    // UNIQUE on (schedule_ref, line_index) — the insert-as-lock consume
    // arbiter; a concurrent consume of the same line throws the unique
    // violation (the PR 12 accumulator discipline).
    if (
      this.vtuberTechSetupAmortizationLines.some(
        (existing) =>
          existing.schedule_ref === row.schedule_ref &&
          existing.line_index === row.line_index,
      )
    ) {
      uniqueViolation('vtuber_tech_setup_amortization_lines.schedule_ref,line_index');
    }
    const record: VtuberTechSetupAmortizationLineRecord = { ...row, id: randomUUID() };
    this.vtuberTechSetupAmortizationLines.push(record);
    return record;
  }

  async listVtuberTechSetupAmortizationLines(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationLineRecord[]> {
    // Line index order — the deterministic consumption order.
    return this.vtuberTechSetupAmortizationLines
      .filter((row) => row.schedule_ref === scheduleRef)
      .sort((a, b) => a.line_index - b.line_index);
  }

  // --- Derivative asset royalty cascade (0021, PR 16) ---

  async insertDerivativeRoyaltyEdge(
    row: Omit<DerivativeRoyaltyEdgeRecord, 'id'>,
  ): Promise<DerivativeRoyaltyEdgeRecord> {
    // UNIQUE on (asset_id, parent_asset_id, upstream_creator_payee_id) — a
    // duplicate registration throws the unique violation (the replay surface).
    if (
      this.derivativeRoyaltyEdges.some(
        (existing) =>
          existing.asset_id === row.asset_id &&
          existing.parent_asset_id === row.parent_asset_id &&
          existing.upstream_creator_payee_id === row.upstream_creator_payee_id,
      )
    ) {
      uniqueViolation('derivative_royalty_edges.asset_id,parent_asset_id,upstream_creator_payee_id');
    }
    const record: DerivativeRoyaltyEdgeRecord = { ...row, id: randomUUID() };
    this.derivativeRoyaltyEdges.push(record);
    return record;
  }

  async getDerivativeRoyaltyEdgesByAsset(assetId: string): Promise<DerivativeRoyaltyEdgeRecord[]> {
    // Insertion order — the deterministic reservation order (the array IS
    // the insertion_order identity column's local mirror).
    return this.derivativeRoyaltyEdges.filter((row) => row.asset_id === assetId);
  }

  async insertSampleClearanceEdge(
    row: Omit<SampleClearanceEdgeRecord, 'id'>,
  ): Promise<SampleClearanceEdgeRecord> {
    // UNIQUE on (work_id, parent_composition_id, rights_holder_payee_id,
    // rights_type) — a duplicate registration throws the unique violation
    // (the replay surface). The same (work, parent) pair on BOTH sides of
    // the rights separation is two distinct contracts, not a duplicate.
    if (
      this.sampleClearanceEdges.some(
        (existing) =>
          existing.work_id === row.work_id &&
          existing.parent_composition_id === row.parent_composition_id &&
          existing.rights_holder_payee_id === row.rights_holder_payee_id &&
          existing.rights_type === row.rights_type,
      )
    ) {
      uniqueViolation(
        'sample_clearance_edges.work_id,parent_composition_id,rights_holder_payee_id,rights_type',
      );
    }
    const record: SampleClearanceEdgeRecord = { ...row, id: randomUUID() };
    this.sampleClearanceEdges.push(record);
    return record;
  }

  async getSampleClearanceEdgesByWork(workId: string): Promise<SampleClearanceEdgeRecord[]> {
    // Insertion order — the deterministic reservation order (the array IS
    // the insertion_order identity column's local mirror).
    return this.sampleClearanceEdges.filter((row) => row.work_id === workId);
  }

  async insertCompositionPublisher(
    row: Omit<CompositionPublisherRecord, 'id'>,
  ): Promise<CompositionPublisherRecord> {
    // UNIQUE on (composition_id, publisher_payee_id) — a duplicate
    // registration throws the unique violation (the replay surface).
    if (
      this.compositionPublishers.some(
        (existing) =>
          existing.composition_id === row.composition_id &&
          existing.publisher_payee_id === row.publisher_payee_id,
      )
    ) {
      uniqueViolation('composition_publishers.composition_id,publisher_payee_id');
    }
    const record: CompositionPublisherRecord = { ...row, id: randomUUID() };
    this.compositionPublishers.push(record);
    return record;
  }

  async listCompositionPublishers(compositionId: string): Promise<CompositionPublisherRecord[]> {
    // Insertion order — the deterministic routing order (the array IS the
    // insertion_order identity column's local mirror).
    return this.compositionPublishers.filter((row) => row.composition_id === compositionId);
  }

  // --- Webtoon studio splits + translation cascades (PR 20, migration 0024) ---

  async insertWebtoonStudioSplitRole(
    row: Omit<WebtoonStudioSplitRoleRecord, 'id'>,
  ): Promise<WebtoonStudioSplitRoleRecord> {
    // UNIQUE on (series_id, role_group, payee_id) — a duplicate registration
    // throws the unique violation (the replay surface).
    if (
      this.webtoonStudioSplitRoles.some(
        (existing) =>
          existing.series_id === row.series_id &&
          existing.role_group === row.role_group &&
          existing.payee_id === row.payee_id,
      )
    ) {
      uniqueViolation('webtoon_studio_split_roles.series_id,role_group,payee_id');
    }
    const record: WebtoonStudioSplitRoleRecord = { ...row, id: randomUUID() };
    this.webtoonStudioSplitRoles.push(record);
    return record;
  }

  async listWebtoonStudioSplitRoles(seriesId: string): Promise<WebtoonStudioSplitRoleRecord[]> {
    // Insertion order — the deterministic allocation order (the array IS the
    // insertion_order identity column's local mirror).
    return this.webtoonStudioSplitRoles.filter((row) => row.series_id === seriesId);
  }

  async upsertWebtoonLocalizationContract(
    row: Omit<WebtoonLocalizationContractRecord, 'id'>,
  ): Promise<WebtoonLocalizationContractRecord> {
    // One localizer of record per (series, language) feed — INSERT ON
    // CONFLICT replaces the row atomically (the studio-KYC precedent).
    const existingIndex = this.webtoonLocalizationContracts.findIndex(
      (candidate) =>
        candidate.series_id === row.series_id && candidate.language_code === row.language_code,
    );
    const record: WebtoonLocalizationContractRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.webtoonLocalizationContracts[existingIndex] = record;
    } else {
      this.webtoonLocalizationContracts.push(record);
    }
    return record;
  }

  async getWebtoonLocalizationContract(
    seriesId: string,
    languageCode: string,
  ): Promise<WebtoonLocalizationContractRecord | undefined> {
    return this.webtoonLocalizationContracts.find(
      (candidate) =>
        candidate.series_id === seriesId && candidate.language_code === languageCode,
    );
  }

  async insertWebtoonLocalizationCostSchedule(
    row: Omit<WebtoonLocalizationCostScheduleRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostScheduleRecord> {
    // UNIQUE on schedule_ref — the business key the release resolves by.
    if (
      this.webtoonLocalizationCostSchedules.some(
        (existing) => existing.schedule_ref === row.schedule_ref,
      )
    ) {
      uniqueViolation('webtoon_localization_cost_schedules.schedule_ref');
    }
    const record: WebtoonLocalizationCostScheduleRecord = { ...row, id: randomUUID() };
    this.webtoonLocalizationCostSchedules.push(record);
    return record;
  }

  async getWebtoonLocalizationCostScheduleByRef(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostScheduleRecord | undefined> {
    return this.webtoonLocalizationCostSchedules.find(
      (candidate) => candidate.schedule_ref === scheduleRef,
    );
  }

  async insertWebtoonLocalizationCostLine(
    row: Omit<WebtoonLocalizationCostLineRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostLineRecord> {
    // UNIQUE per (schedule_ref, line_index) — the insert-as-lock guard: a
    // concurrent release consuming one period twice throws here.
    if (
      this.webtoonLocalizationCostLines.some(
        (existing) =>
          existing.schedule_ref === row.schedule_ref && existing.line_index === row.line_index,
      )
    ) {
      uniqueViolation('webtoon_localization_cost_lines.schedule_ref,line_index');
    }
    const record: WebtoonLocalizationCostLineRecord = { ...row, id: randomUUID() };
    this.webtoonLocalizationCostLines.push(record);
    return record;
  }

  async listWebtoonLocalizationCostLines(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostLineRecord[]> {
    // line_index ASC — the consumed periods in amortization order.
    return this.webtoonLocalizationCostLines
      .filter((row) => row.schedule_ref === scheduleRef)
      .sort((a, b) => a.line_index - b.line_index);
  }

  async upsertWebtoonRecoupmentPool(
    row: Omit<WebtoonRecoupmentPoolRecord, 'id'>,
  ): Promise<WebtoonRecoupmentPoolRecord> {
    // One pool of record per (series, class) — INSERT ON CONFLICT replaces
    // the row atomically.
    const existingIndex = this.webtoonRecoupmentPools.findIndex(
      (candidate) =>
        candidate.series_id === row.series_id && candidate.pool_class === row.pool_class,
    );
    const record: WebtoonRecoupmentPoolRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.webtoonRecoupmentPools[existingIndex] = record;
    } else {
      this.webtoonRecoupmentPools.push(record);
    }
    return record;
  }

  async getWebtoonRecoupmentPool(
    seriesId: string,
    poolClass: WebtoonRecoupmentPoolClass,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined> {
    return this.webtoonRecoupmentPools.find(
      (candidate) => candidate.series_id === seriesId && candidate.pool_class === poolClass,
    );
  }

  async insertWebtoonRecoupmentApplication(
    row: Omit<WebtoonRecoupmentApplicationRecord, 'id'>,
  ): Promise<WebtoonRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id) — a replayed application is the
    // unique violation, never a double recovery. UNIQUE per
    // (pool_id, recouped_before_cents) — the POSITION lock: a concurrent
    // application computing the same running position loses here and
    // re-derives from the append-only truth.
    if (
      this.webtoonRecoupmentApplications.some(
        (existing) =>
          existing.pool_id === row.pool_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('webtoon_recoupment_applications.pool_id,source_event_id');
    }
    if (
      this.webtoonRecoupmentApplications.some(
        (existing) =>
          existing.pool_id === row.pool_id &&
          existing.recouped_before_cents === row.recouped_before_cents,
      )
    ) {
      uniqueViolation('webtoon_recoupment_applications.pool_id,recouped_before_cents');
    }
    const record: WebtoonRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.webtoonRecoupmentApplications.push(record);
    return record;
  }

  async listWebtoonRecoupmentApplications(
    poolId: string,
  ): Promise<WebtoonRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return sortByTime(
      this.webtoonRecoupmentApplications.filter((row) => row.pool_id === poolId),
      (row) => row.created_at,
      'asc',
    );
  }

  async updateWebtoonRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: WebtoonRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined> {
    const row = this.webtoonRecoupmentPools.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — an already-recouped pool refuses the
    // update (undefined), the same settle discipline the escrow rows ride.
    if (row === undefined || row.status !== 'active') {
      return undefined;
    }
    row.recouped_cents = recoupedCents;
    row.status = status;
    row.updated_at = updatedAt;
    return { ...row };
  }

  async listTranslationLocalizationEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'translation_localization_pending' &&
          row.status === 'translation_localization_pending',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleTranslationLocalizationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — the same single-threaded-by-
    // construction atomicity the film-escrow/gaming-cashout/holdback settles
    // ride.
    if (row === undefined || row.status !== 'translation_localization_pending') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  // --- IP adaptation optioning (PR 21, migration 0025) ---

  async upsertIpOptionAgreement(
    row: Omit<IpOptionAgreementRecord, 'id'>,
  ): Promise<IpOptionAgreementRecord> {
    // One agreement of record per work — upsert replaces the row atomically.
    const existingIndex = this.ipOptionAgreements.findIndex(
      (candidate) => candidate.work_id === row.work_id,
    );
    const record: IpOptionAgreementRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.ipOptionAgreements[existingIndex] = record;
    } else {
      this.ipOptionAgreements.push(record);
    }
    return record;
  }

  async getIpOptionAgreement(workId: string): Promise<IpOptionAgreementRecord | undefined> {
    return this.ipOptionAgreements.find((candidate) => candidate.work_id === workId);
  }

  async insertIpOptionAuthorAllocation(
    row: Omit<IpOptionAuthorAllocationRecord, 'id'>,
  ): Promise<IpOptionAuthorAllocationRecord> {
    // UNIQUE on (work_id, payee_id) — a duplicate registration throws the
    // unique violation (the replay surface).
    if (
      this.ipOptionAuthorAllocations.some(
        (existing) => existing.work_id === row.work_id && existing.payee_id === row.payee_id,
      )
    ) {
      uniqueViolation('ip_option_author_allocations.work_id,payee_id');
    }
    const record: IpOptionAuthorAllocationRecord = { ...row, id: randomUUID() };
    this.ipOptionAuthorAllocations.push(record);
    return record;
  }

  async listIpOptionAuthorAllocations(workId: string): Promise<IpOptionAuthorAllocationRecord[]> {
    // Insertion order — the deterministic author-first reservation order.
    return this.ipOptionAuthorAllocations.filter((row) => row.work_id === workId);
  }

  async upsertPublishingIpRightsVerification(
    row: Omit<PublishingIpRightsVerificationRecord, 'id'>,
  ): Promise<PublishingIpRightsVerificationRecord> {
    // One verification state per (payee, work) — upsert replaces the row
    // atomically (the studio-KYC precedent, at work scope).
    const existingIndex = this.publishingIpRightsVerifications.findIndex(
      (candidate) => candidate.payee_id === row.payee_id && candidate.work_id === row.work_id,
    );
    const record: PublishingIpRightsVerificationRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.publishingIpRightsVerifications[existingIndex] = record;
    } else {
      this.publishingIpRightsVerifications.push(record);
    }
    return record;
  }

  async getPublishingIpRightsVerification(
    payeeId: string,
    workId: string,
  ): Promise<PublishingIpRightsVerificationRecord | undefined> {
    return this.publishingIpRightsVerifications.find(
      (candidate) => candidate.payee_id === payeeId && candidate.work_id === workId,
    );
  }

  // --- Merch COGS + the brand collaboration waterfall (PR 22, migration 0026) ---

  async insertMerchCogsLot(row: Omit<MerchCogsLotRecord, 'id'>): Promise<MerchCogsLotRecord> {
    // UNIQUE on (sku_id, lot_ref) — a re-registered lot throws the unique
    // violation (the replay surface).
    if (
      this.merchCogsLots.some(
        (existing) => existing.sku_id === row.sku_id && existing.lot_ref === row.lot_ref,
      )
    ) {
      uniqueViolation('merch_cogs_lots.sku_id,lot_ref');
    }
    const record: MerchCogsLotRecord = { ...row, id: randomUUID() };
    this.merchCogsLots.push(record);
    return record;
  }

  async listMerchCogsLots(skuId: string): Promise<MerchCogsLotRecord[]> {
    // FIFO order — created_at ASC, then lot_ref ASC (the deterministic tie).
    return this.merchCogsLots
      .filter((row) => row.sku_id === skuId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.lot_ref.localeCompare(b.lot_ref),
      );
  }

  async insertMerchCogsConsumption(
    row: Omit<MerchCogsConsumptionRecord, 'id'>,
  ): Promise<MerchCogsConsumptionRecord> {
    // UNIQUE on (lot_id, source_event_id) — a replayed fulfillment event is
    // the unique violation, never a double amortization. UNIQUE on
    // (lot_id, units_consumed_before) — the insert-as-lock position
    // arbiter: a concurrent consumer that loses the position throws.
    if (
      this.merchCogsConsumptions.some(
        (existing) =>
          existing.lot_id === row.lot_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('merch_cogs_consumptions.lot_id,source_event_id');
    }
    if (
      this.merchCogsConsumptions.some(
        (existing) =>
          existing.lot_id === row.lot_id &&
          existing.units_consumed_before === row.units_consumed_before,
      )
    ) {
      uniqueViolation('merch_cogs_consumptions.lot_id,units_consumed_before');
    }
    const record: MerchCogsConsumptionRecord = { ...row, id: randomUUID() };
    this.merchCogsConsumptions.push(record);
    return record;
  }

  async listMerchCogsConsumptions(lotId: string): Promise<MerchCogsConsumptionRecord[]> {
    return this.merchCogsConsumptions
      .filter((row) => row.lot_id === lotId)
      .sort((a, b) => a.units_consumed_before - b.units_consumed_before);
  }

  async upsertMerchCollabAgreement(
    row: Omit<MerchCollabAgreementRecord, 'id'>,
  ): Promise<MerchCollabAgreementRecord> {
    // One agreement of record per sku — upsert replaces the row atomically.
    const existingIndex = this.merchCollabAgreements.findIndex(
      (candidate) => candidate.sku_id === row.sku_id,
    );
    const record: MerchCollabAgreementRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.merchCollabAgreements[existingIndex] = record;
    } else {
      this.merchCollabAgreements.push(record);
    }
    return record;
  }

  async getMerchCollabAgreement(skuId: string): Promise<MerchCollabAgreementRecord | undefined> {
    return this.merchCollabAgreements.find((candidate) => candidate.sku_id === skuId);
  }

  async insertMerchCollabRecoupmentApplication(
    row: Omit<MerchCollabRecoupmentApplicationRecord, 'id'>,
  ): Promise<MerchCollabRecoupmentApplicationRecord> {
    // UNIQUE on (agreement_id, pool_class, source_event_id) — a replayed
    // settlement is the unique violation, never a double recovery. UNIQUE
    // on (agreement_id, pool_class, recouped_before_cents) — the
    // insert-as-lock position arbiter.
    if (
      this.merchCollabRecoupmentApplications.some(
        (existing) =>
          existing.agreement_id === row.agreement_id &&
          existing.pool_class === row.pool_class &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('merch_collab_recoupment_applications.agreement_id,pool_class,source_event_id');
    }
    if (
      this.merchCollabRecoupmentApplications.some(
        (existing) =>
          existing.agreement_id === row.agreement_id &&
          existing.pool_class === row.pool_class &&
          existing.recouped_before_cents === row.recouped_before_cents,
      )
    ) {
      uniqueViolation('merch_collab_recoupment_applications.agreement_id,pool_class,recouped_before_cents');
    }
    const record: MerchCollabRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.merchCollabRecoupmentApplications.push(record);
    return record;
  }

  async listMerchCollabRecoupmentApplications(
    agreementId: string,
    poolClass: MerchCollabPoolClass,
  ): Promise<MerchCollabRecoupmentApplicationRecord[]> {
    return this.merchCollabRecoupmentApplications
      .filter((row) => row.agreement_id === agreementId && row.pool_class === poolClass)
      .sort((a, b) => a.recouped_before_cents - b.recouped_before_cents);
  }

  async upsertMerchDesignerRoyaltyTier(
    row: Omit<MerchDesignerRoyaltyTierRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyTierRecord> {
    // One tier of record per sku — upsert replaces the row atomically.
    const existingIndex = this.merchDesignerRoyaltyTiers.findIndex(
      (candidate) => candidate.sku_id === row.sku_id,
    );
    const record: MerchDesignerRoyaltyTierRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.merchDesignerRoyaltyTiers[existingIndex] = record;
    } else {
      this.merchDesignerRoyaltyTiers.push(record);
    }
    return record;
  }

  async getMerchDesignerRoyaltyTier(
    skuId: string,
  ): Promise<MerchDesignerRoyaltyTierRecord | undefined> {
    return this.merchDesignerRoyaltyTiers.find((candidate) => candidate.sku_id === skuId);
  }

  async insertMerchDesignerRoyaltyBilling(
    row: Omit<MerchDesignerRoyaltyBillingRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyBillingRecord> {
    // UNIQUE on (source_event_id, sku_id) — a replayed fulfillment event is
    // the unique violation, never a double billing.
    if (
      this.merchDesignerRoyaltyBillings.some(
        (existing) =>
          existing.source_event_id === row.source_event_id && existing.sku_id === row.sku_id,
      )
    ) {
      uniqueViolation('merch_designer_royalty_billings.source_event_id,sku_id');
    }
    const record: MerchDesignerRoyaltyBillingRecord = { ...row, id: randomUUID() };
    this.merchDesignerRoyaltyBillings.push(record);
    return record;
  }

  async insertMerchConsignmentSettlement(
    row: Omit<MerchConsignmentSettlementRecord, 'id'>,
  ): Promise<MerchConsignmentSettlementRecord> {
    // UNIQUE on event_id — a re-shipped report is the unique violation
    // (the replay surface).
    if (this.merchConsignmentSettlements.some((existing) => existing.event_id === row.event_id)) {
      uniqueViolation('merch_consignment_settlements.event_id');
    }
    const record: MerchConsignmentSettlementRecord = { ...row, id: randomUUID() };
    this.merchConsignmentSettlements.push(record);
    return record;
  }

  async getMerchConsignmentSettlementByEventId(
    eventId: string,
  ): Promise<MerchConsignmentSettlementRecord | undefined> {
    return this.merchConsignmentSettlements.find((candidate) => candidate.event_id === eventId);
  }


  async sumVerifiedImpressionsByEpisode(
    episodeId: string,
    eventIdPrefixes: readonly string[],
  ): Promise<number> {
    // The raw payload is the source of truth — parse it like every other
    // recovery path. Only rows whose event_id matches a milestone-kind
    // prefix count (downloads ignores subscription rows), and only VERIFIED
    // impressions count: held rows carry `podcast:held:` ids and unverified
    // rows never wrote a `podcast:imp:` row at all.
    let total = 0;
    for (const row of this.matchQueue) {
      if (!eventIdPrefixes.some((prefix) => row.event_id.startsWith(prefix))) {
        continue;
      }
      if (podcastEpisodeIdOfQueueRow(row.raw_payload) !== episodeId) continue;
      total += row.verified_impressions ?? 0;
    }
    return total;
  }

  // --- BaaS transfers ---

  async insertBaasTransfer(row: Omit<BaasTransferRecord, 'id'>): Promise<BaasTransferRecord> {
    const record: BaasTransferRecord = { ...row, id: randomUUID() };
    this.baasTransfers.set(record.id, record);
    return record;
  }

  async getBaasTransfer(id: string): Promise<BaasTransferRecord | undefined> {
    return this.baasTransfers.get(id);
  }

  async listBaasTransfers(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<BaasTransferRecord[]> {
    return sortByTime([...this.baasTransfers.values()], (row) => row.created_at, 'desc').slice(
      0,
      limit,
    );
  }

  async updateBaasTransferStatus(
    id: string,
    status: BaasTransferRecord['status'],
  ): Promise<BaasTransferRecord | undefined> {
    const row = this.baasTransfers.get(id);
    if (row === undefined) return undefined;
    row.status = status;
    return row;
  }

  // --- Company dust ---

  async insertCompanyDust(row: Omit<CompanyDustRecord, 'id'>): Promise<CompanyDustRecord> {
    const record: CompanyDustRecord = { ...row, id: randomUUID() };
    this.companyDust.push(record);
    return record;
  }

  async listCompanyDustByRun(splitRunId: string): Promise<CompanyDustRecord[]> {
    return sortByTime(
      this.companyDust.filter((row) => row.split_run_id === splitRunId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Compliance ---

  async getCreatorTaxProfile(creatorId: string): Promise<CreatorTaxProfile | undefined> {
    return this.taxProfiles.get(creatorId);
  }

  async upsertCreatorTaxProfile(row: CreatorTaxProfile): Promise<CreatorTaxProfile> {
    this.taxProfiles.set(row.creator_id, row);
    return row;
  }

  async getCreatorYtd(
    creatorId: string,
    taxYear: number,
  ): Promise<CreatorYtdEarnings | undefined> {
    return this.creatorYtd.get(`${creatorId}:${taxYear}`);
  }

  async upsertCreatorYtd(row: CreatorYtdEarnings): Promise<CreatorYtdEarnings> {
    this.creatorYtd.set(`${row.creator_id}:${row.tax_year}`, row);
    return row;
  }

  async insertTaxEscrow(row: Omit<TaxEscrowRecord, 'id'>): Promise<TaxEscrowRecord> {
    const record: TaxEscrowRecord = { ...row, id: randomUUID() };
    this.taxEscrow.push(record);
    return record;
  }

  async listTaxEscrowByCreator(
    creatorId: string,
    taxYear: number,
  ): Promise<TaxEscrowRecord[]> {
    return sortByTime(
      this.taxEscrow.filter(
        (row) => row.creator_id === creatorId && row.tax_year === taxYear,
      ),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Vaults + disputes ---

  async getVault(payeeId: string): Promise<SovereignVaultRecord | undefined> {
    return this.vaults.get(payeeId);
  }

  async listVaults(): Promise<SovereignVaultRecord[]> {
    return [...this.vaults.values()].sort((a, b) => (a.payee_id < b.payee_id ? -1 : 1));
  }

  async upsertVault(row: SovereignVaultRecord): Promise<SovereignVaultRecord> {
    this.vaults.set(row.payee_id, row);
    return row;
  }

  /**
   * The atomic vault mutation (migration 0009, H1) — the memory-store mirror
   * of the apply_vault_delta RPC. There is no await between the read and the
   * write here (the method body is synchronous), so a concurrent second call
   * observes the first call's balances — the same no-lost-update guarantee
   * the database enforces with its conditional statement.
   */
  async applyVaultDelta(input: VaultDeltaInput): Promise<ApplyVaultDeltaResult> {
    const delta = input.delta;
    const min = input.min_balances ?? {};
    const minAvailable = min.available_balance ?? null;
    const minPending = min.pending_balance ?? null;
    const minReserve = min.reserve_balance ?? null;
    const current = this.vaults.get(input.payee_id);

    if (current === undefined) {
      if (!input.create_if_missing) {
        return { outcome: 'not_found' };
      }
      // Minting is credits-only: a negative delta with no vault to debit is
      // the caller's not_found, and a floor the minted balances cannot
      // satisfy is guard_failed — both before anything is written.
      if (delta.available_balance < 0 || delta.pending_balance < 0 || delta.reserve_balance < 0) {
        return { outcome: 'not_found' };
      }
      if (
        (minAvailable !== null && delta.available_balance < minAvailable) ||
        (minPending !== null && delta.pending_balance < minPending) ||
        (minReserve !== null && delta.reserve_balance < minReserve)
      ) {
        return { outcome: 'guard_failed' };
      }
      const minted: SovereignVaultRecord = {
        payee_id: input.payee_id,
        payee_name: input.payee_name,
        available_balance: delta.available_balance,
        pending_balance: delta.pending_balance,
        reserve_balance: delta.reserve_balance,
        updated_at: input.updated_at,
      };
      this.vaults.set(minted.payee_id, minted);
      return { outcome: 'applied', vault: minted };
    }

    const nextAvailable = current.available_balance + delta.available_balance;
    const nextPending = current.pending_balance + delta.pending_balance;
    const nextReserve = current.reserve_balance + delta.reserve_balance;
    if (
      (minAvailable !== null && nextAvailable < minAvailable) ||
      (minPending !== null && nextPending < minPending) ||
      (minReserve !== null && nextReserve < minReserve)
    ) {
      return { outcome: 'guard_failed' };
    }
    const updated: SovereignVaultRecord = {
      ...current,
      available_balance: nextAvailable,
      pending_balance: nextPending,
      reserve_balance: nextReserve,
      updated_at: input.updated_at,
    };
    this.vaults.set(updated.payee_id, updated);
    return { outcome: 'applied', vault: updated };
  }

  async getVaultDispute(payeeId: string): Promise<VaultDisputeRecord | undefined> {
    return this.vaultDisputes.get(payeeId);
  }

  async upsertVaultDispute(row: VaultDisputeRecord): Promise<VaultDisputeRecord> {
    this.vaultDisputes.set(row.payee_id, row);
    return row;
  }

  async getCatalogDispute(workId: string): Promise<CatalogDisputeRecord | undefined> {
    return this.catalogDisputes.get(workId);
  }

  async upsertCatalogDispute(row: CatalogDisputeRecord): Promise<CatalogDisputeRecord> {
    this.catalogDisputes.set(row.work_id, row);
    return row;
  }

  // --- Recoupment ---

  async getRecoupmentAdvance(
    creatorId: string,
  ): Promise<RecoupmentAdvanceRecord | undefined> {
    return this.recoupmentAdvances.get(creatorId);
  }

  async upsertRecoupmentAdvance(row: RecoupmentAdvanceRecord): Promise<RecoupmentAdvanceRecord> {
    this.recoupmentAdvances.set(row.creator_id, row);
    return row;
  }

  async listRecoupmentAdvances(): Promise<RecoupmentAdvanceRecord[]> {
    return [...this.recoupmentAdvances.values()].sort((a, b) =>
      a.creator_id < b.creator_id ? -1 : 1,
    );
  }

  async insertRecoupmentLedger(
    row: Omit<RecoupmentLedgerRecord, 'id'>,
  ): Promise<RecoupmentLedgerRecord> {
    const record: RecoupmentLedgerRecord = { ...row, id: randomUUID() };
    this.recoupmentLedger.push(record);
    return record;
  }

  async listRecoupmentLedgerByRun(splitRunId: string): Promise<RecoupmentLedgerRecord[]> {
    return sortByTime(
      this.recoupmentLedger.filter((row) => row.split_run_id === splitRunId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Payout holds + reversals ---

  async getPayoutHold(transferId: string): Promise<PayoutHoldRecord | undefined> {
    return this.payoutHolds.get(transferId);
  }

  async insertPayoutHold(row: PayoutHoldRecord): Promise<PayoutHoldRecord> {
    this.payoutHolds.set(row.transfer_id, row);
    return row;
  }

  async updatePayoutHoldStatus(
    transferId: string,
    status: PayoutHoldRecord['status'],
  ): Promise<PayoutHoldRecord | undefined> {
    const row = this.payoutHolds.get(transferId);
    if (row === undefined) return undefined;
    row.status = status;
    return row;
  }

  async sumInFlightPayoutHolds(payeeId: string): Promise<number> {
    let total = 0;
    for (const row of this.payoutHolds.values()) {
      if (row.payee_id === payeeId && row.status === 'in_flight') {
        total += row.amount_cents;
      }
    }
    return total;
  }

  async insertPayoutReversal(
    row: Omit<PayoutReversalRecord, 'id'>,
  ): Promise<PayoutReversalRecord> {
    // Migration 0009 (H4): payout_reversals.transfer_id is unique — the
    // insert-as-lock replay guard. One reversal row per transfer, ever.
    if ([...this.payoutReversals.values()].some((row2) => row2.transfer_id === row.transfer_id)) {
      uniqueViolation('payout_reversals.transfer_id');
    }
    const record: PayoutReversalRecord = { ...row, id: randomUUID() };
    this.payoutReversals.set(record.id, record);
    return record;
  }

  async getPayoutReversalByTransfer(
    transferId: string,
  ): Promise<PayoutReversalRecord | undefined> {
    // Latest reversal for the transfer (SupabaseStore: created_at DESC LIMIT 1).
    return sortByTime(
      [...this.payoutReversals.values()].filter((row) => row.transfer_id === transferId),
      (row) => row.created_at,
      'desc',
    )[0];
  }

  async updatePayoutReversal(
    id: string,
    patch: Pick<PayoutReversalRecord, 'journal_id' | 'ledger_transaction_id'>,
  ): Promise<PayoutReversalRecord | undefined> {
    const row = this.payoutReversals.get(id);
    if (row === undefined) return undefined;
    const updated: PayoutReversalRecord = { ...row, ...patch };
    this.payoutReversals.set(id, updated);
    return updated;
  }

  async deletePayoutReversal(id: string): Promise<void> {
    this.payoutReversals.delete(id);
  }

  // --- Webhook event ledgers ---

  async getWebhookEvent(eventId: string): Promise<BaasWebhookEventRecord | undefined> {
    return this.baasWebhookEvents.get(eventId);
  }

  async insertWebhookEvent(
    row: Omit<BaasWebhookEventRecord, 'id'>,
  ): Promise<BaasWebhookEventRecord> {
    if (this.baasWebhookEvents.has(row.event_id)) {
      uniqueViolation('baas_webhook_events.event_id');
    }
    // Keyed by event_id — the dedupe/read key (getWebhookEvent).
    const record: BaasWebhookEventRecord = { ...row, id: randomUUID() };
    this.baasWebhookEvents.set(row.event_id, record);
    return record;
  }

  async getDspWebhookEvent(eventId: string): Promise<DspWebhookEventRecord | undefined> {
    return this.dspWebhookEvents.get(eventId);
  }

  async insertDspWebhookEvent(
    row: Omit<DspWebhookEventRecord, 'id'>,
  ): Promise<DspWebhookEventRecord> {
    if (this.dspWebhookEvents.has(row.event_id)) {
      uniqueViolation('dsp_webhook_events.event_id');
    }
    // Keyed by event_id — the dedupe/read key (getDspWebhookEvent).
    const record: DspWebhookEventRecord = { ...row, id: randomUUID() };
    this.dspWebhookEvents.set(row.event_id, record);
    return record;
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
    const record: GlJournalRecord = {
      ...row,
      sequence: row.sequence ?? 0,
      prev_hash: row.prev_hash ?? '',
      entry_hash: row.entry_hash ?? '',
      state: row.state ?? 'posted',
      id: randomUUID(),
    };
    // Migration 0009 (H2): gl_journals.sequence is unique — the chain cannot
    // fork under concurrent posts.
    if (this.glJournals.some((journal) => journal.sequence === record.sequence)) {
      uniqueViolation('gl_journals.sequence');
    }
    this.glJournals.push(record);
    return record;
  }

  async insertGlEntry(row: Omit<GlEntryRecord, 'id'>): Promise<GlEntryRecord> {
    const record: GlEntryRecord = { ...row, id: randomUUID() };
    this.glEntries.push(record);
    return record;
  }

  async listGlJournals(): Promise<GlJournalRecord[]> {
    return this.glJournals
      .map((row, index) => ({ row, index }))
      .sort((a, b) => a.row.sequence - b.row.sequence || a.index - b.index)
      .map((entry) => entry.row);
  }

  async getLatestGlJournal(): Promise<GlJournalRecord | undefined> {
    const ordered = await this.listGlJournals();
    return ordered[ordered.length - 1];
  }

  async listGlJournalsByRef(refType: string, refId: string): Promise<GlJournalRecord[]> {
    return (await this.listGlJournals()).filter(
      (row) => row.ref_type === refType && row.ref_id === refId,
    );
  }

  async listGlEntries(): Promise<GlEntryRecord[]> {
    return [...this.glEntries];
  }

  async listGlEntriesByJournal(journalId: string): Promise<GlEntryRecord[]> {
    return this.glEntries.filter((row) => row.journal_id === journalId);
  }

  // --- Split-run reversals ---

  async insertSplitReversal(row: Omit<SplitReversalRecord, 'id'>): Promise<SplitReversalRecord> {
    for (const existing of this.splitReversals) {
      if (existing.split_run_id === row.split_run_id) {
        uniqueViolation('split_reversals.split_run_id');
      }
    }
    const record: SplitReversalRecord = { ...row, id: randomUUID() };
    this.splitReversals.push(record);
    return record;
  }

  async getSplitReversalByRun(splitRunId: string): Promise<SplitReversalRecord | undefined> {
    return this.splitReversals.find((row) => row.split_run_id === splitRunId);
  }

  // --- SDK collection surfaces (migration 0007) ---

  async upsertClearance(row: MulClearanceRecord): Promise<MulClearanceRecord> {
    this.mulClearances.set(row.asset_cbt_code, row);
    return row;
  }

  async getClearanceForAsset(assetCbtCode: string): Promise<MulClearanceRecord | undefined> {
    return this.mulClearances.get(assetCbtCode);
  }

  async insertClearanceTransition(
    row: Omit<MulClearanceTransitionRecord, 'id'>,
  ): Promise<MulClearanceTransitionRecord> {
    const record: MulClearanceTransitionRecord = { ...row, id: randomUUID() };
    this.clearanceTransitions.push(record);
    return record;
  }

  async listClearanceTransitions(
    assetCbtCode: string,
  ): Promise<MulClearanceTransitionRecord[]> {
    return sortByTime(
      this.clearanceTransitions.filter((row) => row.asset_cbt_code === assetCbtCode),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertMatchQueueEntry(row: Omit<MatchQueueRecord, 'id'>): Promise<MatchQueueRecord> {
    for (const existing of this.matchQueue) {
      if (existing.event_id === row.event_id) {
        uniqueViolation('match_queue.event_id');
      }
    }
    const record: MatchQueueRecord = { ...row, id: randomUUID() };
    this.matchQueue.push(record);
    return record;
  }

  async getMatchQueueEntry(id: string): Promise<MatchQueueRecord | undefined> {
    return this.matchQueue.find((row) => row.id === id);
  }

  async getMatchQueueEntryByEventId(
    eventId: string,
  ): Promise<MatchQueueRecord | undefined> {
    return this.matchQueue.find((row) => row.event_id === eventId);
  }

  async listMatchQueueEntries(
    status?: MatchQueueRecord['status'],
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<MatchQueueRecord[]> {
    const rows =
      status === undefined
        ? [...this.matchQueue]
        : this.matchQueue.filter((row) => row.status === status);
    return sortByTime(rows, (row) => row.created_at, 'desc').slice(0, limit);
  }

  async resolveMatchQueueEntry(
    id: string,
    resolution: MatchQueueResolution,
  ): Promise<MatchQueueRecord | undefined> {
    const record = this.matchQueue.find((row) => row.id === id);
    if (record === undefined) return undefined;
    const resolved = {
      ...record,
      status: resolution.status,
      matched_cbt_code: resolution.status === 'matched' ? resolution.cbtCode : null,
      resolved_at: new Date().toISOString(),
    } satisfies MatchQueueRecord;
    this.matchQueue = this.matchQueue.map((row) => (row.id === id ? resolved : row));
    return resolved;
  }

  async insertStatementIngest(
    row: Omit<StatementIngestRecord, 'id'>,
  ): Promise<StatementIngestRecord> {
    const record: StatementIngestRecord = { ...row, id: randomUUID() };
    this.statementIngests.set(record.id, record);
    return record;
  }

  async getStatementIngest(id: string): Promise<StatementIngestRecord | undefined> {
    return this.statementIngests.get(id);
  }

  // --- Royalty recon job queue (migration 0011, spec art_7M0snhxc) ---

  async createReconJob(input: ReconJobInput): Promise<RoyaltyReconJobRecord> {
    const now = new Date().toISOString();
    const record: RoyaltyReconJobRecord = {
      id: randomUUID(),
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
    // Array push = the database's insertion_order — the claim's tiebreak
    // for rows sharing a created_at.
    this.reconJobs.push(record);
    return record;
  }

  async getReconJob(id: string): Promise<RoyaltyReconJobRecord | undefined> {
    return this.reconJobs.find((job) => job.id === id);
  }

  async claimReconJob(
    now: Date = new Date(),
    engine: string | null = null,
  ): Promise<RoyaltyReconJobRecord | undefined> {
    const nowIso = now.toISOString();
    const staleCutoff = new Date(now.getTime() - RECON_STALE_CLAIM_MS).toISOString();
    // Single-threaded equivalent of FOR UPDATE SKIP LOCKED: the candidate
    // scan and the transition happen with no await between them. Scanning
    // the insertion-ordered array keeps the EARLIEST claimable job —
    // strict < on created_at preserves insertion order on a tie.
    let best: RoyaltyReconJobRecord | undefined;
    for (const job of this.reconJobs) {
      const claimable =
        job.status === 'pending' ||
        (job.status === 'processing' &&
          job.claimed_at !== null &&
          job.claimed_at < staleCutoff);
      if (!claimable) continue;
      if (best === undefined || job.created_at < best.created_at) best = job;
    }
    if (best === undefined) return undefined;
    const claimed: RoyaltyReconJobRecord = {
      ...best,
      status: 'processing',
      engine,
      claimed_at: nowIso,
      started_at: best.started_at ?? nowIso,
      attempts: best.attempts + 1,
      updated_at: nowIso,
    };
    this.reconJobs = this.reconJobs.map((row) => (row.id === best.id ? claimed : row));
    return claimed;
  }

  async completeReconJob(
    id: string,
    result: ReconJobResult,
  ): Promise<RoyaltyReconJobRecord | undefined> {
    const job = await this.getReconJob(id);
    if (job === undefined) return undefined;
    if (isTerminalReconJob(job)) return job; // replay — leave the row untouched
    if (job.status !== 'pending' && job.status !== 'processing') return job;
    const completed: RoyaltyReconJobRecord = {
      ...job,
      status: 'completed',
      result,
      error: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.reconJobs = this.reconJobs.map((row) => (row.id === id ? completed : row));
    return completed;
  }

  async failReconJob(id: string, error: string): Promise<RoyaltyReconJobRecord | undefined> {
    const job = await this.getReconJob(id);
    if (job === undefined) return undefined;
    if (isTerminalReconJob(job)) return job; // replay — leave the row untouched
    if (job.status !== 'pending' && job.status !== 'processing') return job;
    const now = new Date().toISOString();
    const pastBudget = job.attempts >= RECON_MAX_ATTEMPTS;
    const failed: RoyaltyReconJobRecord = pastBudget
      ? {
          ...job,
          status: 'failed',
          error,
          completed_at: now,
          updated_at: now,
        }
      : {
          ...job,
          status: 'pending', // back to the pool for the next claim
          error,
          claimed_at: null, // nobody holds it while it waits
          updated_at: now,
        };
    this.reconJobs = this.reconJobs.map((row) => (row.id === id ? failed : row));
    return failed;
  }

  // --- The UCT credential vault (migration 0013, PR 5) ---

  async createDistributorConnection(
    input: DistributorConnectionInput,
  ): Promise<DistributorConnectionUpsert> {
    const now = new Date().toISOString();
    // Reconnect = rotate: one ACTIVE row per (holder, distributor), the
    // in-memory equivalent of the migration's partial unique index.
    const existing = this.distributorConnections.find(
      (row) =>
        row.holder_id === input.holder_id &&
        row.distributor === input.distributor &&
        row.status === 'connected',
    );
    if (existing !== undefined) {
      const rotated: DistributorConnectionRecord = {
        ...existing,
        username_encrypted: input.username_encrypted,
        password_encrypted: input.password_encrypted,
        updated_at: now,
      };
      this.distributorConnections = this.distributorConnections.map((row) =>
        row.id === existing.id ? rotated : row,
      );
      return { connection: rotated, rotated: true };
    }
    const record: DistributorConnectionRecord = {
      id: randomUUID(),
      holder_id: input.holder_id,
      distributor: input.distributor,
      status: 'connected',
      username_encrypted: input.username_encrypted,
      password_encrypted: input.password_encrypted,
      last_verified_at: null, // the Astra agent writes traversal provenance (PR 6)
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.distributorConnections.push(record);
    return { connection: record, rotated: false };
  }

  async listDistributorConnections(holderId: string): Promise<DistributorConnectionRecord[]> {
    // Newest first — the array's insertion order reversed (created_at ties
    // resolve by insertion_order, which the push order IS).
    return this.distributorConnections
      .filter((row) => row.holder_id === holderId)
      .slice()
      .reverse();
  }

  async getDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined> {
    return this.distributorConnections.find(
      (row) => row.id === id && row.holder_id === holderId,
    );
  }

  async disconnectDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined> {
    const connection = await this.getDistributorConnection(holderId, id);
    if (connection === undefined) return undefined;
    if (connection.status === 'disconnected') return connection; // replay — untouched
    const disconnected: DistributorConnectionRecord = {
      ...connection,
      status: 'disconnected',
      updated_at: new Date().toISOString(),
    };
    this.distributorConnections = this.distributorConnections.map((row) =>
      row.id === id ? disconnected : row,
    );
    return disconnected;
  }

  async listActiveDistributorConnections(): Promise<DistributorConnectionRecord[]> {
    // Oldest insertion first — the sweep traverses in connect order. The
    // array's push order IS insertion_order (see listDistributorConnections).
    return this.distributorConnections.filter((row) => row.status === 'connected');
  }

  async markDistributorTraversal(
    id: string,
    outcome: DistributorTraversalOutcome,
  ): Promise<DistributorConnectionRecord | undefined> {
    const connection = this.distributorConnections.find((row) => row.id === id);
    if (connection === undefined) return undefined;
    const now = new Date().toISOString();
    // Success verifies (and clears the stale error); failure records the
    // honest reason and never touches last_verified_at. Neither ever flips
    // status — disconnect is the holder's explicit act.
    const marked: DistributorConnectionRecord = {
      ...connection,
      last_verified_at: 'verifiedAt' in outcome ? outcome.verifiedAt : connection.last_verified_at,
      last_error: 'error' in outcome ? outcome.error : null,
      updated_at: now,
    };
    this.distributorConnections = this.distributorConnections.map((row) =>
      row.id === id ? marked : row,
    );
    return marked;
  }

  // --- Clearinghouse kernel + Sync Library seams (migration 0008) ---

  async getCreatorUct(creatorId: string): Promise<CreatorUctRecord | undefined> {
    return this.creatorUcts.get(creatorId);
  }

  /**
   * Local-dev/test seed for the identity projection — NOT on the Store
   * interface. Production identity comes from the signup registry holder
   * entries (SupabaseStore reads them); the in-memory and SQLite backends
   * materialize the same projection here.
   */
  async upsertCreatorUct(row: CreatorUctRecord): Promise<CreatorUctRecord> {
    this.creatorUcts.set(row.creatorId, row);
    return row;
  }

  async upsertSyncCatalogItem(
    row: Omit<SyncCatalogItemRecord, 'updated_at'> & { updated_at?: string },
  ): Promise<SyncCatalogItemRecord> {
    const record: SyncCatalogItemRecord = {
      ...row,
      updated_at: row.updated_at ?? new Date().toISOString(),
    };
    this.syncCatalog.set(record.cbt_code, record);
    return record;
  }

  async getSyncCatalogItem(cbtCode: string): Promise<SyncCatalogItemRecord | undefined> {
    return this.syncCatalog.get(cbtCode);
  }

  async listSyncCatalogItems(): Promise<SyncCatalogItemRecord[]> {
    return [...this.syncCatalog.values()].sort((a, b) =>
      a.cbt_code < b.cbt_code ? -1 : a.cbt_code > b.cbt_code ? 1 : 0,
    );
  }

  async insertSyncLicensePurchase(
    row: Omit<SyncLicensePurchaseRecord, 'id' | 'created_at'>,
  ): Promise<SyncLicensePurchaseRecord> {
    const existing = this.syncPurchases.get(row.cbt_settlement_stamp);
    if (existing !== undefined) uniqueViolation('sync_license_purchases.cbt_settlement_stamp');
    const record: SyncLicensePurchaseRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.syncPurchases.set(record.cbt_settlement_stamp, record);
    return record;
  }

  async getSyncLicensePurchaseByStamp(stamp: string): Promise<SyncLicensePurchaseRecord | undefined> {
    return this.syncPurchases.get(stamp);
  }

  // --- Territory settlement seam (spec art_qNu4T32F) ---

  /**
   * The SDK-settled tier credits' territory projection — SDK-settled ONLY
   * (the transaction_type gate runs before projection), oldest first with
   * the transaction_id tiebreak the other backends order by.
   */
  async listTerritorySettlements(): Promise<TerritorySettlementRecord[]> {
    return this.universalRoyaltyLedger
      .filter((row) => isSdkSettlementTransactionType(row.transaction_type))
      .sort(compareTierCreditRows)
      .map(territorySettlementOfRow);
  }

  /**
   * Fixture affordance for the tier ledger — the in-memory stand-in for the
   * wire's raw-SQL INSERT (covnant-sdk/src/engine/wire.ts settleEvent).
   * NOT on the Store contract: production writes go through the wire, and
   * this method exists so tests can seat rows exactly as the wire writes
   * them without a database. Verbatim row — no id minting, no mutation.
   */
  async insertUniversalRoyaltyLedgerRow(row: UniversalRoyaltyLedgerRow): Promise<UniversalRoyaltyLedgerRow> {
    this.universalRoyaltyLedger.push(row);
    return row;
  }

  // --- Operations back-office seam (spec art_Eis55ifL) ---

  /**
   * The statement-ingest provenance list — newest first with the
   * insertion-order tiebreak (sortByTime keeps tied rows in the list's own
   * direction: the latest insertion leads), bounded by limit.
   */
  async listStatementIngests(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<StatementIngestRecord[]> {
    return sortByTime([...this.statementIngests.values()], (row) => row.created_at, 'desc').slice(
      0,
      limit,
    );
  }

  /**
   * admin_action_log is a Supabase-production surface (migration 0005, RLS
   * service-role-only); the in-memory backend carries no mirror and the
   * Store adds no write path — the honest read is empty, never fabricated
   * rows.
   */
  async listAdminActions(): Promise<AdminActionRecord[]> {
    return [];
  }
}

/** Deterministic tier-credit order: created_at ASC, transaction_id ASC (code-unit compare, matching the SQL backends' BINARY collation). */
function compareTierCreditRows(a: UniversalRoyaltyLedgerRow, b: UniversalRoyaltyLedgerRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.transaction_id !== b.transaction_id) {
    return a.transaction_id < b.transaction_id ? -1 : 1;
  }
  return 0;
}
