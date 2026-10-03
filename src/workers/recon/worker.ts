/**
 * CVT recon worker — the claim/parse/write loop (spec art_7M0snhxc, PR 2).
 *
 * The three-layer contract: the UCT layer's enqueue route inserts the
 * royalty_recon_jobs row; this lane claims it (claimReconJob — exclusive
 * claim plus 30-minute stale-claim recovery and the attempts cap live in
 * the store seam), parses the referenced statement ingest through the
 * deterministic profiles, appends guild residual holds, and lands every
 * line in the existing match_queue. Completion reports the honest counts;
 * every failure reports the row-scoped reason — never silent, never
 * guessed.
 *
 * No Next.js imports: this file runs under tsx as a standalone process
 * (npm run worker:recon) and under Vitest against the in-memory store.
 */

import type {
  ReconJobResult,
  RoyaltyReconJobRecord,
} from "@/modules/recon/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import { calculateGuildResiduals } from "./guildResiduals";
import { writeLinesToMatchQueue, type VaultLookup } from "./matchQueue";
import { postMatchedLinesToHolding } from "./posting";
import { qualifyImpressionLines } from "./podcast";
import { postPodcastLinesToHolding } from "./podcastPosting";
import { writePodcastLinesToMatchQueue } from "./podcastQueue";
import { runPodcastSplitBonusPass } from "@/modules/podcastSplits/accrual";
import { isPodcastProfileKind } from "./podcastProfiles";
import { runGamingSplitAccrualPass } from "./gamingAccrual";
import { postGamingLinesToHolding } from "./gamingPosting";
import { writeGamingLinesToMatchQueue } from "./gamingQueue";
import { isGamingProfileKind } from "./gamingProfiles";
import { postLivestreamLines } from "./livestreamPosting";
import { writeLivestreamLinesToMatchQueue } from "./livestreamQueue";
import { isLivestreamProfileKind } from "./livestreamProfiles";
import { writeWebtoonLinesToMatchQueue } from "./webtoonQueue";
import { postWebtoonLines } from "./webtoonPosting";
import { isWebtoonProfileKind } from "./webtoonProfiles";
import { writeMerchLinesToMatchQueue } from "./merchQueue";
import { postMerchNetsToHolding } from "./merchPosting";
import { isMerchProfileKind } from "./merchProfiles";
import { writeAiLinesToMatchQueue } from "./aiQueue";
import { postAiLinesToHolding } from "./aiPosting";
import { isAiProfileKind } from "./aiProfiles";
import { writeBookLinesToMatchQueue } from "./booksQueue";
import { postBookNetsToHolding } from "./booksPosting";
import { isBookProfileKind } from "./booksProfiles";
import { writeArtLinesToMatchQueue } from "./artQueue";
import { postArtNetsToHolding } from "./artPosting";
import { isArtProfileKind } from "./artProfiles";
import { isTheatricalProfileKind } from "./theatricalProfiles";
import { writeTheatricalLinesToMatchQueue } from "./theatricalQueue";
import { postTheatricalNetsToHolding } from "./theatricalPosting";
import { isLicensingProfileKind } from "./licensingProfiles";
import { writeLicensingLinesToMatchQueue } from "./licensingQueue";
import { postLicensingNetsToHolding } from "./licensingPosting";
import { runLicensingRoyaltyCascadePass } from "@/lib/server/licensingRoyaltyCascade";
import { runTheatricalWaterfallPass } from "@/lib/server/theatricalBoxOfficeCascade";
import { runArtWaterfallPass } from "@/lib/server/artMarketCascade";
import { runBookEditorialSplitPass } from "@/lib/server/bookEditorialCascade";
import { StatementParseError } from "./records";
import { dispatchStatementProfile } from "./profiles";
import type { StatementProfile } from "./records";
import {
  looksLikePdfOrImage,
  readVisionEngineConfig,
  runVisionEngine,
} from "./visionEngine";

/** The engine name recorded on every claim — deterministic lane, no model. */
export const RECON_WORKER_ENGINE = "cvt-recon-worker";

/** Default poll interval when the queue is empty (ms). */
export const DEFAULT_RECON_POLL_MS = 5000;

export interface ReconWorkerDeps {
  store: Store;
  /** Vault cross-reference handle; null = queue rows stay honestly unmatched. */
  vault: VaultLookup | null;
  /** Injectable clock and sleep for tests and the Actions cron entry. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Vision-engine env override; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The outcome of one worker pass over one job. */
export interface ProcessedJob {
  job: RoyaltyReconJobRecord;
  outcome: "completed" | "failed";
}

/** The completion result the worker writes — the spec's shape, plus the
 * activated canonical-posting seam's honest counts. The podcast lane adds
 * its own block (absent on music/film lanes — the presence is the
 * discriminator). */
/**
 * The completion result the worker writes — the record layer's
 * `ReconJobResult` with the summary fields the worker always populates.
 * Podcast lane counts ride the record's flat `podcast_*` fields (PR 10);
 * non-podcast lanes leave them absent.
 */
export interface ReconWorkerResult extends ReconJobResult {
  events_written: number;
  matched: number;
  unmatched: number;
  engine_used: string | null;
  /** Matched MUSIC lines credited to UNCLAIMED_HOLDING this pass. */
  holding_posted: number;
  /** Matched lines whose post hit the per-source replay guard — no-ops. */
  holding_replayed: number;
}

/**
 * Claims and processes AT MOST ONE job. Returns undefined when the queue
 * was empty (caller sleeps and polls again).
 */
export async function runOnce(deps: ReconWorkerDeps): Promise<ProcessedJob | undefined> {
  const now = deps.now ?? (() => new Date());
  const job = await deps.store.claimReconJob(now(), RECON_WORKER_ENGINE);
  if (job === undefined) return undefined;
  const outcome = await processClaimedJob(deps, job);
  const fresh = await deps.store.getReconJob(job.id);
  if (fresh === undefined) {
    // A store that accepted our claim then lost the row cannot happen
    // in any of the three backends without a wipe mid-flight — surface it.
    throw new Error(`recon job ${job.id} vanished after ${outcome}`);
  }
  return { job: fresh, outcome };
}

/** Parses and writes one claimed job — every failure path lands in failReconJob. */
async function processClaimedJob(
  deps: ReconWorkerDeps,
  job: RoyaltyReconJobRecord,
): Promise<"completed" | "failed"> {
  try {
    const result = await processJobBody(deps, job);
    await deps.store.completeReconJob(job.id, result);
    return "completed";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown worker error";
    await deps.store.failReconJob(job.id, reason);
    return "failed";
  }
}

async function processJobBody(
  deps: ReconWorkerDeps,
  job: RoyaltyReconJobRecord,
): Promise<ReconWorkerResult> {
  if (job.ingest_id === null) {
    throw new StatementParseError("no_statement_ingest: job references no ingest to parse");
  }
  const ingest = await deps.store.getStatementIngest(job.ingest_id);
  if (ingest === undefined) {
    throw new StatementParseError(`statement_ingest_not_found:${job.ingest_id}`);
  }
  const content = ingest.content;

  const matchedProfile = dispatchStatementProfile(content);
  if (matchedProfile !== null) {
    // The podcast lane branches BEFORE the music path: its lines carry no
    // music rights and its revenue passes the IAB qualification gates
    // before any of it counts — a different pipeline, not a profile flavor.
    if (isPodcastProfileKind(matchedProfile.kind)) {
      return await parsePodcast(deps, job.ingest_id, matchedProfile, content);
    }
    // The gaming lane branches the same way: its lines are rights_type
    // 'unknown' game/asset sales whose money passes the engine-royalty
    // accumulator, the two-deduction net posting, and the per-item split
    // accrual — never the music queue's split math.
    if (isGamingProfileKind(matchedProfile.kind)) {
      return await parseGaming(deps, job.ingest_id, matchedProfile, content);
    }
    // The livestream lane branches the same way (PR 14): its lines carry
    // stream-platform attribution whose money passes the durable conversion
    // log (Bits/Diamonds), the batch prize-pool escrow lock (esports
    // receipts), and the Kick-fee net posting — never the music queue's
    // split math and never the gaming accumulator.
    if (isLivestreamProfileKind(matchedProfile.kind)) {
      return await parseLivestream(deps, job.ingest_id, matchedProfile, content);
    }
    // The webtoon lane branches the same way (PR 19): its rows are
    // rights_type 'unknown' serialized-chapter events whose money passes
    // the coin conversion (recorded rate, layered shares), the KENP pool
    // math, and the monthly-pass double-dip dedup — never the music
    // queue's split math, the gaming accumulator, or the livestream
    // escrow.
    if (isWebtoonProfileKind(matchedProfile.kind)) {
      return await parseWebtoon(deps, job.ingest_id, matchedProfile, content);
    }
    // The merch lane branches the same way (PR 22): its rows are
    // rights_type 'unknown' physical-product fulfillment events whose
    // money passes the COGS deduction (DTC equation, POD
    // printing-before-split), the consignment reconciliation, and the POS
    // net — never the music queue's split math, the gaming accumulator,
    // the livestream escrow, or the webtoon conversions.
    if (isMerchProfileKind(matchedProfile.kind)) {
      return await parseMerch(deps, job.ingest_id, matchedProfile, content);
    }
    // The AI lane branches the same way (PR 24): its rows are the four
    // strict AI senders' metered inference / voice licensing / dataset
    // attribution events whose money runs the founder's nested derivative
    // split — never the music queue's split math, the gaming accumulator,
    // the livestream escrow, the webtoon conversions, or the merch COGS
    // deduction.
    if (isAiProfileKind(matchedProfile.kind)) {
      return await parseAi(deps, matchedProfile, content);
    }
    // The book lane branches the same way (PR 26): its rows are the
    // publishing senders' ISBN-identified royalty events whose money runs
    // the POD print deduction (keyed on isbn + format_type), the e-book
    // agency tiers, and the magazine cuts — then the durable sequential
    // advance recoupment and editorial split cascade. Never the music
    // queue's split math, the gaming accumulator, the livestream escrow,
    // the webtoon conversions, the merch COGS deduction, or the AI split.
    if (isBookProfileKind(matchedProfile.kind)) {
      return await parseBooks(deps, job.ingest_id, matchedProfile, content);
    }
    // The art-market lane branches the same way (PR 28): its rows are the
    // five strict art senders' gallery/resale/edition/licensing/audit
    // events whose money runs the founder's gallery equation, the ARR
    // sliding scale, and the fabrication waterfalls — never the music
    // queue's split math, the gaming accumulator, the livestream escrow,
    // the webtoon conversions, the merch COGS deduction, the AI split, or
    // the book editorial cascade.
    if (isArtProfileKind(matchedProfile.kind)) {
      return await parseArt(deps, job.ingest_id, matchedProfile, content);
    }
    // The theatrical lane branches the same way (PR 30): its rows are the
    // four strict ticketing senders' per-stop settlement events whose money
    // runs the AGBOR calculator, the capped venue-expense recoupment, and
    // the box office deal waterfalls — never the music queue's split math,
    // the gaming accumulator, the livestream escrow, the webtoon
    // conversions, the merch COGS deduction, the AI split, the book
    // editorial cascade, or the art fabrication waterfalls.
    if (isTheatricalProfileKind(matchedProfile.kind)) {
      return await parseTheatrical(deps, job.ingest_id, matchedProfile, content);
    }
    // The brand-licensing lane branches the same way (PR 32): its rows are
    // the four strict senders' sales/sell-through/POS/manifest events whose
    // money runs the Net Sales realization, the cumulative tier walk, the
    // agency commission, the dual-IP split, the treaty withholding, and the
    // sub-license override — never the music queue's split math, the gaming
    // accumulator, the livestream escrow, the webtoon conversions, the
    // merch COGS deduction, the AI split, the book editorial cascade, the
    // art fabrication waterfalls, or the theatrical deal classes.
    if (isLicensingProfileKind(matchedProfile.kind)) {
      return await parseLicensing(deps, job.ingest_id, matchedProfile, content);
    }
    return await parseDeterministic(deps, job.ingest_id, matchedProfile, content);
  }
  return await parseThroughVisionEngine(deps, job.ingest_id, ingest.file_name, content);
}

/**
 * The podcast lane (PR 10): IAB v2/v3 qualification → match_queue write →
 * commission-aware posting. Qualification runs FIRST — bot filtering, the
 * 24-hour single-IP dedup window, the 60-second audio threshold — so only
 * qualified impressions and Channel C subscription rows reach the queue:
 * a bot-filtered or deduped-out line was never an impression, and revenue
 * that does not exist cannot count.
 */
async function parsePodcast(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const qualification = qualifyImpressionLines(lines);
  const writable = [
    ...qualification.qualified,
    ...lines.filter(
      (line) =>
        line.podcastDetail?.revenueChannel === "channel_c_subscription",
    ),
  ];
  const counts = await writePodcastLinesToMatchQueue(
    deps.store,
    ingestId,
    writable,
    deps.vault,
  );
  const posting = await postPodcastLinesToHolding(
    deps.store,
    counts.lineOutcomes,
    (deps.now ?? (() => new Date()))(),
  );
  // PR 11 — after the holding credits land: lock the per-holder episode
  // split routing and fire every crossed guest milestone. Both passes are
  // idempotent (replays are counted no-ops through the per-source guards).
  const splitsAndBonuses = await runPodcastSplitBonusPass(
    deps.store,
    counts.lineOutcomes,
    (deps.now ?? (() => new Date()))(),
  );
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    podcast_written: counts.written,
    podcast_replayed: counts.alreadyPresent,
    podcast_held: counts.heldWritten,
    podcast_bots_filtered: qualification.counts.botsFiltered,
    podcast_duplicates_deduped: qualification.counts.duplicatesDeduped,
    podcast_short_requests_rejected: qualification.counts.shortRequestsRejected,
    podcast_commission_micros: posting.commissionMicrosDeducted.toString(),
    podcast_split_accruals: splitsAndBonuses.splitAccruals,
    podcast_split_replays: splitsAndBonuses.splitReplays,
    podcast_bonus_accrued: splitsAndBonuses.bonusAccrued,
    podcast_bonus_replayed: splitsAndBonuses.bonusReplayed,
  };
}

/**
 * The gaming lane (PR 12): engine-royalty accumulator + match_queue write →
 * two-deduction net posting → per-item split accrual. The accumulator runs
 * at write time (its marginal window depends on the RECORDED contribution
 * sequence); the posting pass deducts the queue row's recorded commission
 * AND engine royalty before the creator net credits UNCLAIMED_HOLDING; the
 * accrual pass routes that same net across the item's registered schedule —
 * the resale royalty off the top on secondary sales, the schedule splits
 * plus dust sweep on the remainder. Every pass is idempotent (replays are
 * counted no-ops through the per-source UNIQUE guards).
 */
async function parseGaming(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeGamingLinesToMatchQueue(
    deps.store,
    ingestId,
    lines,
    deps.vault,
    now,
  );
  const posting = await postGamingLinesToHolding(
    deps.store,
    counts.lineOutcomes,
    now,
  );
  const accrual = await runGamingSplitAccrualPass(
    deps.store,
    counts.lineOutcomes,
    now,
  );
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    gaming_written: counts.written,
    gaming_replayed: counts.alreadyPresent,
    gaming_accumulator_gross_micros: counts.accumulatorGrossMicros.toString(),
    gaming_engine_royalty_micros: posting.engineRoyaltyMicrosDeducted.toString(),
    gaming_commission_micros: posting.commissionMicrosDeducted.toString(),
    gaming_split_payouts: accrual.payouts,
    gaming_split_replays: accrual.replays,
    gaming_royalty_payouts: accrual.royaltiesPosted,
    gaming_royalty_replays: accrual.royaltiesReplayed,
    gaming_split_skipped_no_schedule: accrual.skippedNoSchedule,
  };
}

/**
 * The livestream lane (PR 14): match_queue write (DOI cross-reference,
 * stream metadata, recorded Kick fee) → posting pass — the durable
 * virtual-currency conversion log first (Bits/Diamonds rows), then the
 * esports prize-pool escrow lock (batch receipt rows), then the Kick-fee
 * net holding credit (everything else). Every pass is idempotent (replays
 * are counted no-ops through the per-source guards).
 */
async function parseLivestream(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeLivestreamLinesToMatchQueue(
    deps.store,
    ingestId,
    lines,
    deps.vault,
    now,
  );
  const posting = await postLivestreamLines(deps.store, counts.lineOutcomes, now);
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    livestream_written: counts.written,
    livestream_replayed: counts.alreadyPresent,
    livestream_conversions_logged: posting.conversionsLogged,
    livestream_conversions_replayed: posting.conversionsReplayed,
    livestream_platform_fee_micros: posting.platformFeeMicrosDeducted.toString(),
    livestream_prize_pools_locked: posting.prizePoolsLocked,
    livestream_prize_pools_replayed: posting.prizePoolsReplayed,
    livestream_prize_pool_locked_cents: posting.prizePoolLockedCents,
  };
}

/**
 * The webtoon lane (PR 19): match_queue write (DOI cross-reference, the
 * reading-event identity, the recorded conversion cells, the layered
 * share deductions — and the monthly-pass double-dip dedup) → posting
 * pass — the durable coin-conversion log first (coin-payout rows), then
 * the creator-net holding credit (coin rows) or the pool gross credit
 * (KENP rows). Every pass is idempotent (replays are counted no-ops
 * through the per-source guards); quarantined double-dip rows never post.
 */
async function parseWebtoon(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeWebtoonLinesToMatchQueue(
    deps.store,
    ingestId,
    lines,
    deps.vault,
  );
  const posting = await postWebtoonLines(deps.store, counts.lineOutcomes, now);
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    webtoon_written: counts.written,
    webtoon_replayed: counts.alreadyPresent,
    webtoon_pass_claims: counts.passClaims,
    webtoon_pass_deduped: counts.passDeduped,
    webtoon_paid_as_coin: counts.paidAsCoin,
    webtoon_conversions_logged: posting.conversionsLogged,
    webtoon_conversions_replayed: posting.conversionsReplayed,
    webtoon_store_cut_micros: posting.storeCutMicrosDeducted.toString(),
    webtoon_platform_split_micros: posting.platformSplitMicrosDeducted.toString(),
    webtoon_kenp_payout_cents: posting.kenpPayoutCents,
  };
}

/**
 * The merch lane (PR 22): match_queue write (UPC cross-reference, the
 * physical inventory SKU, the per-unit COGS the FIFO amortization keys on,
 * and the recorded deduction legs) → posting pass — the computed net posts
 * to UNCLAIMED_HOLDING per row kind (the DTC net realized profit equation,
 * the POD collaborator split share of the after-printing remainder, the
 * reconciled consignment net payout, the POS net). Every pass is
 * idempotent (replays are counted no-ops through the per-source guards);
 * negative-net and sub-cent rows never post — the queue row stays the
 * visible quarantine record.
 */
async function parseMerch(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeMerchLinesToMatchQueue(
    deps.store,
    ingestId,
    lines,
    deps.vault,
  );
  const posting = await postMerchNetsToHolding(deps.store, counts, now);
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    merch_written: counts.written,
    merch_replayed: counts.alreadyPresent,
    merch_held_negative_net: counts.heldNegativeNet,
    merch_zero_net: counts.zeroNet,
    merch_cogs_micros: counts.cogsMicrosDeducted.toString(),
    merch_shrinkage_offset_micros: counts.shrinkageOffsetMicros.toString(),
  };
}

/**
 * The AI lane (PR 24): strict-profile parse → match_queue write → the
 * nested derivative split posting. The parse pass already enforced the
 * four senders' layouts (exact rate/revenue reconciliation, bounded
 * vocabularies, identity/quantity validation); the queue pass landed the
 * rows and the attribution registry upserts; this function runs the
 * posting pass and reports the honest counts. A posting failure throws —
 * the job fails with its row-scoped reason and a retry heals
 * idempotently (the 409 guard counts the already-posted legs).
 */
async function parseAi(
  deps: ReconWorkerDeps,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeAiLinesToMatchQueue(deps.store, lines);
  const posting = await postAiLinesToHolding(
    deps.store,
    counts.lineOutcomes,
    now,
  );
  return {
    events_written: counts.written,
    matched: counts.written,
    unmatched: 0,
    engine_used: null,
    holding_posted: posting.postedLegs,
    holding_replayed: posting.replayedLegs,
    ai_written: counts.written,
    ai_replayed: counts.alreadyPresent,
    ai_held: posting.heldUnattributedEvents,
    ai_legs_posted: posting.postedLegs,
    ai_legs_replayed: posting.replayedLegs,
    ai_legs_zero_net: posting.zeroNetLegs,
    ai_fee_micros: posting.feeMicros.toString(),
    ai_developer_micros: posting.developerMicros.toString(),
    ai_operator_micros: posting.operatorMicros.toString(),
    ai_attribution_micros: posting.attributionMicros.toString(),
    ai_voice_licensing_micros: posting.voiceLicensingMicros.toString(),
    ai_pool_royalty_micros: posting.poolRoyaltyMicros.toString(),
    ai_pool_dust_micros: posting.poolDustMicros.toString(),
  };
}

/**
 * The book/magazine lane (PR 26): strict-profile parse → match_queue write
 * (ISBN cross-reference, recorded deduction legs, net computed once at
 * write time) → holding posting (matched money only; negative-net and
 * zero-net rows stay visible quarantines) → the editorial split pass —
 * sequential advance recoupment through the row's OWN pool class (the
 * isolation firewall) and post-clearance split accruals (percentage
 * standard splits, anthology pro-rata, magazine flat/percentage cuts).
 * Every pass is idempotent (replays are counted no-ops through the
 * per-source UNIQUE guards); a pass failure throws — the job fails with
 * its row-scoped reason and a retry heals idempotently.
 */
async function parseBooks(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeBookLinesToMatchQueue(
    deps.store,
    ingestId,
    lines,
    deps.vault,
  );
  const posting = await postBookNetsToHolding(deps.store, counts, now);
  const splits = await runBookEditorialSplitPass(deps.store, counts, now);
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    book_written: counts.written,
    book_replayed: counts.alreadyPresent,
    book_matched: counts.matched,
    book_unmatched: counts.unmatched,
    book_held_negative_net: counts.heldNegativeNet,
    book_zero_net: counts.zeroNet,
    book_print_deduction_micros: counts.printDeductionMicros.toString(),
    book_holding_posted: posting.posted,
    book_holding_replayed: posting.alreadyPosted,
    book_recoupments_applied: splits.recoupmentsApplied,
    book_recoupments_replayed: splits.recoupmentsReplayed,
    book_recoupment_applied_cents: splits.recoupmentAppliedCents,
    book_recoupment_excess_cents: splits.recoupmentExcessCents,
    book_split_accruals: splits.splitAccruals,
    book_split_accruals_replayed: splits.splitAccrualsReplayed,
    book_skipped_no_pool: splits.skippedNoPool + splits.skippedCurrencyMismatch,
    book_skipped_no_schedule: splits.skippedNoSchedule,
  };
}

/**
 * The art-market lane (PR 28): strict-profile parse → match_queue write
 * (Artwork ID cross-reference, recorded deduction legs, net computed once
 * at write time) → holding posting (money dispositions only) → the
 * fabrication waterfall pass — print-edition and sculpture fabrication
 * pools recoup their OWN class's sequence (the isolation firewall), and
 * post-clearance net splits per the scope's registered schedule. Museum
 * licensing posts its agency-net through the same holding seam (the Don
 * Ledger's isolated feed); audits post nothing. Every pass is idempotent
 * (replays are counted no-ops through the per-source UNIQUE guards); a
 * pass failure throws — the job fails with its row-scoped reason and a
 * retry heals idempotently.
 */
async function parseArt(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeArtLinesToMatchQueue(
    deps.store,
    ingestId,
    lines,
  );
  const posting = await postArtNetsToHolding(deps.store, counts, now);
  const waterfall = await runArtWaterfallPass(deps.store, counts, now);

  // The lane's money aggregates — resale royalty legs and licensing legs
  // aggregated from the write pass's own outcomes (never recomputed).
  let arrNetMicros = 0n;
  let licensingNetMicros = 0n;
  let licensingAgencyMicros = 0n;
  for (const outcome of counts.lineOutcomes) {
    if (outcome.disposition !== "money") continue;
    if (outcome.detail.kind === "auction_resale") {
      arrNetMicros += BigInt(outcome.netMicros);
    }
    if (outcome.detail.kind === "museum_licensing") {
      licensingNetMicros += BigInt(outcome.netMicros);
      licensingAgencyMicros += BigInt(outcome.deductionMicros);
    }
  }

  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    art_written: counts.written,
    art_replayed: counts.alreadyPresent,
    art_matched: counts.matched,
    art_unmatched: counts.unmatched,
    art_held_negative_net: counts.heldNegativeNet,
    art_zero_net: counts.zeroNet,
    art_no_arr: counts.noArr,
    art_audit_recorded: counts.auditRows,
    art_holding_posted: posting.posted,
    art_holding_replayed: posting.alreadyPosted,
    art_arr_royalty_micros: (arrNetMicros + counts.resaleDutyOffsetMicros).toString(),
    art_arr_duty_offset_micros: counts.resaleDutyOffsetMicros.toString(),
    art_arr_net_micros: arrNetMicros.toString(),
    art_licensing_fee_micros: (licensingNetMicros + licensingAgencyMicros).toString(),
    art_licensing_agency_deduction_micros: licensingAgencyMicros.toString(),
    art_licensing_net_micros: licensingNetMicros.toString(),
    art_recoupments_applied: waterfall.recoupmentsApplied,
    art_recoupments_replayed: waterfall.recoupmentsReplayed,
    art_recoupment_applied_cents: waterfall.recoupmentAppliedCents,
    art_recoupment_excess_cents: waterfall.recoupmentExcessCents,
    art_split_accruals: waterfall.splitAccruals,
    art_split_accruals_replayed: waterfall.splitAccrualsReplayed,
    art_skipped_no_pool: waterfall.skippedNoPool + waterfall.skippedCurrencyMismatch,
    art_skipped_no_schedule: waterfall.skippedNoSchedule,
  };
}

/**
 * The theatrical lane (PR 30): strict-profile parse → match_queue write
 * (the addendum 11 reconciliation triple on every row, AGBOR computed once
 * at write time from the row's recorded legs) → holding posting (money
 * dispositions only) → the box office waterfall pass — Grand Rights
 * licensing deductions top-line before the production profit splits, the
 * local promoter expense caps bounding venue-expense recoupment, and the
 * deal classes walking their own math (the comedy greater-of guarantee;
 * the theatrical investor recoupment tiers with the automatic 50/50
 * switchover — the isolation firewall). Every pass is idempotent (replays
 * are counted no-ops through the per-source UNIQUE guards); a pass failure
 * throws — the job fails with its row-scoped reason and a retry heals
 * idempotently.
 */
async function parseTheatrical(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeTheatricalLinesToMatchQueue(deps.store, ingestId, lines);
  const posting = await postTheatricalNetsToHolding(deps.store, counts, now);
  const waterfall = await runTheatricalWaterfallPass(deps.store, counts.lineOutcomes, now);

  // The lane's money aggregates — the stops' GBOR and AGBOR legs aggregated
  // from the write pass's own outcomes (never recomputed).
  let gborMicros = 0n;
  for (const outcome of counts.lineOutcomes) {
    gborMicros += BigInt(outcome.detail.gborMicros);
  }
  const agborMicros = gborMicros - counts.agborDeductionMicros;

  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    theatrical_written: counts.written,
    theatrical_replayed: counts.alreadyPresent,
    theatrical_matched: counts.matched,
    theatrical_unmatched: counts.unmatched,
    theatrical_held_negative_net: counts.heldNegativeNet,
    theatrical_zero_net: counts.zeroNet,
    theatrical_holding_posted: posting.posted,
    theatrical_holding_replayed: posting.alreadyPosted,
    theatrical_gbor_micros: gborMicros.toString(),
    theatrical_deductions_micros: counts.agborDeductionMicros.toString(),
    theatrical_agbor_micros: agborMicros.toString(),
    theatrical_grand_rights_cents: waterfall.grandRightsCents,
    theatrical_venue_expense_recouped_cents: waterfall.venueExpenseRecoupedCents,
    theatrical_venue_expense_capped_cents: waterfall.venueExpenseCappedCents,
    theatrical_deal_payout_cents: waterfall.dealPayoutCents,
    theatrical_recoupment_switchovers: waterfall.switchovers,
  };
}

/**
 * The brand-licensing lane (PR 32): strict-profile parse → match_queue
 * write (the addendum 12 deal-of-record triple on every row, the Net
 * Licensed Sales computed once at write time from the row's recorded legs)
 * → holding posting (money dispositions only) → the royalty cascade pass —
 * the tier walk from the deal's cumulative position, the agency commission
 * ordering before the splits, the co-branded 50-50 dual-IP split, the
 * treaty withholding by source territory, and the sub-license override
 * with its audit-gated release (the isolation firewall). Every pass is
 * idempotent (replays are counted no-ops through the per-source UNIQUE
 * guards); a pass failure throws — the job fails with its row-scoped
 * reason and a retry heals idempotently.
 */
async function parseLicensing(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  const now = (deps.now ?? (() => new Date()))();
  const counts = await writeLicensingLinesToMatchQueue(deps.store, ingestId, lines);
  const posting = await postLicensingNetsToHolding(deps.store, counts, now);
  const cascade = await runLicensingRoyaltyCascadePass(deps.store, counts.lineOutcomes, now);

  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: null,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
    licensing_written: counts.written,
    licensing_replayed: counts.alreadyPresent,
    licensing_matched: counts.matched,
    licensing_unmatched: counts.unmatched,
    licensing_held_negative_net: counts.heldNegativeNet,
    licensing_zero_net: counts.zeroNet,
    licensing_holding_posted: posting.posted,
    licensing_holding_replayed: posting.alreadyPosted,
    licensing_net_sales_deduction_micros: counts.netSalesDeductionMicros.toString(),
    licensing_applications_committed: cascade.applicationsCommitted,
    licensing_applications_replayed: cascade.applicationsReplayed,
    licensing_skipped_no_deal: cascade.skippedNoDeal,
    licensing_currency_mismatch: cascade.skippedCurrencyMismatch,
    licensing_sub_reports_written: cascade.subReportsWritten,
    licensing_sub_reports_replayed: cascade.subReportsReplayed,
    licensing_sub_held_pending_audit: cascade.subHeldPendingAudit,
    licensing_sub_releases_posted: cascade.subReleasesPosted,
    licensing_sub_releases_replayed: cascade.subReleasesReplayed,
    licensing_skipped_no_sub_licensee: cascade.skippedNoSubLicensee,
    licensing_royalty_gross_cents: cascade.royaltyGrossCents,
    licensing_agency_commission_cents: cascade.agencyCommissionCents,
    licensing_withheld_cents: cascade.withheldCents,
    licensing_payout_legs_held: cascade.payoutLegsHeld,
  };
}

/** The deterministic lane: profile parse + guild residuals + queue write. */
async function parseDeterministic(
  deps: ReconWorkerDeps,
  ingestId: string,
  profile: StatementProfile,
  content: string,
): Promise<ReconWorkerResult> {
  const lines = profile.parse(content);
  // Guild residual compliance holds — film receipt lines only; music
  // lines pass through untouched. A missing period or rate version fails
  // the job honestly (never a skipped obligation).
  const residualHolds = calculateGuildResiduals(lines);
  return await writeAndPost(deps, ingestId, [...lines, ...residualHolds], null);
}

/** The env-gated seam — PDF/image statements only, fail-closed when unset. */
async function parseThroughVisionEngine(
  deps: ReconWorkerDeps,
  ingestId: string,
  fileName: string,
  content: string,
): Promise<ReconWorkerResult> {
  if (!looksLikePdfOrImage(content)) {
    throw new StatementParseError(
      "no_matching_profile: no deterministic statement profile matched",
    );
  }
  const config = readVisionEngineConfig(deps.env ?? process.env);
  if (config === null) {
    throw new StatementParseError(
      "vision engine not configured: RECON_VISION_URL/RECON_VISION_API_KEY/RECON_VISION_MODEL are required for PDF/image statements",
    );
  }
  const outcome = await runVisionEngine(content, fileName, config);
  if (!outcome.ok) {
    throw new StatementParseError(outcome.reason);
  }
  return await writeAndPost(deps, ingestId, outcome.lines, outcome.model);
}

/**
 * The two lanes' shared tail: land the lines in match_queue, then run the
 * ACTIVATED canonical posting seam — every matched music line's gross
 * credits UNCLAIMED_HOLDING through PR 7's module (per-source replay
 * guard, integer cents). The queue row is already durable when posting
 * runs, so a posting failure throws into the job's fail-closed error path:
 * the row stays open as the quarantine record and a retry re-enters
 * idempotently through the replay guard — never a drop, never a double
 * post. Film receipts and guild residual holds are rights_type 'unknown'
 * and post nothing here — the film waterfall ledger is its own machine.
 */
async function writeAndPost(
  deps: ReconWorkerDeps,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  engineUsed: string | null,
): Promise<ReconWorkerResult> {
  const counts = await writeLinesToMatchQueue(deps.store, ingestId, lines, deps.vault);
  const posting = await postMatchedLinesToHolding(
    deps.store,
    counts.lineOutcomes,
    (deps.now ?? (() => new Date()))(),
  );
  return {
    events_written: counts.written,
    matched: counts.matched,
    unmatched: counts.unmatched,
    engine_used: engineUsed,
    holding_posted: posting.posted,
    holding_replayed: posting.alreadyPosted,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The long-running loop: poll the queue, process one job per pass, sleep
 * between empty passes. `maxJobs` (0 = infinite) bounds the run for the
 * scheduled Actions entry; `shouldStop` is checked between passes so a
 * signal handler can end the daemon cleanly after the in-flight pass. A
 * store outage surfaces on stderr and the loop keeps polling — the
 * durable queue recovers claims on its own.
 */
export async function runWorkerLoop(
  deps: ReconWorkerDeps,
  maxJobs = 0,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const doSleep = deps.sleep ?? sleep;
  let processed = 0;
  while ((maxJobs === 0 || processed < maxJobs) && !shouldStop()) {
    try {
      const job = await runOnce(deps);
      if (job === undefined) {
        await doSleep(DEFAULT_RECON_POLL_MS);
        continue;
      }
      processed += 1;
      const r = job.job.result;
      console.log(
        `[recon-worker] ${job.outcome} ${job.job.id}: ` +
          `written=${r?.events_written ?? 0} matched=${r?.matched ?? 0} ` +
          `unmatched=${r?.unmatched ?? 0} holding_posted=${r?.holding_posted ?? 0} ` +
          `holding_replayed=${r?.holding_replayed ?? 0} ` +
          `engine=${r?.engine_used ?? "deterministic"}`,
      );
    } catch (error) {
      // Surface, never swallow — the queue's own stale-claim recovery
      // re-enters any claim this pass left dangling.
      console.error("[recon-worker] pass failed:", error);
      await doSleep(DEFAULT_RECON_POLL_MS);
    }
  }
}
