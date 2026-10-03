/**
 * The fitness revenue record vocabulary (PR 38, migration 0042) — the
 * founder's fitness directive's durable facts of record:
 *
 *   fitness_trainer_tier_schedules   — the trainer and program royalty tier
 *                                      schedule of record per (trainer,
 *                                      program): the per-completed-workout
 *                                      micro-payout bands (the $0.05 → $0.12
 *                                      scaling walk) and the subscriber
 *                                      retention bonus rate.
 *   fitness_completion_months        — the cumulative monthly completion
 *                                      tracker of record per (trainer,
 *                                      program, month): the tier walk's
 *                                      position.
 *   fitness_sync_music_policies      — the sync music master and publishing
 *                                      per-workout rates of record per
 *                                      program, deducted from class revenue
 *                                      BEFORE the trainer net share.
 *   fitness_live_load_policies       — the live-event server load bands of
 *                                      record per program: the sliding bps
 *                                      scale priced on peak simultaneous
 *                                      viewers.
 *   fitness_franchise_policies       — the studio franchise policy of record
 *                                      per studio franchise code: the
 *                                      franchise license override (certified
 *                                      choreographies and audio tracks) and
 *                                      the studio network fee.
 *   fitness_franchise_class_months   — the physical franchise location class
 *                                      count tracker per (franchise code,
 *                                      month).
 *   fitness_co_brand_partnerships    — the studio-to-app partnership of
 *                                      record per franchise code: the
 *                                      brick-and-mortar IP owner and the
 *                                      digital distributor split shares.
 *   fitness_algorithm_policies       — the wearable biometric / algorithm
 *                                      micro-royalty rate of record per
 *                                      program: the algorithm creator or
 *                                      celebrity sports scientist payee and
 *                                      the per-active-user micro-fee.
 *   fitness_cocreation_modules       — the multi-trainer co-creation
 *                                      waterfall of record per (program,
 *                                      module): the module's trainer and its
 *                                      weighting.
 *   fitness_realization_applications — the append-only Digital Stream
 *                                      Realization per allocation event.
 *   fitness_trainer_royalty_applications — the append-only trainer royalty
 *                                      application per stream-start /
 *                                      workout-log event.
 *   fitness_live_residual_applications   — the append-only live-event
 *                                      streaming residual per live broadcast
 *                                      event.
 *   fitness_franchise_applications   — the append-only studio franchise class
 *                                      override per check-in event.
 *   fitness_cobrand_split_applications   — the append-only co-branded
 *                                      franchise split per stream event.
 *   fitness_algorithm_royalty_ledger — the append-only wearable / algorithm
 *                                      micro-royalty per telemetry event.
 *   fitness_cocreation_applications  — the append-only module-weighted
 *                                      enrollment split per allocation
 *                                      event.
 *
 * Money is integer cents throughout; per-unit royalty rates are statement
 * micros (1 dollar = 1e8 micros) so sub-cent per-unit pricing stays exact.
 * Rates are basis points where they price a share of a money basis. No
 * foreign keys by design — the tables key on content-derived event ids, the
 * sender's trainer/program/franchise identifiers, and reporting months (the
 * 0036–0041 discipline).
 */

// ---------------------------------------------------------------------------
// Tier bands — the per-completed-workout micro-payout schedule.
// ---------------------------------------------------------------------------

/** One trainer royalty tier band. `up_to` is the band's exclusive upper
 * bound ON THE CUMULATIVE MONTHLY COMPLETION POSITION — null marks the open
 * top band. Exactly one band per schedule carries `up_to: null`, and it is
 * the LAST band. The founder's example shape: the first 100,000 monthly
 * completions at $0.05 each, everything after at $0.12. */
export type FitnessTierBand = {
  readonly up_to: number | null;
  /** The band's per-completion payout, statement micros (1 dollar = 1e8). */
  readonly micros_per_completion: number;
};

/**
 * Validates a trainer tier schedule at registration — bands in ascending
 * order with strictly increasing bounds, the first bound past zero, exactly
 * one terminal open band (last), and every rate a positive integer micros
 * amount. A schedule that fails any clause is a hostile registration,
 * refused (the walk never guesses a rate).
 */
export function validateFitnessTierBands(
  bands: readonly FitnessTierBand[],
): { ok: true } | { ok: false; reason: string } {
  if (bands.length === 0) return { ok: false, reason: "empty_schedule" };
  let previousBound = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as FitnessTierBand;
    if (!Number.isInteger(band.micros_per_completion) || band.micros_per_completion <= 0) {
      return { ok: false, reason: `band_${index}:micros_per_completion_out_of_range` };
    }
    if (band.up_to === null) {
      if (index !== bands.length - 1) {
        return { ok: false, reason: `band_${index}:open_band_not_last` };
      }
      continue;
    }
    if (!Number.isInteger(band.up_to) || band.up_to <= previousBound) {
      return { ok: false, reason: `band_${index}:bound_not_increasing` };
    }
    previousBound = band.up_to;
  }
  const last = bands[bands.length - 1] as FitnessTierBand;
  if (last.up_to !== null) return { ok: false, reason: "no_open_top_band" };
  return { ok: true };
}

/** Re-validates a stored schedule at walk time — a corrupt or mutated
 * schedule is a fail-closed refusal, never a guessed walk (the spatial
 * schedule discipline). */
export function parseFitnessTierBands(
  bandsJson: string,
  scheduleRef: string,
): readonly FitnessTierBand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bandsJson);
  } catch (error) {
    throw new Error(
      `fitness_tier_bands_corrupt: ${scheduleRef} schedule is not valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`fitness_tier_bands_invalid: ${scheduleRef} — not an array`);
  }
  for (const band of parsed) {
    if (typeof band !== "object" || band === null) {
      throw new Error(`fitness_tier_bands_invalid: ${scheduleRef} — non-object band`);
    }
  }
  const bands = parsed as FitnessTierBand[];
  const outcome = validateFitnessTierBands(bands);
  if (!outcome.ok) {
    throw new Error(`fitness_tier_bands_invalid: ${scheduleRef} — ${outcome.reason}`);
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Live-event server load bands — the sliding bps scale on peak viewers.
// ---------------------------------------------------------------------------

/** One server load band. `up_to` is the band's exclusive upper bound on the
 * broadcast's PEAK SIMULTANEOUS VIEWERS — null marks the open top band.
 * Exactly one band per policy carries `up_to: null`, and it is the LAST
 * band. The founder's example position: a 50,000-simultaneous-viewer
 * weekend broadcast class. */
export type FitnessLoadBand = {
  readonly up_to: number | null;
  /** The band's server load deduction, bps of the live event revenue. */
  readonly server_load_bps: number;
};

/**
 * Validates a live load policy at registration — the same shape clauses as
 * the tier schedule (ascending strictly-increasing bounds, one open top
 * band, positive integer bps 1–10000).
 */
export function validateFitnessLoadBands(
  bands: readonly FitnessLoadBand[],
): { ok: true } | { ok: false; reason: string } {
  if (bands.length === 0) return { ok: false, reason: "empty_schedule" };
  let previousBound = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as FitnessLoadBand;
    if (!Number.isInteger(band.server_load_bps) || band.server_load_bps <= 0 || band.server_load_bps > 10_000) {
      return { ok: false, reason: `band_${index}:server_load_bps_out_of_range` };
    }
    if (band.up_to === null) {
      if (index !== bands.length - 1) {
        return { ok: false, reason: `band_${index}:open_band_not_last` };
      }
      continue;
    }
    if (!Number.isInteger(band.up_to) || band.up_to <= previousBound) {
      return { ok: false, reason: `band_${index}:bound_not_increasing` };
    }
    previousBound = band.up_to;
  }
  const last = bands[bands.length - 1] as FitnessLoadBand;
  if (last.up_to !== null) return { ok: false, reason: "no_open_top_band" };
  return { ok: true };
}

/** Re-validates a stored load policy at walk time. */
export function parseFitnessLoadBands(
  bandsJson: string,
  policyRef: string,
): readonly FitnessLoadBand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bandsJson);
  } catch (error) {
    throw new Error(
      `fitness_load_bands_corrupt: ${policyRef} policy is not valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`fitness_load_bands_invalid: ${policyRef} — not an array`);
  }
  for (const band of parsed) {
    if (typeof band !== "object" || band === null) {
      throw new Error(`fitness_load_bands_invalid: ${policyRef} — non-object band`);
    }
  }
  const bands = parsed as FitnessLoadBand[];
  const outcome = validateFitnessLoadBands(bands);
  if (!outcome.ok) {
    throw new Error(`fitness_load_bands_invalid: ${policyRef} — ${outcome.reason}`);
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Co-creation waterfalls — the module weightings of record.
// ---------------------------------------------------------------------------

/** One co-creation module of record: the module's trainer and its weighting
 * of the program's course enrollment revenue, bps. The program's registered
 * modules' weights sum to exactly 10000 (validated at walk time — the walk
 * never normalizes an unvalidated waterfall). */
export type FitnessCocreationModule = {
  readonly module_id: string;
  readonly trainer_id: string;
  readonly weight_bps: number;
};

/**
 * Validates a program's co-creation waterfall at walk time — at least one
 * module, unique module ids, every weight a positive integer bps, and the
 * weights summing to exactly 10000 bps. A waterfall that fails any clause
 * is a fail-closed refusal (the split never guesses a weighting).
 */
export function validateFitnessCocreationWaterfall(
  modules: readonly FitnessCocreationModule[],
): { ok: true } | { ok: false; reason: string } {
  if (modules.length === 0) return { ok: false, reason: "empty_waterfall" };
  const seen = new Set<string>();
  let weightSum = 0;
  for (let index = 0; index < modules.length; index += 1) {
    const module_ = modules[index] as FitnessCocreationModule;
    if (module_.module_id === "") {
      return { ok: false, reason: `module_${index}:id_empty` };
    }
    if (seen.has(module_.module_id)) {
      return { ok: false, reason: `module_${index}:duplicate_id` };
    }
    seen.add(module_.module_id);
    if (module_.trainer_id === "") {
      return { ok: false, reason: `module_${index}:trainer_empty` };
    }
    if (!Number.isInteger(module_.weight_bps) || module_.weight_bps <= 0 || module_.weight_bps > 10_000) {
      return { ok: false, reason: `module_${index}:weight_bps_out_of_range` };
    }
    weightSum += module_.weight_bps;
  }
  if (weightSum !== 10_000) {
    return { ok: false, reason: "weights_do_not_sum_to_10000" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------

/** The trainer royalty application's verdict of record. `paid` — every
 * policy of record was present and the money walked; `held_negative_net` —
 * the sync music deductions exceeded the class revenue (the math is
 * recorded visible; no royalty posts). */
export type FitnessRoyaltyVerdict = "paid" | "held_negative_net";

/** The trainer tier schedule of record per (trainer, program) — the
 * per-completion micro-payout bands and the subscriber retention bonus
 * rate. */
export type FitnessTrainerTierScheduleRecord = {
  id: string;
  trainer_id: string;
  program_id: string;
  /** The tier bands of record — JSON-encoded FitnessTierBand[]. */
  bands: string;
  /** The subscriber retention bonus, statement micros per retained
   * completion (0 = the schedule pays no retention bonus). */
  retention_bonus_micros_per_completion: number;
  created_at: string;
  updated_at: string;
};

/** The cumulative monthly completion tracker of record per (trainer,
 * program, month) — the tier walk's position, advanced by every
 * completion-bearing row. */
export type FitnessCompletionMonthRecord = {
  id: string;
  trainer_id: string;
  program_id: string;
  /** The reporting month of record (YYYY-MM) — the tracking is monthly. */
  month: string;
  cumulative_completions: number;
  created_at: string;
  updated_at: string;
};

/** The sync music rate of record per program — the per-workout master and
 * publishing performance royalties deducted from class revenue BEFORE the
 * trainer net share (the ordering the application rows pin). Both rates are
 * statement micros per workout (1 dollar = 1e8). */
export type FitnessSyncMusicPolicyRecord = {
  id: string;
  program_id: string;
  master_royalty_micros_per_workout: number;
  publishing_royalty_micros_per_workout: number;
  created_at: string;
  updated_at: string;
};

/** The live-event server load policy of record per program — the sliding
 * bps bands priced on the broadcast's peak simultaneous viewers. */
export type FitnessLiveLoadPolicyRecord = {
  id: string;
  program_id: string;
  /** The load bands of record — JSON-encoded FitnessLoadBand[]. */
  bands: string;
  created_at: string;
  updated_at: string;
};

/** The studio franchise policy of record per franchise code — the franchise
 * license override applied on certified workout choreographies and audio
 * tracks, and the studio network fee deducted prior to instructor
 * disbursement. */
export type FitnessFranchisePolicyRecord = {
  id: string;
  studio_franchise_code: string;
  /** The license override, bps of each certified content leg. */
  franchise_license_override_bps: number;
  /** The studio network fee, bps of the class revenue. */
  network_fee_bps: number;
  created_at: string;
  updated_at: string;
};

/** The physical franchise location class count tracker of record per
 * (franchise code, month). */
export type FitnessFranchiseClassMonthRecord = {
  id: string;
  studio_franchise_code: string;
  month: string;
  cumulative_classes: number;
  created_at: string;
  updated_at: string;
};

/** The studio-to-app partnership of record per franchise code — the
 * brick-and-mortar IP owner and the digital distributor who split the net
 * class stream earnings. The two shares sum to exactly 10000 bps (pinned —
 * the split conserves its basis). */
export type FitnessCoBrandPartnershipRecord = {
  id: string;
  studio_franchise_code: string;
  /** The brick-and-mortar IP owner's payee identity of record. */
  ip_owner_id: string;
  /** The digital distributor's payee identity of record. */
  distributor_id: string;
  ip_owner_share_bps: number;
  distributor_share_bps: number;
  created_at: string;
  updated_at: string;
};

/** The wearable biometric / algorithm micro-royalty rate of record per
 * program — the algorithm creator or celebrity sports scientist payee and
 * the per-active-user micro-fee (statement micros per daily active user). */
export type FitnessAlgorithmPolicyRecord = {
  id: string;
  program_id: string;
  algorithm_creator_id: string;
  micros_per_active_user: number;
  created_at: string;
  updated_at: string;
};

/** One module of a program's co-creation waterfall of record. */
export type FitnessCocreationModuleRecord = {
  id: string;
  program_id: string;
  module_id: string;
  trainer_id: string;
  weight_bps: number;
  created_at: string;
  updated_at: string;
};

/** The per-event Digital Stream Realization of record — the founder's
 * exact identity keyed on the trainer_id, program_id, and
 * studio_franchise_code columns:
 *
 *   Net Fitness Content Pool =
 *     gross subscription pool
 *     − app store engine cut
 *     − digital infrastructure overhead
 */
export type FitnessRealizationApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  trainer_id: string;
  program_id: string;
  /** The founder-specified key of record ('' when the content is not
   * franchise-associated). */
  studio_franchise_code: string;
  period: string;
  currency: string;
  gross_subscription_pool_cents: number;
  app_store_engine_cut_cents: number;
  digital_infrastructure_overhead_cents: number;
  /** gross − cut − overhead — the identity pinned in a CHECK. */
  net_fitness_content_pool_cents: number;
  verdict: FitnessRoyaltyVerdict;
  created_at: string;
};

/** One tier walk leg — the trainer royalty application's committed band
 * math (per-unit pricing: bigint-exact micros, no remainder allocation). */
export type FitnessTierWalkLeg = {
  /** The band's exclusive lower bound on the monthly completion position. */
  readonly band_from: number;
  /** The band's exclusive upper bound (null = the open top band). */
  readonly band_to: number | null;
  readonly micros_per_completion: number;
  /** The row's completions this band held. */
  readonly band_completions: number;
  /** band_completions × micros_per_completion, exact micros. */
  readonly band_payout_micros: number;
};

/** The per-event trainer royalty application of record — the sync music
 * deductions (BEFORE the trainer net, the ordering pinned in a CHECK), the
 * tier walk's committed bands, and the subscriber retention bonus. */
export type FitnessTrainerRoyaltyApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The sender family whose sheet the row walked. */
  sender: "stream_start" | "workout_complete";
  trainer_id: string;
  program_id: string;
  studio_franchise_code: string;
  period: string;
  currency: string;
  /** The row's completions of record. */
  completed_count: number;
  class_revenue_cents: number;
  /** The sync music rates of record the math priced from (pinned, not
   * joined). */
  sync_policy_ref: string | null;
  master_royalty_micros_per_workout: number;
  publishing_royalty_micros_per_workout: number;
  /** completed_count × rate, exact micros. */
  sync_master_micros: number;
  sync_publishing_micros: number;
  /** The floored payable cents per sync leg. */
  sync_master_cents: number;
  sync_publishing_cents: number;
  /** class revenue − sync master − sync publishing (the trainer's net
   * share basis — the sync deductions came FIRST). */
  trainer_net_basis_cents: number;
  tier_schedule_ref: string | null;
  /** The committed tier walk — JSON-encoded FitnessTierWalkLeg[]. */
  tier_legs: string;
  tier_payout_micros: number;
  tier_payout_cents: number;
  /** The completions this row priced at the retention bonus. */
  retained_count: number;
  retention_bonus_micros_per_completion: number;
  retention_bonus_micros: number;
  retention_bonus_cents: number;
  /** The (trainer, program, month) tracker position before/after this row
   * (null when held — held rows advance nothing). */
  monthly_completions_before: number | null;
  monthly_completions_after: number | null;
  verdict: FitnessRoyaltyVerdict;
  created_at: string;
};

/** The per-event live-event streaming residual of record — the real-time
 * server load deduction priced at the band holding the broadcast's peak
 * simultaneous viewers, off the live event revenue. */
export type FitnessLiveResidualApplicationRecord = {
  id: string;
  source_event_id: string;
  trainer_id: string;
  program_id: string;
  studio_franchise_code: string;
  period: string;
  currency: string;
  peak_simultaneous_viewers: number;
  live_event_revenue_cents: number;
  /** The band of record the peak viewers priced in. */
  load_band_from: number;
  load_band_to: number | null;
  server_load_bps: number;
  /** floor(revenue × bps / 10000). */
  server_load_deduction_cents: number;
  /** revenue − deduction — the live event's residual of record. */
  net_live_residual_cents: number;
  created_at: string;
};

/** The per-event studio franchise class override of record — the physical
 * location's class count (tracked), the franchise license override on the
 * certified choreography and audio track legs, and the studio network fee
 * deducted prior to instructor disbursement (the ordering pinned in a
 * CHECK). */
export type FitnessFranchiseApplicationRecord = {
  id: string;
  source_event_id: string;
  trainer_id: string;
  program_id: string;
  studio_franchise_code: string;
  period: string;
  currency: string;
  class_count: number;
  classes_before: number | null;
  classes_after: number | null;
  class_revenue_cents: number;
  certified_choreography_revenue_cents: number;
  certified_audio_revenue_cents: number;
  franchise_license_override_bps: number;
  /** floor(certified leg × bps / 10000), per leg. */
  choreography_override_cents: number;
  audio_override_cents: number;
  franchise_override_total_cents: number;
  network_fee_bps: number;
  /** floor(class revenue × bps / 10000). */
  network_fee_cents: number;
  /** class revenue − override total − network fee. */
  instructor_disbursement_cents: number;
  verdict: FitnessRoyaltyVerdict;
  created_at: string;
};

/** The per-event co-branded franchise split of record — the net class
 * stream earnings split between the brick-and-mortar IP owner and the
 * digital distributor per the partnership of record (the founder's
 * boutique-gym × at-home-bike 50-50 shape). */
export type FitnessCobrandSplitApplicationRecord = {
  id: string;
  source_event_id: string;
  trainer_id: string;
  program_id: string;
  studio_franchise_code: string;
  period: string;
  currency: string;
  ip_owner_id: string;
  distributor_id: string;
  /** The net class stream earnings of record (post sync deductions). */
  net_class_stream_earnings_cents: number;
  ip_owner_share_bps: number;
  distributor_share_bps: number;
  ip_owner_cents: number;
  distributor_cents: number;
  created_at: string;
};

/** The per-event wearable / algorithm micro-royalty of record — the daily
 * active feature usage priced at the policy's per-active-user micro-fee,
 * bigint-exact. */
export type FitnessAlgorithmRoyaltyRecord = {
  id: string;
  source_event_id: string;
  trainer_id: string;
  program_id: string;
  studio_franchise_code: string;
  period: string;
  currency: string;
  equipment_type: "connected_bike" | "treadmill";
  equipment_id: string;
  wearable_active_users: number;
  algorithm_creator_id: string;
  micros_per_active_user: number;
  /** wearable_active_users × rate, exact micros. */
  royalty_micros: number;
  /** floor(royalty_micros / 1e6) — the payable cents. */
  royalty_cents: number;
  created_at: string;
};

/** One committed co-creation waterfall leg — the module's allocated share
 * of the enrollment revenue. */
export type FitnessCocreationWalkLeg = {
  readonly module_id: string;
  readonly trainer_id: string;
  readonly weight_bps: number;
  /** The module's allocated share, whole cents (largest-remainder exact). */
  readonly allocated_cents: number;
};

/** The per-event module-weighted co-creation split of record — the course
 * enrollment revenue split across the program's registered module
 * weightings, conserved exactly. */
export type FitnessCocreationApplicationRecord = {
  id: string;
  source_event_id: string;
  trainer_id: string;
  program_id: string;
  studio_franchise_code: string;
  period: string;
  currency: string;
  enrollment_revenue_cents: number;
  /** The committed waterfall — JSON-encoded FitnessCocreationWalkLeg[]. */
  waterfall_legs: string;
  allocated_total_cents: number;
  created_at: string;
};

/** Validates a co-brand partnership's shares at registration — positive
 * integer bps summing to exactly 10000 (the split conserves its basis). */
export function validateFitnessCoBrandShares(
  ipOwnerShareBps: number,
  distributorShareBps: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(ipOwnerShareBps) || ipOwnerShareBps <= 0 || ipOwnerShareBps > 10_000) {
    return { ok: false, reason: "ip_owner_share_bps_out_of_range" };
  }
  if (
    !Number.isInteger(distributorShareBps) ||
    distributorShareBps <= 0 ||
    distributorShareBps > 10_000
  ) {
    return { ok: false, reason: "distributor_share_bps_out_of_range" };
  }
  if (ipOwnerShareBps + distributorShareBps !== 10_000) {
    return { ok: false, reason: "shares_do_not_sum_to_10000" };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// FITNESS_AUDIT_ESCROW (PR 39, the founder fitness directive) — the
// fitness-side audit escrow's records: the founder-banded policy of record
// per (trainer, studio franchise) scope, the position-locked drawdowns the
// three exposure classes drive (member chargeback reserves, class return
// allowances, quarterly sync music licensing audits), and the verified
// reconciliation of record the release reads. The tables are the 0041
// spatial escrow's twins; the shape tracks them 1:1.
// --------------------------------------------------------------------------

/** The escrow's three drawdown classes of record — exactly the exposures
 * the founder directive names. Anything else refuses. */
export const FITNESS_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "chargeback_reserve",
  "class_return_allowance",
  "sync_music_licensing_audit",
] as const;
export type FitnessAuditEscrowDrawdownClass =
  (typeof FITNESS_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

/** One scope's escrow rate of record (migration 0043) — a founder-banded
 * 500–1000 bps share of the scope's fitness IP payouts that locks into the
 * FITNESS_AUDIT_ESCROW bucket at routing. */
export interface FitnessAuditEscrowPolicyRecord {
  readonly id: string;
  /** `trainer:{trainerId}:studio:{studioFranchiseCode}` — the scope key
   * the escrow's sentinel payee and GL account cite. */
  readonly scope_key: string;
  /** The founder band: 500–1000 bps, checked at registration and again
   * at use (a hostile policy out-of-band refuses). */
  readonly reserve_rate_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One position-locked escrow drawdown (migration 0043) — append-only.
 * UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
 * UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position lock
 * the balance is derived from. */
export interface FitnessAuditEscrowDrawdownRecord {
  readonly id: string;
  /** The escrow bucket's ledger_transactions row of record. */
  readonly reserve_ledger_id: string;
  readonly scope_key: string;
  readonly drawdown_class: FitnessAuditEscrowDrawdownClass;
  /** The drawing event's identity of record — the replay guard. */
  readonly source_event_id: string;
  /** The bucket balance this draw was taken against (the spend position). */
  readonly drawn_before_cents: number;
  /** The drawn amount: 0 < drawn_cents <= drawn_before_cents. */
  readonly drawn_cents: number;
  /** drawn_before_cents - drawn_cents, pinned in a CHECK. */
  readonly remaining_cents: number;
  readonly created_at: string;
}

/** The verified reconciliation of record for one escrow bucket (migration
 * 0043) — insert-as-lock, one per bucket: the release refuses fail-closed
 * until this row exists. */
export interface FitnessAuditEscrowReconciliationRecord {
  readonly id: string;
  readonly reserve_ledger_id: string;
  /** The reconciliation evidence of record (report ref, export hash). */
  readonly evidence_ref: string;
  /** Who verified the reconciliation of record. */
  readonly reconciled_by: string;
  readonly created_at: string;
}

/**
 * The fitness payout gate's states of record for one payee in one studio
 * franchise (migration 0043) — the two states the payout gate's fitness
 * case reads, fail-closed: `hipaa_gdpr_privacy_cleared` is true only when
 * the privacy state is 'cleared', `territorial_studio_exclusivity_verified`
 * is true only when the exclusivity state is 'verified'; an absent record
 * resolves null and 'unknown' resolves false.
 */
export interface FitnessPayoutGateStateRecord {
  readonly id: string;
  /** The payout's beneficiary of record (the trainer). */
  readonly payee_id: string;
  /** The studio franchise whose exclusivity terms govern the payout. */
  readonly studio_franchise_code: string;
  /** HIPAA/GDPR privacy clearance over the workout telemetry. */
  readonly hipaa_gdpr_privacy_state: "unknown" | "cleared";
  /** Territorial studio exclusivity verification. */
  readonly territorial_exclusivity_state: "unknown" | "verified";
  /** The verification evidence of record. */
  readonly evidence_ref: string;
  /** Who verified the states of record. */
  readonly verified_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// --------------------------------------------------------------------------
// Instant live-event performance bonuses (PR 39, the founder fitness
// directive): a synchronous live workout event's concluded row of record
// (the stream_start row carrying the peak simultaneous viewers and the
// live event revenue) posts an instant performance bonus to the lead
// trainer's ledger at event conclusion — priced from the program's bonus
// policy of record, never guessed.
// --------------------------------------------------------------------------

/** One program's instant live-event bonus rate of record (migration
 * 0043) — the bonus bps share of the live event revenue that posts to the
 * lead trainer at event conclusion. A program without a policy is a
 * counted skip: the walk never guesses a rate. */
export interface FitnessLiveEventBonusPolicyRecord {
  readonly id: string;
  readonly program_id: string;
  /** The bonus share of the live event revenue, in bps (1–10000). */
  readonly bonus_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One concluded live event's instant performance bonus (migration 0043)
 * — append-only, UNIQUE per source_event_id (the replay guard), the lead
 * trainer's ledger entry of record for the event. */
export interface FitnessLiveEventBonusRecord {
  readonly id: string;
  /** The concluded broadcast row's event id of record — the replay
   * guard. */
  readonly source_event_id: string;
  /** The event's lead trainer of record — the bonus's beneficiary. */
  readonly trainer_id: string;
  readonly program_id: string;
  readonly studio_franchise_code: string;
  readonly period: string;
  readonly currency: string;
  /** The concluded event's peak simultaneous viewers of record. */
  readonly peak_simultaneous_viewers: number;
  /** The concluded event's revenue of record (integer cents). */
  readonly live_event_revenue_cents: number;
  /** The policy rate of record priced for this event. */
  readonly bonus_bps: number;
  /** floor(revenue × bps / 10000), pinned in a CHECK — integer cents. */
  readonly bonus_cents: number;
  readonly created_at: string;
}

/** The fitness audit escrow's scope key — injective in the (trainer,
 * studio franchise) pair, the same identifier space the 0042 lane keys
 * on. The sentinel payee id, GL account, and policy row all cite it. */
export function fitnessAuditEscrowScopeKey(
  trainerId: string,
  studioFranchiseCode: string,
): string {
  return `trainer:${trainerId}:studio:${studioFranchiseCode}`;
}
