/**
 * CVT recon worker — the fitness lane's pure engine (PR 38, the founder
 * fitness directive): the identity spaces, THE DIGITAL STREAM REALIZATION
 * CALCULATOR, the trainer and program royalty tier walk on cumulative
 * monthly completions, the subscriber retention bonus, the sync music
 * master and publishing deductions (BEFORE the trainer net share), the
 * live-event server load deduction, the studio franchise class override,
 * the co-branded franchise split, the wearable/algorithm micro-royalty, and
 * the module-weighted co-creation waterfall.
 *
 * Every function here is pure — no store, no I/O — and exact to the cent:
 * deductions floor per leg (never round up — the house money discipline),
 * the calculators' identities hold on every input, the tier walk's band
 * allocations conserve the completions exactly, and every micro-royalty is
 * bigint-exact statement micros floored into payable cents. The queue
 * writer consumes these; the profiles parse into them.
 */

import { createHash } from "node:crypto";

import type {
  FitnessCocreationModule,
  FitnessCocreationWalkLeg,
  FitnessLoadBand,
  FitnessTierBand,
  FitnessTierWalkLeg,
} from "@/modules/fitness/records";

/** The fitness lane's statement senders — the five strict layouts' families. */
export type FitnessSenderCode =
  | "stream_start"
  | "workout_complete"
  | "equipment_telemetry"
  | "studio_checkin"
  | "subscription_allocation";

function fitnessFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (ledger, sender, trainer, program, franchise
 * code, period, sender row id). The sender's row id of record is the
 * identity core: a re-shipped sheet replays as a counted no-op, and two
 * senders' sheets for the same trainer stay distinct identities. The ledger
 * namespace rides the prefix — one source event can appear in several
 * ledgers (a live co-branded stream walks the royalty, residual, and split
 * ledgers) without colliding.
 */
export function fitnessRowEventId(
  ledger:
    | "realization"
    | "royalty"
    | "live"
    | "franchise"
    | "cobrand"
    | "algo"
    | "cocreation",
  detail: {
    sender: FitnessSenderCode;
    trainerId: string;
    programId: string;
    studioFranchiseCode: string;
    period: string;
    senderRowId: string;
  },
): string {
  return `fitness:${ledger}:${detail.sender}:${fitnessFingerprint(
    detail.trainerId,
    detail.programId,
    detail.studioFranchiseCode,
    detail.period,
    detail.senderRowId,
  )}`;
}

/** The reporting period's shape of record (YYYY-MM) — the tracking is
 * monthly. */
export function isFitnessPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Floor-divides exact micros into whole cents — the house conversion
 * (1 dollar = 1e8 statement micros, so 1e6 micros per cent). A negative
 * basis is hostile upstream; this helper never sees one. */
export function fitnessMicrosToCents(micros: bigint): number {
  return Number(micros / 1_000_000n);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function fitnessBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE DIGITAL STREAM REALIZATION CALCULATOR (the founder directive's exact
 * identity, keyed on the row's trainer_id, program_id, and
 * studio_franchise_code columns — the identity legs ride the application):
 *
 *   Net Fitness Content Pool =
 *     gross subscription pool
 *     − app store engine cut
 *     − digital infrastructure overhead
 *
 * Every leg is a recorded money amount (the allocation sheet's own figures
 * — never a rate guess). The identity (cut + overhead + net === gross)
 * pins the math. A deduction set larger than the gross yields a negative
 * net — the CALLER holds that application (held_negative_net); this
 * function records the arithmetic honestly either way.
 */
export function digitalStreamRealizationCents(input: {
  grossSubscriptionPoolCents: number;
  appStoreEngineCutCents: number;
  digitalInfrastructureOverheadCents: number;
}): {
  grossSubscriptionPoolCents: number;
  netFitnessContentPoolCents: number;
} {
  const legs = [
    input.grossSubscriptionPoolCents,
    input.appStoreEngineCutCents,
    input.digitalInfrastructureOverheadCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`fitness_realization_invalid_leg:${leg}`);
    }
  }
  const netFitnessContentPoolCents =
    input.grossSubscriptionPoolCents -
    input.appStoreEngineCutCents -
    input.digitalInfrastructureOverheadCents;
  return {
    grossSubscriptionPoolCents: input.grossSubscriptionPoolCents,
    netFitnessContentPoolCents,
  };
}

/**
 * The band containing one position — the band whose (lower, upper] window
 * holds it (the first band's lower is 0; the open top band's upper is
 * infinite). Position 100,000 prices in the first band ("the first 100000
 * monthly completions" include the 100,000th); position 100,001 prices in
 * the open top band — the founder's $0.12 applies strictly POST 100,000.
 * Works for both the tier bands (per-completion micros) and the server
 * load bands (per-viewer bps) — the same window shape. Returns undefined
 * when no band holds the position (an unvalidated schedule — callers
 * re-validate bands at read).
 */
export function fitnessBandForPosition<B extends { up_to: number | null }>(
  position: number,
  bands: readonly B[],
): { band: B; lower: number } | undefined {
  let lower = 0;
  for (const band of bands) {
    const upper = band.up_to;
    if (upper === null || position <= upper) {
      return { band, lower };
    }
    lower = upper;
  }
  return undefined;
}

/**
 * THE TRAINER AND PROGRAM ROYALTY TIER WALK — the row's completions cross
 * the (trainer, program, month) cumulative position, and the completions
 * split across the tier bands they occupy (largest position first — the
 * founder's $0.05 scaling to $0.12 POST 100,000 monthly completions), each
 * band's payout exactly band_completions × band micros (bigint-exact,
 * per-unit pricing — no remainder allocation):
 *
 *   band payout = band_completions × band_micros_per_completion
 *
 * A row entirely inside the first band prices wholly at that band's rate; a
 * row straddling the 100,000 boundary splits exactly — the cumulative
 * position tracks monthly completions across every row of the month (both
 * completion-bearing senders advance the same tracker). Requires
 * completions > 0; the position must be non-negative.
 */
export function trainerTierWalk(input: {
  completions: number;
  cumulativeBefore: number;
  bands: readonly FitnessTierBand[];
}): {
  legs: FitnessTierWalkLeg[];
  payoutMicros: bigint;
  cumulativeAfter: number;
} {
  const { completions, cumulativeBefore, bands } = input;
  if (!Number.isInteger(completions) || completions <= 0) {
    throw new Error(`fitness_walk_invalid_completions:${completions}`);
  }
  if (!Number.isInteger(cumulativeBefore) || cumulativeBefore < 0) {
    throw new Error(`fitness_walk_invalid_position:${cumulativeBefore}`);
  }
  const cumulativeAfter = cumulativeBefore + completions;

  // The completions each band holds: band window ∩ (before, after].
  type BandSlot = { band: FitnessTierBand; lower: number; completions: number };
  const slots: BandSlot[] = [];
  {
    let lower = 0;
    for (const band of bands) {
      const upper = band.up_to;
      const bandLow = Math.max(cumulativeBefore, lower);
      const bandHigh = upper === null ? cumulativeAfter : Math.min(cumulativeAfter, upper);
      slots.push({ band, lower, completions: Math.max(0, bandHigh - bandLow) });
      if (upper === null) break;
      lower = upper;
    }
  }

  const legs: FitnessTierWalkLeg[] = [];
  let payoutMicros = 0n;
  for (const slot of slots) {
    if (slot.completions <= 0) continue;
    const bandPayoutMicros = BigInt(slot.completions) * BigInt(slot.band.micros_per_completion);
    legs.push({
      band_from: slot.lower,
      band_to: slot.band.up_to,
      micros_per_completion: slot.band.micros_per_completion,
      band_completions: slot.completions,
      band_payout_micros: Number(bandPayoutMicros),
    });
    payoutMicros += bandPayoutMicros;
  }

  return { legs, payoutMicros, cumulativeAfter };
}

/**
 * THE SUBSCRIBER RETENTION BONUS — the schedule's flat micro-fee per
 * retained completion (the row's completions when the sheet flags the
 * subscriber retained). Bigint-exact; 0-rate schedules pay 0.
 */
export function retentionBonusMicros(input: {
  retainedCompletions: number;
  bonusMicrosPerCompletion: number;
}): bigint {
  const { retainedCompletions, bonusMicrosPerCompletion } = input;
  if (!Number.isInteger(retainedCompletions) || retainedCompletions < 0) {
    throw new Error(`fitness_retention_invalid_count:${retainedCompletions}`);
  }
  if (!Number.isInteger(bonusMicrosPerCompletion) || bonusMicrosPerCompletion < 0) {
    throw new Error(`fitness_retention_invalid_rate:${bonusMicrosPerCompletion}`);
  }
  return BigInt(retainedCompletions) * BigInt(bonusMicrosPerCompletion);
}

/**
 * THE SYNC MUSIC MASTER AND PUBLISHING DEDUCTIONS — the per-workout
 * performance royalties deducted DIRECTLY from the class revenue BEFORE the
 * trainer net share (the ordering the application row pins: master +
 * publishing + trainer net basis === class revenue). Each leg is
 * bigint-exact micros floored into payable cents; a missing policy of
 * record skips the walk fail-closed (this function never guesses a music
 * rate).
 */
export function syncMusicDeductionMicros(input: {
  workoutCount: number;
  masterMicrosPerWorkout: number;
  publishingMicrosPerWorkout: number;
}): {
  masterMicros: bigint;
  publishingMicros: bigint;
  totalMicros: bigint;
} {
  const { workoutCount, masterMicrosPerWorkout, publishingMicrosPerWorkout } = input;
  if (!Number.isInteger(workoutCount) || workoutCount < 0) {
    throw new Error(`fitness_sync_invalid_workouts:${workoutCount}`);
  }
  if (
    !Number.isInteger(masterMicrosPerWorkout) ||
    masterMicrosPerWorkout < 0 ||
    !Number.isInteger(publishingMicrosPerWorkout) ||
    publishingMicrosPerWorkout < 0
  ) {
    throw new Error(
      `fitness_sync_invalid_rates:${masterMicrosPerWorkout}:${publishingMicrosPerWorkout}`,
    );
  }
  const masterMicros = BigInt(workoutCount) * BigInt(masterMicrosPerWorkout);
  const publishingMicros = BigInt(workoutCount) * BigInt(publishingMicrosPerWorkout);
  return { masterMicros, publishingMicros, totalMicros: masterMicros + publishingMicros };
}

/**
 * THE LIVE-EVENT SERVER LOAD DEDUCTION — the real-time deduction for live
 * interactive workouts: the broadcast's peak simultaneous viewers price at
 * the load band holding that position, and the band's bps floors off the
 * live event revenue (the founder's 50,000-simultaneous-viewer weekend
 * broadcast example). One position, one band, one floored deduction —
 * scaling is the policy's band ladder (a larger audience prices at a
 * higher-bps band).
 */
export function serverLoadDeductionCents(input: {
  peakSimultaneousViewers: number;
  liveEventRevenueCents: number;
  bands: readonly FitnessLoadBand[];
}): {
  bandFrom: number;
  bandTo: number | null;
  serverLoadBps: number;
  serverLoadDeductionCents: number;
  netLiveResidualCents: number;
} {
  const { peakSimultaneousViewers, liveEventRevenueCents, bands } = input;
  if (!Number.isInteger(peakSimultaneousViewers) || peakSimultaneousViewers < 0) {
    throw new Error(`fitness_live_invalid_viewers:${peakSimultaneousViewers}`);
  }
  if (!Number.isInteger(liveEventRevenueCents) || liveEventRevenueCents < 0) {
    throw new Error(`fitness_live_invalid_revenue:${liveEventRevenueCents}`);
  }
  const found = fitnessBandForPosition(peakSimultaneousViewers, bands);
  if (found === undefined) {
    throw new Error(`fitness_live_no_band:${peakSimultaneousViewers}`);
  }
  const serverLoadDeductionCents = fitnessBpsShareCents(
    liveEventRevenueCents,
    found.band.server_load_bps,
  );
  return {
    bandFrom: found.lower,
    bandTo: found.band.up_to,
    serverLoadBps: found.band.server_load_bps,
    serverLoadDeductionCents,
    netLiveResidualCents: liveEventRevenueCents - serverLoadDeductionCents,
  };
}

/**
 * THE INSTANT LIVE-EVENT PERFORMANCE BONUS (PR 39, the founder fitness
 * directive) — a concluded synchronous live workout event (a 50,000-user
 * weekend broadcast) prices its lead trainer's instant bonus as the
 * program's bonus policy share of the event's revenue of record,
 * floored to whole cents. The policy's bps of record is pinned on the
 * application row alongside the priced amount; a rate outside the
 * policy-upsert's 1–10000 bps envelope never reaches this pricer.
 */
export function liveEventBonusCents(input: {
  liveEventRevenueCents: number;
  bonusBps: number;
}): { bonusBps: number; bonusCents: number } {
  const { liveEventRevenueCents, bonusBps } = input;
  if (!Number.isInteger(liveEventRevenueCents) || liveEventRevenueCents < 0) {
    throw new Error(`fitness_live_bonus_invalid_revenue:${liveEventRevenueCents}`);
  }
  if (!Number.isInteger(bonusBps) || bonusBps < 1 || bonusBps > 10_000) {
    throw new Error(`fitness_live_bonus_invalid_rate:${bonusBps}`);
  }
  return {
    bonusBps,
    bonusCents: fitnessBpsShareCents(liveEventRevenueCents, bonusBps),
  };
}

/**
 * THE STUDIO FRANCHISE CLASS OVERRIDE — the physical franchise location's
 * certified content legs (workout choreographies and audio tracks) price at
 * the franchise license override bps (per leg, floored per leg), the studio
 * network fee floors off the class revenue, and BOTH come off BEFORE the
 * instructor disbursement (the ordering the application row pins:
 * override + fee + instructor net === class revenue).
 */
export function franchiseClassOverrideCents(input: {
  classRevenueCents: number;
  certifiedChoreographyRevenueCents: number;
  certifiedAudioRevenueCents: number;
  franchiseLicenseOverrideBps: number;
  networkFeeBps: number;
}): {
  choreographyOverrideCents: number;
  audioOverrideCents: number;
  franchiseOverrideTotalCents: number;
  networkFeeCents: number;
  instructorDisbursementCents: number;
} {
  const legs = [
    input.classRevenueCents,
    input.certifiedChoreographyRevenueCents,
    input.certifiedAudioRevenueCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`fitness_franchise_invalid_leg:${leg}`);
    }
  }
  if (!Number.isInteger(input.franchiseLicenseOverrideBps) || input.franchiseLicenseOverrideBps < 0) {
    throw new Error(`fitness_franchise_invalid_override:${input.franchiseLicenseOverrideBps}`);
  }
  if (!Number.isInteger(input.networkFeeBps) || input.networkFeeBps < 0) {
    throw new Error(`fitness_franchise_invalid_fee:${input.networkFeeBps}`);
  }
  const choreographyOverrideCents = fitnessBpsShareCents(
    input.certifiedChoreographyRevenueCents,
    input.franchiseLicenseOverrideBps,
  );
  const audioOverrideCents = fitnessBpsShareCents(
    input.certifiedAudioRevenueCents,
    input.franchiseLicenseOverrideBps,
  );
  const franchiseOverrideTotalCents = choreographyOverrideCents + audioOverrideCents;
  const networkFeeCents = fitnessBpsShareCents(input.classRevenueCents, input.networkFeeBps);
  const instructorDisbursementCents =
    input.classRevenueCents - franchiseOverrideTotalCents - networkFeeCents;
  return {
    choreographyOverrideCents,
    audioOverrideCents,
    franchiseOverrideTotalCents,
    networkFeeCents,
    instructorDisbursementCents,
  };
}

/**
 * THE CO-BRANDED FRANCHISE SPLIT — the net class stream earnings split
 * between the brick-and-mortar IP owner and the digital distributor per
 * the partnership of record (the founder's boutique gym × at-home bike
 * 50-50 shape). Largest-remainder allocation conserves the basis exactly —
 * an odd-cent basis hands its dust cent to the largest fractional
 * remainder, ties breaking to the IP owner (the first leg, the spatial
 * canon).
 */
export function cobrandSplitCents(input: {
  netClassStreamEarningsCents: number;
  ipOwnerShareBps: number;
  distributorShareBps: number;
}): { ipOwnerCents: number; distributorCents: number } {
  if (!Number.isInteger(input.netClassStreamEarningsCents) || input.netClassStreamEarningsCents < 0) {
    throw new Error(`fitness_cobrand_invalid_basis:${input.netClassStreamEarningsCents}`);
  }
  const legs = largestRemainderSplit(
    input.netClassStreamEarningsCents,
    [input.ipOwnerShareBps, input.distributorShareBps],
  );
  return { ipOwnerCents: legs[0] as number, distributorCents: legs[1] as number };
}

/**
 * THE WEARABLE BIOMETRIC / ALGORITHM MICRO-ROYALTY — the daily active
 * feature usage priced at the policy's per-active-user micro-fee (the
 * algorithm creator's or celebrity sports scientist's route of record).
 * Bigint-exact; the payable cents floor at the conversion (never round up).
 */
export function algorithmMicroRoyaltyMicros(input: {
  wearableActiveUsers: number;
  microsPerActiveUser: number;
}): { royaltyMicros: bigint; royaltyCents: number } {
  const { wearableActiveUsers, microsPerActiveUser } = input;
  if (!Number.isInteger(wearableActiveUsers) || wearableActiveUsers < 0) {
    throw new Error(`fitness_algo_invalid_users:${wearableActiveUsers}`);
  }
  if (!Number.isInteger(microsPerActiveUser) || microsPerActiveUser < 0) {
    throw new Error(`fitness_algo_invalid_rate:${microsPerActiveUser}`);
  }
  const royaltyMicros = BigInt(wearableActiveUsers) * BigInt(microsPerActiveUser);
  return { royaltyMicros, royaltyCents: fitnessMicrosToCents(royaltyMicros) };
}

/**
 * THE MULTI-TRAINER CO-CREATION WATERFALL — the course enrollment revenue
 * split across the program's registered module weightings (the founder's
 * 12-week marathon prep by 3 elite coaches shape). Largest-remainder
 * allocation conserves the enrollment exactly: each module floors its
 * proportional share, the dust cents hand to the largest fractional
 * remainders in weight order. The waterfall must be pre-validated (the
 * caller re-validates at read — weights summing to 10000).
 */
export function cocreationWaterfallCents(input: {
  enrollmentRevenueCents: number;
  modules: readonly FitnessCocreationModule[];
}): { legs: FitnessCocreationWalkLeg[]; allocatedTotalCents: number } {
  if (!Number.isInteger(input.enrollmentRevenueCents) || input.enrollmentRevenueCents < 0) {
    throw new Error(`fitness_cocreation_invalid_enrollment:${input.enrollmentRevenueCents}`);
  }
  const allocations = largestRemainderSplit(
    input.enrollmentRevenueCents,
    input.modules.map((module_) => module_.weight_bps),
  );
  const legs: FitnessCocreationWalkLeg[] = input.modules.map((module_, index) => ({
    module_id: module_.module_id,
    trainer_id: module_.trainer_id,
    weight_bps: module_.weight_bps,
    allocated_cents: allocations[index] as number,
  }));
  return {
    legs,
    allocatedTotalCents: allocations.reduce((sum, cents) => sum + cents, 0),
  };
}

/**
 * The largest-remainder money allocation — floor each leg's proportional
 * share of the basis, then hand the leftover cents to the legs in order of
 * largest fractional remainder (ties break by leg order). BigInt numerators
 * keep the proportions exact for any magnitude. The legs' weights need not
 * sum to 10000 — the shares are proportional.
 */
function largestRemainderSplit(basisCents: number, weights: readonly number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (totalWeight <= 0n) {
    throw new Error(`fitness_split_invalid_weights:${totalWeight}`);
  }
  const basisBig = BigInt(basisCents);
  const floors = weights.map((weight) => (basisBig * BigInt(weight)) / totalWeight);
  const leftoverCents =
    basisCents - floors.reduce((sum, floor) => sum + Number(floor), 0);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (basisBig * BigInt(weight)) % totalWeight,
  }));
  const bonusCents = new Array<number>(weights.length).fill(0);
  const remainderOrder = [...remainders].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });
  for (const slot of remainderOrder) {
    if (bonusCents.reduce((sum, bonus) => sum + bonus, 0) >= leftoverCents) break;
    bonusCents[slot.index] = 1;
  }
  return floors.map((floor, index) => Number(floor) + (bonusCents[index] ?? 0));
}
