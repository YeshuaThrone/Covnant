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
  type CreatorYtdIncrement,
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
  LicensingTreatyRateRecord,
  LicensingSubLicenseeRecord,
  LicensingSubLicenseReportRecord,
} from '@/modules/licensing/records';
import type {
  NilCapVerificationRecord,
  NilDealComplianceAuditRecord,
  NilGroupSplitRecord,
  NilPayoutApplicationRecord,
  NilPayoutGateStateRecord,
  NilAuditEscrowDrawdownRecord,
  NilAuditEscrowPolicyRecord,
  NilAuditEscrowReconciliationRecord,
  NilAdvanceScheduleRecord,
  NilTransferPortalEntryRecord,
  NilUnearnedClawbackRecord,
  NilPoolApplicationRecord,
  NilRevenueShareProgramRecord,
  NilRosterWaterfallRecord,
  NilSchoolCapRecord,
  NilStateRuleRecord,
} from '@/modules/nil/records';
import type {
  SportsBiometricRoyaltyPolicyRecord,
  SportsBiometricTrackingPostRecord,
  SportsBiometricMicroPayoutApplicationRecord,
  SportsBroadcastingContractRecord,
  SportsGateReconciliationRecord,
  SportsLeaguePoolDistributionRecord,
  SportsLeaguePoolPolicyRecord,
  SportsLeagueTeamRegistrationRecord,
  SportsLicenseeClass,
  SportsNetVenueRealizationRecord,
  SportsNilDealReconciliationRecord,
  SportsResaleRoyaltyApplicationRecord,
  SportsResaleRoyaltyPolicyRecord,
  SportsStudentAthleteProfileRecord,
  SportsTicketSalePostRecord,
  SportsResaleSalePostRecord,
  SportsTurnstileScanPostRecord,
  SportsGroupLicensingApplicationRecord,
  SportsPayoutGateStateRecord,
} from '@/modules/sports/records';
import type {
  EventCancellationEscrowDrawdownRecord,
  EventCancellationEscrowPolicyRecord,
} from '@/modules/sports/records';
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
  ServiceAuditEscrowDrawdownRecord,
  ServiceAuditEscrowPolicyRecord,
  ServiceAuditEscrowReconciliationRecord,
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
  ServicesPayoutGateStateRecord,
} from '@/modules/service/records';
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
  HardwareCrossLicenseNetDispatchRecord,
  HardwareCrossLicenseNetSettlementRecord,
  HardwareOtaUnlockApplicationRecord,
  HardwareOtaUnlockPolicyRecord,
  HardwarePatentPoolRecord,
  HardwarePayoutGateStateRecord,
  HardwarePoolHolderLegRecord,
  HardwarePoolRoutingApplicationRecord,
  HardwarePoolWaterfallApplicationRecord,
  HardwareRealizationApplicationRecord,
  HardwareSepRoyaltyApplicationRecord,
  HardwareSepRoyaltyPolicyRecord,
  HardwareSepUnitMonthRecord,
  HardwareTelemetryRoyaltyApplicationRecord,
  PatentLitigationEscrowDrawdownRecord,
  PatentLitigationEscrowPolicyRecord,
  PatentLitigationEscrowReconciliationRecord,
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
  // Migration 0024 — the webtoon studio split registry + per-language
  // translation cascades (PR 20). Roles are the per-series production
  // contract; contracts key each foreign-language feed; the cost
  // schedule/lines are the VTuber amortization discipline; the pools +
  // applications carry the print-advance/digital-coin isolation (pool
  // UNIQUE per (series, class), applications UNIQUE per (pool, source
  // event) — the replay guard).
  webtoonStudioSplitRoles: 'webtoon_studio_split_roles',
  webtoonLocalizationContracts: 'webtoon_localization_contracts',
  webtoonLocalizationCostSchedules: 'webtoon_localization_cost_schedules',
  webtoonLocalizationCostLines: 'webtoon_localization_cost_lines',
  webtoonRecoupmentPools: 'webtoon_recoupment_pools',
  webtoonRecoupmentApplications: 'webtoon_recoupment_applications',
  // Migration 0025 — the IP adaptation option contract + author-first
  // cascade state (PR 21). The agreement is the option deal of record per
  // work (upsert on work_id); the author-side allocations are the ordered,
  // ring-fenced shares reserved before any agency commission (UNIQUE per
  // (work, payee)); the verifications carry the durable ip_rights_cleared
  // state the publishing payout gate reads (UNIQUE per (payee, work)).
  ipOptionAgreements: 'ip_option_agreements',
  ipOptionAuthorAllocations: 'ip_option_author_allocations',
  publishingIpRightsVerifications: 'publishing_ip_rights_verifications',
  // Migration 0026 — the merch COGS + collaboration waterfall layer (PR 22):
  // production lots and their append-only FIFO consumption truth, the
  // collab agreement of record per sku, the append-only overhead-recoupment
  // ledger, the designer royalty tiers and their per-fulfillment-event
  // billings, and the durable consignment settlement reconciliation.
  merchCogsLots: 'merch_cogs_lots',
  merchCogsConsumptions: 'merch_cogs_consumptions',
  merchCollabAgreements: 'merch_collab_agreements',
  merchCollabRecoupmentApplications: 'merch_collab_recoupment_applications',
  merchDesignerRoyaltyTiers: 'merch_designer_royalty_tiers',
  merchDesignerRoyaltyBillings: 'merch_designer_royalty_billings',
  merchConsignmentSettlements: 'merch_consignment_settlements',
  // Migration 0027 — the merch returns reserve + fulfillment confirmation
  // layer (PR 23): the per-sku founder-banded holdback policy, the
  // append-only reserve drawdown truth (the 0026 position-lock discipline
  // at reserve scope), and the fulfillment tracking events the merch
  // payout gate's physical_fulfillment_confirmed condition reads.
  merchReturnReservePolicies: 'merch_return_reserve_policies',
  merchReserveDrawdowns: 'merch_reserve_drawdowns',
  merchFulfillmentTrackings: 'merch_fulfillment_trackings',
  // Migration 0028 — the AI model registry (PR 24): one model's nested
  // derivative split contract terms (UNIQUE per model) and the
  // contributors' registered dataset token weights (UNIQUE per model+payee
  // — a re-shipped attribution log converges). The recon posting pass's
  // terms of record and the unattributed pool's fallback inputs.
  aiModelSplitTerms: 'ai_model_split_terms',
  aiModelContributions: 'ai_model_contributions',
  // Migration 0029 (PR 25) — the AI training dispute freeze, the AI
  // payout-gate states, the dataset deprecations, and the allocation
  // archives that retire historical attributions without touching the
  // append-only ledger rows.
  aiTrainingDisputes: 'ai_training_disputes',
  aiPayoutGateStates: 'ai_payout_gate_states',
  aiDatasetDeprecations: 'ai_dataset_deprecations',
  aiDatasetAllocationArchives: 'ai_dataset_allocation_archives',
  // Migration 0030 (PR 26) — the book editorial split ledger: the schedule
  // of record per title_key (upsert on title_key), the sequential advance
  // pools (UNIQUE per (isbn, class, sequence_no)), their append-only
  // application truth (replay + position uniques), and the executed split
  // accruals (UNIQUE per source_event_id).
  bookEditorialSplitSchedules: 'book_editorial_split_schedules',
  bookRecoupmentPools: 'book_recoupment_pools',
  bookRecoupmentApplications: 'book_recoupment_applications',
  bookEditorialSplitAccruals: 'book_editorial_split_accruals',
  artSplitSchedules: 'art_split_schedules',
  artRecoupmentPools: 'art_recoupment_pools',
  artRecoupmentApplications: 'art_recoupment_applications',
  artSplitAccruals: 'art_split_accruals',
  artLicensingAgencyPolicies: 'art_licensing_agency_policies',
  // Migration 0033 (PR 29) — the estate succession + multi-heir splitting
  // layer: the verified legal certificate of record per
  // (artist_payee_id, certificate_ref), the probate split schedule of
  // record per certificate (upsert on certificate_id), the append-only
  // receiving-entity transition ledger (UNIQUE per
  // (certificate_id, source_event_id)), the executed multi-heir accruals
  // (UNIQUE per (certificate_id, artwork_id, source_event_id) — the
  // provenance triple is the once-only key), and the per-payee payout
  // gate states the art vertical resolves through (fail-closed).
  estateSuccessionCertificates: 'estate_succession_certificates',
  estateHeirSchedules: 'estate_heir_schedules',
  estateSuccessionTransitions: 'estate_succession_transitions',
  estateSplitAccruals: 'estate_split_accruals',
  estatePayoutGateStates: 'estate_payout_gate_states',
  // Migration 0031 (PR 27) — the foreign tax hold + book returns reserve
  // layer: the withholding-tax-credit verification of record per
  // (country_code, tax_year) and the ISBN rights verification of record per
  // isbn (the fail-closed evidence states), the per-ISBN founder-banded
  // returns-reserve policy (upsert on isbn), the append-only reserve
  // drawdown truth (replay + position uniques), the publisher return
  // chargebacks of record (UNIQUE per event_id), and the append-only
  // offset applications that recover an outstanding chargeback from an
  // incoming POD net balance before author payouts release.
  withholdingTaxCreditVerifications: 'withholding_tax_credit_verifications',
  isbnRightsVerifications: 'isbn_rights_verifications',
  bookReturnsReservePolicies: 'book_returns_reserve_policies',
  bookReserveDrawdowns: 'book_reserve_drawdowns',
  bookReturnChargebacks: 'book_return_chargebacks',
  bookChargebackOffsetApplications: 'book_chargeback_offset_applications',
  // Migration 0023 — the film multi-territory withholding log + territory
  // envelopes (PR 18). The withholding log is the per-line, pre-conversion
  // foreign-tax evidence; the envelopes are the per-territory routing
  // decisions behind the cross-collateralization firewall.
  filmTerritoryWithholdings: 'film_territory_withholdings',
  filmTerritoryDistributions: 'film_territory_distributions',
  // Migration 0034 — the AGBOR box office + theatrical recoupment tables
  // (PR 30). Versioned production deals of record, per-stop settlement
  // sheets, investor recoupment applications, and split accruals.
  theatricalProductionDeals: 'theatrical_production_deals',
  theatricalStopSettlements: 'theatrical_stop_settlements',
  theatricalRecoupmentApplications: 'theatrical_recoupment_applications',
  theatricalSplitAccruals: 'theatrical_split_accruals',
  // Migration 0035 — the promoter settlement audit closes of record (the
  // escrow release's fail-closed gate), the theater payout gate states per
  // (payee, production) — grand_rights_cleared / venue_settlement_reconciled
  // — and the founder-banded venue hall fee policies per (tour, venue).
  promoterSettlementAudits: 'promoter_settlement_audits',
  theatricalPayoutGateStates: 'theatrical_payout_gate_states',
  venueHallFeePolicies: 'venue_hall_fee_policies',
  licensingRoyaltyDeals: 'licensing_royalty_deals',
  licensingRoyaltyApplications: 'licensing_royalty_applications',
  licensingTreatyRates: 'licensing_treaty_rates',
  licensingSubLicensees: 'licensing_sub_licensees',
  licensingSubLicenseReports: 'licensing_sub_license_reports',
  // Migration 0037 — the advance/MG recoupment ledger, the automatic
  // shortfall invoice of record, the founder-banded audit reserve escrow's
  // policy/reconciliation/drawdown state, and the fail-closed licensing
  // payout gate states per (payee, scope).
  licensingMgCommitments: 'licensing_mg_commitments',
  licensingMgRecoupmentApplications: 'licensing_mg_recoupment_applications',
  licensingMgTermCloses: 'licensing_mg_term_closes',
  licensingAuditReservePolicies: 'licensing_audit_reserve_policies',
  licensingAuditReserveReconciliations: 'licensing_audit_reserve_reconciliations',
  licensingAuditReserveDrawdowns: 'licensing_audit_reserve_drawdowns',
  licensingPayoutGateStates: 'licensing_payout_gate_states',
  nilRevenueSharePrograms: 'nil_revenue_share_programs',
  nilRosterWaterfalls: 'nil_roster_waterfalls',
  nilSchoolCaps: 'nil_school_caps',
  nilCapVerifications: 'nil_cap_verifications',
  nilDealComplianceAudits: 'nil_deal_compliance_audits',
  nilPayoutApplications: 'nil_payout_applications',
  nilPoolApplications: 'nil_pool_applications',
  nilGroupSplits: 'nil_group_splits',
  nilStateRules: 'nil_state_rules',
  nilPayoutGateStates: 'nil_payout_gate_states',
  nilAuditEscrowPolicies: 'nil_audit_escrow_policies',
  nilAuditEscrowDrawdowns: 'nil_audit_escrow_drawdowns',
  nilAuditEscrowReconciliations: 'nil_audit_escrow_reconciliations',
  nilAdvanceSchedules: 'nil_advance_schedules',
  nilTransferPortalEntries: 'nil_transfer_portal_entries',
  nilUnearnedClawbacks: 'nil_unearned_clawbacks',
  spatialOccupancyTierSchedules: 'spatial_occupancy_tier_schedules',
  spatialOverheadPolicies: 'spatial_overhead_policies',
  spatialZoneAssignments: 'spatial_zone_assignments',
  spatialMicroPolicies: 'spatial_micro_policies',
  spatialThroughputYears: 'spatial_throughput_years',
  spatialRoyaltyApplications: 'spatial_royalty_applications',
  spatialZoneAllocations: 'spatial_zone_allocations',
  spatialMicroRoyalties: 'spatial_micro_royalty_ledger',
  spatialCapexCommitments: 'spatial_capex_commitments',
  spatialCapexApplications: 'spatial_capex_applications',
  spatialMsgCommitments: 'spatial_msg_commitments',
  spatialMsgTermCloses: 'spatial_msg_term_closes',
  spatialPopupExperiences: 'spatial_popup_experiences',
  spatialPopupWriteoffs: 'spatial_popup_writeoffs',
  spatialPopupRestorationReserves: 'spatial_popup_restoration_reserves',
  spatialAuditEscrowPolicies: 'spatial_audit_escrow_policies',
  spatialAuditEscrowDrawdowns: 'spatial_audit_escrow_drawdowns',
  spatialAuditEscrowReconciliations: 'spatial_audit_escrow_reconciliations',
  spatialPayoutGateStates: 'spatial_payout_gate_states',
  // Migration 0042 — the fitness lane.
  fitnessTrainerTierSchedules: 'fitness_trainer_tier_schedules',
  fitnessCompletionMonths: 'fitness_completion_months',
  fitnessSyncMusicPolicies: 'fitness_sync_music_policies',
  fitnessLiveLoadPolicies: 'fitness_live_load_policies',
  fitnessFranchisePolicies: 'fitness_franchise_policies',
  fitnessFranchiseClassMonths: 'fitness_franchise_class_months',
  fitnessCoBrandPartnerships: 'fitness_co_brand_partnerships',
  fitnessAlgorithmPolicies: 'fitness_algorithm_policies',
  fitnessCocreationModules: 'fitness_cocreation_modules',
  fitnessRealizationApplications: 'fitness_realization_applications',
  fitnessTrainerRoyaltyApplications: 'fitness_trainer_royalty_applications',
  fitnessLiveResidualApplications: 'fitness_live_residual_applications',
  fitnessFranchiseApplications: 'fitness_franchise_applications',
  fitnessCobrandSplitApplications: 'fitness_cobrand_split_applications',
  fitnessAlgorithmRoyaltyLedger: 'fitness_algorithm_royalty_ledger',
  fitnessCocreationApplications: 'fitness_cocreation_applications',
  // Migration 0043 — the fitness audit escrow + payout gate states + the
  // instant live-event bonus ledger.
  fitnessAuditEscrowPolicies: 'fitness_audit_escrow_policies',
  fitnessAuditEscrowDrawdowns: 'fitness_audit_escrow_drawdowns',
  fitnessAuditEscrowReconciliations: 'fitness_audit_escrow_reconciliations',
  fitnessPayoutGateStates: 'fitness_payout_gate_states',
  fitnessLiveEventBonusPolicies: 'fitness_live_event_bonus_policies',
  fitnessLiveEventBonuses: 'fitness_live_event_bonuses',
  // Migration 0044 — the food lane (the founder food directive).
  foodRecipeRoyaltySchedules: 'food_recipe_royalty_schedules',
  foodLocationUnitMonths: 'food_location_unit_months',
  foodHostOperatorPolicies: 'food_host_operator_policies',
  foodCookCyclePolicies: 'food_cook_cycle_policies',
  foodCobrandWeightings: 'food_cobrand_weightings',
  foodOperatorWaterfalls: 'food_operator_waterfalls',
  foodRealizationApplications: 'food_realization_applications',
  foodRecipeRoyaltyApplications: 'food_recipe_royalty_applications',
  foodCobrandSplitApplications: 'food_cobrand_split_applications',
  foodHostOperatorSplitApplications: 'food_host_operator_split_applications',
  foodCookCycleRoyalties: 'food_cook_cycle_royalties',
  foodSupplierRebateApplications: 'food_supplier_rebate_applications',
  // Migration 0045 — the culinary audit escrow, the payout gate states,
  // and the viral-menu pop-up decommissioning facts.
  culinaryAuditEscrowPolicies: 'culinary_audit_escrow_policies',
  culinaryAuditEscrowDrawdowns: 'culinary_audit_escrow_drawdowns',
  culinaryAuditEscrowReconciliations: 'culinary_audit_escrow_reconciliations',
  culinaryPayoutGateStates: 'culinary_payout_gate_states',
  culinaryPopupExperiences: 'culinary_popup_experiences',
  culinaryPopupWriteoffs: 'culinary_popup_writeoffs',
  // Migration 0046 — the service lane: franchise schedules, protocol
  // micro-royalty policies, redemption and breakage policies, the vendor
  // rebate waterfall, booth-lease policy, and the application ledgers.
  serviceFranchiseSchedules: 'service_franchise_schedules',
  serviceProtocolPolicies: 'service_protocol_policies',
  serviceRedemptionPolicies: 'service_redemption_policies',
  serviceBreakagePolicies: 'service_breakage_policies',
  serviceRebateWaterfalls: 'service_rebate_waterfalls',
  serviceBoothLeasePolicies: 'service_booth_lease_policies',
  serviceRealizationApplications: 'service_realization_applications',
  serviceFranchiseSplitApplications: 'service_franchise_split_applications',
  serviceProtocolMicroRoyalties: 'service_protocol_micro_royalties',
  serviceRedemptionSplitApplications: 'service_redemption_split_applications',
  serviceBreakageAllocations: 'service_breakage_allocations',
  serviceRebateApplications: 'service_rebate_applications',
  serviceBoothLeaseApplications: 'service_booth_lease_applications',
  // Migration 0047 — the service audit escrow (the founder services
  // directive) and the services payout gate states it reads fail-closed.
  serviceAuditEscrowPolicies: 'service_audit_escrow_policies',
  serviceAuditEscrowDrawdowns: 'service_audit_escrow_drawdowns',
  serviceAuditEscrowReconciliations: 'service_audit_escrow_reconciliations',
  servicesPayoutGateStates: 'services_payout_gate_states',
  // SOFTWARE_AUDIT_ESCROW + the software payout gate states (PR 45,
  // migration 0049).
  softwareAuditEscrowPolicies: 'software_audit_escrow_policies',
  softwareAuditEscrowDrawdowns: 'software_audit_escrow_drawdowns',
  softwareAuditEscrowReconciliations: 'software_audit_escrow_reconciliations',
  softwarePayoutGateStates: 'software_payout_gate_states',
  // PATENT_LITIGATION_ESCROW + the hardware payout gate states + the
  // cross-license net dispatches (PR 47, migration 0051).
  patentLitigationEscrowPolicies: 'hardware_patent_litigation_escrow_policies',
  patentLitigationEscrowDrawdowns: 'hardware_patent_litigation_escrow_drawdowns',
  patentLitigationEscrowReconciliations: 'hardware_patent_litigation_escrow_reconciliations',
  hardwarePayoutGateStates: 'hardware_payout_gate_states',
  hardwareCrossLicenseNetDispatches: 'hardware_cross_license_net_dispatches',
  // Migration 0048 — the developer lane: the royalty/split/ledger/deal
  // registries, the two cumulative monthly trackers, and the seven
  // application ledgers.
  developerApiRoyaltyPolicies: 'developer_api_royalty_policies',
  developerApiCallMonths: 'developer_api_call_months',
  developerMarketplaceSplitPolicies: 'developer_marketplace_split_policies',
  developerCopackageContributionLegs: 'developer_copackage_contribution_legs',
  developerDependencyMaintainerLedgers: 'developer_dependency_maintainer_ledgers',
  developerWhitelabelLicenseDeals: 'developer_whitelabel_license_deals',
  developerToolRoyaltyPolicies: 'developer_tool_royalty_policies',
  developerApiRealizationApplications: 'developer_api_realization_applications',
  developerApiMicroRoyaltyApplications: 'developer_api_micro_royalty_applications',
  developerMarketplaceSplitApplications: 'developer_marketplace_split_applications',
  developerCopackageSplitApplications: 'developer_copackage_split_applications',
  developerDependencyFeeApplications: 'developer_dependency_fee_applications',
  developerWhitelabelLicenseApplications: 'developer_whitelabel_license_applications',
  developerWhitelabelUsageMonths: 'developer_whitelabel_usage_months',
  developerAgentToolCallApplications: 'developer_agent_tool_call_applications',

  // The hardware patent lane (migration 0050, PR 46, the founder hardware
  // directive) — the registries, tracker, and application ledgers.
  hardwarePatentPools: 'hardware_patent_pools',
  hardwarePoolHolderLegs: 'hardware_pool_holder_legs',
  hardwareSepRoyaltyPolicies: 'hardware_sep_royalty_policies',
  hardwareAutomotivePoolAssignments: 'hardware_automotive_pool_assignments',
  hardwareCleanTechRoyaltyPolicies: 'hardware_cleantech_royalty_policies',
  hardwareOtaUnlockPolicies: 'hardware_ota_unlock_policies',
  hardwareCrossLicenseAgreements: 'hardware_cross_license_agreements',
  hardwareSepUnitMonths: 'hardware_sep_unit_months',
  hardwareRealizationApplications: 'hardware_realization_applications',
  hardwareSepRoyaltyApplications: 'hardware_sep_royalty_applications',
  hardwarePoolRoutingApplications: 'hardware_pool_routing_applications',
  hardwarePoolWaterfallApplications: 'hardware_pool_waterfall_applications',
  hardwareTelemetryRoyaltyApplications: 'hardware_telemetry_royalty_applications',
  hardwareOtaUnlockApplications: 'hardware_ota_unlock_applications',
  hardwareCrossLicenseNetSettlements: 'hardware_cross_license_net_settlements',

  // The energy lane (migration 0052, PR 48, the founder resource
  // directive) — the registries, posts, and application ledgers.
  energyLandParcels: 'energy_land_parcels',
  energyParcelOwnerInterests: 'energy_parcel_owner_interests',
  energyParcelRoyaltyPolicies: 'energy_parcel_royalty_policies',
  energyParcelRoyaltyPositions: 'energy_parcel_royalty_positions',
  energyComputeYieldPolicies: 'energy_compute_yield_policies',
  energyComputeYieldPositions: 'energy_compute_yield_positions',
  energyGridParticipants: 'energy_grid_participant_registrations',
  energyDivisionOrders: 'energy_division_orders',
  energyDeedTransfers: 'energy_deed_transfers',
  energyCarbonOffsetPolicies: 'energy_carbon_offset_policies',
  energyMeterSalesPosts: 'energy_meter_sales_posts',
  energyPipelineDeductionPosts: 'energy_pipeline_deduction_posts',
  energyGpuUtilizationPosts: 'energy_gpu_utilization_posts',
  energyNetRealizationApplications: 'energy_net_realization_applications',
  energyParcelDivisionApplications: 'energy_parcel_division_applications',
  energyComputeGridSplitApplications: 'energy_compute_grid_split_applications',
  energyStatutoryInterestApplications: 'energy_statutory_interest_applications',
  energyCarbonOffsetPayoutApplications: 'energy_carbon_offset_payout_applications',
  resourceAuditEscrowPolicies: 'energy_resource_audit_escrow_policies',
  resourceAuditEscrowDrawdowns: 'energy_resource_audit_escrow_drawdowns',
  resourceAuditEscrowReconciliations: 'energy_resource_audit_escrow_reconciliations',
  resourcePayoutGateStates: 'energy_resource_payout_gate_states',

  // PR 50 — the sports lane (mirrors the SQLite DDL table names).
  sportsStudentAthleteProfiles: 'sports_student_athlete_profiles',
  sportsResaleRoyaltyPolicies: 'sports_resale_royalty_policies',
  sportsLeaguePoolPolicies: 'sports_league_pool_policies',
  sportsLeagueTeamRegistrations: 'sports_league_team_registrations',
  sportsBiometricRoyaltyPolicies: 'sports_biometric_royalty_policies',
  sportsTicketSalePosts: 'sports_ticket_sale_posts',
  sportsResaleSalePosts: 'sports_resale_sale_posts',
  sportsTurnstileScanPosts: 'sports_turnstile_scan_posts',
  sportsBiometricTrackingPosts: 'sports_biometric_tracking_posts',
  sportsBroadcastingContracts: 'sports_broadcasting_contracts',
  sportsGateReconciliations: 'sports_gate_reconciliations',
  sportsNetVenueRealizations: 'sports_net_venue_realizations',
  sportsResaleRoyaltyApplications: 'sports_resale_royalty_applications',
  sportsLeaguePoolDistributions: 'sports_league_pool_distributions',
  sportsGroupLicensingApplications: 'sports_group_licensing_applications',
  sportsNilDealReconciliations: 'sports_nil_deal_reconciliations',
  sportsBiometricMicroPayoutApplications:
    'sports_biometric_micro_payout_applications',

  // PR 51 — the event cancellation escrow and the sports payout gate
  // states (mirrors the SQLite DDL table names).
  sportsEventCancellationEscrowPolicies:
    'sports_event_cancellation_escrow_policies',
  sportsEventCancellationEscrowDrawdowns:
    'sports_event_cancellation_escrow_drawdowns',
  sportsPayoutGateStates: 'sports_payout_gate_states',
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

  async upsertAiModelSplitTerms(
    terms: Omit<AiModelSplitTermsRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiModelSplitTermsRecord> {
    // UNIQUE per ai_model_id — the upsert targets the model key, so a
    // re-registered contract replaces the row atomically (the newest
    // contract governs the next ingest, never a duplicate).
    return this.oneStrict<AiModelSplitTermsRecord>(
      this.client
        .from(TABLES.aiModelSplitTerms)
        .upsert(
          { ...terms, id: crypto.randomUUID() },
          { onConflict: 'ai_model_id' },
        )
        .select()
        .maybeSingle(),
      'upsertAiModelSplitTerms',
    );
  }

  async getAiModelSplitTerms(
    aiModelId: string,
  ): Promise<AiModelSplitTermsRecord | undefined> {
    return this.one<AiModelSplitTermsRecord>(
      this.client
        .from(TABLES.aiModelSplitTerms)
        .select()
        .eq('ai_model_id', aiModelId)
        .maybeSingle(),
      'getAiModelSplitTerms',
    );
  }

  async upsertAiModelContribution(
    contribution: Omit<
      AiModelContributionRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<AiModelContributionRecord> {
    // UNIQUE per (ai_model_id, contributor_payee_id) — a re-shipped
    // attribution log converges; the newest weight governs.
    return this.oneStrict<AiModelContributionRecord>(
      this.client
        .from(TABLES.aiModelContributions)
        .upsert(
          { ...contribution, id: crypto.randomUUID() },
          { onConflict: 'ai_model_id,contributor_payee_id' },
        )
        .select()
        .maybeSingle(),
      'upsertAiModelContribution',
    );
  }

  async listAiModelContributions(
    aiModelId: string,
  ): Promise<AiModelContributionRecord[]> {
    // Write order — the registry's own audit order (created_at ASC, the
    // devex log read's tiebreak; the synthetic insertion_order column does
    // not exist on this table).
    return this.many<AiModelContributionRecord>(
      this.client
        .from(TABLES.aiModelContributions)
        .select()
        .eq('ai_model_id', aiModelId)
        .order('created_at', { ascending: true }),
      'listAiModelContributions',
    );
  }

  // --- AI training dispute freeze + payout gate states + dataset
  // --- deprecations (migration 0029, PR 25)

  async insertAiTrainingDispute(
    row: Omit<AiTrainingDisputeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiTrainingDisputeRecord> {
    // UNIQUE per (ai_model_id, dataset_version, rights_holder_payee_id) —
    // a re-filed dispute surfaces the unique violation (23505); the
    // caller recovers by reading the existing row.
    const now = new Date().toISOString();
    return this.oneStrict<AiTrainingDisputeRecord>(
      this.client
        .from(TABLES.aiTrainingDisputes)
        .insert({ ...row, id: crypto.randomUUID(), created_at: now, updated_at: now })
        .select()
        .maybeSingle(),
      'insertAiTrainingDispute',
    );
  }

  async getAiTrainingDispute(
    id: string,
  ): Promise<AiTrainingDisputeRecord | undefined> {
    return this.one<AiTrainingDisputeRecord>(
      this.client
        .from(TABLES.aiTrainingDisputes)
        .select()
        .eq('id', id)
        .maybeSingle(),
      'getAiTrainingDispute',
    );
  }

  async listAiTrainingDisputes(
    status?: AiTrainingDisputeStatus,
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<AiTrainingDisputeRecord[]> {
    // Newest first (created_at DESC, id DESC as the strict tiebreak).
    let query = this.client
      .from(TABLES.aiTrainingDisputes)
      .select()
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (status !== undefined) {
      query = query.eq('status', status);
    }
    return this.many<AiTrainingDisputeRecord>(
      query,
      'listAiTrainingDisputes',
    );
  }

  async resolveAiTrainingDispute(
    id: string,
    resolution: {
      resolution_notes: string | null;
      resolved_by: string;
      resolved_at: string;
    },
  ): Promise<AiTrainingDisputeRecord | undefined> {
    // THE VERIFIED RESOLUTION PATH's CAS — the UPDATE's WHERE pins
    // status = 'filed': only the first resolver wins, the concurrent
    // resolution loser reads undefined. PostgREST's .select() returns the
    // rows the original filters matched (empty = not the winner).
    const resolved = await this.many<AiTrainingDisputeRecord>(
      this.client
        .from(TABLES.aiTrainingDisputes)
        .update({
          status: 'resolved',
          resolution_notes: resolution.resolution_notes,
          resolved_by: resolution.resolved_by,
          resolved_at: resolution.resolved_at,
          updated_at: resolution.resolved_at,
        })
        .eq('id', id)
        .eq('status', 'filed')
        .select(),
      'resolveAiTrainingDispute',
    );
    return resolved[0];
  }

  async freezeUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number> {
    // The FREEZE CAS sweep — the batch-settlement precedent: the status
    // predicate in the UPDATE's WHERE only flips still-held legs of the
    // model's ingest scope, and the returned row count is the honest
    // report of what this call froze (a re-file's sweep is a no-op).
    const frozen = await this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'unauthorized_training_hold' })
        .eq('split_run_id', modelLedgerScope)
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'unclaimed_holding')
        .select(),
      'freezeUnauthorizedTrainingHolds',
    );
    return frozen.length;
  }

  async thawUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number> {
    // The THAW CAS sweep — the verified resolution's ledger leg: ONLY the
    // scope's 'unauthorized_training_hold' legs return to holding.
    const thawed = await this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'unclaimed_holding' })
        .eq('split_run_id', modelLedgerScope)
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'unauthorized_training_hold')
        .select(),
      'thawUnauthorizedTrainingHolds',
    );
    return thawed.length;
  }

  async listUnauthorizedTrainingHolds(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    // The frozen-leg work queue — a thawed leg leaves the listing.
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'unauthorized_training_hold')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit),
      'listUnauthorizedTrainingHolds',
    );
  }

  async upsertAiPayoutGateState(
    row: Omit<AiPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiPayoutGateStateRecord> {
    // UNIQUE per payee_id — a re-recording converges (the newest state
    // governs the next dispatch).
    const now = new Date().toISOString();
    return this.oneStrict<AiPayoutGateStateRecord>(
      this.client
        .from(TABLES.aiPayoutGateStates)
        .upsert(
          { ...row, id: crypto.randomUUID(), created_at: now, updated_at: now },
          { onConflict: 'payee_id' },
        )
        .select()
        .maybeSingle(),
      'upsertAiPayoutGateState',
    );
  }

  async getAiPayoutGateState(
    payeeId: string,
  ): Promise<AiPayoutGateStateRecord | undefined> {
    return this.one<AiPayoutGateStateRecord>(
      this.client
        .from(TABLES.aiPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .maybeSingle(),
      'getAiPayoutGateState',
    );
  }

  async insertAiDatasetDeprecation(
    row: Omit<AiDatasetDeprecationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiDatasetDeprecationRecord> {
    // UNIQUE per (ai_model_id, dataset_version) — a re-deprecation
    // surfaces the unique violation; the caller recovers by reading the row.
    const now = new Date().toISOString();
    return this.oneStrict<AiDatasetDeprecationRecord>(
      this.client
        .from(TABLES.aiDatasetDeprecations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: now, updated_at: now })
        .select()
        .maybeSingle(),
      'insertAiDatasetDeprecation',
    );
  }

  async getAiDatasetDeprecation(
    aiModelId: string,
    datasetVersion: string,
  ): Promise<AiDatasetDeprecationRecord | undefined> {
    return this.one<AiDatasetDeprecationRecord>(
      this.client
        .from(TABLES.aiDatasetDeprecations)
        .select()
        .eq('ai_model_id', aiModelId)
        .eq('dataset_version', datasetVersion)
        .maybeSingle(),
      'getAiDatasetDeprecation',
    );
  }

  async listAiDatasetDeprecationsByModel(
    aiModelId: string,
  ): Promise<AiDatasetDeprecationRecord[]> {
    // Oldest first — the posting pass's halt set reads the history in order.
    return this.many<AiDatasetDeprecationRecord>(
      this.client
        .from(TABLES.aiDatasetDeprecations)
        .select()
        .eq('ai_model_id', aiModelId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
      'listAiDatasetDeprecationsByModel',
    );
  }

  async insertAiDatasetAllocationArchive(
    row: Omit<AiDatasetAllocationArchiveRecord, 'id'>,
  ): Promise<AiDatasetAllocationArchiveRecord> {
    // UNIQUE per (deprecation_id, ledger_transaction_id) — a re-run
    // deprecation converges, never double-archives. The referenced ledger
    // row is NOT touched (the append-only trail stays intact).
    return this.oneStrict<AiDatasetAllocationArchiveRecord>(
      this.client
        .from(TABLES.aiDatasetAllocationArchives)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertAiDatasetAllocationArchive',
    );
  }

  async listAiDatasetAllocationArchives(
    deprecationId: string,
  ): Promise<AiDatasetAllocationArchiveRecord[]> {
    // Oldest first — the archival order of record.
    return this.many<AiDatasetAllocationArchiveRecord>(
      this.client
        .from(TABLES.aiDatasetAllocationArchives)
        .select()
        .eq('deprecation_id', deprecationId)
        .order('archived_at', { ascending: true })
        .order('id', { ascending: true }),
      'listAiDatasetAllocationArchives',
    );
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

  // --- Webtoon studio splits + translation cascades (PR 20, migration 0024) ---

  async insertWebtoonStudioSplitRole(
    row: Omit<WebtoonStudioSplitRoleRecord, 'id'>,
  ): Promise<WebtoonStudioSplitRoleRecord> {
    // UNIQUE on (series_id, role_group, payee_id): a duplicate registration
    // throws here (the same failure mode the canonical store exhibits).
    return this.oneStrict<WebtoonStudioSplitRoleRecord>(
      this.client
        .from(TABLES.webtoonStudioSplitRoles)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertWebtoonStudioSplitRole',
    );
  }

  async listWebtoonStudioSplitRoles(seriesId: string): Promise<WebtoonStudioSplitRoleRecord[]> {
    // created_at ASC with the insertion-order tiebreak — the deterministic
    // allocation order within each role group.
    return this.many<WebtoonStudioSplitRoleRecord>(
      this.client
        .from(TABLES.webtoonStudioSplitRoles)
        .select()
        .eq('series_id', seriesId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listWebtoonStudioSplitRoles',
    );
  }

  async upsertWebtoonLocalizationContract(
    row: Omit<WebtoonLocalizationContractRecord, 'id'>,
  ): Promise<WebtoonLocalizationContractRecord> {
    // One localizer of record per (series, language) feed — the upsert
    // targets the composite key, so a re-registered contract replaces the
    // row atomically (the studio-KYC precedent).
    return this.oneStrict<WebtoonLocalizationContractRecord>(
      this.client
        .from(TABLES.webtoonLocalizationContracts)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'series_id,language_code' })
        .select()
        .maybeSingle(),
      'upsertWebtoonLocalizationContract',
    );
  }

  async getWebtoonLocalizationContract(
    seriesId: string,
    languageCode: string,
  ): Promise<WebtoonLocalizationContractRecord | undefined> {
    return this.one<WebtoonLocalizationContractRecord>(
      this.client
        .from(TABLES.webtoonLocalizationContracts)
        .select()
        .eq('series_id', seriesId)
        .eq('language_code', languageCode)
        .maybeSingle(),
      'getWebtoonLocalizationContract',
    );
  }

  async insertWebtoonLocalizationCostSchedule(
    row: Omit<WebtoonLocalizationCostScheduleRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostScheduleRecord> {
    // UNIQUE on schedule_ref — the business key the release resolves by.
    return this.oneStrict<WebtoonLocalizationCostScheduleRecord>(
      this.client
        .from(TABLES.webtoonLocalizationCostSchedules)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertWebtoonLocalizationCostSchedule',
    );
  }

  async getWebtoonLocalizationCostScheduleByRef(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostScheduleRecord | undefined> {
    return this.one<WebtoonLocalizationCostScheduleRecord>(
      this.client
        .from(TABLES.webtoonLocalizationCostSchedules)
        .select()
        .eq('schedule_ref', scheduleRef)
        .maybeSingle(),
      'getWebtoonLocalizationCostScheduleByRef',
    );
  }

  async insertWebtoonLocalizationCostLine(
    row: Omit<WebtoonLocalizationCostLineRecord, 'id'>,
  ): Promise<WebtoonLocalizationCostLineRecord> {
    // UNIQUE per (schedule_ref, line_index) — the insert-as-lock consume
    // arbiter; a concurrent consume of the same period throws and the
    // caller re-derives the next line.
    return this.oneStrict<WebtoonLocalizationCostLineRecord>(
      this.client
        .from(TABLES.webtoonLocalizationCostLines)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertWebtoonLocalizationCostLine',
    );
  }

  async listWebtoonLocalizationCostLines(
    scheduleRef: string,
  ): Promise<WebtoonLocalizationCostLineRecord[]> {
    // Line index order — the deterministic consumption order.
    return this.many<WebtoonLocalizationCostLineRecord>(
      this.client
        .from(TABLES.webtoonLocalizationCostLines)
        .select()
        .eq('schedule_ref', scheduleRef)
        .order('line_index', { ascending: true }),
      'listWebtoonLocalizationCostLines',
    );
  }

  async upsertWebtoonRecoupmentPool(
    row: Omit<WebtoonRecoupmentPoolRecord, 'id'>,
  ): Promise<WebtoonRecoupmentPoolRecord> {
    // One pool of record per (series, class) — the upsert targets the
    // composite key, so re-registering an advance replaces the row
    // atomically.
    return this.oneStrict<WebtoonRecoupmentPoolRecord>(
      this.client
        .from(TABLES.webtoonRecoupmentPools)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'series_id,pool_class' })
        .select()
        .maybeSingle(),
      'upsertWebtoonRecoupmentPool',
    );
  }

  async getWebtoonRecoupmentPool(
    seriesId: string,
    poolClass: WebtoonRecoupmentPoolClass,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined> {
    return this.one<WebtoonRecoupmentPoolRecord>(
      this.client
        .from(TABLES.webtoonRecoupmentPools)
        .select()
        .eq('series_id', seriesId)
        .eq('pool_class', poolClass)
        .maybeSingle(),
      'getWebtoonRecoupmentPool',
    );
  }

  async insertWebtoonRecoupmentApplication(
    row: Omit<WebtoonRecoupmentApplicationRecord, 'id'>,
  ): Promise<WebtoonRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id): a replayed application throws
    // here — the once-only replay guard, never a double recovery. UNIQUE
    // per (pool_id, recouped_before_cents): the POSITION lock (the
    // insert-as-lock arbiter).
    return this.oneStrict<WebtoonRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.webtoonRecoupmentApplications)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertWebtoonRecoupmentApplication',
    );
  }

  async listWebtoonRecoupmentApplications(
    poolId: string,
  ): Promise<WebtoonRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return this.many<WebtoonRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.webtoonRecoupmentApplications)
        .select()
        .eq('pool_id', poolId)
        .order('created_at', { ascending: true }),
      'listWebtoonRecoupmentApplications',
    );
  }

  async listTranslationLocalizationEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    // Newest first — the release path's discovery order (the holdback
    // list's convention mirrored for a deterministic settle walk).
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'translation_localization_pending')
        .eq('status', 'translation_localization_pending')
        .order('created_at', { ascending: false })
        .limit(limit),
      'listTranslationLocalizationEscrowCredits',
    );
  }

  async settleTranslationLocalizationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The same CAS as the film-escrow/gaming-cashout/holdback settles,
    // scoped to the escrow lock state only.
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'translation_localization_pending')
        .select()
        .maybeSingle(),
      'settleTranslationLocalizationEscrow',
    );
  }

  async updateWebtoonRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: WebtoonRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<WebtoonRecoupmentPoolRecord | undefined> {
    // The pool CAS: one conditional update scoped to the 'active' state —
    // changes=0 (no returned row) means the pool is absent or already
    // recouped; either way this call lost the race.
    return this.one<WebtoonRecoupmentPoolRecord>(
      this.client
        .from(TABLES.webtoonRecoupmentPools)
        .update({ recouped_cents: recoupedCents, status, updated_at: updatedAt })
        .eq('id', id)
        .eq('status', 'active')
        .select()
        .maybeSingle(),
      'updateWebtoonRecoupmentPoolProgress',
    );
  }

  // --- Book editorial split ledger (PR 26, migration 0030) ---

  async upsertBookEditorialSplitSchedule(
    row: BookEditorialSplitScheduleRecord,
  ): Promise<BookEditorialSplitScheduleRecord> {
    // One schedule of record per title_key — the upsert targets the key, so
    // a re-registration (identity + version preserved by the caller)
    // replaces the row atomically.
    return this.oneStrict<BookEditorialSplitScheduleRecord>(
      this.client
        .from(TABLES.bookEditorialSplitSchedules)
        .upsert({ ...row }, { onConflict: 'title_key' })
        .select()
        .maybeSingle(),
      'upsertBookEditorialSplitSchedule',
    );
  }

  async getBookEditorialSplitSchedule(
    titleKey: string,
  ): Promise<BookEditorialSplitScheduleRecord | undefined> {
    return this.one<BookEditorialSplitScheduleRecord>(
      this.client
        .from(TABLES.bookEditorialSplitSchedules)
        .select()
        .eq('title_key', titleKey)
        .maybeSingle(),
      'getBookEditorialSplitSchedule',
    );
  }

  async insertBookRecoupmentPool(
    row: Omit<BookRecoupmentPoolRecord, 'id'>,
  ): Promise<BookRecoupmentPoolRecord> {
    // UNIQUE per (isbn, pool_class, sequence_no): a re-registered sequence
    // slot throws here — never a silent duplicate advance slot.
    return this.oneStrict<BookRecoupmentPoolRecord>(
      this.client
        .from(TABLES.bookRecoupmentPools)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBookRecoupmentPool',
    );
  }

  async listBookRecoupmentPools(
    isbn: string,
    poolClass: BookRecoupmentPoolClass,
  ): Promise<BookRecoupmentPoolRecord[]> {
    // sequence_no ASC — the recoupment order of record.
    return this.many<BookRecoupmentPoolRecord>(
      this.client
        .from(TABLES.bookRecoupmentPools)
        .select()
        .eq('isbn', isbn)
        .eq('pool_class', poolClass)
        .order('sequence_no', { ascending: true }),
      'listBookRecoupmentPools',
    );
  }

  async updateBookRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: BookRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<BookRecoupmentPoolRecord | undefined> {
    // The pool CAS: one conditional update scoped to the 'active' state —
    // changes=0 (no returned row) means the pool is absent or already
    // recouped; either way this call lost the race (the webtoon CAS).
    return this.one<BookRecoupmentPoolRecord>(
      this.client
        .from(TABLES.bookRecoupmentPools)
        .update({ recouped_cents: recoupedCents, status, updated_at: updatedAt })
        .eq('id', id)
        .eq('status', 'active')
        .select()
        .maybeSingle(),
      'updateBookRecoupmentPoolProgress',
    );
  }

  async insertBookRecoupmentApplication(
    row: Omit<BookRecoupmentApplicationRecord, 'id'>,
  ): Promise<BookRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id): a replayed application throws
    // here — the once-only replay guard, never a double recovery. UNIQUE
    // per (pool_id, recouped_before_cents): the POSITION lock (the
    // insert-as-lock arbiter).
    return this.oneStrict<BookRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.bookRecoupmentApplications)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBookRecoupmentApplication',
    );
  }

  async listBookRecoupmentApplications(
    poolId: string,
  ): Promise<BookRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return this.many<BookRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.bookRecoupmentApplications)
        .select()
        .eq('pool_id', poolId)
        .order('created_at', { ascending: true }),
      'listBookRecoupmentApplications',
    );
  }

  async insertBookEditorialSplitAccrual(
    row: Omit<BookEditorialSplitAccrualRecord, 'id'>,
  ): Promise<BookEditorialSplitAccrualRecord> {
    // UNIQUE per source_event_id: a replayed accrual throws here — the
    // once-only designation guard, never a double split.
    return this.oneStrict<BookEditorialSplitAccrualRecord>(
      this.client
        .from(TABLES.bookEditorialSplitAccruals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBookEditorialSplitAccrual',
    );
  }

  // --- Art market waterfalls (PR 28, migration 0032) ---

  async upsertArtSplitSchedule(
    row: ArtSplitScheduleRecord,
  ): Promise<ArtSplitScheduleRecord> {
    // One schedule of record per scope_key — the upsert targets the key, so
    // a re-registration (identity + version preserved by the caller)
    // replaces the row atomically.
    return this.oneStrict<ArtSplitScheduleRecord>(
      this.client
        .from(TABLES.artSplitSchedules)
        .upsert({ ...row }, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertArtSplitSchedule',
    );
  }

  async getArtSplitSchedule(scopeKey: string): Promise<ArtSplitScheduleRecord | undefined> {
    return this.one<ArtSplitScheduleRecord>(
      this.client
        .from(TABLES.artSplitSchedules)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getArtSplitSchedule',
    );
  }

  async insertArtRecoupmentPool(
    row: Omit<ArtRecoupmentPoolRecord, 'id'>,
  ): Promise<ArtRecoupmentPoolRecord> {
    // UNIQUE per (scope_key, pool_class, sequence_no): a re-registered
    // sequence slot throws here — never a silent duplicate debt slot.
    return this.oneStrict<ArtRecoupmentPoolRecord>(
      this.client
        .from(TABLES.artRecoupmentPools)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertArtRecoupmentPool',
    );
  }

  async listArtRecoupmentPools(
    scopeKey: string,
    poolClass: ArtRecoupmentPoolClass,
  ): Promise<ArtRecoupmentPoolRecord[]> {
    // sequence_no ASC — the fabrication recoupment order of record.
    return this.many<ArtRecoupmentPoolRecord>(
      this.client
        .from(TABLES.artRecoupmentPools)
        .select()
        .eq('scope_key', scopeKey)
        .eq('pool_class', poolClass)
        .order('sequence_no', { ascending: true }),
      'listArtRecoupmentPools',
    );
  }

  async updateArtRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: ArtRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<ArtRecoupmentPoolRecord | undefined> {
    // The pool CAS: one conditional update scoped to the 'active' state —
    // changes=0 (no returned row) means the pool is absent or already
    // recouped; either way this call lost the race (the books CAS).
    return this.one<ArtRecoupmentPoolRecord>(
      this.client
        .from(TABLES.artRecoupmentPools)
        .update({ recouped_cents: recoupedCents, status, updated_at: updatedAt })
        .eq('id', id)
        .eq('status', 'active')
        .select()
        .maybeSingle(),
      'updateArtRecoupmentPoolProgress',
    );
  }

  async insertArtRecoupmentApplication(
    row: Omit<ArtRecoupmentApplicationRecord, 'id'>,
  ): Promise<ArtRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id): a replayed application throws
    // here — the once-only replay guard, never a double recovery. UNIQUE
    // per (pool_id, recouped_before_cents): the POSITION lock (the
    // insert-as-lock arbiter).
    return this.oneStrict<ArtRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.artRecoupmentApplications)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertArtRecoupmentApplication',
    );
  }

  async listArtRecoupmentApplications(
    poolId: string,
  ): Promise<ArtRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return this.many<ArtRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.artRecoupmentApplications)
        .select()
        .eq('pool_id', poolId)
        .order('created_at', { ascending: true }),
      'listArtRecoupmentApplications',
    );
  }

  async insertArtSplitAccrual(
    row: Omit<ArtSplitAccrualRecord, 'id'>,
  ): Promise<ArtSplitAccrualRecord> {
    // UNIQUE per source_event_id: a replayed accrual throws here — the
    // once-only designation guard, never a double split.
    return this.oneStrict<ArtSplitAccrualRecord>(
      this.client
        .from(TABLES.artSplitAccruals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertArtSplitAccrual',
    );
  }

  async upsertArtLicensingAgencyPolicy(
    row: Omit<ArtLicensingAgencyPolicyRecord, 'id'>,
  ): Promise<ArtLicensingAgencyPolicyRecord> {
    // One policy of record per agency_code — the upsert targets the key, so
    // a re-registered rate replaces the row atomically (the founder band
    // validates at registration).
    return this.oneStrict<ArtLicensingAgencyPolicyRecord>(
      this.client
        .from(TABLES.artLicensingAgencyPolicies)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'agency_code' })
        .select()
        .maybeSingle(),
      'upsertArtLicensingAgencyPolicy',
    );
  }

  async getArtLicensingAgencyPolicy(
    agencyCode: ArtLicensingAgencyPolicyRecord['agency_code'],
  ): Promise<ArtLicensingAgencyPolicyRecord | undefined> {
    return this.one<ArtLicensingAgencyPolicyRecord>(
      this.client
        .from(TABLES.artLicensingAgencyPolicies)
        .select()
        .eq('agency_code', agencyCode)
        .maybeSingle(),
      'getArtLicensingAgencyPolicy',
    );
  }

  async upsertEstateSuccessionCertificate(
    row: Omit<EstateSuccessionCertificateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstateSuccessionCertificateRecord> {
    // UNIQUE per (artist_payee_id, certificate_ref) — a re-validation
    // converges on the row: the identity is read and preserved BEFORE the
    // upsert (a schedule of record hangs off certificate_id, so a
    // re-validation may never mint a new id — the read-then-write
    // discipline), and the newest validation state governs the transition
    // gate.
    const existing = await this.getEstateSuccessionCertificate(
      row.artist_payee_id,
      row.certificate_ref,
    );
    return this.oneStrict<EstateSuccessionCertificateRecord>(
      this.client
        .from(TABLES.estateSuccessionCertificates)
        .upsert(
          {
            ...row,
            ...(existing === undefined
              ? { id: crypto.randomUUID() }
              : { id: existing.id, created_at: existing.created_at }),
          },
          { onConflict: 'artist_payee_id,certificate_ref' },
        )
        .select()
        .maybeSingle(),
      'upsertEstateSuccessionCertificate',
    );
  }

  async getEstateSuccessionCertificate(
    artistPayeeId: string,
    certificateRef: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    return this.one<EstateSuccessionCertificateRecord>(
      this.client
        .from(TABLES.estateSuccessionCertificates)
        .select()
        .eq('artist_payee_id', artistPayeeId)
        .eq('certificate_ref', certificateRef)
        .maybeSingle(),
      'getEstateSuccessionCertificate',
    );
  }

  async getEstateSuccessionCertificateById(
    certificateId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    return this.one<EstateSuccessionCertificateRecord>(
      this.client
        .from(TABLES.estateSuccessionCertificates)
        .select()
        .eq('id', certificateId)
        .maybeSingle(),
      'getEstateSuccessionCertificateById',
    );
  }

  async getVerifiedEstateSuccessionCertificate(
    artistPayeeId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    return this.one<EstateSuccessionCertificateRecord>(
      this.client
        .from(TABLES.estateSuccessionCertificates)
        .select()
        .eq('artist_payee_id', artistPayeeId)
        .eq('validation_state', 'verified')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'getVerifiedEstateSuccessionCertificate',
    );
  }

  async upsertEstateHeirSchedule(
    row: EstateHeirScheduleRecord,
  ): Promise<EstateHeirScheduleRecord> {
    // UNIQUE per certificate_id — a re-registration (a probate amendment)
    // replaces the row atomically, identity and created_at preserved (the
    // art schedule upsert discipline; the engine builds the versioned row).
    return this.oneStrict<EstateHeirScheduleRecord>(
      this.client
        .from(TABLES.estateHeirSchedules)
        .upsert({ ...row, id: row.id || crypto.randomUUID() }, { onConflict: 'certificate_id' })
        .select()
        .maybeSingle(),
      'upsertEstateHeirSchedule',
    );
  }

  async getEstateHeirSchedule(
    certificateId: string,
  ): Promise<EstateHeirScheduleRecord | undefined> {
    return this.one<EstateHeirScheduleRecord>(
      this.client
        .from(TABLES.estateHeirSchedules)
        .select()
        .eq('certificate_id', certificateId)
        .maybeSingle(),
      'getEstateHeirSchedule',
    );
  }

  async insertEstateSuccessionTransition(
    row: Omit<EstateSuccessionTransitionRecord, 'id'>,
  ): Promise<EstateSuccessionTransitionRecord> {
    // UNIQUE per (certificate_id, source_event_id): a replayed transition
    // throws here — the once-only handoff guard, never a double handoff.
    // Append-only: nothing ever updates or deletes a transition row.
    return this.oneStrict<EstateSuccessionTransitionRecord>(
      this.client
        .from(TABLES.estateSuccessionTransitions)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertEstateSuccessionTransition',
    );
  }

  async listEstateSuccessionTransitions(
    certificateId: string,
  ): Promise<EstateSuccessionTransitionRecord[]> {
    return this.many<EstateSuccessionTransitionRecord>(
      this.client
        .from(TABLES.estateSuccessionTransitions)
        .select()
        .eq('certificate_id', certificateId)
        .order('created_at', { ascending: true }),
      'listEstateSuccessionTransitions',
    );
  }

  async insertEstateSplitAccrual(
    row: Omit<EstateSplitAccrualRecord, 'id'>,
  ): Promise<EstateSplitAccrualRecord> {
    // UNIQUE per (certificate_id, artwork_id, source_event_id): a replayed
    // accrual throws here — the once-only designation guard, never a
    // double split (the provenance triple IS the once-only key).
    return this.oneStrict<EstateSplitAccrualRecord>(
      this.client
        .from(TABLES.estateSplitAccruals)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertEstateSplitAccrual',
    );
  }

  async listEstateSplitAccruals(
    certificateId: string,
  ): Promise<EstateSplitAccrualRecord[]> {
    return this.many<EstateSplitAccrualRecord>(
      this.client
        .from(TABLES.estateSplitAccruals)
        .select()
        .eq('certificate_id', certificateId)
        .order('created_at', { ascending: true }),
      'listEstateSplitAccruals',
    );
  }

  async upsertEstatePayoutGateState(
    row: Omit<EstatePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstatePayoutGateStateRecord> {
    // UNIQUE per payee_id — a re-recording converges (the newest state
    // governs the next dispatch).
    return this.oneStrict<EstatePayoutGateStateRecord>(
      this.client
        .from(TABLES.estatePayoutGateStates)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'payee_id' })
        .select()
        .maybeSingle(),
      'upsertEstatePayoutGateState',
    );
  }

  async getEstatePayoutGateState(
    payeeId: string,
  ): Promise<EstatePayoutGateStateRecord | undefined> {
    return this.one<EstatePayoutGateStateRecord>(
      this.client
        .from(TABLES.estatePayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .maybeSingle(),
      'getEstatePayoutGateState',
    );
  }

  // --- AGBOR box office + theatrical recoupment (PR 30, migration 0034) ---

  async upsertTheatricalProductionDeal(
    row: TheatricalProductionDealRecord,
  ): Promise<TheatricalProductionDealRecord> {
    // One deal of record per scope_key — the upsert targets the key, so a
    // re-registration (identity + version preserved by the caller)
    // replaces the row atomically.
    return this.oneStrict<TheatricalProductionDealRecord>(
      this.client
        .from(TABLES.theatricalProductionDeals)
        .upsert({ ...row }, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertTheatricalProductionDeal',
    );
  }

  async getTheatricalProductionDeal(
    productionId: string,
  ): Promise<TheatricalProductionDealRecord | undefined> {
    return this.one<TheatricalProductionDealRecord>(
      this.client
        .from(TABLES.theatricalProductionDeals)
        .select()
        .eq('scope_key', `production:${productionId}`)
        .maybeSingle(),
      'getTheatricalProductionDeal',
    );
  }

  async insertTheatricalStopSettlement(
    row: Omit<TheatricalStopSettlementRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalStopSettlementRecord> {
    // UNIQUE per source_event_id: a replayed settlement row throws here —
    // the once-only replay guard, never a double stop.
    return this.oneStrict<TheatricalStopSettlementRecord>(
      this.client
        .from(TABLES.theatricalStopSettlements)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertTheatricalStopSettlement',
    );
  }

  async listTheatricalStopSettlements(
    productionId: string,
  ): Promise<TheatricalStopSettlementRecord[]> {
    // show_date then created_at — the tour book in stop order.
    return this.many<TheatricalStopSettlementRecord>(
      this.client
        .from(TABLES.theatricalStopSettlements)
        .select()
        .eq('production_id', productionId)
        .order('show_date', { ascending: true })
        .order('created_at', { ascending: true }),
      'listTheatricalStopSettlements',
    );
  }

  async updateTheatricalDealRecoupment(
    id: string,
    recoupedCents: number,
    updatedAt: string,
  ): Promise<TheatricalProductionDealRecord | undefined> {
    // The deal CAS: one conditional update — the counter only advances and
    // never past the capitalization budget. changes=0 (no returned row)
    // means the deal is absent or the caller's value regressed.
    return this.one<TheatricalProductionDealRecord>(
      this.client
        .from(TABLES.theatricalProductionDeals)
        .update({ recouped_cents: recoupedCents, updated_at: updatedAt })
        .eq('id', id)
        // The advance guarantee is the CAS filter; the budget bound is the
        // engine's math (it computes the bounded target before calling) —
        // PostgREST filters cannot compare two columns of the same row.
        .lt('recouped_cents', recoupedCents)
        .select()
        .maybeSingle(),
      'updateTheatricalDealRecoupment',
    );
  }

  async insertTheatricalRecoupmentApplication(
    row: Omit<TheatricalRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalRecoupmentApplicationRecord> {
    // UNIQUE per (deal_id, source_event_id): the replay guard; UNIQUE per
    // (deal_id, recouped_before_cents): the position lock (the books/art
    // insert-as-lock arbiter).
    return this.oneStrict<TheatricalRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.theatricalRecoupmentApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertTheatricalRecoupmentApplication',
    );
  }

  async listTheatricalRecoupmentApplications(
    dealId: string,
  ): Promise<TheatricalRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return this.many<TheatricalRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.theatricalRecoupmentApplications)
        .select()
        .eq('deal_id', dealId)
        .order('created_at', { ascending: true }),
      'listTheatricalRecoupmentApplications',
    );
  }

  async insertTheatricalSplitAccrual(
    row: Omit<TheatricalSplitAccrualRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalSplitAccrualRecord> {
    // UNIQUE per (deal_id, source_event_id): a replayed accrual throws
    // here — the once-only designation guard, never a double split.
    return this.oneStrict<TheatricalSplitAccrualRecord>(
      this.client
        .from(TABLES.theatricalSplitAccruals)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertTheatricalSplitAccrual',
    );
  }

  async listTheatricalSplitAccruals(dealId: string): Promise<TheatricalSplitAccrualRecord[]> {
    // created_at ASC — the executed designations in execution order.
    return this.many<TheatricalSplitAccrualRecord>(
      this.client
        .from(TABLES.theatricalSplitAccruals)
        .select()
        .eq('deal_id', dealId)
        .order('created_at', { ascending: true }),
      'listTheatricalSplitAccruals',
    );
  }

  // --- Promoter settlement escrow + theater gates + comedy audio (PR 31,
  // --- migration 0035) ---

  async listPromoterSettlementEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    // Newest first — the release path's discovery order (the
    // translation-localization escrow listing's convention mirrored for a
    // deterministic settle walk). Released credits (status 'settled') are
    // history, not holdings — they never appear here.
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'promoter_box_office_settlement_pending')
        .eq('status', 'promoter_box_office_settlement_pending')
        .order('created_at', { ascending: false })
        .limit(limit),
      'listPromoterSettlementEscrowCredits',
    );
  }

  async settlePromoterSettlementEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The same CAS as the film-escrow/gaming-cashout/holdback/translation
    // settles, scoped to the promoter lock state only: no returned row
    // means the receipt is absent or no longer locked — this call lost.
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'promoter_box_office_settlement_pending')
        .select()
        .maybeSingle(),
      'settlePromoterSettlementEscrow',
    );
  }

  async upsertPromoterSettlementAudit(
    row: Omit<PromoterSettlementAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PromoterSettlementAuditRecord> {
    // UNIQUE per (production_id, venue_id, show_date) — a re-recording
    // converges (the newest close governs the next release).
    return this.oneStrict<PromoterSettlementAuditRecord>(
      this.client
        .from(TABLES.promoterSettlementAudits)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'production_id,venue_id,show_date' },
        )
        .select()
        .maybeSingle(),
      'upsertPromoterSettlementAudit',
    );
  }

  async getPromoterSettlementAudit(
    productionId: string,
    venueId: string,
    showDate: string,
  ): Promise<PromoterSettlementAuditRecord | undefined> {
    return this.one<PromoterSettlementAuditRecord>(
      this.client
        .from(TABLES.promoterSettlementAudits)
        .select()
        .eq('production_id', productionId)
        .eq('venue_id', venueId)
        .eq('show_date', showDate)
        .maybeSingle(),
      'getPromoterSettlementAudit',
    );
  }

  async upsertTheatricalPayoutGateState(
    row: Omit<TheatricalPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<TheatricalPayoutGateStateRecord> {
    // UNIQUE per (payee_id, production_id) — an upsert converges (the newest
    // states govern the next dispatch).
    return this.oneStrict<TheatricalPayoutGateStateRecord>(
      this.client
        .from(TABLES.theatricalPayoutGateStates)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'payee_id,production_id' },
        )
        .select()
        .maybeSingle(),
      'upsertTheatricalPayoutGateState',
    );
  }

  async getTheatricalPayoutGateState(
    payeeId: string,
    productionId: string,
  ): Promise<TheatricalPayoutGateStateRecord | undefined> {
    return this.one<TheatricalPayoutGateStateRecord>(
      this.client
        .from(TABLES.theatricalPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('production_id', productionId)
        .maybeSingle(),
      'getTheatricalPayoutGateState',
    );
  }

  async upsertVenueHallFeePolicy(
    row: Omit<VenueHallFeePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<VenueHallFeePolicyRecord> {
    // UNIQUE per (tour_id, venue_id) — an upsert converges.
    return this.oneStrict<VenueHallFeePolicyRecord>(
      this.client
        .from(TABLES.venueHallFeePolicies)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'tour_id,venue_id' },
        )
        .select()
        .maybeSingle(),
      'upsertVenueHallFeePolicy',
    );
  }

  async getVenueHallFeePolicy(
    tourId: string,
    venueId: string,
  ): Promise<VenueHallFeePolicyRecord | undefined> {
    return this.one<VenueHallFeePolicyRecord>(
      this.client
        .from(TABLES.venueHallFeePolicies)
        .select()
        .eq('tour_id', tourId)
        .eq('venue_id', venueId)
        .maybeSingle(),
      'getVenueHallFeePolicy',
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
    return this.oneStrict<LicensingRoyaltyDealRecord>(
      this.client
        .from(TABLES.licensingRoyaltyDeals)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'scope_key' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingRoyaltyDeal',
    );
  }

  async getLicensingRoyaltyDeal(
    scopeKey: string,
  ): Promise<LicensingRoyaltyDealRecord | undefined> {
    return this.one<LicensingRoyaltyDealRecord>(
      this.client
        .from(TABLES.licensingRoyaltyDeals)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getLicensingRoyaltyDeal',
    );
  }

  async insertLicensingRoyaltyApplication(
    row: Omit<LicensingRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingRoyaltyApplicationRecord> {
    // UNIQUE per (deal_id, source_event_id) is the replay guard; UNIQUE
    // per (deal_id, cumulative_before_cents) is the position lock — a
    // replayed walk or a lost position race throws here, never a double
    // application; the caller retries at the advanced position.
    return this.oneStrict<LicensingRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.licensingRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertLicensingRoyaltyApplication',
    );
  }

  async listLicensingRoyaltyApplications(
    dealId: string,
  ): Promise<LicensingRoyaltyApplicationRecord[]> {
    // created_at ASC — the cumulative ledger in walk order.
    return this.many<LicensingRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.licensingRoyaltyApplications)
        .select()
        .eq('deal_id', dealId)
        .order('created_at', { ascending: true }),
      'listLicensingRoyaltyApplications',
    );
  }

  async upsertLicensingTreatyRate(
    row: Omit<LicensingTreatyRateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingTreatyRateRecord> {
    // UNIQUE per (source_country, residence_country) — a re-registration
    // converges (the newest rate governs the next walk).
    return this.oneStrict<LicensingTreatyRateRecord>(
      this.client
        .from(TABLES.licensingTreatyRates)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'source_country,residence_country' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingTreatyRate',
    );
  }

  async getLicensingTreatyRate(
    sourceCountry: string,
    residenceCountry: string,
  ): Promise<LicensingTreatyRateRecord | undefined> {
    return this.one<LicensingTreatyRateRecord>(
      this.client
        .from(TABLES.licensingTreatyRates)
        .select()
        .eq('source_country', sourceCountry)
        .eq('residence_country', residenceCountry)
        .maybeSingle(),
      'getLicensingTreatyRate',
    );
  }

  async upsertLicensingSubLicensee(
    row: Omit<LicensingSubLicenseeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseeRecord> {
    // UNIQUE per (scope_key, sub_licensee_id) — an upsert converges (the
    // newest override governs the next report).
    return this.oneStrict<LicensingSubLicenseeRecord>(
      this.client
        .from(TABLES.licensingSubLicensees)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'scope_key,sub_licensee_id' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingSubLicensee',
    );
  }

  async getLicensingSubLicensee(
    scopeKey: string,
    subLicenseeId: string,
  ): Promise<LicensingSubLicenseeRecord | undefined> {
    return this.one<LicensingSubLicenseeRecord>(
      this.client
        .from(TABLES.licensingSubLicensees)
        .select()
        .eq('scope_key', scopeKey)
        .eq('sub_licensee_id', subLicenseeId)
        .maybeSingle(),
      'getLicensingSubLicensee',
    );
  }

  async listLicensingSubLicensees(scopeKey: string): Promise<LicensingSubLicenseeRecord[]> {
    // created_at ASC — the registered regional parties in registration order.
    return this.many<LicensingSubLicenseeRecord>(
      this.client
        .from(TABLES.licensingSubLicensees)
        .select()
        .eq('scope_key', scopeKey)
        .order('created_at', { ascending: true }),
      'listLicensingSubLicensees',
    );
  }

  async upsertLicensingSubLicenseReport(
    row: Omit<LicensingSubLicenseReportRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseReportRecord> {
    // UNIQUE per source_event_id — a re-shipped manifest converges, never
    // a double report row. The CAS reconcile (below) is the ONLY writer of
    // the 'reconciled' audit state; this upsert never flips it.
    return this.oneStrict<LicensingSubLicenseReportRecord>(
      this.client
        .from(TABLES.licensingSubLicenseReports)
        .upsert(
          { ...row, id: crypto.randomUUID(), updated_at: new Date().toISOString() },
          { onConflict: 'source_event_id' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingSubLicenseReport',
    );
  }

  async getLicensingSubLicenseReport(
    sourceEventId: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined> {
    return this.one<LicensingSubLicenseReportRecord>(
      this.client
        .from(TABLES.licensingSubLicenseReports)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getLicensingSubLicenseReport',
    );
  }

  async listLicensingSubLicenseReports(
    scopeKey: string,
  ): Promise<LicensingSubLicenseReportRecord[]> {
    // created_at ASC — the audit trail the release path replays.
    return this.many<LicensingSubLicenseReportRecord>(
      this.client
        .from(TABLES.licensingSubLicenseReports)
        .select()
        .eq('scope_key', scopeKey)
        .order('created_at', { ascending: true }),
      'listLicensingSubLicenseReports',
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
    return this.one<LicensingSubLicenseReportRecord>(
      this.client
        .from(TABLES.licensingSubLicenseReports)
        .update({
          audit_state: 'reconciled',
          evidence_ref: evidenceRef,
          reconciled_by: reconciledBy,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('audit_state', 'unknown')
        .select()
        .maybeSingle(),
      'reconcileLicensingSubLicenseReport',
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
    return this.oneStrict<LicensingMgCommitmentRecord>(
      this.client
        .from(TABLES.licensingMgCommitments)
        .upsert(
          {
            ...row,
            recouped_cents: row.recouped_cents ?? 0,
            // No id in the payload: on conflict, PostgREST updates only the
            // transmitted columns, so the row's identity (and created_at)
            // survive a re-registration — applications and term closes keyed
            // to this commitment keep their references. A fresh insert gets
            // the table's gen_random_uuid() default.
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'scope_key,commitment_ref' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingMgCommitment',
    );
  }

  async getLicensingMgCommitment(
    scopeKey: string,
    commitmentRef: string,
  ): Promise<LicensingMgCommitmentRecord | undefined> {
    return this.one<LicensingMgCommitmentRecord>(
      this.client
        .from(TABLES.licensingMgCommitments)
        .select()
        .eq('scope_key', scopeKey)
        .eq('commitment_ref', commitmentRef)
        .maybeSingle(),
      'getLicensingMgCommitment',
    );
  }

  async listLicensingMgCommitments(scopeKey: string): Promise<LicensingMgCommitmentRecord[]> {
    // created_at ASC — the recoupment pass's routing candidates in order.
    return this.many<LicensingMgCommitmentRecord>(
      this.client
        .from(TABLES.licensingMgCommitments)
        .select()
        .eq('scope_key', scopeKey)
        .order('created_at', { ascending: true }),
      'listLicensingMgCommitments',
    );
  }

  async insertLicensingMgRecoupmentApplication(
    row: Omit<LicensingMgRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingMgRecoupmentApplicationRecord> {
    // UNIQUE per (commitment_id, source_event_id) is the replay guard;
    // UNIQUE per (commitment_id, recouped_before_cents) is the position
    // lock — a replayed event or a lost position race throws here, never a
    // double application; the caller retries at the advanced position.
    return this.oneStrict<LicensingMgRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.licensingMgRecoupmentApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertLicensingMgRecoupmentApplication',
    );
  }

  async listLicensingMgRecoupmentApplications(
    commitmentId: string,
  ): Promise<LicensingMgRecoupmentApplicationRecord[]> {
    // created_at ASC — the append-only truth in application order.
    return this.many<LicensingMgRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.licensingMgRecoupmentApplications)
        .select()
        .eq('commitment_id', commitmentId)
        .order('created_at', { ascending: true }),
      'listLicensingMgRecoupmentApplications',
    );
  }

  async upsertLicensingMgTermClose(
    row: Omit<LicensingMgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingMgTermCloseRecord> {
    // UNIQUE per (commitment_id, term) — the once-only close; a replay
    // converges on the recorded shortfall and invoice of record.
    return this.oneStrict<LicensingMgTermCloseRecord>(
      this.client
        .from(TABLES.licensingMgTermCloses)
        .upsert(
          // No id in the payload — the once-only close converges on the
          // recorded identity; the commitment reference never rotates.
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'commitment_id,term' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingMgTermClose',
    );
  }

  async getLicensingMgTermClose(
    commitmentId: string,
    term: string,
  ): Promise<LicensingMgTermCloseRecord | undefined> {
    return this.one<LicensingMgTermCloseRecord>(
      this.client
        .from(TABLES.licensingMgTermCloses)
        .select()
        .eq('commitment_id', commitmentId)
        .eq('term', term)
        .maybeSingle(),
      'getLicensingMgTermClose',
    );
  }

  async listLicensingMgTermCloses(scopeKey: string): Promise<LicensingMgTermCloseRecord[]> {
    // created_at ASC — the audit trail of the guarantee's enforcement.
    return this.many<LicensingMgTermCloseRecord>(
      this.client
        .from(TABLES.licensingMgTermCloses)
        .select()
        .eq('scope_key', scopeKey)
        .order('created_at', { ascending: true }),
      'listLicensingMgTermCloses',
    );
  }

  async upsertLicensingAuditReservePolicy(
    row: Omit<LicensingAuditReservePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingAuditReservePolicyRecord> {
    // UNIQUE per scope_key — a re-registration converges (the newest rate
    // governs the next routing).
    return this.oneStrict<LicensingAuditReservePolicyRecord>(
      this.client
        .from(TABLES.licensingAuditReservePolicies)
        .upsert(
          // No id in the payload — a re-registration converges on the same
          // policy row, never a new identity.
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'scope_key' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingAuditReservePolicy',
    );
  }

  async getLicensingAuditReservePolicy(
    scopeKey: string,
  ): Promise<LicensingAuditReservePolicyRecord | undefined> {
    return this.one<LicensingAuditReservePolicyRecord>(
      this.client
        .from(TABLES.licensingAuditReservePolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getLicensingAuditReservePolicy',
    );
  }

  async insertLicensingAuditReserveReconciliation(
    row: Omit<LicensingAuditReserveReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<LicensingAuditReserveReconciliationRecord>(
      this.client
        .from(TABLES.licensingAuditReserveReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertLicensingAuditReserveReconciliation',
    );
  }

  async getLicensingAuditReserveReconciliation(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveReconciliationRecord | undefined> {
    return this.one<LicensingAuditReserveReconciliationRecord>(
      this.client
        .from(TABLES.licensingAuditReserveReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getLicensingAuditReserveReconciliation',
    );
  }

  async insertLicensingAuditReserveDrawdown(
    row: Omit<LicensingAuditReserveDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
    // UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
    // lock — a replayed event or a lost race throws here, never a double
    // drawdown; the caller re-derives from the append-only truth.
    return this.oneStrict<LicensingAuditReserveDrawdownRecord>(
      this.client
        .from(TABLES.licensingAuditReserveDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertLicensingAuditReserveDrawdown',
    );
  }

  async listLicensingAuditReserveDrawdowns(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveDrawdownRecord[]> {
    // created_at ASC — the append-only truth in spend order.
    return this.many<LicensingAuditReserveDrawdownRecord>(
      this.client
        .from(TABLES.licensingAuditReserveDrawdowns)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .order('created_at', { ascending: true }),
      'listLicensingAuditReserveDrawdowns',
    );
  }

  async upsertLicensingPayoutGateState(
    row: Omit<LicensingPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingPayoutGateStateRecord> {
    // UNIQUE per (payee_id, scope_key) — an upsert converges (the newest
    // states govern the next dispatch).
    return this.oneStrict<LicensingPayoutGateStateRecord>(
      this.client
        .from(TABLES.licensingPayoutGateStates)
        .upsert(
          // No id in the payload — a verification heals the states on the
          // same row, never a new identity.
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'payee_id,scope_key' },
        )
        .select()
        .maybeSingle(),
      'upsertLicensingPayoutGateState',
    );
  }

  async getLicensingPayoutGateState(
    payeeId: string,
    scopeKey: string,
  ): Promise<LicensingPayoutGateStateRecord | undefined> {
    return this.one<LicensingPayoutGateStateRecord>(
      this.client
        .from(TABLES.licensingPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getLicensingPayoutGateState',
    );
  }

  async settleLicensingAuditReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update IS the CAS — a single statement that only
    // flips the row while it is still the held escrow state; the caller
    // that lost the race (or replayed) reads undefined.
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'audit_reserve_escrow')
        .select()
        .maybeSingle(),
      'settleLicensingAuditReserve',
    );
  }

  async getLicensingRoyaltyApplication(
    dealId: string,
    sourceEventId: string,
  ): Promise<LicensingRoyaltyApplicationRecord | undefined> {
    return this.one<LicensingRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.licensingRoyaltyApplications)
        .select()
        .eq('deal_id', dealId)
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getLicensingRoyaltyApplication',
    );
  }

  // --- The NIL lane: the compliance parser + roster waterfall (PR 34,
  // --- migration 0038) ---
  // UPSERT DISCIPLINE (the PR 33 parity-suite lesson, applied): the id
  // column is NEVER in the upsert payload — on conflict the id would
  // rotate (the row's identity of record would silently change). The
  // database default generates the id on insert; on conflict only the
  // payload columns update.

  async upsertNilRevenueShareProgram(
    row: Omit<NilRevenueShareProgramRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRevenueShareProgramRecord> {
    // UNIQUE per scope_key — a re-registration replaces the row atomically.
    return this.oneStrict<NilRevenueShareProgramRecord>(
      this.client
        .from(TABLES.nilRevenueSharePrograms)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'scope_key',
        })
        .select()
        .maybeSingle(),
      'upsertNilRevenueShareProgram',
    );
  }

  async getNilRevenueShareProgram(
    scopeKey: string,
  ): Promise<NilRevenueShareProgramRecord | undefined> {
    return this.one<NilRevenueShareProgramRecord>(
      this.client
        .from(TABLES.nilRevenueSharePrograms)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getNilRevenueShareProgram',
    );
  }

  async upsertNilRosterWaterfall(
    row: Omit<NilRosterWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRosterWaterfallRecord> {
    // UNIQUE per (scope_key, waterfall_key) — an upsert converges.
    return this.oneStrict<NilRosterWaterfallRecord>(
      this.client
        .from(TABLES.nilRosterWaterfalls)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'scope_key,waterfall_key',
        })
        .select()
        .maybeSingle(),
      'upsertNilRosterWaterfall',
    );
  }

  async getNilRosterWaterfall(
    scopeKey: string,
    waterfallKey: string,
  ): Promise<NilRosterWaterfallRecord | undefined> {
    return this.one<NilRosterWaterfallRecord>(
      this.client
        .from(TABLES.nilRosterWaterfalls)
        .select()
        .eq('scope_key', scopeKey)
        .eq('waterfall_key', waterfallKey)
        .maybeSingle(),
      'getNilRosterWaterfall',
    );
  }

  async upsertNilSchoolCap(
    row: Omit<NilSchoolCapRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilSchoolCapRecord> {
    // UNIQUE per (school_id, cap_year) — an upsert converges.
    return this.oneStrict<NilSchoolCapRecord>(
      this.client
        .from(TABLES.nilSchoolCaps)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'school_id,cap_year',
        })
        .select()
        .maybeSingle(),
      'upsertNilSchoolCap',
    );
  }

  async getNilSchoolCap(
    schoolId: string,
    capYear: string,
  ): Promise<NilSchoolCapRecord | undefined> {
    return this.one<NilSchoolCapRecord>(
      this.client
        .from(TABLES.nilSchoolCaps)
        .select()
        .eq('school_id', schoolId)
        .eq('cap_year', capYear)
        .maybeSingle(),
      'getNilSchoolCap',
    );
  }

  async insertNilCapVerification(
    row: Omit<NilCapVerificationRecord, 'id' | 'created_at'>,
  ): Promise<NilCapVerificationRecord> {
    // UNIQUE per (school_id, cap_year) is the INSERT-AS-LOCK: the FIRST
    // verification wins; a concurrent second insert throws here, never a
    // double verification.
    return this.oneStrict<NilCapVerificationRecord>(
      this.client
        .from(TABLES.nilCapVerifications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilCapVerification',
    );
  }

  async getNilCapVerification(
    schoolId: string,
    capYear: string,
  ): Promise<NilCapVerificationRecord | undefined> {
    return this.one<NilCapVerificationRecord>(
      this.client
        .from(TABLES.nilCapVerifications)
        .select()
        .eq('school_id', schoolId)
        .eq('cap_year', capYear)
        .maybeSingle(),
      'getNilCapVerification',
    );
  }

  async upsertNilDealComplianceAudit(
    row: Omit<NilDealComplianceAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilDealComplianceAuditRecord> {
    // UNIQUE per nil_contract_id — an upsert converges: the $600 flag
    // heals to 'nil_cleared'; never the reverse through this table.
    return this.oneStrict<NilDealComplianceAuditRecord>(
      this.client
        .from(TABLES.nilDealComplianceAudits)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'nil_contract_id',
        })
        .select()
        .maybeSingle(),
      'upsertNilDealComplianceAudit',
    );
  }

  async getNilDealComplianceAudit(
    nilContractId: string,
  ): Promise<NilDealComplianceAuditRecord | undefined> {
    return this.one<NilDealComplianceAuditRecord>(
      this.client
        .from(TABLES.nilDealComplianceAudits)
        .select()
        .eq('nil_contract_id', nilContractId)
        .maybeSingle(),
      'getNilDealComplianceAudit',
    );
  }

  async insertNilPayoutApplication(
    row: Omit<NilPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPayoutApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked event
    // throws here, never a double payout.
    return this.oneStrict<NilPayoutApplicationRecord>(
      this.client
        .from(TABLES.nilPayoutApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilPayoutApplication',
    );
  }

  async getNilPayoutApplication(
    sourceEventId: string,
  ): Promise<NilPayoutApplicationRecord | undefined> {
    return this.one<NilPayoutApplicationRecord>(
      this.client
        .from(TABLES.nilPayoutApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getNilPayoutApplication',
    );
  }

  async insertNilPoolApplication(
    row: Omit<NilPoolApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPoolApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked pool
    // event throws here, never a double distribution.
    return this.oneStrict<NilPoolApplicationRecord>(
      this.client
        .from(TABLES.nilPoolApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilPoolApplication',
    );
  }

  async getNilPoolApplication(
    sourceEventId: string,
  ): Promise<NilPoolApplicationRecord | undefined> {
    return this.one<NilPoolApplicationRecord>(
      this.client
        .from(TABLES.nilPoolApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getNilPoolApplication',
    );
  }

  async insertNilGroupSplit(
    row: Omit<NilGroupSplitRecord, 'id' | 'created_at'>,
  ): Promise<NilGroupSplitRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-shipped
    // distribution splits once, never twice.
    return this.oneStrict<NilGroupSplitRecord>(
      this.client
        .from(TABLES.nilGroupSplits)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilGroupSplit',
    );
  }

  async getNilGroupSplit(
    sourceEventId: string,
  ): Promise<NilGroupSplitRecord | undefined> {
    return this.one<NilGroupSplitRecord>(
      this.client
        .from(TABLES.nilGroupSplits)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getNilGroupSplit',
    );
  }

  async upsertNilStateRule(
    row: Omit<NilStateRuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilStateRuleRecord> {
    // UNIQUE per (state_jurisdiction_code, rule_code) — an upsert
    // converges (the newest rule governs the next payout execution).
    return this.oneStrict<NilStateRuleRecord>(
      this.client
        .from(TABLES.nilStateRules)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'state_jurisdiction_code,rule_code',
        })
        .select()
        .maybeSingle(),
      'upsertNilStateRule',
    );
  }

  async getNilStateRule(
    stateJurisdictionCode: string,
    ruleCode: string,
  ): Promise<NilStateRuleRecord | undefined> {
    return this.one<NilStateRuleRecord>(
      this.client
        .from(TABLES.nilStateRules)
        .select()
        .eq('state_jurisdiction_code', stateJurisdictionCode)
        .eq('rule_code', ruleCode)
        .maybeSingle(),
      'getNilStateRule',
    );
  }

  async upsertNilPayoutGateState(
    row: Omit<NilPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilPayoutGateStateRecord> {
    // UNIQUE per (payee_id, school_id) — an upsert converges: a
    // verification heals 'unknown'; states never regress through this
    // table.
    return this.oneStrict<NilPayoutGateStateRecord>(
      this.client
        .from(TABLES.nilPayoutGateStates)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'payee_id,school_id',
        })
        .select()
        .maybeSingle(),
      'upsertNilPayoutGateState',
    );
  }

  async getNilPayoutGateState(
    payeeId: string,
    schoolId: string,
  ): Promise<NilPayoutGateStateRecord | undefined> {
    return this.one<NilPayoutGateStateRecord>(
      this.client
        .from(TABLES.nilPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('school_id', schoolId)
        .maybeSingle(),
      'getNilPayoutGateState',
    );
  }

  // --- NIL audit escrow + transfer portal clawback (PR 35, migration 0039) ---

  async upsertNilAuditEscrowPolicy(
    row: Omit<NilAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — an upsert converges: a re-registration
    // replaces the rate of record atomically. No id in the payload — the
    // id is server-assigned on insert and must not rotate on conflict
    // (the PR 33 parity lesson).
    return this.oneStrict<NilAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.nilAuditEscrowPolicies)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'scope_key',
        })
        .select()
        .maybeSingle(),
      'upsertNilAuditEscrowPolicy',
    );
  }

  async getNilAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<NilAuditEscrowPolicyRecord | undefined> {
    return this.one<NilAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.nilAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getNilAuditEscrowPolicy',
    );
  }

  async insertNilAuditEscrowDrawdown(
    row: Omit<NilAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowDrawdownRecord> {
    // Insert-as-lock — UNIQUE per (reserve_ledger_id, source_event_id) is
    // the replay guard and UNIQUE per (reserve_ledger_id,
    // drawn_before_cents) is the position lock: a replayed event or a
    // lost race throws here, never a double drawdown.
    return this.oneStrict<NilAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.nilAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilAuditEscrowDrawdown',
    );
  }

  async listNilAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowDrawdownRecord[]> {
    return this.many<NilAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.nilAuditEscrowDrawdowns)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .order('created_at', { ascending: true }),
      'listNilAuditEscrowDrawdowns',
    );
  }

  async insertNilAuditEscrowReconciliation(
    row: Omit<NilAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<NilAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.nilAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilAuditEscrowReconciliation',
    );
  }

  async getNilAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowReconciliationRecord | undefined> {
    return this.one<NilAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.nilAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getNilAuditEscrowReconciliation',
    );
  }

  async settleNilAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update IS the CAS — a single statement that only
    // flips the row while it is still the held escrow state; the caller
    // that lost the race (or replayed) reads undefined.
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'nil_audit_escrow')
        .select()
        .maybeSingle(),
      'settleNilAuditEscrow',
    );
  }

  async upsertNilAdvanceSchedule(
    row: Omit<NilAdvanceScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAdvanceScheduleRecord> {
    // UNIQUE per nil_contract_id — an upsert converges: re-registered
    // terms replace the row atomically. No id in the payload — the id is
    // server-assigned on insert and must not rotate on conflict (the
    // PR 33 parity lesson).
    return this.oneStrict<NilAdvanceScheduleRecord>(
      this.client
        .from(TABLES.nilAdvanceSchedules)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'nil_contract_id',
        })
        .select()
        .maybeSingle(),
      'upsertNilAdvanceSchedule',
    );
  }

  async getNilAdvanceSchedule(
    nilContractId: string,
  ): Promise<NilAdvanceScheduleRecord | undefined> {
    return this.one<NilAdvanceScheduleRecord>(
      this.client
        .from(TABLES.nilAdvanceSchedules)
        .select()
        .eq('nil_contract_id', nilContractId)
        .maybeSingle(),
      'getNilAdvanceSchedule',
    );
  }

  async insertNilTransferPortalEntry(
    row: Omit<NilTransferPortalEntryRecord, 'id' | 'created_at'>,
  ): Promise<NilTransferPortalEntryRecord> {
    // Insert-as-lock — UNIQUE per (nil_contract_id, athlete_id): the
    // FIRST portal entry of record wins; a re-shipped sheet or a lost
    // race throws here (the caller reads the winner through the getter).
    return this.oneStrict<NilTransferPortalEntryRecord>(
      this.client
        .from(TABLES.nilTransferPortalEntries)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilTransferPortalEntry',
    );
  }

  async getNilTransferPortalEntry(
    nilContractId: string,
    athleteId: string,
  ): Promise<NilTransferPortalEntryRecord | undefined> {
    return this.one<NilTransferPortalEntryRecord>(
      this.client
        .from(TABLES.nilTransferPortalEntries)
        .select()
        .eq('nil_contract_id', nilContractId)
        .eq('athlete_id', athleteId)
        .maybeSingle(),
      'getNilTransferPortalEntry',
    );
  }

  async insertNilUnearnedClawback(
    row: Omit<NilUnearnedClawbackRecord, 'id' | 'created_at'>,
  ): Promise<NilUnearnedClawbackRecord> {
    // UNIQUE per portal_entry_id — the calculation and its
    // nil_unearned_clawback debit hold land once; a concurrent second
    // insert throws here (the caller reads the winner through the
    // getter).
    return this.oneStrict<NilUnearnedClawbackRecord>(
      this.client
        .from(TABLES.nilUnearnedClawbacks)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertNilUnearnedClawback',
    );
  }

  async getNilUnearnedClawback(
    portalEntryId: string,
  ): Promise<NilUnearnedClawbackRecord | undefined> {
    return this.one<NilUnearnedClawbackRecord>(
      this.client
        .from(TABLES.nilUnearnedClawbacks)
        .select()
        .eq('portal_entry_id', portalEntryId)
        .maybeSingle(),
      'getNilUnearnedClawback',
    );
  }

  // --- Spatial POS + occupancy royalties + zone allocation (PR 36, migration 0040) ---

  async upsertSpatialOccupancyTierSchedule(
    row: Omit<SpatialOccupancyTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOccupancyTierScheduleRecord> {
    // UNIQUE per (venue_id, year) — a re-registration converges (the newest
    // schedule governs the next walk). No id in the payload — the id is
    // server-assigned on insert and must not rotate on conflict (the PR 33
    // parity lesson, applied per the 0039 pattern).
    return this.oneStrict<SpatialOccupancyTierScheduleRecord>(
      this.client
        .from(TABLES.spatialOccupancyTierSchedules)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'venue_id,year',
        })
        .select()
        .maybeSingle(),
      'upsertSpatialOccupancyTierSchedule',
    );
  }

  async getSpatialOccupancyTierSchedule(
    venueId: string,
    year: string,
  ): Promise<SpatialOccupancyTierScheduleRecord | undefined> {
    return this.one<SpatialOccupancyTierScheduleRecord>(
      this.client
        .from(TABLES.spatialOccupancyTierSchedules)
        .select()
        .eq('venue_id', venueId)
        .eq('year', year)
        .maybeSingle(),
      'getSpatialOccupancyTierSchedule',
    );
  }

  async upsertSpatialOverheadPolicy(
    row: Omit<SpatialOverheadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOverheadPolicyRecord> {
    // UNIQUE per (venue_id, year) — a re-registration converges. No id in
    // the payload (the id never rotates on conflict).
    return this.oneStrict<SpatialOverheadPolicyRecord>(
      this.client
        .from(TABLES.spatialOverheadPolicies)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'venue_id,year',
        })
        .select()
        .maybeSingle(),
      'upsertSpatialOverheadPolicy',
    );
  }

  async getSpatialOverheadPolicy(
    venueId: string,
    year: string,
  ): Promise<SpatialOverheadPolicyRecord | undefined> {
    return this.one<SpatialOverheadPolicyRecord>(
      this.client
        .from(TABLES.spatialOverheadPolicies)
        .select()
        .eq('venue_id', venueId)
        .eq('year', year)
        .maybeSingle(),
      'getSpatialOverheadPolicy',
    );
  }

  async upsertSpatialZoneAssignment(
    row: Omit<SpatialZoneAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialZoneAssignmentRecord> {
    // UNIQUE per (venue_id, zone_code) — a re-registration converges (the
    // newest assignment governs the next zone walk). No id in the payload.
    return this.oneStrict<SpatialZoneAssignmentRecord>(
      this.client
        .from(TABLES.spatialZoneAssignments)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'venue_id,zone_code',
        })
        .select()
        .maybeSingle(),
      'upsertSpatialZoneAssignment',
    );
  }

  async getSpatialZoneAssignment(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialZoneAssignmentRecord | undefined> {
    return this.one<SpatialZoneAssignmentRecord>(
      this.client
        .from(TABLES.spatialZoneAssignments)
        .select()
        .eq('venue_id', venueId)
        .eq('zone_code', zoneCode)
        .maybeSingle(),
      'getSpatialZoneAssignment',
    );
  }

  async upsertSpatialMicroPolicy(
    row: Omit<SpatialMicroPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMicroPolicyRecord> {
    // UNIQUE per (venue_id, zone_code) — a re-registration converges. No
    // id in the payload.
    return this.oneStrict<SpatialMicroPolicyRecord>(
      this.client
        .from(TABLES.spatialMicroPolicies)
        .upsert({ ...row, updated_at: new Date().toISOString() }, {
          onConflict: 'venue_id,zone_code',
        })
        .select()
        .maybeSingle(),
      'upsertSpatialMicroPolicy',
    );
  }

  async getSpatialMicroPolicy(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialMicroPolicyRecord | undefined> {
    return this.one<SpatialMicroPolicyRecord>(
      this.client
        .from(TABLES.spatialMicroPolicies)
        .select()
        .eq('venue_id', venueId)
        .eq('zone_code', zoneCode)
        .maybeSingle(),
      'getSpatialMicroPolicy',
    );
  }

  async advanceSpatialThroughputYear(
    venueId: string,
    year: string,
    entriesAdded: number,
  ): Promise<SpatialThroughputYearRecord> {
    // UNIQUE per (venue_id, year) — the tracker converges: the standing
    // position plus this row's entries. The cumulative walk is serialized
    // per venue-year by the recon lane (one event at a time), so a
    // read-modify-upsert carries the same position arithmetic the SQLite
    // backend expresses additively in its ON CONFLICT arm. No id in the
    // payload (the id never rotates on conflict).
    const existing = await this.getSpatialThroughputYear(venueId, year);
    return this.oneStrict<SpatialThroughputYearRecord>(
      this.client
        .from(TABLES.spatialThroughputYears)
        .upsert(
          {
            venue_id: venueId,
            year,
            cumulative_entries: (existing?.cumulative_entries ?? 0) + entriesAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'venue_id,year' },
        )
        .select()
        .maybeSingle(),
      'advanceSpatialThroughputYear',
    );
  }

  async getSpatialThroughputYear(
    venueId: string,
    year: string,
  ): Promise<SpatialThroughputYearRecord | undefined> {
    return this.one<SpatialThroughputYearRecord>(
      this.client
        .from(TABLES.spatialThroughputYears)
        .select()
        .eq('venue_id', venueId)
        .eq('year', year)
        .maybeSingle(),
      'getSpatialThroughputYear',
    );
  }

  async insertSpatialRoyaltyApplication(
    row: Omit<SpatialRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialRoyaltyApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard: a
    // re-walked event throws here, never a double royalty (the caller
    // reads the winner through the getter).
    return this.oneStrict<SpatialRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.spatialRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialRoyaltyApplication',
    );
  }

  async getSpatialRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SpatialRoyaltyApplicationRecord | undefined> {
    return this.one<SpatialRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.spatialRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSpatialRoyaltyApplication',
    );
  }

  async insertSpatialZoneAllocation(
    row: Omit<SpatialZoneAllocationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialZoneAllocationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard: a
    // re-walked sale throws here, never a double allocation.
    return this.oneStrict<SpatialZoneAllocationRecord>(
      this.client
        .from(TABLES.spatialZoneAllocations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialZoneAllocation',
    );
  }

  async getSpatialZoneAllocation(
    sourceEventId: string,
  ): Promise<SpatialZoneAllocationRecord | undefined> {
    return this.one<SpatialZoneAllocationRecord>(
      this.client
        .from(TABLES.spatialZoneAllocations)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSpatialZoneAllocation',
    );
  }

  async insertSpatialMicroRoyalty(
    row: Omit<SpatialMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<SpatialMicroRoyaltyRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard: a
    // re-walked telemetry event throws here, never a double micro-payout.
    return this.oneStrict<SpatialMicroRoyaltyRecord>(
      this.client
        .from(TABLES.spatialMicroRoyalties)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialMicroRoyalty',
    );
  }

  async getSpatialMicroRoyalty(
    sourceEventId: string,
  ): Promise<SpatialMicroRoyaltyRecord | undefined> {
    return this.one<SpatialMicroRoyaltyRecord>(
      this.client
        .from(TABLES.spatialMicroRoyalties)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSpatialMicroRoyalty',
    );
  }

  // --- PR 37 — spatial commitments (migration 0041) ---

  async upsertSpatialCapexCommitment(
    row: Omit<SpatialCapexCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialCapexCommitmentRecord> {
    // UNIQUE per (scope_key, capex_ref) — a re-registered commitment
    // converges (the newest registered cost governs the next walk).
    // HARDENED UPSERT: no id in the payload (the id rotates on conflict).
    return this.oneStrict<SpatialCapexCommitmentRecord>(
      this.client
        .from(TABLES.spatialCapexCommitments)
        .upsert(row, { onConflict: 'scope_key,capex_ref' })
        .select()
        .maybeSingle(),
      'upsertSpatialCapexCommitment',
    );
  }

  async getSpatialCapexCommitment(
    scopeKey: string,
    capexRef: string,
  ): Promise<SpatialCapexCommitmentRecord | undefined> {
    return this.one<SpatialCapexCommitmentRecord>(
      this.client
        .from(TABLES.spatialCapexCommitments)
        .select()
        .eq('scope_key', scopeKey)
        .eq('capex_ref', capexRef)
        .maybeSingle(),
      'getSpatialCapexCommitment',
    );
  }

  async listSpatialCapexCommitments(
    scopeKey: string,
  ): Promise<SpatialCapexCommitmentRecord[]> {
    // created_at ASC — the offset walk's OLDEST-FIRST input.
    const { data, error } = await this.client
      .from(TABLES.spatialCapexCommitments)
      .select()
      .eq('scope_key', scopeKey)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listSpatialCapexCommitments failed: ${error.message}`);
    }
    return (data ?? []) as SpatialCapexCommitmentRecord[];
  }

  async insertSpatialCapexApplication(
    row: Omit<SpatialCapexApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialCapexApplicationRecord> {
    // UNIQUE per (commitment_id, source_event_id) is the replay guard and
    // UNIQUE per (commitment_id, offset_before_cents) is the position
    // lock — a replayed royalty or a lost race throws here, never a
    // double offset; the caller re-derives from the append-only truth.
    return this.oneStrict<SpatialCapexApplicationRecord>(
      this.client
        .from(TABLES.spatialCapexApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialCapexApplication',
    );
  }

  async listSpatialCapexApplications(
    commitmentId: string,
  ): Promise<SpatialCapexApplicationRecord[]> {
    // created_at ASC — the amortization schedule of record.
    const { data, error } = await this.client
      .from(TABLES.spatialCapexApplications)
      .select()
      .eq('commitment_id', commitmentId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listSpatialCapexApplications failed: ${error.message}`);
    }
    return (data ?? []) as SpatialCapexApplicationRecord[];
  }

  async upsertSpatialMsgCommitment(
    row: Omit<SpatialMsgCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgCommitmentRecord> {
    // UNIQUE per scope_key — a re-registered guarantee converges (the
    // newest priced terms govern the next close). HARDENED UPSERT: no id
    // in the payload (the id rotates on conflict).
    return this.oneStrict<SpatialMsgCommitmentRecord>(
      this.client
        .from(TABLES.spatialMsgCommitments)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertSpatialMsgCommitment',
    );
  }

  async getSpatialMsgCommitment(
    scopeKey: string,
  ): Promise<SpatialMsgCommitmentRecord | undefined> {
    return this.one<SpatialMsgCommitmentRecord>(
      this.client
        .from(TABLES.spatialMsgCommitments)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getSpatialMsgCommitment',
    );
  }

  async upsertSpatialMsgTermClose(
    row: Omit<SpatialMsgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgTermCloseRecord> {
    // UNIQUE per (commitment_id, quarter) — the once-only close; a replay
    // converges on the recorded shortfall and invoice of record.
    // HARDENED UPSERT: no id in the payload (the id rotates on conflict).
    return this.oneStrict<SpatialMsgTermCloseRecord>(
      this.client
        .from(TABLES.spatialMsgTermCloses)
        .upsert(row, { onConflict: 'commitment_id,quarter' })
        .select()
        .maybeSingle(),
      'upsertSpatialMsgTermClose',
    );
  }

  async getSpatialMsgTermClose(
    commitmentId: string,
    quarter: string,
  ): Promise<SpatialMsgTermCloseRecord | undefined> {
    return this.one<SpatialMsgTermCloseRecord>(
      this.client
        .from(TABLES.spatialMsgTermCloses)
        .select()
        .eq('commitment_id', commitmentId)
        .eq('quarter', quarter)
        .maybeSingle(),
      'getSpatialMsgTermClose',
    );
  }

  async listSpatialRoyaltyApplicationsByVenue(
    venueId: string,
  ): Promise<SpatialRoyaltyApplicationRecord[]> {
    // created_at ASC — the append-only royalty truth the MSG close sums.
    const { data, error } = await this.client
      .from(TABLES.spatialRoyaltyApplications)
      .select()
      .eq('venue_id', venueId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listSpatialRoyaltyApplicationsByVenue failed: ${error.message}`);
    }
    return (data ?? []) as SpatialRoyaltyApplicationRecord[];
  }

  async listSpatialZoneAllocationsByVenue(
    venueId: string,
  ): Promise<SpatialZoneAllocationRecord[]> {
    const { data, error } = await this.client
      .from(TABLES.spatialZoneAllocations)
      .select()
      .eq('venue_id', venueId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listSpatialZoneAllocationsByVenue failed: ${error.message}`);
    }
    return (data ?? []) as SpatialZoneAllocationRecord[];
  }

  async listSpatialMicroRoyaltiesByVenue(venueId: string): Promise<SpatialMicroRoyaltyRecord[]> {
    const { data, error } = await this.client
      .from(TABLES.spatialMicroRoyalties)
      .select()
      .eq('venue_id', venueId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listSpatialMicroRoyaltiesByVenue failed: ${error.message}`);
    }
    return (data ?? []) as SpatialMicroRoyaltyRecord[];
  }

  async insertSpatialPopupExperience(
    row: Omit<SpatialPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPopupExperienceRecord> {
    // Insert-as-lock — UNIQUE per popup_ref: the FIRST registration
    // wins; a re-shipped sheet or a lost race throws here.
    return this.oneStrict<SpatialPopupExperienceRecord>(
      this.client
        .from(TABLES.spatialPopupExperiences)
        .insert({
          ...row,
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .maybeSingle(),
      'insertSpatialPopupExperience',
    );
  }

  async getSpatialPopupExperience(
    popupRef: string,
  ): Promise<SpatialPopupExperienceRecord | undefined> {
    return this.one<SpatialPopupExperienceRecord>(
      this.client
        .from(TABLES.spatialPopupExperiences)
        .select()
        .eq('popup_ref', popupRef)
        .maybeSingle(),
      'getSpatialPopupExperience',
    );
  }

  async insertSpatialPopupWriteoff(
    row: Omit<SpatialPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupWriteoffRecord> {
    // UNIQUE per (popup_experience_id, source_event_id) — a replayed
    // calculation throws, never a double-priced write-off.
    return this.oneStrict<SpatialPopupWriteoffRecord>(
      this.client
        .from(TABLES.spatialPopupWriteoffs)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialPopupWriteoff',
    );
  }

  async listSpatialPopupWriteoffs(
    popupExperienceId: string,
  ): Promise<SpatialPopupWriteoffRecord[]> {
    const { data, error } = await this.client
      .from(TABLES.spatialPopupWriteoffs)
      .select()
      .eq('popup_experience_id', popupExperienceId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listSpatialPopupWriteoffs failed: ${error.message}`);
    }
    return (data ?? []) as SpatialPopupWriteoffRecord[];
  }

  async insertSpatialPopupRestorationReserve(
    row: Omit<SpatialPopupRestorationReserveRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupRestorationReserveRecord> {
    // Insert-as-lock — UNIQUE per popup_experience_id: the FIRST reserve
    // wins; a concurrent second insert throws here.
    return this.oneStrict<SpatialPopupRestorationReserveRecord>(
      this.client
        .from(TABLES.spatialPopupRestorationReserves)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialPopupRestorationReserve',
    );
  }

  async getSpatialPopupRestorationReserve(
    popupExperienceId: string,
  ): Promise<SpatialPopupRestorationReserveRecord | undefined> {
    return this.one<SpatialPopupRestorationReserveRecord>(
      this.client
        .from(TABLES.spatialPopupRestorationReserves)
        .select()
        .eq('popup_experience_id', popupExperienceId)
        .maybeSingle(),
      'getSpatialPopupRestorationReserve',
    );
  }

  async upsertSpatialAuditEscrowPolicy(
    row: Omit<SpatialAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing). HARDENED UPSERT: no id in
    // the payload (the id rotates on conflict).
    return this.oneStrict<SpatialAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.spatialAuditEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertSpatialAuditEscrowPolicy',
    );
  }

  async getSpatialAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<SpatialAuditEscrowPolicyRecord | undefined> {
    return this.one<SpatialAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.spatialAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getSpatialAuditEscrowPolicy',
    );
  }

  async insertSpatialAuditEscrowDrawdown(
    row: Omit<SpatialAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<SpatialAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.spatialAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialAuditEscrowDrawdown',
    );
  }

  async listSpatialAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique position column orders same-millisecond rows honestly.
    const { data, error } = await this.client
      .from(TABLES.spatialAuditEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listSpatialAuditEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as SpatialAuditEscrowDrawdownRecord[];
  }

  async insertSpatialAuditEscrowReconciliation(
    row: Omit<SpatialAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<SpatialAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.spatialAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSpatialAuditEscrowReconciliation',
    );
  }

  async getSpatialAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowReconciliationRecord | undefined> {
    return this.one<SpatialAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.spatialAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getSpatialAuditEscrowReconciliation',
    );
  }

  async settleSpatialAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'spatial_audit_escrow')
      .select();
    if (error) {
      throw new Error(`settleSpatialAuditEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertSpatialPayoutGateState(
    row: Omit<SpatialPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPayoutGateStateRecord> {
    // UNIQUE per (payee_id, venue_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<SpatialPayoutGateStateRecord>(
      this.client
        .from(TABLES.spatialPayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,venue_id' })
        .select()
        .maybeSingle(),
      'upsertSpatialPayoutGateState',
    );
  }

  async getSpatialPayoutGateState(
    payeeId: string,
    venueId: string,
  ): Promise<SpatialPayoutGateStateRecord | undefined> {
    return this.one<SpatialPayoutGateStateRecord>(
      this.client
        .from(TABLES.spatialPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('venue_id', venueId)
        .maybeSingle(),
      'getSpatialPayoutGateState',
    );
  }

  // --- The fitness lane (PR 38, migration 0042) ---

  async upsertFitnessTrainerTierSchedule(
    row: Omit<FitnessTrainerTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessTrainerTierScheduleRecord> {
    // UNIQUE per (trainer_id, program_id) — the newest schedule governs the
    // next walk. HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict — the PR 33 lesson).
    return this.oneStrict<FitnessTrainerTierScheduleRecord>(
      this.client
        .from(TABLES.fitnessTrainerTierSchedules)
        .upsert(row, { onConflict: 'trainer_id,program_id' })
        .select()
        .maybeSingle(),
      'upsertFitnessTrainerTierSchedule',
    );
  }

  async getFitnessTrainerTierSchedule(
    trainerId: string,
    programId: string,
  ): Promise<FitnessTrainerTierScheduleRecord | undefined> {
    return this.one<FitnessTrainerTierScheduleRecord>(
      this.client
        .from(TABLES.fitnessTrainerTierSchedules)
        .select()
        .eq('trainer_id', trainerId)
        .eq('program_id', programId)
        .maybeSingle(),
      'getFitnessTrainerTierSchedule',
    );
  }

  async upsertFitnessSyncMusicPolicy(
    row: Omit<FitnessSyncMusicPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessSyncMusicPolicyRecord> {
    // UNIQUE per program_id — a re-registration converges. HARDENED
    // UPSERT: no id in the payload.
    return this.oneStrict<FitnessSyncMusicPolicyRecord>(
      this.client
        .from(TABLES.fitnessSyncMusicPolicies)
        .upsert(row, { onConflict: 'program_id' })
        .select()
        .maybeSingle(),
      'upsertFitnessSyncMusicPolicy',
    );
  }

  async getFitnessSyncMusicPolicy(
    programId: string,
  ): Promise<FitnessSyncMusicPolicyRecord | undefined> {
    return this.one<FitnessSyncMusicPolicyRecord>(
      this.client
        .from(TABLES.fitnessSyncMusicPolicies)
        .select()
        .eq('program_id', programId)
        .maybeSingle(),
      'getFitnessSyncMusicPolicy',
    );
  }

  async upsertFitnessLiveLoadPolicy(
    row: Omit<FitnessLiveLoadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveLoadPolicyRecord> {
    // UNIQUE per program_id — a re-registration converges. HARDENED
    // UPSERT: no id in the payload.
    return this.oneStrict<FitnessLiveLoadPolicyRecord>(
      this.client
        .from(TABLES.fitnessLiveLoadPolicies)
        .upsert(row, { onConflict: 'program_id' })
        .select()
        .maybeSingle(),
      'upsertFitnessLiveLoadPolicy',
    );
  }

  async getFitnessLiveLoadPolicy(
    programId: string,
  ): Promise<FitnessLiveLoadPolicyRecord | undefined> {
    return this.one<FitnessLiveLoadPolicyRecord>(
      this.client
        .from(TABLES.fitnessLiveLoadPolicies)
        .select()
        .eq('program_id', programId)
        .maybeSingle(),
      'getFitnessLiveLoadPolicy',
    );
  }

  async upsertFitnessFranchisePolicy(
    row: Omit<FitnessFranchisePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessFranchisePolicyRecord> {
    // UNIQUE per studio_franchise_code — a re-registration converges.
    // HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FitnessFranchisePolicyRecord>(
      this.client
        .from(TABLES.fitnessFranchisePolicies)
        .upsert(row, { onConflict: 'studio_franchise_code' })
        .select()
        .maybeSingle(),
      'upsertFitnessFranchisePolicy',
    );
  }

  async getFitnessFranchisePolicy(
    studioFranchiseCode: string,
  ): Promise<FitnessFranchisePolicyRecord | undefined> {
    return this.one<FitnessFranchisePolicyRecord>(
      this.client
        .from(TABLES.fitnessFranchisePolicies)
        .select()
        .eq('studio_franchise_code', studioFranchiseCode)
        .maybeSingle(),
      'getFitnessFranchisePolicy',
    );
  }

  async upsertFitnessCoBrandPartnership(
    row: Omit<FitnessCoBrandPartnershipRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCoBrandPartnershipRecord> {
    // UNIQUE per studio_franchise_code — a re-registration converges.
    // HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FitnessCoBrandPartnershipRecord>(
      this.client
        .from(TABLES.fitnessCoBrandPartnerships)
        .upsert(row, { onConflict: 'studio_franchise_code' })
        .select()
        .maybeSingle(),
      'upsertFitnessCoBrandPartnership',
    );
  }

  async getFitnessCoBrandPartnership(
    studioFranchiseCode: string,
  ): Promise<FitnessCoBrandPartnershipRecord | undefined> {
    return this.one<FitnessCoBrandPartnershipRecord>(
      this.client
        .from(TABLES.fitnessCoBrandPartnerships)
        .select()
        .eq('studio_franchise_code', studioFranchiseCode)
        .maybeSingle(),
      'getFitnessCoBrandPartnership',
    );
  }

  async upsertFitnessAlgorithmPolicy(
    row: Omit<FitnessAlgorithmPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAlgorithmPolicyRecord> {
    // UNIQUE per program_id — a re-registration converges. HARDENED
    // UPSERT: no id in the payload.
    return this.oneStrict<FitnessAlgorithmPolicyRecord>(
      this.client
        .from(TABLES.fitnessAlgorithmPolicies)
        .upsert(row, { onConflict: 'program_id' })
        .select()
        .maybeSingle(),
      'upsertFitnessAlgorithmPolicy',
    );
  }

  async getFitnessAlgorithmPolicy(
    programId: string,
  ): Promise<FitnessAlgorithmPolicyRecord | undefined> {
    return this.one<FitnessAlgorithmPolicyRecord>(
      this.client
        .from(TABLES.fitnessAlgorithmPolicies)
        .select()
        .eq('program_id', programId)
        .maybeSingle(),
      'getFitnessAlgorithmPolicy',
    );
  }

  async upsertFitnessCocreationModule(
    row: Omit<FitnessCocreationModuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCocreationModuleRecord> {
    // UNIQUE per (program_id, module_id) — a re-registration converges.
    // HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FitnessCocreationModuleRecord>(
      this.client
        .from(TABLES.fitnessCocreationModules)
        .upsert(row, { onConflict: 'program_id,module_id' })
        .select()
        .maybeSingle(),
      'upsertFitnessCocreationModule',
    );
  }

  async listFitnessCocreationModules(
    programId: string,
  ): Promise<FitnessCocreationModuleRecord[]> {
    // Registration order (the insertion order the waterfall walk reads).
    const { data, error } = await this.client
      .from(TABLES.fitnessCocreationModules)
      .select()
      .eq('program_id', programId)
      .order('created_at');
    if (error) {
      throw new Error(`listFitnessCocreationModules failed: ${error.message}`);
    }
    return (data ?? []) as FitnessCocreationModuleRecord[];
  }

  async advanceFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
    completionsAdded: number,
  ): Promise<FitnessCompletionMonthRecord> {
    // UNIQUE per (trainer_id, program_id, month) — the tracker converges.
    // The cumulative walk is serialized per trainer-program-month by the
    // recon lane (one event at a time), so a read-modify-upsert carries
    // the same position arithmetic the SQLite backend expresses additively
    // in its ON CONFLICT arm. No id in the payload.
    const existing = await this.getFitnessCompletionMonth(trainerId, programId, month);
    return this.oneStrict<FitnessCompletionMonthRecord>(
      this.client
        .from(TABLES.fitnessCompletionMonths)
        .upsert(
          {
            trainer_id: trainerId,
            program_id: programId,
            month,
            cumulative_completions: (existing?.cumulative_completions ?? 0) + completionsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'trainer_id,program_id,month' },
        )
        .select()
        .maybeSingle(),
      'advanceFitnessCompletionMonth',
    );
  }

  async getFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
  ): Promise<FitnessCompletionMonthRecord | undefined> {
    return this.one<FitnessCompletionMonthRecord>(
      this.client
        .from(TABLES.fitnessCompletionMonths)
        .select()
        .eq('trainer_id', trainerId)
        .eq('program_id', programId)
        .eq('month', month)
        .maybeSingle(),
      'getFitnessCompletionMonth',
    );
  }

  async advanceFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
    classesAdded: number,
  ): Promise<FitnessFranchiseClassMonthRecord> {
    // UNIQUE per (studio_franchise_code, month) — the tracker converges;
    // same read-modify-upsert as the completion tracker. No id in the
    // payload.
    const existing = await this.getFitnessFranchiseClassMonth(studioFranchiseCode, month);
    return this.oneStrict<FitnessFranchiseClassMonthRecord>(
      this.client
        .from(TABLES.fitnessFranchiseClassMonths)
        .upsert(
          {
            studio_franchise_code: studioFranchiseCode,
            month,
            cumulative_classes: (existing?.cumulative_classes ?? 0) + classesAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'studio_franchise_code,month' },
        )
        .select()
        .maybeSingle(),
      'advanceFitnessFranchiseClassMonth',
    );
  }

  async getFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
  ): Promise<FitnessFranchiseClassMonthRecord | undefined> {
    return this.one<FitnessFranchiseClassMonthRecord>(
      this.client
        .from(TABLES.fitnessFranchiseClassMonths)
        .select()
        .eq('studio_franchise_code', studioFranchiseCode)
        .eq('month', month)
        .maybeSingle(),
      'getFitnessFranchiseClassMonth',
    );
  }

  async insertFitnessRealizationApplication(
    row: Omit<FitnessRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessRealizationApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard: a
    // re-walked allocation throws here, never a double application.
    return this.oneStrict<FitnessRealizationApplicationRecord>(
      this.client
        .from(TABLES.fitnessRealizationApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessRealizationApplication',
    );
  }

  async getFitnessRealizationApplication(
    sourceEventId: string,
  ): Promise<FitnessRealizationApplicationRecord | undefined> {
    return this.one<FitnessRealizationApplicationRecord>(
      this.client
        .from(TABLES.fitnessRealizationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessRealizationApplication',
    );
  }

  async insertFitnessTrainerRoyaltyApplication(
    row: Omit<FitnessTrainerRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard.
    return this.oneStrict<FitnessTrainerRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.fitnessTrainerRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessTrainerRoyaltyApplication',
    );
  }

  async getFitnessTrainerRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord | undefined> {
    return this.one<FitnessTrainerRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.fitnessTrainerRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessTrainerRoyaltyApplication',
    );
  }

  async insertFitnessLiveResidualApplication(
    row: Omit<FitnessLiveResidualApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveResidualApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard.
    return this.oneStrict<FitnessLiveResidualApplicationRecord>(
      this.client
        .from(TABLES.fitnessLiveResidualApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessLiveResidualApplication',
    );
  }

  async getFitnessLiveResidualApplication(
    sourceEventId: string,
  ): Promise<FitnessLiveResidualApplicationRecord | undefined> {
    return this.one<FitnessLiveResidualApplicationRecord>(
      this.client
        .from(TABLES.fitnessLiveResidualApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessLiveResidualApplication',
    );
  }

  async insertFitnessFranchiseApplication(
    row: Omit<FitnessFranchiseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessFranchiseApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard.
    return this.oneStrict<FitnessFranchiseApplicationRecord>(
      this.client
        .from(TABLES.fitnessFranchiseApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessFranchiseApplication',
    );
  }

  async getFitnessFranchiseApplication(
    sourceEventId: string,
  ): Promise<FitnessFranchiseApplicationRecord | undefined> {
    return this.one<FitnessFranchiseApplicationRecord>(
      this.client
        .from(TABLES.fitnessFranchiseApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessFranchiseApplication',
    );
  }

  async insertFitnessCobrandSplitApplication(
    row: Omit<FitnessCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCobrandSplitApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard.
    return this.oneStrict<FitnessCobrandSplitApplicationRecord>(
      this.client
        .from(TABLES.fitnessCobrandSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessCobrandSplitApplication',
    );
  }

  async getFitnessCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FitnessCobrandSplitApplicationRecord | undefined> {
    return this.one<FitnessCobrandSplitApplicationRecord>(
      this.client
        .from(TABLES.fitnessCobrandSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessCobrandSplitApplication',
    );
  }

  async insertFitnessAlgorithmRoyalty(
    row: Omit<FitnessAlgorithmRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAlgorithmRoyaltyRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard.
    return this.oneStrict<FitnessAlgorithmRoyaltyRecord>(
      this.client
        .from(TABLES.fitnessAlgorithmRoyaltyLedger)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessAlgorithmRoyalty',
    );
  }

  async getFitnessAlgorithmRoyalty(
    sourceEventId: string,
  ): Promise<FitnessAlgorithmRoyaltyRecord | undefined> {
    return this.one<FitnessAlgorithmRoyaltyRecord>(
      this.client
        .from(TABLES.fitnessAlgorithmRoyaltyLedger)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessAlgorithmRoyalty',
    );
  }

  async insertFitnessCocreationApplication(
    row: Omit<FitnessCocreationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCocreationApplicationRecord> {
    // Insert-as-lock — UNIQUE per source_event_id is the replay guard.
    return this.oneStrict<FitnessCocreationApplicationRecord>(
      this.client
        .from(TABLES.fitnessCocreationApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessCocreationApplication',
    );
  }

  async getFitnessCocreationApplication(
    sourceEventId: string,
  ): Promise<FitnessCocreationApplicationRecord | undefined> {
    return this.one<FitnessCocreationApplicationRecord>(
      this.client
        .from(TABLES.fitnessCocreationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessCocreationApplication',
    );
  }

  // --- The fitness audit escrow + gate states + live-event bonuses (PR 39,
  // migration 0043) — the 0041 spatial twins' PostgREST shape. ---

  async upsertFitnessAuditEscrowPolicy(
    row: Omit<FitnessAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing). HARDENED UPSERT: no id in
    // the payload (the id rotates on conflict).
    return this.oneStrict<FitnessAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.fitnessAuditEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertFitnessAuditEscrowPolicy',
    );
  }

  async getFitnessAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<FitnessAuditEscrowPolicyRecord | undefined> {
    return this.one<FitnessAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.fitnessAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getFitnessAuditEscrowPolicy',
    );
  }

  async insertFitnessAuditEscrowDrawdown(
    row: Omit<FitnessAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<FitnessAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.fitnessAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessAuditEscrowDrawdown',
    );
  }

  async listFitnessAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    const { data, error } = await this.client
      .from(TABLES.fitnessAuditEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listFitnessAuditEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as FitnessAuditEscrowDrawdownRecord[];
  }

  async insertFitnessAuditEscrowReconciliation(
    row: Omit<FitnessAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<FitnessAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.fitnessAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessAuditEscrowReconciliation',
    );
  }

  async getFitnessAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowReconciliationRecord | undefined> {
    return this.one<FitnessAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.fitnessAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getFitnessAuditEscrowReconciliation',
    );
  }

  async settleFitnessAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'fitness_audit_escrow')
      .select();
    if (error) {
      throw new Error(`settleFitnessAuditEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertFitnessPayoutGateState(
    row: Omit<FitnessPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessPayoutGateStateRecord> {
    // UNIQUE per (payee_id, studio_franchise_code) — an upsert converges
    // (a verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<FitnessPayoutGateStateRecord>(
      this.client
        .from(TABLES.fitnessPayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,studio_franchise_code' })
        .select()
        .maybeSingle(),
      'upsertFitnessPayoutGateState',
    );
  }

  async getFitnessPayoutGateState(
    payeeId: string,
    studioFranchiseCode: string,
  ): Promise<FitnessPayoutGateStateRecord | undefined> {
    return this.one<FitnessPayoutGateStateRecord>(
      this.client
        .from(TABLES.fitnessPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('studio_franchise_code', studioFranchiseCode)
        .maybeSingle(),
      'getFitnessPayoutGateState',
    );
  }

  async upsertFitnessLiveEventBonusPolicy(
    row: Omit<FitnessLiveEventBonusPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveEventBonusPolicyRecord> {
    // UNIQUE per program_id — a re-registered policy converges (the
    // newest rate governs the next concluded event's posting).
    // HARDENED UPSERT: no id in the payload (the id rotates on conflict).
    return this.oneStrict<FitnessLiveEventBonusPolicyRecord>(
      this.client
        .from(TABLES.fitnessLiveEventBonusPolicies)
        .upsert(row, { onConflict: 'program_id' })
        .select()
        .maybeSingle(),
      'upsertFitnessLiveEventBonusPolicy',
    );
  }

  async getFitnessLiveEventBonusPolicy(
    programId: string,
  ): Promise<FitnessLiveEventBonusPolicyRecord | undefined> {
    return this.one<FitnessLiveEventBonusPolicyRecord>(
      this.client
        .from(TABLES.fitnessLiveEventBonusPolicies)
        .select()
        .eq('program_id', programId)
        .maybeSingle(),
      'getFitnessLiveEventBonusPolicy',
    );
  }

  async insertFitnessLiveEventBonus(
    row: Omit<FitnessLiveEventBonusRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveEventBonusRecord> {
    // UNIQUE per source_event_id — the replay guard: a replayed event
    // row throws here, never a double bonus; the caller re-derives from
    // the ledger of record.
    return this.oneStrict<FitnessLiveEventBonusRecord>(
      this.client
        .from(TABLES.fitnessLiveEventBonuses)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFitnessLiveEventBonus',
    );
  }

  async getFitnessLiveEventBonus(
    sourceEventId: string,
  ): Promise<FitnessLiveEventBonusRecord | undefined> {
    return this.one<FitnessLiveEventBonusRecord>(
      this.client
        .from(TABLES.fitnessLiveEventBonuses)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFitnessLiveEventBonus',
    );
  }

  // --- PR 40, migration 0044 — the food lane (the founder food directive) ---

  async upsertFoodRecipeRoyaltySchedule(
    row: Omit<FoodRecipeRoyaltyScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodRecipeRoyaltyScheduleRecord> {
    // UNIQUE per (chef_id, recipe_id) — a re-registered schedule replaces
    // the row atomically (the newest schedule governs the next walk).
    // HARDENED UPSERT: no id in the payload (the id rotates on conflict).
    return this.oneStrict<FoodRecipeRoyaltyScheduleRecord>(
      this.client
        .from(TABLES.foodRecipeRoyaltySchedules)
        .upsert(row, { onConflict: 'chef_id,recipe_id' })
        .select()
        .maybeSingle(),
      'upsertFoodRecipeRoyaltySchedule',
    );
  }

  async getFoodRecipeRoyaltySchedule(
    chefId: string,
    recipeId: string,
  ): Promise<FoodRecipeRoyaltyScheduleRecord | undefined> {
    return this.one<FoodRecipeRoyaltyScheduleRecord>(
      this.client
        .from(TABLES.foodRecipeRoyaltySchedules)
        .select()
        .eq('chef_id', chefId)
        .eq('recipe_id', recipeId)
        .maybeSingle(),
      'getFoodRecipeRoyaltySchedule',
    );
  }

  async advanceFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
    unitsAdded: number,
  ): Promise<FoodLocationUnitMonthRecord> {
    // UNIQUE per (ghost_kitchen_location_id, month) — the tracker
    // converges. Same read-modify-upsert as the fitness completion
    // tracker: the cumulative walk is serialized per location-month by
    // the recon lane, so a read-modify-upsert carries the same position
    // arithmetic the SQLite backend expresses additively in its ON
    // CONFLICT arm. No id in the payload.
    const existing = await this.getFoodLocationUnitMonth(ghostKitchenLocationId, month);
    return this.oneStrict<FoodLocationUnitMonthRecord>(
      this.client
        .from(TABLES.foodLocationUnitMonths)
        .upsert(
          {
            ghost_kitchen_location_id: ghostKitchenLocationId,
            month,
            cumulative_units: (existing?.cumulative_units ?? 0) + unitsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'ghost_kitchen_location_id,month' },
        )
        .select()
        .maybeSingle(),
      'advanceFoodLocationUnitMonth',
    );
  }

  async getFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
  ): Promise<FoodLocationUnitMonthRecord | undefined> {
    return this.one<FoodLocationUnitMonthRecord>(
      this.client
        .from(TABLES.foodLocationUnitMonths)
        .select()
        .eq('ghost_kitchen_location_id', ghostKitchenLocationId)
        .eq('month', month)
        .maybeSingle(),
      'getFoodLocationUnitMonth',
    );
  }

  async upsertFoodHostOperatorPolicy(
    row: Omit<FoodHostOperatorPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodHostOperatorPolicyRecord> {
    // UNIQUE per ghost_kitchen_location_id — a re-registered policy
    // replaces the row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FoodHostOperatorPolicyRecord>(
      this.client
        .from(TABLES.foodHostOperatorPolicies)
        .upsert(row, { onConflict: 'ghost_kitchen_location_id' })
        .select()
        .maybeSingle(),
      'upsertFoodHostOperatorPolicy',
    );
  }

  async getFoodHostOperatorPolicy(
    ghostKitchenLocationId: string,
  ): Promise<FoodHostOperatorPolicyRecord | undefined> {
    return this.one<FoodHostOperatorPolicyRecord>(
      this.client
        .from(TABLES.foodHostOperatorPolicies)
        .select()
        .eq('ghost_kitchen_location_id', ghostKitchenLocationId)
        .maybeSingle(),
      'getFoodHostOperatorPolicy',
    );
  }

  async upsertFoodCookCyclePolicy(
    row: Omit<FoodCookCyclePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCookCyclePolicyRecord> {
    // UNIQUE per (chef_id, recipe_id) — a re-registered policy replaces
    // the row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FoodCookCyclePolicyRecord>(
      this.client
        .from(TABLES.foodCookCyclePolicies)
        .upsert(row, { onConflict: 'chef_id,recipe_id' })
        .select()
        .maybeSingle(),
      'upsertFoodCookCyclePolicy',
    );
  }

  async getFoodCookCyclePolicy(
    chefId: string,
    recipeId: string,
  ): Promise<FoodCookCyclePolicyRecord | undefined> {
    return this.one<FoodCookCyclePolicyRecord>(
      this.client
        .from(TABLES.foodCookCyclePolicies)
        .select()
        .eq('chef_id', chefId)
        .eq('recipe_id', recipeId)
        .maybeSingle(),
      'getFoodCookCyclePolicy',
    );
  }

  async upsertFoodCobrandWeighting(
    row: Omit<FoodCobrandWeightingRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCobrandWeightingRecord> {
    // UNIQUE per (recipe_id, leg_id) — a re-registered leg converges.
    // HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FoodCobrandWeightingRecord>(
      this.client
        .from(TABLES.foodCobrandWeightings)
        .upsert(row, { onConflict: 'recipe_id,leg_id' })
        .select()
        .maybeSingle(),
      'upsertFoodCobrandWeighting',
    );
  }

  async listFoodCobrandWeightings(recipeId: string): Promise<FoodCobrandWeightingRecord[]> {
    // Registration order (the insertion order the split walk reads).
    const { data, error } = await this.client
      .from(TABLES.foodCobrandWeightings)
      .select()
      .eq('recipe_id', recipeId)
      .order('created_at');
    if (error) {
      throw new Error(`listFoodCobrandWeightings failed: ${error.message}`);
    }
    return (data ?? []) as FoodCobrandWeightingRecord[];
  }

  async upsertFoodOperatorWaterfallLeg(
    row: Omit<FoodOperatorWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodOperatorWaterfallRecord> {
    // UNIQUE per (ghost_kitchen_location_id, operator_id) — a
    // re-registered leg converges. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<FoodOperatorWaterfallRecord>(
      this.client
        .from(TABLES.foodOperatorWaterfalls)
        .upsert(row, { onConflict: 'ghost_kitchen_location_id,operator_id' })
        .select()
        .maybeSingle(),
      'upsertFoodOperatorWaterfallLeg',
    );
  }

  async listFoodOperatorWaterfallLegs(
    ghostKitchenLocationId: string,
  ): Promise<FoodOperatorWaterfallRecord[]> {
    // Registration order (the insertion order the rebate walk reads).
    const { data, error } = await this.client
      .from(TABLES.foodOperatorWaterfalls)
      .select()
      .eq('ghost_kitchen_location_id', ghostKitchenLocationId)
      .order('created_at');
    if (error) {
      throw new Error(`listFoodOperatorWaterfallLegs failed: ${error.message}`);
    }
    return (data ?? []) as FoodOperatorWaterfallRecord[];
  }

  async insertFoodRealizationApplication(
    row: Omit<FoodRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-walked order
    // throws here, never a double application; the caller re-derives
    // from the application of record.
    return this.oneStrict<FoodRealizationApplicationRecord>(
      this.client
        .from(TABLES.foodRealizationApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFoodRealizationApplication',
    );
  }

  async getFoodRealizationApplication(
    sourceEventId: string,
  ): Promise<FoodRealizationApplicationRecord | undefined> {
    return this.one<FoodRealizationApplicationRecord>(
      this.client
        .from(TABLES.foodRealizationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFoodRealizationApplication',
    );
  }

  async insertFoodRecipeRoyaltyApplication(
    row: Omit<FoodRecipeRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRecipeRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<FoodRecipeRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.foodRecipeRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFoodRecipeRoyaltyApplication',
    );
  }

  async getFoodRecipeRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FoodRecipeRoyaltyApplicationRecord | undefined> {
    return this.one<FoodRecipeRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.foodRecipeRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFoodRecipeRoyaltyApplication',
    );
  }

  async insertFoodCobrandSplitApplication(
    row: Omit<FoodCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodCobrandSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<FoodCobrandSplitApplicationRecord>(
      this.client
        .from(TABLES.foodCobrandSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFoodCobrandSplitApplication',
    );
  }

  async getFoodCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FoodCobrandSplitApplicationRecord | undefined> {
    return this.one<FoodCobrandSplitApplicationRecord>(
      this.client
        .from(TABLES.foodCobrandSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFoodCobrandSplitApplication',
    );
  }

  async insertFoodHostOperatorSplitApplication(
    row: Omit<FoodHostOperatorSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodHostOperatorSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<FoodHostOperatorSplitApplicationRecord>(
      this.client
        .from(TABLES.foodHostOperatorSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFoodHostOperatorSplitApplication',
    );
  }

  async getFoodHostOperatorSplitApplication(
    sourceEventId: string,
  ): Promise<FoodHostOperatorSplitApplicationRecord | undefined> {
    return this.one<FoodHostOperatorSplitApplicationRecord>(
      this.client
        .from(TABLES.foodHostOperatorSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFoodHostOperatorSplitApplication',
    );
  }

  async insertFoodCookCycleRoyalty(
    row: Omit<FoodCookCycleRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FoodCookCycleRoyaltyRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<FoodCookCycleRoyaltyRecord>(
      this.client
        .from(TABLES.foodCookCycleRoyalties)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFoodCookCycleRoyalty',
    );
  }

  async getFoodCookCycleRoyalty(
    sourceEventId: string,
  ): Promise<FoodCookCycleRoyaltyRecord | undefined> {
    return this.one<FoodCookCycleRoyaltyRecord>(
      this.client
        .from(TABLES.foodCookCycleRoyalties)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFoodCookCycleRoyalty',
    );
  }

  async insertFoodSupplierRebateApplication(
    row: Omit<FoodSupplierRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodSupplierRebateApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<FoodSupplierRebateApplicationRecord>(
      this.client
        .from(TABLES.foodSupplierRebateApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertFoodSupplierRebateApplication',
    );
  }

  async getFoodSupplierRebateApplication(
    sourceEventId: string,
  ): Promise<FoodSupplierRebateApplicationRecord | undefined> {
    return this.one<FoodSupplierRebateApplicationRecord>(
      this.client
        .from(TABLES.foodSupplierRebateApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getFoodSupplierRebateApplication',
    );
  }

  // --- IP adaptation optioning (PR 21, migration 0025) ---

  async upsertIpOptionAgreement(
    row: Omit<IpOptionAgreementRecord, 'id'>,
  ): Promise<IpOptionAgreementRecord> {
    // One agreement of record per work — the upsert targets work_id, so a
    // re-registered agreement replaces the row atomically (the
    // localization-contract precedent).
    return this.oneStrict<IpOptionAgreementRecord>(
      this.client
        .from(TABLES.ipOptionAgreements)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'work_id' })
        .select()
        .maybeSingle(),
      'upsertIpOptionAgreement',
    );
  }

  async getIpOptionAgreement(workId: string): Promise<IpOptionAgreementRecord | undefined> {
    return this.one<IpOptionAgreementRecord>(
      this.client
        .from(TABLES.ipOptionAgreements)
        .select()
        .eq('work_id', workId)
        .maybeSingle(),
      'getIpOptionAgreement',
    );
  }

  async insertIpOptionAuthorAllocation(
    row: Omit<IpOptionAuthorAllocationRecord, 'id'>,
  ): Promise<IpOptionAuthorAllocationRecord> {
    // UNIQUE on (work_id, payee_id) — a duplicate registration throws the
    // unique violation (the replay surface).
    return this.oneStrict<IpOptionAuthorAllocationRecord>(
      this.client
        .from(TABLES.ipOptionAuthorAllocations)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertIpOptionAuthorAllocation',
    );
  }

  async listIpOptionAuthorAllocations(workId: string): Promise<IpOptionAuthorAllocationRecord[]> {
    // created_at ASC with the insertion-order tiebreak — the deterministic
    // author-first reservation order.
    return this.many<IpOptionAuthorAllocationRecord>(
      this.client
        .from(TABLES.ipOptionAuthorAllocations)
        .select()
        .eq('work_id', workId)
        .order('created_at', { ascending: true })
        .order('insertion_order', { ascending: true }),
      'listIpOptionAuthorAllocations',
    );
  }

  async upsertPublishingIpRightsVerification(
    row: Omit<PublishingIpRightsVerificationRecord, 'id'>,
  ): Promise<PublishingIpRightsVerificationRecord> {
    // One verification state per (payee, work) — the upsert targets the
    // pair, so a re-verification replaces the row atomically (the
    // studio-KYC precedent, at work scope).
    return this.oneStrict<PublishingIpRightsVerificationRecord>(
      this.client
        .from(TABLES.publishingIpRightsVerifications)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'payee_id,work_id' })
        .select()
        .maybeSingle(),
      'upsertPublishingIpRightsVerification',
    );
  }

  async getPublishingIpRightsVerification(
    payeeId: string,
    workId: string,
  ): Promise<PublishingIpRightsVerificationRecord | undefined> {
    return this.one<PublishingIpRightsVerificationRecord>(
      this.client
        .from(TABLES.publishingIpRightsVerifications)
        .select()
        .eq('payee_id', payeeId)
        .eq('work_id', workId)
        .maybeSingle(),
      'getPublishingIpRightsVerification',
    );
  }

  // --- Merch COGS + the brand collaboration waterfall (PR 22, migration 0026) ---

  async insertMerchCogsLot(row: Omit<MerchCogsLotRecord, 'id'>): Promise<MerchCogsLotRecord> {
    // UNIQUE on (sku_id, lot_ref) — a re-registered lot throws the unique
    // violation (the replay surface).
    return this.oneStrict<MerchCogsLotRecord>(
      this.client
        .from(TABLES.merchCogsLots)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchCogsLot',
    );
  }

  async listMerchCogsLots(skuId: string): Promise<MerchCogsLotRecord[]> {
    // FIFO order — created_at ASC, then lot_ref ASC (the deterministic tie).
    return this.many<MerchCogsLotRecord>(
      this.client
        .from(TABLES.merchCogsLots)
        .select()
        .eq('sku_id', skuId)
        .order('created_at', { ascending: true })
        .order('lot_ref', { ascending: true }),
      'listMerchCogsLots',
    );
  }

  async insertMerchCogsConsumption(
    row: Omit<MerchCogsConsumptionRecord, 'id'>,
  ): Promise<MerchCogsConsumptionRecord> {
    // UNIQUE on (lot_id, source_event_id) — a replayed fulfillment event is
    // the unique violation, never a double amortization. UNIQUE on
    // (lot_id, units_consumed_before) — the insert-as-lock position
    // arbiter: a concurrent consumer that loses the position throws.
    return this.oneStrict<MerchCogsConsumptionRecord>(
      this.client
        .from(TABLES.merchCogsConsumptions)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchCogsConsumption',
    );
  }

  async listMerchCogsConsumptions(lotId: string): Promise<MerchCogsConsumptionRecord[]> {
    return this.many<MerchCogsConsumptionRecord>(
      this.client
        .from(TABLES.merchCogsConsumptions)
        .select()
        .eq('lot_id', lotId)
        .order('units_consumed_before', { ascending: true }),
      'listMerchCogsConsumptions',
    );
  }

  async upsertMerchCollabAgreement(
    row: Omit<MerchCollabAgreementRecord, 'id'>,
  ): Promise<MerchCollabAgreementRecord> {
    // One agreement of record per sku — the upsert targets sku_id, so a
    // re-registered agreement replaces the row atomically (the
    // option-agreement precedent).
    return this.oneStrict<MerchCollabAgreementRecord>(
      this.client
        .from(TABLES.merchCollabAgreements)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'sku_id' })
        .select()
        .maybeSingle(),
      'upsertMerchCollabAgreement',
    );
  }

  async getMerchCollabAgreement(skuId: string): Promise<MerchCollabAgreementRecord | undefined> {
    return this.one<MerchCollabAgreementRecord>(
      this.client
        .from(TABLES.merchCollabAgreements)
        .select()
        .eq('sku_id', skuId)
        .maybeSingle(),
      'getMerchCollabAgreement',
    );
  }

  async insertMerchCollabRecoupmentApplication(
    row: Omit<MerchCollabRecoupmentApplicationRecord, 'id'>,
  ): Promise<MerchCollabRecoupmentApplicationRecord> {
    // UNIQUE on (agreement_id, pool_class, source_event_id) — a replayed
    // settlement is the unique violation, never a double recovery. UNIQUE
    // on (agreement_id, pool_class, recouped_before_cents) — the
    // insert-as-lock position arbiter.
    return this.oneStrict<MerchCollabRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.merchCollabRecoupmentApplications)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchCollabRecoupmentApplication',
    );
  }

  async listMerchCollabRecoupmentApplications(
    agreementId: string,
    poolClass: MerchCollabPoolClass,
  ): Promise<MerchCollabRecoupmentApplicationRecord[]> {
    return this.many<MerchCollabRecoupmentApplicationRecord>(
      this.client
        .from(TABLES.merchCollabRecoupmentApplications)
        .select()
        .eq('agreement_id', agreementId)
        .eq('pool_class', poolClass)
        .order('recouped_before_cents', { ascending: true }),
      'listMerchCollabRecoupmentApplications',
    );
  }

  async upsertMerchDesignerRoyaltyTier(
    row: Omit<MerchDesignerRoyaltyTierRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyTierRecord> {
    // One tier of record per sku — the upsert targets sku_id, so a
    // re-registered tier replaces the row atomically (the option-agreement
    // precedent).
    return this.oneStrict<MerchDesignerRoyaltyTierRecord>(
      this.client
        .from(TABLES.merchDesignerRoyaltyTiers)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'sku_id' })
        .select()
        .maybeSingle(),
      'upsertMerchDesignerRoyaltyTier',
    );
  }

  async getMerchDesignerRoyaltyTier(
    skuId: string,
  ): Promise<MerchDesignerRoyaltyTierRecord | undefined> {
    return this.one<MerchDesignerRoyaltyTierRecord>(
      this.client
        .from(TABLES.merchDesignerRoyaltyTiers)
        .select()
        .eq('sku_id', skuId)
        .maybeSingle(),
      'getMerchDesignerRoyaltyTier',
    );
  }

  async insertMerchDesignerRoyaltyBilling(
    row: Omit<MerchDesignerRoyaltyBillingRecord, 'id'>,
  ): Promise<MerchDesignerRoyaltyBillingRecord> {
    // UNIQUE on (source_event_id, sku_id) — a replayed fulfillment event is
    // the unique violation, never a double billing. The tier FK guards the
    // billing's precondition.
    return this.oneStrict<MerchDesignerRoyaltyBillingRecord>(
      this.client
        .from(TABLES.merchDesignerRoyaltyBillings)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchDesignerRoyaltyBilling',
    );
  }

  async insertMerchConsignmentSettlement(
    row: Omit<MerchConsignmentSettlementRecord, 'id'>,
  ): Promise<MerchConsignmentSettlementRecord> {
    // UNIQUE on event_id — a re-shipped report is the unique violation
    // (the replay surface).
    return this.oneStrict<MerchConsignmentSettlementRecord>(
      this.client
        .from(TABLES.merchConsignmentSettlements)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchConsignmentSettlement',
    );
  }

  async getMerchConsignmentSettlementByEventId(
    eventId: string,
  ): Promise<MerchConsignmentSettlementRecord | undefined> {
    return this.one<MerchConsignmentSettlementRecord>(
      this.client
        .from(TABLES.merchConsignmentSettlements)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getMerchConsignmentSettlementByEventId',
    );
  }

  // --- Merch returns reserve + fulfillment confirmation (PR 23, migration 0027) ---

  async upsertMerchReturnReservePolicy(
    row: Omit<MerchReturnReservePolicyRecord, 'id'>,
  ): Promise<MerchReturnReservePolicyRecord> {
    // One policy of record per sku — the upsert targets sku_id, so a
    // re-registered policy replaces the row atomically (the
    // option-agreement precedent).
    return this.oneStrict<MerchReturnReservePolicyRecord>(
      this.client
        .from(TABLES.merchReturnReservePolicies)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'sku_id' })
        .select()
        .maybeSingle(),
      'upsertMerchReturnReservePolicy',
    );
  }

  async getMerchReturnReservePolicy(
    skuId: string,
  ): Promise<MerchReturnReservePolicyRecord | undefined> {
    return this.one<MerchReturnReservePolicyRecord>(
      this.client
        .from(TABLES.merchReturnReservePolicies)
        .select()
        .eq('sku_id', skuId)
        .maybeSingle(),
      'getMerchReturnReservePolicy',
    );
  }

  async insertMerchReserveDrawdown(
    row: Omit<MerchReserveDrawdownRecord, 'id'>,
  ): Promise<MerchReserveDrawdownRecord> {
    // UNIQUE on (reserve_ledger_id, source_event_id) — a re-shipped
    // return/chargeback event is the unique violation, never a double
    // drawdown. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
    // insert-as-lock position arbiter.
    return this.oneStrict<MerchReserveDrawdownRecord>(
      this.client
        .from(TABLES.merchReserveDrawdowns)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchReserveDrawdown',
    );
  }

  async listMerchReserveDrawdowns(reserveLedgerId: string): Promise<MerchReserveDrawdownRecord[]> {
    return this.many<MerchReserveDrawdownRecord>(
      this.client
        .from(TABLES.merchReserveDrawdowns)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .order('drawn_before_cents', { ascending: true }),
      'listMerchReserveDrawdowns',
    );
  }

  async insertMerchFulfillmentTracking(
    row: Omit<MerchFulfillmentTrackingRecord, 'id'>,
  ): Promise<MerchFulfillmentTrackingRecord> {
    // UNIQUE on (fulfillment_event_id, tracking_number, tracking_state) — a
    // re-shipped tracking event is the unique violation, never a double
    // record.
    return this.oneStrict<MerchFulfillmentTrackingRecord>(
      this.client
        .from(TABLES.merchFulfillmentTrackings)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertMerchFulfillmentTracking',
    );
  }

  async listMerchFulfillmentTrackings(
    fulfillmentEventId: string,
  ): Promise<MerchFulfillmentTrackingRecord[]> {
    return this.many<MerchFulfillmentTrackingRecord>(
      this.client
        .from(TABLES.merchFulfillmentTrackings)
        .select()
        .eq('fulfillment_event_id', fulfillmentEventId)
        .order('created_at', { ascending: true }),
      'listMerchFulfillmentTrackings',
    );
  }

  async listMerchReturnsReserveCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'merch_returns_reserve')
        .eq('status', 'merch_returns_reserve')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listMerchReturnsReserveCredits',
    );
  }

  async settleMerchReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The status predicate in the UPDATE's WHERE is the CAS: PostgREST
    // matches the row only while it is still held, so the concurrent
    // release/drawdown loser gets zero rows back (maybeSingle → undefined).
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'merch_returns_reserve')
        .select()
        .maybeSingle(),
      'settleMerchReturnsReserve',
    );
  }

  // --- Foreign tax hold + book returns reserve ledger states (PR 27) ---

  async listForeignTaxHolds(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    // The frozen-leg work queue: a thawed leg leaves the listing (its
    // status returned to 'unclaimed_holding'). Newest first.
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'foreign_tax_hold')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listForeignTaxHolds',
    );
  }

  async thawForeignTaxHolds(taxHoldScope: string): Promise<number> {
    // The THAW CAS sweep — the VERIFIED withholding credit's ledger leg:
    // ONLY the scope's 'foreign_tax_hold' legs return to holding. A re-run
    // is an honest no-op (the already-thawed legs no longer match).
    const thawed = await this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'unclaimed_holding' })
        .eq('split_run_id', taxHoldScope)
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'foreign_tax_hold')
        .select(),
      'thawForeignTaxHolds',
    );
    return thawed.length;
  }

  async freezeForeignTaxHolds(taxHoldScope: string): Promise<number> {
    // The FREEZE CAS sweep — the foreign-tax-hold lane's ledger leg: ONLY
    // the scope's still-held legs enter the freeze. A re-applied hold is a
    // counted no-op (the already-frozen legs no longer match).
    const frozen = await this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'foreign_tax_hold' })
        .eq('split_run_id', taxHoldScope)
        .eq('kind', 'unclaimed_holding')
        .eq('status', 'unclaimed_holding')
        .select(),
      'freezeForeignTaxHolds',
    );
    return frozen.length;
  }

  async listBookReturnsReserveCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'book_returns_reserve')
        .eq('status', 'book_returns_reserve')
        .order('created_at', { ascending: false })
        .order('insertion_order', { ascending: false })
        .limit(limit),
      'listBookReturnsReserveCredits',
    );
  }

  async listBookReturnsReserveCreditsByIsbn(isbn: string): Promise<LedgerTransactionRecord[]> {
    // EVERY state of the ISBN's reserves, oldest first — the FIFO draw
    // ordering and the gate's window derivation (a settled reserve still
    // proves its period ran).
    return this.many<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .select()
        .eq('kind', 'book_returns_reserve')
        .eq('payee_id', bookReturnsReservePayeeId(isbn))
        .order('created_at', { ascending: true }),
      'listBookReturnsReserveCreditsByIsbn',
    );
  }

  async settleBookReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The status predicate in the UPDATE's WHERE is the CAS: PostgREST
    // matches the row only while it is still held, so the concurrent
    // release/drawdown loser gets zero rows back (maybeSingle → undefined).
    return this.one<LedgerTransactionRecord>(
      this.client
        .from(TABLES.ledgerTransactions)
        .update({ status: 'settled', settled_at: settledAt })
        .eq('id', id)
        .eq('status', 'book_returns_reserve')
        .select()
        .maybeSingle(),
      'settleBookReturnsReserve',
    );
  }

  // --- Foreign tax hold evidence + book returns reserve (PR 27, migration 0031) ---

  async upsertWithholdingTaxCreditVerification(
    row: Omit<WithholdingTaxCreditVerificationRecord, 'id'>,
  ): Promise<WithholdingTaxCreditVerificationRecord> {
    // The verification of record per (country_code, tax_year) — the upsert
    // targets that pair, so a replayed verification returns the original
    // row (idempotency) instead of a duplicate.
    return this.oneStrict<WithholdingTaxCreditVerificationRecord>(
      this.client
        .from(TABLES.withholdingTaxCreditVerifications)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'country_code,tax_year' })
        .select()
        .maybeSingle(),
      'upsertWithholdingTaxCreditVerification',
    );
  }

  async getWithholdingTaxCreditVerification(
    countryCode: string,
    taxYear: number,
  ): Promise<WithholdingTaxCreditVerificationRecord | undefined> {
    return this.one<WithholdingTaxCreditVerificationRecord>(
      this.client
        .from(TABLES.withholdingTaxCreditVerifications)
        .select()
        .eq('country_code', countryCode)
        .eq('tax_year', taxYear)
        .maybeSingle(),
      'getWithholdingTaxCreditVerification',
    );
  }

  async upsertIsbnRightsVerification(
    row: Omit<IsbnRightsVerificationRecord, 'id'>,
  ): Promise<IsbnRightsVerificationRecord> {
    // The rights verification of record per isbn — the upsert targets
    // isbn, so a re-verified title replaces the row atomically.
    return this.oneStrict<IsbnRightsVerificationRecord>(
      this.client
        .from(TABLES.isbnRightsVerifications)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'isbn' })
        .select()
        .maybeSingle(),
      'upsertIsbnRightsVerification',
    );
  }

  async getIsbnRightsVerification(
    isbn: string,
  ): Promise<IsbnRightsVerificationRecord | undefined> {
    return this.one<IsbnRightsVerificationRecord>(
      this.client
        .from(TABLES.isbnRightsVerifications)
        .select()
        .eq('isbn', isbn)
        .maybeSingle(),
      'getIsbnRightsVerification',
    );
  }

  async upsertBookReturnsReservePolicy(
    row: Omit<BookReturnsReservePolicyRecord, 'id'>,
  ): Promise<BookReturnsReservePolicyRecord> {
    // One policy of record per isbn — the upsert targets isbn, so a
    // re-registered policy replaces the row atomically (the merch
    // sku_id precedent).
    return this.oneStrict<BookReturnsReservePolicyRecord>(
      this.client
        .from(TABLES.bookReturnsReservePolicies)
        .upsert({ ...row, id: crypto.randomUUID() }, { onConflict: 'isbn' })
        .select()
        .maybeSingle(),
      'upsertBookReturnsReservePolicy',
    );
  }

  async getBookReturnsReservePolicy(
    isbn: string,
  ): Promise<BookReturnsReservePolicyRecord | undefined> {
    return this.one<BookReturnsReservePolicyRecord>(
      this.client
        .from(TABLES.bookReturnsReservePolicies)
        .select()
        .eq('isbn', isbn)
        .maybeSingle(),
      'getBookReturnsReservePolicy',
    );
  }

  async insertBookReserveDrawdown(
    row: Omit<BookReserveDrawdownRecord, 'id'>,
  ): Promise<BookReserveDrawdownRecord> {
    // UNIQUE on (reserve_ledger_id, source_event_id) — a re-shipped
    // return/chargeback event is the unique violation, never a double
    // drawdown. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
    // insert-as-lock position arbiter.
    return this.oneStrict<BookReserveDrawdownRecord>(
      this.client
        .from(TABLES.bookReserveDrawdowns)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBookReserveDrawdown',
    );
  }

  async listBookReserveDrawdowns(reserveLedgerId: string): Promise<BookReserveDrawdownRecord[]> {
    return this.many<BookReserveDrawdownRecord>(
      this.client
        .from(TABLES.bookReserveDrawdowns)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .order('drawn_before_cents', { ascending: true }),
      'listBookReserveDrawdowns',
    );
  }

  async insertBookReturnChargeback(
    row: Omit<BookReturnChargebackRecord, 'id'>,
  ): Promise<BookReturnChargebackRecord> {
    // UNIQUE on event_id — a re-delivered publisher return event is the
    // unique violation, never a duplicate chargeback of record.
    return this.oneStrict<BookReturnChargebackRecord>(
      this.client
        .from(TABLES.bookReturnChargebacks)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBookReturnChargeback',
    );
  }

  async getBookReturnChargeback(
    eventId: string,
  ): Promise<BookReturnChargebackRecord | undefined> {
    return this.one<BookReturnChargebackRecord>(
      this.client
        .from(TABLES.bookReturnChargebacks)
        .select()
        .eq('event_id', eventId)
        .maybeSingle(),
      'getBookReturnChargeback',
    );
  }

  async listBookReturnChargebacksByIsbn(isbn: string): Promise<BookReturnChargebackRecord[]> {
    // ONE ISBN's chargebacks, oldest first (created_at ASC): the FIFO
    // ordering the outstanding-offset recovery reads.
    return this.many<BookReturnChargebackRecord>(
      this.client
        .from(TABLES.bookReturnChargebacks)
        .select()
        .eq('isbn', isbn)
        .order('created_at', { ascending: true }),
      'listBookReturnChargebacksByIsbn',
    );
  }

  async insertBookChargebackOffsetApplication(
    row: Omit<BookChargebackOffsetApplicationRecord, 'id'>,
  ): Promise<BookChargebackOffsetApplicationRecord> {
    // UNIQUE on (chargeback_id, holding_ledger_id) — a replayed release is
    // the unique violation, never a double recovery. UNIQUE on
    // (chargeback_id, offset_before_cents) — the insert-as-lock position
    // arbiter.
    return this.oneStrict<BookChargebackOffsetApplicationRecord>(
      this.client
        .from(TABLES.bookChargebackOffsetApplications)
        .insert({ ...row, id: crypto.randomUUID() })
        .select()
        .maybeSingle(),
      'insertBookChargebackOffsetApplication',
    );
  }

  async listBookChargebackOffsetApplications(
    chargebackId: string,
  ): Promise<BookChargebackOffsetApplicationRecord[]> {
    return this.many<BookChargebackOffsetApplicationRecord>(
      this.client
        .from(TABLES.bookChargebackOffsetApplications)
        .select()
        .eq('chargeback_id', chargebackId)
        .order('offset_before_cents', { ascending: true }),
      'listBookChargebackOffsetApplications',
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

  /**
   * Atomic accumulate (migration 0057): the deltas move inside the
   * increment_creator_ytd SQL function — INSERT ... ON CONFLICT DO UPDATE
   * with column arithmetic — so two concurrent settlements of one creator
   * both land instead of last-write-wins over each other. PostgREST cannot
   * express `col = col + $delta`, which is why the RPC exists.
   */
  async incrementCreatorYtd(input: CreatorYtdIncrement): Promise<CreatorYtdEarnings> {
    return this.oneStrict<CreatorYtdEarnings>(
      this.client.rpc('increment_creator_ytd', {
        p_creator_id: input.creator_id,
        p_tax_year: input.tax_year,
        p_gross_delta: input.gross_delta_cents,
        p_withheld_delta: input.withheld_delta_cents,
        p_updated_at: input.updated_at,
      }),
      'incrementCreatorYtd',
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

  // --- The culinary audit escrow + gate states + pop-up decommissioning
  // (PR 41, migration 0045) — the 0043 fitness twins' PostgREST shape. ---

  async upsertCulinaryAuditEscrowPolicy(
    row: Omit<CulinaryAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing). HARDENED UPSERT: no id in
    // the payload (the id rotates on conflict).
    return this.oneStrict<CulinaryAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.culinaryAuditEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertCulinaryAuditEscrowPolicy',
    );
  }

  async getCulinaryAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<CulinaryAuditEscrowPolicyRecord | undefined> {
    return this.one<CulinaryAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.culinaryAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getCulinaryAuditEscrowPolicy',
    );
  }

  async insertCulinaryAuditEscrowDrawdown(
    row: Omit<CulinaryAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<CulinaryAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.culinaryAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertCulinaryAuditEscrowDrawdown',
    );
  }

  async listCulinaryAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<CulinaryAuditEscrowDrawdownRecord[]> {
    // Chronological spend order — the same ordering discipline the
    // fitness and spatial drawdown lists run.
    const { data, error } = await this.client
      .from(TABLES.culinaryAuditEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listCulinaryAuditEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as CulinaryAuditEscrowDrawdownRecord[];
  }

  async insertCulinaryAuditEscrowReconciliation(
    row: Omit<CulinaryAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<CulinaryAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.culinaryAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertCulinaryAuditEscrowReconciliation',
    );
  }

  async getCulinaryAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<CulinaryAuditEscrowReconciliationRecord | undefined> {
    return this.one<CulinaryAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.culinaryAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getCulinaryAuditEscrowReconciliation',
    );
  }

  async settleCulinaryAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'culinary_audit_escrow')
      .select();
    if (error) {
      throw new Error(`settleCulinaryAuditEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertCulinaryPayoutGateState(
    row: Omit<CulinaryPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryPayoutGateStateRecord> {
    // UNIQUE per (payee_id, ghost_kitchen_location_code) — an upsert
    // converges (a verification heals 'unknown'; states never regress
    // through this table). HARDENED UPSERT: no id in the payload (the
    // id rotates on conflict).
    return this.oneStrict<CulinaryPayoutGateStateRecord>(
      this.client
        .from(TABLES.culinaryPayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,ghost_kitchen_location_code' })
        .select()
        .maybeSingle(),
      'upsertCulinaryPayoutGateState',
    );
  }

  async getCulinaryPayoutGateState(
    payeeId: string,
    ghostKitchenLocationCode: string,
  ): Promise<CulinaryPayoutGateStateRecord | undefined> {
    return this.one<CulinaryPayoutGateStateRecord>(
      this.client
        .from(TABLES.culinaryPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('ghost_kitchen_location_code', ghostKitchenLocationCode)
        .maybeSingle(),
      'getCulinaryPayoutGateState',
    );
  }

  async insertCulinaryPopupExperience(
    row: Omit<CulinaryPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryPopupExperienceRecord> {
    // Insert-as-lock — UNIQUE per popup_ref: the FIRST registration
    // wins; a re-shipped sheet or a lost race throws here (the caller
    // reads the winner through the getter).
    return this.oneStrict<CulinaryPopupExperienceRecord>(
      this.client
        .from(TABLES.culinaryPopupExperiences)
        .insert({
          ...row,
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .maybeSingle(),
      'insertCulinaryPopupExperience',
    );
  }

  async getCulinaryPopupExperience(
    popupRef: string,
  ): Promise<CulinaryPopupExperienceRecord | undefined> {
    return this.one<CulinaryPopupExperienceRecord>(
      this.client
        .from(TABLES.culinaryPopupExperiences)
        .select()
        .eq('popup_ref', popupRef)
        .maybeSingle(),
      'getCulinaryPopupExperience',
    );
  }

  async insertCulinaryPopupWriteoff(
    row: Omit<CulinaryPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryPopupWriteoffRecord> {
    // UNIQUE per (popup_experience_id, source_event_id) — a replayed
    // calculation throws, never a double-priced write-off.
    return this.oneStrict<CulinaryPopupWriteoffRecord>(
      this.client
        .from(TABLES.culinaryPopupWriteoffs)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertCulinaryPopupWriteoff',
    );
  }

  async listCulinaryPopupWriteoffs(
    popupExperienceId: string,
  ): Promise<CulinaryPopupWriteoffRecord[]> {
    const { data, error } = await this.client
      .from(TABLES.culinaryPopupWriteoffs)
      .select()
      .eq('popup_experience_id', popupExperienceId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`listCulinaryPopupWriteoffs failed: ${error.message}`);
    }
    return (data ?? []) as CulinaryPopupWriteoffRecord[];
  }

  // ------------------------------------------------------------------
  // The service audit escrow + services payout gate states (PR 43) —
  // the founder-banded escrow rate of record, the position-locked
  // drawdowns, the verified reconciliation of record, and the two
  // durable gate states the services payout gate reads fail-closed.
  // ------------------------------------------------------------------

  async upsertServiceAuditEscrowPolicy(
    row: Omit<ServiceAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing). HARDENED UPSERT: no id in
    // the payload (the id rotates on conflict).
    return this.oneStrict<ServiceAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.serviceAuditEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertServiceAuditEscrowPolicy',
    );
  }

  async getServiceAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<ServiceAuditEscrowPolicyRecord | undefined> {
    return this.one<ServiceAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.serviceAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getServiceAuditEscrowPolicy',
    );
  }

  async insertServiceAuditEscrowDrawdown(
    row: Omit<ServiceAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<ServiceAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<ServiceAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.serviceAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceAuditEscrowDrawdown',
    );
  }

  async listServiceAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<ServiceAuditEscrowDrawdownRecord[]> {
    // Chronological spend order — the same ordering discipline the
    // fitness, spatial, and culinary drawdown lists run.
    const { data, error } = await this.client
      .from(TABLES.serviceAuditEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listServiceAuditEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as ServiceAuditEscrowDrawdownRecord[];
  }

  async insertServiceAuditEscrowReconciliation(
    row: Omit<ServiceAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<ServiceAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.serviceAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceAuditEscrowReconciliation',
    );
  }

  async getServiceAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<ServiceAuditEscrowReconciliationRecord | undefined> {
    return this.one<ServiceAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.serviceAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getServiceAuditEscrowReconciliation',
    );
  }

  async settleServiceAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'service_audit_escrow')
      .select();
    if (error) {
      throw new Error(`settleServiceAuditEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertServicesPayoutGateState(
    row: Omit<ServicesPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServicesPayoutGateStateRecord> {
    // UNIQUE per (payee_id, salon_location_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<ServicesPayoutGateStateRecord>(
      this.client
        .from(TABLES.servicesPayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,salon_location_id' })
        .select()
        .maybeSingle(),
      'upsertServicesPayoutGateState',
    );
  }

  async getServicesPayoutGateState(
    payeeId: string,
    salonLocationId: string,
  ): Promise<ServicesPayoutGateStateRecord | undefined> {
    return this.one<ServicesPayoutGateStateRecord>(
      this.client
        .from(TABLES.servicesPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('salon_location_id', salonLocationId)
        .maybeSingle(),
      'getServicesPayoutGateState',
    );
  }

  async upsertSoftwareAuditEscrowPolicy(
    row: Omit<SoftwareAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SoftwareAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing). HARDENED UPSERT: no id in
    // the payload (the id rotates on conflict).
    return this.oneStrict<SoftwareAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.softwareAuditEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertSoftwareAuditEscrowPolicy',
    );
  }

  async getSoftwareAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<SoftwareAuditEscrowPolicyRecord | undefined> {
    return this.one<SoftwareAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.softwareAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getSoftwareAuditEscrowPolicy',
    );
  }

  async insertSoftwareAuditEscrowDrawdown(
    row: Omit<SoftwareAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SoftwareAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<SoftwareAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.softwareAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSoftwareAuditEscrowDrawdown',
    );
  }

  async listSoftwareAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<SoftwareAuditEscrowDrawdownRecord[]> {
    // Chronological spend order — the same ordering discipline the
    // fitness, spatial, culinary, and service drawdown lists run.
    const { data, error } = await this.client
      .from(TABLES.softwareAuditEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listSoftwareAuditEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as SoftwareAuditEscrowDrawdownRecord[];
  }

  async insertSoftwareAuditEscrowReconciliation(
    row: Omit<SoftwareAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SoftwareAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<SoftwareAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.softwareAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSoftwareAuditEscrowReconciliation',
    );
  }

  async getSoftwareAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SoftwareAuditEscrowReconciliationRecord | undefined> {
    return this.one<SoftwareAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.softwareAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getSoftwareAuditEscrowReconciliation',
    );
  }

  async settleSoftwareAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'software_audit_escrow')
      .select();
    if (error) {
      throw new Error(`settleSoftwareAuditEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertSoftwarePayoutGateState(
    row: Omit<SoftwarePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SoftwarePayoutGateStateRecord> {
    // UNIQUE per (payee_id, api_endpoint_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<SoftwarePayoutGateStateRecord>(
      this.client
        .from(TABLES.softwarePayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,api_endpoint_id' })
        .select()
        .maybeSingle(),
      'upsertSoftwarePayoutGateState',
    );
  }

  async getSoftwarePayoutGateState(
    payeeId: string,
    apiEndpointId: string,
  ): Promise<SoftwarePayoutGateStateRecord | undefined> {
    return this.one<SoftwarePayoutGateStateRecord>(
      this.client
        .from(TABLES.softwarePayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('api_endpoint_id', apiEndpointId)
        .maybeSingle(),
      'getSoftwarePayoutGateState',
    );
  }

  async upsertPatentLitigationEscrowPolicy(
    row: Omit<PatentLitigationEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PatentLitigationEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing). HARDENED UPSERT: no id in
    // the payload (the id rotates on conflict).
    return this.oneStrict<PatentLitigationEscrowPolicyRecord>(
      this.client
        .from(TABLES.patentLitigationEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertPatentLitigationEscrowPolicy',
    );
  }

  async getPatentLitigationEscrowPolicy(
    scopeKey: string,
  ): Promise<PatentLitigationEscrowPolicyRecord | undefined> {
    return this.one<PatentLitigationEscrowPolicyRecord>(
      this.client
        .from(TABLES.patentLitigationEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getPatentLitigationEscrowPolicy',
    );
  }

  async insertPatentLitigationEscrowDrawdown(
    row: Omit<PatentLitigationEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<PatentLitigationEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<PatentLitigationEscrowDrawdownRecord>(
      this.client
        .from(TABLES.patentLitigationEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertPatentLitigationEscrowDrawdown',
    );
  }

  async listPatentLitigationEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<PatentLitigationEscrowDrawdownRecord[]> {
    // Chronological spend order — the same ordering discipline the
    // fitness, spatial, culinary, service, and software drawdown lists run.
    const { data, error } = await this.client
      .from(TABLES.patentLitigationEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listPatentLitigationEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as PatentLitigationEscrowDrawdownRecord[];
  }

  async insertPatentLitigationEscrowReconciliation(
    row: Omit<PatentLitigationEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<PatentLitigationEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<PatentLitigationEscrowReconciliationRecord>(
      this.client
        .from(TABLES.patentLitigationEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertPatentLitigationEscrowReconciliation',
    );
  }

  async getPatentLitigationEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<PatentLitigationEscrowReconciliationRecord | undefined> {
    return this.one<PatentLitigationEscrowReconciliationRecord>(
      this.client
        .from(TABLES.patentLitigationEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getPatentLitigationEscrowReconciliation',
    );
  }

  async settlePatentLitigationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'patent_litigation_escrow')
      .select();
    if (error) {
      throw new Error(`settlePatentLitigationEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertHardwarePayoutGateState(
    row: Omit<HardwarePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePayoutGateStateRecord> {
    // UNIQUE per (payee_id, sep_pool_code) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<HardwarePayoutGateStateRecord>(
      this.client
        .from(TABLES.hardwarePayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,sep_pool_code' })
        .select()
        .maybeSingle(),
      'upsertHardwarePayoutGateState',
    );
  }

  async getHardwarePayoutGateState(
    payeeId: string,
    sepPoolCode: string,
  ): Promise<HardwarePayoutGateStateRecord | undefined> {
    return this.one<HardwarePayoutGateStateRecord>(
      this.client
        .from(TABLES.hardwarePayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('sep_pool_code', sepPoolCode)
        .maybeSingle(),
      'getHardwarePayoutGateState',
    );
  }

  async insertHardwareCrossLicenseNetDispatch(
    row: Omit<HardwareCrossLicenseNetDispatchRecord, 'id' | 'created_at'>,
  ): Promise<HardwareCrossLicenseNetDispatchRecord> {
    // UNIQUE per (agreement_ref, period, net_before_cents,
    // net_after_cents) — the replay guard AND the concurrency arbiter
    // (insert-as-lock): a replayed trigger at the same settlement state
    // or a lost race throws at the migration's constraint, never a
    // double dispatch. net_before is in the tuple so a re-net that
    // revisits an earlier net cannot collide with the row that first
    // reached it.
    return this.oneStrict<HardwareCrossLicenseNetDispatchRecord>(
      this.client
        .from(TABLES.hardwareCrossLicenseNetDispatches)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwareCrossLicenseNetDispatch',
    );
  }

  async listHardwareCrossLicenseNetDispatches(
    agreementRef: string,
    period: string,
  ): Promise<HardwareCrossLicenseNetDispatchRecord[]> {
    // Chronological execution order — the cumulative dispatched position
    // strictly advances as dispatches land.
    const { data, error } = await this.client
      .from(TABLES.hardwareCrossLicenseNetDispatches)
      .select()
      .eq('agreement_ref', agreementRef)
      .eq('period', period)
      .order('created_at', { ascending: true })
      .order('net_before_cents', { ascending: true });
    if (error) {
      throw new Error(`listHardwareCrossLicenseNetDispatches failed: ${error.message}`);
    }
    return (data ?? []) as HardwareCrossLicenseNetDispatchRecord[];
  }

  // ------------------------------------------------------------------
  // The service lane (PR 42) — the policies of record, the waterfalls,
  // and the seven application ledgers.
  // ------------------------------------------------------------------

  async upsertServiceFranchiseSchedule(
    row: Omit<ServiceFranchiseScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceFranchiseScheduleRecord> {
    // UNIQUE per salon_location_id — a re-registered schedule replaces
    // the row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<ServiceFranchiseScheduleRecord>(
      this.client
        .from(TABLES.serviceFranchiseSchedules)
        .upsert(row, { onConflict: 'salon_location_id' })
        .select()
        .maybeSingle(),
      'upsertServiceFranchiseSchedule',
    );
  }

  async getServiceFranchiseSchedule(
    salonLocationId: string,
  ): Promise<ServiceFranchiseScheduleRecord | undefined> {
    return this.one<ServiceFranchiseScheduleRecord>(
      this.client
        .from(TABLES.serviceFranchiseSchedules)
        .select()
        .eq('salon_location_id', salonLocationId)
        .maybeSingle(),
      'getServiceFranchiseSchedule',
    );
  }

  async upsertServiceProtocolPolicy(
    row: Omit<ServiceProtocolPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceProtocolPolicyRecord> {
    // UNIQUE per protocol_id — a re-registered policy replaces the row
    // atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<ServiceProtocolPolicyRecord>(
      this.client
        .from(TABLES.serviceProtocolPolicies)
        .upsert(row, { onConflict: 'protocol_id' })
        .select()
        .maybeSingle(),
      'upsertServiceProtocolPolicy',
    );
  }

  async getServiceProtocolPolicy(
    protocolId: string,
  ): Promise<ServiceProtocolPolicyRecord | undefined> {
    return this.one<ServiceProtocolPolicyRecord>(
      this.client
        .from(TABLES.serviceProtocolPolicies)
        .select()
        .eq('protocol_id', protocolId)
        .maybeSingle(),
      'getServiceProtocolPolicy',
    );
  }

  async upsertServiceRedemptionPolicy(
    row: Omit<ServiceRedemptionPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceRedemptionPolicyRecord> {
    // UNIQUE per home_location_id — a re-registered policy replaces the
    // row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<ServiceRedemptionPolicyRecord>(
      this.client
        .from(TABLES.serviceRedemptionPolicies)
        .upsert(row, { onConflict: 'home_location_id' })
        .select()
        .maybeSingle(),
      'upsertServiceRedemptionPolicy',
    );
  }

  async getServiceRedemptionPolicy(
    homeLocationId: string,
  ): Promise<ServiceRedemptionPolicyRecord | undefined> {
    return this.one<ServiceRedemptionPolicyRecord>(
      this.client
        .from(TABLES.serviceRedemptionPolicies)
        .select()
        .eq('home_location_id', homeLocationId)
        .maybeSingle(),
      'getServiceRedemptionPolicy',
    );
  }

  async upsertServiceBreakagePolicy(
    row: Omit<ServiceBreakagePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceBreakagePolicyRecord> {
    // UNIQUE per home_location_id — a re-registered policy replaces the
    // row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<ServiceBreakagePolicyRecord>(
      this.client
        .from(TABLES.serviceBreakagePolicies)
        .upsert(row, { onConflict: 'home_location_id' })
        .select()
        .maybeSingle(),
      'upsertServiceBreakagePolicy',
    );
  }

  async getServiceBreakagePolicy(
    homeLocationId: string,
  ): Promise<ServiceBreakagePolicyRecord | undefined> {
    return this.one<ServiceBreakagePolicyRecord>(
      this.client
        .from(TABLES.serviceBreakagePolicies)
        .select()
        .eq('home_location_id', homeLocationId)
        .maybeSingle(),
      'getServiceBreakagePolicy',
    );
  }

  async upsertServiceRebateWaterfallLeg(
    row: Omit<ServiceRebateWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceRebateWaterfallRecord> {
    // UNIQUE per (salon_location_id, ledger_id) — a re-registered leg
    // converges. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<ServiceRebateWaterfallRecord>(
      this.client
        .from(TABLES.serviceRebateWaterfalls)
        .upsert(row, { onConflict: 'salon_location_id,ledger_id' })
        .select()
        .maybeSingle(),
      'upsertServiceRebateWaterfallLeg',
    );
  }

  async listServiceRebateWaterfallLegs(
    salonLocationId: string,
  ): Promise<ServiceRebateWaterfallRecord[]> {
    // Registration order (the insertion order the rebate walk reads).
    const { data, error } = await this.client
      .from(TABLES.serviceRebateWaterfalls)
      .select()
      .eq('salon_location_id', salonLocationId)
      .order('created_at');
    if (error) {
      throw new Error(`listServiceRebateWaterfallLegs failed: ${error.message}`);
    }
    return (data ?? []) as ServiceRebateWaterfallRecord[];
  }

  async upsertServiceBoothLeasePolicy(
    row: Omit<ServiceBoothLeasePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceBoothLeasePolicyRecord> {
    // UNIQUE per salon_location_id — a re-registered policy replaces the
    // row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<ServiceBoothLeasePolicyRecord>(
      this.client
        .from(TABLES.serviceBoothLeasePolicies)
        .upsert(row, { onConflict: 'salon_location_id' })
        .select()
        .maybeSingle(),
      'upsertServiceBoothLeasePolicy',
    );
  }

  async getServiceBoothLeasePolicy(
    salonLocationId: string,
  ): Promise<ServiceBoothLeasePolicyRecord | undefined> {
    return this.one<ServiceBoothLeasePolicyRecord>(
      this.client
        .from(TABLES.serviceBoothLeasePolicies)
        .select()
        .eq('salon_location_id', salonLocationId)
        .maybeSingle(),
      'getServiceBoothLeasePolicy',
    );
  }

  async insertServiceRealizationApplication(
    row: Omit<ServiceRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-shipped sheet
    // throws here, never a double application; the caller re-derives
    // from the application of record.
    return this.oneStrict<ServiceRealizationApplicationRecord>(
      this.client
        .from(TABLES.serviceRealizationApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceRealizationApplication',
    );
  }

  async getServiceRealizationApplication(
    sourceEventId: string,
  ): Promise<ServiceRealizationApplicationRecord | undefined> {
    return this.one<ServiceRealizationApplicationRecord>(
      this.client
        .from(TABLES.serviceRealizationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceRealizationApplication',
    );
  }

  async insertServiceFranchiseSplitApplication(
    row: Omit<ServiceFranchiseSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceFranchiseSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<ServiceFranchiseSplitApplicationRecord>(
      this.client
        .from(TABLES.serviceFranchiseSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceFranchiseSplitApplication',
    );
  }

  async getServiceFranchiseSplitApplication(
    sourceEventId: string,
  ): Promise<ServiceFranchiseSplitApplicationRecord | undefined> {
    return this.one<ServiceFranchiseSplitApplicationRecord>(
      this.client
        .from(TABLES.serviceFranchiseSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceFranchiseSplitApplication',
    );
  }

  async insertServiceProtocolMicroRoyalty(
    row: Omit<ServiceProtocolMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<ServiceProtocolMicroRoyaltyRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<ServiceProtocolMicroRoyaltyRecord>(
      this.client
        .from(TABLES.serviceProtocolMicroRoyalties)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceProtocolMicroRoyalty',
    );
  }

  async getServiceProtocolMicroRoyalty(
    sourceEventId: string,
  ): Promise<ServiceProtocolMicroRoyaltyRecord | undefined> {
    return this.one<ServiceProtocolMicroRoyaltyRecord>(
      this.client
        .from(TABLES.serviceProtocolMicroRoyalties)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceProtocolMicroRoyalty',
    );
  }

  async insertServiceRedemptionSplitApplication(
    row: Omit<ServiceRedemptionSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRedemptionSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<ServiceRedemptionSplitApplicationRecord>(
      this.client
        .from(TABLES.serviceRedemptionSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceRedemptionSplitApplication',
    );
  }

  async getServiceRedemptionSplitApplication(
    sourceEventId: string,
  ): Promise<ServiceRedemptionSplitApplicationRecord | undefined> {
    return this.one<ServiceRedemptionSplitApplicationRecord>(
      this.client
        .from(TABLES.serviceRedemptionSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceRedemptionSplitApplication',
    );
  }

  async insertServiceBreakageAllocation(
    row: Omit<ServiceBreakageAllocationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceBreakageAllocationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<ServiceBreakageAllocationRecord>(
      this.client
        .from(TABLES.serviceBreakageAllocations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceBreakageAllocation',
    );
  }

  async getServiceBreakageAllocation(
    sourceEventId: string,
  ): Promise<ServiceBreakageAllocationRecord | undefined> {
    return this.one<ServiceBreakageAllocationRecord>(
      this.client
        .from(TABLES.serviceBreakageAllocations)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceBreakageAllocation',
    );
  }

  async insertServiceRebateApplication(
    row: Omit<ServiceRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRebateApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<ServiceRebateApplicationRecord>(
      this.client
        .from(TABLES.serviceRebateApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceRebateApplication',
    );
  }

  async getServiceRebateApplication(
    sourceEventId: string,
  ): Promise<ServiceRebateApplicationRecord | undefined> {
    return this.one<ServiceRebateApplicationRecord>(
      this.client
        .from(TABLES.serviceRebateApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceRebateApplication',
    );
  }

  async insertServiceBoothLeaseApplication(
    row: Omit<ServiceBoothLeaseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceBoothLeaseApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<ServiceBoothLeaseApplicationRecord>(
      this.client
        .from(TABLES.serviceBoothLeaseApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertServiceBoothLeaseApplication',
    );
  }

  async getServiceBoothLeaseApplication(
    sourceEventId: string,
  ): Promise<ServiceBoothLeaseApplicationRecord | undefined> {
    return this.one<ServiceBoothLeaseApplicationRecord>(
      this.client
        .from(TABLES.serviceBoothLeaseApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getServiceBoothLeaseApplication',
    );
  }

  // ------------------------------------------------------------------
  // The developer lane (PR 44) — the founder developer directive's
  // registries of record, the two cumulative monthly trackers, and the
  // seven application ledgers. Same discipline as the service lane:
  // every application is UNIQUE per source_event_id (the replay guard);
  // every registry upsert converges per its natural key and NEVER puts
  // the id column in the conflict payload (the parity lesson from PR
  // 33).
  // ------------------------------------------------------------------

  async upsertDeveloperApiRoyaltyPolicy(
    row: Omit<DeveloperApiRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperApiRoyaltyPolicyRecord> {
    // UNIQUE per developer_id — a re-registered policy replaces the row
    // atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<DeveloperApiRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.developerApiRoyaltyPolicies)
        .upsert(row, { onConflict: 'developer_id' })
        .select()
        .maybeSingle(),
      'upsertDeveloperApiRoyaltyPolicy',
    );
  }

  async getDeveloperApiRoyaltyPolicy(
    developerId: string,
  ): Promise<DeveloperApiRoyaltyPolicyRecord | undefined> {
    return this.one<DeveloperApiRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.developerApiRoyaltyPolicies)
        .select()
        .eq('developer_id', developerId)
        .maybeSingle(),
      'getDeveloperApiRoyaltyPolicy',
    );
  }

  async upsertDeveloperMarketplacePolicy(
    row: Omit<DeveloperMarketplaceSplitPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperMarketplaceSplitPolicyRecord> {
    // UNIQUE per marketplace — a re-registered policy replaces the row
    // atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<DeveloperMarketplaceSplitPolicyRecord>(
      this.client
        .from(TABLES.developerMarketplaceSplitPolicies)
        .upsert(row, { onConflict: 'marketplace' })
        .select()
        .maybeSingle(),
      'upsertDeveloperMarketplacePolicy',
    );
  }

  async getDeveloperMarketplacePolicy(
    marketplace: string,
  ): Promise<DeveloperMarketplaceSplitPolicyRecord | undefined> {
    return this.one<DeveloperMarketplaceSplitPolicyRecord>(
      this.client
        .from(TABLES.developerMarketplaceSplitPolicies)
        .select()
        .eq('marketplace', marketplace)
        .maybeSingle(),
      'getDeveloperMarketplacePolicy',
    );
  }

  async upsertDeveloperCopackageLeg(
    row: Omit<DeveloperCopackageContributionLegRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperCopackageContributionLegRecord> {
    // UNIQUE per (package_id, maintainer_id) — a re-registered leg
    // converges. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<DeveloperCopackageContributionLegRecord>(
      this.client
        .from(TABLES.developerCopackageContributionLegs)
        .upsert(row, { onConflict: 'package_id,maintainer_id' })
        .select()
        .maybeSingle(),
      'upsertDeveloperCopackageLeg',
    );
  }

  async listDeveloperCopackageLegs(
    packageId: string,
  ): Promise<DeveloperCopackageContributionLegRecord[]> {
    // Registration order (the insertion order the split walk reads).
    const { data, error } = await this.client
      .from(TABLES.developerCopackageContributionLegs)
      .select()
      .eq('package_id', packageId)
      .order('created_at');
    if (error) {
      throw new Error(`listDeveloperCopackageLegs failed: ${error.message}`);
    }
    return (data ?? []) as DeveloperCopackageContributionLegRecord[];
  }

  async upsertDeveloperDependencyLedger(
    row: Omit<DeveloperDependencyMaintainerLedgerRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperDependencyMaintainerLedgerRecord> {
    // UNIQUE per component_id — a re-registered ledger replaces the row
    // atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<DeveloperDependencyMaintainerLedgerRecord>(
      this.client
        .from(TABLES.developerDependencyMaintainerLedgers)
        .upsert(row, { onConflict: 'component_id' })
        .select()
        .maybeSingle(),
      'upsertDeveloperDependencyLedger',
    );
  }

  async getDeveloperDependencyLedger(
    componentId: string,
  ): Promise<DeveloperDependencyMaintainerLedgerRecord | undefined> {
    return this.one<DeveloperDependencyMaintainerLedgerRecord>(
      this.client
        .from(TABLES.developerDependencyMaintainerLedgers)
        .select()
        .eq('component_id', componentId)
        .maybeSingle(),
      'getDeveloperDependencyLedger',
    );
  }

  async upsertDeveloperWhitelabelDeal(
    row: Omit<DeveloperWhitelabelLicenseDealRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperWhitelabelLicenseDealRecord> {
    // UNIQUE per sdk_package_hash — a re-registered deal replaces the
    // row atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<DeveloperWhitelabelLicenseDealRecord>(
      this.client
        .from(TABLES.developerWhitelabelLicenseDeals)
        .upsert(row, { onConflict: 'sdk_package_hash' })
        .select()
        .maybeSingle(),
      'upsertDeveloperWhitelabelDeal',
    );
  }

  async getDeveloperWhitelabelDeal(
    sdkPackageHash: string,
  ): Promise<DeveloperWhitelabelLicenseDealRecord | undefined> {
    return this.one<DeveloperWhitelabelLicenseDealRecord>(
      this.client
        .from(TABLES.developerWhitelabelLicenseDeals)
        .select()
        .eq('sdk_package_hash', sdkPackageHash)
        .maybeSingle(),
      'getDeveloperWhitelabelDeal',
    );
  }

  async upsertDeveloperToolPolicy(
    row: Omit<DeveloperToolRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperToolRoyaltyPolicyRecord> {
    // UNIQUE per tool_id — a re-registered policy replaces the row
    // atomically. HARDENED UPSERT: no id in the payload.
    return this.oneStrict<DeveloperToolRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.developerToolRoyaltyPolicies)
        .upsert(row, { onConflict: 'tool_id' })
        .select()
        .maybeSingle(),
      'upsertDeveloperToolPolicy',
    );
  }

  async getDeveloperToolPolicy(
    toolId: string,
  ): Promise<DeveloperToolRoyaltyPolicyRecord | undefined> {
    return this.one<DeveloperToolRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.developerToolRoyaltyPolicies)
        .select()
        .eq('tool_id', toolId)
        .maybeSingle(),
      'getDeveloperToolPolicy',
    );
  }

  async advanceDeveloperApiCallMonth(
    developerId: string,
    month: string,
    callsAdded: number,
  ): Promise<DeveloperApiCallMonthRecord> {
    // UNIQUE per (developer_id, month) — the tracker converges. The
    // cumulative walk is serialized per developer-month by the recon
    // lane (one event at a time), so a read-modify-upsert carries the
    // same position arithmetic the SQLite backend expresses additively
    // in its ON CONFLICT arm. No id in the payload.
    const existing = await this.getDeveloperApiCallMonth(developerId, month);
    return this.oneStrict<DeveloperApiCallMonthRecord>(
      this.client
        .from(TABLES.developerApiCallMonths)
        .upsert(
          {
            developer_id: developerId,
            month,
            cumulative_calls: (existing?.cumulative_calls ?? 0) + callsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'developer_id,month' },
        )
        .select()
        .maybeSingle(),
      'advanceDeveloperApiCallMonth',
    );
  }

  async getDeveloperApiCallMonth(
    developerId: string,
    month: string,
  ): Promise<DeveloperApiCallMonthRecord | undefined> {
    return this.one<DeveloperApiCallMonthRecord>(
      this.client
        .from(TABLES.developerApiCallMonths)
        .select()
        .eq('developer_id', developerId)
        .eq('month', month)
        .maybeSingle(),
      'getDeveloperApiCallMonth',
    );
  }

  async advanceDeveloperWhitelabelUsageMonth(
    sdkPackageHash: string,
    licensorId: string,
    month: string,
    usageCentsAdded: number,
  ): Promise<DeveloperWhitelabelUsageMonthRecord> {
    // UNIQUE per (sdk_package_hash, licensor_id, month) — the tracker
    // converges; same read-modify-upsert as the call tracker. No id in
    // the payload.
    const existing = await this.getDeveloperWhitelabelUsageMonth(
      sdkPackageHash,
      licensorId,
      month,
    );
    return this.oneStrict<DeveloperWhitelabelUsageMonthRecord>(
      this.client
        .from(TABLES.developerWhitelabelUsageMonths)
        .upsert(
          {
            sdk_package_hash: sdkPackageHash,
            licensor_id: licensorId,
            month,
            cumulative_usage_cents:
              (existing?.cumulative_usage_cents ?? 0) + usageCentsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'sdk_package_hash,licensor_id,month' },
        )
        .select()
        .maybeSingle(),
      'advanceDeveloperWhitelabelUsageMonth',
    );
  }

  async getDeveloperWhitelabelUsageMonth(
    sdkPackageHash: string,
    licensorId: string,
    month: string,
  ): Promise<DeveloperWhitelabelUsageMonthRecord | undefined> {
    return this.one<DeveloperWhitelabelUsageMonthRecord>(
      this.client
        .from(TABLES.developerWhitelabelUsageMonths)
        .select()
        .eq('sdk_package_hash', sdkPackageHash)
        .eq('licensor_id', licensorId)
        .eq('month', month)
        .maybeSingle(),
      'getDeveloperWhitelabelUsageMonth',
    );
  }

  async insertDeveloperRealizationApplication(
    row: Omit<DeveloperApiRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperApiRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-shipped event
    // throws here, never a double application.
    return this.oneStrict<DeveloperApiRealizationApplicationRecord>(
      this.client
        .from(TABLES.developerApiRealizationApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperRealizationApplication',
    );
  }

  async getDeveloperRealizationApplication(
    sourceEventId: string,
  ): Promise<DeveloperApiRealizationApplicationRecord | undefined> {
    return this.one<DeveloperApiRealizationApplicationRecord>(
      this.client
        .from(TABLES.developerApiRealizationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperRealizationApplication',
    );
  }

  async insertDeveloperApiMicroRoyalty(
    row: Omit<DeveloperApiMicroRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperApiMicroRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<DeveloperApiMicroRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.developerApiMicroRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperApiMicroRoyalty',
    );
  }

  async getDeveloperApiMicroRoyalty(
    sourceEventId: string,
  ): Promise<DeveloperApiMicroRoyaltyApplicationRecord | undefined> {
    return this.one<DeveloperApiMicroRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.developerApiMicroRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperApiMicroRoyalty',
    );
  }

  async insertDeveloperMarketplaceSplit(
    row: Omit<DeveloperMarketplaceSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperMarketplaceSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<DeveloperMarketplaceSplitApplicationRecord>(
      this.client
        .from(TABLES.developerMarketplaceSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperMarketplaceSplit',
    );
  }

  async getDeveloperMarketplaceSplit(
    sourceEventId: string,
  ): Promise<DeveloperMarketplaceSplitApplicationRecord | undefined> {
    return this.one<DeveloperMarketplaceSplitApplicationRecord>(
      this.client
        .from(TABLES.developerMarketplaceSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperMarketplaceSplit',
    );
  }

  async insertDeveloperCopackageSplit(
    row: Omit<DeveloperCopackageSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperCopackageSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<DeveloperCopackageSplitApplicationRecord>(
      this.client
        .from(TABLES.developerCopackageSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperCopackageSplit',
    );
  }

  async getDeveloperCopackageSplit(
    sourceEventId: string,
  ): Promise<DeveloperCopackageSplitApplicationRecord | undefined> {
    return this.one<DeveloperCopackageSplitApplicationRecord>(
      this.client
        .from(TABLES.developerCopackageSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperCopackageSplit',
    );
  }

  async insertDeveloperDependencyFee(
    row: Omit<DeveloperDependencyFeeApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperDependencyFeeApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<DeveloperDependencyFeeApplicationRecord>(
      this.client
        .from(TABLES.developerDependencyFeeApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperDependencyFee',
    );
  }

  async getDeveloperDependencyFee(
    sourceEventId: string,
  ): Promise<DeveloperDependencyFeeApplicationRecord | undefined> {
    return this.one<DeveloperDependencyFeeApplicationRecord>(
      this.client
        .from(TABLES.developerDependencyFeeApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperDependencyFee',
    );
  }

  async insertDeveloperWhitelabelLicense(
    row: Omit<DeveloperWhitelabelLicenseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperWhitelabelLicenseApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<DeveloperWhitelabelLicenseApplicationRecord>(
      this.client
        .from(TABLES.developerWhitelabelLicenseApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperWhitelabelLicense',
    );
  }

  async getDeveloperWhitelabelLicense(
    sourceEventId: string,
  ): Promise<DeveloperWhitelabelLicenseApplicationRecord | undefined> {
    return this.one<DeveloperWhitelabelLicenseApplicationRecord>(
      this.client
        .from(TABLES.developerWhitelabelLicenseApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperWhitelabelLicense',
    );
  }

  async insertDeveloperToolCallApplication(
    row: Omit<DeveloperAgentToolCallApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperAgentToolCallApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<DeveloperAgentToolCallApplicationRecord>(
      this.client
        .from(TABLES.developerAgentToolCallApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertDeveloperToolCallApplication',
    );
  }

  async getDeveloperToolCallApplication(
    sourceEventId: string,
  ): Promise<DeveloperAgentToolCallApplicationRecord | undefined> {
    return this.one<DeveloperAgentToolCallApplicationRecord>(
      this.client
        .from(TABLES.developerAgentToolCallApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getDeveloperToolCallApplication',
    );
  }

  // -------------------------------------------------------------------------
  // The hardware patent lane (PR 46, migration 0050) — the founder
  // hardware directive's registries, tracker, and application ledgers.
  // HARDENED UPSERTS: no id in any conflict payload (the PR 33 lesson).
  // -------------------------------------------------------------------------

  async upsertHardwarePatentPool(
    row: Omit<HardwarePatentPoolRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePatentPoolRecord> {
    // One pool of record per pool_code.
    return this.oneStrict<HardwarePatentPoolRecord>(
      this.client
        .from(TABLES.hardwarePatentPools)
        .upsert(row, { onConflict: 'pool_code' })
        .select()
        .maybeSingle(),
      'upsertHardwarePatentPool',
    );
  }

  async getHardwarePatentPool(poolCode: string): Promise<HardwarePatentPoolRecord | undefined> {
    return this.one<HardwarePatentPoolRecord>(
      this.client
        .from(TABLES.hardwarePatentPools)
        .select()
        .eq('pool_code', poolCode)
        .maybeSingle(),
      'getHardwarePatentPool',
    );
  }

  async upsertHardwarePoolHolderLeg(
    row: Omit<HardwarePoolHolderLegRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePoolHolderLegRecord> {
    // One verified weighting per (pool_code, holder_payee_id).
    return this.oneStrict<HardwarePoolHolderLegRecord>(
      this.client
        .from(TABLES.hardwarePoolHolderLegs)
        .upsert(row, { onConflict: 'pool_code,holder_payee_id' })
        .select()
        .maybeSingle(),
      'upsertHardwarePoolHolderLeg',
    );
  }

  async getHardwarePoolHolderLeg(
    poolCode: string,
    holderPayeeId: string,
  ): Promise<HardwarePoolHolderLegRecord | undefined> {
    return this.one<HardwarePoolHolderLegRecord>(
      this.client
        .from(TABLES.hardwarePoolHolderLegs)
        .select()
        .eq('pool_code', poolCode)
        .eq('holder_payee_id', holderPayeeId)
        .maybeSingle(),
      'getHardwarePoolHolderLeg',
    );
  }

  async listHardwarePoolHolderLegs(poolCode: string): Promise<HardwarePoolHolderLegRecord[]> {
    // Registration order (the insertion order the waterfall reads).
    const { data, error } = await this.client
      .from(TABLES.hardwarePoolHolderLegs)
      .select()
      .eq('pool_code', poolCode)
      .order('created_at');
    if (error) {
      throw new Error(`listHardwarePoolHolderLegs failed: ${error.message}`);
    }
    return (data ?? []) as HardwarePoolHolderLegRecord[];
  }

  async upsertHardwareSepRoyaltyPolicy(
    row: Omit<HardwareSepRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareSepRoyaltyPolicyRecord> {
    // One policy of record per (patent_family_id, sep_pool_code).
    return this.oneStrict<HardwareSepRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.hardwareSepRoyaltyPolicies)
        .upsert(row, { onConflict: 'patent_family_id,sep_pool_code' })
        .select()
        .maybeSingle(),
      'upsertHardwareSepRoyaltyPolicy',
    );
  }

  async getHardwareSepRoyaltyPolicy(
    patentFamilyId: string,
    sepPoolCode: string,
  ): Promise<HardwareSepRoyaltyPolicyRecord | undefined> {
    return this.one<HardwareSepRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.hardwareSepRoyaltyPolicies)
        .select()
        .eq('patent_family_id', patentFamilyId)
        .eq('sep_pool_code', sepPoolCode)
        .maybeSingle(),
      'getHardwareSepRoyaltyPolicy',
    );
  }

  async upsertHardwareAutomotivePoolAssignment(
    row: Omit<HardwareAutomotivePoolAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareAutomotivePoolAssignmentRecord> {
    // One routing of record per (oem_id, line_id).
    return this.oneStrict<HardwareAutomotivePoolAssignmentRecord>(
      this.client
        .from(TABLES.hardwareAutomotivePoolAssignments)
        .upsert(row, { onConflict: 'oem_id,line_id' })
        .select()
        .maybeSingle(),
      'upsertHardwareAutomotivePoolAssignment',
    );
  }

  async getHardwareAutomotivePoolAssignment(
    oemId: string,
    lineId: string,
  ): Promise<HardwareAutomotivePoolAssignmentRecord | undefined> {
    return this.one<HardwareAutomotivePoolAssignmentRecord>(
      this.client
        .from(TABLES.hardwareAutomotivePoolAssignments)
        .select()
        .eq('oem_id', oemId)
        .eq('line_id', lineId)
        .maybeSingle(),
      'getHardwareAutomotivePoolAssignment',
    );
  }

  async upsertHardwareCleanTechRoyaltyPolicy(
    row: Omit<HardwareCleanTechRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareCleanTechRoyaltyPolicyRecord> {
    // One policy of record per patent_family_id.
    return this.oneStrict<HardwareCleanTechRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.hardwareCleanTechRoyaltyPolicies)
        .upsert(row, { onConflict: 'patent_family_id' })
        .select()
        .maybeSingle(),
      'upsertHardwareCleanTechRoyaltyPolicy',
    );
  }

  async getHardwareCleanTechRoyaltyPolicy(
    patentFamilyId: string,
  ): Promise<HardwareCleanTechRoyaltyPolicyRecord | undefined> {
    return this.one<HardwareCleanTechRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.hardwareCleanTechRoyaltyPolicies)
        .select()
        .eq('patent_family_id', patentFamilyId)
        .maybeSingle(),
      'getHardwareCleanTechRoyaltyPolicy',
    );
  }

  async upsertHardwareOtaUnlockPolicy(
    row: Omit<HardwareOtaUnlockPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareOtaUnlockPolicyRecord> {
    // One policy of record per feature_code.
    return this.oneStrict<HardwareOtaUnlockPolicyRecord>(
      this.client
        .from(TABLES.hardwareOtaUnlockPolicies)
        .upsert(row, { onConflict: 'feature_code' })
        .select()
        .maybeSingle(),
      'upsertHardwareOtaUnlockPolicy',
    );
  }

  async getHardwareOtaUnlockPolicy(
    featureCode: string,
  ): Promise<HardwareOtaUnlockPolicyRecord | undefined> {
    return this.one<HardwareOtaUnlockPolicyRecord>(
      this.client
        .from(TABLES.hardwareOtaUnlockPolicies)
        .select()
        .eq('feature_code', featureCode)
        .maybeSingle(),
      'getHardwareOtaUnlockPolicy',
    );
  }

  async upsertHardwareCrossLicenseAgreement(
    row: Omit<HardwareCrossLicenseAgreementRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareCrossLicenseAgreementRecord> {
    // One agreement of record per (company_a_id, company_b_id) — the
    // canonical pair orientation.
    return this.oneStrict<HardwareCrossLicenseAgreementRecord>(
      this.client
        .from(TABLES.hardwareCrossLicenseAgreements)
        .upsert(row, { onConflict: 'company_a_id,company_b_id' })
        .select()
        .maybeSingle(),
      'upsertHardwareCrossLicenseAgreement',
    );
  }

  async getHardwareCrossLicenseAgreement(
    companyAId: string,
    companyBId: string,
  ): Promise<HardwareCrossLicenseAgreementRecord | undefined> {
    return this.one<HardwareCrossLicenseAgreementRecord>(
      this.client
        .from(TABLES.hardwareCrossLicenseAgreements)
        .select()
        .eq('company_a_id', companyAId)
        .eq('company_b_id', companyBId)
        .maybeSingle(),
      'getHardwareCrossLicenseAgreement',
    );
  }

  async advanceHardwareSepUnitMonth(
    licenseeId: string,
    patentFamilyId: string,
    sepPoolCode: string,
    month: string,
    unitsAdded: number,
  ): Promise<HardwareSepUnitMonthRecord> {
    // UNIQUE per (licensee_id, patent_family_id, sep_pool_code, month) —
    // the tracker converges. The cumulative walk is serialized per
    // licensee-family-pool-month by the recon lane (one event at a
    // time), so a read-modify-upsert carries the same position
    // arithmetic the SQLite backend expresses additively in its ON
    // CONFLICT arm. No id in the payload.
    const existing = await this.getHardwareSepUnitMonth(
      licenseeId,
      patentFamilyId,
      sepPoolCode,
      month,
    );
    return this.oneStrict<HardwareSepUnitMonthRecord>(
      this.client
        .from(TABLES.hardwareSepUnitMonths)
        .upsert(
          {
            licensee_id: licenseeId,
            patent_family_id: patentFamilyId,
            sep_pool_code: sepPoolCode,
            month,
            cumulative_units: (existing?.cumulative_units ?? 0) + unitsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'licensee_id,patent_family_id,sep_pool_code,month' },
        )
        .select()
        .maybeSingle(),
      'advanceHardwareSepUnitMonth',
    );
  }

  async getHardwareSepUnitMonth(
    licenseeId: string,
    patentFamilyId: string,
    sepPoolCode: string,
    month: string,
  ): Promise<HardwareSepUnitMonthRecord | undefined> {
    return this.one<HardwareSepUnitMonthRecord>(
      this.client
        .from(TABLES.hardwareSepUnitMonths)
        .select()
        .eq('licensee_id', licenseeId)
        .eq('patent_family_id', patentFamilyId)
        .eq('sep_pool_code', sepPoolCode)
        .eq('month', month)
        .maybeSingle(),
      'getHardwareSepUnitMonth',
    );
  }

  async insertHardwareRealizationApplication(
    row: Omit<HardwareRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<HardwareRealizationApplicationRecord>(
      this.client
        .from(TABLES.hardwareRealizationApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwareRealizationApplication',
    );
  }

  async getHardwareRealizationApplication(
    sourceEventId: string,
  ): Promise<HardwareRealizationApplicationRecord | undefined> {
    return this.one<HardwareRealizationApplicationRecord>(
      this.client
        .from(TABLES.hardwareRealizationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getHardwareRealizationApplication',
    );
  }

  async insertHardwareSepRoyaltyApplication(
    row: Omit<HardwareSepRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareSepRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<HardwareSepRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.hardwareSepRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwareSepRoyaltyApplication',
    );
  }

  async getHardwareSepRoyaltyApplication(
    sourceEventId: string,
  ): Promise<HardwareSepRoyaltyApplicationRecord | undefined> {
    return this.one<HardwareSepRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.hardwareSepRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getHardwareSepRoyaltyApplication',
    );
  }

  async insertHardwarePoolRoutingApplication(
    row: Omit<HardwarePoolRoutingApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwarePoolRoutingApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<HardwarePoolRoutingApplicationRecord>(
      this.client
        .from(TABLES.hardwarePoolRoutingApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwarePoolRoutingApplication',
    );
  }

  async getHardwarePoolRoutingApplication(
    sourceEventId: string,
  ): Promise<HardwarePoolRoutingApplicationRecord | undefined> {
    return this.one<HardwarePoolRoutingApplicationRecord>(
      this.client
        .from(TABLES.hardwarePoolRoutingApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getHardwarePoolRoutingApplication',
    );
  }

  async insertHardwarePoolWaterfallApplication(
    row: Omit<HardwarePoolWaterfallApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwarePoolWaterfallApplicationRecord> {
    // UNIQUE per (routing_source_event_id, pool_code) — the replay guard.
    return this.oneStrict<HardwarePoolWaterfallApplicationRecord>(
      this.client
        .from(TABLES.hardwarePoolWaterfallApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwarePoolWaterfallApplication',
    );
  }

  async getHardwarePoolWaterfallApplication(
    routingSourceEventId: string,
    poolCode: string,
  ): Promise<HardwarePoolWaterfallApplicationRecord | undefined> {
    return this.one<HardwarePoolWaterfallApplicationRecord>(
      this.client
        .from(TABLES.hardwarePoolWaterfallApplications)
        .select()
        .eq('routing_source_event_id', routingSourceEventId)
        .eq('pool_code', poolCode)
        .maybeSingle(),
      'getHardwarePoolWaterfallApplication',
    );
  }

  async insertHardwareTelemetryRoyaltyApplication(
    row: Omit<HardwareTelemetryRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareTelemetryRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<HardwareTelemetryRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.hardwareTelemetryRoyaltyApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwareTelemetryRoyaltyApplication',
    );
  }

  async getHardwareTelemetryRoyaltyApplication(
    sourceEventId: string,
  ): Promise<HardwareTelemetryRoyaltyApplicationRecord | undefined> {
    return this.one<HardwareTelemetryRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.hardwareTelemetryRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getHardwareTelemetryRoyaltyApplication',
    );
  }

  async insertHardwareOtaUnlockApplication(
    row: Omit<HardwareOtaUnlockApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareOtaUnlockApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<HardwareOtaUnlockApplicationRecord>(
      this.client
        .from(TABLES.hardwareOtaUnlockApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertHardwareOtaUnlockApplication',
    );
  }

  async getHardwareOtaUnlockApplication(
    sourceEventId: string,
  ): Promise<HardwareOtaUnlockApplicationRecord | undefined> {
    return this.one<HardwareOtaUnlockApplicationRecord>(
      this.client
        .from(TABLES.hardwareOtaUnlockApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getHardwareOtaUnlockApplication',
    );
  }

  async upsertHardwareCrossLicenseNetSettlement(
    row: Omit<HardwareCrossLicenseNetSettlementRecord, 'id' | 'created_at'>,
  ): Promise<HardwareCrossLicenseNetSettlementRecord> {
    // One net clearing of record per (agreement_ref, period) — the
    // walk's recompute replaces the sums in place. No id in the payload
    // (the PR 33 lesson): the id of record survives the conflict.
    return this.oneStrict<HardwareCrossLicenseNetSettlementRecord>(
      this.client
        .from(TABLES.hardwareCrossLicenseNetSettlements)
        .upsert(row, { onConflict: 'agreement_ref,period' })
        .select()
        .maybeSingle(),
      'upsertHardwareCrossLicenseNetSettlement',
    );
  }

  async getHardwareCrossLicenseNetSettlement(
    agreementRef: string,
    period: string,
  ): Promise<HardwareCrossLicenseNetSettlementRecord | undefined> {
    return this.one<HardwareCrossLicenseNetSettlementRecord>(
      this.client
        .from(TABLES.hardwareCrossLicenseNetSettlements)
        .select()
        .eq('agreement_ref', agreementRef)
        .eq('period', period)
        .maybeSingle(),
      'getHardwareCrossLicenseNetSettlement',
    );
  }

  async sumHardwareSepRoyaltiesBetween(
    licenseeId: string,
    payeeId: string,
    period: string,
  ): Promise<number> {
    // The netting walk's liability aggregation — the amount column alone,
    // summed exactly (never a page of full rows).
    const rows = await this.many<{ royalty_cents: number }>(
      this.client
        .from(TABLES.hardwareSepRoyaltyApplications)
        .select('royalty_cents')
        .eq('licensee_id', licenseeId)
        .eq('payee_id', payeeId)
        .eq('period', period),
      'sumHardwareSepRoyaltiesBetween',
    );
    return rows.reduce((total, row) => total + row.royalty_cents, 0);
  }

  // -------------------------------------------------------------------------
  // The energy lane (PR 48, migration 0052) — the founder resource
  // directive's registries, posts, and application ledgers. HARDENED
  // UPSERTS: no id in any conflict payload (the PR 33 lesson).
  // -------------------------------------------------------------------------

  async upsertEnergyLandParcel(
    row: Omit<EnergyLandParcelRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyLandParcelRecord> {
    // One parcel of record per parcel_id.
    return this.oneStrict<EnergyLandParcelRecord>(
      this.client
        .from(TABLES.energyLandParcels)
        .upsert(row, { onConflict: 'parcel_id' })
        .select()
        .maybeSingle(),
      'upsertEnergyLandParcel',
    );
  }

  async getEnergyLandParcel(
    parcelId: string,
  ): Promise<EnergyLandParcelRecord | undefined> {
    return this.one<EnergyLandParcelRecord>(
      this.client
        .from(TABLES.energyLandParcels)
        .select()
        .eq('parcel_id', parcelId)
        .maybeSingle(),
      'getEnergyLandParcel',
    );
  }

  async upsertEnergyParcelOwnerInterest(
    row: Omit<EnergyParcelOwnerInterestRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyParcelOwnerInterestRecord> {
    // One deeded interest per (parcel_id, owner_payee_id).
    return this.oneStrict<EnergyParcelOwnerInterestRecord>(
      this.client
        .from(TABLES.energyParcelOwnerInterests)
        .upsert(row, { onConflict: 'parcel_id,owner_payee_id' })
        .select()
        .maybeSingle(),
      'upsertEnergyParcelOwnerInterest',
    );
  }

  async listEnergyParcelOwnerInterests(
    parcelId: string,
  ): Promise<EnergyParcelOwnerInterestRecord[]> {
    // Registration order (the insertion order the division reads).
    const { data, error } = await this.client
      .from(TABLES.energyParcelOwnerInterests)
      .select()
      .eq('parcel_id', parcelId)
      .order('created_at');
    if (error) {
      throw new Error(`listEnergyParcelOwnerInterests failed: ${error.message}`);
    }
    return (data ?? []) as EnergyParcelOwnerInterestRecord[];
  }

  async upsertEnergyParcelRoyaltyPolicy(
    row: Omit<EnergyParcelRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyParcelRoyaltyPolicyRecord> {
    // One policy of record per parcel_id.
    return this.oneStrict<EnergyParcelRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.energyParcelRoyaltyPolicies)
        .upsert(row, { onConflict: 'parcel_id' })
        .select()
        .maybeSingle(),
      'upsertEnergyParcelRoyaltyPolicy',
    );
  }

  async getEnergyParcelRoyaltyPolicy(
    parcelId: string,
  ): Promise<EnergyParcelRoyaltyPolicyRecord | undefined> {
    return this.one<EnergyParcelRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.energyParcelRoyaltyPolicies)
        .select()
        .eq('parcel_id', parcelId)
        .maybeSingle(),
      'getEnergyParcelRoyaltyPolicy',
    );
  }

  async advanceEnergyParcelRoyaltyPosition(
    parcelId: string,
    period: string,
    currency: string,
    revenueCentsAdded: number,
    royaltyCentsAdded: number,
  ): Promise<EnergyParcelRoyaltyPositionRecord> {
    // UNIQUE per (parcel_id, period, currency) — the position converges.
    // The cumulative walk is serialized per parcel-period-currency by
    // the recon lane (one event at a time), so a read-modify-upsert
    // carries the same position arithmetic the SQLite backend expresses
    // additively in its ON CONFLICT arm. No id in the payload.
    const existing = await this.getEnergyParcelRoyaltyPosition(
      parcelId,
      period,
      currency,
    );
    return this.oneStrict<EnergyParcelRoyaltyPositionRecord>(
      this.client
        .from(TABLES.energyParcelRoyaltyPositions)
        .upsert(
          {
            parcel_id: parcelId,
            period,
            currency,
            cumulative_revenue_cents:
              (existing?.cumulative_revenue_cents ?? 0) + revenueCentsAdded,
            cumulative_royalty_cents:
              (existing?.cumulative_royalty_cents ?? 0) + royaltyCentsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'parcel_id,period,currency' },
        )
        .select()
        .maybeSingle(),
      'advanceEnergyParcelRoyaltyPosition',
    );
  }

  async getEnergyParcelRoyaltyPosition(
    parcelId: string,
    period: string,
    currency: string,
  ): Promise<EnergyParcelRoyaltyPositionRecord | undefined> {
    return this.one<EnergyParcelRoyaltyPositionRecord>(
      this.client
        .from(TABLES.energyParcelRoyaltyPositions)
        .select()
        .eq('parcel_id', parcelId)
        .eq('period', period)
        .eq('currency', currency)
        .maybeSingle(),
      'getEnergyParcelRoyaltyPosition',
    );
  }

  async upsertEnergyComputeYieldPolicy(
    row: Omit<EnergyComputeYieldPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyComputeYieldPolicyRecord> {
    // One policy of record per gpu_cluster_hash.
    return this.oneStrict<EnergyComputeYieldPolicyRecord>(
      this.client
        .from(TABLES.energyComputeYieldPolicies)
        .upsert(row, { onConflict: 'gpu_cluster_hash' })
        .select()
        .maybeSingle(),
      'upsertEnergyComputeYieldPolicy',
    );
  }

  async getEnergyComputeYieldPolicy(
    gpuClusterHash: string,
  ): Promise<EnergyComputeYieldPolicyRecord | undefined> {
    return this.one<EnergyComputeYieldPolicyRecord>(
      this.client
        .from(TABLES.energyComputeYieldPolicies)
        .select()
        .eq('gpu_cluster_hash', gpuClusterHash)
        .maybeSingle(),
      'getEnergyComputeYieldPolicy',
    );
  }

  async advanceEnergyComputeYieldPosition(
    gpuClusterHash: string,
    period: string,
    currency: string,
    computeRevenueCentsAdded: number,
    yieldCentsAdded: number,
  ): Promise<EnergyComputeYieldPositionRecord> {
    // UNIQUE per (gpu_cluster_hash, period, currency) — the position
    // converges; serialized per the recon lane. No id in the payload.
    const existing = await this.getEnergyComputeYieldPosition(
      gpuClusterHash,
      period,
      currency,
    );
    return this.oneStrict<EnergyComputeYieldPositionRecord>(
      this.client
        .from(TABLES.energyComputeYieldPositions)
        .upsert(
          {
            gpu_cluster_hash: gpuClusterHash,
            period,
            currency,
            cumulative_compute_revenue_cents:
              (existing?.cumulative_compute_revenue_cents ?? 0) +
              computeRevenueCentsAdded,
            cumulative_yield_cents:
              (existing?.cumulative_yield_cents ?? 0) + yieldCentsAdded,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'gpu_cluster_hash,period,currency' },
        )
        .select()
        .maybeSingle(),
      'advanceEnergyComputeYieldPosition',
    );
  }

  async getEnergyComputeYieldPosition(
    gpuClusterHash: string,
    period: string,
    currency: string,
  ): Promise<EnergyComputeYieldPositionRecord | undefined> {
    return this.one<EnergyComputeYieldPositionRecord>(
      this.client
        .from(TABLES.energyComputeYieldPositions)
        .select()
        .eq('gpu_cluster_hash', gpuClusterHash)
        .eq('period', period)
        .eq('currency', currency)
        .maybeSingle(),
      'getEnergyComputeYieldPosition',
    );
  }

  async upsertEnergyGridParticipant(
    row: Omit<
      EnergyGridParticipantRegistrationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<EnergyGridParticipantRegistrationRecord> {
    // One registration per (gpu_cluster_hash, participant_payee_id).
    return this.oneStrict<EnergyGridParticipantRegistrationRecord>(
      this.client
        .from(TABLES.energyGridParticipants)
        .upsert(row, { onConflict: 'gpu_cluster_hash,participant_payee_id' })
        .select()
        .maybeSingle(),
      'upsertEnergyGridParticipant',
    );
  }

  async listEnergyGridParticipants(
    gpuClusterHash: string,
  ): Promise<EnergyGridParticipantRegistrationRecord[]> {
    // Registration order (the insertion order the split reads).
    const { data, error } = await this.client
      .from(TABLES.energyGridParticipants)
      .select()
      .eq('gpu_cluster_hash', gpuClusterHash)
      .order('created_at');
    if (error) {
      throw new Error(`listEnergyGridParticipants failed: ${error.message}`);
    }
    return (data ?? []) as EnergyGridParticipantRegistrationRecord[];
  }

  async upsertEnergyDivisionOrder(
    row: Omit<EnergyDivisionOrderRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyDivisionOrderRecord> {
    // One order of record per order_ref.
    return this.oneStrict<EnergyDivisionOrderRecord>(
      this.client
        .from(TABLES.energyDivisionOrders)
        .upsert(row, { onConflict: 'order_ref' })
        .select()
        .maybeSingle(),
      'upsertEnergyDivisionOrder',
    );
  }

  async getEnergyDivisionOrder(
    orderRef: string,
  ): Promise<EnergyDivisionOrderRecord | undefined> {
    return this.one<EnergyDivisionOrderRecord>(
      this.client
        .from(TABLES.energyDivisionOrders)
        .select()
        .eq('order_ref', orderRef)
        .maybeSingle(),
      'getEnergyDivisionOrder',
    );
  }

  async upsertEnergyDeedTransfer(
    row: Omit<EnergyDeedTransferRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyDeedTransferRecord> {
    // One transfer of record per deed_ref.
    return this.oneStrict<EnergyDeedTransferRecord>(
      this.client
        .from(TABLES.energyDeedTransfers)
        .upsert(row, { onConflict: 'deed_ref' })
        .select()
        .maybeSingle(),
      'upsertEnergyDeedTransfer',
    );
  }

  async getEnergyDeedTransfer(
    deedRef: string,
  ): Promise<EnergyDeedTransferRecord | undefined> {
    return this.one<EnergyDeedTransferRecord>(
      this.client
        .from(TABLES.energyDeedTransfers)
        .select()
        .eq('deed_ref', deedRef)
        .maybeSingle(),
      'getEnergyDeedTransfer',
    );
  }

  async listEnergyDeedTransfersForParcel(
    parcelId: string,
  ): Promise<EnergyDeedTransferRecord[]> {
    // Registration order (the insertion order the division reads).
    const { data, error } = await this.client
      .from(TABLES.energyDeedTransfers)
      .select()
      .eq('parcel_id', parcelId)
      .order('created_at');
    if (error) {
      throw new Error(`listEnergyDeedTransfersForParcel failed: ${error.message}`);
    }
    return (data ?? []) as EnergyDeedTransferRecord[];
  }

  async upsertEnergyCarbonOffsetPolicy(
    row: Omit<EnergyCarbonOffsetPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyCarbonOffsetPolicyRecord> {
    // One policy of record per parcel_id.
    return this.oneStrict<EnergyCarbonOffsetPolicyRecord>(
      this.client
        .from(TABLES.energyCarbonOffsetPolicies)
        .upsert(row, { onConflict: 'parcel_id' })
        .select()
        .maybeSingle(),
      'upsertEnergyCarbonOffsetPolicy',
    );
  }

  async getEnergyCarbonOffsetPolicy(
    parcelId: string,
  ): Promise<EnergyCarbonOffsetPolicyRecord | undefined> {
    return this.one<EnergyCarbonOffsetPolicyRecord>(
      this.client
        .from(TABLES.energyCarbonOffsetPolicies)
        .select()
        .eq('parcel_id', parcelId)
        .maybeSingle(),
      'getEnergyCarbonOffsetPolicy',
    );
  }

  async insertEnergyMeterSalesPost(
    row: Omit<EnergyMeterSalesPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyMeterSalesPostRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyMeterSalesPostRecord>(
      this.client
        .from(TABLES.energyMeterSalesPosts)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyMeterSalesPost',
    );
  }

  async getEnergyMeterSalesPost(
    sourceEventId: string,
  ): Promise<EnergyMeterSalesPostRecord | undefined> {
    return this.one<EnergyMeterSalesPostRecord>(
      this.client
        .from(TABLES.energyMeterSalesPosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyMeterSalesPost',
    );
  }

  async insertEnergyPipelineDeductionPost(
    row: Omit<EnergyPipelineDeductionPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyPipelineDeductionPostRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyPipelineDeductionPostRecord>(
      this.client
        .from(TABLES.energyPipelineDeductionPosts)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyPipelineDeductionPost',
    );
  }

  async getEnergyPipelineDeductionPost(
    sourceEventId: string,
  ): Promise<EnergyPipelineDeductionPostRecord | undefined> {
    return this.one<EnergyPipelineDeductionPostRecord>(
      this.client
        .from(TABLES.energyPipelineDeductionPosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyPipelineDeductionPost',
    );
  }

  async insertEnergyGpuUtilizationPost(
    row: Omit<EnergyGpuUtilizationPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyGpuUtilizationPostRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyGpuUtilizationPostRecord>(
      this.client
        .from(TABLES.energyGpuUtilizationPosts)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyGpuUtilizationPost',
    );
  }

  async getEnergyGpuUtilizationPost(
    sourceEventId: string,
  ): Promise<EnergyGpuUtilizationPostRecord | undefined> {
    return this.one<EnergyGpuUtilizationPostRecord>(
      this.client
        .from(TABLES.energyGpuUtilizationPosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyGpuUtilizationPost',
    );
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
    // The realization recompute's aggregation — the amount columns alone,
    // summed exactly (never a page of full rows).
    const meterRows = await this.many<{
      gross_energy_sales_cents: number;
      gross_mineral_sales_cents: number;
    }>(
      this.client
        .from(TABLES.energyMeterSalesPosts)
        .select('gross_energy_sales_cents,gross_mineral_sales_cents')
        .eq('parcel_id', parcelId)
        .eq('well_meter_id', wellMeterId)
        .eq('gpu_cluster_hash', gpuClusterHash)
        .eq('period', period)
        .eq('currency', currency),
      'sumEnergyRealizationPosts',
    );
    const pipelineRows = await this.many<{
      transportation_pipeline_deductions_cents: number;
      grid_transmission_fees_cents: number;
      processing_refining_base_fees_cents: number;
    }>(
      this.client
        .from(TABLES.energyPipelineDeductionPosts)
        .select(
          'transportation_pipeline_deductions_cents,grid_transmission_fees_cents,processing_refining_base_fees_cents',
        )
        .eq('parcel_id', parcelId)
        .eq('well_meter_id', wellMeterId)
        .eq('gpu_cluster_hash', gpuClusterHash)
        .eq('period', period)
        .eq('currency', currency),
      'sumEnergyRealizationPosts',
    );
    return {
      gross_energy_sales_cents: meterRows.reduce(
        (total, row) => total + row.gross_energy_sales_cents,
        0,
      ),
      gross_mineral_sales_cents: meterRows.reduce(
        (total, row) => total + row.gross_mineral_sales_cents,
        0,
      ),
      transportation_pipeline_deductions_cents: pipelineRows.reduce(
        (total, row) => total + row.transportation_pipeline_deductions_cents,
        0,
      ),
      grid_transmission_fees_cents: pipelineRows.reduce(
        (total, row) => total + row.grid_transmission_fees_cents,
        0,
      ),
      processing_refining_base_fees_cents: pipelineRows.reduce(
        (total, row) => total + row.processing_refining_base_fees_cents,
        0,
      ),
    };
  }

  async upsertEnergyNetRealizationApplication(
    row: Omit<
      EnergyNetRealizationApplicationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<EnergyNetRealizationApplicationRecord> {
    // The realization position of record — UNIQUE per the founder's
    // five-tuple; the recompute replaces the sums in place (no id in the
    // conflict payload — the PR 33 lesson). updated_at is stamped here —
    // the caller has no clock.
    return this.oneStrict<EnergyNetRealizationApplicationRecord>(
      this.client
        .from(TABLES.energyNetRealizationApplications)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          {
            onConflict:
              'parcel_id,well_meter_id,gpu_cluster_hash,period,currency',
          },
        )
        .select()
        .maybeSingle(),
      'upsertEnergyNetRealizationApplication',
    );
  }

  async getEnergyNetRealizationApplication(
    sourceEventId: string,
  ): Promise<EnergyNetRealizationApplicationRecord | undefined> {
    return this.one<EnergyNetRealizationApplicationRecord>(
      this.client
        .from(TABLES.energyNetRealizationApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyNetRealizationApplication',
    );
  }

  async insertEnergyParcelDivisionApplication(
    row: Omit<EnergyParcelDivisionApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyParcelDivisionApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyParcelDivisionApplicationRecord>(
      this.client
        .from(TABLES.energyParcelDivisionApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyParcelDivisionApplication',
    );
  }

  async getEnergyParcelDivisionApplication(
    sourceEventId: string,
  ): Promise<EnergyParcelDivisionApplicationRecord | undefined> {
    return this.one<EnergyParcelDivisionApplicationRecord>(
      this.client
        .from(TABLES.energyParcelDivisionApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyParcelDivisionApplication',
    );
  }

  async insertEnergyComputeGridSplitApplication(
    row: Omit<EnergyComputeGridSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyComputeGridSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyComputeGridSplitApplicationRecord>(
      this.client
        .from(TABLES.energyComputeGridSplitApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyComputeGridSplitApplication',
    );
  }

  async getEnergyComputeGridSplitApplication(
    sourceEventId: string,
  ): Promise<EnergyComputeGridSplitApplicationRecord | undefined> {
    return this.one<EnergyComputeGridSplitApplicationRecord>(
      this.client
        .from(TABLES.energyComputeGridSplitApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyComputeGridSplitApplication',
    );
  }

  async insertEnergyStatutoryInterestApplication(
    row: Omit<EnergyStatutoryInterestApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyStatutoryInterestApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyStatutoryInterestApplicationRecord>(
      this.client
        .from(TABLES.energyStatutoryInterestApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyStatutoryInterestApplication',
    );
  }

  async getEnergyStatutoryInterestApplication(
    sourceEventId: string,
  ): Promise<EnergyStatutoryInterestApplicationRecord | undefined> {
    return this.one<EnergyStatutoryInterestApplicationRecord>(
      this.client
        .from(TABLES.energyStatutoryInterestApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyStatutoryInterestApplication',
    );
  }

  async insertEnergyCarbonOffsetPayoutApplication(
    row: Omit<EnergyCarbonOffsetPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyCarbonOffsetPayoutApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    return this.oneStrict<EnergyCarbonOffsetPayoutApplicationRecord>(
      this.client
        .from(TABLES.energyCarbonOffsetPayoutApplications)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEnergyCarbonOffsetPayoutApplication',
    );
  }

  async getEnergyCarbonOffsetPayoutApplication(
    sourceEventId: string,
  ): Promise<EnergyCarbonOffsetPayoutApplicationRecord | undefined> {
    return this.one<EnergyCarbonOffsetPayoutApplicationRecord>(
      this.client
        .from(TABLES.energyCarbonOffsetPayoutApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getEnergyCarbonOffsetPayoutApplication',
    );
  }

  // ---------------------------------------------------------------------------
  // PR 49 — the resource audit escrow, the resource payout gate states, and
  // the staged grid-split completion (the instant cascade's journal stamp).
  // ---------------------------------------------------------------------------

  async upsertResourceAuditEscrowPolicy(
    row: Omit<ResourceAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ResourceAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the newest
    // rate governs the next routing). HARDENED UPSERT: no id in the
    // payload (the id rotates on conflict).
    return this.oneStrict<ResourceAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.resourceAuditEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertResourceAuditEscrowPolicy',
    );
  }

  async getResourceAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<ResourceAuditEscrowPolicyRecord | undefined> {
    return this.one<ResourceAuditEscrowPolicyRecord>(
      this.client
        .from(TABLES.resourceAuditEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getResourceAuditEscrowPolicy',
    );
  }

  async insertResourceAuditEscrowDrawdown(
    row: Omit<ResourceAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<ResourceAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<ResourceAuditEscrowDrawdownRecord>(
      this.client
        .from(TABLES.resourceAuditEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertResourceAuditEscrowDrawdown',
    );
  }

  async listResourceAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<ResourceAuditEscrowDrawdownRecord[]> {
    // Chronological spend order — the same ordering discipline the
    // patent escrow's drawdown list runs.
    const { data, error } = await this.client
      .from(TABLES.resourceAuditEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listResourceAuditEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as ResourceAuditEscrowDrawdownRecord[];
  }

  async insertResourceAuditEscrowReconciliation(
    row: Omit<ResourceAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<ResourceAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    return this.oneStrict<ResourceAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.resourceAuditEscrowReconciliations)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertResourceAuditEscrowReconciliation',
    );
  }

  async getResourceAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<ResourceAuditEscrowReconciliationRecord | undefined> {
    return this.one<ResourceAuditEscrowReconciliationRecord>(
      this.client
        .from(TABLES.resourceAuditEscrowReconciliations)
        .select()
        .eq('reserve_ledger_id', reserveLedgerId)
        .maybeSingle(),
      'getResourceAuditEscrowReconciliation',
    );
  }

  async settleResourceAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'resource_audit_escrow')
      .select();
    if (error) {
      throw new Error(`settleResourceAuditEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertResourcePayoutGateState(
    row: Omit<ResourcePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ResourcePayoutGateStateRecord> {
    // UNIQUE per (payee_id, parcel_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<ResourcePayoutGateStateRecord>(
      this.client
        .from(TABLES.resourcePayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,parcel_id' })
        .select()
        .maybeSingle(),
      'upsertResourcePayoutGateState',
    );
  }

  async getResourcePayoutGateState(
    payeeId: string,
    parcelId: string,
  ): Promise<ResourcePayoutGateStateRecord | undefined> {
    return this.one<ResourcePayoutGateStateRecord>(
      this.client
        .from(TABLES.resourcePayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('parcel_id', parcelId)
        .maybeSingle(),
      'getResourcePayoutGateState',
    );
  }

  async setEnergyComputeGridSplitJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<EnergyComputeGridSplitApplicationRecord | undefined> {
    // The conditional update is the CAS: the journal stamps only while
    // the staged application's journal_id is still null (PR 48 stages
    // the split, PR 49's instant cascade completes it); a lost race (or
    // a replay) updates zero rows and returns undefined. The null check
    // rides `.is()` — PostgREST's null filter.
    const { data, error } = await this.client
      .from(TABLES.energyComputeGridSplitApplications)
      .update({ journal_id: journalId })
      .eq('source_event_id', sourceEventId)
      .is('journal_id', null)
      .select();
    if (error) {
      throw new Error(`setEnergyComputeGridSplitJournal failed: ${error.message}`);
    }
    return (data?.[0] as EnergyComputeGridSplitApplicationRecord | undefined) ?? undefined;
  }

  // ------------------------------------------------------------------
  // PR 50 — the sports lane. The Supabase mirror of the sports store
  // seam: registry upserts converge on their natural keys, posts are
  // replay-guarded by UNIQUE(source_event_id) (contract_ref for the
  // contracts), and the positions of record replace in place — no id
  // in any conflict payload (the PR 33 lesson). Aggregates select the
  // amount columns alone and sum exactly in JS (integer cents — never
  // a page of full rows).
  // ------------------------------------------------------------------

  async upsertSportsStudentAthleteProfile(
    row: Omit<SportsStudentAthleteProfileRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsStudentAthleteProfileRecord> {
    return this.oneStrict<SportsStudentAthleteProfileRecord>(
      this.client
        .from(TABLES.sportsStudentAthleteProfiles)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'athlete_glan' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsStudentAthleteProfile',
    );
  }

  async getSportsStudentAthleteProfile(
    athleteGlan: string,
  ): Promise<SportsStudentAthleteProfileRecord | undefined> {
    return this.one<SportsStudentAthleteProfileRecord>(
      this.client
        .from(TABLES.sportsStudentAthleteProfiles)
        .select()
        .eq('athlete_glan', athleteGlan)
        .maybeSingle(),
      'getSportsStudentAthleteProfile',
    );
  }

  async getSportsStudentAthleteProfileByNilAthleteId(
    nilAthleteId: string,
  ): Promise<SportsStudentAthleteProfileRecord | undefined> {
    return this.one<SportsStudentAthleteProfileRecord>(
      this.client
        .from(TABLES.sportsStudentAthleteProfiles)
        .select()
        .eq('nil_athlete_id', nilAthleteId)
        .maybeSingle(),
      'getSportsStudentAthleteProfileByNilAthleteId',
    );
  }

  async upsertSportsResaleRoyaltyPolicy(
    row: Omit<SportsResaleRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsResaleRoyaltyPolicyRecord> {
    return this.oneStrict<SportsResaleRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.sportsResaleRoyaltyPolicies)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'venue_gln,league_rights_code' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsResaleRoyaltyPolicy',
    );
  }

  async getSportsResaleRoyaltyPolicy(
    venueGln: string,
    leagueRightsCode: string,
  ): Promise<SportsResaleRoyaltyPolicyRecord | undefined> {
    return this.one<SportsResaleRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.sportsResaleRoyaltyPolicies)
        .select()
        .eq('venue_gln', venueGln)
        .eq('league_rights_code', leagueRightsCode)
        .maybeSingle(),
      'getSportsResaleRoyaltyPolicy',
    );
  }

  async upsertSportsLeaguePoolPolicy(
    row: Omit<SportsLeaguePoolPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeaguePoolPolicyRecord> {
    return this.oneStrict<SportsLeaguePoolPolicyRecord>(
      this.client
        .from(TABLES.sportsLeaguePoolPolicies)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'league_rights_code' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsLeaguePoolPolicy',
    );
  }

  async getSportsLeaguePoolPolicy(
    leagueRightsCode: string,
  ): Promise<SportsLeaguePoolPolicyRecord | undefined> {
    return this.one<SportsLeaguePoolPolicyRecord>(
      this.client
        .from(TABLES.sportsLeaguePoolPolicies)
        .select()
        .eq('league_rights_code', leagueRightsCode)
        .maybeSingle(),
      'getSportsLeaguePoolPolicy',
    );
  }

  async upsertSportsLeagueTeam(
    row: Omit<SportsLeagueTeamRegistrationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeagueTeamRegistrationRecord> {
    return this.oneStrict<SportsLeagueTeamRegistrationRecord>(
      this.client
        .from(TABLES.sportsLeagueTeamRegistrations)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'league_rights_code,team_code' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsLeagueTeam',
    );
  }

  async listSportsLeagueTeams(
    leagueRightsCode: string,
  ): Promise<SportsLeagueTeamRegistrationRecord[]> {
    return this.many<SportsLeagueTeamRegistrationRecord>(
      this.client
        .from(TABLES.sportsLeagueTeamRegistrations)
        .select()
        .eq('league_rights_code', leagueRightsCode)
        .order('team_code'),
      'listSportsLeagueTeams',
    );
  }

  async upsertSportsBiometricRoyaltyPolicy(
    row: Omit<SportsBiometricRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsBiometricRoyaltyPolicyRecord> {
    return this.oneStrict<SportsBiometricRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.sportsBiometricRoyaltyPolicies)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'league_rights_code,licensee_class' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsBiometricRoyaltyPolicy',
    );
  }

  async getSportsBiometricRoyaltyPolicy(
    leagueRightsCode: string,
    licenseeClass: SportsLicenseeClass,
  ): Promise<SportsBiometricRoyaltyPolicyRecord | undefined> {
    return this.one<SportsBiometricRoyaltyPolicyRecord>(
      this.client
        .from(TABLES.sportsBiometricRoyaltyPolicies)
        .select()
        .eq('league_rights_code', leagueRightsCode)
        .eq('licensee_class', licenseeClass)
        .maybeSingle(),
      'getSportsBiometricRoyaltyPolicy',
    );
  }

  async insertSportsTicketSalePost(
    row: Omit<SportsTicketSalePostRecord, 'id' | 'created_at'>,
  ): Promise<SportsTicketSalePostRecord> {
    // UNIQUE per source_event_id — the replay guard. A duplicate walks
    // into the thrown unique-violation (the InMemory/SQLite parity).
    return this.oneStrict<SportsTicketSalePostRecord>(
      this.client
        .from(TABLES.sportsTicketSalePosts)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsTicketSalePost',
    );
  }

  async getSportsTicketSalePost(
    sourceEventId: string,
  ): Promise<SportsTicketSalePostRecord | undefined> {
    return this.one<SportsTicketSalePostRecord>(
      this.client
        .from(TABLES.sportsTicketSalePosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsTicketSalePost',
    );
  }

  async insertSportsResaleSalePost(
    row: Omit<SportsResaleSalePostRecord, 'id' | 'created_at'>,
  ): Promise<SportsResaleSalePostRecord> {
    return this.oneStrict<SportsResaleSalePostRecord>(
      this.client
        .from(TABLES.sportsResaleSalePosts)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsResaleSalePost',
    );
  }

  async getSportsResaleSalePost(
    sourceEventId: string,
  ): Promise<SportsResaleSalePostRecord | undefined> {
    return this.one<SportsResaleSalePostRecord>(
      this.client
        .from(TABLES.sportsResaleSalePosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsResaleSalePost',
    );
  }

  async insertSportsTurnstileScanPost(
    row: Omit<SportsTurnstileScanPostRecord, 'id' | 'created_at'>,
  ): Promise<SportsTurnstileScanPostRecord> {
    return this.oneStrict<SportsTurnstileScanPostRecord>(
      this.client
        .from(TABLES.sportsTurnstileScanPosts)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsTurnstileScanPost',
    );
  }

  async getSportsTurnstileScanPost(
    sourceEventId: string,
  ): Promise<SportsTurnstileScanPostRecord | undefined> {
    return this.one<SportsTurnstileScanPostRecord>(
      this.client
        .from(TABLES.sportsTurnstileScanPosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsTurnstileScanPost',
    );
  }

  async insertSportsBiometricTrackingPost(
    row: Omit<SportsBiometricTrackingPostRecord, 'id' | 'created_at'>,
  ): Promise<SportsBiometricTrackingPostRecord> {
    return this.oneStrict<SportsBiometricTrackingPostRecord>(
      this.client
        .from(TABLES.sportsBiometricTrackingPosts)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsBiometricTrackingPost',
    );
  }

  async getSportsBiometricTrackingPost(
    sourceEventId: string,
  ): Promise<SportsBiometricTrackingPostRecord | undefined> {
    return this.one<SportsBiometricTrackingPostRecord>(
      this.client
        .from(TABLES.sportsBiometricTrackingPosts)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsBiometricTrackingPost',
    );
  }

  async insertSportsBroadcastingContract(
    row: Omit<SportsBroadcastingContractRecord, 'id' | 'created_at'>,
  ): Promise<SportsBroadcastingContractRecord> {
    // UNIQUE per contract_ref — the replay guard (the contract's own
    // reference, not a source event id).
    return this.oneStrict<SportsBroadcastingContractRecord>(
      this.client
        .from(TABLES.sportsBroadcastingContracts)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsBroadcastingContract',
    );
  }

  async getSportsBroadcastingContract(
    contractRef: string,
  ): Promise<SportsBroadcastingContractRecord | undefined> {
    return this.one<SportsBroadcastingContractRecord>(
      this.client
        .from(TABLES.sportsBroadcastingContracts)
        .select()
        .eq('contract_ref', contractRef)
        .maybeSingle(),
      'getSportsBroadcastingContract',
    );
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
    // The realization recompute's aggregation — the amount columns alone,
    // summed exactly (never a page of full rows).
    const rows = await this.many<{
      gross_ticket_revenue_cents: number;
      facility_surcharges_cents: number;
      municipal_taxes_cents: number;
      insurance_reserves_cents: number;
      processor_fee_cuts_cents: number;
      ticket_count: number;
    }>(
      this.client
        .from(TABLES.sportsTicketSalePosts)
        .select(
          'gross_ticket_revenue_cents,facility_surcharges_cents,municipal_taxes_cents,insurance_reserves_cents,processor_fee_cuts_cents,ticket_count',
        )
        .eq('nil_contract_id', nilContractId)
        .eq('athlete_glan', athleteGlan)
        .eq('venue_gln', venueGln)
        .eq('league_rights_code', leagueRightsCode)
        .eq('turnstile_scan_hash', turnstileScanHash)
        .eq('period', period)
        .eq('currency', currency),
      'sumSportsGateLegs',
    );
    return rows.reduce(
      (acc, row) => ({
        gross_ticket_revenue_cents:
          acc.gross_ticket_revenue_cents + row.gross_ticket_revenue_cents,
        facility_surcharges_cents:
          acc.facility_surcharges_cents + row.facility_surcharges_cents,
        municipal_taxes_cents: acc.municipal_taxes_cents + row.municipal_taxes_cents,
        insurance_reserves_cents:
          acc.insurance_reserves_cents + row.insurance_reserves_cents,
        processor_fee_cuts_cents:
          acc.processor_fee_cuts_cents + row.processor_fee_cuts_cents,
        ticket_count: acc.ticket_count + row.ticket_count,
      }),
      {
        gross_ticket_revenue_cents: 0,
        facility_surcharges_cents: 0,
        municipal_taxes_cents: 0,
        insurance_reserves_cents: 0,
        processor_fee_cuts_cents: 0,
        ticket_count: 0,
      },
    );
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
    const rows = await this.many<{
      nil_contract_id: string;
      athlete_glan: string;
      venue_gln: string;
      league_rights_code: string;
      turnstile_scan_hash: string;
      period: string;
      currency: string;
    }>(
      this.client
        .from(TABLES.sportsTicketSalePosts)
        .select(
          'nil_contract_id,athlete_glan,venue_gln,league_rights_code,turnstile_scan_hash,period,currency',
        )
        .eq('venue_gln', venueGln)
        .eq('turnstile_scan_hash', turnstileScanHash),
      'listSportsTicketSaleKeysForHash',
    );
    // PostgREST has no SELECT DISTINCT — dedupe on the joined identity.
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = [
        row.nil_contract_id,
        row.athlete_glan,
        row.venue_gln,
        row.league_rights_code,
        row.turnstile_scan_hash,
        row.period,
        row.currency,
      ].join('\u0000');
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
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
    const ticketRows = await this.many<{
      ticket_count: number;
      gross_ticket_revenue_cents: number;
    }>(
      this.client
        .from(TABLES.sportsTicketSalePosts)
        .select('ticket_count,gross_ticket_revenue_cents')
        .eq('venue_gln', venueGln)
        .eq('period', period)
        .eq('currency', currency),
      'sumSportsGateReconciliationSides/tickets',
    );
    const scanRows = await this.many<{ scan_count: number }>(
      this.client
        .from(TABLES.sportsTurnstileScanPosts)
        .select('scan_count')
        .eq('venue_gln', venueGln)
        .eq('period', period)
        .eq('currency', currency),
      'sumSportsGateReconciliationSides/scans',
    );
    return {
      ticket_count_sum: ticketRows.reduce((sum, row) => sum + row.ticket_count, 0),
      scan_count_sum: scanRows.reduce((sum, row) => sum + row.scan_count, 0),
      gross_ticket_revenue_cents: ticketRows.reduce(
        (sum, row) => sum + row.gross_ticket_revenue_cents,
        0,
      ),
    };
  }

  async upsertSportsGateReconciliation(
    row: Omit<SportsGateReconciliationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsGateReconciliationRecord> {
    return this.oneStrict<SportsGateReconciliationRecord>(
      this.client
        .from(TABLES.sportsGateReconciliations)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'venue_gln,period,currency' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsGateReconciliation',
    );
  }

  async getSportsGateReconciliation(
    sourceEventId: string,
  ): Promise<SportsGateReconciliationRecord | undefined> {
    return this.one<SportsGateReconciliationRecord>(
      this.client
        .from(TABLES.sportsGateReconciliations)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsGateReconciliation',
    );
  }

  async upsertSportsNetVenueRealization(
    row: Omit<SportsNetVenueRealizationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsNetVenueRealizationRecord> {
    // The realization position of record — UNIQUE per the founder's
    // tuple; the recompute replaces the sums in place (no id in the
    // conflict payload — the PR 33 lesson).
    return this.oneStrict<SportsNetVenueRealizationRecord>(
      this.client
        .from(TABLES.sportsNetVenueRealizations)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          {
            onConflict:
              'nil_contract_id,athlete_glan,venue_gln,league_rights_code,turnstile_scan_hash,period,currency',
          },
        )
        .select()
        .maybeSingle(),
      'upsertSportsNetVenueRealization',
    );
  }

  async getSportsNetVenueRealization(
    sourceEventId: string,
  ): Promise<SportsNetVenueRealizationRecord | undefined> {
    return this.one<SportsNetVenueRealizationRecord>(
      this.client
        .from(TABLES.sportsNetVenueRealizations)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsNetVenueRealization',
    );
  }

  async insertSportsResaleRoyaltyApplication(
    row: Omit<SportsResaleRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsResaleRoyaltyApplicationRecord> {
    return this.oneStrict<SportsResaleRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.sportsResaleRoyaltyApplications)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsResaleRoyaltyApplication',
    );
  }

  async getSportsResaleRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SportsResaleRoyaltyApplicationRecord | undefined> {
    return this.one<SportsResaleRoyaltyApplicationRecord>(
      this.client
        .from(TABLES.sportsResaleRoyaltyApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsResaleRoyaltyApplication',
    );
  }

  async sumSportsLeaguePoolContractGross(
    leagueRightsCode: string,
    period: string,
    currency: string,
  ): Promise<number> {
    const rows = await this.many<{ contract_gross_cents: number }>(
      this.client
        .from(TABLES.sportsBroadcastingContracts)
        .select('contract_gross_cents')
        .eq('league_rights_code', leagueRightsCode)
        .eq('period', period)
        .eq('currency', currency),
      'sumSportsLeaguePoolContractGross',
    );
    return rows.reduce((sum, row) => sum + row.contract_gross_cents, 0);
  }

  async upsertSportsLeaguePoolDistribution(
    row: Omit<SportsLeaguePoolDistributionRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeaguePoolDistributionRecord> {
    return this.oneStrict<SportsLeaguePoolDistributionRecord>(
      this.client
        .from(TABLES.sportsLeaguePoolDistributions)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'league_rights_code,period,currency' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsLeaguePoolDistribution',
    );
  }

  async getSportsLeaguePoolDistribution(
    sourceEventId: string,
  ): Promise<SportsLeaguePoolDistributionRecord | undefined> {
    return this.one<SportsLeaguePoolDistributionRecord>(
      this.client
        .from(TABLES.sportsLeaguePoolDistributions)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsLeaguePoolDistribution',
    );
  }

  async insertSportsGroupLicensingApplication(
    row: Omit<SportsGroupLicensingApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsGroupLicensingApplicationRecord> {
    return this.oneStrict<SportsGroupLicensingApplicationRecord>(
      this.client
        .from(TABLES.sportsGroupLicensingApplications)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsGroupLicensingApplication',
    );
  }

  async getSportsGroupLicensingApplication(
    sourceEventId: string,
  ): Promise<SportsGroupLicensingApplicationRecord | undefined> {
    return this.one<SportsGroupLicensingApplicationRecord>(
      this.client
        .from(TABLES.sportsGroupLicensingApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsGroupLicensingApplication',
    );
  }

  async listNilPayoutApplicationsForAthlete(
    athleteId: string,
    period: string,
  ): Promise<NilPayoutApplicationRecord[]> {
    return this.many<NilPayoutApplicationRecord>(
      this.client
        .from('nil_payout_applications')
        .select()
        .eq('athlete_id', athleteId)
        .eq('period', period)
        .order('source_event_id'),
      'listNilPayoutApplicationsForAthlete',
    );
  }

  async upsertSportsNilDealReconciliation(
    row: Omit<SportsNilDealReconciliationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsNilDealReconciliationRecord> {
    return this.oneStrict<SportsNilDealReconciliationRecord>(
      this.client
        .from(TABLES.sportsNilDealReconciliations)
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: 'nil_contract_id,athlete_glan,period' },
        )
        .select()
        .maybeSingle(),
      'upsertSportsNilDealReconciliation',
    );
  }

  async getSportsNilDealReconciliation(
    sourceEventId: string,
  ): Promise<SportsNilDealReconciliationRecord | undefined> {
    return this.one<SportsNilDealReconciliationRecord>(
      this.client
        .from(TABLES.sportsNilDealReconciliations)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsNilDealReconciliation',
    );
  }

  async insertSportsBiometricMicroPayoutApplication(
    row: Omit<SportsBiometricMicroPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord> {
    return this.oneStrict<SportsBiometricMicroPayoutApplicationRecord>(
      this.client
        .from(TABLES.sportsBiometricMicroPayoutApplications)
        .insert({ ...row, created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertSportsBiometricMicroPayoutApplication',
    );
  }

  async getSportsBiometricMicroPayoutApplication(
    sourceEventId: string,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord | undefined> {
    return this.one<SportsBiometricMicroPayoutApplicationRecord>(
      this.client
        .from(TABLES.sportsBiometricMicroPayoutApplications)
        .select()
        .eq('source_event_id', sourceEventId)
        .maybeSingle(),
      'getSportsBiometricMicroPayoutApplication',
    );
  }

  // ---------------------------------------------------------------------------
  // PR 51 — the event cancellation escrow, the sports payout gate states, and
  // the staged sports applications' instant-posting journal stamps. The
  // Supabase mirror of the SQLite methods: no id in any conflict payload
  // (the PR 33 lesson).
  // ---------------------------------------------------------------------------

  async upsertEventCancellationEscrowPolicy(
    row: Omit<EventCancellationEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EventCancellationEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the newest
    // rate governs the next routing). HARDENED UPSERT: no id in the
    // payload (the id rotates on conflict).
    return this.oneStrict<EventCancellationEscrowPolicyRecord>(
      this.client
        .from(TABLES.sportsEventCancellationEscrowPolicies)
        .upsert(row, { onConflict: 'scope_key' })
        .select()
        .maybeSingle(),
      'upsertEventCancellationEscrowPolicy',
    );
  }

  async getEventCancellationEscrowPolicy(
    scopeKey: string,
  ): Promise<EventCancellationEscrowPolicyRecord | undefined> {
    return this.one<EventCancellationEscrowPolicyRecord>(
      this.client
        .from(TABLES.sportsEventCancellationEscrowPolicies)
        .select()
        .eq('scope_key', scopeKey)
        .maybeSingle(),
      'getEventCancellationEscrowPolicy',
    );
  }

  async insertEventCancellationEscrowDrawdown(
    row: Omit<EventCancellationEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<EventCancellationEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard
    // and UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here, never
    // a double drawdown; the caller re-derives from the append-only
    // truth.
    return this.oneStrict<EventCancellationEscrowDrawdownRecord>(
      this.client
        .from(TABLES.sportsEventCancellationEscrowDrawdowns)
        .insert({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() })
        .select()
        .maybeSingle(),
      'insertEventCancellationEscrowDrawdown',
    );
  }

  async listEventCancellationEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<EventCancellationEscrowDrawdownRecord[]> {
    // Chronological spend order — the same ordering discipline the
    // resource escrow's drawdown list runs.
    const { data, error } = await this.client
      .from(TABLES.sportsEventCancellationEscrowDrawdowns)
      .select()
      .eq('reserve_ledger_id', reserveLedgerId)
      .order('created_at', { ascending: true })
      .order('drawn_before_cents', { ascending: false });
    if (error) {
      throw new Error(`listEventCancellationEscrowDrawdowns failed: ${error.message}`);
    }
    return (data ?? []) as EventCancellationEscrowDrawdownRecord[];
  }

  async settleEventCancellationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the escrow was still held) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'event_cancellation_escrow')
      .select();
    if (error) {
      throw new Error(`settleEventCancellationEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async settleIdentifierHoldEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The conditional update is the CAS — only the caller whose filter
    // matched (the hold was still locked) reads the settled row; a
    // concurrent settle updates zero rows and returns undefined.
    const { data, error } = await this.client
      .from(TABLES.ledgerTransactions)
      .update({ status: 'settled', settled_at: settledAt })
      .eq('id', id)
      .eq('status', 'unclaimed_identifier_hold')
      .select();
    if (error) {
      throw new Error(`settleIdentifierHoldEscrow failed: ${error.message}`);
    }
    return (data?.[0] as LedgerTransactionRecord | undefined) ?? undefined;
  }

  async upsertSportsPayoutGateState(
    row: Omit<SportsPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsPayoutGateStateRecord> {
    // UNIQUE per (payee_id, event_ref) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table). HARDENED UPSERT: no id in the payload (the id rotates on
    // conflict).
    return this.oneStrict<SportsPayoutGateStateRecord>(
      this.client
        .from(TABLES.sportsPayoutGateStates)
        .upsert(row, { onConflict: 'payee_id,event_ref' })
        .select()
        .maybeSingle(),
      'upsertSportsPayoutGateState',
    );
  }

  async getSportsPayoutGateState(
    payeeId: string,
    eventRef: string,
  ): Promise<SportsPayoutGateStateRecord | undefined> {
    return this.one<SportsPayoutGateStateRecord>(
      this.client
        .from(TABLES.sportsPayoutGateStates)
        .select()
        .eq('payee_id', payeeId)
        .eq('event_ref', eventRef)
        .maybeSingle(),
      'getSportsPayoutGateState',
    );
  }

  async setSportsResaleRoyaltyJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<SportsResaleRoyaltyApplicationRecord | undefined> {
    // The conditional update is the CAS: the journal stamps only while
    // the staged application's journal_id is still null (PR 50 stages
    // the application, PR 51's instant posting completes it); a lost
    // race (or a replay) updates zero rows and returns undefined. The
    // null check rides `.is()` — PostgREST's null filter.
    const { data, error } = await this.client
      .from(TABLES.sportsResaleRoyaltyApplications)
      .update({ journal_id: journalId })
      .eq('source_event_id', sourceEventId)
      .is('journal_id', null)
      .select();
    if (error) {
      throw new Error(`setSportsResaleRoyaltyJournal failed: ${error.message}`);
    }
    return (data?.[0] as SportsResaleRoyaltyApplicationRecord | undefined) ?? undefined;
  }

  async setSportsBiometricMicroPayoutJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord | undefined> {
    // The conditional update is the CAS: the journal stamps only while
    // the staged application's journal_id is still null (PR 50 stages
    // the application, PR 51's instant posting completes it); a lost
    // race (or a replay) updates zero rows and returns undefined. The
    // null check rides `.is()` — PostgREST's null filter.
    const { data, error } = await this.client
      .from(TABLES.sportsBiometricMicroPayoutApplications)
      .update({ journal_id: journalId })
      .eq('source_event_id', sourceEventId)
      .is('journal_id', null)
      .select();
    if (error) {
      throw new Error(`setSportsBiometricMicroPayoutJournal failed: ${error.message}`);
    }
    return (data?.[0] as SportsBiometricMicroPayoutApplicationRecord | undefined) ?? undefined;
  }
}
