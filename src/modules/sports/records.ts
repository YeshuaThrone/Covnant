
/**
 * The sports record vocabulary (PR 50, migration 0054) — the founder
 * sports-ticketing directive's durable facts of record for ticketing,
 * turnstile, resale, league, NIL, and biometric reconciliation:
 *
 *   sports_student_athlete_profiles         — one student-athlete profile
 *                                             of record (the group
 *                                             licensing wallet registry
 *                                             and the NIL reconciliation's
 *                                             profile side).
 *   sports_resale_royalty_policies          — one (venue, league) scope's
 *                                             resale royalty policy of
 *                                             record (the founder 5–10%
 *                                             band and the three-way
 *                                             split).
 *   sports_league_pool_policies             — one league's pool split
 *                                             policy of record (equal,
 *                                             market-size balance, and
 *                                             performance incentive
 *                                             shares).
 *   sports_league_team_registrations        — one team owner's
 *                                             registration of record
 *                                             (market size, payroll, cap
 *                                             threshold, incentive bps).
 *   sports_broadcasting_contracts           — one parsed league contract
 *                                             of record (broadcasting,
 *                                             merchandise pool, group
 *                                             licensing).
 *   sports_ticket_sale_posts                — the append-only primary
 *                                             ticketer settlement row
 *                                             post (the realization's
 *                                             gross side replay guard).
 *   sports_resale_sale_posts                — the append-only secondary
 *                                             marketplace row post (the
 *                                             royalty application's
 *                                             replay guard).
 *   sports_turnstile_scan_posts             — the append-only venue
 *                                             turnstile scan batch post
 *                                             (the gate reconciliation's
 *                                             replay guard).
 *   sports_biometric_tracking_posts         — the append-only biometric
 *                                             tracking row post (the
 *                                             micro-payout application's
 *                                             replay guard).
 *   sports_gate_reconciliations             — the turnstile-to-receipt
 *                                             reconciliation of record
 *                                             per (venue, period,
 *                                             currency) — recomputed in
 *                                             place BEFORE the Net Gate
 *                                             Pool realization reads it.
 *   sports_net_venue_realizations           — THE NET GATE POOL of
 *                                             record per the founder's
 *                                             five-column identity tuple
 *                                             (+ period, currency) —
 *                                             recomputed in place from
 *                                             the posts.
 *   sports_league_pool_distributions        — the league-wide pool
 *                                             distribution of record per
 *                                             (league, period, currency)
 *                                             — recomputed in place from
 *                                             the contract posts.
 *   sports_nil_deal_reconciliations         — the NIL deal waterfall
 *                                             reconciliation of record
 *                                             per (contract, athlete,
 *                                             period) — recomputed in
 *                                             place from the NIL lane's
 *                                             applications.
 *   sports_resale_royalty_applications      — the append-only resale
 *                                             royalty routing of record
 *                                             (promoter, venue, league).
 *   sports_group_licensing_applications     — the append-only group
 *                                             licensing routing of record
 *                                             (union ledger + athlete
 *                                             wallets).
 *   sports_biometric_micro_payout_applications
 *                                           — the append-only biometric
 *                                             micro-payout routing of
 *                                             record (athlete wallet +
 *                                             league data rights).
 *
 * MONEY is integer cents (the platform's money floor). QUANTITIES are
 * statement micros. Every division floors. BPS bands match the CHECKs
 * exactly.
 */

// ---------------------------------------------------------------------------
// The vocabulary unions. BYTE-IDENTITY DISCIPLINE (the PR 129/130 lesson):
// every SQL CHECK token list in migration 0054 is byte-identical to these
// constants — verified before CI dispatch.
// ---------------------------------------------------------------------------

/** The primary ticketers' settlement senders. */
export const SPORTS_TICKETER_SENDERS = [
  "ticketmaster",
  "axs",
  "seatgeek",
] as const;
export type SportsTicketerSender = (typeof SPORTS_TICKETER_SENDERS)[number];

/** The secondary marketplaces' resale senders. */
export const SPORTS_RESALE_SENDERS = ["stubhub", "vivid_seats"] as const;
export type SportsResaleSender = (typeof SPORTS_RESALE_SENDERS)[number];

/** The union-and-players-association ledger codes — 'none' rides rows
 * that carry no group-licensing union (the NIL agency mode precedent). */
export const SPORTS_UNION_CODES = ["NFLPA", "NBAPA", "none"] as const;
export type SportsUnionCode = (typeof SPORTS_UNION_CODES)[number];

/** The league contract classes — broadcasting (national and
 * international), the collective merchandise pool, and the three group
 * licensing streams the directive names. */
export const SPORTS_CONTRACT_CLASSES = [
  "broadcasting_national",
  "broadcasting_international",
  "merchandise_pool",
  "group_licensing_video_games",
  "group_licensing_trading_cards",
  "group_licensing_apparel",
] as const;
export type SportsContractClass = (typeof SPORTS_CONTRACT_CLASSES)[number];

/** The group licensing subset — the contract classes that route through
 * the union ledgers and the athlete wallets. */
export const SPORTS_GROUP_LICENSE_CLASSES = [
  "group_licensing_video_games",
  "group_licensing_trading_cards",
  "group_licensing_apparel",
] as const;
export type SportsGroupLicenseClass = (typeof SPORTS_GROUP_LICENSE_CLASSES)[number];

/** The biometric tracking modalities. */
export const SPORTS_TRACKING_MODALITIES = ["wearable", "optical"] as const;
export type SportsTrackingModality = (typeof SPORTS_TRACKING_MODALITIES)[number];

/** The biometric licensee classes the directive names. */
export const SPORTS_LICENSEE_CLASSES = [
  "sportsbook",
  "media_network",
  "health_tech",
] as const;
export type SportsLicenseeClass = (typeof SPORTS_LICENSEE_CLASSES)[number];

/** The gate reconciliation verdicts. */
export const SPORTS_GATE_RECONCILIATION_VERDICTS = [
  "reconciled",
  "variance_flagged",
  "unreconciled",
] as const;
export type SportsGateReconciliationVerdict =
  (typeof SPORTS_GATE_RECONCILIATION_VERDICTS)[number];

/** The Net Gate Pool realization verdicts — the energy realization
 * precedent's vocabulary, byte-identical to its CHECK. */
export const SPORTS_REALIZATION_VERDICTS = [
  "posted",
  "held_negative_net",
] as const;
export type SportsRealizationVerdict = (typeof SPORTS_REALIZATION_VERDICTS)[number];

/** The NIL deal reconciliation verdicts. */
export const SPORTS_NIL_RECONCILIATION_VERDICTS = [
  "reconciled",
  "unmatched_profile",
  "profile_ineligible",
] as const;
export type SportsNilReconciliationVerdict =
  (typeof SPORTS_NIL_RECONCILIATION_VERDICTS)[number];

/** The founder resale royalty band — 5 to 10 percent, in bps. */
export const SPORTS_RESALE_ROYALTY_MIN_BPS = 500;
export const SPORTS_RESALE_ROYALTY_MAX_BPS = 1000;

/** The team performance incentive band — 0 to 1000 bps (0–10%). */
export const SPORTS_TEAM_INCENTIVE_MAX_BPS = 1000;

/** The full bps pot — a three-way split conserves into exactly this. */
export const SPORTS_BPS_POT = 10_000;

// ---------------------------------------------------------------------------
// The registry records.
// ---------------------------------------------------------------------------

/** One student-athlete profile of record. */
export interface SportsStudentAthleteProfileRecord {
  id: string;
  athlete_glan: string;
  full_name: string;
  school_id: string;
  /** The players association of record — NFLPA or NBAPA, never 'none':
   * every athlete belongs to a union ledger. */
  union_code: Exclude<SportsUnionCode, "none">;
  /** The NIL lane's athlete identifier of record — the join key the NIL
   * deal reconciliation resolves profiles through. */
  nil_athlete_id: string;
  /** The athlete digital wallet payee of record — the group licensing
   * and biometric payout walk's destination. */
  wallet_payee_id: string;
  /** The eligibility flag of record — an ineligible athlete's payouts
   * fail closed (the NIL reconciliation flags them). */
  eligible: boolean;
  created_at: string;
  updated_at: string;
}

/** One (venue, league) scope's resale royalty policy of record. */
export interface SportsResaleRoyaltyPolicyRecord {
  id: string;
  venue_gln: string;
  league_rights_code: string;
  promoter_payee_id: string;
  promoter_payee_name: string;
  venue_payee_id: string;
  venue_payee_name: string;
  league_payee_id: string;
  league_payee_name: string;
  /** The resale royalty cut — the founder band, 500–1000 bps. */
  resale_royalty_bps: number;
  /** The three-way split of the royalty pot — conserves to 10000. */
  promoter_share_bps: number;
  venue_share_bps: number;
  league_share_bps: number;
  created_at: string;
  updated_at: string;
}

/** One league's pool split policy of record. */
export interface SportsLeaguePoolPolicyRecord {
  id: string;
  league_rights_code: string;
  /** The pool's three-way split — conserves to 10000. */
  equal_share_bps: number;
  market_balance_bps: number;
  performance_incentive_bps: number;
  created_at: string;
  updated_at: string;
}

/** One team owner's registration of record. */
export interface SportsLeagueTeamRegistrationRecord {
  id: string;
  league_rights_code: string;
  team_code: string;
  owner_payee_id: string;
  owner_payee_name: string;
  /** The market size and payroll inputs — statement micros. */
  market_size_micros: number;
  payroll_micros: number;
  /** The league salary cap threshold — statement micros. */
  cap_threshold_micros: number;
  /** The team's performance incentive — 0–1000 bps of its incentive
   * pool slice. */
  performance_incentive_bps: number;
  created_at: string;
  updated_at: string;
}

/** One athlete wallet leg of a group licensing application. */
export interface SportsGroupLicensingWalletLeg {
  athlete_glan: string;
  wallet_payee_id: string;
  wallet_cents: number;
}

/** One parsed league contract of record. */
export interface SportsBroadcastingContractRecord {
  id: string;
  contract_ref: string;
  league_rights_code: string;
  contract_class: SportsContractClass;
  contract_gross_cents: number;
  /** The group licensing royalty pot — 0 for the league pool classes. */
  royalty_pool_cents: number;
  union_code: SportsUnionCode;
  union_share_bps: number;
  /** The group licensing roster — the athlete GLANs the royalties walk
   * to; '[]' for the league pool classes. */
  athlete_roster_json: string;
  period: string;
  currency: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// The post records (append-only replay guards).
// ---------------------------------------------------------------------------

/** One primary ticketer settlement row post. */
export interface SportsTicketSalePostRecord {
  id: string;
  source_event_id: string;
  /** The founder's five identity columns — the Net Gate Pool tuple. */
  nil_contract_id: string;
  athlete_glan: string;
  venue_gln: string;
  league_rights_code: string;
  turnstile_scan_hash: string;
  period: string;
  currency: string;
  gross_ticket_revenue_cents: number;
  facility_surcharges_cents: number;
  municipal_taxes_cents: number;
  insurance_reserves_cents: number;
  processor_fee_cuts_cents: number;
  ticket_count: number;
  created_at: string;
}

/** One secondary marketplace resale row post. */
export interface SportsResaleSalePostRecord {
  id: string;
  source_event_id: string;
  venue_gln: string;
  league_rights_code: string;
  resale_gross_cents: number;
  period: string;
  currency: string;
  created_at: string;
}

/** One venue turnstile scan batch post. */
export interface SportsTurnstileScanPostRecord {
  id: string;
  source_event_id: string;
  venue_gln: string;
  turnstile_scan_hash: string;
  scan_count: number;
  period: string;
  currency: string;
  created_at: string;
}

/** One biometric tracking row post. */
export interface SportsBiometricTrackingPostRecord {
  id: string;
  source_event_id: string;
  athlete_glan: string;
  league_rights_code: string;
  tracking_modality: SportsTrackingModality;
  licensee_class: SportsLicenseeClass;
  licensed_quantity_micros: number;
  period: string;
  currency: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// The position-of-record records (recomputed in place).
// ---------------------------------------------------------------------------

/** The turnstile-to-receipt reconciliation of record per venue scope. */
export interface SportsGateReconciliationRecord {
  id: string;
  source_event_id: string;
  venue_gln: string;
  period: string;
  currency: string;
  ticket_count_sum: number;
  scan_count_sum: number;
  /** scans − tickets — signed; flagged verdicts carry the delta. */
  variance_scan_delta: number;
  /** The receipts side of record the scans reconcile against. */
  gross_ticket_revenue_cents: number;
  verdict: SportsGateReconciliationVerdict;
  created_at: string;
  updated_at: string;
}

/** The Net Gate Pool of record per the founder's identity tuple. */
export interface SportsNetVenueRealizationRecord {
  id: string;
  source_event_id: string;
  nil_contract_id: string;
  athlete_glan: string;
  venue_gln: string;
  league_rights_code: string;
  turnstile_scan_hash: string;
  period: string;
  currency: string;
  gross_ticket_revenue_cents: number;
  facility_surcharges_cents: number;
  municipal_taxes_cents: number;
  insurance_reserves_cents: number;
  processor_fee_cuts_cents: number;
  /** gross − facility − taxes − insurance − processor, exact. */
  net_gate_pool_cents: number;
  /** The scope's gate reconciliation identity at recompute time — the
   * realized-after-reconciliation ordering's audit trail. */
  gate_reconciliation_event_id: string;
  gate_reconciliation_verdict: SportsGateReconciliationVerdict;
  verdict: SportsRealizationVerdict;
  created_at: string;
  updated_at: string;
}

/** One team owner's distribution leg. */
export interface SportsLeaguePoolLeg {
  team_code: string;
  owner_payee_id: string;
  owner_payee_name: string;
  equal_share_cents: number;
  market_balance_cents: number;
  cap_floor_cents: number;
  performance_incentive_cents: number;
  total_cents: number;
}

/** The league-wide pool distribution of record per league scope. */
export interface SportsLeaguePoolDistributionRecord {
  id: string;
  source_event_id: string;
  league_rights_code: string;
  period: string;
  currency: string;
  /** Σ broadcasting + merchandise contract gross for the scope. */
  pool_cents: number;
  equal_share_bps: number;
  market_balance_bps: number;
  performance_incentive_bps: number;
  legs_json: string;
  distributed_cents: number;
  dust_cents: number;
  created_at: string;
  updated_at: string;
}

/** The NIL deal waterfall reconciliation of record per contract scope. */
export interface SportsNilDealReconciliationRecord {
  id: string;
  source_event_id: string;
  nil_contract_id: string;
  athlete_glan: string;
  period: string;
  /** The corporate endorsement deals' leg — the NIL lane's brand-sender
   * deal applications of record. */
  endorsement_deal_cents: number;
  /** The booster collective payouts' leg — the NIL lane's
   * collective-sender deal applications of record. */
  booster_collective_cents: number;
  /** The fan-club subscriptions' leg — carried at zero today: the NIL
   * lane has no fan-club sender yet; the class rides the reconciliation
   * so its vocabulary is complete. */
  fan_club_subscription_cents: number;
  /** Σ the three legs — pinned by the CHECK. */
  nil_deal_gross_cents: number;
  verdict: SportsNilReconciliationVerdict;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// The application records (append-only routing truth).
// ---------------------------------------------------------------------------

/** One resale royalty routing of record. */
export interface SportsResaleRoyaltyApplicationRecord {
  id: string;
  source_event_id: string;
  resale_sale_event_id: string;
  venue_gln: string;
  league_rights_code: string;
  resale_gross_cents: number;
  resale_royalty_bps: number;
  promoter_share_bps: number;
  venue_share_bps: number;
  league_share_bps: number;
  /** floor(gross × royalty bps / 10000) — pinned by the CHECK. */
  royalty_pot_cents: number;
  promoter_leg_cents: number;
  venue_leg_cents: number;
  league_leg_cents: number;
  created_at: string;
}

/** One group licensing routing of record. */
export interface SportsGroupLicensingApplicationRecord {
  id: string;
  source_event_id: string;
  contract_ref: string;
  league_rights_code: string;
  union_code: Exclude<SportsUnionCode, "none">;
  union_payee_id: string;
  union_share_bps: number;
  royalty_pool_cents: number;
  union_leg_cents: number;
  athlete_pool_cents: number;
  athlete_wallets_json: string;
  wallet_count: number;
  created_at: string;
}

/** One biometric micro-payout routing of record. */
export interface SportsBiometricMicroPayoutApplicationRecord {
  id: string;
  source_event_id: string;
  biometric_post_event_id: string;
  athlete_glan: string;
  league_rights_code: string;
  tracking_modality: SportsTrackingModality;
  licensee_class: SportsLicenseeClass;
  licensed_quantity_micros: number;
  micros_per_unit: number;
  athlete_share_bps: number;
  payout_pot_cents: number;
  athlete_wallet_payee_id: string;
  athlete_leg_cents: number;
  league_data_payee_id: string;
  league_leg_cents: number;
  created_at: string;
}

/** One biometric micro-payout policy of record per (league, licensee). */
export interface SportsBiometricRoyaltyPolicyRecord {
  id: string;
  league_rights_code: string;
  licensee_class: SportsLicenseeClass;
  league_data_payee_id: string;
  league_data_payee_name: string;
  /** The micro-payout rate — money micros per quantity micro. */
  micros_per_unit: number;
  /** The athlete wallet's share of each payout pot. */
  athlete_share_bps: number;
  created_at: string;
  updated_at: string;
}

/** The period shape — the platform-wide `YYYY-MM` bucket. */
export function isSportsPeriod(period: string): boolean {
  return /^[0-9]{4}-[0-9]{2}$/.test(period);
}
