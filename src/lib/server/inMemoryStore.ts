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
  private dspWebhookEvents = new Map<string, DspWebhookEventRecord>();
  private splitReversals: SplitReversalRecord[] = [];

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
    row: Omit<SplitRunRecord, 'id' | 'status'> & { status?: SplitRunRecord['status'] },
  ): Promise<SplitRunRecord> {
    const record: SplitRunRecord = {
      ...row,
      status: row.status ?? 'posted',
      id: randomUUID(),
    };
    this.splitRuns.set(record.id, record);
    return record;
  }

  async getSplitRun(id: string): Promise<SplitRunRecord | undefined> {
    return this.splitRuns.get(id);
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
}
