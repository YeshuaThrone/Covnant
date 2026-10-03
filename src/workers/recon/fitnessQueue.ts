/**
 * CVT recon worker — the fitness lane's store-touching pass (PR 38, the
 * founder fitness directive). The math and identity spaces live in
 * fitness.ts, the profiles in fitnessProfiles.ts; THIS module is the only
 * place the lane touches the store — the same discipline as
 * spatialQueue.ts and nilQueue.ts.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative net is a HELD verdict (visible, never dropped,
 *   never posted), and a trainer-program without a tier schedule of
 *   record, a program without a sync music policy of record (a zero-rate
 *   policy is the operator's explicit "no music cost" statement), a
 *   program without a live load policy, a franchise code without a
 *   policy or a partnership of record, a program without an algorithm
 *   policy of record, and a program with no registered co-creation
 *   waterfall are counted skips — the walk never guesses a rate.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (fitnessRowEventId, the ledger namespace riding the
 *   prefix): a re-shipped sheet replays as a counted no-op.
 * - SYNC MUSIC BEFORE THE TRAINER NET — the per-workout master and
 *   publishing performance royalties come DIRECTLY off the class revenue
 *   before the trainer's net share basis prices; the application row pins
 *   the ordering identity (net basis = revenue − master − publishing) at
 *   the database. The deduction prices only rows that carry class
 *   revenue (completed workout logs) — a stream start has no class
 *   revenue leg to deduct from and walks its tier payout directly.
 * - OVERRIDE AND NETWORK FEE BEFORE THE INSTRUCTOR DISBURSEMENT — the
 *   franchise license override (certified choreography + audio legs) and
 *   the studio network fee come off the class revenue first; the
 *   application row pins that ordering identity at the database.
 *
 * The five senders' walks:
 *
 *   1. DIGITAL STREAM STARTS (sender 'stream_start') — the trainer
 *      royalty tier walk (the row's stream starts ARE completions;
 *      cumulative monthly tracking), plus the live-event streaming
 *      residual when the row is a live broadcast (peak simultaneous
 *      viewers price the server load band).
 *   2. COMPLETED WORKOUT LOGS (sender 'workout_complete') — the sync
 *      music deductions FIRST, then the trainer royalty tier walk on the
 *      net basis, the subscriber retention bonus, and the cumulative
 *      monthly tracker advance.
 *   3. CONNECTED BIKE AND TREADMILL TELEMETRY (sender
 *      'equipment_telemetry') — the wearable / algorithm micro-royalty:
 *      daily active feature usage priced at the policy's per-active-user
 *      micro-fee.
 *   4. STUDIO CLASS CHECK-INS (sender 'studio_checkin') — the franchise
 *      class count tracker, the certified-content license overrides, the
 *      network fee before the instructor disbursement, and (when the
 *      franchise has a partnership of record) the co-branded split of
 *      the net class stream earnings.
 *   5. APP SUBSCRIPTION ALLOCATIONS (sender 'subscription_allocation') —
 *      the Digital Stream Realization (gross pool − engine cut − digital
 *      infrastructure overhead = Net Fitness Content Pool), and (when
 *      the program has registered modules) the module-weighted
 *      co-creation waterfall splitting the realized pool.
 *
 * Fitness rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import {
  parseFitnessLoadBands,
  parseFitnessTierBands,
  validateFitnessCocreationWaterfall,
  type FitnessCocreationModule,
} from "@/modules/fitness/records";
import type { ParsedStatementLine, FitnessLineDetail } from "./records";
import {
  algorithmMicroRoyaltyMicros,
  cobrandSplitCents,
  cocreationWaterfallCents,
  digitalStreamRealizationCents,
  fitnessMicrosToCents,
  fitnessRowEventId,
  franchiseClassOverrideCents,
  retentionBonusMicros,
  liveEventBonusCents,
  serverLoadDeductionCents,
  syncMusicDeductionMicros,
  trainerTierWalk,
  type FitnessSenderCode,
} from "./fitness";

/** The fitness lane's per-pass counters — the honest outcome summary. */
export interface FitnessWriteCounts {
  /** Realization applications committed / counted replay no-ops. */
  realizationApplicationsWritten: number;
  realizationApplicationsReplayed: number;
  /** The negative-pool holds (the money pauses, visible). */
  realizationHeldNegativeNet: number;
  /** Trainer royalty applications committed / counted replay no-ops /
   * fail-closed skips (no tier schedule of record, no sync policy of
   * record for a class-revenue row). */
  royaltyApplicationsWritten: number;
  royaltyApplicationsReplayed: number;
  royaltySkippedNoTierSchedule: number;
  royaltySkippedNoSyncPolicy: number;
  royaltyHeldNegativeNet: number;
  /** Live-event residuals committed / counted replay no-ops / fail-closed
   * skips (no load policy of record for the program). */
  liveResidualsWritten: number;
  liveResidualsReplayed: number;
  liveSkippedNoLoadPolicy: number;
  /** Instant live-event bonuses committed / counted replay no-ops /
   * fail-closed skips (no bonus policy of record for the program). */
  liveEventBonusesWritten: number;
  liveEventBonusesReplayed: number;
  liveSkippedNoBonusPolicy: number;
  /** Franchise applications committed / counted replay no-ops / fail-closed
   * skips (no franchise policy of record for the code). */
  franchiseApplicationsWritten: number;
  franchiseApplicationsReplayed: number;
  franchiseSkippedNoPolicy: number;
  franchiseHeldNegativeNet: number;
  /** Co-brand splits committed / counted replay no-ops / fail-closed
   * skips (no partnership of record for the code, or the studio walk
   * held). */
  cobrandSplitsWritten: number;
  cobrandSplitsReplayed: number;
  cobrandSkippedNoPartnership: number;
  /** Algorithm micro-royalties committed / counted replay no-ops /
   * fail-closed skips (no algorithm policy of record). */
  algorithmRoyaltiesWritten: number;
  algorithmRoyaltiesReplayed: number;
  algorithmSkippedNoPolicy: number;
  /** Co-creation splits committed / counted replay no-ops / fail-closed
   * skips (no registered modules, an invalid waterfall, or a held
   * realization). */
  cocreationApplicationsWritten: number;
  cocreationApplicationsReplayed: number;
  cocreationSkippedNoWaterfall: number;
  /** The committed money, integer cents. */
  netFitnessContentPoolCents: number;
  trainerTierPayoutCents: number;
  retentionBonusCents: number;
  syncMusicDeductionCents: number;
  serverLoadDeductionCents: number;
  liveEventBonusCents: number;
  franchiseOverrideCents: number;
  networkFeeCents: number;
  instructorDisbursementCents: number;
  cobrandIpOwnerCents: number;
  cobrandDistributorCents: number;
  algorithmRoyaltyCents: number;
  cocreationAllocatedCents: number;
}

/**
 * The fitness lane's one pass over a parsed statement's lines — the seven
 * application ledgers (realization, trainer royalties, live residuals,
 * franchise overrides, co-brand splits, algorithm micro-royalties, and
 * co-creation splits) land in the store's fitness tables. Throws into the
 * job's fail-closed error path on any store failure.
 */
export async function writeFitnessRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<FitnessWriteCounts> {
  const counts: FitnessWriteCounts = {
    realizationApplicationsWritten: 0,
    realizationApplicationsReplayed: 0,
    realizationHeldNegativeNet: 0,
    royaltyApplicationsWritten: 0,
    royaltyApplicationsReplayed: 0,
    royaltySkippedNoTierSchedule: 0,
    royaltySkippedNoSyncPolicy: 0,
    royaltyHeldNegativeNet: 0,
    liveResidualsWritten: 0,
    liveResidualsReplayed: 0,
    liveSkippedNoLoadPolicy: 0,
    liveEventBonusesWritten: 0,
    liveEventBonusesReplayed: 0,
    liveSkippedNoBonusPolicy: 0,
    franchiseApplicationsWritten: 0,
    franchiseApplicationsReplayed: 0,
    franchiseSkippedNoPolicy: 0,
    franchiseHeldNegativeNet: 0,
    cobrandSplitsWritten: 0,
    cobrandSplitsReplayed: 0,
    cobrandSkippedNoPartnership: 0,
    algorithmRoyaltiesWritten: 0,
    algorithmRoyaltiesReplayed: 0,
    algorithmSkippedNoPolicy: 0,
    cocreationApplicationsWritten: 0,
    cocreationApplicationsReplayed: 0,
    cocreationSkippedNoWaterfall: 0,
    netFitnessContentPoolCents: 0,
    trainerTierPayoutCents: 0,
    retentionBonusCents: 0,
    syncMusicDeductionCents: 0,
    serverLoadDeductionCents: 0,
    liveEventBonusCents: 0,
    franchiseOverrideCents: 0,
    networkFeeCents: 0,
    instructorDisbursementCents: 0,
    cobrandIpOwnerCents: 0,
    cobrandDistributorCents: 0,
    algorithmRoyaltyCents: 0,
    cocreationAllocatedCents: 0,
  };

  for (const line of lines) {
    const detail = line.fitnessDetail;
    // The fitness profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`fitness_detail_missing: line ${line.lineNumber} has no fitness detail`);
    }

    switch (detail.sender) {
      case "stream_start":
        await walkTrainerRoyalty(store, detail, counts);
        await walkLiveResidual(store, detail, counts);
        continue;
      case "workout_complete":
        await walkTrainerRoyalty(store, detail, counts);
        continue;
      case "equipment_telemetry":
        await walkAlgorithmRoyalty(store, detail, counts);
        continue;
      case "studio_checkin":
        await walkFranchiseOverride(store, detail, counts);
        await walkCobrandSplit(store, detail, counts);
        continue;
      case "subscription_allocation":
        await walkRealization(store, detail, counts);
        await walkCocreationSplit(store, detail, counts);
        continue;
    }
  }

  return counts;
}

/** The line detail's common identity legs — the directive's three keys
 * plus the period and the sender row id every event id fingerprints. */
type FitnessIdentity = {
  sender: FitnessSenderCode;
  trainerId: string;
  programId: string;
  studioFranchiseCode: string;
  period: string;
  senderRowId: string;
};

// ---------------------------------------------------------------------------
// Senders 1 + 2 — the trainer royalty walk (stream starts and completed
// workout logs): the sync music deductions FIRST (class-revenue rows),
// then the tier walk on the trainer's cumulative monthly position, the
// subscriber retention bonus, and the tracker advance.
// ---------------------------------------------------------------------------

async function walkTrainerRoyalty(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "stream_start" | "workout_complete" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  const sourceEventId = fitnessRowEventId("royalty", detail);

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getFitnessTrainerRoyaltyApplication(sourceEventId);
  if (existing !== undefined) {
    counts.royaltyApplicationsReplayed += 1;
    return;
  }

  const completions =
    detail.sender === "stream_start" ? detail.streamStarts : detail.completedWorkouts;
  const classRevenueCents =
    detail.sender === "stream_start" ? 0 : detail.classRevenueCents;

  // The sync music policy of record — class-revenue rows price their
  // per-workout master and publishing deductions here; a program without
  // a policy of record skips fail-closed (the walk never guesses a music
  // rate — a zero-rate policy is the operator's explicit statement).
  // A stream-start row carries no class revenue leg — nothing to deduct
  // from — so the music deduction is out of scope and the walk proceeds
  // to the tier walk directly.
  let syncPolicyRef: string | null = null;
  let masterRate = 0;
  let publishingRate = 0;
  if (detail.sender === "workout_complete") {
    const syncPolicy = await store.getFitnessSyncMusicPolicy(detail.programId);
    if (syncPolicy === undefined) {
      counts.royaltySkippedNoSyncPolicy += 1;
      return;
    }
    syncPolicyRef = syncPolicy.id;
    masterRate = syncPolicy.master_royalty_micros_per_workout;
    publishingRate = syncPolicy.publishing_royalty_micros_per_workout;
  }

  // THE SYNC MUSIC MASTER AND PUBLISHING DEDUCTIONS — per-workout
  // performance royalties off the class revenue BEFORE the trainer net
  // (the ordering the application row pins).
  const sync = syncMusicDeductionMicros({
    workoutCount: detail.sender === "workout_complete" ? completions : 0,
    masterMicrosPerWorkout: masterRate,
    publishingMicrosPerWorkout: publishingRate,
  });
  const syncMasterCents = fitnessMicrosToCents(sync.masterMicros);
  const syncPublishingCents = fitnessMicrosToCents(sync.publishingMicros);
  const trainerNetBasisCents = classRevenueCents - syncMasterCents - syncPublishingCents;

  const month = detail.period;

  // A NEGATIVE NET — the sync music deductions exceeded the class
  // revenue. The math is recorded visible (the held row's truth), the
  // royalty legs zeroed, no tracker advance: the hold IS the record; the
  // next walk re-prices after an operator heals the sheet.
  if (trainerNetBasisCents < 0) {
    await store.insertFitnessTrainerRoyaltyApplication({
      source_event_id: sourceEventId,
      sender: detail.sender,
      trainer_id: detail.trainerId,
      program_id: detail.programId,
      studio_franchise_code: detail.studioFranchiseCode,
      period: detail.period,
      currency: detail.currency,
      completed_count: completions,
      class_revenue_cents: classRevenueCents,
      sync_policy_ref: syncPolicyRef,
      master_royalty_micros_per_workout: masterRate,
      publishing_royalty_micros_per_workout: publishingRate,
      sync_master_micros: Number(sync.masterMicros),
      sync_publishing_micros: Number(sync.publishingMicros),
      sync_master_cents: syncMasterCents,
      sync_publishing_cents: syncPublishingCents,
      trainer_net_basis_cents: trainerNetBasisCents,
      tier_schedule_ref: null,
      tier_legs: "[]",
      tier_payout_micros: 0,
      tier_payout_cents: 0,
      retained_count: 0,
      retention_bonus_micros_per_completion: 0,
      retention_bonus_micros: 0,
      retention_bonus_cents: 0,
      monthly_completions_before: null,
      monthly_completions_after: null,
      verdict: "held_negative_net",
    });
    counts.royaltyApplicationsWritten += 1;
    counts.royaltyHeldNegativeNet += 1;
    counts.syncMusicDeductionCents += syncMasterCents + syncPublishingCents;
    return;
  }

  // The tier schedule of record — no schedule, no royalty (the walk
  // never guesses a rate).
  const schedule = await store.getFitnessTrainerTierSchedule(
    detail.trainerId,
    detail.programId,
  );
  if (schedule === undefined) {
    counts.royaltySkippedNoTierSchedule += 1;
    return;
  }
  const bands = parseFitnessTierBands(schedule.bands, schedule.id);

  // The tracker position BEFORE this row — the cumulative monthly
  // position the walk prices from.
  const before = await store.getFitnessCompletionMonth(
    detail.trainerId,
    detail.programId,
    month,
  );
  const cumulativeBefore = before?.cumulative_completions ?? 0;

  // THE TIER WALK — the row's completions split across the bands they
  // occupy on the cumulative position (the $0.05 → $0.12 scaling).
  const walk = trainerTierWalk({
    completions,
    cumulativeBefore,
    bands,
  });
  const tierPayoutCents = fitnessMicrosToCents(walk.payoutMicros);

  // THE SUBSCRIBER RETENTION BONUS — the schedule's flat micro-fee per
  // retained completion (only completed workout logs carry the
  // retention gate).
  const retainedCount =
    detail.sender === "workout_complete" && detail.subscriberRetained ? completions : 0;
  const retentionMicros = retentionBonusMicros({
    retainedCompletions: retainedCount,
    bonusMicrosPerCompletion: schedule.retention_bonus_micros_per_completion,
  });
  const retentionCents = fitnessMicrosToCents(retentionMicros);

  // The tracker advance — the paid row's completions join the cumulative
  // monthly position.
  const after = await store.advanceFitnessCompletionMonth(
    detail.trainerId,
    detail.programId,
    month,
    completions,
  );

  await store.insertFitnessTrainerRoyaltyApplication({
    source_event_id: sourceEventId,
    sender: detail.sender,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    completed_count: completions,
    class_revenue_cents: classRevenueCents,
    sync_policy_ref: syncPolicyRef,
    master_royalty_micros_per_workout: masterRate,
    publishing_royalty_micros_per_workout: publishingRate,
    sync_master_micros: Number(sync.masterMicros),
    sync_publishing_micros: Number(sync.publishingMicros),
    sync_master_cents: syncMasterCents,
    sync_publishing_cents: syncPublishingCents,
    trainer_net_basis_cents: trainerNetBasisCents,
    tier_schedule_ref: schedule.id,
    tier_legs: JSON.stringify(walk.legs),
    tier_payout_micros: Number(walk.payoutMicros),
    tier_payout_cents: tierPayoutCents,
    retained_count: retainedCount,
    retention_bonus_micros_per_completion: schedule.retention_bonus_micros_per_completion,
    retention_bonus_micros: Number(retentionMicros),
    retention_bonus_cents: retentionCents,
    monthly_completions_before: cumulativeBefore,
    monthly_completions_after: after.cumulative_completions,
    verdict: "paid",
  });
  counts.royaltyApplicationsWritten += 1;
  counts.trainerTierPayoutCents += tierPayoutCents;
  counts.retentionBonusCents += retentionCents;
  counts.syncMusicDeductionCents += syncMasterCents + syncPublishingCents;
}

// ---------------------------------------------------------------------------
// Sender 1 — the live-event streaming residual: the broadcast's peak
// simultaneous viewers price at the load band of record, the band's bps
// floors off the live event revenue.
// ---------------------------------------------------------------------------

async function walkLiveResidual(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "stream_start" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  // A non-broadcast stream start carries no live legs (the profile
  // rejects a contradictory row at parse) — nothing to walk.
  if (!detail.liveBroadcast) {
    return;
  }
  const sourceEventId = fitnessRowEventId("live", detail);

  // The instant performance bonus lane runs BEFORE the residual's replay
  // guard returns — its own replay guard (same source event id) keeps a
  // re-shipped broadcast a counted no-op, and a row first walked before
  // its program had a bonus policy of record can still post the bonus on
  // a later re-ship.
  await walkLiveEventBonus(store, detail, sourceEventId, counts);

  const existing = await store.getFitnessLiveResidualApplication(sourceEventId);
  if (existing !== undefined) {
    counts.liveResidualsReplayed += 1;
    return;
  }

  // The live load policy of record — no policy, no residual (the walk
  // never guesses a server load rate).
  const policy = await store.getFitnessLiveLoadPolicy(detail.programId);
  if (policy === undefined) {
    counts.liveSkippedNoLoadPolicy += 1;
    return;
  }
  const bands = parseFitnessLoadBands(policy.bands, policy.id);

  // THE SERVER LOAD DEDUCTION — the band holding the peak viewers prices
  // the deduction; the residual is the live event revenue less it.
  const residual = serverLoadDeductionCents({
    peakSimultaneousViewers: detail.peakSimultaneousViewers,
    liveEventRevenueCents: detail.liveEventRevenueCents,
    bands,
  });

  await store.insertFitnessLiveResidualApplication({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    peak_simultaneous_viewers: detail.peakSimultaneousViewers,
    live_event_revenue_cents: detail.liveEventRevenueCents,
    load_band_from: residual.bandFrom,
    load_band_to: residual.bandTo,
    server_load_bps: residual.serverLoadBps,
    server_load_deduction_cents: residual.serverLoadDeductionCents,
    net_live_residual_cents: residual.netLiveResidualCents,
  });
  counts.liveResidualsWritten += 1;
  counts.serverLoadDeductionCents += residual.serverLoadDeductionCents;
}

// ---------------------------------------------------------------------------
// Sender 1 — the instant live-event performance bonus: a concluded
// synchronous broadcast posts its lead trainer's instant bonus (the
// program's bonus policy of record priced at the event's revenue) at
// event conclusion — the walk of the concluded broadcast row IS the
// event's conclusion trigger, and the row's trainer_id is the lead
// trainer of record.
// ---------------------------------------------------------------------------

async function walkLiveEventBonus(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "stream_start" }>,
  sourceEventId: string,
  counts: FitnessWriteCounts,
): Promise<void> {
  // The replay guard's read — a re-shipped broadcast is a counted no-op
  // (the UNIQUE constraint is the concurrent backstop behind this read):
  // never a second bonus for one concluded event.
  const existing = await store.getFitnessLiveEventBonus(sourceEventId);
  if (existing !== undefined) {
    counts.liveEventBonusesReplayed += 1;
    return;
  }

  // The bonus policy of record — no policy, no bonus (the walk never
  // guesses a rate; the counted skip is the operator's explicit state).
  const policy = await store.getFitnessLiveEventBonusPolicy(detail.programId);
  if (policy === undefined) {
    counts.liveSkippedNoBonusPolicy += 1;
    return;
  }

  const bonus = liveEventBonusCents({
    liveEventRevenueCents: detail.liveEventRevenueCents,
    bonusBps: policy.bonus_bps,
  });

  await store.insertFitnessLiveEventBonus({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    peak_simultaneous_viewers: detail.peakSimultaneousViewers,
    live_event_revenue_cents: detail.liveEventRevenueCents,
    bonus_bps: policy.bonus_bps,
    bonus_cents: bonus.bonusCents,
  });
  counts.liveEventBonusesWritten += 1;
  counts.liveEventBonusCents += bonus.bonusCents;
}

// ---------------------------------------------------------------------------
// Sender 3 — the wearable / algorithm micro-royalty: the daily active
// feature usage priced at the policy's per-active-user micro-fee.
// ---------------------------------------------------------------------------

async function walkAlgorithmRoyalty(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "equipment_telemetry" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  const sourceEventId = fitnessRowEventId("algo", detail);

  const existing = await store.getFitnessAlgorithmRoyalty(sourceEventId);
  if (existing !== undefined) {
    counts.algorithmRoyaltiesReplayed += 1;
    return;
  }

  // The algorithm policy of record — no policy, no micro-royalty (the
  // walk never guesses a rate; the route to the algorithm creator or
  // celebrity sports scientist is the policy's payee identity).
  const policy = await store.getFitnessAlgorithmPolicy(detail.programId);
  if (policy === undefined) {
    counts.algorithmSkippedNoPolicy += 1;
    return;
  }

  const royalty = algorithmMicroRoyaltyMicros({
    wearableActiveUsers: detail.wearableActiveUsers,
    microsPerActiveUser: policy.micros_per_active_user,
  });

  await store.insertFitnessAlgorithmRoyalty({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    equipment_type: detail.equipmentType,
    equipment_id: detail.senderRowId,
    wearable_active_users: detail.wearableActiveUsers,
    algorithm_creator_id: policy.algorithm_creator_id,
    micros_per_active_user: policy.micros_per_active_user,
    royalty_micros: Number(royalty.royaltyMicros),
    royalty_cents: royalty.royaltyCents,
  });
  counts.algorithmRoyaltiesWritten += 1;
  counts.algorithmRoyaltyCents += royalty.royaltyCents;
}

// ---------------------------------------------------------------------------
// Sender 4 — the studio franchise class override: the tracked class
// counts, the certified-content license overrides, the network fee
// before the instructor disbursement, and the co-branded split of the
// net class stream earnings when a partnership of record exists.
// ---------------------------------------------------------------------------

async function walkFranchiseOverride(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "studio_checkin" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  const sourceEventId = fitnessRowEventId("franchise", detail);

  const existing = await store.getFitnessFranchiseApplication(sourceEventId);
  if (existing !== undefined) {
    counts.franchiseApplicationsReplayed += 1;
    return;
  }

  // The franchise policy of record — no policy, no override walk (the
  // walk never guesses an override or a fee).
  const policy = await store.getFitnessFranchisePolicy(detail.studioFranchiseCode);
  if (policy === undefined) {
    counts.franchiseSkippedNoPolicy += 1;
    return;
  }

  // THE FRANCHISE LICENSE OVERRIDE + NETWORK FEE — the certified
  // choreography and audio legs price the override per leg, the network
  // fee floors off the class revenue, BOTH before the instructor
  // disbursement (the ordering the application row pins).
  const override = franchiseClassOverrideCents({
    classRevenueCents: detail.classRevenueCents,
    certifiedChoreographyRevenueCents: detail.certifiedChoreographyRevenueCents,
    certifiedAudioRevenueCents: detail.certifiedAudioRevenueCents,
    franchiseLicenseOverrideBps: policy.franchise_license_override_bps,
    networkFeeBps: policy.network_fee_bps,
  });

  const month = detail.period;

  // A NEGATIVE DISBURSEMENT — the studio legs exceeded the class
  // revenue. Recorded visible, no tracker advance, and the co-brand
  // split skips (a negative pot splits nothing).
  if (override.instructorDisbursementCents < 0) {
    await store.insertFitnessFranchiseApplication({
      source_event_id: sourceEventId,
      trainer_id: detail.trainerId,
      program_id: detail.programId,
      studio_franchise_code: detail.studioFranchiseCode,
      period: detail.period,
      currency: detail.currency,
      class_count: detail.classCheckins,
      classes_before: null,
      classes_after: null,
      class_revenue_cents: detail.classRevenueCents,
      certified_choreography_revenue_cents: detail.certifiedChoreographyRevenueCents,
      certified_audio_revenue_cents: detail.certifiedAudioRevenueCents,
      franchise_license_override_bps: policy.franchise_license_override_bps,
      choreography_override_cents: 0,
      audio_override_cents: 0,
      franchise_override_total_cents: 0,
      network_fee_bps: policy.network_fee_bps,
      network_fee_cents: 0,
      instructor_disbursement_cents: override.instructorDisbursementCents,
      verdict: "held_negative_net",
    });
    counts.franchiseApplicationsWritten += 1;
    counts.franchiseHeldNegativeNet += 1;
    return;
  }

  // The franchise class count tracker advance — the paid row's check-ins
  // join the franchise-month position.
  const after = await store.advanceFitnessFranchiseClassMonth(
    detail.studioFranchiseCode,
    month,
    detail.classCheckins,
  );

  await store.insertFitnessFranchiseApplication({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    class_count: detail.classCheckins,
    classes_before: after.cumulative_classes - detail.classCheckins,
    classes_after: after.cumulative_classes,
    class_revenue_cents: detail.classRevenueCents,
    certified_choreography_revenue_cents: detail.certifiedChoreographyRevenueCents,
    certified_audio_revenue_cents: detail.certifiedAudioRevenueCents,
    franchise_license_override_bps: policy.franchise_license_override_bps,
    choreography_override_cents: override.choreographyOverrideCents,
    audio_override_cents: override.audioOverrideCents,
    franchise_override_total_cents: override.franchiseOverrideTotalCents,
    network_fee_bps: policy.network_fee_bps,
    network_fee_cents: override.networkFeeCents,
    instructor_disbursement_cents: override.instructorDisbursementCents,
    verdict: "paid",
  });
  counts.franchiseApplicationsWritten += 1;
  counts.franchiseOverrideCents += override.franchiseOverrideTotalCents;
  counts.networkFeeCents += override.networkFeeCents;
  counts.instructorDisbursementCents += override.instructorDisbursementCents;
}

async function walkCobrandSplit(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "studio_checkin" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  const sourceEventId = fitnessRowEventId("cobrand", detail);

  const existing = await store.getFitnessCobrandSplitApplication(sourceEventId);
  if (existing !== undefined) {
    counts.cobrandSplitsReplayed += 1;
    return;
  }

  // The franchise walk of record — the split prices the studio
  // operation's NET (the committed class revenue less the override and
  // network-fee legs). A row the franchise walk skipped or held has no
  // positive pot to split.
  const franchiseApp = await store.getFitnessFranchiseApplication(
    fitnessRowEventId("franchise", detail),
  );
  if (franchiseApp === undefined || franchiseApp.verdict !== "paid") {
    return;
  }

  // The partnership of record — no partnership, no split (a studio
  // without a registered partnership splits nothing).
  const partnership = await store.getFitnessCoBrandPartnership(
    detail.studioFranchiseCode,
  );
  if (partnership === undefined) {
    counts.cobrandSkippedNoPartnership += 1;
    return;
  }

  const netClassStreamEarningsCents =
    franchiseApp.class_revenue_cents -
    franchiseApp.franchise_override_total_cents -
    franchiseApp.network_fee_cents;

  // THE CO-BRAND SPLIT — the partnership's shares divide the net basis
  // (both floored, the 1-cent dust to the distributor — the split
  // conserves its basis exactly).
  const split = cobrandSplitCents({
    netClassStreamEarningsCents,
    ipOwnerShareBps: partnership.ip_owner_share_bps,
    distributorShareBps: partnership.distributor_share_bps,
  });

  await store.insertFitnessCobrandSplitApplication({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    ip_owner_id: partnership.ip_owner_id,
    distributor_id: partnership.distributor_id,
    net_class_stream_earnings_cents: netClassStreamEarningsCents,
    ip_owner_share_bps: partnership.ip_owner_share_bps,
    distributor_share_bps: partnership.distributor_share_bps,
    ip_owner_cents: split.ipOwnerCents,
    distributor_cents: split.distributorCents,
  });
  counts.cobrandSplitsWritten += 1;
  counts.cobrandIpOwnerCents += split.ipOwnerCents;
  counts.cobrandDistributorCents += split.distributorCents;
}

// ---------------------------------------------------------------------------
// Sender 5 — the Digital Stream Realization (the founder's exact
// identity) and, when the program has registered modules, the
// module-weighted co-creation waterfall splitting the realized pool.
// ---------------------------------------------------------------------------

async function walkRealization(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "subscription_allocation" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  const sourceEventId = fitnessRowEventId("realization", detail);

  const existing = await store.getFitnessRealizationApplication(sourceEventId);
  if (existing !== undefined) {
    counts.realizationApplicationsReplayed += 1;
    return;
  }

  // THE DIGITAL STREAM REALIZATION — the allocation sheet's own figures
  // (never a rate guess); the identity (cut + overhead + net === gross)
  // pins the math at the database.
  const realization = digitalStreamRealizationCents({
    grossSubscriptionPoolCents: detail.grossSubscriptionPoolCents,
    appStoreEngineCutCents: detail.appStoreEngineCutCents,
    digitalInfrastructureOverheadCents: detail.digitalInfrastructureOverheadCents,
  });

  // A NEGATIVE POOL — the deduction legs exceeded the gross
  // subscription pool. Recorded visible (the held row's truth), the
  // co-creation split skips (a negative pool splits nothing).
  const held = realization.netFitnessContentPoolCents < 0;

  await store.insertFitnessRealizationApplication({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    gross_subscription_pool_cents: detail.grossSubscriptionPoolCents,
    app_store_engine_cut_cents: detail.appStoreEngineCutCents,
    digital_infrastructure_overhead_cents: detail.digitalInfrastructureOverheadCents,
    net_fitness_content_pool_cents: realization.netFitnessContentPoolCents,
    verdict: held ? "held_negative_net" : "paid",
  });
  counts.realizationApplicationsWritten += 1;
  // The pool of record includes the held row's negative net — the pass
  // summary shows the truth (the spatial lane's precedent).
  counts.netFitnessContentPoolCents += realization.netFitnessContentPoolCents;
  if (held) {
    counts.realizationHeldNegativeNet += 1;
    return;
  }
}

async function walkCocreationSplit(
  store: Store,
  detail: Extract<FitnessLineDetail, { sender: "subscription_allocation" }>,
  counts: FitnessWriteCounts,
): Promise<void> {
  const sourceEventId = fitnessRowEventId("cocreation", detail);

  const existing = await store.getFitnessCocreationApplication(sourceEventId);
  if (existing !== undefined) {
    counts.cocreationApplicationsReplayed += 1;
    return;
  }

  // The realization of record — the waterfall splits the committed Net
  // Fitness Content Pool. A row the realization walk held (negative
  // net) has no positive pool to split.
  const realizationApp = await store.getFitnessRealizationApplication(
    fitnessRowEventId("realization", detail),
  );
  if (realizationApp === undefined || realizationApp.verdict !== "paid") {
    return;
  }

  const netFitnessContentPoolCents = realizationApp.net_fitness_content_pool_cents;

  const moduleRecords = await store.listFitnessCocreationModules(detail.programId);
  if (moduleRecords.length === 0) {
    counts.cocreationSkippedNoWaterfall += 1;
    return;
  }
  const modules: FitnessCocreationModule[] = moduleRecords.map((module_) => ({
    module_id: module_.module_id,
    trainer_id: module_.trainer_id,
    weight_bps: module_.weight_bps,
  }));

  // The waterfall of record — re-validated at read (an unvalidated
  // waterfall skips fail-closed; the split never guesses a weighting).
  const waterfall = validateFitnessCocreationWaterfall(modules);
  if (!waterfall.ok) {
    counts.cocreationSkippedNoWaterfall += 1;
    return;
  }

  // THE MODULE-WEIGHTED SPLIT — largest-remainder exact; the legs'
  // allocated shares conserve the pool exactly.
  const split = cocreationWaterfallCents({
    enrollmentRevenueCents: netFitnessContentPoolCents,
    modules,
  });

  await store.insertFitnessCocreationApplication({
    source_event_id: sourceEventId,
    trainer_id: detail.trainerId,
    program_id: detail.programId,
    studio_franchise_code: detail.studioFranchiseCode,
    period: detail.period,
    currency: detail.currency,
    enrollment_revenue_cents: netFitnessContentPoolCents,
    waterfall_legs: JSON.stringify(split.legs),
    allocated_total_cents: split.allocatedTotalCents,
  });
  counts.cocreationApplicationsWritten += 1;
  counts.cocreationAllocatedCents += split.allocatedTotalCents;
}

// Re-exported for the worker's dispatch — the identity helper's signature
// stays internal to the lane.
export type { FitnessIdentity };
