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
  type ArtistRecord,
  type CheckoutPurchaseResult,
  type LivePingRecord,
  type ShowRecord,
  type Store,
  type ValidLivePingPayload,
  type ValidShowPayload,
} from '@/lib/server/store';
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
} as const;

type DbResult = PromiseLike<{
  data: unknown;
  error: { message: string; code: string } | null;
}>;

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
    row: Omit<SplitRunRecord, 'id' | 'status'> & { status?: SplitRunRecord['status'] },
  ): Promise<SplitRunRecord> {
    return this.oneStrict<SplitRunRecord>(
      this.client
        .from(TABLES.splitRuns)
        .insert({ ...row, status: row.status ?? 'posted', id: crypto.randomUUID() })
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
}
