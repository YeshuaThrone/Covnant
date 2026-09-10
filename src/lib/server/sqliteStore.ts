/**
 * SqliteStore — the canonical Cursor implementation, mechanically
 * async-wrapped for local development (architectural ruling 2026-09-10).
 *
 * Adaptation, NOT verbatim: Cursor's canonical Store contract is fully
 * synchronous (it assumed a self-hosted better-sqlite3 deployment). The
 * official adapted contract is Promise-based end to end because production
 * persistence is Supabase/Postgres over the async supabase-js client, and a
 * synchronous interface cannot be implemented over an async-only client.
 * This file keeps the canonical SCHEMA string byte-for-byte and every
 * method body's synchronous internals intact; each public method is
 * declared `async` and hands its sync result to `Promise.resolve`
 * (delegating methods return the inner promise directly). The constructor,
 * `migrate()`, and the SQL itself are unchanged.
 *
 * Not used in production: `getStore()` boots `SupabaseStore` (see
 * ./store.ts). SqliteStore remains the local/dev and engine-test reference
 * backend, exactly matching migration 0006's column inventory.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

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

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL,
  set_time TEXT NOT NULL,
  ticket_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  ticketing_type TEXT NOT NULL DEFAULT '',
  native_ticket_price REAL,
  native_ticket_capacity INTEGER,
  latitude REAL,
  longitude REAL,
  council_district TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS live_pings (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT ''
);

-- PR 24 capacity accounting: one row per completed checkout session. The
-- primary key is the idempotency guard — a repeated success-redirect
-- confirm (or a future webhook + redirect race) inserts nothing and
-- therefore never double-decrements capacity.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Don Engine sandbox: Plaid Link tokens, KYC outcomes, UDR ledger, BaaS rails.
CREATE TABLE IF NOT EXISTS plaid_link_tokens (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  link_token TEXT NOT NULL UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  expiration TEXT NOT NULL,
  products TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_verifications (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  plaid_link_token TEXT,
  plaid_public_token TEXT,
  status TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS split_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  period TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  gross_cents INTEGER NOT NULL,
  line_item_count INTEGER NOT NULL,
  variance_account_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted'
);

CREATE TABLE IF NOT EXISTS royalty_line_items (
  id TEXT PRIMARY KEY,
  split_run_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  work_title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  splits_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  split_run_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  role TEXT NOT NULL,
  share_bps INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  rail TEXT,
  baas_provider TEXT,
  baas_transfer_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  kind TEXT NOT NULL DEFAULT 'royalty'
);

CREATE TABLE IF NOT EXISTS baas_transfers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  rail TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  ledger_transaction_id TEXT,
  created_at TEXT NOT NULL,
  estimated_settlement TEXT
);

CREATE TABLE IF NOT EXISTS company_dust_ledger (
  id TEXT PRIMARY KEY,
  split_run_id TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  variance_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_tax_profiles (
  creator_id TEXT PRIMARY KEY,
  tin_verified INTEGER NOT NULL DEFAULT 0,
  w9_on_file INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_ytd_earnings (
  creator_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  withheld_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (creator_id, tax_year)
);

CREATE TABLE IF NOT EXISTS tax_escrow_ledger (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  withheld_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  tin_verified INTEGER NOT NULL,
  w9_on_file INTEGER NOT NULL,
  requires_1099 INTEGER NOT NULL,
  crossed_1099_threshold INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sovereign_vaults (
  payee_id TEXT PRIMARY KEY,
  payee_name TEXT NOT NULL,
  available_balance INTEGER NOT NULL DEFAULT 0,
  pending_balance INTEGER NOT NULL DEFAULT 0,
  reserve_balance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plaid_processor_tokens (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  public_token TEXT NOT NULL,
  processor TEXT NOT NULL,
  processor_token TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (public_token, processor)
);

CREATE TABLE IF NOT EXISTS recoupment_advances (
  creator_id TEXT PRIMARY KEY,
  creator_name TEXT NOT NULL,
  recoupment_target_cents INTEGER NOT NULL,
  recoupment_current_cents INTEGER NOT NULL DEFAULT 0,
  recoupment_bps INTEGER NOT NULL DEFAULT 10000,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_disputes (
  payee_id TEXT PRIMARY KEY,
  locked INTEGER NOT NULL DEFAULT 0,
  line_item_id TEXT,
  frozen_from_available INTEGER NOT NULL DEFAULT 0,
  frozen_from_pending INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_holds (
  transfer_id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS baas_webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reversal_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payout_reversals (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ledger_transaction_id TEXT,
  journal_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gl_journals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  prev_hash TEXT NOT NULL DEFAULT '',
  entry_hash TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'posted'
);

CREATE TABLE IF NOT EXISTS gl_entries (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL,
  account TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recoupment_ledger (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  split_run_id TEXT NOT NULL,
  incoming_cents INTEGER NOT NULL,
  recouped_cents INTEGER NOT NULL,
  excess_cents INTEGER NOT NULL,
  recoupment_current_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_disputes (
  work_id TEXT PRIMARY KEY,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dsp_webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  source TEXT NOT NULL,
  split_run_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS split_reversals (
  id TEXT PRIMARY KEY,
  split_run_id TEXT NOT NULL UNIQUE,
  journal_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * In-place column additions for databases created before PR 22 (the dev
   * DB at data/atxlive.db predates the show coordinate columns) and before
   * PR 23 (the artists table predates the key columns). SQLite's CREATE
   * TABLE IF NOT EXISTS never alters an existing table, so missing columns
   * are added here; fresh databases already have them.
   */
  private migrate(): void {
    const columnsOf = (table: string) =>
      new Set(
        (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );

    const showColumns = columnsOf('shows');
    if (!showColumns.has('latitude')) {
      this.db.exec(`ALTER TABLE shows ADD COLUMN latitude REAL`);
    }
    if (!showColumns.has('longitude')) {
      this.db.exec(`ALTER TABLE shows ADD COLUMN longitude REAL`);
    }
    if (!showColumns.has('council_district')) {
      this.db.exec(`ALTER TABLE shows ADD COLUMN council_district TEXT NOT NULL DEFAULT ''`);
    }

    // PR 23: pre-23 databases have an artists table without key columns.
    // Existing rows (PR 21/22 stubs) had no credentials; a NOT NULL backfill
    // is impossible for them, so the migration adds nullable columns and
    // fresh registrations always populate them.
    const artistColumns = columnsOf('artists');
    if (!artistColumns.has('key_hash')) {
      this.db.exec(`ALTER TABLE artists ADD COLUMN key_hash TEXT`);
    }
    if (!artistColumns.has('key_prefix')) {
      this.db.exec(`ALTER TABLE artists ADD COLUMN key_prefix TEXT NOT NULL DEFAULT ''`);
    }

    const splitRunColumns = columnsOf('split_runs');
    if (!splitRunColumns.has('variance_account_cents')) {
      this.db.exec(
        `ALTER TABLE split_runs ADD COLUMN variance_account_cents INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!splitRunColumns.has('status')) {
      this.db.exec(`ALTER TABLE split_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'`);
    }

    const ledgerColumns = columnsOf('ledger_transactions');
    if (!ledgerColumns.has('kind')) {
      this.db.exec(
        `ALTER TABLE ledger_transactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'royalty'`,
      );
    }

    const journalColumns = columnsOf('gl_journals');
    if (!journalColumns.has('sequence')) {
      this.db.exec(`ALTER TABLE gl_journals ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0`);
    }
    if (!journalColumns.has('prev_hash')) {
      this.db.exec(`ALTER TABLE gl_journals ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''`);
    }
    if (!journalColumns.has('entry_hash')) {
      this.db.exec(`ALTER TABLE gl_journals ADD COLUMN entry_hash TEXT NOT NULL DEFAULT ''`);
    }
    if (!journalColumns.has('state')) {
      this.db.exec(`ALTER TABLE gl_journals ADD COLUMN state TEXT NOT NULL DEFAULT 'posted'`);
    }
  }

  async insertShow(show: ValidShowPayload): Promise<ShowRecord> {
    const record: ShowRecord = { ...show, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO shows (
           id, artist_id, artist_name, venue_name, address, district,
           set_time, ticket_url, created_at, ticketing_type,
           native_ticket_price, native_ticket_capacity,
           latitude, longitude, council_district
         ) VALUES (
           @id, @artist_id, @artist_name, @venue_name, @address, @district,
           @set_time, @ticket_url, @created_at, @ticketing_type,
           @native_ticket_price, @native_ticket_capacity,
           @latitude, @longitude, @council_district
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listShows(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<ShowRecord[]> {
    // rowid DESC breaks created_at ties so the most recently inserted row
    // still leads when two shows share a timestamp.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM shows
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as ShowRecord[],
    );
  }

  async getShow(id: string): Promise<ShowRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM shows WHERE id = ?`).get(id) as ShowRecord | undefined,
    );
  }

  async recordCheckoutPurchase(
    sessionId: string,
    showId: string,
    quantity: number,
  ): Promise<CheckoutPurchaseResult | null> {
    const show = await this.getShow(showId);
    if (show === undefined || show.ticketing_type !== 'native' || show.native_ticket_capacity === null) {
      return Promise.resolve(null);
    }
    const remainingAfter = (): number => show.native_ticket_capacity ?? 0;

    // Single synchronous transaction: the INSERT OR IGNORE is the
    // idempotency gate, the guarded UPDATE the capacity decrement.
    const txn = this.db.transaction((): CheckoutPurchaseResult => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO checkout_sessions (id, show_id, quantity, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sessionId, showId, quantity, new Date().toISOString());
      if (inserted.changes === 0) {
        return { outcome: 'already_recorded', remaining: remainingAfter() };
      }
      const updated = this.db
        .prepare(
          `UPDATE shows
           SET native_ticket_capacity = native_ticket_capacity - ?
           WHERE id = ? AND native_ticket_capacity >= ?`,
        )
        .run(quantity, showId, quantity);
      if (updated.changes === 0) {
        // Sold out between session creation and confirmation — the row is
        // recorded so retries stay no-ops; the caller surfaces the conflict.
        return { outcome: 'insufficient_capacity', remaining: remainingAfter() };
      }
      return { outcome: 'recorded', remaining: remainingAfter() };
    });
    return Promise.resolve(txn());
  }

  async insertLivePing(ping: ValidLivePingPayload): Promise<LivePingRecord> {
    const record: LivePingRecord = { ...ping, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO live_pings (id, artist_id, latitude, longitude, timestamp, status)
         VALUES (@id, @artist_id, @latitude, @longitude, @timestamp, @status)`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listLivePings(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<LivePingRecord[]> {
    // rowid DESC breaks timestamp ties so the most recently inserted ping
    // still leads when two pings share a timestamp.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM live_pings
         ORDER BY timestamp DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LivePingRecord[],
    );
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
    this.db
      .prepare(
        `INSERT INTO artists (id, name, created_at, key_hash, key_prefix)
         VALUES (@id, @name, @created_at, @key_hash, @key_prefix)`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getArtist(id: string): Promise<ArtistRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM artists WHERE id = ?`).get(id) as ArtistRecord | undefined,
    );
  }

  async getArtistByKeyHash(keyHash: string): Promise<ArtistRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM artists WHERE key_hash = ?`).get(keyHash) as
        | ArtistRecord
        | undefined,
    );
  }

  async insertPlaidLinkToken(
    token: Omit<PlaidLinkTokenRecord, 'id' | 'created_at'>,
  ): Promise<PlaidLinkTokenRecord> {
    const record: PlaidLinkTokenRecord = {
      ...token,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO plaid_link_tokens (
           id, creator_id, link_token, public_token, access_token,
           expiration, products, created_at
         ) VALUES (
           @id, @creator_id, @link_token, @public_token, @access_token,
           @expiration, @products, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getPlaidLinkTokenByLinkToken(linkToken: string): Promise<PlaidLinkTokenRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM plaid_link_tokens WHERE link_token = ?`).get(linkToken) as
        | PlaidLinkTokenRecord
        | undefined,
    );
  }

  async getPlaidLinkTokenByPublicToken(
    publicToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM plaid_link_tokens WHERE public_token = ?`).get(publicToken) as
        | PlaidLinkTokenRecord
        | undefined,
    );
  }

  async updatePlaidAccessToken(
    publicToken: string,
    accessToken: string,
  ): Promise<PlaidLinkTokenRecord | undefined> {
    this.db
      .prepare(`UPDATE plaid_link_tokens SET access_token = ? WHERE public_token = ?`)
      .run(accessToken, publicToken);
    return this.getPlaidLinkTokenByPublicToken(publicToken);
  }

  async insertKycVerification(row: Omit<KycVerificationRecord, 'id'>): Promise<KycVerificationRecord> {
    const record: KycVerificationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO kyc_verifications (
           id, creator_id, plaid_link_token, plaid_public_token, status,
           identity_json, failure_reason, created_at, verified_at
         ) VALUES (
           @id, @creator_id, @plaid_link_token, @plaid_public_token, @status,
           @identity_json, @failure_reason, @created_at, @verified_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listKycVerificationsByCreator(creatorId: string): Promise<KycVerificationRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM kyc_verifications
         WHERE creator_id = ?
         ORDER BY created_at DESC, rowid DESC`,
        )
        .all(creatorId) as KycVerificationRecord[],
    );
  }

  async insertSplitRun(
    row: Omit<SplitRunRecord, 'id' | 'status'> & { status?: SplitRunRecord['status'] },
  ): Promise<SplitRunRecord> {
    const record: SplitRunRecord = {
      ...row,
      status: row.status ?? 'posted',
      id: randomUUID(),
    };
    this.db
      .prepare(
        `INSERT INTO split_runs (
           id, source, period, currency, gross_cents, line_item_count,
           variance_account_cents, created_at, status
         ) VALUES (
           @id, @source, @period, @currency, @gross_cents, @line_item_count,
           @variance_account_cents, @created_at, @status
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getSplitRun(id: string): Promise<SplitRunRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM split_runs WHERE id = ?`).get(id) as SplitRunRecord | undefined,
    );
  }

  async updateSplitRunStatus(
    id: string,
    status: SplitRunRecord['status'],
  ): Promise<SplitRunRecord | undefined> {
    this.db.prepare(`UPDATE split_runs SET status = ? WHERE id = ?`).run(status, id);
    return this.getSplitRun(id);
  }

  async insertRoyaltyLineItem(
    row: Omit<RoyaltyLineItemRecord, 'id'>,
  ): Promise<RoyaltyLineItemRecord> {
    const record: RoyaltyLineItemRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO royalty_line_items (
           id, split_run_id, work_id, work_title, amount_cents, splits_json, created_at
         ) VALUES (
           @id, @split_run_id, @work_id, @work_title, @amount_cents, @splits_json, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

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
    this.db
      .prepare(
        `INSERT INTO ledger_transactions (
           id, split_run_id, line_item_id, payee_id, payee_name, role,
           share_bps, amount_cents, currency, status, rail, baas_provider,
           baas_transfer_id, created_at, settled_at, kind
         ) VALUES (
           @id, @split_run_id, @line_item_id, @payee_id, @payee_name, @role,
           @share_bps, @amount_cents, @currency, @status, @rail, @baas_provider,
           @baas_transfer_id, @created_at, @settled_at, @kind
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getLedgerTransaction(id: string): Promise<LedgerTransactionRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM ledger_transactions WHERE id = ?`).get(id) as
        | LedgerTransactionRecord
        | undefined,
    );
  }

  async listLedgerTransactionsByRun(splitRunId: string): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE split_run_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(splitRunId) as LedgerTransactionRecord[],
    );
  }

  async listLedgerTransactionsByLineItem(lineItemId: string): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE line_item_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(lineItemId) as LedgerTransactionRecord[],
    );
  }

  async updateLedgerSettlement(
    id: string,
    patch: Pick<
      LedgerTransactionRecord,
      'status' | 'rail' | 'baas_provider' | 'baas_transfer_id' | 'settled_at'
    >,
  ): Promise<LedgerTransactionRecord | undefined> {
    this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = @status,
             rail = @rail,
             baas_provider = @baas_provider,
             baas_transfer_id = @baas_transfer_id,
             settled_at = @settled_at
         WHERE id = @id`,
      )
      .run({ id, ...patch });
    return this.getLedgerTransaction(id);
  }

  async insertBaasTransfer(row: Omit<BaasTransferRecord, 'id'>): Promise<BaasTransferRecord> {
    const record: BaasTransferRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO baas_transfers (
           id, provider, rail, payee_id, payee_name, amount_cents, currency,
           status, ledger_transaction_id, created_at, estimated_settlement
         ) VALUES (
           @id, @provider, @rail, @payee_id, @payee_name, @amount_cents, @currency,
           @status, @ledger_transaction_id, @created_at, @estimated_settlement
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getBaasTransfer(id: string): Promise<BaasTransferRecord | undefined> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM baas_transfers WHERE id = ?`).get(id) as
        | BaasTransferRecord
        | undefined,
    );
  }

  async listBaasTransfers(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<BaasTransferRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM baas_transfers
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as BaasTransferRecord[],
    );
  }

  async updateBaasTransferStatus(
    id: string,
    status: BaasTransferRecord['status'],
  ): Promise<BaasTransferRecord | undefined> {
    this.db.prepare(`UPDATE baas_transfers SET status = ? WHERE id = ?`).run(status, id);
    return this.getBaasTransfer(id);
  }

  async insertCompanyDust(row: Omit<CompanyDustRecord, 'id'>): Promise<CompanyDustRecord> {
    const record: CompanyDustRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO company_dust_ledger (
           id, split_run_id, line_item_id, amount_cents, variance_account_id, created_at
         ) VALUES (
           @id, @split_run_id, @line_item_id, @amount_cents, @variance_account_id, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listCompanyDustByRun(splitRunId: string): Promise<CompanyDustRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM company_dust_ledger
         WHERE split_run_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(splitRunId) as CompanyDustRecord[],
    );
  }

  async getCreatorTaxProfile(creatorId: string): Promise<CreatorTaxProfile | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM creator_tax_profiles WHERE creator_id = ?`)
        .get(creatorId) as CreatorTaxProfile | undefined,
    );
  }

  async upsertCreatorTaxProfile(row: CreatorTaxProfile): Promise<CreatorTaxProfile> {
    this.db
      .prepare(
        `INSERT INTO creator_tax_profiles (
           creator_id, tin_verified, w9_on_file, updated_at
         ) VALUES (
           @creator_id, @tin_verified, @w9_on_file, @updated_at
         )
         ON CONFLICT(creator_id) DO UPDATE SET
           tin_verified = excluded.tin_verified,
           w9_on_file = excluded.w9_on_file,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async getCreatorYtd(creatorId: string, taxYear: number): Promise<CreatorYtdEarnings | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM creator_ytd_earnings WHERE creator_id = ? AND tax_year = ?`)
        .get(creatorId, taxYear) as CreatorYtdEarnings | undefined,
    );
  }

  async upsertCreatorYtd(row: CreatorYtdEarnings): Promise<CreatorYtdEarnings> {
    this.db
      .prepare(
        `INSERT INTO creator_ytd_earnings (
           creator_id, tax_year, gross_cents, withheld_cents, updated_at
         ) VALUES (
           @creator_id, @tax_year, @gross_cents, @withheld_cents, @updated_at
         )
         ON CONFLICT(creator_id, tax_year) DO UPDATE SET
           gross_cents = excluded.gross_cents,
           withheld_cents = excluded.withheld_cents,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async insertTaxEscrow(row: Omit<TaxEscrowRecord, 'id'>): Promise<TaxEscrowRecord> {
    const record: TaxEscrowRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO tax_escrow_ledger (
           id, creator_id, tax_year, gross_cents, withheld_cents, net_cents,
           tin_verified, w9_on_file, requires_1099, crossed_1099_threshold, created_at
         ) VALUES (
           @id, @creator_id, @tax_year, @gross_cents, @withheld_cents, @net_cents,
           @tin_verified, @w9_on_file, @requires_1099, @crossed_1099_threshold, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listTaxEscrowByCreator(creatorId: string, taxYear: number): Promise<TaxEscrowRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM tax_escrow_ledger
         WHERE creator_id = ? AND tax_year = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(creatorId, taxYear) as TaxEscrowRecord[],
    );
  }

  async getVault(payeeId: string): Promise<SovereignVaultRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM sovereign_vaults WHERE payee_id = ?`)
        .get(payeeId) as SovereignVaultRecord | undefined,
    );
  }

  async listVaults(): Promise<SovereignVaultRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM sovereign_vaults ORDER BY payee_id ASC`)
        .all() as SovereignVaultRecord[],
    );
  }

  async upsertVault(row: SovereignVaultRecord): Promise<SovereignVaultRecord> {
    this.db
      .prepare(
        `INSERT INTO sovereign_vaults (
           payee_id, payee_name, available_balance, pending_balance,
           reserve_balance, updated_at
         ) VALUES (
           @payee_id, @payee_name, @available_balance, @pending_balance,
           @reserve_balance, @updated_at
         )
         ON CONFLICT(payee_id) DO UPDATE SET
           payee_name = excluded.payee_name,
           available_balance = excluded.available_balance,
           pending_balance = excluded.pending_balance,
           reserve_balance = excluded.reserve_balance,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async insertProcessorToken(
    row: Omit<PlaidProcessorTokenRecord, 'id'>,
  ): Promise<PlaidProcessorTokenRecord> {
    const record: PlaidProcessorTokenRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO plaid_processor_tokens (
           id, creator_id, public_token, processor, processor_token,
           account_id, created_at
         ) VALUES (
           @id, @creator_id, @public_token, @processor, @processor_token,
           @account_id, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getProcessorToken(
    publicToken: string,
    processor: PlaidProcessorTokenRecord['processor'],
  ): Promise<PlaidProcessorTokenRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM plaid_processor_tokens WHERE public_token = ? AND processor = ?`)
        .get(publicToken, processor) as PlaidProcessorTokenRecord | undefined,
    );
  }

  async getRecoupmentAdvance(creatorId: string): Promise<RecoupmentAdvanceRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM recoupment_advances WHERE creator_id = ?`)
        .get(creatorId) as RecoupmentAdvanceRecord | undefined,
    );
  }

  async upsertRecoupmentAdvance(row: RecoupmentAdvanceRecord): Promise<RecoupmentAdvanceRecord> {
    this.db
      .prepare(
        `INSERT INTO recoupment_advances (
           creator_id, creator_name, recoupment_target_cents,
           recoupment_current_cents, recoupment_bps, updated_at
         ) VALUES (
           @creator_id, @creator_name, @recoupment_target_cents,
           @recoupment_current_cents, @recoupment_bps, @updated_at
         )
         ON CONFLICT(creator_id) DO UPDATE SET
           creator_name = excluded.creator_name,
           recoupment_target_cents = excluded.recoupment_target_cents,
           recoupment_current_cents = excluded.recoupment_current_cents,
           recoupment_bps = excluded.recoupment_bps,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async listRecoupmentAdvances(): Promise<RecoupmentAdvanceRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM recoupment_advances ORDER BY creator_id ASC`)
        .all() as RecoupmentAdvanceRecord[],
    );
  }

  async getVaultDispute(payeeId: string): Promise<VaultDisputeRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM vault_disputes WHERE payee_id = ?`)
        .get(payeeId) as VaultDisputeRecord | undefined,
    );
  }

  async upsertVaultDispute(row: VaultDisputeRecord): Promise<VaultDisputeRecord> {
    this.db
      .prepare(
        `INSERT INTO vault_disputes (
           payee_id, locked, line_item_id, frozen_from_available,
           frozen_from_pending, updated_at
         ) VALUES (
           @payee_id, @locked, @line_item_id, @frozen_from_available,
           @frozen_from_pending, @updated_at
         )
         ON CONFLICT(payee_id) DO UPDATE SET
           locked = excluded.locked,
           line_item_id = excluded.line_item_id,
           frozen_from_available = excluded.frozen_from_available,
           frozen_from_pending = excluded.frozen_from_pending,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async getPayoutHold(transferId: string): Promise<PayoutHoldRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM payout_holds WHERE transfer_id = ?`)
        .get(transferId) as PayoutHoldRecord | undefined,
    );
  }

  async insertPayoutHold(row: PayoutHoldRecord): Promise<PayoutHoldRecord> {
    this.db
      .prepare(
        `INSERT INTO payout_holds (
           transfer_id, payee_id, amount_cents, status, created_at
         ) VALUES (
           @transfer_id, @payee_id, @amount_cents, @status, @created_at
         )`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async updatePayoutHoldStatus(
    transferId: string,
    status: PayoutHoldRecord['status'],
  ): Promise<PayoutHoldRecord | undefined> {
    this.db.prepare(`UPDATE payout_holds SET status = ? WHERE transfer_id = ?`).run(status, transferId);
    return this.getPayoutHold(transferId);
  }

  async sumInFlightPayoutHolds(payeeId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payout_holds
         WHERE payee_id = ? AND status = 'in_flight'`,
      )
      .get(payeeId) as { total: number };
    return Promise.resolve(row.total);
  }

  async getWebhookEvent(eventId: string): Promise<BaasWebhookEventRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM baas_webhook_events WHERE event_id = ?`)
        .get(eventId) as BaasWebhookEventRecord | undefined,
    );
  }

  async insertWebhookEvent(row: Omit<BaasWebhookEventRecord, 'id'>): Promise<BaasWebhookEventRecord> {
    const record: BaasWebhookEventRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO baas_webhook_events (
           id, event_id, event, transfer_id, payload_json, reversal_id, created_at
         ) VALUES (
           @id, @event_id, @event, @transfer_id, @payload_json, @reversal_id, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async insertPayoutReversal(row: Omit<PayoutReversalRecord, 'id'>): Promise<PayoutReversalRecord> {
    const record: PayoutReversalRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO payout_reversals (
           id, transfer_id, payee_id, amount_cents, reason,
           ledger_transaction_id, journal_id, created_at
         ) VALUES (
           @id, @transfer_id, @payee_id, @amount_cents, @reason,
           @ledger_transaction_id, @journal_id, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getPayoutReversalByTransfer(transferId: string): Promise<PayoutReversalRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM payout_reversals WHERE transfer_id = ?`)
        .get(transferId) as PayoutReversalRecord | undefined,
    );
  }

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
    this.db
      .prepare(
        `INSERT INTO gl_journals (
           id, kind, ref_type, ref_id, created_at, sequence, prev_hash, entry_hash, state
         ) VALUES (
           @id, @kind, @ref_type, @ref_id, @created_at, @sequence, @prev_hash, @entry_hash, @state
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async insertGlEntry(row: Omit<GlEntryRecord, 'id'>): Promise<GlEntryRecord> {
    const record: GlEntryRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO gl_entries (
           id, journal_id, account, debit_cents, credit_cents, created_at
         ) VALUES (
           @id, @journal_id, @account, @debit_cents, @credit_cents, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listGlJournals(): Promise<GlJournalRecord[]> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM gl_journals ORDER BY sequence ASC, rowid ASC`).all() as GlJournalRecord[],
    );
  }

  async getLatestGlJournal(): Promise<GlJournalRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM gl_journals ORDER BY sequence DESC, rowid DESC LIMIT 1`)
        .get() as GlJournalRecord | undefined,
    );
  }

  async listGlJournalsByRef(refType: string, refId: string): Promise<GlJournalRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM gl_journals
         WHERE ref_type = ? AND ref_id = ?
         ORDER BY sequence ASC, rowid ASC`,
        )
        .all(refType, refId) as GlJournalRecord[],
    );
  }

  async listGlEntries(): Promise<GlEntryRecord[]> {
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM gl_entries ORDER BY created_at ASC, rowid ASC`).all() as GlEntryRecord[],
    );
  }

  async listGlEntriesByJournal(journalId: string): Promise<GlEntryRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM gl_entries WHERE journal_id = ? ORDER BY rowid ASC`)
        .all(journalId) as GlEntryRecord[],
    );
  }

  async insertRecoupmentLedger(row: Omit<RecoupmentLedgerRecord, 'id'>): Promise<RecoupmentLedgerRecord> {
    const record: RecoupmentLedgerRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO recoupment_ledger (
           id, creator_id, split_run_id, incoming_cents, recouped_cents,
           excess_cents, recoupment_current_cents, created_at
         ) VALUES (
           @id, @creator_id, @split_run_id, @incoming_cents, @recouped_cents,
           @excess_cents, @recoupment_current_cents, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listRecoupmentLedgerByRun(splitRunId: string): Promise<RecoupmentLedgerRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM recoupment_ledger
         WHERE split_run_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(splitRunId) as RecoupmentLedgerRecord[],
    );
  }

  async getCatalogDispute(workId: string): Promise<CatalogDisputeRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM catalog_disputes WHERE work_id = ?`)
        .get(workId) as CatalogDisputeRecord | undefined,
    );
  }

  async upsertCatalogDispute(row: CatalogDisputeRecord): Promise<CatalogDisputeRecord> {
    this.db
      .prepare(
        `INSERT INTO catalog_disputes (work_id, locked, updated_at)
         VALUES (@work_id, @locked, @updated_at)
         ON CONFLICT(work_id) DO UPDATE SET
           locked = excluded.locked,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async getDspWebhookEvent(eventId: string): Promise<DspWebhookEventRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM dsp_webhook_events WHERE event_id = ?`)
        .get(eventId) as DspWebhookEventRecord | undefined,
    );
  }

  async insertDspWebhookEvent(
    row: Omit<DspWebhookEventRecord, 'id'>,
  ): Promise<DspWebhookEventRecord> {
    const record: DspWebhookEventRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO dsp_webhook_events (
           id, event_id, event, source, split_run_id, payload_json, created_at
         ) VALUES (
           @id, @event_id, @event, @source, @split_run_id, @payload_json, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async insertSplitReversal(row: Omit<SplitReversalRecord, 'id'>): Promise<SplitReversalRecord> {
    const record: SplitReversalRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO split_reversals (
           id, split_run_id, journal_id, created_at
         ) VALUES (
           @id, @split_run_id, @journal_id, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getSplitReversalByRun(splitRunId: string): Promise<SplitReversalRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM split_reversals WHERE split_run_id = ?`)
        .get(splitRunId) as SplitReversalRecord | undefined,
    );
  }
}

/** Default DB location: data/atxlive.db under the project root (gitignored). */
export function defaultDbPath(): string {
  return process.env.ATXLIVE_DB_PATH ?? path.join(process.cwd(), 'data', 'atxlive.db');
}
