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
  WithholdingTaxCreditVerificationRecord,
  IsbnRightsVerificationRecord,
  BookReturnsReservePolicyRecord,
  BookReserveDrawdownRecord,
  BookReturnChargebackRecord,
  BookChargebackOffsetApplicationRecord,
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
  NilAuditEscrowDrawdownRecord,
  NilAuditEscrowPolicyRecord,
  NilAuditEscrowReconciliationRecord,
  NilAdvanceScheduleRecord,
  NilCapVerificationRecord,
  NilDealComplianceAuditRecord,
  NilGroupSplitRecord,
  NilPayoutApplicationRecord,
  NilPayoutGateStateRecord,
  NilPoolApplicationRecord,
  NilRevenueShareProgramRecord,
  NilRosterWaterfallRecord,
  NilSchoolCapRecord,
  NilStateRuleRecord,
  NilTransferPortalEntryRecord,
  NilUnearnedClawbackRecord,
} from '@/modules/nil/records';
import { bookReturnsReservePayeeId } from '@/modules/don/constants';
import type {
  MatchQueueRecord,
  MatchQueueResolution,
  MulClearanceRecord,
  MulClearanceTransitionRecord,
  StatementIngestRecord,
  SyncCatalogItemRecord,
  SyncLicensePurchaseRecord,
} from '@/modules/sdk/records';
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
  SportsPayoutGateStateRecord,
  SportsResaleRoyaltyApplicationRecord,
  SportsResaleRoyaltyPolicyRecord,
  SportsResaleSalePostRecord,
  SportsStudentAthleteProfileRecord,
  SportsTicketSalePostRecord,
  SportsTurnstileScanPostRecord,
} from '@/modules/sports/records';
import type {
  CulinaryAuditEscrowDrawdownRecord,
  CulinaryAuditEscrowPolicyRecord,
  CulinaryAuditEscrowReconciliationRecord,
  CulinaryPayoutGateStateRecord,
  CulinaryPopupExperienceRecord,
  CulinaryPopupWriteoffRecord,
} from '@/modules/culinary/records';
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
  EventCancellationEscrowDrawdownRecord,
  EventCancellationEscrowPolicyRecord,
} from '@/modules/sports/records';
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
  // --- AI model registry (0028, PR 24): the nested-split contract terms
  // (UNIQUE per model) and the contributors' registered dataset token
  // weights (UNIQUE per model+payee) — the recon posting pass's terms of
  // record and the unattributed pool's fallback inputs.
  private aiModelSplitTerms = new Map<string, AiModelSplitTermsRecord>();
  private aiModelContributions = new Map<string, AiModelContributionRecord>();
  // --- AI training dispute freeze + payout gate states + dataset
  // --- deprecations (migration 0029, PR 25)
  private aiTrainingDisputes: AiTrainingDisputeRecord[] = [];
  private aiPayoutGateStates = new Map<string, AiPayoutGateStateRecord>();
  private aiDatasetDeprecations = new Map<string, AiDatasetDeprecationRecord>();
  private aiDatasetAllocationArchives: AiDatasetAllocationArchiveRecord[] = [];
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
  // Migration 0030 — the book editorial split ledger state.
  private bookEditorialSplitSchedules: BookEditorialSplitScheduleRecord[] = [];
  private bookRecoupmentPools: BookRecoupmentPoolRecord[] = [];
  private bookRecoupmentApplications: BookRecoupmentApplicationRecord[] = [];
  private bookEditorialSplitAccruals: BookEditorialSplitAccrualRecord[] = [];
  // Migration 0032 — the art market waterfall state.
  private artSplitSchedules: ArtSplitScheduleRecord[] = [];
  private artRecoupmentPools: ArtRecoupmentPoolRecord[] = [];
  private artRecoupmentApplications: ArtRecoupmentApplicationRecord[] = [];
  private artSplitAccruals: ArtSplitAccrualRecord[] = [];
  private artLicensingAgencyPolicies: ArtLicensingAgencyPolicyRecord[] = [];
  private estateSuccessionCertificates: EstateSuccessionCertificateRecord[] = [];
  private estateHeirSchedules: EstateHeirScheduleRecord[] = [];
  private estateSuccessionTransitions: EstateSuccessionTransitionRecord[] = [];
  private estateSplitAccruals: EstateSplitAccrualRecord[] = [];
  private estatePayoutGateStates = new Map<string, EstatePayoutGateStateRecord>();
  private theatricalProductionDeals: TheatricalProductionDealRecord[] = [];
  private theatricalStopSettlements: TheatricalStopSettlementRecord[] = [];
  private theatricalRecoupmentApplications: TheatricalRecoupmentApplicationRecord[] = [];
  private theatricalSplitAccruals: TheatricalSplitAccrualRecord[] = [];
  // Migration 0035 — the promoter settlement audit closes of record per
  // (production, venue, show date), the theater payout gate states per
  // (payee, production), and the venue hall fee policies per (tour, venue).
  private promoterSettlementAudits = new Map<string, PromoterSettlementAuditRecord>();
  private theatricalPayoutGateStates = new Map<string, TheatricalPayoutGateStateRecord>();
  private venueHallFeePolicies = new Map<string, VenueHallFeePolicyRecord>();
  // Migration 0036 — the licensing lane's facts of record: the deal of record
  // per license scope, the append-only royalty applications (walk commits),
  // the treaty rates per (source, residence), the registered sub-licensees
  // per (scope, sub-licensee), and the sub-license gross reports of record.
  private licensingRoyaltyDeals = new Map<string, LicensingRoyaltyDealRecord>();
  private licensingRoyaltyApplications: LicensingRoyaltyApplicationRecord[] = [];
  private licensingTreatyRates = new Map<string, LicensingTreatyRateRecord>();
  private licensingSubLicensees = new Map<string, LicensingSubLicenseeRecord>();
  private licensingSubLicenseReports = new Map<string, LicensingSubLicenseReportRecord>();
  private licensingMgCommitments = new Map<string, LicensingMgCommitmentRecord>();
  private licensingMgRecoupmentApplications: LicensingMgRecoupmentApplicationRecord[] = [];
  private licensingMgTermCloses = new Map<string, LicensingMgTermCloseRecord>();
  private licensingAuditReservePolicies = new Map<string, LicensingAuditReservePolicyRecord>();
  private licensingAuditReserveReconciliations = new Map<
    string,
    LicensingAuditReserveReconciliationRecord
  >();
  // Migration 0038 — the NIL lane's facts of record: the revenue-share
  // program per scope, the roster waterfall per (scope, key), the school
  // caps and cap verifications per (school, year), the valid business
  // purpose audits per contract, the append-only payout/pool/group-split
  // applications (replay-guarded per source event), the state rules per
  // (state, rule), and the payout gate states per (payee, school).
  private nilRevenueSharePrograms = new Map<string, NilRevenueShareProgramRecord>();
  private nilRosterWaterfalls = new Map<string, NilRosterWaterfallRecord>();
  private nilSchoolCaps = new Map<string, NilSchoolCapRecord>();
  private nilCapVerifications = new Map<string, NilCapVerificationRecord>();
  private nilDealComplianceAudits = new Map<string, NilDealComplianceAuditRecord>();
  private nilPayoutApplications = new Map<string, NilPayoutApplicationRecord>();
  private nilPoolApplications = new Map<string, NilPoolApplicationRecord>();
  private nilGroupSplits = new Map<string, NilGroupSplitRecord>();
  private nilStateRules = new Map<string, NilStateRuleRecord>();
  private nilPayoutGateStates = new Map<string, NilPayoutGateStateRecord>();
  // Migration 0039 — the NIL audit escrow and transfer portal clawback:
  // the founder-banded escrow rate per scope, the position-locked escrow
  // drawdowns (the append-only spend truth), the verified reconciliations
  // of record per escrow, the NIL advance of record per contract, the
  // portal entries of record per (contract, athlete), and the pro-rated
  // clawbacks of record per portal entry.
  private nilAuditEscrowPolicies = new Map<string, NilAuditEscrowPolicyRecord>();
  private nilAuditEscrowDrawdowns: NilAuditEscrowDrawdownRecord[] = [];
  private nilAuditEscrowReconciliations = new Map<
    string,
    NilAuditEscrowReconciliationRecord
  >();
  private nilAdvanceSchedules = new Map<string, NilAdvanceScheduleRecord>();
  private nilTransferPortalEntries = new Map<string, NilTransferPortalEntryRecord>();
  private nilUnearnedClawbacks = new Map<string, NilUnearnedClawbackRecord>();
  private licensingAuditReserveDrawdowns: LicensingAuditReserveDrawdownRecord[] = [];
  private licensingPayoutGateStates = new Map<string, LicensingPayoutGateStateRecord>();
  // Migration 0040 — the spatial lane (PR 36, the founder spatial
  // directive): the schedules/policies/assignments the walks read (keyed
  // per venue-year or venue-zone) and the three append-only application
  // ledgers (replay-guarded per source event).
  private spatialOccupancyTierSchedules = new Map<string, SpatialOccupancyTierScheduleRecord>();
  private spatialOverheadPolicies = new Map<string, SpatialOverheadPolicyRecord>();
  private spatialZoneAssignments = new Map<string, SpatialZoneAssignmentRecord>();
  private spatialMicroPolicies = new Map<string, SpatialMicroPolicyRecord>();
  private spatialThroughputYears = new Map<string, SpatialThroughputYearRecord>();
  private spatialRoyaltyApplications = new Map<string, SpatialRoyaltyApplicationRecord>();
  private spatialZoneAllocations = new Map<string, SpatialZoneAllocationRecord>();
  private spatialMicroRoyalties = new Map<string, SpatialMicroRoyaltyRecord>();
  private spatialCapexCommitments = new Map<string, SpatialCapexCommitmentRecord>();
  private spatialCapexApplications: SpatialCapexApplicationRecord[] = [];
  private spatialMsgCommitments = new Map<string, SpatialMsgCommitmentRecord>();
  private spatialMsgTermCloses = new Map<string, SpatialMsgTermCloseRecord>();
  private spatialPopupExperiences = new Map<string, SpatialPopupExperienceRecord>();
  private spatialPopupWriteoffs: SpatialPopupWriteoffRecord[] = [];
  private spatialPopupRestorationReserves = new Map<string, SpatialPopupRestorationReserveRecord>();
  private spatialAuditEscrowPolicies = new Map<string, SpatialAuditEscrowPolicyRecord>();
  private spatialAuditEscrowDrawdowns: SpatialAuditEscrowDrawdownRecord[] = [];
  private spatialAuditEscrowReconciliations = new Map<
    string,
    SpatialAuditEscrowReconciliationRecord
  >();
  private spatialPayoutGateStates = new Map<string, SpatialPayoutGateStateRecord>();
  // Migration 0042 — the fitness lane's durable facts of record.
  private fitnessTrainerTierSchedules = new Map<
    string,
    FitnessTrainerTierScheduleRecord
  >();
  private fitnessCompletionMonths = new Map<string, FitnessCompletionMonthRecord>();
  private fitnessSyncMusicPolicies = new Map<string, FitnessSyncMusicPolicyRecord>();
  private fitnessLiveLoadPolicies = new Map<string, FitnessLiveLoadPolicyRecord>();
  private fitnessFranchisePolicies = new Map<string, FitnessFranchisePolicyRecord>();
  private fitnessFranchiseClassMonths = new Map<
    string,
    FitnessFranchiseClassMonthRecord
  >();
  private fitnessCoBrandPartnerships = new Map<
    string,
    FitnessCoBrandPartnershipRecord
  >();
  private fitnessAlgorithmPolicies = new Map<string, FitnessAlgorithmPolicyRecord>();
  private fitnessCocreationModules: FitnessCocreationModuleRecord[] = [];
  private fitnessRealizationApplications: FitnessRealizationApplicationRecord[] = [];
  private fitnessTrainerRoyaltyApplications: FitnessTrainerRoyaltyApplicationRecord[] = [];
  private fitnessLiveResidualApplications: FitnessLiveResidualApplicationRecord[] = [];
  private fitnessFranchiseApplications: FitnessFranchiseApplicationRecord[] = [];
  private fitnessCobrandSplitApplications: FitnessCobrandSplitApplicationRecord[] = [];
  private fitnessAlgorithmRoyaltyLedger: FitnessAlgorithmRoyaltyRecord[] = [];
  private fitnessCocreationApplications: FitnessCocreationApplicationRecord[] = [];
  // Migration 0043 — the fitness audit escrow + payout gate states + the
  // instant live-event bonus ledger.
  private fitnessAuditEscrowPolicies = new Map<string, FitnessAuditEscrowPolicyRecord>();
  private fitnessAuditEscrowDrawdowns: FitnessAuditEscrowDrawdownRecord[] = [];
  private fitnessAuditEscrowReconciliations = new Map<
    string,
    FitnessAuditEscrowReconciliationRecord
  >();
  private fitnessPayoutGateStates = new Map<string, FitnessPayoutGateStateRecord>();
  private fitnessLiveEventBonusPolicies = new Map<string, FitnessLiveEventBonusPolicyRecord>();
  private fitnessLiveEventBonuses: FitnessLiveEventBonusRecord[] = [];
  // Migration 0044 — the food lane (the founder food directive).
  private foodRecipeRoyaltySchedules = new Map<
    string,
    FoodRecipeRoyaltyScheduleRecord
  >();
  private foodLocationUnitMonths = new Map<string, FoodLocationUnitMonthRecord>();
  private foodHostOperatorPolicies = new Map<string, FoodHostOperatorPolicyRecord>();
  private foodCookCyclePolicies = new Map<string, FoodCookCyclePolicyRecord>();
  private foodCobrandWeightings: FoodCobrandWeightingRecord[] = [];
  private foodOperatorWaterfalls: FoodOperatorWaterfallRecord[] = [];
  private foodRealizationApplications: FoodRealizationApplicationRecord[] = [];
  private foodRecipeRoyaltyApplications: FoodRecipeRoyaltyApplicationRecord[] = [];
  private foodCobrandSplitApplications: FoodCobrandSplitApplicationRecord[] = [];
  private foodHostOperatorSplitApplications: FoodHostOperatorSplitApplicationRecord[] = [];
  private foodCookCycleRoyalties: FoodCookCycleRoyaltyRecord[] = [];
  private foodSupplierRebateApplications: FoodSupplierRebateApplicationRecord[] = [];
  // Migration 0046 — the service lane's policies of record, waterfalls,
  // and seven application ledgers.
  private serviceFranchiseSchedules = new Map<
    string,
    ServiceFranchiseScheduleRecord
  >();
  private serviceProtocolPolicies = new Map<
    string,
    ServiceProtocolPolicyRecord
  >();
  private serviceRedemptionPolicies = new Map<
    string,
    ServiceRedemptionPolicyRecord
  >();
  private serviceBreakagePolicies = new Map<
    string,
    ServiceBreakagePolicyRecord
  >();
  private serviceRebateWaterfalls: ServiceRebateWaterfallRecord[] = [];
  private serviceBoothLeasePolicies = new Map<
    string,
    ServiceBoothLeasePolicyRecord
  >();
  private serviceRealizationApplications: ServiceRealizationApplicationRecord[] = [];
  private serviceFranchiseSplits: ServiceFranchiseSplitApplicationRecord[] = [];
  private serviceProtocolRoyalties: ServiceProtocolMicroRoyaltyRecord[] = [];
  private serviceRedemptionSplits: ServiceRedemptionSplitApplicationRecord[] = [];
  private serviceBreakageAllocations: ServiceBreakageAllocationRecord[] = [];
  private serviceRebateApplications: ServiceRebateApplicationRecord[] = [];
  private serviceBoothLeaseSplits: ServiceBoothLeaseApplicationRecord[] = [];
  // Migration 0045 — the culinary audit escrow, the payout gate states,
  // and the viral-menu pop-up decommissioning facts.
  private culinaryAuditEscrowPolicies = new Map<string, CulinaryAuditEscrowPolicyRecord>();
  private culinaryAuditEscrowDrawdowns: CulinaryAuditEscrowDrawdownRecord[] = [];
  private culinaryAuditEscrowReconciliations = new Map<
    string,
    CulinaryAuditEscrowReconciliationRecord
  >();
  private culinaryPayoutGateStates = new Map<string, CulinaryPayoutGateStateRecord>();
  private culinaryPopupExperiences = new Map<string, CulinaryPopupExperienceRecord>();
  private culinaryPopupWriteoffs: CulinaryPopupWriteoffRecord[] = [];
  private serviceAuditEscrowPolicies = new Map<string, ServiceAuditEscrowPolicyRecord>();
  private serviceAuditEscrowDrawdowns: ServiceAuditEscrowDrawdownRecord[] = [];
  private serviceAuditEscrowReconciliations = new Map<
    string,
    ServiceAuditEscrowReconciliationRecord
  >();
  private servicesPayoutGateStates = new Map<string, ServicesPayoutGateStateRecord>();
  // SOFTWARE_AUDIT_ESCROW (PR 45, migration 0049) — the software lane's
  // policy rows, position-locked drawdowns, reconciliations of record,
  // and payout gate states.
  private softwareAuditEscrowPolicies = new Map<string, SoftwareAuditEscrowPolicyRecord>();
  private softwareAuditEscrowDrawdowns: SoftwareAuditEscrowDrawdownRecord[] = [];
  private softwareAuditEscrowReconciliations = new Map<
    string,
    SoftwareAuditEscrowReconciliationRecord
  >();
  private softwarePayoutGateStates = new Map<string, SoftwarePayoutGateStateRecord>();
  // Migration 0048 — the developer lane's registries of record, the two
  // cumulative monthly trackers, and the seven application ledgers.
  private developerApiRoyaltyPolicies = new Map<
    string,
    DeveloperApiRoyaltyPolicyRecord
  >();
  private developerMarketplacePolicies = new Map<
    string,
    DeveloperMarketplaceSplitPolicyRecord
  >();
  private developerCopackageLegs: DeveloperCopackageContributionLegRecord[] = [];
  private developerDependencyLedgers = new Map<
    string,
    DeveloperDependencyMaintainerLedgerRecord
  >();
  private developerWhitelabelDeals = new Map<
    string,
    DeveloperWhitelabelLicenseDealRecord
  >();
  private developerToolPolicies = new Map<
    string,
    DeveloperToolRoyaltyPolicyRecord
  >();
  private developerApiCallMonths = new Map<
    string,
    DeveloperApiCallMonthRecord
  >();
  private developerWhitelabelUsageMonths = new Map<
    string,
    DeveloperWhitelabelUsageMonthRecord
  >();
  private developerRealizationApplications: DeveloperApiRealizationApplicationRecord[] = [];
  private developerApiMicroRoyalties: DeveloperApiMicroRoyaltyApplicationRecord[] = [];
  private developerMarketplaceSplits: DeveloperMarketplaceSplitApplicationRecord[] = [];
  private developerCopackageSplits: DeveloperCopackageSplitApplicationRecord[] = [];
  private developerDependencyFees: DeveloperDependencyFeeApplicationRecord[] = [];
  private developerWhitelabelLicenses: DeveloperWhitelabelLicenseApplicationRecord[] = [];
  private developerToolCallApplications: DeveloperAgentToolCallApplicationRecord[] = [];

  // The hardware patent lane (PR 46, migration 0050) — the founder
  // hardware directive's registries, tracker, and application ledgers.
  private hardwarePatentPools: HardwarePatentPoolRecord[] = [];
  private hardwarePoolHolderLegs: HardwarePoolHolderLegRecord[] = [];
  private hardwareSepRoyaltyPolicies: HardwareSepRoyaltyPolicyRecord[] = [];
  private hardwareAutomotivePoolAssignments: HardwareAutomotivePoolAssignmentRecord[] = [];
  private hardwareCleanTechRoyaltyPolicies: HardwareCleanTechRoyaltyPolicyRecord[] = [];
  private hardwareOtaUnlockPolicies: HardwareOtaUnlockPolicyRecord[] = [];
  private hardwareCrossLicenseAgreements: HardwareCrossLicenseAgreementRecord[] = [];
  private hardwareSepUnitMonths: HardwareSepUnitMonthRecord[] = [];
  private hardwareRealizationApplications: HardwareRealizationApplicationRecord[] = [];
  private hardwareSepRoyaltyApplications: HardwareSepRoyaltyApplicationRecord[] = [];
  private hardwarePoolRoutingApplications: HardwarePoolRoutingApplicationRecord[] = [];
  private hardwarePoolWaterfallApplications: HardwarePoolWaterfallApplicationRecord[] = [];
  private hardwareTelemetryRoyaltyApplications: HardwareTelemetryRoyaltyApplicationRecord[] = [];
  private hardwareOtaUnlockApplications: HardwareOtaUnlockApplicationRecord[] = [];
  private hardwareCrossLicenseNetSettlements: HardwareCrossLicenseNetSettlementRecord[] = [];
  // PR 47 — the patent litigation escrow, the hardware payout gate
  // states, and the cross-license net dispatches (migration 0051): the
  // software twins' in-memory shapes over the hardware lane's own
  // identity space.
  private patentLitigationEscrowPolicies = new Map<string, PatentLitigationEscrowPolicyRecord>();
  private patentLitigationEscrowDrawdowns: PatentLitigationEscrowDrawdownRecord[] = [];
  private patentLitigationEscrowReconciliations = new Map<
    string,
    PatentLitigationEscrowReconciliationRecord
  >();
  private hardwarePayoutGateStates = new Map<string, HardwarePayoutGateStateRecord>();
  private hardwareCrossLicenseNetDispatches: HardwareCrossLicenseNetDispatchRecord[] = [];
  // The energy lane (PR 48, migration 0052) — the founder resource
  // directive's registries, posts, and application ledgers.
  private energyLandParcels: EnergyLandParcelRecord[] = [];
  private energyParcelOwnerInterests: EnergyParcelOwnerInterestRecord[] = [];
  private energyParcelRoyaltyPolicies: EnergyParcelRoyaltyPolicyRecord[] = [];
  private energyParcelRoyaltyPositions: EnergyParcelRoyaltyPositionRecord[] = [];
  private energyComputeYieldPolicies: EnergyComputeYieldPolicyRecord[] = [];
  private energyComputeYieldPositions: EnergyComputeYieldPositionRecord[] = [];
  private energyGridParticipants: EnergyGridParticipantRegistrationRecord[] = [];
  private energyDivisionOrders: EnergyDivisionOrderRecord[] = [];
  private energyDeedTransfers: EnergyDeedTransferRecord[] = [];
  private energyCarbonOffsetPolicies: EnergyCarbonOffsetPolicyRecord[] = [];
  private energyMeterSalesPosts: EnergyMeterSalesPostRecord[] = [];
  private energyPipelineDeductionPosts: EnergyPipelineDeductionPostRecord[] = [];
  private energyGpuUtilizationPosts: EnergyGpuUtilizationPostRecord[] = [];
  private energyNetRealizationApplications: EnergyNetRealizationApplicationRecord[] = [];
  private energyParcelDivisionApplications: EnergyParcelDivisionApplicationRecord[] = [];
  private energyComputeGridSplitApplications: EnergyComputeGridSplitApplicationRecord[] = [];
  private energyStatutoryInterestApplications: EnergyStatutoryInterestApplicationRecord[] = [];
  private energyCarbonOffsetPayoutApplications: EnergyCarbonOffsetPayoutApplicationRecord[] = [];
  // PR 49 — the resource audit escrow, the resource payout gate states, and
  // the staged grid-split completions (the instant cascade's journal stamp).
  private resourceAuditEscrowPolicies = new Map<string, ResourceAuditEscrowPolicyRecord>();
  private resourceAuditEscrowDrawdowns: ResourceAuditEscrowDrawdownRecord[] = [];
  private resourceAuditEscrowReconciliations = new Map<
    string,
    ResourceAuditEscrowReconciliationRecord
  >();
  private resourcePayoutGateStates = new Map<string, ResourcePayoutGateStateRecord>();
  // PR 51 — the event cancellation escrow's policies of record, the
  // append-only drawdown truth, and the sports payout gate states (the
  // fail-closed release/resolver inputs).
  private eventCancellationEscrowPolicies = new Map<
    string,
    EventCancellationEscrowPolicyRecord
  >();
  private eventCancellationEscrowDrawdowns: EventCancellationEscrowDrawdownRecord[] = [];
  private sportsPayoutGateStates = new Map<string, SportsPayoutGateStateRecord>();
  // PR 50 — the sports lane's state: the registries of record (athlete
  // profiles and the policies/team owners), the replay-guard posts, and
  // the recompute-in-place positions (reconciliations, realizations,
  // distributions).
  private sportsStudentAthleteProfiles = new Map<string, SportsStudentAthleteProfileRecord>();
  private sportsResaleRoyaltyPolicies = new Map<string, SportsResaleRoyaltyPolicyRecord>();
  private sportsLeaguePoolPolicies = new Map<string, SportsLeaguePoolPolicyRecord>();
  private sportsLeagueTeams = new Map<string, SportsLeagueTeamRegistrationRecord>();
  private sportsBiometricRoyaltyPolicies = new Map<string, SportsBiometricRoyaltyPolicyRecord>();
  private sportsTicketSalePosts: SportsTicketSalePostRecord[] = [];
  private sportsResaleSalePosts: SportsResaleSalePostRecord[] = [];
  private sportsTurnstileScanPosts: SportsTurnstileScanPostRecord[] = [];
  private sportsBroadcastingContracts: SportsBroadcastingContractRecord[] = [];
  private sportsBiometricTrackingPosts: SportsBiometricTrackingPostRecord[] = [];
  private sportsGateReconciliations: SportsGateReconciliationRecord[] = [];
  private sportsNetVenueRealizations: SportsNetVenueRealizationRecord[] = [];
  private sportsResaleRoyaltyApplications: SportsResaleRoyaltyApplicationRecord[] = [];
  private sportsLeaguePoolDistributions: SportsLeaguePoolDistributionRecord[] = [];
  private sportsGroupLicensingApplications: SportsGroupLicensingApplicationRecord[] = [];
  private sportsNilDealReconciliations: SportsNilDealReconciliationRecord[] = [];
  private sportsBiometricMicroPayoutApplications: SportsBiometricMicroPayoutApplicationRecord[] = [];
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
  private merchReturnReservePolicies: MerchReturnReservePolicyRecord[] = [];
  private merchFulfillmentTrackings: MerchFulfillmentTrackingRecord[] = [];
  private merchReserveDrawdowns: MerchReserveDrawdownRecord[] = [];
  // Foreign tax hold + book returns reserve state (0031, PR 27).
  private withholdingTaxCreditVerifications: WithholdingTaxCreditVerificationRecord[] = [];
  private isbnRightsVerifications: IsbnRightsVerificationRecord[] = [];
  private bookReturnsReservePolicies: BookReturnsReservePolicyRecord[] = [];
  private bookReserveDrawdowns: BookReserveDrawdownRecord[] = [];
  private bookReturnChargebacks: BookReturnChargebackRecord[] = [];
  private bookChargebackOffsetApplications: BookChargebackOffsetApplicationRecord[] = [];
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

  async upsertAiModelSplitTerms(
    terms: Omit<AiModelSplitTermsRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiModelSplitTermsRecord> {
    // UNIQUE per ai_model_id — an upsert converges on the newest contract
    // (the re-registered terms govern the next ingest, never a duplicate).
    const now = new Date().toISOString();
    const existing = this.aiModelSplitTerms.get(terms.ai_model_id);
    const record: AiModelSplitTermsRecord = {
      ...terms,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.aiModelSplitTerms.set(terms.ai_model_id, record);
    return record;
  }

  async getAiModelSplitTerms(
    aiModelId: string,
  ): Promise<AiModelSplitTermsRecord | undefined> {
    return this.aiModelSplitTerms.get(aiModelId);
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
    const key = `${contribution.ai_model_id}\u0000${contribution.contributor_payee_id}`;
    const existing = this.aiModelContributions.get(key);
    const record: AiModelContributionRecord = {
      ...contribution,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.aiModelContributions.set(key, record);
    return record;
  }

  async listAiModelContributions(
    aiModelId: string,
  ): Promise<AiModelContributionRecord[]> {
    // Write order (insertion order for ties) — the registry's own audit order.
    return [...this.aiModelContributions.values()].filter(
      (row) => row.ai_model_id === aiModelId,
    );
  }

  // --- AI training dispute freeze + payout gate states + dataset
  // --- deprecations (migration 0029, PR 25)

  async insertAiTrainingDispute(
    row: Omit<AiTrainingDisputeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiTrainingDisputeRecord> {
    // UNIQUE per (ai_model_id, dataset_version, rights_holder_payee_id) —
    // a re-filed dispute throws the unique violation; the caller recovers
    // by reading the existing row (the filing is never a second fact).
    const duplicate = this.aiTrainingDisputes.find(
      (existing) =>
        existing.ai_model_id === row.ai_model_id &&
        existing.dataset_version === row.dataset_version &&
        existing.rights_holder_payee_id === row.rights_holder_payee_id,
    );
    if (duplicate !== undefined) {
      uniqueViolation(
        'ai_training_disputes.ai_model_id,dataset_version,rights_holder_payee_id',
      );
    }
    const now = new Date().toISOString();
    const record: AiTrainingDisputeRecord = { ...row, id: randomUUID(), created_at: now, updated_at: now };
    this.aiTrainingDisputes.push(record);
    return record;
  }

  async getAiTrainingDispute(
    id: string,
  ): Promise<AiTrainingDisputeRecord | undefined> {
    return this.aiTrainingDisputes.find((row) => row.id === id);
  }

  async listAiTrainingDisputes(
    status?: AiTrainingDisputeStatus,
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<AiTrainingDisputeRecord[]> {
    // Newest first (created_at DESC, insertion order as tiebreak).
    const rows = sortByTime(
      this.aiTrainingDisputes,
      (row) => row.created_at,
      'desc',
    );
    return (status === undefined
      ? rows
      : rows.filter((row) => row.status === status)
    ).slice(0, limit);
  }

  async resolveAiTrainingDispute(
    id: string,
    resolution: {
      resolution_notes: string | null;
      resolved_by: string;
      resolved_at: string;
    },
  ): Promise<AiTrainingDisputeRecord | undefined> {
    // The CAS: flips ONE row from 'filed' to 'resolved' in a single
    // conditional step — a concurrent resolution loser reads undefined.
    const row = this.aiTrainingDisputes.find((candidate) => candidate.id === id);
    if (row === undefined || row.status !== 'filed') {
      return undefined;
    }
    row.status = 'resolved';
    row.resolution_notes = resolution.resolution_notes;
    row.resolved_by = resolution.resolved_by;
    row.resolved_at = resolution.resolved_at;
    row.updated_at = resolution.resolved_at;
    return row;
  }

  async freezeUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number> {
    // The FREEZE CAS sweep — flips EVERY held leg of the model's ingest
    // scope; the status predicate is the CAS (already-frozen, released,
    // and settled legs are untouched — a re-file's sweep is a no-op).
    let frozen = 0;
    for (const row of this.ledgerTransactions) {
      if (
        row.kind === 'unclaimed_holding' &&
        row.status === 'unclaimed_holding' &&
        row.split_run_id === modelLedgerScope
      ) {
        row.status = 'unauthorized_training_hold';
        frozen += 1;
      }
    }
    return frozen;
  }

  async thawUnauthorizedTrainingHolds(modelLedgerScope: string): Promise<number> {
    // The THAW CAS sweep — the verified resolution's ledger leg: ONLY
    // 'unauthorized_training_hold' legs of the scope return to holding.
    let thawed = 0;
    for (const row of this.ledgerTransactions) {
      if (
        row.kind === 'unclaimed_holding' &&
        row.status === 'unauthorized_training_hold' &&
        row.split_run_id === modelLedgerScope
      ) {
        row.status = 'unclaimed_holding';
        thawed += 1;
      }
    }
    return thawed;
  }

  async listUnauthorizedTrainingHolds(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    // The frozen-leg work queue: a thawed leg leaves the listing (its
    // status returned to 'unclaimed_holding'). Newest first.
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'unclaimed_holding' &&
          row.status === 'unauthorized_training_hold',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async upsertAiPayoutGateState(
    row: Omit<AiPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiPayoutGateStateRecord> {
    // UNIQUE per payee_id — a re-recording converges (the newest state
    // governs the next dispatch).
    const now = new Date().toISOString();
    const existing = this.aiPayoutGateStates.get(row.payee_id);
    const record: AiPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.aiPayoutGateStates.set(row.payee_id, record);
    return record;
  }

  async getAiPayoutGateState(
    payeeId: string,
  ): Promise<AiPayoutGateStateRecord | undefined> {
    return this.aiPayoutGateStates.get(payeeId);
  }

  async insertAiDatasetDeprecation(
    row: Omit<AiDatasetDeprecationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<AiDatasetDeprecationRecord> {
    // UNIQUE per (ai_model_id, dataset_version) — a re-deprecation throws
    // the unique violation; the caller recovers by reading the row.
    const key = `${row.ai_model_id}\u0000${row.dataset_version}`;
    if (this.aiDatasetDeprecations.has(key)) {
      uniqueViolation('ai_dataset_deprecations.ai_model_id,dataset_version');
    }
    const now = new Date().toISOString();
    const record: AiDatasetDeprecationRecord = { ...row, id: randomUUID(), created_at: now, updated_at: now };
    this.aiDatasetDeprecations.set(key, record);
    return record;
  }

  async getAiDatasetDeprecation(
    aiModelId: string,
    datasetVersion: string,
  ): Promise<AiDatasetDeprecationRecord | undefined> {
    return this.aiDatasetDeprecations.get(`${aiModelId}\u0000${datasetVersion}`);
  }

  async listAiDatasetDeprecationsByModel(
    aiModelId: string,
  ): Promise<AiDatasetDeprecationRecord[]> {
    // Oldest first (created_at ASC, insertion order as tiebreak) — the
    // posting pass's halt set reads the deprecation history in order.
    return sortByTime(
      [...this.aiDatasetDeprecations.values()].filter(
        (row) => row.ai_model_id === aiModelId,
      ),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertAiDatasetAllocationArchive(
    row: Omit<AiDatasetAllocationArchiveRecord, 'id'>,
  ): Promise<AiDatasetAllocationArchiveRecord> {
    // UNIQUE per (deprecation_id, ledger_transaction_id) — a re-run
    // deprecation converges, never double-archives. The referenced ledger
    // row is NOT touched here or anywhere (the append-only trail stays
    // intact); this row is the retirement record.
    if (
      this.aiDatasetAllocationArchives.some(
        (existing) =>
          existing.deprecation_id === row.deprecation_id &&
          existing.ledger_transaction_id === row.ledger_transaction_id,
      )
    ) {
      uniqueViolation(
        'ai_dataset_allocation_archives.deprecation_id,ledger_transaction_id',
      );
    }
    const record: AiDatasetAllocationArchiveRecord = { ...row, id: randomUUID() };
    this.aiDatasetAllocationArchives.push(record);
    return record;
  }

  async listAiDatasetAllocationArchives(
    deprecationId: string,
  ): Promise<AiDatasetAllocationArchiveRecord[]> {
    // Oldest first — the archival order of record.
    return this.aiDatasetAllocationArchives
      .filter((row) => row.deprecation_id === deprecationId)
      .sort((a, b) => Date.parse(a.archived_at) - Date.parse(b.archived_at));
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

  // Migration 0030 — the book editorial split ledger (PR 26).

  async upsertBookEditorialSplitSchedule(
    row: BookEditorialSplitScheduleRecord,
  ): Promise<BookEditorialSplitScheduleRecord> {
    // One schedule of record per title_key — the caller builds the row from
    // the existing record (identity + version preserved); replace atomically.
    const existingIndex = this.bookEditorialSplitSchedules.findIndex(
      (candidate) => candidate.title_key === row.title_key,
    );
    if (existingIndex >= 0) {
      this.bookEditorialSplitSchedules[existingIndex] = { ...row };
      return { ...this.bookEditorialSplitSchedules[existingIndex] };
    }
    this.bookEditorialSplitSchedules.push({ ...row });
    return { ...row };
  }

  async getBookEditorialSplitSchedule(
    titleKey: string,
  ): Promise<BookEditorialSplitScheduleRecord | undefined> {
    return this.bookEditorialSplitSchedules.find((candidate) => candidate.title_key === titleKey);
  }

  async insertBookRecoupmentPool(
    row: Omit<BookRecoupmentPoolRecord, 'id'>,
  ): Promise<BookRecoupmentPoolRecord> {
    // UNIQUE per (isbn, pool_class, sequence_no) — a re-registered sequence
    // slot is the unique violation, never a silent duplicate.
    if (
      this.bookRecoupmentPools.some(
        (existing) =>
          existing.isbn === row.isbn &&
          existing.pool_class === row.pool_class &&
          existing.sequence_no === row.sequence_no,
      )
    ) {
      uniqueViolation('book_recoupment_pools.isbn,pool_class,sequence_no');
    }
    const record: BookRecoupmentPoolRecord = { ...row, id: randomUUID() };
    this.bookRecoupmentPools.push(record);
    return { ...record };
  }

  async listBookRecoupmentPools(
    isbn: string,
    poolClass: BookRecoupmentPoolClass,
  ): Promise<BookRecoupmentPoolRecord[]> {
    // sequence_no ASC — the recoupment order of record.
    return this.bookRecoupmentPools
      .filter((row) => row.isbn === isbn && row.pool_class === poolClass)
      .sort((a, b) => a.sequence_no - b.sequence_no)
      .map((row) => ({ ...row }));
  }

  async updateBookRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: BookRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<BookRecoupmentPoolRecord | undefined> {
    const row = this.bookRecoupmentPools.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — an already-recouped pool refuses
    // the update (undefined), the webtoon pool's settle discipline.
    if (row === undefined || row.status !== 'active') {
      return undefined;
    }
    row.recouped_cents = recoupedCents;
    row.status = status;
    row.updated_at = updatedAt;
    return { ...row };
  }

  async insertBookRecoupmentApplication(
    row: Omit<BookRecoupmentApplicationRecord, 'id'>,
  ): Promise<BookRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id) — the replay guard; UNIQUE per
    // (pool_id, recouped_before_cents) — the position lock (the webtoon
    // insert-as-lock arbiter).
    if (
      this.bookRecoupmentApplications.some(
        (existing) =>
          existing.pool_id === row.pool_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('book_recoupment_applications.pool_id,source_event_id');
    }
    if (
      this.bookRecoupmentApplications.some(
        (existing) =>
          existing.pool_id === row.pool_id &&
          existing.recouped_before_cents === row.recouped_before_cents,
      )
    ) {
      uniqueViolation('book_recoupment_applications.pool_id,recouped_before_cents');
    }
    const record: BookRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.bookRecoupmentApplications.push(record);
    return { ...record };
  }

  async listBookRecoupmentApplications(
    poolId: string,
  ): Promise<BookRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return sortByTime(
      this.bookRecoupmentApplications.filter((row) => row.pool_id === poolId),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertBookEditorialSplitAccrual(
    row: Omit<BookEditorialSplitAccrualRecord, 'id'>,
  ): Promise<BookEditorialSplitAccrualRecord> {
    // UNIQUE per source_event_id — a replayed accrual is the unique
    // violation, never a double designation.
    if (
      this.bookEditorialSplitAccruals.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('book_editorial_split_accruals.source_event_id');
    }
    const record: BookEditorialSplitAccrualRecord = { ...row, id: randomUUID() };
    this.bookEditorialSplitAccruals.push(record);
    return { ...record };
  }

  // --- Art market waterfalls (migration 0032, PR 28) -----------------------

  async upsertArtSplitSchedule(
    row: ArtSplitScheduleRecord,
  ): Promise<ArtSplitScheduleRecord> {
    // One schedule of record per scope_key — the caller builds the row from
    // the existing record (identity + version preserved); replace atomically.
    const existingIndex = this.artSplitSchedules.findIndex(
      (candidate) => candidate.scope_key === row.scope_key,
    );
    if (existingIndex >= 0) {
      this.artSplitSchedules[existingIndex] = { ...row };
      return { ...this.artSplitSchedules[existingIndex] };
    }
    this.artSplitSchedules.push({ ...row });
    return { ...row };
  }

  async getArtSplitSchedule(scopeKey: string): Promise<ArtSplitScheduleRecord | undefined> {
    const found = this.artSplitSchedules.find((candidate) => candidate.scope_key === scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertArtRecoupmentPool(
    row: Omit<ArtRecoupmentPoolRecord, 'id'>,
  ): Promise<ArtRecoupmentPoolRecord> {
    // UNIQUE per (scope_key, pool_class, sequence_no) — a re-registered
    // sequence slot is the unique violation, never a silent duplicate.
    if (
      this.artRecoupmentPools.some(
        (existing) =>
          existing.scope_key === row.scope_key &&
          existing.pool_class === row.pool_class &&
          existing.sequence_no === row.sequence_no,
      )
    ) {
      uniqueViolation('art_recoupment_pools.scope_key,pool_class,sequence_no');
    }
    const record: ArtRecoupmentPoolRecord = { ...row, id: randomUUID() };
    this.artRecoupmentPools.push(record);
    return { ...record };
  }

  async listArtRecoupmentPools(
    scopeKey: string,
    poolClass: ArtRecoupmentPoolClass,
  ): Promise<ArtRecoupmentPoolRecord[]> {
    // sequence_no ASC — the fabrication recoupment order of record.
    return this.artRecoupmentPools
      .filter((row) => row.scope_key === scopeKey && row.pool_class === poolClass)
      .sort((a, b) => a.sequence_no - b.sequence_no)
      .map((row) => ({ ...row }));
  }

  async updateArtRecoupmentPoolProgress(
    id: string,
    recoupedCents: number,
    status: ArtRecoupmentPoolRecord['status'],
    updatedAt: string,
  ): Promise<ArtRecoupmentPoolRecord | undefined> {
    const row = this.artRecoupmentPools.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — an already-recouped pool refuses
    // the update (undefined), the books pool's settle discipline.
    if (row === undefined || row.status !== 'active') {
      return undefined;
    }
    row.recouped_cents = recoupedCents;
    row.status = status;
    row.updated_at = updatedAt;
    return { ...row };
  }

  async insertArtRecoupmentApplication(
    row: Omit<ArtRecoupmentApplicationRecord, 'id'>,
  ): Promise<ArtRecoupmentApplicationRecord> {
    // UNIQUE per (pool_id, source_event_id) — the replay guard; UNIQUE per
    // (pool_id, recouped_before_cents) — the position lock (the books
    // insert-as-lock arbiter).
    if (
      this.artRecoupmentApplications.some(
        (existing) =>
          existing.pool_id === row.pool_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('art_recoupment_applications.pool_id,source_event_id');
    }
    if (
      this.artRecoupmentApplications.some(
        (existing) =>
          existing.pool_id === row.pool_id &&
          existing.recouped_before_cents === row.recouped_before_cents,
      )
    ) {
      uniqueViolation('art_recoupment_applications.pool_id,recouped_before_cents');
    }
    const record: ArtRecoupmentApplicationRecord = { ...row, id: randomUUID() };
    this.artRecoupmentApplications.push(record);
    return { ...record };
  }

  async listArtRecoupmentApplications(
    poolId: string,
  ): Promise<ArtRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return sortByTime(
      this.artRecoupmentApplications.filter((row) => row.pool_id === poolId),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertArtSplitAccrual(
    row: Omit<ArtSplitAccrualRecord, 'id'>,
  ): Promise<ArtSplitAccrualRecord> {
    // UNIQUE per source_event_id — a replayed accrual is the unique
    // violation, never a double designation.
    if (
      this.artSplitAccruals.some((existing) => existing.source_event_id === row.source_event_id)
    ) {
      uniqueViolation('art_split_accruals.source_event_id');
    }
    const record: ArtSplitAccrualRecord = { ...row, id: randomUUID() };
    this.artSplitAccruals.push(record);
    return { ...record };
  }

  async upsertArtLicensingAgencyPolicy(
    row: Omit<ArtLicensingAgencyPolicyRecord, 'id'>,
  ): Promise<ArtLicensingAgencyPolicyRecord> {
    // One policy of record per agency_code — replace on the key, the
    // existing row's identity preserved.
    const existing = this.artLicensingAgencyPolicies.find(
      (candidate) => candidate.agency_code === row.agency_code,
    );
    if (existing !== undefined) {
      const updated: ArtLicensingAgencyPolicyRecord = { ...row, id: existing.id };
      this.artLicensingAgencyPolicies[this.artLicensingAgencyPolicies.indexOf(existing)] = updated;
      return { ...updated };
    }
    const record: ArtLicensingAgencyPolicyRecord = { ...row, id: randomUUID() };
    this.artLicensingAgencyPolicies.push(record);
    return { ...record };
  }

  async getArtLicensingAgencyPolicy(
    agencyCode: ArtLicensingAgencyPolicyRecord['agency_code'],
  ): Promise<ArtLicensingAgencyPolicyRecord | undefined> {
    const found = this.artLicensingAgencyPolicies.find(
      (candidate) => candidate.agency_code === agencyCode,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertEstateSuccessionCertificate(
    row: Omit<EstateSuccessionCertificateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstateSuccessionCertificateRecord> {
    // UNIQUE per (artist_payee_id, certificate_ref) — a re-validation
    // converges on the row (the newest validation state governs).
    const now = new Date().toISOString();
    const existing = this.estateSuccessionCertificates.find(
      (candidate) =>
        candidate.artist_payee_id === row.artist_payee_id &&
        candidate.certificate_ref === row.certificate_ref,
    );
    if (existing !== undefined) {
      const updated: EstateSuccessionCertificateRecord = {
        ...existing,
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
      };
      this.estateSuccessionCertificates[
        this.estateSuccessionCertificates.indexOf(existing)
      ] = updated;
      return { ...updated };
    }
    const record: EstateSuccessionCertificateRecord = {
      ...row,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.estateSuccessionCertificates.push(record);
    return { ...record };
  }

  async getEstateSuccessionCertificate(
    artistPayeeId: string,
    certificateRef: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    const found = this.estateSuccessionCertificates.find(
      (candidate) =>
        candidate.artist_payee_id === artistPayeeId &&
        candidate.certificate_ref === certificateRef,
    );
    return found === undefined ? undefined : { ...found };
  }

  async getEstateSuccessionCertificateById(
    certificateId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    const found = this.estateSuccessionCertificates.find(
      (candidate) => candidate.id === certificateId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async getVerifiedEstateSuccessionCertificate(
    artistPayeeId: string,
  ): Promise<EstateSuccessionCertificateRecord | undefined> {
    const verified = this.estateSuccessionCertificates
      .filter(
        (candidate) =>
          candidate.artist_payee_id === artistPayeeId &&
          candidate.validation_state === 'verified',
      )
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return verified[0] === undefined ? undefined : { ...verified[0] };
  }

  async upsertEstateHeirSchedule(
    row: EstateHeirScheduleRecord,
  ): Promise<EstateHeirScheduleRecord> {
    // UNIQUE per certificate_id — a re-registration replaces the row
    // atomically, identity and created_at preserved (the art schedule
    // upsert discipline; the engine builds the versioned row).
    const existing = this.estateHeirSchedules.find(
      (candidate) => candidate.certificate_id === row.certificate_id,
    );
    if (existing !== undefined) {
      const updated: EstateHeirScheduleRecord = {
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: row.updated_at,
      };
      this.estateHeirSchedules[this.estateHeirSchedules.indexOf(existing)] = updated;
      return { ...updated };
    }
    this.estateHeirSchedules.push({ ...row });
    return { ...row };
  }

  async getEstateHeirSchedule(
    certificateId: string,
  ): Promise<EstateHeirScheduleRecord | undefined> {
    const found = this.estateHeirSchedules.find(
      (candidate) => candidate.certificate_id === certificateId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEstateSuccessionTransition(
    row: Omit<EstateSuccessionTransitionRecord, 'id'>,
  ): Promise<EstateSuccessionTransitionRecord> {
    // UNIQUE per (certificate_id, source_event_id) — a replayed transition
    // is the unique violation, never a double handoff. Append-only: the
    // row, once written, is never updated or deleted.
    if (
      this.estateSuccessionTransitions.some(
        (candidate) =>
          candidate.certificate_id === row.certificate_id &&
          candidate.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('estate_succession_transitions.certificate_id_source_event_id');
    }
    const record: EstateSuccessionTransitionRecord = { ...row, id: randomUUID() };
    this.estateSuccessionTransitions.push(record);
    return { ...record };
  }

  async listEstateSuccessionTransitions(
    certificateId: string,
  ): Promise<EstateSuccessionTransitionRecord[]> {
    return sortByTime(
      this.estateSuccessionTransitions
        .filter((candidate) => candidate.certificate_id === certificateId)
        .map((candidate) => ({ ...candidate })),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertEstateSplitAccrual(
    row: Omit<EstateSplitAccrualRecord, 'id'>,
  ): Promise<EstateSplitAccrualRecord> {
    // UNIQUE per (certificate_id, artwork_id, source_event_id) — a
    // replayed accrual is the unique violation, never a double designation
    // (the provenance triple IS the once-only key).
    if (
      this.estateSplitAccruals.some(
        (candidate) =>
          candidate.certificate_id === row.certificate_id &&
          candidate.artwork_id === row.artwork_id &&
          candidate.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('estate_split_accruals.certificate_id_artwork_id_source_event_id');
    }
    const record: EstateSplitAccrualRecord = { ...row, id: randomUUID() };
    this.estateSplitAccruals.push(record);
    return { ...record };
  }

  async listEstateSplitAccruals(
    certificateId: string,
  ): Promise<EstateSplitAccrualRecord[]> {
    return sortByTime(
      this.estateSplitAccruals
        .filter((candidate) => candidate.certificate_id === certificateId)
        .map((candidate) => ({ ...candidate })),
      (row) => row.created_at,
      'asc',
    );
  }

  async upsertEstatePayoutGateState(
    row: Omit<EstatePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EstatePayoutGateStateRecord> {
    // UNIQUE per payee_id — a re-recording converges (the newest state
    // governs the next dispatch).
    const now = new Date().toISOString();
    const existing = this.estatePayoutGateStates.get(row.payee_id);
    const record: EstatePayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.estatePayoutGateStates.set(row.payee_id, record);
    return { ...record };
  }

  async getEstatePayoutGateState(
    payeeId: string,
  ): Promise<EstatePayoutGateStateRecord | undefined> {
    const found = this.estatePayoutGateStates.get(payeeId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertTheatricalProductionDeal(
    row: TheatricalProductionDealRecord,
  ): Promise<TheatricalProductionDealRecord> {
    // One deal of record per scope_key — replace on the key, the existing
    // row's identity preserved (the caller increments version).
    const existingIndex = this.theatricalProductionDeals.findIndex(
      (candidate) => candidate.scope_key === row.scope_key,
    );
    if (existingIndex >= 0) {
      this.theatricalProductionDeals[existingIndex] = { ...row };
      return { ...this.theatricalProductionDeals[existingIndex] };
    }
    this.theatricalProductionDeals.push({ ...row });
    return { ...row };
  }

  async getTheatricalProductionDeal(
    productionId: string,
  ): Promise<TheatricalProductionDealRecord | undefined> {
    const found = this.theatricalProductionDeals.find(
      (candidate) => candidate.scope_key === `production:${productionId}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertTheatricalStopSettlement(
    row: Omit<TheatricalStopSettlementRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalStopSettlementRecord> {
    // UNIQUE per source_event_id — a replayed settlement row is the unique
    // violation, never a double stop.
    if (
      this.theatricalStopSettlements.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('theatrical_stop_settlements.source_event_id');
    }
    const record: TheatricalStopSettlementRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.theatricalStopSettlements.push(record);
    return { ...record };
  }

  async listTheatricalStopSettlements(
    productionId: string,
  ): Promise<TheatricalStopSettlementRecord[]> {
    // show_date then created_at — the tour book in stop order.
    return sortByTime(
      this.theatricalStopSettlements.filter((row) => row.production_id === productionId),
      (row) => `${row.show_date}T${row.created_at}`,
      'asc',
    );
  }

  async updateTheatricalDealRecoupment(
    id: string,
    recoupedCents: number,
    updatedAt: string,
  ): Promise<TheatricalProductionDealRecord | undefined> {
    const row = this.theatricalProductionDeals.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — the counter only advances and never
    // past the capitalization budget; a regressed value refuses (undefined).
    if (
      row === undefined ||
      recoupedCents <= row.recouped_cents ||
      recoupedCents > (row.capitalization_budget_cents ?? Number.MAX_SAFE_INTEGER)
    ) {
      return undefined;
    }
    row.recouped_cents = recoupedCents;
    row.updated_at = updatedAt;
    return { ...row };
  }

  async insertTheatricalRecoupmentApplication(
    row: Omit<TheatricalRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalRecoupmentApplicationRecord> {
    // UNIQUE per (deal_id, source_event_id) — the replay guard; UNIQUE per
    // (deal_id, recouped_before_cents) — the position lock (the books
    // insert-as-lock arbiter).
    if (
      this.theatricalRecoupmentApplications.some(
        (existing) => existing.deal_id === row.deal_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('theatrical_recoupment_applications.deal_id,source_event_id');
    }
    if (
      this.theatricalRecoupmentApplications.some(
        (existing) =>
          existing.deal_id === row.deal_id &&
          existing.recouped_before_cents === row.recouped_before_cents,
      )
    ) {
      uniqueViolation('theatrical_recoupment_applications.deal_id,recouped_before_cents');
    }
    const record: TheatricalRecoupmentApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.theatricalRecoupmentApplications.push(record);
    return { ...record };
  }

  async listTheatricalRecoupmentApplications(
    dealId: string,
  ): Promise<TheatricalRecoupmentApplicationRecord[]> {
    // created_at ASC — the running recovery in application order.
    return sortByTime(
      this.theatricalRecoupmentApplications.filter((row) => row.deal_id === dealId),
      (row) => row.created_at,
      'asc',
    );
  }

  async insertTheatricalSplitAccrual(
    row: Omit<TheatricalSplitAccrualRecord, 'id' | 'created_at'>,
  ): Promise<TheatricalSplitAccrualRecord> {
    // UNIQUE per (deal_id, source_event_id) — a replayed accrual is the
    // unique violation, never a double designation.
    if (
      this.theatricalSplitAccruals.some(
        (existing) => existing.deal_id === row.deal_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('theatrical_split_accruals.deal_id,source_event_id');
    }
    const record: TheatricalSplitAccrualRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.theatricalSplitAccruals.push(record);
    return { ...record };
  }

  async listTheatricalSplitAccruals(dealId: string): Promise<TheatricalSplitAccrualRecord[]> {
    // created_at ASC — the executed designations in execution order.
    return sortByTime(
      this.theatricalSplitAccruals.filter((row) => row.deal_id === dealId),
      (row) => row.created_at,
      'asc',
    );
  }

  // --- Promoter settlement escrow + theater gates + comedy audio (PR 31,
  // --- migration 0035) ---

  async listPromoterSettlementEscrowCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'promoter_box_office_settlement_pending' &&
          row.status === 'promoter_box_office_settlement_pending',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settlePromoterSettlementEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'promoter_box_office_settlement_pending') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async upsertPromoterSettlementAudit(
    row: Omit<PromoterSettlementAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PromoterSettlementAuditRecord> {
    // UNIQUE per (production_id, venue_id, show_date) — a re-recording
    // converges (the newest close governs the next release).
    const key = `${row.production_id}:${row.venue_id}:${row.show_date}`;
    const now = new Date().toISOString();
    const existing = this.promoterSettlementAudits.get(key);
    const record: PromoterSettlementAuditRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.promoterSettlementAudits.set(key, record);
    return { ...record };
  }

  async getPromoterSettlementAudit(
    productionId: string,
    venueId: string,
    showDate: string,
  ): Promise<PromoterSettlementAuditRecord | undefined> {
    const found = this.promoterSettlementAudits.get(
      `${productionId}:${venueId}:${showDate}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertTheatricalPayoutGateState(
    row: Omit<TheatricalPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<TheatricalPayoutGateStateRecord> {
    // UNIQUE per (payee_id, production_id) — an upsert converges (the newest
    // states govern the next dispatch).
    const key = `${row.payee_id}:${row.production_id}`;
    const now = new Date().toISOString();
    const existing = this.theatricalPayoutGateStates.get(key);
    const record: TheatricalPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.theatricalPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getTheatricalPayoutGateState(
    payeeId: string,
    productionId: string,
  ): Promise<TheatricalPayoutGateStateRecord | undefined> {
    const found = this.theatricalPayoutGateStates.get(`${payeeId}:${productionId}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertVenueHallFeePolicy(
    row: Omit<VenueHallFeePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<VenueHallFeePolicyRecord> {
    // UNIQUE per (tour_id, venue_id) — an upsert converges.
    const key = `${row.tour_id}:${row.venue_id}`;
    const now = new Date().toISOString();
    const existing = this.venueHallFeePolicies.get(key);
    const record: VenueHallFeePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.venueHallFeePolicies.set(key, record);
    return { ...record };
  }

  async getVenueHallFeePolicy(
    tourId: string,
    venueId: string,
  ): Promise<VenueHallFeePolicyRecord | undefined> {
    const found = this.venueHallFeePolicies.get(`${tourId}:${venueId}`);
    return found === undefined ? undefined : { ...found };
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
    const existing = this.licensingRoyaltyDeals.get(row.scope_key);
    const record: LicensingRoyaltyDealRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingRoyaltyDeals.set(row.scope_key, record);
    return { ...record };
  }

  async getLicensingRoyaltyDeal(
    scopeKey: string,
  ): Promise<LicensingRoyaltyDealRecord | undefined> {
    const found = this.licensingRoyaltyDeals.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertLicensingRoyaltyApplication(
    row: Omit<LicensingRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingRoyaltyApplicationRecord> {
    // UNIQUE per (deal_id, source_event_id) is the replay guard; UNIQUE
    // per (deal_id, cumulative_before_cents) is the position lock — a
    // replayed walk or a lost position race throws here, never a double
    // application; the caller retries at the advanced position.
    if (
      this.licensingRoyaltyApplications.some(
        (existing) =>
          existing.deal_id === row.deal_id && existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('licensing_royalty_applications.deal_id,source_event_id');
    }
    if (
      this.licensingRoyaltyApplications.some(
        (existing) =>
          existing.deal_id === row.deal_id &&
          existing.cumulative_before_cents === row.cumulative_before_cents,
      )
    ) {
      uniqueViolation('licensing_royalty_applications.deal_id,cumulative_before_cents');
    }
    const record: LicensingRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.licensingRoyaltyApplications.push(record);
    return { ...record };
  }

  async listLicensingRoyaltyApplications(
    dealId: string,
  ): Promise<LicensingRoyaltyApplicationRecord[]> {
    // created_at ASC — the cumulative ledger in walk order.
    return this.licensingRoyaltyApplications
      .filter((row) => row.deal_id === dealId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertLicensingTreatyRate(
    row: Omit<LicensingTreatyRateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingTreatyRateRecord> {
    // UNIQUE per (source_country, residence_country) — a re-registration
    // converges (the newest rate governs the next walk).
    const key = `${row.source_country}:${row.residence_country}`;
    const now = new Date().toISOString();
    const existing = this.licensingTreatyRates.get(key);
    const record: LicensingTreatyRateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingTreatyRates.set(key, record);
    return { ...record };
  }

  async getLicensingTreatyRate(
    sourceCountry: string,
    residenceCountry: string,
  ): Promise<LicensingTreatyRateRecord | undefined> {
    const found = this.licensingTreatyRates.get(`${sourceCountry}:${residenceCountry}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertLicensingSubLicensee(
    row: Omit<LicensingSubLicenseeRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseeRecord> {
    // UNIQUE per (scope_key, sub_licensee_id) — an upsert converges (the
    // newest override governs the next report).
    const key = `${row.scope_key}:${row.sub_licensee_id}`;
    const now = new Date().toISOString();
    const existing = this.licensingSubLicensees.get(key);
    const record: LicensingSubLicenseeRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingSubLicensees.set(key, record);
    return { ...record };
  }

  async getLicensingSubLicensee(
    scopeKey: string,
    subLicenseeId: string,
  ): Promise<LicensingSubLicenseeRecord | undefined> {
    const found = this.licensingSubLicensees.get(`${scopeKey}:${subLicenseeId}`);
    return found === undefined ? undefined : { ...found };
  }

  async listLicensingSubLicensees(scopeKey: string): Promise<LicensingSubLicenseeRecord[]> {
    // created_at ASC — the registered regional parties in registration order.
    return [...this.licensingSubLicensees.values()]
      .filter((row) => row.scope_key === scopeKey)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertLicensingSubLicenseReport(
    row: Omit<LicensingSubLicenseReportRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingSubLicenseReportRecord> {
    // UNIQUE per source_event_id — a re-shipped manifest converges, never
    // a double report row. The CAS reconcile (below) is the ONLY writer of
    // the 'reconciled' audit state; this upsert never flips it.
    const now = new Date().toISOString();
    const existing = this.licensingSubLicenseReports.get(row.source_event_id);
    const record: LicensingSubLicenseReportRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingSubLicenseReports.set(row.source_event_id, record);
    return { ...record };
  }

  async getLicensingSubLicenseReport(
    sourceEventId: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined> {
    const found = this.licensingSubLicenseReports.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async listLicensingSubLicenseReports(
    scopeKey: string,
  ): Promise<LicensingSubLicenseReportRecord[]> {
    // created_at ASC — the audit trail the release path replays.
    return [...this.licensingSubLicenseReports.values()]
      .filter((row) => row.scope_key === scopeKey)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async reconcileLicensingSubLicenseReport(
    id: string,
    evidenceRef: string,
    reconciledBy: string,
  ): Promise<LicensingSubLicenseReportRecord | undefined> {
    // The evidenced audit CAS — flips ONE row 'unknown' → 'reconciled';
    // the caller that lost the race (or replayed) reads undefined.
    for (const [key, row] of this.licensingSubLicenseReports) {
      if (row.id !== id || row.audit_state !== 'unknown') continue;
      const reconciled: LicensingSubLicenseReportRecord = {
        ...row,
        audit_state: 'reconciled',
        evidence_ref: evidenceRef,
        reconciled_by: reconciledBy,
        updated_at: new Date().toISOString(),
      };
      this.licensingSubLicenseReports.set(key, reconciled);
      return { ...reconciled };
    }
    return undefined;
  }

  // --- Advance / MG recoupment, shortfall invoices, audit reserve escrow,
  // --- and payout gate states (PR 33, migration 0037) ---

  async upsertLicensingMgCommitment(
    row: Omit<LicensingMgCommitmentRecord, 'id' | 'created_at' | 'updated_at' | 'recouped_cents'> & {
      recouped_cents?: number;
    },
  ): Promise<LicensingMgCommitmentRecord> {
    // UNIQUE per (scope_key, commitment_ref) — a re-registration replaces
    // the row atomically (the option-agreement discipline). The recouped
    // counter is bookkeeping; the append-only applications are the truth.
    const key = `${row.scope_key}:${row.commitment_ref}`;
    const now = new Date().toISOString();
    const existing = this.licensingMgCommitments.get(key);
    const record: LicensingMgCommitmentRecord = {
      ...row,
      recouped_cents: row.recouped_cents ?? existing?.recouped_cents ?? 0,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingMgCommitments.set(key, record);
    return { ...record };
  }

  async getLicensingMgCommitment(
    scopeKey: string,
    commitmentRef: string,
  ): Promise<LicensingMgCommitmentRecord | undefined> {
    const found = this.licensingMgCommitments.get(`${scopeKey}:${commitmentRef}`);
    return found === undefined ? undefined : { ...found };
  }

  async listLicensingMgCommitments(scopeKey: string): Promise<LicensingMgCommitmentRecord[]> {
    return [...this.licensingMgCommitments.values()]
      .filter((row) => row.scope_key === scopeKey)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async insertLicensingMgRecoupmentApplication(
    row: Omit<LicensingMgRecoupmentApplicationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingMgRecoupmentApplicationRecord> {
    // UNIQUE per (commitment_id, source_event_id) is the replay guard;
    // UNIQUE per (commitment_id, recouped_before_cents) is the position
    // lock — a replayed event or a lost position race throws here, never a
    // double application; the caller retries at the advanced position.
    if (
      this.licensingMgRecoupmentApplications.some(
        (existing) =>
          existing.commitment_id === row.commitment_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('licensing_mg_recoupment_applications.commitment_id,source_event_id');
    }
    if (
      this.licensingMgRecoupmentApplications.some(
        (existing) =>
          existing.commitment_id === row.commitment_id &&
          existing.recouped_before_cents === row.recouped_before_cents,
      )
    ) {
      uniqueViolation('licensing_mg_recoupment_applications.commitment_id,recouped_before_cents');
    }
    const record: LicensingMgRecoupmentApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.licensingMgRecoupmentApplications.push(record);
    return { ...record };
  }

  async listLicensingMgRecoupmentApplications(
    commitmentId: string,
  ): Promise<LicensingMgRecoupmentApplicationRecord[]> {
    // created_at ASC — the append-only truth in application order.
    return this.licensingMgRecoupmentApplications
      .filter((row) => row.commitment_id === commitmentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertLicensingMgTermClose(
    row: Omit<LicensingMgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingMgTermCloseRecord> {
    // UNIQUE per (commitment_id, term) — the once-only close; a replay
    // converges on the recorded shortfall and invoice of record.
    const key = `${row.commitment_id}:${row.term}`;
    const now = new Date().toISOString();
    const existing = this.licensingMgTermCloses.get(key);
    const record: LicensingMgTermCloseRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingMgTermCloses.set(key, record);
    return { ...record };
  }

  async getLicensingMgTermClose(
    commitmentId: string,
    term: string,
  ): Promise<LicensingMgTermCloseRecord | undefined> {
    const found = this.licensingMgTermCloses.get(`${commitmentId}:${term}`);
    return found === undefined ? undefined : { ...found };
  }

  async listLicensingMgTermCloses(scopeKey: string): Promise<LicensingMgTermCloseRecord[]> {
    return [...this.licensingMgTermCloses.values()]
      .filter((row) => row.scope_key === scopeKey)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertLicensingAuditReservePolicy(
    row: Omit<LicensingAuditReservePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingAuditReservePolicyRecord> {
    // UNIQUE per scope_key — a re-registration converges (the newest rate
    // governs the next routing).
    const now = new Date().toISOString();
    const existing = this.licensingAuditReservePolicies.get(row.scope_key);
    const record: LicensingAuditReservePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingAuditReservePolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getLicensingAuditReservePolicy(
    scopeKey: string,
  ): Promise<LicensingAuditReservePolicyRecord | undefined> {
    const found = this.licensingAuditReservePolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertLicensingAuditReserveReconciliation(
    row: Omit<LicensingAuditReserveReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.licensingAuditReserveReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('licensing_audit_reserve_reconciliations.reserve_ledger_id');
    }
    const record: LicensingAuditReserveReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.licensingAuditReserveReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getLicensingAuditReserveReconciliation(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveReconciliationRecord | undefined> {
    const found = this.licensingAuditReserveReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async insertLicensingAuditReserveDrawdown(
    row: Omit<LicensingAuditReserveDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<LicensingAuditReserveDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
    // UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
    // lock — a replayed event or a lost race throws here, never a double
    // drawdown; the caller re-derives from the append-only truth.
    if (
      this.licensingAuditReserveDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('licensing_audit_reserve_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.licensingAuditReserveDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('licensing_audit_reserve_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: LicensingAuditReserveDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.licensingAuditReserveDrawdowns.push(record);
    return { ...record };
  }

  async listLicensingAuditReserveDrawdowns(
    reserveLedgerId: string,
  ): Promise<LicensingAuditReserveDrawdownRecord[]> {
    // created_at ASC — the append-only truth in spend order.
    return this.licensingAuditReserveDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertLicensingPayoutGateState(
    row: Omit<LicensingPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<LicensingPayoutGateStateRecord> {
    // UNIQUE per (payee_id, scope_key) — an upsert converges (the newest
    // states govern the next dispatch).
    const key = `${row.payee_id}:${row.scope_key}`;
    const now = new Date().toISOString();
    const existing = this.licensingPayoutGateStates.get(key);
    const record: LicensingPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.licensingPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getLicensingPayoutGateState(
    payeeId: string,
    scopeKey: string,
  ): Promise<LicensingPayoutGateStateRecord | undefined> {
    const found = this.licensingPayoutGateStates.get(`${payeeId}:${scopeKey}`);
    return found === undefined ? undefined : { ...found };
  }

  async settleLicensingAuditReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'audit_reserve_escrow') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async getLicensingRoyaltyApplication(
    dealId: string,
    sourceEventId: string,
  ): Promise<LicensingRoyaltyApplicationRecord | undefined> {
    const found = this.licensingRoyaltyApplications.find(
      (row) => row.deal_id === dealId && row.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  // --- The NIL lane: the compliance parser + roster waterfall (PR 34,
  // --- migration 0038) ---

  async upsertNilRevenueShareProgram(
    row: Omit<NilRevenueShareProgramRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRevenueShareProgramRecord> {
    // UNIQUE per scope_key — a re-registration replaces the row atomically
    // (the option-agreement/agency-policy discipline).
    const now = new Date().toISOString();
    const existing = this.nilRevenueSharePrograms.get(row.scope_key);
    const record: NilRevenueShareProgramRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilRevenueSharePrograms.set(row.scope_key, record);
    return { ...record };
  }

  async getNilRevenueShareProgram(
    scopeKey: string,
  ): Promise<NilRevenueShareProgramRecord | undefined> {
    const found = this.nilRevenueSharePrograms.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async upsertNilRosterWaterfall(
    row: Omit<NilRosterWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilRosterWaterfallRecord> {
    // UNIQUE per (scope_key, waterfall_key) — an upsert converges (the
    // newest schedule governs the next walk).
    const key = `${row.scope_key}:${row.waterfall_key}`;
    const now = new Date().toISOString();
    const existing = this.nilRosterWaterfalls.get(key);
    const record: NilRosterWaterfallRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilRosterWaterfalls.set(key, record);
    return { ...record };
  }

  async getNilRosterWaterfall(
    scopeKey: string,
    waterfallKey: string,
  ): Promise<NilRosterWaterfallRecord | undefined> {
    const found = this.nilRosterWaterfalls.get(`${scopeKey}:${waterfallKey}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertNilSchoolCap(
    row: Omit<NilSchoolCapRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilSchoolCapRecord> {
    // UNIQUE per (school_id, cap_year) — an upsert converges.
    const key = `${row.school_id}:${row.cap_year}`;
    const now = new Date().toISOString();
    const existing = this.nilSchoolCaps.get(key);
    const record: NilSchoolCapRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilSchoolCaps.set(key, record);
    return { ...record };
  }

  async getNilSchoolCap(
    schoolId: string,
    capYear: string,
  ): Promise<NilSchoolCapRecord | undefined> {
    const found = this.nilSchoolCaps.get(`${schoolId}:${capYear}`);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilCapVerification(
    row: Omit<NilCapVerificationRecord, 'id' | 'created_at'>,
  ): Promise<NilCapVerificationRecord> {
    // UNIQUE per (school_id, cap_year) is the INSERT-AS-LOCK: the FIRST
    // verification wins; a concurrent second insert throws the unique
    // violation, never a double verification.
    if (this.nilCapVerifications.has(`${row.school_id}:${row.cap_year}`)) {
      uniqueViolation('nil_cap_verifications.school_id,cap_year');
    }
    const record: NilCapVerificationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilCapVerifications.set(`${row.school_id}:${row.cap_year}`, record);
    return { ...record };
  }

  async getNilCapVerification(
    schoolId: string,
    capYear: string,
  ): Promise<NilCapVerificationRecord | undefined> {
    const found = this.nilCapVerifications.get(`${schoolId}:${capYear}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertNilDealComplianceAudit(
    row: Omit<NilDealComplianceAuditRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilDealComplianceAuditRecord> {
    // UNIQUE per nil_contract_id — an upsert converges: the $600 flag
    // heals to 'nil_cleared'; never the reverse through this table.
    const now = new Date().toISOString();
    const existing = this.nilDealComplianceAudits.get(row.nil_contract_id);
    const record: NilDealComplianceAuditRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilDealComplianceAudits.set(row.nil_contract_id, record);
    return { ...record };
  }

  async getNilDealComplianceAudit(
    nilContractId: string,
  ): Promise<NilDealComplianceAuditRecord | undefined> {
    const found = this.nilDealComplianceAudits.get(nilContractId);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilPayoutApplication(
    row: Omit<NilPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPayoutApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked event
    // throws, never a double payout.
    if (this.nilPayoutApplications.has(row.source_event_id)) {
      uniqueViolation('nil_payout_applications.source_event_id');
    }
    const record: NilPayoutApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilPayoutApplications.set(row.source_event_id, record);
    return { ...record };
  }

  async getNilPayoutApplication(
    sourceEventId: string,
  ): Promise<NilPayoutApplicationRecord | undefined> {
    const found = this.nilPayoutApplications.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilPoolApplication(
    row: Omit<NilPoolApplicationRecord, 'id' | 'created_at'>,
  ): Promise<NilPoolApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked pool
    // event throws, never a double distribution.
    if (this.nilPoolApplications.has(row.source_event_id)) {
      uniqueViolation('nil_pool_applications.source_event_id');
    }
    const record: NilPoolApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilPoolApplications.set(row.source_event_id, record);
    return { ...record };
  }

  async getNilPoolApplication(
    sourceEventId: string,
  ): Promise<NilPoolApplicationRecord | undefined> {
    const found = this.nilPoolApplications.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilGroupSplit(
    row: Omit<NilGroupSplitRecord, 'id' | 'created_at'>,
  ): Promise<NilGroupSplitRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-shipped
    // distribution splits once, never twice.
    if (this.nilGroupSplits.has(row.source_event_id)) {
      uniqueViolation('nil_group_splits.source_event_id');
    }
    const record: NilGroupSplitRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilGroupSplits.set(row.source_event_id, record);
    return { ...record };
  }

  async getNilGroupSplit(
    sourceEventId: string,
  ): Promise<NilGroupSplitRecord | undefined> {
    const found = this.nilGroupSplits.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertNilStateRule(
    row: Omit<NilStateRuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilStateRuleRecord> {
    // UNIQUE per (state_jurisdiction_code, rule_code) — an upsert
    // converges (the newest rule governs the next payout execution).
    const key = `${row.state_jurisdiction_code}:${row.rule_code}`;
    const now = new Date().toISOString();
    const existing = this.nilStateRules.get(key);
    const record: NilStateRuleRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilStateRules.set(key, record);
    return { ...record };
  }

  async getNilStateRule(
    stateJurisdictionCode: string,
    ruleCode: string,
  ): Promise<NilStateRuleRecord | undefined> {
    const found = this.nilStateRules.get(`${stateJurisdictionCode}:${ruleCode}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertNilPayoutGateState(
    row: Omit<NilPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilPayoutGateStateRecord> {
    // UNIQUE per (payee_id, school_id) — an upsert converges: a
    // verification heals 'unknown'; states never regress through this
    // table.
    const key = `${row.payee_id}:${row.school_id}`;
    const now = new Date().toISOString();
    const existing = this.nilPayoutGateStates.get(key);
    const record: NilPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getNilPayoutGateState(
    payeeId: string,
    schoolId: string,
  ): Promise<NilPayoutGateStateRecord | undefined> {
    const found = this.nilPayoutGateStates.get(`${payeeId}:${schoolId}`);
    return found === undefined ? undefined : { ...found };
  }

  // --- NIL audit escrow + transfer portal clawback (PR 35, migration 0039) ---

  async upsertNilAuditEscrowPolicy(
    row: Omit<NilAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registration converges (the newest rate
    // governs the next routing).
    const key = row.scope_key;
    const now = new Date().toISOString();
    const existing = this.nilAuditEscrowPolicies.get(key);
    const record: NilAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilAuditEscrowPolicies.set(key, record);
    return { ...record };
  }

  async getNilAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<NilAuditEscrowPolicyRecord | undefined> {
    const found = this.nilAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilAuditEscrowDrawdown(
    row: Omit<NilAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
    // UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
    // lock — a replayed event or a lost race throws here, never a double
    // drawdown; the caller re-derives from the append-only truth.
    if (
      this.nilAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('nil_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.nilAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('nil_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: NilAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listNilAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowDrawdownRecord[]> {
    // created_at ASC — the append-only truth in spend order.
    return this.nilAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async insertNilAuditEscrowReconciliation(
    row: Omit<NilAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<NilAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.nilAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('nil_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: NilAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getNilAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<NilAuditEscrowReconciliationRecord | undefined> {
    const found = this.nilAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleNilAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — the row flips only while it is
    // still the held escrow state; the caller that lost the race (or
    // replayed) reads undefined.
    if (row === undefined || row.status !== 'nil_audit_escrow') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async upsertNilAdvanceSchedule(
    row: Omit<NilAdvanceScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NilAdvanceScheduleRecord> {
    // UNIQUE per nil_contract_id — a re-registration converges (the newest
    // terms govern the next pro-rated clawback calculation).
    const key = row.nil_contract_id;
    const now = new Date().toISOString();
    const existing = this.nilAdvanceSchedules.get(key);
    const record: NilAdvanceScheduleRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.nilAdvanceSchedules.set(key, record);
    return { ...record };
  }

  async getNilAdvanceSchedule(
    nilContractId: string,
  ): Promise<NilAdvanceScheduleRecord | undefined> {
    const found = this.nilAdvanceSchedules.get(nilContractId);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilTransferPortalEntry(
    row: Omit<NilTransferPortalEntryRecord, 'id' | 'created_at'>,
  ): Promise<NilTransferPortalEntryRecord> {
    // Insert-as-lock — UNIQUE per (nil_contract_id, athlete_id): the FIRST
    // portal entry of record wins; a re-shipped sheet or a lost race
    // throws here (the caller reads the winner through the getter).
    const key = `${row.nil_contract_id}:${row.athlete_id}`;
    if (this.nilTransferPortalEntries.has(key)) {
      uniqueViolation('nil_transfer_portal_entries.nil_contract_id,athlete_id');
    }
    const record: NilTransferPortalEntryRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilTransferPortalEntries.set(key, record);
    return { ...record };
  }

  async getNilTransferPortalEntry(
    nilContractId: string,
    athleteId: string,
  ): Promise<NilTransferPortalEntryRecord | undefined> {
    const found = this.nilTransferPortalEntries.get(`${nilContractId}:${athleteId}`);
    return found === undefined ? undefined : { ...found };
  }

  async insertNilUnearnedClawback(
    row: Omit<NilUnearnedClawbackRecord, 'id' | 'created_at'>,
  ): Promise<NilUnearnedClawbackRecord> {
    // UNIQUE per portal_entry_id — the calculation and its
    // nil_unearned_clawback debit hold land once; a concurrent second
    // insert throws here (the caller reads the winner through the
    // getter).
    const key = row.portal_entry_id;
    if (this.nilUnearnedClawbacks.has(key)) {
      uniqueViolation('nil_unearned_clawbacks.portal_entry_id');
    }
    const record: NilUnearnedClawbackRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.nilUnearnedClawbacks.set(key, record);
    return { ...record };
  }

  async getNilUnearnedClawback(
    portalEntryId: string,
  ): Promise<NilUnearnedClawbackRecord | undefined> {
    const found = this.nilUnearnedClawbacks.get(portalEntryId);
    return found === undefined ? undefined : { ...found };
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

  // --- Merch returns reserve + fulfillment confirmation (PR 23, migration 0027) ---

  async upsertMerchReturnReservePolicy(
    row: Omit<MerchReturnReservePolicyRecord, 'id'>,
  ): Promise<MerchReturnReservePolicyRecord> {
    // One policy of record per sku — upsert replaces the row atomically.
    const existingIndex = this.merchReturnReservePolicies.findIndex(
      (candidate) => candidate.sku_id === row.sku_id,
    );
    const record: MerchReturnReservePolicyRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.merchReturnReservePolicies[existingIndex] = record;
    } else {
      this.merchReturnReservePolicies.push(record);
    }
    return record;
  }

  async getMerchReturnReservePolicy(
    skuId: string,
  ): Promise<MerchReturnReservePolicyRecord | undefined> {
    return this.merchReturnReservePolicies.find((candidate) => candidate.sku_id === skuId);
  }

  async insertMerchReserveDrawdown(
    row: Omit<MerchReserveDrawdownRecord, 'id'>,
  ): Promise<MerchReserveDrawdownRecord> {
    // UNIQUE on (reserve_ledger_id, source_event_id) — a re-shipped
    // return/chargeback event is the unique violation, never a double
    // drawdown. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
    // insert-as-lock position arbiter: a concurrent drawdown that loses the
    // position throws.
    if (
      this.merchReserveDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('merch_reserve_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.merchReserveDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('merch_reserve_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: MerchReserveDrawdownRecord = { ...row, id: randomUUID() };
    this.merchReserveDrawdowns.push(record);
    return record;
  }

  async listMerchReserveDrawdowns(reserveLedgerId: string): Promise<MerchReserveDrawdownRecord[]> {
    return this.merchReserveDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort((a, b) => a.drawn_before_cents - b.drawn_before_cents);
  }

  async insertMerchFulfillmentTracking(
    row: Omit<MerchFulfillmentTrackingRecord, 'id'>,
  ): Promise<MerchFulfillmentTrackingRecord> {
    // UNIQUE on (fulfillment_event_id, tracking_number, tracking_state) — a
    // re-shipped tracking event is the unique violation, never a double
    // record.
    if (
      this.merchFulfillmentTrackings.some(
        (existing) =>
          existing.fulfillment_event_id === row.fulfillment_event_id &&
          existing.tracking_number === row.tracking_number &&
          existing.tracking_state === row.tracking_state,
      )
    ) {
      uniqueViolation('merch_fulfillment_trackings.fulfillment_event_id,tracking_number,tracking_state');
    }
    const record: MerchFulfillmentTrackingRecord = { ...row, id: randomUUID() };
    this.merchFulfillmentTrackings.push(record);
    return record;
  }

  async listMerchFulfillmentTrackings(
    fulfillmentEventId: string,
  ): Promise<MerchFulfillmentTrackingRecord[]> {
    return this.merchFulfillmentTrackings
      .filter((row) => row.fulfillment_event_id === fulfillmentEventId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async listMerchReturnsReserveCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) =>
          row.kind === 'merch_returns_reserve' && row.status === 'merch_returns_reserve',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async settleMerchReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'merch_returns_reserve') return undefined;
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  // --- Foreign tax hold + book returns reserve (PR 27, migration 0031) ---

  async listForeignTaxHolds(limit: number = DEFAULT_LIST_SHOWS_LIMIT): Promise<LedgerTransactionRecord[]> {
    // The frozen-leg work queue: a thawed leg leaves the listing (its
    // status returned to 'unclaimed_holding'). Newest first.
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) => row.kind === 'unclaimed_holding' && row.status === 'foreign_tax_hold',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async thawForeignTaxHolds(taxHoldScope: string): Promise<number> {
    // The THAW CAS sweep — the VERIFIED withholding credit's ledger leg:
    // ONLY the scope's 'foreign_tax_hold' legs return to holding. A re-run
    // is an honest no-op (the already-thawed legs no longer match).
    let thawed = 0;
    for (const row of this.ledgerTransactions) {
      if (
        row.kind === 'unclaimed_holding' &&
        row.status === 'foreign_tax_hold' &&
        row.split_run_id === taxHoldScope
      ) {
        row.status = 'unclaimed_holding';
        thawed += 1;
      }
    }
    return thawed;
  }

  async freezeForeignTaxHolds(taxHoldScope: string): Promise<number> {
    // The FREEZE CAS sweep — the foreign-tax-hold lane's ledger leg: ONLY
    // the scope's still-held legs enter the freeze. A re-applied hold is a
    // counted no-op (the already-frozen legs no longer match).
    let frozen = 0;
    for (const row of this.ledgerTransactions) {
      if (
        row.kind === 'unclaimed_holding' &&
        row.status === 'unclaimed_holding' &&
        row.split_run_id === taxHoldScope
      ) {
        row.status = 'foreign_tax_hold';
        frozen += 1;
      }
    }
    return frozen;
  }

  async upsertWithholdingTaxCreditVerification(
    row: Omit<WithholdingTaxCreditVerificationRecord, 'id'>,
  ): Promise<WithholdingTaxCreditVerificationRecord> {
    // One verification of record per (country_code, tax_year) — upsert
    // replaces the row atomically (the evidence upgrade converges).
    const existingIndex = this.withholdingTaxCreditVerifications.findIndex(
      (candidate) => candidate.country_code === row.country_code && candidate.tax_year === row.tax_year,
    );
    const record: WithholdingTaxCreditVerificationRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.withholdingTaxCreditVerifications[existingIndex] = record;
    } else {
      this.withholdingTaxCreditVerifications.push(record);
    }
    return record;
  }

  async getWithholdingTaxCreditVerification(
    countryCode: string,
    taxYear: number,
  ): Promise<WithholdingTaxCreditVerificationRecord | undefined> {
    return this.withholdingTaxCreditVerifications.find(
      (candidate) => candidate.country_code === countryCode && candidate.tax_year === taxYear,
    );
  }

  async upsertIsbnRightsVerification(
    row: Omit<IsbnRightsVerificationRecord, 'id'>,
  ): Promise<IsbnRightsVerificationRecord> {
    // One verification of record per isbn — upsert replaces the row
    // atomically (the option-agreement precedent).
    const existingIndex = this.isbnRightsVerifications.findIndex(
      (candidate) => candidate.isbn === row.isbn,
    );
    const record: IsbnRightsVerificationRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.isbnRightsVerifications[existingIndex] = record;
    } else {
      this.isbnRightsVerifications.push(record);
    }
    return record;
  }

  async getIsbnRightsVerification(isbn: string): Promise<IsbnRightsVerificationRecord | undefined> {
    return this.isbnRightsVerifications.find((candidate) => candidate.isbn === isbn);
  }

  async upsertBookReturnsReservePolicy(
    row: Omit<BookReturnsReservePolicyRecord, 'id'>,
  ): Promise<BookReturnsReservePolicyRecord> {
    // One policy of record per isbn — upsert replaces the row atomically.
    const existingIndex = this.bookReturnsReservePolicies.findIndex(
      (candidate) => candidate.isbn === row.isbn,
    );
    const record: BookReturnsReservePolicyRecord = { ...row, id: randomUUID() };
    if (existingIndex >= 0) {
      this.bookReturnsReservePolicies[existingIndex] = record;
    } else {
      this.bookReturnsReservePolicies.push(record);
    }
    return record;
  }

  async getBookReturnsReservePolicy(isbn: string): Promise<BookReturnsReservePolicyRecord | undefined> {
    return this.bookReturnsReservePolicies.find((candidate) => candidate.isbn === isbn);
  }

  async listBookReturnsReserveCredits(
    limit: number = DEFAULT_LIST_SHOWS_LIMIT,
  ): Promise<LedgerTransactionRecord[]> {
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) => row.kind === 'book_returns_reserve' && row.status === 'book_returns_reserve',
      ),
      (row) => row.created_at,
      'desc',
    ).slice(0, limit);
  }

  async listBookReturnsReserveCreditsByIsbn(isbn: string): Promise<LedgerTransactionRecord[]> {
    // EVERY state of the ISBN's reserves, oldest first — the FIFO draw
    // ordering and the gate's window derivation (a settled reserve still
    // proves its period ran).
    return sortByTime(
      this.ledgerTransactions.filter(
        (row) => row.kind === 'book_returns_reserve' && row.payee_id === bookReturnsReservePayeeId(isbn),
      ),
      (row) => row.created_at,
      'asc',
    );
  }

  async settleBookReturnsReserve(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS: the in-memory backend is single-threaded
    // by construction, so check-then-set is atomic here the way the conditional
    // UPDATE is on SQLite/Supabase.
    if (row === undefined || row.status !== 'book_returns_reserve') return undefined;
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async insertBookReserveDrawdown(
    row: Omit<BookReserveDrawdownRecord, 'id'>,
  ): Promise<BookReserveDrawdownRecord> {
    // UNIQUE on (reserve_ledger_id, source_event_id) — a re-shipped
    // return/chargeback event is the unique violation, never a double
    // drawdown. UNIQUE on (reserve_ledger_id, drawn_before_cents) — the
    // insert-as-lock position arbiter: a concurrent drawdown that loses the
    // position throws.
    if (
      this.bookReserveDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('book_reserve_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.bookReserveDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('book_reserve_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: BookReserveDrawdownRecord = { ...row, id: randomUUID() };
    this.bookReserveDrawdowns.push(record);
    return record;
  }

  async listBookReserveDrawdowns(reserveLedgerId: string): Promise<BookReserveDrawdownRecord[]> {
    return this.bookReserveDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort((a, b) => a.drawn_before_cents - b.drawn_before_cents);
  }

  async insertBookReturnChargeback(
    row: Omit<BookReturnChargebackRecord, 'id'>,
  ): Promise<BookReturnChargebackRecord> {
    // UNIQUE on event_id — a re-shipped chargeback event is the unique
    // violation (the replay surface).
    if (this.bookReturnChargebacks.some((existing) => existing.event_id === row.event_id)) {
      uniqueViolation('book_return_chargebacks.event_id');
    }
    const record: BookReturnChargebackRecord = { ...row, id: randomUUID() };
    this.bookReturnChargebacks.push(record);
    return record;
  }

  async listBookReturnChargebacksByIsbn(isbn: string): Promise<BookReturnChargebackRecord[]> {
    return this.bookReturnChargebacks
      .filter((row) => row.isbn === isbn)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async insertBookChargebackOffsetApplication(
    row: Omit<BookChargebackOffsetApplicationRecord, 'id'>,
  ): Promise<BookChargebackOffsetApplicationRecord> {
    // UNIQUE on (chargeback_id, holding_ledger_id) — a replayed release is
    // the unique violation, never a double offset. UNIQUE on
    // (chargeback_id, offset_before_cents) — the insert-as-lock position
    // arbiter: exactly one release wins an offset's next running position.
    if (
      this.bookChargebackOffsetApplications.some(
        (existing) =>
          existing.chargeback_id === row.chargeback_id &&
          existing.holding_ledger_id === row.holding_ledger_id,
      )
    ) {
      uniqueViolation('book_chargeback_offset_applications.chargeback_id,holding_ledger_id');
    }
    if (
      this.bookChargebackOffsetApplications.some(
        (existing) =>
          existing.chargeback_id === row.chargeback_id &&
          existing.offset_before_cents === row.offset_before_cents,
      )
    ) {
      uniqueViolation('book_chargeback_offset_applications.chargeback_id,offset_before_cents');
    }
    const record: BookChargebackOffsetApplicationRecord = { ...row, id: randomUUID() };
    this.bookChargebackOffsetApplications.push(record);
    return record;
  }

  async listBookChargebackOffsetApplications(
    chargebackId: string,
  ): Promise<BookChargebackOffsetApplicationRecord[]> {
    return this.bookChargebackOffsetApplications
      .filter((row) => row.chargeback_id === chargebackId)
      .sort((a, b) => a.offset_before_cents - b.offset_before_cents);
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

  // --- Spatial POS + occupancy royalties + zone allocation (migration 0040) ---

  async upsertSpatialOccupancyTierSchedule(
    row: Omit<SpatialOccupancyTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOccupancyTierScheduleRecord> {
    // UNIQUE per (venue_id, year) — an upsert converges (the newest
    // schedule governs); never the id column in the conflict payload
    // (the id rotates on conflict — the PR 33 parity lesson).
    const key = `${row.venue_id}:${row.year}`;
    const now = new Date().toISOString();
    const existing = this.spatialOccupancyTierSchedules.get(key);
    const record: SpatialOccupancyTierScheduleRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialOccupancyTierSchedules.set(key, record);
    return { ...record };
  }

  async getSpatialOccupancyTierSchedule(
    venueId: string,
    year: string,
  ): Promise<SpatialOccupancyTierScheduleRecord | undefined> {
    const found = this.spatialOccupancyTierSchedules.get(`${venueId}:${year}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSpatialOverheadPolicy(
    row: Omit<SpatialOverheadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialOverheadPolicyRecord> {
    const key = `${row.venue_id}:${row.year}`;
    const now = new Date().toISOString();
    const existing = this.spatialOverheadPolicies.get(key);
    const record: SpatialOverheadPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialOverheadPolicies.set(key, record);
    return { ...record };
  }

  async getSpatialOverheadPolicy(
    venueId: string,
    year: string,
  ): Promise<SpatialOverheadPolicyRecord | undefined> {
    const found = this.spatialOverheadPolicies.get(`${venueId}:${year}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSpatialZoneAssignment(
    row: Omit<SpatialZoneAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialZoneAssignmentRecord> {
    const key = `${row.venue_id}:${row.zone_code}`;
    const now = new Date().toISOString();
    const existing = this.spatialZoneAssignments.get(key);
    const record: SpatialZoneAssignmentRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialZoneAssignments.set(key, record);
    return { ...record };
  }

  async getSpatialZoneAssignment(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialZoneAssignmentRecord | undefined> {
    const found = this.spatialZoneAssignments.get(`${venueId}:${zoneCode}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSpatialMicroPolicy(
    row: Omit<SpatialMicroPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMicroPolicyRecord> {
    const key = `${row.venue_id}:${row.zone_code}`;
    const now = new Date().toISOString();
    const existing = this.spatialMicroPolicies.get(key);
    const record: SpatialMicroPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialMicroPolicies.set(key, record);
    return { ...record };
  }

  async getSpatialMicroPolicy(
    venueId: string,
    zoneCode: string,
  ): Promise<SpatialMicroPolicyRecord | undefined> {
    const found = this.spatialMicroPolicies.get(`${venueId}:${zoneCode}`);
    return found === undefined ? undefined : { ...found };
  }

  async advanceSpatialThroughputYear(
    venueId: string,
    year: string,
    entriesAdded: number,
  ): Promise<SpatialThroughputYearRecord> {
    const key = `${venueId}:${year}`;
    const now = new Date().toISOString();
    const existing = this.spatialThroughputYears.get(key);
    const record: SpatialThroughputYearRecord = {
      id: existing?.id ?? randomUUID(),
      venue_id: venueId,
      year,
      cumulative_entries: (existing?.cumulative_entries ?? 0) + entriesAdded,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialThroughputYears.set(key, record);
    return { ...record };
  }

  async getSpatialThroughputYear(
    venueId: string,
    year: string,
  ): Promise<SpatialThroughputYearRecord | undefined> {
    const found = this.spatialThroughputYears.get(`${venueId}:${year}`);
    return found === undefined ? undefined : { ...found };
  }

  async insertSpatialRoyaltyApplication(
    row: Omit<SpatialRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked event
    // throws, never a double royalty.
    if (this.spatialRoyaltyApplications.has(row.source_event_id)) {
      uniqueViolation('spatial_royalty_applications.source_event_id');
    }
    const record: SpatialRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialRoyaltyApplications.set(row.source_event_id, record);
    return { ...record };
  }

  async getSpatialRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SpatialRoyaltyApplicationRecord | undefined> {
    const found = this.spatialRoyaltyApplications.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertSpatialZoneAllocation(
    row: Omit<SpatialZoneAllocationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialZoneAllocationRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked sale
    // throws, never a double allocation.
    if (this.spatialZoneAllocations.has(row.source_event_id)) {
      uniqueViolation('spatial_zone_allocations.source_event_id');
    }
    const record: SpatialZoneAllocationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialZoneAllocations.set(row.source_event_id, record);
    return { ...record };
  }

  async getSpatialZoneAllocation(
    sourceEventId: string,
  ): Promise<SpatialZoneAllocationRecord | undefined> {
    const found = this.spatialZoneAllocations.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertSpatialMicroRoyalty(
    row: Omit<SpatialMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<SpatialMicroRoyaltyRecord> {
    // UNIQUE per source_event_id is the replay guard — a re-walked
    // telemetry event throws, never a double micro-payout.
    if (this.spatialMicroRoyalties.has(row.source_event_id)) {
      uniqueViolation('spatial_micro_royalty_ledger.source_event_id');
    }
    const record: SpatialMicroRoyaltyRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialMicroRoyalties.set(row.source_event_id, record);
    return { ...record };
  }

  async getSpatialMicroRoyalty(
    sourceEventId: string,
  ): Promise<SpatialMicroRoyaltyRecord | undefined> {
    const found = this.spatialMicroRoyalties.get(sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  // -----------------------------------------------------------------
  // PR 37 — spatial commitments (migration 0041).
  // -----------------------------------------------------------------

  async upsertSpatialCapexCommitment(
    row: Omit<SpatialCapexCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialCapexCommitmentRecord> {
    // UNIQUE per (scope_key, capex_ref) — a re-registered commitment
    // converges (the newest registered cost governs the next walk).
    const key = `${row.scope_key}\u0000${row.capex_ref}`;
    const now = new Date().toISOString();
    const existing = this.spatialCapexCommitments.get(key);
    const record: SpatialCapexCommitmentRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialCapexCommitments.set(key, record);
    return { ...record };
  }

  async getSpatialCapexCommitment(
    scopeKey: string,
    capexRef: string,
  ): Promise<SpatialCapexCommitmentRecord | undefined> {
    const found = this.spatialCapexCommitments.get(`${scopeKey}\u0000${capexRef}`);
    return found === undefined ? undefined : { ...found };
  }

  async listSpatialCapexCommitments(
    scopeKey: string,
  ): Promise<SpatialCapexCommitmentRecord[]> {
    // created_at ASC — the offset walk's OLDEST-FIRST input.
    return [...this.spatialCapexCommitments.values()]
      .filter((row) => row.scope_key === scopeKey)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async insertSpatialCapexApplication(
    row: Omit<SpatialCapexApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialCapexApplicationRecord> {
    // UNIQUE per (commitment_id, source_event_id) is the replay guard;
    // UNIQUE per (commitment_id, offset_before_cents) is the position
    // lock — a replayed royalty or a lost race throws here, never a
    // double offset; the caller re-derives from the append-only truth.
    if (
      this.spatialCapexApplications.some(
        (existing) =>
          existing.commitment_id === row.commitment_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('spatial_capex_applications.commitment_id,source_event_id');
    }
    if (
      this.spatialCapexApplications.some(
        (existing) =>
          existing.commitment_id === row.commitment_id &&
          existing.offset_before_cents === row.offset_before_cents,
      )
    ) {
      uniqueViolation('spatial_capex_applications.commitment_id,offset_before_cents');
    }
    const record: SpatialCapexApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialCapexApplications.push(record);
    return { ...record };
  }

  async listSpatialCapexApplications(
    commitmentId: string,
  ): Promise<SpatialCapexApplicationRecord[]> {
    // created_at ASC — the amortization schedule of record.
    return this.spatialCapexApplications
      .filter((row) => row.commitment_id === commitmentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertSpatialMsgCommitment(
    row: Omit<SpatialMsgCommitmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgCommitmentRecord> {
    // UNIQUE per scope_key — a re-registered guarantee converges (the
    // newest priced terms govern the next close).
    const now = new Date().toISOString();
    const existing = this.spatialMsgCommitments.get(row.scope_key);
    const record: SpatialMsgCommitmentRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialMsgCommitments.set(row.scope_key, record);
    return { ...record };
  }

  async getSpatialMsgCommitment(
    scopeKey: string,
  ): Promise<SpatialMsgCommitmentRecord | undefined> {
    const found = this.spatialMsgCommitments.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSpatialMsgTermClose(
    row: Omit<SpatialMsgTermCloseRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialMsgTermCloseRecord> {
    // UNIQUE per (commitment_id, quarter) — the once-only close; a
    // replay converges on the recorded shortfall and invoice of record.
    const key = `${row.commitment_id}\u0000${row.quarter}`;
    const now = new Date().toISOString();
    const existing = this.spatialMsgTermCloses.get(key);
    const record: SpatialMsgTermCloseRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialMsgTermCloses.set(key, record);
    return { ...record };
  }

  async getSpatialMsgTermClose(
    commitmentId: string,
    quarter: string,
  ): Promise<SpatialMsgTermCloseRecord | undefined> {
    const found = this.spatialMsgTermCloses.get(`${commitmentId}\u0000${quarter}`);
    return found === undefined ? undefined : { ...found };
  }

  async listSpatialRoyaltyApplicationsByVenue(
    venueId: string,
  ): Promise<SpatialRoyaltyApplicationRecord[]> {
    // created_at ASC — the append-only royalty truth the MSG close sums.
    return [...this.spatialRoyaltyApplications.values()]
      .filter((row) => row.venue_id === venueId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async listSpatialZoneAllocationsByVenue(
    venueId: string,
  ): Promise<SpatialZoneAllocationRecord[]> {
    return [...this.spatialZoneAllocations.values()]
      .filter((row) => row.venue_id === venueId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async listSpatialMicroRoyaltiesByVenue(venueId: string): Promise<SpatialMicroRoyaltyRecord[]> {
    return [...this.spatialMicroRoyalties.values()]
      .filter((row) => row.venue_id === venueId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async insertSpatialPopupExperience(
    row: Omit<SpatialPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPopupExperienceRecord> {
    // Insert-as-lock — UNIQUE per popup_ref: the FIRST registration
    // wins; a re-shipped sheet or a lost race throws here (the caller
    // reads the winner through the getter).
    if (this.spatialPopupExperiences.has(row.popup_ref)) {
      uniqueViolation('spatial_popup_experiences.popup_ref');
    }
    const record: SpatialPopupExperienceRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.spatialPopupExperiences.set(row.popup_ref, record);
    return { ...record };
  }

  async getSpatialPopupExperience(
    popupRef: string,
  ): Promise<SpatialPopupExperienceRecord | undefined> {
    const found = this.spatialPopupExperiences.get(popupRef);
    return found === undefined ? undefined : { ...found };
  }

  async insertSpatialPopupWriteoff(
    row: Omit<SpatialPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupWriteoffRecord> {
    // UNIQUE per (popup_experience_id, source_event_id) — a replayed
    // calculation throws, never a double-priced write-off.
    if (
      this.spatialPopupWriteoffs.some(
        (existing) =>
          existing.popup_experience_id === row.popup_experience_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('spatial_popup_writeoffs.popup_experience_id,source_event_id');
    }
    const record: SpatialPopupWriteoffRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialPopupWriteoffs.push(record);
    return { ...record };
  }

  async listSpatialPopupWriteoffs(
    popupExperienceId: string,
  ): Promise<SpatialPopupWriteoffRecord[]> {
    return this.spatialPopupWriteoffs
      .filter((row) => row.popup_experience_id === popupExperienceId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async insertSpatialPopupRestorationReserve(
    row: Omit<SpatialPopupRestorationReserveRecord, 'id' | 'created_at'>,
  ): Promise<SpatialPopupRestorationReserveRecord> {
    // Insert-as-lock — UNIQUE per popup_experience_id: the FIRST reserve
    // wins; a concurrent second insert throws here.
    if (this.spatialPopupRestorationReserves.has(row.popup_experience_id)) {
      uniqueViolation('spatial_popup_restoration_reserves.popup_experience_id');
    }
    const record: SpatialPopupRestorationReserveRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialPopupRestorationReserves.set(row.popup_experience_id, record);
    return { ...record };
  }

  async getSpatialPopupRestorationReserve(
    popupExperienceId: string,
  ): Promise<SpatialPopupRestorationReserveRecord | undefined> {
    const found = this.spatialPopupRestorationReserves.get(popupExperienceId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSpatialAuditEscrowPolicy(
    row: Omit<SpatialAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.spatialAuditEscrowPolicies.get(row.scope_key);
    const record: SpatialAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialAuditEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getSpatialAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<SpatialAuditEscrowPolicyRecord | undefined> {
    const found = this.spatialAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertSpatialAuditEscrowDrawdown(
    row: Omit<SpatialAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.spatialAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('spatial_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.spatialAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('spatial_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: SpatialAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listSpatialAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique position column orders same-millisecond rows honestly.
    return this.spatialAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertSpatialAuditEscrowReconciliation(
    row: Omit<SpatialAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SpatialAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.spatialAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('spatial_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: SpatialAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.spatialAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getSpatialAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SpatialAuditEscrowReconciliationRecord | undefined> {
    const found = this.spatialAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleSpatialAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    const row = this.ledgerTransactions.find((candidate) => candidate.id === id);
    // The conditional read IS the CAS — the row flips only while it is
    // still the held escrow state; the caller that lost the race (or
    // replayed) reads undefined.
    if (row === undefined || row.status !== 'spatial_audit_escrow') {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return row;
  }

  async upsertSpatialPayoutGateState(
    row: Omit<SpatialPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SpatialPayoutGateStateRecord> {
    // UNIQUE per (payee_id, venue_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const key = `${row.payee_id}\u0000${row.venue_id}`;
    const now = new Date().toISOString();
    const existing = this.spatialPayoutGateStates.get(key);
    const record: SpatialPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.spatialPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getSpatialPayoutGateState(
    payeeId: string,
    venueId: string,
  ): Promise<SpatialPayoutGateStateRecord | undefined> {
    const found = this.spatialPayoutGateStates.get(`${payeeId}\u0000${venueId}`);
    return found === undefined ? undefined : { ...found };
  }

  // ---------------------------------------------------------------------------
  // PR 38 — the fitness lane (migration 0042). Policies and trackers upsert
  // on their identities; the ledgers are append-only — a duplicate
  // source_event_id throws, never a double application.
  // ---------------------------------------------------------------------------

  async upsertFitnessTrainerTierSchedule(
    row: Omit<FitnessTrainerTierScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessTrainerTierScheduleRecord> {
    const key = `${row.trainer_id}\u0000${row.program_id}`;
    const now = new Date().toISOString();
    const existing = this.fitnessTrainerTierSchedules.get(key);
    const record: FitnessTrainerTierScheduleRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessTrainerTierSchedules.set(key, record);
    return { ...record };
  }

  async getFitnessTrainerTierSchedule(
    trainerId: string,
    programId: string,
  ): Promise<FitnessTrainerTierScheduleRecord | undefined> {
    const found = this.fitnessTrainerTierSchedules.get(`${trainerId}\u0000${programId}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFitnessSyncMusicPolicy(
    row: Omit<FitnessSyncMusicPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessSyncMusicPolicyRecord> {
    const now = new Date().toISOString();
    const existing = this.fitnessSyncMusicPolicies.get(row.program_id);
    const record: FitnessSyncMusicPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessSyncMusicPolicies.set(row.program_id, record);
    return { ...record };
  }

  async getFitnessSyncMusicPolicy(
    programId: string,
  ): Promise<FitnessSyncMusicPolicyRecord | undefined> {
    const found = this.fitnessSyncMusicPolicies.get(programId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFitnessLiveLoadPolicy(
    row: Omit<FitnessLiveLoadPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveLoadPolicyRecord> {
    const now = new Date().toISOString();
    const existing = this.fitnessLiveLoadPolicies.get(row.program_id);
    const record: FitnessLiveLoadPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessLiveLoadPolicies.set(row.program_id, record);
    return { ...record };
  }

  async getFitnessLiveLoadPolicy(
    programId: string,
  ): Promise<FitnessLiveLoadPolicyRecord | undefined> {
    const found = this.fitnessLiveLoadPolicies.get(programId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFitnessFranchisePolicy(
    row: Omit<FitnessFranchisePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessFranchisePolicyRecord> {
    const now = new Date().toISOString();
    const existing = this.fitnessFranchisePolicies.get(row.studio_franchise_code);
    const record: FitnessFranchisePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessFranchisePolicies.set(row.studio_franchise_code, record);
    return { ...record };
  }

  async getFitnessFranchisePolicy(
    studioFranchiseCode: string,
  ): Promise<FitnessFranchisePolicyRecord | undefined> {
    const found = this.fitnessFranchisePolicies.get(studioFranchiseCode);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFitnessCoBrandPartnership(
    row: Omit<FitnessCoBrandPartnershipRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCoBrandPartnershipRecord> {
    const now = new Date().toISOString();
    const existing = this.fitnessCoBrandPartnerships.get(row.studio_franchise_code);
    const record: FitnessCoBrandPartnershipRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessCoBrandPartnerships.set(row.studio_franchise_code, record);
    return { ...record };
  }

  async getFitnessCoBrandPartnership(
    studioFranchiseCode: string,
  ): Promise<FitnessCoBrandPartnershipRecord | undefined> {
    const found = this.fitnessCoBrandPartnerships.get(studioFranchiseCode);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFitnessAlgorithmPolicy(
    row: Omit<FitnessAlgorithmPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAlgorithmPolicyRecord> {
    const now = new Date().toISOString();
    const existing = this.fitnessAlgorithmPolicies.get(row.program_id);
    const record: FitnessAlgorithmPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessAlgorithmPolicies.set(row.program_id, record);
    return { ...record };
  }

  async getFitnessAlgorithmPolicy(
    programId: string,
  ): Promise<FitnessAlgorithmPolicyRecord | undefined> {
    const found = this.fitnessAlgorithmPolicies.get(programId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFitnessCocreationModule(
    row: Omit<FitnessCocreationModuleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessCocreationModuleRecord> {
    const now = new Date().toISOString();
    const index = this.fitnessCocreationModules.findIndex(
      (module_) =>
        module_.program_id === row.program_id && module_.module_id === row.module_id,
    );
    if (index >= 0) {
      const existing = this.fitnessCocreationModules[index] as FitnessCocreationModuleRecord;
      const record: FitnessCocreationModuleRecord = {
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
      };
      this.fitnessCocreationModules[index] = record;
      return { ...record };
    }
    const record: FitnessCocreationModuleRecord = {
      ...row,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.fitnessCocreationModules.push(record);
    return { ...record };
  }

  async listFitnessCocreationModules(
    programId: string,
  ): Promise<FitnessCocreationModuleRecord[]> {
    return this.fitnessCocreationModules
      .filter((module_) => module_.program_id === programId)
      .map((module_) => ({ ...module_ }));
  }

  async advanceFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
    completionsAdded: number,
  ): Promise<FitnessCompletionMonthRecord> {
    const key = `${trainerId}\u0000${programId}\u0000${month}`;
    const now = new Date().toISOString();
    const existing = this.fitnessCompletionMonths.get(key);
    const record: FitnessCompletionMonthRecord = {
      id: existing?.id ?? randomUUID(),
      trainer_id: trainerId,
      program_id: programId,
      month,
      cumulative_completions: (existing?.cumulative_completions ?? 0) + completionsAdded,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessCompletionMonths.set(key, record);
    return { ...record };
  }

  async getFitnessCompletionMonth(
    trainerId: string,
    programId: string,
    month: string,
  ): Promise<FitnessCompletionMonthRecord | undefined> {
    const found = this.fitnessCompletionMonths.get(
      `${trainerId}\u0000${programId}\u0000${month}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async advanceFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
    classesAdded: number,
  ): Promise<FitnessFranchiseClassMonthRecord> {
    const key = `${studioFranchiseCode}\u0000${month}`;
    const now = new Date().toISOString();
    const existing = this.fitnessFranchiseClassMonths.get(key);
    const record: FitnessFranchiseClassMonthRecord = {
      id: existing?.id ?? randomUUID(),
      studio_franchise_code: studioFranchiseCode,
      month,
      cumulative_classes: (existing?.cumulative_classes ?? 0) + classesAdded,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessFranchiseClassMonths.set(key, record);
    return { ...record };
  }

  async getFitnessFranchiseClassMonth(
    studioFranchiseCode: string,
    month: string,
  ): Promise<FitnessFranchiseClassMonthRecord | undefined> {
    const found = this.fitnessFranchiseClassMonths.get(
      `${studioFranchiseCode}\u0000${month}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessRealizationApplication(
    row: Omit<FitnessRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessRealizationApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessRealizationApplications.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_realization_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessRealizationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessRealizationApplications.push(record);
    return { ...record };
  }

  async getFitnessRealizationApplication(
    sourceEventId: string,
  ): Promise<FitnessRealizationApplicationRecord | undefined> {
    const found = this.fitnessRealizationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessTrainerRoyaltyApplication(
    row: Omit<FitnessTrainerRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessTrainerRoyaltyApplications.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_trainer_royalty_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessTrainerRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessTrainerRoyaltyApplications.push(record);
    return { ...record };
  }

  async getFitnessTrainerRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FitnessTrainerRoyaltyApplicationRecord | undefined> {
    const found = this.fitnessTrainerRoyaltyApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessLiveResidualApplication(
    row: Omit<FitnessLiveResidualApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveResidualApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessLiveResidualApplications.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_live_residual_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessLiveResidualApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessLiveResidualApplications.push(record);
    return { ...record };
  }

  async getFitnessLiveResidualApplication(
    sourceEventId: string,
  ): Promise<FitnessLiveResidualApplicationRecord | undefined> {
    const found = this.fitnessLiveResidualApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessFranchiseApplication(
    row: Omit<FitnessFranchiseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessFranchiseApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessFranchiseApplications.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_franchise_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessFranchiseApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessFranchiseApplications.push(record);
    return { ...record };
  }

  async getFitnessFranchiseApplication(
    sourceEventId: string,
  ): Promise<FitnessFranchiseApplicationRecord | undefined> {
    const found = this.fitnessFranchiseApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessCobrandSplitApplication(
    row: Omit<FitnessCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCobrandSplitApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessCobrandSplitApplications.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_cobrand_split_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessCobrandSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessCobrandSplitApplications.push(record);
    return { ...record };
  }

  async getFitnessCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FitnessCobrandSplitApplicationRecord | undefined> {
    const found = this.fitnessCobrandSplitApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessAlgorithmRoyalty(
    row: Omit<FitnessAlgorithmRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAlgorithmRoyaltyRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessAlgorithmRoyaltyLedger.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_algorithm_royalty_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessAlgorithmRoyaltyRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessAlgorithmRoyaltyLedger.push(record);
    return { ...record };
  }

  async getFitnessAlgorithmRoyalty(
    sourceEventId: string,
  ): Promise<FitnessAlgorithmRoyaltyRecord | undefined> {
    const found = this.fitnessAlgorithmRoyaltyLedger.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessCocreationApplication(
    row: Omit<FitnessCocreationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessCocreationApplicationRecord> {
    // UNIQUE per source_event_id is the replay guard.
    if (
      this.fitnessCocreationApplications.some(
        (record) => record.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(
        `fitness_cocreation_replay_conflict: ${row.source_event_id} already applied`,
      );
    }
    const record: FitnessCocreationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessCocreationApplications.push(record);
    return { ...record };
  }

  async getFitnessCocreationApplication(
    sourceEventId: string,
  ): Promise<FitnessCocreationApplicationRecord | undefined> {
    const found = this.fitnessCocreationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  // --- The fitness audit escrow + gate states + live-event bonuses (PR 39,
  // migration 0043) — the 0041 spatial twins' in-memory shape. ---

  async upsertFitnessAuditEscrowPolicy(
    row: Omit<FitnessAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.fitnessAuditEscrowPolicies.get(row.scope_key);
    const record: FitnessAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessAuditEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getFitnessAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<FitnessAuditEscrowPolicyRecord | undefined> {
    const found = this.fitnessAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessAuditEscrowDrawdown(
    row: Omit<FitnessAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.fitnessAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('fitness_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.fitnessAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('fitness_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: FitnessAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listFitnessAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.fitnessAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertFitnessAuditEscrowReconciliation(
    row: Omit<FitnessAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<FitnessAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.fitnessAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('fitness_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: FitnessAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getFitnessAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<FitnessAuditEscrowReconciliationRecord | undefined> {
    const found = this.fitnessAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleFitnessAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'fitness_audit_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertFitnessPayoutGateState(
    row: Omit<FitnessPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessPayoutGateStateRecord> {
    // UNIQUE per (payee_id, studio_franchise_code) — an upsert converges
    // (a verification heals 'unknown'; states never regress through this
    // table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.studio_franchise_code}`;
    const existing = this.fitnessPayoutGateStates.get(key);
    const record: FitnessPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getFitnessPayoutGateState(
    payeeId: string,
    studioFranchiseCode: string,
  ): Promise<FitnessPayoutGateStateRecord | undefined> {
    const found = this.fitnessPayoutGateStates.get(`${payeeId}|${studioFranchiseCode}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertCulinaryAuditEscrowPolicy(
    row: Omit<CulinaryAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.culinaryAuditEscrowPolicies.get(row.scope_key);
    const record: CulinaryAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.culinaryAuditEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getCulinaryAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<CulinaryAuditEscrowPolicyRecord | undefined> {
    const found = this.culinaryAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertCulinaryAuditEscrowDrawdown(
    row: Omit<CulinaryAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.culinaryAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('culinary_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.culinaryAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('culinary_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: CulinaryAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.culinaryAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listCulinaryAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<CulinaryAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.culinaryAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertCulinaryAuditEscrowReconciliation(
    row: Omit<CulinaryAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.culinaryAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('culinary_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: CulinaryAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.culinaryAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getCulinaryAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<CulinaryAuditEscrowReconciliationRecord | undefined> {
    const found = this.culinaryAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleCulinaryAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'culinary_audit_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertCulinaryPayoutGateState(
    row: Omit<CulinaryPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryPayoutGateStateRecord> {
    // UNIQUE per (payee_id, ghost_kitchen_location_code) — an upsert
    // converges (a verification heals 'unknown'; states never regress
    // through this table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.ghost_kitchen_location_code}`;
    const existing = this.culinaryPayoutGateStates.get(key);
    const record: CulinaryPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.culinaryPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getCulinaryPayoutGateState(
    payeeId: string,
    ghostKitchenLocationCode: string,
  ): Promise<CulinaryPayoutGateStateRecord | undefined> {
    const found = this.culinaryPayoutGateStates.get(
      `${payeeId}|${ghostKitchenLocationCode}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertCulinaryPopupExperience(
    row: Omit<CulinaryPopupExperienceRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<CulinaryPopupExperienceRecord> {
    // Insert-as-lock — UNIQUE per popup_ref: the FIRST registration
    // wins; a re-shipped sheet or a lost race throws here (the caller
    // reads the winner through the getter).
    if (this.culinaryPopupExperiences.has(row.popup_ref)) {
      uniqueViolation('culinary_popup_experiences.popup_ref');
    }
    const record: CulinaryPopupExperienceRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.culinaryPopupExperiences.set(row.popup_ref, record);
    return { ...record };
  }

  async getCulinaryPopupExperience(
    popupRef: string,
  ): Promise<CulinaryPopupExperienceRecord | undefined> {
    const found = this.culinaryPopupExperiences.get(popupRef);
    return found === undefined ? undefined : { ...found };
  }

  async insertCulinaryPopupWriteoff(
    row: Omit<CulinaryPopupWriteoffRecord, 'id' | 'created_at'>,
  ): Promise<CulinaryPopupWriteoffRecord> {
    // UNIQUE per (popup_experience_id, source_event_id) — a replayed
    // calculation throws, never a double-priced write-off.
    if (
      this.culinaryPopupWriteoffs.some(
        (existing) =>
          existing.popup_experience_id === row.popup_experience_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('culinary_popup_writeoffs.popup_experience_id,source_event_id');
    }
    const record: CulinaryPopupWriteoffRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.culinaryPopupWriteoffs.push(record);
    return { ...record };
  }

  async listCulinaryPopupWriteoffs(
    popupExperienceId: string,
  ): Promise<CulinaryPopupWriteoffRecord[]> {
    return this.culinaryPopupWriteoffs
      .filter((row) => row.popup_experience_id === popupExperienceId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((row) => ({ ...row }));
  }

  async upsertServiceAuditEscrowPolicy(
    row: Omit<ServiceAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.serviceAuditEscrowPolicies.get(row.scope_key);
    const record: ServiceAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.serviceAuditEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getServiceAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<ServiceAuditEscrowPolicyRecord | undefined> {
    const found = this.serviceAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceAuditEscrowDrawdown(
    row: Omit<ServiceAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<ServiceAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.serviceAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.serviceAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('service_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: ServiceAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listServiceAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<ServiceAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.serviceAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertServiceAuditEscrowReconciliation(
    row: Omit<ServiceAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.serviceAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('service_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: ServiceAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getServiceAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<ServiceAuditEscrowReconciliationRecord | undefined> {
    const found = this.serviceAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleServiceAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'service_audit_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertServicesPayoutGateState(
    row: Omit<ServicesPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServicesPayoutGateStateRecord> {
    // UNIQUE per (payee_id, salon_location_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.salon_location_id}`;
    const existing = this.servicesPayoutGateStates.get(key);
    const record: ServicesPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.servicesPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getServicesPayoutGateState(
    payeeId: string,
    salonLocationId: string,
  ): Promise<ServicesPayoutGateStateRecord | undefined> {
    const found = this.servicesPayoutGateStates.get(
      `${payeeId}|${salonLocationId}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertSoftwareAuditEscrowPolicy(
    row: Omit<SoftwareAuditEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SoftwareAuditEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.softwareAuditEscrowPolicies.get(row.scope_key);
    const record: SoftwareAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.softwareAuditEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getSoftwareAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<SoftwareAuditEscrowPolicyRecord | undefined> {
    const found = this.softwareAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertSoftwareAuditEscrowDrawdown(
    row: Omit<SoftwareAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<SoftwareAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.softwareAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('software_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.softwareAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('software_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: SoftwareAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.softwareAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listSoftwareAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<SoftwareAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.softwareAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertSoftwareAuditEscrowReconciliation(
    row: Omit<SoftwareAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<SoftwareAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.softwareAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('software_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: SoftwareAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.softwareAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getSoftwareAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<SoftwareAuditEscrowReconciliationRecord | undefined> {
    const found = this.softwareAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleSoftwareAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'software_audit_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertSoftwarePayoutGateState(
    row: Omit<SoftwarePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SoftwarePayoutGateStateRecord> {
    // UNIQUE per (payee_id, api_endpoint_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.api_endpoint_id}`;
    const existing = this.softwarePayoutGateStates.get(key);
    const record: SoftwarePayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.softwarePayoutGateStates.set(key, record);
    return { ...record };
  }

  async getSoftwarePayoutGateState(
    payeeId: string,
    apiEndpointId: string,
  ): Promise<SoftwarePayoutGateStateRecord | undefined> {
    const found = this.softwarePayoutGateStates.get(
      `${payeeId}|${apiEndpointId}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertPatentLitigationEscrowPolicy(
    row: Omit<PatentLitigationEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<PatentLitigationEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.patentLitigationEscrowPolicies.get(row.scope_key);
    const record: PatentLitigationEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.patentLitigationEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getPatentLitigationEscrowPolicy(
    scopeKey: string,
  ): Promise<PatentLitigationEscrowPolicyRecord | undefined> {
    const found = this.patentLitigationEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertPatentLitigationEscrowDrawdown(
    row: Omit<PatentLitigationEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<PatentLitigationEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.patentLitigationEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('hardware_patent_litigation_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.patentLitigationEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('hardware_patent_litigation_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: PatentLitigationEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.patentLitigationEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listPatentLitigationEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<PatentLitigationEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.patentLitigationEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertPatentLitigationEscrowReconciliation(
    row: Omit<PatentLitigationEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<PatentLitigationEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.patentLitigationEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('hardware_patent_litigation_escrow_reconciliations.reserve_ledger_id');
    }
    const record: PatentLitigationEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.patentLitigationEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getPatentLitigationEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<PatentLitigationEscrowReconciliationRecord | undefined> {
    const found = this.patentLitigationEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settlePatentLitigationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'patent_litigation_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertHardwarePayoutGateState(
    row: Omit<HardwarePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePayoutGateStateRecord> {
    // UNIQUE per (payee_id, sep_pool_code) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.sep_pool_code}`;
    const existing = this.hardwarePayoutGateStates.get(key);
    const record: HardwarePayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.hardwarePayoutGateStates.set(key, record);
    return { ...record };
  }

  async getHardwarePayoutGateState(
    payeeId: string,
    sepPoolCode: string,
  ): Promise<HardwarePayoutGateStateRecord | undefined> {
    const found = this.hardwarePayoutGateStates.get(`${payeeId}|${sepPoolCode}`);
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwareCrossLicenseNetDispatch(
    row: Omit<HardwareCrossLicenseNetDispatchRecord, 'id' | 'created_at'>,
  ): Promise<HardwareCrossLicenseNetDispatchRecord> {
    // UNIQUE per (agreement_ref, period, net_before_cents,
    // net_after_cents) — the replay guard AND the concurrency arbiter
    // (insert-as-lock): a replayed trigger at the same settlement state
    // or a lost race throws here, never a double dispatch. net_before is
    // in the tuple so a re-net that revisits an earlier net cannot
    // collide with the row that first reached it.
    if (
      this.hardwareCrossLicenseNetDispatches.some(
        (existing) =>
          existing.agreement_ref === row.agreement_ref &&
          existing.period === row.period &&
          existing.net_before_cents === row.net_before_cents &&
          existing.net_after_cents === row.net_after_cents,
      )
    ) {
      uniqueViolation(
        'hardware_cross_license_net_dispatches.agreement_ref,period,net_before_cents,net_after_cents',
      );
    }
    const record: HardwareCrossLicenseNetDispatchRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwareCrossLicenseNetDispatches.push(record);
    return { ...record };
  }

  async listHardwareCrossLicenseNetDispatches(
    agreementRef: string,
    period: string,
  ): Promise<HardwareCrossLicenseNetDispatchRecord[]> {
    // Chronological execution order: created_at ASC with net_before_cents
    // ASC as the tiebreak — the cumulative dispatched position strictly
    // advances as dispatches land.
    return this.hardwareCrossLicenseNetDispatches
      .filter((row) => row.agreement_ref === agreementRef && row.period === period)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.net_before_cents - b.net_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async upsertFitnessLiveEventBonusPolicy(
    row: Omit<FitnessLiveEventBonusPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FitnessLiveEventBonusPolicyRecord> {
    // UNIQUE per program_id — a re-registered policy converges (the
    // newest rate governs the next concluded event's posting).
    const now = new Date().toISOString();
    const existing = this.fitnessLiveEventBonusPolicies.get(row.program_id);
    const record: FitnessLiveEventBonusPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.fitnessLiveEventBonusPolicies.set(row.program_id, record);
    return { ...record };
  }

  async getFitnessLiveEventBonusPolicy(
    programId: string,
  ): Promise<FitnessLiveEventBonusPolicyRecord | undefined> {
    const found = this.fitnessLiveEventBonusPolicies.get(programId);
    return found === undefined ? undefined : { ...found };
  }

  async insertFitnessLiveEventBonus(
    row: Omit<FitnessLiveEventBonusRecord, 'id' | 'created_at'>,
  ): Promise<FitnessLiveEventBonusRecord> {
    // UNIQUE per source_event_id — the replay guard: a replayed event
    // row throws here, never a double bonus; the caller re-derives from
    // the ledger of record.
    if (
      this.fitnessLiveEventBonuses.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('fitness_live_event_bonuses.source_event_id');
    }
    const record: FitnessLiveEventBonusRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.fitnessLiveEventBonuses.push(record);
    return { ...record };
  }

  async getFitnessLiveEventBonus(
    sourceEventId: string,
  ): Promise<FitnessLiveEventBonusRecord | undefined> {
    const found = this.fitnessLiveEventBonuses.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  // --- PR 40, migration 0044 — the food lane (the founder food directive) ---

  async upsertFoodRecipeRoyaltySchedule(
    row: Omit<FoodRecipeRoyaltyScheduleRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodRecipeRoyaltyScheduleRecord> {
    // UNIQUE per (chef_id, recipe_id) — a re-registered schedule replaces
    // the row atomically.
    const now = new Date().toISOString();
    const key = `${row.chef_id}|${row.recipe_id}`;
    const existing = this.foodRecipeRoyaltySchedules.get(key);
    const record: FoodRecipeRoyaltyScheduleRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.foodRecipeRoyaltySchedules.set(key, record);
    return { ...record };
  }

  async getFoodRecipeRoyaltySchedule(
    chefId: string,
    recipeId: string,
  ): Promise<FoodRecipeRoyaltyScheduleRecord | undefined> {
    const found = this.foodRecipeRoyaltySchedules.get(`${chefId}|${recipeId}`);
    return found === undefined ? undefined : { ...found };
  }

  async advanceFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
    unitsAdded: number,
  ): Promise<FoodLocationUnitMonthRecord> {
    // UNIQUE per (ghost_kitchen_location_id, month) — the tracker
    // converges (an upsert adds).
    const now = new Date().toISOString();
    const key = `${ghostKitchenLocationId}|${month}`;
    const existing = this.foodLocationUnitMonths.get(key);
    const record: FoodLocationUnitMonthRecord = {
      ghost_kitchen_location_id: ghostKitchenLocationId,
      month,
      cumulative_units: (existing?.cumulative_units ?? 0) + unitsAdded,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.foodLocationUnitMonths.set(key, record);
    return { ...record };
  }

  async getFoodLocationUnitMonth(
    ghostKitchenLocationId: string,
    month: string,
  ): Promise<FoodLocationUnitMonthRecord | undefined> {
    const found = this.foodLocationUnitMonths.get(`${ghostKitchenLocationId}|${month}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFoodHostOperatorPolicy(
    row: Omit<FoodHostOperatorPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodHostOperatorPolicyRecord> {
    // UNIQUE per ghost_kitchen_location_id — a re-registered policy
    // replaces the row atomically.
    const now = new Date().toISOString();
    const existing = this.foodHostOperatorPolicies.get(row.ghost_kitchen_location_id);
    const record: FoodHostOperatorPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.foodHostOperatorPolicies.set(row.ghost_kitchen_location_id, record);
    return { ...record };
  }

  async getFoodHostOperatorPolicy(
    ghostKitchenLocationId: string,
  ): Promise<FoodHostOperatorPolicyRecord | undefined> {
    const found = this.foodHostOperatorPolicies.get(ghostKitchenLocationId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFoodCookCyclePolicy(
    row: Omit<FoodCookCyclePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCookCyclePolicyRecord> {
    // UNIQUE per (chef_id, recipe_id) — a re-registered policy replaces
    // the row atomically.
    const now = new Date().toISOString();
    const key = `${row.chef_id}|${row.recipe_id}`;
    const existing = this.foodCookCyclePolicies.get(key);
    const record: FoodCookCyclePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.foodCookCyclePolicies.set(key, record);
    return { ...record };
  }

  async getFoodCookCyclePolicy(
    chefId: string,
    recipeId: string,
  ): Promise<FoodCookCyclePolicyRecord | undefined> {
    const found = this.foodCookCyclePolicies.get(`${chefId}|${recipeId}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertFoodCobrandWeighting(
    row: Omit<FoodCobrandWeightingRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodCobrandWeightingRecord> {
    // UNIQUE per (recipe_id, leg_id) — a re-registered leg converges.
    const now = new Date().toISOString();
    const index = this.foodCobrandWeightings.findIndex(
      (leg) => leg.recipe_id === row.recipe_id && leg.leg_id === row.leg_id,
    );
    if (index >= 0) {
      const existing = this.foodCobrandWeightings[index] as FoodCobrandWeightingRecord;
      const record: FoodCobrandWeightingRecord = {
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
      };
      this.foodCobrandWeightings[index] = record;
      return { ...record };
    }
    const record: FoodCobrandWeightingRecord = {
      ...row,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.foodCobrandWeightings.push(record);
    return { ...record };
  }

  async listFoodCobrandWeightings(recipeId: string): Promise<FoodCobrandWeightingRecord[]> {
    // Registration order (the insertion order the split walk reads).
    return this.foodCobrandWeightings
      .filter((leg) => leg.recipe_id === recipeId)
      .map((leg) => ({ ...leg }));
  }

  async upsertFoodOperatorWaterfallLeg(
    row: Omit<FoodOperatorWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<FoodOperatorWaterfallRecord> {
    // UNIQUE per (ghost_kitchen_location_id, operator_id) — a
    // re-registered leg converges.
    const now = new Date().toISOString();
    const index = this.foodOperatorWaterfalls.findIndex(
      (leg) =>
        leg.ghost_kitchen_location_id === row.ghost_kitchen_location_id &&
        leg.operator_id === row.operator_id,
    );
    if (index >= 0) {
      const existing = this.foodOperatorWaterfalls[index] as FoodOperatorWaterfallRecord;
      const record: FoodOperatorWaterfallRecord = {
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
      };
      this.foodOperatorWaterfalls[index] = record;
      return { ...record };
    }
    const record: FoodOperatorWaterfallRecord = {
      ...row,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.foodOperatorWaterfalls.push(record);
    return { ...record };
  }

  async listFoodOperatorWaterfallLegs(
    ghostKitchenLocationId: string,
  ): Promise<FoodOperatorWaterfallRecord[]> {
    // Registration order (the insertion order the rebate walk reads).
    return this.foodOperatorWaterfalls
      .filter((leg) => leg.ghost_kitchen_location_id === ghostKitchenLocationId)
      .map((leg) => ({ ...leg }));
  }

  async insertFoodRealizationApplication(
    row: Omit<FoodRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard: a re-walked order
    // throws here, never a double application.
    if (
      this.foodRealizationApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('food_realization_applications.source_event_id');
    }
    const record: FoodRealizationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.foodRealizationApplications.push(record);
    return { ...record };
  }

  async getFoodRealizationApplication(
    sourceEventId: string,
  ): Promise<FoodRealizationApplicationRecord | undefined> {
    const found = this.foodRealizationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFoodRecipeRoyaltyApplication(
    row: Omit<FoodRecipeRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodRecipeRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.foodRecipeRoyaltyApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('food_recipe_royalty_applications.source_event_id');
    }
    const record: FoodRecipeRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.foodRecipeRoyaltyApplications.push(record);
    return { ...record };
  }

  async getFoodRecipeRoyaltyApplication(
    sourceEventId: string,
  ): Promise<FoodRecipeRoyaltyApplicationRecord | undefined> {
    const found = this.foodRecipeRoyaltyApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFoodCobrandSplitApplication(
    row: Omit<FoodCobrandSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodCobrandSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.foodCobrandSplitApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('food_cobrand_split_applications.source_event_id');
    }
    const record: FoodCobrandSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.foodCobrandSplitApplications.push(record);
    return { ...record };
  }

  async getFoodCobrandSplitApplication(
    sourceEventId: string,
  ): Promise<FoodCobrandSplitApplicationRecord | undefined> {
    const found = this.foodCobrandSplitApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFoodHostOperatorSplitApplication(
    row: Omit<FoodHostOperatorSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodHostOperatorSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.foodHostOperatorSplitApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('food_host_operator_split_applications.source_event_id');
    }
    const record: FoodHostOperatorSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.foodHostOperatorSplitApplications.push(record);
    return { ...record };
  }

  async getFoodHostOperatorSplitApplication(
    sourceEventId: string,
  ): Promise<FoodHostOperatorSplitApplicationRecord | undefined> {
    const found = this.foodHostOperatorSplitApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFoodCookCycleRoyalty(
    row: Omit<FoodCookCycleRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<FoodCookCycleRoyaltyRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.foodCookCycleRoyalties.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('food_cook_cycle_royalties.source_event_id');
    }
    const record: FoodCookCycleRoyaltyRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.foodCookCycleRoyalties.push(record);
    return { ...record };
  }

  async getFoodCookCycleRoyalty(
    sourceEventId: string,
  ): Promise<FoodCookCycleRoyaltyRecord | undefined> {
    const found = this.foodCookCycleRoyalties.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertFoodSupplierRebateApplication(
    row: Omit<FoodSupplierRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<FoodSupplierRebateApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.foodSupplierRebateApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('food_supplier_rebate_applications.source_event_id');
    }
    const record: FoodSupplierRebateApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.foodSupplierRebateApplications.push(record);
    return { ...record };
  }

  async getFoodSupplierRebateApplication(
    sourceEventId: string,
  ): Promise<FoodSupplierRebateApplicationRecord | undefined> {
    const found = this.foodSupplierRebateApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
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
    const now = new Date().toISOString();
    const existing = this.serviceFranchiseSchedules.get(row.salon_location_id);
    const record: ServiceFranchiseScheduleRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.serviceFranchiseSchedules.set(row.salon_location_id, record);
    return { ...record };
  }

  async getServiceFranchiseSchedule(
    salonLocationId: string,
  ): Promise<ServiceFranchiseScheduleRecord | undefined> {
    const found = this.serviceFranchiseSchedules.get(salonLocationId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertServiceProtocolPolicy(
    row: Omit<ServiceProtocolPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceProtocolPolicyRecord> {
    // UNIQUE per protocol_id — a re-registered policy replaces the row
    // atomically.
    const now = new Date().toISOString();
    const existing = this.serviceProtocolPolicies.get(row.protocol_id);
    const record: ServiceProtocolPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.serviceProtocolPolicies.set(row.protocol_id, record);
    return { ...record };
  }

  async getServiceProtocolPolicy(
    protocolId: string,
  ): Promise<ServiceProtocolPolicyRecord | undefined> {
    const found = this.serviceProtocolPolicies.get(protocolId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertServiceRedemptionPolicy(
    row: Omit<ServiceRedemptionPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceRedemptionPolicyRecord> {
    // UNIQUE per home_location_id — a re-registered policy replaces the
    // row atomically.
    const now = new Date().toISOString();
    const existing = this.serviceRedemptionPolicies.get(row.home_location_id);
    const record: ServiceRedemptionPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.serviceRedemptionPolicies.set(row.home_location_id, record);
    return { ...record };
  }

  async getServiceRedemptionPolicy(
    homeLocationId: string,
  ): Promise<ServiceRedemptionPolicyRecord | undefined> {
    const found = this.serviceRedemptionPolicies.get(homeLocationId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertServiceBreakagePolicy(
    row: Omit<ServiceBreakagePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceBreakagePolicyRecord> {
    // UNIQUE per home_location_id — a re-registered policy replaces the
    // row atomically.
    const now = new Date().toISOString();
    const existing = this.serviceBreakagePolicies.get(row.home_location_id);
    const record: ServiceBreakagePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.serviceBreakagePolicies.set(row.home_location_id, record);
    return { ...record };
  }

  async getServiceBreakagePolicy(
    homeLocationId: string,
  ): Promise<ServiceBreakagePolicyRecord | undefined> {
    const found = this.serviceBreakagePolicies.get(homeLocationId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertServiceRebateWaterfallLeg(
    row: Omit<ServiceRebateWaterfallRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceRebateWaterfallRecord> {
    // UNIQUE per (salon_location_id, ledger_id) — a re-registered leg
    // converges.
    const now = new Date().toISOString();
    const index = this.serviceRebateWaterfalls.findIndex(
      (leg) =>
        leg.salon_location_id === row.salon_location_id &&
        leg.ledger_id === row.ledger_id,
    );
    if (index >= 0) {
      const existing = this.serviceRebateWaterfalls[index] as ServiceRebateWaterfallRecord;
      const record: ServiceRebateWaterfallRecord = {
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
      };
      this.serviceRebateWaterfalls[index] = record;
      return { ...record };
    }
    const record: ServiceRebateWaterfallRecord = {
      ...row,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.serviceRebateWaterfalls.push(record);
    return { ...record };
  }

  async listServiceRebateWaterfallLegs(
    salonLocationId: string,
  ): Promise<ServiceRebateWaterfallRecord[]> {
    // Registration order (the insertion order the rebate walk reads).
    return this.serviceRebateWaterfalls
      .filter((leg) => leg.salon_location_id === salonLocationId)
      .map((leg) => ({ ...leg }));
  }

  async upsertServiceBoothLeasePolicy(
    row: Omit<ServiceBoothLeasePolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ServiceBoothLeasePolicyRecord> {
    // UNIQUE per salon_location_id — a re-registered policy replaces
    // the row atomically.
    const now = new Date().toISOString();
    const existing = this.serviceBoothLeasePolicies.get(row.salon_location_id);
    const record: ServiceBoothLeasePolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.serviceBoothLeasePolicies.set(row.salon_location_id, record);
    return { ...record };
  }

  async getServiceBoothLeasePolicy(
    salonLocationId: string,
  ): Promise<ServiceBoothLeasePolicyRecord | undefined> {
    const found = this.serviceBoothLeasePolicies.get(salonLocationId);
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceRealizationApplication(
    row: Omit<ServiceRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceRealizationApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_realization_applications.source_event_id');
    }
    const record: ServiceRealizationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceRealizationApplications.push(record);
    return { ...record };
  }

  async getServiceRealizationApplication(
    sourceEventId: string,
  ): Promise<ServiceRealizationApplicationRecord | undefined> {
    const found = this.serviceRealizationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceFranchiseSplitApplication(
    row: Omit<ServiceFranchiseSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceFranchiseSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceFranchiseSplits.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_franchise_splits.source_event_id');
    }
    const record: ServiceFranchiseSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceFranchiseSplits.push(record);
    return { ...record };
  }

  async getServiceFranchiseSplitApplication(
    sourceEventId: string,
  ): Promise<ServiceFranchiseSplitApplicationRecord | undefined> {
    const found = this.serviceFranchiseSplits.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceProtocolMicroRoyalty(
    row: Omit<ServiceProtocolMicroRoyaltyRecord, 'id' | 'created_at'>,
  ): Promise<ServiceProtocolMicroRoyaltyRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceProtocolRoyalties.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_protocol_micro_royalties.source_event_id');
    }
    const record: ServiceProtocolMicroRoyaltyRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceProtocolRoyalties.push(record);
    return { ...record };
  }

  async getServiceProtocolMicroRoyalty(
    sourceEventId: string,
  ): Promise<ServiceProtocolMicroRoyaltyRecord | undefined> {
    const found = this.serviceProtocolRoyalties.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceRedemptionSplitApplication(
    row: Omit<ServiceRedemptionSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRedemptionSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceRedemptionSplits.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_redemption_splits.source_event_id');
    }
    const record: ServiceRedemptionSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceRedemptionSplits.push(record);
    return { ...record };
  }

  async getServiceRedemptionSplitApplication(
    sourceEventId: string,
  ): Promise<ServiceRedemptionSplitApplicationRecord | undefined> {
    const found = this.serviceRedemptionSplits.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceBreakageAllocation(
    row: Omit<ServiceBreakageAllocationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceBreakageAllocationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceBreakageAllocations.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_breakage_allocations.source_event_id');
    }
    const record: ServiceBreakageAllocationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceBreakageAllocations.push(record);
    return { ...record };
  }

  async getServiceBreakageAllocation(
    sourceEventId: string,
  ): Promise<ServiceBreakageAllocationRecord | undefined> {
    const found = this.serviceBreakageAllocations.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceRebateApplication(
    row: Omit<ServiceRebateApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceRebateApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceRebateApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_rebate_applications.source_event_id');
    }
    const record: ServiceRebateApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceRebateApplications.push(record);
    return { ...record };
  }

  async getServiceRebateApplication(
    sourceEventId: string,
  ): Promise<ServiceRebateApplicationRecord | undefined> {
    const found = this.serviceRebateApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertServiceBoothLeaseApplication(
    row: Omit<ServiceBoothLeaseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<ServiceBoothLeaseApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.serviceBoothLeaseSplits.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('service_booth_lease_splits.source_event_id');
    }
    const record: ServiceBoothLeaseApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.serviceBoothLeaseSplits.push(record);
    return { ...record };
  }

  async getServiceBoothLeaseApplication(
    sourceEventId: string,
  ): Promise<ServiceBoothLeaseApplicationRecord | undefined> {
    const found = this.serviceBoothLeaseSplits.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
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
    // atomically.
    const now = new Date().toISOString();
    const existing = this.developerApiRoyaltyPolicies.get(row.developer_id);
    const record: DeveloperApiRoyaltyPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerApiRoyaltyPolicies.set(row.developer_id, record);
    return { ...record };
  }

  async getDeveloperApiRoyaltyPolicy(
    developerId: string,
  ): Promise<DeveloperApiRoyaltyPolicyRecord | undefined> {
    const found = this.developerApiRoyaltyPolicies.get(developerId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertDeveloperMarketplacePolicy(
    row: Omit<DeveloperMarketplaceSplitPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperMarketplaceSplitPolicyRecord> {
    // UNIQUE per marketplace — a re-registered policy replaces the row
    // atomically.
    const now = new Date().toISOString();
    const existing = this.developerMarketplacePolicies.get(row.marketplace);
    const record: DeveloperMarketplaceSplitPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerMarketplacePolicies.set(row.marketplace, record);
    return { ...record };
  }

  async getDeveloperMarketplacePolicy(
    marketplace: string,
  ): Promise<DeveloperMarketplaceSplitPolicyRecord | undefined> {
    const found = this.developerMarketplacePolicies.get(marketplace);
    return found === undefined ? undefined : { ...found };
  }

  async upsertDeveloperCopackageLeg(
    row: Omit<DeveloperCopackageContributionLegRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperCopackageContributionLegRecord> {
    // UNIQUE per (package_id, maintainer_id) — a re-registered leg
    // replaces its row in place (registration order preserved).
    const now = new Date().toISOString();
    const index = this.developerCopackageLegs.findIndex(
      (leg) =>
        leg.package_id === row.package_id && leg.maintainer_id === row.maintainer_id,
    );
    const prior = index >= 0 ? this.developerCopackageLegs[index] : undefined;
    const record: DeveloperCopackageContributionLegRecord = {
      ...row,
      id: prior?.id ?? randomUUID(),
      created_at: prior?.created_at ?? now,
      updated_at: now,
    };
    if (index >= 0) {
      this.developerCopackageLegs[index] = record;
    } else {
      this.developerCopackageLegs.push(record);
    }
    return { ...record };
  }

  async listDeveloperCopackageLegs(
    packageId: string,
  ): Promise<DeveloperCopackageContributionLegRecord[]> {
    return this.developerCopackageLegs
      .filter((leg) => leg.package_id === packageId)
      .map((leg) => ({ ...leg }));
  }

  async upsertDeveloperDependencyLedger(
    row: Omit<DeveloperDependencyMaintainerLedgerRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperDependencyMaintainerLedgerRecord> {
    // UNIQUE per component_id — a re-registered ledger replaces the row
    // atomically.
    const now = new Date().toISOString();
    const existing = this.developerDependencyLedgers.get(row.component_id);
    const record: DeveloperDependencyMaintainerLedgerRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerDependencyLedgers.set(row.component_id, record);
    return { ...record };
  }

  async getDeveloperDependencyLedger(
    componentId: string,
  ): Promise<DeveloperDependencyMaintainerLedgerRecord | undefined> {
    const found = this.developerDependencyLedgers.get(componentId);
    return found === undefined ? undefined : { ...found };
  }

  async upsertDeveloperWhitelabelDeal(
    row: Omit<DeveloperWhitelabelLicenseDealRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperWhitelabelLicenseDealRecord> {
    // UNIQUE per sdk_package_hash — a re-registered deal replaces the
    // row atomically.
    const now = new Date().toISOString();
    const existing = this.developerWhitelabelDeals.get(row.sdk_package_hash);
    const record: DeveloperWhitelabelLicenseDealRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerWhitelabelDeals.set(row.sdk_package_hash, record);
    return { ...record };
  }

  async getDeveloperWhitelabelDeal(
    sdkPackageHash: string,
  ): Promise<DeveloperWhitelabelLicenseDealRecord | undefined> {
    const found = this.developerWhitelabelDeals.get(sdkPackageHash);
    return found === undefined ? undefined : { ...found };
  }

  async upsertDeveloperToolPolicy(
    row: Omit<DeveloperToolRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<DeveloperToolRoyaltyPolicyRecord> {
    // UNIQUE per tool_id — a re-registered policy replaces the row
    // atomically.
    const now = new Date().toISOString();
    const existing = this.developerToolPolicies.get(row.tool_id);
    const record: DeveloperToolRoyaltyPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerToolPolicies.set(row.tool_id, record);
    return { ...record };
  }

  async getDeveloperToolPolicy(
    toolId: string,
  ): Promise<DeveloperToolRoyaltyPolicyRecord | undefined> {
    const found = this.developerToolPolicies.get(toolId);
    return found === undefined ? undefined : { ...found };
  }

  async advanceDeveloperApiCallMonth(
    developerId: string,
    month: string,
    callsAdded: number,
  ): Promise<DeveloperApiCallMonthRecord> {
    const key = `${developerId}\u0000${month}`;
    const now = new Date().toISOString();
    const existing = this.developerApiCallMonths.get(key);
    const record: DeveloperApiCallMonthRecord = {
      id: existing?.id ?? randomUUID(),
      developer_id: developerId,
      month,
      cumulative_calls: (existing?.cumulative_calls ?? 0) + callsAdded,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerApiCallMonths.set(key, record);
    return { ...record };
  }

  async getDeveloperApiCallMonth(
    developerId: string,
    month: string,
  ): Promise<DeveloperApiCallMonthRecord | undefined> {
    const found = this.developerApiCallMonths.get(`${developerId}\u0000${month}`);
    return found === undefined ? undefined : { ...found };
  }

  async advanceDeveloperWhitelabelUsageMonth(
    sdkPackageHash: string,
    licensorId: string,
    month: string,
    usageCentsAdded: number,
  ): Promise<DeveloperWhitelabelUsageMonthRecord> {
    const key = `${sdkPackageHash}\u0000${licensorId}\u0000${month}`;
    const now = new Date().toISOString();
    const existing = this.developerWhitelabelUsageMonths.get(key);
    const record: DeveloperWhitelabelUsageMonthRecord = {
      id: existing?.id ?? randomUUID(),
      sdk_package_hash: sdkPackageHash,
      licensor_id: licensorId,
      month,
      cumulative_usage_cents: (existing?.cumulative_usage_cents ?? 0) + usageCentsAdded,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.developerWhitelabelUsageMonths.set(key, record);
    return { ...record };
  }

  async getDeveloperWhitelabelUsageMonth(
    sdkPackageHash: string,
    licensorId: string,
    month: string,
  ): Promise<DeveloperWhitelabelUsageMonthRecord | undefined> {
    const found = this.developerWhitelabelUsageMonths.get(
      `${sdkPackageHash}\u0000${licensorId}\u0000${month}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperRealizationApplication(
    row: Omit<DeveloperApiRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperApiRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerRealizationApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_api_realization_applications.source_event_id');
    }
    const record: DeveloperApiRealizationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerRealizationApplications.push(record);
    return { ...record };
  }

  async getDeveloperRealizationApplication(
    sourceEventId: string,
  ): Promise<DeveloperApiRealizationApplicationRecord | undefined> {
    const found = this.developerRealizationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperApiMicroRoyalty(
    row: Omit<DeveloperApiMicroRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperApiMicroRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerApiMicroRoyalties.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_api_micro_royalty_applications.source_event_id');
    }
    const record: DeveloperApiMicroRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerApiMicroRoyalties.push(record);
    return { ...record };
  }

  async getDeveloperApiMicroRoyalty(
    sourceEventId: string,
  ): Promise<DeveloperApiMicroRoyaltyApplicationRecord | undefined> {
    const found = this.developerApiMicroRoyalties.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperMarketplaceSplit(
    row: Omit<DeveloperMarketplaceSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperMarketplaceSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerMarketplaceSplits.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_marketplace_split_applications.source_event_id');
    }
    const record: DeveloperMarketplaceSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerMarketplaceSplits.push(record);
    return { ...record };
  }

  async getDeveloperMarketplaceSplit(
    sourceEventId: string,
  ): Promise<DeveloperMarketplaceSplitApplicationRecord | undefined> {
    const found = this.developerMarketplaceSplits.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperCopackageSplit(
    row: Omit<DeveloperCopackageSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperCopackageSplitApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerCopackageSplits.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_copackage_split_applications.source_event_id');
    }
    const record: DeveloperCopackageSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerCopackageSplits.push(record);
    return { ...record };
  }

  async getDeveloperCopackageSplit(
    sourceEventId: string,
  ): Promise<DeveloperCopackageSplitApplicationRecord | undefined> {
    const found = this.developerCopackageSplits.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperDependencyFee(
    row: Omit<DeveloperDependencyFeeApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperDependencyFeeApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerDependencyFees.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_dependency_fee_applications.source_event_id');
    }
    const record: DeveloperDependencyFeeApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerDependencyFees.push(record);
    return { ...record };
  }

  async getDeveloperDependencyFee(
    sourceEventId: string,
  ): Promise<DeveloperDependencyFeeApplicationRecord | undefined> {
    const found = this.developerDependencyFees.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperWhitelabelLicense(
    row: Omit<DeveloperWhitelabelLicenseApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperWhitelabelLicenseApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerWhitelabelLicenses.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_whitelabel_license_applications.source_event_id');
    }
    const record: DeveloperWhitelabelLicenseApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerWhitelabelLicenses.push(record);
    return { ...record };
  }

  async getDeveloperWhitelabelLicense(
    sourceEventId: string,
  ): Promise<DeveloperWhitelabelLicenseApplicationRecord | undefined> {
    const found = this.developerWhitelabelLicenses.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertDeveloperToolCallApplication(
    row: Omit<DeveloperAgentToolCallApplicationRecord, 'id' | 'created_at'>,
  ): Promise<DeveloperAgentToolCallApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.developerToolCallApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('developer_agent_tool_call_applications.source_event_id');
    }
    const record: DeveloperAgentToolCallApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.developerToolCallApplications.push(record);
    return { ...record };
  }

  async getDeveloperToolCallApplication(
    sourceEventId: string,
  ): Promise<DeveloperAgentToolCallApplicationRecord | undefined> {
    const found = this.developerToolCallApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  // -------------------------------------------------------------------------
  // The hardware patent lane (PR 46, migration 0050) — the founder
  // hardware directive's registries, tracker, and application ledgers.
  // -------------------------------------------------------------------------

  async upsertHardwarePatentPool(
    row: Omit<HardwarePatentPoolRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePatentPoolRecord> {
    // One pool of record per pool_code — INSERT ON CONFLICT replaces the
    // row atomically.
    const existing = this.hardwarePatentPools.find(
      (candidate) => candidate.pool_code === row.pool_code,
    );
    const now = new Date().toISOString();
    const record: HardwarePatentPoolRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwarePatentPools[this.hardwarePatentPools.indexOf(existing)] = record;
    } else {
      this.hardwarePatentPools.push(record);
    }
    return { ...record };
  }

  async getHardwarePatentPool(
    poolCode: string,
  ): Promise<HardwarePatentPoolRecord | undefined> {
    const found = this.hardwarePatentPools.find(
      (record) => record.pool_code === poolCode,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertHardwarePoolHolderLeg(
    row: Omit<HardwarePoolHolderLegRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwarePoolHolderLegRecord> {
    // One verified weighting per (pool_code, holder_payee_id) — the
    // re-registration converges.
    const existing = this.hardwarePoolHolderLegs.find(
      (candidate) =>
        candidate.pool_code === row.pool_code &&
        candidate.holder_payee_id === row.holder_payee_id,
    );
    const now = new Date().toISOString();
    const record: HardwarePoolHolderLegRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwarePoolHolderLegs[this.hardwarePoolHolderLegs.indexOf(existing)] = record;
    } else {
      this.hardwarePoolHolderLegs.push(record);
    }
    return { ...record };
  }

  async listHardwarePoolHolderLegs(poolCode: string): Promise<HardwarePoolHolderLegRecord[]> {
    // Registration order — the waterfall's deterministic leg order.
    return this.hardwarePoolHolderLegs
      .filter((record) => record.pool_code === poolCode)
      .map((record) => ({ ...record }));
  }

  async upsertHardwareSepRoyaltyPolicy(
    row: Omit<HardwareSepRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareSepRoyaltyPolicyRecord> {
    // One policy of record per (patent_family_id, sep_pool_code).
    const existing = this.hardwareSepRoyaltyPolicies.find(
      (candidate) =>
        candidate.patent_family_id === row.patent_family_id &&
        candidate.sep_pool_code === row.sep_pool_code,
    );
    const now = new Date().toISOString();
    const record: HardwareSepRoyaltyPolicyRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwareSepRoyaltyPolicies[this.hardwareSepRoyaltyPolicies.indexOf(existing)] = record;
    } else {
      this.hardwareSepRoyaltyPolicies.push(record);
    }
    return { ...record };
  }

  async getHardwareSepRoyaltyPolicy(
    patentFamilyId: string,
    sepPoolCode: string,
  ): Promise<HardwareSepRoyaltyPolicyRecord | undefined> {
    const found = this.hardwareSepRoyaltyPolicies.find(
      (record) =>
        record.patent_family_id === patentFamilyId && record.sep_pool_code === sepPoolCode,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertHardwareAutomotivePoolAssignment(
    row: Omit<HardwareAutomotivePoolAssignmentRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareAutomotivePoolAssignmentRecord> {
    // One routing of record per (oem_id, line_id).
    const existing = this.hardwareAutomotivePoolAssignments.find(
      (candidate) => candidate.oem_id === row.oem_id && candidate.line_id === row.line_id,
    );
    const now = new Date().toISOString();
    const record: HardwareAutomotivePoolAssignmentRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwareAutomotivePoolAssignments[
        this.hardwareAutomotivePoolAssignments.indexOf(existing)
      ] = record;
    } else {
      this.hardwareAutomotivePoolAssignments.push(record);
    }
    return { ...record };
  }

  async getHardwareAutomotivePoolAssignment(
    oemId: string,
    lineId: string,
  ): Promise<HardwareAutomotivePoolAssignmentRecord | undefined> {
    const found = this.hardwareAutomotivePoolAssignments.find(
      (record) => record.oem_id === oemId && record.line_id === lineId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertHardwareCleanTechRoyaltyPolicy(
    row: Omit<HardwareCleanTechRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareCleanTechRoyaltyPolicyRecord> {
    // One policy of record per patent_family_id.
    const existing = this.hardwareCleanTechRoyaltyPolicies.find(
      (candidate) => candidate.patent_family_id === row.patent_family_id,
    );
    const now = new Date().toISOString();
    const record: HardwareCleanTechRoyaltyPolicyRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwareCleanTechRoyaltyPolicies[
        this.hardwareCleanTechRoyaltyPolicies.indexOf(existing)
      ] = record;
    } else {
      this.hardwareCleanTechRoyaltyPolicies.push(record);
    }
    return { ...record };
  }

  async getHardwareCleanTechRoyaltyPolicy(
    patentFamilyId: string,
  ): Promise<HardwareCleanTechRoyaltyPolicyRecord | undefined> {
    const found = this.hardwareCleanTechRoyaltyPolicies.find(
      (record) => record.patent_family_id === patentFamilyId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertHardwareOtaUnlockPolicy(
    row: Omit<HardwareOtaUnlockPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareOtaUnlockPolicyRecord> {
    // One policy of record per feature_code.
    const existing = this.hardwareOtaUnlockPolicies.find(
      (candidate) => candidate.feature_code === row.feature_code,
    );
    const now = new Date().toISOString();
    const record: HardwareOtaUnlockPolicyRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwareOtaUnlockPolicies[this.hardwareOtaUnlockPolicies.indexOf(existing)] = record;
    } else {
      this.hardwareOtaUnlockPolicies.push(record);
    }
    return { ...record };
  }

  async getHardwareOtaUnlockPolicy(
    featureCode: string,
  ): Promise<HardwareOtaUnlockPolicyRecord | undefined> {
    const found = this.hardwareOtaUnlockPolicies.find(
      (record) => record.feature_code === featureCode,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertHardwareCrossLicenseAgreement(
    row: Omit<HardwareCrossLicenseAgreementRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<HardwareCrossLicenseAgreementRecord> {
    // One agreement of record per (company_a_id, company_b_id) — the
    // canonical pair orientation.
    const existing = this.hardwareCrossLicenseAgreements.find(
      (candidate) =>
        candidate.company_a_id === row.company_a_id &&
        candidate.company_b_id === row.company_b_id,
    );
    const now = new Date().toISOString();
    const record: HardwareCrossLicenseAgreementRecord = {
      ...row,
      // The upsert of record keeps the original id and created_at — the
      // SQLite/Supabase ON CONFLICT semantics (never send the id in the
      // conflict payload; the id does not rotate).
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.hardwareCrossLicenseAgreements[
        this.hardwareCrossLicenseAgreements.indexOf(existing)
      ] = record;
    } else {
      this.hardwareCrossLicenseAgreements.push(record);
    }
    return { ...record };
  }

  async getHardwareCrossLicenseAgreement(
    companyAId: string,
    companyBId: string,
  ): Promise<HardwareCrossLicenseAgreementRecord | undefined> {
    const found = this.hardwareCrossLicenseAgreements.find(
      (record) => record.company_a_id === companyAId && record.company_b_id === companyBId,
    );
    return found === undefined ? undefined : { ...found };
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
    const existing = this.hardwareSepUnitMonths.find(
      (record) =>
        record.licensee_id === licenseeId &&
        record.patent_family_id === patentFamilyId &&
        record.sep_pool_code === sepPoolCode &&
        record.month === month,
    );
    if (existing !== undefined) {
      existing.cumulative_units += unitsAdded;
      return { ...existing };
    }
    const record: HardwareSepUnitMonthRecord = {
      id: randomUUID(),
      licensee_id: licenseeId,
      patent_family_id: patentFamilyId,
      sep_pool_code: sepPoolCode,
      month,
      cumulative_units: unitsAdded,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.hardwareSepUnitMonths.push(record);
    return { ...record };
  }

  async getHardwareSepUnitMonth(
    licenseeId: string,
    patentFamilyId: string,
    sepPoolCode: string,
    month: string,
  ): Promise<HardwareSepUnitMonthRecord | undefined> {
    const found = this.hardwareSepUnitMonths.find(
      (record) =>
        record.licensee_id === licenseeId &&
        record.patent_family_id === patentFamilyId &&
        record.sep_pool_code === sepPoolCode &&
        record.month === month,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwareRealizationApplication(
    row: Omit<HardwareRealizationApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareRealizationApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.hardwareRealizationApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('hardware_realization_applications.source_event_id');
    }
    const record: HardwareRealizationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwareRealizationApplications.push(record);
    return { ...record };
  }

  async getHardwareRealizationApplication(
    sourceEventId: string,
  ): Promise<HardwareRealizationApplicationRecord | undefined> {
    const found = this.hardwareRealizationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwareSepRoyaltyApplication(
    row: Omit<HardwareSepRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareSepRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.hardwareSepRoyaltyApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('hardware_sep_royalty_applications.source_event_id');
    }
    const record: HardwareSepRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwareSepRoyaltyApplications.push(record);
    return { ...record };
  }

  async getHardwareSepRoyaltyApplication(
    sourceEventId: string,
  ): Promise<HardwareSepRoyaltyApplicationRecord | undefined> {
    const found = this.hardwareSepRoyaltyApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwarePoolRoutingApplication(
    row: Omit<HardwarePoolRoutingApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwarePoolRoutingApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.hardwarePoolRoutingApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('hardware_pool_routing_applications.source_event_id');
    }
    const record: HardwarePoolRoutingApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwarePoolRoutingApplications.push(record);
    return { ...record };
  }

  async getHardwarePoolRoutingApplication(
    sourceEventId: string,
  ): Promise<HardwarePoolRoutingApplicationRecord | undefined> {
    const found = this.hardwarePoolRoutingApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwarePoolWaterfallApplication(
    row: Omit<HardwarePoolWaterfallApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwarePoolWaterfallApplicationRecord> {
    // UNIQUE per (routing_source_event_id, pool_code) — the replay guard.
    if (
      this.hardwarePoolWaterfallApplications.some(
        (existing) =>
          existing.routing_source_event_id === row.routing_source_event_id &&
          existing.pool_code === row.pool_code,
      )
    ) {
      uniqueViolation('hardware_pool_waterfall_applications.routing_source_event_id,pool_code');
    }
    const record: HardwarePoolWaterfallApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwarePoolWaterfallApplications.push(record);
    return { ...record };
  }

  async getHardwarePoolWaterfallApplication(
    routingSourceEventId: string,
    poolCode: string,
  ): Promise<HardwarePoolWaterfallApplicationRecord | undefined> {
    const found = this.hardwarePoolWaterfallApplications.find(
      (record) =>
        record.routing_source_event_id === routingSourceEventId &&
        record.pool_code === poolCode,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwareTelemetryRoyaltyApplication(
    row: Omit<HardwareTelemetryRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareTelemetryRoyaltyApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.hardwareTelemetryRoyaltyApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('hardware_telemetry_royalty_applications.source_event_id');
    }
    const record: HardwareTelemetryRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwareTelemetryRoyaltyApplications.push(record);
    return { ...record };
  }

  async getHardwareTelemetryRoyaltyApplication(
    sourceEventId: string,
  ): Promise<HardwareTelemetryRoyaltyApplicationRecord | undefined> {
    const found = this.hardwareTelemetryRoyaltyApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertHardwareOtaUnlockApplication(
    row: Omit<HardwareOtaUnlockApplicationRecord, 'id' | 'created_at'>,
  ): Promise<HardwareOtaUnlockApplicationRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.hardwareOtaUnlockApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('hardware_ota_unlock_applications.source_event_id');
    }
    const record: HardwareOtaUnlockApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwareOtaUnlockApplications.push(record);
    return { ...record };
  }

  async getHardwareOtaUnlockApplication(
    sourceEventId: string,
  ): Promise<HardwareOtaUnlockApplicationRecord | undefined> {
    const found = this.hardwareOtaUnlockApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertHardwareCrossLicenseNetSettlement(
    row: Omit<HardwareCrossLicenseNetSettlementRecord, 'id' | 'created_at'>,
  ): Promise<HardwareCrossLicenseNetSettlementRecord> {
    // One net clearing of record per (agreement_ref, period) — the
    // walk's recompute replaces the sums in place; the id and created_at
    // of record survive (the SQLite/Supabase ON CONFLICT parity).
    const existing = this.hardwareCrossLicenseNetSettlements.find(
      (candidate) =>
        candidate.agreement_ref === row.agreement_ref && candidate.period === row.period,
    );
    if (existing !== undefined) {
      const updated: HardwareCrossLicenseNetSettlementRecord = { ...existing, ...row };
      this.hardwareCrossLicenseNetSettlements[
        this.hardwareCrossLicenseNetSettlements.indexOf(existing)
      ] = updated;
      return { ...updated };
    }
    const record: HardwareCrossLicenseNetSettlementRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.hardwareCrossLicenseNetSettlements.push(record);
    return { ...record };
  }

  async getHardwareCrossLicenseNetSettlement(
    agreementRef: string,
    period: string,
  ): Promise<HardwareCrossLicenseNetSettlementRecord | undefined> {
    const found = this.hardwareCrossLicenseNetSettlements.find(
      (record) => record.agreement_ref === agreementRef && record.period === period,
    );
    return found === undefined ? undefined : { ...found };
  }

  async sumHardwareSepRoyaltiesBetween(
    licenseeId: string,
    payeeId: string,
    period: string,
  ): Promise<number> {
    // The netting walk's liability aggregation — exact integer cents.
    return this.hardwareSepRoyaltyApplications
      .filter(
        (record) =>
          record.licensee_id === licenseeId &&
          record.payee_id === payeeId &&
          record.period === period,
      )
      .reduce((sum, record) => sum + record.royalty_cents, 0);
  }

  // -------------------------------------------------------------------------
  // The energy lane (PR 48, migration 0052) — the founder resource
  // directive's registries, posts, and application ledgers.
  // -------------------------------------------------------------------------

  async upsertEnergyLandParcel(
    row: Omit<EnergyLandParcelRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyLandParcelRecord> {
    const existing = this.energyLandParcels.find(
      (candidate) => candidate.parcel_id === row.parcel_id,
    );
    const now = new Date().toISOString();
    const record: EnergyLandParcelRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyLandParcels[this.energyLandParcels.indexOf(existing)] = record;
    } else {
      this.energyLandParcels.push(record);
    }
    return { ...record };
  }

  async getEnergyLandParcel(
    parcelId: string,
  ): Promise<EnergyLandParcelRecord | undefined> {
    const found = this.energyLandParcels.find(
      (record) => record.parcel_id === parcelId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertEnergyParcelOwnerInterest(
    row: Omit<EnergyParcelOwnerInterestRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyParcelOwnerInterestRecord> {
    const existing = this.energyParcelOwnerInterests.find(
      (candidate) =>
        candidate.parcel_id === row.parcel_id &&
        candidate.owner_payee_id === row.owner_payee_id,
    );
    const now = new Date().toISOString();
    const record: EnergyParcelOwnerInterestRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyParcelOwnerInterests[
        this.energyParcelOwnerInterests.indexOf(existing)
      ] = record;
    } else {
      this.energyParcelOwnerInterests.push(record);
    }
    return { ...record };
  }

  async listEnergyParcelOwnerInterests(
    parcelId: string,
  ): Promise<EnergyParcelOwnerInterestRecord[]> {
    return this.energyParcelOwnerInterests
      .filter((record) => record.parcel_id === parcelId)
      .map((record) => ({ ...record }));
  }

  async upsertEnergyParcelRoyaltyPolicy(
    row: Omit<EnergyParcelRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyParcelRoyaltyPolicyRecord> {
    const existing = this.energyParcelRoyaltyPolicies.find(
      (candidate) => candidate.parcel_id === row.parcel_id,
    );
    const now = new Date().toISOString();
    const record: EnergyParcelRoyaltyPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyParcelRoyaltyPolicies[
        this.energyParcelRoyaltyPolicies.indexOf(existing)
      ] = record;
    } else {
      this.energyParcelRoyaltyPolicies.push(record);
    }
    return { ...record };
  }

  async getEnergyParcelRoyaltyPolicy(
    parcelId: string,
  ): Promise<EnergyParcelRoyaltyPolicyRecord | undefined> {
    const found = this.energyParcelRoyaltyPolicies.find(
      (record) => record.parcel_id === parcelId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async advanceEnergyParcelRoyaltyPosition(
    parcelId: string,
    period: string,
    currency: string,
    revenueCentsAdded: number,
    royaltyCentsAdded: number,
  ): Promise<EnergyParcelRoyaltyPositionRecord> {
    const existing = this.energyParcelRoyaltyPositions.find(
      (candidate) =>
        candidate.parcel_id === parcelId &&
        candidate.period === period &&
        candidate.currency === currency,
    );
    const now = new Date().toISOString();
    if (existing !== undefined) {
      existing.cumulative_revenue_cents += revenueCentsAdded;
      existing.cumulative_royalty_cents += royaltyCentsAdded;
      existing.updated_at = now;
      return { ...existing };
    }
    const record: EnergyParcelRoyaltyPositionRecord = {
      id: randomUUID(),
      parcel_id: parcelId,
      period,
      currency,
      cumulative_revenue_cents: revenueCentsAdded,
      cumulative_royalty_cents: royaltyCentsAdded,
      created_at: now,
      updated_at: now,
    };
    this.energyParcelRoyaltyPositions.push(record);
    return { ...record };
  }

  async getEnergyParcelRoyaltyPosition(
    parcelId: string,
    period: string,
    currency: string,
  ): Promise<EnergyParcelRoyaltyPositionRecord | undefined> {
    const found = this.energyParcelRoyaltyPositions.find(
      (record) =>
        record.parcel_id === parcelId &&
        record.period === period &&
        record.currency === currency,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertEnergyComputeYieldPolicy(
    row: Omit<EnergyComputeYieldPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyComputeYieldPolicyRecord> {
    const existing = this.energyComputeYieldPolicies.find(
      (candidate) => candidate.gpu_cluster_hash === row.gpu_cluster_hash,
    );
    const now = new Date().toISOString();
    const record: EnergyComputeYieldPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyComputeYieldPolicies[
        this.energyComputeYieldPolicies.indexOf(existing)
      ] = record;
    } else {
      this.energyComputeYieldPolicies.push(record);
    }
    return { ...record };
  }

  async getEnergyComputeYieldPolicy(
    gpuClusterHash: string,
  ): Promise<EnergyComputeYieldPolicyRecord | undefined> {
    const found = this.energyComputeYieldPolicies.find(
      (record) => record.gpu_cluster_hash === gpuClusterHash,
    );
    return found === undefined ? undefined : { ...found };
  }

  async advanceEnergyComputeYieldPosition(
    gpuClusterHash: string,
    period: string,
    currency: string,
    computeRevenueCentsAdded: number,
    yieldCentsAdded: number,
  ): Promise<EnergyComputeYieldPositionRecord> {
    const existing = this.energyComputeYieldPositions.find(
      (candidate) =>
        candidate.gpu_cluster_hash === gpuClusterHash &&
        candidate.period === period &&
        candidate.currency === currency,
    );
    const now = new Date().toISOString();
    if (existing !== undefined) {
      existing.cumulative_compute_revenue_cents += computeRevenueCentsAdded;
      existing.cumulative_yield_cents += yieldCentsAdded;
      existing.updated_at = now;
      return { ...existing };
    }
    const record: EnergyComputeYieldPositionRecord = {
      id: randomUUID(),
      gpu_cluster_hash: gpuClusterHash,
      period,
      currency,
      cumulative_compute_revenue_cents: computeRevenueCentsAdded,
      cumulative_yield_cents: yieldCentsAdded,
      created_at: now,
      updated_at: now,
    };
    this.energyComputeYieldPositions.push(record);
    return { ...record };
  }

  async getEnergyComputeYieldPosition(
    gpuClusterHash: string,
    period: string,
    currency: string,
  ): Promise<EnergyComputeYieldPositionRecord | undefined> {
    const found = this.energyComputeYieldPositions.find(
      (record) =>
        record.gpu_cluster_hash === gpuClusterHash &&
        record.period === period &&
        record.currency === currency,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertEnergyGridParticipant(
    row: Omit<
      EnergyGridParticipantRegistrationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<EnergyGridParticipantRegistrationRecord> {
    const existing = this.energyGridParticipants.find(
      (candidate) =>
        candidate.gpu_cluster_hash === row.gpu_cluster_hash &&
        candidate.participant_payee_id === row.participant_payee_id,
    );
    const now = new Date().toISOString();
    const record: EnergyGridParticipantRegistrationRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyGridParticipants[
        this.energyGridParticipants.indexOf(existing)
      ] = record;
    } else {
      this.energyGridParticipants.push(record);
    }
    return { ...record };
  }

  async listEnergyGridParticipants(
    gpuClusterHash: string,
  ): Promise<EnergyGridParticipantRegistrationRecord[]> {
    return this.energyGridParticipants
      .filter((record) => record.gpu_cluster_hash === gpuClusterHash)
      .map((record) => ({ ...record }));
  }

  async upsertEnergyDivisionOrder(
    row: Omit<EnergyDivisionOrderRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyDivisionOrderRecord> {
    const existing = this.energyDivisionOrders.find(
      (candidate) => candidate.order_ref === row.order_ref,
    );
    const now = new Date().toISOString();
    const record: EnergyDivisionOrderRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyDivisionOrders[
        this.energyDivisionOrders.indexOf(existing)
      ] = record;
    } else {
      this.energyDivisionOrders.push(record);
    }
    return { ...record };
  }

  async getEnergyDivisionOrder(
    orderRef: string,
  ): Promise<EnergyDivisionOrderRecord | undefined> {
    const found = this.energyDivisionOrders.find(
      (record) => record.order_ref === orderRef,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertEnergyDeedTransfer(
    row: Omit<EnergyDeedTransferRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyDeedTransferRecord> {
    const existing = this.energyDeedTransfers.find(
      (candidate) => candidate.deed_ref === row.deed_ref,
    );
    const now = new Date().toISOString();
    const record: EnergyDeedTransferRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyDeedTransfers[
        this.energyDeedTransfers.indexOf(existing)
      ] = record;
    } else {
      this.energyDeedTransfers.push(record);
    }
    return { ...record };
  }

  async getEnergyDeedTransfer(
    deedRef: string,
  ): Promise<EnergyDeedTransferRecord | undefined> {
    const found = this.energyDeedTransfers.find(
      (record) => record.deed_ref === deedRef,
    );
    return found === undefined ? undefined : { ...found };
  }

  async listEnergyDeedTransfersForParcel(
    parcelId: string,
  ): Promise<EnergyDeedTransferRecord[]> {
    return this.energyDeedTransfers
      .filter((record) => record.parcel_id === parcelId)
      .map((record) => ({ ...record }));
  }

  async upsertEnergyCarbonOffsetPolicy(
    row: Omit<EnergyCarbonOffsetPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EnergyCarbonOffsetPolicyRecord> {
    const existing = this.energyCarbonOffsetPolicies.find(
      (candidate) => candidate.parcel_id === row.parcel_id,
    );
    const now = new Date().toISOString();
    const record: EnergyCarbonOffsetPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing !== undefined) {
      this.energyCarbonOffsetPolicies[
        this.energyCarbonOffsetPolicies.indexOf(existing)
      ] = record;
    } else {
      this.energyCarbonOffsetPolicies.push(record);
    }
    return { ...record };
  }

  async getEnergyCarbonOffsetPolicy(
    parcelId: string,
  ): Promise<EnergyCarbonOffsetPolicyRecord | undefined> {
    const found = this.energyCarbonOffsetPolicies.find(
      (record) => record.parcel_id === parcelId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyMeterSalesPost(
    row: Omit<EnergyMeterSalesPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyMeterSalesPostRecord> {
    // UNIQUE per source_event_id — the replay guard.
    if (
      this.energyMeterSalesPosts.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_meter_sales_posts.source_event_id');
    }
    const record: EnergyMeterSalesPostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyMeterSalesPosts.push(record);
    return { ...record };
  }

  async getEnergyMeterSalesPost(
    sourceEventId: string,
  ): Promise<EnergyMeterSalesPostRecord | undefined> {
    const found = this.energyMeterSalesPosts.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyPipelineDeductionPost(
    row: Omit<EnergyPipelineDeductionPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyPipelineDeductionPostRecord> {
    if (
      this.energyPipelineDeductionPosts.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_pipeline_deduction_posts.source_event_id');
    }
    const record: EnergyPipelineDeductionPostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyPipelineDeductionPosts.push(record);
    return { ...record };
  }

  async getEnergyPipelineDeductionPost(
    sourceEventId: string,
  ): Promise<EnergyPipelineDeductionPostRecord | undefined> {
    const found = this.energyPipelineDeductionPosts.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyGpuUtilizationPost(
    row: Omit<EnergyGpuUtilizationPostRecord, 'id' | 'created_at'>,
  ): Promise<EnergyGpuUtilizationPostRecord> {
    if (
      this.energyGpuUtilizationPosts.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_gpu_utilization_posts.source_event_id');
    }
    const record: EnergyGpuUtilizationPostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyGpuUtilizationPosts.push(record);
    return { ...record };
  }

  async getEnergyGpuUtilizationPost(
    sourceEventId: string,
  ): Promise<EnergyGpuUtilizationPostRecord | undefined> {
    const found = this.energyGpuUtilizationPosts.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
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
    const meterSums = this.energyMeterSalesPosts
      .filter(
        (record) =>
          record.parcel_id === parcelId &&
          record.well_meter_id === wellMeterId &&
          record.gpu_cluster_hash === gpuClusterHash &&
          record.period === period &&
          record.currency === currency,
      )
      .reduce(
        (sums, record) => ({
          gross_energy_sales_cents:
            sums.gross_energy_sales_cents + record.gross_energy_sales_cents,
          gross_mineral_sales_cents:
            sums.gross_mineral_sales_cents + record.gross_mineral_sales_cents,
        }),
        { gross_energy_sales_cents: 0, gross_mineral_sales_cents: 0 },
      );
    const pipelineSums = this.energyPipelineDeductionPosts
      .filter(
        (record) =>
          record.parcel_id === parcelId &&
          record.well_meter_id === wellMeterId &&
          record.gpu_cluster_hash === gpuClusterHash &&
          record.period === period &&
          record.currency === currency,
      )
      .reduce(
        (sums, record) => ({
          transportation_pipeline_deductions_cents:
            sums.transportation_pipeline_deductions_cents +
            record.transportation_pipeline_deductions_cents,
          grid_transmission_fees_cents:
            sums.grid_transmission_fees_cents + record.grid_transmission_fees_cents,
          processing_refining_base_fees_cents:
            sums.processing_refining_base_fees_cents +
            record.processing_refining_base_fees_cents,
        }),
        {
          transportation_pipeline_deductions_cents: 0,
          grid_transmission_fees_cents: 0,
          processing_refining_base_fees_cents: 0,
        },
      );
    return { ...meterSums, ...pipelineSums };
  }

  async upsertEnergyNetRealizationApplication(
    row: Omit<
      EnergyNetRealizationApplicationRecord,
      'id' | 'created_at' | 'updated_at'
    >,
  ): Promise<EnergyNetRealizationApplicationRecord> {
    // The realization position of record — UNIQUE per the founder's
    // five-tuple; the recompute replaces the sums in place (the id and
    // created_at survive — no id in the conflict payload, the PR 33
    // lesson).
    const existing = this.energyNetRealizationApplications.find(
      (candidate) =>
        candidate.parcel_id === row.parcel_id &&
        candidate.well_meter_id === row.well_meter_id &&
        candidate.gpu_cluster_hash === row.gpu_cluster_hash &&
        candidate.period === row.period &&
        candidate.currency === row.currency,
    );
    if (existing !== undefined) {
      const merged: EnergyNetRealizationApplicationRecord = {
        ...existing,
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      this.energyNetRealizationApplications[
        this.energyNetRealizationApplications.indexOf(existing)
      ] = merged;
      return { ...merged };
    }
    const record: EnergyNetRealizationApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.energyNetRealizationApplications.push(record);
    return { ...record };
  }

  async getEnergyNetRealizationApplication(
    sourceEventId: string,
  ): Promise<EnergyNetRealizationApplicationRecord | undefined> {
    const found = this.energyNetRealizationApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyParcelDivisionApplication(
    row: Omit<EnergyParcelDivisionApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyParcelDivisionApplicationRecord> {
    if (
      this.energyParcelDivisionApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_parcel_division_applications.source_event_id');
    }
    const record: EnergyParcelDivisionApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyParcelDivisionApplications.push(record);
    return { ...record };
  }

  async getEnergyParcelDivisionApplication(
    sourceEventId: string,
  ): Promise<EnergyParcelDivisionApplicationRecord | undefined> {
    const found = this.energyParcelDivisionApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyComputeGridSplitApplication(
    row: Omit<EnergyComputeGridSplitApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyComputeGridSplitApplicationRecord> {
    if (
      this.energyComputeGridSplitApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_compute_grid_split_applications.source_event_id');
    }
    const record: EnergyComputeGridSplitApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyComputeGridSplitApplications.push(record);
    return { ...record };
  }

  async getEnergyComputeGridSplitApplication(
    sourceEventId: string,
  ): Promise<EnergyComputeGridSplitApplicationRecord | undefined> {
    const found = this.energyComputeGridSplitApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyStatutoryInterestApplication(
    row: Omit<EnergyStatutoryInterestApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyStatutoryInterestApplicationRecord> {
    if (
      this.energyStatutoryInterestApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_statutory_interest_applications.source_event_id');
    }
    const record: EnergyStatutoryInterestApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyStatutoryInterestApplications.push(record);
    return { ...record };
  }

  async getEnergyStatutoryInterestApplication(
    sourceEventId: string,
  ): Promise<EnergyStatutoryInterestApplicationRecord | undefined> {
    const found = this.energyStatutoryInterestApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertEnergyCarbonOffsetPayoutApplication(
    row: Omit<EnergyCarbonOffsetPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<EnergyCarbonOffsetPayoutApplicationRecord> {
    if (
      this.energyCarbonOffsetPayoutApplications.some(
        (existing) => existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_carbon_offset_payout_applications.source_event_id');
    }
    const record: EnergyCarbonOffsetPayoutApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.energyCarbonOffsetPayoutApplications.push(record);
    return { ...record };
  }

  async getEnergyCarbonOffsetPayoutApplication(
    sourceEventId: string,
  ): Promise<EnergyCarbonOffsetPayoutApplicationRecord | undefined> {
    const found = this.energyCarbonOffsetPayoutApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
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
    const now = new Date().toISOString();
    const existing = this.resourceAuditEscrowPolicies.get(row.scope_key);
    const record: ResourceAuditEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.resourceAuditEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getResourceAuditEscrowPolicy(
    scopeKey: string,
  ): Promise<ResourceAuditEscrowPolicyRecord | undefined> {
    const found = this.resourceAuditEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertResourceAuditEscrowDrawdown(
    row: Omit<ResourceAuditEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<ResourceAuditEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.resourceAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('energy_resource_audit_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.resourceAuditEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('energy_resource_audit_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: ResourceAuditEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.resourceAuditEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listResourceAuditEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<ResourceAuditEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.resourceAuditEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async insertResourceAuditEscrowReconciliation(
    row: Omit<ResourceAuditEscrowReconciliationRecord, 'id' | 'created_at'>,
  ): Promise<ResourceAuditEscrowReconciliationRecord> {
    // Insert-as-lock — UNIQUE per reserve_ledger_id: the FIRST
    // reconciliation of record wins; a concurrent second insert throws
    // here (the caller reads the winner through the getter).
    if (this.resourceAuditEscrowReconciliations.has(row.reserve_ledger_id)) {
      uniqueViolation('energy_resource_audit_escrow_reconciliations.reserve_ledger_id');
    }
    const record: ResourceAuditEscrowReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.resourceAuditEscrowReconciliations.set(row.reserve_ledger_id, record);
    return { ...record };
  }

  async getResourceAuditEscrowReconciliation(
    reserveLedgerId: string,
  ): Promise<ResourceAuditEscrowReconciliationRecord | undefined> {
    const found = this.resourceAuditEscrowReconciliations.get(reserveLedgerId);
    return found === undefined ? undefined : { ...found };
  }

  async settleResourceAuditEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'resource_audit_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertResourcePayoutGateState(
    row: Omit<ResourcePayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ResourcePayoutGateStateRecord> {
    // UNIQUE per (payee_id, parcel_id) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.parcel_id}`;
    const existing = this.resourcePayoutGateStates.get(key);
    const record: ResourcePayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.resourcePayoutGateStates.set(key, record);
    return { ...record };
  }

  async getResourcePayoutGateState(
    payeeId: string,
    parcelId: string,
  ): Promise<ResourcePayoutGateStateRecord | undefined> {
    const found = this.resourcePayoutGateStates.get(`${payeeId}|${parcelId}`);
    return found === undefined ? undefined : { ...found };
  }

  async setEnergyComputeGridSplitJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<EnergyComputeGridSplitApplicationRecord | undefined> {
    // The CAS: the journal stamps only while the staged application's
    // journal_id is still null (PR 48 stages the split, PR 49's instant
    // cascade completes it); the caller that lost the race (or replayed)
    // reads undefined.
    const row = this.energyComputeGridSplitApplications.find(
      (record) =>
        record.source_event_id === sourceEventId && record.journal_id === null,
    );
    if (row === undefined) {
      return undefined;
    }
    row.journal_id = journalId;
    return { ...row };
  }

  // ------------------------------------------------------------------
  // PR 50 — the sports lane (ticketing, turnstile, resale, league
  // pools, group licensing, NIL reconciliation, biometric payouts).
  // The queue module (sportsQueue.ts) is the only caller; the shape
  // mirrors the energy lane: replay-guard posts, recompute-in-place
  // positions of record, and fail-closed registry reads.
  // ------------------------------------------------------------------

  async upsertSportsStudentAthleteProfile(
    row: Omit<SportsStudentAthleteProfileRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsStudentAthleteProfileRecord> {
    const now = new Date().toISOString();
    const existing = this.sportsStudentAthleteProfiles.get(row.athlete_glan);
    const record: SportsStudentAthleteProfileRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.sportsStudentAthleteProfiles.set(row.athlete_glan, record);
    return { ...record };
  }

  async getSportsStudentAthleteProfile(
    athleteGlan: string,
  ): Promise<SportsStudentAthleteProfileRecord | undefined> {
    const found = this.sportsStudentAthleteProfiles.get(athleteGlan);
    return found === undefined ? undefined : { ...found };
  }

  async getSportsStudentAthleteProfileByNilAthleteId(
    nilAthleteId: string,
  ): Promise<SportsStudentAthleteProfileRecord | undefined> {
    for (const record of this.sportsStudentAthleteProfiles.values()) {
      if (record.nil_athlete_id === nilAthleteId) {
        return { ...record };
      }
    }
    return undefined;
  }

  async upsertSportsResaleRoyaltyPolicy(
    row: Omit<SportsResaleRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsResaleRoyaltyPolicyRecord> {
    const now = new Date().toISOString();
    const key = `${row.venue_gln}|${row.league_rights_code}`;
    const existing = this.sportsResaleRoyaltyPolicies.get(key);
    const record: SportsResaleRoyaltyPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.sportsResaleRoyaltyPolicies.set(key, record);
    return { ...record };
  }

  async getSportsResaleRoyaltyPolicy(
    venueGln: string,
    leagueRightsCode: string,
  ): Promise<SportsResaleRoyaltyPolicyRecord | undefined> {
    const found = this.sportsResaleRoyaltyPolicies.get(`${venueGln}|${leagueRightsCode}`);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSportsLeaguePoolPolicy(
    row: Omit<SportsLeaguePoolPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeaguePoolPolicyRecord> {
    const now = new Date().toISOString();
    const existing = this.sportsLeaguePoolPolicies.get(row.league_rights_code);
    const record: SportsLeaguePoolPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.sportsLeaguePoolPolicies.set(row.league_rights_code, record);
    return { ...record };
  }

  async getSportsLeaguePoolPolicy(
    leagueRightsCode: string,
  ): Promise<SportsLeaguePoolPolicyRecord | undefined> {
    const found = this.sportsLeaguePoolPolicies.get(leagueRightsCode);
    return found === undefined ? undefined : { ...found };
  }

  async upsertSportsLeagueTeam(
    row: Omit<SportsLeagueTeamRegistrationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeagueTeamRegistrationRecord> {
    const now = new Date().toISOString();
    const key = `${row.league_rights_code}|${row.team_code}`;
    const existing = this.sportsLeagueTeams.get(key);
    const record: SportsLeagueTeamRegistrationRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.sportsLeagueTeams.set(key, record);
    return { ...record };
  }

  async listSportsLeagueTeams(
    leagueRightsCode: string,
  ): Promise<SportsLeagueTeamRegistrationRecord[]> {
    const rows = [...this.sportsLeagueTeams.values()].filter(
      (record) => record.league_rights_code === leagueRightsCode,
    );
    // Deterministic order — team_code ascending (matching the SQL
    // backends' ORDER BY), so the distribution walk is stable in tests.
    rows.sort((a, b) => (a.team_code < b.team_code ? -1 : a.team_code > b.team_code ? 1 : 0));
    return rows.map((record) => ({ ...record }));
  }

  async upsertSportsBiometricRoyaltyPolicy(
    row: Omit<SportsBiometricRoyaltyPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsBiometricRoyaltyPolicyRecord> {
    const now = new Date().toISOString();
    const key = `${row.league_rights_code}|${row.licensee_class}`;
    const existing = this.sportsBiometricRoyaltyPolicies.get(key);
    const record: SportsBiometricRoyaltyPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.sportsBiometricRoyaltyPolicies.set(key, record);
    return { ...record };
  }

  async getSportsBiometricRoyaltyPolicy(
    leagueRightsCode: string,
    licenseeClass: SportsLicenseeClass,
  ): Promise<SportsBiometricRoyaltyPolicyRecord | undefined> {
    const found = this.sportsBiometricRoyaltyPolicies.get(
      `${leagueRightsCode}|${licenseeClass}`,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsTicketSalePost(
    row: Omit<SportsTicketSalePostRecord, 'id' | 'created_at'>,
  ): Promise<SportsTicketSalePostRecord> {
    if (this.sportsTicketSalePosts.some((r) => r.source_event_id === row.source_event_id)) {
      throw new Error(`sports_ticket_sale_post_conflict:${row.source_event_id}`);
    }
    const record: SportsTicketSalePostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsTicketSalePosts.push(record);
    return { ...record };
  }

  async getSportsTicketSalePost(
    sourceEventId: string,
  ): Promise<SportsTicketSalePostRecord | undefined> {
    const found = this.sportsTicketSalePosts.find((r) => r.source_event_id === sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsResaleSalePost(
    row: Omit<SportsResaleSalePostRecord, 'id' | 'created_at'>,
  ): Promise<SportsResaleSalePostRecord> {
    if (this.sportsResaleSalePosts.some((r) => r.source_event_id === row.source_event_id)) {
      throw new Error(`sports_resale_sale_post_conflict:${row.source_event_id}`);
    }
    const record: SportsResaleSalePostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsResaleSalePosts.push(record);
    return { ...record };
  }

  async getSportsResaleSalePost(
    sourceEventId: string,
  ): Promise<SportsResaleSalePostRecord | undefined> {
    const found = this.sportsResaleSalePosts.find((r) => r.source_event_id === sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsTurnstileScanPost(
    row: Omit<SportsTurnstileScanPostRecord, 'id' | 'created_at'>,
  ): Promise<SportsTurnstileScanPostRecord> {
    if (this.sportsTurnstileScanPosts.some((r) => r.source_event_id === row.source_event_id)) {
      throw new Error(`sports_turnstile_scan_post_conflict:${row.source_event_id}`);
    }
    const record: SportsTurnstileScanPostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsTurnstileScanPosts.push(record);
    return { ...record };
  }

  async getSportsTurnstileScanPost(
    sourceEventId: string,
  ): Promise<SportsTurnstileScanPostRecord | undefined> {
    const found = this.sportsTurnstileScanPosts.find((r) => r.source_event_id === sourceEventId);
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsBiometricTrackingPost(
    row: Omit<SportsBiometricTrackingPostRecord, 'id' | 'created_at'>,
  ): Promise<SportsBiometricTrackingPostRecord> {
    if (
      this.sportsBiometricTrackingPosts.some((r) => r.source_event_id === row.source_event_id)
    ) {
      throw new Error(`sports_biometric_post_conflict:${row.source_event_id}`);
    }
    const record: SportsBiometricTrackingPostRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsBiometricTrackingPosts.push(record);
    return { ...record };
  }

  async getSportsBiometricTrackingPost(
    sourceEventId: string,
  ): Promise<SportsBiometricTrackingPostRecord | undefined> {
    const found = this.sportsBiometricTrackingPosts.find(
      (r) => r.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsBroadcastingContract(
    row: Omit<SportsBroadcastingContractRecord, 'id' | 'created_at'>,
  ): Promise<SportsBroadcastingContractRecord> {
    // The contract_ref is the replay key (UNIQUE in every backend) — a
    // re-shipped contract is a conflict, not a second row.
    if (
      this.sportsBroadcastingContracts.some((r) => r.contract_ref === row.contract_ref)
    ) {
      throw new Error(`sports_broadcasting_contract_conflict:${row.contract_ref}`);
    }
    const record: SportsBroadcastingContractRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsBroadcastingContracts.push(record);
    return { ...record };
  }

  async getSportsBroadcastingContract(
    contractRef: string,
  ): Promise<SportsBroadcastingContractRecord | undefined> {
    const found = this.sportsBroadcastingContracts.find(
      (r) => r.contract_ref === contractRef,
    );
    return found === undefined ? undefined : { ...found };
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
    const legs = {
      gross_ticket_revenue_cents: 0,
      facility_surcharges_cents: 0,
      municipal_taxes_cents: 0,
      insurance_reserves_cents: 0,
      processor_fee_cuts_cents: 0,
      ticket_count: 0,
    };
    for (const post of this.sportsTicketSalePosts) {
      if (
        post.nil_contract_id === nilContractId &&
        post.athlete_glan === athleteGlan &&
        post.venue_gln === venueGln &&
        post.league_rights_code === leagueRightsCode &&
        post.turnstile_scan_hash === turnstileScanHash &&
        post.period === period &&
        post.currency === currency
      ) {
        legs.gross_ticket_revenue_cents += post.gross_ticket_revenue_cents;
        legs.facility_surcharges_cents += post.facility_surcharges_cents;
        legs.municipal_taxes_cents += post.municipal_taxes_cents;
        legs.insurance_reserves_cents += post.insurance_reserves_cents;
        legs.processor_fee_cuts_cents += post.processor_fee_cuts_cents;
        legs.ticket_count += post.ticket_count;
      }
    }
    return legs;
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
    const keys: Array<{
      nil_contract_id: string;
      athlete_glan: string;
      venue_gln: string;
      league_rights_code: string;
      turnstile_scan_hash: string;
      period: string;
      currency: string;
    }> = [];
    const seen = new Set<string>();
    for (const post of this.sportsTicketSalePosts) {
      if (post.venue_gln !== venueGln || post.turnstile_scan_hash !== turnstileScanHash) {
        continue;
      }
      const key = [
        post.nil_contract_id,
        post.athlete_glan,
        post.venue_gln,
        post.league_rights_code,
        post.turnstile_scan_hash,
        post.period,
        post.currency,
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      keys.push({
        nil_contract_id: post.nil_contract_id,
        athlete_glan: post.athlete_glan,
        venue_gln: post.venue_gln,
        league_rights_code: post.league_rights_code,
        turnstile_scan_hash: post.turnstile_scan_hash,
        period: post.period,
        currency: post.currency,
      });
    }
    return keys;
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
    let ticketCountSum = 0;
    let grossTicketRevenueCents = 0;
    for (const post of this.sportsTicketSalePosts) {
      if (post.venue_gln === venueGln && post.period === period && post.currency === currency) {
        ticketCountSum += post.ticket_count;
        grossTicketRevenueCents += post.gross_ticket_revenue_cents;
      }
    }
    let scanCountSum = 0;
    for (const post of this.sportsTurnstileScanPosts) {
      if (post.venue_gln === venueGln && post.period === period && post.currency === currency) {
        scanCountSum += post.scan_count;
      }
    }
    return {
      ticket_count_sum: ticketCountSum,
      scan_count_sum: scanCountSum,
      gross_ticket_revenue_cents: grossTicketRevenueCents,
    };
  }

  async upsertSportsGateReconciliation(
    row: Omit<SportsGateReconciliationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsGateReconciliationRecord> {
    const existing = this.sportsGateReconciliations.find(
      (candidate) => candidate.source_event_id === row.source_event_id,
    );
    if (existing !== undefined) {
      const merged: SportsGateReconciliationRecord = {
        ...existing,
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      this.sportsGateReconciliations[
        this.sportsGateReconciliations.indexOf(existing)
      ] = merged;
      return { ...merged };
    }
    const record: SportsGateReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.sportsGateReconciliations.push(record);
    return { ...record };
  }

  async getSportsGateReconciliation(
    sourceEventId: string,
  ): Promise<SportsGateReconciliationRecord | undefined> {
    const found = this.sportsGateReconciliations.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async upsertSportsNetVenueRealization(
    row: Omit<SportsNetVenueRealizationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsNetVenueRealizationRecord> {
    // The realization position of record — UNIQUE per source_event_id
    // (the founder tuple); the recompute replaces the sums in place
    // (no id in the conflict payload — the PR 33 lesson).
    const existing = this.sportsNetVenueRealizations.find(
      (candidate) => candidate.source_event_id === row.source_event_id,
    );
    if (existing !== undefined) {
      const merged: SportsNetVenueRealizationRecord = {
        ...existing,
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      this.sportsNetVenueRealizations[
        this.sportsNetVenueRealizations.indexOf(existing)
      ] = merged;
      return { ...merged };
    }
    const record: SportsNetVenueRealizationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.sportsNetVenueRealizations.push(record);
    return { ...record };
  }

  async getSportsNetVenueRealization(
    sourceEventId: string,
  ): Promise<SportsNetVenueRealizationRecord | undefined> {
    const found = this.sportsNetVenueRealizations.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsResaleRoyaltyApplication(
    row: Omit<SportsResaleRoyaltyApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsResaleRoyaltyApplicationRecord> {
    if (
      this.sportsResaleRoyaltyApplications.some((r) => r.source_event_id === row.source_event_id)
    ) {
      throw new Error(`sports_resale_royalty_conflict:${row.source_event_id}`);
    }
    const record: SportsResaleRoyaltyApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsResaleRoyaltyApplications.push(record);
    return { ...record };
  }

  async getSportsResaleRoyaltyApplication(
    sourceEventId: string,
  ): Promise<SportsResaleRoyaltyApplicationRecord | undefined> {
    const found = this.sportsResaleRoyaltyApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async sumSportsLeaguePoolContractGross(
    leagueRightsCode: string,
    period: string,
    currency: string,
  ): Promise<number> {
    return this.sportsBroadcastingContracts
      .filter(
        (contract) =>
          contract.league_rights_code === leagueRightsCode &&
          contract.period === period &&
          contract.currency === currency,
      )
      .reduce((sum, contract) => sum + contract.contract_gross_cents, 0);
  }

  async upsertSportsLeaguePoolDistribution(
    row: Omit<SportsLeaguePoolDistributionRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsLeaguePoolDistributionRecord> {
    const existing = this.sportsLeaguePoolDistributions.find(
      (candidate) => candidate.source_event_id === row.source_event_id,
    );
    if (existing !== undefined) {
      const merged: SportsLeaguePoolDistributionRecord = {
        ...existing,
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      this.sportsLeaguePoolDistributions[
        this.sportsLeaguePoolDistributions.indexOf(existing)
      ] = merged;
      return { ...merged };
    }
    const record: SportsLeaguePoolDistributionRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.sportsLeaguePoolDistributions.push(record);
    return { ...record };
  }

  async getSportsLeaguePoolDistribution(
    sourceEventId: string,
  ): Promise<SportsLeaguePoolDistributionRecord | undefined> {
    const found = this.sportsLeaguePoolDistributions.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsGroupLicensingApplication(
    row: Omit<SportsGroupLicensingApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsGroupLicensingApplicationRecord> {
    if (
      this.sportsGroupLicensingApplications.some((r) => r.source_event_id === row.source_event_id)
    ) {
      throw new Error(`sports_group_licensing_conflict:${row.source_event_id}`);
    }
    const record: SportsGroupLicensingApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsGroupLicensingApplications.push(record);
    return { ...record };
  }

  async getSportsGroupLicensingApplication(
    sourceEventId: string,
  ): Promise<SportsGroupLicensingApplicationRecord | undefined> {
    const found = this.sportsGroupLicensingApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async listNilPayoutApplicationsForAthlete(
    athleteId: string,
    period: string,
  ): Promise<NilPayoutApplicationRecord[]> {
    const rows = [...this.nilPayoutApplications.values()].filter(
      (application) => application.athlete_id === athleteId && application.period === period,
    );
    // Deterministic order — source_event_id ascending.
    rows.sort((a, b) => (a.source_event_id < b.source_event_id ? -1 : 1));
    return rows.map((record) => ({ ...record }));
  }

  async upsertSportsNilDealReconciliation(
    row: Omit<SportsNilDealReconciliationRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsNilDealReconciliationRecord> {
    const existing = this.sportsNilDealReconciliations.find(
      (candidate) => candidate.source_event_id === row.source_event_id,
    );
    if (existing !== undefined) {
      const merged: SportsNilDealReconciliationRecord = {
        ...existing,
        ...row,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      this.sportsNilDealReconciliations[
        this.sportsNilDealReconciliations.indexOf(existing)
      ] = merged;
      return { ...merged };
    }
    const record: SportsNilDealReconciliationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.sportsNilDealReconciliations.push(record);
    return { ...record };
  }

  async getSportsNilDealReconciliation(
    sourceEventId: string,
  ): Promise<SportsNilDealReconciliationRecord | undefined> {
    const found = this.sportsNilDealReconciliations.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  async insertSportsBiometricMicroPayoutApplication(
    row: Omit<SportsBiometricMicroPayoutApplicationRecord, 'id' | 'created_at'>,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord> {
    if (
      this.sportsBiometricMicroPayoutApplications.some(
        (r) => r.source_event_id === row.source_event_id,
      )
    ) {
      throw new Error(`sports_biometric_payout_conflict:${row.source_event_id}`);
    }
    const record: SportsBiometricMicroPayoutApplicationRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.sportsBiometricMicroPayoutApplications.push(record);
    return { ...record };
  }

  async getSportsBiometricMicroPayoutApplication(
    sourceEventId: string,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord | undefined> {
    const found = this.sportsBiometricMicroPayoutApplications.find(
      (record) => record.source_event_id === sourceEventId,
    );
    return found === undefined ? undefined : { ...found };
  }

  // ---------------------------------------------------------------------------
  // PR 51 — the event cancellation escrow, the sports payout gate states, and
  // the staged sports applications' instant-posting journal stamps.
  // ---------------------------------------------------------------------------

  async upsertEventCancellationEscrowPolicy(
    row: Omit<EventCancellationEscrowPolicyRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<EventCancellationEscrowPolicyRecord> {
    // UNIQUE per scope_key — a re-registered policy converges (the
    // newest rate governs the next routing).
    const now = new Date().toISOString();
    const existing = this.eventCancellationEscrowPolicies.get(row.scope_key);
    const record: EventCancellationEscrowPolicyRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.eventCancellationEscrowPolicies.set(row.scope_key, record);
    return { ...record };
  }

  async getEventCancellationEscrowPolicy(
    scopeKey: string,
  ): Promise<EventCancellationEscrowPolicyRecord | undefined> {
    const found = this.eventCancellationEscrowPolicies.get(scopeKey);
    return found === undefined ? undefined : { ...found };
  }

  async insertEventCancellationEscrowDrawdown(
    row: Omit<EventCancellationEscrowDrawdownRecord, 'id' | 'created_at'>,
  ): Promise<EventCancellationEscrowDrawdownRecord> {
    // UNIQUE per (reserve_ledger_id, source_event_id) is the replay
    // guard; UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
    // position lock — a replayed event or a lost race throws here,
    // never a double drawdown; the caller re-derives from the
    // append-only truth.
    if (
      this.eventCancellationEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.source_event_id === row.source_event_id,
      )
    ) {
      uniqueViolation('sports_event_cancellation_escrow_drawdowns.reserve_ledger_id,source_event_id');
    }
    if (
      this.eventCancellationEscrowDrawdowns.some(
        (existing) =>
          existing.reserve_ledger_id === row.reserve_ledger_id &&
          existing.drawn_before_cents === row.drawn_before_cents,
      )
    ) {
      uniqueViolation('sports_event_cancellation_escrow_drawdowns.reserve_ledger_id,drawn_before_cents');
    }
    const record: EventCancellationEscrowDrawdownRecord = {
      ...row,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.eventCancellationEscrowDrawdowns.push(record);
    return { ...record };
  }

  async listEventCancellationEscrowDrawdowns(
    reserveLedgerId: string,
  ): Promise<EventCancellationEscrowDrawdownRecord[]> {
    // Chronological spend order: created_at ASC with drawn_before_cents
    // DESC as the tiebreak — balances strictly decrease as draws land, so
    // the unique balance-before column orders same-millisecond rows honestly.
    return this.eventCancellationEscrowDrawdowns
      .filter((row) => row.reserve_ledger_id === reserveLedgerId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          b.drawn_before_cents - a.drawn_before_cents,
      )
      .map((row) => ({ ...row }));
  }

  async settleEventCancellationEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still held —
    // the in-memory shape of the single-statement conditional UPDATE the
    // SQL backends run; the caller that lost the race reads undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'event_cancellation_escrow',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async settleIdentifierHoldEscrow(
    id: string,
    settledAt: string,
  ): Promise<LedgerTransactionRecord | undefined> {
    // The CAS reads the row and settles it only while it is still locked
    // — the in-memory shape of the single-statement conditional UPDATE
    // the SQL backends run; the caller that lost the race reads
    // undefined.
    const row = this.ledgerTransactions.find(
      (tx) => tx.id === id && tx.status === 'unclaimed_identifier_hold',
    );
    if (row === undefined) {
      return undefined;
    }
    row.status = 'settled';
    row.settled_at = settledAt;
    return { ...row };
  }

  async upsertSportsPayoutGateState(
    row: Omit<SportsPayoutGateStateRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<SportsPayoutGateStateRecord> {
    // UNIQUE per (payee_id, event_ref) — an upsert converges (a
    // verification heals 'unknown'; states never regress through this
    // table).
    const now = new Date().toISOString();
    const key = `${row.payee_id}|${row.event_ref}`;
    const existing = this.sportsPayoutGateStates.get(key);
    const record: SportsPayoutGateStateRecord = {
      ...row,
      id: existing?.id ?? randomUUID(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.sportsPayoutGateStates.set(key, record);
    return { ...record };
  }

  async getSportsPayoutGateState(
    payeeId: string,
    eventRef: string,
  ): Promise<SportsPayoutGateStateRecord | undefined> {
    const found = this.sportsPayoutGateStates.get(`${payeeId}|${eventRef}`);
    return found === undefined ? undefined : { ...found };
  }

  async setSportsResaleRoyaltyJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<SportsResaleRoyaltyApplicationRecord | undefined> {
    // The CAS: the journal stamps only while the staged application's
    // journal_id is still null (PR 50 stages the application, PR 51's
    // instant posting completes it); the caller that lost the race (or
    // replayed) reads undefined.
    const row = this.sportsResaleRoyaltyApplications.find(
      (record) =>
        record.source_event_id === sourceEventId && record.journal_id === null,
    );
    if (row === undefined) {
      return undefined;
    }
    row.journal_id = journalId;
    return { ...row };
  }

  async setSportsBiometricMicroPayoutJournal(
    sourceEventId: string,
    journalId: string,
  ): Promise<SportsBiometricMicroPayoutApplicationRecord | undefined> {
    // The CAS: the journal stamps only while the staged application's
    // journal_id is still null (PR 50 stages the application, PR 51's
    // instant posting completes it); the caller that lost the race (or
    // replayed) reads undefined.
    const row = this.sportsBiometricMicroPayoutApplications.find(
      (record) =>
        record.source_event_id === sourceEventId && record.journal_id === null,
    );
    if (row === undefined) {
      return undefined;
    }
    row.journal_id = journalId;
    return { ...row };
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
