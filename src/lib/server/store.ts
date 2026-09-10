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
    row: Omit<SplitRunRecord, 'id' | 'status'> & { status?: SplitRunRecord['status'] },
  ): Promise<SplitRunRecord>;
  getSplitRun(id: string): Promise<SplitRunRecord | undefined>;
  updateSplitRunStatus(
    id: string,
    status: SplitRunRecord['status'],
  ): Promise<SplitRunRecord | undefined>;
  insertRoyaltyLineItem(
    row: Omit<RoyaltyLineItemRecord, 'id'>,
  ): Promise<RoyaltyLineItemRecord>;

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
