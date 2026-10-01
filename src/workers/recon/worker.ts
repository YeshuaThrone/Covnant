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
