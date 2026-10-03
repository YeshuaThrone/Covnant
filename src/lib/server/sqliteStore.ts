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
  MerchDesignerRoyaltyBillingRecord,
  MerchConsignmentSettlementRecord,
  MerchReturnReservePolicyRecord,
  MerchReserveDrawdownRecord,
  MerchFulfillmentTrackingRecord,
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
  LicensingAuditReserveDrawdownRecord,
  LicensingAuditReservePolicyRecord,
  LicensingAuditReserveReconciliationRecord,
  LicensingMgCommitmentRecord,
  LicensingMgRecoupmentApplicationRecord,
  LicensingMgTermCloseRecord,
  LicensingPayoutGateStateRecord,
  LicensingRoyaltyDealRecord,
  LicensingRoyaltyApplicationRecord,
  LicensingTierSlice,
  LicensingTierSpec,
  LicensingTreatyRateRecord,
  LicensingSubLicenseeRecord,
  LicensingSubLicenseReportRecord,
} from '@/modules/licensing/records';
import type {
  NilCapVerificationRecord,
  NilDealComplianceAuditRecord,
  NilGroupSplitRecord,
  NilPayoutApplicationRecord,
  NilAuditEscrowDrawdownRecord,
  NilAuditEscrowPolicyRecord,
  NilAuditEscrowReconciliationRecord,
  NilAdvanceScheduleRecord,
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
  SportsBiometricMicroPayoutApplicationRecord,
  SportsBiometricRoyaltyPolicyRecord,
  SportsBiometricTrackingPostRecord,
  SportsBroadcastingContractRecord,
  SportsGateReconciliationRecord,
  SportsGroupLicensingApplicationRecord,
  SportsLicenseeClass,
  SportsLeaguePoolDistributionRecord,
  SportsLeaguePoolPolicyRecord,
  SportsLeagueTeamRegistrationRecord,
  SportsNetVenueRealizationRecord,
  SportsNilDealReconciliationRecord,
  SportsResaleRoyaltyApplicationRecord,
  SportsResaleRoyaltyPolicyRecord,
  SportsResaleSalePostRecord,
  SportsStudentAthleteProfileRecord,
  SportsTicketSalePostRecord,
  SportsTurnstileScanPostRecord,
} from '@/modules/sports/records';
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
  ServiceBoothLeasePolicyRecord,
  ServiceBoothLeaseApplicationRecord,
  ServiceBreakageAllocationRecord,
  ServiceBreakagePolicyRecord,
  ServiceFranchiseScheduleRecord,
  ServiceFranchiseSplitApplicationRecord,
  ServiceProtocolMicroRoyaltyRecord,
  ServiceProtocolPolicyRecord,
  ServiceRealizationApplicationRecord,
  ServiceRebateApplicationRecord,
  ServiceRebateWaterfallRecord,
  ServiceRedemptionPolicyRecord,
  ServiceRedemptionSplitApplicationRecord,
  ServiceAuditEscrowDrawdownRecord,
  ServiceAuditEscrowPolicyRecord,
  ServiceAuditEscrowReconciliationRecord,
  ServicesPayoutGateStateRecord,
} from '@/modules/service/records';
import type {
  HardwareCrossLicenseNetDispatchRecord,
  HardwarePayoutGateStateRecord,
  PatentLitigationEscrowDrawdownRecord,
  PatentLitigationEscrowPolicyRecord,
  PatentLitigationEscrowReconciliationRecord,
} from '@/modules/hardware/records';
import type {
  SoftwareAuditEscrowDrawdownRecord,
  SoftwareAuditEscrowPolicyRecord,
  SoftwareAuditEscrowReconciliationRecord,
  SoftwarePayoutGateStateRecord,
} from '@/modules/software/records';
import type {
  DeveloperAgentToolCallApplicationRecord,
  DeveloperApiCallMonthRecord,
  DeveloperApiMicroRoyaltyApplicationRecord,
  DeveloperApiRealizationApplicationRecord,
  DeveloperApiRoyaltyPolicyRecord,
  DeveloperCopackageContributionLegRecord,
  DeveloperCopackageSplitApplicationRecord,
  DeveloperDependencyFeeApplicationRecord,
  DeveloperDependencyMaintainerLedgerRecord,
  DeveloperMarketplaceSplitApplicationRecord,
  DeveloperMarketplaceSplitPolicyRecord,
  DeveloperToolRoyaltyPolicyRecord,
  DeveloperWhitelabelLicenseApplicationRecord,
  DeveloperWhitelabelLicenseDealRecord,
  DeveloperWhitelabelUsageMonthRecord,
} from '@/modules/developer/records';
import type {
  HardwareAutomotivePoolAssignmentRecord,
  HardwareCleanTechRoyaltyPolicyRecord,
  HardwareCrossLicenseAgreementRecord,
  HardwareCrossLicenseNetSettlementRecord,
  HardwareOtaUnlockApplicationRecord,
  HardwareOtaUnlockPolicyRecord,
  HardwarePatentPoolRecord,
  HardwarePoolHolderLegRecord,
  HardwarePoolRoutingApplicationRecord,
  HardwarePoolWaterfallApplicationRecord,
  HardwareRealizationApplicationRecord,
  HardwareSepRoyaltyApplicationRecord,
  HardwareSepRoyaltyPolicyRecord,
  HardwareSepUnitMonthRecord,
  HardwareTelemetryRoyaltyApplicationRecord,
} from '@/modules/hardware/records';
import type {
  CulinaryAuditEscrowDrawdownRecord,
  CulinaryAuditEscrowPolicyRecord,
  CulinaryAuditEscrowReconciliationRecord,
  CulinaryPayoutGateStateRecord,
  CulinaryPopupExperienceRecord,
  CulinaryPopupWriteoffRecord,
} from '@/modules/culinary/records';
import type {
  EnergyCarbonOffsetPayoutApplicationRecord,
  EnergyCarbonOffsetPolicyRecord,
  EnergyComputeGridSplitApplicationRecord,
  EnergyComputeYieldPolicyRecord,
  EnergyComputeYieldPositionRecord,
  EnergyDeedTransferRecord,
  EnergyDivisionOrderRecord,
  EnergyGpuUtilizationPostRecord,
  EnergyGridParticipantRegistrationRecord,
  EnergyLandParcelRecord,
  EnergyMeterSalesPostRecord,
  EnergyNetRealizationApplicationRecord,
  EnergyParcelDivisionApplicationRecord,
  EnergyParcelOwnerInterestRecord,
  EnergyParcelRoyaltyPolicyRecord,
  EnergyParcelRoyaltyPositionRecord,
  EnergyPipelineDeductionPostRecord,
  EnergyStatutoryInterestApplicationRecord,
  ResourceAuditEscrowDrawdownRecord,
  ResourceAuditEscrowPolicyRecord,
  ResourceAuditEscrowReconciliationRecord,
  ResourcePayoutGateStateRecord,
} from '@/modules/energy/records';
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
import { bookReturnsReservePayeeId } from '@/modules/don/constants';

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

-- Art market waterfalls (migration 0032, PR 28). The fabrication recoupment
-- pools of record (UNIQUE per (scope_key, pool_class, sequence_no)), the
-- append-only recovery applications (UNIQUE per (pool, source event) — the
-- replay guard — plus UNIQUE per (pool, recouped_before) — the insert-as-lock
-- position arbiter), the split schedule of record per scope_key (upsert),
-- the append-only executed splits (UNIQUE per source event), and the
-- copyright agency collection-fee policy of record per agency_code (upsert,
-- the founder band validates at registration).
CREATE TABLE IF NOT EXISTS art_recoupment_pools (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('print_edition_fabrication', 'sculpture_fabrication')),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  debt_cents INTEGER NOT NULL CHECK (debt_cents > 0),
  recouped_cents INTEGER NOT NULL CHECK (recouped_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'recouped')),
  creditor_role TEXT NOT NULL CHECK (creditor_role IN ('master_printmaker', 'lithographer', 'bronze_foundry', 'three_d_printing')),
  creditor_payee_id TEXT NOT NULL,
  creditor_payee_name TEXT NOT NULL,
  agreement_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, pool_class, sequence_no)
);

CREATE TABLE IF NOT EXISTS art_recoupment_applications (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  pool_class TEXT NOT NULL CHECK (pool_class IN ('print_edition_fabrication', 'sculpture_fabrication')),
  scope_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  recouped_before_cents INTEGER NOT NULL,
  applied_cents INTEGER NOT NULL CHECK (applied_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (pool_id, source_event_id),
  UNIQUE (pool_id, recouped_before_cents)
);
CREATE INDEX IF NOT EXISTS idx_art_recoupment_applications_pool
  ON art_recoupment_applications (pool_id);

CREATE TABLE IF NOT EXISTS art_split_schedules (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('print_edition', 'sculpture_fabrication')),
  contributors TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS art_split_accruals (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('print_edition', 'sculpture_fabrication')),
  source_event_id TEXT NOT NULL UNIQUE,
  basis_cents INTEGER NOT NULL CHECK (basis_cents >= 0),
  allocations TEXT NOT NULL,
  dust_cents INTEGER NOT NULL CHECK (dust_cents >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS art_licensing_agency_policies (
  id TEXT PRIMARY KEY,
  agency_code TEXT NOT NULL UNIQUE CHECK (agency_code IN ('ars', 'dacs')),
  agency_name TEXT NOT NULL,
  collection_fee_bps INTEGER NOT NULL CHECK (collection_fee_bps >= 1500 AND collection_fee_bps <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Estate succession + multi-heir splitting (migration 0033, PR 29). The
-- verified legal certificate of record per (artist, certificate_ref), the
-- probate split schedule of record per certificate, the append-only
-- receiving-entity transition ledger, the executed multi-heir accruals
-- (the provenance triple is the once-only key), and the per-payee payout
-- gate states the art vertical resolves through (fail-closed).
CREATE TABLE IF NOT EXISTS estate_succession_certificates (
  id TEXT PRIMARY KEY,
  artist_payee_id TEXT NOT NULL,
  certificate_ref TEXT NOT NULL,
  certificate_hash TEXT NOT NULL,
  estate_entity_payee_id TEXT NOT NULL,
  estate_entity_payee_name TEXT NOT NULL,
  validation_state TEXT NOT NULL CHECK (validation_state IN ('pending', 'verified', 'rejected')),
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (artist_payee_id, certificate_ref)
);
CREATE INDEX IF NOT EXISTS estate_succession_certificates_artist_idx
  ON estate_succession_certificates (artist_payee_id);

CREATE TABLE IF NOT EXISTS estate_heir_schedules (
  id TEXT PRIMARY KEY,
  certificate_id TEXT NOT NULL UNIQUE,
  heirs TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS estate_succession_transitions (
  id TEXT PRIMARY KEY,
  certificate_id TEXT NOT NULL,
  artist_payee_id TEXT NOT NULL,
  estate_entity_payee_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  artwork_id TEXT,
  provenance_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (certificate_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS estate_succession_transitions_certificate_idx
  ON estate_succession_transitions (certificate_id);

CREATE TABLE IF NOT EXISTS estate_split_accruals (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  certificate_id TEXT NOT NULL,
  artist_payee_id TEXT NOT NULL,
  estate_entity_payee_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  artwork_id TEXT NOT NULL,
  provenance_hash TEXT NOT NULL,
  basis_cents INTEGER NOT NULL CHECK (basis_cents >= 0),
  allocations TEXT NOT NULL,
  dust_cents INTEGER NOT NULL CHECK (dust_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (certificate_id, artwork_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS estate_split_accruals_certificate_idx
  ON estate_split_accruals (certificate_id);

CREATE TABLE IF NOT EXISTS estate_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL UNIQUE,
  estate_succession_state TEXT NOT NULL CHECK (estate_succession_state IN ('unknown', 'verified')),
  certificate_ref TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- AGBOR box office + theatrical recoupment (migration 0034, PR 30). The
-- versioned box office deal of record per production scope, the per-stop
-- settlement sheets keyed on the addendum 11 (production, venue, show
-- date) triple, the append-only investor recoupment applications (the
-- position lock is the books/art discipline), and the executed payout
-- designations — the mirrors of the Supabase migration.
CREATE TABLE IF NOT EXISTS theatrical_production_deals (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  deal_class TEXT NOT NULL CHECK (deal_class IN ('comedy_guarantee', 'theatrical_recoupment')),
  grand_rights_rate_bps INTEGER
    CHECK (grand_rights_rate_bps IS NULL OR (grand_rights_rate_bps >= 600 AND grand_rights_rate_bps <= 1000)),
  publisher_code TEXT
    CHECK (publisher_code IS NULL OR publisher_code IN ('concord', 'mti', 'rodgers_hammerstein')),
  publisher_payee_id TEXT,
  publisher_payee_name TEXT,
  artist_payee_id TEXT,
  artist_payee_name TEXT,
  producer_payee_id TEXT,
  producer_payee_name TEXT,
  investor_payee_id TEXT,
  investor_payee_name TEXT,
  flat_guarantee_cents INTEGER CHECK (flat_guarantee_cents IS NULL OR flat_guarantee_cents > 0),
  guarantee_percentage_bps INTEGER
    CHECK (guarantee_percentage_bps IS NULL OR (guarantee_percentage_bps >= 0 AND guarantee_percentage_bps <= 10000)),
  capitalization_budget_cents INTEGER
    CHECK (capitalization_budget_cents IS NULL OR capitalization_budget_cents > 0),
  recouped_cents INTEGER NOT NULL CHECK (recouped_cents >= 0),
  currency TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS theatrical_stop_settlements (
  id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  show_date TEXT NOT NULL CHECK (length(show_date) = 10),
  source_event_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  sender_code TEXT NOT NULL CHECK (sender_code IN ('axs', 'ticketmaster', 'eventbrite', 'venuepos')),
  city TEXT NOT NULL,
  gbor_cents INTEGER NOT NULL CHECK (gbor_cents > 0),
  sales_tax_cents INTEGER NOT NULL CHECK (sales_tax_cents >= 0),
  card_fees_cents INTEGER NOT NULL CHECK (card_fees_cents >= 0),
  facility_fee_cents INTEGER NOT NULL CHECK (facility_fee_cents >= 0),
  ffe_fee_cents INTEGER NOT NULL CHECK (ffe_fee_cents >= 0),
  group_discount_cents INTEGER NOT NULL CHECK (group_discount_cents >= 0),
  agbor_cents INTEGER NOT NULL CHECK (agbor_cents >= 0),
  grand_rights_cents INTEGER NOT NULL CHECK (grand_rights_cents >= 0),
  venue_expense_cents INTEGER NOT NULL CHECK (venue_expense_cents >= 0),
  promoter_expense_cap_cents INTEGER NOT NULL CHECK (promoter_expense_cap_cents >= 0),
  venue_expense_recouped_cents INTEGER NOT NULL CHECK (venue_expense_recouped_cents >= 0),
  venue_expense_capped_cents INTEGER NOT NULL CHECK (venue_expense_capped_cents >= 0),
  deal_payout_cents INTEGER NOT NULL CHECK (deal_payout_cents >= 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS theatrical_stop_settlements_production_idx
  ON theatrical_stop_settlements (production_id, show_date);

CREATE TABLE IF NOT EXISTS theatrical_recoupment_applications (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  recouped_before_cents INTEGER NOT NULL CHECK (recouped_before_cents >= 0),
  applied_cents INTEGER NOT NULL CHECK (applied_cents >= 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (deal_id, source_event_id),
  UNIQUE (deal_id, recouped_before_cents)
);
CREATE INDEX IF NOT EXISTS theatrical_recoupment_applications_deal_idx
  ON theatrical_recoupment_applications (deal_id);

CREATE TABLE IF NOT EXISTS theatrical_split_accruals (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  deal_class TEXT NOT NULL CHECK (deal_class IN ('comedy_guarantee', 'theatrical_recoupment')),
  source_event_id TEXT NOT NULL,
  basis_cents INTEGER NOT NULL CHECK (basis_cents >= 0),
  allocations TEXT NOT NULL,
  dust_cents INTEGER NOT NULL CHECK (dust_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (deal_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS theatrical_split_accruals_deal_idx
  ON theatrical_split_accruals (deal_id);

-- Promoter settlement escrow + theater gates + venue hall fees (migration
-- 0035, PR 31). The final night-of-show audit closes of record per the
-- addendum-11 triple (the escrow release's fail-closed gate), the theater
-- payout gate states per (payee, production) — the grand_rights_cleared and
-- venue_settlement_reconciled facts the theater vertical resolves through —
-- and the founder-banded venue hall fee policies per (tour, venue).
CREATE TABLE IF NOT EXISTS promoter_settlement_audits (
  id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  show_date TEXT NOT NULL,
  audit_state TEXT NOT NULL CHECK (audit_state IN ('unknown', 'closed')),
  evidence_ref TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (production_id, venue_id, show_date)
);

CREATE TABLE IF NOT EXISTS theatrical_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  grand_rights_state TEXT NOT NULL CHECK (grand_rights_state IN ('unknown', 'cleared')),
  venue_settlement_state TEXT NOT NULL CHECK (venue_settlement_state IN ('unknown', 'reconciled')),
  grand_rights_evidence_ref TEXT,
  venue_settlement_evidence_ref TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, production_id)
);

CREATE TABLE IF NOT EXISTS venue_hall_fee_policies (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  hall_fee_rate_bps INTEGER NOT NULL CHECK (hall_fee_rate_bps >= 1500 AND hall_fee_rate_bps <= 2500),
  venue_payee_id TEXT NOT NULL,
  venue_payee_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tour_id, venue_id)
);

-- Brand licensing: Net Sales realization, tiered royalties, dual-IP splits,
-- treaty withholding, sub-license cascade (migration 0036, PR 32). The
-- deal of record per license scope (the marginal tier schedule and the
-- dual-IP licensor payees pack as TEXT JSON), the append-only per-event
-- tier walks (the cumulative state's commit), the treaty rates per
-- (source, residence), the registered regional sub-licensees, and the
-- sub-license gross reports of record (the fail-closed audit gate).
CREATE TABLE IF NOT EXISTS licensing_royalty_deals (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  license_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  tiers TEXT NOT NULL,
  agency_commission_bps INTEGER,
  licensor_a_payee_id TEXT NOT NULL,
  licensor_a_payee_name TEXT NOT NULL,
  licensor_a_country TEXT NOT NULL,
  licensor_b_payee_id TEXT,
  licensor_b_payee_name TEXT,
  licensor_b_country TEXT,
  withholding_default_bps INTEGER,
  cumulative_net_sales_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_royalty_cents INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licensing_royalty_applications (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  period TEXT,
  net_sales_cents INTEGER NOT NULL,
  cumulative_before_cents INTEGER NOT NULL,
  royalty_cents INTEGER NOT NULL,
  slices TEXT NOT NULL,
  agency_commission_cents INTEGER NOT NULL DEFAULT 0,
  licensor_a_gross_cents INTEGER NOT NULL,
  licensor_b_gross_cents INTEGER NOT NULL DEFAULT 0,
  dust_cents INTEGER NOT NULL DEFAULT 0,
  withholding_rate_bps INTEGER,
  licensor_a_withheld_cents INTEGER,
  licensor_b_withheld_cents INTEGER,
  withholding_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (deal_id, source_event_id),
  UNIQUE (deal_id, cumulative_before_cents)
);

CREATE TABLE IF NOT EXISTS licensing_treaty_rates (
  id TEXT PRIMARY KEY,
  source_country TEXT NOT NULL,
  residence_country TEXT NOT NULL,
  rate_bps INTEGER NOT NULL,
  treaty_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_country, residence_country)
);

CREATE TABLE IF NOT EXISTS licensing_sub_licensees (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  sub_licensee_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  master_override_bps INTEGER NOT NULL,
  payee_id TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, sub_licensee_id)
);

CREATE TABLE IF NOT EXISTS licensing_sub_license_reports (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  sub_licensee_id TEXT NOT NULL,
  region_code TEXT NOT NULL,
  period TEXT,
  source_event_id TEXT NOT NULL UNIQUE,
  gross_cents INTEGER NOT NULL,
  trade_discount_cents INTEGER NOT NULL DEFAULT 0,
  returned_goods_cents INTEGER NOT NULL DEFAULT 0,
  shipping_freight_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  net_sales_cents INTEGER NOT NULL,
  master_override_bps INTEGER NOT NULL,
  master_royalty_cents INTEGER NOT NULL,
  audit_state TEXT NOT NULL CHECK (audit_state IN ('unknown', 'reconciled')),
  evidence_ref TEXT,
  reconciled_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licensing_sub_reports_scope
  ON licensing_sub_license_reports (scope_key);

-- Advance / minimum-guarantee recoupment, shortfall invoices, audit reserve
-- escrow, and payout gate states (PR 33, migration 0037) — the recoupment
-- ledger and its automatic penalty, the founder-banded audit-reserve bucket,
-- and the fail-closed gate states of record. Every business key an inline
-- UNIQUE, no FOREIGN KEYs (the reconciliation-identifier discipline
-- 0011/0036 use).
CREATE TABLE IF NOT EXISTS licensing_mg_commitments (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  commitment_ref TEXT NOT NULL,
  category_code TEXT NOT NULL,
  collateralization TEXT NOT NULL CHECK (collateralization IN ('cross_collateralized', 'category_isolated')),
  mg_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  licensee_id TEXT NOT NULL,
  licensee_name TEXT NOT NULL,
  recouped_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, commitment_ref)
);
CREATE INDEX IF NOT EXISTS idx_licensing_mg_commitments_scope
  ON licensing_mg_commitments (scope_key);

CREATE TABLE IF NOT EXISTS licensing_mg_recoupment_applications (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  category_code TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  earned_royalty_cents INTEGER NOT NULL,
  recouped_before_cents INTEGER NOT NULL,
  recouped_cents INTEGER NOT NULL,
  recouped_after_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (commitment_id, source_event_id),
  UNIQUE (commitment_id, recouped_before_cents)
);
CREATE INDEX IF NOT EXISTS idx_licensing_mg_recoup_commitment
  ON licensing_mg_recoupment_applications (commitment_id);

CREATE TABLE IF NOT EXISTS licensing_mg_term_closes (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  term TEXT NOT NULL,
  mg_due_cents INTEGER NOT NULL,
  recouped_at_close_cents INTEGER NOT NULL,
  shortfall_cents INTEGER NOT NULL,
  invoice_ledger_id TEXT,
  closed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (commitment_id, term)
);
CREATE INDEX IF NOT EXISTS idx_licensing_mg_term_closes_scope
  ON licensing_mg_term_closes (scope_key);

CREATE TABLE IF NOT EXISTS licensing_audit_reserve_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licensing_audit_reserve_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licensing_audit_reserve_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('quarterly_audit_reconciliation', 'inventory_write_off')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL,
  remaining_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id, source_event_id),
  UNIQUE (reserve_ledger_id, drawn_before_cents)
);
CREATE INDEX IF NOT EXISTS idx_licensing_audit_drawdowns_reserve
  ON licensing_audit_reserve_drawdowns (reserve_ledger_id);

CREATE TABLE IF NOT EXISTS licensing_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  territory_state TEXT NOT NULL CHECK (territory_state IN ('unknown', 'cleared')),
  category_exclusivity_state TEXT NOT NULL CHECK (category_exclusivity_state IN ('unknown', 'verified')),
  territory_evidence_ref TEXT,
  category_exclusivity_evidence_ref TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_licensing_gate_states_scope
  ON licensing_payout_gate_states (scope_key);

-- The NIL lane (migration 0038, PR 34). The compliance parser + roster
-- waterfall's durable facts of record — the revenue-share program per
-- scope, the roster waterfall per (scope, key), the school caps and cap
-- verifications per (school, year), the valid business purpose audits per
-- contract, the append-only payout/pool/group-split applications (replay-
-- guarded per source event), the state rules per (state, rule), and the
-- payout gate states per (payee, school). The SQLite mirror keeps the
-- Postgres wall types as TEXT (uuid/timestamptz read back as strings),
-- packs the jsonb columns (tiers/slices/participant_ids — pre-encoded in
-- the records module) as TEXT JSON, and mirrors booleans as INTEGER
-- (null stays NULL).
CREATE TABLE IF NOT EXISTS nil_revenue_share_programs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('school', 'collective')),
  school_id TEXT,
  collective_id TEXT,
  title_ix_reserve_bps INTEGER NOT NULL,
  admin_fee_bps INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key)
);

CREATE TABLE IF NOT EXISTS nil_roster_waterfalls (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  waterfall_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('position', 'performance')),
  tiers TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, waterfall_key)
);

CREATE TABLE IF NOT EXISTS nil_school_caps (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  cap_year TEXT NOT NULL,
  annual_cap_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (school_id, cap_year)
);

CREATE TABLE IF NOT EXISTS nil_cap_verifications (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  cap_year TEXT NOT NULL,
  verified_committed_cents INTEGER NOT NULL,
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (school_id, cap_year)
);

CREATE TABLE IF NOT EXISTS nil_deal_compliance_audits (
  id TEXT PRIMARY KEY,
  nil_contract_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  deal_value_cents INTEGER NOT NULL,
  business_purpose_state TEXT NOT NULL CHECK (business_purpose_state IN ('flagged', 'nil_cleared')),
  purpose_description TEXT,
  evidence_ref TEXT,
  cleared_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (nil_contract_id)
);

CREATE TABLE IF NOT EXISTS nil_payout_applications (
  id TEXT PRIMARY KEY,
  nil_contract_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  period TEXT NOT NULL,
  gross_cents INTEGER NOT NULL,
  agency_mode TEXT NOT NULL CHECK (agency_mode IN ('marketing', 'direct_rev_share', 'none')),
  agency_bps INTEGER NOT NULL,
  agency_fee_cents INTEGER NOT NULL,
  net_payout_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_compliance', 'held_state_rule')),
  state_rule_ref TEXT,
  cap_verified_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);

CREATE TABLE IF NOT EXISTS nil_pool_applications (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  pool_type TEXT NOT NULL CHECK (pool_type IN ('media_rights', 'ticket_distribution')),
  source_event_id TEXT NOT NULL,
  period TEXT NOT NULL,
  gross_pool_cents INTEGER NOT NULL,
  title_ix_reserve_bps INTEGER NOT NULL,
  title_ix_reserve_cents INTEGER NOT NULL,
  admin_fee_bps INTEGER NOT NULL,
  admin_fee_cents INTEGER NOT NULL,
  net_athlete_share_pool_cents INTEGER NOT NULL,
  waterfall_key TEXT NOT NULL,
  tier_kind TEXT NOT NULL CHECK (tier_kind IN ('position', 'performance')),
  slices TEXT NOT NULL,
  roster_paid_cents INTEGER NOT NULL,
  dust_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);

CREATE TABLE IF NOT EXISTS nil_group_splits (
  id TEXT PRIMARY KEY,
  scope_ref TEXT NOT NULL,
  rights_stream TEXT NOT NULL CHECK (rights_stream IN ('video_game', 'apparel', 'media')),
  source_event_id TEXT NOT NULL,
  period TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  participant_ids TEXT NOT NULL,
  participant_count INTEGER NOT NULL,
  per_participant_cents INTEGER NOT NULL,
  dust_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);

CREATE TABLE IF NOT EXISTS nil_state_rules (
  id TEXT PRIMARY KEY,
  state_jurisdiction_code TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  applies_to_category TEXT NOT NULL,
  enforcement TEXT NOT NULL CHECK (enforcement IN ('prohibited', 'permitted', 'conditional')),
  rule_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (state_jurisdiction_code, rule_code)
);

CREATE TABLE IF NOT EXISTS nil_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  nil_clearance_state TEXT NOT NULL CHECK (nil_clearance_state IN ('unknown', 'nil_cleared')),
  compliance_state TEXT NOT NULL CHECK (compliance_state IN ('unknown', 'verified')),
  title_ix_state TEXT NOT NULL CHECK (title_ix_state IN ('unknown', 'cleared')),
  collective_or_booster_backed INTEGER,
  institutional_cap_state TEXT NOT NULL CHECK (institutional_cap_state IN ('unknown', 'verified')),
  evidence_ref TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, school_id)
);

-- NIL audit escrow + transfer portal clawback (PR 35, migration 0039). The
-- founder-banded escrow rate of record per (payee, school) scope, the
-- position-locked escrow drawdowns (mid-season NCAA Transfer Portal
-- reconciliations and tax withholdings), the verified reconciliations of
-- record (the release gate's key), the NIL advance of record per contract
-- (the pro-ration's terms), the portal entries of record per (contract,
-- athlete), and the pro-rated clawbacks of record per portal entry.
CREATE TABLE IF NOT EXISTS nil_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key)
);

CREATE TABLE IF NOT EXISTS nil_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('transfer_portal_reconciliation', 'tax_withholding')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL,
  remaining_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id, source_event_id),
  UNIQUE (reserve_ledger_id, drawn_before_cents)
);

CREATE TABLE IF NOT EXISTS nil_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id)
);

CREATE TABLE IF NOT EXISTS nil_advance_schedules (
  id TEXT PRIMARY KEY,
  nil_contract_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  advance_cents INTEGER NOT NULL CHECK (advance_cents > 0),
  term_start_date TEXT NOT NULL,
  term_end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (nil_contract_id)
);

CREATE TABLE IF NOT EXISTS nil_transfer_portal_entries (
  id TEXT PRIMARY KEY,
  nil_contract_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  contract_completion_date TEXT,
  entered_prior_to_completion INTEGER NOT NULL CHECK (entered_prior_to_completion IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (nil_contract_id, athlete_id)
);

CREATE TABLE IF NOT EXISTS nil_unearned_clawbacks (
  id TEXT PRIMARY KEY,
  nil_contract_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  portal_entry_id TEXT NOT NULL,
  advance_cents INTEGER NOT NULL,
  term_start_date TEXT NOT NULL,
  term_end_date TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  total_term_days INTEGER NOT NULL,
  served_days INTEGER NOT NULL,
  unearned_cents INTEGER NOT NULL,
  clawback_ledger_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (portal_entry_id)
);

-- Spatial POS + occupancy royalties + zone allocation (PR 36, migration
-- 0040). The founder spatial directive's durable facts: the occupancy
-- royalty schedule of record per (venue, year) (the sliding-scale tier
-- bands, keyed on annual throughput or footprint), the shared facility
-- overhead policy of record (the three park-wide bps legs), the assigned
-- IP owner per (venue, zone), the micro-royalty rates per (venue, zone),
-- the cumulative annual throughput tracker, and the three append-only
-- application ledgers (replay-guarded per source event).
CREATE TABLE IF NOT EXISTS spatial_occupancy_tier_schedules (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  year TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('annual_throughput', 'footprint_sqft')),
  bands TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_id, year)
);

CREATE TABLE IF NOT EXISTS spatial_overhead_policies (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  year TEXT NOT NULL,
  security_bps INTEGER NOT NULL CHECK (security_bps >= 0 AND security_bps <= 10000),
  wristband_maintenance_bps INTEGER NOT NULL CHECK (wristband_maintenance_bps >= 0 AND wristband_maintenance_bps <= 10000),
  ticketing_platform_bps INTEGER NOT NULL CHECK (ticketing_platform_bps >= 0 AND ticketing_platform_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_id, year)
);

CREATE TABLE IF NOT EXISTS spatial_zone_assignments (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  assigned_ip_owner_id TEXT NOT NULL,
  royalty_bps INTEGER NOT NULL CHECK (royalty_bps >= 0 AND royalty_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_id, zone_code)
);

CREATE TABLE IF NOT EXISTS spatial_micro_policies (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  micros_per_dwell_minute INTEGER NOT NULL CHECK (micros_per_dwell_minute >= 0),
  micros_per_ride_session INTEGER NOT NULL CHECK (micros_per_ride_session >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_id, zone_code)
);

CREATE TABLE IF NOT EXISTS spatial_throughput_years (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL,
  year TEXT NOT NULL,
  cumulative_entries INTEGER NOT NULL CHECK (cumulative_entries >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_id, year)
);

CREATE TABLE IF NOT EXISTS spatial_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('turnstile', 'pass')),
  venue_id TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  spatial_footprint_sqft INTEGER NOT NULL CHECK (spatial_footprint_sqft > 0),
  period TEXT NOT NULL,
  ticket_revenue_cents INTEGER NOT NULL CHECK (ticket_revenue_cents >= 0),
  merch_revenue_cents INTEGER NOT NULL CHECK (merch_revenue_cents >= 0),
  gross_revenue_cents INTEGER NOT NULL CHECK (gross_revenue_cents >= 0),
  occupancy_tax_cents INTEGER NOT NULL CHECK (occupancy_tax_cents >= 0),
  infrastructure_cogs_cents INTEGER NOT NULL CHECK (infrastructure_cogs_cents >= 0),
  group_tour_discount_cents INTEGER NOT NULL CHECK (group_tour_discount_cents >= 0),
  net_spatial_licensed_revenue_cents INTEGER NOT NULL,
  overhead_security_cents INTEGER NOT NULL CHECK (overhead_security_cents >= 0),
  overhead_wristband_cents INTEGER NOT NULL CHECK (overhead_wristband_cents >= 0),
  overhead_ticketing_cents INTEGER NOT NULL CHECK (overhead_ticketing_cents >= 0),
  overhead_total_cents INTEGER NOT NULL CHECK (overhead_total_cents >= 0),
  royalty_basis_cents INTEGER NOT NULL CHECK (royalty_basis_cents >= 0),
  tier_basis TEXT NOT NULL CHECK (tier_basis IN ('annual_throughput', 'footprint_sqft')),
  tier_schedule_ref TEXT,
  tier_legs TEXT NOT NULL,
  entries_count INTEGER NOT NULL CHECK (entries_count >= 0),
  entries_before INTEGER,
  entries_after INTEGER,
  occupancy_royalty_cents INTEGER NOT NULL CHECK (occupancy_royalty_cents >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (net_spatial_licensed_revenue_cents
    = ticket_revenue_cents + merch_revenue_cents
      - occupancy_tax_cents - infrastructure_cogs_cents - group_tour_discount_cents),
  CHECK (verdict = 'held_negative_net'
    OR royalty_basis_cents = net_spatial_licensed_revenue_cents - overhead_total_cents),
  CHECK (verdict = 'paid'
    OR (overhead_security_cents = 0
        AND overhead_wristband_cents = 0
        AND overhead_ticketing_cents = 0
        AND overhead_total_cents = 0
        AND royalty_basis_cents = 0
        AND occupancy_royalty_cents = 0)),
  CHECK (overhead_total_cents
    = overhead_security_cents + overhead_wristband_cents + overhead_ticketing_cents)
);

CREATE TABLE IF NOT EXISTS spatial_zone_allocations (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  row_class TEXT NOT NULL CHECK (row_class IN ('fnb', 'retail')),
  venue_id TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  period TEXT NOT NULL,
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  overhead_security_cents INTEGER NOT NULL CHECK (overhead_security_cents >= 0),
  overhead_wristband_cents INTEGER NOT NULL CHECK (overhead_wristband_cents >= 0),
  overhead_ticketing_cents INTEGER NOT NULL CHECK (overhead_ticketing_cents >= 0),
  overhead_total_cents INTEGER NOT NULL CHECK (overhead_total_cents >= 0),
  allocated_basis_cents INTEGER NOT NULL CHECK (allocated_basis_cents >= 0),
  assigned_ip_owner_id TEXT NOT NULL,
  royalty_bps INTEGER NOT NULL CHECK (royalty_bps >= 0 AND royalty_bps <= 10000),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (allocated_basis_cents = gross_cents - overhead_total_cents),
  CHECK (overhead_total_cents
    = overhead_security_cents + overhead_wristband_cents + overhead_ticketing_cents)
);

CREATE TABLE IF NOT EXISTS spatial_micro_royalty_ledger (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  wristband_id TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  period TEXT NOT NULL,
  dwell_minutes INTEGER NOT NULL CHECK (dwell_minutes >= 0),
  ride_sessions INTEGER NOT NULL CHECK (ride_sessions >= 0),
  micros_per_dwell_minute INTEGER NOT NULL CHECK (micros_per_dwell_minute >= 0),
  micros_per_ride_session INTEGER NOT NULL CHECK (micros_per_ride_session >= 0),
  dwell_royalty_micros INTEGER NOT NULL CHECK (dwell_royalty_micros >= 0),
  session_royalty_micros INTEGER NOT NULL CHECK (session_royalty_micros >= 0),
  total_royalty_micros INTEGER NOT NULL CHECK (total_royalty_micros >= 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (dwell_royalty_micros = dwell_minutes * micros_per_dwell_minute),
  CHECK (session_royalty_micros = ride_sessions * micros_per_ride_session),
  CHECK (total_royalty_micros = dwell_royalty_micros + session_royalty_micros),
  CHECK (royalty_cents = total_royalty_micros / 1000000)
);

-- Spatial commitments (migration 0041, PR 37). The allowable CapEx
-- commitments of record per (scope, capex_ref) with their position-locked
-- recoupment applications, the quarterly Minimum Spatial Guarantee terms
-- and once-only term closes, the temporary pop-up experiences of record
-- with their post-event inventory write-off calculations and site
-- restoration reserves, the SPATIAL_AUDIT_ESCROW policies per scope with
-- their position-locked drawdowns and verified reconciliations, and the
-- durable spatial payout-gate states per (payee, venue).
CREATE TABLE IF NOT EXISTS spatial_capex_commitments (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  capex_ref TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  capex_category TEXT NOT NULL CHECK (capex_category IN ('ride_construction', 'venue_buildout')),
  capex_amount_cents INTEGER NOT NULL CHECK (capex_amount_cents > 0),
  recouped_cents INTEGER NOT NULL CHECK (recouped_cents >= 0),
  currency TEXT NOT NULL CHECK (currency <> ''),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_key, capex_ref),
  CHECK (recouped_cents <= capex_amount_cents)
);

CREATE TABLE IF NOT EXISTS spatial_capex_applications (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  capex_category TEXT NOT NULL CHECK (capex_category IN ('ride_construction', 'venue_buildout')),
  source_event_id TEXT NOT NULL,
  royalty_stream TEXT NOT NULL CHECK (royalty_stream IN ('occupancy', 'zone', 'micro')),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  offset_before_cents INTEGER NOT NULL CHECK (offset_before_cents >= 0),
  offset_cents INTEGER NOT NULL CHECK (offset_cents > 0),
  offset_after_cents INTEGER NOT NULL CHECK (offset_after_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (commitment_id, source_event_id),
  UNIQUE (commitment_id, offset_before_cents),
  CHECK (offset_after_cents = offset_before_cents + offset_cents)
);

CREATE TABLE IF NOT EXISTS spatial_msg_commitments (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL CHECK (operator_name <> ''),
  venue_id TEXT NOT NULL,
  reserved_footprint_sqft INTEGER NOT NULL CHECK (reserved_footprint_sqft > 0),
  quarterly_rate_micros_per_sqft INTEGER NOT NULL CHECK (quarterly_rate_micros_per_sqft > 0),
  currency TEXT NOT NULL CHECK (currency <> ''),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spatial_msg_term_closes (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  quarter TEXT NOT NULL CHECK (quarter GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
  msg_due_cents INTEGER NOT NULL CHECK (msg_due_cents >= 0),
  earned_at_close_cents INTEGER NOT NULL CHECK (earned_at_close_cents >= 0),
  shortfall_cents INTEGER NOT NULL CHECK (shortfall_cents >= 0),
  invoice_ledger_id TEXT,
  closed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (commitment_id, quarter),
  CHECK (shortfall_cents = MAX(msg_due_cents - earned_at_close_cents, 0)),
  CHECK (shortfall_cents > 0 OR invoice_ledger_id IS NULL)
);

CREATE TABLE IF NOT EXISTS spatial_popup_experiences (
  id TEXT PRIMARY KEY,
  popup_ref TEXT NOT NULL UNIQUE,
  venue_id TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  experience_kind TEXT NOT NULL CHECK (experience_kind <> ''),
  window_start_date TEXT NOT NULL,
  window_end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (window_end_date >= window_start_date)
);

CREATE TABLE IF NOT EXISTS spatial_popup_writeoffs (
  id TEXT PRIMARY KEY,
  popup_experience_id TEXT NOT NULL,
  popup_ref TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  unsold_units INTEGER NOT NULL CHECK (unsold_units >= 0),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  writeoff_cents INTEGER NOT NULL CHECK (writeoff_cents >= 0),
  evidence_ref TEXT NOT NULL,
  calculated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (popup_experience_id, source_event_id),
  CHECK (writeoff_cents = unsold_units * unit_cost_cents)
);

CREATE TABLE IF NOT EXISTS spatial_popup_restoration_reserves (
  id TEXT PRIMARY KEY,
  popup_experience_id TEXT NOT NULL UNIQUE,
  popup_ref TEXT NOT NULL,
  reserve_cents INTEGER NOT NULL CHECK (reserve_cents >= 0),
  evidence_ref TEXT NOT NULL,
  funded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spatial_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spatial_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN
    ('entertainment_sales_tax', 'safety_compliance_holdback', 'concession_reconciliation')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL CHECK (drawn_before_cents >= 0),
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id, source_event_id),
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents)
);

CREATE TABLE IF NOT EXISTS spatial_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spatial_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  territorial_zoning_state TEXT NOT NULL CHECK (territorial_zoning_state IN ('unknown', 'cleared')),
  spatial_audit_state TEXT NOT NULL CHECK (spatial_audit_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, venue_id)
);

-- The fitness lane (migration 0042, PR 38). The founder fitness directive's
-- durable facts: the tier schedules, rate policies, partnerships, and
-- waterfalls the walks read, the monthly trackers the cumulative walks
-- advance, and the seven append-only application ledgers the walks write.
-- No foreign keys by design — the tables key on content-derived event ids,
-- the sender's trainer/program/franchise identifiers, and reporting months
-- (the 0036–0041 discipline).
CREATE TABLE IF NOT EXISTS fitness_trainer_tier_schedules (
  id TEXT PRIMARY KEY,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  bands TEXT NOT NULL,
  retention_bonus_micros_per_completion INTEGER NOT NULL CHECK (retention_bonus_micros_per_completion >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (trainer_id, program_id)
);

CREATE TABLE IF NOT EXISTS fitness_completion_months (
  id TEXT PRIMARY KEY,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  cumulative_completions INTEGER NOT NULL CHECK (cumulative_completions >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (trainer_id, program_id, month)
);

CREATE TABLE IF NOT EXISTS fitness_sync_music_policies (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  master_royalty_micros_per_workout INTEGER NOT NULL CHECK (master_royalty_micros_per_workout >= 0),
  publishing_royalty_micros_per_workout INTEGER NOT NULL CHECK (publishing_royalty_micros_per_workout >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id)
);

CREATE TABLE IF NOT EXISTS fitness_live_load_policies (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  bands TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id)
);

CREATE TABLE IF NOT EXISTS fitness_franchise_policies (
  id TEXT PRIMARY KEY,
  studio_franchise_code TEXT NOT NULL,
  franchise_license_override_bps INTEGER NOT NULL CHECK (franchise_license_override_bps >= 0 AND franchise_license_override_bps <= 10000),
  network_fee_bps INTEGER NOT NULL CHECK (network_fee_bps >= 0 AND network_fee_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (studio_franchise_code)
);

CREATE TABLE IF NOT EXISTS fitness_franchise_class_months (
  id TEXT PRIMARY KEY,
  studio_franchise_code TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  cumulative_classes INTEGER NOT NULL CHECK (cumulative_classes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (studio_franchise_code, month)
);

CREATE TABLE IF NOT EXISTS fitness_co_brand_partnerships (
  id TEXT PRIMARY KEY,
  studio_franchise_code TEXT NOT NULL,
  ip_owner_id TEXT NOT NULL,
  distributor_id TEXT NOT NULL,
  ip_owner_share_bps INTEGER NOT NULL CHECK (ip_owner_share_bps > 0 AND ip_owner_share_bps < 10000),
  distributor_share_bps INTEGER NOT NULL CHECK (distributor_share_bps > 0 AND distributor_share_bps < 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (studio_franchise_code),
  CHECK (ip_owner_share_bps + distributor_share_bps = 10000)
);

CREATE TABLE IF NOT EXISTS fitness_algorithm_policies (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  algorithm_creator_id TEXT NOT NULL,
  micros_per_active_user INTEGER NOT NULL CHECK (micros_per_active_user > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id)
);

CREATE TABLE IF NOT EXISTS fitness_cocreation_modules (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  weight_bps INTEGER NOT NULL CHECK (weight_bps > 0 AND weight_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (program_id, module_id)
);

CREATE TABLE IF NOT EXISTS fitness_realization_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_subscription_pool_cents INTEGER NOT NULL CHECK (gross_subscription_pool_cents >= 0),
  app_store_engine_cut_cents INTEGER NOT NULL CHECK (app_store_engine_cut_cents >= 0),
  digital_infrastructure_overhead_cents INTEGER NOT NULL CHECK (digital_infrastructure_overhead_cents >= 0),
  net_fitness_content_pool_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (net_fitness_content_pool_cents
    = gross_subscription_pool_cents
      - app_store_engine_cut_cents - digital_infrastructure_overhead_cents)
);

CREATE TABLE IF NOT EXISTS fitness_trainer_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('stream_start', 'workout_complete')),
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  completed_count INTEGER NOT NULL CHECK (completed_count > 0),
  class_revenue_cents INTEGER NOT NULL CHECK (class_revenue_cents >= 0),
  sync_policy_ref TEXT,
  master_royalty_micros_per_workout INTEGER NOT NULL CHECK (master_royalty_micros_per_workout >= 0),
  publishing_royalty_micros_per_workout INTEGER NOT NULL CHECK (publishing_royalty_micros_per_workout >= 0),
  sync_master_micros INTEGER NOT NULL CHECK (sync_master_micros >= 0),
  sync_publishing_micros INTEGER NOT NULL CHECK (sync_publishing_micros >= 0),
  sync_master_cents INTEGER NOT NULL CHECK (sync_master_cents >= 0),
  sync_publishing_cents INTEGER NOT NULL CHECK (sync_publishing_cents >= 0),
  trainer_net_basis_cents INTEGER NOT NULL,
  tier_schedule_ref TEXT,
  tier_legs TEXT NOT NULL,
  tier_payout_micros INTEGER NOT NULL CHECK (tier_payout_micros >= 0),
  tier_payout_cents INTEGER NOT NULL CHECK (tier_payout_cents >= 0),
  retained_count INTEGER NOT NULL CHECK (retained_count >= 0),
  retention_bonus_micros_per_completion INTEGER NOT NULL CHECK (retention_bonus_micros_per_completion >= 0),
  retention_bonus_micros INTEGER NOT NULL CHECK (retention_bonus_micros >= 0),
  retention_bonus_cents INTEGER NOT NULL CHECK (retention_bonus_cents >= 0),
  monthly_completions_before INTEGER,
  monthly_completions_after INTEGER,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The sync deductions came FIRST: the trainer's net share basis is the
  -- class revenue less both sync legs (the founder's ordering, pinned).
  CHECK (trainer_net_basis_cents
    = class_revenue_cents - sync_master_cents - sync_publishing_cents),
  CHECK (retained_count <= completed_count),
  CHECK (verdict = 'paid' OR (trainer_net_basis_cents < 0
    AND tier_payout_micros = 0 AND tier_payout_cents = 0
    AND retention_bonus_micros = 0 AND retention_bonus_cents = 0
    AND monthly_completions_before IS NULL AND monthly_completions_after IS NULL))
);

CREATE TABLE IF NOT EXISTS fitness_live_residual_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  peak_simultaneous_viewers INTEGER NOT NULL CHECK (peak_simultaneous_viewers > 0),
  live_event_revenue_cents INTEGER NOT NULL CHECK (live_event_revenue_cents >= 0),
  load_band_from INTEGER NOT NULL CHECK (load_band_from >= 0),
  load_band_to INTEGER,
  server_load_bps INTEGER NOT NULL CHECK (server_load_bps >= 0 AND server_load_bps <= 10000),
  server_load_deduction_cents INTEGER NOT NULL CHECK (server_load_deduction_cents >= 0),
  net_live_residual_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (net_live_residual_cents
    = live_event_revenue_cents - server_load_deduction_cents),
  CHECK (server_load_deduction_cents <= live_event_revenue_cents)
);

CREATE TABLE IF NOT EXISTS fitness_franchise_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  class_count INTEGER NOT NULL CHECK (class_count > 0),
  classes_before INTEGER,
  classes_after INTEGER,
  class_revenue_cents INTEGER NOT NULL CHECK (class_revenue_cents >= 0),
  certified_choreography_revenue_cents INTEGER NOT NULL CHECK (certified_choreography_revenue_cents >= 0),
  certified_audio_revenue_cents INTEGER NOT NULL CHECK (certified_audio_revenue_cents >= 0),
  franchise_license_override_bps INTEGER NOT NULL CHECK (franchise_license_override_bps >= 0 AND franchise_license_override_bps <= 10000),
  choreography_override_cents INTEGER NOT NULL CHECK (choreography_override_cents >= 0),
  audio_override_cents INTEGER NOT NULL CHECK (audio_override_cents >= 0),
  franchise_override_total_cents INTEGER NOT NULL CHECK (franchise_override_total_cents >= 0),
  network_fee_bps INTEGER NOT NULL CHECK (network_fee_bps >= 0 AND network_fee_bps <= 10000),
  network_fee_cents INTEGER NOT NULL CHECK (network_fee_cents >= 0),
  instructor_disbursement_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The override and network fee come off BEFORE the instructor
  -- disbursement (the founder's ordering, pinned).
  CHECK (instructor_disbursement_cents
    = class_revenue_cents - franchise_override_total_cents - network_fee_cents),
  CHECK (franchise_override_total_cents
    = choreography_override_cents + audio_override_cents),
  CHECK (verdict = 'paid' OR (instructor_disbursement_cents < 0
    AND classes_before IS NULL AND classes_after IS NULL))
);

CREATE TABLE IF NOT EXISTS fitness_cobrand_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  ip_owner_id TEXT NOT NULL,
  distributor_id TEXT NOT NULL,
  net_class_stream_earnings_cents INTEGER NOT NULL CHECK (net_class_stream_earnings_cents >= 0),
  ip_owner_share_bps INTEGER NOT NULL CHECK (ip_owner_share_bps > 0 AND ip_owner_share_bps < 10000),
  distributor_share_bps INTEGER NOT NULL CHECK (distributor_share_bps > 0 AND distributor_share_bps < 10000),
  ip_owner_cents INTEGER NOT NULL CHECK (ip_owner_cents >= 0),
  distributor_cents INTEGER NOT NULL CHECK (distributor_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (ip_owner_share_bps + distributor_share_bps = 10000),
  CHECK (ip_owner_cents + distributor_cents = net_class_stream_earnings_cents)
);

CREATE TABLE IF NOT EXISTS fitness_algorithm_royalty_ledger (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  equipment_type TEXT NOT NULL CHECK (equipment_type IN ('connected_bike', 'treadmill')),
  equipment_id TEXT NOT NULL,
  wearable_active_users INTEGER NOT NULL CHECK (wearable_active_users >= 0),
  algorithm_creator_id TEXT NOT NULL,
  micros_per_active_user INTEGER NOT NULL CHECK (micros_per_active_user > 0),
  royalty_micros INTEGER NOT NULL CHECK (royalty_micros >= 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);

CREATE TABLE IF NOT EXISTS fitness_cocreation_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  enrollment_revenue_cents INTEGER NOT NULL CHECK (enrollment_revenue_cents >= 0),
  waterfall_legs TEXT NOT NULL,
  allocated_total_cents INTEGER NOT NULL CHECK (allocated_total_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The waterfall conserves its basis exactly (largest-remainder exact).
  CHECK (allocated_total_cents = enrollment_revenue_cents)
);

-- The fitness audit escrow + gate states + instant live-event bonuses
-- (migration 0043, PR 39). The founder fitness directive's compliance
-- money: the founder-banded escrow policy of record per (trainer, studio
-- franchise) scope, the position-locked drawdowns the three exposure
-- classes drive, the reconciliation of record the release reads, the two
-- fail-closed gate states the fitness payout gate reads, the instant
-- live-event bonus policy of record per program, and the append-only
-- bonus ledger. No foreign keys by design — the tables key on content-
-- derived event ids, the sender's trainer/program/franchise identifiers,
-- and the escrow's ledger row id (the 0036–0042 discipline).
CREATE TABLE IF NOT EXISTS fitness_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fitness_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('chargeback_reserve', 'class_return_allowance', 'sync_music_licensing_audit')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard.
  UNIQUE (reserve_ledger_id, source_event_id),
  -- UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
  -- lock the balance derives from.
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents)
);

CREATE TABLE IF NOT EXISTS fitness_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fitness_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  hipaa_gdpr_privacy_state TEXT NOT NULL CHECK (hipaa_gdpr_privacy_state IN ('unknown', 'cleared')),
  territorial_exclusivity_state TEXT NOT NULL CHECK (territorial_exclusivity_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, studio_franchise_code)
);

CREATE TABLE IF NOT EXISTS fitness_live_event_bonus_policies (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL UNIQUE,
  bonus_bps INTEGER NOT NULL CHECK (bonus_bps > 0 AND bonus_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fitness_live_event_bonuses (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  studio_franchise_code TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  peak_simultaneous_viewers INTEGER NOT NULL CHECK (peak_simultaneous_viewers >= 0),
  live_event_revenue_cents INTEGER NOT NULL CHECK (live_event_revenue_cents >= 0),
  bonus_bps INTEGER NOT NULL CHECK (bonus_bps > 0 AND bonus_bps <= 10000),
  bonus_cents INTEGER NOT NULL CHECK (bonus_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The pinned pricing arithmetic (integer cents, floor).
  CHECK (bonus_cents = (live_event_revenue_cents * bonus_bps) / 10000)
);

-- The food lane (migration 0044, PR 40) — the founder food directive's
-- durable facts of record: the royalty schedules, the cumulative
-- location-month unit trackers, the host operator and cook-cycle
-- policies, the co-brand weightings and operator waterfalls, and the six
-- append-only application ledgers.
CREATE TABLE IF NOT EXISTS food_recipe_royalty_schedules (
  id TEXT PRIMARY KEY,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  unit_micros_bands TEXT NOT NULL,
  royalty_bps_bands TEXT NOT NULL,
  cpg_royalty_bps INTEGER NOT NULL CHECK (cpg_royalty_bps >= 0 AND cpg_royalty_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chef_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS food_location_unit_months (
  id TEXT PRIMARY KEY,
  ghost_kitchen_location_id TEXT NOT NULL,
  month TEXT NOT NULL,
  cumulative_units INTEGER NOT NULL CHECK (cumulative_units >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ghost_kitchen_location_id, month)
);

CREATE TABLE IF NOT EXISTS food_host_operator_policies (
  id TEXT PRIMARY KEY,
  ghost_kitchen_location_id TEXT NOT NULL UNIQUE,
  brand_licensor_id TEXT NOT NULL,
  brand_licensor_holdback_bps INTEGER NOT NULL CHECK (brand_licensor_holdback_bps >= 0 AND brand_licensor_holdback_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_cook_cycle_policies (
  id TEXT PRIMARY KEY,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  micros_per_cook_cycle INTEGER NOT NULL CHECK (micros_per_cook_cycle >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chef_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS food_cobrand_weightings (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  leg_id TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  payee_role TEXT NOT NULL CHECK (payee_role IN ('chef', 'brand', 'operator', 'supplier_partner')),
  weight_bps INTEGER NOT NULL CHECK (weight_bps > 0 AND weight_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (recipe_id, leg_id)
);
CREATE INDEX IF NOT EXISTS idx_food_cobrand_weightings_recipe
  ON food_cobrand_weightings (recipe_id);

CREATE TABLE IF NOT EXISTS food_operator_waterfalls (
  id TEXT PRIMARY KEY,
  ghost_kitchen_location_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  weight_bps INTEGER NOT NULL CHECK (weight_bps > 0 AND weight_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ghost_kitchen_location_id, operator_id)
);
CREATE INDEX IF NOT EXISTS idx_food_operator_waterfalls_location
  ON food_operator_waterfalls (ghost_kitchen_location_id);

CREATE TABLE IF NOT EXISTS food_realization_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  ghost_kitchen_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_menu_item_sales_cents INTEGER NOT NULL CHECK (gross_menu_item_sales_cents >= 0),
  approved_ingredient_cogs_cents INTEGER NOT NULL CHECK (approved_ingredient_cogs_cents >= 0),
  delivery_platform_engine_cut_cents INTEGER NOT NULL CHECK (delivery_platform_engine_cut_cents >= 0),
  local_food_service_taxes_cents INTEGER NOT NULL CHECK (local_food_service_taxes_cents >= 0),
  net_culinary_ip_pool_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- THE NET RECIPE REALIZATION identity, pinned: the four legs conserve
  -- the gross menu item sales exactly.
  CHECK (
    approved_ingredient_cogs_cents
    + delivery_platform_engine_cut_cents
    + local_food_service_taxes_cents
    + net_culinary_ip_pool_cents
    = gross_menu_item_sales_cents
  )
);

CREATE TABLE IF NOT EXISTS food_recipe_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  ghost_kitchen_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  platform TEXT NOT NULL,
  units_sold INTEGER NOT NULL CHECK (units_sold > 0),
  net_basis_cents INTEGER NOT NULL CHECK (net_basis_cents >= 0),
  schedule_ref TEXT NOT NULL,
  unit_walk_legs TEXT NOT NULL,
  unit_payout_micros INTEGER NOT NULL CHECK (unit_payout_micros >= 0),
  unit_payout_cents INTEGER NOT NULL CHECK (unit_payout_cents >= 0),
  royalty_bps INTEGER NOT NULL CHECK (royalty_bps >= 0 AND royalty_bps <= 10000),
  percentage_split_cents INTEGER NOT NULL CHECK (percentage_split_cents >= 0),
  units_before INTEGER NOT NULL CHECK (units_before >= 0),
  units_after INTEGER NOT NULL CHECK (units_after >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('paid')),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The pinned band arithmetic: the payout cents floor the micros (one
  -- cent = 1,000,000 statement micros, per migration 0044); the
  -- percentage split prices the row's net basis at the row's band rate.
  CHECK (
    unit_payout_cents = unit_payout_micros / 1000000
    AND percentage_split_cents = (net_basis_cents * royalty_bps) / 10000
    AND units_after = units_before + units_sold
  )
);

CREATE TABLE IF NOT EXISTS food_cobrand_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  ghost_kitchen_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  royalty_pot_cents INTEGER NOT NULL CHECK (royalty_pot_cents > 0),
  weighting_legs TEXT NOT NULL,
  allocated_total_cents INTEGER NOT NULL CHECK (allocated_total_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The pot conserves exactly: the legs' allocated shares sum to the pot.
  CHECK (allocated_total_cents = royalty_pot_cents)
);

CREATE TABLE IF NOT EXISTS food_host_operator_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  ghost_kitchen_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  platform TEXT NOT NULL,
  tickets INTEGER NOT NULL CHECK (tickets > 0),
  physical_preparation_margin_cents INTEGER NOT NULL CHECK (physical_preparation_margin_cents >= 0),
  brand_licensor_id TEXT NOT NULL,
  brand_licensor_holdback_bps INTEGER NOT NULL CHECK (brand_licensor_holdback_bps >= 0 AND brand_licensor_holdback_bps <= 10000),
  brand_licensor_holdback_cents INTEGER NOT NULL CHECK (brand_licensor_holdback_cents >= 0),
  host_operator_cents INTEGER NOT NULL CHECK (host_operator_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The margin routes DIRECTLY to the local operator first; the
  -- licensor's cut holds back — the two legs conserve the margin exactly.
  CHECK (
    host_operator_cents
    = physical_preparation_margin_cents - brand_licensor_holdback_cents
  )
);

CREATE TABLE IF NOT EXISTS food_cook_cycle_royalties (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  chef_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  ghost_kitchen_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  meal_kits_produced INTEGER NOT NULL CHECK (meal_kits_produced >= 0),
  cook_cycles_executed INTEGER NOT NULL CHECK (cook_cycles_executed > 0),
  payee_id TEXT NOT NULL,
  micros_per_cook_cycle INTEGER NOT NULL CHECK (micros_per_cook_cycle >= 0),
  royalty_micros INTEGER NOT NULL CHECK (royalty_micros >= 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The pinned per-execution arithmetic (integer cents, floor; one
  -- cent = 1,000,000 statement micros, per migration 0044).
  CHECK (royalty_micros = cook_cycles_executed * micros_per_cook_cycle
    AND royalty_cents = royalty_micros / 1000000)
);

CREATE TABLE IF NOT EXISTS food_supplier_rebate_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  supplier TEXT NOT NULL CHECK (supplier IN ('sysco', 'us_foods')),
  ghost_kitchen_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  rebate_basis_cents INTEGER NOT NULL CHECK (rebate_basis_cents >= 0),
  volume_rebate_cents INTEGER NOT NULL CHECK (volume_rebate_cents >= 0),
  routing_legs TEXT NOT NULL,
  routed_total_cents INTEGER NOT NULL CHECK (routed_total_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The rebate conserves exactly: the legs' routed shares sum to the
  -- volume kickback.
  CHECK (routed_total_cents = volume_rebate_cents)
);

-- The service lane (migration 0046, PR 42) — the founder service
-- directive's policies of record, waterfalls, and seven application
-- ledgers for salon, med-spa, and hospitality franchise reconciliation.
-- The CHECK vocabularies here are byte-identical to the TS unions in
-- src/modules/service/records.ts (the PR 129 lesson: the applied
-- CHECK rejects any token the TypeScript side still accepts, so the two
-- sides are built together).

CREATE TABLE IF NOT EXISTS service_franchise_schedules (
  id TEXT PRIMARY KEY,
  salon_location_id TEXT NOT NULL UNIQUE,
  master_franchisor_royalty_bps INTEGER NOT NULL CHECK (master_franchisor_royalty_bps >= 0 AND master_franchisor_royalty_bps <= 10000),
  technician_commission_bps INTEGER NOT NULL CHECK (technician_commission_bps >= 0 AND technician_commission_bps <= 10000),
  house_margin_bps INTEGER NOT NULL CHECK (house_margin_bps >= 0 AND house_margin_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The three legs partition the gross EXACTLY (the validator's clause).
  CHECK (
    master_franchisor_royalty_bps
    + technician_commission_bps
    + house_margin_bps
    = 10000
  )
);

CREATE TABLE IF NOT EXISTS service_protocol_policies (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL UNIQUE,
  payee_id TEXT NOT NULL,
  micros_per_treatment INTEGER NOT NULL CHECK (micros_per_treatment >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_redemption_policies (
  id TEXT PRIMARY KEY,
  home_location_id TEXT NOT NULL UNIQUE,
  franchisor_royalty_bps INTEGER NOT NULL CHECK (franchisor_royalty_bps >= 0 AND franchisor_royalty_bps <= 10000),
  home_admin_bps INTEGER NOT NULL CHECK (home_admin_bps >= 0 AND home_admin_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The two rates sum to AT MOST 10000 — the visiting location routes
  -- the residual (the validator's clause).
  CHECK (franchisor_royalty_bps + home_admin_bps <= 10000)
);

CREATE TABLE IF NOT EXISTS service_breakage_policies (
  id TEXT PRIMARY KEY,
  home_location_id TEXT NOT NULL UNIQUE,
  franchisor_breakage_bps INTEGER NOT NULL CHECK (franchisor_breakage_bps >= 0 AND franchisor_breakage_bps <= 10000),
  franchisee_breakage_bps INTEGER NOT NULL CHECK (franchisee_breakage_bps >= 0 AND franchisee_breakage_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The unredeemed funds allocate fully across the two contractual legs.
  CHECK (franchisor_breakage_bps + franchisee_breakage_bps = 10000)
);

CREATE TABLE IF NOT EXISTS service_rebate_waterfalls (
  id TEXT PRIMARY KEY,
  salon_location_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  weight_bps INTEGER NOT NULL CHECK (weight_bps > 0 AND weight_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (salon_location_id, ledger_id)
);
CREATE INDEX IF NOT EXISTS idx_service_rebate_waterfalls_location
  ON service_rebate_waterfalls (salon_location_id);

CREATE TABLE IF NOT EXISTS service_booth_lease_policies (
  id TEXT PRIMARY KEY,
  salon_location_id TEXT NOT NULL UNIQUE,
  chair_rent_payee_id TEXT NOT NULL,
  retail_commission_bps INTEGER NOT NULL CHECK (retail_commission_bps >= 0 AND retail_commission_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_realization_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('pos_ticket', 'hotel_folio')),
  stylist_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  salon_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_service_ticket_cents INTEGER NOT NULL CHECK (gross_service_ticket_cents >= 0),
  backbar_product_cogs_cents INTEGER NOT NULL CHECK (backbar_product_cogs_cents >= 0),
  card_processing_engine_cut_cents INTEGER NOT NULL CHECK (card_processing_engine_cut_cents >= 0),
  service_sales_taxes_cents INTEGER NOT NULL CHECK (service_sales_taxes_cents >= 0),
  net_realized_service_pool_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- THE NET SERVICE REALIZATION identity, pinned: the four legs conserve
  -- the gross service ticket exactly.
  CHECK (
    backbar_product_cogs_cents
    + card_processing_engine_cut_cents
    + service_sales_taxes_cents
    + net_realized_service_pool_cents
    = gross_service_ticket_cents
  )
);

CREATE TABLE IF NOT EXISTS service_franchise_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('pos_ticket', 'hotel_folio')),
  stylist_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  salon_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross_service_ticket_cents INTEGER NOT NULL CHECK (gross_service_ticket_cents >= 0),
  schedule_ref TEXT NOT NULL,
  master_franchisor_royalty_bps INTEGER NOT NULL CHECK (master_franchisor_royalty_bps >= 0 AND master_franchisor_royalty_bps <= 10000),
  master_franchisor_royalty_cents INTEGER NOT NULL CHECK (master_franchisor_royalty_cents >= 0),
  technician_commission_bps INTEGER NOT NULL CHECK (technician_commission_bps >= 0 AND technician_commission_bps <= 10000),
  technician_commission_cents INTEGER NOT NULL CHECK (technician_commission_cents >= 0),
  house_margin_bps INTEGER NOT NULL CHECK (house_margin_bps >= 0 AND house_margin_bps <= 10000),
  house_margin_cents INTEGER NOT NULL CHECK (house_margin_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The three legs conserve the gross exactly — the house location
  -- margin routes the residual (the founder's 5 / 45 / 50 example).
  CHECK (
    master_franchisor_royalty_cents
    + technician_commission_cents
    + house_margin_cents
    = gross_service_ticket_cents
  )
);

CREATE TABLE IF NOT EXISTS service_protocol_micro_royalties (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('pos_ticket', 'hotel_folio')),
  stylist_id TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  salon_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  micros_per_treatment INTEGER NOT NULL CHECK (micros_per_treatment >= 0),
  royalty_micros INTEGER NOT NULL CHECK (royalty_micros >= 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- One treatment per logged row; the fee floors into payable cents
  -- (one cent = 1,000,000 statement micros, per migration 0046).
  CHECK (
    royalty_micros = micros_per_treatment
    AND royalty_cents = royalty_micros / 1000000
  )
);

CREATE TABLE IF NOT EXISTS service_redemption_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  home_location_id TEXT NOT NULL,
  visiting_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  service_allocation_fee_cents INTEGER NOT NULL CHECK (service_allocation_fee_cents >= 0),
  franchisor_royalty_bps INTEGER NOT NULL CHECK (franchisor_royalty_bps >= 0 AND franchisor_royalty_bps <= 10000),
  franchisor_royalty_cents INTEGER NOT NULL CHECK (franchisor_royalty_cents >= 0),
  home_admin_bps INTEGER NOT NULL CHECK (home_admin_bps >= 0 AND home_admin_bps <= 10000),
  home_admin_cents INTEGER NOT NULL CHECK (home_admin_cents >= 0),
  visiting_location_cents INTEGER NOT NULL CHECK (visiting_location_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The fee conserves exactly: the fee routes DIRECTLY to the visiting
  -- location; the royalty and the home admin cut distribute.
  CHECK (
    franchisor_royalty_cents
    + home_admin_cents
    + visiting_location_cents
    = service_allocation_fee_cents
  )
);

CREATE TABLE IF NOT EXISTS service_breakage_allocations (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  home_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  unredeemed_amount_cents INTEGER NOT NULL CHECK (unredeemed_amount_cents >= 0),
  franchisor_breakage_bps INTEGER NOT NULL CHECK (franchisor_breakage_bps >= 0 AND franchisor_breakage_bps <= 10000),
  franchisor_breakage_cents INTEGER NOT NULL CHECK (franchisor_breakage_cents >= 0),
  franchisee_breakage_cents INTEGER NOT NULL CHECK (franchisee_breakage_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The funds conserve exactly: the franchisee routes the residual.
  CHECK (
    franchisor_breakage_cents
    + franchisee_breakage_cents
    = unredeemed_amount_cents
  )
);

CREATE TABLE IF NOT EXISTS service_rebate_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  distributor TEXT NOT NULL CHECK (distributor IN ('loreal', 'estee_lauder')),
  salon_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  rebate_basis_cents INTEGER NOT NULL CHECK (rebate_basis_cents >= 0),
  volume_rebate_cents INTEGER NOT NULL CHECK (volume_rebate_cents >= 0),
  routing_legs TEXT NOT NULL,
  routed_total_cents INTEGER NOT NULL CHECK (routed_total_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- The rebate conserves exactly: the legs' routed shares sum to the
  -- volume kickback.
  CHECK (routed_total_cents = volume_rebate_cents)
);

CREATE TABLE IF NOT EXISTS service_booth_lease_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  salon_location_id TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  leg_kind TEXT NOT NULL CHECK (leg_kind IN ('chair_rent', 'retail_commission')),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  retail_commission_bps INTEGER NOT NULL CHECK (retail_commission_bps >= 0 AND retail_commission_bps <= 10000),
  studio_owner_cents INTEGER NOT NULL CHECK (studio_owner_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- THE ISOLATION, pinned: the flat chair rent routes exact to the
  -- studio owner (never commissioned); the retail sale routes its
  -- floored commission (never the flat rent).
  CHECK (
    (
      leg_kind = 'chair_rent'
      AND studio_owner_cents = gross_cents
      AND retail_commission_bps = 0
    )
    OR
    (
      leg_kind = 'retail_commission'
      AND studio_owner_cents = (gross_cents * retail_commission_bps) / 10000
    )
  )
);

-- Migration 0048 — the developer lane's registries of record, the two
-- cumulative monthly trackers, and the seven application ledgers. The
-- vocabulary here is byte-identical to the TS unions and the Supabase
-- CHECKs (the PR 129 / 41 lesson).
CREATE TABLE IF NOT EXISTS developer_api_royalty_policies (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL UNIQUE,
  royalty_mode TEXT NOT NULL CHECK (royalty_mode IN ('per_call', 'usage_share')),
  payee_id TEXT NOT NULL CHECK (length(payee_id) > 0),
  tier_bands TEXT NOT NULL CHECK (length(tier_bands) > 0),
  usage_share_bps INTEGER NOT NULL CHECK (usage_share_bps >= 0 AND usage_share_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_api_call_months (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  cumulative_calls INTEGER NOT NULL CHECK (cumulative_calls >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (developer_id, month)
);

CREATE TABLE IF NOT EXISTS developer_marketplace_split_policies (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL UNIQUE,
  platform_share_bps INTEGER NOT NULL CHECK (platform_share_bps >= 1500 AND platform_share_bps <= 3000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_copackage_contribution_legs (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  maintainer_id TEXT NOT NULL,
  commits INTEGER NOT NULL CHECK (commits >= 0),
  pull_requests INTEGER NOT NULL CHECK (pull_requests >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, maintainer_id),
  CHECK (length(package_id) > 0),
  CHECK (length(maintainer_id) > 0),
  CHECK (commits + pull_requests > 0)
);

CREATE TABLE IF NOT EXISTS developer_dependency_maintainer_ledgers (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL UNIQUE,
  maintainer_payee_id TEXT NOT NULL CHECK (length(maintainer_payee_id) > 0),
  micros_per_deploy INTEGER NOT NULL CHECK (micros_per_deploy >= 0),
  micros_per_active_instance INTEGER NOT NULL CHECK (micros_per_active_instance >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A ledger pricing nothing is a hostile registration.
  CHECK (micros_per_deploy > 0 OR micros_per_active_instance > 0)
);

CREATE TABLE IF NOT EXISTS developer_whitelabel_license_deals (
  id TEXT PRIMARY KEY,
  sdk_package_hash TEXT NOT NULL UNIQUE,
  owner_payee_id TEXT NOT NULL CHECK (length(owner_payee_id) > 0),
  seat_micros_per_seat INTEGER NOT NULL CHECK (seat_micros_per_seat >= 0),
  deployment_micros_per_deployment INTEGER NOT NULL CHECK (deployment_micros_per_deployment >= 0),
  minimum_monthly_guarantee_cents INTEGER NOT NULL CHECK (minimum_monthly_guarantee_cents >= 0),
  overage_royalty_bps INTEGER NOT NULL CHECK (overage_royalty_bps >= 0 AND overage_royalty_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A deal pricing nothing is a hostile registration.
  CHECK (seat_micros_per_seat > 0 OR deployment_micros_per_deployment > 0)
);

CREATE TABLE IF NOT EXISTS developer_tool_royalty_policies (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL UNIQUE,
  builder_payee_id TEXT NOT NULL CHECK (length(builder_payee_id) > 0),
  micros_per_call INTEGER NOT NULL CHECK (micros_per_call > 0),
  builder_share_bps INTEGER NOT NULL CHECK (builder_share_bps >= 0 AND builder_share_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS developer_api_realization_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  feed TEXT NOT NULL CHECK (feed IN ('gateway_usage', 'sdk_initialization', 'usage_billing_token')),
  developer_id TEXT NOT NULL CHECK (length(developer_id) > 0),
  api_endpoint_id TEXT NOT NULL,
  sdk_package_hash TEXT NOT NULL CHECK (length(sdk_package_hash) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_api_transaction_revenue_cents INTEGER NOT NULL CHECK (gross_api_transaction_revenue_cents >= 0),
  cloud_infrastructure_hosting_base_cents INTEGER NOT NULL CHECK (cloud_infrastructure_hosting_base_cents >= 0),
  payment_processing_gate_cut_cents INTEGER NOT NULL CHECK (payment_processing_gate_cut_cents >= 0),
  enterprise_sla_reserve_cents INTEGER NOT NULL CHECK (enterprise_sla_reserve_cents >= 0),
  net_code_usage_pool_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id is the replay guard.
  UNIQUE (source_event_id),
  -- THE NET API REALIZATION identity, pinned: the four legs conserve
  -- the gross exactly.
  CHECK (
    cloud_infrastructure_hosting_base_cents
    + payment_processing_gate_cut_cents
    + enterprise_sla_reserve_cents
    + net_code_usage_pool_cents
    = gross_api_transaction_revenue_cents
  )
);

CREATE TABLE IF NOT EXISTS developer_api_micro_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  feed TEXT NOT NULL CHECK (feed IN ('gateway_usage', 'sdk_initialization', 'usage_billing_token')),
  developer_id TEXT NOT NULL CHECK (length(developer_id) > 0),
  api_endpoint_id TEXT NOT NULL,
  sdk_package_hash TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  payee_id TEXT NOT NULL CHECK (length(payee_id) > 0),
  royalty_mode TEXT NOT NULL CHECK (royalty_mode IN ('per_call', 'usage_share')),
  policy_ref TEXT NOT NULL,
  api_calls INTEGER NOT NULL CHECK (api_calls >= 0),
  tier_legs TEXT NOT NULL,
  usage_share_bps INTEGER NOT NULL CHECK (usage_share_bps >= 0 AND usage_share_bps <= 10000),
  royalty_basis_cents INTEGER NOT NULL CHECK (royalty_basis_cents >= 0),
  royalty_micros INTEGER NOT NULL CHECK (royalty_micros >= 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents = royalty_micros / 1000000),
  monthly_calls_before INTEGER NOT NULL CHECK (monthly_calls_before >= 0),
  monthly_calls_after INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (monthly_calls_after = monthly_calls_before + api_calls)
);

CREATE TABLE IF NOT EXISTS developer_marketplace_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('apple_app_store', 'google_play', 'unity_asset_store', 'vscode_marketplace')),
  developer_id TEXT NOT NULL CHECK (length(developer_id) > 0),
  sdk_package_hash TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_sale_cents INTEGER NOT NULL CHECK (gross_sale_cents >= 0),
  policy_ref TEXT NOT NULL,
  platform_share_bps INTEGER NOT NULL CHECK (platform_share_bps >= 1500 AND platform_share_bps <= 3000),
  platform_cents INTEGER NOT NULL,
  developer_net_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The founder band's platform share floors and the split conserves
  -- the sale exactly.
  CHECK (platform_cents = (gross_sale_cents * platform_share_bps) / 10000),
  CHECK (platform_cents + developer_net_cents = gross_sale_cents)
);

CREATE TABLE IF NOT EXISTS developer_copackage_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  package_id TEXT NOT NULL CHECK (length(package_id) > 0),
  developer_id TEXT NOT NULL,
  revenue_kind TEXT NOT NULL CHECK (revenue_kind IN ('subscription', 'sponsorship')),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_revenue_cents INTEGER NOT NULL CHECK (gross_revenue_cents >= 0),
  split_legs TEXT NOT NULL CHECK (length(split_legs) > 0),
  allocated_total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The contribution-weighted shares conserve the revenue exactly.
  CHECK (allocated_total_cents = gross_revenue_cents)
);

CREATE TABLE IF NOT EXISTS developer_dependency_fee_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  component_id TEXT NOT NULL CHECK (length(component_id) > 0),
  scan_context TEXT NOT NULL CHECK (scan_context IN ('ci_deploy', 'runtime_fleet')),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  deploy_count INTEGER NOT NULL CHECK (deploy_count >= 0),
  active_instances INTEGER NOT NULL CHECK (active_instances >= 0),
  ledger_ref TEXT NOT NULL,
  maintainer_payee_id TEXT NOT NULL CHECK (length(maintainer_payee_id) > 0),
  micros_per_deploy INTEGER NOT NULL,
  micros_per_active_instance INTEGER NOT NULL,
  fee_micros INTEGER NOT NULL CHECK (fee_micros >= 0),
  fee_cents INTEGER NOT NULL CHECK (fee_cents = fee_micros / 1000000),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);

CREATE TABLE IF NOT EXISTS developer_whitelabel_license_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  sdk_package_hash TEXT NOT NULL CHECK (length(sdk_package_hash) > 0),
  licensor_id TEXT NOT NULL CHECK (length(licensor_id) > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('seat', 'deployment')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  deal_ref TEXT NOT NULL,
  owner_payee_id TEXT NOT NULL CHECK (length(owner_payee_id) > 0),
  usage_micros INTEGER NOT NULL CHECK (usage_micros >= 0),
  usage_cents INTEGER NOT NULL CHECK (usage_cents = usage_micros / 1000000),
  monthly_usage_before_cents INTEGER NOT NULL,
  monthly_usage_after_cents INTEGER NOT NULL,
  mmg_cents INTEGER NOT NULL CHECK (mmg_cents >= 0),
  recouped_cents INTEGER NOT NULL,
  overage_cents INTEGER NOT NULL,
  overage_royalty_bps INTEGER NOT NULL CHECK (overage_royalty_bps >= 0 AND overage_royalty_bps <= 10000),
  overage_royalty_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (monthly_usage_after_cents = monthly_usage_before_cents + usage_cents),
  -- THE MMG RECOUPMENT, pinned: the guarantee recoups against the
  -- month's cumulative usage.
  CHECK (
    recouped_cents
    = min(mmg_cents, monthly_usage_after_cents)
      - min(mmg_cents, monthly_usage_before_cents)
  ),
  CHECK (overage_cents = usage_cents - recouped_cents),
  CHECK (overage_royalty_cents = (overage_cents * overage_royalty_bps) / 10000)
);

CREATE TABLE IF NOT EXISTS developer_whitelabel_usage_months (
  id TEXT PRIMARY KEY,
  sdk_package_hash TEXT NOT NULL,
  licensor_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  cumulative_usage_cents INTEGER NOT NULL CHECK (cumulative_usage_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (sdk_package_hash, licensor_id, month)
);

CREATE TABLE IF NOT EXISTS developer_agent_tool_call_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  tool_id TEXT NOT NULL CHECK (tool_id IN ('web_search', 'database_query', 'payment_action')),
  call_count INTEGER NOT NULL CHECK (call_count > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  policy_ref TEXT NOT NULL,
  builder_payee_id TEXT NOT NULL CHECK (length(builder_payee_id) > 0),
  micros_per_call INTEGER NOT NULL CHECK (micros_per_call > 0),
  settlement_micros INTEGER NOT NULL CHECK (settlement_micros >= 0),
  settlement_cents INTEGER NOT NULL CHECK (settlement_cents = settlement_micros / 1000000),
  builder_share_bps INTEGER NOT NULL CHECK (builder_share_bps >= 0 AND builder_share_bps <= 10000),
  builder_cents INTEGER NOT NULL,
  platform_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  CHECK (builder_cents = (settlement_cents * builder_share_bps) / 10000),
  CHECK (builder_cents + platform_cents = settlement_cents)
);

-- The culinary audit escrow (migration 0045, PR 41) — the founder
-- culinary directive's escrow bucket, payout-gate states, and viral-menu
-- pop-up decommissioning facts. The drawdown-class and gate-state vocab
-- here is byte-identical to the TS arrays and the Supabase CHECKs (the
-- PR 129 lesson).
CREATE TABLE IF NOT EXISTS culinary_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS culinary_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('refund_allowance', 'spoilage_chargeback', 'supplier_quality_audit')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard.
  UNIQUE (reserve_ledger_id, source_event_id),
  -- UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
  -- lock the balance derives from.
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents)
);

CREATE TABLE IF NOT EXISTS culinary_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS culinary_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  ghost_kitchen_location_code TEXT NOT NULL,
  health_inspection_state TEXT NOT NULL CHECK (health_inspection_state IN ('unknown', 'cleared')),
  territorial_exclusivity_state TEXT NOT NULL CHECK (territorial_exclusivity_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, ghost_kitchen_location_code)
);

CREATE TABLE IF NOT EXISTS culinary_popup_experiences (
  id TEXT PRIMARY KEY,
  popup_ref TEXT NOT NULL UNIQUE,
  chef_id TEXT NOT NULL,
  ghost_kitchen_location_code TEXT NOT NULL,
  menu_theme TEXT NOT NULL,
  window_start_date TEXT NOT NULL,
  window_end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The campaign window of record runs forward.
  CHECK (window_end_date >= window_start_date)
);

CREATE TABLE IF NOT EXISTS culinary_popup_writeoffs (
  id TEXT PRIMARY KEY,
  popup_experience_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  unsold_packages INTEGER NOT NULL CHECK (unsold_packages >= 0),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  writeoff_cents INTEGER NOT NULL CHECK (writeoff_cents >= 0),
  evidence_ref TEXT NOT NULL,
  calculated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- UNIQUE per (popup_experience_id, source_event_id) is the replay
  -- guard.
  UNIQUE (popup_experience_id, source_event_id),
  -- The pinned write-off arithmetic (integer cents).
  CHECK (writeoff_cents = unsold_packages * unit_cost_cents)
);

-- Service audit escrow + services payout gate states (migration 0047, PR
-- 43). The services twin of the culinary escrow tables above: the
-- founder-banded policy per (stylist, salon location) scope, the
-- position-locked drawdowns (client refund allowances, product return
-- chargebacks, quarterly backbar inventory audits), the verified
-- reconciliation of record (the release gate's key), and the two durable
-- gate states the services payout gate reads fail-closed. The CHECK
-- vocabularies are byte-identical to the TS-side arrays in
-- modules/service/records.ts (the PR 129/130 lesson).
CREATE TABLE IF NOT EXISTS service_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('refund_allowance', 'product_return_chargeback', 'backbar_inventory_audit')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard.
  UNIQUE (reserve_ledger_id, source_event_id),
  -- UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
  -- lock the balance derives from.
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents)
);

CREATE TABLE IF NOT EXISTS service_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  salon_location_id TEXT NOT NULL,
  health_license_state TEXT NOT NULL CHECK (health_license_state IN ('unknown', 'verified')),
  territorial_exclusivity_state TEXT NOT NULL CHECK (territorial_exclusivity_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, salon_location_id)
);

-- SOFTWARE_AUDIT_ESCROW + the software payout gate states (migration 0049,
-- PR 45, the founder software directive): the SOFTWARE_AUDIT_ESCROW
-- founder-banded rate of record per (developer, API endpoint) scope, the
-- position-locked drawdowns (uptime outage penalty refunds, API rate-limit
-- breach credits, quarterly security compliance audits), the verified
-- reconciliation of record (the release gate's key), and the two durable
-- gate states the software payout gate reads fail-closed. The CHECK
-- vocabularies are byte-identical to the TS-side arrays in
-- modules/software/records.ts (the PR 129/130 lesson).
CREATE TABLE IF NOT EXISTS software_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS software_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('uptime_outage_penalty_refund', 'api_rate_limit_breach_credit', 'quarterly_security_compliance_audit')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard.
  UNIQUE (reserve_ledger_id, source_event_id),
  -- UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
  -- lock the balance derives from.
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents)
);

CREATE TABLE IF NOT EXISTS software_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS software_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  api_endpoint_id TEXT NOT NULL,
  api_uptime_sla_state TEXT NOT NULL CHECK (api_uptime_sla_state IN ('unknown', 'verified')),
  security_audit_state TEXT NOT NULL CHECK (security_audit_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, api_endpoint_id)
);

-- The hardware patent lane (migration 0050, PR 46, the founder hardware
-- directive): the patent pools of record (the MPEG-LA / Avanci shape),
-- their verified essentiality holder weightings, the tiered FRAND SEP
-- royalty policies (each band a FRAND rate bps + per-unit cap), the
-- automotive OEM pool routings, the clean-tech telemetry policies, the
-- OTA unlock split policies, the cross-licensing agreements (canonical
-- pair orientation), the cumulative monthly unit tracker, and the seven
-- append-only application ledgers (realization, SEP royalty, pool
-- routing, pool waterfall, telemetry royalty, OTA unlock split, and
-- cross-license net settlement). The CHECK vocabularies are byte-
-- identical to the TS-side arrays in modules/hardware/records.ts (the
-- PR 129/130/133/134 lesson); the identities pin the founder's exact
-- money math at the database.
CREATE TABLE IF NOT EXISTS hardware_patent_pools (
  id TEXT PRIMARY KEY,
  pool_code TEXT NOT NULL UNIQUE,
  pool_name TEXT NOT NULL CHECK (length(pool_name) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_pool_holder_legs (
  id TEXT PRIMARY KEY,
  pool_code TEXT NOT NULL,
  holder_payee_id TEXT NOT NULL CHECK (length(holder_payee_id) > 0),
  -- The verified essentiality score (1–100) — the waterfall's weight.
  essentiality_score INTEGER NOT NULL CHECK (essentiality_score >= 1 AND essentiality_score <= 100),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (pool_code, holder_payee_id)
);
CREATE INDEX IF NOT EXISTS idx_hardware_pool_holder_legs_pool
  ON hardware_pool_holder_legs (pool_code);

CREATE TABLE IF NOT EXISTS hardware_sep_royalty_policies (
  id TEXT PRIMARY KEY,
  patent_family_id TEXT NOT NULL,
  sep_pool_code TEXT NOT NULL,
  payee_id TEXT NOT NULL CHECK (length(payee_id) > 0),
  -- The tier bands of record (JSON text, ascending, open top last).
  tier_bands TEXT NOT NULL CHECK (length(tier_bands) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (patent_family_id, sep_pool_code)
);

CREATE TABLE IF NOT EXISTS hardware_automotive_pool_assignments (
  id TEXT PRIMARY KEY,
  oem_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  cellular_pool_code TEXT NOT NULL CHECK (length(cellular_pool_code) > 0),
  navigation_pool_code TEXT NOT NULL CHECK (length(navigation_pool_code) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (oem_id, line_id)
);

CREATE TABLE IF NOT EXISTS hardware_cleantech_royalty_policies (
  id TEXT PRIMARY KEY,
  patent_family_id TEXT NOT NULL UNIQUE,
  payee_id TEXT NOT NULL CHECK (length(payee_id) > 0),
  -- Statement micros per delivered kilowatt-hour / completed cycle.
  micros_per_kwh INTEGER NOT NULL CHECK (micros_per_kwh >= 0),
  micros_per_charge_cycle INTEGER NOT NULL CHECK (micros_per_charge_cycle >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_ota_unlock_policies (
  id TEXT PRIMARY KEY,
  feature_code TEXT NOT NULL UNIQUE,
  sensor_licensor_payee_id TEXT NOT NULL CHECK (length(sensor_licensor_payee_id) > 0),
  -- Statement micros per unlock event (> 0 — a policy pricing nothing
  -- is a hostile registration).
  micros_per_unlock INTEGER NOT NULL CHECK (micros_per_unlock > 0),
  -- The licensor's share bps; the residual is the platform's.
  licensor_share_bps INTEGER NOT NULL CHECK (licensor_share_bps >= 0 AND licensor_share_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_cross_license_agreements (
  id TEXT PRIMARY KEY,
  agreement_ref TEXT NOT NULL UNIQUE,
  -- The pair stored canonically (a < b) so the netting walk reads one
  -- direction of identity.
  company_a_id TEXT NOT NULL,
  company_b_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_a_id, company_b_id),
  CHECK (company_a_id < company_b_id),
  CHECK (company_a_id <> company_b_id)
);

CREATE TABLE IF NOT EXISTS hardware_sep_unit_months (
  id TEXT PRIMARY KEY,
  licensee_id TEXT NOT NULL,
  patent_family_id TEXT NOT NULL,
  sep_pool_code TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  cumulative_units INTEGER NOT NULL CHECK (cumulative_units > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (licensee_id, patent_family_id, sep_pool_code, month)
);

CREATE TABLE IF NOT EXISTS hardware_realization_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  -- The founder-specified realization keys of record.
  patent_family_id TEXT NOT NULL CHECK (length(patent_family_id) > 0),
  sep_pool_code TEXT NOT NULL CHECK (length(sep_pool_code) > 0),
  device_imei_mac TEXT NOT NULL CHECK (length(device_imei_mac) > 0),
  eid TEXT,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  device_wholesale_asp_cents INTEGER NOT NULL CHECK (device_wholesale_asp_cents >= 0),
  component_cogs_base_cents INTEGER NOT NULL CHECK (component_cogs_base_cents >= 0),
  non_essential_bom_cents INTEGER NOT NULL CHECK (non_essential_bom_cents >= 0),
  net_patentable_device_value_base_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('paid', 'held_negative_net')),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id — the replay guard.
  UNIQUE (source_event_id),
  -- THE NET HARDWARE PATENT REALIZATION, pinned: device wholesale ASP
  -- minus component COGS base minus non-essential BOM = the Net
  -- Patentable Device Value Base; the held verdict records the
  -- negative net.
  CHECK (
    net_patentable_device_value_base_cents
    = device_wholesale_asp_cents - component_cogs_base_cents - non_essential_bom_cents
  ),
  CHECK (
    (net_patentable_device_value_base_cents < 0 AND verdict = 'held_negative_net')
    OR (net_patentable_device_value_base_cents >= 0 AND verdict = 'paid')
  )
);

CREATE TABLE IF NOT EXISTS hardware_sep_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  licensee_id TEXT NOT NULL CHECK (length(licensee_id) > 0),
  patent_family_id TEXT NOT NULL CHECK (length(patent_family_id) > 0),
  sep_pool_code TEXT NOT NULL CHECK (length(sep_pool_code) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  policy_ref TEXT NOT NULL,
  payee_id TEXT NOT NULL CHECK (length(payee_id) > 0),
  device_mac TEXT NOT NULL CHECK (length(device_mac) > 0),
  connected_units INTEGER NOT NULL CHECK (connected_units > 0),
  -- The per-unit royalty basis of record (exact cents).
  royalty_basis_cents INTEGER NOT NULL CHECK (royalty_basis_cents >= 0),
  tier_legs TEXT NOT NULL CHECK (length(tier_legs) > 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  cumulative_units_before INTEGER NOT NULL CHECK (cumulative_units_before >= 0),
  cumulative_units_after INTEGER NOT NULL CHECK (cumulative_units_after > 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id — the replay guard.
  UNIQUE (source_event_id),
  -- The cumulative position, pinned.
  CHECK (cumulative_units_after = cumulative_units_before + connected_units)
);
CREATE INDEX IF NOT EXISTS idx_hardware_sep_royalty_applications_netting
  ON hardware_sep_royalty_applications (licensee_id, payee_id, period);

CREATE TABLE IF NOT EXISTS hardware_pool_routing_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  oem_id TEXT NOT NULL CHECK (length(oem_id) > 0),
  line_id TEXT NOT NULL CHECK (length(line_id) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  assignment_ref TEXT NOT NULL,
  serials_produced INTEGER NOT NULL CHECK (serials_produced > 0),
  cellular_pool_code TEXT NOT NULL CHECK (length(cellular_pool_code) > 0),
  navigation_pool_code TEXT NOT NULL CHECK (length(navigation_pool_code) > 0),
  cellular_fee_per_vehicle_cents INTEGER NOT NULL CHECK (cellular_fee_per_vehicle_cents >= 0),
  navigation_fee_per_vehicle_cents INTEGER NOT NULL CHECK (navigation_fee_per_vehicle_cents >= 0),
  cellular_routed_cents INTEGER NOT NULL CHECK (cellular_routed_cents >= 0),
  navigation_routed_cents INTEGER NOT NULL CHECK (navigation_routed_cents >= 0),
  total_routed_cents INTEGER NOT NULL CHECK (total_routed_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id — the replay guard.
  UNIQUE (source_event_id),
  -- THE AUTOMOTIVE POOL ROUTING, pinned: serials × per-vehicle fees,
  -- integer-exact; the routed legs sum to the total.
  CHECK (cellular_routed_cents = serials_produced * cellular_fee_per_vehicle_cents),
  CHECK (navigation_routed_cents = serials_produced * navigation_fee_per_vehicle_cents),
  CHECK (total_routed_cents = cellular_routed_cents + navigation_routed_cents)
);

CREATE TABLE IF NOT EXISTS hardware_pool_waterfall_applications (
  id TEXT PRIMARY KEY,
  routing_source_event_id TEXT NOT NULL,
  pool_code TEXT NOT NULL CHECK (length(pool_code) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  -- The essentiality-weighted split legs of record (JSON text).
  split_legs TEXT NOT NULL CHECK (length(split_legs) > 0),
  pool_fee_pot_cents INTEGER NOT NULL CHECK (pool_fee_pot_cents > 0),
  allocated_total_cents INTEGER NOT NULL CHECK (allocated_total_cents > 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per (routing_source_event_id, pool_code) — the replay guard.
  UNIQUE (routing_source_event_id, pool_code),
  -- THE ESSENTIALITY WATERFALL, pinned: the pot conserves exactly (the
  -- dust rides the highest-scored holders).
  CHECK (allocated_total_cents = pool_fee_pot_cents)
);

CREATE TABLE IF NOT EXISTS hardware_telemetry_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  patent_family_id TEXT NOT NULL CHECK (length(patent_family_id) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  policy_ref TEXT NOT NULL,
  payee_id TEXT NOT NULL CHECK (length(payee_id) > 0),
  device_serial TEXT NOT NULL CHECK (length(device_serial) > 0),
  -- The delivered energy of record (statement micros of kWh).
  kwh_micros INTEGER NOT NULL CHECK (kwh_micros >= 0),
  charge_cycles INTEGER NOT NULL CHECK (charge_cycles >= 0),
  micros_per_kwh INTEGER NOT NULL CHECK (micros_per_kwh >= 0),
  micros_per_charge_cycle INTEGER NOT NULL CHECK (micros_per_charge_cycle >= 0),
  royalty_micros INTEGER NOT NULL CHECK (royalty_micros >= 0),
  royalty_cents INTEGER NOT NULL CHECK (royalty_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id — the replay guard.
  UNIQUE (source_event_id),
  -- THE CLEAN-TECH TELEMETRY MICRO-PAYOUT, pinned: the energy leg's
  -- product divides back down by 1e8 (kwh_micros prices the energy at
  -- 1e8 statement micros per kWh — without the division the product
  -- double-scales 1e8x); the cycle leg is a plain count x micro-dollars
  -- per cycle. Integer division floors the energy leg.
  CHECK (
    royalty_micros
      = (kwh_micros * micros_per_kwh) / 100000000
        + charge_cycles * micros_per_charge_cycle
  ),
  CHECK (royalty_cents = royalty_micros / 1000000)
);

CREATE TABLE IF NOT EXISTS hardware_ota_unlock_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  feature_code TEXT NOT NULL CHECK (length(feature_code) > 0),
  policy_ref TEXT NOT NULL,
  sensor_licensor_payee_id TEXT NOT NULL CHECK (length(sensor_licensor_payee_id) > 0),
  device_imei_mac TEXT NOT NULL CHECK (length(device_imei_mac) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  micros_per_unlock INTEGER NOT NULL CHECK (micros_per_unlock > 0),
  licensor_share_bps INTEGER NOT NULL CHECK (licensor_share_bps >= 0 AND licensor_share_bps <= 10000),
  settlement_micros INTEGER NOT NULL CHECK (settlement_micros > 0),
  settlement_cents INTEGER NOT NULL CHECK (settlement_cents >= 0),
  licensor_cents INTEGER NOT NULL CHECK (licensor_cents >= 0),
  platform_cents INTEGER NOT NULL CHECK (platform_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id — the replay guard.
  UNIQUE (source_event_id),
  -- THE OTA UNLOCK SPLIT, pinned: the pot floors micros/1,000,000; the
  -- licensor's bps share; licensor + platform === the pot, ALWAYS
  -- (one cent = 1,000,000 statement micros).
  CHECK (settlement_cents = settlement_micros / 1000000),
  CHECK (licensor_cents = (settlement_cents * licensor_share_bps) / 10000),
  CHECK (licensor_cents + platform_cents = settlement_cents)
);

CREATE TABLE IF NOT EXISTS hardware_cross_license_net_settlements (
  id TEXT PRIMARY KEY,
  agreement_ref TEXT NOT NULL,
  company_a_id TEXT NOT NULL,
  company_b_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  owed_a_to_b_cents INTEGER NOT NULL CHECK (owed_a_to_b_cents >= 0),
  owed_b_to_a_cents INTEGER NOT NULL CHECK (owed_b_to_a_cents >= 0),
  net_cents INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('a_to_b', 'b_to_a', 'balanced')),
  created_at TEXT NOT NULL,
  -- UNIQUE per (agreement_ref, period) — one net clearing of record per
  -- agreement per period; the walk's recompute replaces the sums in
  -- place.
  UNIQUE (agreement_ref, period),
  -- THE CROSS-LICENSING NET OFFSET, pinned: the mutual liabilities net,
  -- the direction naming the dispatch (the founder example: $12M owed
  -- by A minus $8M owed by A = $4M dispatching to B).
  CHECK (net_cents = owed_a_to_b_cents - owed_b_to_a_cents),
  CHECK (
    (net_cents > 0 AND direction = 'a_to_b')
    OR (net_cents < 0 AND direction = 'b_to_a')
    OR (net_cents = 0 AND direction = 'balanced')
  )
);

-- PR 47 — the patent litigation escrow, the hardware payout gate states,
-- and the cross-license net dispatches (migration 0051): the software
-- twins' shapes over the hardware lane's own (licensor payee, SEP pool)
-- identity space. The CHECK vocabularies below are byte-identical to the
-- TypeScript unions in src/modules/hardware/records.ts (the PR 129/130
-- lesson).
CREATE TABLE IF NOT EXISTS hardware_patent_litigation_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 1000 AND reserve_rate_bps <= 1500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_patent_litigation_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('global_court_rate_redetermination', 'anti_suit_injunction_penalty', 'cross_border_patent_validity_challenge')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL,
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard.
  UNIQUE (reserve_ledger_id, source_event_id),
  -- UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
  -- lock the balance derives from.
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents)
);

CREATE TABLE IF NOT EXISTS hardware_patent_litigation_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hardware_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  sep_pool_code TEXT NOT NULL,
  frand_determination_state TEXT NOT NULL CHECK (frand_determination_state IN ('unknown', 'cleared')),
  essentiality_audit_state TEXT NOT NULL CHECK (essentiality_audit_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, sep_pool_code)
);

CREATE TABLE IF NOT EXISTS hardware_cross_license_net_dispatches (
  id TEXT PRIMARY KEY,
  agreement_ref TEXT NOT NULL,
  company_a_id TEXT NOT NULL,
  company_b_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  net_before_cents INTEGER NOT NULL,
  net_after_cents INTEGER NOT NULL,
  dispatched_delta_cents INTEGER NOT NULL,
  a_gross_cleared_cents INTEGER NOT NULL CHECK (a_gross_cleared_cents >= 0),
  b_gross_cleared_cents INTEGER NOT NULL CHECK (b_gross_cleared_cents >= 0),
  direction TEXT NOT NULL CHECK (direction IN ('a_to_b', 'b_to_a', 'balanced')),
  journal_id TEXT,
  created_at TEXT NOT NULL,
  -- UNIQUE per (agreement_ref, period, net_before_cents,
  -- net_after_cents) — the replay guard AND the concurrency arbiter
  -- (insert-as-lock): a replayed trigger at the same settlement state
  -- or a lost race throws here, never a double dispatch. net_before is
  -- in the tuple so a re-net that revisits an earlier net cannot
  -- collide with the row that first reached it.
  UNIQUE (agreement_ref, period, net_before_cents, net_after_cents)
);

-- The energy resource lane (migration 0052, PR 48). The founder resource
-- directive's facts of record: the surveyed land parcels, their deeded
-- fractional owner acreage interests, the tiered parcel royalty policies
-- (the mineral ORRI ladder), the cumulative parcel royalty and GPU yield
-- positions, the grid participant registrations, the parsed title
-- division orders, the deed transfers (the statutory rate of record at
-- transfer), the per-tonne carbon offset policies, the three append-only
-- post ledgers (meter sales, pipeline deductions, GPU utilization), and
-- the five append-only application ledgers (net realization — keyed and
-- recomputed in place — acreage division, dynamic grid split, statutory
-- interest, and carbon offset payout). The CHECK vocabularies are byte-
-- identical to the TS-side arrays in modules/energy/records.ts (the
-- PR 129/130/133/134 lesson); the identities pin the founder's exact
-- money math at the database.
CREATE TABLE IF NOT EXISTS energy_land_parcels (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL UNIQUE,
  parcel_name TEXT NOT NULL CHECK (length(parcel_name) > 0),
  region TEXT NOT NULL CHECK (length(region) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_parcel_owner_interests (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  owner_payee_id TEXT NOT NULL CHECK (length(owner_payee_id) > 0),
  owner_name TEXT NOT NULL CHECK (length(owner_name) > 0),
  -- The deeded surveyed acreage in micros (1 acre = 1e6 micros) — the
  -- division's ratio basis (> 0: a zero-acre deed is a hostile
  -- registration).
  deeded_acres_micros INTEGER NOT NULL CHECK (deeded_acres_micros >= 1),
  interest_class TEXT NOT NULL CHECK (interest_class IN ('mineral', 'surface', 'wind', 'mixed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (parcel_id, owner_payee_id)
);
CREATE INDEX IF NOT EXISTS idx_energy_parcel_owner_interests_parcel
  ON energy_parcel_owner_interests (parcel_id);

CREATE TABLE IF NOT EXISTS energy_parcel_royalty_policies (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL UNIQUE,
  -- The tier bands of record (JSON text, ascending, open top last).
  tier_bands TEXT NOT NULL CHECK (length(tier_bands) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_parcel_royalty_positions (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  cumulative_revenue_cents INTEGER NOT NULL CHECK (cumulative_revenue_cents >= 0),
  cumulative_royalty_cents INTEGER NOT NULL CHECK (cumulative_royalty_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (parcel_id, period, currency)
);

CREATE TABLE IF NOT EXISTS energy_compute_yield_policies (
  id TEXT PRIMARY KEY,
  gpu_cluster_hash TEXT NOT NULL UNIQUE,
  sponsor_payee_id TEXT NOT NULL CHECK (length(sponsor_payee_id) > 0),
  sponsor_payee_name TEXT NOT NULL CHECK (length(sponsor_payee_name) > 0),
  tier_bands TEXT NOT NULL CHECK (length(tier_bands) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_compute_yield_positions (
  id TEXT PRIMARY KEY,
  gpu_cluster_hash TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  cumulative_compute_revenue_cents INTEGER NOT NULL CHECK (cumulative_compute_revenue_cents >= 0),
  cumulative_yield_cents INTEGER NOT NULL CHECK (cumulative_yield_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (gpu_cluster_hash, period, currency)
);

CREATE TABLE IF NOT EXISTS energy_grid_participant_registrations (
  id TEXT PRIMARY KEY,
  gpu_cluster_hash TEXT NOT NULL,
  participant_payee_id TEXT NOT NULL CHECK (length(participant_payee_id) > 0),
  participant_payee_name TEXT NOT NULL CHECK (length(participant_payee_name) > 0),
  participant_class TEXT NOT NULL CHECK (participant_class IN ('gpu_hardware_owner', 'power_plant_operator', 'colocation_manager')),
  -- The registered telemetry weight in micros (> 0 — a zero-weight
  -- participant never splits and never registers).
  weight_micros INTEGER NOT NULL CHECK (weight_micros >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (gpu_cluster_hash, participant_payee_id)
);
CREATE INDEX IF NOT EXISTS idx_energy_grid_participant_registrations_cluster
  ON energy_grid_participant_registrations (gpu_cluster_hash);

CREATE TABLE IF NOT EXISTS energy_division_orders (
  id TEXT PRIMARY KEY,
  order_ref TEXT NOT NULL UNIQUE,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  owner_payee_id TEXT NOT NULL CHECK (length(owner_payee_id) > 0),
  owner_payee_name TEXT NOT NULL CHECK (length(owner_payee_name) > 0),
  -- The order's stated fractional interest, in bps of the parcel.
  interest_bps INTEGER NOT NULL CHECK (interest_bps >= 0 AND interest_bps <= 10000),
  effective_on TEXT NOT NULL CHECK (effective_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_deed_transfers (
  id TEXT PRIMARY KEY,
  deed_ref TEXT NOT NULL UNIQUE,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  from_payee_id TEXT NOT NULL CHECK (length(from_payee_id) > 0),
  to_payee_id TEXT NOT NULL CHECK (length(to_payee_id) > 0),
  transferred_acres_micros INTEGER NOT NULL CHECK (transferred_acres_micros >= 1),
  -- The statutory interest rate of record AT the transfer — the rate the
  -- rerouted legs accrue at.
  statutory_interest_bps INTEGER NOT NULL CHECK (statutory_interest_bps >= 0 AND statutory_interest_bps <= 10000),
  recorded_on TEXT NOT NULL CHECK (recorded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_payee_id <> to_payee_id)
);

CREATE TABLE IF NOT EXISTS energy_carbon_offset_policies (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL UNIQUE,
  trust_payee_id TEXT NOT NULL CHECK (length(trust_payee_id) > 0),
  trust_payee_name TEXT NOT NULL CHECK (length(trust_payee_name) > 0),
  developer_payee_id TEXT NOT NULL CHECK (length(developer_payee_id) > 0),
  developer_payee_name TEXT NOT NULL CHECK (length(developer_payee_name) > 0),
  micros_per_tonne INTEGER NOT NULL CHECK (micros_per_tonne >= 1),
  trust_share_bps INTEGER NOT NULL CHECK (trust_share_bps >= 0 AND trust_share_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_meter_sales_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  well_meter_id TEXT NOT NULL CHECK (length(well_meter_id) > 0),
  -- The GPU cluster hash of record ('' where the parcel carries no
  -- compute — the NULL-distinctness avoidance; NOT NULL so the
  -- realization's five-tuple UNIQUE never collapses on NULLs).
  gpu_cluster_hash TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_energy_sales_cents INTEGER NOT NULL CHECK (gross_energy_sales_cents >= 0),
  gross_mineral_sales_cents INTEGER NOT NULL CHECK (gross_mineral_sales_cents >= 0),
  created_at TEXT NOT NULL,
  -- UNIQUE per source_event_id — the replay guard.
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_energy_meter_sales_posts_key
  ON energy_meter_sales_posts (parcel_id, well_meter_id, period);

CREATE TABLE IF NOT EXISTS energy_pipeline_deduction_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  well_meter_id TEXT NOT NULL CHECK (length(well_meter_id) > 0),
  gpu_cluster_hash TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  transportation_pipeline_deductions_cents INTEGER NOT NULL CHECK (transportation_pipeline_deductions_cents >= 0),
  grid_transmission_fees_cents INTEGER NOT NULL CHECK (grid_transmission_fees_cents >= 0),
  processing_refining_base_fees_cents INTEGER NOT NULL CHECK (processing_refining_base_fees_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_energy_pipeline_deduction_posts_key
  ON energy_pipeline_deduction_posts (parcel_id, well_meter_id, period);

CREATE TABLE IF NOT EXISTS energy_gpu_utilization_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  gpu_cluster_hash TEXT NOT NULL CHECK (length(gpu_cluster_hash) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  -- The row's compute hours in micros and its average power draw in
  -- kilowatt micros (> 0 — a zero row prices nothing and posts nothing).
  compute_hours_micros INTEGER NOT NULL CHECK (compute_hours_micros >= 1),
  power_draw_kw_micros INTEGER NOT NULL CHECK (power_draw_kw_micros >= 1),
  compute_revenue_cents INTEGER NOT NULL CHECK (compute_revenue_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_energy_gpu_utilization_posts_key
  ON energy_gpu_utilization_posts (gpu_cluster_hash, period);

CREATE TABLE IF NOT EXISTS energy_net_realization_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  -- The founder-specified realization keys of record.
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  well_meter_id TEXT NOT NULL CHECK (length(well_meter_id) > 0),
  gpu_cluster_hash TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_energy_sales_cents INTEGER NOT NULL CHECK (gross_energy_sales_cents >= 0),
  gross_mineral_sales_cents INTEGER NOT NULL CHECK (gross_mineral_sales_cents >= 0),
  transportation_pipeline_deductions_cents INTEGER NOT NULL CHECK (transportation_pipeline_deductions_cents >= 0),
  grid_transmission_fees_cents INTEGER NOT NULL CHECK (grid_transmission_fees_cents >= 0),
  processing_refining_base_fees_cents INTEGER NOT NULL CHECK (processing_refining_base_fees_cents >= 0),
  -- THE NET REALIZED RESOURCE POOL — may be negative (the held verdict).
  net_realized_resource_pool_cents INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('posted', 'held_negative_net')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The walk's replay-check handle.
  UNIQUE (source_event_id),
  -- The founder's exact identity: one realization of record per
  -- (parcel, meter, cluster, period, currency) — the recompute replaces
  -- the sums in place.
  UNIQUE (parcel_id, well_meter_id, gpu_cluster_hash, period, currency),
  -- THE NET RESOURCE REALIZATION, pinned: gross energy and mineral sales
  -- revenue minus transportation and pipeline deductions minus grid
  -- transmission fees minus processing and refining base fees = the Net
  -- Realized Resource Pool; the held verdict records the negative net.
  CHECK (
    net_realized_resource_pool_cents
    = gross_energy_sales_cents + gross_mineral_sales_cents
      - transportation_pipeline_deductions_cents
      - grid_transmission_fees_cents
      - processing_refining_base_fees_cents
  ),
  CHECK (
    (net_realized_resource_pool_cents < 0 AND verdict = 'held_negative_net')
    OR (net_realized_resource_pool_cents >= 0 AND verdict = 'posted')
  )
);

CREATE TABLE IF NOT EXISTS energy_parcel_division_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  -- The royalty pot the tier walk priced — the division's basis.
  revenue_basis_cents INTEGER NOT NULL CHECK (revenue_basis_cents > 0),
  -- The division legs of record (JSON text: per heir, the deeded acres
  -- and allocated cents).
  division_legs TEXT NOT NULL CHECK (length(division_legs) > 0),
  allocated_total_cents INTEGER NOT NULL CHECK (allocated_total_cents > 0),
  owner_count INTEGER NOT NULL CHECK (owner_count >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE ACREAGE DIVISION, pinned: the pot conserves exactly across the
  -- heirs (the dust rides the largest deeded tracts).
  CHECK (allocated_total_cents = revenue_basis_cents)
);

CREATE TABLE IF NOT EXISTS energy_compute_grid_split_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  gpu_cluster_hash TEXT NOT NULL CHECK (length(gpu_cluster_hash) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  compute_revenue_cents INTEGER NOT NULL CHECK (compute_revenue_cents > 0),
  -- The split legs of record (JSON text: per participant, the class,
  -- the effective telemetry weight, and the allocated cents).
  split_legs TEXT NOT NULL CHECK (length(split_legs) > 0),
  allocated_total_cents INTEGER NOT NULL CHECK (allocated_total_cents > 0),
  -- The instant posting's journal of record (null when the split
  -- recorded but the posting did not run — the reconciliation gap).
  journal_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE DYNAMIC GRID SPLIT, pinned: the compute pot conserves exactly
  -- across the participants (the dust rides the heaviest telemetry).
  CHECK (allocated_total_cents = compute_revenue_cents)
);

CREATE TABLE IF NOT EXISTS energy_statutory_interest_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  deed_ref TEXT NOT NULL CHECK (length(deed_ref) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  base_cents INTEGER NOT NULL CHECK (base_cents > 0),
  late_days INTEGER NOT NULL CHECK (late_days >= 1),
  statutory_interest_bps INTEGER NOT NULL CHECK (statutory_interest_bps >= 0 AND statutory_interest_bps <= 10000),
  interest_cents INTEGER NOT NULL CHECK (interest_cents > 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE STATUTORY INTEREST, pinned: base × late days × the transfer's
  -- rate of record, integer-exact (the 365-day year at bps scale).
  CHECK (interest_cents = (base_cents * late_days * statutory_interest_bps) / 3650000)
);

CREATE TABLE IF NOT EXISTS energy_carbon_offset_payout_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  parcel_id TEXT NOT NULL CHECK (length(parcel_id) > 0),
  registry_ref TEXT NOT NULL CHECK (length(registry_ref) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  -- The satellite-verified tonnage of record (statement micros).
  tonnes_verified_micros INTEGER NOT NULL CHECK (tonnes_verified_micros >= 1),
  micros_per_tonne INTEGER NOT NULL CHECK (micros_per_tonne >= 1),
  trust_share_bps INTEGER NOT NULL CHECK (trust_share_bps >= 0 AND trust_share_bps <= 10000),
  trust_payee_id TEXT NOT NULL CHECK (length(trust_payee_id) > 0),
  trust_payout_cents INTEGER NOT NULL CHECK (trust_payout_cents >= 0),
  developer_payee_id TEXT NOT NULL CHECK (length(developer_payee_id) > 0),
  developer_payout_cents INTEGER NOT NULL CHECK (developer_payout_cents >= 0),
  total_payout_cents INTEGER NOT NULL CHECK (total_payout_cents > 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE PER-TONNE PAYOUT, pinned: the trust and developer legs conserve
  -- the mint exactly.
  CHECK (total_payout_cents = trust_payout_cents + developer_payout_cents)
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

-- Foreign tax hold + book returns reserve (migration 0031, PR 27). The
-- withholding-tax-credit verification of record per (country_code,
-- tax_year) and the ISBN rights verification of record per isbn — the
-- fail-closed evidence states the foreign-tax-hold release and the
-- publishing payout gate read; the per-ISBN founder-banded returns-reserve
-- policy; the append-only reserve drawdown truth (the 0027 position-lock
-- discipline at ISBN scope); the publisher return chargebacks of record;
-- and the append-only offset applications that recover an outstanding
-- chargeback from an incoming POD net balance before author payouts
-- release.
CREATE TABLE IF NOT EXISTS withholding_tax_credit_verifications (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  tax_year INTEGER NOT NULL CHECK (tax_year > 1900),
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'failed')),
  treaty_ref TEXT,
  evidence_ref TEXT,
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (country_code, tax_year)
);

CREATE TABLE IF NOT EXISTS isbn_rights_verifications (
  id TEXT PRIMARY KEY,
  isbn TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'failed')),
  evidence_ref TEXT,
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_returns_reserve_policies (
  id TEXT PRIMARY KEY,
  isbn TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 1500 AND reserve_rate_bps <= 2000),
  reserve_window_days INTEGER NOT NULL CHECK (reserve_window_days >= 90 AND reserve_window_days <= 120),
  beneficiary_payee_id TEXT NOT NULL,
  beneficiary_payee_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_reserve_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('publisher_return', 'chargeback')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL CHECK (drawn_before_cents >= 0),
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id, source_event_id),
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  FOREIGN KEY (reserve_ledger_id) REFERENCES ledger_transactions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_reserve_drawdowns_reserve
  ON book_reserve_drawdowns (reserve_ledger_id);

CREATE TABLE IF NOT EXISTS book_return_chargebacks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  isbn TEXT NOT NULL,
  chargeback_class TEXT NOT NULL CHECK (chargeback_class IN ('publisher_return', 'chargeback')),
  chargeback_cents INTEGER NOT NULL CHECK (chargeback_cents > 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_return_chargebacks_isbn
  ON book_return_chargebacks (isbn);

CREATE TABLE IF NOT EXISTS book_chargeback_offset_applications (
  id TEXT PRIMARY KEY,
  chargeback_id TEXT NOT NULL,
  holding_ledger_id TEXT NOT NULL,
  offset_before_cents INTEGER NOT NULL CHECK (offset_before_cents >= 0),
  applied_cents INTEGER NOT NULL CHECK (applied_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (chargeback_id, holding_ledger_id),
  UNIQUE (chargeback_id, offset_before_cents),
  FOREIGN KEY (chargeback_id) REFERENCES book_return_chargebacks (id) ON DELETE CASCADE,
  FOREIGN KEY (holding_ledger_id) REFERENCES ledger_transactions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_chargeback_offset_applications_chargeback
  ON book_chargeback_offset_applications (chargeback_id);

-- Resource audit escrow + resource payout gate states (migration 0053, PR
-- 49). The energy lane's escrow family: the founder-banded 5–15% of a
-- resource payout locked per (owner payee, parcel) scope, the position-
-- locked drawdowns (monthly commodity price reconciliations, pipeline
-- variance audits, environmental regulatory compliance checks), the
-- insert-as-lock verified reconciliation the release reads fail-closed,
-- and the two durable gate states the resource payout gate reads
-- (absent and unknown BOTH refuse). No foreign keys: the tables key on
-- parcel ids and text payee ids — the energy lane's own identifier space.
CREATE TABLE IF NOT EXISTS energy_resource_audit_escrow_policies (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  reserve_rate_bps INTEGER NOT NULL CHECK (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_resource_audit_escrow_drawdowns (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  drawdown_class TEXT NOT NULL CHECK (drawdown_class IN ('commodity_price_reconciliation', 'pipeline_variance_audit', 'environmental_compliance_check')),
  source_event_id TEXT NOT NULL,
  drawn_before_cents INTEGER NOT NULL CHECK (drawn_before_cents >= 0),
  drawn_cents INTEGER NOT NULL CHECK (drawn_cents > 0),
  remaining_cents INTEGER NOT NULL CHECK (remaining_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (reserve_ledger_id, source_event_id),
  UNIQUE (reserve_ledger_id, drawn_before_cents),
  CHECK (remaining_cents = drawn_before_cents - drawn_cents AND remaining_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_energy_resource_audit_escrow_drawdowns_reserve
  ON energy_resource_audit_escrow_drawdowns (reserve_ledger_id);

CREATE TABLE IF NOT EXISTS energy_resource_audit_escrow_reconciliations (
  id TEXT PRIMARY KEY,
  reserve_ledger_id TEXT NOT NULL UNIQUE,
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) > 0),
  reconciled_by TEXT NOT NULL CHECK (length(reconciled_by) > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_resource_payout_gate_states (
  id TEXT PRIMARY KEY,
  payee_id TEXT NOT NULL,
  parcel_id TEXT NOT NULL,
  environmental_compliance_state TEXT NOT NULL CHECK (environmental_compliance_state IN ('unknown', 'cleared')),
  title_ownership_state TEXT NOT NULL CHECK (title_ownership_state IN ('unknown', 'verified')),
  evidence_ref TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payee_id, parcel_id)
);

-- PR 50 — the sports lane (ticketing, turnstile, resale, league pools,
-- group licensing, NIL reconciliation, biometric payouts). The SQLite
-- mirror keeps the Postgres wall types as TEXT; the CHECK vocabulary
-- pins the same facts migration 0054 pins (byte-identical token lists).

CREATE TABLE IF NOT EXISTS sports_student_athlete_profiles (
  id TEXT PRIMARY KEY,
  athlete_glan TEXT NOT NULL CHECK (length(athlete_glan) > 0),
  full_name TEXT NOT NULL CHECK (length(full_name) > 0),
  school_id TEXT NOT NULL CHECK (length(school_id) > 0),
  -- Every athlete belongs to a union ledger of record.
  union_code TEXT NOT NULL CHECK (union_code IN ('NFLPA', 'NBAPA')),
  nil_athlete_id TEXT NOT NULL CHECK (length(nil_athlete_id) > 0),
  wallet_payee_id TEXT NOT NULL CHECK (length(wallet_payee_id) > 0),
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (athlete_glan)
);
CREATE INDEX IF NOT EXISTS idx_sports_profiles_nil_athlete
  ON sports_student_athlete_profiles (nil_athlete_id);

CREATE TABLE IF NOT EXISTS sports_resale_royalty_policies (
  id TEXT PRIMARY KEY,
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  promoter_payee_id TEXT NOT NULL CHECK (length(promoter_payee_id) > 0),
  promoter_payee_name TEXT NOT NULL CHECK (length(promoter_payee_name) > 0),
  venue_payee_id TEXT NOT NULL CHECK (length(venue_payee_id) > 0),
  venue_payee_name TEXT NOT NULL CHECK (length(venue_payee_name) > 0),
  league_payee_id TEXT NOT NULL CHECK (length(league_payee_id) > 0),
  league_payee_name TEXT NOT NULL CHECK (length(league_payee_name) > 0),
  -- The founder resale royalty band — 5 to 10 percent.
  resale_royalty_bps INTEGER NOT NULL CHECK (resale_royalty_bps >= 500 AND resale_royalty_bps <= 1000),
  promoter_share_bps INTEGER NOT NULL CHECK (promoter_share_bps >= 0),
  venue_share_bps INTEGER NOT NULL CHECK (venue_share_bps >= 0),
  league_share_bps INTEGER NOT NULL CHECK (league_share_bps >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (venue_gln, league_rights_code),
  -- THE THREE-WAY SPLIT, pinned: the shares conserve into the full pot.
  CHECK (promoter_share_bps + venue_share_bps + league_share_bps = 10000)
);

CREATE TABLE IF NOT EXISTS sports_league_pool_policies (
  id TEXT PRIMARY KEY,
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  equal_share_bps INTEGER NOT NULL CHECK (equal_share_bps >= 0),
  market_balance_bps INTEGER NOT NULL CHECK (market_balance_bps >= 0),
  performance_incentive_bps INTEGER NOT NULL CHECK (performance_incentive_bps >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (league_rights_code),
  CHECK (equal_share_bps + market_balance_bps + performance_incentive_bps = 10000)
);

CREATE TABLE IF NOT EXISTS sports_league_team_registrations (
  id TEXT PRIMARY KEY,
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  team_code TEXT NOT NULL CHECK (length(team_code) > 0),
  owner_payee_id TEXT NOT NULL CHECK (length(owner_payee_id) > 0),
  owner_payee_name TEXT NOT NULL CHECK (length(owner_payee_name) > 0),
  market_size_micros INTEGER NOT NULL CHECK (market_size_micros >= 1),
  payroll_micros INTEGER NOT NULL CHECK (payroll_micros >= 0),
  cap_threshold_micros INTEGER NOT NULL CHECK (cap_threshold_micros >= 1),
  -- The team performance incentive band — 0 to 1000 bps.
  performance_incentive_bps INTEGER NOT NULL CHECK (performance_incentive_bps >= 0 AND performance_incentive_bps <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (league_rights_code, team_code)
);

CREATE TABLE IF NOT EXISTS sports_biometric_royalty_policies (
  id TEXT PRIMARY KEY,
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  licensee_class TEXT NOT NULL CHECK (licensee_class IN ('sportsbook', 'media_network', 'health_tech')),
  league_data_payee_id TEXT NOT NULL CHECK (length(league_data_payee_id) > 0),
  league_data_payee_name TEXT NOT NULL CHECK (length(league_data_payee_name) > 0),
  -- The micro-payout rate — money micros per quantity micro.
  micros_per_unit INTEGER NOT NULL CHECK (micros_per_unit >= 1),
  athlete_share_bps INTEGER NOT NULL CHECK (athlete_share_bps >= 0 AND athlete_share_bps <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (league_rights_code, licensee_class)
);

CREATE TABLE IF NOT EXISTS sports_ticket_sale_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  -- The founder's five identity columns — the Net Gate Pool tuple.
  nil_contract_id TEXT NOT NULL CHECK (length(nil_contract_id) > 0),
  athlete_glan TEXT NOT NULL CHECK (length(athlete_glan) > 0),
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  turnstile_scan_hash TEXT NOT NULL CHECK (length(turnstile_scan_hash) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_ticket_revenue_cents INTEGER NOT NULL CHECK (gross_ticket_revenue_cents >= 0),
  facility_surcharges_cents INTEGER NOT NULL CHECK (facility_surcharges_cents >= 0),
  municipal_taxes_cents INTEGER NOT NULL CHECK (municipal_taxes_cents >= 0),
  insurance_reserves_cents INTEGER NOT NULL CHECK (insurance_reserves_cents >= 0),
  processor_fee_cuts_cents INTEGER NOT NULL CHECK (processor_fee_cuts_cents >= 0),
  ticket_count INTEGER NOT NULL CHECK (ticket_count >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_sports_ticket_sale_posts_recon
  ON sports_ticket_sale_posts (venue_gln, period, currency);
CREATE INDEX IF NOT EXISTS idx_sports_ticket_sale_posts_realization
  ON sports_ticket_sale_posts (nil_contract_id, athlete_glan, venue_gln,
    league_rights_code, turnstile_scan_hash, period, currency);

CREATE TABLE IF NOT EXISTS sports_resale_sale_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  resale_gross_cents INTEGER NOT NULL CHECK (resale_gross_cents >= 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_sports_resale_sale_posts_scope
  ON sports_resale_sale_posts (venue_gln, period, currency);

CREATE TABLE IF NOT EXISTS sports_turnstile_scan_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  turnstile_scan_hash TEXT NOT NULL CHECK (length(turnstile_scan_hash) > 0),
  scan_count INTEGER NOT NULL CHECK (scan_count >= 1),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_sports_turnstile_scan_posts_scope
  ON sports_turnstile_scan_posts (venue_gln, period, currency);

CREATE TABLE IF NOT EXISTS sports_biometric_tracking_posts (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  athlete_glan TEXT NOT NULL CHECK (length(athlete_glan) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  tracking_modality TEXT NOT NULL CHECK (tracking_modality IN ('wearable', 'optical')),
  licensee_class TEXT NOT NULL CHECK (licensee_class IN ('sportsbook', 'media_network', 'health_tech')),
  licensed_quantity_micros INTEGER NOT NULL CHECK (licensed_quantity_micros >= 1),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id)
);

CREATE TABLE IF NOT EXISTS sports_broadcasting_contracts (
  id TEXT PRIMARY KEY,
  -- The contract_ref is the replay key (UNIQUE — a re-shipped contract
  -- is a conflict, never a second row).
  contract_ref TEXT NOT NULL CHECK (length(contract_ref) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  contract_class TEXT NOT NULL CHECK (contract_class IN (
    'broadcasting_national', 'broadcasting_international', 'merchandise_pool',
    'group_licensing_video_games', 'group_licensing_trading_cards',
    'group_licensing_apparel')),
  contract_gross_cents INTEGER NOT NULL CHECK (contract_gross_cents >= 0),
  -- The group licensing royalty pot — 0 for the league pool classes.
  royalty_pool_cents INTEGER NOT NULL CHECK (royalty_pool_cents >= 0),
  union_code TEXT NOT NULL CHECK (union_code IN ('NFLPA', 'NBAPA', 'none')),
  union_share_bps INTEGER NOT NULL CHECK (union_share_bps >= 0 AND union_share_bps <= 10000),
  -- The group licensing roster — the athlete GLANs; '[]' for pool classes.
  athlete_roster_json TEXT NOT NULL CHECK (length(athlete_roster_json) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (contract_ref)
);
CREATE INDEX IF NOT EXISTS idx_sports_broadcasting_contracts_pool
  ON sports_broadcasting_contracts (league_rights_code, period, currency);

CREATE TABLE IF NOT EXISTS sports_gate_reconciliations (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  ticket_count_sum INTEGER NOT NULL CHECK (ticket_count_sum >= 0),
  scan_count_sum INTEGER NOT NULL CHECK (scan_count_sum >= 0),
  -- scans − tickets, signed; flagged verdicts carry the delta.
  variance_scan_delta INTEGER NOT NULL,
  gross_ticket_revenue_cents INTEGER NOT NULL CHECK (gross_ticket_revenue_cents >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('reconciled', 'variance_flagged', 'unreconciled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The venue scope's position of record — one per scope, replaced in
  -- place by the recompute.
  UNIQUE (venue_gln, period, currency),
  -- THE RECONCILIATION DELTA, pinned: the delta is the scan side minus
  -- the receipt side.
  CHECK (variance_scan_delta = scan_count_sum - ticket_count_sum)
);

CREATE TABLE IF NOT EXISTS sports_net_venue_realizations (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  -- The founder's five identity columns.
  nil_contract_id TEXT NOT NULL CHECK (length(nil_contract_id) > 0),
  athlete_glan TEXT NOT NULL CHECK (length(athlete_glan) > 0),
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  turnstile_scan_hash TEXT NOT NULL CHECK (length(turnstile_scan_hash) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  gross_ticket_revenue_cents INTEGER NOT NULL CHECK (gross_ticket_revenue_cents >= 0),
  facility_surcharges_cents INTEGER NOT NULL CHECK (facility_surcharges_cents >= 0),
  municipal_taxes_cents INTEGER NOT NULL CHECK (municipal_taxes_cents >= 0),
  insurance_reserves_cents INTEGER NOT NULL CHECK (insurance_reserves_cents >= 0),
  processor_fee_cuts_cents INTEGER NOT NULL CHECK (processor_fee_cuts_cents >= 0),
  -- THE NET GATE POOL — may be negative (the held verdict).
  net_gate_pool_cents INTEGER NOT NULL,
  -- The scope's gate reconciliation identity at recompute time.
  gate_reconciliation_event_id TEXT NOT NULL CHECK (length(gate_reconciliation_event_id) > 0),
  gate_reconciliation_verdict TEXT NOT NULL CHECK (gate_reconciliation_verdict IN ('reconciled', 'variance_flagged', 'unreconciled')),
  verdict TEXT NOT NULL CHECK (verdict IN ('posted', 'held_negative_net')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- One realization of record per the founder's tuple — the recompute
  -- replaces the sums in place.
  UNIQUE (nil_contract_id, athlete_glan, venue_gln, league_rights_code, turnstile_scan_hash, period, currency),
  -- THE NET VENUE REALIZATION, pinned: gross ticket revenue minus
  -- facility surcharges minus municipal taxes minus insurance reserves
  -- minus payment processor fee cuts = the Net Gate Pool.
  CHECK (
    net_gate_pool_cents
    = gross_ticket_revenue_cents
      - facility_surcharges_cents - municipal_taxes_cents
      - insurance_reserves_cents - processor_fee_cuts_cents
  ),
  CHECK (
    (net_gate_pool_cents < 0 AND verdict = 'held_negative_net')
    OR (net_gate_pool_cents >= 0 AND verdict = 'posted')
  )
);

CREATE TABLE IF NOT EXISTS sports_resale_royalty_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  resale_sale_event_id TEXT NOT NULL CHECK (length(resale_sale_event_id) > 0),
  venue_gln TEXT NOT NULL CHECK (length(venue_gln) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  resale_gross_cents INTEGER NOT NULL CHECK (resale_gross_cents >= 0),
  resale_royalty_bps INTEGER NOT NULL CHECK (resale_royalty_bps >= 500 AND resale_royalty_bps <= 1000),
  promoter_share_bps INTEGER NOT NULL CHECK (promoter_share_bps >= 0),
  venue_share_bps INTEGER NOT NULL CHECK (venue_share_bps >= 0),
  league_share_bps INTEGER NOT NULL CHECK (league_share_bps >= 0),
  royalty_pot_cents INTEGER NOT NULL CHECK (royalty_pot_cents >= 0),
  promoter_leg_cents INTEGER NOT NULL CHECK (promoter_leg_cents >= 0),
  venue_leg_cents INTEGER NOT NULL CHECK (venue_leg_cents >= 0),
  league_leg_cents INTEGER NOT NULL CHECK (league_leg_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE PERPETUAL ROYALTY, pinned: the three legs conserve the pot.
  CHECK (promoter_leg_cents + venue_leg_cents + league_leg_cents = royalty_pot_cents)
);

CREATE TABLE IF NOT EXISTS sports_league_pool_distributions (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  pool_cents INTEGER NOT NULL CHECK (pool_cents >= 0),
  equal_share_bps INTEGER NOT NULL CHECK (equal_share_bps >= 0),
  market_balance_bps INTEGER NOT NULL CHECK (market_balance_bps >= 0),
  performance_incentive_bps INTEGER NOT NULL CHECK (performance_incentive_bps >= 0),
  -- The team legs of record (JSON text: per team, the shares and cents).
  legs_json TEXT NOT NULL CHECK (length(legs_json) > 0),
  distributed_cents INTEGER NOT NULL CHECK (distributed_cents >= 0),
  dust_cents INTEGER NOT NULL CHECK (dust_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The scope's position of record — one per league scope.
  UNIQUE (league_rights_code, period, currency),
  -- THE POOL WATERFALL, pinned: the distributed legs plus the dust
  -- conserve the pool exactly.
  CHECK (distributed_cents + dust_cents = pool_cents),
  CHECK (equal_share_bps + market_balance_bps + performance_incentive_bps = 10000)
);

CREATE TABLE IF NOT EXISTS sports_group_licensing_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  contract_ref TEXT NOT NULL CHECK (length(contract_ref) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  union_code TEXT NOT NULL CHECK (union_code IN ('NFLPA', 'NBAPA')),
  union_payee_id TEXT NOT NULL CHECK (length(union_payee_id) > 0),
  union_share_bps INTEGER NOT NULL CHECK (union_share_bps >= 0 AND union_share_bps <= 10000),
  royalty_pool_cents INTEGER NOT NULL CHECK (royalty_pool_cents >= 0),
  union_leg_cents INTEGER NOT NULL CHECK (union_leg_cents >= 0),
  athlete_pool_cents INTEGER NOT NULL CHECK (athlete_pool_cents >= 0),
  athlete_wallets_json TEXT NOT NULL CHECK (length(athlete_wallets_json) > 0),
  wallet_count INTEGER NOT NULL CHECK (wallet_count >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE GROUP LICENSING SPLIT, pinned: the union leg plus the athlete
  -- pool conserve the royalty pot.
  CHECK (union_leg_cents + athlete_pool_cents = royalty_pool_cents)
);

CREATE TABLE IF NOT EXISTS sports_nil_deal_reconciliations (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  nil_contract_id TEXT NOT NULL CHECK (length(nil_contract_id) > 0),
  athlete_glan TEXT NOT NULL CHECK (length(athlete_glan) > 0),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  endorsement_deal_cents INTEGER NOT NULL CHECK (endorsement_deal_cents >= 0),
  booster_collective_cents INTEGER NOT NULL CHECK (booster_collective_cents >= 0),
  -- Carried at zero today: the NIL lane has no fan-club sender yet.
  fan_club_subscription_cents INTEGER NOT NULL CHECK (fan_club_subscription_cents >= 0),
  nil_deal_gross_cents INTEGER NOT NULL CHECK (nil_deal_gross_cents >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('reconciled', 'unmatched_profile', 'profile_ineligible')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- The scope's position of record — one per (contract, athlete, period).
  UNIQUE (nil_contract_id, athlete_glan, period),
  -- THE NIL WATERFALL, pinned: the gross is the sum of the three legs.
  CHECK (
    nil_deal_gross_cents
    = endorsement_deal_cents + booster_collective_cents
      + fan_club_subscription_cents
  )
);

CREATE TABLE IF NOT EXISTS sports_biometric_micro_payout_applications (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  biometric_post_event_id TEXT NOT NULL CHECK (length(biometric_post_event_id) > 0),
  athlete_glan TEXT NOT NULL CHECK (length(athlete_glan) > 0),
  league_rights_code TEXT NOT NULL CHECK (length(league_rights_code) > 0),
  tracking_modality TEXT NOT NULL CHECK (tracking_modality IN ('wearable', 'optical')),
  licensee_class TEXT NOT NULL CHECK (licensee_class IN ('sportsbook', 'media_network', 'health_tech')),
  licensed_quantity_micros INTEGER NOT NULL CHECK (licensed_quantity_micros >= 1),
  micros_per_unit INTEGER NOT NULL CHECK (micros_per_unit >= 1),
  athlete_share_bps INTEGER NOT NULL CHECK (athlete_share_bps >= 0 AND athlete_share_bps <= 10000),
  payout_pot_cents INTEGER NOT NULL CHECK (payout_pot_cents >= 0),
  athlete_wallet_payee_id TEXT NOT NULL CHECK (length(athlete_wallet_payee_id) > 0),
  athlete_leg_cents INTEGER NOT NULL CHECK (athlete_leg_cents >= 0),
  league_data_payee_id TEXT NOT NULL CHECK (length(league_data_payee_id) > 0),
  league_leg_cents INTEGER NOT NULL CHECK (league_leg_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_event_id),
  -- THE MICRO-PAYOUT, pinned: the athlete leg plus the league data leg
  -- conserve the payout pot.
  CHECK (athlete_leg_cents + league_leg_cents = payout_pot_cents)
);
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

// --- Brand licensing (migration 0036, PR 32) — row projection helpers ---
//
// The deal's tier schedule and the application's tier slices pack as TEXT
// JSON (the film-waterfall distribution's discipline); unpacking is
// fail-closed: a corrupt mirror throws rather than silently yielding an
// empty schedule.

type LicensingRoyaltyDealDbRow = Omit<LicensingRoyaltyDealRecord, 'tiers'> & { tiers: string };

function licensingDealToDbRow(record: LicensingRoyaltyDealRecord): LicensingRoyaltyDealDbRow {
  return { ...record, tiers: JSON.stringify(record.tiers) };
}

function licensingDealFromDbRow(row: LicensingRoyaltyDealDbRow): LicensingRoyaltyDealRecord {
  let tiers: LicensingTierSpec[];
  try {
    tiers = JSON.parse(row.tiers) as LicensingTierSpec[];
  } catch (error) {
    throw new Error(
      `licensing_royalty_deals.tiers for ${row.id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, tiers };
}

type LicensingRoyaltyApplicationDbRow = Omit<LicensingRoyaltyApplicationRecord, 'slices'> & {
  slices: string;
};

function licensingApplicationToDbRow(
  record: LicensingRoyaltyApplicationRecord,
): LicensingRoyaltyApplicationDbRow {
  return { ...record, slices: JSON.stringify(record.slices) };
}

function licensingApplicationFromDbRow(
  row: LicensingRoyaltyApplicationDbRow,
): LicensingRoyaltyApplicationRecord {
  let slices: LicensingTierSlice[];
  try {
    slices = JSON.parse(row.slices) as LicensingTierSlice[];
  } catch (error) {
    throw new Error(
      `licensing_royalty_applications.slices for ${row.id} is not valid JSON — SQLite mirror corrupt`,
      { cause: error },
    );
  }
  return { ...row, slices };
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

  // --- Art market waterfalls (migration 0032, PR 28) -----------------------

  async upsertArtSplitSchedule(
    row: ArtSplitScheduleRecord,
  ): Promise<ArtSplitScheduleRecord> {
    // One schedule of record per scope_key — INSERT ON CONFLICT replaces
    // the row atomically (the caller preserves identity + version).
    const dbRow = {
      ...row,
      contributors: JSON.stringify(row.contributors),
    };
    this.db
      .prepare(
        `INSERT INTO art_split_schedules
           (id, scope_key, scope, contributors, version, created_at, updated_at)
         VALUES (@id, @scope_key, @scope, @contributors, @version, @created_at, @updated_at)
         ON CONFLICT (scope_key) DO UPDATE SET
           scope = excluded.scope,
           contributors = excluded.contributors,
           version = excluded.version,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(dbRow as unknown as Record<string, unknown>);
    return Promise.resolve(row);
  }

  async getArtSplitSchedule(scopeKey: string): Promise<ArtSplitScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM art_split_schedules WHERE scope_key = ?`)
      .get(scopeKey) as (ArtSplitScheduleRecord & { contributors: string }) | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      ...row,
      contributors: JSON.parse(row.contributors) as ArtSplitScheduleRecord['contributors'],
    });
  }

  async insertArtRecoupmentPool(
    row: Omit<ArtRecoupmentPoolRecord, 'id'>,
  ): Promise<ArtRecoupmentPoolRecord> {
    // UNIQUE per (scope_key, pool_class, sequence_no) — a re-registered
    // slot is the unique violation, never a silent duplicate.
    const record: ArtRecoupmentPoolRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO art_recoupment_pools
           (id, scope_key, pool_class, sequence_no, debt_cents, recouped_cents, currency, status, creditor_role, creditor_payee_id, creditor_payee_name, agreement_ref, created_at, updated_at)
         VALUES (@id, @scope_key, @pool_class, @sequence_no, @debt_cents, @recouped_cents, @currency, @status, @creditor_role, @creditor_payee_id, @creditor_payee_name, @agreement_ref, @created_at, @updated_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listArtRecoupmentPools(
    scopeKey: string,
    poolClass: ArtRecoupmentPoolClass,
  ): Promise<ArtRecoupmentPoolRecord[]> {
    // sequence_no ASC — the fabrication recoupment order of record (rowid
    // ASC the strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM art_recoupment_pools
         WHERE scope_key = ? AND pool_class = ?
         ORDER BY sequence_no ASC, rowid ASC`,
        )
        .all(scopeKey, poolClass) as ArtRecoupmentPoolRecord[],
    );
  }

  async updateArtRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: ArtRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<ArtRecoupmentPoolRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the 'active' state only. changes = 0 means the pool is absent or
    // already recouped; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE art_recoupment_pools
         SET recouped_cents = ?, status = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(recoupedCents, status, updatedAt, id);
    if (result.changes === 0) return undefined;
    return Promise.resolve(
      this.db.prepare(`SELECT * FROM art_recoupment_pools WHERE id = ?`).get(id) as
        | ArtRecoupmentPoolRecord
        | undefined,
    );
  }

  async insertArtRecoupmentApplication(
    row: Omit<ArtRecoupmentApplicationRecord, 'id'>,
  ): Promise<ArtRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id) — a replayed application is the
    // unique violation, never a double recovery. UNIQUE per
    // (pool_id, recouped_before_cents) — the POSITION lock (the
    // insert-as-lock arbiter).
    const record: ArtRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO art_recoupment_applications
           (id, pool_id, pool_class, scope_key, source_event_id, recouped_before_cents, applied_cents, remaining_cents, created_at)
         VALUES (@id, @pool_id, @pool_class, @scope_key, @source_event_id, @recouped_before_cents, @applied_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listArtRecoupmentApplications(
    poolId: string,
  ): Promise<ArtRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order (rowid ASC
    // the strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM art_recoupment_applications
         WHERE pool_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(poolId) as ArtRecoupmentApplicationRecord[],
    );
  }

  async insertArtSplitAccrual(
    row: Omit<ArtSplitAccrualRecord, 'id'>,
  ): Promise<ArtSplitAccrualRecord> {
    // UNIQUE per source_event_id — a replayed accrual is the unique
    // violation, never a double designation.
    const record: ArtSplitAccrualRecord = { ...row, id: randomUUID() };
    const dbRow = {
      ...record,
      allocations: JSON.stringify(record.allocations),
    };
    this.db
      .prepare(
        `INSERT INTO art_split_accruals
           (id, schedule_id, scope_key, scope, source_event_id, basis_cents, allocations, dust_cents, created_at)
         VALUES (@id, @schedule_id, @scope_key, @scope, @source_event_id, @basis_cents, @allocations, @dust_cents, @created_at)`,
      )
      .run(dbRow as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async upsertArtLicensingAgencyPolicy(
    row: Omit<ArtLicensingAgencyPolicyRecord, 'id'>,
  ): Promise<ArtLicensingAgencyPolicyRecord> {
    // One policy of record per agency_code — INSERT ON CONFLICT replaces
    // the row atomically (the founder band validates at registration).
    const record: ArtLicensingAgencyPolicyRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO art_licensing_agency_policies
           (id, agency_code, agency_name, collection_fee_bps, created_at, updated_at)
         VALUES (@id, @agency_code, @agency_name, @collection_fee_bps, @created_at, @updated_at)
         ON CONFLICT (agency_code) DO UPDATE SET
           agency_name = excluded.agency_name,
           collection_fee_bps = excluded.collection_fee_bps,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getArtLicensingAgencyPolicy(
    agencyCode: ArtLicensingAgencyPolicyRecord['agency_code'],
  ): Promise<ArtLicensingAgencyPolicyRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM art_licensing_agency_policies WHERE agency_code = ?`)
        .get(agencyCode) as ArtLicensingAgencyPolicyRecord | undefined,
    );
  }

  async upsertEstateSuccessionCertificate(
    row: Omit<EstateSuccessionCertificateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstateSuccessionCertificateRecord> {
    // UNIQUE per (artist_payee_id, certificate_ref) — a re-validation
    // converges on the row (the newest validation state governs).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM estate_succession_certificates
         WHERE artist_payee_id = ? AND certificate_ref = ?`,
      )
      .get(row.artist_payee_id, row.certificate_ref) as
      | EstateSuccessionCertificateRecord
      | undefined;
    const record: EstateSuccessionCertificateRecord = existing === undefined
      ? { ...row, id: randomUUID(), created_at: now, updated_at: now }
      : { ...existing, ...row, id: existing.id, created_at: existing.created_at, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO estate_succession_certificates
           (id, artist_payee_id, certificate_ref, certificate_hash, estate_entity_payee_id,
            estate_entity_payee_name, validation_state, verified_by, verified_at, created_at, updated_at)
         VALUES (@id, @artist_payee_id, @certificate_ref, @certificate_hash, @estate_entity_payee_id,
            @estate_entity_payee_name, @validation_state, @verified_by, @verified_at, @created_at, @updated_at)
         ON CONFLICT (artist_payee_id, certificate_ref) DO UPDATE SET
           certificate_hash = excluded.certificate_hash,
           estate_entity_payee_id = excluded.estate_entity_payee_id,
           estate_entity_payee_name = excluded.estate_entity_payee_name,
           validation_state = excluded.validation_state,
           verified_by = excluded.verified_by,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getEstateSuccessionCertificate(
    artistPayeeId: string,
    certificateRef: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM estate_succession_certificates
           WHERE artist_payee_id = ? AND certificate_ref = ?`,
        )
        .get(artistPayeeId, certificateRef) as
        | EstateSuccessionCertificateRecord
        | undefined,
    );
  }

  async getEstateSuccessionCertificateById(
    certificateId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM estate_succession_certificates WHERE id = ?`)
        .get(certificateId) as EstateSuccessionCertificateRecord | undefined,
    );
  }

  async getVerifiedEstateSuccessionCertificate(
    artistPayeeId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM estate_succession_certificates
           WHERE artist_payee_id = ? AND validation_state = 'verified'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(artistPayeeId) as EstateSuccessionCertificateRecord | undefined,
    );
  }

  async upsertEstateHeirSchedule(
    row: EstateHeirScheduleRecord,
  ): Promise<EstateHeirScheduleRecord> {
    // UNIQUE per certificate_id — a re-registration replaces the row
    // atomically, identity and created_at preserved (the art schedule
    // upsert discipline; the engine builds the versioned row).
    const existing = this.db
      .prepare(`SELECT * FROM estate_heir_schedules WHERE certificate_id = ?`)
      .get(row.certificate_id) as EstateHeirScheduleRecord | undefined;
    const dbRow = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? row.created_at,
      heirs: JSON.stringify(row.heirs),
    };
    this.db
      .prepare(
        `INSERT INTO estate_heir_schedules
           (id, certificate_id, heirs, version, created_at, updated_at)
         VALUES (@id, @certificate_id, @heirs, @version, @created_at, @updated_at)
         ON CONFLICT (certificate_id) DO UPDATE SET
           heirs = excluded.heirs,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(dbRow as unknown as Record<string, unknown>);
    // Return the record as persisted — the converged identity and
    // created_at, not the engine's freshly-built row.
    return Promise.resolve({ ...row, id: dbRow.id, created_at: dbRow.created_at });
  }

  async getEstateHeirSchedule(
    certificateId: string,
  ): Promise<EstateHeirScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM estate_heir_schedules WHERE certificate_id = ?`)
      .get(certificateId) as (EstateHeirScheduleRecord & { heirs: string }) | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      ...row,
      heirs: JSON.parse(row.heirs) as EstateHeirScheduleRecord['heirs'],
    });
  }

  async insertEstateSuccessionTransition(
    row: Omit<EstateSuccessionTransitionRecord, 'id'>,
  ): Promise<EstateSuccessionTransitionRecord> {
    // UNIQUE per (certificate_id, source_event_id) — a replayed transition
    // is the unique violation, never a double handoff. Append-only: the
    // row, once written, is never updated or deleted.
    const record: EstateSuccessionTransitionRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO estate_succession_transitions
           (id, certificate_id, artist_payee_id, estate_entity_payee_id, source_event_id,
            artwork_id, provenance_hash, created_at)
         VALUES (@id, @certificate_id, @artist_payee_id, @estate_entity_payee_id, @source_event_id,
            @artwork_id, @provenance_hash, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listEstateSuccessionTransitions(
    certificateId: string,
  ): Promise<EstateSuccessionTransitionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM estate_succession_transitions
           WHERE certificate_id = ? ORDER BY created_at ASC`,
        )
        .all(certificateId) as EstateSuccessionTransitionRecord[],
    );
  }

  async insertEstateSplitAccrual(
    row: Omit<EstateSplitAccrualRecord, 'id'>,
  ): Promise<EstateSplitAccrualRecord> {
    // UNIQUE per (certificate_id, artwork_id, source_event_id) — a
    // replayed accrual is the unique violation, never a double designation
    // (the provenance triple IS the once-only key).
    const record: EstateSplitAccrualRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO estate_split_accruals
           (id, schedule_id, certificate_id, artist_payee_id, estate_entity_payee_id,
            source_event_id, artwork_id, provenance_hash, basis_cents, allocations, dust_cents, created_at)
         VALUES (@id, @schedule_id, @certificate_id, @artist_payee_id, @estate_entity_payee_id,
            @source_event_id, @artwork_id, @provenance_hash, @basis_cents, @allocations, @dust_cents, @created_at)`,
      )
      .run({
        ...record,
        allocations: JSON.stringify(record.allocations),
      } as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listEstateSplitAccruals(
    certificateId: string,
  ): Promise<EstateSplitAccrualRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM estate_split_accruals
         WHERE certificate_id = ? ORDER BY created_at ASC`,
      )
      .all(certificateId) as (EstateSplitAccrualRecord & { allocations: string })[];
    return Promise.resolve(
      rows.map((row) => ({
        ...row,
        allocations: JSON.parse(row.allocations) as EstateSplitAccrualRecord['allocations'],
      })),
    );
  }

  async upsertEstatePayoutGateState(
    row: Omit<EstatePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstatePayoutGateStateRecord> {
    // UNIQUE per payee_id — a re-recording converges (the newest state
    // governs the next dispatch).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM estate_payout_gate_states WHERE payee_id = ?`)
      .get(row.payee_id) as EstatePayoutGateStateRecord | undefined;
    const record: EstatePayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO estate_payout_gate_states
           (id, payee_id, estate_succession_state, certificate_ref, verified_by, created_at, updated_at)
         VALUES (@id, @payee_id, @estate_succession_state, @certificate_ref, @verified_by, @created_at, @updated_at)
         ON CONFLICT (payee_id) DO UPDATE SET
           estate_succession_state = excluded.estate_succession_state,
           certificate_ref = excluded.certificate_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getEstatePayoutGateState(
    payeeId: string,
  ): Promise<EstatePayoutGateStateRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM estate_payout_gate_states WHERE payee_id = ?`)
        .get(payeeId) as EstatePayoutGateStateRecord | undefined,
    );
  }

  async upsertTheatricalProductionDeal(
    row: TheatricalProductionDealRecord,
  ): Promise<TheatricalProductionDealRecord> {
    // One deal of record per scope_key — INSERT ON CONFLICT replaces the
    // row atomically (the caller preserves identity + version).
    this.db
      .prepare(
        `INSERT INTO theatrical_production_deals
           (id, scope_key, deal_class, grand_rights_rate_bps, publisher_code, publisher_payee_id, publisher_payee_name,
            artist_payee_id, artist_payee_name, producer_payee_id, producer_payee_name, investor_payee_id, investor_payee_name,
            flat_guarantee_cents, guarantee_percentage_bps, capitalization_budget_cents, recouped_cents, currency, version, created_at, updated_at)
         VALUES (@id, @scope_key, @deal_class, @grand_rights_rate_bps, @publisher_code, @publisher_payee_id, @publisher_payee_name,
            @artist_payee_id, @artist_payee_name, @producer_payee_id, @producer_payee_name, @investor_payee_id, @investor_payee_name,
            @flat_guarantee_cents, @guarantee_percentage_bps, @capitalization_budget_cents, @recouped_cents, @currency, @version, @created_at, @updated_at)
         ON CONFLICT (scope_key) DO UPDATE SET
           deal_class = excluded.deal_class,
           grand_rights_rate_bps = excluded.grand_rights_rate_bps,
           publisher_code = excluded.publisher_code,
           publisher_payee_id = excluded.publisher_payee_id,
           publisher_payee_name = excluded.publisher_payee_name,
           artist_payee_id = excluded.artist_payee_id,
           artist_payee_name = excluded.artist_payee_name,
           producer_payee_id = excluded.producer_payee_id,
           producer_payee_name = excluded.producer_payee_name,
           investor_payee_id = excluded.investor_payee_id,
           investor_payee_name = excluded.investor_payee_name,
           flat_guarantee_cents = excluded.flat_guarantee_cents,
           guarantee_percentage_bps = excluded.guarantee_percentage_bps,
           capitalization_budget_cents = excluded.capitalization_budget_cents,
           recouped_cents = excluded.recouped_cents,
           currency = excluded.currency,
           version = excluded.version,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(row as unknown as Record<string, unknown>);
    return Promise.resolve(row);
  }

  async getTheatricalProductionDeal(
    productionId: string,
  ): Promise<TheatricalProductionDealRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM theatrical_production_deals WHERE scope_key = ?`)
        .get(`production:${productionId}`) as
        | TheatricalProductionDealRecord
        | undefined,
    );
  }

  async insertTheatricalStopSettlement(
    row: Omit<TheatricalStopSettlementRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalStopSettlementRecord> {
    // UNIQUE per source_event_id — a replayed settlement row is the unique
    // violation, never a double stop.
    const record: TheatricalStopSettlementRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO theatrical_stop_settlements
           (id, production_id, venue_id, show_date, source_event_id, settlement_id, sender_code, city,
            gbor_cents, sales_tax_cents, card_fees_cents, facility_fee_cents, ffe_fee_cents, group_discount_cents,
            agbor_cents, grand_rights_cents, venue_expense_cents, promoter_expense_cap_cents,
            venue_expense_recouped_cents, venue_expense_capped_cents, deal_payout_cents, currency, created_at)
         VALUES (@id, @production_id, @venue_id, @show_date, @source_event_id, @settlement_id, @sender_code, @city,
            @gbor_cents, @sales_tax_cents, @card_fees_cents, @facility_fee_cents, @ffe_fee_cents, @group_discount_cents,
            @agbor_cents, @grand_rights_cents, @venue_expense_cents, @promoter_expense_cap_cents,
            @venue_expense_recouped_cents, @venue_expense_capped_cents, @deal_payout_cents, @currency, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listTheatricalStopSettlements(
    productionId: string,
  ): Promise<TheatricalStopSettlementRecord[]> {
    // show_date then created_at — the tour book in stop order (rowid ASC
    // the strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM theatrical_stop_settlements
         WHERE production_id = ?
         ORDER BY show_date ASC, created_at ASC, rowid ASC`,
        )
        .all(productionId) as TheatricalStopSettlementRecord[],
    );
  }

  async updateTheatricalDealRecoupment(
    id: string,
    recoupedCents: number,
    updatedAt: string,
  ): Promise<TheatricalProductionDealRecord | undefined> {
    // One conditional statement — the WHERE clause bounds the counter to
    // the capitalization budget (the CAS; the pool discipline). changes = 0
    // means the deal is absent or the caller's value regressed.
    const result = this.db
      .prepare(
        `UPDATE theatrical_production_deals
         SET recouped_cents = ?, updated_at = ?
         WHERE id = ?
           AND recouped_cents < ?
           AND recouped_cents + ? <= capitalization_budget_cents`,
      )
      .run(recoupedCents, updatedAt, id, recoupedCents, recoupedCents);
    if (result.changes === 0) return undefined;
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM theatrical_production_deals WHERE id = ?`)
        .get(id) as TheatricalProductionDealRecord | undefined,
    );
  }

  async insertTheatricalRecoupmentApplication(
    row: Omit<TheatricalRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalRecoupmentApplicationRecord> {
    // UNIQUE per (deal_id, source_event_id) — a replayed application is the
    // unique violation. UNIQUE per (deal_id, recouped_before_cents) — the
    // POSITION lock (the books/art discipline).
    const record: TheatricalRecoupmentApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO theatrical_recoupment_applications
           (id, deal_id, scope_key, source_event_id, recouped_before_cents, applied_cents, remaining_cents, created_at)
         VALUES (@id, @deal_id, @scope_key, @source_event_id, @recouped_before_cents, @applied_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listTheatricalRecoupmentApplications(
    dealId: string,
  ): Promise<TheatricalRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order (rowid
    // ASC the strict tiebreak).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM theatrical_recoupment_applications
         WHERE deal_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(dealId) as TheatricalRecoupmentApplicationRecord[],
    );
  }

  async insertTheatricalSplitAccrual(
    row: Omit<TheatricalSplitAccrualRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalSplitAccrualRecord> {
    // UNIQUE per (deal_id, source_event_id) — a replayed accrual is the
    // unique violation, never a double designation.
    const record: TheatricalSplitAccrualRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO theatrical_split_accruals
           (id, deal_id, scope_key, deal_class, source_event_id, basis_cents, allocations, dust_cents, created_at)
         VALUES (@id, @deal_id, @scope_key, @deal_class, @source_event_id, @basis_cents, @allocations, @dust_cents, @created_at)`,
      )
      .run({
        ...record,
        allocations: JSON.stringify(record.allocations),
      } as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listTheatricalSplitAccruals(dealId: string): Promise<TheatricalSplitAccrualRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM theatrical_split_accruals
         WHERE deal_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(dealId) as (TheatricalSplitAccrualRecord & { allocations: string })[];
    return Promise.resolve(
      rows.map((row) => ({
        ...row,
        allocations: JSON.parse(row.allocations) as TheatricalSplitAccrualRecord['allocations'],
      })),
    );
  }

  // --- Promoter settlement escrow + theater gates + comedy audio (PR 31,
  // --- migration 0035) ---

  async listPromoterSettlementEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'promoter_box_office_settlement_pending' AND status = 'promoter_box_office_settlement_pending'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async settlePromoterSettlementEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS, scoped to
    // the promoter lock state only. changes = 0 means the row is absent or
    // no longer locked; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'promoter_box_office_settlement_pending'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  async upsertPromoterSettlementAudit(
    row: Omit<PromoterSettlementAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PromoterSettlementAuditRecord> {
    // UNIQUE per (production_id, venue_id, show_date) — a re-recording
    // converges (the newest close governs the next release).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM promoter_settlement_audits
         WHERE production_id = ? AND venue_id = ? AND show_date = ?`,
      )
      .get(row.production_id, row.venue_id, row.show_date) as
      | PromoterSettlementAuditRecord
      | undefined;
    const record: PromoterSettlementAuditRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO promoter_settlement_audits
           (id, production_id, venue_id, show_date, audit_state, evidence_ref, closed_by, created_at, updated_at)
         VALUES (@id, @production_id, @venue_id, @show_date, @audit_state, @evidence_ref, @closed_by, @created_at, @updated_at)
         ON CONFLICT (production_id, venue_id, show_date) DO UPDATE SET
           audit_state = excluded.audit_state,
           evidence_ref = excluded.evidence_ref,
           closed_by = excluded.closed_by,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getPromoterSettlementAudit(
    productionId: string,
    venueId: string,
    showDate: string,
  ): Promise<PromoterSettlementAuditRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM promoter_settlement_audits
         WHERE production_id = ? AND venue_id = ? AND show_date = ?`,
        )
        .get(productionId, venueId, showDate) as PromoterSettlementAuditRecord | undefined,
    );
  }

  async upsertTheatricalPayoutGateState(
    row: Omit<TheatricalPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<TheatricalPayoutGateStateRecord> {
    // UNIQUE per (payee_id, production_id) — an upsert converges (the newest
    // states govern the next dispatch).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM theatrical_payout_gate_states WHERE payee_id = ? AND production_id = ?`,
      )
      .get(row.payee_id, row.production_id) as
      | TheatricalPayoutGateStateRecord
      | undefined;
    const record: TheatricalPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO theatrical_payout_gate_states
           (id, payee_id, production_id, grand_rights_state, venue_settlement_state,
            grand_rights_evidence_ref, venue_settlement_evidence_ref, verified_by, created_at, updated_at)
         VALUES (@id, @payee_id, @production_id, @grand_rights_state, @venue_settlement_state,
                 @grand_rights_evidence_ref, @venue_settlement_evidence_ref, @verified_by, @created_at, @updated_at)
         ON CONFLICT (payee_id, production_id) DO UPDATE SET
           grand_rights_state = excluded.grand_rights_state,
           venue_settlement_state = excluded.venue_settlement_state,
           grand_rights_evidence_ref = excluded.grand_rights_evidence_ref,
           venue_settlement_evidence_ref = excluded.venue_settlement_evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getTheatricalPayoutGateState(
    payeeId: string,
    productionId: string,
  ): Promise<TheatricalPayoutGateStateRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM theatrical_payout_gate_states WHERE payee_id = ? AND production_id = ?`,
        )
        .get(payeeId, productionId) as TheatricalPayoutGateStateRecord | undefined,
    );
  }

  async upsertVenueHallFeePolicy(
    row: Omit<VenueHallFeePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<VenueHallFeePolicyRecord> {
    // UNIQUE per (tour_id, venue_id) — an upsert converges.
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM venue_hall_fee_policies WHERE tour_id = ? AND venue_id = ?`)
      .get(row.tour_id, row.venue_id) as VenueHallFeePolicyRecord | undefined;
    const record: VenueHallFeePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO venue_hall_fee_policies
           (id, tour_id, venue_id, hall_fee_rate_bps, venue_payee_id, venue_payee_name, created_at, updated_at)
         VALUES (@id, @tour_id, @venue_id, @hall_fee_rate_bps, @venue_payee_id, @venue_payee_name, @created_at, @updated_at)
         ON CONFLICT (tour_id, venue_id) DO UPDATE SET
           hall_fee_rate_bps = excluded.hall_fee_rate_bps,
           venue_payee_id = excluded.venue_payee_id,
           venue_payee_name = excluded.venue_payee_name,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getVenueHallFeePolicy(
    tourId: string,
    venueId: string,
  ): Promise<VenueHallFeePolicyRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM venue_hall_fee_policies WHERE tour_id = ? AND venue_id = ?`)
        .get(tourId, venueId) as VenueHallFeePolicyRecord | undefined,
    );
  }

  // --- Brand licensing: Net Sales + tiered royalties + sub-license cascade
  // --- (PR 32, migration 0036) ---

  async upsertLicensingRoyaltyDeal(
    row: Omit<LicensingRoyaltyDealRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingRoyaltyDealRecord> {
    // UNIQUE per scope_key — a re-registration replaces the row atomically
    // (the caller increments version and preserves the counters; this
    // method never touches them).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM licensing_royalty_deals WHERE scope_key = ?`)
      .get(row.scope_key) as LicensingRoyaltyDealRecord | undefined;
    const record: LicensingRoyaltyDealRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO licensing_royalty_deals
           (id, scope_key, license_id, currency, tiers, agency_commission_bps,
            licensor_a_payee_id, licensor_a_payee_name, licensor_a_country,
            licensor_b_payee_id, licensor_b_payee_name, licensor_b_country,
            withholding_default_bps, cumulative_net_sales_cents, cumulative_royalty_cents,
            version, created_at, updated_at)
         VALUES (@id, @scope_key, @license_id, @currency, @tiers, @agency_commission_bps,
            @licensor_a_payee_id, @licensor_a_payee_name, @licensor_a_country,
            @licensor_b_payee_id, @licensor_b_payee_name, @licensor_b_country,
            @withholding_default_bps, @cumulative_net_sales_cents, @cumulative_royalty_cents,
            @version, @created_at, @updated_at)
         ON CONFLICT (scope_key) DO UPDATE SET
           license_id = excluded.license_id,
           currency = excluded.currency,
           tiers = excluded.tiers,
           agency_commission_bps = excluded.agency_commission_bps,
           licensor_a_payee_id = excluded.licensor_a_payee_id,
           licensor_a_payee_name = excluded.licensor_a_payee_name,
           licensor_a_country = excluded.licensor_a_country,
           licensor_b_payee_id = excluded.licensor_b_payee_id,
           licensor_b_payee_name = excluded.licensor_b_payee_name,
           licensor_b_country = excluded.licensor_b_country,
           withholding_default_bps = excluded.withholding_default_bps,
           cumulative_net_sales_cents = excluded.cumulative_net_sales_cents,
           cumulative_royalty_cents = excluded.cumulative_royalty_cents,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(licensingDealToDbRow(record) as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getLicensingRoyaltyDeal(
    scopeKey: string,
  ): Promise<LicensingRoyaltyDealRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM licensing_royalty_deals WHERE scope_key = ?`)
      .get(scopeKey) as LicensingRoyaltyDealDbRow | undefined;
    return Promise.resolve(row === undefined ? undefined : licensingDealFromDbRow(row));
  }

  async insertLicensingRoyaltyApplication(
    row: Omit<LicensingRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingRoyaltyApplicationRecord> {
    // UNIQUE per (deal_id, source_event_id) is the replay guard; UNIQUE
    // per (deal_id, cumulative_before_cents) is the position lock — a
    // replayed walk or a lost position race throws here (the raw SQLite
    // unique violation, this backend's convention), never a double
    // application; the caller retries at the advanced position.
    const record: LicensingRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO licensing_royalty_applications
           (id, deal_id, scope_key, source_event_id, period, net_sales_cents,
            cumulative_before_cents, royalty_cents, slices, agency_commission_cents,
            licensor_a_gross_cents, licensor_b_gross_cents, dust_cents,
            withholding_rate_bps, licensor_a_withheld_cents, licensor_b_withheld_cents,
            withholding_ref, created_at)
         VALUES (@id, @deal_id, @scope_key, @source_event_id, @period, @net_sales_cents,
            @cumulative_before_cents, @royalty_cents, @slices, @agency_commission_cents,
            @licensor_a_gross_cents, @licensor_b_gross_cents, @dust_cents,
            @withholding_rate_bps, @licensor_a_withheld_cents, @licensor_b_withheld_cents,
            @withholding_ref, @created_at)`,
      )
      .run(licensingApplicationToDbRow(record) as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listLicensingRoyaltyApplications(
    dealId: string,
  ): Promise<LicensingRoyaltyApplicationRecord[]> {
    // created_at ASC — the cumulative ledger in walk order.
    const rows = this.db
      .prepare(
        `SELECT * FROM licensing_royalty_applications
         WHERE deal_id = ? ORDER BY created_at ASC`,
      )
      .all(dealId) as LicensingRoyaltyApplicationDbRow[];
    return Promise.resolve(rows.map(licensingApplicationFromDbRow));
  }

  async upsertLicensingTreatyRate(
    row: Omit<LicensingTreatyRateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingTreatyRateRecord> {
    // UNIQUE per (source_country, residence_country) — a re-registration
    // converges (the newest rate governs the next walk).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM licensing_treaty_rates
         WHERE source_country = ? AND residence_country = ?`,
      )
      .get(row.source_country, row.residence_country) as LicensingTreatyRateRecord | undefined;
    const record: LicensingTreatyRateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO licensing_treaty_rates
           (id, source_country, residence_country, rate_bps, treaty_ref, created_at, updated_at)
         VALUES (@id, @source_country, @residence_country, @rate_bps, @treaty_ref, @created_at, @updated_at)
         ON CONFLICT (source_country, residence_country) DO UPDATE SET
           rate_bps = excluded.rate_bps,
           treaty_ref = excluded.treaty_ref,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getLicensingTreatyRate(
    sourceCountry: string,
    residenceCountry: string,
  ): Promise<LicensingTreatyRateRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM licensing_treaty_rates
         WHERE source_country = ? AND residence_country = ?`,
        )
        .get(sourceCountry, residenceCountry) as LicensingTreatyRateRecord | undefined,
    );
  }

  async upsertLicensingSubLicensee(
    row: Omit<LicensingSubLicenseeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseeRecord> {
    // UNIQUE per (scope_key, sub_licensee_id) — an upsert converges (the
    // newest override governs the next report).
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM licensing_sub_licensees WHERE scope_key = ? AND sub_licensee_id = ?`,
      )
      .get(row.scope_key, row.sub_licensee_id) as LicensingSubLicenseeRecord | undefined;
    const record: LicensingSubLicenseeRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO licensing_sub_licensees
           (id, scope_key, sub_licensee_id, region_code, master_override_bps,
            payee_id, payee_name, created_at, updated_at)
         VALUES (@id, @scope_key, @sub_licensee_id, @region_code, @master_override_bps,
            @payee_id, @payee_name, @created_at, @updated_at)
         ON CONFLICT (scope_key, sub_licensee_id) DO UPDATE SET
           region_code = excluded.region_code,
           master_override_bps = excluded.master_override_bps,
           payee_id = excluded.payee_id,
           payee_name = excluded.payee_name,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getLicensingSubLicensee(
    scopeKey: string,
    subLicenseeId: string,
  ): Promise<LicensingSubLicenseeRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM licensing_sub_licensees WHERE scope_key = ? AND sub_licensee_id = ?`,
        )
        .get(scopeKey, subLicenseeId) as LicensingSubLicenseeRecord | undefined,
    );
  }

  async listLicensingSubLicensees(scopeKey: string): Promise<LicensingSubLicenseeRecord[]> {
    // created_at ASC — the registered regional parties in registration order.
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM licensing_sub_licensees WHERE scope_key = ? ORDER BY created_at ASC`)
        .all(scopeKey) as LicensingSubLicenseeRecord[],
    );
  }

  async upsertLicensingSubLicenseReport(
    row: Omit<LicensingSubLicenseReportRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseReportRecord> {
    // UNIQUE per source_event_id — a re-shipped manifest converges, never
    // a double report row. The CAS reconcile (below) is the ONLY writer of
    // the 'reconciled' audit state; this upsert never flips it.
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM licensing_sub_license_reports WHERE source_event_id = ?`)
      .get(row.source_event_id) as LicensingSubLicenseReportRecord | undefined;
    const record: LicensingSubLicenseReportRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO licensing_sub_license_reports
           (id, scope_key, sub_licensee_id, region_code, period, source_event_id,
            gross_cents, trade_discount_cents, returned_goods_cents,
            shipping_freight_cents, vat_cents, net_sales_cents,
            master_override_bps, master_royalty_cents, audit_state,
            evidence_ref, reconciled_by, created_at, updated_at)
         VALUES (@id, @scope_key, @sub_licensee_id, @region_code, @period, @source_event_id,
            @gross_cents, @trade_discount_cents, @returned_goods_cents,
            @shipping_freight_cents, @vat_cents, @net_sales_cents,
            @master_override_bps, @master_royalty_cents, @audit_state,
            @evidence_ref, @reconciled_by, @created_at, @updated_at)
         ON CONFLICT (source_event_id) DO UPDATE SET
           scope_key = excluded.scope_key,
           sub_licensee_id = excluded.sub_licensee_id,
           region_code = excluded.region_code,
           period = excluded.period,
           gross_cents = excluded.gross_cents,
           trade_discount_cents = excluded.trade_discount_cents,
           returned_goods_cents = excluded.returned_goods_cents,
           shipping_freight_cents = excluded.shipping_freight_cents,
           vat_cents = excluded.vat_cents,
           net_sales_cents = excluded.net_sales_cents,
           master_override_bps = excluded.master_override_bps,
           master_royalty_cents = excluded.master_royalty_cents,
           audit_state = excluded.audit_state,
           evidence_ref = excluded.evidence_ref,
           reconciled_by = excluded.reconciled_by,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getLicensingSubLicenseReport(
    sourceEventId: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM licensing_sub_license_reports WHERE source_event_id = ?`)
        .get(sourceEventId) as LicensingSubLicenseReportRecord | undefined,
    );
  }

  async listLicensingSubLicenseReports(
    scopeKey: string,
  ): Promise<LicensingSubLicenseReportRecord[]> {
    // created_at ASC — the audit trail the release path replays.
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM licensing_sub_license_reports WHERE scope_key = ? ORDER BY created_at ASC`)
        .all(scopeKey) as LicensingSubLicenseReportRecord[],
    );
  }

  async reconcileLicensingSubLicenseReport(
    id: string,
    evidenceRef: string,
    reconciledBy: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined> {
    // The evidenced audit CAS — flips ONE row 'unknown' → 'reconciled' in
    // a single conditional statement; the caller that lost the race (or
    // replayed) reads undefined.
    const result = this.db
      .prepare(
        `UPDATE licensing_sub_license_reports
         SET audit_state = 'reconciled', evidence_ref = ?, reconciled_by = ?, updated_at = ?
         WHERE id = ? AND audit_state = 'unknown'`,
      )
      .run(evidenceRef, reconciledBy, new Date().toISOString(), id);
    if (result.changes === 0) return Promise.resolve(undefined);
    return this.getLicensingSubLicenseReport(
      // The CAS keyed on the row id; read it back by its event id.
      (this.db
        .prepare(`SELECT source_event_id FROM licensing_sub_license_reports WHERE id = ?`)
        .get(id) as { source_event_id: string }).source_event_id,
    );
  }

  // --- Advance / MG recoupment, shortfall invoices, audit reserve escrow,
  // --- and payout gate states (PR 33, migration 0037) ---

  async upsertLicensingMgCommitment(
    row: Omit<LicensingMgCommitmentRecord, 'id' | 'created_at' | 'updated_at' | 'recouped_cents'> & {
      recouped_cents?: number;
    },
  ): Promise<LicensingMgCommitmentRecord> {
    // UNIQUE per (scope_key, commitment_ref) — a re-registration replaces
    // the row atomically (the option-agreement discipline).
    const record = {
      ...row,
      recouped_cents: row.recouped_cents ?? 0,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO licensing_mg_commitments
           (id, scope_key, commitment_ref, category_code, collateralization,
            mg_amount_cents, currency, licensee_id, licensee_name,
            recouped_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_key, commitment_ref) DO UPDATE SET
           category_code = excluded.category_code,
           collateralization = excluded.collateralization,
           mg_amount_cents = excluded.mg_amount_cents,
           currency = excluded.currency,
           licensee_id = excluded.licensee_id,
           licensee_name = excluded.licensee_name,
           recouped_cents = excluded.recouped_cents,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.commitment_ref,
        record.category_code,
        record.collateralization,
        record.mg_amount_cents,
        record.currency,
        record.licensee_id,
        record.licensee_name,
        record.recouped_cents,
        record.created_at,
        record.updated_at,
      );
    return this.getLicensingMgCommitment(record.scope_key, record.commitment_ref) as Promise<
      LicensingMgCommitmentRecord
    >;
  }

  async getLicensingMgCommitment(
    scopeKey: string,
    commitmentRef: string,
  ): Promise<LicensingMgCommitmentRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM licensing_mg_commitments WHERE scope_key = ? AND commitment_ref = ?`)
      .get(scopeKey, commitmentRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return this.licensingMgCommitmentRow(row);
  }

  async listLicensingMgCommitments(scopeKey: string): Promise<LicensingMgCommitmentRecord[]> {
    return (
      this.db
        .prepare(`SELECT * FROM licensing_mg_commitments WHERE scope_key = ? ORDER BY created_at ASC`)
        .all(scopeKey) as Record<string, unknown>[]
    ).map((row) => this.licensingMgCommitmentRow(row));
  }

  private licensingMgCommitmentRow(row: Record<string, unknown>): LicensingMgCommitmentRecord {
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      commitment_ref: row.commitment_ref as string,
      category_code: row.category_code as string,
      collateralization: row.collateralization as LicensingMgCommitmentRecord['collateralization'],
      mg_amount_cents: Number(row.mg_amount_cents),
      currency: row.currency as string,
      licensee_id: row.licensee_id as string,
      licensee_name: row.licensee_name as string,
      recouped_cents: Number(row.recouped_cents),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertLicensingMgRecoupmentApplication(
    row: Omit<LicensingMgRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingMgRecoupmentApplicationRecord> {
    // UNIQUE per (commitment_id, source_event_id) is the replay guard;
    // UNIQUE per (commitment_id, recouped_before_cents) is the position
    // lock — a replayed event or a lost position race throws here, never a
    // double application; the caller retries at the advanced position.
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO licensing_mg_recoupment_applications
           (id, commitment_id, scope_key, category_code, source_event_id,
            earned_royalty_cents, recouped_before_cents, recouped_cents,
            recouped_after_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.commitment_id,
        record.scope_key,
        record.category_code,
        record.source_event_id,
        record.earned_royalty_cents,
        record.recouped_before_cents,
        record.recouped_cents,
        record.recouped_after_cents,
        record.created_at,
      );
    return record;
  }

  async listLicensingMgRecoupmentApplications(
    commitmentId: string,
  ): Promise<LicensingMgRecoupmentApplicationRecord[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM licensing_mg_recoupment_applications
           WHERE commitment_id = ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(commitmentId) as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id as string,
      commitment_id: row.commitment_id as string,
      scope_key: row.scope_key as string,
      category_code: row.category_code as string,
      source_event_id: row.source_event_id as string,
      earned_royalty_cents: Number(row.earned_royalty_cents),
      recouped_before_cents: Number(row.recouped_before_cents),
      recouped_cents: Number(row.recouped_cents),
      recouped_after_cents: Number(row.recouped_after_cents),
      created_at: row.created_at as string,
    }));
  }

  async upsertLicensingMgTermClose(
    row: Omit<LicensingMgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingMgTermCloseRecord> {
    // UNIQUE per (commitment_id, term) — the once-only close; a replay
    // converges on the recorded shortfall and invoice of record.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO licensing_mg_term_closes
           (id, commitment_id, scope_key, term, mg_due_cents,
            recouped_at_close_cents, shortfall_cents, invoice_ledger_id,
            closed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (commitment_id, term) DO UPDATE SET
           mg_due_cents = excluded.mg_due_cents,
           recouped_at_close_cents = excluded.recouped_at_close_cents,
           shortfall_cents = excluded.shortfall_cents,
           invoice_ledger_id = excluded.invoice_ledger_id,
           closed_by = excluded.closed_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.commitment_id,
        record.scope_key,
        record.term,
        record.mg_due_cents,
        record.recouped_at_close_cents,
        record.shortfall_cents,
        record.invoice_ledger_id,
        record.closed_by,
        record.created_at,
        record.updated_at,
      );
    return this.getLicensingMgTermClose(record.commitment_id, record.term) as Promise<
      LicensingMgTermCloseRecord
    >;
  }

  async getLicensingMgTermClose(
    commitmentId: string,
    term: string,
  ): Promise<LicensingMgTermCloseRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM licensing_mg_term_closes WHERE commitment_id = ? AND term = ?`)
      .get(commitmentId, term) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      commitment_id: row.commitment_id as string,
      scope_key: row.scope_key as string,
      term: row.term as string,
      mg_due_cents: Number(row.mg_due_cents),
      recouped_at_close_cents: Number(row.recouped_at_close_cents),
      shortfall_cents: Number(row.shortfall_cents),
      invoice_ledger_id: (row.invoice_ledger_id as string | null) ?? null,
      closed_by: row.closed_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async listLicensingMgTermCloses(scopeKey: string): Promise<LicensingMgTermCloseRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM licensing_mg_term_closes WHERE scope_key = ? ORDER BY created_at ASC`)
      .all(scopeKey) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      commitment_id: row.commitment_id as string,
      scope_key: row.scope_key as string,
      term: row.term as string,
      mg_due_cents: Number(row.mg_due_cents),
      recouped_at_close_cents: Number(row.recouped_at_close_cents),
      shortfall_cents: Number(row.shortfall_cents),
      invoice_ledger_id: (row.invoice_ledger_id as string | null) ?? null,
      closed_by: row.closed_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertLicensingAuditReservePolicy(
    row: Omit<LicensingAuditReservePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingAuditReservePolicyRecord> {
    // UNIQUE per scope_key — a re-registration converges (the newest rate
    // governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO licensing_audit_reserve_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(record.id, record.scope_key, record.reserve_rate_bps, record.created_at, record.updated_at);
    return this.getLicensingAuditReservePolicy(record.scope_key) as Promise<
      LicensingAuditReservePolicyRecord
    >;
  }

  async getLicensingAuditReservePolicy(
    scopeKey: string,
  ): Promise<LicensingAuditReservePolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM licensing_audit_reserve_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: Number(row.reserve_rate_bps),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertLicensingAuditReserveReconciliation(
    row: Omit<LicensingAuditReserveReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO licensing_audit_reserve_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.reserve_ledger_id, record.evidence_ref, record.reconciled_by, record.created_at);
    return record;
  }

  async getLicensingAuditReserveReconciliation(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM licensing_audit_reserve_reconciliations WHERE reserve_ledger_id = ?`)
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async insertLicensingAuditReserveDrawdown(
    row: Omit<LicensingAuditReserveDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
    // UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
    // lock — a replayed event or a lost race throws here, never a double
    // drawdown; the caller re-derives from the append-only truth.
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO licensing_audit_reserve_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listLicensingAuditReserveDrawdowns(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveDrawdownRecord[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM licensing_audit_reserve_drawdowns
           WHERE reserve_ledger_id = ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(reserveLedgerId) as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class: row.drawdown_class as LicensingAuditReserveDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: Number(row.drawn_before_cents),
      drawn_cents: Number(row.drawn_cents),
      remaining_cents: Number(row.remaining_cents),
      created_at: row.created_at as string,
    }));
  }

  async upsertLicensingPayoutGateState(
    row: Omit<LicensingPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingPayoutGateStateRecord> {
    // UNIQUE per (payee_id, scope_key) — an upsert converges (the newest
    // states govern the next dispatch).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO licensing_payout_gate_states
           (id, payee_id, scope_key, territory_state, category_exclusivity_state,
            territory_evidence_ref, category_exclusivity_evidence_ref,
            verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, scope_key) DO UPDATE SET
           territory_state = excluded.territory_state,
           category_exclusivity_state = excluded.category_exclusivity_state,
           territory_evidence_ref = excluded.territory_evidence_ref,
           category_exclusivity_evidence_ref = excluded.category_exclusivity_evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.scope_key,
        record.territory_state,
        record.category_exclusivity_state,
        record.territory_evidence_ref,
        record.category_exclusivity_evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getLicensingPayoutGateState(record.payee_id, record.scope_key) as Promise<
      LicensingPayoutGateStateRecord
    >;
  }

  async getLicensingPayoutGateState(
    payeeId: string,
    scopeKey: string,
  ): Promise<LicensingPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM licensing_payout_gate_states WHERE payee_id = ? AND scope_key = ?`)
      .get(payeeId, scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      scope_key: row.scope_key as string,
      territory_state: row.territory_state as LicensingPayoutGateStateRecord['territory_state'],
      category_exclusivity_state: row
        .category_exclusivity_state as LicensingPayoutGateStateRecord['category_exclusivity_state'],
      territory_evidence_ref: (row.territory_evidence_ref as string | null) ?? null,
      category_exclusivity_evidence_ref:
        (row.category_exclusivity_evidence_ref as string | null) ?? null,
      verified_by: (row.verified_by as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async settleLicensingAuditReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the localization escrow settle rides: only the caller
    // whose WHERE matched (the reserve was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'audit_reserve_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async getLicensingRoyaltyApplication(
    dealId: string,
    sourceEventId: string,
  ): Promise<LicensingRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM licensing_royalty_applications WHERE deal_id = ? AND source_event_id = ?`,
      )
      .get(dealId, sourceEventId) as LicensingRoyaltyApplicationDbRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve(licensingApplicationFromDbRow(row));
  }

  // --- The NIL lane: the compliance parser + roster waterfall (PR 34,
  // --- migration 0038) ---
  // UPSERT DISCIPLINE (the PR 33 parity-suite lesson, applied): the
  // UPDATE SET list NEVER touches id — on conflict the id stays the
  // existing row's; the generated id only lands on the insert path.

  async upsertNilRevenueShareProgram(
    row: Omit<NilRevenueShareProgramRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRevenueShareProgramRecord> {
    // UNIQUE per scope_key — a re-registration replaces the row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_revenue_share_programs
           (id, scope_key, scope, school_id, collective_id,
            title_ix_reserve_bps, admin_fee_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           scope = excluded.scope,
           school_id = excluded.school_id,
           collective_id = excluded.collective_id,
           title_ix_reserve_bps = excluded.title_ix_reserve_bps,
           admin_fee_bps = excluded.admin_fee_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.scope,
        record.school_id,
        record.collective_id,
        record.title_ix_reserve_bps,
        record.admin_fee_bps,
        record.created_at,
        record.updated_at,
      );
    return (await this.getNilRevenueShareProgram(record.scope_key)) as NilRevenueShareProgramRecord;
  }

  async getNilRevenueShareProgram(
    scopeKey: string,
  ): Promise<NilRevenueShareProgramRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_revenue_share_programs WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      scope_key: row.scope_key as string,
      scope: row.scope as NilRevenueShareProgramRecord['scope'],
      school_id: (row.school_id as string | null) ?? null,
      collective_id: (row.collective_id as string | null) ?? null,
      title_ix_reserve_bps: row.title_ix_reserve_bps as number,
      admin_fee_bps: row.admin_fee_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async upsertNilRosterWaterfall(
    row: Omit<NilRosterWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRosterWaterfallRecord> {
    // UNIQUE per (scope_key, waterfall_key) — an upsert converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_roster_waterfalls
           (id, scope_key, waterfall_key, kind, tiers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_key, waterfall_key) DO UPDATE SET
           kind = excluded.kind,
           tiers = excluded.tiers,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.waterfall_key,
        record.kind,
        record.tiers,
        record.created_at,
        record.updated_at,
      );
    return (await this.getNilRosterWaterfall(
      record.scope_key,
      record.waterfall_key,
    )) as NilRosterWaterfallRecord;
  }

  async getNilRosterWaterfall(
    scopeKey: string,
    waterfallKey: string,
  ): Promise<NilRosterWaterfallRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM nil_roster_waterfalls WHERE scope_key = ? AND waterfall_key = ?`,
      )
      .get(scopeKey, waterfallKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      scope_key: row.scope_key as string,
      waterfall_key: row.waterfall_key as string,
      kind: row.kind as NilRosterWaterfallRecord['kind'],
      tiers: row.tiers as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async upsertNilSchoolCap(
    row: Omit<NilSchoolCapRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilSchoolCapRecord> {
    // UNIQUE per (school_id, cap_year) — an upsert converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_school_caps
           (id, school_id, cap_year, annual_cap_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (school_id, cap_year) DO UPDATE SET
           annual_cap_cents = excluded.annual_cap_cents,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.school_id,
        record.cap_year,
        record.annual_cap_cents,
        record.created_at,
        record.updated_at,
      );
    return (await this.getNilSchoolCap(
      record.school_id,
      record.cap_year,
    )) as NilSchoolCapRecord;
  }

  async getNilSchoolCap(
    schoolId: string,
    capYear: string,
  ): Promise<NilSchoolCapRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_school_caps WHERE school_id = ? AND cap_year = ?`)
      .get(schoolId, capYear) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      school_id: row.school_id as string,
      cap_year: row.cap_year as string,
      annual_cap_cents: row.annual_cap_cents as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async insertNilCapVerification(
    row: Omit<NilCapVerificationRecord, 'id' | 'created_at'>,
  ): Promise<NilCapVerificationRecord> {
    // UNIQUE per (school_id, cap_year) is the INSERT-AS-LOCK: the FIRST
    // verification wins; a concurrent second insert throws here, never a
    // double verification.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_cap_verifications
           (id, school_id, cap_year, verified_committed_cents, evidence_ref, verified_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.school_id,
        record.cap_year,
        record.verified_committed_cents,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
      );
    return record;
  }

  async getNilCapVerification(
    schoolId: string,
    capYear: string,
  ): Promise<NilCapVerificationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_cap_verifications WHERE school_id = ? AND cap_year = ?`)
      .get(schoolId, capYear) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      school_id: row.school_id as string,
      cap_year: row.cap_year as string,
      verified_committed_cents: row.verified_committed_cents as number,
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
    });
  }

  async upsertNilDealComplianceAudit(
    row: Omit<NilDealComplianceAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilDealComplianceAuditRecord> {
    // UNIQUE per nil_contract_id — an upsert converges: the $600 flag
    // heals to 'nil_cleared'; never the reverse through this table.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_deal_compliance_audits
           (id, nil_contract_id, athlete_id, school_id, deal_value_cents,
            business_purpose_state, purpose_description, evidence_ref, cleared_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (nil_contract_id) DO UPDATE SET
           athlete_id = excluded.athlete_id,
           school_id = excluded.school_id,
           deal_value_cents = excluded.deal_value_cents,
           business_purpose_state = excluded.business_purpose_state,
           purpose_description = excluded.purpose_description,
           evidence_ref = excluded.evidence_ref,
           cleared_by = excluded.cleared_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.nil_contract_id,
        record.athlete_id,
        record.school_id,
        record.deal_value_cents,
        record.business_purpose_state,
        record.purpose_description,
        record.evidence_ref,
        record.cleared_by,
        record.created_at,
        record.updated_at,
      );
    return (await this.getNilDealComplianceAudit(
      record.nil_contract_id,
    )) as NilDealComplianceAuditRecord;
  }

  async getNilDealComplianceAudit(
    nilContractId: string,
  ): Promise<NilDealComplianceAuditRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_deal_compliance_audits WHERE nil_contract_id = ?`)
      .get(nilContractId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_id: row.athlete_id as string,
      school_id: row.school_id as string,
      deal_value_cents: row.deal_value_cents as number,
      business_purpose_state:
        row.business_purpose_state as NilDealComplianceAuditRecord['business_purpose_state'],
      purpose_description: (row.purpose_description as string | null) ?? null,
      evidence_ref: (row.evidence_ref as string | null) ?? null,
      cleared_by: (row.cleared_by as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async insertNilPayoutApplication(
    row: Omit<NilPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPayoutApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked event
    // throws here, never a double payout.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_payout_applications
           (id, nil_contract_id, athlete_id, school_id, source_event_id, period,
            gross_cents, agency_mode, agency_bps, agency_fee_cents, net_payout_cents,
            verdict, state_rule_ref, cap_verified_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.nil_contract_id,
        record.athlete_id,
        record.school_id,
        record.source_event_id,
        record.period,
        record.gross_cents,
        record.agency_mode,
        record.agency_bps,
        record.agency_fee_cents,
        record.net_payout_cents,
        record.verdict,
        record.state_rule_ref,
        record.cap_verified_ref,
        record.created_at,
      );
    return record;
  }

  async getNilPayoutApplication(
    sourceEventId: string,
  ): Promise<NilPayoutApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_payout_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_id: row.athlete_id as string,
      school_id: row.school_id as string,
      source_event_id: row.source_event_id as string,
      period: row.period as string,
      gross_cents: row.gross_cents as number,
      agency_mode: row.agency_mode as NilPayoutApplicationRecord['agency_mode'],
      agency_bps: row.agency_bps as number,
      agency_fee_cents: row.agency_fee_cents as number,
      net_payout_cents: row.net_payout_cents as number,
      verdict: row.verdict as NilPayoutApplicationRecord['verdict'],
      state_rule_ref: (row.state_rule_ref as string | null) ?? null,
      cap_verified_ref: (row.cap_verified_ref as string | null) ?? null,
      created_at: row.created_at as string,
    });
  }

  async insertNilPoolApplication(
    row: Omit<NilPoolApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPoolApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked pool
    // event throws here, never a double distribution.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_pool_applications
           (id, school_id, pool_type, source_event_id, period, gross_pool_cents,
            title_ix_reserve_bps, title_ix_reserve_cents, admin_fee_bps, admin_fee_cents,
            net_athlete_share_pool_cents, waterfall_key, tier_kind, slices,
            roster_paid_cents, dust_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.school_id,
        record.pool_type,
        record.source_event_id,
        record.period,
        record.gross_pool_cents,
        record.title_ix_reserve_bps,
        record.title_ix_reserve_cents,
        record.admin_fee_bps,
        record.admin_fee_cents,
        record.net_athlete_share_pool_cents,
        record.waterfall_key,
        record.tier_kind,
        record.slices,
        record.roster_paid_cents,
        record.dust_cents,
        record.created_at,
      );
    return record;
  }

  async getNilPoolApplication(
    sourceEventId: string,
  ): Promise<NilPoolApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_pool_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      school_id: row.school_id as string,
      pool_type: row.pool_type as NilPoolApplicationRecord['pool_type'],
      source_event_id: row.source_event_id as string,
      period: row.period as string,
      gross_pool_cents: row.gross_pool_cents as number,
      title_ix_reserve_bps: row.title_ix_reserve_bps as number,
      title_ix_reserve_cents: row.title_ix_reserve_cents as number,
      admin_fee_bps: row.admin_fee_bps as number,
      admin_fee_cents: row.admin_fee_cents as number,
      net_athlete_share_pool_cents: row.net_athlete_share_pool_cents as number,
      waterfall_key: row.waterfall_key as string,
      tier_kind: row.tier_kind as NilPoolApplicationRecord['tier_kind'],
      slices: row.slices as string,
      roster_paid_cents: row.roster_paid_cents as number,
      dust_cents: row.dust_cents as number,
      created_at: row.created_at as string,
    });
  }

  async insertNilGroupSplit(
    row: Omit<NilGroupSplitRecord, 'id' | 'created_at'>,
  ): Promise<NilGroupSplitRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-shipped
    // distribution splits once, never twice.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_group_splits
           (id, scope_ref, rights_stream, source_event_id, period, total_cents,
            participant_ids, participant_count, per_participant_cents, dust_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.scope_ref,
        record.rights_stream,
        record.source_event_id,
        record.period,
        record.total_cents,
        record.participant_ids,
        record.participant_count,
        record.per_participant_cents,
        record.dust_cents,
        record.created_at,
      );
    return record;
  }

  async getNilGroupSplit(
    sourceEventId: string,
  ): Promise<NilGroupSplitRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_group_splits WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      scope_ref: row.scope_ref as string,
      rights_stream: row.rights_stream as NilGroupSplitRecord['rights_stream'],
      source_event_id: row.source_event_id as string,
      period: row.period as string,
      total_cents: row.total_cents as number,
      participant_ids: row.participant_ids as string,
      participant_count: row.participant_count as number,
      per_participant_cents: row.per_participant_cents as number,
      dust_cents: row.dust_cents as number,
      created_at: row.created_at as string,
    });
  }

  async upsertNilStateRule(
    row: Omit<NilStateRuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilStateRuleRecord> {
    // UNIQUE per (state_jurisdiction_code, rule_code) — an upsert
    // converges (the newest rule governs the next payout execution).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_state_rules
           (id, state_jurisdiction_code, rule_code, applies_to_category, enforcement,
            rule_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (state_jurisdiction_code, rule_code) DO UPDATE SET
           applies_to_category = excluded.applies_to_category,
           enforcement = excluded.enforcement,
           rule_summary = excluded.rule_summary,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.state_jurisdiction_code,
        record.rule_code,
        record.applies_to_category,
        record.enforcement,
        record.rule_summary,
        record.created_at,
        record.updated_at,
      );
    return (await this.getNilStateRule(
      record.state_jurisdiction_code,
      record.rule_code,
    )) as NilStateRuleRecord;
  }

  async getNilStateRule(
    stateJurisdictionCode: string,
    ruleCode: string,
  ): Promise<NilStateRuleRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM nil_state_rules WHERE state_jurisdiction_code = ? AND rule_code = ?`,
      )
      .get(stateJurisdictionCode, ruleCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      state_jurisdiction_code: row.state_jurisdiction_code as string,
      rule_code: row.rule_code as string,
      applies_to_category: row.applies_to_category as string,
      enforcement: row.enforcement as NilStateRuleRecord['enforcement'],
      rule_summary: row.rule_summary as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async upsertNilPayoutGateState(
    row: Omit<NilPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilPayoutGateStateRecord> {
    // UNIQUE per (payee_id, school_id) — an upsert converges: a
    // verification heals 'unknown'; states never regress through this
    // table. The boolean mirror: true = 1, false = 0, null = NULL.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const backed = record.collective_or_booster_backed;
    this.db
      .prepare(
        `INSERT INTO nil_payout_gate_states
           (id, payee_id, school_id, nil_clearance_state, compliance_state, title_ix_state,
            collective_or_booster_backed, institutional_cap_state, evidence_ref, verified_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, school_id) DO UPDATE SET
           nil_clearance_state = excluded.nil_clearance_state,
           compliance_state = excluded.compliance_state,
           title_ix_state = excluded.title_ix_state,
           collective_or_booster_backed = excluded.collective_or_booster_backed,
           institutional_cap_state = excluded.institutional_cap_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.school_id,
        record.nil_clearance_state,
        record.compliance_state,
        record.title_ix_state,
        backed === null ? null : backed ? 1 : 0,
        record.institutional_cap_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return (await this.getNilPayoutGateState(
      record.payee_id,
      record.school_id,
    )) as NilPayoutGateStateRecord;
  }

  async getNilPayoutGateState(
    payeeId: string,
    schoolId: string,
  ): Promise<NilPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_payout_gate_states WHERE payee_id = ? AND school_id = ?`)
      .get(payeeId, schoolId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    const backed = row.collective_or_booster_backed as number | null | undefined;
    return Promise.resolve({
      id: row.id as string,
      payee_id: row.payee_id as string,
      school_id: row.school_id as string,
      nil_clearance_state:
        row.nil_clearance_state as NilPayoutGateStateRecord['nil_clearance_state'],
      compliance_state: row.compliance_state as NilPayoutGateStateRecord['compliance_state'],
      title_ix_state: row.title_ix_state as NilPayoutGateStateRecord['title_ix_state'],
      collective_or_booster_backed: backed === null || backed === undefined ? null : backed === 1,
      institutional_cap_state:
        row.institutional_cap_state as NilPayoutGateStateRecord['institutional_cap_state'],
      evidence_ref: (row.evidence_ref as string | null) ?? null,
      verified_by: (row.verified_by as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  // --- NIL audit escrow + transfer portal clawback (PR 35, migration 0039) ---

  async upsertNilAuditEscrowPolicy(
    row: Omit<NilAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registration converges (the newest rate
    // governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(record.id, record.scope_key, record.reserve_rate_bps, record.created_at, record.updated_at);
    return this.getNilAuditEscrowPolicy(record.scope_key) as Promise<NilAuditEscrowPolicyRecord>;
  }

  async getNilAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<NilAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_audit_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: Number(row.reserve_rate_bps),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async insertNilAuditEscrowDrawdown(
    row: Omit<NilAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
    // UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
    // lock — a replayed event or a lost race throws here, never a double
    // drawdown; the caller re-derives from the append-only truth.
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO nil_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listNilAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowDrawdownRecord[]> {
    return Promise.resolve(
      (
        this.db
          .prepare(
            `SELECT * FROM nil_audit_escrow_drawdowns
             WHERE reserve_ledger_id = ? ORDER BY created_at ASC, rowid ASC`,
          )
          .all(reserveLedgerId) as Record<string, unknown>[]
      ).map((row) => ({
        id: row.id as string,
        reserve_ledger_id: row.reserve_ledger_id as string,
        scope_key: row.scope_key as string,
        drawdown_class: row.drawdown_class as NilAuditEscrowDrawdownRecord['drawdown_class'],
        source_event_id: row.source_event_id as string,
        drawn_before_cents: Number(row.drawn_before_cents),
        drawn_cents: Number(row.drawn_cents),
        remaining_cents: Number(row.remaining_cents),
        created_at: row.created_at as string,
      })),
    );
  }

  async insertNilAuditEscrowReconciliation(
    row: Omit<NilAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO nil_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.reserve_ledger_id, record.evidence_ref, record.reconciled_by, record.created_at);
    return record;
  }

  async getNilAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`)
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    });
  }

  async settleNilAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the licensing reserve settle rides: only the caller
    // whose WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'nil_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertNilAdvanceSchedule(
    row: Omit<NilAdvanceScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAdvanceScheduleRecord> {
    // UNIQUE per nil_contract_id — a re-registration converges (the newest
    // terms govern the next pro-rated clawback calculation).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO nil_advance_schedules
           (id, nil_contract_id, athlete_id, school_id, advance_cents,
            term_start_date, term_end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (nil_contract_id) DO UPDATE SET
           athlete_id = excluded.athlete_id,
           school_id = excluded.school_id,
           advance_cents = excluded.advance_cents,
           term_start_date = excluded.term_start_date,
           term_end_date = excluded.term_end_date,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.nil_contract_id,
        record.athlete_id,
        record.school_id,
        record.advance_cents,
        record.term_start_date,
        record.term_end_date,
        record.created_at,
        record.updated_at,
      );
    return this.getNilAdvanceSchedule(record.nil_contract_id) as Promise<NilAdvanceScheduleRecord>;
  }

  async getNilAdvanceSchedule(
    nilContractId: string,
  ): Promise<NilAdvanceScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_advance_schedules WHERE nil_contract_id = ?`)
      .get(nilContractId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_id: row.athlete_id as string,
      school_id: row.school_id as string,
      advance_cents: Number(row.advance_cents),
      term_start_date: row.term_start_date as string,
      term_end_date: row.term_end_date as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    });
  }

  async insertNilTransferPortalEntry(
    row: Omit<NilTransferPortalEntryRecord, 'id' | 'created_at'>,
  ): Promise<NilTransferPortalEntryRecord> {
    // Insert-as-lock — UNIQUE per (nil_contract_id, athlete_id): the FIRST
    // portal entry of record wins; a re-shipped sheet or a lost race
    // throws here (the caller reads the winner through the getter). The
    // boolean mirror: true = 1, false = 0.
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO nil_transfer_portal_entries
           (id, nil_contract_id, athlete_id, school_id, entry_date,
            contract_completion_date, entered_prior_to_completion, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.nil_contract_id,
        record.athlete_id,
        record.school_id,
        record.entry_date,
        record.contract_completion_date,
        record.entered_prior_to_completion ? 1 : 0,
        record.created_at,
      );
    return record;
  }

  async getNilTransferPortalEntry(
    nilContractId: string,
    athleteId: string,
  ): Promise<NilTransferPortalEntryRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM nil_transfer_portal_entries WHERE nil_contract_id = ? AND athlete_id = ?`,
      )
      .get(nilContractId, athleteId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_id: row.athlete_id as string,
      school_id: row.school_id as string,
      entry_date: row.entry_date as string,
      contract_completion_date: (row.contract_completion_date as string | null) ?? null,
      entered_prior_to_completion: row.entered_prior_to_completion === 1,
      created_at: row.created_at as string,
    });
  }

  async insertNilUnearnedClawback(
    row: Omit<NilUnearnedClawbackRecord, 'id' | 'created_at'>,
  ): Promise<NilUnearnedClawbackRecord> {
    // UNIQUE per portal_entry_id — the calculation and its
    // nil_unearned_clawback debit hold land once; a concurrent second
    // insert throws here (the caller reads the winner through the
    // getter).
    const record = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO nil_unearned_clawbacks
           (id, nil_contract_id, athlete_id, school_id, portal_entry_id,
            advance_cents, term_start_date, term_end_date, entry_date,
            total_term_days, served_days, unearned_cents, clawback_ledger_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.nil_contract_id,
        record.athlete_id,
        record.school_id,
        record.portal_entry_id,
        record.advance_cents,
        record.term_start_date,
        record.term_end_date,
        record.entry_date,
        record.total_term_days,
        record.served_days,
        record.unearned_cents,
        record.clawback_ledger_id,
        record.created_at,
      );
    return record;
  }

  async getNilUnearnedClawback(
    portalEntryId: string,
  ): Promise<NilUnearnedClawbackRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM nil_unearned_clawbacks WHERE portal_entry_id = ?`)
      .get(portalEntryId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return Promise.resolve({
      id: row.id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_id: row.athlete_id as string,
      school_id: row.school_id as string,
      portal_entry_id: row.portal_entry_id as string,
      advance_cents: Number(row.advance_cents),
      term_start_date: row.term_start_date as string,
      term_end_date: row.term_end_date as string,
      entry_date: row.entry_date as string,
      total_term_days: Number(row.total_term_days),
      served_days: Number(row.served_days),
      unearned_cents: Number(row.unearned_cents),
      clawback_ledger_id: row.clawback_ledger_id as string,
      created_at: row.created_at as string,
    });
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

  // --- Foreign tax hold + book returns reserve (PR 27, migration 0031) ---

  async listForeignTaxHolds(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<LedgerTransactionRecord[]> {
    // The frozen-leg work queue — a thawed leg leaves the listing.
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'unclaimed_holding' AND status = 'foreign_tax_hold'
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async thawForeignTaxHolds(taxHoldScope: string): Promise<number> {
    // The THAW CAS sweep — the VERIFIED withholding credit's ledger leg:
    // ONLY the scope's 'foreign_tax_hold' legs return to holding. A re-run
    // is an honest no-op (the already-thawed legs no longer match).
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'unclaimed_holding'
         WHERE kind = 'unclaimed_holding' AND status = 'foreign_tax_hold'
           AND split_run_id = ?`,
      )
      .run(taxHoldScope);
    return Promise.resolve(result.changes);
  }

  async freezeForeignTaxHolds(taxHoldScope: string): Promise<number> {
    // The FREEZE CAS sweep — the foreign-tax-hold lane's ledger leg: ONLY
    // the scope's still-held legs enter the freeze. A re-applied hold is a
    // counted no-op (the already-frozen legs no longer match).
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'foreign_tax_hold'
         WHERE kind = 'unclaimed_holding' AND status = 'unclaimed_holding'
           AND split_run_id = ?`,
      )
      .run(taxHoldScope);
    return Promise.resolve(result.changes);
  }

  async upsertWithholdingTaxCreditVerification(
    row: Omit<WithholdingTaxCreditVerificationRecord, 'id'>,
  ): Promise<WithholdingTaxCreditVerificationRecord> {
    // One verification of record per (country_code, tax_year) — the ON
    // CONFLICT upsert replaces the evidence state atomically (the upgrade
    // pending → verified converges).
    const record: WithholdingTaxCreditVerificationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO withholding_tax_credit_verifications
           (id, country_code, tax_year, state, treaty_ref, evidence_ref, verified_by, verified_at, created_at, updated_at)
         VALUES (@id, @country_code, @tax_year, @state, @treaty_ref, @evidence_ref, @verified_by, @verified_at, @created_at, @updated_at)
         ON CONFLICT (country_code, tax_year) DO UPDATE SET
           state = excluded.state,
           treaty_ref = excluded.treaty_ref,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getWithholdingTaxCreditVerification(
    countryCode: string,
    taxYear: number,
  ): Promise<WithholdingTaxCreditVerificationRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM withholding_tax_credit_verifications WHERE country_code = ? AND tax_year = ?`,
        )
        .get(countryCode, taxYear) as WithholdingTaxCreditVerificationRecord | undefined,
    );
  }

  async upsertIsbnRightsVerification(
    row: Omit<IsbnRightsVerificationRecord, 'id'>,
  ): Promise<IsbnRightsVerificationRecord> {
    // One verification of record per isbn — the ON CONFLICT upsert replaces
    // the evidence state atomically.
    const record: IsbnRightsVerificationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO isbn_rights_verifications
           (id, isbn, state, evidence_ref, verified_by, verified_at, created_at, updated_at)
         VALUES (@id, @isbn, @state, @evidence_ref, @verified_by, @verified_at, @created_at, @updated_at)
         ON CONFLICT (isbn) DO UPDATE SET
           state = excluded.state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getIsbnRightsVerification(isbn: string): Promise<IsbnRightsVerificationRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM isbn_rights_verifications WHERE isbn = ?`)
        .get(isbn) as IsbnRightsVerificationRecord | undefined,
    );
  }

  async upsertBookReturnsReservePolicy(
    row: Omit<BookReturnsReservePolicyRecord, 'id'>,
  ): Promise<BookReturnsReservePolicyRecord> {
    // One policy of record per isbn — the ON CONFLICT upsert replaces the
    // money terms atomically (the option-agreement precedent).
    const record: BookReturnsReservePolicyRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO book_returns_reserve_policies
           (id, isbn, reserve_rate_bps, reserve_window_days, beneficiary_payee_id, beneficiary_payee_name, created_at, updated_at)
         VALUES (@id, @isbn, @reserve_rate_bps, @reserve_window_days, @beneficiary_payee_id, @beneficiary_payee_name, @created_at, @updated_at)
         ON CONFLICT (isbn) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           reserve_window_days = excluded.reserve_window_days,
           beneficiary_payee_id = excluded.beneficiary_payee_id,
           beneficiary_payee_name = excluded.beneficiary_payee_name,
           updated_at = excluded.updated_at`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async getBookReturnsReservePolicy(isbn: string): Promise<BookReturnsReservePolicyRecord | undefined> {
    return Promise.resolve(
      this.db
        .prepare(`SELECT * FROM book_returns_reserve_policies WHERE isbn = ?`)
        .get(isbn) as BookReturnsReservePolicyRecord | undefined,
    );
  }

  async listBookReturnsReserveCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'book_returns_reserve' AND status = 'book_returns_reserve'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
        )
        .all(limit) as LedgerTransactionRecord[],
    );
  }

  async listBookReturnsReserveCreditsByIsbn(isbn: string): Promise<LedgerTransactionRecord[]> {
    // EVERY state of the ISBN's reserves, oldest first — the FIFO draw
    // ordering and the gate's window derivation (a settled reserve still
    // proves its period ran).
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM ledger_transactions
         WHERE kind = 'book_returns_reserve' AND payee_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(bookReturnsReservePayeeId(isbn)) as LedgerTransactionRecord[],
    );
  }

  async settleBookReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // One conditional statement — the WHERE clause is the CAS. changes = 0
    // means the row is absent or no longer held; either way this call lost.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'book_returns_reserve'`,
      )
      .run(settledAt, id);
    if (result.changes === 0) return undefined;
    return this.getLedgerTransaction(id);
  }

  async insertBookReserveDrawdown(
    row: Omit<BookReserveDrawdownRecord, 'id'>,
  ): Promise<BookReserveDrawdownRecord> {
    // UNIQUE on (reserve_ledger_id, source_event_id) — a re-shipped
    // return/chargeback event is the unique violation, never a double
    // drawdown. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
    // insert-as-lock position arbiter: a concurrent drawdown that loses
    // the position throws.
    const record: BookReserveDrawdownRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO book_reserve_drawdowns
           (id, reserve_ledger_id, drawdown_class, source_event_id, drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (@id, @reserve_ledger_id, @drawdown_class, @source_event_id, @drawn_before_cents, @drawn_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listBookReserveDrawdowns(reserveLedgerId: string): Promise<BookReserveDrawdownRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM book_reserve_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY drawn_before_cents ASC`,
        )
        .all(reserveLedgerId) as BookReserveDrawdownRecord[],
    );
  }

  async insertBookReturnChargeback(
    row: Omit<BookReturnChargebackRecord, 'id'>,
  ): Promise<BookReturnChargebackRecord> {
    // UNIQUE on event_id — a re-shipped chargeback event is the unique
    // violation (the replay surface).
    const record: BookReturnChargebackRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO book_return_chargebacks
           (id, event_id, isbn, chargeback_class, chargeback_cents, currency, created_at)
         VALUES (@id, @event_id, @isbn, @chargeback_class, @chargeback_cents, @currency, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listBookReturnChargebacksByIsbn(isbn: string): Promise<BookReturnChargebackRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM book_return_chargebacks
         WHERE isbn = ?
         ORDER BY created_at ASC, rowid ASC`,
        )
        .all(isbn) as BookReturnChargebackRecord[],
    );
  }

  async insertBookChargebackOffsetApplication(
    row: Omit<BookChargebackOffsetApplicationRecord, 'id'>,
  ): Promise<BookChargebackOffsetApplicationRecord> {
    // UNIQUE on (chargeback_id, holding_ledger_id) — a replayed release is
    // the unique violation, never a double offset. UNIQUE on
    // (chargeback_id, offset_before_cents) — the insert-as-lock position
    // arbiter: exactly one release wins an offset's next running position.
    const record: BookChargebackOffsetApplicationRecord = { ...row, id: randomUUID() };
    this.db
      .prepare(
        `INSERT INTO book_chargeback_offset_applications
           (id, chargeback_id, holding_ledger_id, offset_before_cents, applied_cents, remaining_cents, created_at)
         VALUES (@id, @chargeback_id, @holding_ledger_id, @offset_before_cents, @applied_cents, @remaining_cents, @created_at)`,
      )
      .run(record as unknown as Record<string, unknown>);
    return Promise.resolve(record);
  }

  async listBookChargebackOffsetApplications(
    chargebackId: string,
  ): Promise<BookChargebackOffsetApplicationRecord[]> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT * FROM book_chargeback_offset_applications
         WHERE chargeback_id = ?
         ORDER BY offset_before_cents ASC`,
        )
        .all(chargebackId) as BookChargebackOffsetApplicationRecord[],
    );
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

  // --- Spatial POS + occupancy royalties + zone allocation (migration 0040) ---

  async upsertSpatialOccupancyTierSchedule(
    row: Omit<SpatialOccupancyTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOccupancyTierScheduleRecord> {
    // UNIQUE per (venue_id, year) — a re-registration converges (the
    // newest schedule governs the next walk); the id never rides the
    // conflict payload (the id rotates on conflict — the PR 33 lesson).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_occupancy_tier_schedules
           (id, venue_id, year, basis, bands, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, year) DO UPDATE SET
           basis = excluded.basis,
           bands = excluded.bands,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.venue_id,
        record.year,
        record.basis,
        record.bands,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialOccupancyTierSchedule(
      record.venue_id,
      record.year,
    ) as Promise<SpatialOccupancyTierScheduleRecord>;
  }

  async getSpatialOccupancyTierSchedule(
    venueId: string,
    year: string,
  ): Promise<SpatialOccupancyTierScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_occupancy_tier_schedules WHERE venue_id = ? AND year = ?`)
      .get(venueId, year) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      venue_id: row.venue_id as string,
      year: row.year as string,
      basis: row.basis as SpatialOccupancyTierScheduleRecord['basis'],
      bands: row.bands as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSpatialOverheadPolicy(
    row: Omit<SpatialOverheadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOverheadPolicyRecord> {
    // UNIQUE per (venue_id, year) — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_overhead_policies
           (id, venue_id, year, security_bps, wristband_maintenance_bps,
            ticketing_platform_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, year) DO UPDATE SET
           security_bps = excluded.security_bps,
           wristband_maintenance_bps = excluded.wristband_maintenance_bps,
           ticketing_platform_bps = excluded.ticketing_platform_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.venue_id,
        record.year,
        record.security_bps,
        record.wristband_maintenance_bps,
        record.ticketing_platform_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialOverheadPolicy(
      record.venue_id,
      record.year,
    ) as Promise<SpatialOverheadPolicyRecord>;
  }

  async getSpatialOverheadPolicy(
    venueId: string,
    year: string,
  ): Promise<SpatialOverheadPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_overhead_policies WHERE venue_id = ? AND year = ?`)
      .get(venueId, year) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      venue_id: row.venue_id as string,
      year: row.year as string,
      security_bps: row.security_bps as number,
      wristband_maintenance_bps: row.wristband_maintenance_bps as number,
      ticketing_platform_bps: row.ticketing_platform_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSpatialZoneAssignment(
    row: Omit<SpatialZoneAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialZoneAssignmentRecord> {
    // UNIQUE per (venue_id, zone_code) — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_zone_assignments
           (id, venue_id, zone_code, assigned_ip_owner_id, royalty_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, zone_code) DO UPDATE SET
           assigned_ip_owner_id = excluded.assigned_ip_owner_id,
           royalty_bps = excluded.royalty_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.venue_id,
        record.zone_code,
        record.assigned_ip_owner_id,
        record.royalty_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialZoneAssignment(
      record.venue_id,
      record.zone_code,
    ) as Promise<SpatialZoneAssignmentRecord>;
  }

  async getSpatialZoneAssignment(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialZoneAssignmentRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_zone_assignments WHERE venue_id = ? AND zone_code = ?`)
      .get(venueId, zoneCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      assigned_ip_owner_id: row.assigned_ip_owner_id as string,
      royalty_bps: row.royalty_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSpatialMicroPolicy(
    row: Omit<SpatialMicroPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMicroPolicyRecord> {
    // UNIQUE per (venue_id, zone_code) — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_micro_policies
           (id, venue_id, zone_code, micros_per_dwell_minute, micros_per_ride_session,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, zone_code) DO UPDATE SET
           micros_per_dwell_minute = excluded.micros_per_dwell_minute,
           micros_per_ride_session = excluded.micros_per_ride_session,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.venue_id,
        record.zone_code,
        record.micros_per_dwell_minute,
        record.micros_per_ride_session,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialMicroPolicy(
      record.venue_id,
      record.zone_code,
    ) as Promise<SpatialMicroPolicyRecord>;
  }

  async getSpatialMicroPolicy(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialMicroPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_micro_policies WHERE venue_id = ? AND zone_code = ?`)
      .get(venueId, zoneCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      micros_per_dwell_minute: row.micros_per_dwell_minute as number,
      micros_per_ride_session: row.micros_per_ride_session as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceSpatialThroughputYear(
    venueId: string,
    year: string,
    entriesAdded: number,
  ): Promise<SpatialThroughputYearRecord> {
    // UNIQUE per (venue_id, year) — the tracker converges: the conflict
    // arm ADDS the row's entries to the standing position, never a second
    // row for the same venue-year.
    const record = {
      id: randomUUID(),
      venue_id: venueId,
      year,
      cumulative_entries: entriesAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_throughput_years
           (id, venue_id, year, cumulative_entries, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, year) DO UPDATE SET
           cumulative_entries = cumulative_entries + excluded.cumulative_entries,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.venue_id,
        record.year,
        record.cumulative_entries,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialThroughputYear(
      record.venue_id,
      record.year,
    ) as Promise<SpatialThroughputYearRecord>;
  }

  async getSpatialThroughputYear(
    venueId: string,
    year: string,
  ): Promise<SpatialThroughputYearRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_throughput_years WHERE venue_id = ? AND year = ?`)
      .get(venueId, year) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      venue_id: row.venue_id as string,
      year: row.year as string,
      cumulative_entries: row.cumulative_entries as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSpatialRoyaltyApplication(
    row: Omit<SpatialRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked event
    // throws here, never a double royalty.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_royalty_applications
           (id, source_event_id, sender, venue_id, zone_code, spatial_footprint_sqft,
            period, ticket_revenue_cents, merch_revenue_cents, gross_revenue_cents,
            occupancy_tax_cents, infrastructure_cogs_cents, group_tour_discount_cents,
            net_spatial_licensed_revenue_cents, overhead_security_cents,
            overhead_wristband_cents, overhead_ticketing_cents, overhead_total_cents,
            royalty_basis_cents, tier_basis, tier_schedule_ref, tier_legs,
            entries_count, entries_before, entries_after, occupancy_royalty_cents,
            verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sender,
        record.venue_id,
        record.zone_code,
        record.spatial_footprint_sqft,
        record.period,
        record.ticket_revenue_cents,
        record.merch_revenue_cents,
        record.gross_revenue_cents,
        record.occupancy_tax_cents,
        record.infrastructure_cogs_cents,
        record.group_tour_discount_cents,
        record.net_spatial_licensed_revenue_cents,
        record.overhead_security_cents,
        record.overhead_wristband_cents,
        record.overhead_ticketing_cents,
        record.overhead_total_cents,
        record.royalty_basis_cents,
        record.tier_basis,
        record.tier_schedule_ref,
        record.tier_legs,
        record.entries_count,
        record.entries_before,
        record.entries_after,
        record.occupancy_royalty_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getSpatialRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SpatialRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_royalty_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as SpatialRoyaltyApplicationRecord['sender'],
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      spatial_footprint_sqft: row.spatial_footprint_sqft as number,
      period: row.period as string,
      ticket_revenue_cents: row.ticket_revenue_cents as number,
      merch_revenue_cents: row.merch_revenue_cents as number,
      gross_revenue_cents: row.gross_revenue_cents as number,
      occupancy_tax_cents: row.occupancy_tax_cents as number,
      infrastructure_cogs_cents: row.infrastructure_cogs_cents as number,
      group_tour_discount_cents: row.group_tour_discount_cents as number,
      net_spatial_licensed_revenue_cents: row.net_spatial_licensed_revenue_cents as number,
      overhead_security_cents: row.overhead_security_cents as number,
      overhead_wristband_cents: row.overhead_wristband_cents as number,
      overhead_ticketing_cents: row.overhead_ticketing_cents as number,
      overhead_total_cents: row.overhead_total_cents as number,
      royalty_basis_cents: row.royalty_basis_cents as number,
      tier_basis: row.tier_basis as SpatialRoyaltyApplicationRecord['tier_basis'],
      tier_schedule_ref: (row.tier_schedule_ref as string | null) ?? null,
      tier_legs: row.tier_legs as string,
      entries_count: row.entries_count as number,
      entries_before: (row.entries_before as number | null) ?? null,
      entries_after: (row.entries_after as number | null) ?? null,
      occupancy_royalty_cents: row.occupancy_royalty_cents as number,
      verdict: row.verdict as SpatialRoyaltyApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertSpatialZoneAllocation(
    row: Omit<SpatialZoneAllocationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialZoneAllocationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked sale
    // throws here, never a double allocation.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_zone_allocations
           (id, source_event_id, row_class, venue_id, zone_code, period, gross_cents,
            overhead_security_cents, overhead_wristband_cents, overhead_ticketing_cents,
            overhead_total_cents, allocated_basis_cents, assigned_ip_owner_id,
            royalty_bps, royalty_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.row_class,
        record.venue_id,
        record.zone_code,
        record.period,
        record.gross_cents,
        record.overhead_security_cents,
        record.overhead_wristband_cents,
        record.overhead_ticketing_cents,
        record.overhead_total_cents,
        record.allocated_basis_cents,
        record.assigned_ip_owner_id,
        record.royalty_bps,
        record.royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getSpatialZoneAllocation(
    sourceEventId: string,
  ): Promise<SpatialZoneAllocationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_zone_allocations WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      row_class: row.row_class as SpatialZoneAllocationRecord['row_class'],
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      period: row.period as string,
      gross_cents: row.gross_cents as number,
      overhead_security_cents: row.overhead_security_cents as number,
      overhead_wristband_cents: row.overhead_wristband_cents as number,
      overhead_ticketing_cents: row.overhead_ticketing_cents as number,
      overhead_total_cents: row.overhead_total_cents as number,
      allocated_basis_cents: row.allocated_basis_cents as number,
      assigned_ip_owner_id: row.assigned_ip_owner_id as string,
      royalty_bps: row.royalty_bps as number,
      royalty_cents: row.royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertSpatialMicroRoyalty(
    row: Omit<SpatialMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<SpatialMicroRoyaltyRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked
    // telemetry event throws here, never a double micro-payout.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_micro_royalty_ledger
           (id, source_event_id, venue_id, zone_code, wristband_id, sensor_id, period,
            dwell_minutes, ride_sessions, micros_per_dwell_minute, micros_per_ride_session,
            dwell_royalty_micros, session_royalty_micros, total_royalty_micros,
            royalty_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.venue_id,
        record.zone_code,
        record.wristband_id,
        record.sensor_id,
        record.period,
        record.dwell_minutes,
        record.ride_sessions,
        record.micros_per_dwell_minute,
        record.micros_per_ride_session,
        record.dwell_royalty_micros,
        record.session_royalty_micros,
        record.total_royalty_micros,
        record.royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getSpatialMicroRoyalty(
    sourceEventId: string,
  ): Promise<SpatialMicroRoyaltyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_micro_royalty_ledger WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      wristband_id: row.wristband_id as string,
      sensor_id: row.sensor_id as string,
      period: row.period as string,
      dwell_minutes: row.dwell_minutes as number,
      ride_sessions: row.ride_sessions as number,
      micros_per_dwell_minute: row.micros_per_dwell_minute as number,
      micros_per_ride_session: row.micros_per_ride_session as number,
      dwell_royalty_micros: row.dwell_royalty_micros as number,
      session_royalty_micros: row.session_royalty_micros as number,
      total_royalty_micros: row.total_royalty_micros as number,
      royalty_cents: row.royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  // -----------------------------------------------------------------
  // PR 37 — spatial commitments (migration 0041).
  // -----------------------------------------------------------------

  async upsertSpatialCapexCommitment(
    row: Omit<SpatialCapexCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialCapexCommitmentRecord> {
    // UNIQUE per (scope_key, capex_ref) — a re-registered commitment
    // converges (the newest registered cost governs the next walk).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_capex_commitments
           (id, scope_key, capex_ref, operator_id, capex_category,
            capex_amount_cents, recouped_cents, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_key, capex_ref) DO UPDATE SET
           operator_id = excluded.operator_id,
           capex_category = excluded.capex_category,
           capex_amount_cents = excluded.capex_amount_cents,
           recouped_cents = excluded.recouped_cents,
           currency = excluded.currency,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.capex_ref,
        record.operator_id,
        record.capex_category,
        record.capex_amount_cents,
        record.recouped_cents,
        record.currency,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialCapexCommitment(record.scope_key, record.capex_ref) as Promise<
      SpatialCapexCommitmentRecord
    >;
  }

  async getSpatialCapexCommitment(
    scopeKey: string,
    capexRef: string,
  ): Promise<SpatialCapexCommitmentRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM spatial_capex_commitments WHERE scope_key = ? AND capex_ref = ?`,
      )
      .get(scopeKey, capexRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      capex_ref: row.capex_ref as string,
      operator_id: row.operator_id as string,
      capex_category: row.capex_category as SpatialCapexCommitmentRecord['capex_category'],
      capex_amount_cents: Number(row.capex_amount_cents),
      recouped_cents: Number(row.recouped_cents),
      currency: row.currency as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async listSpatialCapexCommitments(
    scopeKey: string,
  ): Promise<SpatialCapexCommitmentRecord[]> {
    // created_at ASC — the offset walk's OLDEST-FIRST input.
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_capex_commitments WHERE scope_key = ? ORDER BY created_at ASC`,
      )
      .all(scopeKey) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      scope_key: row.scope_key as string,
      capex_ref: row.capex_ref as string,
      operator_id: row.operator_id as string,
      capex_category: row.capex_category as SpatialCapexCommitmentRecord['capex_category'],
      capex_amount_cents: Number(row.capex_amount_cents),
      recouped_cents: Number(row.recouped_cents),
      currency: row.currency as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async insertSpatialCapexApplication(
    row: Omit<SpatialCapexApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialCapexApplicationRecord> {
    // UNIQUE per (commitment_id, source_event_id) is the replay guard and
    // UNIQUE per (commitment_id, offset_before_cents) is the position
    // lock — a replayed royalty or a lost race throws here, never a
    // double offset; the caller re-derives from the append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_capex_applications
           (id, commitment_id, scope_key, capex_category, source_event_id,
            royalty_stream, royalty_cents, offset_before_cents, offset_cents,
            offset_after_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.commitment_id,
        record.scope_key,
        record.capex_category,
        record.source_event_id,
        record.royalty_stream,
        record.royalty_cents,
        record.offset_before_cents,
        record.offset_cents,
        record.offset_after_cents,
        record.created_at,
      );
    return record;
  }

  async listSpatialCapexApplications(
    commitmentId: string,
  ): Promise<SpatialCapexApplicationRecord[]> {
    // created_at ASC — the amortization schedule of record.
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_capex_applications WHERE commitment_id = ? ORDER BY created_at ASC`,
      )
      .all(commitmentId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      commitment_id: row.commitment_id as string,
      scope_key: row.scope_key as string,
      capex_category: row.capex_category as SpatialCapexApplicationRecord['capex_category'],
      source_event_id: row.source_event_id as string,
      royalty_stream: row.royalty_stream as SpatialCapexApplicationRecord['royalty_stream'],
      royalty_cents: Number(row.royalty_cents),
      offset_before_cents: Number(row.offset_before_cents),
      offset_cents: Number(row.offset_cents),
      offset_after_cents: Number(row.offset_after_cents),
      created_at: row.created_at as string,
    }));
  }

  async upsertSpatialMsgCommitment(
    row: Omit<SpatialMsgCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgCommitmentRecord> {
    // UNIQUE per scope_key — a re-registered guarantee converges (the
    // newest priced terms govern the next close).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_msg_commitments
           (id, scope_key, operator_id, operator_name, venue_id,
            reserved_footprint_sqft, quarterly_rate_micros_per_sqft,
            currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           operator_id = excluded.operator_id,
           operator_name = excluded.operator_name,
           venue_id = excluded.venue_id,
           reserved_footprint_sqft = excluded.reserved_footprint_sqft,
           quarterly_rate_micros_per_sqft = excluded.quarterly_rate_micros_per_sqft,
           currency = excluded.currency,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.operator_id,
        record.operator_name,
        record.venue_id,
        record.reserved_footprint_sqft,
        record.quarterly_rate_micros_per_sqft,
        record.currency,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialMsgCommitment(record.scope_key) as Promise<SpatialMsgCommitmentRecord>;
  }

  async getSpatialMsgCommitment(
    scopeKey: string,
  ): Promise<SpatialMsgCommitmentRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_msg_commitments WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      operator_id: row.operator_id as string,
      operator_name: row.operator_name as string,
      venue_id: row.venue_id as string,
      reserved_footprint_sqft: Number(row.reserved_footprint_sqft),
      quarterly_rate_micros_per_sqft: Number(row.quarterly_rate_micros_per_sqft),
      currency: row.currency as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSpatialMsgTermClose(
    row: Omit<SpatialMsgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgTermCloseRecord> {
    // UNIQUE per (commitment_id, quarter) — the once-only close; a
    // replay converges on the recorded shortfall and invoice of record.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_msg_term_closes
           (id, commitment_id, scope_key, quarter, msg_due_cents,
            earned_at_close_cents, shortfall_cents, invoice_ledger_id,
            closed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (commitment_id, quarter) DO UPDATE SET
           msg_due_cents = excluded.msg_due_cents,
           earned_at_close_cents = excluded.earned_at_close_cents,
           shortfall_cents = excluded.shortfall_cents,
           invoice_ledger_id = excluded.invoice_ledger_id,
           closed_by = excluded.closed_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.commitment_id,
        record.scope_key,
        record.quarter,
        record.msg_due_cents,
        record.earned_at_close_cents,
        record.shortfall_cents,
        record.invoice_ledger_id,
        record.closed_by,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialMsgTermClose(record.commitment_id, record.quarter) as Promise<
      SpatialMsgTermCloseRecord
    >;
  }

  async getSpatialMsgTermClose(
    commitmentId: string,
    quarter: string,
  ): Promise<SpatialMsgTermCloseRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM spatial_msg_term_closes WHERE commitment_id = ? AND quarter = ?`,
      )
      .get(commitmentId, quarter) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      commitment_id: row.commitment_id as string,
      scope_key: row.scope_key as string,
      quarter: row.quarter as string,
      msg_due_cents: Number(row.msg_due_cents),
      earned_at_close_cents: Number(row.earned_at_close_cents),
      shortfall_cents: Number(row.shortfall_cents),
      invoice_ledger_id: (row.invoice_ledger_id as string | null) ?? null,
      closed_by: row.closed_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async listSpatialRoyaltyApplicationsByVenue(
    venueId: string,
  ): Promise<SpatialRoyaltyApplicationRecord[]> {
    // created_at ASC — the append-only royalty truth the MSG close sums.
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_royalty_applications WHERE venue_id = ? ORDER BY created_at ASC`,
      )
      .all(venueId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as SpatialRoyaltyApplicationRecord['sender'],
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      spatial_footprint_sqft: Number(row.spatial_footprint_sqft),
      period: row.period as string,
      ticket_revenue_cents: Number(row.ticket_revenue_cents),
      merch_revenue_cents: Number(row.merch_revenue_cents),
      gross_revenue_cents: Number(row.gross_revenue_cents),
      occupancy_tax_cents: Number(row.occupancy_tax_cents),
      infrastructure_cogs_cents: Number(row.infrastructure_cogs_cents),
      group_tour_discount_cents: Number(row.group_tour_discount_cents),
      net_spatial_licensed_revenue_cents: Number(row.net_spatial_licensed_revenue_cents),
      overhead_security_cents: Number(row.overhead_security_cents),
      overhead_wristband_cents: Number(row.overhead_wristband_cents),
      overhead_ticketing_cents: Number(row.overhead_ticketing_cents),
      overhead_total_cents: Number(row.overhead_total_cents),
      royalty_basis_cents: Number(row.royalty_basis_cents),
      tier_basis: row.tier_basis as SpatialRoyaltyApplicationRecord['tier_basis'],
      tier_schedule_ref: (row.tier_schedule_ref as string | null) ?? null,
      tier_legs: row.tier_legs as string,
      entries_count: Number(row.entries_count),
      entries_before: (row.entries_before as number | null) ?? null,
      entries_after: (row.entries_after as number | null) ?? null,
      occupancy_royalty_cents: Number(row.occupancy_royalty_cents),
      verdict: row.verdict as SpatialRoyaltyApplicationRecord['verdict'],
      created_at: row.created_at as string,
    }));
  }

  async listSpatialZoneAllocationsByVenue(
    venueId: string,
  ): Promise<SpatialZoneAllocationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_zone_allocations WHERE venue_id = ? ORDER BY created_at ASC`,
      )
      .all(venueId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      row_class: row.row_class as SpatialZoneAllocationRecord['row_class'],
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      period: row.period as string,
      gross_cents: Number(row.gross_cents),
      overhead_security_cents: Number(row.overhead_security_cents),
      overhead_wristband_cents: Number(row.overhead_wristband_cents),
      overhead_ticketing_cents: Number(row.overhead_ticketing_cents),
      overhead_total_cents: Number(row.overhead_total_cents),
      allocated_basis_cents: Number(row.allocated_basis_cents),
      assigned_ip_owner_id: row.assigned_ip_owner_id as string,
      royalty_bps: Number(row.royalty_bps),
      royalty_cents: Number(row.royalty_cents),
      created_at: row.created_at as string,
    }));
  }

  async listSpatialMicroRoyaltiesByVenue(venueId: string): Promise<SpatialMicroRoyaltyRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_micro_royalty_ledger WHERE venue_id = ? ORDER BY created_at ASC`,
      )
      .all(venueId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      wristband_id: row.wristband_id as string,
      sensor_id: row.sensor_id as string,
      period: row.period as string,
      dwell_minutes: Number(row.dwell_minutes),
      ride_sessions: Number(row.ride_sessions),
      micros_per_dwell_minute: Number(row.micros_per_dwell_minute),
      micros_per_ride_session: Number(row.micros_per_ride_session),
      dwell_royalty_micros: Number(row.dwell_royalty_micros),
      session_royalty_micros: Number(row.session_royalty_micros),
      total_royalty_micros: Number(row.total_royalty_micros),
      royalty_cents: Number(row.royalty_cents),
      created_at: row.created_at as string,
    }));
  }

  async insertSpatialPopupExperience(
    row: Omit<SpatialPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPopupExperienceRecord> {
    // Insert-as-lock — UNIQUE per popup_ref: the FIRST registration
    // wins; a re-shipped sheet or a lost race throws here.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_popup_experiences
           (id, popup_ref, venue_id, zone_code, operator_id, experience_kind,
            window_start_date, window_end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.popup_ref,
        record.venue_id,
        record.zone_code,
        record.operator_id,
        record.experience_kind,
        record.window_start_date,
        record.window_end_date,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  async getSpatialPopupExperience(
    popupRef: string,
  ): Promise<SpatialPopupExperienceRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_popup_experiences WHERE popup_ref = ?`)
      .get(popupRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      popup_ref: row.popup_ref as string,
      venue_id: row.venue_id as string,
      zone_code: row.zone_code as string,
      operator_id: row.operator_id as string,
      experience_kind: row.experience_kind as string,
      window_start_date: row.window_start_date as string,
      window_end_date: row.window_end_date as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSpatialPopupWriteoff(
    row: Omit<SpatialPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupWriteoffRecord> {
    // UNIQUE per (popup_experience_id, source_event_id) — a replayed
    // calculation throws, never a double-priced write-off.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_popup_writeoffs
           (id, popup_experience_id, popup_ref, source_event_id, unsold_units,
            unit_cost_cents, writeoff_cents, evidence_ref, calculated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.popup_experience_id,
        record.popup_ref,
        record.source_event_id,
        record.unsold_units,
        record.unit_cost_cents,
        record.writeoff_cents,
        record.evidence_ref,
        record.calculated_by,
        record.created_at,
      );
    return record;
  }

  async listSpatialPopupWriteoffs(
    popupExperienceId: string,
  ): Promise<SpatialPopupWriteoffRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_popup_writeoffs WHERE popup_experience_id = ? ORDER BY created_at ASC`,
      )
      .all(popupExperienceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      popup_experience_id: row.popup_experience_id as string,
      popup_ref: row.popup_ref as string,
      source_event_id: row.source_event_id as string,
      unsold_units: Number(row.unsold_units),
      unit_cost_cents: Number(row.unit_cost_cents),
      writeoff_cents: Number(row.writeoff_cents),
      evidence_ref: row.evidence_ref as string,
      calculated_by: row.calculated_by as string,
      created_at: row.created_at as string,
    }));
  }

  async insertSpatialPopupRestorationReserve(
    row: Omit<SpatialPopupRestorationReserveRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupRestorationReserveRecord> {
    // Insert-as-lock — UNIQUE per popup_experience_id: the FIRST reserve
    // wins; a concurrent second insert throws here.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_popup_restoration_reserves
           (id, popup_experience_id, popup_ref, reserve_cents, evidence_ref,
            funded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.popup_experience_id,
        record.popup_ref,
        record.reserve_cents,
        record.evidence_ref,
        record.funded_by,
        record.created_at,
      );
    return record;
  }

  async getSpatialPopupRestorationReserve(
    popupExperienceId: string,
  ): Promise<SpatialPopupRestorationReserveRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM spatial_popup_restoration_reserves WHERE popup_experience_id = ?`,
      )
      .get(popupExperienceId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      popup_experience_id: row.popup_experience_id as string,
      popup_ref: row.popup_ref as string,
      reserve_cents: Number(row.reserve_cents),
      evidence_ref: row.evidence_ref as string,
      funded_by: row.funded_by as string,
      created_at: row.created_at as string,
    };
  }

  async upsertSpatialAuditEscrowPolicy(
    row: Omit<SpatialAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(record.id, record.scope_key, record.reserve_rate_bps, record.created_at, record.updated_at);
    return this.getSpatialAuditEscrowPolicy(record.scope_key) as Promise<SpatialAuditEscrowPolicyRecord>;
  }

  async getSpatialAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<SpatialAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM spatial_audit_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: Number(row.reserve_rate_bps),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSpatialAuditEscrowDrawdown(
    row: Omit<SpatialAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listSpatialAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique position column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM spatial_audit_escrow_drawdowns WHERE reserve_ledger_id = ? ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class: row.drawdown_class as SpatialAuditEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: Number(row.drawn_before_cents),
      drawn_cents: Number(row.drawn_cents),
      remaining_cents: Number(row.remaining_cents),
      created_at: row.created_at as string,
    }));
  }

  async insertSpatialAuditEscrowReconciliation(
    row: Omit<SpatialAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.reserve_ledger_id, record.evidence_ref, record.reconciled_by, record.created_at);
    return record;
  }

  async getSpatialAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM spatial_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`,
      )
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settleSpatialAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the licensing reserve settle rides: only the caller
    // whose WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'spatial_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertSpatialPayoutGateState(
    row: Omit<SpatialPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPayoutGateStateRecord> {
    // UNIQUE per (payee_id, venue_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO spatial_payout_gate_states
           (id, payee_id, venue_id, territorial_zoning_state, spatial_audit_state,
            evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, venue_id) DO UPDATE SET
           territorial_zoning_state = excluded.territorial_zoning_state,
           spatial_audit_state = excluded.spatial_audit_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.venue_id,
        record.territorial_zoning_state,
        record.spatial_audit_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getSpatialPayoutGateState(record.payee_id, record.venue_id) as Promise<
      SpatialPayoutGateStateRecord
    >;
  }

  async getSpatialPayoutGateState(
    payeeId: string,
    venueId: string,
  ): Promise<SpatialPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM spatial_payout_gate_states WHERE payee_id = ? AND venue_id = ?`,
      )
      .get(payeeId, venueId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      venue_id: row.venue_id as string,
      territorial_zoning_state:
        row.territorial_zoning_state as SpatialPayoutGateStateRecord['territorial_zoning_state'],
      spatial_audit_state:
        row.spatial_audit_state as SpatialPayoutGateStateRecord['spatial_audit_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  // ---------------------------------------------------------------------------
  // PR 38 — the fitness lane (migration 0042). Policies and trackers upsert
  // on their identities; the ledgers are append-only — a UNIQUE
  // source_event_id replay conflict throws, never a double application.
  // ---------------------------------------------------------------------------

  async upsertFitnessTrainerTierSchedule(
    row: Omit<FitnessTrainerTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessTrainerTierScheduleRecord> {
    // UNIQUE per (trainer_id, program_id) — the newest schedule governs the
    // next walk; the id never rides the conflict payload (the id rotates on
    // conflict — the PR 33 lesson).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_trainer_tier_schedules
           (id, trainer_id, program_id, bands, retention_bonus_micros_per_completion,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (trainer_id, program_id) DO UPDATE SET
           bands = excluded.bands,
           retention_bonus_micros_per_completion = excluded.retention_bonus_micros_per_completion,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.trainer_id,
        record.program_id,
        record.bands,
        record.retention_bonus_micros_per_completion,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessTrainerTierSchedule(record.trainer_id, record.program_id) as Promise<
      FitnessTrainerTierScheduleRecord
    >;
  }

  async getFitnessTrainerTierSchedule(
    trainerId: string,
    programId: string,
  ): Promise<FitnessTrainerTierScheduleRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM fitness_trainer_tier_schedules WHERE trainer_id = ? AND program_id = ?`,
      )
      .get(trainerId, programId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      bands: row.bands as string,
      retention_bonus_micros_per_completion:
        row.retention_bonus_micros_per_completion as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessSyncMusicPolicy(
    row: Omit<FitnessSyncMusicPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessSyncMusicPolicyRecord> {
    // UNIQUE per program_id — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_sync_music_policies
           (id, program_id, master_royalty_micros_per_workout,
            publishing_royalty_micros_per_workout, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (program_id) DO UPDATE SET
           master_royalty_micros_per_workout = excluded.master_royalty_micros_per_workout,
           publishing_royalty_micros_per_workout = excluded.publishing_royalty_micros_per_workout,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.program_id,
        record.master_royalty_micros_per_workout,
        record.publishing_royalty_micros_per_workout,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessSyncMusicPolicy(record.program_id) as Promise<FitnessSyncMusicPolicyRecord>;
  }

  async getFitnessSyncMusicPolicy(
    programId: string,
  ): Promise<FitnessSyncMusicPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_sync_music_policies WHERE program_id = ?`)
      .get(programId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      program_id: row.program_id as string,
      master_royalty_micros_per_workout:
        row.master_royalty_micros_per_workout as number,
      publishing_royalty_micros_per_workout:
        row.publishing_royalty_micros_per_workout as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessLiveLoadPolicy(
    row: Omit<FitnessLiveLoadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveLoadPolicyRecord> {
    // UNIQUE per program_id — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_live_load_policies
           (id, program_id, bands, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (program_id) DO UPDATE SET
           bands = excluded.bands,
           updated_at = excluded.updated_at`,
      )
      .run(record.id, record.program_id, record.bands, record.created_at, record.updated_at);
    return this.getFitnessLiveLoadPolicy(record.program_id) as Promise<FitnessLiveLoadPolicyRecord>;
  }

  async getFitnessLiveLoadPolicy(
    programId: string,
  ): Promise<FitnessLiveLoadPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_live_load_policies WHERE program_id = ?`)
      .get(programId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      program_id: row.program_id as string,
      bands: row.bands as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessFranchisePolicy(
    row: Omit<FitnessFranchisePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessFranchisePolicyRecord> {
    // UNIQUE per studio_franchise_code — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_franchise_policies
           (id, studio_franchise_code, franchise_license_override_bps, network_fee_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (studio_franchise_code) DO UPDATE SET
           franchise_license_override_bps = excluded.franchise_license_override_bps,
           network_fee_bps = excluded.network_fee_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.studio_franchise_code,
        record.franchise_license_override_bps,
        record.network_fee_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessFranchisePolicy(
      record.studio_franchise_code,
    ) as Promise<FitnessFranchisePolicyRecord>;
  }

  async getFitnessFranchisePolicy(
    studioFranchiseCode: string,
  ): Promise<FitnessFranchisePolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_franchise_policies WHERE studio_franchise_code = ?`)
      .get(studioFranchiseCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      franchise_license_override_bps: row.franchise_license_override_bps as number,
      network_fee_bps: row.network_fee_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessCoBrandPartnership(
    row: Omit<FitnessCoBrandPartnershipRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCoBrandPartnershipRecord> {
    // UNIQUE per studio_franchise_code — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_co_brand_partnerships
           (id, studio_franchise_code, ip_owner_id, distributor_id, ip_owner_share_bps,
            distributor_share_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (studio_franchise_code) DO UPDATE SET
           ip_owner_id = excluded.ip_owner_id,
           distributor_id = excluded.distributor_id,
           ip_owner_share_bps = excluded.ip_owner_share_bps,
           distributor_share_bps = excluded.distributor_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.studio_franchise_code,
        record.ip_owner_id,
        record.distributor_id,
        record.ip_owner_share_bps,
        record.distributor_share_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessCoBrandPartnership(
      record.studio_franchise_code,
    ) as Promise<FitnessCoBrandPartnershipRecord>;
  }

  async getFitnessCoBrandPartnership(
    studioFranchiseCode: string,
  ): Promise<FitnessCoBrandPartnershipRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_co_brand_partnerships WHERE studio_franchise_code = ?`)
      .get(studioFranchiseCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      ip_owner_id: row.ip_owner_id as string,
      distributor_id: row.distributor_id as string,
      ip_owner_share_bps: row.ip_owner_share_bps as number,
      distributor_share_bps: row.distributor_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessAlgorithmPolicy(
    row: Omit<FitnessAlgorithmPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAlgorithmPolicyRecord> {
    // UNIQUE per program_id — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_algorithm_policies
           (id, program_id, algorithm_creator_id, micros_per_active_user,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (program_id) DO UPDATE SET
           algorithm_creator_id = excluded.algorithm_creator_id,
           micros_per_active_user = excluded.micros_per_active_user,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.program_id,
        record.algorithm_creator_id,
        record.micros_per_active_user,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessAlgorithmPolicy(record.program_id) as Promise<FitnessAlgorithmPolicyRecord>;
  }

  async getFitnessAlgorithmPolicy(
    programId: string,
  ): Promise<FitnessAlgorithmPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_algorithm_policies WHERE program_id = ?`)
      .get(programId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      program_id: row.program_id as string,
      algorithm_creator_id: row.algorithm_creator_id as string,
      micros_per_active_user: row.micros_per_active_user as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessCocreationModule(
    row: Omit<FitnessCocreationModuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCocreationModuleRecord> {
    // UNIQUE per (program_id, module_id) — a re-registration converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_cocreation_modules
           (id, program_id, module_id, trainer_id, weight_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (program_id, module_id) DO UPDATE SET
           trainer_id = excluded.trainer_id,
           weight_bps = excluded.weight_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.program_id,
        record.module_id,
        record.trainer_id,
        record.weight_bps,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  async listFitnessCocreationModules(
    programId: string,
  ): Promise<FitnessCocreationModuleRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM fitness_cocreation_modules WHERE program_id = ? ORDER BY rowid`)
      .all(programId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      program_id: row.program_id as string,
      module_id: row.module_id as string,
      trainer_id: row.trainer_id as string,
      weight_bps: row.weight_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async advanceFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
    completionsAdded: number,
  ): Promise<FitnessCompletionMonthRecord> {
    // UNIQUE per (trainer_id, program_id, month) — the tracker converges
    // (the upsert ADDS the row's completions to the cumulative position).
    const record = {
      id: randomUUID(),
      trainer_id: trainerId,
      program_id: programId,
      month,
      cumulative_completions: completionsAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_completion_months
           (id, trainer_id, program_id, month, cumulative_completions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (trainer_id, program_id, month) DO UPDATE SET
           cumulative_completions = fitness_completion_months.cumulative_completions
             + excluded.cumulative_completions,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.trainer_id,
        record.program_id,
        record.month,
        record.cumulative_completions,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessCompletionMonth(trainerId, programId, month) as Promise<
      FitnessCompletionMonthRecord
    >;
  }

  async getFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
  ): Promise<FitnessCompletionMonthRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM fitness_completion_months
           WHERE trainer_id = ? AND program_id = ? AND month = ?`,
      )
      .get(trainerId, programId, month) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      month: row.month as string,
      cumulative_completions: row.cumulative_completions as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
    classesAdded: number,
  ): Promise<FitnessFranchiseClassMonthRecord> {
    // UNIQUE per (studio_franchise_code, month) — the tracker converges.
    const record = {
      id: randomUUID(),
      studio_franchise_code: studioFranchiseCode,
      month,
      cumulative_classes: classesAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_franchise_class_months
           (id, studio_franchise_code, month, cumulative_classes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (studio_franchise_code, month) DO UPDATE SET
           cumulative_classes = fitness_franchise_class_months.cumulative_classes
             + excluded.cumulative_classes,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.studio_franchise_code,
        record.month,
        record.cumulative_classes,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessFranchiseClassMonth(studioFranchiseCode, month) as Promise<
      FitnessFranchiseClassMonthRecord
    >;
  }

  async getFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
  ): Promise<FitnessFranchiseClassMonthRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM fitness_franchise_class_months
           WHERE studio_franchise_code = ? AND month = ?`,
      )
      .get(studioFranchiseCode, month) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      month: row.month as string,
      cumulative_classes: row.cumulative_classes as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertFitnessRealizationApplication(
    row: Omit<FitnessRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessRealizationApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked
    // allocation throws here, never a double application.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_realization_applications
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, gross_subscription_pool_cents, app_store_engine_cut_cents,
            digital_infrastructure_overhead_cents, net_fitness_content_pool_cents,
            verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.gross_subscription_pool_cents,
        record.app_store_engine_cut_cents,
        record.digital_infrastructure_overhead_cents,
        record.net_fitness_content_pool_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getFitnessRealizationApplication(
    sourceEventId: string,
  ): Promise<FitnessRealizationApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_realization_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_subscription_pool_cents: row.gross_subscription_pool_cents as number,
      app_store_engine_cut_cents: row.app_store_engine_cut_cents as number,
      digital_infrastructure_overhead_cents:
        row.digital_infrastructure_overhead_cents as number,
      net_fitness_content_pool_cents: row.net_fitness_content_pool_cents as number,
      verdict: row.verdict as FitnessRealizationApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertFitnessTrainerRoyaltyApplication(
    row: Omit<FitnessTrainerRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_trainer_royalty_applications
           (id, source_event_id, sender, trainer_id, program_id, studio_franchise_code,
            period, currency, completed_count, class_revenue_cents, sync_policy_ref,
            master_royalty_micros_per_workout, publishing_royalty_micros_per_workout,
            sync_master_micros, sync_publishing_micros, sync_master_cents,
            sync_publishing_cents, trainer_net_basis_cents, tier_schedule_ref,
            tier_legs, tier_payout_micros, tier_payout_cents, retained_count,
            retention_bonus_micros_per_completion, retention_bonus_micros,
            retention_bonus_cents, monthly_completions_before, monthly_completions_after,
            verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sender,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.completed_count,
        record.class_revenue_cents,
        record.sync_policy_ref,
        record.master_royalty_micros_per_workout,
        record.publishing_royalty_micros_per_workout,
        record.sync_master_micros,
        record.sync_publishing_micros,
        record.sync_master_cents,
        record.sync_publishing_cents,
        record.trainer_net_basis_cents,
        record.tier_schedule_ref,
        record.tier_legs,
        record.tier_payout_micros,
        record.tier_payout_cents,
        record.retained_count,
        record.retention_bonus_micros_per_completion,
        record.retention_bonus_micros,
        record.retention_bonus_cents,
        record.monthly_completions_before,
        record.monthly_completions_after,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getFitnessTrainerRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_trainer_royalty_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as FitnessTrainerRoyaltyApplicationRecord['sender'],
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      completed_count: row.completed_count as number,
      class_revenue_cents: row.class_revenue_cents as number,
      sync_policy_ref: (row.sync_policy_ref as string | null) ?? null,
      master_royalty_micros_per_workout:
        row.master_royalty_micros_per_workout as number,
      publishing_royalty_micros_per_workout:
        row.publishing_royalty_micros_per_workout as number,
      sync_master_micros: row.sync_master_micros as number,
      sync_publishing_micros: row.sync_publishing_micros as number,
      sync_master_cents: row.sync_master_cents as number,
      sync_publishing_cents: row.sync_publishing_cents as number,
      trainer_net_basis_cents: row.trainer_net_basis_cents as number,
      tier_schedule_ref: (row.tier_schedule_ref as string | null) ?? null,
      tier_legs: row.tier_legs as string,
      tier_payout_micros: row.tier_payout_micros as number,
      tier_payout_cents: row.tier_payout_cents as number,
      retained_count: row.retained_count as number,
      retention_bonus_micros_per_completion:
        row.retention_bonus_micros_per_completion as number,
      retention_bonus_micros: row.retention_bonus_micros as number,
      retention_bonus_cents: row.retention_bonus_cents as number,
      monthly_completions_before: (row.monthly_completions_before as number | null) ?? null,
      monthly_completions_after: (row.monthly_completions_after as number | null) ?? null,
      verdict: row.verdict as FitnessTrainerRoyaltyApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertFitnessLiveResidualApplication(
    row: Omit<FitnessLiveResidualApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveResidualApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_live_residual_applications
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, peak_simultaneous_viewers, live_event_revenue_cents,
            load_band_from, load_band_to, server_load_bps, server_load_deduction_cents,
            net_live_residual_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.peak_simultaneous_viewers,
        record.live_event_revenue_cents,
        record.load_band_from,
        record.load_band_to,
        record.server_load_bps,
        record.server_load_deduction_cents,
        record.net_live_residual_cents,
        record.created_at,
      );
    return record;
  }

  async getFitnessLiveResidualApplication(
    sourceEventId: string,
  ): Promise<FitnessLiveResidualApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_live_residual_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      peak_simultaneous_viewers: row.peak_simultaneous_viewers as number,
      live_event_revenue_cents: row.live_event_revenue_cents as number,
      load_band_from: row.load_band_from as number,
      load_band_to: (row.load_band_to as number | null) ?? null,
      server_load_bps: row.server_load_bps as number,
      server_load_deduction_cents: row.server_load_deduction_cents as number,
      net_live_residual_cents: row.net_live_residual_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertFitnessFranchiseApplication(
    row: Omit<FitnessFranchiseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessFranchiseApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_franchise_applications
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, class_count, classes_before, classes_after, class_revenue_cents,
            certified_choreography_revenue_cents, certified_audio_revenue_cents,
            franchise_license_override_bps, choreography_override_cents,
            audio_override_cents, franchise_override_total_cents, network_fee_bps,
            network_fee_cents, instructor_disbursement_cents, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.class_count,
        record.classes_before,
        record.classes_after,
        record.class_revenue_cents,
        record.certified_choreography_revenue_cents,
        record.certified_audio_revenue_cents,
        record.franchise_license_override_bps,
        record.choreography_override_cents,
        record.audio_override_cents,
        record.franchise_override_total_cents,
        record.network_fee_bps,
        record.network_fee_cents,
        record.instructor_disbursement_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getFitnessFranchiseApplication(
    sourceEventId: string,
  ): Promise<FitnessFranchiseApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_franchise_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      class_count: row.class_count as number,
      classes_before: (row.classes_before as number | null) ?? null,
      classes_after: (row.classes_after as number | null) ?? null,
      class_revenue_cents: row.class_revenue_cents as number,
      certified_choreography_revenue_cents:
        row.certified_choreography_revenue_cents as number,
      certified_audio_revenue_cents: row.certified_audio_revenue_cents as number,
      franchise_license_override_bps: row.franchise_license_override_bps as number,
      choreography_override_cents: row.choreography_override_cents as number,
      audio_override_cents: row.audio_override_cents as number,
      franchise_override_total_cents: row.franchise_override_total_cents as number,
      network_fee_bps: row.network_fee_bps as number,
      network_fee_cents: row.network_fee_cents as number,
      instructor_disbursement_cents: row.instructor_disbursement_cents as number,
      verdict: row.verdict as FitnessFranchiseApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertFitnessCobrandSplitApplication(
    row: Omit<FitnessCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCobrandSplitApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_cobrand_split_applications
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, ip_owner_id, distributor_id, net_class_stream_earnings_cents,
            ip_owner_share_bps, distributor_share_bps, ip_owner_cents,
            distributor_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.ip_owner_id,
        record.distributor_id,
        record.net_class_stream_earnings_cents,
        record.ip_owner_share_bps,
        record.distributor_share_bps,
        record.ip_owner_cents,
        record.distributor_cents,
        record.created_at,
      );
    return record;
  }

  async getFitnessCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FitnessCobrandSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_cobrand_split_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      ip_owner_id: row.ip_owner_id as string,
      distributor_id: row.distributor_id as string,
      net_class_stream_earnings_cents: row.net_class_stream_earnings_cents as number,
      ip_owner_share_bps: row.ip_owner_share_bps as number,
      distributor_share_bps: row.distributor_share_bps as number,
      ip_owner_cents: row.ip_owner_cents as number,
      distributor_cents: row.distributor_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertFitnessAlgorithmRoyalty(
    row: Omit<FitnessAlgorithmRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAlgorithmRoyaltyRecord> {
    // UNIQUE per source_event_id is the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_algorithm_royalty_ledger
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, equipment_type, equipment_id, wearable_active_users,
            algorithm_creator_id, micros_per_active_user, royalty_micros,
            royalty_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.equipment_type,
        record.equipment_id,
        record.wearable_active_users,
        record.algorithm_creator_id,
        record.micros_per_active_user,
        record.royalty_micros,
        record.royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getFitnessAlgorithmRoyalty(
    sourceEventId: string,
  ): Promise<FitnessAlgorithmRoyaltyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_algorithm_royalty_ledger WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      equipment_type: row.equipment_type as FitnessAlgorithmRoyaltyRecord['equipment_type'],
      equipment_id: row.equipment_id as string,
      wearable_active_users: row.wearable_active_users as number,
      algorithm_creator_id: row.algorithm_creator_id as string,
      micros_per_active_user: row.micros_per_active_user as number,
      royalty_micros: row.royalty_micros as number,
      royalty_cents: row.royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertFitnessCocreationApplication(
    row: Omit<FitnessCocreationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCocreationApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_cocreation_applications
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, enrollment_revenue_cents, waterfall_legs, allocated_total_cents,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.enrollment_revenue_cents,
        record.waterfall_legs,
        record.allocated_total_cents,
        record.created_at,
      );
    return record;
  }

  async getFitnessCocreationApplication(
    sourceEventId: string,
  ): Promise<FitnessCocreationApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_cocreation_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      enrollment_revenue_cents: row.enrollment_revenue_cents as number,
      waterfall_legs: row.waterfall_legs as string,
      allocated_total_cents: row.allocated_total_cents as number,
      created_at: row.created_at as string,
    };
  }

  // --- The fitness audit escrow + gate states + live-event bonuses (PR 39,
  // migration 0043) — the 0041 spatial twins' sqlite shape. ---

  async upsertFitnessAuditEscrowPolicy(
    row: Omit<FitnessAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.reserve_rate_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessAuditEscrowPolicy(record.scope_key) as Promise<
      FitnessAuditEscrowPolicyRecord
    >;
  }

  async getFitnessAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<FitnessAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_audit_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: row.reserve_rate_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertFitnessAuditEscrowDrawdown(
    row: Omit<FitnessAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listFitnessAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM fitness_audit_escrow_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class: row.drawdown_class as FitnessAuditEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: row.drawn_before_cents as number,
      drawn_cents: row.drawn_cents as number,
      remaining_cents: row.remaining_cents as number,
      created_at: row.created_at as string,
    }));
  }

  async insertFitnessAuditEscrowReconciliation(
    row: Omit<FitnessAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.evidence_ref,
        record.reconciled_by,
        record.created_at,
      );
    return record;
  }

  async getFitnessAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`)
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settleFitnessAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the spatial escrow settle rides: only the caller whose
    // WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'fitness_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertFitnessPayoutGateState(
    row: Omit<FitnessPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessPayoutGateStateRecord> {
    // UNIQUE per (payee_id, studio_franchise_code) — an upsert converges
    // (a verification heals 'unknown'; states never regress through this
    // table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_payout_gate_states
           (id, payee_id, studio_franchise_code, hipaa_gdpr_privacy_state,
            territorial_exclusivity_state, evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, studio_franchise_code) DO UPDATE SET
           hipaa_gdpr_privacy_state = excluded.hipaa_gdpr_privacy_state,
           territorial_exclusivity_state = excluded.territorial_exclusivity_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.studio_franchise_code,
        record.hipaa_gdpr_privacy_state,
        record.territorial_exclusivity_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getFitnessPayoutGateState(
      record.payee_id,
      record.studio_franchise_code,
    ) as Promise<FitnessPayoutGateStateRecord>;
  }

  async getFitnessPayoutGateState(
    payeeId: string,
    studioFranchiseCode: string,
  ): Promise<FitnessPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM fitness_payout_gate_states WHERE payee_id = ? AND studio_franchise_code = ?`,
      )
      .get(payeeId, studioFranchiseCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      hipaa_gdpr_privacy_state:
        row.hipaa_gdpr_privacy_state as FitnessPayoutGateStateRecord['hipaa_gdpr_privacy_state'],
      territorial_exclusivity_state:
        row.territorial_exclusivity_state as FitnessPayoutGateStateRecord['territorial_exclusivity_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertCulinaryAuditEscrowPolicy(
    row: Omit<CulinaryAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO culinary_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.reserve_rate_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getCulinaryAuditEscrowPolicy(record.scope_key) as Promise<
      CulinaryAuditEscrowPolicyRecord
    >;
  }

  async getCulinaryAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<CulinaryAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM culinary_audit_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: row.reserve_rate_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertCulinaryAuditEscrowDrawdown(
    row: Omit<CulinaryAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO culinary_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listCulinaryAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<CulinaryAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM culinary_audit_escrow_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class: row.drawdown_class as CulinaryAuditEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: row.drawn_before_cents as number,
      drawn_cents: row.drawn_cents as number,
      remaining_cents: row.remaining_cents as number,
      created_at: row.created_at as string,
    }));
  }

  async insertCulinaryAuditEscrowReconciliation(
    row: Omit<CulinaryAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO culinary_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.evidence_ref,
        record.reconciled_by,
        record.created_at,
      );
    return record;
  }

  async getCulinaryAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<CulinaryAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM culinary_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`)
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settleCulinaryAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the fitness escrow settle rides: only the caller whose
    // WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'culinary_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertCulinaryPayoutGateState(
    row: Omit<CulinaryPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryPayoutGateStateRecord> {
    // UNIQUE per (payee_id, ghost_kitchen_location_code) — an upsert
    // converges (a verification heals 'unknown'; states never regress
    // through this table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO culinary_payout_gate_states
           (id, payee_id, ghost_kitchen_location_code, health_inspection_state,
            territorial_exclusivity_state, evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, ghost_kitchen_location_code) DO UPDATE SET
           health_inspection_state = excluded.health_inspection_state,
           territorial_exclusivity_state = excluded.territorial_exclusivity_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.ghost_kitchen_location_code,
        record.health_inspection_state,
        record.territorial_exclusivity_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getCulinaryPayoutGateState(
      record.payee_id,
      record.ghost_kitchen_location_code,
    ) as Promise<CulinaryPayoutGateStateRecord>;
  }

  async getCulinaryPayoutGateState(
    payeeId: string,
    ghostKitchenLocationCode: string,
  ): Promise<CulinaryPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM culinary_payout_gate_states WHERE payee_id = ? AND ghost_kitchen_location_code = ?`,
      )
      .get(payeeId, ghostKitchenLocationCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      ghost_kitchen_location_code: row.ghost_kitchen_location_code as string,
      health_inspection_state:
        row.health_inspection_state as CulinaryPayoutGateStateRecord['health_inspection_state'],
      territorial_exclusivity_state:
        row.territorial_exclusivity_state as CulinaryPayoutGateStateRecord['territorial_exclusivity_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertCulinaryPopupExperience(
    row: Omit<CulinaryPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryPopupExperienceRecord> {
    // Insert-as-lock — UNIQUE per popup_ref: the FIRST registration
    // wins; a re-shipped sheet or a lost race throws here (the caller
    // reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO culinary_popup_experiences
           (id, popup_ref, chef_id, ghost_kitchen_location_code, menu_theme,
            window_start_date, window_end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.popup_ref,
        record.chef_id,
        record.ghost_kitchen_location_code,
        record.menu_theme,
        record.window_start_date,
        record.window_end_date,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  async getCulinaryPopupExperience(
    popupRef: string,
  ): Promise<CulinaryPopupExperienceRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM culinary_popup_experiences WHERE popup_ref = ?`)
      .get(popupRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      popup_ref: row.popup_ref as string,
      chef_id: row.chef_id as string,
      ghost_kitchen_location_code: row.ghost_kitchen_location_code as string,
      menu_theme: row.menu_theme as string,
      window_start_date: row.window_start_date as string,
      window_end_date: row.window_end_date as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertCulinaryPopupWriteoff(
    row: Omit<CulinaryPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryPopupWriteoffRecord> {
    // UNIQUE per (popup_experience_id, source_event_id) — a replayed
    // calculation throws, never a double-priced write-off.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO culinary_popup_writeoffs
           (id, popup_experience_id, source_event_id, unsold_packages,
            unit_cost_cents, writeoff_cents, evidence_ref, calculated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.popup_experience_id,
        record.source_event_id,
        record.unsold_packages,
        record.unit_cost_cents,
        record.writeoff_cents,
        record.evidence_ref,
        record.calculated_by,
        record.created_at,
      );
    return record;
  }

  async listCulinaryPopupWriteoffs(
    popupExperienceId: string,
  ): Promise<CulinaryPopupWriteoffRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM culinary_popup_writeoffs
         WHERE popup_experience_id = ?
         ORDER BY created_at ASC`,
      )
      .all(popupExperienceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      popup_experience_id: row.popup_experience_id as string,
      source_event_id: row.source_event_id as string,
      unsold_packages: row.unsold_packages as number,
      unit_cost_cents: row.unit_cost_cents as number,
      writeoff_cents: row.writeoff_cents as number,
      evidence_ref: row.evidence_ref as string,
      calculated_by: row.calculated_by as string,
      created_at: row.created_at as string,
    }));
  }

  async upsertServiceAuditEscrowPolicy(
    row: Omit<ServiceAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.reserve_rate_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getServiceAuditEscrowPolicy(record.scope_key) as Promise<
      ServiceAuditEscrowPolicyRecord
    >;
  }

  async getServiceAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<ServiceAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_audit_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: row.reserve_rate_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertServiceAuditEscrowDrawdown(
    row: Omit<ServiceAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<ServiceAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listServiceAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<ServiceAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM service_audit_escrow_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class: row.drawdown_class as ServiceAuditEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: row.drawn_before_cents as number,
      drawn_cents: row.drawn_cents as number,
      remaining_cents: row.remaining_cents as number,
      created_at: row.created_at as string,
    }));
  }

  async insertServiceAuditEscrowReconciliation(
    row: Omit<ServiceAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.evidence_ref,
        record.reconciled_by,
        record.created_at,
      );
    return record;
  }

  async getServiceAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<ServiceAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`)
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settleServiceAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the culinary escrow settle rides: only the caller whose
    // WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'service_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertServicesPayoutGateState(
    row: Omit<ServicesPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServicesPayoutGateStateRecord> {
    // UNIQUE per (payee_id, salon_location_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO services_payout_gate_states
           (id, payee_id, salon_location_id, health_license_state,
            territorial_exclusivity_state, evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, salon_location_id) DO UPDATE SET
           health_license_state = excluded.health_license_state,
           territorial_exclusivity_state = excluded.territorial_exclusivity_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.salon_location_id,
        record.health_license_state,
        record.territorial_exclusivity_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getServicesPayoutGateState(
      record.payee_id,
      record.salon_location_id,
    ) as Promise<ServicesPayoutGateStateRecord>;
  }

  async getServicesPayoutGateState(
    payeeId: string,
    salonLocationId: string,
  ): Promise<ServicesPayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM services_payout_gate_states WHERE payee_id = ? AND salon_location_id = ?`,
      )
      .get(payeeId, salonLocationId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      salon_location_id: row.salon_location_id as string,
      health_license_state:
        row.health_license_state as ServicesPayoutGateStateRecord['health_license_state'],
      territorial_exclusivity_state:
        row.territorial_exclusivity_state as ServicesPayoutGateStateRecord['territorial_exclusivity_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSoftwareAuditEscrowPolicy(
    row: Omit<SoftwareAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SoftwareAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO software_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.reserve_rate_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getSoftwareAuditEscrowPolicy(record.scope_key) as Promise<
      SoftwareAuditEscrowPolicyRecord
    >;
  }

  async getSoftwareAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<SoftwareAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM software_audit_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: row.reserve_rate_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSoftwareAuditEscrowDrawdown(
    row: Omit<SoftwareAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SoftwareAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO software_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listSoftwareAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<SoftwareAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM software_audit_escrow_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class: row.drawdown_class as SoftwareAuditEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: row.drawn_before_cents as number,
      drawn_cents: row.drawn_cents as number,
      remaining_cents: row.remaining_cents as number,
      created_at: row.created_at as string,
    }));
  }

  async insertSoftwareAuditEscrowReconciliation(
    row: Omit<SoftwareAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SoftwareAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO software_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.evidence_ref,
        record.reconciled_by,
        record.created_at,
      );
    return record;
  }

  async getSoftwareAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SoftwareAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM software_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`)
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settleSoftwareAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the culinary escrow settle rides: only the caller whose
    // WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'software_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertSoftwarePayoutGateState(
    row: Omit<SoftwarePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SoftwarePayoutGateStateRecord> {
    // UNIQUE per (payee_id, api_endpoint_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO software_payout_gate_states
           (id, payee_id, api_endpoint_id, api_uptime_sla_state,
            security_audit_state, evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, api_endpoint_id) DO UPDATE SET
           api_uptime_sla_state = excluded.api_uptime_sla_state,
           security_audit_state = excluded.security_audit_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.api_endpoint_id,
        record.api_uptime_sla_state,
        record.security_audit_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getSoftwarePayoutGateState(
      record.payee_id,
      record.api_endpoint_id,
    ) as Promise<SoftwarePayoutGateStateRecord>;
  }

  async getSoftwarePayoutGateState(
    payeeId: string,
    apiEndpointId: string,
  ): Promise<SoftwarePayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM software_payout_gate_states WHERE payee_id = ? AND api_endpoint_id = ?`,
      )
      .get(payeeId, apiEndpointId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      api_endpoint_id: row.api_endpoint_id as string,
      api_uptime_sla_state:
        row.api_uptime_sla_state as SoftwarePayoutGateStateRecord['api_uptime_sla_state'],
      security_audit_state:
        row.security_audit_state as SoftwarePayoutGateStateRecord['security_audit_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFitnessLiveEventBonusPolicy(
    row: Omit<FitnessLiveEventBonusPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveEventBonusPolicyRecord> {
    // UNIQUE per program_id — a re-registered policy converges (the
    // newest rate governs the next concluded event's posting).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_live_event_bonus_policies
           (id, program_id, bonus_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (program_id) DO UPDATE SET
           bonus_bps = excluded.bonus_bps,
           updated_at = excluded.updated_at`,
      )
      .run(record.id, record.program_id, record.bonus_bps, record.created_at, record.updated_at);
    return this.getFitnessLiveEventBonusPolicy(record.program_id) as Promise<
      FitnessLiveEventBonusPolicyRecord
    >;
  }

  async getFitnessLiveEventBonusPolicy(
    programId: string,
  ): Promise<FitnessLiveEventBonusPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_live_event_bonus_policies WHERE program_id = ?`)
      .get(programId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      program_id: row.program_id as string,
      bonus_bps: row.bonus_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertFitnessLiveEventBonus(
    row: Omit<FitnessLiveEventBonusRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveEventBonusRecord> {
    // UNIQUE per source_event_id — the replay guard: a replayed event
    // row throws here, never a double bonus; the caller re-derives from
    // the ledger of record.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO fitness_live_event_bonuses
           (id, source_event_id, trainer_id, program_id, studio_franchise_code, period,
            currency, peak_simultaneous_viewers, live_event_revenue_cents, bonus_bps,
            bonus_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.trainer_id,
        record.program_id,
        record.studio_franchise_code,
        record.period,
        record.currency,
        record.peak_simultaneous_viewers,
        record.live_event_revenue_cents,
        record.bonus_bps,
        record.bonus_cents,
        record.created_at,
      );
    return record;
  }

  async getFitnessLiveEventBonus(
    sourceEventId: string,
  ): Promise<FitnessLiveEventBonusRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM fitness_live_event_bonuses WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      trainer_id: row.trainer_id as string,
      program_id: row.program_id as string,
      studio_franchise_code: row.studio_franchise_code as string,
      period: row.period as string,
      currency: row.currency as string,
      peak_simultaneous_viewers: row.peak_simultaneous_viewers as number,
      live_event_revenue_cents: row.live_event_revenue_cents as number,
      bonus_bps: row.bonus_bps as number,
      bonus_cents: row.bonus_cents as number,
      created_at: row.created_at as string,
    };
  }

  // --- PR 40, migration 0044 — the food lane (the founder food directive) ---

  async upsertFoodRecipeRoyaltySchedule(
    row: Omit<FoodRecipeRoyaltyScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodRecipeRoyaltyScheduleRecord> {
    // UNIQUE per (chef_id, recipe_id) — a re-registered schedule replaces
    // the row atomically (the newest schedule governs the next walk).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_recipe_royalty_schedules
           (id, chef_id, recipe_id, unit_micros_bands, royalty_bps_bands,
            cpg_royalty_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chef_id, recipe_id) DO UPDATE SET
           unit_micros_bands = excluded.unit_micros_bands,
           royalty_bps_bands = excluded.royalty_bps_bands,
           cpg_royalty_bps = excluded.cpg_royalty_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.chef_id,
        record.recipe_id,
        record.unit_micros_bands,
        record.royalty_bps_bands,
        record.cpg_royalty_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getFoodRecipeRoyaltySchedule(record.chef_id, record.recipe_id) as Promise<
      FoodRecipeRoyaltyScheduleRecord
    >;
  }

  async getFoodRecipeRoyaltySchedule(
    chefId: string,
    recipeId: string,
  ): Promise<FoodRecipeRoyaltyScheduleRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM food_recipe_royalty_schedules WHERE chef_id = ? AND recipe_id = ?`,
      )
      .get(chefId, recipeId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      unit_micros_bands: row.unit_micros_bands as string,
      royalty_bps_bands: row.royalty_bps_bands as string,
      cpg_royalty_bps: row.cpg_royalty_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
    unitsAdded: number,
  ): Promise<FoodLocationUnitMonthRecord> {
    // UNIQUE per (ghost_kitchen_location_id, month) — the tracker
    // converges (the upsert ADDS the row's units to the cumulative
    // position).
    const record = {
      id: randomUUID(),
      ghost_kitchen_location_id: ghostKitchenLocationId,
      month,
      cumulative_units: unitsAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_location_unit_months
           (id, ghost_kitchen_location_id, month, cumulative_units, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ghost_kitchen_location_id, month) DO UPDATE SET
           cumulative_units = food_location_unit_months.cumulative_units
             + excluded.cumulative_units,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.ghost_kitchen_location_id,
        record.month,
        record.cumulative_units,
        record.created_at,
        record.updated_at,
      );
    return this.getFoodLocationUnitMonth(ghostKitchenLocationId, month) as Promise<
      FoodLocationUnitMonthRecord
    >;
  }

  async getFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
  ): Promise<FoodLocationUnitMonthRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM food_location_unit_months
           WHERE ghost_kitchen_location_id = ? AND month = ?`,
      )
      .get(ghostKitchenLocationId, month) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      month: row.month as string,
      cumulative_units: row.cumulative_units as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFoodHostOperatorPolicy(
    row: Omit<FoodHostOperatorPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodHostOperatorPolicyRecord> {
    // UNIQUE per ghost_kitchen_location_id — a re-registered policy
    // replaces the row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_host_operator_policies
           (id, ghost_kitchen_location_id, brand_licensor_id,
            brand_licensor_holdback_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ghost_kitchen_location_id) DO UPDATE SET
           brand_licensor_id = excluded.brand_licensor_id,
           brand_licensor_holdback_bps = excluded.brand_licensor_holdback_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.ghost_kitchen_location_id,
        record.brand_licensor_id,
        record.brand_licensor_holdback_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getFoodHostOperatorPolicy(record.ghost_kitchen_location_id) as Promise<
      FoodHostOperatorPolicyRecord
    >;
  }

  async getFoodHostOperatorPolicy(
    ghostKitchenLocationId: string,
  ): Promise<FoodHostOperatorPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM food_host_operator_policies WHERE ghost_kitchen_location_id = ?`,
      )
      .get(ghostKitchenLocationId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      brand_licensor_id: row.brand_licensor_id as string,
      brand_licensor_holdback_bps: row.brand_licensor_holdback_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFoodCookCyclePolicy(
    row: Omit<FoodCookCyclePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCookCyclePolicyRecord> {
    // UNIQUE per (chef_id, recipe_id) — a re-registered policy replaces
    // the row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_cook_cycle_policies
           (id, chef_id, recipe_id, payee_id, micros_per_cook_cycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chef_id, recipe_id) DO UPDATE SET
           payee_id = excluded.payee_id,
           micros_per_cook_cycle = excluded.micros_per_cook_cycle,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.chef_id,
        record.recipe_id,
        record.payee_id,
        record.micros_per_cook_cycle,
        record.created_at,
        record.updated_at,
      );
    return this.getFoodCookCyclePolicy(record.chef_id, record.recipe_id) as Promise<
      FoodCookCyclePolicyRecord
    >;
  }

  async getFoodCookCyclePolicy(
    chefId: string,
    recipeId: string,
  ): Promise<FoodCookCyclePolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM food_cook_cycle_policies WHERE chef_id = ? AND recipe_id = ?`,
      )
      .get(chefId, recipeId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      payee_id: row.payee_id as string,
      micros_per_cook_cycle: row.micros_per_cook_cycle as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertFoodCobrandWeighting(
    row: Omit<FoodCobrandWeightingRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCobrandWeightingRecord> {
    // UNIQUE per (recipe_id, leg_id) — a re-registered leg converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_cobrand_weightings
           (id, recipe_id, leg_id, payee_id, payee_role, weight_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (recipe_id, leg_id) DO UPDATE SET
           payee_id = excluded.payee_id,
           payee_role = excluded.payee_role,
           weight_bps = excluded.weight_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.recipe_id,
        record.leg_id,
        record.payee_id,
        record.payee_role,
        record.weight_bps,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  async listFoodCobrandWeightings(recipeId: string): Promise<FoodCobrandWeightingRecord[]> {
    // Registration order (created_at ASC, id ASC is this backend's
    // insertion_order).
    const rows = this.db
      .prepare(
        `SELECT * FROM food_cobrand_weightings
           WHERE recipe_id = ?
           ORDER BY created_at ASC, id ASC`,
      )
      .all(recipeId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      recipe_id: row.recipe_id as string,
      leg_id: row.leg_id as string,
      payee_id: row.payee_id as string,
      payee_role: row.payee_role as FoodCobrandWeightingRecord['payee_role'],
      weight_bps: row.weight_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertFoodOperatorWaterfallLeg(
    row: Omit<FoodOperatorWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodOperatorWaterfallRecord> {
    // UNIQUE per (ghost_kitchen_location_id, operator_id) — a
    // re-registered leg converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_operator_waterfalls
           (id, ghost_kitchen_location_id, operator_id, weight_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (ghost_kitchen_location_id, operator_id) DO UPDATE SET
           weight_bps = excluded.weight_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.ghost_kitchen_location_id,
        record.operator_id,
        record.weight_bps,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  async listFoodOperatorWaterfallLegs(
    ghostKitchenLocationId: string,
  ): Promise<FoodOperatorWaterfallRecord[]> {
    // Registration order (created_at ASC, id ASC is this backend's
    // insertion_order).
    const rows = this.db
      .prepare(
        `SELECT * FROM food_operator_waterfalls
           WHERE ghost_kitchen_location_id = ?
           ORDER BY created_at ASC, id ASC`,
      )
      .all(ghostKitchenLocationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      operator_id: row.operator_id as string,
      weight_bps: row.weight_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async insertFoodRealizationApplication(
    row: Omit<FoodRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-walked order
    // throws here, never a double application.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_realization_applications
           (id, source_event_id, chef_id, recipe_id, ghost_kitchen_location_id, period,
            currency, gross_menu_item_sales_cents, approved_ingredient_cogs_cents,
            delivery_platform_engine_cut_cents, local_food_service_taxes_cents,
            net_culinary_ip_pool_cents, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.chef_id,
        record.recipe_id,
        record.ghost_kitchen_location_id,
        record.period,
        record.currency,
        record.gross_menu_item_sales_cents,
        record.approved_ingredient_cogs_cents,
        record.delivery_platform_engine_cut_cents,
        record.local_food_service_taxes_cents,
        record.net_culinary_ip_pool_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getFoodRealizationApplication(
    sourceEventId: string,
  ): Promise<FoodRealizationApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM food_realization_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_menu_item_sales_cents: row.gross_menu_item_sales_cents as number,
      approved_ingredient_cogs_cents: row.approved_ingredient_cogs_cents as number,
      delivery_platform_engine_cut_cents: row.delivery_platform_engine_cut_cents as number,
      local_food_service_taxes_cents: row.local_food_service_taxes_cents as number,
      net_culinary_ip_pool_cents: row.net_culinary_ip_pool_cents as number,
      verdict: row.verdict as FoodRealizationApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertFoodRecipeRoyaltyApplication(
    row: Omit<FoodRecipeRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRecipeRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_recipe_royalty_applications
           (id, source_event_id, sender, chef_id, recipe_id, ghost_kitchen_location_id,
            period, currency, platform, units_sold, net_basis_cents, schedule_ref,
            unit_walk_legs, unit_payout_micros, unit_payout_cents, royalty_bps,
            percentage_split_cents, units_before, units_after, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sender,
        record.chef_id,
        record.recipe_id,
        record.ghost_kitchen_location_id,
        record.period,
        record.currency,
        record.platform,
        record.units_sold,
        record.net_basis_cents,
        record.schedule_ref,
        record.unit_walk_legs,
        record.unit_payout_micros,
        record.unit_payout_cents,
        record.royalty_bps,
        record.percentage_split_cents,
        record.units_before,
        record.units_after,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getFoodRecipeRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FoodRecipeRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM food_recipe_royalty_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as FoodRecipeRoyaltyApplicationRecord['sender'],
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      platform: row.platform as FoodRecipeRoyaltyApplicationRecord['platform'],
      units_sold: row.units_sold as number,
      net_basis_cents: row.net_basis_cents as number,
      schedule_ref: row.schedule_ref as string,
      unit_walk_legs: row.unit_walk_legs as string,
      unit_payout_micros: row.unit_payout_micros as number,
      unit_payout_cents: row.unit_payout_cents as number,
      royalty_bps: row.royalty_bps as number,
      percentage_split_cents: row.percentage_split_cents as number,
      units_before: row.units_before as number,
      units_after: row.units_after as number,
      verdict: row.verdict as FoodRecipeRoyaltyApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertFoodCobrandSplitApplication(
    row: Omit<FoodCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodCobrandSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_cobrand_split_applications
           (id, source_event_id, chef_id, recipe_id, ghost_kitchen_location_id, period,
            currency, royalty_pot_cents, weighting_legs, allocated_total_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.chef_id,
        record.recipe_id,
        record.ghost_kitchen_location_id,
        record.period,
        record.currency,
        record.royalty_pot_cents,
        record.weighting_legs,
        record.allocated_total_cents,
        record.created_at,
      );
    return record;
  }

  async getFoodCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FoodCobrandSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM food_cobrand_split_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      royalty_pot_cents: row.royalty_pot_cents as number,
      weighting_legs: row.weighting_legs as string,
      allocated_total_cents: row.allocated_total_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertFoodHostOperatorSplitApplication(
    row: Omit<FoodHostOperatorSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodHostOperatorSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_host_operator_split_applications
           (id, source_event_id, chef_id, recipe_id, ghost_kitchen_location_id, period,
            currency, platform, tickets, physical_preparation_margin_cents,
            brand_licensor_id, brand_licensor_holdback_bps,
            brand_licensor_holdback_cents, host_operator_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.chef_id,
        record.recipe_id,
        record.ghost_kitchen_location_id,
        record.period,
        record.currency,
        record.platform,
        record.tickets,
        record.physical_preparation_margin_cents,
        record.brand_licensor_id,
        record.brand_licensor_holdback_bps,
        record.brand_licensor_holdback_cents,
        record.host_operator_cents,
        record.created_at,
      );
    return record;
  }

  async getFoodHostOperatorSplitApplication(
    sourceEventId: string,
  ): Promise<FoodHostOperatorSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM food_host_operator_split_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      platform: row.platform as FoodHostOperatorSplitApplicationRecord['platform'],
      tickets: row.tickets as number,
      physical_preparation_margin_cents: row.physical_preparation_margin_cents as number,
      brand_licensor_id: row.brand_licensor_id as string,
      brand_licensor_holdback_bps: row.brand_licensor_holdback_bps as number,
      brand_licensor_holdback_cents: row.brand_licensor_holdback_cents as number,
      host_operator_cents: row.host_operator_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertFoodCookCycleRoyalty(
    row: Omit<FoodCookCycleRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FoodCookCycleRoyaltyRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_cook_cycle_royalties
           (id, source_event_id, chef_id, recipe_id, ghost_kitchen_location_id, period,
            currency, meal_kits_produced, cook_cycles_executed, payee_id,
            micros_per_cook_cycle, royalty_micros, royalty_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.chef_id,
        record.recipe_id,
        record.ghost_kitchen_location_id,
        record.period,
        record.currency,
        record.meal_kits_produced,
        record.cook_cycles_executed,
        record.payee_id,
        record.micros_per_cook_cycle,
        record.royalty_micros,
        record.royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getFoodCookCycleRoyalty(
    sourceEventId: string,
  ): Promise<FoodCookCycleRoyaltyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM food_cook_cycle_royalties WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      chef_id: row.chef_id as string,
      recipe_id: row.recipe_id as string,
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      meal_kits_produced: row.meal_kits_produced as number,
      cook_cycles_executed: row.cook_cycles_executed as number,
      payee_id: row.payee_id as string,
      micros_per_cook_cycle: row.micros_per_cook_cycle as number,
      royalty_micros: row.royalty_micros as number,
      royalty_cents: row.royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertFoodSupplierRebateApplication(
    row: Omit<FoodSupplierRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodSupplierRebateApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO food_supplier_rebate_applications
           (id, source_event_id, supplier, ghost_kitchen_location_id, period, currency,
            rebate_basis_cents, volume_rebate_cents, routing_legs, routed_total_cents,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.supplier,
        record.ghost_kitchen_location_id,
        record.period,
        record.currency,
        record.rebate_basis_cents,
        record.volume_rebate_cents,
        record.routing_legs,
        record.routed_total_cents,
        record.created_at,
      );
    return record;
  }

  async getFoodSupplierRebateApplication(
    sourceEventId: string,
  ): Promise<FoodSupplierRebateApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM food_supplier_rebate_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      supplier: row.supplier as FoodSupplierRebateApplicationRecord['supplier'],
      ghost_kitchen_location_id: row.ghost_kitchen_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      rebate_basis_cents: row.rebate_basis_cents as number,
      volume_rebate_cents: row.volume_rebate_cents as number,
      routing_legs: row.routing_legs as string,
      routed_total_cents: row.routed_total_cents as number,
      created_at: row.created_at as string,
    };
  }

  // ------------------------------------------------------------------
  // The service lane (PR 42) — the policies of record, the waterfalls,
  // and the seven application ledgers.
  // ------------------------------------------------------------------

  async upsertServiceFranchiseSchedule(
    row: Omit<ServiceFranchiseScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceFranchiseScheduleRecord> {
    // UNIQUE per salon_location_id — a re-registered schedule replaces
    // the row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_franchise_schedules
           (id, salon_location_id, master_franchisor_royalty_bps,
            technician_commission_bps, house_margin_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (salon_location_id) DO UPDATE SET
           master_franchisor_royalty_bps = excluded.master_franchisor_royalty_bps,
           technician_commission_bps = excluded.technician_commission_bps,
           house_margin_bps = excluded.house_margin_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.salon_location_id,
        record.master_franchisor_royalty_bps,
        record.technician_commission_bps,
        record.house_margin_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getServiceFranchiseSchedule(record.salon_location_id) as Promise<
      ServiceFranchiseScheduleRecord
    >;
  }

  async getServiceFranchiseSchedule(
    salonLocationId: string,
  ): Promise<ServiceFranchiseScheduleRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_franchise_schedules WHERE salon_location_id = ?`)
      .get(salonLocationId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      salon_location_id: row.salon_location_id as string,
      master_franchisor_royalty_bps: row.master_franchisor_royalty_bps as number,
      technician_commission_bps: row.technician_commission_bps as number,
      house_margin_bps: row.house_margin_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertServiceProtocolPolicy(
    row: Omit<ServiceProtocolPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceProtocolPolicyRecord> {
    // UNIQUE per protocol_id — a re-registered policy replaces the row
    // atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_protocol_policies
           (id, protocol_id, payee_id, micros_per_treatment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (protocol_id) DO UPDATE SET
           payee_id = excluded.payee_id,
           micros_per_treatment = excluded.micros_per_treatment,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.protocol_id,
        record.payee_id,
        record.micros_per_treatment,
        record.created_at,
        record.updated_at,
      );
    return this.getServiceProtocolPolicy(record.protocol_id) as Promise<
      ServiceProtocolPolicyRecord
    >;
  }

  async getServiceProtocolPolicy(
    protocolId: string,
  ): Promise<ServiceProtocolPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_protocol_policies WHERE protocol_id = ?`)
      .get(protocolId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      protocol_id: row.protocol_id as string,
      payee_id: row.payee_id as string,
      micros_per_treatment: row.micros_per_treatment as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertServiceRedemptionPolicy(
    row: Omit<ServiceRedemptionPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceRedemptionPolicyRecord> {
    // UNIQUE per home_location_id — a re-registered policy replaces the
    // row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_redemption_policies
           (id, home_location_id, franchisor_royalty_bps, home_admin_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (home_location_id) DO UPDATE SET
           franchisor_royalty_bps = excluded.franchisor_royalty_bps,
           home_admin_bps = excluded.home_admin_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.home_location_id,
        record.franchisor_royalty_bps,
        record.home_admin_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getServiceRedemptionPolicy(record.home_location_id) as Promise<
      ServiceRedemptionPolicyRecord
    >;
  }

  async getServiceRedemptionPolicy(
    homeLocationId: string,
  ): Promise<ServiceRedemptionPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_redemption_policies WHERE home_location_id = ?`)
      .get(homeLocationId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      home_location_id: row.home_location_id as string,
      franchisor_royalty_bps: row.franchisor_royalty_bps as number,
      home_admin_bps: row.home_admin_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertServiceBreakagePolicy(
    row: Omit<ServiceBreakagePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceBreakagePolicyRecord> {
    // UNIQUE per home_location_id — a re-registered policy replaces the
    // row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_breakage_policies
           (id, home_location_id, franchisor_breakage_bps, franchisee_breakage_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (home_location_id) DO UPDATE SET
           franchisor_breakage_bps = excluded.franchisor_breakage_bps,
           franchisee_breakage_bps = excluded.franchisee_breakage_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.home_location_id,
        record.franchisor_breakage_bps,
        record.franchisee_breakage_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getServiceBreakagePolicy(record.home_location_id) as Promise<
      ServiceBreakagePolicyRecord
    >;
  }

  async getServiceBreakagePolicy(
    homeLocationId: string,
  ): Promise<ServiceBreakagePolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_breakage_policies WHERE home_location_id = ?`)
      .get(homeLocationId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      home_location_id: row.home_location_id as string,
      franchisor_breakage_bps: row.franchisor_breakage_bps as number,
      franchisee_breakage_bps: row.franchisee_breakage_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertServiceRebateWaterfallLeg(
    row: Omit<ServiceRebateWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceRebateWaterfallRecord> {
    // UNIQUE per (salon_location_id, ledger_id) — a re-registered leg
    // converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_rebate_waterfalls
           (id, salon_location_id, ledger_id, weight_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (salon_location_id, ledger_id) DO UPDATE SET
           weight_bps = excluded.weight_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.salon_location_id,
        record.ledger_id,
        record.weight_bps,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  async listServiceRebateWaterfallLegs(
    salonLocationId: string,
  ): Promise<ServiceRebateWaterfallRecord[]> {
    // Registration order (created_at ASC, id ASC is this backend's
    // insertion_order).
    const rows = this.db
      .prepare(
        `SELECT * FROM service_rebate_waterfalls
           WHERE salon_location_id = ?
           ORDER BY created_at ASC, id ASC`,
      )
      .all(salonLocationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      salon_location_id: row.salon_location_id as string,
      ledger_id: row.ledger_id as string,
      weight_bps: row.weight_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertServiceBoothLeasePolicy(
    row: Omit<ServiceBoothLeasePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceBoothLeasePolicyRecord> {
    // UNIQUE per salon_location_id — a re-registered policy replaces
    // the row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_booth_lease_policies
           (id, salon_location_id, chair_rent_payee_id, retail_commission_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (salon_location_id) DO UPDATE SET
           chair_rent_payee_id = excluded.chair_rent_payee_id,
           retail_commission_bps = excluded.retail_commission_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.salon_location_id,
        record.chair_rent_payee_id,
        record.retail_commission_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getServiceBoothLeasePolicy(record.salon_location_id) as Promise<
      ServiceBoothLeasePolicyRecord
    >;
  }

  async getServiceBoothLeasePolicy(
    salonLocationId: string,
  ): Promise<ServiceBoothLeasePolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_booth_lease_policies WHERE salon_location_id = ?`)
      .get(salonLocationId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      salon_location_id: row.salon_location_id as string,
      chair_rent_payee_id: row.chair_rent_payee_id as string,
      retail_commission_bps: row.retail_commission_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertServiceRealizationApplication(
    row: Omit<ServiceRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-shipped sheet
    // throws here, never a double application.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_realization_applications
           (id, source_event_id, sender, stylist_id, protocol_id, salon_location_id,
            period, currency, gross_service_ticket_cents, backbar_product_cogs_cents,
            card_processing_engine_cut_cents, service_sales_taxes_cents,
            net_realized_service_pool_cents, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sender,
        record.stylist_id,
        record.protocol_id,
        record.salon_location_id,
        record.period,
        record.currency,
        record.gross_service_ticket_cents,
        record.backbar_product_cogs_cents,
        record.card_processing_engine_cut_cents,
        record.service_sales_taxes_cents,
        record.net_realized_service_pool_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getServiceRealizationApplication(
    sourceEventId: string,
  ): Promise<ServiceRealizationApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_realization_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as ServiceRealizationApplicationRecord['sender'],
      stylist_id: row.stylist_id as string,
      protocol_id: row.protocol_id as string,
      salon_location_id: row.salon_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_service_ticket_cents: row.gross_service_ticket_cents as number,
      backbar_product_cogs_cents: row.backbar_product_cogs_cents as number,
      card_processing_engine_cut_cents: row.card_processing_engine_cut_cents as number,
      service_sales_taxes_cents: row.service_sales_taxes_cents as number,
      net_realized_service_pool_cents: row.net_realized_service_pool_cents as number,
      verdict: row.verdict as ServiceRealizationApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertServiceFranchiseSplitApplication(
    row: Omit<ServiceFranchiseSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceFranchiseSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_franchise_split_applications
           (id, source_event_id, sender, stylist_id, protocol_id, salon_location_id,
            period, currency, gross_service_ticket_cents, schedule_ref,
            master_franchisor_royalty_bps, master_franchisor_royalty_cents,
            technician_commission_bps, technician_commission_cents,
            house_margin_bps, house_margin_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sender,
        record.stylist_id,
        record.protocol_id,
        record.salon_location_id,
        record.period,
        record.currency,
        record.gross_service_ticket_cents,
        record.schedule_ref,
        record.master_franchisor_royalty_bps,
        record.master_franchisor_royalty_cents,
        record.technician_commission_bps,
        record.technician_commission_cents,
        record.house_margin_bps,
        record.house_margin_cents,
        record.created_at,
      );
    return record;
  }

  async getServiceFranchiseSplitApplication(
    sourceEventId: string,
  ): Promise<ServiceFranchiseSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM service_franchise_split_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as ServiceFranchiseSplitApplicationRecord['sender'],
      stylist_id: row.stylist_id as string,
      protocol_id: row.protocol_id as string,
      salon_location_id: row.salon_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_service_ticket_cents: row.gross_service_ticket_cents as number,
      schedule_ref: row.schedule_ref as string,
      master_franchisor_royalty_bps: row.master_franchisor_royalty_bps as number,
      master_franchisor_royalty_cents: row.master_franchisor_royalty_cents as number,
      technician_commission_bps: row.technician_commission_bps as number,
      technician_commission_cents: row.technician_commission_cents as number,
      house_margin_bps: row.house_margin_bps as number,
      house_margin_cents: row.house_margin_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertServiceProtocolMicroRoyalty(
    row: Omit<ServiceProtocolMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<ServiceProtocolMicroRoyaltyRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_protocol_micro_royalties
           (id, source_event_id, sender, stylist_id, protocol_id, salon_location_id,
            period, currency, payee_id, micros_per_treatment, royalty_micros,
            royalty_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sender,
        record.stylist_id,
        record.protocol_id,
        record.salon_location_id,
        record.period,
        record.currency,
        record.payee_id,
        record.micros_per_treatment,
        record.royalty_micros,
        record.royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getServiceProtocolMicroRoyalty(
    sourceEventId: string,
  ): Promise<ServiceProtocolMicroRoyaltyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM service_protocol_micro_royalties WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sender: row.sender as ServiceProtocolMicroRoyaltyRecord['sender'],
      stylist_id: row.stylist_id as string,
      protocol_id: row.protocol_id as string,
      salon_location_id: row.salon_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      payee_id: row.payee_id as string,
      micros_per_treatment: row.micros_per_treatment as number,
      royalty_micros: row.royalty_micros as number,
      royalty_cents: row.royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertServiceRedemptionSplitApplication(
    row: Omit<ServiceRedemptionSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRedemptionSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_redemption_split_applications
           (id, source_event_id, member_id, home_location_id, visiting_location_id,
            period, currency, service_allocation_fee_cents, franchisor_royalty_bps,
            franchisor_royalty_cents, home_admin_bps, home_admin_cents,
            visiting_location_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.member_id,
        record.home_location_id,
        record.visiting_location_id,
        record.period,
        record.currency,
        record.service_allocation_fee_cents,
        record.franchisor_royalty_bps,
        record.franchisor_royalty_cents,
        record.home_admin_bps,
        record.home_admin_cents,
        record.visiting_location_cents,
        record.created_at,
      );
    return record;
  }

  async getServiceRedemptionSplitApplication(
    sourceEventId: string,
  ): Promise<ServiceRedemptionSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM service_redemption_split_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      member_id: row.member_id as string,
      home_location_id: row.home_location_id as string,
      visiting_location_id: row.visiting_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      service_allocation_fee_cents: row.service_allocation_fee_cents as number,
      franchisor_royalty_bps: row.franchisor_royalty_bps as number,
      franchisor_royalty_cents: row.franchisor_royalty_cents as number,
      home_admin_bps: row.home_admin_bps as number,
      home_admin_cents: row.home_admin_cents as number,
      visiting_location_cents: row.visiting_location_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertServiceBreakageAllocation(
    row: Omit<ServiceBreakageAllocationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceBreakageAllocationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_breakage_allocations
           (id, source_event_id, member_id, home_location_id, period, currency,
            unredeemed_amount_cents, franchisor_breakage_bps,
            franchisor_breakage_cents, franchisee_breakage_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.member_id,
        record.home_location_id,
        record.period,
        record.currency,
        record.unredeemed_amount_cents,
        record.franchisor_breakage_bps,
        record.franchisor_breakage_cents,
        record.franchisee_breakage_cents,
        record.created_at,
      );
    return record;
  }

  async getServiceBreakageAllocation(
    sourceEventId: string,
  ): Promise<ServiceBreakageAllocationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_breakage_allocations WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      member_id: row.member_id as string,
      home_location_id: row.home_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      unredeemed_amount_cents: row.unredeemed_amount_cents as number,
      franchisor_breakage_bps: row.franchisor_breakage_bps as number,
      franchisor_breakage_cents: row.franchisor_breakage_cents as number,
      franchisee_breakage_cents: row.franchisee_breakage_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertServiceRebateApplication(
    row: Omit<ServiceRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRebateApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_rebate_applications
           (id, source_event_id, distributor, salon_location_id, period, currency,
            rebate_basis_cents, volume_rebate_cents, routing_legs,
            routed_total_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.distributor,
        record.salon_location_id,
        record.period,
        record.currency,
        record.rebate_basis_cents,
        record.volume_rebate_cents,
        record.routing_legs,
        record.routed_total_cents,
        record.created_at,
      );
    return record;
  }

  async getServiceRebateApplication(
    sourceEventId: string,
  ): Promise<ServiceRebateApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_rebate_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      distributor: row.distributor as ServiceRebateApplicationRecord['distributor'],
      salon_location_id: row.salon_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      rebate_basis_cents: row.rebate_basis_cents as number,
      volume_rebate_cents: row.volume_rebate_cents as number,
      routing_legs: row.routing_legs as string,
      routed_total_cents: row.routed_total_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertServiceBoothLeaseApplication(
    row: Omit<ServiceBoothLeaseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceBoothLeaseApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO service_booth_lease_applications
           (id, source_event_id, salon_location_id, period, currency, leg_kind,
            gross_cents, retail_commission_bps, studio_owner_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.salon_location_id,
        record.period,
        record.currency,
        record.leg_kind,
        record.gross_cents,
        record.retail_commission_bps,
        record.studio_owner_cents,
        record.created_at,
      );
    return record;
  }

  async getServiceBoothLeaseApplication(
    sourceEventId: string,
  ): Promise<ServiceBoothLeaseApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM service_booth_lease_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      salon_location_id: row.salon_location_id as string,
      period: row.period as string,
      currency: row.currency as string,
      leg_kind: row.leg_kind as ServiceBoothLeaseApplicationRecord['leg_kind'],
      gross_cents: row.gross_cents as number,
      retail_commission_bps: row.retail_commission_bps as number,
      studio_owner_cents: row.studio_owner_cents as number,
      created_at: row.created_at as string,
    };
  }

  // ------------------------------------------------------------------
  // The developer lane (PR 44) — the founder developer directive's
  // registries of record, the two cumulative monthly trackers, and the
  // seven application ledgers.
  // ------------------------------------------------------------------

  async upsertDeveloperApiRoyaltyPolicy(
    row: Omit<DeveloperApiRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperApiRoyaltyPolicyRecord> {
    // UNIQUE per developer_id — a re-registered policy replaces the row
    // atomically (never the id column in the conflict payload).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_api_royalty_policies
           (id, developer_id, royalty_mode, payee_id, tier_bands, usage_share_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (developer_id) DO UPDATE SET
           royalty_mode = excluded.royalty_mode,
           payee_id = excluded.payee_id,
           tier_bands = excluded.tier_bands,
           usage_share_bps = excluded.usage_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.developer_id,
        record.royalty_mode,
        record.payee_id,
        record.tier_bands,
        record.usage_share_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperApiRoyaltyPolicy(record.developer_id) as Promise<
      DeveloperApiRoyaltyPolicyRecord
    >;
  }

  async getDeveloperApiRoyaltyPolicy(
    developerId: string,
  ): Promise<DeveloperApiRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM developer_api_royalty_policies WHERE developer_id = ?`)
      .get(developerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      developer_id: row.developer_id as string,
      royalty_mode: row.royalty_mode as DeveloperApiRoyaltyPolicyRecord['royalty_mode'],
      payee_id: row.payee_id as string,
      tier_bands: row.tier_bands as string,
      usage_share_bps: row.usage_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertDeveloperMarketplacePolicy(
    row: Omit<DeveloperMarketplaceSplitPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperMarketplaceSplitPolicyRecord> {
    // UNIQUE per marketplace — a re-registered policy replaces the row
    // atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_marketplace_split_policies
           (id, marketplace, platform_share_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (marketplace) DO UPDATE SET
           platform_share_bps = excluded.platform_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.marketplace,
        record.platform_share_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperMarketplacePolicy(record.marketplace) as Promise<
      DeveloperMarketplaceSplitPolicyRecord
    >;
  }

  async getDeveloperMarketplacePolicy(
    marketplace: string,
  ): Promise<DeveloperMarketplaceSplitPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM developer_marketplace_split_policies WHERE marketplace = ?`)
      .get(marketplace) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      marketplace: row.marketplace as DeveloperMarketplaceSplitPolicyRecord['marketplace'],
      platform_share_bps: row.platform_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertDeveloperCopackageLeg(
    row: Omit<DeveloperCopackageContributionLegRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperCopackageContributionLegRecord> {
    // UNIQUE per (package_id, maintainer_id) — a re-registered leg
    // converges.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_copackage_contribution_legs
           (id, package_id, maintainer_id, commits, pull_requests, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (package_id, maintainer_id) DO UPDATE SET
           commits = excluded.commits,
           pull_requests = excluded.pull_requests,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.package_id,
        record.maintainer_id,
        record.commits,
        record.pull_requests,
        record.created_at,
        record.updated_at,
      );
    return this.listDeveloperCopackageLegs(record.package_id).then((legs) =>
      legs.find(
        (leg) =>
          leg.package_id === record.package_id &&
          leg.maintainer_id === record.maintainer_id,
      ),
    ) as Promise<DeveloperCopackageContributionLegRecord>;
  }

  async listDeveloperCopackageLegs(
    packageId: string,
  ): Promise<DeveloperCopackageContributionLegRecord[]> {
    // Registration order: created_at ASC, then maintainer_id ASC (the
    // SQL backends' deterministic order).
    const rows = this.db
      .prepare(
        `SELECT * FROM developer_copackage_contribution_legs
           WHERE package_id = ? ORDER BY created_at ASC, maintainer_id ASC`,
      )
      .all(packageId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      package_id: row.package_id as string,
      maintainer_id: row.maintainer_id as string,
      commits: row.commits as number,
      pull_requests: row.pull_requests as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertDeveloperDependencyLedger(
    row: Omit<DeveloperDependencyMaintainerLedgerRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperDependencyMaintainerLedgerRecord> {
    // UNIQUE per component_id — a re-registered ledger replaces the row
    // atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_dependency_maintainer_ledgers
           (id, component_id, maintainer_payee_id, micros_per_deploy,
            micros_per_active_instance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (component_id) DO UPDATE SET
           maintainer_payee_id = excluded.maintainer_payee_id,
           micros_per_deploy = excluded.micros_per_deploy,
           micros_per_active_instance = excluded.micros_per_active_instance,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.component_id,
        record.maintainer_payee_id,
        record.micros_per_deploy,
        record.micros_per_active_instance,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperDependencyLedger(record.component_id) as Promise<
      DeveloperDependencyMaintainerLedgerRecord
    >;
  }

  async getDeveloperDependencyLedger(
    componentId: string,
  ): Promise<DeveloperDependencyMaintainerLedgerRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_dependency_maintainer_ledgers WHERE component_id = ?`,
      )
      .get(componentId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      component_id: row.component_id as string,
      maintainer_payee_id: row.maintainer_payee_id as string,
      micros_per_deploy: row.micros_per_deploy as number,
      micros_per_active_instance: row.micros_per_active_instance as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertDeveloperWhitelabelDeal(
    row: Omit<DeveloperWhitelabelLicenseDealRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperWhitelabelLicenseDealRecord> {
    // UNIQUE per sdk_package_hash — a re-registered deal replaces the
    // row atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_whitelabel_license_deals
           (id, sdk_package_hash, owner_payee_id, seat_micros_per_seat,
            deployment_micros_per_deployment, minimum_monthly_guarantee_cents,
            overage_royalty_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sdk_package_hash) DO UPDATE SET
           owner_payee_id = excluded.owner_payee_id,
           seat_micros_per_seat = excluded.seat_micros_per_seat,
           deployment_micros_per_deployment = excluded.deployment_micros_per_deployment,
           minimum_monthly_guarantee_cents = excluded.minimum_monthly_guarantee_cents,
           overage_royalty_bps = excluded.overage_royalty_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.sdk_package_hash,
        record.owner_payee_id,
        record.seat_micros_per_seat,
        record.deployment_micros_per_deployment,
        record.minimum_monthly_guarantee_cents,
        record.overage_royalty_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperWhitelabelDeal(record.sdk_package_hash) as Promise<
      DeveloperWhitelabelLicenseDealRecord
    >;
  }

  async getDeveloperWhitelabelDeal(
    sdkPackageHash: string,
  ): Promise<DeveloperWhitelabelLicenseDealRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_whitelabel_license_deals WHERE sdk_package_hash = ?`,
      )
      .get(sdkPackageHash) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      sdk_package_hash: row.sdk_package_hash as string,
      owner_payee_id: row.owner_payee_id as string,
      seat_micros_per_seat: row.seat_micros_per_seat as number,
      deployment_micros_per_deployment: row.deployment_micros_per_deployment as number,
      minimum_monthly_guarantee_cents: row.minimum_monthly_guarantee_cents as number,
      overage_royalty_bps: row.overage_royalty_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertDeveloperToolPolicy(
    row: Omit<DeveloperToolRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperToolRoyaltyPolicyRecord> {
    // UNIQUE per tool_id — a re-registered policy replaces the row
    // atomically.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_tool_royalty_policies
           (id, tool_id, builder_payee_id, micros_per_call, builder_share_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tool_id) DO UPDATE SET
           builder_payee_id = excluded.builder_payee_id,
           micros_per_call = excluded.micros_per_call,
           builder_share_bps = excluded.builder_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.tool_id,
        record.builder_payee_id,
        record.micros_per_call,
        record.builder_share_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperToolPolicy(record.tool_id) as Promise<
      DeveloperToolRoyaltyPolicyRecord
    >;
  }

  async getDeveloperToolPolicy(
    toolId: string,
  ): Promise<DeveloperToolRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM developer_tool_royalty_policies WHERE tool_id = ?`)
      .get(toolId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      tool_id: row.tool_id as DeveloperToolRoyaltyPolicyRecord['tool_id'],
      builder_payee_id: row.builder_payee_id as string,
      micros_per_call: row.micros_per_call as number,
      builder_share_bps: row.builder_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceDeveloperApiCallMonth(
    developerId: string,
    month: string,
    callsAdded: number,
  ): Promise<DeveloperApiCallMonthRecord> {
    // UNIQUE per (developer_id, month) — the tracker converges (the
    // upsert ADDS the row's calls to the cumulative position).
    const record = {
      id: randomUUID(),
      developer_id: developerId,
      month,
      cumulative_calls: callsAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_api_call_months
           (id, developer_id, month, cumulative_calls, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (developer_id, month) DO UPDATE SET
           cumulative_calls = developer_api_call_months.cumulative_calls
             + excluded.cumulative_calls,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.developer_id,
        record.month,
        record.cumulative_calls,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperApiCallMonth(developerId, month) as Promise<
      DeveloperApiCallMonthRecord
    >;
  }

  async getDeveloperApiCallMonth(
    developerId: string,
    month: string,
  ): Promise<DeveloperApiCallMonthRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_api_call_months
           WHERE developer_id = ? AND month = ?`,
      )
      .get(developerId, month) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      developer_id: row.developer_id as string,
      month: row.month as string,
      cumulative_calls: row.cumulative_calls as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceDeveloperWhitelabelUsageMonth(
    sdkPackageHash: string,
    licensorId: string,
    month: string,
    usageCentsAdded: number,
  ): Promise<DeveloperWhitelabelUsageMonthRecord> {
    // UNIQUE per (sdk_package_hash, licensor_id, month) — the tracker
    // converges (the upsert ADDS the event's payable cents).
    const record = {
      id: randomUUID(),
      sdk_package_hash: sdkPackageHash,
      licensor_id: licensorId,
      month,
      cumulative_usage_cents: usageCentsAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_whitelabel_usage_months
           (id, sdk_package_hash, licensor_id, month, cumulative_usage_cents,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sdk_package_hash, licensor_id, month) DO UPDATE SET
           cumulative_usage_cents = developer_whitelabel_usage_months.cumulative_usage_cents
             + excluded.cumulative_usage_cents,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.sdk_package_hash,
        record.licensor_id,
        record.month,
        record.cumulative_usage_cents,
        record.created_at,
        record.updated_at,
      );
    return this.getDeveloperWhitelabelUsageMonth(
      sdkPackageHash,
      licensorId,
      month,
    ) as Promise<DeveloperWhitelabelUsageMonthRecord>;
  }

  async getDeveloperWhitelabelUsageMonth(
    sdkPackageHash: string,
    licensorId: string,
    month: string,
  ): Promise<DeveloperWhitelabelUsageMonthRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_whitelabel_usage_months
           WHERE sdk_package_hash = ? AND licensor_id = ? AND month = ?`,
      )
      .get(sdkPackageHash, licensorId, month) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      sdk_package_hash: row.sdk_package_hash as string,
      licensor_id: row.licensor_id as string,
      month: row.month as string,
      cumulative_usage_cents: row.cumulative_usage_cents as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertDeveloperRealizationApplication(
    row: Omit<DeveloperApiRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperApiRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-shipped event
    // throws here, never a double application.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_api_realization_applications
           (id, source_event_id, feed, developer_id, api_endpoint_id, sdk_package_hash,
            period, currency, gross_api_transaction_revenue_cents,
            cloud_infrastructure_hosting_base_cents, payment_processing_gate_cut_cents,
            enterprise_sla_reserve_cents, net_code_usage_pool_cents, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.feed,
        record.developer_id,
        record.api_endpoint_id,
        record.sdk_package_hash,
        record.period,
        record.currency,
        record.gross_api_transaction_revenue_cents,
        record.cloud_infrastructure_hosting_base_cents,
        record.payment_processing_gate_cut_cents,
        record.enterprise_sla_reserve_cents,
        record.net_code_usage_pool_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getDeveloperRealizationApplication(
    sourceEventId: string,
  ): Promise<DeveloperApiRealizationApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_api_realization_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      feed: row.feed as DeveloperApiRealizationApplicationRecord['feed'],
      developer_id: row.developer_id as string,
      api_endpoint_id: row.api_endpoint_id as string,
      sdk_package_hash: row.sdk_package_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_api_transaction_revenue_cents: row.gross_api_transaction_revenue_cents as number,
      cloud_infrastructure_hosting_base_cents:
        row.cloud_infrastructure_hosting_base_cents as number,
      payment_processing_gate_cut_cents: row.payment_processing_gate_cut_cents as number,
      enterprise_sla_reserve_cents: row.enterprise_sla_reserve_cents as number,
      net_code_usage_pool_cents: row.net_code_usage_pool_cents as number,
      verdict: row.verdict as DeveloperApiRealizationApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertDeveloperApiMicroRoyalty(
    row: Omit<DeveloperApiMicroRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperApiMicroRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_api_micro_royalty_applications
           (id, source_event_id, feed, developer_id, api_endpoint_id, sdk_package_hash,
            period, currency, payee_id, royalty_mode, policy_ref, api_calls, tier_legs,
            usage_share_bps, royalty_basis_cents, royalty_micros, royalty_cents,
            monthly_calls_before, monthly_calls_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.feed,
        record.developer_id,
        record.api_endpoint_id,
        record.sdk_package_hash,
        record.period,
        record.currency,
        record.payee_id,
        record.royalty_mode,
        record.policy_ref,
        record.api_calls,
        record.tier_legs,
        record.usage_share_bps,
        record.royalty_basis_cents,
        record.royalty_micros,
        record.royalty_cents,
        record.monthly_calls_before,
        record.monthly_calls_after,
        record.created_at,
      );
    return record;
  }

  async getDeveloperApiMicroRoyalty(
    sourceEventId: string,
  ): Promise<DeveloperApiMicroRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_api_micro_royalty_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      feed: row.feed as DeveloperApiMicroRoyaltyApplicationRecord['feed'],
      developer_id: row.developer_id as string,
      api_endpoint_id: row.api_endpoint_id as string,
      sdk_package_hash: row.sdk_package_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      payee_id: row.payee_id as string,
      royalty_mode: row.royalty_mode as DeveloperApiMicroRoyaltyApplicationRecord['royalty_mode'],
      policy_ref: row.policy_ref as string,
      api_calls: row.api_calls as number,
      tier_legs: row.tier_legs as string,
      usage_share_bps: row.usage_share_bps as number,
      royalty_basis_cents: row.royalty_basis_cents as number,
      royalty_micros: row.royalty_micros as number,
      royalty_cents: row.royalty_cents as number,
      monthly_calls_before: row.monthly_calls_before as number,
      monthly_calls_after: row.monthly_calls_after as number,
      created_at: row.created_at as string,
    };
  }

  async insertDeveloperMarketplaceSplit(
    row: Omit<DeveloperMarketplaceSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperMarketplaceSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_marketplace_split_applications
           (id, source_event_id, marketplace, developer_id, sdk_package_hash, period,
            currency, gross_sale_cents, policy_ref, platform_share_bps, platform_cents,
            developer_net_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.marketplace,
        record.developer_id,
        record.sdk_package_hash,
        record.period,
        record.currency,
        record.gross_sale_cents,
        record.policy_ref,
        record.platform_share_bps,
        record.platform_cents,
        record.developer_net_cents,
        record.created_at,
      );
    return record;
  }

  async getDeveloperMarketplaceSplit(
    sourceEventId: string,
  ): Promise<DeveloperMarketplaceSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_marketplace_split_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      marketplace: row.marketplace as DeveloperMarketplaceSplitApplicationRecord['marketplace'],
      developer_id: row.developer_id as string,
      sdk_package_hash: row.sdk_package_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_sale_cents: row.gross_sale_cents as number,
      policy_ref: row.policy_ref as string,
      platform_share_bps: row.platform_share_bps as number,
      platform_cents: row.platform_cents as number,
      developer_net_cents: row.developer_net_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertDeveloperCopackageSplit(
    row: Omit<DeveloperCopackageSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperCopackageSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_copackage_split_applications
           (id, source_event_id, package_id, developer_id, revenue_kind, period,
            currency, gross_revenue_cents, split_legs, allocated_total_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.package_id,
        record.developer_id,
        record.revenue_kind,
        record.period,
        record.currency,
        record.gross_revenue_cents,
        record.split_legs,
        record.allocated_total_cents,
        record.created_at,
      );
    return record;
  }

  async getDeveloperCopackageSplit(
    sourceEventId: string,
  ): Promise<DeveloperCopackageSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_copackage_split_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      package_id: row.package_id as string,
      developer_id: row.developer_id as string,
      revenue_kind: row.revenue_kind as DeveloperCopackageSplitApplicationRecord['revenue_kind'],
      period: row.period as string,
      currency: row.currency as string,
      gross_revenue_cents: row.gross_revenue_cents as number,
      split_legs: row.split_legs as string,
      allocated_total_cents: row.allocated_total_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertDeveloperDependencyFee(
    row: Omit<DeveloperDependencyFeeApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperDependencyFeeApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_dependency_fee_applications
           (id, source_event_id, developer_id, component_id, scan_context, period,
            currency, deploy_count, active_instances, ledger_ref, maintainer_payee_id,
            micros_per_deploy, micros_per_active_instance, fee_micros, fee_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.developer_id,
        record.component_id,
        record.scan_context,
        record.period,
        record.currency,
        record.deploy_count,
        record.active_instances,
        record.ledger_ref,
        record.maintainer_payee_id,
        record.micros_per_deploy,
        record.micros_per_active_instance,
        record.fee_micros,
        record.fee_cents,
        record.created_at,
      );
    return record;
  }

  async getDeveloperDependencyFee(
    sourceEventId: string,
  ): Promise<DeveloperDependencyFeeApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_dependency_fee_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      developer_id: row.developer_id as string,
      component_id: row.component_id as string,
      scan_context: row.scan_context as DeveloperDependencyFeeApplicationRecord['scan_context'],
      period: row.period as string,
      currency: row.currency as string,
      deploy_count: row.deploy_count as number,
      active_instances: row.active_instances as number,
      ledger_ref: row.ledger_ref as string,
      maintainer_payee_id: row.maintainer_payee_id as string,
      micros_per_deploy: row.micros_per_deploy as number,
      micros_per_active_instance: row.micros_per_active_instance as number,
      fee_micros: row.fee_micros as number,
      fee_cents: row.fee_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertDeveloperWhitelabelLicense(
    row: Omit<DeveloperWhitelabelLicenseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperWhitelabelLicenseApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_whitelabel_license_applications
           (id, source_event_id, sdk_package_hash, licensor_id, event_kind, quantity,
            period, currency, deal_ref, owner_payee_id, usage_micros, usage_cents,
            monthly_usage_before_cents, monthly_usage_after_cents, mmg_cents,
            recouped_cents, overage_cents, overage_royalty_bps, overage_royalty_cents,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.sdk_package_hash,
        record.licensor_id,
        record.event_kind,
        record.quantity,
        record.period,
        record.currency,
        record.deal_ref,
        record.owner_payee_id,
        record.usage_micros,
        record.usage_cents,
        record.monthly_usage_before_cents,
        record.monthly_usage_after_cents,
        record.mmg_cents,
        record.recouped_cents,
        record.overage_cents,
        record.overage_royalty_bps,
        record.overage_royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getDeveloperWhitelabelLicense(
    sourceEventId: string,
  ): Promise<DeveloperWhitelabelLicenseApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_whitelabel_license_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sdk_package_hash: row.sdk_package_hash as string,
      licensor_id: row.licensor_id as string,
      event_kind: row.event_kind as DeveloperWhitelabelLicenseApplicationRecord['event_kind'],
      quantity: row.quantity as number,
      period: row.period as string,
      currency: row.currency as string,
      deal_ref: row.deal_ref as string,
      owner_payee_id: row.owner_payee_id as string,
      usage_micros: row.usage_micros as number,
      usage_cents: row.usage_cents as number,
      monthly_usage_before_cents: row.monthly_usage_before_cents as number,
      monthly_usage_after_cents: row.monthly_usage_after_cents as number,
      mmg_cents: row.mmg_cents as number,
      recouped_cents: row.recouped_cents as number,
      overage_cents: row.overage_cents as number,
      overage_royalty_bps: row.overage_royalty_bps as number,
      overage_royalty_cents: row.overage_royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertDeveloperToolCallApplication(
    row: Omit<DeveloperAgentToolCallApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperAgentToolCallApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO developer_agent_tool_call_applications
           (id, source_event_id, agent_id, tool_id, call_count, period, currency,
            policy_ref, builder_payee_id, micros_per_call, settlement_micros,
            settlement_cents, builder_share_bps, builder_cents, platform_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.agent_id,
        record.tool_id,
        record.call_count,
        record.period,
        record.currency,
        record.policy_ref,
        record.builder_payee_id,
        record.micros_per_call,
        record.settlement_micros,
        record.settlement_cents,
        record.builder_share_bps,
        record.builder_cents,
        record.platform_cents,
        record.created_at,
      );
    return record;
  }

  async getDeveloperToolCallApplication(
    sourceEventId: string,
  ): Promise<DeveloperAgentToolCallApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM developer_agent_tool_call_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      agent_id: row.agent_id as string,
      tool_id: row.tool_id as DeveloperAgentToolCallApplicationRecord['tool_id'],
      call_count: row.call_count as number,
      period: row.period as string,
      currency: row.currency as string,
      policy_ref: row.policy_ref as string,
      builder_payee_id: row.builder_payee_id as string,
      micros_per_call: row.micros_per_call as number,
      settlement_micros: row.settlement_micros as number,
      settlement_cents: row.settlement_cents as number,
      builder_share_bps: row.builder_share_bps as number,
      builder_cents: row.builder_cents as number,
      platform_cents: row.platform_cents as number,
      created_at: row.created_at as string,
    };
  }

  // -------------------------------------------------------------------------
  // The hardware patent lane (PR 46, migration 0050) — the founder
  // hardware directive's registries, tracker, and application ledgers.
  // -------------------------------------------------------------------------

  async upsertHardwarePatentPool(
    row: Omit<HardwarePatentPoolRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePatentPoolRecord> {
    // One pool of record per pool_code — INSERT ON CONFLICT replaces the
    // row atomically (the id rotates; never send one in the payload).
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_patent_pools (id, pool_code, pool_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (pool_code) DO UPDATE SET
           pool_name = excluded.pool_name,
           updated_at = excluded.updated_at`,
      )
      .run(id, row.pool_code, row.pool_name, now, now);
    return this.getHardwarePatentPool(row.pool_code) as Promise<HardwarePatentPoolRecord>;
  }

  async getHardwarePatentPool(
    poolCode: string,
  ): Promise<HardwarePatentPoolRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_patent_pools WHERE pool_code = ?`)
      .get(poolCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      pool_code: row.pool_code as string,
      pool_name: row.pool_name as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertHardwarePoolHolderLeg(
    row: Omit<HardwarePoolHolderLegRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePoolHolderLegRecord> {
    // One verified weighting per (pool_code, holder_payee_id).
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_pool_holder_legs
           (id, pool_code, holder_payee_id, essentiality_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (pool_code, holder_payee_id) DO UPDATE SET
           essentiality_score = excluded.essentiality_score,
           updated_at = excluded.updated_at`,
      )
      .run(id, row.pool_code, row.holder_payee_id, row.essentiality_score, now, now);
    const found = await this.getHardwarePoolHolderLeg(row.pool_code, row.holder_payee_id);
    if (found === undefined) {
      throw new Error('hardware_pool_holder_leg_upsert_failed');
    }
    return found;
  }

  async getHardwarePoolHolderLeg(
    poolCode: string,
    holderPayeeId: string,
  ): Promise<HardwarePoolHolderLegRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_pool_holder_legs
         WHERE pool_code = ? AND holder_payee_id = ?`,
      )
      .get(poolCode, holderPayeeId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      pool_code: row.pool_code as string,
      holder_payee_id: row.holder_payee_id as string,
      essentiality_score: row.essentiality_score as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async listHardwarePoolHolderLegs(poolCode: string): Promise<HardwarePoolHolderLegRecord[]> {
    // Registration order — rowid ASC is this backend's insertion_order.
    const rows = this.db
      .prepare(`SELECT * FROM hardware_pool_holder_legs WHERE pool_code = ? ORDER BY rowid ASC`)
      .all(poolCode) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      pool_code: row.pool_code as string,
      holder_payee_id: row.holder_payee_id as string,
      essentiality_score: row.essentiality_score as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertHardwareSepRoyaltyPolicy(
    row: Omit<HardwareSepRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareSepRoyaltyPolicyRecord> {
    // One policy of record per (patent_family_id, sep_pool_code).
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_sep_royalty_policies
           (id, patent_family_id, sep_pool_code, payee_id, tier_bands, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (patent_family_id, sep_pool_code) DO UPDATE SET
           payee_id = excluded.payee_id,
           tier_bands = excluded.tier_bands,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.patent_family_id,
        row.sep_pool_code,
        row.payee_id,
        row.tier_bands,
        now,
        now,
      );
    const found = await this.getHardwareSepRoyaltyPolicy(
      row.patent_family_id,
      row.sep_pool_code,
    );
    if (found === undefined) {
      throw new Error('hardware_sep_royalty_policy_upsert_failed');
    }
    return found;
  }

  async getHardwareSepRoyaltyPolicy(
    patentFamilyId: string,
    sepPoolCode: string,
  ): Promise<HardwareSepRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_sep_royalty_policies
         WHERE patent_family_id = ? AND sep_pool_code = ?`,
      )
      .get(patentFamilyId, sepPoolCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      patent_family_id: row.patent_family_id as string,
      sep_pool_code: row.sep_pool_code as string,
      payee_id: row.payee_id as string,
      tier_bands: row.tier_bands as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertHardwareAutomotivePoolAssignment(
    row: Omit<HardwareAutomotivePoolAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareAutomotivePoolAssignmentRecord> {
    // One routing of record per (oem_id, line_id).
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_automotive_pool_assignments
           (id, oem_id, line_id, cellular_pool_code, navigation_pool_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (oem_id, line_id) DO UPDATE SET
           cellular_pool_code = excluded.cellular_pool_code,
           navigation_pool_code = excluded.navigation_pool_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.oem_id,
        row.line_id,
        row.cellular_pool_code,
        row.navigation_pool_code,
        now,
        now,
      );
    const found = await this.getHardwareAutomotivePoolAssignment(row.oem_id, row.line_id);
    if (found === undefined) {
      throw new Error('hardware_automotive_pool_assignment_upsert_failed');
    }
    return found;
  }

  async getHardwareAutomotivePoolAssignment(
    oemId: string,
    lineId: string,
  ): Promise<HardwareAutomotivePoolAssignmentRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_automotive_pool_assignments
         WHERE oem_id = ? AND line_id = ?`,
      )
      .get(oemId, lineId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      oem_id: row.oem_id as string,
      line_id: row.line_id as string,
      cellular_pool_code: row.cellular_pool_code as string,
      navigation_pool_code: row.navigation_pool_code as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertHardwareCleanTechRoyaltyPolicy(
    row: Omit<HardwareCleanTechRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareCleanTechRoyaltyPolicyRecord> {
    // One policy of record per patent_family_id.
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_cleantech_royalty_policies
           (id, patent_family_id, payee_id, micros_per_kwh, micros_per_charge_cycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (patent_family_id) DO UPDATE SET
           payee_id = excluded.payee_id,
           micros_per_kwh = excluded.micros_per_kwh,
           micros_per_charge_cycle = excluded.micros_per_charge_cycle,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.patent_family_id,
        row.payee_id,
        row.micros_per_kwh,
        row.micros_per_charge_cycle,
        now,
        now,
      );
    const found = await this.getHardwareCleanTechRoyaltyPolicy(row.patent_family_id);
    if (found === undefined) {
      throw new Error('hardware_cleantech_royalty_policy_upsert_failed');
    }
    return found;
  }

  async getHardwareCleanTechRoyaltyPolicy(
    patentFamilyId: string,
  ): Promise<HardwareCleanTechRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_cleantech_royalty_policies WHERE patent_family_id = ?`,
      )
      .get(patentFamilyId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      patent_family_id: row.patent_family_id as string,
      payee_id: row.payee_id as string,
      micros_per_kwh: row.micros_per_kwh as number,
      micros_per_charge_cycle: row.micros_per_charge_cycle as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertHardwareOtaUnlockPolicy(
    row: Omit<HardwareOtaUnlockPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareOtaUnlockPolicyRecord> {
    // One policy of record per feature_code.
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_ota_unlock_policies
           (id, feature_code, sensor_licensor_payee_id, micros_per_unlock, licensor_share_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (feature_code) DO UPDATE SET
           sensor_licensor_payee_id = excluded.sensor_licensor_payee_id,
           micros_per_unlock = excluded.micros_per_unlock,
           licensor_share_bps = excluded.licensor_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.feature_code,
        row.sensor_licensor_payee_id,
        row.micros_per_unlock,
        row.licensor_share_bps,
        now,
        now,
      );
    const found = await this.getHardwareOtaUnlockPolicy(row.feature_code);
    if (found === undefined) {
      throw new Error('hardware_ota_unlock_policy_upsert_failed');
    }
    return found;
  }

  async getHardwareOtaUnlockPolicy(
    featureCode: string,
  ): Promise<HardwareOtaUnlockPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_ota_unlock_policies WHERE feature_code = ?`)
      .get(featureCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      feature_code: row.feature_code as string,
      sensor_licensor_payee_id: row.sensor_licensor_payee_id as string,
      micros_per_unlock: row.micros_per_unlock as number,
      licensor_share_bps: row.licensor_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertHardwareCrossLicenseAgreement(
    row: Omit<HardwareCrossLicenseAgreementRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareCrossLicenseAgreementRecord> {
    // One agreement of record per (company_a_id, company_b_id) — the
    // canonical pair orientation (the CHECK pins a < b).
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_cross_license_agreements
           (id, agreement_ref, company_a_id, company_b_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_a_id, company_b_id) DO UPDATE SET
           agreement_ref = excluded.agreement_ref,
           updated_at = excluded.updated_at`,
      )
      .run(id, row.agreement_ref, row.company_a_id, row.company_b_id, now, now);
    const found = await this.getHardwareCrossLicenseAgreement(
      row.company_a_id,
      row.company_b_id,
    );
    if (found === undefined) {
      throw new Error('hardware_cross_license_agreement_upsert_failed');
    }
    return found;
  }

  async getHardwareCrossLicenseAgreement(
    companyAId: string,
    companyBId: string,
  ): Promise<HardwareCrossLicenseAgreementRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_cross_license_agreements
         WHERE company_a_id = ? AND company_b_id = ?`,
      )
      .get(companyAId, companyBId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      agreement_ref: row.agreement_ref as string,
      company_a_id: row.company_a_id as string,
      company_b_id: row.company_b_id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceHardwareSepUnitMonth(
    licenseeId: string,
    patentFamilyId: string,
    sepPoolCode: string,
    month: string,
    unitsAdded: number,
  ): Promise<HardwareSepUnitMonthRecord> {
    // The cumulative monthly tracker of record — an upsert that ADDS the
    // row's units to the (licensee, family, pool, month) position.
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_sep_unit_months
           (id, licensee_id, patent_family_id, sep_pool_code, month, cumulative_units, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (licensee_id, patent_family_id, sep_pool_code, month) DO UPDATE SET
           cumulative_units = cumulative_units + excluded.cumulative_units,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        licenseeId,
        patentFamilyId,
        sepPoolCode,
        month,
        unitsAdded,
        now,
        now,
      );
    const found = await this.getHardwareSepUnitMonth(
      licenseeId,
      patentFamilyId,
      sepPoolCode,
      month,
    );
    if (found === undefined) {
      throw new Error('hardware_sep_unit_month_advance_failed');
    }
    return found;
  }

  async getHardwareSepUnitMonth(
    licenseeId: string,
    patentFamilyId: string,
    sepPoolCode: string,
    month: string,
  ): Promise<HardwareSepUnitMonthRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_sep_unit_months
         WHERE licensee_id = ? AND patent_family_id = ? AND sep_pool_code = ? AND month = ?`,
      )
      .get(licenseeId, patentFamilyId, sepPoolCode, month) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      licensee_id: row.licensee_id as string,
      patent_family_id: row.patent_family_id as string,
      sep_pool_code: row.sep_pool_code as string,
      month: row.month as string,
      cumulative_units: row.cumulative_units as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertHardwareRealizationApplication(
    row: Omit<HardwareRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard (the DDL's UNIQUE
    // clause is the concurrent backstop).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_realization_applications
           (id, source_event_id, patent_family_id, sep_pool_code, device_imei_mac, eid,
            period, currency, device_wholesale_asp_cents, component_cogs_base_cents,
            non_essential_bom_cents, net_patentable_device_value_base_cents, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.patent_family_id,
        record.sep_pool_code,
        record.device_imei_mac,
        record.eid,
        record.period,
        record.currency,
        record.device_wholesale_asp_cents,
        record.component_cogs_base_cents,
        record.non_essential_bom_cents,
        record.net_patentable_device_value_base_cents,
        record.verdict,
        record.created_at,
      );
    return record;
  }

  async getHardwareRealizationApplication(
    sourceEventId: string,
  ): Promise<HardwareRealizationApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_realization_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      patent_family_id: row.patent_family_id as string,
      sep_pool_code: row.sep_pool_code as string,
      device_imei_mac: row.device_imei_mac as string,
      eid: (row.eid as string | null) ?? null,
      period: row.period as string,
      currency: row.currency as string,
      device_wholesale_asp_cents: row.device_wholesale_asp_cents as number,
      component_cogs_base_cents: row.component_cogs_base_cents as number,
      non_essential_bom_cents: row.non_essential_bom_cents as number,
      net_patentable_device_value_base_cents: row.net_patentable_device_value_base_cents as number,
      verdict: row.verdict as HardwareRealizationApplicationRecord['verdict'],
      created_at: row.created_at as string,
    };
  }

  async insertHardwareSepRoyaltyApplication(
    row: Omit<HardwareSepRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareSepRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_sep_royalty_applications
           (id, source_event_id, licensee_id, patent_family_id, sep_pool_code, period, currency,
            policy_ref, payee_id, device_mac, connected_units, royalty_basis_cents, tier_legs,
            royalty_cents, cumulative_units_before, cumulative_units_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.licensee_id,
        record.patent_family_id,
        record.sep_pool_code,
        record.period,
        record.currency,
        record.policy_ref,
        record.payee_id,
        record.device_mac,
        record.connected_units,
        record.royalty_basis_cents,
        record.tier_legs,
        record.royalty_cents,
        record.cumulative_units_before,
        record.cumulative_units_after,
        record.created_at,
      );
    return record;
  }

  async getHardwareSepRoyaltyApplication(
    sourceEventId: string,
  ): Promise<HardwareSepRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_sep_royalty_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      licensee_id: row.licensee_id as string,
      patent_family_id: row.patent_family_id as string,
      sep_pool_code: row.sep_pool_code as string,
      period: row.period as string,
      currency: row.currency as string,
      policy_ref: row.policy_ref as string,
      payee_id: row.payee_id as string,
      device_mac: row.device_mac as string,
      connected_units: row.connected_units as number,
      royalty_basis_cents: row.royalty_basis_cents as number,
      tier_legs: row.tier_legs as string,
      royalty_cents: row.royalty_cents as number,
      cumulative_units_before: row.cumulative_units_before as number,
      cumulative_units_after: row.cumulative_units_after as number,
      created_at: row.created_at as string,
    };
  }

  async insertHardwarePoolRoutingApplication(
    row: Omit<HardwarePoolRoutingApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwarePoolRoutingApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_pool_routing_applications
           (id, source_event_id, oem_id, line_id, period, currency, assignment_ref,
            serials_produced, cellular_pool_code, navigation_pool_code,
            cellular_fee_per_vehicle_cents, navigation_fee_per_vehicle_cents,
            cellular_routed_cents, navigation_routed_cents, total_routed_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.oem_id,
        record.line_id,
        record.period,
        record.currency,
        record.assignment_ref,
        record.serials_produced,
        record.cellular_pool_code,
        record.navigation_pool_code,
        record.cellular_fee_per_vehicle_cents,
        record.navigation_fee_per_vehicle_cents,
        record.cellular_routed_cents,
        record.navigation_routed_cents,
        record.total_routed_cents,
        record.created_at,
      );
    return record;
  }

  async getHardwarePoolRoutingApplication(
    sourceEventId: string,
  ): Promise<HardwarePoolRoutingApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_pool_routing_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      oem_id: row.oem_id as string,
      line_id: row.line_id as string,
      period: row.period as string,
      currency: row.currency as string,
      assignment_ref: row.assignment_ref as string,
      serials_produced: row.serials_produced as number,
      cellular_pool_code: row.cellular_pool_code as string,
      navigation_pool_code: row.navigation_pool_code as string,
      cellular_fee_per_vehicle_cents: row.cellular_fee_per_vehicle_cents as number,
      navigation_fee_per_vehicle_cents: row.navigation_fee_per_vehicle_cents as number,
      cellular_routed_cents: row.cellular_routed_cents as number,
      navigation_routed_cents: row.navigation_routed_cents as number,
      total_routed_cents: row.total_routed_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertHardwarePoolWaterfallApplication(
    row: Omit<HardwarePoolWaterfallApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwarePoolWaterfallApplicationRecord> {
    // UNIQUE per (routing_source_event_id, pool_code) — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_pool_waterfall_applications
           (id, routing_source_event_id, pool_code, period, currency, split_legs,
            pool_fee_pot_cents, allocated_total_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.routing_source_event_id,
        record.pool_code,
        record.period,
        record.currency,
        record.split_legs,
        record.pool_fee_pot_cents,
        record.allocated_total_cents,
        record.created_at,
      );
    return record;
  }

  async getHardwarePoolWaterfallApplication(
    routingSourceEventId: string,
    poolCode: string,
  ): Promise<HardwarePoolWaterfallApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_pool_waterfall_applications
         WHERE routing_source_event_id = ? AND pool_code = ?`,
      )
      .get(routingSourceEventId, poolCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      routing_source_event_id: row.routing_source_event_id as string,
      pool_code: row.pool_code as string,
      period: row.period as string,
      currency: row.currency as string,
      split_legs: row.split_legs as string,
      pool_fee_pot_cents: row.pool_fee_pot_cents as number,
      allocated_total_cents: row.allocated_total_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertHardwareTelemetryRoyaltyApplication(
    row: Omit<HardwareTelemetryRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareTelemetryRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_telemetry_royalty_applications
           (id, source_event_id, patent_family_id, period, currency, policy_ref, payee_id,
            device_serial, kwh_micros, charge_cycles, micros_per_kwh, micros_per_charge_cycle,
            royalty_micros, royalty_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.patent_family_id,
        record.period,
        record.currency,
        record.policy_ref,
        record.payee_id,
        record.device_serial,
        record.kwh_micros,
        record.charge_cycles,
        record.micros_per_kwh,
        record.micros_per_charge_cycle,
        record.royalty_micros,
        record.royalty_cents,
        record.created_at,
      );
    return record;
  }

  async getHardwareTelemetryRoyaltyApplication(
    sourceEventId: string,
  ): Promise<HardwareTelemetryRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_telemetry_royalty_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      patent_family_id: row.patent_family_id as string,
      period: row.period as string,
      currency: row.currency as string,
      policy_ref: row.policy_ref as string,
      payee_id: row.payee_id as string,
      device_serial: row.device_serial as string,
      kwh_micros: row.kwh_micros as number,
      charge_cycles: row.charge_cycles as number,
      micros_per_kwh: row.micros_per_kwh as number,
      micros_per_charge_cycle: row.micros_per_charge_cycle as number,
      royalty_micros: row.royalty_micros as number,
      royalty_cents: row.royalty_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertHardwareOtaUnlockApplication(
    row: Omit<HardwareOtaUnlockApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareOtaUnlockApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_ota_unlock_applications
           (id, source_event_id, feature_code, policy_ref, sensor_licensor_payee_id,
            device_imei_mac, period, currency, micros_per_unlock, licensor_share_bps,
            settlement_micros, settlement_cents, licensor_cents, platform_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.feature_code,
        record.policy_ref,
        record.sensor_licensor_payee_id,
        record.device_imei_mac,
        record.period,
        record.currency,
        record.micros_per_unlock,
        record.licensor_share_bps,
        record.settlement_micros,
        record.settlement_cents,
        record.licensor_cents,
        record.platform_cents,
        record.created_at,
      );
    return record;
  }

  async getHardwareOtaUnlockApplication(
    sourceEventId: string,
  ): Promise<HardwareOtaUnlockApplicationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_ota_unlock_applications WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      feature_code: row.feature_code as string,
      policy_ref: row.policy_ref as string,
      sensor_licensor_payee_id: row.sensor_licensor_payee_id as string,
      device_imei_mac: row.device_imei_mac as string,
      period: row.period as string,
      currency: row.currency as string,
      micros_per_unlock: row.micros_per_unlock as number,
      licensor_share_bps: row.licensor_share_bps as number,
      settlement_micros: row.settlement_micros as number,
      settlement_cents: row.settlement_cents as number,
      licensor_cents: row.licensor_cents as number,
      platform_cents: row.platform_cents as number,
      created_at: row.created_at as string,
    };
  }

  async upsertHardwareCrossLicenseNetSettlement(
    row: Omit<HardwareCrossLicenseNetSettlementRecord, 'id' | 'created_at'>,
  ): Promise<HardwareCrossLicenseNetSettlementRecord> {
    // One net clearing of record per (agreement_ref, period) — the walk's
    // recompute replaces the sums in place (the founder example's
    // full-period netting); the id and created_at of record survive.
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hardware_cross_license_net_settlements
           (id, agreement_ref, company_a_id, company_b_id, period, currency,
            owed_a_to_b_cents, owed_b_to_a_cents, net_cents, direction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agreement_ref, period) DO UPDATE SET
           company_a_id = excluded.company_a_id,
           company_b_id = excluded.company_b_id,
           currency = excluded.currency,
           owed_a_to_b_cents = excluded.owed_a_to_b_cents,
           owed_b_to_a_cents = excluded.owed_b_to_a_cents,
           net_cents = excluded.net_cents,
           direction = excluded.direction`,
      )
      .run(
        id,
        row.agreement_ref,
        row.company_a_id,
        row.company_b_id,
        row.period,
        row.currency,
        row.owed_a_to_b_cents,
        row.owed_b_to_a_cents,
        row.net_cents,
        row.direction,
        createdAt,
      );
    return this.getHardwareCrossLicenseNetSettlement(
      row.agreement_ref,
      row.period,
    ) as Promise<HardwareCrossLicenseNetSettlementRecord>;
  }

  async getHardwareCrossLicenseNetSettlement(
    agreementRef: string,
    period: string,
  ): Promise<HardwareCrossLicenseNetSettlementRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_cross_license_net_settlements
         WHERE agreement_ref = ? AND period = ?`,
      )
      .get(agreementRef, period) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      agreement_ref: row.agreement_ref as string,
      company_a_id: row.company_a_id as string,
      company_b_id: row.company_b_id as string,
      period: row.period as string,
      currency: row.currency as string,
      owed_a_to_b_cents: row.owed_a_to_b_cents as number,
      owed_b_to_a_cents: row.owed_b_to_a_cents as number,
      net_cents: row.net_cents as number,
      direction: row.direction as HardwareCrossLicenseNetSettlementRecord['direction'],
      created_at: row.created_at as string,
    };
  }

  async sumHardwareSepRoyaltiesBetween(
    licenseeId: string,
    payeeId: string,
    period: string,
  ): Promise<number> {
    // The netting walk's liability aggregation — exact integer cents.
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(royalty_cents), 0) AS total
         FROM hardware_sep_royalty_applications
         WHERE licensee_id = ? AND payee_id = ? AND period = ?`,
      )
      .get(licenseeId, payeeId, period) as Record<string, unknown> | undefined;
    return (row?.total as number) ?? 0;
  }

  // -------------------------------------------------------------------------
  // The energy lane (PR 48, migration 0052) — the founder resource
  // directive's registries, posts, and application ledgers.
  // -------------------------------------------------------------------------

  async upsertEnergyLandParcel(
    row: Omit<EnergyLandParcelRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyLandParcelRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_land_parcels (id, parcel_id, parcel_name, region, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (parcel_id) DO UPDATE SET
           parcel_name = excluded.parcel_name,
           region = excluded.region,
           updated_at = excluded.updated_at`,
      )
      .run(id, row.parcel_id, row.parcel_name, row.region, now, now);
    const found = await this.getEnergyLandParcel(row.parcel_id);
    if (found === undefined) {
      throw new Error('energy_land_parcel_upsert_failed');
    }
    return found;
  }

  async getEnergyLandParcel(
    parcelId: string,
  ): Promise<EnergyLandParcelRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM energy_land_parcels WHERE parcel_id = ?`)
      .get(parcelId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      parcel_id: row.parcel_id as string,
      parcel_name: row.parcel_name as string,
      region: row.region as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertEnergyParcelOwnerInterest(
    row: Omit<EnergyParcelOwnerInterestRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyParcelOwnerInterestRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_parcel_owner_interests
           (id, parcel_id, owner_payee_id, owner_name, deeded_acres_micros,
            interest_class, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (parcel_id, owner_payee_id) DO UPDATE SET
           owner_name = excluded.owner_name,
           deeded_acres_micros = excluded.deeded_acres_micros,
           interest_class = excluded.interest_class,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.parcel_id,
        row.owner_payee_id,
        row.owner_name,
        row.deeded_acres_micros,
        row.interest_class,
        now,
        now,
      );
    const found = await this.listEnergyParcelOwnerInterests(row.parcel_id);
    const exact = found.find(
      (candidate: EnergyParcelOwnerInterestRecord) =>
        candidate.owner_payee_id === row.owner_payee_id,
    );
    if (exact === undefined) {
      throw new Error('energy_parcel_owner_interest_upsert_failed');
    }
    return exact;
  }

  async listEnergyParcelOwnerInterests(
    parcelId: string,
  ): Promise<EnergyParcelOwnerInterestRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM energy_parcel_owner_interests
         WHERE parcel_id = ? ORDER BY rowid ASC`,
      )
      .all(parcelId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      parcel_id: row.parcel_id as string,
      owner_payee_id: row.owner_payee_id as string,
      owner_name: row.owner_name as string,
      deeded_acres_micros: row.deeded_acres_micros as number,
      interest_class: row.interest_class as EnergyParcelOwnerInterestRecord['interest_class'],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertEnergyParcelRoyaltyPolicy(
    row: Omit<EnergyParcelRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyParcelRoyaltyPolicyRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_parcel_royalty_policies (id, parcel_id, tier_bands, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (parcel_id) DO UPDATE SET
           tier_bands = excluded.tier_bands,
           updated_at = excluded.updated_at`,
      )
      .run(id, row.parcel_id, row.tier_bands, now, now);
    const found = await this.getEnergyParcelRoyaltyPolicy(row.parcel_id);
    if (found === undefined) {
      throw new Error('energy_parcel_royalty_policy_upsert_failed');
    }
    return found;
  }

  async getEnergyParcelRoyaltyPolicy(
    parcelId: string,
  ): Promise<EnergyParcelRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM energy_parcel_royalty_policies WHERE parcel_id = ?`)
      .get(parcelId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      parcel_id: row.parcel_id as string,
      tier_bands: row.tier_bands as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceEnergyParcelRoyaltyPosition(
    parcelId: string,
    period: string,
    currency: string,
    revenueCentsAdded: number,
    royaltyCentsAdded: number,
  ): Promise<EnergyParcelRoyaltyPositionRecord> {
    // The cumulative position of record — an upsert that ADDS the walk's
    // cents to the (parcel, period, currency) position.
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_parcel_royalty_positions
           (id, parcel_id, period, currency, cumulative_revenue_cents,
            cumulative_royalty_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (parcel_id, period, currency) DO UPDATE SET
           cumulative_revenue_cents = cumulative_revenue_cents + excluded.cumulative_revenue_cents,
           cumulative_royalty_cents = cumulative_royalty_cents + excluded.cumulative_royalty_cents,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        parcelId,
        period,
        currency,
        revenueCentsAdded,
        royaltyCentsAdded,
        now,
        now,
      );
    const found = await this.getEnergyParcelRoyaltyPosition(
      parcelId,
      period,
      currency,
    );
    if (found === undefined) {
      throw new Error('energy_parcel_royalty_position_advance_failed');
    }
    return found;
  }

  async getEnergyParcelRoyaltyPosition(
    parcelId: string,
    period: string,
    currency: string,
  ): Promise<EnergyParcelRoyaltyPositionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_parcel_royalty_positions
         WHERE parcel_id = ? AND period = ? AND currency = ?`,
      )
      .get(parcelId, period, currency) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      parcel_id: row.parcel_id as string,
      period: row.period as string,
      currency: row.currency as string,
      cumulative_revenue_cents: row.cumulative_revenue_cents as number,
      cumulative_royalty_cents: row.cumulative_royalty_cents as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertEnergyComputeYieldPolicy(
    row: Omit<EnergyComputeYieldPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyComputeYieldPolicyRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_compute_yield_policies
           (id, gpu_cluster_hash, sponsor_payee_id, sponsor_payee_name, tier_bands, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (gpu_cluster_hash) DO UPDATE SET
           sponsor_payee_id = excluded.sponsor_payee_id,
           sponsor_payee_name = excluded.sponsor_payee_name,
           tier_bands = excluded.tier_bands,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.gpu_cluster_hash,
        row.sponsor_payee_id,
        row.sponsor_payee_name,
        row.tier_bands,
        now,
        now,
      );
    const found = await this.getEnergyComputeYieldPolicy(row.gpu_cluster_hash);
    if (found === undefined) {
      throw new Error('energy_compute_yield_policy_upsert_failed');
    }
    return found;
  }

  async getEnergyComputeYieldPolicy(
    gpuClusterHash: string,
  ): Promise<EnergyComputeYieldPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_compute_yield_policies WHERE gpu_cluster_hash = ?`,
      )
      .get(gpuClusterHash) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      sponsor_payee_id: row.sponsor_payee_id as string,
      sponsor_payee_name: row.sponsor_payee_name as string,
      tier_bands: row.tier_bands as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async advanceEnergyComputeYieldPosition(
    gpuClusterHash: string,
    period: string,
    currency: string,
    computeRevenueCentsAdded: number,
    yieldCentsAdded: number,
  ): Promise<EnergyComputeYieldPositionRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_compute_yield_positions
           (id, gpu_cluster_hash, period, currency, cumulative_compute_revenue_cents,
            cumulative_yield_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (gpu_cluster_hash, period, currency) DO UPDATE SET
           cumulative_compute_revenue_cents = cumulative_compute_revenue_cents + excluded.cumulative_compute_revenue_cents,
           cumulative_yield_cents = cumulative_yield_cents + excluded.cumulative_yield_cents,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        gpuClusterHash,
        period,
        currency,
        computeRevenueCentsAdded,
        yieldCentsAdded,
        now,
        now,
      );
    const found = await this.getEnergyComputeYieldPosition(
      gpuClusterHash,
      period,
      currency,
    );
    if (found === undefined) {
      throw new Error('energy_compute_yield_position_advance_failed');
    }
    return found;
  }

  async getEnergyComputeYieldPosition(
    gpuClusterHash: string,
    period: string,
    currency: string,
  ): Promise<EnergyComputeYieldPositionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_compute_yield_positions
         WHERE gpu_cluster_hash = ? AND period = ? AND currency = ?`,
      )
      .get(gpuClusterHash, period, currency) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      cumulative_compute_revenue_cents: row.cumulative_compute_revenue_cents as number,
      cumulative_yield_cents: row.cumulative_yield_cents as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertEnergyGridParticipant(
    row: Omit<
      EnergyGridParticipantRegistrationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<EnergyGridParticipantRegistrationRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_grid_participant_registrations
           (id, gpu_cluster_hash, participant_payee_id, participant_payee_name,
            participant_class, weight_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (gpu_cluster_hash, participant_payee_id) DO UPDATE SET
           participant_payee_name = excluded.participant_payee_name,
           participant_class = excluded.participant_class,
           weight_micros = excluded.weight_micros,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.gpu_cluster_hash,
        row.participant_payee_id,
        row.participant_payee_name,
        row.participant_class,
        row.weight_micros,
        now,
        now,
      );
    const found = await this.listEnergyGridParticipants(row.gpu_cluster_hash);
    const exact = found.find(
      (candidate) => candidate.participant_payee_id === row.participant_payee_id,
    );
    if (exact === undefined) {
      throw new Error('energy_grid_participant_upsert_failed');
    }
    return exact;
  }

  async listEnergyGridParticipants(
    gpuClusterHash: string,
  ): Promise<EnergyGridParticipantRegistrationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM energy_grid_participant_registrations
         WHERE gpu_cluster_hash = ? ORDER BY rowid ASC`,
      )
      .all(gpuClusterHash) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      participant_payee_id: row.participant_payee_id as string,
      participant_payee_name: row.participant_payee_name as string,
      participant_class: row.participant_class as EnergyGridParticipantRegistrationRecord['participant_class'],
      weight_micros: row.weight_micros as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertEnergyDivisionOrder(
    row: Omit<EnergyDivisionOrderRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyDivisionOrderRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_division_orders
           (id, order_ref, parcel_id, owner_payee_id, owner_payee_name,
            interest_bps, effective_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (order_ref) DO UPDATE SET
           parcel_id = excluded.parcel_id,
           owner_payee_id = excluded.owner_payee_id,
           owner_payee_name = excluded.owner_payee_name,
           interest_bps = excluded.interest_bps,
           effective_on = excluded.effective_on,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.order_ref,
        row.parcel_id,
        row.owner_payee_id,
        row.owner_payee_name,
        row.interest_bps,
        row.effective_on,
        now,
        now,
      );
    const found = await this.getEnergyDivisionOrder(row.order_ref);
    if (found === undefined) {
      throw new Error('energy_division_order_upsert_failed');
    }
    return found;
  }

  async getEnergyDivisionOrder(
    orderRef: string,
  ): Promise<EnergyDivisionOrderRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM energy_division_orders WHERE order_ref = ?`)
      .get(orderRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      order_ref: row.order_ref as string,
      parcel_id: row.parcel_id as string,
      owner_payee_id: row.owner_payee_id as string,
      owner_payee_name: row.owner_payee_name as string,
      interest_bps: row.interest_bps as number,
      effective_on: row.effective_on as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertEnergyDeedTransfer(
    row: Omit<EnergyDeedTransferRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyDeedTransferRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_deed_transfers
           (id, deed_ref, parcel_id, from_payee_id, to_payee_id,
            transferred_acres_micros, statutory_interest_bps, recorded_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (deed_ref) DO UPDATE SET
           parcel_id = excluded.parcel_id,
           from_payee_id = excluded.from_payee_id,
           to_payee_id = excluded.to_payee_id,
           transferred_acres_micros = excluded.transferred_acres_micros,
           statutory_interest_bps = excluded.statutory_interest_bps,
           recorded_on = excluded.recorded_on,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.deed_ref,
        row.parcel_id,
        row.from_payee_id,
        row.to_payee_id,
        row.transferred_acres_micros,
        row.statutory_interest_bps,
        row.recorded_on,
        now,
        now,
      );
    const found = await this.getEnergyDeedTransfer(row.deed_ref);
    if (found === undefined) {
      throw new Error('energy_deed_transfer_upsert_failed');
    }
    return found;
  }

  async getEnergyDeedTransfer(
    deedRef: string,
  ): Promise<EnergyDeedTransferRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM energy_deed_transfers WHERE deed_ref = ?`)
      .get(deedRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      deed_ref: row.deed_ref as string,
      parcel_id: row.parcel_id as string,
      from_payee_id: row.from_payee_id as string,
      to_payee_id: row.to_payee_id as string,
      transferred_acres_micros: row.transferred_acres_micros as number,
      statutory_interest_bps: row.statutory_interest_bps as number,
      recorded_on: row.recorded_on as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async listEnergyDeedTransfersForParcel(
    parcelId: string,
  ): Promise<EnergyDeedTransferRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM energy_deed_transfers
         WHERE parcel_id = ? ORDER BY rowid ASC`,
      )
      .all(parcelId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      deed_ref: row.deed_ref as string,
      parcel_id: row.parcel_id as string,
      from_payee_id: row.from_payee_id as string,
      to_payee_id: row.to_payee_id as string,
      transferred_acres_micros: row.transferred_acres_micros as number,
      statutory_interest_bps: row.statutory_interest_bps as number,
      recorded_on: row.recorded_on as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  }

  async upsertEnergyCarbonOffsetPolicy(
    row: Omit<EnergyCarbonOffsetPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyCarbonOffsetPolicyRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_carbon_offset_policies
           (id, parcel_id, trust_payee_id, trust_payee_name, developer_payee_id,
            developer_payee_name, micros_per_tonne, trust_share_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (parcel_id) DO UPDATE SET
           trust_payee_id = excluded.trust_payee_id,
           trust_payee_name = excluded.trust_payee_name,
           developer_payee_id = excluded.developer_payee_id,
           developer_payee_name = excluded.developer_payee_name,
           micros_per_tonne = excluded.micros_per_tonne,
           trust_share_bps = excluded.trust_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.parcel_id,
        row.trust_payee_id,
        row.trust_payee_name,
        row.developer_payee_id,
        row.developer_payee_name,
        row.micros_per_tonne,
        row.trust_share_bps,
        now,
        now,
      );
    const found = await this.getEnergyCarbonOffsetPolicy(row.parcel_id);
    if (found === undefined) {
      throw new Error('energy_carbon_offset_policy_upsert_failed');
    }
    return found;
  }

  async getEnergyCarbonOffsetPolicy(
    parcelId: string,
  ): Promise<EnergyCarbonOffsetPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM energy_carbon_offset_policies WHERE parcel_id = ?`)
      .get(parcelId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      parcel_id: row.parcel_id as string,
      trust_payee_id: row.trust_payee_id as string,
      trust_payee_name: row.trust_payee_name as string,
      developer_payee_id: row.developer_payee_id as string,
      developer_payee_name: row.developer_payee_name as string,
      micros_per_tonne: row.micros_per_tonne as number,
      trust_share_bps: row.trust_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertEnergyMeterSalesPost(
    row: Omit<EnergyMeterSalesPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyMeterSalesPostRecord> {
    // UNIQUE per source_event_id — the replay guard.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_meter_sales_posts
           (id, source_event_id, parcel_id, well_meter_id, gpu_cluster_hash,
            period, currency, gross_energy_sales_cents, gross_mineral_sales_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.parcel_id,
        record.well_meter_id,
        record.gpu_cluster_hash,
        record.period,
        record.currency,
        record.gross_energy_sales_cents,
        record.gross_mineral_sales_cents,
        record.created_at,
      );
    return record;
  }

  async getEnergyMeterSalesPost(
    sourceEventId: string,
  ): Promise<EnergyMeterSalesPostRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM energy_meter_sales_posts WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      parcel_id: row.parcel_id as string,
      well_meter_id: row.well_meter_id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_energy_sales_cents: row.gross_energy_sales_cents as number,
      gross_mineral_sales_cents: row.gross_mineral_sales_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertEnergyPipelineDeductionPost(
    row: Omit<EnergyPipelineDeductionPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyPipelineDeductionPostRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_pipeline_deduction_posts
           (id, source_event_id, parcel_id, well_meter_id, gpu_cluster_hash,
            period, currency, transportation_pipeline_deductions_cents,
            grid_transmission_fees_cents, processing_refining_base_fees_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.parcel_id,
        record.well_meter_id,
        record.gpu_cluster_hash,
        record.period,
        record.currency,
        record.transportation_pipeline_deductions_cents,
        record.grid_transmission_fees_cents,
        record.processing_refining_base_fees_cents,
        record.created_at,
      );
    return record;
  }

  async getEnergyPipelineDeductionPost(
    sourceEventId: string,
  ): Promise<EnergyPipelineDeductionPostRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_pipeline_deduction_posts WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      parcel_id: row.parcel_id as string,
      well_meter_id: row.well_meter_id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      transportation_pipeline_deductions_cents:
        row.transportation_pipeline_deductions_cents as number,
      grid_transmission_fees_cents: row.grid_transmission_fees_cents as number,
      processing_refining_base_fees_cents:
        row.processing_refining_base_fees_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertEnergyGpuUtilizationPost(
    row: Omit<EnergyGpuUtilizationPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyGpuUtilizationPostRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_gpu_utilization_posts
           (id, source_event_id, gpu_cluster_hash, period, currency,
            compute_hours_micros, power_draw_kw_micros, compute_revenue_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.gpu_cluster_hash,
        record.period,
        record.currency,
        record.compute_hours_micros,
        record.power_draw_kw_micros,
        record.compute_revenue_cents,
        record.created_at,
      );
    return record;
  }

  async getEnergyGpuUtilizationPost(
    sourceEventId: string,
  ): Promise<EnergyGpuUtilizationPostRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_gpu_utilization_posts WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      compute_hours_micros: row.compute_hours_micros as number,
      power_draw_kw_micros: row.power_draw_kw_micros as number,
      compute_revenue_cents: row.compute_revenue_cents as number,
      created_at: row.created_at as string,
    };
  }

  async sumEnergyRealizationPosts(
    parcelId: string,
    wellMeterId: string,
    gpuClusterHash: string,
    period: string,
    currency: string,
  ): Promise<{
    gross_energy_sales_cents: number;
    gross_mineral_sales_cents: number;
    transportation_pipeline_deductions_cents: number;
    grid_transmission_fees_cents: number;
    processing_refining_base_fees_cents: number;
  }> {
    // The realization recompute's aggregation — the posted meter rows
    // (gross) and pipeline rows (deductions) for the exact key.
    const meterRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(gross_energy_sales_cents), 0) AS gross_energy,
                COALESCE(SUM(gross_mineral_sales_cents), 0) AS gross_mineral
         FROM energy_meter_sales_posts
         WHERE parcel_id = ? AND well_meter_id = ? AND gpu_cluster_hash = ?
           AND period = ? AND currency = ?`,
      )
      .get(parcelId, wellMeterId, gpuClusterHash, period, currency) as
      | Record<string, unknown>
      | undefined;
    const pipelineRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(transportation_pipeline_deductions_cents), 0) AS transportation,
                COALESCE(SUM(grid_transmission_fees_cents), 0) AS grid_fees,
                COALESCE(SUM(processing_refining_base_fees_cents), 0) AS processing
         FROM energy_pipeline_deduction_posts
         WHERE parcel_id = ? AND well_meter_id = ? AND gpu_cluster_hash = ?
           AND period = ? AND currency = ?`,
      )
      .get(parcelId, wellMeterId, gpuClusterHash, period, currency) as
      | Record<string, unknown>
      | undefined;
    return {
      gross_energy_sales_cents: (meterRow?.gross_energy as number) ?? 0,
      gross_mineral_sales_cents: (meterRow?.gross_mineral as number) ?? 0,
      transportation_pipeline_deductions_cents:
        (pipelineRow?.transportation as number) ?? 0,
      grid_transmission_fees_cents: (pipelineRow?.grid_fees as number) ?? 0,
      processing_refining_base_fees_cents:
        (pipelineRow?.processing as number) ?? 0,
    };
  }

  async upsertEnergyNetRealizationApplication(
    row: Omit<
      EnergyNetRealizationApplicationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<EnergyNetRealizationApplicationRecord> {
    // The realization position of record — UNIQUE per the founder's
    // five-tuple; the recompute replaces the sums in place (the id and
    // created_at of record survive — the PR 33 lesson, no id in the
    // conflict payload).
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO energy_net_realization_applications
           (id, source_event_id, parcel_id, well_meter_id, gpu_cluster_hash,
            period, currency, gross_energy_sales_cents, gross_mineral_sales_cents,
            transportation_pipeline_deductions_cents, grid_transmission_fees_cents,
            processing_refining_base_fees_cents, net_realized_resource_pool_cents,
            verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (parcel_id, well_meter_id, gpu_cluster_hash, period, currency) DO UPDATE SET
           source_event_id = excluded.source_event_id,
           gross_energy_sales_cents = excluded.gross_energy_sales_cents,
           gross_mineral_sales_cents = excluded.gross_mineral_sales_cents,
           transportation_pipeline_deductions_cents = excluded.transportation_pipeline_deductions_cents,
           grid_transmission_fees_cents = excluded.grid_transmission_fees_cents,
           processing_refining_base_fees_cents = excluded.processing_refining_base_fees_cents,
           net_realized_resource_pool_cents = excluded.net_realized_resource_pool_cents,
           verdict = excluded.verdict,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        row.source_event_id,
        row.parcel_id,
        row.well_meter_id,
        row.gpu_cluster_hash,
        row.period,
        row.currency,
        row.gross_energy_sales_cents,
        row.gross_mineral_sales_cents,
        row.transportation_pipeline_deductions_cents,
        row.grid_transmission_fees_cents,
        row.processing_refining_base_fees_cents,
        row.net_realized_resource_pool_cents,
        row.verdict,
        now,
        now,
      );
    const found = await this.getEnergyNetRealizationApplication(
      row.source_event_id,
    );
    if (found === undefined) {
      throw new Error('energy_net_realization_upsert_failed');
    }
    return found;
  }

  async getEnergyNetRealizationApplication(
    sourceEventId: string,
  ): Promise<EnergyNetRealizationApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_net_realization_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      parcel_id: row.parcel_id as string,
      well_meter_id: row.well_meter_id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_energy_sales_cents: row.gross_energy_sales_cents as number,
      gross_mineral_sales_cents: row.gross_mineral_sales_cents as number,
      transportation_pipeline_deductions_cents:
        row.transportation_pipeline_deductions_cents as number,
      grid_transmission_fees_cents: row.grid_transmission_fees_cents as number,
      processing_refining_base_fees_cents:
        row.processing_refining_base_fees_cents as number,
      net_realized_resource_pool_cents:
        row.net_realized_resource_pool_cents as number,
      verdict: row.verdict as EnergyNetRealizationApplicationRecord['verdict'],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertEnergyParcelDivisionApplication(
    row: Omit<EnergyParcelDivisionApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyParcelDivisionApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_parcel_division_applications
           (id, source_event_id, parcel_id, period, currency, revenue_basis_cents,
            division_legs, allocated_total_cents, owner_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.parcel_id,
        record.period,
        record.currency,
        record.revenue_basis_cents,
        record.division_legs,
        record.allocated_total_cents,
        record.owner_count,
        record.created_at,
      );
    return record;
  }

  async getEnergyParcelDivisionApplication(
    sourceEventId: string,
  ): Promise<EnergyParcelDivisionApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_parcel_division_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      parcel_id: row.parcel_id as string,
      period: row.period as string,
      currency: row.currency as string,
      revenue_basis_cents: row.revenue_basis_cents as number,
      division_legs: row.division_legs as string,
      allocated_total_cents: row.allocated_total_cents as number,
      owner_count: row.owner_count as number,
      created_at: row.created_at as string,
    };
  }

  async insertEnergyComputeGridSplitApplication(
    row: Omit<EnergyComputeGridSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyComputeGridSplitApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_compute_grid_split_applications
           (id, source_event_id, gpu_cluster_hash, period, currency,
            compute_revenue_cents, split_legs, allocated_total_cents, journal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.gpu_cluster_hash,
        record.period,
        record.currency,
        record.compute_revenue_cents,
        record.split_legs,
        record.allocated_total_cents,
        record.journal_id,
        record.created_at,
      );
    return record;
  }

  async getEnergyComputeGridSplitApplication(
    sourceEventId: string,
  ): Promise<EnergyComputeGridSplitApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_compute_grid_split_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      gpu_cluster_hash: row.gpu_cluster_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      compute_revenue_cents: row.compute_revenue_cents as number,
      split_legs: row.split_legs as string,
      allocated_total_cents: row.allocated_total_cents as number,
      journal_id: (row.journal_id as string | null) ?? null,
      created_at: row.created_at as string,
    };
  }

  async insertEnergyStatutoryInterestApplication(
    row: Omit<EnergyStatutoryInterestApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyStatutoryInterestApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_statutory_interest_applications
           (id, source_event_id, parcel_id, deed_ref, period, currency,
            base_cents, late_days, statutory_interest_bps, interest_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.parcel_id,
        record.deed_ref,
        record.period,
        record.currency,
        record.base_cents,
        record.late_days,
        record.statutory_interest_bps,
        record.interest_cents,
        record.created_at,
      );
    return record;
  }

  async getEnergyStatutoryInterestApplication(
    sourceEventId: string,
  ): Promise<EnergyStatutoryInterestApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_statutory_interest_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      parcel_id: row.parcel_id as string,
      deed_ref: row.deed_ref as string,
      period: row.period as string,
      currency: row.currency as string,
      base_cents: row.base_cents as number,
      late_days: row.late_days as number,
      statutory_interest_bps: row.statutory_interest_bps as number,
      interest_cents: row.interest_cents as number,
      created_at: row.created_at as string,
    };
  }

  async insertEnergyCarbonOffsetPayoutApplication(
    row: Omit<EnergyCarbonOffsetPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyCarbonOffsetPayoutApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_carbon_offset_payout_applications
           (id, source_event_id, parcel_id, registry_ref, period, currency,
            tonnes_verified_micros, micros_per_tonne, trust_share_bps,
            trust_payee_id, trust_payout_cents, developer_payee_id,
            developer_payout_cents, total_payout_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.parcel_id,
        record.registry_ref,
        record.period,
        record.currency,
        record.tonnes_verified_micros,
        record.micros_per_tonne,
        record.trust_share_bps,
        record.trust_payee_id,
        record.trust_payout_cents,
        record.developer_payee_id,
        record.developer_payout_cents,
        record.total_payout_cents,
        record.created_at,
      );
    return record;
  }

  async getEnergyCarbonOffsetPayoutApplication(
    sourceEventId: string,
  ): Promise<EnergyCarbonOffsetPayoutApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_carbon_offset_payout_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      parcel_id: row.parcel_id as string,
      registry_ref: row.registry_ref as string,
      period: row.period as string,
      currency: row.currency as string,
      tonnes_verified_micros: row.tonnes_verified_micros as number,
      micros_per_tonne: row.micros_per_tonne as number,
      trust_share_bps: row.trust_share_bps as number,
      trust_payee_id: row.trust_payee_id as string,
      trust_payout_cents: row.trust_payout_cents as number,
      developer_payee_id: row.developer_payee_id as string,
      developer_payout_cents: row.developer_payout_cents as number,
      total_payout_cents: row.total_payout_cents as number,
      created_at: row.created_at as string,
    };
  }

  // ---------------------------------------------------------------------------
  // PR 49 — the resource audit escrow, the resource payout gate states, and
  // the staged grid-split completion (the instant cascade's journal stamp).
  // ---------------------------------------------------------------------------

  async upsertResourceAuditEscrowPolicy(
    row: Omit<ResourceAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ResourceAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_resource_audit_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.reserve_rate_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getResourceAuditEscrowPolicy(
      record.scope_key,
    ) as Promise<ResourceAuditEscrowPolicyRecord>;
  }

  async getResourceAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<ResourceAuditEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_resource_audit_escrow_policies WHERE scope_key = ?`,
      )
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: row.reserve_rate_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertResourceAuditEscrowDrawdown(
    row: Omit<ResourceAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<ResourceAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — SQLite's constraint throws here, never a double
    // drawdown; the caller re-derives from the append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_resource_audit_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listResourceAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<ResourceAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM energy_resource_audit_escrow_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class:
        row.drawdown_class as ResourceAuditEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: row.drawn_before_cents as number,
      drawn_cents: row.drawn_cents as number,
      remaining_cents: row.remaining_cents as number,
      created_at: row.created_at as string,
    }));
  }

  async insertResourceAuditEscrowReconciliation(
    row: Omit<ResourceAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<ResourceAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; SQLite's constraint throws here (the
    // caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_resource_audit_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.evidence_ref,
        record.reconciled_by,
        record.created_at,
      );
    return record;
  }

  async getResourceAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<ResourceAuditEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_resource_audit_escrow_reconciliations WHERE reserve_ledger_id = ?`,
      )
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settleResourceAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the patent escrow settle rides: only the caller whose
    // WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'resource_audit_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertResourcePayoutGateState(
    row: Omit<ResourcePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ResourcePayoutGateStateRecord> {
    // UNIQUE per (payee_id, parcel_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO energy_resource_payout_gate_states
           (id, payee_id, parcel_id, environmental_compliance_state,
            title_ownership_state, evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, parcel_id) DO UPDATE SET
           environmental_compliance_state = excluded.environmental_compliance_state,
           title_ownership_state = excluded.title_ownership_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.parcel_id,
        record.environmental_compliance_state,
        record.title_ownership_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getResourcePayoutGateState(
      record.payee_id,
      record.parcel_id,
    ) as Promise<ResourcePayoutGateStateRecord>;
  }

  async getResourcePayoutGateState(
    payeeId: string,
    parcelId: string,
  ): Promise<ResourcePayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM energy_resource_payout_gate_states WHERE payee_id = ? AND parcel_id = ?`,
      )
      .get(payeeId, parcelId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      parcel_id: row.parcel_id as string,
      environmental_compliance_state:
        row.environmental_compliance_state as ResourcePayoutGateStateRecord['environmental_compliance_state'],
      title_ownership_state:
        row.title_ownership_state as ResourcePayoutGateStateRecord['title_ownership_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async setEnergyComputeGridSplitJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<EnergyComputeGridSplitApplicationRecord | undefined> {
    // The conditional UPDATE IS the CAS: the journal stamps only while
    // the staged application's journal_id is still null (PR 48 stages
    // the split, PR 49's instant cascade completes it); the caller that
    // lost the race (or replayed) reads undefined.
    const result = this.db
      .prepare(
        `UPDATE energy_compute_grid_split_applications
         SET journal_id = ?
         WHERE source_event_id = ? AND journal_id IS NULL
         RETURNING *`,
      )
      .get(journalId, sourceEventId) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return {
      id: result.id as string,
      source_event_id: result.source_event_id as string,
      gpu_cluster_hash: result.gpu_cluster_hash as string,
      period: result.period as string,
      currency: result.currency as string,
      compute_revenue_cents: result.compute_revenue_cents as number,
      split_legs: result.split_legs as string,
      allocated_total_cents: result.allocated_total_cents as number,
      journal_id: (result.journal_id as string | null) ?? null,
      created_at: result.created_at as string,
    };
  }

  async upsertPatentLitigationEscrowPolicy(
    row: Omit<PatentLitigationEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PatentLitigationEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_patent_litigation_escrow_policies
           (id, scope_key, reserve_rate_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope_key) DO UPDATE SET
           reserve_rate_bps = excluded.reserve_rate_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.scope_key,
        record.reserve_rate_bps,
        record.created_at,
        record.updated_at,
      );
    return this.getPatentLitigationEscrowPolicy(record.scope_key) as Promise<
      PatentLitigationEscrowPolicyRecord
    >;
  }

  async getPatentLitigationEscrowPolicy(
    scopeKey: string,
  ): Promise<PatentLitigationEscrowPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM hardware_patent_litigation_escrow_policies WHERE scope_key = ?`)
      .get(scopeKey) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      scope_key: row.scope_key as string,
      reserve_rate_bps: row.reserve_rate_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertPatentLitigationEscrowDrawdown(
    row: Omit<PatentLitigationEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<PatentLitigationEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_patent_litigation_escrow_drawdowns
           (id, reserve_ledger_id, scope_key, drawdown_class, source_event_id,
            drawn_before_cents, drawn_cents, remaining_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.reserve_ledger_id,
        record.scope_key,
        record.drawdown_class,
        record.source_event_id,
        record.drawn_before_cents,
        record.drawn_cents,
        record.remaining_cents,
        record.created_at,
      );
    return record;
  }

  async listPatentLitigationEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<PatentLitigationEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const rows = this.db
      .prepare(
        `SELECT * FROM hardware_patent_litigation_escrow_drawdowns
         WHERE reserve_ledger_id = ?
         ORDER BY created_at ASC, drawn_before_cents DESC`,
      )
      .all(reserveLedgerId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      scope_key: row.scope_key as string,
      drawdown_class:
        row.drawdown_class as PatentLitigationEscrowDrawdownRecord['drawdown_class'],
      source_event_id: row.source_event_id as string,
      drawn_before_cents: row.drawn_before_cents as number,
      drawn_cents: row.drawn_cents as number,
      remaining_cents: row.remaining_cents as number,
      created_at: row.created_at as string,
    }));
  }

  async insertPatentLitigationEscrowReconciliation(
    row: Omit<PatentLitigationEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<PatentLitigationEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_patent_litigation_escrow_reconciliations
           (id, reserve_ledger_id, evidence_ref, reconciled_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.reserve_ledger_id, record.evidence_ref, record.reconciled_by, record.created_at);
    return record;
  }

  async getPatentLitigationEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<PatentLitigationEscrowReconciliationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_patent_litigation_escrow_reconciliations WHERE reserve_ledger_id = ?`,
      )
      .get(reserveLedgerId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      reserve_ledger_id: row.reserve_ledger_id as string,
      evidence_ref: row.evidence_ref as string,
      reconciled_by: row.reconciled_by as string,
      created_at: row.created_at as string,
    };
  }

  async settlePatentLitigationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional UPDATE IS the CAS — the same single-statement
    // transition the software escrow settle rides: only the caller whose
    // WHERE matched (the escrow was still held) reads the row.
    const result = this.db
      .prepare(
        `UPDATE ledger_transactions
         SET status = 'settled', settled_at = ?
         WHERE id = ? AND status = 'patent_litigation_escrow'
         RETURNING *`,
      )
      .get(settledAt, id) as Record<string, unknown> | undefined;
    if (result === undefined) {
      return undefined;
    }
    return Promise.resolve(result as unknown as LedgerTransactionRecord);
  }

  async upsertHardwarePayoutGateState(
    row: Omit<HardwarePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePayoutGateStateRecord> {
    // UNIQUE per (payee_id, sep_pool_code) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_payout_gate_states
           (id, payee_id, sep_pool_code, frand_determination_state,
            essentiality_audit_state, evidence_ref, verified_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (payee_id, sep_pool_code) DO UPDATE SET
           frand_determination_state = excluded.frand_determination_state,
           essentiality_audit_state = excluded.essentiality_audit_state,
           evidence_ref = excluded.evidence_ref,
           verified_by = excluded.verified_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.payee_id,
        record.sep_pool_code,
        record.frand_determination_state,
        record.essentiality_audit_state,
        record.evidence_ref,
        record.verified_by,
        record.created_at,
        record.updated_at,
      );
    return this.getHardwarePayoutGateState(
      record.payee_id,
      record.sep_pool_code,
    ) as Promise<HardwarePayoutGateStateRecord>;
  }

  async getHardwarePayoutGateState(
    payeeId: string,
    sepPoolCode: string,
  ): Promise<HardwarePayoutGateStateRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM hardware_payout_gate_states WHERE payee_id = ? AND sep_pool_code = ?`,
      )
      .get(payeeId, sepPoolCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      payee_id: row.payee_id as string,
      sep_pool_code: row.sep_pool_code as string,
      frand_determination_state:
        row.frand_determination_state as HardwarePayoutGateStateRecord['frand_determination_state'],
      essentiality_audit_state:
        row.essentiality_audit_state as HardwarePayoutGateStateRecord['essentiality_audit_state'],
      evidence_ref: row.evidence_ref as string,
      verified_by: row.verified_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertHardwareCrossLicenseNetDispatch(
    row: Omit<HardwareCrossLicenseNetDispatchRecord, 'id' | 'created_at'>,
  ): Promise<HardwareCrossLicenseNetDispatchRecord> {
    // UNIQUE per (agreement_ref, period, net_after_cents) — the replay
    // guard AND the concurrency arbiter (insert-as-lock): a replayed
    // trigger at the same settlement state or a lost race throws here,
    // never a double dispatch.
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO hardware_cross_license_net_dispatches
           (id, agreement_ref, company_a_id, company_b_id, period, currency,
            net_before_cents, net_after_cents, dispatched_delta_cents,
            a_gross_cleared_cents, b_gross_cleared_cents, direction, journal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.agreement_ref,
        record.company_a_id,
        record.company_b_id,
        record.period,
        record.currency,
        record.net_before_cents,
        record.net_after_cents,
        record.dispatched_delta_cents,
        record.a_gross_cleared_cents,
        record.b_gross_cleared_cents,
        record.direction,
        record.journal_id,
        record.created_at,
      );
    return record;
  }

  async listHardwareCrossLicenseNetDispatches(
    agreementRef: string,
    period: string,
  ): Promise<HardwareCrossLicenseNetDispatchRecord[]> {
    // Chronological execution order: created_at ASC with net_before_cents
    // ASC as the tiebreak — the cumulative dispatched position strictly
    // advances as dispatches land.
    const rows = this.db
      .prepare(
        `SELECT * FROM hardware_cross_license_net_dispatches
         WHERE agreement_ref = ? AND period = ?
         ORDER BY created_at ASC, net_before_cents ASC`,
      )
      .all(agreementRef, period) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      agreement_ref: row.agreement_ref as string,
      company_a_id: row.company_a_id as string,
      company_b_id: row.company_b_id as string,
      period: row.period as string,
      currency: row.currency as string,
      net_before_cents: row.net_before_cents as number,
      net_after_cents: row.net_after_cents as number,
      dispatched_delta_cents: row.dispatched_delta_cents as number,
      a_gross_cleared_cents: row.a_gross_cleared_cents as number,
      b_gross_cleared_cents: row.b_gross_cleared_cents as number,
      direction: row.direction as HardwareCrossLicenseNetDispatchRecord['direction'],
      journal_id: row.journal_id as string | null,
      created_at: row.created_at as string,
    }));
  }

  // ------------------------------------------------------------------
  // PR 50 — the sports lane. The SQLite mirror of the sports store
  // seam: registry upserts converge on their natural keys, posts are
  // replay-guarded by UNIQUE(source_event_id) (contract_ref for the
  // contracts), and the positions of record replace in place — no id
  // in any conflict payload (the PR 33 lesson).
  // ------------------------------------------------------------------

  async upsertSportsStudentAthleteProfile(
    row: Omit<SportsStudentAthleteProfileRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsStudentAthleteProfileRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_student_athlete_profiles
           (id, athlete_glan, full_name, school_id, union_code, nil_athlete_id,
            wallet_payee_id, eligible, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (athlete_glan) DO UPDATE SET
           full_name = excluded.full_name,
           school_id = excluded.school_id,
           union_code = excluded.union_code,
           nil_athlete_id = excluded.nil_athlete_id,
           wallet_payee_id = excluded.wallet_payee_id,
           eligible = excluded.eligible,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.athlete_glan,
        row.full_name,
        row.school_id,
        row.union_code,
        row.nil_athlete_id,
        row.wallet_payee_id,
        row.eligible ? 1 : 0,
        now,
        now,
      );
    const found = await this.getSportsStudentAthleteProfile(row.athlete_glan);
    if (found === undefined) {
      throw new Error('sports_student_athlete_profile_upsert_failed');
    }
    return found;
  }

  async getSportsStudentAthleteProfile(
    athleteGlan: string,
  ): Promise<SportsStudentAthleteProfileRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_student_athlete_profiles WHERE athlete_glan = ?`)
      .get(athleteGlan) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      athlete_glan: row.athlete_glan as string,
      full_name: row.full_name as string,
      school_id: row.school_id as string,
      union_code: row.union_code as SportsStudentAthleteProfileRecord['union_code'],
      nil_athlete_id: row.nil_athlete_id as string,
      wallet_payee_id: row.wallet_payee_id as string,
      eligible: row.eligible === 1,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async getSportsStudentAthleteProfileByNilAthleteId(
    nilAthleteId: string,
  ): Promise<SportsStudentAthleteProfileRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_student_athlete_profiles WHERE nil_athlete_id = ?`,
      )
      .get(nilAthleteId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      athlete_glan: row.athlete_glan as string,
      full_name: row.full_name as string,
      school_id: row.school_id as string,
      union_code: row.union_code as SportsStudentAthleteProfileRecord['union_code'],
      nil_athlete_id: row.nil_athlete_id as string,
      wallet_payee_id: row.wallet_payee_id as string,
      eligible: row.eligible === 1,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSportsResaleRoyaltyPolicy(
    row: Omit<SportsResaleRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsResaleRoyaltyPolicyRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_resale_royalty_policies
           (id, venue_gln, league_rights_code, promoter_payee_id, promoter_payee_name,
            venue_payee_id, venue_payee_name, league_payee_id, league_payee_name,
            resale_royalty_bps, promoter_share_bps, venue_share_bps, league_share_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_gln, league_rights_code) DO UPDATE SET
           promoter_payee_id = excluded.promoter_payee_id,
           promoter_payee_name = excluded.promoter_payee_name,
           venue_payee_id = excluded.venue_payee_id,
           venue_payee_name = excluded.venue_payee_name,
           league_payee_id = excluded.league_payee_id,
           league_payee_name = excluded.league_payee_name,
           resale_royalty_bps = excluded.resale_royalty_bps,
           promoter_share_bps = excluded.promoter_share_bps,
           venue_share_bps = excluded.venue_share_bps,
           league_share_bps = excluded.league_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.venue_gln,
        row.league_rights_code,
        row.promoter_payee_id,
        row.promoter_payee_name,
        row.venue_payee_id,
        row.venue_payee_name,
        row.league_payee_id,
        row.league_payee_name,
        row.resale_royalty_bps,
        row.promoter_share_bps,
        row.venue_share_bps,
        row.league_share_bps,
        now,
        now,
      );
    const found = await this.getSportsResaleRoyaltyPolicy(
      row.venue_gln,
      row.league_rights_code,
    );
    if (found === undefined) {
      throw new Error('sports_resale_royalty_policy_upsert_failed');
    }
    return found;
  }

  async getSportsResaleRoyaltyPolicy(
    venueGln: string,
    leagueRightsCode: string,
  ): Promise<SportsResaleRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_resale_royalty_policies
           WHERE venue_gln = ? AND league_rights_code = ?`,
      )
      .get(venueGln, leagueRightsCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      venue_gln: row.venue_gln as string,
      league_rights_code: row.league_rights_code as string,
      promoter_payee_id: row.promoter_payee_id as string,
      promoter_payee_name: row.promoter_payee_name as string,
      venue_payee_id: row.venue_payee_id as string,
      venue_payee_name: row.venue_payee_name as string,
      league_payee_id: row.league_payee_id as string,
      league_payee_name: row.league_payee_name as string,
      resale_royalty_bps: row.resale_royalty_bps as number,
      promoter_share_bps: row.promoter_share_bps as number,
      venue_share_bps: row.venue_share_bps as number,
      league_share_bps: row.league_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSportsLeaguePoolPolicy(
    row: Omit<SportsLeaguePoolPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeaguePoolPolicyRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_league_pool_policies
           (id, league_rights_code, equal_share_bps, market_balance_bps,
            performance_incentive_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (league_rights_code) DO UPDATE SET
           equal_share_bps = excluded.equal_share_bps,
           market_balance_bps = excluded.market_balance_bps,
           performance_incentive_bps = excluded.performance_incentive_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.league_rights_code,
        row.equal_share_bps,
        row.market_balance_bps,
        row.performance_incentive_bps,
        now,
        now,
      );
    const found = await this.getSportsLeaguePoolPolicy(row.league_rights_code);
    if (found === undefined) {
      throw new Error('sports_league_pool_policy_upsert_failed');
    }
    return found;
  }

  async getSportsLeaguePoolPolicy(
    leagueRightsCode: string,
  ): Promise<SportsLeaguePoolPolicyRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_league_pool_policies WHERE league_rights_code = ?`)
      .get(leagueRightsCode) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      league_rights_code: row.league_rights_code as string,
      equal_share_bps: row.equal_share_bps as number,
      market_balance_bps: row.market_balance_bps as number,
      performance_incentive_bps: row.performance_incentive_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSportsLeagueTeam(
    row: Omit<SportsLeagueTeamRegistrationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeagueTeamRegistrationRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_league_team_registrations
           (id, league_rights_code, team_code, owner_payee_id, owner_payee_name,
            market_size_micros, payroll_micros, cap_threshold_micros,
            performance_incentive_bps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (league_rights_code, team_code) DO UPDATE SET
           owner_payee_id = excluded.owner_payee_id,
           owner_payee_name = excluded.owner_payee_name,
           market_size_micros = excluded.market_size_micros,
           payroll_micros = excluded.payroll_micros,
           cap_threshold_micros = excluded.cap_threshold_micros,
           performance_incentive_bps = excluded.performance_incentive_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.league_rights_code,
        row.team_code,
        row.owner_payee_id,
        row.owner_payee_name,
        row.market_size_micros,
        row.payroll_micros,
        row.cap_threshold_micros,
        row.performance_incentive_bps,
        now,
        now,
      );
    const found = this.db
      .prepare(
        `SELECT * FROM sports_league_team_registrations
           WHERE league_rights_code = ? AND team_code = ?`,
      )
      .get(row.league_rights_code, row.team_code) as Record<string, unknown> | undefined;
    if (found === undefined) {
      throw new Error('sports_league_team_upsert_failed');
    }
    return this.projectSportsLeagueTeam(found);
  }

  private projectSportsLeagueTeam(
    row: Record<string, unknown>,
  ): SportsLeagueTeamRegistrationRecord {
    return {
      id: row.id as string,
      league_rights_code: row.league_rights_code as string,
      team_code: row.team_code as string,
      owner_payee_id: row.owner_payee_id as string,
      owner_payee_name: row.owner_payee_name as string,
      market_size_micros: row.market_size_micros as number,
      payroll_micros: row.payroll_micros as number,
      cap_threshold_micros: row.cap_threshold_micros as number,
      performance_incentive_bps: row.performance_incentive_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async listSportsLeagueTeams(
    leagueRightsCode: string,
  ): Promise<SportsLeagueTeamRegistrationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM sports_league_team_registrations
           WHERE league_rights_code = ? ORDER BY team_code ASC`,
      )
      .all(leagueRightsCode) as Record<string, unknown>[];
    return rows.map((row) => this.projectSportsLeagueTeam(row));
  }

  async upsertSportsBiometricRoyaltyPolicy(
    row: Omit<SportsBiometricRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsBiometricRoyaltyPolicyRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_biometric_royalty_policies
           (id, league_rights_code, licensee_class, league_data_payee_id,
            league_data_payee_name, micros_per_unit, athlete_share_bps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (league_rights_code, licensee_class) DO UPDATE SET
           league_data_payee_id = excluded.league_data_payee_id,
           league_data_payee_name = excluded.league_data_payee_name,
           micros_per_unit = excluded.micros_per_unit,
           athlete_share_bps = excluded.athlete_share_bps,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.league_rights_code,
        row.licensee_class,
        row.league_data_payee_id,
        row.league_data_payee_name,
        row.micros_per_unit,
        row.athlete_share_bps,
        now,
        now,
      );
    const found = await this.getSportsBiometricRoyaltyPolicy(
      row.league_rights_code,
      row.licensee_class,
    );
    if (found === undefined) {
      throw new Error('sports_biometric_royalty_policy_upsert_failed');
    }
    return found;
  }

  async getSportsBiometricRoyaltyPolicy(
    leagueRightsCode: string,
    licenseeClass: SportsLicenseeClass,
  ): Promise<SportsBiometricRoyaltyPolicyRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_biometric_royalty_policies
           WHERE league_rights_code = ? AND licensee_class = ?`,
      )
      .get(leagueRightsCode, licenseeClass) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      league_rights_code: row.league_rights_code as string,
      licensee_class: row.licensee_class as SportsLicenseeClass,
      league_data_payee_id: row.league_data_payee_id as string,
      league_data_payee_name: row.league_data_payee_name as string,
      micros_per_unit: row.micros_per_unit as number,
      athlete_share_bps: row.athlete_share_bps as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSportsTicketSalePost(
    row: Omit<SportsTicketSalePostRecord, 'id' | 'created_at'>,
  ): Promise<SportsTicketSalePostRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_ticket_sale_posts
           (id, source_event_id, nil_contract_id, athlete_glan, venue_gln,
            league_rights_code, turnstile_scan_hash, period, currency,
            gross_ticket_revenue_cents, facility_surcharges_cents,
            municipal_taxes_cents, insurance_reserves_cents,
            processor_fee_cuts_cents, ticket_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.nil_contract_id,
        record.athlete_glan,
        record.venue_gln,
        record.league_rights_code,
        record.turnstile_scan_hash,
        record.period,
        record.currency,
        record.gross_ticket_revenue_cents,
        record.facility_surcharges_cents,
        record.municipal_taxes_cents,
        record.insurance_reserves_cents,
        record.processor_fee_cuts_cents,
        record.ticket_count,
        record.created_at,
      );
    return record;
  }

  private projectSportsTicketSalePost(
    row: Record<string, unknown>,
  ): SportsTicketSalePostRecord {
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_glan: row.athlete_glan as string,
      venue_gln: row.venue_gln as string,
      league_rights_code: row.league_rights_code as string,
      turnstile_scan_hash: row.turnstile_scan_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_ticket_revenue_cents: row.gross_ticket_revenue_cents as number,
      facility_surcharges_cents: row.facility_surcharges_cents as number,
      municipal_taxes_cents: row.municipal_taxes_cents as number,
      insurance_reserves_cents: row.insurance_reserves_cents as number,
      processor_fee_cuts_cents: row.processor_fee_cuts_cents as number,
      ticket_count: row.ticket_count as number,
      created_at: row.created_at as string,
    };
  }

  async getSportsTicketSalePost(
    sourceEventId: string,
  ): Promise<SportsTicketSalePostRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_ticket_sale_posts WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.projectSportsTicketSalePost(row);
  }

  async insertSportsResaleSalePost(
    row: Omit<SportsResaleSalePostRecord, 'id' | 'created_at'>,
  ): Promise<SportsResaleSalePostRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_resale_sale_posts
           (id, source_event_id, venue_gln, league_rights_code,
            resale_gross_cents, period, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.venue_gln,
        record.league_rights_code,
        record.resale_gross_cents,
        record.period,
        record.currency,
        record.created_at,
      );
    return record;
  }

  async getSportsResaleSalePost(
    sourceEventId: string,
  ): Promise<SportsResaleSalePostRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_resale_sale_posts WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      venue_gln: row.venue_gln as string,
      league_rights_code: row.league_rights_code as string,
      resale_gross_cents: row.resale_gross_cents as number,
      period: row.period as string,
      currency: row.currency as string,
      created_at: row.created_at as string,
    };
  }

  async insertSportsTurnstileScanPost(
    row: Omit<SportsTurnstileScanPostRecord, 'id' | 'created_at'>,
  ): Promise<SportsTurnstileScanPostRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_turnstile_scan_posts
           (id, source_event_id, venue_gln, turnstile_scan_hash, scan_count,
            period, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.venue_gln,
        record.turnstile_scan_hash,
        record.scan_count,
        record.period,
        record.currency,
        record.created_at,
      );
    return record;
  }

  async getSportsTurnstileScanPost(
    sourceEventId: string,
  ): Promise<SportsTurnstileScanPostRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_turnstile_scan_posts WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      venue_gln: row.venue_gln as string,
      turnstile_scan_hash: row.turnstile_scan_hash as string,
      scan_count: row.scan_count as number,
      period: row.period as string,
      currency: row.currency as string,
      created_at: row.created_at as string,
    };
  }

  async insertSportsBiometricTrackingPost(
    row: Omit<SportsBiometricTrackingPostRecord, 'id' | 'created_at'>,
  ): Promise<SportsBiometricTrackingPostRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_biometric_tracking_posts
           (id, source_event_id, athlete_glan, league_rights_code,
            tracking_modality, licensee_class, licensed_quantity_micros,
            period, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.athlete_glan,
        record.league_rights_code,
        record.tracking_modality,
        record.licensee_class,
        record.licensed_quantity_micros,
        record.period,
        record.currency,
        record.created_at,
      );
    return record;
  }

  async getSportsBiometricTrackingPost(
    sourceEventId: string,
  ): Promise<SportsBiometricTrackingPostRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_biometric_tracking_posts WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      athlete_glan: row.athlete_glan as string,
      league_rights_code: row.league_rights_code as string,
      tracking_modality: row.tracking_modality as SportsBiometricTrackingPostRecord['tracking_modality'],
      licensee_class: row.licensee_class as SportsBiometricTrackingPostRecord['licensee_class'],
      licensed_quantity_micros: row.licensed_quantity_micros as number,
      period: row.period as string,
      currency: row.currency as string,
      created_at: row.created_at as string,
    };
  }

  async insertSportsBroadcastingContract(
    row: Omit<SportsBroadcastingContractRecord, 'id' | 'created_at'>,
  ): Promise<SportsBroadcastingContractRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_broadcasting_contracts
           (id, contract_ref, league_rights_code, contract_class,
            contract_gross_cents, royalty_pool_cents, union_code,
            union_share_bps, athlete_roster_json, period, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.contract_ref,
        record.league_rights_code,
        record.contract_class,
        record.contract_gross_cents,
        record.royalty_pool_cents,
        record.union_code,
        record.union_share_bps,
        record.athlete_roster_json,
        record.period,
        record.currency,
        record.created_at,
      );
    return record;
  }

  async getSportsBroadcastingContract(
    contractRef: string,
  ): Promise<SportsBroadcastingContractRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_broadcasting_contracts WHERE contract_ref = ?`)
      .get(contractRef) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      contract_ref: row.contract_ref as string,
      league_rights_code: row.league_rights_code as string,
      contract_class: row.contract_class as SportsBroadcastingContractRecord['contract_class'],
      contract_gross_cents: row.contract_gross_cents as number,
      royalty_pool_cents: row.royalty_pool_cents as number,
      union_code: row.union_code as SportsBroadcastingContractRecord['union_code'],
      union_share_bps: row.union_share_bps as number,
      athlete_roster_json: row.athlete_roster_json as string,
      period: row.period as string,
      currency: row.currency as string,
      created_at: row.created_at as string,
    };
  }

  async sumSportsGateLegs(
    nilContractId: string,
    athleteGlan: string,
    venueGln: string,
    leagueRightsCode: string,
    turnstileScanHash: string,
    period: string,
    currency: string,
  ): Promise<{
    gross_ticket_revenue_cents: number;
    facility_surcharges_cents: number;
    municipal_taxes_cents: number;
    insurance_reserves_cents: number;
    processor_fee_cuts_cents: number;
    ticket_count: number;
  }> {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(gross_ticket_revenue_cents), 0) AS gross_ticket_revenue_cents,
           COALESCE(SUM(facility_surcharges_cents), 0) AS facility_surcharges_cents,
           COALESCE(SUM(municipal_taxes_cents), 0) AS municipal_taxes_cents,
           COALESCE(SUM(insurance_reserves_cents), 0) AS insurance_reserves_cents,
           COALESCE(SUM(processor_fee_cuts_cents), 0) AS processor_fee_cuts_cents,
           COALESCE(SUM(ticket_count), 0) AS ticket_count
         FROM sports_ticket_sale_posts
         WHERE nil_contract_id = ? AND athlete_glan = ? AND venue_gln = ?
           AND league_rights_code = ? AND turnstile_scan_hash = ?
           AND period = ? AND currency = ?`,
      )
      .get(
        nilContractId,
        athleteGlan,
        venueGln,
        leagueRightsCode,
        turnstileScanHash,
        period,
        currency,
      ) as Record<string, unknown>;
    return {
      gross_ticket_revenue_cents: row.gross_ticket_revenue_cents as number,
      facility_surcharges_cents: row.facility_surcharges_cents as number,
      municipal_taxes_cents: row.municipal_taxes_cents as number,
      insurance_reserves_cents: row.insurance_reserves_cents as number,
      processor_fee_cuts_cents: row.processor_fee_cuts_cents as number,
      ticket_count: row.ticket_count as number,
    };
  }

  async listSportsTicketSaleKeysForHash(
    venueGln: string,
    turnstileScanHash: string,
  ): Promise<
    Array<{
      nil_contract_id: string;
      athlete_glan: string;
      venue_gln: string;
      league_rights_code: string;
      turnstile_scan_hash: string;
      period: string;
      currency: string;
    }>
  > {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT nil_contract_id, athlete_glan, venue_gln,
                league_rights_code, turnstile_scan_hash, period, currency
         FROM sports_ticket_sale_posts
         WHERE venue_gln = ? AND turnstile_scan_hash = ?`,
      )
      .all(venueGln, turnstileScanHash) as Record<string, unknown>[];
    return rows.map((row) => ({
      nil_contract_id: row.nil_contract_id as string,
      athlete_glan: row.athlete_glan as string,
      venue_gln: row.venue_gln as string,
      league_rights_code: row.league_rights_code as string,
      turnstile_scan_hash: row.turnstile_scan_hash as string,
      period: row.period as string,
      currency: row.currency as string,
    }));
  }

  async sumSportsGateReconciliationSides(
    venueGln: string,
    period: string,
    currency: string,
  ): Promise<{
    ticket_count_sum: number;
    scan_count_sum: number;
    gross_ticket_revenue_cents: number;
  }> {
    const ticketRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(ticket_count), 0) AS ticket_count_sum,
                COALESCE(SUM(gross_ticket_revenue_cents), 0) AS gross_ticket_revenue_cents
         FROM sports_ticket_sale_posts
         WHERE venue_gln = ? AND period = ? AND currency = ?`,
      )
      .get(venueGln, period, currency) as Record<string, unknown>;
    const scanRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(scan_count), 0) AS scan_count_sum
         FROM sports_turnstile_scan_posts
         WHERE venue_gln = ? AND period = ? AND currency = ?`,
      )
      .get(venueGln, period, currency) as Record<string, unknown>;
    return {
      ticket_count_sum: ticketRow.ticket_count_sum as number,
      scan_count_sum: scanRow.scan_count_sum as number,
      gross_ticket_revenue_cents: ticketRow.gross_ticket_revenue_cents as number,
    };
  }

  async upsertSportsGateReconciliation(
    row: Omit<SportsGateReconciliationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsGateReconciliationRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_gate_reconciliations
           (id, source_event_id, venue_gln, period, currency,
            ticket_count_sum, scan_count_sum, variance_scan_delta,
            gross_ticket_revenue_cents, verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_gln, period, currency) DO UPDATE SET
           source_event_id = excluded.source_event_id,
           ticket_count_sum = excluded.ticket_count_sum,
           scan_count_sum = excluded.scan_count_sum,
           variance_scan_delta = excluded.variance_scan_delta,
           gross_ticket_revenue_cents = excluded.gross_ticket_revenue_cents,
           verdict = excluded.verdict,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.source_event_id,
        row.venue_gln,
        row.period,
        row.currency,
        row.ticket_count_sum,
        row.scan_count_sum,
        row.variance_scan_delta,
        row.gross_ticket_revenue_cents,
        row.verdict,
        now,
        now,
      );
    const found = await this.getSportsGateReconciliation(row.source_event_id);
    if (found === undefined) {
      throw new Error('sports_gate_reconciliation_upsert_failed');
    }
    return found;
  }

  async getSportsGateReconciliation(
    sourceEventId: string,
  ): Promise<SportsGateReconciliationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_gate_reconciliations WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      venue_gln: row.venue_gln as string,
      period: row.period as string,
      currency: row.currency as string,
      ticket_count_sum: row.ticket_count_sum as number,
      scan_count_sum: row.scan_count_sum as number,
      variance_scan_delta: row.variance_scan_delta as number,
      gross_ticket_revenue_cents: row.gross_ticket_revenue_cents as number,
      verdict: row.verdict as SportsGateReconciliationRecord['verdict'],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async upsertSportsNetVenueRealization(
    row: Omit<SportsNetVenueRealizationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsNetVenueRealizationRecord> {
    // The realization position of record — UNIQUE per the founder's
    // tuple; the recompute replaces the sums in place (no id in the
    // conflict payload — the PR 33 lesson).
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_net_venue_realizations
           (id, source_event_id, nil_contract_id, athlete_glan, venue_gln,
            league_rights_code, turnstile_scan_hash, period, currency,
            gross_ticket_revenue_cents, facility_surcharges_cents,
            municipal_taxes_cents, insurance_reserves_cents,
            processor_fee_cuts_cents, net_gate_pool_cents,
            gate_reconciliation_event_id, gate_reconciliation_verdict,
            verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (nil_contract_id, athlete_glan, venue_gln,
                      league_rights_code, turnstile_scan_hash, period, currency)
         DO UPDATE SET
           source_event_id = excluded.source_event_id,
           gross_ticket_revenue_cents = excluded.gross_ticket_revenue_cents,
           facility_surcharges_cents = excluded.facility_surcharges_cents,
           municipal_taxes_cents = excluded.municipal_taxes_cents,
           insurance_reserves_cents = excluded.insurance_reserves_cents,
           processor_fee_cuts_cents = excluded.processor_fee_cuts_cents,
           net_gate_pool_cents = excluded.net_gate_pool_cents,
           gate_reconciliation_event_id = excluded.gate_reconciliation_event_id,
           gate_reconciliation_verdict = excluded.gate_reconciliation_verdict,
           verdict = excluded.verdict,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.source_event_id,
        row.nil_contract_id,
        row.athlete_glan,
        row.venue_gln,
        row.league_rights_code,
        row.turnstile_scan_hash,
        row.period,
        row.currency,
        row.gross_ticket_revenue_cents,
        row.facility_surcharges_cents,
        row.municipal_taxes_cents,
        row.insurance_reserves_cents,
        row.processor_fee_cuts_cents,
        row.net_gate_pool_cents,
        row.gate_reconciliation_event_id,
        row.gate_reconciliation_verdict,
        row.verdict,
        now,
        now,
      );
    const found = await this.getSportsNetVenueRealization(row.source_event_id);
    if (found === undefined) {
      throw new Error('sports_net_venue_realization_upsert_failed');
    }
    return found;
  }

  async getSportsNetVenueRealization(
    sourceEventId: string,
  ): Promise<SportsNetVenueRealizationRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sports_net_venue_realizations WHERE source_event_id = ?`)
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_glan: row.athlete_glan as string,
      venue_gln: row.venue_gln as string,
      league_rights_code: row.league_rights_code as string,
      turnstile_scan_hash: row.turnstile_scan_hash as string,
      period: row.period as string,
      currency: row.currency as string,
      gross_ticket_revenue_cents: row.gross_ticket_revenue_cents as number,
      facility_surcharges_cents: row.facility_surcharges_cents as number,
      municipal_taxes_cents: row.municipal_taxes_cents as number,
      insurance_reserves_cents: row.insurance_reserves_cents as number,
      processor_fee_cuts_cents: row.processor_fee_cuts_cents as number,
      net_gate_pool_cents: row.net_gate_pool_cents as number,
      gate_reconciliation_event_id: row.gate_reconciliation_event_id as string,
      gate_reconciliation_verdict:
        row.gate_reconciliation_verdict as SportsNetVenueRealizationRecord['gate_reconciliation_verdict'],
      verdict: row.verdict as SportsNetVenueRealizationRecord['verdict'],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSportsResaleRoyaltyApplication(
    row: Omit<SportsResaleRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsResaleRoyaltyApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_resale_royalty_applications
           (id, source_event_id, resale_sale_event_id, venue_gln,
            league_rights_code, resale_gross_cents, resale_royalty_bps,
            promoter_share_bps, venue_share_bps, league_share_bps,
            royalty_pot_cents, promoter_leg_cents, venue_leg_cents,
            league_leg_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.resale_sale_event_id,
        record.venue_gln,
        record.league_rights_code,
        record.resale_gross_cents,
        record.resale_royalty_bps,
        record.promoter_share_bps,
        record.venue_share_bps,
        record.league_share_bps,
        record.royalty_pot_cents,
        record.promoter_leg_cents,
        record.venue_leg_cents,
        record.league_leg_cents,
        record.created_at,
      );
    return record;
  }

  async getSportsResaleRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SportsResaleRoyaltyApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_resale_royalty_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      resale_sale_event_id: row.resale_sale_event_id as string,
      venue_gln: row.venue_gln as string,
      league_rights_code: row.league_rights_code as string,
      resale_gross_cents: row.resale_gross_cents as number,
      resale_royalty_bps: row.resale_royalty_bps as number,
      promoter_share_bps: row.promoter_share_bps as number,
      venue_share_bps: row.venue_share_bps as number,
      league_share_bps: row.league_share_bps as number,
      royalty_pot_cents: row.royalty_pot_cents as number,
      promoter_leg_cents: row.promoter_leg_cents as number,
      venue_leg_cents: row.venue_leg_cents as number,
      league_leg_cents: row.league_leg_cents as number,
      created_at: row.created_at as string,
    };
  }

  async sumSportsLeaguePoolContractGross(
    leagueRightsCode: string,
    period: string,
    currency: string,
  ): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(contract_gross_cents), 0) AS pool_cents
         FROM sports_broadcasting_contracts
         WHERE league_rights_code = ? AND period = ? AND currency = ?`,
      )
      .get(leagueRightsCode, period, currency) as Record<string, unknown>;
    return row.pool_cents as number;
  }

  async upsertSportsLeaguePoolDistribution(
    row: Omit<SportsLeaguePoolDistributionRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeaguePoolDistributionRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_league_pool_distributions
           (id, source_event_id, league_rights_code, period, currency,
            pool_cents, equal_share_bps, market_balance_bps,
            performance_incentive_bps, legs_json, distributed_cents,
            dust_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (league_rights_code, period, currency) DO UPDATE SET
           source_event_id = excluded.source_event_id,
           pool_cents = excluded.pool_cents,
           equal_share_bps = excluded.equal_share_bps,
           market_balance_bps = excluded.market_balance_bps,
           performance_incentive_bps = excluded.performance_incentive_bps,
           legs_json = excluded.legs_json,
           distributed_cents = excluded.distributed_cents,
           dust_cents = excluded.dust_cents,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.source_event_id,
        row.league_rights_code,
        row.period,
        row.currency,
        row.pool_cents,
        row.equal_share_bps,
        row.market_balance_bps,
        row.performance_incentive_bps,
        row.legs_json,
        row.distributed_cents,
        row.dust_cents,
        now,
        now,
      );
    const found = await this.getSportsLeaguePoolDistribution(row.source_event_id);
    if (found === undefined) {
      throw new Error('sports_league_pool_distribution_upsert_failed');
    }
    return found;
  }

  async getSportsLeaguePoolDistribution(
    sourceEventId: string,
  ): Promise<SportsLeaguePoolDistributionRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_league_pool_distributions WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      league_rights_code: row.league_rights_code as string,
      period: row.period as string,
      currency: row.currency as string,
      pool_cents: row.pool_cents as number,
      equal_share_bps: row.equal_share_bps as number,
      market_balance_bps: row.market_balance_bps as number,
      performance_incentive_bps: row.performance_incentive_bps as number,
      legs_json: row.legs_json as string,
      distributed_cents: row.distributed_cents as number,
      dust_cents: row.dust_cents as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSportsGroupLicensingApplication(
    row: Omit<SportsGroupLicensingApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsGroupLicensingApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_group_licensing_applications
           (id, source_event_id, contract_ref, league_rights_code, union_code,
            union_payee_id, union_share_bps, royalty_pool_cents,
            union_leg_cents, athlete_pool_cents, athlete_wallets_json,
            wallet_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.contract_ref,
        record.league_rights_code,
        record.union_code,
        record.union_payee_id,
        record.union_share_bps,
        record.royalty_pool_cents,
        record.union_leg_cents,
        record.athlete_pool_cents,
        record.athlete_wallets_json,
        record.wallet_count,
        record.created_at,
      );
    return record;
  }

  async getSportsGroupLicensingApplication(
    sourceEventId: string,
  ): Promise<SportsGroupLicensingApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_group_licensing_applications WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      contract_ref: row.contract_ref as string,
      league_rights_code: row.league_rights_code as string,
      union_code: row.union_code as SportsGroupLicensingApplicationRecord['union_code'],
      union_payee_id: row.union_payee_id as string,
      union_share_bps: row.union_share_bps as number,
      royalty_pool_cents: row.royalty_pool_cents as number,
      union_leg_cents: row.union_leg_cents as number,
      athlete_pool_cents: row.athlete_pool_cents as number,
      athlete_wallets_json: row.athlete_wallets_json as string,
      wallet_count: row.wallet_count as number,
      created_at: row.created_at as string,
    };
  }

  async listNilPayoutApplicationsForAthlete(
    athleteId: string,
    period: string,
  ): Promise<NilPayoutApplicationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM nil_payout_applications
           WHERE athlete_id = ? AND period = ? ORDER BY source_event_id ASC`,
      )
      .all(athleteId, period) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_id: row.athlete_id as string,
      school_id: row.school_id as string,
      source_event_id: row.source_event_id as string,
      period: row.period as string,
      gross_cents: row.gross_cents as number,
      agency_mode: row.agency_mode as NilPayoutApplicationRecord['agency_mode'],
      agency_bps: row.agency_bps as number,
      agency_fee_cents: row.agency_fee_cents as number,
      net_payout_cents: row.net_payout_cents as number,
      verdict: row.verdict as NilPayoutApplicationRecord['verdict'],
      state_rule_ref: row.state_rule_ref as string | null,
      cap_verified_ref: row.cap_verified_ref as string | null,
      created_at: row.created_at as string,
    }));
  }

  async upsertSportsNilDealReconciliation(
    row: Omit<SportsNilDealReconciliationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsNilDealReconciliationRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sports_nil_deal_reconciliations
           (id, source_event_id, nil_contract_id, athlete_glan, period,
            endorsement_deal_cents, booster_collective_cents,
            fan_club_subscription_cents, nil_deal_gross_cents, verdict,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (nil_contract_id, athlete_glan, period) DO UPDATE SET
           source_event_id = excluded.source_event_id,
           endorsement_deal_cents = excluded.endorsement_deal_cents,
           booster_collective_cents = excluded.booster_collective_cents,
           fan_club_subscription_cents = excluded.fan_club_subscription_cents,
           nil_deal_gross_cents = excluded.nil_deal_gross_cents,
           verdict = excluded.verdict,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        row.source_event_id,
        row.nil_contract_id,
        row.athlete_glan,
        row.period,
        row.endorsement_deal_cents,
        row.booster_collective_cents,
        row.fan_club_subscription_cents,
        row.nil_deal_gross_cents,
        row.verdict,
        now,
        now,
      );
    const found = await this.getSportsNilDealReconciliation(row.source_event_id);
    if (found === undefined) {
      throw new Error('sports_nil_deal_reconciliation_upsert_failed');
    }
    return found;
  }

  async getSportsNilDealReconciliation(
    sourceEventId: string,
  ): Promise<SportsNilDealReconciliationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_nil_deal_reconciliations WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      nil_contract_id: row.nil_contract_id as string,
      athlete_glan: row.athlete_glan as string,
      period: row.period as string,
      endorsement_deal_cents: row.endorsement_deal_cents as number,
      booster_collective_cents: row.booster_collective_cents as number,
      fan_club_subscription_cents: row.fan_club_subscription_cents as number,
      nil_deal_gross_cents: row.nil_deal_gross_cents as number,
      verdict: row.verdict as SportsNilDealReconciliationRecord['verdict'],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async insertSportsBiometricMicroPayoutApplication(
    row: Omit<SportsBiometricMicroPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord> {
    const record = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sports_biometric_micro_payout_applications
           (id, source_event_id, biometric_post_event_id, athlete_glan,
            league_rights_code, tracking_modality, licensee_class,
            licensed_quantity_micros, micros_per_unit, athlete_share_bps,
            payout_pot_cents, athlete_wallet_payee_id, athlete_leg_cents,
            league_data_payee_id, league_leg_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.source_event_id,
        record.biometric_post_event_id,
        record.athlete_glan,
        record.league_rights_code,
        record.tracking_modality,
        record.licensee_class,
        record.licensed_quantity_micros,
        record.micros_per_unit,
        record.athlete_share_bps,
        record.payout_pot_cents,
        record.athlete_wallet_payee_id,
        record.athlete_leg_cents,
        record.league_data_payee_id,
        record.league_leg_cents,
        record.created_at,
      );
    return record;
  }

  async getSportsBiometricMicroPayoutApplication(
    sourceEventId: string,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM sports_biometric_micro_payout_applications
           WHERE source_event_id = ?`,
      )
      .get(sourceEventId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      biometric_post_event_id: row.biometric_post_event_id as string,
      athlete_glan: row.athlete_glan as string,
      league_rights_code: row.league_rights_code as string,
      tracking_modality: row.tracking_modality as SportsBiometricMicroPayoutApplicationRecord['tracking_modality'],
      licensee_class: row.licensee_class as SportsBiometricMicroPayoutApplicationRecord['licensee_class'],
      licensed_quantity_micros: row.licensed_quantity_micros as number,
      micros_per_unit: row.micros_per_unit as number,
      athlete_share_bps: row.athlete_share_bps as number,
      payout_pot_cents: row.payout_pot_cents as number,
      athlete_wallet_payee_id: row.athlete_wallet_payee_id as string,
      athlete_leg_cents: row.athlete_leg_cents as number,
      league_data_payee_id: row.league_data_payee_id as string,
      league_leg_cents: row.league_leg_cents as number,
      created_at: row.created_at as string,
    };
  }
}

/** Default DB location: data/atxlive.db under the project root (gitignored). */
export function defaultDbPath(): string {
  return process.env.ATXLIVE_DB_PATH ?? path.join(process.cwd(), 'data', 'atxlive.db');
}
