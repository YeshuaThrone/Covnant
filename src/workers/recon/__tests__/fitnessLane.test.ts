/**
 * The fitness lane's worker-path test (PR 38, the founder fitness
 * directive) — the full pass over the five senders' sheets through the
 * real dispatch (profiles) and the real store walk (fitnessQueue) on the
 * in-memory backend: the exact founder math (realization identity, tier
 * boundaries at 100,000 monthly completions with cumulative tracking,
 * franchise overrides and the network fee before the instructor
 * disbursement, server load scaling, sync music before the trainer net,
 * the 50-50 co-brand split, daily-active usage micro-fees, and the
 * module-weighted co-creation waterfall), the replay no-ops, the
 * fail-closed skips, and the negative-net holds.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dispatchStatementProfile } from "../profiles";
import {
  fitnessMicrosToCents,
  fitnessRowEventId,
  serverLoadDeductionCents,
  trainerTierWalk,
} from "../fitness";
import { writeFitnessRowsToStore } from "../fitnessQueue";
import { validateFitnessCocreationWaterfall } from "@/modules/fitness/records";
import type { ParsedStatementLine } from "../records";
import { loadFixture } from "./fixtures";

/** Dispatches and parses one raw CSV through the pinned registry (the
 * worker's own two-step). */
function parseCsv(content: string): readonly ParsedStatementLine[] {
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error("content matched no profile");
  return profile.parse(content);
}

const TRAINER = "trainer-kai";
const PROGRAM = "prog-hiit-pro";
const FRANCHISE = "BOUTIQUE-BOS";
const MONTH = "2026-03";

/** The founder's example tiers — $0.05 per completion to 100,000 monthly
 * completions, $0.12 after (statement micros: $1 = 1e8), with the
 * $0.005 retention bonus. */
const TIER_BANDS = [
  { up_to: 100_000, micros_per_completion: 5_000_000 },
  { up_to: null, micros_per_completion: 12_000_000 },
];
/** The founder's example load bands — the founder's 50,000-viewer
 * weekend broadcast prices in the open top band. */
const LOAD_BANDS = [
  { up_to: 10_000, server_load_bps: 200 },
  { up_to: null, server_load_bps: 450 },
];

/** Registers every policy of record the lane's walks read. */
function registerPolicies(store: InMemoryStore): void {
  store.upsertFitnessTrainerTierSchedule({
    trainer_id: TRAINER,
    program_id: PROGRAM,
    bands: JSON.stringify(TIER_BANDS),
    retention_bonus_micros_per_completion: 500_000,
  });
  store.upsertFitnessSyncMusicPolicy({
    program_id: PROGRAM,
    master_royalty_micros_per_workout: 200_000,
    publishing_royalty_micros_per_workout: 150_000,
  });
  store.upsertFitnessLiveLoadPolicy({
    program_id: PROGRAM,
    bands: JSON.stringify(LOAD_BANDS),
  });
  store.upsertFitnessFranchisePolicy({
    studio_franchise_code: FRANCHISE,
    franchise_license_override_bps: 750,
    network_fee_bps: 350,
  });
  store.upsertFitnessCoBrandPartnership({
    studio_franchise_code: FRANCHISE,
    ip_owner_id: "ip-owner-boutique",
    distributor_id: "dist-at-home-bike",
    ip_owner_share_bps: 5_000,
    distributor_share_bps: 5_000,
  });
  store.upsertFitnessAlgorithmPolicy({
    program_id: PROGRAM,
    algorithm_creator_id: "algo-creator-lena",
    micros_per_active_user: 432_100,
  });
  // The 12-week marathon prep program's three-coach module weighting.
  for (const module_ of [
    { module_id: "m1", trainer_id: "coach-a", weight_bps: 3_333 },
    { module_id: "m2", trainer_id: "coach-b", weight_bps: 3_333 },
    { module_id: "m3", trainer_id: "coach-c", weight_bps: 3_334 },
  ]) {
    store.upsertFitnessCocreationModule({
      program_id: "prog-marathon-12wk",
      ...module_,
    });
  }
}

/** Parses the five senders' checked-in fixtures and walks the lane. */
async function walkFixtures(store: InMemoryStore) {
  const lines = [
    "fitness_stream_starts.csv",
    "fitness_workout_logs.csv",
    "fitness_equipment_telemetry.csv",
    "fitness_studio_checkins.csv",
    "fitness_subscription_allocations.csv",
  ].flatMap((name) => parseCsv(loadFixture(name)));
  return writeFitnessRowsToStore(store, lines);
}

/** The row event id for a fixture row (the replay guard's identity,
 * namespaced per ledger). */
function eventId(
  ledger: "royalty" | "live" | "franchise" | "cobrand" | "algo",
  sender: "stream_start" | "workout_complete" | "equipment_telemetry" | "studio_checkin",
  senderRowId: string,
): string {
  return fitnessRowEventId(ledger, {
    sender,
    trainerId: TRAINER,
    programId: PROGRAM,
    studioFranchiseCode: FRANCHISE,
    period: MONTH,
    senderRowId,
  });
}

describe("the fitness lane's full pass over the five senders", () => {
  it("commits every ledger with the exact founder math and advances the trackers", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    const counts = await walkFixtures(store);

    // 2 allocations + 3 stream starts + 1 workout + 1 telemetry + 1
    // check-in: 2 realizations, 4 royalty walks, 1 live residual,
    // 1 franchise walk, 1 co-brand split, 1 algorithm royalty, and
    // 1 co-creation waterfall (AL-1's program has no modules — the
    // no-waterfall skip counted). Nothing skipped, held, or replayed.
    expect(counts.realizationApplicationsWritten).toBe(2);
    expect(counts.royaltyApplicationsWritten).toBe(4);
    expect(counts.liveResidualsWritten).toBe(1);
    expect(counts.franchiseApplicationsWritten).toBe(1);
    expect(counts.cobrandSplitsWritten).toBe(1);
    expect(counts.algorithmRoyaltiesWritten).toBe(1);
    expect(counts.cocreationApplicationsWritten).toBe(1);
    expect(counts.realizationApplicationsReplayed).toBe(0);
    expect(counts.royaltyApplicationsReplayed).toBe(0);
    expect(counts.liveResidualsReplayed).toBe(0);
    expect(counts.franchiseApplicationsReplayed).toBe(0);
    expect(counts.cobrandSplitsReplayed).toBe(0);
    expect(counts.algorithmRoyaltiesReplayed).toBe(0);
    expect(counts.cocreationApplicationsReplayed).toBe(0);
    expect(counts.realizationHeldNegativeNet).toBe(0);
    expect(counts.royaltyHeldNegativeNet).toBe(0);
    expect(counts.franchiseHeldNegativeNet).toBe(0);
    expect(counts.royaltySkippedNoTierSchedule).toBe(0);
    expect(counts.royaltySkippedNoSyncPolicy).toBe(0);
    expect(counts.liveSkippedNoLoadPolicy).toBe(0);
    expect(counts.franchiseSkippedNoPolicy).toBe(0);
    expect(counts.cobrandSkippedNoPartnership).toBe(0);
    expect(counts.algorithmSkippedNoPolicy).toBe(0);

    // THE MONEY — exact to the cent:
    //   SS-1: 100,000 completions from position 0 — ALL at the $0.05
    //         band (100,000 is the band's inclusive top) → 5,000.00.
    //   SS-2: 25,000 from position 100,000 — the boundary crossed, the
    //         $0.12 band → 3,000.00.
    //   SS-3: 50,000 from 125,000 at $0.12 → 6,000.00.
    //   WL-1: 10,000 from 175,000 at $0.12 → 1,200.00.
    expect(counts.trainerTierPayoutCents).toBe(1_520_000);
    //   WL-1: 10,000 retained completions × $0.005 = 50.00.
    expect(counts.retentionBonusCents).toBe(5_000);
    //   WL-1: 10,000 workouts × $0.02 master + $0.015 publishing = 350.00,
    //         deducted from the class revenue BEFORE the trainer net.
    expect(counts.syncMusicDeductionCents).toBe(3_500);
    //   SS-3: the 50,000-viewer broadcast prices in the open top band
    //         (450 bps of 20,000.00) = 900.00.
    expect(counts.serverLoadDeductionCents).toBe(90_000);
    //   CI-1: choreography 2,000.00 + audio 1,000.00 at 750 bps
    //         = 225.00 in certified-content overrides.
    expect(counts.franchiseOverrideCents).toBe(22_500);
    //   CI-1: 350 bps of the 7,500.00 class revenue = 262.50, deducted
    //         before the instructor disbursement.
    expect(counts.networkFeeCents).toBe(26_250);
    expect(counts.instructorDisbursementCents).toBe(701_250);
    //   CI-1: the 50-50 co-brand split of the net class stream earnings —
    //   the boutique gym IP owner and the at-home bike distributor.
    expect(counts.cobrandIpOwnerCents).toBe(350_625);
    expect(counts.cobrandDistributorCents).toBe(350_625);
    //   ET-1: 2,500 daily active users × $0.04321 = 108.025 → 108.00
    //         (floored into payable cents).
    expect(counts.algorithmRoyaltyCents).toBe(1_080);
    //   AL-2: the 3-coach waterfall over the 4,000,000.01¢ pool at
    //   3333/3333/3334 bps — largest-remainder exact.
    expect(counts.cocreationAllocatedCents).toBe(40_000_001);
    //   THE REALIZATION IDENTITY — gross − engine cut − infrastructure:
    //   AL-1: 1,234,567.89 − 123,456.79 − 54,321.09 = 1,056,790.01.
    //   AL-2: 500,000.01 − 75,000.00 − 25,000.00 = 400,000.01.
    expect(counts.netFitnessContentPoolCents).toBe(145_679_002);

    // The trackers advanced cumulatively across the month's rows.
    const completions = await store.getFitnessCompletionMonth(TRAINER, PROGRAM, MONTH);
    expect(completions?.cumulative_completions).toBe(185_000); // 175k + 10k
    const classes = await store.getFitnessFranchiseClassMonth(FRANCHISE, MONTH);
    expect(classes?.cumulative_classes).toBe(120);

    // THE REALIZATION of record — the founder's identity keyed on the
    // trainer_id, program_id, and studio_franchise_code columns.
    const realization = await store.getFitnessRealizationApplication(
      fitnessRowEventId("realization", {
        sender: "subscription_allocation",
        trainerId: TRAINER,
        programId: PROGRAM,
        studioFranchiseCode: FRANCHISE,
        period: MONTH,
        senderRowId: "AL-2026-0001",
      }),
    );
    expect(realization?.gross_subscription_pool_cents).toBe(123_456_789);
    expect(realization?.app_store_engine_cut_cents).toBe(12_345_679);
    expect(realization?.digital_infrastructure_overhead_cents).toBe(5_432_109);
    expect(realization?.net_fitness_content_pool_cents).toBe(105_679_001);
    expect(realization?.verdict).toBe("paid");

    // THE TIER WALK of record — SS-1's committed legs (the boundary:
    // exactly 100,000 completions, all in the $0.05 band).
    const ss1 = await store.getFitnessTrainerRoyaltyApplication(
      eventId("royalty", "stream_start", "SS-2026-0001"),
    );
    expect(ss1?.monthly_completions_before).toBe(0);
    expect(ss1?.monthly_completions_after).toBe(100_000);
    expect(ss1?.tier_payout_cents).toBe(500_000);
    expect(JSON.parse(ss1?.tier_legs ?? "[]")).toEqual([
      {
        band_from: 0,
        band_to: 100_000,
        micros_per_completion: 5_000_000,
        band_completions: 100_000,
        band_payout_micros: 500_000_000_000,
      },
    ]);

    // THE SYNC ORDERING of record — the workout row pins master +
    // publishing + trainer net basis === class revenue (the deductions
    // came FIRST), and the retention bonus rode the same walk.
    const wl1 = await store.getFitnessTrainerRoyaltyApplication(
      eventId("royalty", "workout_complete", "WL-2026-0001"),
    );
    expect(wl1?.sync_master_cents).toBe(2_000);
    expect(wl1?.sync_publishing_cents).toBe(1_500);
    expect(wl1?.class_revenue_cents).toBe(50_000);
    expect(wl1?.trainer_net_basis_cents).toBe(46_500);
    expect(
      wl1 !== undefined &&
        wl1.sync_master_cents + wl1.sync_publishing_cents + wl1.trainer_net_basis_cents ===
          wl1.class_revenue_cents,
    ).toBe(true);
    expect(wl1?.tier_payout_cents).toBe(120_000);
    expect(wl1?.retention_bonus_cents).toBe(5_000);
    expect(wl1?.monthly_completions_before).toBe(175_000);
    expect(wl1?.monthly_completions_after).toBe(185_000);

    // THE LIVE RESIDUAL of record — the founder's 50,000 simultaneous
    // viewers priced in the open top band.
    const ss3 = await store.getFitnessLiveResidualApplication(
      eventId("live", "stream_start", "SS-2026-0003"),
    );
    expect(ss3?.peak_simultaneous_viewers).toBe(50_000);
    expect(ss3?.load_band_from).toBe(10_000);
    expect(ss3?.load_band_to).toBeNull();
    expect(ss3?.server_load_bps).toBe(450);
    expect(ss3?.server_load_deduction_cents).toBe(90_000);
    expect(ss3?.net_live_residual_cents).toBe(1_910_000);

    // THE FRANCHISE WALK of record — the class count tracked, the
    // certified-content overrides, the network fee, the disbursement.
    const ci1 = await store.getFitnessFranchiseApplication(
      eventId("franchise", "studio_checkin", "CI-2026-0001"),
    );
    expect(ci1?.class_count).toBe(120);
    expect(ci1?.classes_before).toBe(0);
    expect(ci1?.classes_after).toBe(120);
    expect(ci1?.choreography_override_cents).toBe(15_000);
    expect(ci1?.audio_override_cents).toBe(7_500);
    expect(ci1?.franchise_override_total_cents).toBe(22_500);
    expect(ci1?.network_fee_cents).toBe(26_250);
    expect(ci1?.instructor_disbursement_cents).toBe(701_250);

    // THE CO-BRAND SPLIT of record — 50-50, conserved exactly.
    const split = await store.getFitnessCobrandSplitApplication(
      eventId("cobrand", "studio_checkin", "CI-2026-0001"),
    );
    expect(split?.ip_owner_id).toBe("ip-owner-boutique");
    expect(split?.distributor_id).toBe("dist-at-home-bike");
    expect(split?.net_class_stream_earnings_cents).toBe(701_250);
    expect(split?.ip_owner_cents).toBe(350_625);
    expect(split?.distributor_cents).toBe(350_625);

    // THE ALGORITHM MICRO-ROYALTY of record — the daily active usage
    // priced at the policy's micro-fee, routed to the creator.
    const royalty = await store.getFitnessAlgorithmRoyalty(
      eventId("algo", "equipment_telemetry", "ET-2026-0001"),
    );
    expect(royalty?.wearable_active_users).toBe(2_500);
    expect(royalty?.algorithm_creator_id).toBe("algo-creator-lena");
    expect(royalty?.royalty_micros).toBe(1_080_250_000);
    expect(royalty?.royalty_cents).toBe(1_080);

    // THE CO-CREATION WATERFALL of record — module-weighted, conserved.
    const waterfall = await store.getFitnessCocreationApplication(
      fitnessRowEventId("cocreation", {
        sender: "subscription_allocation",
        trainerId: "coach-a",
        programId: "prog-marathon-12wk",
        studioFranchiseCode: FRANCHISE,
        period: MONTH,
        senderRowId: "AL-2026-0002",
      }),
    );
    expect(waterfall?.enrollment_revenue_cents).toBe(40_000_001);
    expect(JSON.parse(waterfall?.waterfall_legs ?? "[]")).toEqual([
      { module_id: "m1", trainer_id: "coach-a", weight_bps: 3_333, allocated_cents: 13_332_000 },
      { module_id: "m2", trainer_id: "coach-b", weight_bps: 3_333, allocated_cents: 13_332_000 },
      { module_id: "m3", trainer_id: "coach-c", weight_bps: 3_334, allocated_cents: 13_336_001 },
    ]);
    expect(waterfall?.allocated_total_cents).toBe(40_000_001);
  });
});

describe("the lane's replay guards", () => {
  it("replays every ledger as a counted no-op and advances no tracker", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    const first = await walkFixtures(store);
    expect(first.realizationApplicationsWritten).toBe(2);

    const replay = await walkFixtures(store);

    // Every ledger counted its pass as replays — no second application.
    expect(replay.realizationApplicationsWritten).toBe(0);
    expect(replay.royaltyApplicationsWritten).toBe(0);
    expect(replay.liveResidualsWritten).toBe(0);
    expect(replay.franchiseApplicationsWritten).toBe(0);
    expect(replay.cobrandSplitsWritten).toBe(0);
    expect(replay.algorithmRoyaltiesWritten).toBe(0);
    expect(replay.cocreationApplicationsWritten).toBe(0);
    expect(replay.realizationApplicationsReplayed).toBe(2);
    expect(replay.royaltyApplicationsReplayed).toBe(4);
    expect(replay.liveResidualsReplayed).toBe(1);
    expect(replay.franchiseApplicationsReplayed).toBe(1);
    expect(replay.cobrandSplitsReplayed).toBe(1);
    expect(replay.algorithmRoyaltiesReplayed).toBe(1);
    expect(replay.cocreationApplicationsReplayed).toBe(1);
    // No money moved on the replay.
    expect(replay.trainerTierPayoutCents).toBe(0);
    expect(replay.retentionBonusCents).toBe(0);
    expect(replay.syncMusicDeductionCents).toBe(0);
    expect(replay.serverLoadDeductionCents).toBe(0);
    expect(replay.franchiseOverrideCents).toBe(0);
    expect(replay.networkFeeCents).toBe(0);
    expect(replay.instructorDisbursementCents).toBe(0);
    expect(replay.cobrandIpOwnerCents).toBe(0);
    expect(replay.cobrandDistributorCents).toBe(0);
    expect(replay.algorithmRoyaltyCents).toBe(0);
    expect(replay.cocreationAllocatedCents).toBe(0);
    expect(replay.netFitnessContentPoolCents).toBe(0);

    // The trackers did not move on the replays.
    const completions = await store.getFitnessCompletionMonth(TRAINER, PROGRAM, MONTH);
    expect(completions?.cumulative_completions).toBe(185_000);
    const classes = await store.getFitnessFranchiseClassMonth(FRANCHISE, MONTH);
    expect(classes?.cumulative_classes).toBe(120);
  });
});

describe("the lane's fail-closed skips", () => {
  const STREAM_HEADER =
    "Stream Start ID,Trainer ID,Program ID,Studio Franchise Code,Stream Starts,Live Broadcast,Peak Simultaneous Viewers,Live Event Revenue,Currency,Reporting Period";
  const WORKOUT_HEADER =
    "Workout Log ID,Trainer ID,Program ID,Studio Franchise Code,Completed Workouts,Subscriber Retained,Class Revenue,Currency,Reporting Period";
  const TELEMETRY_HEADER =
    "Telemetry ID,Trainer ID,Program ID,Studio Franchise Code,Equipment Type,Session Count,Workout Minutes,Wearable Active Users,Currency,Reporting Period";
  const CHECKIN_HEADER =
    "Check-In ID,Trainer ID,Program ID,Studio Franchise Code,Class Check-Ins,Class Revenue,Certified Choreography Revenue,Certified Audio Revenue,Currency,Reporting Period";

  it("skips a completion row whose trainer-program has no tier schedule of record", async () => {
    const store = new InMemoryStore();
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          STREAM_HEADER,
          `SS-1,trainer-no,prog-no,${FRANCHISE},1000,no,0,0.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.royaltySkippedNoTierSchedule).toBe(1);
    expect(counts.royaltyApplicationsWritten).toBe(0);
  });

  it("skips a class-revenue workout row whose program has no sync music policy of record", async () => {
    const store = new InMemoryStore();
    // The schedule exists; the sync music policy does not — the walk
    // never guesses a music rate (a zero-rate policy is the operator's
    // explicit "no music cost" statement).
    store.upsertFitnessTrainerTierSchedule({
      trainer_id: TRAINER,
      program_id: PROGRAM,
      bands: JSON.stringify(TIER_BANDS),
      retention_bonus_micros_per_completion: 0,
    });
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          WORKOUT_HEADER,
          `WL-1,${TRAINER},${PROGRAM},${FRANCHISE},1000,no,500.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.royaltySkippedNoSyncPolicy).toBe(1);
    expect(counts.royaltyApplicationsWritten).toBe(0);
  });

  it("commits a live broadcast's royalty walk but skips its residual when the program has no load policy of record", async () => {
    const store = new InMemoryStore();
    store.upsertFitnessTrainerTierSchedule({
      trainer_id: TRAINER,
      program_id: PROGRAM,
      bands: JSON.stringify(TIER_BANDS),
      retention_bonus_micros_per_completion: 0,
    });
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          STREAM_HEADER,
          `SS-1,${TRAINER},${PROGRAM},${FRANCHISE},1000,yes,50000,200000.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.royaltyApplicationsWritten).toBe(1);
    expect(counts.liveSkippedNoLoadPolicy).toBe(1);
    expect(counts.liveResidualsWritten).toBe(0);
  });

  it("skips a check-in row whose franchise code has no policy of record", async () => {
    const store = new InMemoryStore();
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          CHECKIN_HEADER,
          `CI-1,${TRAINER},${PROGRAM},UNREGISTERED-GYM,120,7500.00,2000.00,1000.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.franchiseSkippedNoPolicy).toBe(1);
    expect(counts.franchiseApplicationsWritten).toBe(0);
    expect(counts.cobrandSplitsWritten).toBe(0);
  });

  it("commits the franchise walk but skips the co-brand split when the code has no partnership of record", async () => {
    const store = new InMemoryStore();
    store.upsertFitnessFranchisePolicy({
      studio_franchise_code: FRANCHISE,
      franchise_license_override_bps: 750,
      network_fee_bps: 350,
    });
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          CHECKIN_HEADER,
          `CI-1,${TRAINER},${PROGRAM},${FRANCHISE},120,7500.00,2000.00,1000.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.franchiseApplicationsWritten).toBe(1);
    expect(counts.cobrandSkippedNoPartnership).toBe(1);
    expect(counts.cobrandSplitsWritten).toBe(0);
  });

  it("skips a telemetry row whose program has no algorithm policy of record", async () => {
    const store = new InMemoryStore();
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          TELEMETRY_HEADER,
          `ET-1,${TRAINER},${PROGRAM},${FRANCHISE},treadmill,10,300,900,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.algorithmSkippedNoPolicy).toBe(1);
    expect(counts.algorithmRoyaltiesWritten).toBe(0);
  });
});

describe("the lane's negative-net holds", () => {
  const STREAM_HEADER =
    "Stream Start ID,Trainer ID,Program ID,Studio Franchise Code,Stream Starts,Live Broadcast,Peak Simultaneous Viewers,Live Event Revenue,Currency,Reporting Period";
  const WORKOUT_HEADER =
    "Workout Log ID,Trainer ID,Program ID,Studio Franchise Code,Completed Workouts,Subscriber Retained,Class Revenue,Currency,Reporting Period";
  const CHECKIN_HEADER =
    "Check-In ID,Trainer ID,Program ID,Studio Franchise Code,Class Check-Ins,Class Revenue,Certified Choreography Revenue,Certified Audio Revenue,Currency,Reporting Period";
  const ALLOCATION_HEADER =
    "Allocation ID,Trainer ID,Program ID,Studio Franchise Code,Gross Subscription Pool,App Store Engine Cut,Digital Infrastructure Overhead,Currency,Reporting Period";

  it("holds a realization whose engine cut and overhead exceed the gross pool", async () => {
    const store = new InMemoryStore();
    // 100.00 gross − 80.00 cut − 50.00 overhead = −30.00: the hold IS
    // the record.
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          ALLOCATION_HEADER,
          `AL-HOLD,trainer-hold,prog-hold,HOLD-GYM,100.00,80.00,50.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.realizationHeldNegativeNet).toBe(1);
    expect(counts.realizationApplicationsWritten).toBe(1);
    expect(counts.netFitnessContentPoolCents).toBe(-3_000);
    expect(counts.cocreationApplicationsWritten).toBe(0);

    const held = await store.getFitnessRealizationApplication(
      fitnessRowEventId("realization", {
        sender: "subscription_allocation",
        trainerId: "trainer-hold",
        programId: "prog-hold",
        studioFranchiseCode: "HOLD-GYM",
        period: MONTH,
        senderRowId: "AL-HOLD",
      }),
    );
    expect(held?.verdict).toBe("held_negative_net");
    expect(held?.net_fitness_content_pool_cents).toBe(-3_000);
  });

  it("holds a workout row whose sync music deductions exceed the class revenue, advances no completion tracker, and never prices the tier walk", async () => {
    const store = new InMemoryStore();
    store.upsertFitnessSyncMusicPolicy({
      program_id: "prog-royalty-hold",
      master_royalty_micros_per_workout: 200_000,
      publishing_royalty_micros_per_workout: 150_000,
    });
    // 0.01 class revenue − (1,000 × 200,000µ master = 200¢) − (1,000 ×
    // 150,000µ publishing = 150¢) = 1 − 350 = −349.
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          WORKOUT_HEADER,
          `WL-HOLD,trainer-hold,prog-royalty-hold,HOLD-GYM,1000,no,0.01,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.royaltyHeldNegativeNet).toBe(1);
    expect(counts.royaltyApplicationsWritten).toBe(1);
    expect(counts.syncMusicDeductionCents).toBe(350);

    const held = await store.getFitnessTrainerRoyaltyApplication(
      fitnessRowEventId("royalty", {
        sender: "workout_complete",
        trainerId: "trainer-hold",
        programId: "prog-royalty-hold",
        studioFranchiseCode: "HOLD-GYM",
        period: MONTH,
        senderRowId: "WL-HOLD",
      }),
    );
    expect(held?.verdict).toBe("held_negative_net");
    expect(held?.trainer_net_basis_cents).toBe(-349);
    expect(held?.tier_schedule_ref).toBeNull();
    expect(held?.tier_legs).toBe("[]");
    expect(held?.tier_payout_cents).toBe(0);
    expect(held?.retention_bonus_cents).toBe(0);
    expect(held?.monthly_completions_before).toBeNull();
    expect(held?.monthly_completions_after).toBeNull();

    // The hold advanced no position — the next walk re-prices after the
    // operator heals the sheet.
    const tracker = await store.getFitnessCompletionMonth("trainer-hold", "prog-royalty-hold", MONTH);
    expect(tracker).toBeUndefined();
  });

  it("holds a check-in row whose certified-content override exceeds the class revenue, advances no class tracker, and skips the co-brand split", async () => {
    const store = new InMemoryStore();
    store.upsertFitnessFranchisePolicy({
      studio_franchise_code: "HOLD-GYM",
      franchise_license_override_bps: 750,
      network_fee_bps: 350,
    });
    // 1.00 class revenue − (500.00 choreography at 750 bps = 37.50)
    // − 0.03 fee = −36.53.
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          CHECKIN_HEADER,
          `CI-HOLD,trainer-hold,prog-hold,HOLD-GYM,5,1.00,500.00,0.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.franchiseHeldNegativeNet).toBe(1);
    expect(counts.franchiseApplicationsWritten).toBe(1);
    expect(counts.cobrandSplitsWritten).toBe(0);

    const held = await store.getFitnessFranchiseApplication(
      fitnessRowEventId("franchise", {
        sender: "studio_checkin",
        trainerId: "trainer-hold",
        programId: "prog-hold",
        studioFranchiseCode: "HOLD-GYM",
        period: MONTH,
        senderRowId: "CI-HOLD",
      }),
    );
    expect(held?.verdict).toBe("held_negative_net");
    expect(held?.instructor_disbursement_cents).toBe(-3_653);
    expect(held?.classes_before).toBeNull();
    expect(held?.classes_after).toBeNull();

    const tracker = await store.getFitnessFranchiseClassMonth("HOLD-GYM", MONTH);
    expect(tracker).toBeUndefined();
  });

  it("prices a live residual that is always a positive share of the broadcast revenue", async () => {
    const store = new InMemoryStore();
    store.upsertFitnessLiveLoadPolicy({
      program_id: "prog-live",
      bands: JSON.stringify([{ up_to: null, server_load_bps: 9_000 }]),
    });
    // Even the 90% top band leaves a positive residual — the deduction
    // is a share of positive revenue, never a hold.
    const counts = await writeFitnessRowsToStore(
      store,
      parseCsv(
        [
          STREAM_HEADER,
          `SS-1,trainer-live,prog-live,HOLD-GYM,1,no,0,0.00,USD,${MONTH}`,
          `SS-2,trainer-live,prog-live,HOLD-GYM,1,yes,100,1.00,USD,${MONTH}`,
        ].join("\n"),
      ),
    );
    expect(counts.liveResidualsWritten).toBe(1);
    expect(counts.serverLoadDeductionCents).toBe(90);
    const residual = await store.getFitnessLiveResidualApplication(
      fitnessRowEventId("live", {
        sender: "stream_start",
        trainerId: "trainer-live",
        programId: "prog-live",
        studioFranchiseCode: "HOLD-GYM",
        period: MONTH,
        senderRowId: "SS-2",
      }),
    );
    expect(residual?.net_live_residual_cents).toBe(10);
  });
});

describe("the pure calculator contracts", () => {
  it("walks a tier boundary INSIDE one row's completions — 125,000 from zero spans both bands", () => {
    const walk = trainerTierWalk({
      completions: 125_000,
      cumulativeBefore: 0,
      bands: TIER_BANDS,
    });
    // 100,000 × $0.05 + 25,000 × $0.12 = 5,000.00 + 3,000.00 = 8,000.00.
    expect(walk.payoutMicros).toBe(800_000_000_000n);
    expect(fitnessMicrosToCents(walk.payoutMicros)).toBe(800_000);
    expect(walk.legs).toEqual([
      {
        band_from: 0,
        band_to: 100_000,
        micros_per_completion: 5_000_000,
        band_completions: 100_000,
        band_payout_micros: 500_000_000_000,
      },
      {
        band_from: 100_000,
        band_to: null,
        micros_per_completion: 12_000_000,
        band_completions: 25_000,
        band_payout_micros: 300_000_000_000,
      },
    ]);
    expect(walk.cumulativeAfter).toBe(125_000);
  });

  it("scales the server load deduction across the band boundary — 10,000 viewers price band 1, 10,001 price band 2", () => {
    const bands = [
      { up_to: 10_000, server_load_bps: 200 },
      { up_to: null, server_load_bps: 450 },
    ];
    // The revenue: 1,000,000 cents — the founder's 50,000-viewer weekend
    // broadcast shape at a smaller audience.
    const band1 = serverLoadDeductionCents({
      peakSimultaneousViewers: 10_000,
      liveEventRevenueCents: 1_000_000,
      bands,
    });
    expect(band1.serverLoadBps).toBe(200);
    expect(band1.serverLoadDeductionCents).toBe(20_000);
    expect(band1.netLiveResidualCents).toBe(980_000);

    const band2 = serverLoadDeductionCents({
      peakSimultaneousViewers: 10_001,
      liveEventRevenueCents: 1_000_000,
      bands,
    });
    expect(band2.serverLoadBps).toBe(450);
    expect(band2.serverLoadDeductionCents).toBe(45_000);
    expect(band2.netLiveResidualCents).toBe(955_000);

    // The founder's headline shape: 50,000 simultaneous users.
    const weekend = serverLoadDeductionCents({
      peakSimultaneousViewers: 50_000,
      liveEventRevenueCents: 2_000_000,
      bands,
    });
    expect(weekend.serverLoadDeductionCents).toBe(90_000);
  });

  it("rejects a co-creation waterfall whose module weights do not sum to exactly 10000 bps", () => {
    expect(
      validateFitnessCocreationWaterfall([
        { module_id: "m1", trainer_id: "coach-a", weight_bps: 3_333 },
        { module_id: "m2", trainer_id: "coach-b", weight_bps: 3_333 },
        { module_id: "m3", trainer_id: "coach-c", weight_bps: 3_333 },
      ]),
    ).toEqual({ ok: false, reason: "weights_do_not_sum_to_10000" });
  });

  it("floors statement micros into payable cents exactly — no float dust ($1 = 1e8 micros)", () => {
    expect(fitnessMicrosToCents(1_080_250_000n)).toBe(1_080); // 1080.25 floors
    expect(fitnessMicrosToCents(999_999n)).toBe(0); // sub-cent dust floors to 0
    expect(fitnessMicrosToCents(1_000_000n)).toBe(1);
  });
});
