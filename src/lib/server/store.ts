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
