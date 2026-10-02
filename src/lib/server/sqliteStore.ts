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
  BookEditorialSplitScheduleRecord,
  BookRecoupmentPoolRecord,
  BookRecoupmentPoolClass,
  BookRecoupmentApplicationRecord,
  BookEditorialSplitAccrualRecord,
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
  MerchReturnReservePolicyRecord,
  MerchReserveDrawdownRecord,
  MerchFulfillmentTrackingRecord,
  AiModelSplitTermsRecord,
  AiModelContributionRecord,
  AiTrainingDisputeRecord,
  AiTrainingDisputeStatus,
  AiPayoutGateStateRecord,
  AiDatasetDeprecationRecord,
  AiDatasetAllocationArchiveRecord,
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
  journal_id TEXT,
  created_at TEXT NOT NULL
);

-- 0009 (H4): one reversal per BaaS transfer — the engine inserts this row
-- as its replay lock before money moves.
CREATE UNIQUE INDEX IF NOT EXISTS payout_reversals_transfer_id_unique
  ON payout_reversals (transfer_id);

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

-- 0009 (H2): one journal per chain sequence — a concurrent post that lost
-- the race surfaces the same failure the database raises.
CREATE UNIQUE INDEX IF NOT EXISTS gl_journals_sequence_unique
  ON gl_journals (sequence);

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

-- --- SDK collection surfaces (migration 0007) ---

CREATE TABLE IF NOT EXISTS mul_clearances (
  asset_cbt_code TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'draft',
  licensee TEXT,
  territory TEXT,
  term_start TEXT,
  term_end TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mul_clearance_transitions (
  id TEXT PRIMARY KEY,
  asset_cbt_code TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mul_clearance_transitions_asset_idx
  ON mul_clearance_transitions (asset_cbt_code, created_at);

CREATE TABLE IF NOT EXISTS match_queue (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL,
  rights_pipeline TEXT NOT NULL,
  rights_type TEXT NOT NULL DEFAULT 'unknown',
  tier_level INTEGER,
  statement_source_type TEXT,
  revenue_channel TEXT,
  ad_slot TEXT,
  verified_impressions INTEGER,
  network_sold BOOLEAN,
  sale_type TEXT,
  virtual_currency_code TEXT,
  virtual_amount TEXT,
  exchange_rate TEXT,
  engine_royalty_micros TEXT,
  platform_commission_micros TEXT,
  parent_asset_id TEXT,
  stream_platform TEXT,
  alert_type TEXT,
  revenue_basis TEXT,
  prize_pool_batch TEXT,
  parent_composition_id TEXT,
  is_cover_version BOOLEAN,
  territory_code TEXT,
  foreign_tax_withheld BOOLEAN,
  rss_feed_id TEXT,
  ad_placement_type TEXT,
  format_type TEXT,
  language_code TEXT,
  sku_id TEXT,
  cogs_per_unit_micros TEXT,
  usage_unit TEXT,
  usage_quantity TEXT,
  isbn TEXT,
  country_code TEXT,
  ai_model_id TEXT,
  dataset_attribution_weight TEXT,
  artwork_id TEXT,
  provenance_hash TEXT,
  jurisdiction_code TEXT,
  production_id TEXT,
  venue_id TEXT,
  show_date TEXT,
  license_class TEXT,
  license_id TEXT,
  category_code TEXT,
  territory_iso TEXT,
  athlete_id TEXT,
  school_id TEXT,
  state_jurisdiction_code TEXT,
  zone_code TEXT,
  spatial_footprint_sqft TEXT,
  trainer_id TEXT,
  program_id TEXT,
  studio_franchise_code TEXT,
  chef_id TEXT,
  recipe_id TEXT,
  ghost_kitchen_location_id TEXT,
  stylist_id TEXT,
  salon_location_id TEXT,
  protocol_id TEXT,
  developer_id TEXT,
  api_endpoint_id TEXT,
  sdk_package_hash TEXT,
  patent_family_id TEXT,
  sep_pool_code TEXT,
  device_imei_mac TEXT,
  parcel_id TEXT,
  well_meter_id TEXT,
  gpu_cluster_hash TEXT,
  nil_contract_id TEXT,
  athlete_glan TEXT,
  venue_gln TEXT,
  league_rights_code TEXT,
  turnstile_scan_hash TEXT,
  resolved_chain TEXT,
  resolved_identifiers TEXT,
  unclaimed_identifier_hold BOOLEAN NOT NULL DEFAULT 0,
  identifier_hold_reason TEXT,
  source TEXT NOT NULL,
  platform TEXT,
  territory TEXT,
  period TEXT,
  currency TEXT,
  gross_micros TEXT,
  identifiers_json TEXT,
  raw_payload TEXT NOT NULL,
  matched_cbt_code TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS match_queue_status_idx ON match_queue (status, created_at);

CREATE TABLE IF NOT EXISTS statement_ingests (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  source TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  event_count INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Royalty recon orchestration queue (migration 0011, spec art_7M0snhxc).
-- Orchestration only — parsed line items live in match_queue. Local mirror
-- of the Postgres table: uuid/timestamptz walls are TEXT (ISO strings, the
-- store-seam convention); the check constraint rides the guarded store
-- methods, and rowid is the insertion_order tiebreak.
CREATE TABLE IF NOT EXISTS royalty_recon_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL,
  ingest_id TEXT,
  requested_by TEXT,
  engine TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result TEXT,
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS royalty_recon_jobs_status_idx
  ON royalty_recon_jobs (status, created_at);

-- --- The UCT credential vault (migration 0013) — local mirror ---
--
-- uuid/timestamptz walls are TEXT (ISO strings, the store-seam convention);
-- the one-active-per-(holder, distributor) rule and the distributor/status
-- vocabularies ride the guarded store methods (the in-memory backend and
-- the Postgres partial unique index enforce the same contract).
CREATE TABLE IF NOT EXISTS distributor_connections (
  id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  distributor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  username_encrypted TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  last_verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS distributor_connections_holder_idx
  ON distributor_connections (holder_id, status);

-- --- Clearinghouse kernel + Sync Library seams (migration 0008 — the
--     SyncMarketplaceRegistry amendment) ---

CREATE TABLE IF NOT EXISTS creator_ucts (
  creator_id TEXT PRIMARY KEY,
  uct_number TEXT NOT NULL,
  isni TEXT
);

CREATE TABLE IF NOT EXISTS sync_catalog_items (
  cbt_code TEXT PRIMARY KEY,
  is_pre_cleared INTEGER NOT NULL DEFAULT 0,
  sync_fee_cents INTEGER NOT NULL DEFAULT 0,
  genre TEXT NOT NULL DEFAULT '',
  bpm INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_license_purchases (
  id TEXT PRIMARY KEY,
  cvt_asset_tag TEXT NOT NULL,
  buyer_uct TEXT NOT NULL,
  license_type TEXT NOT NULL,
  fee_paid_cents INTEGER NOT NULL,
  cbt_settlement_stamp TEXT NOT NULL UNIQUE,
  split_run_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- The tier-universe royalty ledger (universal_royalty_ledger) — read-side
-- seam for the SDK-settled territory data (spec art_qNu4T32F). The wire
-- (covnant-sdk/src/engine/wire.ts settleEvent) writes these credits in
-- production over PostgreSQL; this mirror carries the write shape for
-- reads and fixtures. amount_cents stays TEXT — the wire's text-cents
-- discipline, bigint-safe beyond Number's integer range.
CREATE TABLE IF NOT EXISTS universal_royalty_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  rights_holder_id TEXT,
  amount_cents TEXT NOT NULL,
  transaction_type TEXT,
  reference_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

-- The film waterfall engine (migration 0016, PR 8) — the registered deal
-- (one definition jsonb per film asset) and the routing-decision record
-- (the per-leg detail that makes shortfall carry honest). jsonb columns
-- pack as TEXT JSON — the store-seam discipline the recon queue's result
-- column uses.
CREATE TABLE IF NOT EXISTS film_waterfall_definitions (
  film_id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS film_waterfall_distributions (
  id TEXT PRIMARY KEY,
  film_id TEXT NOT NULL,
  escrow_ledger_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  fdg_bypass_cents INTEGER NOT NULL,
  legs TEXT NOT NULL,
  tier_allocations TEXT NOT NULL,
  unpaid_total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Podcast episode splits + guest milestone bonuses (PR 11) — the episode-
-- scoped routing ledger. Splits jsonb packs as TEXT JSON (the waterfall
-- discipline). Accruals are unique per source event and bonuses per
-- content-derived event id — the once-only replay guards.
CREATE TABLE IF NOT EXISTS podcast_episode_split_schedules (
  episode_id TEXT PRIMARY KEY,
  show_cbt_code TEXT,
  splits TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS podcast_episode_split_accruals (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  source_amount_cents INTEGER NOT NULL,
  split_version INTEGER NOT NULL,
  accruals TEXT NOT NULL,
  company_dust_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS podcast_guest_bonus_definitions (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  guest_payee_id TEXT NOT NULL,
  guest_payee_name TEXT NOT NULL,
  milestone_kind TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  bonus_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (episode_id, guest_payee_id, milestone_kind, threshold)
);

CREATE TABLE IF NOT EXISTS podcast_guest_bonus_accruals (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  episode_id TEXT NOT NULL,
  bonus_definition_id TEXT NOT NULL,
  guest_payee_id TEXT NOT NULL,
  milestone_kind TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  verified_count INTEGER NOT NULL,
  bonus_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  holding_ledger_id TEXT,
  created_at TEXT NOT NULL
);

-- Gaming engine-royalty accumulator + item splits (PR 12) — the append-only
-- contribution log IS the accumulator (its state is the derived SUM, so
-- replayed gross can never cross the $1M threshold twice), schedules are one
-- row per item, and payout routings are unique per funding event — the
-- once-only replay guards. Splits/accruals jsonb pack as TEXT JSON (the
-- waterfall discipline).
CREATE TABLE IF NOT EXISTS gaming_engine_royalty_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  product_id TEXT NOT NULL,
  annual_year INTEGER NOT NULL,
  gross_micros TEXT NOT NULL,
  engine_royalty_micros TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gaming_item_split_schedules (
  item_id TEXT PRIMARY KEY,
  asset_cbt_code TEXT,
  splits TEXT NOT NULL,
  resale_royalty_payee_id TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gaming_split_payouts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  source_amount_cents INTEGER NOT NULL,
  resale_royalty_payee_id TEXT,
  resale_royalty_cents INTEGER NOT NULL,
  split_version INTEGER NOT NULL,
  accruals TEXT NOT NULL,
  company_dust_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Gaming cashout states (PR 13) — the durable DevEx conversion logs hold
-- until the platform's fiat settlement completes (the release path reads a
-- batch's logs and refuses while any is pending), and one KYC verification
-- state per studio payee backs the gaming payout gate's studio/team read.
-- team_members jsonb packs as TEXT JSON (the waterfall discipline).
CREATE TABLE IF NOT EXISTS gaming_devex_conversion_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  line_event_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  denomination TEXT NOT NULL,
  virtual_amount TEXT NOT NULL,
  exchange_rate TEXT NOT NULL,
  fiat_net_cents INTEGER NOT NULL,
  settlement_batch_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  settled_at TEXT,
  created_at TEXT NOT NULL
);

-- AI model registry (0028, PR 24): one model's nested derivative split
-- contract terms (UNIQUE per model — the newest contract governs) and the
-- contributors' registered dataset token weights (UNIQUE per model+payee —
-- a re-shipped attribution log converges).
CREATE TABLE IF NOT EXISTS ai_model_split_terms (
  id TEXT PRIMARY KEY,
  ai_model_id TEXT NOT NULL UNIQUE,
  base_model_provider_fee_bps INTEGER NOT NULL,
  developer_split_bps INTEGER NOT NULL,
  contributor_pool_bps INTEGER NOT NULL,
  base_model_provider_payee_id TEXT NOT NULL,
  base_model_provider_payee_name TEXT NOT NULL,
  developer_payee_id TEXT NOT NULL,
  developer_payee_name TEXT NOT NULL,
  model_operator_payee_id TEXT NOT NULL,
  model_operator_payee_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_model_contributions (
  id TEXT PRIMARY KEY,
  ai_model_id TEXT NOT NULL,
  contributor_payee_id TEXT NOT NULL,
  contributor_payee_name TEXT NOT NULL,
  contributor_class TEXT NOT NULL,
  dataset_token_weight TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ai_model_id, contributor_payee_id)
);

-- AI training dispute freeze + payout gate states + dataset deprecations
-- (0029, PR 25): the dispute of record (UNIQUE per model+version+payee —
-- a re-filed claim converges), the AI payout-gate states the release
-- gate reads fail-closed (UNIQUE per payee), the dataset deprecations of
-- record (UNIQUE per model+version), and the allocation archives that
-- retire historical attributions WITHOUT touching the append-only
-- ledger rows (UNIQUE per deprecation+ledger row — a re-run converges).
CREATE TABLE IF NOT EXISTS ai_training_disputes (
  id TEXT PRIMARY KEY,
  ai_model_id TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  rights_holder_payee_id TEXT NOT NULL,
  rights_holder_payee_name TEXT NOT NULL,
  dispute_basis TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution_notes TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ai_model_id, dataset_version, rights_holder_payee_id)
);

CREATE TABLE IF NOT EXISTS ai_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL UNIQUE,
  ai_model_id TEXT,
  ai_training_consent_state TEXT NOT NULL,
  synthetic_voice_likeness_state TEXT NOT NULL,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_dataset_deprecations (
  id TEXT PRIMARY KEY,
  ai_model_id TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  rights_holder_payee_id TEXT,
  rights_holder_payee_name TEXT,
  deprecated_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ai_model_id, dataset_version)
);

CREATE TABLE IF NOT EXISTS ai_dataset_allocation_archives (
  id TEXT PRIMARY KEY,
  deprecation_id TEXT NOT NULL,
  ledger_transaction_id TEXT NOT NULL,
  contributor_payee_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  UNIQUE (deprecation_id, ledger_transaction_id)
);

CREATE TABLE IF NOT EXISTS gaming_studio_kyc_verifications (
  id TEXT PRIMARY KEY,
  studio_payee_id TEXT NOT NULL UNIQUE,
  studio_kyc_status TEXT NOT NULL,
  team_members TEXT NOT NULL,
  contract_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- VTuber agency licensing holdback states (PR 15) — the durable state
-- behind the livestream gate's tax_withholding_verified read (one row per
-- payee + tax year) and the tech setup amortization contracts. The schedule
-- row is the immutable contract; consumption lives in the APPEND-ONLY lines
-- (the PR 12 accumulator's insert-as-lock discipline), unique per
-- (schedule_ref, line_index) — a concurrent consume throws, never a lost
-- update.
CREATE TABLE IF NOT EXISTS vtuber_tax_withholding_verifications (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  tax_year INTEGER NOT NULL,
  state TEXT NOT NULL,
  tin_verified INTEGER NOT NULL,
  w9_on_file INTEGER NOT NULL,
  evidence_ref TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, tax_year)
);

CREATE TABLE IF NOT EXISTS vtuber_tech_setup_amortization_schedules (
  id TEXT PRIMARY KEY,
  schedule_ref TEXT NOT NULL UNIQUE,
  agency_payee_id TEXT NOT NULL,
  description TEXT NOT NULL,
  total_cost_cents INTEGER NOT NULL,
  amortization_periods INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vtuber_tech_setup_amortization_lines (
  id TEXT PRIMARY KEY,
  schedule_ref TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  line_cents INTEGER NOT NULL,
  deducted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (schedule_ref, line_index)
);

-- Derivative asset royalty cascade (PR 16) — the per-edge fractional
-- royalty contracts over the parent_asset_id dependency tree. The
-- allocator's depth-first walk reads this table per node; insertion order
-- (rowid) is the deterministic reservation order. A self-edge is refused
-- here; longer cycles refuse at plan time (fail-closed).
CREATE TABLE IF NOT EXISTS derivative_royalty_edges (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  parent_asset_id TEXT NOT NULL,
  upstream_creator_payee_id TEXT NOT NULL,
  upstream_creator_payee_name TEXT NOT NULL,
  royalty_bps INTEGER NOT NULL CHECK (royalty_bps > 0 AND royalty_bps <= 10000),
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, parent_asset_id, upstream_creator_payee_id),
  CHECK (asset_id <> parent_asset_id)
);
CREATE INDEX IF NOT EXISTS idx_derivative_royalty_edges_asset
  ON derivative_royalty_edges (asset_id);
CREATE INDEX IF NOT EXISTS idx_derivative_royalty_edges_parent
  ON derivative_royalty_edges (parent_asset_id);

-- Music sample cascade + statutory cover mechanicals (migration 0022): the
-- contract layer the sample-cascade and cover-mechanical planners read. The
-- walk key is match_queue.parent_composition_id — work_id /
-- parent_composition_id / composition_id are cbt_assets identities. The
-- rights-type separation: master and publishing are separate sides of the
-- queue; an edge belongs to one side and a line's cascade fires only its
-- own side's edges. Self-edges refuse here; longer cycles refuse at plan
-- time (fail-closed).
CREATE TABLE IF NOT EXISTS sample_clearance_edges (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  parent_composition_id TEXT NOT NULL,
  rights_type TEXT NOT NULL CHECK (rights_type IN ('master', 'publishing')),
  rights_holder_payee_id TEXT NOT NULL,
  rights_holder_payee_name TEXT NOT NULL,
  license_bps INTEGER NOT NULL CHECK (license_bps > 0 AND license_bps <= 10000),
  clearance_agreement_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, parent_composition_id, rights_holder_payee_id, rights_type),
  CHECK (work_id <> parent_composition_id)
);
CREATE INDEX IF NOT EXISTS idx_sample_clearance_edges_work
  ON sample_clearance_edges (work_id);
CREATE INDEX IF NOT EXISTS idx_sample_clearance_edges_parent
  ON sample_clearance_edges (parent_composition_id);

CREATE TABLE IF NOT EXISTS composition_publishers (
  id TEXT PRIMARY KEY,
  composition_id TEXT NOT NULL,
  publisher_payee_id TEXT NOT NULL,
  publisher_payee_name TEXT NOT NULL,
  share_bps INTEGER NOT NULL CHECK (share_bps > 0 AND share_bps <= 10000),
  created_at TEXT NOT NULL,
  UNIQUE (composition_id, publisher_payee_id)
);
CREATE INDEX IF NOT EXISTS idx_composition_publishers_composition
  ON composition_publishers (composition_id);

-- Webtoon studio splits + translation cascades (migration 0024, PR 20). The
-- studio split registry is the per-series production contract (one row per
-- series/role-group/payee, group bands enforced at plan time — they are
-- cross-row group totals); the localization contract keys each foreign
-- language feed; the cost amortization schedule/lines are the VTuber
-- tech-setup discipline (immutable schedule, append-only consumed lines,
-- unique per (schedule_ref, line_index)); the recoupment pools + applications
-- carry the print-advance/digital-coin isolation (pool UNIQUE per
-- (series, class), applications UNIQUE per (pool, source event) — the
-- replay guard).
CREATE TABLE IF NOT EXISTS webtoon_studio_split_roles (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  role_group TEXT NOT NULL CHECK (role_group IN ('original_creator_storywriter', 'line_artist_inker', 'colorist_background')),
  payee_id TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  share_bps INTEGER NOT NULL CHECK (share_bps > 0 AND share_bps <= 10000),
  contract_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (series_id, role_group, payee_id)
);
CREATE INDEX IF NOT EXISTS idx_webtoon_studio_split_roles_series
  ON webtoon_studio_split_roles (series_id);

CREATE TABLE IF NOT EXISTS webtoon_localization_contracts (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  language_code TEXT NOT NULL,
  localizer_payee_id TEXT NOT NULL,
  localizer_payee_name TEXT NOT NULL,
  fee_mode TEXT NOT NULL CHECK (fee_mode IN ('flat_fee', 'rev_share')),
  per_chapter_flat_fee_cents INTEGER NOT NULL CHECK (per_chapter_flat_fee_cents >= 0),
  rev_share_bps INTEGER NOT NULL CHECK (rev_share_bps >= 0 AND rev_share_bps <= 10000),
  contract_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (series_id, language_code)
);

CREATE TABLE IF NOT EXISTS webtoon_localization_cost_schedules (
  id TEXT PRIMARY KEY,
  schedule_ref TEXT NOT NULL UNIQUE,
  series_id TEXT NOT NULL,
  language_code TEXT NOT NULL,
  total_cost_cents INTEGER NOT NULL CHECK (total_cost_cents > 0),
  amortization_periods INTEGER NOT NULL CHECK (amortization_periods > 0),
  cost_agreement_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webtoon_localization_cost_lines (
  id TEXT PRIMARY KEY,
  schedule_ref TEXT NOT NULL,
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  released_in_ledger_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (schedule_ref, line_index)
);
CREATE INDEX IF NOT EXISTS idx_webtoon_localization_cost_lines_ref
  ON webtoon_localization_cost_lines (schedule_ref);

CREATE TABLE IF NOT EXISTS webtoon_recoupment_pools (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('print_advance', 'digital_coin_unlock')),
  advance_cents INTEGER NOT NULL CHECK (advance_cents > 0),
  recouped_cents INTEGER NOT NULL CHECK (recouped_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'recouped')),
  advance_agreement_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (series_id, pool_class)
);

CREATE TABLE IF NOT EXISTS webtoon_recoupment_applications (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('print_advance', 'digital_coin_unlock')),
  source_event_id TEXT NOT NULL,
  recouped_before_cents INTEGER NOT NULL,
  applied_cents INTEGER NOT NULL CHECK (applied_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (pool_id, source_event_id),
  UNIQUE (pool_id, recouped_before_cents)
);
CREATE INDEX IF NOT EXISTS idx_webtoon_recoupment_applications_pool
  ON webtoon_recoupment_applications (pool_id);

-- Book editorial split ledger (migration 0030, PR 26). The schedule of
-- record per title_key (JSON contributor roster), the sequential advance
-- pools (UNIQUE per (isbn, class, sequence_no)), their append-only
-- application truth (the replay + position uniques), and the executed
-- split accruals (UNIQUE per source_event_id).
CREATE TABLE IF NOT EXISTS book_editorial_split_schedules (
  id TEXT PRIMARY KEY,
  title_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('book', 'magazine_issue')),
  mode TEXT NOT NULL CHECK (mode IN ('flat_per_issue', 'percentage', 'pro_rata')),
  pro_rata_basis TEXT,
  contributors TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_recoupment_pools (
  id TEXT PRIMARY KEY,
  isbn TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('ebook_advance', 'print_advance', 'audiobook_production_unrecouped')),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  advance_cents INTEGER NOT NULL CHECK (advance_cents > 0),
  recouped_cents INTEGER NOT NULL CHECK (recouped_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'recouped')),
  advance_agreement_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (isbn, pool_class, sequence_no)
);

CREATE TABLE IF NOT EXISTS book_recoupment_applications (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('ebook_advance', 'print_advance', 'audiobook_production_unrecouped')),
  isbn TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  recouped_before_cents INTEGER NOT NULL,
  applied_cents INTEGER NOT NULL CHECK (applied_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (pool_id, source_event_id),
  UNIQUE (pool_id, recouped_before_cents)
);
CREATE INDEX IF NOT EXISTS idx_book_recoupment_applications_pool
  ON book_recoupment_applications (pool_id);

CREATE TABLE IF NOT EXISTS book_editorial_split_accruals (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  title_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('book', 'magazine_issue')),
  source_event_id TEXT NOT NULL UNIQUE,
  basis_cents INTEGER NOT NULL CHECK (basis_cents >= 0),
  allocations TEXT NOT NULL,
  dust_cents INTEGER NOT NULL CHECK (dust_cents >= 0),
  created_at TEXT NOT NULL
);

-- IP adaptation optioning (migration 0025, PR 21). The option agreement of
-- record per work (upsert on work_id), the ordered author-side IP
-- allocations (the author-first reservation order — rowid ASC is this
-- backend's insertion_order), and the durable ip_rights_cleared
-- verification state the publishing payout gate reads (one row per
-- (payee, work), upsert on the pair).
CREATE TABLE IF NOT EXISTS ip_option_agreements (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL UNIQUE,
  author_payee_id TEXT NOT NULL,
  author_payee_name TEXT NOT NULL,
  agency_payee_id TEXT NOT NULL,
  agency_payee_name TEXT NOT NULL,
  agency_commission_bps INTEGER NOT NULL CHECK (agency_commission_bps >= 0 AND agency_commission_bps <= 10000),
  option_deal_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_option_author_allocations (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  allocation_bps INTEGER NOT NULL CHECK (allocation_bps > 0 AND allocation_bps <= 10000),
  created_at TEXT NOT NULL,
  UNIQUE (work_id, payee_id)
);
CREATE INDEX IF NOT EXISTS idx_ip_option_author_allocations_work
  ON ip_option_author_allocations (work_id);

CREATE TABLE IF NOT EXISTS publishing_ip_rights_verifications (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'cleared', 'failed')),
  evidence_ref TEXT,
  cleared_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, work_id)
);
CREATE INDEX IF NOT EXISTS idx_publishing_ip_rights_verifications_work
  ON publishing_ip_rights_verifications (work_id);

-- Merch COGS + the brand collaboration waterfall (migration 0026, PR 22).
-- The production lots of record (UNIQUE per (sku_id, lot_ref)), the
-- append-only FIFO consumption truth (UNIQUE per (lot, source event) —
-- the replay guard — plus UNIQUE per (lot, units_consumed_before) — the
-- insert-as-lock position arbiter), the collab agreement of record per
-- sku (upsert on sku_id), the append-only overhead-recoupment ledger
-- (the 0024 pool discipline at agreement scope), the designer royalty
-- tier of record per sku (upsert on sku_id), the append-only royalty
-- billing ledger (UNIQUE per (source event, sku)), and the durable
-- consignment settlement reconciliation (UNIQUE per event_id).
CREATE TABLE IF NOT EXISTS merch_cogs_lots (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  lot_ref TEXT NOT NULL,
  units_produced INTEGER NOT NULL CHECK (units_produced > 0),
  cogs_per_unit_cents INTEGER NOT NULL CHECK (cogs_per_unit_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (sku_id, lot_ref)
);
CREATE INDEX IF NOT EXISTS idx_merch_cogs_lots_sku
  ON merch_cogs_lots (sku_id, created_at, lot_ref);

CREATE TABLE IF NOT EXISTS merch_cogs_consumptions (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  units_consumed_before INTEGER NOT NULL CHECK (units_consumed_before >= 0),
  units_consumed INTEGER NOT NULL CHECK (units_consumed > 0),
  cogs_per_unit_cents INTEGER NOT NULL CHECK (cogs_per_unit_cents >= 0),
  amortized_cents INTEGER NOT NULL CHECK (amortized_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (lot_id, source_event_id),
  UNIQUE (lot_id, units_consumed_before),
  FOREIGN KEY (lot_id) REFERENCES merch_cogs_lots (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_merch_cogs_consumptions_lot
  ON merch_cogs_consumptions (lot_id);

CREATE TABLE IF NOT EXISTS merch_collab_agreements (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL UNIQUE,
  manufacturer_payee_id TEXT NOT NULL,
  manufacturer_payee_name TEXT NOT NULL,
  brand_payee_id TEXT NOT NULL,
  brand_payee_name TEXT NOT NULL,
  artist_payee_id TEXT NOT NULL,
  artist_payee_name TEXT NOT NULL,
  artist_split_bps INTEGER NOT NULL CHECK (artist_split_bps >= 0 AND artist_split_bps <= 10000),
  blank_sourcing_cents INTEGER NOT NULL CHECK (blank_sourcing_cents >= 0),
  screen_printing_cents INTEGER NOT NULL CHECK (screen_printing_cents >= 0),
  agreement_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merch_collab_recoupment_applications (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('blank_sourcing', 'screen_printing')),
  source_event_id TEXT NOT NULL,
  recouped_before_cents INTEGER NOT NULL CHECK (recouped_before_cents >= 0),
  applied_cents INTEGER NOT NULL CHECK (applied_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (agreement_id, pool_class, source_event_id),
  UNIQUE (agreement_id, pool_class, recouped_before_cents),
  FOREIGN KEY (agreement_id) REFERENCES merch_collab_agreements (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_merch_collab_recoupment_applications_agreement
  ON merch_collab_recoupment_applications (agreement_id, pool_class);

CREATE TABLE IF NOT EXISTS merch_designer_royalty_tiers (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL UNIQUE,
  designer_payee_id TEXT NOT NULL,
  designer_payee_name TEXT NOT NULL,
  royalty_per_unit_cents INTEGER NOT NULL CHECK (royalty_per_unit_cents > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merch_designer_royalty_billings (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  designer_payee_id TEXT NOT NULL,
  designer_payee_name TEXT NOT NULL,
  units_billed INTEGER NOT NULL CHECK (units_billed > 0),
  royalty_per_unit_cents INTEGER NOT NULL CHECK (royalty_per_unit_cents > 0),
  billed_cents INTEGER NOT NULL CHECK (billed_cents > 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id, sku_id),
  FOREIGN KEY (sku_id) REFERENCES merch_designer_royalty_tiers (sku_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_merch_designer_royalty_billings_sku
  ON merch_designer_royalty_billings (sku_id);

CREATE TABLE IF NOT EXISTS merch_consignment_settlements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  period TEXT NOT NULL,
  location TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  units_sold INTEGER NOT NULL CHECK (units_sold > 0),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  shrinkage_allowance_cents INTEGER NOT NULL CHECK (shrinkage_allowance_cents >= 0),
  net_payout_cents INTEGER NOT NULL CHECK (net_payout_cents >= 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merch_consignment_settlements_sku
  ON merch_consignment_settlements (sku_id);

-- Merch returns reserve + fulfillment confirmation (migration 0027, PR 23).
-- The returns-reserve policy of record — one per sku (upsert on sku_id) —
-- carries the founder-banded money terms: the 10-15% holdback rate and the
-- 30-60 day returns window, plus the beneficiary payee the verified
-- release pays. Bands are CHECK-enforced at rest and lane-enforced at
-- write.
CREATE TABLE IF NOT EXISTS merch_return_reserve_policies (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL
    CHECK (reserve_rate_bps >= 1000 AND reserve_rate_bps <= 1500),
  reserve_window_days INTEGER NOT NULL
    CHECK (reserve_window_days >= 30 AND reserve_window_days <= 60),
  beneficiary_payee_id TEXT NOT NULL,
  beneficiary_payee_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The append-only reserve drawdown truth — the 0026 recoupment-application
-- discipline at reserve scope. UNIQUE (reserve_ledger_id, source_event_id)
-- is the replay guard (a re-shipped return/chargeback event is the unique
-- violation, never a double drawdown); UNIQUE (reserve_ledger_id,
-- drawn_before_cents) is the insert-as-lock position arbiter. The reserve
-- ledger reference is uuid -> uuid, type-matched.
CREATE TABLE IF NOT EXISTS merch_reserve_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  drawdown_class TEXT NOT NULL
    CHECK (drawdown_class IN ('customer_return', 'chargeback')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL CHECK (drawn_before_cents >= 0),
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id, source_event_id),
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  FOREIGN KEY (reserve_ledger_id) REFERENCES ledger_transactions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_merch_reserve_drawdowns_reserve
  ON merch_reserve_drawdowns (reserve_ledger_id);

-- The fulfillment tracking events the merch payout gate reads — the
-- physical_fulfillment_confirmed source of truth. UNIQUE
-- (fulfillment_event_id, tracking_number, tracking_state) is the replay
-- guard (a re-shipped tracking event is the unique violation, never a
-- double record). Only 'delivered' confirms; 'assigned' and 'in_transit'
-- are honest not-yet states, and an absent tracking ledger is unknown —
-- all refuse the gate, fail-closed.
CREATE TABLE IF NOT EXISTS merch_fulfillment_trackings (
  id TEXT PRIMARY KEY,
  fulfillment_event_id TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  tracking_state TEXT NOT NULL
    CHECK (tracking_state IN ('assigned', 'in_transit', 'delivered')),
  carrier TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (fulfillment_event_id, tracking_number, tracking_state)
);
CREATE INDEX IF NOT EXISTS idx_merch_fulfillment_trackings_event
  ON merch_fulfillment_trackings (fulfillment_event_id);


-- Film multi-territory withholding + cross-collateralization firewall
-- (migration 0023, PR 18). The withholding log is the per-line,
-- pre-conversion foreign-tax evidence (UNIQUE per match_queue event — the
-- once-only replay guard); the territory envelopes are the per-territory
-- routing decisions (UNIQUE per released receipt per territory). jsonb
-- columns pack as TEXT JSON — the waterfall discipline.
CREATE TABLE IF NOT EXISTS film_territory_withholdings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  film_id TEXT NOT NULL,
  territory_code TEXT NOT NULL,
  foreign_tax_withheld INTEGER NOT NULL,
  withholding_rate_bps INTEGER NOT NULL,
  rate_table_version TEXT,
  source_currency TEXT NOT NULL,
  gross_source_micros TEXT NOT NULL,
  withheld_source_micros TEXT NOT NULL,
  net_source_micros TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  fx_rate_micros INTEGER NOT NULL,
  gross_base_cents INTEGER NOT NULL,
  withheld_base_cents INTEGER NOT NULL,
  net_base_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_film_territory_withholdings_film
  ON film_territory_withholdings (film_id);

CREATE TABLE IF NOT EXISTS film_territory_distributions (
  id TEXT PRIMARY KEY,
  film_id TEXT NOT NULL,
  escrow_ledger_id TEXT NOT NULL,
  territory_code TEXT NOT NULL,
  status TEXT NOT NULL,
  fdg_bypass_cents INTEGER NOT NULL,
  legs TEXT NOT NULL,
  tier_allocations TEXT NOT NULL,
  unpaid_total_cents INTEGER NOT NULL,
  cross_collateralization_permitted INTEGER NOT NULL,
  cross_applications TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (escrow_ledger_id, territory_code)
);
CREATE INDEX IF NOT EXISTS idx_film_territory_distributions_film
  ON film_territory_distributions (film_id);
`;

// --- Royalty recon job queue (migration 0011) — row projection helpers ---
//
// The SQLite mirror keeps the Postgres wall types as TEXT (uuid /
// timestamptz read back as strings) and packs result jsonb as TEXT JSON —
// the same store-seam discipline the other local tables use.

type ReconJobDbRow = Omit<RoyaltyReconJobRecord, 'result'> & { result: string | null };

function reconJobToDbRow(record: RoyaltyReconJobRecord): ReconJobDbRow {
  return { ...record, result: record.result === null ? null : JSON.stringify(record.result) };
}

function reconJobFromDbRow(row: ReconJobDbRow): RoyaltyReconJobRecord {
  let result: ReconJobResult | null = null;
  if (typeof row.result === 'string') {
    try {
      result = JSON.parse(row.result) as ReconJobResult;
    } catch (error) {
      throw new Error(
        `royalty_recon_jobs.result for ${row.id} is not valid JSON — SQLite mirror corrupt`,
        { cause: error },
      );
    }
  }
  return { ...row, result };
}

// --- The film waterfall engine (migration 0016, PR 8) — row projection helpers ---
//
// The definition jsonb and the per-leg routing arrays pack as TEXT JSON —
// the recon queue's result-column discipline. Unpacking is fail-closed: a
// corrupt mirror throws rather than silently yielding an empty deal.

type FilmWaterfallDefinitionDbRow = Omit<FilmWaterfallDefinitionRecord, 'definition'> & {
  definition: string;
};

function filmWaterfallDefinitionFromDbRow(row: FilmWaterfallDefinitionDbRow): FilmWaterfallDefinitionRecord {
  let definition: FilmWaterfallDefinitionRecord['definition'];
  try {
    definition = JSON.parse(row.definition) as FilmWaterfallDefinitionRecord['definition'];
  } catch (error) {
    throw new Error(
      `film_waterfall_definitions.definition for ${row.film_id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, definition };
}

type FilmWaterfallDistributionDbRow = Omit<
  FilmWaterfallDistributionRecord,
  'legs' | 'tier_allocations'
> & { legs: string; tier_allocations: string };

function filmWaterfallDistributionToDbRow(
  record: FilmWaterfallDistributionRecord,
): FilmWaterfallDistributionDbRow {
  return {
    ...record,
    legs: JSON.stringify(record.legs),
    tier_allocations: JSON.stringify(record.tier_allocations),
  };
}

function filmWaterfallDistributionFromDbRow(
  row: FilmWaterfallDistributionDbRow,
): FilmWaterfallDistributionRecord {
  const unpack = <T>(json: string, column: string): T => {
    try {
      return JSON.parse(json) as T;
    } catch (error) {
      throw new Error(
        `film_waterfall_distributions.${column} for ${row.id} is not valid JSON — SQLite mirror corrupt`,
        { cause: error },
      );
    }
  };
  return {
    ...row,
    legs: unpack<FilmWaterfallDistributionRecord['legs']>(row.legs, 'legs'),
    tier_allocations: unpack<FilmWaterfallDistributionRecord['tier_allocations']>(
      row.tier_allocations,
      'tier_allocations',
    ),
  };
}

// --- Film multi-territory withholding + firewall (migration 0023, PR 18) — row projection helpers ---
//
// The territory envelope's legs/tier_allocations/cross_applications pack as
// TEXT JSON (the parent waterfall distribution's discipline); the two CAMA
// flags store as 0/1 INTEGER (the SQLite boolean discipline). Unpacking is
// fail-closed: a corrupt mirror throws rather than silently yielding an
// empty allocation.

type FilmTerritoryDistributionDbRow = Omit<
  FilmTerritoryDistributionRecord,
  'legs' | 'tier_allocations' | 'cross_applications' | 'cross_collateralization_permitted'
> & {
  legs: string;
  tier_allocations: string;
  cross_applications: string | null;
  cross_collateralization_permitted: number;
};
function filmTerritoryDistributionToDbRow(
  record: FilmTerritoryDistributionRecord,
): FilmTerritoryDistributionDbRow {
  return {
    ...record,
    cross_collateralization_permitted: record.cross_collateralization_permitted ? 1 : 0,
    legs: JSON.stringify(record.legs),
    tier_allocations: JSON.stringify(record.tier_allocations),
    cross_applications:
      record.cross_applications === null ? null : JSON.stringify(record.cross_applications),
  };
}

type FilmTerritoryWithholdingDbRow = Omit<FilmTerritoryWithholdingRecord, 'foreign_tax_withheld'> & {
  foreign_tax_withheld: number;
};

function filmTerritoryWithholdingToDbRow(
  record: FilmTerritoryWithholdingRecord,
): FilmTerritoryWithholdingDbRow {
  return { ...record, foreign_tax_withheld: record.foreign_tax_withheld ? 1 : 0 };
}

function filmTerritoryWithholdingFromDbRow(
  row: FilmTerritoryWithholdingDbRow,
): FilmTerritoryWithholdingRecord {
  return { ...row, foreign_tax_withheld: row.foreign_tax_withheld !== 0 };
}

function filmTerritoryDistributionFromDbRow(
  row: FilmTerritoryDistributionDbRow,
): FilmTerritoryDistributionRecord {
  const unpack = <T>(json: string | null, column: string): T | null => {
    if (json === null) return null;
    try {
      return JSON.parse(json) as T;
    } catch (error) {
      throw new Error(
        `film_territory_distributions.${column} for ${row.id} is not valid JSON — SQLite mirror corrupt`,
        { cause: error },
      );
    }
  };
  return {
    ...row,
    cross_collateralization_permitted: row.cross_collateralization_permitted !== 0,
    legs: unpack<FilmTerritoryDistributionRecord['legs']>(row.legs, 'legs') as NonNullable<
      FilmTerritoryDistributionRecord['legs']
    >,
    tier_allocations: unpack<FilmTerritoryDistributionRecord['tier_allocations']>(
      row.tier_allocations,
      'tier_allocations',
    ) as NonNullable<FilmTerritoryDistributionRecord['tier_allocations']>,
    cross_applications: unpack<FilmTerritoryDistributionRecord['cross_applications']>(
      row.cross_applications,
      'cross_applications',
    ),
  };
}

// --- Podcast episode splits + guest milestone bonuses (migration 0017, PR 11) — row projection helpers ---
//
// The schedule splits and the per-holder accrual arrays pack as TEXT JSON —
// the waterfall's discipline. Unpacking is fail-closed: a corrupt mirror
// throws rather than silently yielding an empty allocation.

type PodcastEpisodeSplitScheduleDbRow = Omit<
  PodcastEpisodeSplitScheduleRecord,
  'splits'
> & { splits: string };

function podcastEpisodeSplitScheduleToDbRow(
  record: PodcastEpisodeSplitScheduleRecord,
): PodcastEpisodeSplitScheduleDbRow {
  return { ...record, splits: JSON.stringify(record.splits) };
}

function podcastEpisodeSplitScheduleFromDbRow(
  row: PodcastEpisodeSplitScheduleDbRow,
): PodcastEpisodeSplitScheduleRecord {
  let splits: PodcastEpisodeSplitScheduleRecord['splits'];
  try {
    splits = JSON.parse(row.splits) as PodcastEpisodeSplitScheduleRecord['splits'];
  } catch (error) {
    throw new Error(
      `podcast_episode_split_schedules.splits for ${row.episode_id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, splits };
}

type PodcastEpisodeSplitAccrualDbRow = Omit<
  PodcastEpisodeSplitAccrualRecord,
  'accruals'
> & { accruals: string };

function podcastEpisodeSplitAccrualToDbRow(
  record: PodcastEpisodeSplitAccrualRecord,
): PodcastEpisodeSplitAccrualDbRow {
  return { ...record, accruals: JSON.stringify(record.accruals) };
}

function podcastEpisodeSplitAccrualFromDbRow(
  row: PodcastEpisodeSplitAccrualDbRow,
): PodcastEpisodeSplitAccrualRecord {
  let accruals: PodcastEpisodeSplitAccrualRecord['accruals'];
  try {
    accruals = JSON.parse(row.accruals) as PodcastEpisodeSplitAccrualRecord['accruals'];
  } catch (error) {
    throw new Error(
      `podcast_episode_split_accruals.accruals for ${row.id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, accruals };
}

// --- Gaming (migration 0018, PR 12) — row projection helpers ---

// The schedule splits and the per-payee payout arrays pack as TEXT JSON —
// the waterfall's discipline. Unpacking is fail-closed: a corrupt mirror
// throws rather than silently yielding an empty allocation.

type GamingItemSplitScheduleDbRow = Omit<
  GamingItemSplitScheduleRecord,
  'splits'
> & { splits: string };

function gamingItemSplitScheduleToDbRow(
  record: GamingItemSplitScheduleRecord,
): GamingItemSplitScheduleDbRow {
  return { ...record, splits: JSON.stringify(record.splits) };
}

function gamingItemSplitScheduleFromDbRow(
  row: GamingItemSplitScheduleDbRow,
): GamingItemSplitScheduleRecord {
  let splits: GamingItemSplitScheduleRecord['splits'];
  try {
    splits = JSON.parse(row.splits) as GamingItemSplitScheduleRecord['splits'];
  } catch (error) {
    throw new Error(
      `gaming_item_split_schedules.splits for ${row.item_id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, splits };
}

type GamingSplitPayoutDbRow = Omit<
  GamingSplitPayoutRecord,
  'accruals'
> & { accruals: string };

function gamingSplitPayoutToDbRow(
  record: GamingSplitPayoutRecord,
): GamingSplitPayoutDbRow {
  return { ...record, accruals: JSON.stringify(record.accruals) };
}

function gamingSplitPayoutFromDbRow(
  row: GamingSplitPayoutDbRow,
): GamingSplitPayoutRecord {
  let accruals: GamingSplitPayoutRecord['accruals'];
  try {
    accruals = JSON.parse(row.accruals) as GamingSplitPayoutRecord['accruals'];
  } catch (error) {
    throw new Error(
      `gaming_split_payouts.accruals for ${row.id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, accruals };
}

type GamingStudioKycDbRow = Omit<
  GamingStudioKycRecord,
  'team_members'
> & { team_members: string };

function gamingStudioKycToDbRow(record: GamingStudioKycRecord): GamingStudioKycDbRow {
  return { ...record, team_members: JSON.stringify(record.team_members) };
}

function gamingStudioKycFromDbRow(row: GamingStudioKycDbRow): GamingStudioKycRecord {
  let teamMembers: GamingStudioKycRecord['team_members'];
  try {
    teamMembers = JSON.parse(row.team_members) as GamingStudioKycRecord['team_members'];
  } catch (error) {
    throw new Error(
      `gaming_studio_kyc_verifications.team_members for ${row.id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, team_members: teamMembers };
}

// --- VTuber agency licensing holdbacks + tax verification (0020, PR 15) —
// row projection helpers. SQLite has no boolean type — the verification's
// profile-of-record fields ride as 0/1 integers, the same discipline the
// UCT credential vault rows use.

type VtuberVerificationSqliteRow = Omit<
  VtuberTaxWithholdingVerificationRecord,
  'tin_verified' | 'w9_on_file'
> & { tin_verified: number; w9_on_file: number };

function vtuberVerificationToSqliteRow(
  record: VtuberTaxWithholdingVerificationRecord,
): VtuberVerificationSqliteRow {
  return {
    ...record,
    tin_verified: record.tin_verified ? 1 : 0,
    w9_on_file: record.w9_on_file ? 1 : 0,
  };
}

function vtuberVerificationFromSqliteRow(
  row: VtuberVerificationSqliteRow,
): VtuberTaxWithholdingVerificationRecord {
  return {
    ...row,
    tin_verified: row.tin_verified === 1,
    w9_on_file: row.w9_on_file === 1,
  };
}

// --- The UCT credential vault (migration 0013) — row projection helpers ---
//
// Every record field is already SQLite-safe (strings and nulls only — no
// jsonb packing, no 0/1 booleans), so the row type is the record itself.

type DistributorConnectionRow = DistributorConnectionRecord;

/**
 * better-sqlite3 binds numbers, strings, bigints, buffers, and null only —
 * boolean record fields ride as 0/1 on write and restore on read.
 */
type MatchQueueSqliteRow = Omit<
  MatchQueueRecord,
  'unclaimed_identifier_hold' | 'network_sold' | 'is_cover_version' | 'foreign_tax_withheld'
> & {
  unclaimed_identifier_hold: 0 | 1;
  network_sold: 0 | 1 | null;
  is_cover_version: 0 | 1 | null;
  foreign_tax_withheld: 0 | 1 | null;
};

const booleanToSqlite = (value: boolean | null): 0 | 1 | null =>
  value === null ? null : value ? 1 : 0;

const booleanFromSqlite = (value: 0 | 1 | null): boolean | null =>
  value === null ? null : value === 1;

function matchQueueToSqliteRow(record: MatchQueueRecord): MatchQueueSqliteRow {
  return {
    ...record,
    unclaimed_identifier_hold: record.unclaimed_identifier_hold ? 1 : 0,
    network_sold: booleanToSqlite(record.network_sold),
    is_cover_version: booleanToSqlite(record.is_cover_version),
    foreign_tax_withheld: booleanToSqlite(record.foreign_tax_withheld),
  };
}

function matchQueueFromSqliteRow(row: MatchQueueSqliteRow): MatchQueueRecord {
  return {
    ...row,
    unclaimed_identifier_hold: row.unclaimed_identifier_hold === 1,
    network_sold: booleanFromSqlite(row.network_sold),
    is_cover_version: booleanFromSqlite(row.is_cover_version),
    foreign_tax_withheld: booleanFromSqlite(row.foreign_tax_withheld),
  };
}

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

    // 0009 — settlement-core concurrency guards (pre-0009 databases).
    const splitRunColumns0009 = columnsOf('split_runs');
    if (!splitRunColumns0009.has('idempotency_key')) {
      this.db.exec(`ALTER TABLE split_runs ADD COLUMN idempotency_key TEXT`);
    }
    // 0009 (H4): journal_id became nullable — the reversal row is inserted
    // before the journal exists. SQLite cannot relax NOT NULL in place;
    // rebuild the column through a rename/copy/drop.
    const reversalInfo = this.db
      .prepare(`PRAGMA table_info(payout_reversals)`)
      .all() as Array<{ name: string; notnull: number }>;
    const journalIdColumn = reversalInfo.find((column) => column.name === 'journal_id');
    if (journalIdColumn && journalIdColumn.notnull === 1) {
      this.db.exec(`
        ALTER TABLE payout_reversals RENAME COLUMN journal_id TO journal_id_legacy;
        ALTER TABLE payout_reversals ADD COLUMN journal_id TEXT;
        UPDATE payout_reversals SET journal_id = journal_id_legacy;
        ALTER TABLE payout_reversals DROP COLUMN journal_id_legacy;
      `);
    }
    // 0009 (H2/H3/H4): the uniqueness constraints themselves. Loud failure
    // on existing duplicates — a forked chain needs manual repair, exactly
    // like migration 0009 against Postgres.
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS gl_journals_sequence_unique ON gl_journals (sequence)`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS payout_reversals_transfer_id_unique ON payout_reversals (transfer_id)`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS split_runs_idempotency_key_unique ON split_runs (idempotency_key)`,
    );
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
      idempotency_key: row.idempotency_key ?? null,
      id: randomUUID(),
    };
    this.db
      .prepare(
        `INSERT INTO split_runs (
           id, source, period, currency, gross_cents, line_item_count,
           variance_account_cents, created_at, status, idempotency_key
         ) VALUES (
           @id, @source, @period, @currency, @gross_cents, @line_item_count,
           @variance_account_cents, @created_at, @status, @idempotency_key
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

  async getSplitRunByIdempotencyKey(key: string): Promise<SplitRunRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM split_runs WHERE idempotency_key = ?`)
        .get(key) as SplitRunRecord | undefined,
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

  async listRoyaltyLineItemsByRun(splitRunId: string): Promise<RoyaltyLineItemRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM royalty_line_items WHERE split_run_id = ? ORDER BY rowid ASC`)
        .all(splitRunId) as RoyaltyLineItemRecord[],
    );
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

  // --- Unclaimed royalty holding (PR 7) ---

  async listUnclaimedHoldingCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'unclaimed_holding' AND status = 'unclaimed_holding'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settleUnclaimedHolding(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS. changes = 0
    // means the row is absent or no longer held; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'unclaimed_holding'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  // --- Film waterfall escrow (PR 9) ---

  async listFilmEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'escrow_waterfall_pending' AND status = 'escrow_waterfall_pending'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settleFilmEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS. changes = 0
    // means the row is absent or no longer locked; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'escrow_waterfall_pending'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  async sumFilmGrossReceiptCents(filmId: string): Promise<number> {
    // Gross receipts count EVERY escrow receipt row for the film, held or
    // released — money is received when it locks, not when it releases. The
    // per-film payee id (film_escrow:{filmId}) is the grouping key.
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS gross_cents
         FROM ledger_transactions
         WHERE kind = 'escrow_waterfall_pending' AND payee_id = ?`,
      )
      .get(`film_escrow:${filmId}`) as { gross_cents: number };
    return Promise.resolve(row.gross_cents);
  }

  // --- Film waterfall engine (migration 0016, PR 8) ---

  async upsertFilmWaterfallDefinition(
    row: FilmWaterfallDefinitionRecord,
  ): Promise<FilmWaterfallDefinitionRecord> {
    // One definition per film asset — INSERT ON CONFLICT replaces the row
    // atomically (a re-registration after the lock check).
    this.db
      .prepare(
        `INSERT INTO film_waterfall_definitions (film_id, definition, created_at, updated_at)
         VALUES (@film_id, @definition, @created_at, @updated_at)
         ON CONFLICT(film_id) DO UPDATE SET
           definition = excluded.definition,
           updated_at = excluded.updated_at`,
      )
      .run({
        film_id: row.film_id,
        definition: JSON.stringify(row.definition),
        created_at: row.created_at,
        updated_at: row.updated_at,
      } satisfies FilmWaterfallDefinitionDbRow);
    return Promise.resolve(
      filmWaterfallDefinitionFromDbRow(
        this.db
          .prepare(`SELECT * FROM film_waterfall_definitions WHERE film_id = ?`)
          .get(row.film_id) as FilmWaterfallDefinitionDbRow,
      ),
    );
  }

  async getFilmWaterfallDefinition(
    filmId: string,
  ): Promise<FilmWaterfallDefinitionRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM film_waterfall_definitions WHERE film_id = ?`)
      .get(filmId) as FilmWaterfallDefinitionDbRow | undefined;
    return Promise.resolve(row === undefined ? undefined : filmWaterfallDefinitionFromDbRow(row));
  }

  async insertFilmWaterfallDistribution(
    row: Omit<FilmWaterfallDistributionRecord, 'id'>,
  ): Promise<FilmWaterfallDistributionRecord> {
    // UNIQUE on escrow_ledger_id: a duplicate insert throws (better-sqlite3
    // surfaces the constraint violation) and the caller recovers by reading
    // the existing row — one routing decision per released receipt.
    const record: FilmWaterfallDistributionRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO film_waterfall_distributions
           (id, film_id, escrow_ledger_id, status, fdg_bypass_cents, legs, tier_allocations, unpaid_total_cents, created_at)
         VALUES (@id, @film_id, @escrow_ledger_id, @status, @fdg_bypass_cents, @legs, @tier_allocations, @unpaid_total_cents, @created_at)`,
      )
      .run(
        filmWaterfallDistributionToDbRow(record) as unknown as Record<string, unknown>,
      );
    return Promise.resolve(record);
  }

  async getFilmWaterfallDistributionByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmWaterfallDistributionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM film_waterfall_distributions WHERE escrow_ledger_id = ?`,
      )
      .get(escrowLedgerId) as FilmWaterfallDistributionDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : filmWaterfallDistributionFromDbRow(row),
    );
  }

  async updateFilmWaterfallDistributionStatus(
    id: string,
    status: FilmWaterfallDistributionRecord['status'],
  ): Promise<FilmWaterfallDistributionRecord | undefined> {
    this.db
      .prepare(`UPDATE film_waterfall_distributions SET status = ? WHERE id = ?`)
      .run(status, id);
    const row = this.db
      .prepare(`SELECT * FROM film_waterfall_distributions WHERE id = ?`)
      .get(id) as FilmWaterfallDistributionDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : filmWaterfallDistributionFromDbRow(row),
    );
  }

  async deleteFilmWaterfallDistribution(id: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM film_waterfall_distributions WHERE id = ?`)
      .run(id);
  }

  async listFilmWaterfallDistributions(
    filmId: string,
  ): Promise<FilmWaterfallDistributionRecord[]> {
    // Oldest first — the cumulative paid state folds in routing order
    // (rowid ASC is the strict tiebreak when created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM film_waterfall_distributions
         WHERE film_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(filmId) as FilmWaterfallDistributionDbRow[];
    return Promise.resolve(rows.map(filmWaterfallDistributionFromDbRow));
  }

  // --- Film multi-territory withholding + cross-collateralization firewall (migration 0023, PR 18) ---

  async insertFilmTerritoryWithholding(
    row: Omit<FilmTerritoryWithholdingRecord, 'id'>,
  ): Promise<FilmTerritoryWithholdingRecord> {
    // UNIQUE on event_id (the content-derived match_queue event): a
    // duplicate insert throws (better-sqlite3 surfaces the constraint
    // violation) and the caller recovers by reading the existing row — one
    // withholding log per line, ever.
    const record: FilmTerritoryWithholdingRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO film_territory_withholdings
           (id, event_id, film_id, territory_code, foreign_tax_withheld,
            withholding_rate_bps, rate_table_version, source_currency,
            gross_source_micros, withheld_source_micros, net_source_micros,
            base_currency, fx_rate_micros, gross_base_cents, withheld_base_cents,
            net_base_cents, created_at)
         VALUES (@id, @event_id, @film_id, @territory_code, @foreign_tax_withheld,
            @withholding_rate_bps, @rate_table_version, @source_currency,
            @gross_source_micros, @withheld_source_micros, @net_source_micros,
            @base_currency, @fx_rate_micros, @gross_base_cents, @withheld_base_cents,
            @net_base_cents, @created_at)`,
      )
      .run(
        filmTerritoryWithholdingToDbRow(record) as unknown as Record<string, unknown>,
      );
    return Promise.resolve(record);
  }

  async getFilmTerritoryWithholdingByEventId(
    eventId: string,
  ): Promise<FilmTerritoryWithholdingRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM film_territory_withholdings WHERE event_id = ?`)
      .get(eventId) as FilmTerritoryWithholdingDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : filmTerritoryWithholdingFromDbRow(row),
    );
  }

  async listFilmTerritoryWithholdingsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryWithholdingRecord[]> {
    // Oldest first — the film's withholding history in log order.
    const rows = this.db
      .prepare(
        `SELECT * FROM film_territory_withholdings
         WHERE film_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(filmId) as FilmTerritoryWithholdingDbRow[];
    return Promise.resolve(rows.map(filmTerritoryWithholdingFromDbRow));
  }

  async insertFilmTerritoryDistribution(
    row: Omit<FilmTerritoryDistributionRecord, 'id'>,
  ): Promise<FilmTerritoryDistributionRecord> {
    // UNIQUE on (escrow_ledger_id, territory_code): a duplicate insert
    // throws (better-sqlite3 surfaces the constraint violation) and the
    // caller recovers by reading the existing rows — one routing decision
    // per released receipt per territory, ever.
    const record: FilmTerritoryDistributionRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO film_territory_distributions
           (id, film_id, escrow_ledger_id, territory_code, status, fdg_bypass_cents,
            legs, tier_allocations, unpaid_total_cents, cross_collateralization_permitted,
            cross_applications, created_at)
         VALUES (@id, @film_id, @escrow_ledger_id, @territory_code, @status, @fdg_bypass_cents,
            @legs, @tier_allocations, @unpaid_total_cents, @cross_collateralization_permitted,
            @cross_applications, @created_at)`,
      )
      .run(
        filmTerritoryDistributionToDbRow(record) as unknown as Record<string, unknown>,
      );
    return Promise.resolve(record);
  }

  async listFilmTerritoryDistributionsByEscrow(
    escrowLedgerId: string,
  ): Promise<FilmTerritoryDistributionRecord[]> {
    // One receipt's territory envelopes, territory_code ASC (deterministic).
    const rows = this.db
      .prepare(
        `SELECT * FROM film_territory_distributions
         WHERE escrow_ledger_id = ?
         ORDER BY territory_code ASC`,
      )
      .all(escrowLedgerId) as FilmTerritoryDistributionDbRow[];
    return Promise.resolve(rows.map(filmTerritoryDistributionFromDbRow));
  }

  async listFilmTerritoryDistributionsByFilm(
    filmId: string,
  ): Promise<FilmTerritoryDistributionRecord[]> {
    // Oldest first — the per-territory paid state folds in routing order
    // (rowid ASC is the strict tiebreak when created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM film_territory_distributions
         WHERE film_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(filmId) as FilmTerritoryDistributionDbRow[];
    return Promise.resolve(rows.map(filmTerritoryDistributionFromDbRow));
  }

  async updateFilmTerritoryDistributionStatus(
    id: string,
    status: FilmTerritoryDistributionRecord['status'],
  ): Promise<FilmTerritoryDistributionRecord | undefined> {
    this.db
      .prepare(`UPDATE film_territory_distributions SET status = ? WHERE id = ?`)
      .run(status, id);
    const row = this.db
      .prepare(`SELECT * FROM film_territory_distributions WHERE id = ?`)
      .get(id) as FilmTerritoryDistributionDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : filmTerritoryDistributionFromDbRow(row),
    );
  }

  async deleteFilmTerritoryDistribution(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM film_territory_distributions WHERE id = ?`).run(id);
  }

  // --- Podcast episode splits + guest milestone bonuses (migration 0017, PR 11) ---

  async upsertPodcastEpisodeSplitSchedule(
    row: PodcastEpisodeSplitScheduleRecord,
  ): Promise<PodcastEpisodeSplitScheduleRecord> {
    // One schedule per episode — INSERT ON CONFLICT replaces the row
    // atomically (a re-registration after the lock check).
    this.db
      .prepare(
        `INSERT INTO podcast_episode_split_schedules
           (episode_id, show_cbt_code, splits, version, created_at, updated_at)
         VALUES (@episode_id, @show_cbt_code, @splits, @version, @created_at, @updated_at)
         ON CONFLICT(episode_id) DO UPDATE SET
           show_cbt_code = excluded.show_cbt_code,
           splits = excluded.splits,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(
        podcastEpisodeSplitScheduleToDbRow(row) as unknown as Record<string, unknown>,
      );
    return Promise.resolve(
      podcastEpisodeSplitScheduleFromDbRow(
        this.db
          .prepare(`SELECT * FROM podcast_episode_split_schedules WHERE episode_id = ?`)
          .get(row.episode_id) as PodcastEpisodeSplitScheduleDbRow,
      ),
    );
  }

  async getPodcastEpisodeSplitSchedule(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM podcast_episode_split_schedules WHERE episode_id = ?`)
      .get(episodeId) as PodcastEpisodeSplitScheduleDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : podcastEpisodeSplitScheduleFromDbRow(row),
    );
  }

  async insertPodcastEpisodeSplitAccrual(
    row: Omit<PodcastEpisodeSplitAccrualRecord, 'id'>,
  ): Promise<PodcastEpisodeSplitAccrualRecord> {
    // UNIQUE on source_event_id: a duplicate insert throws (better-sqlite3
    // surfaces the constraint violation) and the caller counts the replay
    // as a no-op — one accrual per funding event, ever.
    const record: PodcastEpisodeSplitAccrualRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO podcast_episode_split_accruals
           (id, episode_id, source_event_id, source_amount_cents, split_version, accruals, company_dust_cents, created_at)
         VALUES (@id, @episode_id, @source_event_id, @source_amount_cents, @split_version, @accruals, @company_dust_cents, @created_at)`,
      )
      .run(
        podcastEpisodeSplitAccrualToDbRow(record) as unknown as Record<string, unknown>,
      );
    return Promise.resolve(record);
  }

  async getPodcastEpisodeSplitAccrualBySourceEvent(
    sourceEventId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM podcast_episode_split_accruals WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as PodcastEpisodeSplitAccrualDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : podcastEpisodeSplitAccrualFromDbRow(row),
    );
  }

  async listPodcastEpisodeSplitAccruals(
    episodeId: string,
  ): Promise<PodcastEpisodeSplitAccrualRecord[]> {
    // Oldest first — routing order (rowid ASC is the strict tiebreak when
    // created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM podcast_episode_split_accruals
         WHERE episode_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(episodeId) as PodcastEpisodeSplitAccrualDbRow[];
    return Promise.resolve(rows.map(podcastEpisodeSplitAccrualFromDbRow));
  }

  async insertPodcastGuestBonusDefinition(
    row: PodcastGuestBonusDefinitionRecord,
  ): Promise<PodcastGuestBonusDefinitionRecord> {
    // Composite UNIQUE (episode, guest, kind, threshold) — one contract per
    // milestone; a duplicate insert throws the constraint violation.
    this.db
      .prepare(
        `INSERT INTO podcast_guest_bonus_definitions
           (id, episode_id, guest_payee_id, guest_payee_name, milestone_kind, threshold, bonus_amount_cents, currency, created_at, updated_at)
         VALUES (@id, @episode_id, @guest_payee_id, @guest_payee_name, @milestone_kind, @threshold, @bonus_amount_cents, @currency, @created_at, @updated_at)`,
      )
      .run(row as unknown as Record<string, unknown>);
    return Promise.resolve(row);
  }

  async listPodcastGuestBonusDefinitions(
    episodeId: string,
  ): Promise<PodcastGuestBonusDefinitionRecord[]> {
    // Oldest first — definition registration order (rowid ASC is the
    // strict tiebreak when created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM podcast_guest_bonus_definitions
         WHERE episode_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(episodeId) as PodcastGuestBonusDefinitionRecord[];
    return Promise.resolve(rows);
  }

  async insertPodcastGuestBonusAccrual(
    row: Omit<PodcastGuestBonusAccrualRecord, 'id'>,
  ): Promise<PodcastGuestBonusAccrualRecord> {
    // UNIQUE on event_id (the content-derived `podcast:bonus:` id) — the
    // once-only milestone arbiter; a duplicate insert throws.
    const record: PodcastGuestBonusAccrualRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO podcast_guest_bonus_accruals
           (id, event_id, episode_id, bonus_definition_id, guest_payee_id, milestone_kind, threshold, verified_count, bonus_amount_cents, status, holding_ledger_id, created_at)
         VALUES (@id, @event_id, @episode_id, @bonus_definition_id, @guest_payee_id, @milestone_kind, @threshold, @verified_count, @bonus_amount_cents, @status, @holding_ledger_id, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async markPodcastGuestBonusAccrualPosted(
    id: string,
    holdingLedgerId: string,
  ): Promise<PodcastGuestBonusAccrualRecord | undefined> {
    this.db
      .prepare(
        `UPDATE podcast_guest_bonus_accruals SET status = 'posted', holding_ledger_id = ? WHERE id = ?`,
      )
      .run(holdingLedgerId, id);
    const row = this.db
      .prepare(`SELECT * FROM podcast_guest_bonus_accruals WHERE id = ?`)
      .get(id) as PodcastGuestBonusAccrualRecord | undefined;
    return Promise.resolve(row);
  }

  async deletePodcastGuestBonusAccrual(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM podcast_guest_bonus_accruals WHERE id = ?`).run(id);
  }

  async listPodcastGuestBonusAccruals(
    episodeId: string,
  ): Promise<PodcastGuestBonusAccrualRecord[]> {
    // Oldest first — accrual order (rowid ASC is the strict tiebreak when
    // created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM podcast_guest_bonus_accruals
         WHERE episode_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(episodeId) as PodcastGuestBonusAccrualRecord[];
    return Promise.resolve(rows);
  }

  // --- Gaming engine-royalty accumulator + item splits (migration 0018, PR 12) ---

  async insertGamingEngineRoyaltyEvent(
    row: Omit<GamingEngineRoyaltyEventRecord, 'id'>,
  ): Promise<GamingEngineRoyaltyEventRecord> {
    // UNIQUE on event_id — one contribution per queue event, ever; a
    // duplicate insert throws (better-sqlite3 surfaces the constraint
    // violation) and the caller counts the replay as a no-op.
    const record: GamingEngineRoyaltyEventRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO gaming_engine_royalty_events
           (id, event_id, platform, product_id, annual_year, gross_micros, engine_royalty_micros, created_at)
         VALUES (@id, @event_id, @platform, @product_id, @annual_year, @gross_micros, @engine_royalty_micros, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getGamingEngineRoyaltyEventByEventId(
    eventId: string,
  ): Promise<GamingEngineRoyaltyEventRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM gaming_engine_royalty_events WHERE event_id = ?`)
      .get(eventId) as GamingEngineRoyaltyEventRecord | undefined;
    return Promise.resolve(row);
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
    const placeholders = platforms.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT gross_micros FROM gaming_engine_royalty_events
         WHERE platform IN (${placeholders}) AND product_id = ? AND annual_year = ?`,
      )
      .all(...platforms, productId, annualYear) as Array<{ gross_micros: string }>;
    let total = 0n;
    for (const row of rows) {
      total += BigInt(row.gross_micros);
    }
    return Promise.resolve(total.toString());
  }

  async upsertGamingItemSplitSchedule(
    row: GamingItemSplitScheduleRecord,
  ): Promise<GamingItemSplitScheduleRecord> {
    // One schedule per item — INSERT ON CONFLICT replaces the row
    // atomically (a re-registration after the lock check).
    this.db
      .prepare(
        `INSERT INTO gaming_item_split_schedules
           (item_id, asset_cbt_code, splits, resale_royalty_payee_id, version, created_at, updated_at)
         VALUES (@item_id, @asset_cbt_code, @splits, @resale_royalty_payee_id, @version, @created_at, @updated_at)
         ON CONFLICT(item_id) DO UPDATE SET
           asset_cbt_code = excluded.asset_cbt_code,
           splits = excluded.splits,
           resale_royalty_payee_id = excluded.resale_royalty_payee_id,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(gamingItemSplitScheduleToDbRow(row) as unknown as Record<string, unknown>);
    return Promise.resolve(
      gamingItemSplitScheduleFromDbRow(
        this.db
          .prepare(`SELECT * FROM gaming_item_split_schedules WHERE item_id = ?`)
          .get(row.item_id) as GamingItemSplitScheduleDbRow,
      ),
    );
  }

  async getGamingItemSplitSchedule(
    itemId: string,
  ): Promise<GamingItemSplitScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM gaming_item_split_schedules WHERE item_id = ?`)
      .get(itemId) as GamingItemSplitScheduleDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : gamingItemSplitScheduleFromDbRow(row),
    );
  }

  async insertGamingSplitPayout(
    row: Omit<GamingSplitPayoutRecord, 'id'>,
  ): Promise<GamingSplitPayoutRecord> {
    // UNIQUE on source_event_id: a duplicate insert throws (better-sqlite3
    // surfaces the constraint violation) and the caller counts the replay
    // as a no-op — one routing per funding event, ever.
    const record: GamingSplitPayoutRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO gaming_split_payouts
           (id, item_id, source_event_id, source_amount_cents, resale_royalty_payee_id, resale_royalty_cents, split_version, accruals, company_dust_cents, created_at)
         VALUES (@id, @item_id, @source_event_id, @source_amount_cents, @resale_royalty_payee_id, @resale_royalty_cents, @split_version, @accruals, @company_dust_cents, @created_at)`,
      )
      .run(gamingSplitPayoutToDbRow(record) as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getGamingSplitPayoutBySourceEvent(
    sourceEventId: string,
  ): Promise<GamingSplitPayoutRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM gaming_split_payouts WHERE source_event_id = ?`)
      .get(sourceEventId) as GamingSplitPayoutDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : gamingSplitPayoutFromDbRow(row),
    );
  }

  async listGamingSplitPayouts(itemId: string): Promise<GamingSplitPayoutRecord[]> {
    // Oldest first — routing order (rowid ASC is the strict tiebreak when
    // created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM gaming_split_payouts
         WHERE item_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(itemId) as GamingSplitPayoutDbRow[];
    return Promise.resolve(rows.map(gamingSplitPayoutFromDbRow));
  }

  // --- Gaming cashout states: DevEx conversion logs + studio KYC (migration 0019, PR 13) ---

  async listVirtualCurrencyCashoutCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'virtual_currency_cashout_pending' AND status = 'virtual_currency_cashout_pending'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settleVirtualCurrencyCashout(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS. changes = 0
    // means the row is absent or no longer locked; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'virtual_currency_cashout_pending'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  async listEsportsPoolEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'esports_prize_pool_pending' AND status = 'esports_prize_pool_pending'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settleEsportsPoolEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the esports lock state only. changes = 0 means the row is absent or
    // no longer locked; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'esports_prize_pool_pending'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  async insertGamingDevexConversionLog(
    row: Omit<GamingDevexConversionLogRecord, 'id'>,
  ): Promise<GamingDevexConversionLogRecord> {
    // UNIQUE on event_id — one conversion log per funding line, ever; a
    // duplicate insert throws (better-sqlite3 surfaces the constraint
    // violation) and the caller counts the replay as a no-op.
    const record: GamingDevexConversionLogRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO gaming_devex_conversion_logs
           (id, event_id, line_event_id, platform, denomination, virtual_amount, exchange_rate, fiat_net_cents, settlement_batch_ref, status, settled_at, created_at)
         VALUES (@id, @event_id, @line_event_id, @platform, @denomination, @virtual_amount, @exchange_rate, @fiat_net_cents, @settlement_batch_ref, @status, @settled_at, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getGamingDevexConversionLogByEventId(
    eventId: string,
  ): Promise<GamingDevexConversionLogRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM gaming_devex_conversion_logs WHERE event_id = ?`)
      .get(eventId) as GamingDevexConversionLogRecord | undefined;
    return Promise.resolve(row);
  }

  async listGamingDevexConversionLogsByBatch(
    batchRef: string,
  ): Promise<GamingDevexConversionLogRecord[]> {
    // Oldest first — write order (rowid ASC is the strict tiebreak when
    // created_at strings tie).
    const rows = this.db
      .prepare(
        `SELECT * FROM gaming_devex_conversion_logs
         WHERE settlement_batch_ref = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(batchRef) as GamingDevexConversionLogRecord[];
    return Promise.resolve(rows);
  }

  async settleGamingDevexConversionLogsByBatch(
    batchRef: string,
    settledAt: string,
  ): Promise<number> {
    // The status predicate is the CAS at batch scope: only PENDING rows
    // flip, already-settled rows are untouched, and the count is the honest
    // report of what this call settled.
    const result = this.db
      .prepare(
        `UPDATE gaming_devex_conversion_logs
         SET status = 'fiat_settled', settled_at = ?
         WHERE settlement_batch_ref = ? AND status = 'pending_fiat_settlement'`,
      )
      .run(settledAt, batchRef);
    return Promise.resolve(result.changes);
  }

  async upsertAiModelSplitTerms(
    terms: Omit<AiModelSplitTermsRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiModelSplitTermsRecord> {
    // UNIQUE per ai_model_id — an upsert converges on the newest contract
    // (the re-registered terms govern the next ingest, never a duplicate).
    const now = new Date().toISOString();
    const record: AiModelSplitTermsRecord = {
      ...terms,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO ai_model_split_terms
           (id, ai_model_id, base_model_provider_fee_bps, developer_split_bps, contributor_pool_bps,
            base_model_provider_payee_id, base_model_provider_payee_name, developer_payee_id,
            developer_payee_name, model_operator_payee_id, model_operator_payee_name,
            created_at, updated_at)
         VALUES (@id, @ai_model_id, @base_model_provider_fee_bps, @developer_split_bps, @contributor_pool_bps,
            @base_model_provider_payee_id, @base_model_provider_payee_name, @developer_payee_id,
            @developer_payee_name, @model_operator_payee_id, @model_operator_payee_name,
            @created_at, @updated_at)
         ON CONFLICT (ai_model_id) DO UPDATE SET
           base_model_provider_fee_bps = excluded.base_model_provider_fee_bps,
           developer_split_bps = excluded.developer_split_bps,
           contributor_pool_bps = excluded.contributor_pool_bps,
           base_model_provider_payee_id = excluded.base_model_provider_payee_id,
           base_model_provider_payee_name = excluded.base_model_provider_payee_name,
           developer_payee_id = excluded.developer_payee_id,
           developer_payee_name = excluded.developer_payee_name,
           model_operator_payee_id = excluded.model_operator_payee_id,
           model_operator_payee_name = excluded.model_operator_payee_name,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getAiModelSplitTerms(
    aiModelId: string,
  ): Promise<AiModelSplitTermsRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM ai_model_split_terms WHERE ai_model_id = ?`)
      .get(aiModelId) as AiModelSplitTermsRecord | undefined;
    return Promise.resolve(row);
  }

  async upsertAiModelContribution(
    contribution: Omit<
      AiModelContributionRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<AiModelContributionRecord> {
    // UNIQUE per (ai_model_id, contributor_payee_id) — a re-shipped
    // attribution log converges; the newest weight governs.
    const now = new Date().toISOString();
    const record: AiModelContributionRecord = {
      ...contribution,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO ai_model_contributions
           (id, ai_model_id, contributor_payee_id, contributor_payee_name, contributor_class,
            dataset_token_weight, created_at, updated_at)
         VALUES (@id, @ai_model_id, @contributor_payee_id, @contributor_payee_name, @contributor_class,
            @dataset_token_weight, @created_at, @updated_at)
         ON CONFLICT (ai_model_id, contributor_payee_id) DO UPDATE SET
           contributor_payee_name = excluded.contributor_payee_name,
           contributor_class = excluded.contributor_class,
           dataset_token_weight = excluded.dataset_token_weight,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listAiModelContributions(
    aiModelId: string,
  ): Promise<AiModelContributionRecord[]> {
    // Write order (rowid ASC is the strict tiebreak when created_at ties).
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_model_contributions
         WHERE ai_model_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(aiModelId) as AiModelContributionRecord[];
    return Promise.resolve(rows);
  }

  // --- AI training dispute freeze + payout gate states + dataset
  // --- deprecations (migration 0029, PR 25)

  async insertAiTrainingDispute(
    row: Omit<AiTrainingDisputeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiTrainingDisputeRecord> {
    // UNIQUE per (ai_model_id, dataset_version, rights_holder_payee_id) —
    // a re-filed dispute surfaces the unique violation; the caller
    // recovers by reading the existing row.
    const now = new Date().toISOString();
    const record: AiTrainingDisputeRecord = { ...row, id: randomUUID(), created_at: now, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO ai_training_disputes
           (id, ai_model_id, dataset_version, rights_holder_payee_id, rights_holder_payee_name,
            dispute_basis, status, resolution_notes, resolved_by, resolved_at, created_at, updated_at)
         VALUES (@id, @ai_model_id, @dataset_version, @rights_holder_payee_id, @rights_holder_payee_name,
            @dispute_basis, @status, @resolution_notes, @resolved_by, @resolved_at, @created_at, @updated_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getAiTrainingDispute(
    id: string,
  ): Promise<AiTrainingDisputeRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM ai_training_disputes WHERE id = ?`)
      .get(id) as AiTrainingDisputeRecord | undefined;
    return Promise.resolve(row);
  }

  async listAiTrainingDisputes(
    status?: AiTrainingDisputeStatus,
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<AiTrainingDisputeRecord[]> {
    // Newest first (created_at DESC, rowid DESC as the strict tiebreak).
    const rows = (
      status === undefined
        ? this.db
            .prepare(
              `SELECT * FROM ai_training_disputes
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(limit)
        : this.db
            .prepare(
              `SELECT * FROM ai_training_disputes
               WHERE status = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(status, limit)
    ) as AiTrainingDisputeRecord[];
    return Promise.resolve(rows);
  }

  async resolveAiTrainingDispute(
    id: string,
    resolution: {
      resolution_notes: string | null;
      resolved_by: string;
      resolved_at: string;
    },
  ): Promise<AiTrainingDisputeRecord | undefined> {
    // THE VERIFIED RESOLUTION PATH's CAS — the single conditional UPDATE
    // flips ONE filed row; changes === 0 means unknown id or an already-
    // resolved dispute (the concurrent resolution loser reads undefined).
    const result = this.db
      .prepare(
        `UPDATE ai_training_disputes
         SET status = 'resolved', resolution_notes = ?, resolved_by = ?,
             resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'filed'`,
      )
      .run(
        resolution.resolution_notes,
        resolution.resolved_by,
        resolution.resolved_at,
        resolution.resolved_at,
        id,
      );
    if (result.changes !== 1) {
      return Promise.resolve(undefined);
    }
    return this.getAiTrainingDispute(id);
  }

  async freezeUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number> {
    // The FREEZE CAS sweep — one conditional statement over the model's
    // ingest scope; `changes` is the count of legs THIS call froze. The
    // status predicate is the CAS: already-frozen, released, and settled
    // legs are untouched (a re-file's sweep is a counted no-op).
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'unauthorized_training_hold'
         WHERE kind = 'unclaimed_holding' AND status = 'unclaimed_holding'
           AND split_run_id = ?`,
      )
      .run(modelLedgerScope);
    return Promise.resolve(result.changes);
  }

  async thawUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number> {
    // The THAW CAS sweep — the verified resolution's ledger leg: ONLY the
    // scope's 'unauthorized_training_hold' legs return to holding.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'unclaimed_holding'
         WHERE kind = 'unclaimed_holding' AND status = 'unauthorized_training_hold'
           AND split_run_id = ?`,
      )
      .run(modelLedgerScope);
    return Promise.resolve(result.changes);
  }

  async listUnauthorizedTrainingHolds(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    // The frozen-leg work queue — a thawed leg leaves the listing.
    const rows = this.db
      .prepare(
        `SELECT * FROM ledger_transactions
         WHERE kind = 'unclaimed_holding' AND status = 'unauthorized_training_hold'
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as LedgerTransactionRecord[];
    return Promise.resolve(rows);
  }

  async upsertAiPayoutGateState(
    row: Omit<AiPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiPayoutGateStateRecord> {
    // UNIQUE per payee_id — a re-recording converges (the newest state
    // governs the next dispatch).
    const now = new Date().toISOString();
    const record: AiPayoutGateStateRecord = {
      ...row,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO ai_payout_gate_states
           (id, payee_id, ai_model_id, ai_training_consent_state, synthetic_voice_likeness_state,
            verified_by, created_at, updated_at)
         VALUES (@id, @payee_id, @ai_model_id, @ai_training_consent_state, @synthetic_voice_likeness_state,
            @verified_by, @created_at, @updated_at)
         ON CONFLICT (payee_id) DO UPDATE SET
           ai_model_id = excluded.ai_model_id,
           ai_training_consent_state = excluded.ai_training_consent_state,
           synthetic_voice_likeness_state = excluded.synthetic_voice_likeness_state,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getAiPayoutGateState(
    payeeId: string,
  ): Promise<AiPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM ai_payout_gate_states WHERE payee_id = ?`)
      .get(payeeId) as AiPayoutGateStateRecord | undefined;
    return Promise.resolve(row);
  }

  async insertAiDatasetDeprecation(
    row: Omit<AiDatasetDeprecationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiDatasetDeprecationRecord> {
    // UNIQUE per (ai_model_id, dataset_version) — a re-deprecation
    // surfaces the unique violation; the caller recovers by reading the row.
    const now = new Date().toISOString();
    const record: AiDatasetDeprecationRecord = { ...row, id: randomUUID(), created_at: now, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO ai_dataset_deprecations
           (id, ai_model_id, dataset_version, reason, rights_holder_payee_id,
            rights_holder_payee_name, deprecated_at, notes, created_at, updated_at)
         VALUES (@id, @ai_model_id, @dataset_version, @reason, @rights_holder_payee_id,
            @rights_holder_payee_name, @deprecated_at, @notes, @created_at, @updated_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getAiDatasetDeprecation(
    aiModelId: string,
    datasetVersion: string,
  ): Promise<AiDatasetDeprecationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM ai_dataset_deprecations
         WHERE ai_model_id = ? AND dataset_version = ?`,
      )
      .get(aiModelId, datasetVersion) as AiDatasetDeprecationRecord | undefined;
    return Promise.resolve(row);
  }

  async listAiDatasetDeprecationsByModel(
    aiModelId: string,
  ): Promise<AiDatasetDeprecationRecord[]> {
    // Oldest first — the posting pass's halt set reads the history in order.
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_dataset_deprecations
         WHERE ai_model_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(aiModelId) as AiDatasetDeprecationRecord[];
    return Promise.resolve(rows);
  }

  async insertAiDatasetAllocationArchive(
    row: Omit<AiDatasetAllocationArchiveRecord, 'id'>,
  ): Promise<AiDatasetAllocationArchiveRecord> {
    // UNIQUE per (deprecation_id, ledger_transaction_id) — a re-run
    // deprecation converges, never double-archives. The referenced ledger
    // row is NOT touched (the append-only trail stays intact).
    const record: AiDatasetAllocationArchiveRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO ai_dataset_allocation_archives
           (id, deprecation_id, ledger_transaction_id, contributor_payee_id,
            amount_cents, currency, archived_at)
         VALUES (@id, @deprecation_id, @ledger_transaction_id, @contributor_payee_id,
            @amount_cents, @currency, @archived_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listAiDatasetAllocationArchives(
    deprecationId: string,
  ): Promise<AiDatasetAllocationArchiveRecord[]> {
    // Oldest first — the archival order of record.
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_dataset_allocation_archives
         WHERE deprecation_id = ?
         ORDER BY archived_at ASC, rowid ASC`,
      )
      .all(deprecationId) as AiDatasetAllocationArchiveRecord[];
    return Promise.resolve(rows);
  }

  async upsertGamingStudioKyc(
    row: GamingStudioKycRecord,
  ): Promise<GamingStudioKycRecord> {
    // One verification state per studio payee — INSERT ON CONFLICT replaces
    // the row atomically (a re-verification after the lock check).
    this.db
      .prepare(
        `INSERT INTO gaming_studio_kyc_verifications
           (id, studio_payee_id, studio_kyc_status, team_members, contract_ref, created_at, updated_at)
         VALUES (@id, @studio_payee_id, @studio_kyc_status, @team_members, @contract_ref, @created_at, @updated_at)
         ON CONFLICT(studio_payee_id) DO UPDATE SET
           id = excluded.id,
           studio_kyc_status = excluded.studio_kyc_status,
           team_members = excluded.team_members,
           contract_ref = excluded.contract_ref,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(gamingStudioKycToDbRow(row) as unknown as Record<string, unknown>);
    return Promise.resolve(
      gamingStudioKycFromDbRow(
        this.db
          .prepare(`SELECT * FROM gaming_studio_kyc_verifications WHERE studio_payee_id = ?`)
          .get(row.studio_payee_id) as GamingStudioKycDbRow,
      ),
    );
  }

  async getGamingStudioKyc(
    studioPayeeId: string,
  ): Promise<GamingStudioKycRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM gaming_studio_kyc_verifications WHERE studio_payee_id = ?`)
      .get(studioPayeeId) as GamingStudioKycDbRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : gamingStudioKycFromDbRow(row),
    );
  }

  // --- VTuber agency licensing holdbacks + tax verification (0020, PR 15) ---

  async listAvatarIpHoldbackCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'avatar_ip_licensing_holdback' AND status = 'avatar_ip_licensing_holdback'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settleAvatarIpHoldback(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the holdback lock state only. changes = 0 means the row is absent or
    // no longer locked; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'avatar_ip_licensing_holdback'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  // --- Webtoon studio splits + translation cascades (PR 20, migration 0024) ---

  async insertWebtoonStudioSplitRole(
    row: Omit<WebtoonStudioSplitRoleRecord, 'id'>,
  ): Promise<WebtoonStudioSplitRoleRecord> {
    // UNIQUE on (series_id, role_group, payee_id) — a duplicate registration
    // throws the unique violation (the replay surface).
    const record: WebtoonStudioSplitRoleRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO webtoon_studio_split_roles
           (id, series_id, role_group, payee_id, payee_name, share_bps, contract_ref, created_at)
         VALUES (@id, @series_id, @role_group, @payee_id, @payee_name, @share_bps, @contract_ref, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listWebtoonStudioSplitRoles(seriesId: string): Promise<WebtoonStudioSplitRoleRecord[]> {
    // Insertion order (rowid ASC) — the deterministic allocation order.
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM webtoon_studio_split_roles WHERE series_id = ? ORDER BY rowid ASC`)
        .all(seriesId) as WebtoonStudioSplitRoleRecord[],
    );
  }

  async upsertWebtoonLocalizationContract(
    row: Omit<WebtoonLocalizationContractRecord, 'id'>,
  ): Promise<WebtoonLocalizationContractRecord> {
    // One localizer of record per (series, language) feed — INSERT ON
    // CONFLICT replaces the row atomically (the studio-KYC precedent).
    const record: WebtoonLocalizationContractRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO webtoon_localization_contracts
           (id, series_id, language_code, localizer_payee_id, localizer_payee_name, fee_mode, per_chapter_flat_fee_cents, rev_share_bps, contract_ref, created_at)
         VALUES (@id, @series_id, @language_code, @localizer_payee_id, @localizer_payee_name, @fee_mode, @per_chapter_flat_fee_cents, @rev_share_bps, @contract_ref, @created_at)
         ON CONFLICT(series_id, language_code) DO UPDATE SET
           id = excluded.id,
           localizer_payee_id = excluded.localizer_payee_id,
           localizer_payee_name = excluded.localizer_payee_name,
           fee_mode = excluded.fee_mode,
           per_chapter_flat_fee_cents = excluded.per_chapter_flat_fee_cents,
           rev_share_bps = excluded.rev_share_bps,
           contract_ref = excluded.contract_ref,
           created_at = excluded.created_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getWebtoonLocalizationContract(
    seriesId: string,
    languageCode: string,
  ): Promise<WebtoonLocalizationContractRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM webtoon_localization_contracts WHERE series_id = ? AND language_code = ?`,
        )
        .get(seriesId, languageCode) as WebtoonLocalizationContractRecord | undefined,
    );
  }

  async insertWebtoonLocalizationCostSchedule(
    row: Omit<WebtoonLocalizationCostScheduleRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostScheduleRecord> {
    // UNIQUE on schedule_ref — the business key the release resolves by.
    const record: WebtoonLocalizationCostScheduleRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO webtoon_localization_cost_schedules
           (id, schedule_ref, series_id, language_code, total_cost_cents, amortization_periods, cost_agreement_ref, created_at)
         VALUES (@id, @schedule_ref, @series_id, @language_code, @total_cost_cents, @amortization_periods, @cost_agreement_ref, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getWebtoonLocalizationCostScheduleByRef(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostScheduleRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM webtoon_localization_cost_schedules WHERE schedule_ref = ?`)
        .get(scheduleRef) as WebtoonLocalizationCostScheduleRecord | undefined,
    );
  }

  async insertWebtoonLocalizationCostLine(
    row: Omit<WebtoonLocalizationCostLineRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostLineRecord> {
    // UNIQUE per (schedule_ref, line_index) — the insert-as-lock consume
    // arbiter; a concurrent consume of the same period throws and the
    // caller re-derives the next line (the VTuber amortization discipline).
    const record: WebtoonLocalizationCostLineRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO webtoon_localization_cost_lines
           (id, schedule_ref, line_index, amount_cents, released_in_ledger_id, created_at)
         VALUES (@id, @schedule_ref, @line_index, @amount_cents, @released_in_ledger_id, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listWebtoonLocalizationCostLines(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostLineRecord[]> {
    // Line index order — the deterministic consumption order (rowid ASC is
    // the strict tiebreak, though the unique constraint precludes ties).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM webtoon_localization_cost_lines
         WHERE schedule_ref = ?
         ORDER BY line_index ASC, rowid ASC`,
        )
        .all(scheduleRef) as WebtoonLocalizationCostLineRecord[],
    );
  }

  async upsertWebtoonRecoupmentPool(
    row: Omit<WebtoonRecoupmentPoolRecord, 'id'>,
  ): Promise<WebtoonRecoupmentPoolRecord> {
    // One pool of record per (series, class) — INSERT ON CONFLICT replaces
    // the row atomically.
    const record: WebtoonRecoupmentPoolRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO webtoon_recoupment_pools
           (id, series_id, pool_class, advance_cents, recouped_cents, currency, status, advance_agreement_ref, created_at, updated_at)
         VALUES (@id, @series_id, @pool_class, @advance_cents, @recouped_cents, @currency, @status, @advance_agreement_ref, @created_at, @updated_at)
         ON CONFLICT(series_id, pool_class) DO UPDATE SET
           id = excluded.id,
           advance_cents = excluded.advance_cents,
           recouped_cents = excluded.recouped_cents,
           currency = excluded.currency,
           status = excluded.status,
           advance_agreement_ref = excluded.advance_agreement_ref,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getWebtoonRecoupmentPool(
    seriesId: string,
    poolClass: WebtoonRecoupmentPoolClass,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM webtoon_recoupment_pools WHERE series_id = ? AND pool_class = ?`)
        .get(seriesId, poolClass) as WebtoonRecoupmentPoolRecord | undefined,
    );
  }

  async insertWebtoonRecoupmentApplication(
    row: Omit<WebtoonRecoupmentApplicationRecord, 'id'>,
  ): Promise<WebtoonRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id) — a replayed application is the
    // unique violation, never a double recovery. UNIQUE per
    // (pool_id, recouped_before_cents) — the POSITION lock (the
    // insert-as-lock arbiter).
    const record: WebtoonRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO webtoon_recoupment_applications
           (id, pool_id, pool_class, source_event_id, recouped_before_cents, applied_cents, remaining_cents, created_at)
         VALUES (@id, @pool_id, @pool_class, @source_event_id, @recouped_before_cents, @applied_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listWebtoonRecoupmentApplications(
    poolId: string,
  ): Promise<WebtoonRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order (rowid ASC
    // the strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM webtoon_recoupment_applications
         WHERE pool_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(poolId) as WebtoonRecoupmentApplicationRecord[],
    );
  }

  async updateWebtoonRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: WebtoonRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the 'active' state only. changes = 0 means the pool is absent or
    // already recouped; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE webtoon_recoupment_pools
         SET recouped_cents = ?, status = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(recoupedCents, status, updatedAt, id);
    if (result.changes === 0) return undefined;
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM webtoon_recoupment_pools WHERE id = ?`).get(id) as
        | WebtoonRecoupmentPoolRecord
        | undefined,
    );
  }

  // Migration 0030 — the book editorial split ledger (PR 26).

  async upsertBookEditorialSplitSchedule(
    row: BookEditorialSplitScheduleRecord,
  ): Promise<BookEditorialSplitScheduleRecord> {
    // One schedule of record per title_key — INSERT ON CONFLICT replaces
    // the row atomically (the caller preserves identity + version).
    const dbRow = {
      ...row,
      contributors: JSON.stringify(row.contributors),
    };
    this.db
      .prepare(
        `INSERT INTO book_editorial_split_schedules
           (id, title_key, scope, mode, pro_rata_basis, contributors, version, created_at, updated_at)
         VALUES (@id, @title_key, @scope, @mode, @pro_rata_basis, @contributors, @version, @created_at, @updated_at)
         ON CONFLICT (title_key) DO UPDATE SET
           scope = excluded.scope,
           mode = excluded.mode,
           pro_rata_basis = excluded.pro_rata_basis,
           contributors = excluded.contributors,
           version = excluded.version,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(dbRow as unknown as Record<string, unknown>);
    return Promise.resolve(row);
  }

  async getBookEditorialSplitSchedule(
    titleKey: string,
  ): Promise<BookEditorialSplitScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM book_editorial_split_schedules WHERE title_key = ?`)
      .get(titleKey) as (BookEditorialSplitScheduleRecord & { contributors: string }) | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      ...row,
      contributors: JSON.parse(row.contributors) as BookEditorialSplitScheduleRecord['contributors'],
    });
  }

  async insertBookRecoupmentPool(
    row: Omit<BookRecoupmentPoolRecord, 'id'>,
  ): Promise<BookRecoupmentPoolRecord> {
    // UNIQUE per (isbn, pool_class, sequence_no) — a re-registered slot is
    // the unique violation, never a silent duplicate.
    const record: BookRecoupmentPoolRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO book_recoupment_pools
           (id, isbn, pool_class, sequence_no, advance_cents, recouped_cents, currency, status, advance_agreement_ref, created_at, updated_at)
         VALUES (@id, @isbn, @pool_class, @sequence_no, @advance_cents, @recouped_cents, @currency, @status, @advance_agreement_ref, @created_at, @updated_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listBookRecoupmentPools(
    isbn: string,
    poolClass: BookRecoupmentPoolClass,
  ): Promise<BookRecoupmentPoolRecord[]> {
    // sequence_no ASC — the recoupment order of record (rowid ASC the
    // strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM book_recoupment_pools
         WHERE isbn = ? AND pool_class = ?
         ORDER BY sequence_no ASC, rowid ASC`,
        )
        .all(isbn, poolClass) as BookRecoupmentPoolRecord[],
    );
  }

  async updateBookRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: BookRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<BookRecoupmentPoolRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the 'active' state only. changes = 0 means the pool is absent or
    // already recouped; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE book_recoupment_pools
         SET recouped_cents = ?, status = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(recoupedCents, status, updatedAt, id);
    if (result.changes === 0) return undefined;
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM book_recoupment_pools WHERE id = ?`).get(id) as
        | BookRecoupmentPoolRecord
        | undefined,
    );
  }

  async insertBookRecoupmentApplication(
    row: Omit<BookRecoupmentApplicationRecord, 'id'>,
  ): Promise<BookRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id) — a replayed application is the
    // unique violation, never a double recovery. UNIQUE per
    // (pool_id, recouped_before_cents) — the POSITION lock (the
    // insert-as-lock arbiter).
    const record: BookRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO book_recoupment_applications
           (id, pool_id, pool_class, isbn, source_event_id, recouped_before_cents, applied_cents, remaining_cents, created_at)
         VALUES (@id, @pool_id, @pool_class, @isbn, @source_event_id, @recouped_before_cents, @applied_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listBookRecoupmentApplications(
    poolId: string,
  ): Promise<BookRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order (rowid ASC
    // the strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM book_recoupment_applications
         WHERE pool_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(poolId) as BookRecoupmentApplicationRecord[],
    );
  }

  async insertBookEditorialSplitAccrual(
    row: Omit<BookEditorialSplitAccrualRecord, 'id'>,
  ): Promise<BookEditorialSplitAccrualRecord> {
    // UNIQUE per source_event_id — a replayed accrual is the unique
    // violation, never a double designation.
    const record: BookEditorialSplitAccrualRecord = { ...row, id: randomUUID() };
    const dbRow = {
      ...record,
      allocations: JSON.stringify(record.allocations),
    };
    this.db
      .prepare(
        `INSERT INTO book_editorial_split_accruals
           (id, schedule_id, title_key, scope, source_event_id, basis_cents, allocations, dust_cents, created_at)
         VALUES (@id, @schedule_id, @title_key, @scope, @source_event_id, @basis_cents, @allocations, @dust_cents, @created_at)`,
      )
      .run(dbRow as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listTranslationLocalizationEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      (
        this.db
          .prepare(
            `SELECT * FROM ledger_transactions
         WHERE kind = 'translation_localization_pending' AND status = 'translation_localization_pending'
         ORDER BY created_at DESC
         LIMIT ?`,
          )
          .all(limit) as LedgerTransactionRecord[]
      ).reverse(),
    );
  }

  async settleTranslationLocalizationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the escrow lock state only. changes = 0 means the row is absent or
    // no longer locked; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'translation_localization_pending'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  // --- IP adaptation optioning (PR 21, migration 0025) ---

  async upsertIpOptionAgreement(
    row: Omit<IpOptionAgreementRecord, 'id'>,
  ): Promise<IpOptionAgreementRecord> {
    // One agreement of record per work — INSERT ON CONFLICT replaces the
    // row atomically (the localization-contract precedent).
    const record: IpOptionAgreementRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO ip_option_agreements
           (id, work_id, author_payee_id, author_payee_name, agency_payee_id, agency_payee_name, agency_commission_bps, option_deal_ref, created_at, updated_at)
         VALUES (@id, @work_id, @author_payee_id, @author_payee_name, @agency_payee_id, @agency_payee_name, @agency_commission_bps, @option_deal_ref, @created_at, @updated_at)
         ON CONFLICT(work_id) DO UPDATE SET
           id = excluded.id,
           author_payee_id = excluded.author_payee_id,
           author_payee_name = excluded.author_payee_name,
           agency_payee_id = excluded.agency_payee_id,
           agency_payee_name = excluded.agency_payee_name,
           agency_commission_bps = excluded.agency_commission_bps,
           option_deal_ref = excluded.option_deal_ref,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getIpOptionAgreement(workId: string): Promise<IpOptionAgreementRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM ip_option_agreements WHERE work_id = ?`)
        .get(workId) as IpOptionAgreementRecord | undefined,
    );
  }

  async insertIpOptionAuthorAllocation(
    row: Omit<IpOptionAuthorAllocationRecord, 'id'>,
  ): Promise<IpOptionAuthorAllocationRecord> {
    // UNIQUE on (work_id, payee_id) — a duplicate registration throws the
    // unique violation (the replay surface).
    const record: IpOptionAuthorAllocationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO ip_option_author_allocations
           (id, work_id, payee_id, payee_name, allocation_bps, created_at)
         VALUES (@id, @work_id, @payee_id, @payee_name, @allocation_bps, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listIpOptionAuthorAllocations(workId: string): Promise<IpOptionAuthorAllocationRecord[]> {
    // Insertion order (rowid ASC) — the deterministic author-first
    // reservation order.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ip_option_author_allocations WHERE work_id = ? ORDER BY rowid ASC`,
        )
        .all(workId) as IpOptionAuthorAllocationRecord[],
    );
  }

  async upsertPublishingIpRightsVerification(
    row: Omit<PublishingIpRightsVerificationRecord, 'id'>,
  ): Promise<PublishingIpRightsVerificationRecord> {
    // One verification state per (payee, work) — INSERT ON CONFLICT
    // replaces the row atomically (the studio-KYC precedent, at work scope).
    const record: PublishingIpRightsVerificationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO publishing_ip_rights_verifications
           (id, payee_id, work_id, state, evidence_ref, cleared_at, created_at, updated_at)
         VALUES (@id, @payee_id, @work_id, @state, @evidence_ref, @cleared_at, @created_at, @updated_at)
         ON CONFLICT(payee_id, work_id) DO UPDATE SET
           id = excluded.id,
           state = excluded.state,
           evidence_ref = excluded.evidence_ref,
           cleared_at = excluded.cleared_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getPublishingIpRightsVerification(
    payeeId: string,
    workId: string,
  ): Promise<PublishingIpRightsVerificationRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM publishing_ip_rights_verifications WHERE payee_id = ? AND work_id = ?`,
        )
        .get(payeeId, workId) as PublishingIpRightsVerificationRecord | undefined,
    );
  }

  async upsertVtuberTaxWithholdingVerification(
    row: VtuberTaxWithholdingVerificationRecord,
  ): Promise<VtuberTaxWithholdingVerificationRecord> {
    // One verification state per payee + tax year — INSERT ON CONFLICT
    // replaces the row atomically (a re-verification, the studio-KYC
    // precedent at year scope).
    this.db
      .prepare(
        `INSERT INTO vtuber_tax_withholding_verifications
           (id, payee_id, tax_year, state, tin_verified, w9_on_file, evidence_ref, verified_at, created_at, updated_at)
         VALUES (@id, @payee_id, @tax_year, @state, @tin_verified, @w9_on_file, @evidence_ref, @verified_at, @created_at, @updated_at)
         ON CONFLICT(payee_id, tax_year) DO UPDATE SET
           id = excluded.id,
           state = excluded.state,
           tin_verified = excluded.tin_verified,
           w9_on_file = excluded.w9_on_file,
           evidence_ref = excluded.evidence_ref,
           verified_at = excluded.verified_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(vtuberVerificationToSqliteRow(row) as unknown as Record<string, unknown>);
    const stored = this.db
      .prepare(
        `SELECT * FROM vtuber_tax_withholding_verifications WHERE payee_id = ? AND tax_year = ?`,
      )
      .get(row.payee_id, row.tax_year) as VtuberVerificationSqliteRow;
    return Promise.resolve(vtuberVerificationFromSqliteRow(stored));
  }

  // --- Merch COGS + the brand collaboration waterfall (PR 22, migration 0026) ---

  async insertMerchCogsLot(row: Omit<MerchCogsLotRecord, 'id'>): Promise<MerchCogsLotRecord> {
    // UNIQUE on (sku_id, lot_ref) — a re-registered lot throws the unique
    // violation (the replay surface).
    const record: MerchCogsLotRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_cogs_lots
           (id, sku_id, lot_ref, units_produced, cogs_per_unit_cents, created_at)
         VALUES (@id, @sku_id, @lot_ref, @units_produced, @cogs_per_unit_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listMerchCogsLots(skuId: string): Promise<MerchCogsLotRecord[]> {
    // FIFO order — created_at ASC, then lot_ref ASC (the deterministic tie).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM merch_cogs_lots WHERE sku_id = ? ORDER BY created_at ASC, lot_ref ASC`,
        )
        .all(skuId) as MerchCogsLotRecord[],
    );
  }

  async insertMerchCogsConsumption(
    row: Omit<MerchCogsConsumptionRecord, 'id'>,
  ): Promise<MerchCogsConsumptionRecord> {
    // UNIQUE on (lot_id, source_event_id) — a replayed fulfillment event is
    // the unique violation, never a double amortization. UNIQUE on
    // (lot_id, units_consumed_before) — the insert-as-lock position
    // arbiter: a concurrent consumer that loses the position throws.
    const record: MerchCogsConsumptionRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_cogs_consumptions
           (id, lot_id, source_event_id, units_consumed_before, units_consumed, cogs_per_unit_cents, amortized_cents, created_at)
         VALUES (@id, @lot_id, @source_event_id, @units_consumed_before, @units_consumed, @cogs_per_unit_cents, @amortized_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listMerchCogsConsumptions(lotId: string): Promise<MerchCogsConsumptionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM merch_cogs_consumptions WHERE lot_id = ? ORDER BY units_consumed_before ASC`,
        )
        .all(lotId) as MerchCogsConsumptionRecord[],
    );
  }

  async upsertMerchCollabAgreement(
    row: Omit<MerchCollabAgreementRecord, 'id'>,
  ): Promise<MerchCollabAgreementRecord> {
    // One agreement of record per sku — INSERT ON CONFLICT replaces the
    // row atomically (the option-agreement precedent).
    const record: MerchCollabAgreementRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_collab_agreements
           (id, sku_id, manufacturer_payee_id, manufacturer_payee_name, brand_payee_id, brand_payee_name, artist_payee_id, artist_payee_name, artist_split_bps, blank_sourcing_cents, screen_printing_cents, agreement_ref, created_at, updated_at)
         VALUES (@id, @sku_id, @manufacturer_payee_id, @manufacturer_payee_name, @brand_payee_id, @brand_payee_name, @artist_payee_id, @artist_payee_name, @artist_split_bps, @blank_sourcing_cents, @screen_printing_cents, @agreement_ref, @created_at, @updated_at)
         ON CONFLICT(sku_id) DO UPDATE SET
           id = excluded.id,
           manufacturer_payee_id = excluded.manufacturer_payee_id,
           manufacturer_payee_name = excluded.manufacturer_payee_name,
           brand_payee_id = excluded.brand_payee_id,
           brand_payee_name = excluded.brand_payee_name,
           artist_payee_id = excluded.artist_payee_id,
           artist_payee_name = excluded.artist_payee_name,
           artist_split_bps = excluded.artist_split_bps,
           blank_sourcing_cents = excluded.blank_sourcing_cents,
           screen_printing_cents = excluded.screen_printing_cents,
           agreement_ref = excluded.agreement_ref,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getMerchCollabAgreement(skuId: string): Promise<MerchCollabAgreementRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM merch_collab_agreements WHERE sku_id = ?`)
        .get(skuId) as MerchCollabAgreementRecord | undefined,
    );
  }

  async insertMerchCollabRecoupmentApplication(
    row: Omit<MerchCollabRecoupmentApplicationRecord, 'id'>,
  ): Promise<MerchCollabRecoupmentApplicationRecord> {
    // UNIQUE on (agreement_id, pool_class, source_event_id) — a replayed
    // settlement is the unique violation, never a double recovery. UNIQUE
    // on (agreement_id, pool_class, recouped_before_cents) — the
    // insert-as-lock position arbiter.
    const record: MerchCollabRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_collab_recoupment_applications
           (id, agreement_id, pool_class, source_event_id, recouped_before_cents, applied_cents, remaining_cents, created_at)
         VALUES (@id, @agreement_id, @pool_class, @source_event_id, @recouped_before_cents, @applied_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listMerchCollabRecoupmentApplications(
    agreementId: string,
    poolClass: MerchCollabPoolClass,
  ): Promise<MerchCollabRecoupmentApplicationRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM merch_collab_recoupment_applications
           WHERE agreement_id = ? AND pool_class = ?
           ORDER BY recouped_before_cents ASC`,
        )
        .all(agreementId, poolClass) as MerchCollabRecoupmentApplicationRecord[],
    );
  }

  async upsertMerchDesignerRoyaltyTier(
    row: Omit<MerchDesignerRoyaltyTierRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyTierRecord> {
    // One tier of record per sku — INSERT ON CONFLICT replaces the row
    // atomically (the option-agreement precedent).
    const record: MerchDesignerRoyaltyTierRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_designer_royalty_tiers
           (id, sku_id, designer_payee_id, designer_payee_name, royalty_per_unit_cents, created_at, updated_at)
         VALUES (@id, @sku_id, @designer_payee_id, @designer_payee_name, @royalty_per_unit_cents, @created_at, @updated_at)
         ON CONFLICT(sku_id) DO UPDATE SET
           id = excluded.id,
           designer_payee_id = excluded.designer_payee_id,
           designer_payee_name = excluded.designer_payee_name,
           royalty_per_unit_cents = excluded.royalty_per_unit_cents,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getMerchDesignerRoyaltyTier(
    skuId: string,
  ): Promise<MerchDesignerRoyaltyTierRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM merch_designer_royalty_tiers WHERE sku_id = ?`)
        .get(skuId) as MerchDesignerRoyaltyTierRecord | undefined,
    );
  }

  async insertMerchDesignerRoyaltyBilling(
    row: Omit<MerchDesignerRoyaltyBillingRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyBillingRecord> {
    // UNIQUE on (source_event_id, sku_id) — a replayed fulfillment event is
    // the unique violation, never a double billing. The tier FK guards the
    // billing's precondition.
    const record: MerchDesignerRoyaltyBillingRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_designer_royalty_billings
           (id, source_event_id, sku_id, designer_payee_id, designer_payee_name, units_billed, royalty_per_unit_cents, billed_cents, created_at)
         VALUES (@id, @source_event_id, @sku_id, @designer_payee_id, @designer_payee_name, @units_billed, @royalty_per_unit_cents, @billed_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async insertMerchConsignmentSettlement(
    row: Omit<MerchConsignmentSettlementRecord, 'id'>,
  ): Promise<MerchConsignmentSettlementRecord> {
    // UNIQUE on event_id — a re-shipped report is the unique violation
    // (the replay surface).
    const record: MerchConsignmentSettlementRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_consignment_settlements
           (id, event_id, period, location, sku_id, units_sold, gross_cents, commission_cents, shrinkage_allowance_cents, net_payout_cents, currency, created_at)
         VALUES (@id, @event_id, @period, @location, @sku_id, @units_sold, @gross_cents, @commission_cents, @shrinkage_allowance_cents, @net_payout_cents, @currency, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getMerchConsignmentSettlementByEventId(
    eventId: string,
  ): Promise<MerchConsignmentSettlementRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM merch_consignment_settlements WHERE event_id = ?`)
        .get(eventId) as MerchConsignmentSettlementRecord | undefined,
    );
  }

  // --- Merch returns reserve + fulfillment confirmation (PR 23, migration 0027) ---

  async upsertMerchReturnReservePolicy(
    row: Omit<MerchReturnReservePolicyRecord, 'id'>,
  ): Promise<MerchReturnReservePolicyRecord> {
    // One policy of record per sku — the ON CONFLICT upsert replaces the
    // money terms atomically (the option-agreement precedent).
    const record: MerchReturnReservePolicyRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_return_reserve_policies
           (id, sku_id, reserve_rate_bps, reserve_window_days, beneficiary_payee_id, beneficiary_payee_name, created_at, updated_at)
         VALUES (@id, @sku_id, @reserve_rate_bps, @reserve_window_days, @beneficiary_payee_id, @beneficiary_payee_name, @created_at, @updated_at)
         ON CONFLICT (sku_id) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           reserve_window_days = excluded.reserve_window_days,
           beneficiary_payee_id = excluded.beneficiary_payee_id,
           beneficiary_payee_name = excluded.beneficiary_payee_name,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getMerchReturnReservePolicy(
    skuId: string,
  ): Promise<MerchReturnReservePolicyRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM merch_return_reserve_policies WHERE sku_id = ?`)
        .get(skuId) as MerchReturnReservePolicyRecord | undefined,
    );
  }

  async insertMerchReserveDrawdown(
    row: Omit<MerchReserveDrawdownRecord, 'id'>,
  ): Promise<MerchReserveDrawdownRecord> {
    // UNIQUE on (reserve_ledger_id, source_event_id) — a re-shipped
    // return/chargeback event is the unique violation, never a double
    // drawdown. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
    // insert-as-lock position arbiter: a concurrent drawdown that loses
    // the position throws.
    const record: MerchReserveDrawdownRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_reserve_drawdowns
           (id, reserve_ledger_id, drawdown_class, source_event_id, drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (@id, @reserve_ledger_id, @drawdown_class, @source_event_id, @drawn_before_cents, @drawn_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listMerchReserveDrawdowns(reserveLedgerId: string): Promise<MerchReserveDrawdownRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM merch_reserve_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY drawn_before_cents ASC`,
        )
        .all(reserveLedgerId) as MerchReserveDrawdownRecord[],
    );
  }

  async insertMerchFulfillmentTracking(
    row: Omit<MerchFulfillmentTrackingRecord, 'id'>,
  ): Promise<MerchFulfillmentTrackingRecord> {
    // UNIQUE on (fulfillment_event_id, tracking_number, tracking_state) — a
    // re-shipped tracking event is the unique violation, never a double
    // record.
    const record: MerchFulfillmentTrackingRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO merch_fulfillment_trackings
           (id, fulfillment_event_id, tracking_number, tracking_state, carrier, delivered_at, created_at)
         VALUES (@id, @fulfillment_event_id, @tracking_number, @tracking_state, @carrier, @delivered_at, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listMerchFulfillmentTrackings(
    fulfillmentEventId: string,
  ): Promise<MerchFulfillmentTrackingRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM merch_fulfillment_trackings
         WHERE fulfillment_event_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(fulfillmentEventId) as MerchFulfillmentTrackingRecord[],
    );
  }

  async listMerchReturnsReserveCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'merch_returns_reserve' AND status = 'merch_returns_reserve'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settleMerchReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS. changes = 0
    // means the row is absent or no longer held; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'merch_returns_reserve'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  async getVtuberTaxWithholdingVerification(
    payeeId: string,
    taxYear: number,
  ): Promise<VtuberTaxWithholdingVerificationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM vtuber_tax_withholding_verifications WHERE payee_id = ? AND tax_year = ?`,
      )
      .get(payeeId, taxYear) as VtuberVerificationSqliteRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : vtuberVerificationFromSqliteRow(row),
    );
  }

  async insertVtuberTechSetupAmortizationSchedule(
    row: Omit<VtuberTechSetupAmortizationScheduleRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord> {
    // UNIQUE on schedule_ref — one schedule per contract reference, ever; a
    // duplicate insert throws (better-sqlite3 surfaces the constraint
    // violation).
    const record: VtuberTechSetupAmortizationScheduleRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO vtuber_tech_setup_amortization_schedules
           (id, schedule_ref, agency_payee_id, description, total_cost_cents, amortization_periods, created_at)
         VALUES (@id, @schedule_ref, @agency_payee_id, @description, @total_cost_cents, @amortization_periods, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getVtuberTechSetupAmortizationScheduleByRef(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationScheduleRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM vtuber_tech_setup_amortization_schedules WHERE schedule_ref = ?`,
        )
        .get(scheduleRef) as VtuberTechSetupAmortizationScheduleRecord | undefined,
    );
  }

  async insertVtuberTechSetupAmortizationLine(
    row: Omit<VtuberTechSetupAmortizationLineRecord, 'id'>,
  ): Promise<VtuberTechSetupAmortizationLineRecord> {
    // UNIQUE on (schedule_ref, line_index) — the insert-as-lock consume
    // arbiter; a concurrent consume of the same line throws (the PR 12
    // accumulator discipline) and the caller re-derives the next line.
    const record: VtuberTechSetupAmortizationLineRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO vtuber_tech_setup_amortization_lines
           (id, schedule_ref, line_index, line_cents, deducted_at, created_at)
         VALUES (@id, @schedule_ref, @line_index, @line_cents, @deducted_at, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listVtuberTechSetupAmortizationLines(
    scheduleRef: string,
  ): Promise<VtuberTechSetupAmortizationLineRecord[]> {
    // Line index order — the deterministic consumption order (rowid ASC is
    // the strict tiebreak, though the unique constraint precludes ties).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM vtuber_tech_setup_amortization_lines
         WHERE schedule_ref = ?
         ORDER BY line_index ASC, rowid ASC`,
        )
        .all(scheduleRef) as VtuberTechSetupAmortizationLineRecord[],
    );
  }


  // --- Derivative asset royalty cascade (0021, PR 16) ---

  async insertDerivativeRoyaltyEdge(
    row: Omit<DerivativeRoyaltyEdgeRecord, 'id'>,
  ): Promise<DerivativeRoyaltyEdgeRecord> {
    // UNIQUE on (asset_id, parent_asset_id, upstream_creator_payee_id) — a
    // duplicate registration throws (better-sqlite3 surfaces the constraint
    // violation — the replay surface).
    const record: DerivativeRoyaltyEdgeRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO derivative_royalty_edges
           (id, asset_id, parent_asset_id, upstream_creator_payee_id, upstream_creator_payee_name, royalty_bps, created_at)
         VALUES (@id, @asset_id, @parent_asset_id, @upstream_creator_payee_id, @upstream_creator_payee_name, @royalty_bps, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getDerivativeRoyaltyEdgesByAsset(assetId: string): Promise<DerivativeRoyaltyEdgeRecord[]> {
    // Insertion order (rowid ASC) — the deterministic reservation order.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM derivative_royalty_edges
         WHERE asset_id = ?
         ORDER BY rowid ASC`,
        )
        .all(assetId) as DerivativeRoyaltyEdgeRecord[],
    );
  }

  async insertSampleClearanceEdge(
    row: Omit<SampleClearanceEdgeRecord, 'id'>,
  ): Promise<SampleClearanceEdgeRecord> {
    // UNIQUE on (work_id, parent_composition_id, rights_holder_payee_id,
    // rights_type) — a duplicate registration throws (better-sqlite3
    // surfaces the constraint violation — the replay surface). The same
    // (work, parent) pair on BOTH sides of the rights separation is two
    // distinct contracts, not a duplicate.
    const record: SampleClearanceEdgeRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO sample_clearance_edges
           (id, work_id, parent_composition_id, rights_type, rights_holder_payee_id, rights_holder_payee_name, license_bps, clearance_agreement_ref, created_at)
         VALUES (@id, @work_id, @parent_composition_id, @rights_type, @rights_holder_payee_id, @rights_holder_payee_name, @license_bps, @clearance_agreement_ref, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getSampleClearanceEdgesByWork(workId: string): Promise<SampleClearanceEdgeRecord[]> {
    // Insertion order (rowid ASC) — the deterministic reservation order.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM sample_clearance_edges
         WHERE work_id = ?
         ORDER BY rowid ASC`,
        )
        .all(workId) as SampleClearanceEdgeRecord[],
    );
  }

  async insertCompositionPublisher(
    row: Omit<CompositionPublisherRecord, 'id'>,
  ): Promise<CompositionPublisherRecord> {
    // UNIQUE on (composition_id, publisher_payee_id) — a duplicate
    // registration throws (better-sqlite3 surfaces the constraint
    // violation — the replay surface).
    const record: CompositionPublisherRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO composition_publishers
           (id, composition_id, publisher_payee_id, publisher_payee_name, share_bps, created_at)
         VALUES (@id, @composition_id, @publisher_payee_id, @publisher_payee_name, @share_bps, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listCompositionPublishers(compositionId: string): Promise<CompositionPublisherRecord[]> {
    // Insertion order (rowid ASC) — the deterministic routing order.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM composition_publishers
         WHERE composition_id = ?
         ORDER BY rowid ASC`,
        )
        .all(compositionId) as CompositionPublisherRecord[],
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
    // rows never wrote a `podcast:imp:` row at all.
    const rows = this.db
      .prepare(`SELECT event_id, verified_impressions, raw_payload FROM match_queue`)
      .all() as { event_id: string; verified_impressions: number | null; raw_payload: string }[];
    let total = 0;
    for (const row of rows) {
      if (!eventIdPrefixes.some((prefix) => row.event_id.startsWith(prefix))) {
        continue;
      }
      if (podcastEpisodeIdOfQueueRow(row.raw_payload) !== episodeId) continue;
      total += row.verified_impressions ?? 0;
    }
    return Promise.resolve(total);
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

  async applyVaultDelta(input: VaultDeltaInput): Promise<ApplyVaultDeltaResult> {
    // The atomic vault mutation (migration 0009, H1): SQLite's synchronous
    // transaction makes the guarded UPDATE the same single-statement move
    // the Supabase RPC performs, with identical outcome semantics.
    const min = input.min_balances ?? {};
    const minAvailable = min.available_balance ?? null;
    const minPending = min.pending_balance ?? null;
    const minReserve = min.reserve_balance ?? null;
    const current = this.db
      .prepare(`SELECT * FROM sovereign_vaults WHERE payee_id = ?`)
      .get(input.payee_id) as SovereignVaultRecord | undefined;

    if (current === undefined) {
      if (!input.create_if_missing) {
        return { outcome: 'not_found' };
      }
      // A vault can only be minted from nothing; every negative leg is a
      // refused move, and floors apply to the minted balances as well.
      if (
        input.delta.available_balance < 0 ||
        input.delta.pending_balance < 0 ||
        input.delta.reserve_balance < 0 ||
        (minAvailable !== null && input.delta.available_balance < minAvailable) ||
        (minPending !== null && input.delta.pending_balance < minPending) ||
        (minReserve !== null && input.delta.reserve_balance < minReserve)
      ) {
        return { outcome: 'guard_failed' };
      }
      const minted: SovereignVaultRecord = {
        payee_id: input.payee_id,
        payee_name: input.payee_name,
        available_balance: input.delta.available_balance,
        pending_balance: input.delta.pending_balance,
        reserve_balance: input.delta.reserve_balance,
        updated_at: input.updated_at,
      };
      this.db
        .prepare(
          `INSERT INTO sovereign_vaults (
             payee_id, payee_name, available_balance, pending_balance,
             reserve_balance, updated_at
           ) VALUES (
             @payee_id, @payee_name, @available_balance, @pending_balance,
             @reserve_balance, @updated_at
           )`,
        )
        .run(minted);
      return { outcome: 'applied', vault: minted };
    }

    // Guarded UPDATE: the sufficiency floors live in the WHERE clause of the
    // same statement that moves the money.
    const result = this.db
      .prepare(
        `UPDATE sovereign_vaults SET
           available_balance = available_balance + @available_delta,
           pending_balance = pending_balance + @pending_delta,
           reserve_balance = reserve_balance + @reserve_delta,
           payee_name = @payee_name,
           updated_at = @updated_at
         WHERE payee_id = @payee_id
           AND (@min_available IS NULL OR available_balance + @available_delta >= @min_available)
           AND (@min_pending IS NULL OR pending_balance + @pending_delta >= @min_pending)
           AND (@min_reserve IS NULL OR reserve_balance + @reserve_delta >= @min_reserve)`,
      )
      .run({
        available_delta: input.delta.available_balance,
        pending_delta: input.delta.pending_balance,
        reserve_delta: input.delta.reserve_balance,
        payee_name: input.payee_name,
        updated_at: input.updated_at,
        payee_id: input.payee_id,
        min_available: minAvailable,
        min_pending: minPending,
        min_reserve: minReserve,
      });
    if ((result.changes ?? 0) === 0) {
      // The row existed a moment ago (synchronous driver — no interleaving),
      // so zero changes can only mean a floor refused the move.
      return { outcome: 'guard_failed' };
    }
    return {
      outcome: 'applied',
      vault: this.db
        .prepare(`SELECT * FROM sovereign_vaults WHERE payee_id = ?`)
        .get(input.payee_id) as SovereignVaultRecord,
    };
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

  async updatePayoutReversal(
    id: string,
    patch: Pick<PayoutReversalRecord, 'journal_id' | 'ledger_transaction_id'>,
  ): Promise<PayoutReversalRecord | undefined> {
    this.db
      .prepare(
        `UPDATE payout_reversals
            SET journal_id = @journal_id, ledger_transaction_id = @ledger_transaction_id
          WHERE id = @id`,
      )
      .run({ id, ...patch });
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM payout_reversals WHERE id = ?`).get(id) as
        | PayoutReversalRecord
        | undefined,
    );
  }

  async deletePayoutReversal(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM payout_reversals WHERE id = ?`).run(id);
    return Promise.resolve();
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

  // --- SDK collection surfaces (migration 0007) ---

  async upsertClearance(row: MulClearanceRecord): Promise<MulClearanceRecord> {
    this.db
      .prepare(
        `INSERT INTO mul_clearances (
           asset_cbt_code, state, licensee, territory, term_start, term_end, updated_at
         ) VALUES (
           @asset_cbt_code, @state, @licensee, @territory, @term_start, @term_end, @updated_at
         )
         ON CONFLICT(asset_cbt_code) DO UPDATE SET
           state = excluded.state,
           licensee = excluded.licensee,
           territory = excluded.territory,
           term_start = excluded.term_start,
           term_end = excluded.term_end,
           updated_at = excluded.updated_at`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async getClearanceForAsset(assetCbtCode: string): Promise<MulClearanceRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM mul_clearances WHERE asset_cbt_code = ?`)
        .get(assetCbtCode) as MulClearanceRecord | undefined,
    );
  }

  async insertClearanceTransition(
    row: Omit<MulClearanceTransitionRecord, 'id'>,
  ): Promise<MulClearanceTransitionRecord> {
    const record: MulClearanceTransitionRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO mul_clearance_transitions (
           id, asset_cbt_code, from_state, to_state, note, created_at
         ) VALUES (
           @id, @asset_cbt_code, @from_state, @to_state, @note, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async listClearanceTransitions(
    assetCbtCode: string,
  ): Promise<MulClearanceTransitionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM mul_clearance_transitions
           WHERE asset_cbt_code = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(assetCbtCode) as MulClearanceTransitionRecord[],
    );
  }

  async insertMatchQueueEntry(row: Omit<MatchQueueRecord, 'id'>): Promise<MatchQueueRecord> {
    const record: MatchQueueRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO match_queue (
           id, event_id, status, reason, rights_pipeline, rights_type, tier_level,
           statement_source_type, revenue_channel, ad_slot, verified_impressions,
           network_sold, sale_type, virtual_currency_code, virtual_amount,
           exchange_rate, engine_royalty_micros, platform_commission_micros,
           parent_asset_id, stream_platform, alert_type, revenue_basis,
           prize_pool_batch, parent_composition_id, is_cover_version,
           territory_code, foreign_tax_withheld, rss_feed_id, ad_placement_type,
           format_type, language_code, sku_id, cogs_per_unit_micros,
           usage_unit, usage_quantity, isbn, country_code,
           ai_model_id, dataset_attribution_weight, artwork_id,
           provenance_hash, jurisdiction_code, production_id,
           venue_id, show_date, license_class, license_id,
           category_code, territory_iso, athlete_id,
           school_id, state_jurisdiction_code, zone_code,
           spatial_footprint_sqft, trainer_id, program_id,
           studio_franchise_code, chef_id, recipe_id,
           ghost_kitchen_location_id, stylist_id, salon_location_id,
           protocol_id, developer_id, api_endpoint_id,
           sdk_package_hash, patent_family_id, sep_pool_code,
           device_imei_mac, parcel_id, well_meter_id,
           gpu_cluster_hash, nil_contract_id, athlete_glan,
           venue_gln, league_rights_code, turnstile_scan_hash,
           resolved_chain, resolved_identifiers,
           unclaimed_identifier_hold, identifier_hold_reason,
           source, platform, territory,
           period, currency, gross_micros, identifiers_json, raw_payload,
           matched_cbt_code, resolved_at, created_at
         ) VALUES (
           @id, @event_id, @status, @reason, @rights_pipeline, @rights_type, @tier_level,
           @statement_source_type, @revenue_channel, @ad_slot, @verified_impressions,
           @network_sold, @sale_type, @virtual_currency_code, @virtual_amount,
           @exchange_rate, @engine_royalty_micros, @platform_commission_micros,
           @parent_asset_id, @stream_platform, @alert_type, @revenue_basis,
           @prize_pool_batch, @parent_composition_id, @is_cover_version,
           @territory_code, @foreign_tax_withheld, @rss_feed_id, @ad_placement_type,
           @format_type, @language_code, @sku_id, @cogs_per_unit_micros,
           @usage_unit, @usage_quantity, @isbn, @country_code,
           @ai_model_id, @dataset_attribution_weight, @artwork_id,
           @provenance_hash, @jurisdiction_code, @production_id,
           @venue_id, @show_date, @license_class, @license_id,
           @category_code, @territory_iso, @athlete_id,
           @school_id, @state_jurisdiction_code, @zone_code,
           @spatial_footprint_sqft, @trainer_id, @program_id,
           @studio_franchise_code, @chef_id, @recipe_id,
           @ghost_kitchen_location_id, @stylist_id, @salon_location_id,
           @protocol_id, @developer_id, @api_endpoint_id,
           @sdk_package_hash, @patent_family_id, @sep_pool_code,
           @device_imei_mac, @parcel_id, @well_meter_id,
           @gpu_cluster_hash, @nil_contract_id, @athlete_glan,
           @venue_gln, @league_rights_code, @turnstile_scan_hash,
           @resolved_chain, @resolved_identifiers,
           @unclaimed_identifier_hold, @identifier_hold_reason,
           @source, @platform, @territory,
           @period, @currency, @gross_micros, @identifiers_json, @raw_payload,
           @matched_cbt_code, @resolved_at, @created_at
         )`,
      )
      .run(matchQueueToSqliteRow(record));
    return Promise.resolve(record);
  }

  async getMatchQueueEntry(id: string): Promise<MatchQueueRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM match_queue WHERE id = ?`)
      .get(id) as MatchQueueSqliteRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : matchQueueFromSqliteRow(row),
    );
  }

  async getMatchQueueEntryByEventId(
    eventId: string,
  ): Promise<MatchQueueRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM match_queue WHERE event_id = ?`)
      .get(eventId) as MatchQueueSqliteRow | undefined;
    return Promise.resolve(
      row === undefined ? undefined : matchQueueFromSqliteRow(row),
    );
  }

  async listMatchQueueEntries(
    status?: MatchQueueRecord['status'],
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<MatchQueueRecord[]> {
    return Promise.resolve(
      (status === undefined
        ? this.db
            .prepare(
              `SELECT * FROM match_queue
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?`,
            )
            .all(limit)
        : this.db
            .prepare(
              `SELECT * FROM match_queue
               WHERE status = ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?`,
            )
            .all(status, limit))
        .map((row) => matchQueueFromSqliteRow(row as MatchQueueSqliteRow)),
    );
  }

  async resolveMatchQueueEntry(
    id: string,
    resolution: MatchQueueResolution,
  ): Promise<MatchQueueRecord | undefined> {
    const resolvedAt = new Date().toISOString();
    const patch =
      resolution.status === 'matched'
        ? { status: 'matched' as const, matched_cbt_code: resolution.cbtCode }
        : { status: 'discarded' as const, matched_cbt_code: null };
    const result = this.db
      .prepare(
        `UPDATE match_queue
         SET status = @status, matched_cbt_code = @matched_cbt_code, resolved_at = @resolved_at
         WHERE id = @id`,
      )
      .run({ ...patch, resolved_at: resolvedAt, id });
    if (result.changes === 0) return undefined;
    return this.getMatchQueueEntry(id);
  }

  async insertStatementIngest(
    row: Omit<StatementIngestRecord, 'id'>,
  ): Promise<StatementIngestRecord> {
    const record: StatementIngestRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO statement_ingests (
           id, format, source, file_name, content, status, event_count, error, created_at
         ) VALUES (
           @id, @format, @source, @file_name, @content, @status, @event_count, @error, @created_at
         )`,
      )
      .run(record);
    return Promise.resolve(record);
  }

  async getStatementIngest(id: string): Promise<StatementIngestRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM statement_ingests WHERE id = ?`)
        .get(id) as StatementIngestRecord | undefined,
    );
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
    this.db
      .prepare(
        `INSERT INTO royalty_recon_jobs (
           id, status, source, ingest_id, requested_by, engine, attempts,
           error, result, claimed_at, started_at, completed_at, created_at, updated_at
         ) VALUES (
           @id, @status, @source, @ingest_id, @requested_by, @engine, @attempts,
           @error, @result, @claimed_at, @started_at, @completed_at, @created_at, @updated_at
         )`,
      )
      .run(reconJobToDbRow(record));
    return Promise.resolve(record);
  }

  async getReconJob(id: string): Promise<RoyaltyReconJobRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM royalty_recon_jobs WHERE id = ?`)
      .get(id) as ReconJobDbRow | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve(reconJobFromDbRow(row));
  }

  async claimReconJob(
    now: Date = new Date(),
    engine: string | null = null,
  ): Promise<RoyaltyReconJobRecord | undefined> {
    const nowIso = now.toISOString();
    const staleCutoff = new Date(now.getTime() - RECON_STALE_CLAIM_MS).toISOString();
    // BEGIN IMMEDIATE: the candidate scan and the transition commit as one
    // write transaction — the SQLite equivalent of the claim RPC's
    // FOR UPDATE SKIP LOCKED serialization (the canon's concurrency guard).
    const claim = this.db.transaction(
      (stamp: string, cutoff: string, claimEngine: string | null): ReconJobDbRow | undefined => {
        const candidate = this.db
          .prepare(
            `SELECT id FROM royalty_recon_jobs
             WHERE status = 'pending'
                OR (status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < ?)
             ORDER BY created_at, rowid
             LIMIT 1`,
          )
          .get(cutoff) as { id: string } | undefined;
        if (candidate === undefined) return undefined;
        this.db
          .prepare(
            `UPDATE royalty_recon_jobs
             SET status = 'processing',
                 engine = ?,
                 claimed_at = ?,
                 started_at = COALESCE(started_at, ?),
                 attempts = attempts + 1,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(claimEngine, stamp, stamp, stamp, candidate.id);
        return this.db
          .prepare(`SELECT * FROM royalty_recon_jobs WHERE id = ?`)
          .get(candidate.id) as ReconJobDbRow | undefined;
      },
    );
    const row = claim.immediate(nowIso, staleCutoff, engine);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve(reconJobFromDbRow(row));
  }

  async completeReconJob(
    id: string,
    result: ReconJobResult,
  ): Promise<RoyaltyReconJobRecord | undefined> {
    const job = await this.getReconJob(id);
    if (job === undefined) return Promise.resolve(undefined);
    if (isTerminalReconJob(job)) return Promise.resolve(job); // replay — untouched
    if (job.status !== 'pending' && job.status !== 'processing') return Promise.resolve(job);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE royalty_recon_jobs
         SET status = 'completed', result = ?, error = NULL,
             completed_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'processing')`,
      )
      .run(JSON.stringify(result), now, now, id);
    return this.getReconJob(id);
  }

  async failReconJob(id: string, error: string): Promise<RoyaltyReconJobRecord | undefined> {
    const job = await this.getReconJob(id);
    if (job === undefined) return Promise.resolve(undefined);
    if (isTerminalReconJob(job)) return Promise.resolve(job); // replay — untouched
    if (job.status !== 'pending' && job.status !== 'processing') return Promise.resolve(job);
    const now = new Date().toISOString();
    if (job.attempts >= RECON_MAX_ATTEMPTS) {
      this.db
        .prepare(
          `UPDATE royalty_recon_jobs
           SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'processing')`,
        )
        .run(error, now, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE royalty_recon_jobs
           SET status = 'pending', error = ?, claimed_at = NULL, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'processing')`,
        )
        .run(error, now, id);
    }
    return this.getReconJob(id);
  }

  // --- The UCT credential vault (migration 0013, PR 5) — every statement
  // is holder-scoped first: a foreign (holder, id) pair matches no row, so
  // it is indistinguishable from an unknown id on this backend too.

  async createDistributorConnection(
    input: DistributorConnectionInput,
  ): Promise<DistributorConnectionUpsert> {
    const now = new Date().toISOString();
    // Reconnect = rotate: one ACTIVE row per (holder, distributor), the
    // SQLite equivalent of the migration's partial unique index.
    const active = this.db
      .prepare(
        `SELECT * FROM distributor_connections
         WHERE holder_id = ? AND distributor = ? AND status = 'connected'`,
      )
      .get(input.holder_id, input.distributor) as DistributorConnectionRow | undefined;
    if (active !== undefined) {
      this.db
        .prepare(
          `UPDATE distributor_connections
           SET username_encrypted = ?, password_encrypted = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.username_encrypted, input.password_encrypted, now, active.id);
      return Promise.resolve({
        connection: this.readDistributorConnection(active.id) as DistributorConnectionRecord,
        rotated: true,
      });
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
    this.db
      .prepare(
        `INSERT INTO distributor_connections (
           id, holder_id, distributor, status,
           username_encrypted, password_encrypted,
           last_verified_at, last_error, created_at, updated_at
         ) VALUES (
           @id, @holder_id, @distributor, @status,
           @username_encrypted, @password_encrypted,
           @last_verified_at, @last_error, @created_at, @updated_at
         )`,
      )
      .run(record);
    return Promise.resolve({ connection: record, rotated: false });
  }

  async listDistributorConnections(holderId: string): Promise<DistributorConnectionRecord[]> {
    // Newest first — rowid DESC is this backend's insertion_order.
    const rows = this.db
      .prepare(
        `SELECT * FROM distributor_connections WHERE holder_id = ? ORDER BY rowid DESC`,
      )
      .all(holderId) as DistributorConnectionRow[];
    return Promise.resolve(rows.map((row) => ({ ...row })));
  }

  async getDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined> {
    return Promise.resolve(this.readDistributorConnection(id, holderId));
  }

  async disconnectDistributorConnection(
    holderId: string,
    id: string,
  ): Promise<DistributorConnectionRecord | undefined> {
    const connection = this.readDistributorConnection(id, holderId);
    if (connection === undefined) return Promise.resolve(undefined);
    if (connection.status === 'disconnected') return Promise.resolve(connection); // replay
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE distributor_connections
         SET status = 'disconnected', updated_at = ?
         WHERE id = ? AND holder_id = ?`,
      )
      .run(now, id, holderId);
    return Promise.resolve(this.readDistributorConnection(id, holderId));
  }

  async listActiveDistributorConnections(): Promise<DistributorConnectionRecord[]> {
    // Oldest insertion first — rowid ASC is this backend's insertion_order.
    const rows = this.db
      .prepare(
        `SELECT * FROM distributor_connections WHERE status = 'connected' ORDER BY rowid ASC`,
      )
      .all() as DistributorConnectionRow[];
    return Promise.resolve(rows.map((row) => ({ ...row })));
  }

  async markDistributorTraversal(
    id: string,
    outcome: DistributorTraversalOutcome,
  ): Promise<DistributorConnectionRecord | undefined> {
    const connection = this.readDistributorConnection(id);
    if (connection === undefined) return Promise.resolve(undefined);
    const now = new Date().toISOString();
    // Success verifies (and clears the stale error); failure records the
    // honest reason and never touches last_verified_at. Neither ever flips
    // status — disconnect is the holder's explicit act.
    this.db
      .prepare(
        `UPDATE distributor_connections
         SET last_verified_at = COALESCE(?, last_verified_at),
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run('verifiedAt' in outcome ? outcome.verifiedAt : null, 'error' in outcome ? outcome.error : null, now, id);
    return Promise.resolve(this.readDistributorConnection(id));
  }

  /** Point lookup — holderId omitted only for the rotate path's own re-read. */
  private readDistributorConnection(id: string, holderId?: string): DistributorConnectionRecord | undefined {
    const row = (
      holderId === undefined
        ? this.db.prepare(`SELECT * FROM distributor_connections WHERE id = ?`).get(id)
        : this.db
            .prepare(`SELECT * FROM distributor_connections WHERE id = ? AND holder_id = ?`)
            .get(id, holderId)
    ) as DistributorConnectionRow | undefined;
    return row === undefined ? undefined : { ...row };
  }

  // --- Clearinghouse kernel + Sync Library seams (migration 0008) ---

  async getCreatorUct(creatorId: string): Promise<CreatorUctRecord | undefined> {
    const row = this.db
      .prepare(`SELECT creator_id, uct_number, isni FROM creator_ucts WHERE creator_id = ?`)
      .get(creatorId) as { creator_id: string; uct_number: string; isni: string | null } | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      creatorId: row.creator_id,
      uctNumber: row.uct_number,
      isni: row.isni,
    });
  }

  /**
   * Local-dev/test seed for the identity projection — NOT on the Store
   * interface (production reads the signup registry holder entries; see
   * SupabaseStore.getCreatorUct).
   */
  async upsertCreatorUct(row: CreatorUctRecord): Promise<CreatorUctRecord> {
    this.db
      .prepare(
        `INSERT INTO creator_ucts (creator_id, uct_number, isni) VALUES (@creatorId, @uctNumber, @isni)
         ON CONFLICT(creator_id) DO UPDATE SET
           uct_number = excluded.uct_number,
           isni = excluded.isni`,
      )
      .run(row);
    return Promise.resolve(row);
  }

  async upsertSyncCatalogItem(
    row: Omit<SyncCatalogItemRecord, 'updated_at'> & { updated_at?: string },
  ): Promise<SyncCatalogItemRecord> {
    const record: SyncCatalogItemRecord = {
      ...row,
      updated_at: row.updated_at ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sync_catalog_items (
           cbt_code, is_pre_cleared, sync_fee_cents, genre, bpm, updated_at
         ) VALUES (
           @cbt_code, @is_pre_cleared, @sync_fee_cents, @genre, @bpm, @updated_at
         )
         ON CONFLICT(cbt_code) DO UPDATE SET
           is_pre_cleared = excluded.is_pre_cleared,
           sync_fee_cents = excluded.sync_fee_cents,
           genre = excluded.genre,
           bpm = excluded.bpm,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...record,
        is_pre_cleared: record.is_pre_cleared ? 1 : 0,
      });
    return Promise.resolve(record);
  }

  async getSyncCatalogItem(cbtCode: string): Promise<SyncCatalogItemRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT cbt_code, is_pre_cleared, sync_fee_cents, genre, bpm, updated_at
         FROM sync_catalog_items WHERE cbt_code = ?`,
      )
      .get(cbtCode) as
      | {
          cbt_code: string;
          is_pre_cleared: number;
          sync_fee_cents: number;
          genre: string;
          bpm: number | null;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve(this.syncCatalogRecordFromRow(row));
  }

  async listSyncCatalogItems(): Promise<SyncCatalogItemRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT cbt_code, is_pre_cleared, sync_fee_cents, genre, bpm, updated_at
         FROM sync_catalog_items ORDER BY cbt_code ASC`,
      )
      .all() as Array<{
      cbt_code: string;
      is_pre_cleared: number;
      sync_fee_cents: number;
      genre: string;
      bpm: number | null;
      updated_at: string;
    }>;
    return Promise.resolve(rows.map((row) => this.syncCatalogRecordFromRow(row)));
  }

  /** SQLite keeps the flag as INTEGER 0/1; the record is a boolean. */
  private syncCatalogRecordFromRow(row: {
    cbt_code: string;
    is_pre_cleared: number;
    sync_fee_cents: number;
    genre: string;
    bpm: number | null;
    updated_at: string;
  }): SyncCatalogItemRecord {
    return { ...row, is_pre_cleared: row.is_pre_cleared === 1 };
  }

  async insertSyncLicensePurchase(
    row: Omit<SyncLicensePurchaseRecord, 'id' | 'created_at'>,
  ): Promise<SyncLicensePurchaseRecord> {
    const record: SyncLicensePurchaseRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    // better-sqlite3 surfaces the UNIQUE violation as a thrown
    // "UNIQUE constraint failed: …" error — the canonical failure mode the
    // lane catches to recover the idempotent existing row. It propagates
    // unmodified from here — never swallowed.
    this.db
      .prepare(
        `INSERT INTO sync_license_purchases (
           id, cvt_asset_tag, buyer_uct, license_type, fee_paid_cents,
           cbt_settlement_stamp, split_run_id, metadata, created_at
         ) VALUES (
           @id, @cvt_asset_tag, @buyer_uct, @license_type, @fee_paid_cents,
           @cbt_settlement_stamp, @split_run_id, @metadata, @created_at
         )`,
      )
      .run({ ...record, metadata: JSON.stringify(record.metadata) });
    return Promise.resolve(record);
  }

  async getSyncLicensePurchaseByStamp(
    stamp: string,
  ): Promise<SyncLicensePurchaseRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sync_license_purchases WHERE cbt_settlement_stamp = ?`)
      .get(stamp) as
      | (Omit<SyncLicensePurchaseRecord, 'metadata'> & { metadata: string })
      | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      ...row,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    });
  }

  // --- Territory settlement seam (spec art_qNu4T32F) ---

  /**
   * The SDK-settled tier credits' territory projection — SDK-settled ONLY
   * (the transaction_type gate is in the query), oldest first with the
   * transaction_id tiebreak the other backends order by.
   */
  async listTerritorySettlements(): Promise<TerritorySettlementRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT transaction_id, rights_holder_id, amount_cents, transaction_type, metadata, created_at
         FROM universal_royalty_ledger
         WHERE transaction_type = ?
         ORDER BY created_at ASC, transaction_id ASC`,
      )
      .all(SDK_SETTLEMENT_TRANSACTION_TYPE) as UniversalRoyaltyLedgerRow[];
    return Promise.resolve(rows.map(territorySettlementOfRow));
  }

  /**
   * Fixture affordance for the tier ledger — the local mirror of the wire's
   * raw-SQL INSERT (covnant-sdk/src/engine/wire.ts settleEvent). NOT on the
   * Store contract: production writes go through the wire, and this method
   * exists so tests can seat rows exactly as the wire writes them without
   * PostgreSQL. amount_cents is stored as text (the wire's discipline).
   */
  async insertUniversalRoyaltyLedgerRow(row: UniversalRoyaltyLedgerRow): Promise<UniversalRoyaltyLedgerRow> {
    this.db
      .prepare(
        `INSERT INTO universal_royalty_ledger
           (transaction_id, rights_holder_id, amount_cents, transaction_type, reference_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.transaction_id,
        row.rights_holder_id,
        String(row.amount_cents),
        row.transaction_type,
        row.reference_id,
        row.metadata === null
          ? null
          : typeof row.metadata === 'string'
            ? row.metadata // pre-serialized — never double-encoded
            : JSON.stringify(row.metadata),
        row.created_at,
      );
    return Promise.resolve(row);
  }

  // --- Operations back-office seam (spec art_Eis55ifL) ---

  /**
   * The statement-ingest provenance list — newest first, rowid as the
   * insertion-order tiebreak (the local mirror of the Supabase pair),
   * bounded by limit.
   */
  async listStatementIngests(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<StatementIngestRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM statement_ingests
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(limit) as StatementIngestRecord[],
    );
  }

  /**
   * admin_action_log is a Supabase-production surface (migration 0005, RLS
   * service-role-only) with no local mirror table — the honest read is
   * empty, never fabricated rows. The interface's limit has nothing to
   * bound here.
   */
  async listAdminActions(): Promise<AdminActionRecord[]> {
    return Promise.resolve([]);
  }
}

/** Default DB location: data/atxlive.db under the project root (gitignored). */
export function defaultDbPath(): string {
  return process.env.ATXLIVE_DB_PATH ?? path.join(process.cwd(), 'data', 'atxlive.db');
}
